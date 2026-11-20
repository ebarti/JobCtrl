"""Concrete search-provider/browser execution behind Discovery application ports."""

from __future__ import annotations

import asyncio
from pathlib import Path
import threading

from jobctrl.app.errors import AppError
from jobctrl.features.discovery.adapters.board_diagnostics import board_access_error, board_rate_limit_error
from jobctrl.features.discovery.domain import fingerprint
from jobctrl.features.discovery.qualification import ROLE_TARGET_POLICY
from jobctrl.features.discovery.remote_search import posting_age_evidence, provider_scope, validate_remote_search_scope


class _AcquisitionContext:
    """Stop provider work at capacity without cancelling the user's action."""

    def __init__(self, context, stop):
        self._context, self._stop = context, stop

    def __getattr__(self, name):
        return getattr(self._context, name)

    def cancelled(self):
        return self._stop.is_set() or self._context.cancelled()


class DiscoveryExecutionAdapter:
    def __init__(self, repository, *, jobs, model, workspace, browser_port=None, http_provider=None):
        self.repository, self.jobs, self.model = repository, jobs, model
        self.workspace, self.browser_port, self.http_provider = Path(workspace), browser_port, http_provider
        self._signals = {}
        self._budgets = {}
        self._admit = None

    def bind_admission(self, admission):
        self._admit = admission

    def begin(self, lease):
        key = (lease["run_id"], lease["epoch"])
        self._signals[key] = threading.Event()
        self._budgets[key] = (asyncio.get_running_loop(), asyncio.Event())

    def stop(self, lease):
        key = (lease["run_id"], lease["epoch"])
        signal = self._signals.pop(key, None)
        self._budgets.pop(key, None)
        if signal is not None:
            signal.set()

    def _exhaust_budget(self, lease):
        key = (lease["run_id"], lease["epoch"])
        signal, budget = self._signals.get(key), self._budgets.get(key)
        if signal is not None:
            signal.set()
        if budget is not None:
            loop, exhausted = budget
            loop.call_soon_threadsafe(exhausted.set)

    def _budget_unit(self, lease, unit, *, cursor=None):
        recorded = self.repository.unit(lease["run_id"], unit["unit_id"])
        self.repository.save_unit(
            lease, unit, status="budget_exhausted", cursor=cursor,
            result={**((recorded or {}).get("result") or {}), "termination": "budget_exhaustion"},
        )

    async def _until_budget(self, lease, work):
        task = asyncio.create_task(work)
        exhausted = asyncio.create_task(self._budgets[(lease["run_id"], lease["epoch"])][1].wait())
        try:
            done, _ = await asyncio.wait({task, exhausted}, return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return await task
            return False
        finally:
            for pending in (task, exhausted):
                if not pending.done():
                    pending.cancel()
            await asyncio.gather(task, exhausted, return_exceptions=True)

    async def run_board_unit(self, context, lease, unit, settings, previous, turn=None):
        # Validate unsupported scope per board before touching its provider.
        for site in unit["sites"]:
            provider_scope(site, location=unit["location"], remote_only=unit["remote_only"], hours_old=unit["hours_old"])
        if self.http_provider is not None:
            return await self._until_budget(lease, self._http_unit(context, lease, unit, settings, previous, turn))
        return await self._stream_unit(context, lease, unit, settings, self._signals[(lease["run_id"], lease["epoch"])], turn)

    async def run_registered_source(self, context, lease, source, settings):
        try:
            return await self._until_budget(lease, self._registered_source(context, lease, source, settings))
        except AppError as error:
            if error.code == "action_cancelled" and not context.cancelled() and not self.repository.budget_remaining(lease, settings["newJobLimit"]):
                return False
            raise

    async def _http_unit(self, context, lease, unit, settings, previous, turn):
        provider = self.http_provider
        cursor = previous["data"].get("cursor") if previous else None
        progress = (previous or {}).get("result") or {}
        self.repository.save_unit(lease, unit, status="running", cursor=cursor, result=progress)
        for page_index in range(progress.get("pagesCompleted", 0), 1000):
            self.repository.heartbeat(lease)
            page = await provider.fetch_page(unit, cursor=cursor, run_id=lease["run_id"])
            turn_filled = False
            for index, row in enumerate(page.jobs):
                posting = row.model_dump(exclude={"job_key"})
                posting["provenance"] = {
                    "authority": "provider",
                    "provider": "http",
                    "sourceKind": "search_result",
                    "jobKey": row.job_key,
                }
                outcome = await self._admit(
                    context,
                    lease,
                    unit,
                    settings,
                    posting,
                    "http:" + fingerprint([lease["run_id"], unit["unit_id"], row.job_key]),
                )
                if outcome["budget_reached"]:
                    self._budget_unit(lease, unit, cursor=cursor)
                    self._exhaust_budget(lease)
                    return
                turn_filled = turn is not None and turn.record(outcome)
                if turn_filled and index + 1 < len(page.jobs):
                    # Resume this partial page. Previously committed job keys
                    # replay without another admission or a second quota charge.
                    self.repository.save_unit(lease, unit, status="waiting_for_query_turn", cursor=cursor, result=progress)
                    return True
            # A page cursor advances only after every included receipt committed.
            if turn is not None or "pagesCompleted" in progress:
                progress = {"pagesCompleted": page_index + 1}
            status = "completed" if page.complete else "running"
            if turn_filled and not page.complete and page_index + 1 < 1000:
                status = "waiting_for_query_turn"
            self.repository.save_unit(lease, unit, status=status, cursor=page.cursor, result=progress)
            if page.complete:
                return
            if status == "waiting_for_query_turn":
                return True
            cursor = page.cursor
        raise AppError("discovery_provider_page_limit", "The provider exceeded the bounded page limit.", 502)

    async def _stream_unit(self, context, lease, unit, settings, stop, turn):
        from jobstreaming import ErrorEvent, JobEvent, SearchCompleteEvent, SiteCompleteEvent
        from jobstreaming.checkpoint import SqliteCheckpointStore
        from jobctrl.features.discovery.adapters.jobstreaming import JobStreamingGateway, JobStreamingSearchSpec

        spec = JobStreamingSearchSpec(
            **{
                k: tuple(v) if k == "sites" else v
                for k, v in unit.items()
                if k not in {"unit_id", "cursor", "source_family", "source_id"}
            }
        )
        validate_remote_search_scope(
            spec.sites, location=spec.location, remote_only=spec.remote_only, hours_old=spec.hours_old
        )
        if not settings.get("_criteriaAsOf") and any(
            provider_scope(site, location=spec.location, remote_only=spec.remote_only, hours_old=spec.hours_old)["localAgeCheck"]
            for site in spec.sites
        ):
            raise AppError("discovery_criteria_reference_missing", "Restart this older search to bind its posting-age reference.", 409)
        directory = self.workspace / "discovery-checkpoints" / fingerprint(lease["run_id"])
        if (
            (self.workspace / "discovery-checkpoints").is_symlink()
            or directory.is_symlink()
            or not directory.resolve().is_relative_to(self.workspace.resolve())
        ):
            raise AppError(
                "discovery_checkpoint_path_unsafe", "The provider checkpoint path is not owned by this workspace.", 409
            )
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        checkpoint_path = directory / (unit["unit_id"] + ".sqlite3")
        if checkpoint_path.is_symlink():
            raise AppError(
                "discovery_checkpoint_path_unsafe", "The provider checkpoint file is not owned by this workspace.", 409
            )
        store = SqliteCheckpointStore(checkpoint_path)
        previous = self.repository.unit(lease["run_id"], unit["unit_id"])
        recorded = (previous or {}).get("result") or {}
        if spec.results_per_site is None:
            for reason in recorded.get("sourceTerminations", {}).values():
                if reason != "source_exhausted":
                    raise AppError("discovery_provider_" + reason, "The source stopped before confirmed exhaustion; start a new search to retry.", 502)
        self.repository.save_unit(lease, unit, status="running", result=recorded)
        loop = asyncio.get_running_loop()

        def consume():
            from jobctrl.features.discovery.adapters.synthetic_jobstreaming import controlled_registry

            gateway = JobStreamingGateway()
            registry = controlled_registry(self.workspace)
            terminations = dict(recorded.get("sourceTerminations", {}))
            with gateway.open_stream(spec, checkpoint_store=store, cancel_event=stop, registry=registry) as stream:
                completed = False
                for event in stream:
                    self.repository.heartbeat(lease)
                    if context.cancelled():
                        stop.set()
                        raise AppError("action_cancelled", "Discovery was cancelled.", 409)
                    if isinstance(event, JobEvent):
                        row = gateway.frame_for_job_event(event, spec).iloc[0].to_dict()

                        def text(key):
                            value = row.get(key)
                            return (
                                str(value)
                                if value is not None and str(value).lower() not in {"nan", "none", "<na>"}
                                else ""
                            )

                        posting = {
                            "url": text("job_url"),
                            "title": text("title"),
                            "company": text("company"),
                            "description": text("description"),
                            "location": text("location"),
                            "salary": " ".join(
                                filter(
                                    None, (text("min_amount"), text("max_amount"), text("currency"), text("interval"))
                                )
                            ),
                            "application_url": text("job_url_direct"),
                            "source_id": "jobstreaming:" + event.site.value,
                            "source_native_id": event.job_key,
                            "observed_at": event.emitted_at.isoformat(),
                            "provenance": {
                                "authority": "provider",
                                "provider": "jobstreaming",
                                "sourceKind": "search_result",
                                "jobKey": event.job_key,
                            },
                        }
                        scope = provider_scope(event.site.value, location=spec.location, remote_only=spec.remote_only, hours_old=spec.hours_old)
                        age = None
                        if scope["localAgeCheck"]:
                            if not settings.get("_criteriaAsOf"):
                                raise AppError("discovery_criteria_reference_missing", "Restart this older search to bind its posting-age reference.", 409)
                            age = posting_age_evidence(event.site.value, event.job.date_posted, hours_old=spec.hours_old, reference=settings["_criteriaAsOf"])
                            posting["provenance"]["postingAge"] = age
                            posting["provenance"]["providerHoursOld"] = scope["hours_old"]
                        # A saved-role check obtains missing LinkedIn detail after
                        # its receipt and exclusion fences, before Jobs identity.
                        needs_role_detail = event.site.value == "linkedin" and settings.get("_roleTargetPolicy") == ROLE_TARGET_POLICY
                        if not needs_role_detail and (age is None or age["accepted"]) and not posting["description"] and self._needs_detail(posting):
                            detail = gateway.fetch_detail_for_job_event(event, registry=registry)
                            if detail is not None:
                                detail_row = gateway.frame_for_job_event(event, spec, job=detail).iloc[0].to_dict()
                                posting["description"] = str(detail_row.get("description") or "")
                        async def fetch_role_detail():
                            detail = await asyncio.to_thread(gateway.fetch_detail_for_job_event, event, registry=registry)
                            if detail is not None and detail.job_url == event.job.job_url:
                                return detail.description
                            return None

                        check = self._admit(
                            context,
                            lease,
                            unit,
                            settings,
                            posting,
                            "jobstreaming:"
                            + fingerprint([lease["run_id"], unit["unit_id"], event.site.value, event.job_key]),
                            forced_exclusion=age is not None and not age["accepted"],
                            fetch_detail=fetch_role_detail if needs_role_detail else None,
                        )
                        outcome = asyncio.run_coroutine_threadsafe(check, loop).result()
                        if outcome["budget_reached"]:
                            # A rejected extra emission has no receipt and must
                            # not be acknowledged. The quota-filling event does.
                            if outcome["outcome"] != "budget_exhausted":
                                stream.ack(event)
                            self._budget_unit(lease, unit)
                            self._exhaust_budget(lease)
                            return
                        if turn is not None and turn.record(outcome):
                            stream.ack(event)
                            self.repository.save_unit(lease, unit, status="waiting_for_query_turn", result=recorded)
                            return True
                    elif isinstance(event, ErrorEvent):
                        if event.code.value in {"authentication_configuration", "rate_limited"} and not event.reset_checkpoint:
                            error = board_rate_limit_error() if event.code.value == "rate_limited" else board_access_error(event)
                            self.repository.record_board_failure(lease, unit, error, board=event.site.value)
                            stream.ack(event)
                            raise error
                        self.repository.source_result(
                            lease, "jobstreaming:" + event.site.value, "failed", error_code=event.code.value
                        )
                        if event.reset_checkpoint:
                            raise AppError(
                                "discovery_checkpoint_incompatible",
                                "The provider checkpoint requires explicit reset.",
                                409,
                            )
                        # The SDK emits ErrorEvent after its bounded retries are
                        # exhausted. Persist/ack this board's failure, then allow
                        # the owner to continue the other independently keyed units.
                        stream.ack(event)
                        raise AppError("discovery_provider_" + event.code.value,
                                       "The source could not complete its search; review its connection before retrying.", 502)
                    elif isinstance(event, SiteCompleteEvent):
                        reason = getattr(event, "reason", None)
                        value = reason.value if reason is not None else None
                        if spec.results_per_site is None:
                            from jobstreaming import SiteTerminationReason

                            if not isinstance(reason, SiteTerminationReason):
                                raise AppError("discovery_source_policy_unsupported", "The provider did not report a typed source termination.", 502)
                        terminations[event.site.value] = value or "legacy_completion"
                        self.repository.save_unit(
                            lease, unit, status="running", result={"sourceTerminations": terminations, "termination": value or "legacy_completion"},
                        )
                        # Completion metadata is durable before its checkpoint.
                        stream.ack(event)
                        if spec.results_per_site is None and value != "source_exhausted":
                            raise AppError("discovery_provider_" + value, "The source stopped at its safety limit or without confirmed exhaustion; accepted jobs are retained.", 502)
                        continue
                    elif isinstance(event, SearchCompleteEvent):
                        completed = event.completed
                    # Jobs/filtered receipts committed before provider ack.
                    stream.ack(event)
                if not completed:
                    raise AppError("discovery_provider_incomplete", "The provider search has not completed.", 502)
                if spec.results_per_site is None and any(terminations.get(site) != "source_exhausted" for site in spec.sites):
                    raise AppError("discovery_provider_termination_missing", "The source completion has no recorded exhaustion reason.", 502)
                self.repository.save_unit(lease, unit, status="completed", result={"sourceTerminations": terminations, "termination": "source_exhausted" if spec.results_per_site is None else "legacy_completion"})
                for site in spec.sites:
                    self.repository.source_result(lease, "jobstreaming:" + site, "completed")

        try:
            return await asyncio.to_thread(consume)
        except Exception as error:
            from jobstreaming.exception import JobStreamingError, StreamCancelledError

            if context.cancelled():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409) from None
            if isinstance(error, StreamCancelledError):
                if not self.repository.budget_remaining(lease, settings["newJobLimit"]):
                    self._budget_unit(lease, unit)
                    return
                raise AppError("action_cancelled", "Discovery was cancelled.", 409) from None
            if isinstance(error, JobStreamingError):
                if error.code.value == "rate_limited":
                    raise board_rate_limit_error() from None
                raise AppError("discovery_provider_" + error.code.value, "A search provider could not complete its request.", 502) from None
            raise

    def _needs_detail(self, posting):
        return any(
            job["title"].strip() == posting["title"].strip()
            and job["company"].strip() == posting["company"].strip()
            and job["description"]
            for job in self.jobs.list_job_snapshots(include_inactive=True)
        )

    async def _registered_source(self, context, lease, source, settings):
        from jobctrl.features.discovery.adapters.registered import configured_session
        from jobctrl.network.policy import ATS_API_POLICY, ENRICHMENT_CRAWL_POLICY

        config = source.get("adapterConfig") or {}
        queries = [
            q
            for q in settings.get("queries", [])
            if not isinstance(q, dict)
            or not q.get("source_scope")
            or set(q["source_scope"]).intersection(
                {
                    source["sourceId"],
                    source["sourceId"].split(":", 1)[0],
                    "workday" if source.get("kind") == "ats_api" else "smartextract",
                    "smart_extract",
                }
            )
        ]
        if settings.get("queries") and not queries:
            return False
        session = configured_session(
            source, settings, policy=ATS_API_POLICY if source.get("kind") == "ats_api" else ENRICHMENT_CRAWL_POLICY
        )
        search_template = source.get("seedUrl") or config.get("url") or ""
        if source.get("kind") != "ats_api" and (
            config.get("query_mode") == "search_only" or "{query" in search_template or "{location" in search_template
        ):
            variants = [
                {**settings, "queries": [query], "locations": [location]}
                for query in queries
                for location in settings.get("locations") or []
            ]
        else:
            variants = [{**settings, "queries": queries}]
        if len(variants) > 1000:
            raise AppError("discovery_search_unit_limit", "The source exceeds the bounded search-unit limit.")
        completed = False
        for variant in variants:
            if not self.repository.budget_remaining(lease, settings["newJobLimit"]):
                return completed
            completed = await self._registered_source_unit(context, lease, source, variant, session) or completed
        return completed

    async def _registered_source_unit(self, context, lease, source, settings, session):
        from jobctrl.features.discovery.adapters.registered import acquire_registered_source

        unit = {
            "unit_id": "source:"
            + fingerprint([source["sourceId"], source["revision"], settings.get("queries"), settings.get("locations")]),
            "source_id": source["sourceId"],
            "source_family": "ats_api" if source.get("kind") == "ats_api" else "smart_extract",
        }
        previous = self.repository.unit(lease["run_id"], unit["unit_id"])
        if previous and previous["status"] in {"completed", "budget_exhausted"}:
            return True
        self.repository.save_unit(lease, unit, status="running")
        postings = await acquire_registered_source(
            source,
            settings=settings,
            context=_AcquisitionContext(context, self._signals[(lease["run_id"], lease["epoch"])]),
            jobs=self.jobs,
            model=self.model,
            browser_port=self.browser_port,
            session=session,
            capture_required=self.repository.require_capture,
        )
        for posting in postings:
            if posting.pop("quarantine", False):
                self.jobs.quarantine_posting(posting)
                continue
            key = "registered:" + fingerprint(
                [lease["run_id"], source["sourceId"], posting.get("source_native_id") or posting["url"]]
            )
            if source.get("kind") != "ats_api":
                from jobctrl.features.discovery.qualification import qualify_posting

                qualification, receipt = await qualify_posting(self.model, posting, settings.get("locations") or [])
                posting["provenance"]["discoveryQualification"] = {
                    "value": qualification.model_dump(),
                    "provenance": receipt,
                }
                if (
                    not posting.get("company")
                    or qualification.specific_role != "yes"
                    or qualification.location_match != "match"
                ):
                    if qualification.location_match != "mismatch":
                        self.repository.require_capture(
                            posting["url"],
                            source_id=source["sourceId"],
                            reason="ambiguous_career_system",
                            retry_context={"qualification": qualification.model_dump(), "provenance": receipt},
                        )
                    outcome = await self._admit(context, lease, unit, settings, posting, key, forced_exclusion=True)
                    if outcome["budget_reached"]:
                        self._budget_unit(lease, unit)
                        self._exhaust_budget(lease)
                        return True
                    continue
            outcome = await self._admit(context, lease, unit, settings, posting, key)
            if outcome["budget_reached"]:
                self._budget_unit(lease, unit)
                self._exhaust_budget(lease)
                return True
        self.repository.save_unit(lease, unit, status="completed")
        self.repository.source_result(lease, source["sourceId"], "completed")
        return True
