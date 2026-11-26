"""Discovery plans search and admits provider observations through public Jobs."""

from __future__ import annotations

import asyncio
import base64
import time
from contextlib import nullcontext, suppress

from jobctrl.app.errors import AppError, ConflictError
from jobctrl.app.model_capacity import wait_for_model_capacity
from jobctrl.features.discovery.domain import LINKEDIN_REQUEST_INTERVAL_SECONDS, SOURCE_FETCH_POLICY, fingerprint, now, search_units, validate_settings
from jobctrl.features.discovery.qualification import ROLE_TARGET_POLICY, match_role_targets, posting_role_evidence, read_role_decision, role_binding, role_target_sources
from jobctrl.features.discovery.query_fairness import FAIR_QUERY_SCHEDULING, BoardQueryTurn, query_allowances
from jobctrl.features.discovery.remote_search import validate_remote_search_scope
from jobctrl.features.discovery.role_calls import ROLE_CALL_CUSTODY
from jobctrl.features.discovery.targets import TargetPlanner
from jobctrl.features.discovery.ports import DiscoveryStore, ExecutionPort, JobsPort, ModelPort


class _SettledIntake(Exception):
    def __init__(self, outcome):
        self.outcome = outcome


class DiscoveryService:
    def __init__(
        self,
        repository: DiscoveryStore,
        *,
        jobs: JobsPort,
        model: ModelPort,
        execution: ExecutionPort,
        profile=None,
    ):
        self.repository, self.jobs, self.model = repository, jobs, model
        self.profile, self.execution = profile, execution
        self.targets = TargetPlanner(repository, profile)

    def get_settings(self):
        return self.repository.read_settings()

    def get_crawler_settings(self):
        saved = self.get_settings()
        settings = saved["settings"]
        return {
            "revision": saved["revision"],
            "crawl_user_agent": {
                "product": settings["crawlUserAgentProduct"],
                "contact": settings["crawlUserAgentContact"],
                "use_browser_headers": settings["useBrowserHeaders"],
            },
        }

    def save_settings(self, changes):
        try:
            if "boards" in changes and any(board not in self.repository.boards for board in changes["boards"]):
                raise ValueError("Unsupported JobStreaming board")
            settings = validate_settings({**self.get_settings()["settings"], **changes})
        except (ValueError, TypeError):
            raise AppError("invalid_discovery_settings", "The Discovery settings are invalid.") from None
        for unit in search_units(settings):
            validate_remote_search_scope(
                unit["sites"], location=unit["location"], remote_only=unit["remote_only"], hours_old=unit["hours_old"]
            )
        return self.repository.save_settings(changes)

    def schedule_definition(self):
        saved = self.get_settings()
        return {
            "enabled": saved["settings"]["schedulingEnabled"],
            "cron": saved["settings"]["scheduleCron"],
            "timezone": saved["settings"].get("scheduleTimezone", "UTC"),
            "revision": saved["revision"],
            "action": "discovery.search",
            "payload": {"scheduled": True},
        }

    def list_sources(self):
        return self.repository.sources()

    def patch_source_state(self, source_id, data):
        if data.get("expectedRevision") is None:
            raise AppError(
                "expected_revision_required", "Supply the saved source revision before changing its state.", 428
            )
        if set(data) - {"state", "reason", "expectedRevision"}:
            raise AppError("invalid_source_state", "Only the state of an existing JobStreaming board can change.")
        return self.repository.set_board_state(source_id, data.get("state"), data["expectedRevision"])

    def digest_summary(self):
        return {"sources": self.list_sources()["sources"], "runs": self.repository.runs()["runs"]}

    def progress_summary(self, *, limit=100):
        return self.repository.progress_summary(limit=limit)

    def preview_source(self, source_id):
        self.repository.source(source_id)
        leads = []
        for snapshot in self.jobs.list_job_snapshots(include_inactive=True):
            if snapshot["source_id"] == source_id:
                leads.append(
                    {
                        "candidateUrl": snapshot["url"],
                        "title": snapshot["title"],
                        "company": snapshot["company"],
                        "location": snapshot["location"],
                        "observedAt": snapshot["observed_at"],
                        "jobId": snapshot["job_id"],
                        "estimatedConfidence": None,
                    }
                )
            if len(leads) == 10:
                break
        return {"ok": True, "sourceId": source_id, "leads": leads, "generatedAt": now()}

    async def import_capture(self, item_id, payload):
        item = self.repository.capture_item(item_id)
        expected_lifecycle = payload.get("expectedLifecycleId") or payload.get("lifecycleId")
        if expected_lifecycle is None or item["lifecycleId"] != expected_lifecycle:
            raise ConflictError("Review the current capture request before importing.")
        generation = item["generation"]
        command_hash = fingerprint(payload)
        if item["status"] == "imported":
            if item.get("submittedInputHash") != command_hash:
                raise AppError(
                    "capture_replay_mismatch",
                    "This capture lifetime already accepted different submitted input.",
                    409,
                    {"reason": "capture_replay_mismatch"},
                )
            accepted = self.jobs.read_capture_receipt(f"manual-capture:{item_id}:{generation}")
            if accepted:
                return {
                    "ok": True,
                    "itemId": item_id,
                    "lifecycleId": item["lifecycleId"],
                    "jobKey": accepted["job_id"],
                    "jobId": accepted["job_id"],
                    "importedAt": item.get("importedAt"),
                    "provenance": item.get("captureProvenance"),
                    "posting": accepted,
                }
        body = dict(payload)
        if body.get("contentHtmlBase64"):
            try:
                encoded = body["contentHtmlBase64"]
                if not isinstance(encoded, str) or len(encoded) > 8_000_000:
                    raise ValueError
                body["html"] = base64.b64decode(encoded, validate=True).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                raise AppError("invalid_capture", "The saved HTML capture is invalid.") from None
        if body.get("contentText"):
            body["text"] = body["contentText"]
        provenance = {
            "sourceKind": "user_mediated_capture",
            "originatingUrl": item["originatingUrl"],
            "captureMode": body.get("captureMode", "current_page"),
            "futureManualActionRequired": body.get("futureManualActionRequired") is True,
            "captureClient": body.get("captureClient", "web"),
        }
        body["provenance"] = provenance
        receipt_key = f"manual-capture:{item_id}:{generation}"
        previous_receipt = self.jobs.read_capture_receipt(receipt_key)
        if previous_receipt:
            result = self.repository.complete_capture_import(
                item_id, generation, expected_lifecycle, command_hash, provenance, previous_receipt["job_id"]
            )
            return {
                **result,
                "jobId": previous_receipt["job_id"],
                "jobKey": previous_receipt["job_id"],
                "posting": previous_receipt,
                "importedAt": result["importedAt"],
                "provenance": provenance,
            }
        owner_token = self.repository.claim_capture_import(
            item_id, generation, expected_lifecycle, command_hash, provenance
        )

        def guard(conn):
            self.repository.assert_capture_import_current(conn, item_id, generation, expected_lifecycle, owner_token)

        def acknowledge(conn, accepted):
            self.repository.complete_capture_import(
                item_id,
                generation,
                expected_lifecycle,
                command_hash,
                provenance,
                accepted["job_id"],
                token=owner_token,
                connection=conn,
            )

        try:
            posting = await self.jobs.capture_external(
                {
                    **body,
                    "url": body.get("url") or body.get("capturedUrl") or item["originatingUrl"],
                    "source_id": item.get("sourceId") or "manual_capture:" + item_id,
                    "receipt_key": receipt_key,
                },
                guard=guard,
                on_accepted=acknowledge,
            )
        except Exception as error:
            self.repository.release_capture_import(item_id, owner_token)
            reason = (
                "manual_capture_state_changed"
                if isinstance(error, ConflictError)
                else "capture_replay_mismatch"
                if getattr(error, "code", "") == "capture_replay_mismatch"
                else "manual_capture_provider_failed"
                if isinstance(error, AppError)
                else "manual_capture_database_failed"
            )
            raise AppError(
                getattr(error, "code", "manual_capture_failed"),
                "The capture import did not complete; the previous accepted posting is retained.",
                getattr(error, "status_code", 503),
                {"reason": reason},
            ) from None
        result = {"ok": True, **self.repository.capture_item(item_id)}
        return {
            **result,
            "jobId": posting["job_id"],
            "jobKey": posting["job_id"],
            "posting": posting,
            "importedAt": result.get("importedAt") or now(),
            "provenance": provenance,
        }

    def record_feedback(self, data):
        job_id = data.get("jobKey") or data.get("job_id")
        if job_id:
            self.jobs.get_job(job_id)
        return self.repository.feedback(data)

    async def generate_feedback_proposals(self, *, operation_id=None, request=None):
        request_hash = fingerprint(request or {})
        if operation_id:
            replay = self.repository.feedback_operation(operation_id, request_hash)
            if replay:
                return replay
        # A deliberate refresh owns semantic proposal generation; list is read-only.
        sources = self.repository.feedback_sources(limit=100)
        if not sources:
            return self.repository.save_feedback_proposals(
                [], operation_id=operation_id, input_fingerprint=request_hash
            )
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["suggestions"],
            "properties": {
                "suggestions": {
                    "type": "array",
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["ruleKind", "titlePattern", "titleDisplay", "reason", "evidence"],
                        "properties": {
                            "ruleKind": {"type": "string", "enum": ["exact_title_exclusion", "target_role_review"]},
                            "titlePattern": {"type": "string"},
                            "titleDisplay": {"type": "string"},
                            "reason": {"type": "string"},
                            "evidence": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["source_id", "quote"],
                                    "properties": {"source_id": {"type": "string"}, "quote": {"type": "string"}},
                                },
                            },
                        },
                    },
                }
            },
        }
        response = await self.model.determine(
            operation="discovery_feedback_proposals",
            instructions="Propose optional source-bound search-target or whole-title exclusion reviews from explicit user feedback only. Never silently apply rules. Every proposal needs exact feedback citations; no lexical inference or regex rules. Preserve uncertainty and return no proposal when feedback does not support one.",
            sources=sources,
            response_schema=schema,
            lane="enrichment",
            prompt_version="1",
        )
        by_id = {source["source_id"]: source["text"] for source in sources}
        proposals = response.value["suggestions"]
        for proposal in proposals:
            if not proposal["evidence"] or any(
                e["source_id"] not in by_id or not e["quote"] or e["quote"] not in by_id[e["source_id"]]
                for e in proposal["evidence"]
            ):
                raise AppError("invalid_feedback_source", "The feedback proposal is not bound to its sources.", 409)
            proposal["provenance"] = response.provenance
        return self.repository.save_feedback_proposals(
            proposals, operation_id=operation_id, input_fingerprint=request_hash
        )

    def search_outcome(self, run_id):
        """Read this exact acquisition's committed outcome, including failure."""
        return self.repository.run_outcome(run_id)

    def has_acquired_linkedin_detail(self, run_id, posting):
        """Check whether the current description came from this search's targeted fetch."""
        provenance = posting["provenance"]
        return bool(
            posting["source_id"] == "jobstreaming:linkedin"
            and posting["content_state"] == "provider_detail"
            and posting["description"] and posting["description"] == posting["full_description"]
            and provenance.get("authority") == "provider"
            and provenance.get("provider") == "jobstreaming"
            and provenance.get("sourceKind") == "provider_detail"
            and provenance.get("detailMethod") == "jobstreaming.fetch_job_detail"
            and provenance.get("sourceUrl") == posting["url"]
            and self.repository.acquired_posting_revision(run_id, posting["job_id"], posting["revision"], posting["source_id"])
        )

    async def review_role_target(self, run_id, job_id, *, expected_revision=None, read_only=False):
        request = self.repository.run_request(run_id)
        if request is None or not self.repository.observed_job(run_id, job_id):
            raise AppError("discovery_run_job_missing", "This job does not belong to that search.", 404)
        plan = request["settings"].get("targetPlan")
        if not role_target_sources(plan):
            raise AppError("discovery_role_targets_missing", "This search had no frozen role targets.", 409)
        posting = self.jobs.get_job(job_id)
        if not read_only and (type(expected_revision) is not int or expected_revision != posting["revision"]):
            raise ConflictError("The saved posting changed or its expected revision was omitted.")
        binding = role_binding(run_id, posting, plan["planId"])
        reviewed = self.repository.role_review(binding)
        if reviewed is not None:
            reviewed = read_role_decision(self.model, reviewed, posting, plan)
        elif not read_only:
            def current(conn):
                self.jobs.assert_posting_current(job_id, posting["revision"], posting["source_hash"], connection=conn)

            reviewed = await match_role_targets(self.model, posting, plan, store=self.repository,
                                                owner="role-call:review:" + fingerprint(binding), guard=current)
            reviewed = self.repository.role_review(binding, decision=reviewed, guard=current)
        self.jobs.assert_posting_current(job_id, posting["revision"], posting["source_hash"])
        if read_only and reviewed is None and not posting_role_evidence(posting)["description"].strip():
            return {**binding, "decision": None, "reason": "posting_description_missing"}
        return {**binding, "decision": reviewed}

    def check_search_admission(self, run_id, payload, connection):
        if "resumeFromRunId" in payload:
            self.repository.continuation_request(payload, connection)

    def board_cooling_down(self, board):
        return self.repository.cooldown(board) > 0

    async def reserve_linkedin_detail(self, cancelled):
        """A search assessment using the public posting URL shares board pacing."""
        while not cancelled():
            slot = self.repository.reserve_board_request(None, "linkedin", LINKEDIN_REQUEST_INTERVAL_SECONDS)
            if slot["cooldown"]:
                raise AppError("posting_check_deferred_source_rate_limited",
                               "LinkedIn paused posting checks. Retry this job after the source is available.", 409)
            if not slot["pace"]:
                return
            await asyncio.sleep(min(1, slot["pace"]))
        raise asyncio.CancelledError()

    def finalize(self, run_id, status, error_code, connection):
        if status in {"cancelled","failed"}:
            self.repository.finalize_action(run_id, status, error_code, connection)

    async def search(self, context, payload, *, durable=True):
        while True:
            turn = await self.search_turn(context, payload, durable=durable)
            if turn["done"]:
                return turn["result"]
            await asyncio.sleep(max(0.0, turn["wakeAt"] - time.time()))

    async def search_turn(self, context, payload, *, durable=True, handoff=None):
        """Advance one source page or return the outstanding provider deadline."""
        run_id = context.run_id
        saved = self.repository.run_request(run_id)
        if saved:
            if saved.get("command_hash") != fingerprint(payload):
                raise ConflictError("A restarted Discovery action must retain its original command.")
            request = saved
        elif "resumeFromRunId" in payload:
            if not durable:
                raise AppError("invalid_discovery_resume", "Continue the paused search through the search action.")
            request = self.repository.continuation_request(payload)
        else:
            settings = self.get_settings()["settings"]
            # Explicit action-scoped controls are frozen with the run, never saved
            # back to the user's configuration by starting a search.
            settings = {
                **settings,
                **{
                    k: v
                    for k, v in payload.items()
                    if k in {"queries", "locations", "boards", "newJobLimit", "resultsPerSite", "hoursOld"}
                },
            }
            try:
                settings = validate_settings(settings)
                if any(board not in self.repository.boards for board in settings["boards"]):
                    raise ValueError("Unsupported JobStreaming board")
            except (ValueError, TypeError):
                raise AppError(
                    "invalid_discovery_overrides", "The action-scoped Discovery controls are invalid."
                ) from None
            if not settings["queries"] and self.profile is not None:
                expected_profile = payload.get("expectedProfileVersion")
                if expected_profile is not None and (type(expected_profile) is not int or expected_profile < 1):
                    raise AppError("invalid_profile_version", "The saved Search preferences revision is invalid.")
                target_plan = await self.targets.refresh(operation_id=context.run_id + ":query-plan", expected_profile_revision=expected_profile)
                if target_plan["accepted"] is not None and target_plan["current"]:
                    settings = {
                        **settings,
                        "queries": target_plan["accepted"]["queries"],
                        "locations": settings["locations"] or target_plan["accepted"]["locations"],
                        "targetPlan": target_plan["accepted"],
                    }
            needs_role_match = bool(role_target_sources(settings.get("targetPlan")))
            request = {
                "settings": settings,
                "sources": self.list_sources()["sources"],
                "command_hash": fingerprint(payload),
                "boardUnitsVersion": 1,
                "pageWorkflowVersion": 1,
                "sourceFetchPolicy": SOURCE_FETCH_POLICY,
                "boardQueryScheduling": FAIR_QUERY_SCHEDULING,
                "criteriaAsOf": now(),
                **({"roleTargetPolicy": ROLE_TARGET_POLICY, "roleCallCustody": ROLE_CALL_CUSTODY}
                   if needs_role_match else {}),
            }
        if request.get("roleTargetPolicy") not in {None, ROLE_TARGET_POLICY} or request.get("roleCallCustody") not in {None, ROLE_CALL_CUSTODY}:
            raise AppError("discovery_role_policy_unsupported", "This search has an unsupported frozen role policy.", 409)
        if request.get("roleTargetPolicy") and not role_target_sources(request["settings"].get("targetPlan")):
            raise AppError("discovery_role_targets_missing", "The search lost its frozen role targets.", 409)
        isolate_boards = request.get("boardUnitsVersion") == 1
        units = search_units(
            request["settings"], isolate_boards=isolate_boards,
            source_fetch_policy=request.get("sourceFetchPolicy"),
        )
        execution_settings = {**request["settings"], "_criteriaAsOf": request.get("criteriaAsOf"),
                              "_roleTargetPolicy": request.get("roleTargetPolicy"), "_roleCallCustody": request.get("roleCallCustody"),
                              "_durableRoleChecks": durable, "_assessmentHandoff": handoff}
        # Older frozen requests may contain retired feeds. Only the SDK board
        # identity can authorize acquisition when a worker resumes.
        board_states = {source["sourceId"]: source["state"] for source in request["sources"]}
        for unit in units:
            unit["sites"] = [board for board in unit["sites"] if board in self.repository.boards
                             and board_states.get("jobstreaming:" + board, "active") in {"active", "experimental"}]
        units = [unit for unit in units if unit["sites"]]
        if "resumeUnits" in request:
            units = [unit for unit in units if unit["unit_id"] in request["resumeUnits"]]
            execution_settings["_resumeUnits"] = request["resumeUnits"]
        if units and not saved and "resumeFromRunId" not in request and request.get("roleTargetPolicy"):
            # Saved-role queries are literal. Admission of new postings can
            # require a role decision, so check its accounting before reading a board.
            self.model.preflight_cost_accounting()
        lease = self.repository.claim_run(run_id, request)
        if lease["completed"]:
            return {"done": True, "result": lease["result"]}
        supported_sources = {"jobstreaming:" + board for board in self.repository.boards}
        if saved and any(source_id not in supported_sources and state in {"active", "experimental"}
                         for source_id, state in board_states.items()):
            self.repository.settle(lease, "failed", failure_code="discovery_source_retired")
            raise AppError("discovery_source_retired", "This search used a retired source. Start a new search with your selected JobStreaming boards.", 409)
        if not units:
            self.repository.settle(lease, "failed", failure_code="discovery_targets_missing")
            raise AppError("discovery_targets_missing", "Select an active JobStreaming board and supply a search query and location.", 409)
        self.execution.begin(lease)

        async def keep_alive():
            while True:
                await asyncio.sleep(15)
                if context.cancelled():
                    self.execution.stop(lease)
                    self.repository.cancel(run_id)
                    return
                self.repository.heartbeat(lease)
                context.heartbeat({"runId": run_id})

        heartbeat = asyncio.create_task(keep_alive())
        try:
            if context.cancelled():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            states = self.repository.unit_states(run_id)
            failed_boards = {board for unit in units for failure in [(states.get(unit["unit_id"], {}).get("result") or {}).get("failure", {})]
                             if failure.get("code") in {"rate_limited", "discovery_provider_rate_limited"} for board in unit["sites"]}
            ready = [unit for unit in units if states.get(unit["unit_id"], {}).get("status") not in
                     {"completed", "budget_exhausted", "failed", "deferred"} and not failed_boards.intersection(unit["sites"])]
            remaining = self.repository.budget_remaining(lease, request["settings"]["newJobLimit"])
            if ready and remaining:
                cooldowns = {site: self.repository.cooldown_deadline(site) for site in {s for u in ready for s in u["sites"]}}
                deadlines = {u["unit_id"]: max(cooldowns[site] for site in u["sites"]) for u in ready}
                clock = time.time()
                available = [u for u in ready if deadlines[u["unit_id"]] <= clock]
                if not available:
                    for unit in ready:
                        state = states.get(unit["unit_id"], {})
                        if state.get("status") != "waiting_for_source":
                            self.repository.save_unit(lease, unit, status="waiting_for_source", result=state.get("result", {}))
                    return {"done": False, "wakeAt": min(clock + 3600, min(deadlines.values()))}
                counts = self.repository.board_new_jobs_by_query(lease)
                candidate = min(available, key=lambda u: (counts.get(u["query"], 0), states.get(u["unit_id"], {}).get("updatedAt", "")))
                limits = query_allowances(dict.fromkeys(u["query"] for u in available), counts, remaining)
                turn = BoardQueryTurn(limits[candidate["query"]]) if len(limits) > 1 else None
                try:
                    await self.execution.run_board_unit(context, lease, candidate, execution_settings, states.get(candidate["unit_id"]), turn)
                except AppError as error:
                    if error.code == "action_cancelled":
                        raise
                    self.repository.record_board_failure(lease, candidate, error)
                return {"done": False, "wakeAt": 0.0}
            outcome = self.repository.finalize_bounded_units(lease, request["settings"]["newJobLimit"])
            failures = [state["result"]["failure"] for state in states.values() if state["result"].get("failure")]
            represented = {board for failure in failures for board in failure.get("boards", [])}
            failures.extend(item for item in outcome["failures"] if item["sourceId"].removeprefix("jobstreaming:") not in represented)
            status = "failed" if failures and outcome["fulfilledUnitCount"] == 0 else "partial" if failures else "completed"
            result = {**self.repository.run_summary(run_id), **self.repository.run_job_ids(run_id),
                      "ok": not failures, "status": status, "failures": failures, "postings": self.repository.posting_counts(run_id)}
            settled = self.repository.settle(
                lease, status, result, failure_code="source_family_failed" if failures else None
            )
            if settled == "cancelled":
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            if settled == "failed":
                raise AppError(
                    "discovery_sources_failed",
                    "The selected sources did not complete; accepted saved jobs are retained.",
                    502,
                    {"runId": run_id, "failures": failures},
                )
            return {"done": True, "result": {**result, "preparationAvailable": False} if handoff is None else result}
        except asyncio.CancelledError:
            # Worker shutdown leaves committed pages and pending work recoverable.
            raise
        except BaseException as error:
            code = getattr(error, "code", "discovery_failed")
            if self.repository.run_outcome(run_id) is None:
                with suppress(ConflictError):
                    self.repository.settle(lease, "cancelled" if code == "action_cancelled" else "failed", failure_code=code)
            raise
        finally:
            self.execution.stop(lease)
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat

    async def _admit(self, context, lease, unit, settings, posting, key, *, forced_exclusion=False, fetch_detail=None):
        decision = None
        unavailable = None
        excluded = forced_exclusion or (posting.get("title") or "").strip().casefold() in {
            str(x).strip().casefold() for x in settings["exactTitleExclusions"]
        }
        if not excluded and settings.get("_roleTargetPolicy") == ROLE_TARGET_POLICY:
            limit = int(settings["newJobLimit"])
            settled = self.repository.settled_intake(lease, key, limit, context.cancelled)
            if settled is not None:
                return settled
            plan = settings["targetPlan"]
            if fetch_detail is not None:
                known = self.repository.accept_posting(
                    lease, unit, posting, jobs=self.jobs, receipt_key=key, existing_only=True,
                    limit=limit, cancelled=context.cancelled,
                )
                if known is not None:
                    return known
            if not posting_role_evidence(posting)["description"].strip() and fetch_detail is not None:
                details = await fetch_detail()
                if details:
                    posting = {**posting, "description": details, "full_description": details,
                               "provenance": {**posting["provenance"], "sourceKind": "provider_detail",
                                              "detailMethod": "jobstreaming.fetch_job_detail", "sourceUrl": posting["url"]}}
            if posting_role_evidence(posting)["description"].strip():
                # A different source may have settled this receipt or filled the
                # last slot while detail or a model lane was pending.
                def guard(connection):
                    settled = self.repository.settled_intake(lease, key, limit, context.cancelled, connection)
                    if settled is not None:
                        raise _SettledIntake(settled)

                def wait_cancelled():
                    if context.cancelled():
                        return True
                    guard(None)  # Stop waiting as soon as another source fills the run.
                    return False

                owner = "role-call:intake:" + fingerprint([lease["run_id"], posting["source_id"], posting.get("source_native_id") or posting["url"]])
                wait = (wait_for_model_capacity(wait_cancelled, lane="discovery",
                            on_wait=lambda reason: self.repository.waiting_for_role_capacity(lease, unit["unit_id"], reason))
                        if settings.get("_durableRoleChecks") else nullcontext())
                try:
                    with wait:
                        decision = await match_role_targets(self.model, posting, plan, store=self.repository, owner=owner, guard=guard,
                                                            legacy_recovery=lease["epoch"] > 1 and settings.get("_roleCallCustody") is None)
                except _SettledIntake as previous:
                    return previous.outcome
                posting = {**posting, "provenance": {**posting["provenance"], "roleTargetMatch": decision}}
                excluded = decision["verdict"] != "match"
            else:
                unavailable = {"reason": "posting_description_missing", "targetPlanId": plan["planId"], "policy": ROLE_TARGET_POLICY}
                excluded = True
        return self.repository.accept_posting(
            lease,
            unit,
            posting,
            jobs=self.jobs,
            receipt_key=key,
            excluded=excluded,
            role_target_decision=decision,
            role_target_unavailable=unavailable,
            limit=int(settings["newJobLimit"]),
            cancelled=context.cancelled,
            handoff=settings.get("_assessmentHandoff"),
        )
