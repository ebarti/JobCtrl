"""Read the canonical catalog and recorded relationships without model work."""

from __future__ import annotations

from jobctrl.app.errors import NotFoundError

from .associations import association_view
from .coverage import variant_fingerprint
from .current_wording import assignment_view
from .contract import CONTRACT_VERSION, current_contract
from .sources import dto, qualification_fingerprint


def requirement_library(store, profile_id="default"):
    with store.read_snapshot() as read:
        catalog = read.catalog_snapshot()
        try:
            profile = dto(read.profile_snapshot(profile_id))
        except NotFoundError:
            profile = None
        wording = read.wording_library(profile_id)
        records = read.library_records(profile_id)
        assessments = {row["requirement_id"]: row for row in records["assessments"]}
        by_requirement = {}
        for row in records["coverage"]:
            by_requirement.setdefault(row["requirement_id"], []).append(row)
        associations = {}
        for row in records["associations"]:
            associations.setdefault(row["requirement_id"], []).append(row)
        selections = {}
        for row in read.current_wording_heads(profile_id):
            selections.setdefault(row["requirement_id"], []).append(assignment_view(row, read, profile))
        variants = {row["variant_id"]: row for row in profile["approved_variants"]} if profile else {}
        requirements = []
        for meaning in catalog["requirements"]:
            ident = meaning["requirement_id"]
            source_hash = qualification_fingerprint(profile, meaning) if profile is not None else None
            assessment = (read.latest_assessment(profile_id, ident, meaning["revision"], source_fingerprint=source_hash)
                          if profile is not None else None) or assessments.get(ident)
            if assessment is not None:
                reasons = [] if current_contract(assessment) else ["contract_changed"]
                if str(assessment["requirement_revision"]) != str(meaning["revision"]):
                    reasons.append("requirement_revised")
                if profile is None:
                    reasons.append("profile_unavailable")
                elif assessment["source_fingerprint"] != source_hash:
                    reasons.append("profile_sources_changed")
                assessment = {**assessment, "current": not reasons, "stale_reasons": reasons}
            coverage, seen = [], set()
            for relation in by_requirement.get(ident, []):
                reasons = [] if current_contract(relation) else ["contract_changed"]
                key = (relation["assessment_id"], relation["variant_id"], str(relation["variant_revision"]))
                if key in seen:
                    reasons.append("coverage_superseded")
                seen.add(key)
                if str(relation["requirement_revision"]) != str(meaning["revision"]):
                    reasons.append("requirement_revised")
                if (assessment is None or not assessment["current"]
                        or relation["assessment_id"] != assessment["assessment_id"]
                        or relation["achievement_id"] not in assessment["achievement_ids"]):
                    reasons.append("qualification_changed_or_unavailable")
                variant = variants.get(relation["variant_id"])
                if (variant is None or str(variant["revision"]) != str(relation["variant_revision"])
                        or variant["achievement_id"] != relation["achievement_id"]
                        or variant_fingerprint(variant) != relation["variant_fingerprint"]):
                    reasons.append("approved_wording_changed_or_unavailable")
                coverage.append({**relation, "current": not reasons, "stale_reasons": reasons})
            wording_assignments = selections.get(ident, [])
            requirements.append({**meaning, "assessment": assessment, "coverage": coverage,
                "current_wordings": [row for row in wording_assignments if row["state"] == "active"],
                "wording_assignments": wording_assignments,
                "associations": [association_view(row, meaning, profile, wording) for row in associations.get(ident, [])]})
        return {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "readiness": "ready" if profile else "profile_required",
                "profile_revision": profile["profile_revision"] if profile else None,
                "fact_semantics_version": profile["fact_semantics_version"] if profile else None,
                "wording_revision": profile["wording_revision"] if profile else None,
                "catalog_revision": catalog["catalog_revision"], "requirements": requirements}
