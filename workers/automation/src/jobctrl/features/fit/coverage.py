"""Exact approved-wording reuse and grouped, source-bound expression gaps."""

from __future__ import annotations

import asyncio

from jobctrl.app.errors import AppError, ConflictError

from .coverage_groups import (
    GROUPED_COVERAGE_INSTRUCTIONS, GroupedCoverageDecision, coverage_record, group_sources,
    owned_support, relation_key, validate_group_decision,
)
from .coverage_retries import prepare_wording_retries
from .qualification import decide, now
from .serialization import encoded
from .sources import (
    achievements, citations_still_bound, dto, fact_fingerprint, fact_sources, fingerprint, source_id,
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
                      prepare_wording=True, cancelled=lambda: False, operation=None) -> dict:
        if operation is not None and operation.retry_wording_proposal_ids:
            plans = prepare_wording_retries(self, profile_snapshot, requirements_snapshot, requirements, operation)
            proposals = []
            for achievement, entries, record, previous in plans:
                proposal = await self._request_wording(profile_snapshot, requirements_snapshot, achievement, entries,
                    record, cancelled=cancelled, operation=operation, retry_proposal=previous)
                if proposal is None:
                    raise ConflictError("The selected authoring retry no longer has an expression gap.")
                proposals.append(proposal)
            self._check_cancelled(cancelled, operation)
            return self._result(proposals, operation, reused_groups=len(plans))
        profile = dto(profile_snapshot)
        facts = fact_sources(profile)
        source_hash = fact_fingerprint(profile, facts)
        variants = profile["approved_variants"]
        inventory = achievements(profile)
        groups = {}
        self._check_cancelled(cancelled, operation)
        with self.store.read_snapshot() as read:
            read.validate_sources(profile_snapshot, requirements_snapshot, facts_only=False)
            for requirement in requirements:
                assessment = read.latest_assessment(
                    profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
                    source_fingerprint=source_hash,
                )
                if assessment is None:
                    raise ConflictError("Current person qualification is required before preparing wording coverage.")
                if assessment["kind"] not in {"matched", "transferable"}:
                    continue
                # Qualification records supported achievements. Group that
                # explicit mapping; IDs/order never select semantic ownership.
                for ident in assessment["achievement_ids"]:
                    if ident not in inventory or not owned_support(inventory[ident], assessment):
                        raise AppError("fit_achievement_binding_invalid", "The accepted achievement support is unavailable.", 409)
                    groups.setdefault(ident, []).append((requirement, assessment))

        prepared = []
        assessed = reused = assessed_groups = reused_groups = 0
        proposals = []
        current_groups = []
        for achievement_id, entries in groups.items():
            self._check_cancelled(cancelled, operation)
            entries.sort(key=lambda item: item[0]["requirement_id"])
            approved = [row for row in variants if row["achievement_id"] == achievement_id]
            relations, reused_count = self._current_relations(
                profile, entries, approved, facts, profile_snapshot, requirements_snapshot, cancelled, operation,
            )
            reused += reused_count
            current_groups.append((achievement_id, entries, approved, relations))

        # Restore every unchanged exact relation before finding gaps. A binding
        # under another supported achievement can satisfy the requirement too.
        for achievement_id, entries, approved, relations in current_groups:
            self._check_cancelled(cancelled, operation)
            if all(self._has_covered(profile, requirement, assessment, variants) for requirement, assessment in entries):
                continue
            retained_ids, retained = self._retained_requests(profile, inventory[achievement_id], entries)
            missing = {(requirement["requirement_id"], variant["variant_id"])
                       for requirement, _ in entries for variant in approved
                       if relation_key(requirement, variant) not in relations}
            outstanding = {requirement["requirement_id"] for requirement, assessment in entries
                           if not self._has_covered(profile, requirement, assessment, variants)}
            if not missing and (not prepare_wording or outstanding.issubset(retained_ids)):
                proposals.extend(retained if prepare_wording else [])
                continue
            group_facts, sources, bindings, group_key = self._group_inputs(
                profile, inventory[achievement_id], entries, approved, facts,
            )
            owned_ids = {ref["source_id"] for row in bindings for ref in row["evidence_refs"]}
            record = self.store.wording_group_decision(group_key)
            if record is None and operation is not None:
                record = operation.checkpoint_value(group_key)
            inferred = record is None
            if inferred:
                requested_relations = [self._relation_binding(requirement, variant)
                                       for requirement, _ in entries for variant in approved
                                       if relation_key(requirement, variant) in missing]
                result, provenance = await decide(
                    self.model, operation="fit.wording-coverage-grouped", schema=GroupedCoverageDecision,
                    instructions=GROUPED_COVERAGE_INSTRUCTIONS, sources=sources,
                    context={
                        "binding": {"profile_id": profile["profile_id"], "achievement_id": achievement_id,
                                    "achievement_source_refs": inventory[achievement_id].get("source_refs", []),
                                    "requirements": bindings, "approved_variants": approved},
                        "accepted_qualifications": [assessment for _, assessment in entries],
                        "missing_relations": requested_relations,
                        "current_relations": list(relations.values()),
                        "covered_requirement_ids": sorted(set(row["requirement_id"] for row, _ in entries) - outstanding),
                        "retained_requirement_ids": sorted(retained_ids), "retained_requests": retained,
                    },
                )
                self._validate_group(result, achievement_id, entries, approved, group_facts, sources,
                                     missing, relations, retained_ids, outstanding, owned_ids=owned_ids)
                record = {
                    "group_key": group_key, "profile_id": profile["profile_id"], "achievement_id": achievement_id,
                    "requirements": bindings, "source_fingerprint": fingerprint(sources),
                    "requested_relations": requested_relations,
                    "approved_variant_fingerprints": [{"variant_id": row["variant_id"], "revision": row["revision"],
                                                      "fingerprint": variant_fingerprint(row)} for row in approved],
                    "decision": result.model_dump(), "provenance": provenance, "created_at": now(),
                }
                self._check_cancelled(cancelled, operation)
                if operation is not None:
                    operation.checkpoint(group_key, record)
                assessed_groups += 1
            else:
                result = GroupedCoverageDecision.model_validate(record["decision"])
                provenance = record["provenance"]
                # A later user review suppresses authoring below without
                # reopening an already retained semantic determination.
                self._validate_group(result, achievement_id, entries, approved, group_facts, sources,
                                     missing, relations, set(), None, owned_ids=owned_ids,
                                     expected={(row["requirement_id"], row["variant_id"])
                                               for row in record["requested_relations"]})
                reused_groups += 1
            accepted_record = self.store.publish_wording_group_decision(
                record, profile_snapshot, requirements_snapshot, [assessment for _, assessment in entries],
                cancelled=cancelled,
            )
            if accepted_record != record:
                record = accepted_record
                result = GroupedCoverageDecision.model_validate(record["decision"])
                provenance = record["provenance"]
                self._validate_group(result, achievement_id, entries, approved, group_facts, sources,
                                     missing, relations, set(), None, owned_ids=owned_ids,
                                     expected={(row["requirement_id"], row["variant_id"])
                                               for row in record["requested_relations"]})
            requirement_index = {requirement["requirement_id"]: (requirement, assessment)
                                 for requirement, assessment in entries}
            variant_index = {row["variant_id"]: row for row in approved}
            for decision in result.relations:
                if (decision.requirement_id, decision.variant_id) not in missing:
                    continue
                self._check_cancelled(cancelled, operation)
                requirement, assessment = requirement_index[decision.requirement_id]
                variant = variant_index[decision.variant_id]
                relation = coverage_record(decision, profile=profile, requirement=requirement, assessment=assessment,
                    variant=variant, facts=group_facts, provenance=provenance, variant_fingerprint=variant_fingerprint(variant))
                self.store.publish_coverage(relation, profile_snapshot, requirements_snapshot, assessment, cancelled=cancelled)
                assessed += int(inferred)
                reused += int(not inferred)
            if prepare_wording and result.action == "propose_wording":
                prepared.append((achievement_id, entries, record))
            proposals.extend(retained if prepare_wording else [])

        # Proposals advance Profile's wording revision. Finish all decisions
        # against the frozen factual/approved inventory before any authoring.
        for achievement_id, entries, record in prepared:
            self._check_cancelled(cancelled, operation)
            proposal = await self._request_wording(
                profile_snapshot, requirements_snapshot, inventory[achievement_id], entries, record,
                cancelled=cancelled, operation=operation,
            )
            if proposal is not None:
                proposals.append(proposal)
        self._check_cancelled(cancelled, operation)
        self._current_profile(profile_snapshot)
        with self.store.read_snapshot() as read:
            read.validate_sources(profile_snapshot, requirements_snapshot)
        return self._result(proposals, operation, assessed_relations=assessed, reused_relations=reused,
                            assessed_groups=assessed_groups, reused_groups=reused_groups)

    @staticmethod
    def _result(proposals, operation, *, assessed_relations=0, reused_relations=0, assessed_groups=0, reused_groups=0):
        proposals = list({row["proposal_id"]: row for row in proposals}.values())
        failures = [row for row in proposals if row["status"] in {"failed", "uncertain", "generating"}]
        if operation is not None:
            for proposal in failures:
                operation.record_wording_failure(proposal)
        return {"assessed_relations": assessed_relations, "reused_relations": reused_relations,
                "assessed_groups": assessed_groups, "reused_groups": reused_groups,
                "proposals": proposals, "wording_failures": failures}

    def _group_inputs(self, profile, achievement, entries, variants, facts):
        allowed = {source_id(ref) for ref in achievement.get("source_refs", [])}
        allowed.update(ref["source_id"] for _, assessment in entries for ref in assessment["evidence_refs"])
        allowed.update(source_id(ref) for variant in variants for ref in variant["source_refs"])
        group_facts = [source for source in facts if source["source_id"] in allowed]
        sources = group_sources(entries, variants, group_facts)
        bindings = [self._requirement_binding(requirement, assessment, achievement) for requirement, assessment in entries]
        group_key = "fit-wording-group-" + fingerprint({
            "format": "fit-wording-group-v1", "profile_id": profile["profile_id"],
            "achievement_id": achievement["achievement_id"], "achievement": achievement, "sources": sources,
            "requirements": [{key: row[key] for key in row if key not in {
                "assessment_id", "support_receipt_id", "support_rationale",
            }} for row in bindings],
            "approved_variants": [variant_fingerprint(row) for row in variants],
        })
        return group_facts, sources, bindings, group_key

    @staticmethod
    def _validate_group(result, achievement_id, entries, variants, facts, sources, missing, relations,
                        retained_ids, outstanding, *, owned_ids, expected=None):
        validate_group_decision(result, achievement_id=achievement_id, entries=entries, variants=variants,
            facts=facts, sources=sources, missing_relations=missing if expected is None else expected, current_relations=relations,
            retained_requirement_ids=retained_ids, owned_source_ids=owned_ids)
        if not set(missing).issubset((row.requirement_id, row.variant_id) for row in result.relations):
            raise AppError("fit_wording_binding_invalid", "The retained grouped response omitted required relations.", 422)
        if outstanding is not None and not set(result.gap_requirement_ids).issubset(outstanding):
            raise AppError("fit_wording_gap_invalid", "An approved wording already covers the requested expression gap.", 422)

    @staticmethod
    def _relation_binding(requirement, variant):
        return {"requirement_id": requirement["requirement_id"],
                "requirement_revision": str(requirement["requirement_revision"]),
                "achievement_id": variant["achievement_id"], "variant_id": variant["variant_id"],
                "variant_revision": str(variant["revision"])}

    @staticmethod
    def _requirement_binding(requirement, assessment, achievement):
        return {"requirement_id": requirement["requirement_id"], "requirement_revision": requirement["requirement_revision"],
                "definition": requirement["definition"], "qualifiers": requirement.get("qualifiers", {}),
                "scope": requirement["scope"], "assessment_id": assessment["assessment_id"],
                "support_kind": assessment["kind"], "support_strength": assessment.get("strength"),
                "qualification_determination_id": assessment["determination_id"],
                "support_receipt_id": assessment.get("revalidation_provenance", {}).get("receipt_id", assessment["determination_id"]),
                "support_rationale": assessment["rationale"], "evidence_refs": owned_support(achievement, assessment),
                "accepted_evidence_refs": assessment["evidence_refs"]}

    def _current_relations(self, profile, entries, variants, facts, profile_snapshot, requirements_snapshot,
                           cancelled, operation):
        relations = {}
        for requirement, assessment in entries:
            for variant in variants:
                self._check_cancelled(cancelled, operation)
                if not variant.get("approval_id") or not variant.get("source_refs"):
                    raise AppError("fit_unapproved_wording", "Coverage requires exact approved wording and source bindings.", 409)
                relation = self.store.coverage(
                    profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
                    assessment["assessment_id"], variant["variant_id"], variant["revision"],
                )
                if relation is None or relation["variant_fingerprint"] != variant_fingerprint(variant):
                    relation = self._reuse_revalidated(profile, requirement, assessment, variant, facts)
                    if relation is not None:
                        self.store.publish_coverage(relation, profile_snapshot, requirements_snapshot, assessment,
                                                    cancelled=cancelled)
                if relation is not None:
                    relations[relation_key(requirement, variant)] = relation
        return relations, len(relations)

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

    def _reuse_revalidated(self, profile, requirement, assessment, variant, facts):
        for relation in self.store.prior_coverage(
            profile["profile_id"], requirement["requirement_id"], requirement["requirement_revision"],
            variant["variant_id"], variant["revision"],
        ):
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

    def _retained_requests(self, profile, achievement, entries):
        retained, requirements = {}, set()
        for requirement, assessment in entries:
            refs = self._source_refs(owned_support(achievement, assessment))
            for binding in self.store.wording_requests(profile["profile_id"], requirement["requirement_id"],
                                                       requirement["requirement_revision"]):
                if binding.get("achievement_id") != achievement["achievement_id"]:
                    continue
                members = binding.get("requirements", [binding])
                member = next((row for row in members if row["requirement_id"] == requirement["requirement_id"]), None)
                if member is None or self._source_refs(member.get("evidence_refs", binding.get("evidence_refs", []))) != refs:
                    continue
                proposal = self.profile.get_authoring_request(binding["origin_key"], profile["profile_id"])
                if proposal is not None:
                    proposal = self.profile.get_authoring_proposal(proposal["proposal_id"], profile["profile_id"],
                                                                  follow_retry=True)
                    gaps = binding.get("gap_requirement_ids")
                    if gaps is None and "requirements" in binding:
                        detail = self.profile.get_authoring_proposal(proposal["proposal_id"], profile["profile_id"], include_brief=True)
                        gaps = detail["brief"]["origin_metadata"].get("gap_requirement_ids", []) if detail else []
                    if requirement["requirement_id"] not in (gaps if gaps is not None else [binding["requirement_id"]]):
                        continue
                    retained[proposal["proposal_id"]] = {**proposal, "achievement_id": achievement["achievement_id"],
                                                        "requirement_ids": gaps or [requirement["requirement_id"]]}
                    requirements.add(requirement["requirement_id"])
        return requirements, list(retained.values())

    @staticmethod
    def _source_refs(refs):
        return sorted({(ref["source_id"], str(ref["revision"])): {
            "source_id": ref["source_id"], "revision": ref["revision"],
        } for ref in refs}.values(), key=lambda ref: ref["source_id"])

    def _current_profile(self, frozen):
        profile = dto(frozen)
        current = self.qualification.snapshot(profile["profile_id"])
        actual = dto(current)
        if (fact_fingerprint(actual) != fact_fingerprint(profile)
                or sorted(variant_fingerprint(row) for row in actual["approved_variants"])
                != sorted(variant_fingerprint(row) for row in profile["approved_variants"])):
            raise ConflictError("The frozen factual or approved wording inventory changed during preparation.")
        return current

    async def _request_wording(self, profile_snapshot, requirements_snapshot, achievement, entries, record, *,
                               cancelled, operation, retry_proposal=None):
        profile = dto(profile_snapshot)
        retained_ids, _ = self._retained_requests(profile, achievement, entries) if retry_proposal is None else (set(), [])
        requested_gaps = (record["decision"]["gap_requirement_ids"] if retry_proposal is None
                          else retry_proposal["brief"]["origin_metadata"]["gap_requirement_ids"])
        gaps = [ident for ident in requested_gaps if ident not in retained_ids
                and not any(requirement["requirement_id"] == ident
                            and self._has_covered(profile, requirement, assessment, profile["approved_variants"])
                            for requirement, assessment in entries)]
        if not gaps:
            return None
        bindings = [self._requirement_binding(requirement, assessment, achievement) for requirement, assessment in entries]
        accepted = {ref["source_id"]: ref for _, assessment in entries for ref in assessment["evidence_refs"]}
        chosen = [accepted[cite["source_id"][len("evidence:"):]] for cite in record["decision"]["citations"]
                  if cite["source_id"].startswith("evidence:") and cite["source_id"][len("evidence:"):] in accepted]
        refs = self._source_refs([*chosen, *[ref for row in bindings for ref in row["evidence_refs"]]])
        origin = "fit-wording-" + fingerprint({
            "profile_id": profile["profile_id"], "achievement_id": achievement["achievement_id"],
            "gap_requirement_ids": sorted(gaps),
            "requirements": [{"requirement_id": row["requirement_id"], "requirement_revision": row["requirement_revision"],
                              "evidence_refs": self._source_refs(row["evidence_refs"])} for row in bindings],
        })
        retry_metadata = {}
        if retry_proposal is not None:
            origin = "fit-wording-retry-" + fingerprint({"previous_proposal_id": retry_proposal["proposal_id"],
                "previous_origin_key": retry_proposal["origin_key"], "operation_id": operation.operation_id})
            retry_metadata = {"retry_of_proposal_id": retry_proposal["proposal_id"],
                              "retry_of_origin_key": retry_proposal["origin_key"],
                              "prior_remote_outcome": "unknown" if retry_proposal["status"] == "failed" else "semantic_uncertain"}
        self._check_cancelled(cancelled, operation)
        current = self._current_profile(profile_snapshot)
        with self.store.read_snapshot() as read:
            for _, assessment in entries:
                read.validate_sources(current, requirements_snapshot, assessment, facts_only=False)
        prior = self.profile.get_authoring_request(origin, profile["profile_id"])
        if prior is None and operation is not None:
            operation.reserve_wording(achievement["achievement_id"])
        brief = {
            "origin_key": origin, "profile_id": profile["profile_id"], "profile_revision": dto(current)["profile_revision"],
            "fact_semantics_version": profile["fact_semantics_version"], "achievement_id": achievement["achievement_id"],
            "evidence_refs": refs, "support_receipt_id": record["provenance"]["receipt_id"],
            "requested_expression": (
                "Prepare at most one reviewable wording alternative for this achievement's COMPLETE relevant "
                "requirement set. Preserve supported meaning already present in approved wording, and address "
                "the meaningful new expression gaps together. Preserve factual support levels and remaining "
                "qualification gaps. Do not transfer another achievement's claims, add facts, or make separate "
                "variants per requirement. Retained rejected/deferred requests must not be regenerated. "
                + encoded({"requirements": bindings, "new_gap_requirement_ids": gaps})
            ),
            "origin_metadata": {"owner": "fit", "group_key": record["group_key"], "requirements": bindings,
                                "gap_requirement_ids": gaps, "group_determination_id": record["provenance"]["receipt_id"],
                                "group_rationale": record["decision"]["rationale"],
                                "existing_approved_variants": [row for row in profile["approved_variants"]
                                                               if row["achievement_id"] == achievement["achievement_id"]],
                                **retry_metadata},
        }
        try:
            proposal = await self.profile.request_authoring(brief, cancelled=cancelled,
                expected_approved_variants=profile["approved_variants"],
                retry_of_proposal_id=retry_proposal["proposal_id"] if retry_proposal is not None else None)
        except Exception:
            proposal = self.profile.get_authoring_request(origin, profile["profile_id"])
            if proposal is None or proposal["status"] != "failed":
                raise
            if operation is not None:
                operation.record_wording_failure({**proposal, "achievement_id": achievement["achievement_id"]})
        self._check_cancelled(cancelled, operation)
        self._current_profile(profile_snapshot)
        proposal_id = proposal.get("proposal_id") or proposal.get("request_id")
        if not isinstance(proposal_id, str) or not proposal_id:
            raise AppError("fit_wording_request_invalid", "Profile did not return a retained authoring request identity.", 422)
        binding = {"origin_key": origin, "profile_id": profile["profile_id"], "requirements": bindings,
                   "proposal_id": proposal_id, "achievement_id": achievement["achievement_id"],
                   "evidence_refs": refs, "group_key": record["group_key"], "gap_requirement_ids": gaps,
                   **retry_metadata, "created_at": now()}
        self.store.publish_wording_request(binding, profile_snapshot, requirements_snapshot,
                                           [assessment for _, assessment in entries], cancelled=cancelled)
        return {**proposal, "proposal_id": proposal_id, "achievement_id": achievement["achievement_id"],
                "requirement_ids": gaps}

    @staticmethod
    def _check_cancelled(cancelled, operation=None):
        if cancelled():
            raise asyncio.CancelledError()
        if operation is not None:
            operation.check()
