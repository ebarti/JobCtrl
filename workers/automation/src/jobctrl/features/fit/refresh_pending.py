"""Read-only current wording failures, independent of the last operation scope."""

from __future__ import annotations

from .coverage import variant_fingerprint
from .current_wording import assignment_view
from .contract import current_contract, qualification_key
from .sources import achievements, qualification_fingerprint, wording_eligible


def valid_requirement_bindings(value):
    """Fit metadata is opaque to Profile; validate literal IDs before indexing."""
    if not isinstance(value, list) or not value:
        return False
    for row in value:
        if not isinstance(row, dict) or not isinstance(row.get("requirement_id"), str) or not row["requirement_id"]:
            return False
        revision = row.get("requirement_revision")
        if not ((type(revision) is int and revision > 0) or (isinstance(revision, str) and bool(revision))):
            return False
        if not isinstance(row.get("demand_fingerprint"), str) or not row["demand_fingerprint"]:
            return False
    return True


def pending_wording_failures(read, snapshot):
    profile = snapshot["profile"]
    profile_id = profile["profile_id"]
    facts = {row["source_id"]: row for row in snapshot["facts"]}
    inventory = achievements(profile)
    catalog = {qualification_key(row): row for row in snapshot["demand_catalog"]["demands"]}
    current = {}
    for summary in read.authoring_proposals(profile_id):
        proposal = read.authoring_proposal(summary["proposal_id"], profile_id, include_brief=True, follow_retry=True)
        if proposal is None or proposal["proposal_id"] in current:
            continue
        current[proposal["proposal_id"]] = proposal
    failures = []
    maintained = read.current_wordings(profile_id)
    for proposal in current.values():
        if proposal["status"] not in {"failed", "uncertain", "generating"}:
            continue
        brief = proposal.get("brief", {})
        metadata = brief.get("origin_metadata", {})
        owner = brief.get("achievement_id")
        if (not current_contract(metadata) or metadata.get("owner") != "fit" or owner not in inventory
                or not metadata.get("requirements")
                or not metadata.get("gap_requirement_ids") and metadata.get("authoring_action") != "propose_consolidation"):
            continue
        if any(ref["source_id"] not in facts or facts[ref["source_id"]]["revision"] != ref["revision"]
               for ref in brief.get("evidence_refs", [])):
            continue
        members = metadata["requirements"]
        if not valid_requirement_bindings(members):
            continue
        accepted = {}
        valid = True
        for row in members:
            key = qualification_key(row)
            requirement = catalog.get(key)
            assessment = snapshot["prior_assessments"].get(key)
            if (requirement is None or str(requirement["requirement_revision"]) != str(row["requirement_revision"])
                    or assessment is None or not wording_eligible(assessment)
                    or assessment["source_fingerprint"] != qualification_fingerprint(profile, requirement, snapshot["facts"])
                    or assessment["kind"] not in {"matched", "transferable"}
                    or owner not in assessment["achievement_ids"]
                    or assessment["assessment_id"] != row.get("assessment_id")
                    or assessment["determination_id"] != row.get("qualification_determination_id")):
                valid = False
                break
            accepted[key] = assessment
        if not isinstance(metadata.get("gap_requirement_ids"), list):
            continue
        gap_bindings = metadata.get("gap_demand_bindings", [])
        if gap_bindings and not valid_requirement_bindings(gap_bindings):
            continue
        gaps = [qualification_key(row) for row in gap_bindings]
        if (not valid or any(ident not in accepted for ident in gaps)
                or set(metadata["gap_requirement_ids"]) != {row["requirement_id"] for row in gap_bindings}):
            continue
        unresolved = []
        if metadata.get("authoring_action") == "propose_consolidation":
            selected = [assignment_view(row, read, profile) for row in maintained
                        if row["achievement_id"] == owner and row["requirement_id"] in {item["requirement_id"] for item in members}]
            if ({qualification_key({**row, **pin}) for row in selected for pin in row["demand_bindings"] if pin["current"]} != set(accepted)
                    or len({row["variant_id"] for row in selected}) != 1):
                unresolved = list(accepted)
        for ident in gaps:
            assessment = accepted[ident]
            covered = False
            for variant in profile["approved_variants"]:
                if variant["achievement_id"] != owner or variant["achievement_id"] not in assessment["achievement_ids"]:
                    continue
                relation = read.coverage(profile_id, assessment["requirement_id"], assessment["requirement_revision"], assessment["assessment_id"],
                                         variant["variant_id"], variant["revision"])
                if relation is not None and relation["covered"] and relation["variant_fingerprint"] == variant_fingerprint(variant):
                    covered = True
                    break
            if not covered:
                unresolved.append(ident)
        if unresolved:
            failures.append({key: proposal.get(key) for key in ("proposal_id", "status", "failure_code")} | {
                "achievement_id": owner, "requirement_ids": sorted({accepted[key]["requirement_id"] for key in unresolved}),
            })
    return sorted(failures, key=lambda row: (row["achievement_id"], row["proposal_id"]))
