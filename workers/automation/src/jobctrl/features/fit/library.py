"""Read the canonical catalog and recorded relationships without model work."""

from __future__ import annotations

from jobctrl.app.errors import NotFoundError

from .associations import association_view
from .coverage import variant_fingerprint
from .current_wording import assignment_view
from .contract import CONTRACT_VERSION, current_contract, current_qualification
from .sources import dto, qualification_fingerprint


def requirement_library(store, profile_id="default"):
    with store.read_snapshot() as read:
        catalog = read.library_catalog_snapshot()
        try:
            profile = dto(read.profile_snapshot(profile_id))
        except NotFoundError:
            profile = None
        wording = read.wording_library(profile_id)
        records = read.library_records(profile_id)
        by_requirement = {}
        for row in records["coverage"]:
            by_requirement.setdefault(row["requirement_id"], []).append(row)
        associations = {}
        for row in records["associations"]:
            associations.setdefault(row["requirement_id"], []).append(row)
        selections = {}
        wording_heads = read.current_wording_heads(profile_id)
        meanings = {row["requirement_id"]: row for row in catalog["requirements"]}
        for row in wording_heads:
            meaning = meanings.get(row["requirement_id"])
            applicable = {item["demand_fingerprint"] for item in catalog.get("demands", [])
                          if item["requirement_id"] == row["requirement_id"]}
            if (meaning is not None and str(row["requirement_revision"]) == str(meaning["revision"])
                    and any(pin["demand_fingerprint"] in applicable for pin in row.get("demand_bindings", []))):
                selections.setdefault(row["requirement_id"], []).append(assignment_view(row, read, profile))
        variants = {row["variant_id"]: row for row in profile["approved_variants"]} if profile else {}
        requirements = []
        for meaning in catalog["requirements"]:
            ident = meaning["requirement_id"]
            demands = []
            for demand in catalog.get("demands", []):
                if demand["requirement_id"] != ident:
                    continue
                source_hash = qualification_fingerprint(profile, demand) if profile is not None else None
                assessment = ((read.latest_assessment(profile_id, ident, demand["requirement_revision"],
                                                      source_fingerprint=source_hash) if profile is not None else None)
                              or read.latest_requirement_assessment(profile_id, ident,
                                  demand_fingerprint=demand["demand_fingerprint"]))
                reasons = []
                if assessment is not None:
                    if not current_contract(assessment):
                        reasons.append("contract_changed")
                    elif not current_qualification(assessment):
                        reasons.append("qualification_semantics_changed")
                    if str(assessment["requirement_revision"]) != str(demand["requirement_revision"]):
                        reasons.append("requirement_revised")
                    if assessment["definition"] != demand["definition"]:
                        reasons.append("demand_changed")
                    if profile is None:
                        reasons.append("profile_unavailable")
                    elif assessment["source_fingerprint"] != source_hash and not reasons:
                        reasons.append("profile_sources_changed")
                    assessment = {**assessment, "current": not reasons, "stale_reasons": reasons}
                state = ("profile_required" if profile is None else "not_assessed" if assessment is None
                         else "stale" if reasons else "current")
                demands.append({**{key: demand[key] for key in ("demand_fingerprint", "definition",
                    "capability_definition", "normalization_version", "job_ids")},
                    "assessment": assessment, "state": state, "current": state == "current", "stale_reasons": reasons})
            scope = ("consolidation_required" if catalog.get("consolidation_required_job_ids") else
                     "varies_by_job" if len(demands) > 1 else "single_demand" if demands else "not_applicable")
            assessment = demands[0]["assessment"] if scope == "single_demand" else None
            scoped_assessments = {row["assessment"]["assessment_id"]: row["assessment"]
                                  for row in demands if row["assessment"] is not None}
            coverage, old_coverage, seen = [], [], set()
            for relation in by_requirement.get(ident, []):
                reasons = [] if current_contract(relation) else ["contract_changed"]
                key = (relation["assessment_id"], relation["variant_id"], str(relation["variant_revision"]))
                if key in seen:
                    reasons.append("coverage_superseded")
                seen.add(key)
                if str(relation["requirement_revision"]) != str(meaning["revision"]):
                    reasons.append("requirement_revised")
                related = scoped_assessments.get(relation["assessment_id"])
                if (related is None or not related["current"]
                        or relation["achievement_id"] not in related["achievement_ids"]):
                    reasons.append("qualification_changed_or_unavailable")
                variant = variants.get(relation["variant_id"])
                if (variant is None or str(variant["revision"]) != str(relation["variant_revision"])
                        or variant["achievement_id"] != relation["achievement_id"]
                        or variant_fingerprint(variant) != relation["variant_fingerprint"]):
                    reasons.append("approved_wording_changed_or_unavailable")
                if reasons:
                    old_coverage.append(relation)
                else:
                    coverage.append({**relation, "current": True, "stale_reasons": []})
            wording_assignments = selections.get(ident, [])
            historical = []
            for old_id, root_id in catalog.get("aliases", {}).items():
                if root_id != ident or old_id == ident:
                    continue
                history = {"requirement_id": old_id, "root_requirement_id": ident, "current": False,
                    "stale_reasons": ["capability_consolidated"],
                    "assessments": [row for row in records["assessments"] if row["requirement_id"] == old_id],
                    "coverage": [row for row in records["coverage"] if row["requirement_id"] == old_id],
                    "associations": [row for row in records["associations"] if row["requirement_id"] == old_id],
                    "wording_assignments": [row for row in wording_heads if row["requirement_id"] == old_id]}
                if any(history[key] for key in ("assessments", "coverage", "associations", "wording_assignments")):
                    historical.append(history)
            live_associations = [row for row in associations.get(ident, []) if current_contract(row)
                                 and str(row["requirement_revision"]) == str(meaning["revision"])]
            applicable_assignment_ids = {row["assignment_id"] for row in wording_assignments}
            old_root = {"requirement_id": ident, "root_requirement_id": ident, "current": False,
                "stale_reasons": ["qualification_binding_historical"],
                "assessments": [row for row in records["assessments"] if row["requirement_id"] == ident
                                and row["assessment_id"] not in scoped_assessments],
                "coverage": old_coverage,
                "associations": [row for row in associations.get(ident, []) if row not in live_associations],
                "wording_assignments": [row for row in wording_heads if row["requirement_id"] == ident
                                        and row["assignment_id"] not in applicable_assignment_ids]}
            if any(old_root[key] for key in ("assessments", "coverage", "associations", "wording_assignments")):
                historical.append(old_root)
            requirements.append({**meaning, "assessment": assessment, "assessment_scope": scope,
                "demand_assessments": demands, "assessment_summary": {"demand_count": len(demands),
                    "assessed_count": sum(row["assessment"] is not None for row in demands),
                    "current_count": sum(row["current"] for row in demands)}, "coverage": coverage,
                "current_wordings": [row for row in wording_assignments if row["state"] == "active"],
                "wording_assignments": wording_assignments,
                "historical_alias_records": historical,
                "associations": [association_view(row, meaning, profile, wording) for row in live_associations]})
        return {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "readiness": "ready" if profile else "profile_required",
                "profile_revision": profile["profile_revision"] if profile else None,
                "fact_semantics_version": profile["fact_semantics_version"] if profile else None,
                "wording_revision": profile["wording_revision"] if profile else None,
                "catalog_revision": catalog["catalog_revision"], "requirements": requirements,
                **({"normalization": catalog["normalization"]} if "normalization" in catalog else {})}
