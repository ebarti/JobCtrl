"""Reuse and revalidate source-bound qualification without per-job inference."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import ValidationError

from jobctrl.app.errors import AppError

from .models import (
    QUALIFICATION_INSTRUCTIONS, QualificationDecision,
)
from .sources import (
    achievement_inventory, achievements, dto, evidence_refs, fact_fingerprint,
    fact_sources, fingerprint,
    semantic_sources, source_id, validate_citations,
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def decide(model, *, operation, schema, instructions, sources, context):
    response = await model.determine(
        operation=operation, instructions=instructions, sources=sources,
        response_schema=schema.model_json_schema(), context=context,
        prompt_version="1", lane="scoring",
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

    async def resolve(self, profile_snapshot, requirement: dict, requirements_snapshot: dict, *, force=False,
                      cancelled=lambda: False):
        profile = dto(profile_snapshot)
        facts = fact_sources(profile)
        source_hash = fact_fingerprint(profile, facts)
        binding = (profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"])
        current = self.store.latest_assessment(*binding, source_fingerprint=source_hash)
        if current is not None and not force:
            return current, True
        previous = self.store.latest_requirement_assessment(profile["profile_id"], requirement["requirement_id"])
        if previous is not None:
            raise AppError("fit_refresh_required", "Saved inputs changed. Start a manual Fit refresh to update existing assessments.", 409)
        record = await self.candidate(profile_snapshot, requirement)
        return self.store.publish_assessment(record, facts, profile_snapshot, requirements_snapshot,
            current["assessment_id"] if current else None, cancelled=cancelled), False

    async def candidate(self, profile_snapshot, requirement: dict, *, model=None):
        """Prepare one source-bound result; the caller owns atomic publication."""
        profile = dto(profile_snapshot)
        facts = fact_sources(profile)
        source_hash = fact_fingerprint(profile, facts)
        sources = semantic_sources(requirement, facts)
        inventory = achievements(profile)
        result, provenance = await decide(
            model or self.model, operation="fit.qualification", schema=QualificationDecision,
            instructions=QUALIFICATION_INSTRUCTIONS, sources=sources,
            context={
                "binding": {"requirement_id": requirement["requirement_id"],
                            "requirement_revision": str(requirement["requirement_revision"])},
                "profile_id": profile["profile_id"], "fact_semantics_version": profile["fact_semantics_version"],
                "scope": requirement["scope"],
                "achievements": [{"achievement_id": ident, "role_id": row["role_id"], "source_refs": row.get("source_refs", [])}
                                 for ident, row in inventory.items()],
            },
        )
        self.validate(result, requirement, facts, inventory, sources)
        record = {
            "assessment_id": "fit-assessment-" + fingerprint({
                "profile_id": profile["profile_id"], "requirement_id": requirement["requirement_id"],
                "requirement_revision": requirement["requirement_revision"], "sources": source_hash,
                "determination": provenance["receipt_id"],
            }),
            "profile_id": profile["profile_id"], "fact_semantics_version": profile["fact_semantics_version"],
            "source_fingerprint": source_hash, "requirement_id": requirement["requirement_id"],
            "requirement_revision": requirement["requirement_revision"], "definition": requirement["definition"],
            "qualifiers": requirement.get("qualifiers", {}), "kind": result.kind, "strength": result.strength,
            "achievement_inventory": achievement_inventory(profile),
            "confidence": result.confidence, "rationale": result.rationale,
            "evidence_refs": evidence_refs(result.evidence, facts), "achievement_ids": result.achievement_ids,
            "keywords": result.keywords, "eligibility": result.eligibility,
            "blocker_category": result.blocker_category, "warning_category": result.warning_category,
            "requirement_citations": [row.model_dump() for row in result.requirement_citations],
            "determination_id": provenance["receipt_id"], "provenance": provenance,
            "origin": "model", "created_at": now(),
        }
        return record

    @staticmethod
    def validate(result, requirement, facts, inventory, sources):
        if (result.requirement_id != requirement["requirement_id"]
                or result.requirement_revision != str(requirement["requirement_revision"])):
            raise AppError("fit_requirement_binding_invalid", "The Fit response referenced a different requirement.", 422)
        validate_citations(result.requirement_citations, sources, required_ids=("requirement",))
        if any(citation.source_id == "requirement" for citation in result.evidence):
            raise AppError("fit_evidence_binding_invalid", "Employer requirements cannot prove candidate facts.", 422)
        validate_citations(result.evidence, sources)
        supported = result.kind in {"matched", "transferable"}
        non_guidance = {row["source_id"] for row in facts if row.get("kind") != "user_scoring_guidance"}
        refs = evidence_refs(result.evidence, facts)
        if (supported and not non_guidance.intersection(ref["source_id"] for ref in refs)
                or result.kind == "matched" and result.strength is None
                or result.kind != "matched" and result.strength is not None):
            raise AppError("fit_support_binding_invalid", "The Fit verdict lacks its required factual support.", 422)
        if len(set(result.achievement_ids)) != len(result.achievement_ids):
            raise AppError("fit_achievement_binding_invalid", "The Fit response duplicated an achievement ID.", 422)
        cited = {ref["source_id"] for ref in evidence_refs(result.evidence, facts)}
        for ident in result.achievement_ids:
            if (not supported or ident not in inventory
                    or not cited.intersection(source_id(ref) for ref in inventory[ident].get("source_refs", []))):
                raise AppError("fit_achievement_binding_invalid", "The Fit response referenced an unsupported achievement.", 422)
        if ((result.eligibility == "blocked") != (result.blocker_category is not None)
                or (result.eligibility == "warning") != (result.warning_category is not None)):
            raise AppError("fit_eligibility_binding_invalid", "The Fit eligibility verdict and category disagree.", 422)
        if (result.eligibility == "blocked" or result.kind == "blocked") and not result.evidence:
            raise AppError("fit_blocker_evidence_missing", "A hard mismatch requires cited factual or explicit user evidence.", 422)
