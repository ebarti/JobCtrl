"""One initial missing-set batch and strictly model-free cohort score publication."""

from copy import deepcopy
from types import SimpleNamespace

from jobctrl.app.errors import AppError, ConflictError

from .cohort_storage import COHORT_VERSION
from .cohort_citations import RESPONSE_VERSION
from .contract import CONTRACT_VERSION, assessment_fields, current_qualification, qualification_key
from .domain import FORMULA_VERSION, calculate_score
from .models import QUALIFICATION_PROMPT_VERSION, QUALIFICATION_SEMANTICS_VERSION
from .qualification import now
from .sources import (FrozenFitProfileSnapshot, approved_fingerprint, dto, fact_sources, fingerprint,
                      job_fingerprint, qualification_fingerprint, requirement_source)


class CohortModel:
    def __init__(self, service, operation_id, cancelled):
        self.service, self.operation_id, self.cancelled = service, operation_id, cancelled

    async def determine(self, **arguments):
        self.service._check_cancelled(self.cancelled)
        state = self.service.store.initial_cohort_operation(self.operation_id)
        request_hash = fingerprint(arguments)
        call = state.get("call")
        if call is not None:
            if call["arguments_fingerprint"] != request_hash:
                raise AppError("fit_cohort_interrupted", "The retained cohort model call needs an explicit reviewed retry.", 409)
            if call["status"] == "completed":
                return SimpleNamespace(**deepcopy(call["result"]))
            selection = call["selection"]
            expected = fingerprint({**arguments, **selection, "execution": call["execution"]})
            if expected != call["input_fingerprint"]:
                raise AppError("fit_cohort_interrupted", "The original cohort request cannot be reconstructed.", 409)
            receipt = self.service.model.find_succeeded(expected)
            if receipt is None:
                raise AppError("fit_cohort_interrupted", "The frozen cohort call has no settled successful receipt.", 409)
            if (receipt["status"] != "succeeded" or receipt["input_fingerprint"] != expected
                    or any(receipt[key] != arguments[key] for key in ("operation", "lane", "prompt_version"))
                    or any(receipt[key] != value for key, value in selection.items())):
                raise AppError("fit_model_provenance_invalid", "The settled receipt differs from the frozen cohort request.", 422)
            raw = {"value": receipt["value"], "provenance": {key: receipt[key] for key in
                ("receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at")}}
            self.service.store.complete_initial_cohort_call(self.operation_id, raw)
            return SimpleNamespace(**raw)
        model = self.service.model
        execution = model.freeze_execution()
        input_hash = model.fingerprint(**arguments, execution=execution)
        def admitted(connection, _receipt_id):
            self.service.store.reserve_initial_cohort_call(self.operation_id, request_hash,
                {"provider": execution.provider, "model": execution.model}, execution.identity(), input_hash, connection=connection)
        result = await model.determine(**arguments, execution=execution, on_admitted=admitted)
        raw = {"value": result.value, "provenance": dto(result.provenance)}
        if raw["provenance"]["input_fingerprint"] != input_hash:
            raise AppError("fit_model_provenance_invalid", "The cohort receipt belongs to another request.", 422)
        self.service.store.complete_initial_cohort_call(self.operation_id, raw)
        return SimpleNamespace(**raw)

    def receipt(self, receipt_id):
        return self.service.model.receipt(receipt_id)


class InitialCohortService:
    async def qualify_cohort(self, job_ids, *, expected_requirements, expected_score_revisions, operation_id, profile_id="default",
                             cancelled=lambda: False, heartbeat=lambda details: None):
        if (not isinstance(operation_id, str) or not operation_id or not isinstance(job_ids, list)
                or not 1 <= len(job_ids) <= 1000 or len(set(job_ids)) != len(job_ids)
                or set(expected_requirements) != set(job_ids) or set(expected_score_revisions) != set(job_ids)
                or any(type(expected_score_revisions[job]) is not int or expected_score_revisions[job] < 0
                       for job in job_ids)):
            raise AppError("fit_cohort_scope_invalid", "Choose the exact frozen initial-assessment cohort.", 422)
        request = {"cohort_version": COHORT_VERSION, "job_ids": job_ids, "profile_id": profile_id,
                   "expected_requirements": expected_requirements, "expected_score_revisions": expected_score_revisions,
                   "qualification_prompt_version": QUALIFICATION_PROMPT_VERSION, "qualification_response_version": RESPONSE_VERSION,
                   "qualification_semantics_version": QUALIFICATION_SEMANTICS_VERSION}
        input_hash = fingerprint(request)
        state = self.store.initial_cohort_operation(operation_id, input_hash)
        if state is None:
            from .service import unique_requirements
            with self.store.read_snapshot() as read:
                profile_snapshot = read.profile_snapshot(profile_id)
                profile = dto(profile_snapshot)
                facts = fact_sources(profile)
                jobs, requirements, initial_sources = [], {}, set()
                for job_id in job_ids:
                    snapshot = read.job_requirements(job_id)
                    if set(expected_requirements[job_id]) != {"revision", "posting_revision", "posting_hash"}:
                        raise AppError("fit_cohort_scope_invalid", "Complete requirement version pins are required.", 422)
                    if any(snapshot[key] != value for key, value in expected_requirements[job_id].items()):
                        raise ConflictError("The frozen cohort requirements changed before qualification.")
                    score = read.latest_score(job_id)
                    if (score["revision"] if score else 0) != expected_score_revisions[job_id]:
                        raise ConflictError("The frozen cohort score changed before qualification.")
                    if score is not None:
                        self._require_manual_refresh(read, job_id, profile_id)
                    rows = unique_requirements(snapshot)
                    jobs.append({"job_id": job_id, "requirements": snapshot,
                                 "score_revision": score["revision"] if score else 0,
                                 "binding_keys": [qualification_key(row) for row in rows]})
                    for row in rows:
                        key = qualification_key(row)
                        previous = requirements.setdefault(key, row)
                        if previous is not row and (requirement_source(previous) != requirement_source(row)
                                or qualification_fingerprint(profile, previous, facts) != qualification_fingerprint(profile, row, facts)
                                or row["category"] in {"education", "language"} and previous["job_id"] != job_id):
                            raise ConflictError("A shared qualification binding has different semantic sources or evidence permissions.")
                    if score is None:
                        initial_sources.update(qualification_key(row) for row in rows)
                current_heads, prior_heads, reused, missing = {}, {}, {}, []
                for key, row in requirements.items():
                    current = read.latest_assessment(profile_id, row["requirement_id"], row["requirement_revision"],
                        source_fingerprint=qualification_fingerprint(profile, row, facts))
                    prior = read.latest_requirement_assessment(profile_id, row["requirement_id"], demand_fingerprint=row.get("demand_fingerprint"))
                    current_heads[key] = current["assessment_id"] if current else None
                    prior_heads[key] = prior["assessment_id"] if prior else None
                    if current_qualification(current):
                        if qualification_key(current) != key or requirement_source(current) != requirement_source(row):
                            raise ConflictError("The accepted assessment does not carry the frozen semantic requirement.")
                        reused[key] = current["assessment_id"]
                    elif key in initial_sources:
                        missing.append(key)
                    else:
                        raise AppError("fit_refresh_required", "Existing assessments require a manual Fit refresh.", 409)
                state = {"operation_id": operation_id, "input_fingerprint": input_hash, "request": request,
                         "cohort_version": COHORT_VERSION, "status": "prepared", "profile": profile,
                         "guidance": profile_snapshot.scoring_guidance, "jobs": jobs,
                         "requirements": list(requirements.values()), "current_heads": current_heads,
                         "prior_heads": prior_heads, "reused_assessment_ids": reused, "missing_keys": missing,
                         "published_jobs": {}, "qualification_transport_version": "fit-permission-scopes-v1"}
            state = self.store.start_initial_cohort(state)
        self._check_cancelled(cancelled)
        self.store.validate_initial_cohort(state)
        if state["status"] != "qualified":
            rows = [row for row in state["requirements"] if qualification_key(row) in state["missing_keys"]]
            snapshot = FrozenFitProfileSnapshot(state["profile"], state["guidance"], manual_refresh=False)
            heartbeat({"phase": "initial_cohort_qualification", "jobCount": len(job_ids), "missingCount": len(rows)})
            candidates = await self.qualification.candidates(snapshot, rows, model=CohortModel(self, operation_id, cancelled),
                                                             cohort_operation_id=operation_id)
            self._check_cancelled(cancelled)
            state = self.store.publish_initial_cohort(operation_id, candidates, fact_sources(state["profile"]), cancelled=cancelled)
        return {"contract_version": CONTRACT_VERSION, "cohort_version": COHORT_VERSION, "operation_id": operation_id,
                "jobs": [{"job_id": job["job_id"], "requirements_revision": job["requirements"]["revision"],
                          "posting_revision": job["requirements"]["posting_revision"], "posting_hash": job["requirements"]["posting_hash"]}
                         for job in state["jobs"]],
                "reused_qualifications": len(state["reused_assessment_ids"]), "assessed_qualifications": len(state["missing_keys"])}

    async def assess_cohort_job(self, job_id, *, cohort_operation_id, expected_revision, operation_id,
                                cancelled=lambda: False):
        self._expected_revision(expected_revision)
        state = self.store.initial_cohort_operation(cohort_operation_id)
        if state is None or state["status"] != "qualified":
            raise AppError("fit_cohort_not_qualified", "The frozen cohort has no accepted qualification batch.", 409)
        job = next((row for row in state["jobs"] if row["job_id"] == job_id), None)
        if job is None or job["score_revision"] != expected_revision:
            raise ConflictError("The cohort score scope or original revision changed.")
        profile = state["profile"]
        snapshot = job["requirements"]
        from .service import unique_requirements
        rows = unique_requirements(snapshot)
        assessments = []
        for row in rows:
            record = self.store.assessment(state["accepted_assessment_ids"][qualification_key(row)])
            if record is None or not current_qualification(record):
                raise ConflictError("A frozen cohort qualification is unavailable.")
            assessments.append({**record, **assessment_fields(row)})
        binding = {"contract_version": CONTRACT_VERSION, "profile_id": profile["profile_id"],
            "profile_revision": profile["profile_revision"], "fact_semantics_version": profile["fact_semantics_version"],
            "source_fingerprint": job_fingerprint(profile, rows), "scoring_guidance_fingerprint": fingerprint(state["guidance"]),
            "approved_variants_fingerprint": approved_fingerprint(profile), "requirements_revision": snapshot["revision"],
            "posting_revision": snapshot["posting_revision"], "posting_hash": snapshot["posting_hash"],
            "assessment_ids": [row["assessment_id"] for row in assessments],
            "requirements": [{"requirement_id": row["requirement_id"], "requirement_revision": row["requirement_revision"],
                              "demand_fingerprint": row.get("demand_fingerprint")} for row in rows]}
        candidate = {**calculate_score(assessments), "job_id": job_id, "revision": expected_revision + 1,
                     "source_binding": binding, "created_at": now(), "origin": "model", "correction": None,
                     "policy_version": FORMULA_VERSION, "initial_cohort_operation_id": cohort_operation_id}
        action = fingerprint({"operation": "initial_cohort_score", "cohort_operation_id": cohort_operation_id,
                              "job_id": job_id, "expected_revision": expected_revision})
        self._check_cancelled(cancelled)
        accepted = self.store.publish_initial_cohort_score(cohort_operation_id, candidate, expected_revision,
                                                           operation_id, action, cancelled=cancelled)
        result = self._result_for_score(accepted)
        result["reuse"] = {"reused_qualifications": len(rows), "assessed_qualifications": 0,
                           "score_reused": accepted["revision"] == expected_revision}
        result["coverage_preparation"] = {"status": "not_requested", "assessed_relations": 0, "reused_relations": 0, "proposals": []}
        self.store.complete_operation(operation_id, action, result)
        return result
