"""Validate all explicitly selected authoring retries before any external work."""

from __future__ import annotations

from jobctrl.app.errors import AppError, ConflictError

from .coverage_groups import GroupedCoverageDecision, owned_support
from .contract import qualification_key, wording_selection_inputs
from .sources import achievements, dto, fact_sources, fingerprint, qualification_fingerprint, wording_eligible


def prepare_wording_retries(coverage, profile_snapshot, requirements_snapshot, requirements, operation):
    profile = dto(profile_snapshot)
    facts = fact_sources(profile)
    inventory = achievements(profile)
    catalog = {qualification_key(row): row for row in requirements}
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
                ident = qualification_key(binding)
                requirement = catalog.get(ident)
                if (ident in requirement_ids or requirement is None
                        or str(requirement["requirement_revision"]) != str(binding["requirement_revision"])):
                    raise ConflictError("A selected retry's canonical requirement changed. Refresh Fit first.")
                requirement_ids.add(ident)
                assessment = read.latest_assessment(profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
                                                      source_fingerprint=qualification_fingerprint(profile, requirement, facts))
                if (assessment is None or not wording_eligible(assessment) or assessment["kind"] not in {"matched", "transferable"}
                        or achievement_id not in assessment["achievement_ids"]
                        or not owned_support(inventory[achievement_id], assessment)
                        or binding.get("assessment_id") != assessment["assessment_id"]
                        or binding["qualification_determination_id"] != assessment["determination_id"]):
                    raise ConflictError("A selected retry's factual support changed. Refresh Fit first.")
                entries.append((requirement, assessment))
            gaps = [qualification_key(row) for row in metadata.get("gap_demand_bindings", [])]
            if len(set(gaps)) != len(gaps) or not set(gaps).issubset(requirement_ids):
                raise ConflictError("The selected retry's expression gaps cannot be bound.")
            entries.sort(key=lambda item: qualification_key(item[0]))
            variants = [row for row in profile["approved_variants"] if row["achievement_id"] == achievement_id]
            record = coverage.store.wording_group_decision(metadata["group_key"])
            if record is None:
                raise ConflictError("The selected retry's grouped determination is unavailable. Refresh Fit first.")
            heads = read.current_wordings(profile["profile_id"], achievement_ids=[achievement_id])
            if wording_selection_inputs(heads) != record.get("current_wordings"):
                decision = record["decision"]
                accepted = {qualification_key(row): row for row in record["requirements"]}
                expected = ({key: decision["reusable_variant_id"] for key in accepted} if decision["action"] == "reuse_approved"
                            else {qualification_key(row): row["variant_id"] for row in decision.get("selected_relations", [])})
                actual = {qualification_key({**head, **pin}): head["variant_id"] for head in heads
                          for pin in head.get("demand_bindings", [])}
                if (actual != expected or any(head.get("selection_provenance", {}).get("group_key") != record["group_key"] for head in heads)
                        or any(pin["assessment_id"] != accepted[qualification_key({**head, **pin})]["assessment_id"]
                               for head in heads for pin in head.get("demand_bindings", []))):
                    raise ConflictError("The common wording changed after this proposal. Refresh Fit before retrying.")
            group_facts, sources, bindings, group_key = coverage._group_inputs(
                profile, inventory[achievement_id], entries, variants, facts, maintained=record["current_wordings"],
            )
            if group_key != metadata["group_key"]:
                raise ConflictError("The selected retry's source or approved wording inventory changed. Refresh Fit first.")
            if (record is None or record["source_fingerprint"] != fingerprint(sources)
                    or record["decision"]["action"] not in {"propose_wording", "propose_consolidation"}
                    or not set(gaps).issubset(qualification_key(row) for row in record["decision"]["gap_demand_bindings"])):
                raise ConflictError("The selected retry has no current source-bound expression decision. Refresh Fit first.")
            result = GroupedCoverageDecision.model_validate(record["decision"])
            current_relations, _ = coverage._current_relations(profile, entries, variants, facts,
                profile_snapshot, requirements_snapshot, operation.cancelled, operation)
            coverage._validate_group(result, achievement_id, entries, variants, group_facts, sources, set(), current_relations, set(), None,
                owned_ids={ref["source_id"] for binding in bindings for ref in binding["evidence_refs"]},
                expected={(qualification_key(row), row["variant_id"]) for row in record["requested_relations"]})
            for requirement, assessment in entries:
                if qualification_key(requirement) in gaps and coverage._has_covered(
                        profile, requirement, assessment, variants):
                    raise AppError("fit_wording_retry_unnecessary", "An approved wording already covers a selected retry gap.", 409)
            plans.append((inventory[achievement_id], entries, record, previous))
    if len(plans) != len(operation.retry_wording_proposal_ids):
        raise AppError("fit_wording_retry_unconsumed", "Every selected wording retry must have an exact current plan.", 409)
    operation.check()
    return plans
