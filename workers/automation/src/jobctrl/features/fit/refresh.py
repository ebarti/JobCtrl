"""One manually admitted catalog selection with fixed sources and durable limits."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .contract import CONTRACT_VERSION, assessment_fields, current_contract, require_contract, reusable
from .coverage import Coverage
from .domain import FORMULA_VERSION, calculate_score
from .models import CATALOG_IMPACT_INSTRUCTIONS, CatalogImpactDecision
from .qualification import decide, now
from .refresh_pending import pending_wording_failures, valid_requirement_bindings
from .serialization import encoded
from .sources import (
    FrozenFitProfileSnapshot, achievement_inventory, achievements, approved_fingerprint,
    citations_still_bound, dto, fact_fingerprint, fact_sources, fingerprint,
    job_fingerprint, permitted_facts, qualification_fingerprint, requirement_source, source_id, validate_citations,
)


def public_operation(state):
    if state is None:
        return None
    return {"contract_version": state.get("contract_version"), "current": current_contract(state),
            "stale_reasons": [] if current_contract(state) else ["contract_changed"], **{key: state[key] for key in (
        "operation_id", "profile_id", "status", "phase", "job_ids", "catalog_revision", "requirement_count",
        "selected_requirement_ids", "limits", "counters", "failure_code", "created_at", "deadline_at", "updated_at",
        "factual_published", "accepted_score_revisions",
    )}} | {"partial": bool(state["factual_published"] and state["status"] not in {"running", "completed"}),
         "hard_monetary_bound": False, "spend_policy": "gateway_lane_and_workspace_budget",
         "wording_failures": state.get("wording_failures", []),
         "retry_wording_proposal_ids": state.get("retry_wording_proposal_ids", [])}


def normalize_catalog(catalog):
    return [{**row, "requirement_revision": row["revision"]} for row in catalog["requirements"]]


def _mandatory(previous, requirement, profile, facts):
    if not current_contract(previous) or str(previous["requirement_revision"]) != str(requirement["requirement_revision"]):
        return True
    if not citations_still_bound(previous["evidence_refs"], facts):
        return True
    inventory = achievements(profile)
    cited = {ref["source_id"] for ref in previous["evidence_refs"]}
    return any(ident not in inventory or not cited.intersection(source_id(ref) for ref in inventory[ident].get("source_refs", []))
               for ident in previous["achievement_ids"])


class RefreshOperation:
    """Capability passed to model/authoring adapters; reservations precede I/O."""

    def __init__(self, store, operation_id, model, profile, cancelled):
        self.store, self.operation_id, self.cancelled = store, operation_id, cancelled
        self.model = BoundedModel(self, model)
        self.profile = BoundedProfile(self, profile)

    def state(self):
        return self.store.refresh_operation(self.operation_id)

    def check(self):
        if self.cancelled():
            raise asyncio.CancelledError()
        state = self.store.validate_refresh(self.operation_id)
        if datetime.now(timezone.utc) >= datetime.fromisoformat(state["deadline_at"]):
            raise AppError("fit_refresh_time_limit", "The manual Fit refresh reached its fixed deadline.", 409)
        return state

    @property
    def retry_wording_proposal_ids(self):
        return tuple(self.state().get("retry_wording_proposal_ids", []))

    def record_wording_failure(self, proposal):
        state = self.state()
        if state["status"] != "running":
            return
        failures = {row["proposal_id"]: row for row in state.get("wording_failures", [])}
        failures[proposal["proposal_id"]] = {**failures.get(proposal["proposal_id"], {}),
            **{key: proposal.get(key) for key in ("proposal_id", "status", "failure_code")}}
        if isinstance(proposal.get("achievement_id"), str):
            failures[proposal["proposal_id"]]["achievement_id"] = proposal["achievement_id"]
        self.store.update_refresh(self.operation_id, {"wording_failures": list(failures.values())})

    def checkpoint_value(self, key):
        return self.state()["checkpoints"].get(key)

    def checkpoint(self, key, value):
        return self.store.checkpoint_refresh(self.operation_id, key, value)

    def reserve_wording(self, achievement_id):
        self.check()
        self.store.reserve_refresh_wording(self.operation_id, achievement_id)

    async def external(self, key, kind, invoke):
        state = self.check()
        retained = self.store.reserve_refresh_call(self.operation_id, key, kind)
        if retained is not None:
            return retained
        remaining = (datetime.fromisoformat(state["deadline_at"]) - datetime.now(timezone.utc)).total_seconds()
        if remaining <= 0:
            raise AppError("fit_refresh_time_limit", "The manual Fit refresh reached its fixed deadline.", 409)
        try:
            result = await asyncio.wait_for(invoke(), timeout=remaining)
        except TimeoutError:
            raise AppError("fit_refresh_time_limit", "The manual Fit refresh reached its fixed deadline.", 409) from None
        self.check()
        self.store.complete_refresh_call(self.operation_id, key, result)
        return result


class BoundedModel:
    def __init__(self, operation, model):
        self.operation, self._model = operation, model

    async def determine(self, **arguments):
        key = "model:" + fingerprint(arguments)
        async def invoke():
            response = await self._model.determine(**arguments)
            return {"value": response.value, "provenance": dto(response.provenance) if not isinstance(response.provenance, dict) else response.provenance}
        value = await self.operation.external(key, arguments["operation"], invoke)
        return SimpleNamespace(**value)

    def receipt(self, receipt_id):
        return self._model.receipt(receipt_id)


class BoundedProfile:
    def __init__(self, operation, profile):
        self.operation, self._profile = operation, profile

    def __getattr__(self, name):
        return getattr(self._profile, name)

    async def request_authoring(self, brief, *, cancelled=lambda: False, expected_approved_variants=None,
                               retry_of_proposal_id=None):
        self.operation.check()
        retained = self._profile.get_authoring_request(brief["origin_key"], profile_id=brief.get("profile_id", "default"))
        if retained is not None:
            return retained
        # Profile's public request makes one determination. Count it before the
        # call without replacing Profile's own source and approval validation.
        key = "authoring:" + brief["origin_key"]
        options = {"expected_approved_variants": self.operation.state()["snapshot"]["profile"]["approved_variants"]}
        if retry_of_proposal_id is not None:
            options["retry_of_proposal_id"] = retry_of_proposal_id
        return await self.operation.external(key, "profile.wording_authoring",
            lambda: self._profile.request_authoring(brief, cancelled=cancelled, **options))


class ManualRefresh:
    def __init__(self, service):
        self.service, self.store = service, service.store

    def _inputs(self, read, profile_id, *, profile_snapshot=None):
        from .service import unique_requirements
        if profile_snapshot is None:
            profile_snapshot = read.profile_snapshot(profile_id)
        profile = dto(profile_snapshot)
        catalog = read.catalog_snapshot()
        require_contract(catalog)
        requirements = normalize_catalog(catalog)
        prior = {row["requirement_id"]: read.latest_requirement_assessment(profile_id, row["requirement_id"])
                 for row in requirements}
        jobs = []
        stale = []
        for job_id in read.scored_job_ids():
            score = read.latest_score(job_id)
            if score["source_binding"]["profile_id"] != profile_id:
                continue
            try:
                job_snapshot = read.job_requirements(job_id)
                unique_requirements(job_snapshot)
                current = self.service._get_job_fit(read, job_id, profile_id, include_coverage=False)
                if (not current["current"] or not self.service._wording_inventory_current(read, profile, score)):
                    stale.append(job_id)
                jobs.append({"job_id": job_id, "score_revision": score["revision"], "score": score, "requirements": job_snapshot})
            except AppError as error:
                if not isinstance(error, (NotFoundError, ConflictError)) and error.code not in {"contract_changed", "unsupported_posting_language"}:
                    raise
                stale.append(job_id)
                jobs.append({"job_id": job_id, "score_revision": score["revision"], "source_error": error.code})
        direct = [item for job in jobs if "source_error" not in job
                  for item in unique_requirements(job["requirements"]) if not reusable(item)]
        prior.update({row["requirement_id"]: read.latest_requirement_assessment(profile_id, row["requirement_id"])
                      for row in direct})
        source_hash = fact_fingerprint(profile)
        maintained_wordings = read.current_wordings(profile_id)
        maintained_fingerprint = read.current_wordings_fingerprint(profile_id)
        stamp = fingerprint({
            "profile_id": profile_id, "facts": source_hash, "approved": approved_fingerprint(profile),
            "guidance": profile_snapshot.scoring_guidance, "catalog": catalog, "jobs": jobs,
            "assessment_ids": {ident: row["assessment_id"] if row else None for ident, row in prior.items()},
            "current_wordings_fingerprint": maintained_fingerprint,
        })
        return {"profile": profile, "guidance": profile_snapshot.scoring_guidance,
                "facts": fact_sources(profile), "catalog": catalog, "jobs": jobs, "direct_requirements": direct,
                "prior_assessments": prior, "current_wordings": maintained_wordings,
                "current_wordings_fingerprint": maintained_fingerprint,
                "prior_sources": {row["assessment_id"]: read.assessment_sources(row["assessment_id"])
                                  for row in prior.values() if row is not None}}, stamp, stale

    def pending(self, profile_id="default"):
        with self.store.read_snapshot() as read:
            try:
                profile_snapshot = read.profile_snapshot(profile_id)
            except NotFoundError:
                # Jobs and optional features are usable before Profile exists.
                # Absence is readiness, not a fabricated current source stamp.
                return {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "readiness": "profile_required"}
            snapshot, stamp, stale = self._inputs(read, profile_id, profile_snapshot=profile_snapshot)
            latest = read.latest_refresh(profile_id)
            wording_failures = pending_wording_failures(read, snapshot)
            reasons = []
            if stale:
                reasons.append("saved_job_inputs_changed")
            if wording_failures:
                reasons.append("wording_requests_incomplete")
            if (latest is not None and latest["status"] in {"failed", "cancelled", "stale", "limited"}
                    and (latest.get("failure_code") != "fit_refresh_wording_incomplete" or wording_failures)):
                reasons.append("manual_refresh_incomplete")
            if any(not current_contract(row) or row["source_fingerprint"] != qualification_fingerprint(snapshot["profile"], requirement, snapshot["facts"])
                   or str(row["requirement_revision"]) != str(requirement["revision"])
                   for requirement in snapshot["catalog"]["requirements"]
                   for row in [snapshot["prior_assessments"][requirement["requirement_id"]]]):
                reasons.append("catalog_qualification_pending")
            if (latest is not None and latest["status"] == "completed"
                    and (latest["snapshot"]["catalog"] != snapshot["catalog"]
                         or approved_fingerprint(latest["snapshot"]["profile"]) != approved_fingerprint(snapshot["profile"]))):
                reasons.append("saved_catalog_or_wording_changed")
            return {"contract_version": CONTRACT_VERSION, "profile_id": profile_id, "readiness": "ready", "pending": bool(reasons), "pending_reasons": reasons,
                    "stale_job_ids": stale, "available_job_ids": [row["job_id"] for row in snapshot["jobs"] if "source_error" not in row],
                    "catalog_revision": snapshot["catalog"]["catalog_revision"],
                    "requirement_count": len(snapshot["catalog"]["requirements"]),
                    "expected_input_fingerprint": stamp, "latest_operation": public_operation(latest),
                    "pending_wording_failures": wording_failures}

    def operation(self, operation_id, *, allow_pending=False):
        state = self.store.refresh_operation(operation_id)
        if state is None and allow_pending:
            return None
        if state is None:
            raise NotFoundError("The manual Fit refresh has not started or does not exist.")
        return public_operation(state)

    def interrupt(self, operation_id, status, failure_code=None, *, connection=None):
        if status in {"cancelled", "failed"}:
            self.store.finish_refresh(operation_id, status, failure_code, connection=connection)

    def _retry_inputs(self, read, snapshot, proposal_ids):
        profile = snapshot["profile"]
        facts = {row["source_id"]: row for row in snapshot["facts"]}
        inventory = achievements(profile)
        catalog = {row["requirement_id"]: row for row in snapshot["catalog"]["requirements"]}
        selected = []
        owners = set()
        for ident in proposal_ids:
            proposal = read.authoring_proposal(ident, profile["profile_id"], include_brief=True)
            if proposal is None or proposal["status"] not in {"failed", "uncertain"}:
                raise AppError("fit_refresh_retry_invalid", "Select only retained failed or uncertain wording proposals from this Profile.", 409)
            brief = proposal.get("brief", {})
            metadata = brief.get("origin_metadata", {})
            owner = brief.get("achievement_id")
            if not isinstance(metadata, dict):
                raise AppError("fit_refresh_retry_invalid", "This proposal has no grouped Fit source binding.", 409)
            require_contract(metadata)
            latest = read.authoring_proposal(ident, profile["profile_id"], follow_retry=True)
            if latest is None or latest["proposal_id"] != ident:
                raise AppError("fit_refresh_retry_invalid", "Select the current failed wording attempt; this one has a successor.", 409)
            if owner in owners:
                raise AppError("fit_refresh_retry_ambiguous", "Select one failed proposal for each achievement.", 409)
            owners.add(owner)
            if (owner not in inventory or metadata.get("owner") != "fit"
                    or not isinstance(metadata.get("group_key"), str) or not metadata["group_key"]
                    or not metadata.get("requirements") or not isinstance(metadata.get("gap_requirement_ids"), list)
                    or not metadata["gap_requirement_ids"] and metadata.get("authoring_action") != "propose_consolidation"
                    or any(not isinstance(ident, str) or not ident for ident in metadata["gap_requirement_ids"])):
                raise AppError("fit_refresh_retry_invalid", "This proposal has no exact grouped Fit source binding.", 409)
            for ref in brief.get("evidence_refs", []):
                if ref.get("source_id") not in facts or facts[ref["source_id"]]["revision"] != ref.get("revision"):
                    raise AppError("fit_refresh_retry_stale", "The failed wording's sources changed. Run a normal manual Fit refresh first.", 409)
            if not valid_requirement_bindings(metadata["requirements"]):
                raise AppError("fit_refresh_retry_invalid", "This proposal has no exact requirement bindings.", 409)
            for requirement in metadata["requirements"]:
                current = catalog.get(requirement["requirement_id"])
                prior = snapshot["prior_assessments"].get(requirement["requirement_id"])
                if (current is None or str(current["revision"]) != str(requirement["requirement_revision"])
                        or prior is None or prior["source_fingerprint"] != qualification_fingerprint(profile, current, snapshot["facts"])
                        or owner not in prior["achievement_ids"]
                        or prior["determination_id"] != requirement.get("qualification_determination_id")):
                    raise AppError("fit_refresh_retry_stale", "The failed wording's accepted support changed. Run a normal manual Fit refresh first.", 409)
            selected.append(proposal)
        return selected

    def _start(self, operation_id, request):
        input_hash = fingerprint(request)
        existing = self.store.refresh_operation(operation_id)
        if existing is not None:
            require_contract(existing)
            if existing["input_fingerprint"] != input_hash:
                raise ConflictError("The manual refresh identity belongs to different input.")
            return existing
        with self.store.read_snapshot() as read:
            snapshot, stamp, _ = self._inputs(read, request["profile_id"])
        if stamp != request["expected_input_fingerprint"]:
            raise AppError("fit_refresh_stale", "Saved inputs changed before this manual Fit refresh started. Review the pending work and start a new refresh.", 409)
        retry_ids = request.get("retry_wording_proposal_ids", [])
        for ident in retry_ids:
            # Explicit retry admission may resolve a dead authoring owner, but
            # the read-only pending/operation endpoints never mutate Profile.
            self.service.profile.get_authoring_proposal(ident, request["profile_id"], recover_interrupted=True)
        with self.store.read_snapshot() as read:
            snapshot["retry_proposals"] = self._retry_inputs(read, snapshot, retry_ids)
        available = {row["job_id"]: row for row in snapshot["jobs"] if "source_error" not in row}
        if any(ident not in available for ident in request["job_ids"]):
            raise AppError("fit_refresh_job_scope_invalid", "Select only saved jobs from the reviewed pending Fit summary.", 409)
        snapshot["jobs"] = [available[ident] for ident in request["job_ids"]]
        from .service import unique_requirements
        snapshot["direct_requirements"] = [item for job in snapshot["jobs"]
            for item in unique_requirements(job["requirements"]) if not reusable(item)]
        admitted = {row["requirement_id"] for row in normalize_catalog(snapshot["catalog"]) + snapshot["direct_requirements"]}
        snapshot["prior_assessments"] = {ident: row for ident, row in snapshot["prior_assessments"].items() if ident in admitted}
        before_ids = {row["assessment_id"] for row in snapshot["prior_assessments"].values() if row is not None}
        snapshot["prior_sources"] = {ident: rows for ident, rows in snapshot["prior_sources"].items() if ident in before_ids}
        created = now()
        return self.store.start_refresh({
            "contract_version": CONTRACT_VERSION,
            "operation_id": operation_id, "input_fingerprint": input_hash, "profile_id": request["profile_id"],
            "status": "running", "phase": "selection", "job_ids": request["job_ids"],
            "catalog_revision": snapshot["catalog"]["catalog_revision"],
            "requirement_count": len(admitted), "selected_requirement_ids": None,
            "limits": request["limits"], "counters": {"model_calls": 0, "requirements_assessed": 0,
                "qualifications_reused": 0, "wording_proposals": 0}, "prepare_wording": request["prepare_wording"],
            "failure_code": None, "created_at": created, "updated_at": created,
            "deadline_at": (datetime.fromisoformat(created) + timedelta(seconds=request["limits"]["max_duration_seconds"])).isoformat(),
            "factual_published": False, "accepted_score_revisions": {}, "snapshot": snapshot,
            "calls": {}, "checkpoints": {}, "wording_achievements": [], "wording_failures": [],
            "retry_wording_proposal_ids": request.get("retry_wording_proposal_ids", []),
        })

    async def run(self, *, operation_id, request, cancelled=lambda: False, heartbeat=lambda details: None):
        state = self._start(operation_id, request)
        if state["status"] == "completed":
            return public_operation(state)
        if state["status"] != "running":
            raise AppError(state["failure_code"] or "fit_refresh_terminal", "This manual Fit refresh is already terminal.", 409)
        operation = RefreshOperation(self.store, operation_id, self.service.model, self.service.profile, cancelled)
        try:
            operation.check()
            profile_snapshot = FrozenFitProfileSnapshot(state["snapshot"]["profile"], state["snapshot"]["guidance"], operation_id)
            requirements = normalize_catalog(state["snapshot"]["catalog"]) + state["snapshot"]["direct_requirements"]
            if state.get("retry_wording_proposal_ids"):
                state = self.store.update_refresh(operation_id, {"selected_requirement_ids": [], "phase": "coverage"})
            elif not state["factual_published"]:
                selection = operation.checkpoint_value("selection")
                if selection is None:
                    selection = await self._select(operation, state, requirements)
                    operation.checkpoint("selection", selection)
                selected = [row["requirement_id"] for row in selection["decision"]["requirements"] if row["verdict"] == "affected"]
                state = self.store.update_refresh(operation_id, {"selected_requirement_ids": selected, "phase": "qualification"})
                if len(selected) > state["limits"]["max_requirements"]:
                    raise AppError("fit_refresh_requirement_limit", "The selected requirements exceed this manual refresh's fixed work limit.", 409)
                batch = operation.checkpoint_value("qualification_batch")
                if batch is None:
                    pending = [row for row in requirements if row["requirement_id"] in selected
                               and operation.checkpoint_value("qualification:" + row["requirement_id"]) is None]
                    prepared = await self.service.qualification.candidates(profile_snapshot, pending, model=operation.model)
                    batch = {row["requirement_id"]: {**row, "refresh_operation_id": operation_id,
                             "impact_selection_receipt_id": selection["provenance"]["receipt_id"]} for row in prepared}
                    operation.check()
                    operation.checkpoint("qualification_batch", batch)
                candidates = {}
                for requirement in requirements:
                    operation.check()
                    ident = requirement["requirement_id"]
                    if ident in selected:
                        candidate = operation.checkpoint_value("qualification:" + ident)
                        if candidate is None:
                            candidate = batch.get(ident)
                            if candidate is None:
                                raise AppError("fit_refresh_checkpoint_invalid", "The retained qualification batch is incomplete.", 409)
                            operation.checkpoint("qualification:" + ident, candidate)
                        candidates[ident] = candidate
                    else:
                        candidates[ident] = self._alias(state, requirement, selection)
                    heartbeat({"operationId": operation_id, "phase": "qualification", "completed": len(candidates),
                               "total": len(requirements)})
                counters = operation.state()["counters"]
                counters.update({"requirements_assessed": len(selected), "qualifications_reused": len(requirements) - len(selected)})
                self.store.update_refresh(operation_id, {"counters": counters, "phase": "publication"})
                scores = self._scores(state, candidates)
                operation.check()
                state = self.store.publish_refresh(operation_id, candidates, scores, cancelled=cancelled)
            heartbeat({"operationId": operation_id, "phase": "coverage"})
            coverage = Coverage(model=operation.model, profile=operation.profile, store=self.store,
                                qualification=self.service.qualification)
            result = await coverage.refresh(profile_snapshot, state["snapshot"]["catalog"], [row for row in requirements if reusable(row)],
                                            prepare_wording=state["prepare_wording"], cancelled=cancelled, operation=operation)
            operation.checkpoint("coverage_result", result)
            failures = {row["proposal_id"]: row for row in result.get("wording_failures", [])}
            for proposal in result.get("proposals", []):
                if proposal.get("status") in {"failed", "uncertain", "generating"}:
                    failures.setdefault(proposal["proposal_id"], proposal)
            for proposal in failures.values():
                operation.record_wording_failure(proposal)
            if failures:
                raise AppError("fit_refresh_wording_incomplete", "Some wording requests remain failed or uncertain. Review their retained results before an explicit retry.", 409)
            operation.check()
            return public_operation(self.store.finish_refresh(operation_id, "completed"))
        except asyncio.CancelledError:
            # The application finalizer distinguishes explicit cancellation from
            # worker shutdown. Shutdown must leave this identity recoverable.
            raise
        except AppError as error:
            status = "stale" if isinstance(error, (ConflictError, NotFoundError)) or error.code == "fit_refresh_stale" else (
                "limited" if error.code in {"fit_refresh_requirement_limit", "fit_refresh_model_limit", "fit_refresh_time_limit", "fit_refresh_wording_limit"} else "failed")
            self.store.finish_refresh(operation_id, status, error.code)
            raise

    async def _select(self, operation, state, requirements):
        snapshot = state["snapshot"]
        facts = snapshot["facts"]
        sources = [{**row, "source_id": "current:" + row["source_id"]} for row in facts]
        structure = achievement_inventory(snapshot["profile"])
        sources.append({"source_id": "current:achievement-structure", "revision": "1", "text": encoded(structure)})
        inventories = set()
        entries = []
        for requirement in requirements:
            ident = requirement["requirement_id"]
            canonical = requirement_source(requirement)
            sources.append({**canonical, "source_id": "catalog:" + ident})
            previous = snapshot["prior_assessments"][ident]
            before = snapshot["prior_sources"].get(previous["assessment_id"], []) if previous else []
            before_structure = previous.get("achievement_inventory", {}) if previous else {}
            baseline = fingerprint({"facts": before, "achievements": before_structure})
            if baseline not in inventories:
                inventories.add(baseline)
                sources.extend({**row, "source_id": "before:" + baseline + ":" + row["source_id"]} for row in before)
                sources.append({"source_id": "before:" + baseline + ":achievement-structure", "revision": "1", "text": encoded(before_structure)})
            relevant_before = permitted_facts(requirement, before) + [row for row in before if row.get("kind") == "user_scoring_guidance"]
            relevant_after = permitted_facts(requirement, facts) + [row for row in facts if row.get("kind") == "user_scoring_guidance"]
            before_index = {row["source_id"]: row for row in relevant_before}
            after_index = {row["source_id"]: row for row in relevant_after}
            changed = {key for key in set(before_index) | set(after_index) if before_index.get(key) != after_index.get(key)}
            if structure != before_structure:
                changed.add("achievement-structure")
            changed_ids = []
            for key in sorted(changed):
                if key == "achievement-structure" or key in after_index and after_index[key]["text"].strip():
                    changed_ids.append("current:" + key)
                if key == "achievement-structure" or key in before_index and before_index[key]["text"].strip():
                    changed_ids.append("before:" + baseline + ":" + key)
            assessment_source = "assessment:" + ident
            sources.append({"source_id": assessment_source, "revision": previous["assessment_id"] if previous else "none",
                            "text": encoded(previous) if previous else "No previous assessment exists."})
            entries.append({"requirement_id": ident, "requirement_revision": str(requirement["requirement_revision"]),
                            "category": requirement["category"], "name": requirement["name"],
                            "canonical_source_id": "catalog:" + ident, "saved_assessment_source_id": assessment_source,
                            "prior_assessment_id": previous["assessment_id"] if previous else None,
                            "before_inventory_id": baseline, "changed_source_ids": changed_ids,
                            "mandatory_reassessment": _mandatory(previous, requirement, snapshot["profile"], facts)})
        # Exact recorded factual authority needs no semantic rejudgment. This
        # also makes wording-only refreshes and unchanged manual retries free
        # of impact/qualification calls while still checking the full catalog.
        item_index = {row["requirement_id"]: row for row in requirements}
        if all(not row["mandatory_reassessment"] and
               snapshot["prior_assessments"][row["requirement_id"]]["source_fingerprint"] ==
               qualification_fingerprint(snapshot["profile"], item_index[row["requirement_id"]], facts) for row in entries):
            return {"decision": {"requirements": [{"requirement_id": row["requirement_id"],
                    "requirement_revision": row["requirement_revision"], "verdict": "unchanged",
                    "rationale": "The exact current factual qualification is already recorded.", "citations": []} for row in entries]},
                    "provenance": None, "kind": "exact_binding_reuse"}
        result, provenance = await decide(operation.model, operation="fit.catalog-impact", schema=CatalogImpactDecision,
            instructions=CATALOG_IMPACT_INSTRUCTIONS, sources=sources,
            context={"profile_id": state["profile_id"], "catalog_revision": state["catalog_revision"],
                     "requirements": entries, "fact_semantics_version": snapshot["profile"]["fact_semantics_version"]})
        index = {row["requirement_id"]: row for row in entries}
        returned = [row.requirement_id for row in result.requirements]
        if len(returned) != len(set(returned)) or set(returned) != set(index):
            raise AppError("fit_refresh_partition_invalid", "The catalog impact decision must partition every frozen requirement exactly once.", 422)
        for row in result.requirements:
            expected = index[row.requirement_id]
            if row.requirement_revision != expected["requirement_revision"]:
                raise AppError("fit_requirement_binding_invalid", "The catalog impact decision referenced an older requirement.", 422)
            validate_citations(row.citations, sources, required_ids=(expected["canonical_source_id"],))
            allowed = {"catalog:" + row.requirement_id, "assessment:" + row.requirement_id}
            if any(cite.source_id not in allowed and not cite.source_id.startswith("current:")
                   and not cite.source_id.startswith("before:" + expected["before_inventory_id"] + ":") for cite in row.citations):
                raise AppError("fit_refresh_baseline_invalid", "The impact decision cited another requirement's source baseline.", 422)
            if (expected["changed_source_ids"] and not set(expected["changed_source_ids"]).intersection(cite.source_id for cite in row.citations)):
                raise AppError("fit_change_citation_missing", "The impact decision did not cite a changed source from this assessment's baseline.", 422)
            if expected["mandatory_reassessment"] and row.verdict != "affected":
                raise AppError("fit_refresh_dependency_invalid", "The impact decision retained an assessment without current exact dependencies.", 422)
        return {"decision": result.model_dump(), "provenance": provenance}

    @staticmethod
    def _alias(state, requirement, selection):
        snapshot = state["snapshot"]
        previous = snapshot["prior_assessments"][requirement["requirement_id"]]
        source_hash = qualification_fingerprint(snapshot["profile"], requirement, snapshot["facts"])
        if previous["source_fingerprint"] == source_hash:
            return previous
        provenance = selection["provenance"]
        sources = {row["source_id"]: row for row in snapshot["facts"]}
        rationale = next(row["rationale"] for row in selection["decision"]["requirements"] if row["requirement_id"] == requirement["requirement_id"])
        return {**previous, "assessment_id": "fit-assessment-" + fingerprint({
            "previous": previous["assessment_id"], "sources": source_hash, "impact_receipt": provenance["receipt_id"],
        }), "origin": "revalidated", "source_fingerprint": source_hash,
            "fact_semantics_version": snapshot["profile"]["fact_semantics_version"],
            "revalidated_from": previous["assessment_id"], "revalidation_provenance": provenance,
            "refresh_operation_id": state["operation_id"], "impact_selection_receipt_id": provenance["receipt_id"],
            "revalidation_rationale": rationale, "created_at": now(),
            "achievement_inventory": achievement_inventory(snapshot["profile"]),
            "evidence_refs": [{**ref, "revision": sources[ref["source_id"]]["revision"]} for ref in previous["evidence_refs"]]}

    @staticmethod
    def _scores(state, candidates):
        from .service import unique_requirements
        profile = state["snapshot"]["profile"]
        results = []
        for job in state["snapshot"]["jobs"]:
            requirements = job["requirements"]
            rows = unique_requirements(requirements)
            assessments = []
            for row in rows:
                candidate = candidates.get(row["requirement_id"])
                if candidate is None or str(candidate["requirement_revision"]) != str(row["requirement_revision"]):
                    raise ConflictError("The selected job does not use the frozen canonical catalog.")
                assessments.append({**candidate, **assessment_fields(row)})
            try:
                resolved = calculate_score(assessments)
            except (ValueError, KeyError, TypeError):
                raise AppError("fit_score_inputs_invalid", "No coherent typed qualification score can be calculated.", 422) from None
            candidate = {**resolved, "job_id": job["job_id"], "revision": job["score_revision"] + 1,
                "source_binding": {"contract_version": CONTRACT_VERSION, "profile_id": state["profile_id"], "profile_revision": profile["profile_revision"],
                    "fact_semantics_version": profile["fact_semantics_version"], "source_fingerprint": job_fingerprint(profile, rows),
                    "scoring_guidance_fingerprint": fingerprint(state["snapshot"]["guidance"]),
                    "approved_variants_fingerprint": approved_fingerprint(profile),
                    "requirements_revision": requirements["revision"], "posting_revision": requirements["posting_revision"],
                    "posting_hash": requirements["posting_hash"], "assessment_ids": [row["assessment_id"] for row in assessments],
                    "requirements": [{"requirement_id": row["requirement_id"], "requirement_revision": row["requirement_revision"]} for row in rows]},
                "created_at": now(), "origin": "model", "correction": None, "policy_version": FORMULA_VERSION,
                "refresh_operation_id": state["operation_id"]}
            previous = job["score"]
            binding = candidate["source_binding"]
            if current_contract(previous) and all(previous["source_binding"].get(key) == binding[key] for key in (
                    "profile_id", "source_fingerprint", "requirements_revision", "posting_revision",
                    "posting_hash", "assessment_ids", "requirements")):
                continue
            authority_keys = ("requirement_id", "requirement_revision", "determination_id", "category")
            if (current_contract(previous) and previous.get("correction") is not None
                    and [{key: row.get(key) for key in authority_keys} for row in previous["assessments"]]
                    == [{key: row.get(key) for key in authority_keys} for row in assessments]):
                # Rebinding an unchanged semantic receipt must not revoke an
                # explicit score correction or invent a new human decision.
                candidate.update({"score": previous["score"], "fit_band": previous["fit_band"],
                                  "origin": "manual", "correction": previous["correction"]})
            results.append(candidate)
        return results
