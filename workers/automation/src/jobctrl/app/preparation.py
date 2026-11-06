"""Explicit preparation policy over public feature and checkpoint ports.

This application service has no HTTP, SQLite, Runtime or Temporal dependency.
Stable stage identities and accepted feature receipts survive worker retries.
"""

from __future__ import annotations

import asyncio
import hashlib

from jobctrl.app.contracts import ActionContext
from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.preparation_ports import PreparationCheckpoints, PreparationSettings, RunReader

RECIPES = {"run", "discover", "enrich", "analyze", "score", "tailor", "prepare"}
STAGES = {
    "run": ("enrich", "role_analysis", "requirements", "fit", "compose", "review", "render"),
    "discover": ("enrich", "role_analysis", "requirements", "fit", "compose", "review", "render"),
    "enrich": ("enrich",),
    "analyze": ("role_analysis", "requirements"),
    "score": ("requirements", "fit"),
    "tailor": ("requirements", "fit", "compose", "review", "render"),
    "prepare": ("requirements", "fit", "compose", "review", "render"),
}
DISCOVERY_KEYS = {"queries", "locations", "boards", "newJobLimit", "resultsPerSite", "hoursOld"}
TERMINAL_STEPS = {"succeeded", "skipped", "warning"}


def _operation(run_id: str, job_id: str, stage: str) -> str:
    return "prep:" + hashlib.sha256(f"{run_id}\0{job_id}\0{stage}".encode()).hexdigest()


def _error_code(error: BaseException) -> str:
    value = getattr(error, "code", None)
    if isinstance(value, str) and 0 < len(value) <= 100 and all(c.isalnum() or c in "_-" for c in value):
        return value
    return "preparation_stage_failed"


def _validate(raw: dict) -> dict:
    if not isinstance(raw, dict) or set(raw) - {"recipe", "job_ids", "scope", "discovery", "limit", "force", "min_fit_score", "allow_below_threshold"}:
        raise AppError("invalid_preparation", "Choose a supported preparation recipe and options.")
    recipe = raw.get("recipe")
    if not isinstance(recipe, str) or recipe not in RECIPES:
        raise AppError("invalid_preparation_recipe", "Choose a supported preparation recipe.")
    ids = raw.get("job_ids", [])
    if not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(i, str) or not i.strip() or len(i) > 120 for i in ids):
        raise AppError("invalid_job_selection", "Select up to 1,000 saved jobs.")
    ids = list(dict.fromkeys(ids))
    scope = raw.get("scope", "selected" if ids else "pending")
    if not isinstance(scope, str) or scope not in {"selected", "pending"} or scope == "selected" and not ids or scope == "pending" and ids:
        raise AppError("invalid_job_selection", "Select jobs or choose pending work.")
    limit = raw.get("limit", max(100, len(ids)))
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise AppError("invalid_preparation_limit", "Use a limit from 1 to 1,000.")
    if scope == "selected" and len(ids) > limit:
        raise AppError("invalid_preparation_limit", "The limit cannot exclude selected jobs.")
    force, override = raw.get("force", False), raw.get("allow_below_threshold", False)
    if type(force) is not bool or type(override) is not bool:
        raise AppError("invalid_preparation_option", "Preparation options must be boolean.")
    minimum = raw.get("min_fit_score")
    if minimum is not None and (type(minimum) is not int or not 1 <= minimum <= 10):
        raise AppError("invalid_fit_threshold", "Use a fit threshold from 1 to 10.")
    discovery = raw.get("discovery", {})
    if not isinstance(discovery, dict) or set(discovery) - DISCOVERY_KEYS or discovery and recipe not in {"run", "discover"}:
        raise AppError("invalid_discovery_options", "Choose supported Discovery options.")
    return {"recipe": recipe, "job_ids": ids, "scope": scope, "limit": limit, "force": force,
            "min_fit_score": minimum, "allow_below_threshold": override, "discovery": discovery}


class PreparationService:
    def __init__(self, checkpoints: PreparationCheckpoints, settings: PreparationSettings, *,
                 profile, jobs, requirements, fit, resumes, discovery=None):
        self.checkpoints, self.settings = checkpoints, settings
        self.profile, self.jobs, self.requirements = profile, jobs, requirements
        self.fit, self.resumes, self.discovery = fit, resumes, discovery
        self.run_reader: RunReader | None = None

    def bind_run_reader(self, reader: RunReader):
        self.run_reader = reader

    def _owner_reclaimable(self, run_id):
        if self.run_reader is None:
            return False
        try:
            return self.run_reader(run_id)["status"] in {"succeeded", "failed", "cancelled"}
        except NotFoundError:
            raise AppError("preparation_owner_unknown", "The prior preparation owner needs inspection.", 409) from None

    def _user_cancelled(self, context):
        # Worker shutdown is recoverable. Only an explicit saved user request
        # becomes terminal; a cancelled asyncio task alone does not prove it.
        if self.run_reader is None:
            return context.cancelled()
        return bool(self.run_reader(context.run_id)["cancellationRequested"])

    def _work_cancelled(self, context):
        return context.cancelled() or self._user_cancelled(context)

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
        stages = [{"stage": stage, "scope": "job"} for stage in STAGES[run["recipe"]]]
        if run["recipe"] in {"run", "discover"}:
            stages.insert(0, {"stage": "discover", "scope": "run"})
        return {**run, "stagePlan": stages, "jobConcurrency": 1}

    def job_summaries(self, job_ids, connection=None):
        return self.checkpoints.job_summaries(job_ids, connection=connection)

    def _target_ids(self, run_id, request, discovery_result):
        saved = self.checkpoints.targets(run_id)
        if saved is not None:
            return saved
        if request["scope"] == "selected":
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
        return self.checkpoints.save_targets(run_id, ids)


    def _pending(self, job, request):
        if request["force"]:
            return True
        recipe, job_id = request["recipe"], job["job_id"]
        if recipe == "enrich":
            return job.get("needs_enrichment", True)
        if recipe == "analyze":
            return not self.jobs.get_analysis(job_id).get("current", False)
        if recipe == "score":
            return not self.fit.get_job_fit(job_id, include_coverage=False).get("current", False)
        return not any(r.get("accepted_revision_id") for r in self.resumes.list(job_id))


    def _inputs(self, job_id, stage, request, prior):
        if stage == "enrich":
            posting = self.jobs.snapshot(job_id)
            if request["recipe"] in {"run", "discover"} and not posting.get("needs_enrichment", True):
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
            return {"expected_revision": current["score"]["revision"] if current["score"] else 0,
                    "force": request["force"] and request["recipe"] != "tailor", "prepare_wording": request["resume_mode"] != "baseline",
                    "prepare_coverage": request["resume_mode"] != "baseline"}
        if stage == "compose":
            fit = self.fit.get_job_fit(job_id, include_coverage=False)
            score = fit.get("score")
            if not fit.get("current") or not score:
                raise AppError("fit_not_current", "Current person fit is required before resume preparation.", 409)
            expected_fit = (prior.get("fit", {}).get("result") or {}).get("revision")
            if expected_fit is not None and score["revision"] != expected_fit:
                raise ConflictError("Person fit changed before resume preparation.")
            if score["eligibility"]["status"] == "blocked":
                raise AppError("eligibility_blocked", "Resolve the recorded eligibility blocker first.", 409)
            if score["score"] < request["min_fit_score"] and not request["allow_below_threshold"]:
                return {"skip": "below_fit_threshold", "score": score["score"], "threshold": request["min_fit_score"]}
            documents = self.resumes.list(job_id)
            if documents and not request["force"]:
                existing = documents[-1]
                if existing.get("accepted_revision_id"):
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
        if stage == "review" and previous.get("mode") == "baseline_copy":
            return {"skip": "baseline_copy"}
        state = self.resumes.get(previous["resume_id"])
        if state["current_revision"] != previous.get("revision_id"):
            raise ConflictError("The resume changed before the next preparation step.")
        reviewed = prior.get("review", {}).get("result") or {}
        expected_version = reviewed.get("version", previous.get("version")) if stage == "render" else previous.get("version")
        if state["version"] != expected_version:
            raise ConflictError("The resume version changed before the next preparation step.")
        if stage == "render":
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
            while True:
                if cancelled():
                    raise asyncio.CancelledError()
                try:
                    value = await self.requirements.refresh(job_id, **inputs, operation_id=op,
                                                           cancelled=cancelled, heartbeat=context.heartbeat)
                    break
                except Exception as error:
                    if getattr(error, "code", None) != "requirements_scan_pending":
                        raise
                    progress = getattr(error, "details", None) or {}
                    context.heartbeat({"jobId": job_id, "stage": stage, "continuationId": progress.get("continuation_id"),
                                       "requirementsCompleted": progress.get("requirements_completed"),
                                       "requirementsTotal": progress.get("requirements_total")})
                    await asyncio.sleep(0)
            if value.get("stale"):
                raise ConflictError("The accepted requirement snapshot is stale.")
            return {"revision": value["revision"], "postingRevision": value["posting_revision"]}
        if stage == "fit":
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


    async def _run_job(self, context, job_id, request):
        stages = STAGES[request["recipe"]]
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
                if blocked:
                    self.checkpoints.finish_step(context.run_id, job_id, stage, "blocked", error_code="upstream_stage_failed")
                    continue
                try:
                    inputs = step["input"] if step and step["input"] is not None else self._inputs(job_id, stage, request, previous)
                    if inputs.get("skip"):
                        self.checkpoints.finish_step(context.run_id, job_id, stage, "skipped", result=inputs)
                    else:
                        inputs.setdefault("_operation_id", _operation(context.run_id, job_id, stage))
                        inputs = self.checkpoints.start_step(context.run_id, job_id, stage, inputs)
                        context.heartbeat({"jobId": job_id, "stage": stage})
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
        request = _validate(raw)
        # The action keeps the configured mode and threshold throughout replay.
        frozen = self.checkpoints.request(context.run_id)
        if frozen is not None:
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
                request["resume_mode"] = parent_request["resume_mode"]
            else:
                request["resume_mode"] = settings.get("resumeMode", "tailored")
            request["min_fit_score"] = request["min_fit_score"] or settings.get("minFitScore", 7)
        self.checkpoints.open_run(context.run_id, request, parent)
        if parent:
            # Successful work from the prior run is evidence, not permission to
            # repeat it. Each later stage still rechecks its current sources.
            self.checkpoints.inherit_retry_steps(context.run_id, parent, request["job_ids"])
        failed = False
        try:
            discovered = None
            if request["recipe"] in {"run", "discover"}:
                if self.discovery is None:
                    raise AppError("discovery_unavailable", "Enable Discovery before starting this recipe.", 409)
                prior = self.checkpoints.step(context.run_id, "", "discover")
                if prior and prior["status"] in TERMINAL_STEPS:
                    discovered = prior["result"]
                    failed = prior["status"] == "warning"
                else:
                    inputs = self.checkpoints.start_step(context.run_id, "", "discover", request["discovery"])
                    child = ActionContext(_operation(context.run_id, "", "discover"), context.request_id,
                                          lambda: self._work_cancelled(context), context.heartbeat)
                    try:
                        result = await self.discovery.search(child, inputs)
                        discovered = {"discoveryRunId": result.get("runId"), "newJobIds": result.get("newJobIds", []), "jobIds": result.get("jobIds", []),
                                      "newJobs": result.get("newJobs", 0), "failureCount": len(result.get("failures", []))}
                        state = "warning" if result.get("failures") else "succeeded"
                        self.checkpoints.finish_step(context.run_id, "", "discover", state, result=discovered)
                        failed = state == "warning"
                    except Exception as error:
                        if self._user_cancelled(context):
                            self.checkpoints.finish_step(context.run_id, "", "discover", "cancelled", error_code="action_cancelled")
                            raise asyncio.CancelledError() from None
                        self.checkpoints.finish_step(context.run_id, "", "discover", "failed", error_code=_error_code(error))
                        raise
            targets = self._target_ids(context.run_id, request, discovered)
            for job_id in targets:
                if await self._run_job(context, job_id, request):
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


    async def retry(self, context, payload):
        if not isinstance(payload, dict) or set(payload) - {"run_id", "job_ids"} or not isinstance(payload.get("run_id"), str):
            raise AppError("invalid_preparation_retry", "Supply a previous run ID and optional job IDs.")
        previous = self.get_run(payload["run_id"])
        if previous["status"] not in {"failed", "partial", "cancelled"}:
            raise ConflictError("Only an unsuccessful or cancelled run can be retried.")
        requested = payload.get("job_ids")
        if requested is not None and (not isinstance(requested, list) or not all(isinstance(i, str) for i in requested)):
            raise AppError("invalid_job_selection", "Select jobs from the previous run.")
        failed_ids = {step["jobId"] for step in previous["steps"] if step["jobId"] and step["status"] in {"failed", "blocked", "cancelled"}}
        if previous["status"] == "cancelled":
            for job_id in previous["jobIds"]:
                completed = {step["stage"] for step in previous["steps"]
                             if step["jobId"] == job_id and step["status"] in TERMINAL_STEPS}
                if not set(STAGES[previous["recipe"]]).issubset(completed):
                    failed_ids.add(job_id)
        selected = list(dict.fromkeys(requested)) if requested is not None else [i for i in previous["jobIds"] if i in failed_ids]
        if any(i not in failed_ids for i in selected):
            raise AppError("invalid_job_selection", "Retry only unfinished jobs from that run.")
        original = self.checkpoints.request(payload["run_id"])
        if original is None:
            raise NotFoundError("The prior preparation run does not exist.")
        discovery_failed = any(step["stage"] == "discover" and step["status"] in {"failed", "warning", "cancelled"}
                               for step in previous["steps"])
        if not selected and not discovery_failed:
            raise AppError("nothing_to_retry", "There are no failed preparation jobs to retry.", 409)
        recipe = original["recipe"]
        raw = {key: original[key] for key in ("recipe", "job_ids", "scope", "discovery", "limit", "force", "min_fit_score", "allow_below_threshold")}
        raw.update(recipe=recipe, job_ids=selected, scope="selected" if selected else "pending")
        if recipe not in {"run", "discover"}:
            raw["discovery"] = {}
        return await self.run(context, raw, parent=payload["run_id"])
