"""Discovery plans search and admits provider observations through public Jobs."""

from __future__ import annotations

import asyncio
import base64
from contextlib import suppress
from datetime import datetime, timedelta, timezone
import json

from jobctrl.app.errors import AppError, ConflictError
from jobctrl.features.discovery.domain import fingerprint, now, search_units, validate_settings
from jobctrl.features.discovery.remote_search import validate_remote_search_scope
from jobctrl.features.discovery.targets import TargetPlanner
from jobctrl.features.discovery.ports import DestinationPolicy, DiscoveryStore, ExecutionPort, JobsPort, ModelPort


class DiscoveryService:
    def __init__(
        self,
        repository: DiscoveryStore,
        *,
        jobs: JobsPort,
        model: ModelPort,
        execution: ExecutionPort,
        destination_policy: DestinationPolicy,
        profile=None,
    ):
        self.repository, self.jobs, self.model = repository, jobs, model
        self.profile, self.execution = profile, execution
        self.destination_policy = destination_policy
        self.targets = TargetPlanner(repository, profile, model)

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

    def upsert_source(self, data):
        return self.repository.upsert_source(data)

    def patch_source_state(self, source_id, data):
        if data.get("expectedRevision") is None:
            raise AppError(
                "expected_revision_required", "Supply the saved source revision before changing its state.", 428
            )
        return self.repository.upsert_source({**self.repository.source(source_id), **data, "sourceId": source_id})

    def digest_summary(self):
        return {"sources": self.list_sources()["sources"], "runs": self.repository.runs()["runs"]}

    def progress_summary(self, *, limit=100):
        return self.repository.progress_summary(limit=limit)

    def list_source_proposals(self):
        return self.repository.proposals()

    def reset_source_proposal(self, candidate_id):
        return self.repository.decide_proposal(candidate_id, "reset")

    async def decide_source_proposal(self, candidate_id, decision, expected_revision=None):
        if decision == "promote":
            proposal = next(
                (p for p in self.list_source_proposals()["candidates"] if p["candidateId"] == candidate_id), None
            )
            if proposal and not await self.destination_policy.is_public(proposal["candidateUrl"]):
                raise AppError("source_destination_unsafe", "The source destination is not public.", 409)
        return self.repository.decide_proposal(candidate_id, decision, expected_revision)

    async def propose_sources_from_history(self, job_id=None):
        snapshots = [self.jobs.get_job(job_id)] if job_id else self.jobs.list_job_snapshots(include_inactive=True)
        results = []
        for snapshot in snapshots:
            history = self.jobs.history(snapshot["job_id"])
            for url in dict.fromkeys(
                filter(None, (snapshot.get("url"), snapshot.get("canonical_url"), snapshot.get("application_url")))
            ):
                if not await self.destination_policy.is_public(url):
                    results.append({"jobId": snapshot["job_id"], "url": url, "status": "invalid"})
                    continue
                provenance = snapshot.get("provenance", {})
                import hashlib

                evidence = {
                    "originJobId": snapshot["job_id"],
                    "originPostingUrl": snapshot["url"],
                    "inputUrl": url,
                    "urlKind": "posting_url"
                    if url == snapshot["url"]
                    else "canonical_url"
                    if url == snapshot.get("canonical_url")
                    else "application_url",
                    "observations": [
                        {
                            "observationId": o["observation_id"],
                            "sourceId": o["source_id"],
                            "runId": o.get("run_id") or "",
                            "observedUrl": o["observed_url"],
                            "observedAt": o["observed_at"],
                        }
                        for o in history["observations"]
                    ],
                    "extraction": {
                        "tier": provenance.get("extractionTier"),
                        "enrichedAt": snapshot["observed_at"] if not snapshot.get("needs_enrichment") else None,
                        "snapshotVersion": snapshot["revision"],
                        "descriptionSha256": hashlib.sha256(snapshot["description"].encode()).hexdigest(),
                        "snapshotSha256": snapshot["source_hash"],
                        "snapshotEvidence": [json.dumps(provenance, ensure_ascii=False)[:16000]],
                    },
                    "sample": {
                        "title": snapshot["title"],
                        "company": snapshot["company"],
                        "descriptionExcerpt": snapshot["description"][:4000],
                    },
                }
                results.append(
                    {"jobId": snapshot["job_id"], "url": url, **self.repository.propose_source(url, evidence)}
                )
        return {"ok": True, "results": results}

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

    async def search(self, context, payload):
        run_id = context.run_id
        saved = self.repository.run_request(run_id)
        if saved:
            if saved.get("command_hash") != fingerprint(payload):
                raise ConflictError("A restarted Discovery action must retain its original command.")
            request = saved
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
            request = {
                "settings": settings,
                "sources": self.list_sources()["sources"],
                "command_hash": fingerprint(payload),
                "boardUnitsVersion": 1,
                "criteriaAsOf": now(),
            }
        units = search_units(request["settings"], isolate_boards=request.get("boardUnitsVersion") == 1)
        execution_settings = {**request["settings"], "_criteriaAsOf": request.get("criteriaAsOf")}
        if not units and not any(
            s["state"] in {"active", "experimental"}
            and s.get("kind") in {"ats_api", "employer_careers_page", "smart_extract"}
            for s in request["sources"]
        ):
            raise AppError(
                "discovery_targets_missing", "Save or supply explicit search queries before running Discovery.", 409
            )
        lease = self.repository.claim_run(run_id, request)
        if lease["completed"]:
            return lease["result"]
        prior_outcome = self.repository.finalize_bounded_units(lease, request["settings"]["newJobLimit"])
        prior_source_failures = {failure["sourceId"]: failure for failure in prior_outcome["failures"]}
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
        failures = []
        try:
            active_boards = {
                s.get("adapterConfig", {}).get("board")
                for s in request["sources"]
                if s["state"] in {"active", "experimental"} and s.get("kind") == "broad_board"
            }
            semaphore = asyncio.Semaphore(int(request["settings"]["maxParallelFamilies"]))

            async def run_boards():
                for unit in units:
                    if context.cancelled():
                        raise AppError("action_cancelled", "Discovery was cancelled.", 409)
                    unit["sites"] = [
                        site
                        for site in unit["sites"]
                        if site in active_boards
                        or not any(s.get("adapterConfig", {}).get("board") == site for s in request["sources"])
                    ]
                    if not unit["sites"]:
                        continue
                    previous = self.repository.unit(run_id, unit["unit_id"])
                    if previous and previous["status"] in {"completed", "budget_exhausted"}:
                        continue
                    if previous and previous["status"] == "failed" and (previous.get("result") or {}).get("failure"):
                        failure = previous["result"]["failure"]
                        failures.append(failure)
                        for board in unit["sites"]:
                            self.repository.source_result(lease, "jobstreaming:" + board, "failed", error_code=failure["code"])
                        continue
                    # Recover recorded outcomes before the capacity gate. A
                    # worker restart after the final accepted job must retain
                    # failures even though no acquisition budget remains.
                    if not self.repository.budget_remaining(lease, request["settings"]["newJobLimit"]):
                        continue
                    try:
                        await self.execution.run_board_unit(context, lease, unit, execution_settings, previous)
                    except AppError as error:
                        if error.code == "action_cancelled":
                            raise
                        failure = {"sourceFamily": "broad_boards", "unitId": unit["unit_id"], "boards": unit["sites"], "code": error.code, "message": error.message}
                        self.repository.save_unit(lease, unit, status="failed", result={"failure": failure})
                        failures.append(failure)
                        for board in unit["sites"]:
                            self.repository.source_result(
                                lease, "jobstreaming:" + board, "failed", error_code=error.code
                            )

            async def run_sources(kinds):
                for source in request["sources"]:
                    if source["state"] not in {"active", "experimental"} or source.get("kind") not in kinds:
                        continue
                    if context.cancelled():
                        raise AppError("action_cancelled", "Discovery was cancelled.", 409)
                    if source["sourceId"] in prior_source_failures:
                        failures.append(prior_source_failures[source["sourceId"]])
                        continue
                    if not self.repository.budget_remaining(lease, request["settings"]["newJobLimit"]):
                        return
                    if not payload.get("forceSources") and not self._source_due(source):
                        continue
                    try:
                        await self.execution.run_registered_source(context, lease, source, request["settings"])
                    except AppError as error:
                        if error.code == "action_cancelled":
                            raise
                        failures.append({"sourceId": source["sourceId"], "code": error.code})
                        self.repository.source_result(lease, source["sourceId"], "failed", error_code=error.code)

            async def family(callback):
                async with semaphore:
                    await callback()

            await asyncio.gather(
                family(run_boards),
                family(lambda: run_sources({"ats_api"})),
                family(lambda: run_sources({"employer_careers_page", "smart_extract"})),
            )
            run = next(r for r in self.repository.runs()["runs"] if r["runId"] == run_id)
            outcome = self.repository.finalize_bounded_units(lease, request["settings"]["newJobLimit"])
            represented = {
                source_id
                for failure in failures
                for source_id in ([failure["sourceId"]] if failure.get("sourceId") else ["jobstreaming:" + board for board in failure.get("boards", [])])
            }
            failures.extend(failure for failure in outcome["failures"] if failure["sourceId"] not in represented)
            status = "failed" if failures and outcome["fulfilledUnitCount"] == 0 else "partial" if failures else "completed"
            result = {
                "ok": not failures,
                **run,
                **self.repository.run_job_ids(run_id),
                "status": status,
                "failures": failures,
            }
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
            return result
        except BaseException as error:
            code = getattr(error, "code", "discovery_failed")
            with suppress(ConflictError):
                self.repository.settle(
                    lease, "cancelled" if code == "action_cancelled" else "failed", failure_code=code
                )
            raise
        finally:
            self.execution.stop(lease)
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat

    def _admit(self, context, lease, unit, settings, posting, key, *, forced_exclusion=False):
        excluded = forced_exclusion or (posting.get("title") or "").strip().casefold() in {
            str(x).strip().casefold() for x in settings["exactTitleExclusions"]
        }
        return self.repository.accept_posting(
            lease,
            unit,
            posting,
            jobs=self.jobs,
            receipt_key=key,
            excluded=excluded,
            limit=int(settings["newJobLimit"]),
            cancelled=context.cancelled,
        )

    @staticmethod
    def _source_due(source):
        last = source.get("lastRunCompletedAt")
        if not last:
            return True
        try:
            observed = datetime.fromisoformat(last)
            if observed.tzinfo is None:
                observed = observed.replace(tzinfo=timezone.utc)
            failures = int(source.get("consecutiveFailures") or 0)
            minutes = (
                min(360, 15 * 2 ** min(5, failures - 1))
                if failures
                else int((source.get("adapterConfig") or {}).get("cadenceMinutes", 360))
            )
            return observed + timedelta(minutes=max(1, minutes)) <= datetime.now(timezone.utc)
        except (TypeError, ValueError, OverflowError):
            raise AppError("source_schedule_invalid", "The recorded source schedule requires review.", 409) from None
