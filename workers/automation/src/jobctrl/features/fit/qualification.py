"""Reuse and revalidate source-bound qualification without per-job inference."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import ValidationError

from jobctrl.app.errors import AppError

from .models import (
    IMPACT_INSTRUCTIONS, QUALIFICATION_INSTRUCTIONS, ProfileImpactDecision, QualificationDecision,
)
from .sources import (
    achievement_inventory, achievements, citations_still_bound, dto, evidence_refs, fact_fingerprint,
    fact_sources, fingerprint,
    semantic_sources, source_id, validate_citations,
)
from .serialization import encoded


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
        previous = self.store.latest_assessment(*binding)
        if previous is not None and not force:
            revalidated = await self._revalidate(previous, profile, facts, requirement)
            if revalidated is not None:
                return self.store.publish_assessment(revalidated, facts, profile_snapshot, requirements_snapshot,
                    current["assessment_id"] if current else None, cancelled=cancelled), True

        sources = semantic_sources(requirement, facts)
        inventory = achievements(profile)
        result, provenance = await decide(
            self.model, operation="fit.qualification", schema=QualificationDecision,
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
        return self.store.publish_assessment(record, facts, profile_snapshot, requirements_snapshot,
            current["assessment_id"] if current else None, cancelled=cancelled), False

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

    async def _revalidate(self, previous, profile, facts, requirement):
        before = self.store.assessment_sources(previous["assessment_id"])
        before_index = {row["source_id"]: row for row in before}
        after_index = {row["source_id"]: row for row in facts}
        changed = {ident for ident in set(before_index) | set(after_index)
                   if before_index.get(ident) != after_index.get(ident)}
        current_inventory = achievement_inventory(profile)
        if not changed and previous.get("achievement_inventory") == current_inventory:
            return previous
        sources = [semantic_sources(requirement, [])[0]]
        comparison_ids = set()
        for prefix, entries in (("before", before), ("after", facts)):
            for source in entries:
                ident = f"{prefix}:{source['source_id']}"
                sources.append({**source, "source_id": ident})
                if source["source_id"] in changed:
                    comparison_ids.add(ident)
        if previous.get("achievement_inventory") != current_inventory:
            for prefix, value in (("before", previous.get("achievement_inventory", {})),
                                  ("after", current_inventory)):
                ident = f"{prefix}:achievement-structure"
                sources.append({"source_id": ident, "revision": "1", "text": encoded(value)})
                comparison_ids.add(ident)
            changed.add("achievement-structure")
        result, provenance = await decide(
            self.model, operation="fit.profile-impact", schema=ProfileImpactDecision,
            instructions=IMPACT_INSTRUCTIONS, sources=sources,
            context={"requirement_id": requirement["requirement_id"],
                     "requirement_revision": str(requirement["requirement_revision"]),
                     "saved_assessment": previous, "changed_source_ids": sorted(changed)},
        )
        validate_citations(result.citations, sources)
        if not comparison_ids.intersection(cite.source_id for cite in result.citations):
            raise AppError("fit_change_citation_missing", "The source-impact decision did not cite a changed source.", 422)
        if result.verdict != "unchanged":
            return None
        # An unchanged semantic verdict cannot authorize nonexistent current
        # evidence. Reassessment must establish a new exact source binding.
        if not citations_still_bound(previous["evidence_refs"], facts):
            return None
        inventory = achievements(profile)
        if any(ident not in inventory for ident in previous["achievement_ids"]):
            return None
        cited = {ref["source_id"] for ref in previous["evidence_refs"]}
        if any(not cited.intersection(source_id(ref) for ref in inventory[ident].get("source_refs", []))
               for ident in previous["achievement_ids"]):
            return None
        source_hash = fact_fingerprint(profile, facts)
        record = {**previous, "assessment_id": "fit-assessment-" + fingerprint({
            "previous": previous["assessment_id"], "sources": source_hash,
            "impact_receipt": provenance["receipt_id"],
        }), "origin": "revalidated", "source_fingerprint": source_hash,
            "fact_semantics_version": profile["fact_semantics_version"],
            "revalidated_from": previous["assessment_id"], "revalidation_provenance": provenance,
            "revalidation_rationale": result.rationale, "created_at": now()}
        record["achievement_inventory"] = current_inventory
        record["evidence_refs"] = [{**ref, "revision": after_index[ref["source_id"]]["revision"]}
                                   for ref in previous["evidence_refs"]]
        return record
