"""Validate all explicitly selected authoring retries before any external work."""

from __future__ import annotations

from jobctrl.app.errors import AppError, ConflictError

from .coverage_groups import GroupedCoverageDecision, owned_support
from .sources import achievements, dto, fact_fingerprint, fact_sources, fingerprint


def prepare_wording_retries(coverage, profile_snapshot, requirements_snapshot, requirements, operation):
    profile = dto(profile_snapshot)
    facts = fact_sources(profile)
    source_hash = fact_fingerprint(profile, facts)
    inventory = achievements(profile)
    catalog = {row["requirement_id"]: row for row in requirements}
    plans, seen = [], set()
    operation.check()
    with coverage.store.read_snapshot() as read:
        read.validate_sources(profile_snapshot, requirements_snapshot, facts_only=False)
        for proposal_id in operation.retry_wording_proposal_ids:
            previous = coverage.profile.get_authoring_proposal(proposal_id, profile["profile_id"], include_brief=True)
            if previous is None or previous["status"] not in {"failed", "uncertain"}:
                raise AppError("fit_wording_retry_not_allowed", "Choose an exact failed or uncertain wording request.", 409)
            latest = coverage.profile.get_authoring_proposal(proposal_id, profile["profile_id"], follow_retry=True)
            expected_origin = "fit-wording-retry-" + fingerprint({"previous_proposal_id": proposal_id,
                "previous_origin_key": previous["origin_key"], "operation_id": operation.operation_id})
            if latest["proposal_id"] != proposal_id and latest["origin_key"] != expected_origin:
                raise AppError("fit_wording_retry_superseded", "Select the latest retained authoring attempt for retry.", 409)
            brief = previous["brief"]
            metadata = brief["origin_metadata"]
            achievement_id = brief["achievement_id"]
            if achievement_id in seen:
                raise AppError("fit_wording_retry_ambiguous", "Select at most one retry for each achievement.", 409)
            seen.add(achievement_id)
            if (achievement_id not in inventory or metadata.get("owner") != "fit"
                    or not metadata.get("group_key") or not metadata.get("requirements")
                    or not metadata.get("gap_requirement_ids") and metadata.get("authoring_action") != "propose_consolidation"):
                raise ConflictError("This wording request has no current grouped retry binding. Refresh Fit first.")
            entries = []
            requirement_ids = set()
            for binding in metadata["requirements"]:
                ident = binding["requirement_id"]
                requirement = catalog.get(ident)
                if (ident in requirement_ids or requirement is None
                        or str(requirement["requirement_revision"]) != str(binding["requirement_revision"])):
                    raise ConflictError("A selected retry's canonical requirement changed. Refresh Fit first.")
                requirement_ids.add(ident)
                assessment = read.latest_assessment(profile["profile_id"], ident, requirement["requirement_revision"],
                                                      source_fingerprint=source_hash)
                if (assessment is None or assessment["kind"] not in {"matched", "transferable"}
                        or achievement_id not in assessment["achievement_ids"]
                        or not owned_support(inventory[achievement_id], assessment)
                        or binding["qualification_determination_id"] != assessment["determination_id"]):
                    raise ConflictError("A selected retry's factual support changed. Refresh Fit first.")
                entries.append((requirement, assessment))
            gaps = metadata["gap_requirement_ids"]
            if len(set(gaps)) != len(gaps) or not set(gaps).issubset(requirement_ids):
                raise ConflictError("The selected retry's expression gaps cannot be bound.")
            entries.sort(key=lambda item: item[0]["requirement_id"])
            variants = [row for row in profile["approved_variants"] if row["achievement_id"] == achievement_id]
            group_facts, sources, bindings, group_key = coverage._group_inputs(
                profile, inventory[achievement_id], entries, variants, facts,
            )
            if group_key != metadata["group_key"]:
                raise ConflictError("The selected retry's source or approved wording inventory changed. Refresh Fit first.")
            record = coverage.store.wording_group_decision(group_key)
            if (record is None or record["source_fingerprint"] != fingerprint(sources)
                    or record["decision"]["action"] not in {"propose_wording", "propose_consolidation"}
                    or not set(gaps).issubset(record["decision"]["gap_requirement_ids"])):
                raise ConflictError("The selected retry has no current source-bound expression decision. Refresh Fit first.")
            result = GroupedCoverageDecision.model_validate(record["decision"])
            current_relations, _ = coverage._current_relations(profile, entries, variants, facts,
                profile_snapshot, requirements_snapshot, operation.cancelled, operation)
            coverage._validate_group(result, achievement_id, entries, variants, group_facts, sources, set(), current_relations, set(), None,
                owned_ids={ref["source_id"] for binding in bindings for ref in binding["evidence_refs"]},
                expected={(row["requirement_id"], row["variant_id"]) for row in record["requested_relations"]})
            for requirement, assessment in entries:
                if requirement["requirement_id"] in gaps and coverage._has_covered(
                        profile, requirement, assessment, variants):
                    raise AppError("fit_wording_retry_unnecessary", "An approved wording already covers a selected retry gap.", 409)
            plans.append((inventory[achievement_id], entries, record, previous))
    if len(plans) != len(operation.retry_wording_proposal_ids):
        raise AppError("fit_wording_retry_unconsumed", "Every selected wording retry must have an exact current plan.", 409)
    operation.check()
    return plans
