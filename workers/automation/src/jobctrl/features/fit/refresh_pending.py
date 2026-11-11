"""Read-only current wording failures, independent of the last operation scope."""

from __future__ import annotations

from .coverage import variant_fingerprint
from .sources import achievements, fact_fingerprint


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
    return True


def pending_wording_failures(read, snapshot):
    profile = snapshot["profile"]
    profile_id = profile["profile_id"]
    facts = {row["source_id"]: row for row in snapshot["facts"]}
    source_hash = fact_fingerprint(profile, snapshot["facts"])
    inventory = achievements(profile)
    catalog = {row["requirement_id"]: row for row in snapshot["catalog"]["requirements"]}
    current = {}
    for summary in read.authoring_proposals(profile_id):
        proposal = read.authoring_proposal(summary["proposal_id"], profile_id, include_brief=True, follow_retry=True)
        if proposal is None or proposal["proposal_id"] in current:
            continue
        current[proposal["proposal_id"]] = proposal
    failures = []
    for proposal in current.values():
        if proposal["status"] not in {"failed", "uncertain", "generating"}:
            continue
        brief = proposal.get("brief", {})
        metadata = brief.get("origin_metadata", {})
        owner = brief.get("achievement_id")
        if (not isinstance(metadata, dict) or metadata.get("owner") != "fit" or owner not in inventory
                or not metadata.get("requirements") or not metadata.get("gap_requirement_ids")):
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
            requirement = catalog.get(row["requirement_id"])
            assessment = snapshot["prior_assessments"].get(row["requirement_id"])
            if (requirement is None or str(requirement["revision"]) != str(row["requirement_revision"])
                    or assessment is None or assessment["source_fingerprint"] != source_hash
                    or assessment["kind"] not in {"matched", "transferable"}
                    or owner not in assessment["achievement_ids"]
                    or assessment["determination_id"] != row.get("qualification_determination_id")):
                valid = False
                break
            accepted[row["requirement_id"]] = assessment
        gaps = metadata["gap_requirement_ids"]
        if (not valid or not isinstance(gaps, list)
                or any(not isinstance(ident, str) or ident not in accepted for ident in gaps)):
            continue
        unresolved = []
        for ident in gaps:
            assessment = accepted[ident]
            covered = False
            for variant in profile["approved_variants"]:
                if variant["achievement_id"] not in assessment["achievement_ids"]:
                    continue
                relation = read.coverage(profile_id, ident, assessment["requirement_revision"], assessment["assessment_id"],
                                         variant["variant_id"], variant["revision"])
                if relation is not None and relation["covered"] and relation["variant_fingerprint"] == variant_fingerprint(variant):
                    covered = True
                    break
            if not covered:
                unresolved.append(ident)
        if unresolved:
            failures.append({key: proposal.get(key) for key in ("proposal_id", "status", "failure_code")} | {
                "achievement_id": owner, "requirement_ids": unresolved,
            })
    return sorted(failures, key=lambda row: (row["achievement_id"], row["proposal_id"]))
