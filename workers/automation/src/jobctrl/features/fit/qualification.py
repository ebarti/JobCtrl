"""Reuse and revalidate source-bound qualification without per-job inference."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from pydantic import ValidationError

from jobctrl.app.errors import AppError

from .contract import CONTRACT_VERSION, DIRECT_CATEGORIES, current_contract, require_contract
from .models import (
    QUALIFICATION_INSTRUCTIONS, QualificationBatchDecision,
)
from .sources import (
    achievement_inventory, achievements, dto, evidence_category, evidence_refs,
    fact_sources, fingerprint, permitted_facts, qualification_fingerprint,
    semantic_sources, source_id, validate_citations,
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def decide(model, *, operation, schema, instructions, sources, context, prompt_version="1"):
    response = await model.determine(
        operation=operation, instructions=instructions, sources=sources,
        response_schema=schema.model_json_schema(), context=context,
        prompt_version=prompt_version, lane="scoring",
    )
    try:
        accepted = schema.model_validate(response.value)
    except ValidationError:
        raise AppError("fit_model_schema_violation", "The Fit model response did not match its required structure.", 422) from None
    provenance = dto(response.provenance) if not isinstance(response.provenance, dict) else dict(response.provenance)
    if not all(isinstance(provenance.get(key), str) and provenance[key]
               for key in ("receipt_id", "provider", "model", "lane", "input_fingerprint")):
        raise AppError("fit_model_provenance_invalid", "The Fit model receipt cannot be verified.", 422)
    provenance["accepted_result_fingerprint"] = fingerprint(accepted.model_dump())
    return accepted, provenance


class Qualification:
    def __init__(self, *, model, store):
        self.model, self.store = model, store

    def snapshot(self, profile_id="default", connection=None):
        with self.store.read_snapshot(connection) as read:
            return read.profile_snapshot(profile_id)

    async def resolve_many(self, profile_snapshot, requirements: list[dict], requirements_snapshot: dict, *, force=False,
                           initial_assessment=False, cancelled=lambda: False):
        profile = dto(profile_snapshot)
        facts = fact_sources(profile)
        current = {}
        missing = []
        prior_heads = {}
        with self.store.read_snapshot() as read:
            read.validate_sources(profile_snapshot, requirements_snapshot)
            for requirement in requirements:
                require_contract(requirement)
                ident = requirement["requirement_id"]
                source_hash = qualification_fingerprint(profile, requirement, facts)
                accepted = read.latest_assessment(profile["profile_id"], ident, requirement["requirement_revision"],
                                                  source_fingerprint=source_hash)
                if current_contract(accepted) and not force:
                    current[ident] = accepted
                    continue
                previous = read.latest_requirement_assessment(profile["profile_id"], ident)
                if previous is not None and (not initial_assessment or force):
                    raise AppError("fit_refresh_required", "Saved inputs changed. Start a manual Fit refresh to update existing assessments.", 409)
                prior_heads[ident] = previous["assessment_id"] if previous else None
                missing.append(requirement)
        reused = len(current)
        if missing:
            if cancelled():
                raise asyncio.CancelledError()
            candidates = await self.candidates(profile_snapshot, missing)
            published = self.store.publish_assessments(candidates, facts, profile_snapshot, requirements_snapshot,
                {row["requirement_id"]: None for row in missing}, expected_prior_assessment_ids=prior_heads,
                initial_job_id=requirements_snapshot["job_id"] if initial_assessment else None, cancelled=cancelled)
            current.update({row["requirement_id"]: row for row in published})
        return [current[row["requirement_id"]] for row in requirements], reused

    async def candidates(self, profile_snapshot, requirements: list[dict], *, model=None):
        """Prepare one complete source-bound batch; the caller owns atomic publication."""
        if not requirements:
            return []
        index = {row["requirement_id"]: row for row in requirements}
        if len(index) != len(requirements):
            raise AppError("fit_qualification_partition_invalid", "The Fit qualification input contains duplicate requirements.", 422)
        profile = dto(profile_snapshot)
        facts = fact_sources(profile)
        own_sources = {}
        sources = []
        for requirement in requirements:
            ident = requirement["requirement_id"]
            local = semantic_sources(requirement, facts)
            local[0] = {**local[0], "source_id": "requirement:" + ident}
            own_sources[ident] = local
            sources.append(local[0])
        sources.extend(own_sources[requirements[0]["requirement_id"]][1:])
        inventory = achievements(profile)
        authority_model = model or self.model
        result, provenance = await decide(
            authority_model, operation="fit.qualification-batch", schema=QualificationBatchDecision,
            instructions=QUALIFICATION_INSTRUCTIONS, sources=sources,
            context={
                "requirements": [{"requirement_id": row["requirement_id"],
                                  "requirement_revision": str(row["requirement_revision"]),
                                  "category": row["category"], "name": row["name"],
                                  "alternative": row.get("alternative"),
                                  "source_id": "requirement:" + row["requirement_id"],
                                  "permitted_evidence_ids": ["evidence:" + source["source_id"]
                                                             for source in permitted_facts(row, facts)]}
                                 for row in requirements],
                "profile_id": profile["profile_id"], "fact_semantics_version": profile["fact_semantics_version"],
                "achievements": [{"achievement_id": ident, "role_id": row["role_id"], "source_refs": row.get("source_refs", [])}
                                 for ident, row in inventory.items()],
            },
            prompt_version="fit-qualification-batch-v2",
        )
        self._verify_batch_receipt(authority_model, result, provenance)
        returned = [row.requirement_id for row in result.requirements]
        if len(returned) != len(set(returned)) or set(returned) != set(index):
            raise AppError("fit_qualification_partition_invalid", "The Fit response must assess every requested requirement exactly once.", 422)
        for row in result.requirements:
            self.validate(row, index[row.requirement_id], facts, inventory, own_sources[row.requirement_id],
                          requirement_source_id="requirement:" + row.requirement_id)
        decisions = {row.requirement_id: row for row in result.requirements}
        return [self._record(profile, qualification_fingerprint(profile, requirement, facts), facts, requirement,
                             decisions[requirement["requirement_id"]], provenance) for requirement in requirements]

    @staticmethod
    def _verify_batch_receipt(model, result, provenance):
        try:
            receipt = model.receipt(provenance["receipt_id"])
            canonical = QualificationBatchDecision.model_validate(receipt["value"])
            valid = (receipt.get("status") == "succeeded" and receipt.get("operation") == "fit.qualification-batch"
                     and receipt.get("prompt_version") == "fit-qualification-batch-v2"
                     and all(receipt.get(key) == provenance.get(key) for key in (
                         "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at"))
                     and canonical.model_dump() == result.model_dump())
        except (AppError, KeyError, TypeError, ValueError):
            valid = False
        if not valid:
            raise AppError("fit_model_provenance_invalid", "The Fit qualification batch receipt cannot be verified.", 422)

    @staticmethod
    def _record(profile, source_hash, facts, requirement, result, provenance):
        record = {
            "contract_version": CONTRACT_VERSION,
            "assessment_id": "fit-assessment-" + fingerprint({
                "profile_id": profile["profile_id"], "requirement_id": requirement["requirement_id"],
                "requirement_revision": requirement["requirement_revision"], "sources": source_hash,
                "determination": provenance["receipt_id"],
            }),
            "profile_id": profile["profile_id"], "fact_semantics_version": profile["fact_semantics_version"],
            "source_fingerprint": source_hash, "requirement_id": requirement["requirement_id"],
            "requirement_revision": requirement["requirement_revision"], "definition": requirement["definition"],
            "category": requirement["category"], "name": requirement["name"],
            **({"job_id": requirement["job_id"]} if requirement.get("category") in DIRECT_CATEGORIES else {}),
            **{key: requirement[key] for key in ("alternative", "qualification", "subjects", "language", "proficiency") if key in requirement},
            "kind": result.kind, "strength": result.strength,
            "evidence_route": result.evidence_route, "wording_support": result.wording_support,
            "achievement_inventory": achievement_inventory(profile),
            "confidence": result.confidence, "rationale": result.rationale,
            "evidence_refs": evidence_refs(result.evidence, facts), "achievement_ids": result.achievement_ids,
            "keywords": result.keywords, "eligibility": result.eligibility,
            "blocker_category": result.blocker_category, "warning_category": result.warning_category,
            "requirement_citations": [row.model_dump() for row in result.requirement_citations],
            "determination_id": provenance["receipt_id"],
            "provenance": {**provenance, "qualification_result_fingerprint": fingerprint(result.model_dump())},
            "origin": "model", "created_at": now(),
        }
        return record

    @staticmethod
    def validate(result, requirement, facts, inventory, sources, *, requirement_source_id="requirement"):
        require_contract(requirement)
        if (result.requirement_id != requirement["requirement_id"]
                or result.requirement_revision != str(requirement["requirement_revision"])):
            raise AppError("fit_requirement_binding_invalid", "The Fit response referenced a different requirement.", 422)
        validate_citations(result.requirement_citations, sources, required_ids=(requirement_source_id,))
        if any(citation.source_id == requirement_source_id for citation in result.evidence):
            raise AppError("fit_evidence_binding_invalid", "Employer requirements cannot prove candidate facts.", 422)
        validate_citations(result.evidence, sources)
        supported = result.kind in {"matched", "transferable"}
        category = requirement["category"]
        if (category == "education" and supported and result.evidence_route is None
                or category != "education" and result.evidence_route is not None
                or result.evidence_route == "equivalent_experience" and not requirement.get("alternative")
                ):
            raise AppError("fit_evidence_route_invalid", "The qualification route does not match the recorded education alternative.", 422)
        permitted = {row["source_id"] for row in permitted_facts(requirement, facts, evidence_route=result.evidence_route)}
        refs = evidence_refs(result.evidence, facts)
        if category == "education" and refs and result.evidence_route is None:
            raise AppError("fit_evidence_route_invalid", "Education evidence must record the assessed degree or explicit equivalent-experience route.", 422)
        if any(ref["source_id"] not in permitted for ref in refs) or len(refs) != len(result.evidence):
            raise AppError("fit_evidence_category_invalid", "The qualification cited a source outside this requirement's permitted evidence category.", 422)
        if (supported and not refs
                or result.kind == "matched" and result.strength is None
                or result.kind != "matched" and result.strength is not None):
            raise AppError("fit_support_binding_invalid", "The Fit verdict lacks its required factual support.", 422)
        cited_sources = [row for row in facts if row["source_id"] in {ref["source_id"] for ref in refs}]
        section_supported = any(evidence_category(row) in {"skill", "education", "language"}
                                or row.get("kind") == "role" for row in cited_sources)
        if (supported and result.wording_support == "none"
                or not supported and result.wording_support != "none"
                or supported and result.wording_support == "section" and category not in DIRECT_CATEGORIES and not section_supported
                or result.wording_support == "achievement" and (category in DIRECT_CATEGORIES or not result.achievement_ids)):
            raise AppError("fit_wording_support_invalid", "The wording support route lacks its required factual source category.", 422)
        if result.achievement_ids and (category == "language" or category == "education" and result.evidence_route != "equivalent_experience"):
            raise AppError("fit_achievement_binding_invalid", "This direct demand cannot be supported by achievement IDs.", 422)
        if len(set(result.achievement_ids)) != len(result.achievement_ids):
            raise AppError("fit_achievement_binding_invalid", "The Fit response duplicated an achievement ID.", 422)
        cited = {ref["source_id"] for ref in evidence_refs(result.evidence, facts)}
        for ident in result.achievement_ids:
            if (not supported or ident not in inventory
                    or not cited.intersection(source_id(ref) for ref in inventory[ident].get("source_refs", []))):
                raise AppError("fit_achievement_binding_invalid", "The Fit response referenced an unsupported achievement.", 422)
        if result.kind == "blocked" and not result.evidence:
            raise AppError("fit_blocker_evidence_missing", "A typed factual mismatch requires cited permitted evidence.", 422)
