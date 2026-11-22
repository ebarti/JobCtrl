"""Explicit preparation policy over public feature and checkpoint ports.

This application service has no HTTP, SQLite, Runtime or Temporal dependency.
Stable stage identities and accepted feature receipts survive worker retries.
"""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import nullcontext

from jobctrl.app.contracts import ActionContext
from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.model_capacity import wait_for_model_capacity
from jobctrl.app.preparation_ports import PreparationCheckpoints, PreparationSettings, RunReader

RECIPES = {"run", "discover", "search", "assess", "enrich", "analyze", "score", "tailor", "prepare"}
STAGES = {
    "run": ("enrich", "role_analysis", "requirements", "fit", "compose", "review", "render"),
    "discover": ("enrich", "role_analysis", "requirements", "fit", "compose", "review", "render"),
    "search": ("enrich", "role_analysis", "requirements", "fit"),
    "assess": ("enrich", "role_analysis", "requirements", "fit"),
    "enrich": ("enrich",),
    "analyze": ("role_analysis", "requirements"),
    "score": ("requirements", "fit"),
    "tailor": ("requirements", "fit", "compose", "review", "render"),
    "prepare": ("requirements", "fit", "compose", "review", "render"),
}
DISCOVERY_RECIPES = {"run", "discover", "search"}
DISCOVERY_KEYS = {"queries", "locations", "boards", "newJobLimit", "resultsPerSite", "hoursOld", "expectedProfileVersion"}
TERMINAL_STEPS = {"succeeded", "skipped", "warning"}
COHORT_POLICY = "search-cohort-v1"
COHORT_PRODUCERS = ("enrich", "role_analysis", "requirements_extract")
SEARCH_JOB_LIMIT = 10_000
# Larger searches retain the established per-job preparation policy. The
# gateway independently checks the full admitted semantic payload for size.
COHORT_JOB_LIMIT = 10
PREPARATION_OPTIONS = {"recipe", "job_ids", "scope", "discovery", "limit", "force",
                       "min_fit_score", "allow_below_threshold", "resume_mode"}


def _operation(run_id: str, job_id: str, stage: str) -> str:
    return "prep:" + hashlib.sha256(f"{run_id}\0{job_id}\0{stage}".encode()).hexdigest()


def _error_code(error: BaseException) -> str:
    value = getattr(error, "code", None)
    if isinstance(value, str) and 0 < len(value) <= 100 and all(c.isalnum() or c in "_-" for c in value):
        return value
    return "preparation_stage_failed"


def _validate(raw: dict, *, selection_limit=1000) -> dict:
    if not isinstance(raw, dict) or set(raw) - PREPARATION_OPTIONS:
        raise AppError("invalid_preparation", "Choose a supported preparation recipe and options.")
    recipe = raw.get("recipe")
    if not isinstance(recipe, str) or recipe not in RECIPES:
        raise AppError("invalid_preparation_recipe", "Choose a supported preparation recipe.")
    ids = raw.get("job_ids", [])
    if not isinstance(ids, list) or len(ids) > selection_limit or any(not isinstance(i, str) or not i.strip() or len(i) > 120 for i in ids):
        raise AppError("invalid_job_selection", f"Select up to {selection_limit:,} saved jobs.")
    ids = list(dict.fromkeys(ids))
    scope = raw.get("scope", "selected" if ids else "pending")
    if not isinstance(scope, str) or scope not in {"selected", "pending"} or scope == "selected" and not ids or scope == "pending" and ids:
        raise AppError("invalid_job_selection", "Select jobs or choose pending work.")
    if recipe == "assess" and scope != "selected":
        raise AppError("explicit_job_selection_required", "Select the saved jobs to assess.")
    limit = raw.get("limit", max(100, len(ids)))
    maximum = SEARCH_JOB_LIMIT if recipe == "search" else 1000
    if type(limit) is not int or not 1 <= limit <= maximum:
        raise AppError("invalid_preparation_limit", f"Use a limit from 1 to {maximum:,}.")
    if scope == "selected" and len(ids) > limit:
        raise AppError("invalid_preparation_limit", "The limit cannot exclude selected jobs.")
    force, override = raw.get("force", False), raw.get("allow_below_threshold", False)
    if type(force) is not bool or type(override) is not bool:
        raise AppError("invalid_preparation_option", "Preparation options must be boolean.")
    resume_mode = raw.get("resume_mode")
    if "resume_mode" in raw and (not isinstance(resume_mode, str) or resume_mode not in {"baseline", "tailored"}):
        raise AppError("invalid_resume_mode", "Choose a full baseline or tailored resume.")
    minimum = raw.get("min_fit_score")
    if minimum is not None and (type(minimum) is not int or not 1 <= minimum <= 10):
        raise AppError("invalid_fit_threshold", "Use a fit threshold from 1 to 10.")
    discovery = raw.get("discovery", {})
    if not isinstance(discovery, dict) or set(discovery) - DISCOVERY_KEYS or discovery and recipe not in DISCOVERY_RECIPES:
        raise AppError("invalid_discovery_options", "Choose supported Discovery options.")
    return {"recipe": recipe, "job_ids": ids, "scope": scope, "limit": limit, "force": force,
            "min_fit_score": minimum, "allow_below_threshold": override, "discovery": discovery,
            **({"resume_mode": resume_mode} if resume_mode is not None else {})}


class PreparationService:
    def __init__(self, checkpoints: PreparationCheckpoints, settings: PreparationSettings, *,
                 profile, jobs, requirements, fit, resumes, discovery=None):
        self.checkpoints, self.settings = checkpoints, settings
        self.profile, self.jobs, self.requirements = profile, jobs, requirements
        self.fit, self.resumes, self.discovery = fit, resumes, discovery
        self.run_reader: RunReader | None = None

    def bind_run_reader(self, reader: RunReader):
        self.run_reader = reader

    def admit(self, run_id, raw, settings, connection):
        # Only initial acquisition owns a new-job cohort. Forced/selected
        # recipes retain their existing explicit single-job semantics.
        recipe = raw.get("recipe")
        if recipe != "search":
            if isinstance(recipe, str) and "requirements" in STAGES.get(recipe, ()):
                self.requirements.admit_manual_catalog_prompt(run_id, connection)
            return
        request = _validate(raw)
        if request["scope"] != "pending" or request["force"]:
            self.requirements.admit_manual_catalog_prompt(run_id, connection)
            return
        request.update(contract_version="requirements-v2",
                       refresh_catalog_prompt_version=self.requirements.refresh_catalog_prompt_version,
                       cohort_catalog_prompt_version=self.requirements.cohort_catalog_prompt_version,
                       resume_mode=request.get("resume_mode", settings.get("resumeMode", "tailored")),
                       min_fit_score=request["min_fit_score"] or settings.get("minFitScore", 7),
                       execution_policy={"version": COHORT_POLICY,
                                         "producer_mode": "serial" if settings.get("dailyBudgetUsd", 0) else "cross_lane"})
        self.checkpoints.admit_run(run_id, request, connection)

    def admit_search(self, run_id, payload, settings, connection):
        self.admit(run_id, {"recipe": "search", "scope": "pending", "discovery": payload, "limit": SEARCH_JOB_LIMIT},
                   settings, connection)

    def admit_retry(self, run_id, payload, connection):
        parent = payload.get("run_id")
        if not isinstance(parent, str):
            return
        original = self.checkpoints.request(parent, connection=connection)
        if original is None or self._cohort_policy(original) is None:
            return
        _, requested = self._retry_options(payload)
        previous = self.checkpoints.get_run(parent, connection=connection)
        if (previous["status"] not in {"failed", "partial", "cancelled"}
                or not self._owner_reclaimable(parent, connection=connection)):
            raise ConflictError("Only an unsuccessful or cancelled run can be retried after it settles.")
        discovery = self.checkpoints.step(parent, "", "discover", connection=connection)
        if discovery and discovery["status"] in TERMINAL_STEPS:
            acquisition = discovery["result"]
        else:
            acquisition = self.discovery.search_outcome(parent) if self.discovery is not None else None
            if acquisition and acquisition["status"] == "failed" and not acquisition.get("newJobIds"):
                acquisition = None
        targets = previous["jobIds"] if previous["cohortFrozen"] else None
        if targets is None and acquisition is not None:
            targets = self._search_targets(original, acquisition)
        if requested is not None and set(requested) != set(targets or []):
            raise AppError("preparation_cohort_retry_scope_required",
                           "Retry the complete original cohort to retain its admitted model operations. Completed jobs are reused.", 409)
        completed = {step["jobId"] for step in previous["steps"]
                     if step["stage"] == "fit" and step["status"] in TERMINAL_STEPS}
        if targets is not None and set(targets).issubset(completed):
            raise AppError("nothing_to_retry", "All preparation jobs in the original search are complete.", 409)
        request = {**original, "job_ids": targets or [], "scope": "selected" if targets else "pending"}
        if targets is not None and "target_route" not in request:
            request["target_route"] = self._target_route(targets)
        self.checkpoints.admit_run(run_id, request, connection, parent=parent, targets=targets)
        if acquisition is not None and (not discovery or discovery["status"] not in TERMINAL_STEPS):
            status = "succeeded" if acquisition["status"] == "completed" else "warning"
            self.checkpoints.finish_step(run_id, "", "discover", status, result=acquisition, connection=connection)

    def finalize(self, run_id, status, error_code, connection):
        if status == "cancelled" and self.run_reader is not None:
            request = self.checkpoints.request(run_id, connection=connection)
            if (request and self._cohort_policy(request) is not None
                    and self.run_reader(run_id, connection=connection)["status"] == "running"):
                return  # The active owner must unwind before its claims can be released.
        self.checkpoints.finalize_run(run_id, status, error_code, connection)

    @staticmethod
    def _cohort_policy(request):
        policy = request.get("execution_policy")
        if policy is None:
            return None
        if (not isinstance(policy, dict) or set(policy) != {"version", "producer_mode"}
                or policy["version"] != COHORT_POLICY or policy["producer_mode"] not in {"serial", "cross_lane"}):
            raise AppError("action_contract_changed", "The admitted preparation policy is unsupported.", 409)
        return policy

    def _owner_reclaimable(self, run_id, connection=None):
        if self.run_reader is None:
            return False
        try:
            return self.run_reader(run_id, connection=connection)["status"] in {"succeeded", "failed", "cancelled"}
        except NotFoundError:
            raise AppError("preparation_owner_unknown", "The prior preparation owner needs inspection.", 409) from None

    def _user_cancelled(self, context, connection=None):
        # Worker shutdown is recoverable. Only an explicit saved user request
        # becomes terminal; a cancelled asyncio task alone does not prove it.
        if self.run_reader is None:
            return context.cancelled()
        return bool(self.run_reader(context.run_id, connection=connection)["cancellationRequested"])

    def _work_cancelled(self, context):
        return context.cancelled() or self._user_cancelled(context)

    def _capacity_wait(self, context, job_id, stage):
        if stage not in {*STAGES["search"], "requirements_extract", "requirements_normalize", "fit_qualify"}:
            return nullcontext()
        def waiting(reason):
            self.checkpoints.record_capacity_wait(context.run_id, job_id, stage, reason)
        # Fit can delegate wording proposals to Profile, which has its own
        # interruption/approval contract. Only Fit's scoring calls opt in here.
        lane = "scoring" if stage in {"fit", "fit_qualify"} else None
        return wait_for_model_capacity(context.cancelled, on_wait=waiting, lane=lane)

    def get_run(self, run_id):
        return self._describe_run(self.checkpoints.get_run(run_id))

    def list_runs(self, limit=100):
        return {"runs": [self._describe_run(run) for run in self.checkpoints.list_runs(limit)["runs"]]}

    def telemetry_runs(self, limit=100):
        return {"runs": [self._describe_run(run) for run in self.checkpoints.telemetry_runs(limit)["runs"]]}

    def telemetry_run(self, run_id):
        return self._describe_run(self.checkpoints.telemetry_run(run_id))

    @staticmethod
    def _describe_run(run):
        policy = PreparationService._cohort_policy({"execution_policy": run.get("executionPolicy")})
        if policy and run.get("targetRoute") != "per_job":
            stages = [{"stage": stage, "scope": "job"} for stage in COHORT_PRODUCERS]
            stages.extend([{"stage": "requirements_normalize", "scope": "run"},
                           {"stage": "requirements", "scope": "job"},
                           {"stage": "fit_qualify", "scope": "run"}, {"stage": "fit", "scope": "job"}])
            stages.insert(0, {"stage": "discover", "scope": "run"})
            return {**run, "stagePlan": stages, "jobConcurrency": 3 if policy["producer_mode"] == "cross_lane" else 1}
        stages = [{"stage": stage, "scope": "job"} for stage in STAGES[run["recipe"]]]
        if run["recipe"] in DISCOVERY_RECIPES:
            stages.insert(0, {"stage": "discover", "scope": "run"})
        return {**run, "stagePlan": stages, "jobConcurrency": 1}

    def job_summaries(self, job_ids, connection=None):
        return self.checkpoints.job_summaries(job_ids, connection=connection)

    @staticmethod
    def _search_targets(request, discovery_result):
        # Only newly committed Jobs belong to an initial assessment.
        ids = list(dict.fromkeys((discovery_result or {}).get("newJobIds") or []))
        if len(ids) > request["limit"]:
            raise AppError("search_assessment_limit_exceeded", "The saved search cohort exceeds its assessment limit.", 409)
        return ids

    @staticmethod
    def _target_route(ids):
        return "cohort" if len(ids) <= COHORT_JOB_LIMIT else "per_job"

    def _target_ids(self, run_id, request, discovery_result):
        saved = self.checkpoints.targets(run_id)
        if saved is not None:
            return saved, request.get("target_route")
        if request["recipe"] == "search" and request["scope"] != "selected":
            ids = self._search_targets(request, discovery_result)
        elif request["scope"] == "selected":
            ids = list(dict.fromkeys([*request["job_ids"], *((discovery_result or {}).get("newJobIds") or [])]))[:request["limit"]]
        else:
            ids = list((discovery_result or {}).get("newJobIds") or [])
            for job in self.jobs.list_job_snapshots():
                if len(ids) >= request["limit"]:
                    break
                try:
                    pending = self._pending(job, request)
                except (NotFoundError, ConflictError):
                    # Preserve a per-job outcome if it changed during selection.
                    pending = True
                if job["job_id"] not in ids and pending:
                    ids.append(job["job_id"])
            ids = ids[:request["limit"]]
        # Snapshot the actual selected identities before processing. A resumed
        # workflow must not silently pick up unrelated newer jobs.
        route = self._target_route(ids) if self._cohort_policy(request) else None
        return self.checkpoints.save_targets(run_id, ids, route=route)


    def _pending(self, job, request):
        if request["force"]:
            return True
        recipe, job_id = request["recipe"], job["job_id"]
        if recipe == "enrich":
            return job.get("needs_enrichment", True)
        if recipe == "analyze":
            return not self.jobs.get_analysis(job_id).get("current", False)
        if recipe == "score":
            fit = self.fit.get_job_fit(job_id, include_coverage=False)
            return not fit["qualifications_current"] or not fit["requirements_current"]
        return not any(r.get("accepted_revision_id") for r in self.resumes.list(job_id))


    def _inputs(self, job_id, stage, request, prior):
        baseline_only = request["resume_mode"] == "baseline" and request["recipe"] in {"prepare", "tailor"}
        if baseline_only and stage in {"requirements", "fit"}:
            return {"skip": "full_baseline_needs_no_job_assessment"}
        extraction = prior.get("requirements", {}).get("result") or {}
        if stage in {"fit", "compose", "review", "render"} and extraction.get("status") == "unsupported_language":
            requirements = self.requirements.get_job_requirements(job_id)
            if requirements.get("stale") or requirements["revision"] != extraction["revision"]:
                raise ConflictError("The requirement snapshot changed after language classification.")
            return {"skip": "unsupported_posting_language", "requirements_revision": requirements["revision"]}
        if stage == "enrich":
            posting = self.jobs.snapshot(job_id)
            if request["recipe"] in {"run", "discover", "search", "assess"} and not posting.get("needs_enrichment", True):
                return {"skip": "accepted_detail_current", "revision": posting["revision"]}
            return {"expected_revision": posting["revision"]}
        if stage == "role_analysis":
            posting = self.jobs.snapshot(job_id)
            enriched = (prior.get("enrich", {}).get("result") or {}).get("revision")
            if enriched is not None and posting["revision"] != enriched:
                raise ConflictError("The posting changed after enrichment.")
            return {"expected_revision": posting["revision"], "force": request["force"]}
        if stage == "requirements":
            posting = self.jobs.snapshot(job_id)
            previous_posting = (prior.get("role_analysis", {}).get("result") or {}).get("postingRevision")
            if previous_posting is None:
                previous_posting = (prior.get("enrich", {}).get("result") or {}).get("revision")
            if previous_posting is not None and posting["revision"] != previous_posting:
                raise ConflictError("The posting changed before requirement extraction.")
            try:
                current = self.requirements.get_job_requirements(job_id)
                revision = current["revision"]
            except NotFoundError:
                revision = 0
            return {"expected_posting_revision": posting["revision"], "expected_revision": revision,
                    "force": request["force"] and request["recipe"] != "tailor"}
        if stage == "fit":
            expected_requirements = (prior.get("requirements", {}).get("result") or {}).get("revision")
            if expected_requirements is not None:
                requirements = self.requirements.get_job_requirements(job_id)
                if requirements.get("stale") or requirements["revision"] != expected_requirements:
                    raise ConflictError("The requirement snapshot changed before fit assessment.")
            current = self.fit.get_job_fit(job_id, include_coverage=False)
            prepare_expression = request["recipe"] not in {"search", "assess"} and request["resume_mode"] != "baseline"
            return {"expected_revision": current["score"]["revision"] if current["score"] else 0,
                    "force": request["force"] and request["recipe"] != "tailor", "prepare_wording": prepare_expression,
                    "prepare_coverage": prepare_expression}
        if stage == "compose":
            if not baseline_only:
                fit = self.fit.get_job_fit(job_id, include_coverage=False)
                score = fit.get("score")
                if not fit.get("qualifications_current") or not fit.get("requirements_current") or not score:
                    raise AppError("fit_not_current", "Current person fit is required before resume preparation.", 409)
                expected_fit = (prior.get("fit", {}).get("result") or {}).get("revision")
                if expected_fit is not None and score["revision"] != expected_fit:
                    raise ConflictError("Person fit changed before resume preparation.")
                if score["score"] is None:
                    return {"skip": "no_extractable_requirements"}
                if score["score"] < request["min_fit_score"] and not request["allow_below_threshold"]:
                    return {"skip": "below_fit_threshold", "score": score["score"], "threshold": request["min_fit_score"]}
            documents = self.resumes.list(job_id)
            requested_mode = "baseline_copy" if request["resume_mode"] == "baseline" else "tailored"
            existing_revision = next((item for item in documents[-1]["revisions"]
                                      if item["revision_id"] == documents[-1]["current_revision"]), None) if documents else None
            compatible = bool(existing_revision and existing_revision["mode"] == requested_mode
                              and existing_revision["profile_revision"] == self.profile.snapshot().profile_revision)
            if compatible and not baseline_only:
                try:
                    if existing_revision.get("requirements_snapshot") is not None:
                        self.requirements.assert_current(existing_revision["requirements_snapshot"])
                    if existing_revision.get("fit_snapshot") is not None:
                        self.fit.assert_current(existing_revision["fit_snapshot"])
                except AppError:
                    compatible = False
            if documents and not request["force"] and compatible:
                existing = documents[-1]
                if existing.get("accepted_revision_id") == existing["current_revision"]:
                    return {"skip": "resume_already_accepted", "resume_id": existing["resume_id"]}
                return {"reuse_resume_id": existing["resume_id"], "expected_version": existing["version"],
                        "revision_id": existing["current_revision"]}
            args = {"job_id": job_id, "expected_profile_revision": self.profile.snapshot().profile_revision,
                    "mode": request["resume_mode"]}
            if documents:
                args.update(resume_id=documents[-1]["resume_id"], expected_version=documents[-1]["version"])
            return args
        composed = prior.get("compose", {})
        if composed.get("status") == "skipped":
            return {"skip": "no_new_resume"}
        previous = composed.get("result") or {}
        if not previous.get("resume_id"):
            return {"skip": "no_new_resume"}
        if stage == "review":
            # Frozen inputs still let a previously started review settle on recovery.
            return {"skip": "baseline_copy" if previous.get("mode") == "baseline_copy" else "review_not_requested"}
        state = self.resumes.get(previous["resume_id"])
        if state["current_revision"] != previous.get("revision_id"):
            raise ConflictError("The resume changed before the next preparation step.")
        reviewed = prior.get("review", {}).get("result") or {}
        expected_version = reviewed.get("version", previous.get("version"))
        if state["version"] != expected_version:
            raise ConflictError("The resume version changed before the next preparation step.")
        revision = next(item for item in state["revisions"] if item["revision_id"] == state["current_revision"])
        if revision.get("renders"):
            return {"skip": "resume_already_rendered", "resume_id": state["resume_id"]}
        return {"resume_id": state["resume_id"], "expected_version": state["version"]}


    async def _execute_stage(self, context, job_id, stage, inputs, request):
        inputs = dict(inputs)
        op = inputs.pop("_operation_id", _operation(context.run_id, job_id, stage))
        def cancelled():
            return self._work_cancelled(context)
        if stage == "enrich":
            value = await self.jobs.refresh(job_id, **inputs, receipt_key=op, cancelled=cancelled)
            return {"revision": value["revision"]}
        if stage == "role_analysis":
            value = await self.jobs.analyze(job_id, **inputs, operation_id=op, cancelled=cancelled)
            return {"revision": value["revision"], "postingRevision": value["posting_revision"]}
        if stage == "requirements":
            if cancelled():
                raise asyncio.CancelledError()
            value = await self.requirements.refresh(job_id, **inputs, operation_id=op,
                                                   catalog_prompt_version=request.get("refresh_catalog_prompt_version"),
                                                   cancelled=cancelled, heartbeat=context.heartbeat)
            if value.get("stale"):
                raise ConflictError("The accepted requirement snapshot is stale.")
            return {"revision": value["revision"], "postingRevision": value["posting_revision"],
                    "postingHash": value["posting_hash"], "status": value.get("status", "complete")}
        if stage == "requirements_extract":
            inputs.pop("force", None)
            return await self.requirements.prepare_cohort_job(job_id, **inputs, operation_id=op,
                                                              cancelled=cancelled, heartbeat=context.heartbeat)
        if stage == "fit":
            inputs.pop("_requirements_binding", None)
            cohort_operation = inputs.pop("_cohort_operation_id", None)
            if cohort_operation:
                value = await self.fit.assess_cohort_job(job_id, cohort_operation_id=cohort_operation,
                    expected_revision=inputs["expected_revision"], operation_id=op, cancelled=cancelled)
            else:
                value = await self.fit.assess_job(job_id, **inputs, operation_id=op, cancelled=cancelled)
            summary = {"revision": value["score"]["revision"], "score": value["score"]["score"],
                       "coverageFailureCode": value.get("coverage_failure_code")}
            if value.get("coverage_failure_code") and request["resume_mode"] != "baseline":
                self.checkpoints.finish_step(context.run_id, job_id, stage, "failed", result=summary,
                                  error_code=value["coverage_failure_code"])
                raise AppError("coverage_preparation_failed", "Person fit was recorded; wording coverage needs attention.", 409)
            return summary
        if stage == "compose":
            if "reuse_resume_id" in inputs:
                value = self.resumes.get(inputs["reuse_resume_id"])
                if value["version"] != inputs["expected_version"] or value["current_revision"] != inputs["revision_id"]:
                    raise ConflictError("The existing resume changed before preparation.")
                revision = next(item for item in value["revisions"] if item["revision_id"] == value["current_revision"])
                if revision["profile_revision"] != self.profile.snapshot().profile_revision:
                    raise ConflictError("The existing resume uses an earlier profile.")
                if revision.get("requirements_snapshot") is not None:
                    self.requirements.assert_current(revision["requirements_snapshot"])
                if revision.get("fit_snapshot") is not None:
                    self.fit.assert_current(revision["fit_snapshot"])
                return {"resume_id": value["resume_id"], "version": value["version"], "revision_id": value["current_revision"], "mode": revision["mode"]}
            value = await asyncio.to_thread(self.resumes.compose, **inputs, operation_id=op, cancelled=cancelled)
            revision = next(item for item in value["revisions"] if item["revision_id"] == value["current_revision"])
            return {"resume_id": value["resume_id"], "version": value["version"], "revision_id": value["current_revision"], "mode": revision["mode"]}
        if stage == "review":
            value = await self.resumes.review(**inputs, operation_id=op)
            revision = next(item for item in value["revisions"] if item["revision_id"] == value["current_revision"])
            if revision["review"]["status"] == "running":
                raise AppError("resume_review_in_progress", "Wait for the existing resume review to finish.", 409)
            return {"resume_id": value["resume_id"], "version": value["version"], "review_status": revision["review"]["status"]}
        value = await asyncio.to_thread(self.resumes.render, **inputs, operation_id=op, cancelled=cancelled)
        revision = next(item for item in value["revisions"] if item["revision_id"] == value["current_revision"])
        attempt = revision["render_attempts"][-1]
        if attempt["status"] != "rendered":
            raise AppError(attempt.get("failure_code", "resume_render_failed"), "Resume rendering failed.", 422)
        return {"resume_id": value["resume_id"], "version": value["version"], "artifact_id": attempt["artifact_id"]}


    def _prepare_search_fit(self, context, targets, request, *, shared=False):
        """Pin the complete cohort after all requirement-producing work settles.

        Another cohort member may have consolidated an earlier snapshot. Only
        this run's accepted normalization operations can advance that checkpoint;
        unrelated changes still require a separately admitted action.
        """
        prior = {job_id: {stage: self.checkpoints.step(context.run_id, job_id, stage)
                          for stage in STAGES["search"]} for job_id in targets}
        cohort_operation = self._cohort_qualification_operation(context, targets) if shared else None
        operations = {_operation(context.run_id, job_id, "requirements") for job_id in targets
                      if (prior[job_id]["requirements"] or {}).get("status") == "succeeded"}
        normalization = self.checkpoints.step(context.run_id, "", "requirements_normalize")
        if normalization and normalization["status"] == "succeeded":
            result = normalization["result"] or {}
            operations.update(value for value in (result.get("operation_id"), result.get("reconciliation_id")) if value)
        for job_id, steps in prior.items():
            if self._work_cancelled(context):
                raise asyncio.CancelledError()
            if steps["fit"] or any((steps[stage] or {}).get("status") not in TERMINAL_STEPS
                                   for stage in STAGES["search"][:-1]):
                continue
            try:
                current = self.requirements.get_job_requirements(job_id)
                produced = steps["requirements"]["result"]
                if (current["posting_revision"] != produced["postingRevision"]
                        or produced.get("postingHash", current["posting_hash"]) != current["posting_hash"]):
                    raise ConflictError("The posting changed before cohort fit assessment.")
                if (current["revision"] != produced["revision"] and (shared
                        or current.get("normalization_provenance", {}).get("reconciliation_id") not in operations)):
                    raise ConflictError("Requirements changed outside the admitted search cohort.")
                self.requirements.assert_current(current)
                final_steps = {**steps, "requirements": {**steps["requirements"], "result": {
                    **produced, "revision": current["revision"], "status": current.get("status", "complete")}}}
                inputs = self._inputs(job_id, "fit", request, final_steps)
                inputs["_requirements_binding"] = {key: current[key] for key in ("revision", "posting_revision", "posting_hash")}
                inputs["_operation_id"] = _operation(context.run_id, job_id, "fit")
                if cohort_operation:
                    inputs["_cohort_operation_id"] = cohort_operation
                self.checkpoints.prepare_step(context.run_id, job_id, "fit", inputs)
            except Exception as error:
                self.checkpoints.finish_step(context.run_id, job_id, "fit", "failed", error_code=_error_code(error))

    def _assert_search_binding(self, job_id, inputs, connection=None):
        binding = inputs.get("_requirements_binding")
        if binding is not None:
            current = self.requirements.get_job_requirements(job_id, connection=connection)
            if any(current[key] != value for key, value in binding.items()):
                raise ConflictError("Requirements changed after the search cohort was prepared.")
            self.requirements.assert_current(current, connection=connection)

    def _verify_search_fit(self, context, targets, connection=None):
        """Read-only final guard; never retry model work or replace accepted scores."""
        failed = False
        for job_id in targets:
            if context.cancelled() or self._user_cancelled(context, connection=connection):
                raise asyncio.CancelledError()
            step = self.checkpoints.step(context.run_id, job_id, "fit", connection=connection)
            if not step or step["status"] not in {"succeeded", "skipped"}:
                if connection is not None:
                    failed = True
                continue
            try:
                inputs = step["input"] or {}
                if connection is not None and not inputs.get("_requirements_binding"):
                    raise ConflictError("The completed result has no frozen Requirements binding.")
                self._assert_search_binding(job_id, inputs, connection=connection)
                if step["status"] == "skipped":
                    continue
                current = self.fit.get_job_fit(job_id, connection=connection, include_coverage=False)
                if not current["current"] or not current["score"] or current["score"]["revision"] != step["result"]["revision"]:
                    raise AppError("search_fit_not_current", "The saved fit changed before search completion. Review its current inputs.", 409)
            except Exception as error:
                self.checkpoints.finish_step(context.run_id, job_id, "fit", "failed",
                                             result=step["result"], error_code=_error_code(error), connection=connection)
                failed = True
        if connection is not None and (context.cancelled() or self._user_cancelled(context, connection=connection)):
            raise asyncio.CancelledError()
        return failed

    async def _cohort_step(self, context, job_id, stage, prepare, execute):
        """Execute one pinned phase; terminal refusals never become retries."""
        step = self.checkpoints.step(context.run_id, job_id, stage)
        if step and step["status"] in TERMINAL_STEPS:
            return True
        if step and step["status"] in {"failed", "blocked", "cancelled"}:
            return False
        if self._work_cancelled(context):
            raise asyncio.CancelledError()
        try:
            inputs = step["input"] if step and step["input"] is not None else prepare()
            self._assert_search_binding(job_id, inputs)
            if inputs.get("skip"):
                self.checkpoints.finish_step(context.run_id, job_id, stage, "skipped", result=inputs)
                return True
            inputs.setdefault("_operation_id", _operation(context.run_id, job_id, stage))
            inputs = self.checkpoints.start_step(context.run_id, job_id, stage, inputs)
            context.heartbeat({"jobId": job_id or None, "stage": stage})
            with self._capacity_wait(context, job_id, stage):
                result = await execute(inputs)
            if self._work_cancelled(context):
                raise asyncio.CancelledError()
            self.checkpoints.finish_step(context.run_id, job_id, stage, "succeeded", result=result)
            return True
        except asyncio.CancelledError:
            if self._user_cancelled(context):
                self.checkpoints.finish_step(context.run_id, job_id, stage, "cancelled", error_code="action_cancelled")
            raise
        except Exception as error:
            if self._work_cancelled(context):
                if self._user_cancelled(context):
                    self.checkpoints.finish_step(context.run_id, job_id, stage, "cancelled", error_code="action_cancelled")
                raise asyncio.CancelledError() from None
            self.checkpoints.finish_step(context.run_id, job_id, stage, "failed", error_code=_error_code(error))
            return False

    def _cohort_block(self, context, job_id, stages, *, code="upstream_stage_failed", status="blocked"):
        for stage in stages:
            prior = self.checkpoints.step(context.run_id, job_id, stage)
            if not prior or prior["status"] in {"pending", "running"}:
                self.checkpoints.finish_step(context.run_id, job_id, stage, status, error_code=code)

    async def _cohort_producer(self, context, job_id, stage, request):
        prior = {name: self.checkpoints.step(context.run_id, job_id, name) for name in COHORT_PRODUCERS}
        prerequisites = COHORT_PRODUCERS[:COHORT_PRODUCERS.index(stage)]
        if any((prior[name] or {}).get("status") not in TERMINAL_STEPS for name in prerequisites):
            self._cohort_block(context, job_id, [stage])
            return False
        return await self._cohort_step(context, job_id, stage,
            lambda: self._inputs(job_id, "requirements" if stage == "requirements_extract" else stage,
                                 request, {name: value for name, value in prior.items() if value}),
            lambda inputs: self._execute_stage(context, job_id, stage, inputs, request))

    async def _cohort_producers(self, context, targets, request, claimed):
        def claim(job_id):
            if self._work_cancelled(context):
                raise asyncio.CancelledError()
            try:
                self.checkpoints.claim_job(context.run_id, job_id, self._owner_reclaimable)
                claimed.add(job_id)
                return True
            except Exception as error:
                unfinished = [stage for stage in (*COHORT_PRODUCERS, "requirements", "fit")
                              if (self.checkpoints.step(context.run_id, job_id, stage) or {}).get("status") not in TERMINAL_STEPS]
                if unfinished:
                    self._cohort_block(context, job_id, unfinished[:1], code=_error_code(error), status="failed")
                    self._cohort_block(context, job_id, unfinished[1:])
                return False

        if self._cohort_policy(request)["producer_mode"] == "serial" or self.settings().get("dailyBudgetUsd", 0) > 0:
            for job_id in targets:
                if claim(job_id):
                    for stage in COHORT_PRODUCERS:
                        await self._cohort_producer(context, job_id, stage, request)
            return
        # Exactly one worker owns each distinct model lane. Queue backpressure
        # bounds in-flight jobs independently of the admitted cohort size.
        analysis_queue, extraction_queue = asyncio.Queue(maxsize=1), asyncio.Queue(maxsize=1)

        async def enrich():
            for job_id in targets:
                if claim(job_id):
                    await self._cohort_producer(context, job_id, "enrich", request)
                    await analysis_queue.put(job_id)
            await analysis_queue.put(None)

        async def consume(queue, stage, following=None):
            while (job_id := await queue.get()) is not None:
                await self._cohort_producer(context, job_id, stage, request)
                if following is not None:
                    await following.put(job_id)
            if following is not None:
                await following.put(None)

        tasks = [asyncio.create_task(enrich()),
                 asyncio.create_task(consume(analysis_queue, "role_analysis", extraction_queue)),
                 asyncio.create_task(consume(extraction_queue, "requirements_extract"))]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _cohort_normalize(self, context, targets, claimed, request):
        prepared = []
        for job_id in targets:
            accepted = self.checkpoints.step(context.run_id, job_id, "requirements")
            if accepted and accepted["status"] in TERMINAL_STEPS | {"failed", "blocked", "cancelled"}:
                continue
            extraction = self.checkpoints.step(context.run_id, job_id, "requirements_extract")
            if extraction and extraction["status"] == "succeeded":
                prepared.append(extraction["result"])
            else:
                self._cohort_block(context, job_id, ["requirements", "fit"])

        async def normalize(inputs):
            expected = {item["job_id"]: item for item in inputs["prepared"]}
            if not claimed.issuperset(expected):
                raise AppError("preparation_job_busy", "Another preparation owns a job in the frozen request.", 409)
            result = await self.requirements.finalize_cohort(inputs["prepared"], operation_id=inputs["_operation_id"],
                cancelled=lambda: self._work_cancelled(context), heartbeat=context.heartbeat,
                catalog_prompt_version=request.get("cohort_catalog_prompt_version"))
            jobs = result["jobs"]
            if (result["operation_id"] != inputs["_operation_id"] or len(jobs) != len(expected)
                    or {item["job_id"] for item in jobs} != set(expected)
                    or any(item[key] != expected[item["job_id"]][key] for item in jobs
                           for key in ("posting_revision", "posting_hash"))):
                raise AppError("requirements_cohort_result_invalid", "The normalized result does not cover its admitted cohort.", 409)
            return result

        succeeded = await self._cohort_step(context, "", "requirements_normalize",
            lambda: {"prepared": prepared} if prepared else {"skip": "no_pending_requirement_producers"}, normalize)
        phase = self.checkpoints.step(context.run_id, "", "requirements_normalize")
        if not succeeded:
            for item in (phase["input"] or {}).get("prepared", prepared):
                self._cohort_block(context, item["job_id"], ["requirements"],
                                   code=phase["errorCode"] or "requirements_cohort_failed", status="failed")
                self._cohort_block(context, item["job_id"], ["fit"])
            return
        if phase["status"] == "skipped":
            return
        # The saved phase inputs, rather than today's pending set, own replay
        # after a committed normalization and a lost projection acknowledgement.
        for item in phase["result"]["jobs"]:
            existing = self.checkpoints.step(context.run_id, item["job_id"], "requirements")
            if existing and existing["status"] in TERMINAL_STEPS | {"failed", "blocked", "cancelled"}:
                continue
            self.checkpoints.finish_step(context.run_id, item["job_id"], "requirements", "succeeded", result={
                "revision": item["revision"], "postingRevision": item["posting_revision"],
                "postingHash": item["posting_hash"], "status": item["status"]})

    def _cohort_qualification_operation(self, context, targets):
        phase = self.checkpoints.step(context.run_id, "", "fit_qualify")
        identities = {(phase["input"] or {}).get("_operation_id")} if phase else set()
        for job_id in targets:
            step = self.checkpoints.step(context.run_id, job_id, "fit")
            if step:
                identities.add((step["input"] or {}).get("_cohort_operation_id"))
        identities.discard(None)
        if len(identities) > 1:
            raise ConflictError("The cohort qualification belongs to inconsistent admitted operations.")
        return next(iter(identities), _operation(context.run_id, "", "fit_qualify"))

    async def _cohort_qualify(self, context, targets, claimed):
        operation_id = self._cohort_qualification_operation(context, targets)
        job_ids, expected_requirements, expected_score_revisions = [], {}, {}
        for job_id in targets:
            step = self.checkpoints.step(context.run_id, job_id, "fit")
            if step and step["status"] in {"pending", "running"} and not (step["input"] or {}).get("skip"):
                if (step["input"] or {}).get("_cohort_operation_id") == operation_id:
                    job_ids.append(job_id)
                    expected_requirements[job_id] = step["input"]["_requirements_binding"]
                    expected_score_revisions[job_id] = step["input"]["expected_revision"]

        async def qualify(inputs):
            if not claimed.issuperset(inputs["job_ids"]):
                raise AppError("preparation_job_busy", "Another preparation owns a job in the frozen request.", 409)
            for job_id in inputs["job_ids"]:
                pin = self.checkpoints.step(context.run_id, job_id, "fit")["input"]
                if (pin["_cohort_operation_id"] != inputs["_operation_id"]
                        or pin["_requirements_binding"] != inputs["expected_requirements"][job_id]
                        or pin["expected_revision"] != inputs["expected_score_revisions"][job_id]):
                    raise ConflictError("The cohort qualification does not match its frozen score inputs.")
                self._assert_search_binding(job_id, pin)
            return await self.fit.qualify_cohort(inputs["job_ids"], expected_requirements=inputs["expected_requirements"],
                expected_score_revisions=inputs["expected_score_revisions"],
                operation_id=inputs["_operation_id"],
                cancelled=lambda: self._work_cancelled(context), heartbeat=context.heartbeat)

        succeeded = await self._cohort_step(context, "", "fit_qualify",
            lambda: {"job_ids": job_ids, "expected_requirements": expected_requirements,
                     "expected_score_revisions": expected_score_revisions, "_operation_id": operation_id}
            if job_ids else {"skip": "no_pending_cohort_qualifications"}, qualify)
        if not succeeded:
            phase = self.checkpoints.step(context.run_id, "", "fit_qualify")
            for job_id in (phase["input"] or {}).get("job_ids", job_ids):
                self._cohort_block(context, job_id, ["fit"], code=phase["errorCode"] or "fit_cohort_failed", status="failed")

    async def _run_cohort(self, context, targets, request, failed):
        claimed = set()
        abandoned = False
        try:
            await self._cohort_producers(context, targets, request, claimed)
            await self._cohort_normalize(context, targets, claimed, request)
            self._prepare_search_fit(context, targets, request, shared=True)
            await self._cohort_qualify(context, targets, claimed)
            for job_id in targets:
                step = self.checkpoints.step(context.run_id, job_id, "fit")
                if step is None:
                    self._cohort_block(context, job_id, ["fit"])
                    continue
                await self._cohort_step(context, job_id, "fit", lambda: step["input"],
                    lambda inputs: self._execute_stage(context, job_id, "fit", inputs, request))
            failed = failed or any(step["status"] in {"failed", "blocked", "cancelled"}
                                   for step in self.checkpoints.get_run(context.run_id)["steps"])
            return self.checkpoints.settle_search(context.run_id, failed,
                lambda connection: self._verify_search_fit(context, targets, connection=connection))
        except asyncio.CancelledError:
            abandoned = not self._user_cancelled(context)
            raise
        finally:
            if not abandoned:
                for job_id in claimed:
                    self.checkpoints.release_job(context.run_id, job_id)


    async def _run_job(self, context, job_id, request, *, stages=None):
        stages = STAGES[request["recipe"]] if stages is None else stages
        try:
            self.checkpoints.claim_job(context.run_id, job_id, self._owner_reclaimable)
        except Exception as error:
            unfinished = [stage for stage in stages if (self.checkpoints.step(context.run_id, job_id, stage) or {}).get("status") not in TERMINAL_STEPS]
            for index, stage in enumerate(unfinished):
                self.checkpoints.finish_step(context.run_id, job_id, stage, "failed" if index == 0 else "blocked",
                                  error_code=_error_code(error) if index == 0 else "upstream_stage_failed")
            return True
        abandoned = False
        previous = {}
        blocked = False
        try:
            for stage in stages:
                if self._work_cancelled(context):
                    raise asyncio.CancelledError()
                step = self.checkpoints.step(context.run_id, job_id, stage)
                if step and step["status"] in TERMINAL_STEPS:
                    previous[stage] = step
                    continue
                if step and step["status"] in {"failed", "blocked"}:
                    # An activity replay resumes interrupted work. A completed
                    # failure needs a new, explicitly admitted retry identity.
                    previous[stage] = step
                    blocked = True
                    continue
                if blocked:
                    self.checkpoints.finish_step(context.run_id, job_id, stage, "blocked", error_code="upstream_stage_failed")
                    continue
                try:
                    inputs = step["input"] if step and step["input"] is not None else self._inputs(job_id, stage, request, previous)
                    self._assert_search_binding(job_id, inputs)
                    if inputs.get("skip"):
                        self.checkpoints.finish_step(context.run_id, job_id, stage, "skipped", result=inputs)
                    else:
                        inputs.setdefault("_operation_id", _operation(context.run_id, job_id, stage))
                        inputs = self.checkpoints.start_step(context.run_id, job_id, stage, inputs)
                        context.heartbeat({"jobId": job_id, "stage": stage})
                        with self._capacity_wait(context, job_id, stage):
                            result = await self._execute_stage(context, job_id, stage, inputs, request)
                        status = "warning" if stage == "review" and result.get("review_status") not in {None, "pass", "not_applicable"} else "succeeded"
                        self.checkpoints.finish_step(context.run_id, job_id, stage, status, result=result)
                    previous[stage] = self.checkpoints.step(context.run_id, job_id, stage)
                except asyncio.CancelledError:
                    if self._user_cancelled(context):
                        self.checkpoints.finish_step(context.run_id, job_id, stage, "cancelled", error_code="action_cancelled")
                    raise
                except Exception as error:
                    if self._user_cancelled(context):
                        self.checkpoints.finish_step(context.run_id, job_id, stage, "cancelled", error_code="action_cancelled")
                        raise asyncio.CancelledError() from None
                    current = self.checkpoints.step(context.run_id, job_id, stage)
                    if not current or current["status"] != "failed":
                        self.checkpoints.finish_step(context.run_id, job_id, stage, "failed", error_code=_error_code(error))
                    blocked = True
            return blocked
        except asyncio.CancelledError:
            # Worker shutdown does not release ownership while the same durable
            # action may still be replayed. Explicit cancellation is terminal.
            abandoned = not self._user_cancelled(context)
            raise
        finally:
            if not abandoned:
                self.checkpoints.release_job(context.run_id, job_id)


    async def run(self, context, raw, *, parent=None):
        # The action keeps the configured mode and threshold throughout replay.
        frozen = self.checkpoints.request(context.run_id)
        selection_limit = SEARCH_JOB_LIMIT if parent and frozen and self._cohort_policy(frozen) else 1000
        request = _validate(raw, selection_limit=selection_limit)
        request["contract_version"] = "requirements-v2"
        if frozen is not None:
            if frozen.get("contract_version") != request["contract_version"]:
                raise AppError("action_contract_changed", "Start a new preparation run for the revised matching contract. The earlier run remains in history.", 409)
            if any(frozen[k] != value for k, value in request.items()
                   if k != "min_fit_score" or value is not None):
                raise ConflictError("The preparation identity belongs to different input.")
            request = frozen
        else:
            settings = self.settings()
            if parent:
                parent_request = self.checkpoints.request(parent)
                if parent_request is None:
                    raise NotFoundError("The prior preparation run does not exist.")
                if parent_request.get("contract_version") != request["contract_version"]:
                    raise AppError("action_contract_changed", "Start a new preparation run for the revised matching contract. The earlier run remains in history.", 409)
                request["resume_mode"] = parent_request["resume_mode"]
                catalog_prompt_version = parent_request.get("refresh_catalog_prompt_version")
            else:
                # An explicit task choice is already part of the durable action
                # payload admitted by Actions. Never replace it with a later
                # global preference while a queued action starts or replays.
                request["resume_mode"] = request.get("resume_mode", settings.get("resumeMode", "tailored"))
                catalog_prompt_version = self.requirements.admitted_catalog_prompt(context.run_id)
            if catalog_prompt_version is not None:
                request["refresh_catalog_prompt_version"] = catalog_prompt_version
            request["min_fit_score"] = request["min_fit_score"] or settings.get("minFitScore", 7)
        policy = self._cohort_policy(request)
        self.checkpoints.open_run(context.run_id, request, parent)
        if parent and not policy:
            # Successful work from the prior run is evidence, not permission to
            # repeat it. Each later stage still rechecks its current sources.
            self.checkpoints.inherit_retry_steps(context.run_id, parent, request["job_ids"])
        failed = False
        try:
            if policy and self._work_cancelled(context):
                raise asyncio.CancelledError()
            discovered = None
            if request["recipe"] in DISCOVERY_RECIPES:
                if self.discovery is None:
                    raise AppError("discovery_unavailable", "Enable Discovery before starting this recipe.", 409)
                prior = self.checkpoints.step(context.run_id, "", "discover")
                if prior and prior["status"] in TERMINAL_STEPS:
                    discovered = prior["result"]
                    failed = prior["status"] == "warning"
                else:
                    if policy and request.get("target_route"):
                        raise ConflictError("The original acquisition outcome is missing from the frozen search.")
                    inputs = self.checkpoints.start_step(context.run_id, "", "discover", request["discovery"])
                    discovery_id = context.run_id if request["recipe"] == "search" else _operation(context.run_id, "", "discover")
                    child = ActionContext(discovery_id, context.request_id,
                                          lambda: self._work_cancelled(context), context.heartbeat)
                    try:
                        result = await self.discovery.search(child, inputs)
                        if request["recipe"] == "search" and result.get("status") == "failed" and not result.get("newJobIds"):
                            raise AppError("discovery_sources_failed", "The selected sources did not complete.", 502)
                        discovered = result if request["recipe"] == "search" else {
                            "discoveryRunId": result.get("runId"), "newJobIds": result.get("newJobIds", []), "jobIds": result.get("jobIds", []),
                            "newJobs": result.get("newJobs", 0), "failureCount": len(result.get("failures", []))}
                        state = "warning" if result.get("failures") else "succeeded"
                        self.checkpoints.finish_step(context.run_id, "", "discover", state, result=discovered)
                        failed = state == "warning"
                    except Exception as error:
                        user_cancelled = self._user_cancelled(context)
                        if user_cancelled or (policy and context.cancelled()):
                            if user_cancelled:
                                self.checkpoints.finish_step(context.run_id, "", "discover", "cancelled", error_code="action_cancelled")
                            raise asyncio.CancelledError() from None
                        outcome = self.discovery.search_outcome(discovery_id) if (
                            request["recipe"] == "search" and getattr(error, "code", None) == "discovery_sources_failed"
                        ) else None
                        if outcome and outcome["status"] == "failed" and outcome.get("newJobIds"):
                            # Failed acquisition can still have committed jobs.
                            # Preserve its canonical failure and assess only that
                            # retained cohort, without another provider attempt.
                            discovered = outcome
                            self.checkpoints.finish_step(context.run_id, "", "discover", "warning", result=outcome,
                                                         error_code=_error_code(error))
                            failed = True
                        else:
                            self.checkpoints.finish_step(context.run_id, "", "discover", "failed", error_code=_error_code(error))
                            raise
            targets, route = self._target_ids(context.run_id, request, discovered)
            if policy and route == "cohort":
                failed = await self._run_cohort(context, targets, request, failed)
            else:
                if policy and route != "per_job":
                    raise ConflictError("The frozen search preparation route is missing or unsupported.")
                if request["recipe"] == "search":
                    # Consolidation can replace another cohort member's demand.
                    # Settle every producer before any Fit, then freeze final pins.
                    for job_id in targets:
                        if await self._run_job(context, job_id, request, stages=STAGES["search"][:-1]):
                            failed = True
                    self._prepare_search_fit(context, targets, request)
                for job_id in targets:
                    if await self._run_job(context, job_id, request):
                        failed = True
                if request["recipe"] == "search" and self._verify_search_fit(context, targets):
                    failed = True
                self.checkpoints.set_status(context.run_id, "partial" if failed else "succeeded")
            if failed:
                raise AppError("preparation_partial", "Some preparation steps need attention. Inspect the run for each outcome.", 409)
            return self.get_run(context.run_id)
        except asyncio.CancelledError:
            if self._user_cancelled(context):
                self.checkpoints.set_status(context.run_id, "cancelled")
            raise
        except Exception:
            run = self.get_run(context.run_id)
            if run["status"] == "running":
                self.checkpoints.set_status(context.run_id, "failed")
            raise


    async def search(self, context, payload):
        """Acquire and initially assess under the public search action identity."""
        try:
            # Discovery's authored new-job limit already bounds this cohort to
            # 10,000. Do not silently impose the manual selection default of 100.
            run = await self.run(context, {"recipe": "search", "scope": "pending", "discovery": payload, "limit": SEARCH_JOB_LIMIT})
        except AppError as error:
            if error.code != "preparation_partial":
                raise
            run = self.get_run(context.run_id)
        discovered = self.checkpoints.step(context.run_id, "", "discover")["result"]
        failures = [{"jobId": step["jobId"], "stage": step["stage"], "code": step["errorCode"]}
                    for step in run["steps"] if step["jobId"] and step["status"] == "failed"]
        if run.get("targetRoute") == "cohort":
            reported = {failure["jobId"] for failure in failures}
            completed = {step["jobId"] for step in run["steps"]
                         if step["stage"] == "fit" and step["status"] in TERMINAL_STEPS}
            failures.extend({"jobId": job_id, "stage": "fit", "code": "preparation_incomplete"}
                            for job_id in run["jobIds"] if job_id not in reported | completed)
        assessed = sum(step["stage"] == "fit" and step["status"] == "succeeded"
                       and type((step.get("result") or {}).get("score")) in {int, float} for step in run["steps"])
        skipped = [{"jobId": step["jobId"], "reason": "unsupported_posting_language"}
                   for step in run["steps"] if step["stage"] == "fit" and step["status"] == "skipped"
                   and (step.get("result") or {}).get("skip") == "unsupported_posting_language"]
        skipped.extend({"jobId": step["jobId"], "reason": "no_extractable_requirements"}
                       for step in run["steps"] if step["stage"] == "fit" and step["status"] == "succeeded"
                       and (step.get("result") or {}).get("score") is None)
        preparation = {"status": "partial" if failures else "succeeded", "assessedJobs": assessed,
                       "failedJobs": len({failure["jobId"] for failure in failures}), "failures": failures,
                       "skippedJobs": len(skipped), "skipped": skipped}
        status = "partial" if run["status"] == "partial" else discovered["status"]
        return {**discovered, "ok": status == "completed", "status": status, "acquisitionStatus": discovered["status"],
                "preparationAvailable": True, "preparation": preparation}


    @staticmethod
    def _retry_options(payload):
        if not isinstance(payload, dict) or set(payload) - {"run_id", "job_ids"} or not isinstance(payload.get("run_id"), str):
            raise AppError("invalid_preparation_retry", "Supply a previous run ID and optional job IDs.")
        requested = payload.get("job_ids")
        if requested is not None and (not isinstance(requested, list) or not all(isinstance(i, str) for i in requested)):
            raise AppError("invalid_job_selection", "Select jobs from the previous run.")
        return payload["run_id"], requested

    async def retry(self, context, payload):
        parent, requested = self._retry_options(payload)
        frozen = self.checkpoints.request(context.run_id)
        if frozen and self._cohort_policy(frozen):
            return await self.run(context, {key: frozen[key] for key in PREPARATION_OPTIONS if key in frozen}, parent=parent)
        previous = self.get_run(parent)
        if previous["status"] not in {"failed", "partial", "cancelled"}:
            raise ConflictError("Only an unsuccessful or cancelled run can be retried.")
        failed_ids = {step["jobId"] for step in previous["steps"] if step["jobId"] and step["status"] in {"failed", "blocked", "cancelled"}}
        if previous["status"] == "cancelled":
            for job_id in previous["jobIds"]:
                completed = {step["stage"] for step in previous["steps"]
                             if step["jobId"] == job_id and step["status"] in TERMINAL_STEPS}
                if not set(STAGES[previous["recipe"]]).issubset(completed):
                    failed_ids.add(job_id)
        selected = list(dict.fromkeys(requested)) if requested is not None else [i for i in previous["jobIds"] if i in failed_ids]
        original = self.checkpoints.request(parent)
        if original is None:
            raise NotFoundError("The prior preparation run does not exist.")
        if self._cohort_policy(original):
            raise AppError("action_contract_changed", "Retry the original search with a new action admission.", 409)
        if any(i not in failed_ids for i in selected):
            raise AppError("invalid_job_selection", "Retry only unfinished jobs from that run.")
        discovery_failed = any(step["stage"] == "discover" and step["status"] in {"failed", "warning", "cancelled"}
                               for step in previous["steps"])
        if not selected and not discovery_failed:
            raise AppError("nothing_to_retry", "There are no failed preparation jobs to retry.", 409)
        recipe = original["recipe"]
        raw = {key: original[key] for key in ("recipe", "job_ids", "scope", "discovery", "limit", "force", "min_fit_score", "allow_below_threshold")}
        raw["resume_mode"] = original["resume_mode"]
        raw.update(recipe=recipe, job_ids=selected, scope="selected" if selected else "pending")
        if recipe not in DISCOVERY_RECIPES:
            raw["discovery"] = {}
        return await self.run(context, raw, parent=parent)
