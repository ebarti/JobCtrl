"""Approved wording relations, owned separately from factual qualification."""

from __future__ import annotations

import asyncio

from jobctrl.app.errors import AppError, ConflictError

from .models import COVERAGE_INSTRUCTIONS, WordingCoverageDecision
from .qualification import decide, now
from .sources import (
    achievements, citations_still_bound, dto, evidence_refs, fact_fingerprint, fact_sources,
    fingerprint, semantic_sources, source_id, validate_citations,
)


def variant_fingerprint(variant: dict) -> str:
    return fingerprint({key: variant.get(key) for key in (
        "variant_id", "revision", "achievement_id", "text", "approval_id", "source_refs",
    )})


class Coverage:
    def __init__(self, *, model, profile, store, qualification):
        self.model, self.profile, self.store = model, profile, store
        self.qualification = qualification

    async def refresh(self, profile_snapshot, requirements_snapshot, requirements: list[dict], *,
                      prepare_wording=True, cancelled=lambda: False) -> dict:
        profile = dto(profile_snapshot)
        facts = fact_sources(profile)
        source_hash = fact_fingerprint(profile, facts)
        variants = profile["approved_variants"]
        records = {}
        assessed = reused = 0
        for requirement in requirements:
            self._check_cancelled(cancelled)
            assessment = self.store.latest_assessment(
                profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
                source_fingerprint=source_hash,
            )
            if assessment is None:
                raise ConflictError("Current person qualification is required before preparing wording coverage.")
            records[requirement["requirement_id"]] = assessment
            if assessment["kind"] not in {"matched", "transferable"}:
                continue
            for variant in variants:
                if variant["achievement_id"] not in assessment["achievement_ids"]:
                    continue
                self._check_cancelled(cancelled)
                relation = self.store.coverage(
                    profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
                    assessment["assessment_id"], variant["variant_id"], variant["revision"],
                )
                if relation and relation["variant_fingerprint"] == variant_fingerprint(variant):
                    reused += 1
                    continue
                relation = self._reuse_revalidated(profile, requirement, assessment, variant, facts)
                if relation is None:
                    relation = await self._assess(profile, requirement, assessment, variant, facts)
                    assessed += 1
                else:
                    reused += 1
                self._check_cancelled(cancelled)
                self.store.publish_coverage(relation, profile_snapshot, requirements_snapshot, assessment,
                                            cancelled=cancelled)

        proposals = []
        if prepare_wording:
            # Proposals alter Profile's wording revision, so semantic coverage is
            # completed against one exact snapshot before any authoring action.
            for requirement in requirements:
                self._check_cancelled(cancelled)
                assessment = records[requirement["requirement_id"]]
                if assessment["kind"] not in {"matched", "transferable"} or not assessment["achievement_ids"]:
                    continue
                if self._has_covered(profile, requirement, assessment, variants):
                    continue
                current_profile = self.qualification.snapshot(profile["profile_id"])
                with self.store.read_snapshot() as read:
                    read.validate_sources(profile_snapshot, requirements_snapshot, assessment)
                proposal = await self._request_wording(current_profile, requirements_snapshot, requirement,
                                                       assessment, cancelled=cancelled)
                if proposal is not None:
                    proposals.append(proposal)
        return {"assessed_relations": assessed, "reused_relations": reused, "proposals": proposals}

    def _has_covered(self, profile, requirement, assessment, variants):
        for variant in variants:
            if variant["achievement_id"] not in assessment["achievement_ids"]:
                continue
            relation = self.store.coverage(
                profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
                assessment["assessment_id"], variant["variant_id"], variant["revision"],
            )
            if relation and relation["covered"] and relation["variant_fingerprint"] == variant_fingerprint(variant):
                return True
        return False

    async def _assess(self, profile, requirement, assessment, variant, facts):
        if not variant.get("approval_id") or not variant.get("source_refs"):
            raise AppError("fit_unapproved_wording", "Coverage requires an exact approved wording and source binding.", 409)
        sources = [*semantic_sources(requirement, facts), {
            "source_id": "approved-variant", "revision": str(variant["revision"]), "text": variant["text"],
        }]
        binding = {"requirement_id": requirement["requirement_id"],
                   "requirement_revision": str(requirement["requirement_revision"]),
                   "achievement_id": variant["achievement_id"], "variant_id": variant["variant_id"],
                   "variant_revision": str(variant["revision"])}
        result, provenance = await decide(
            self.model, operation="fit.wording-coverage", schema=WordingCoverageDecision,
            instructions=COVERAGE_INSTRUCTIONS, sources=sources,
            context={"binding": binding, "accepted_qualification": assessment,
                     "approval_id": variant["approval_id"], "variant_source_refs": variant["source_refs"]},
        )
        if any(getattr(result, key) != value for key, value in binding.items()):
            raise AppError("fit_wording_binding_invalid", "The coverage response referenced different wording or requirements.", 422)
        validate_citations(result.citations, sources, required_ids=("requirement", "approved-variant"))
        refs = evidence_refs(result.citations, facts)
        supported_ids = {ref["source_id"] for ref in assessment["evidence_refs"]}
        variant_ids = {source_id(ref) for ref in variant["source_refs"]}
        if result.status in {"covered", "partial"} and not any(
            ref["source_id"] in supported_ids.intersection(variant_ids) for ref in refs
        ):
            raise AppError("fit_coverage_support_missing", "The wording coverage does not cite its supporting candidate evidence.", 422)
        return {
            "relation_id": "fit-coverage-" + fingerprint({"assessment": assessment["assessment_id"],
                "variant": variant_fingerprint(variant), "receipt": provenance["receipt_id"]}),
            "profile_id": profile["profile_id"], "requirement_id": requirement["requirement_id"],
            "requirement_revision": requirement["requirement_revision"],
            "assessment_id": assessment["assessment_id"], "achievement_id": variant["achievement_id"],
            "variant_id": variant["variant_id"], "variant_revision": variant["revision"],
            "variant_fingerprint": variant_fingerprint(variant), "approval_id": variant["approval_id"],
            "covered": result.status == "covered", "status": result.status, "rationale": result.rationale,
            "source_refs": refs, "citations": [ref.model_dump() for ref in result.citations],
            "determination_id": provenance["receipt_id"], "provenance": provenance,
            "qualification_determination_id": assessment["determination_id"], "created_at": now(),
        }

    def _reuse_revalidated(self, profile, requirement, assessment, variant, facts):
        candidates = self.store.prior_coverage(
            profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
            variant["variant_id"], variant["revision"],
        )
        for relation in candidates:
            if (relation["qualification_determination_id"] != assessment["determination_id"]
                    or relation["variant_fingerprint"] != variant_fingerprint(variant)
                    or not citations_still_bound(relation["source_refs"], facts)):
                continue
            current = {row["source_id"]: row for row in facts}
            return {**relation, "relation_id": "fit-coverage-" + fingerprint({
                "previous": relation["relation_id"], "assessment": assessment["assessment_id"],
            }), "assessment_id": assessment["assessment_id"], "revalidated_from": relation["relation_id"],
                "source_refs": [{**ref, "revision": current[ref["source_id"]]["revision"]}
                                for ref in relation["source_refs"]], "created_at": now()}
        return None

    async def _request_wording(self, profile_snapshot, requirements_snapshot, requirement, assessment, *, cancelled):
        profile = dto(profile_snapshot)
        inventory = achievements(profile)
        # All achievements remain in the baseline. Stable IDs choose the first
        # supported authoring owner, never a relevance or brevity heuristic.
        achievement_id = min(assessment["achievement_ids"])
        allowed = {source_id(ref) for ref in inventory[achievement_id].get("source_refs", [])}
        refs = [{"source_id": ref["source_id"], "revision": ref["revision"]}
                for ref in assessment["evidence_refs"] if ref["source_id"] in allowed]
        refs = list({(ref["source_id"], str(ref["revision"])): ref for ref in refs}.values())
        if not refs:
            return None
        origin = "fit-wording-" + fingerprint({
            "profile_id": profile["profile_id"], "requirement_id": requirement["requirement_id"],
            "requirement_revision": requirement["requirement_revision"], "achievement_id": achievement_id,
            "evidence_refs": sorted(refs, key=lambda ref: ref["source_id"]),
        })
        self._check_cancelled(cancelled)
        with self.store.read_snapshot() as read:
            read.validate_sources(profile_snapshot, requirements_snapshot, assessment, facts_only=False)
        proposal = await self.profile.request_authoring({
            "origin_key": origin, "profile_id": profile["profile_id"],
            "profile_revision": profile["profile_revision"],
            "fact_semantics_version": profile["fact_semantics_version"], "achievement_id": achievement_id,
            "evidence_refs": refs, "support_receipt_id": assessment.get("revalidation_provenance", {}).get(
                "receipt_id", assessment["determination_id"]),
            "requested_expression": (
                "Prepare an explicitly reviewable wording alternative for the supported aspects of this qualified "
                "requirement. Preserve the person's recorded support level and any remaining gap; do not add facts. "
                + requirement["definition"]
            ),
            "origin_metadata": {"owner": "fit", "requirement_id": requirement["requirement_id"],
                                "requirement_revision": requirement["requirement_revision"],
                                "qualifiers": requirement.get("qualifiers", {}),
                                "assessment_id": assessment["assessment_id"], "support_kind": assessment["kind"],
                                "support_determination_id": assessment["determination_id"],
                                "support_rationale": assessment["rationale"]},
        }, cancelled=cancelled)
        self._check_cancelled(cancelled)
        proposal_id = proposal.get("proposal_id") or proposal.get("request_id")
        if not isinstance(proposal_id, str) or not proposal_id:
            raise AppError("fit_wording_request_invalid", "Profile did not return a retained authoring request identity.", 422)
        binding = {"origin_key": origin, "profile_id": profile["profile_id"],
                   "requirement_id": requirement["requirement_id"],
                   "requirement_revision": requirement["requirement_revision"], "proposal_id": proposal_id,
                   "achievement_id": achievement_id, "evidence_refs": refs, "created_at": now()}
        self.store.publish_wording_request(binding, profile_snapshot, requirements_snapshot, assessment,
                                           cancelled=cancelled)
        return proposal

    @staticmethod
    def _check_cancelled(cancelled):
        if cancelled():
            raise asyncio.CancelledError()
