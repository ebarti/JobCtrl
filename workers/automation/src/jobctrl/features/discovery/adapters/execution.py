"""JobStreaming search execution, checkpoints and durable admission."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from concurrent.futures import CancelledError
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from functools import partial
from math import ceil
from pathlib import Path
import threading
from time import monotonic
from urllib.parse import urlsplit

from jobctrl.app.errors import AppError
from jobctrl.features.discovery.adapters.board_diagnostics import board_access_error, board_rate_limit_error
from jobctrl.features.discovery.domain import fingerprint
from jobctrl.features.discovery.qualification import ROLE_TARGET_POLICY
from jobctrl.features.discovery.remote_search import posting_age_evidence, provider_scope, validate_remote_search_scope
from jobctrl.network.rate_limiter import HostRateLimiter

logger = logging.getLogger(__name__)
LINKEDIN_REQUEST_INTERVAL_SECONDS = 4.0


def _retry_after_seconds(value, received_at):
    if not value or len(value) > 128:
        return None
    value = value.strip()
    if value.isascii() and value.isdecimal():
        return int(value)
    try:
        retry_at = parsedate_to_datetime(value)
        if retry_at.tzinfo is not None:
            return max(0, ceil((retry_at - received_at).total_seconds()))
    except (TypeError, ValueError, OverflowError):
        pass
    return None


class _LinkedInRequests:
    def __init__(self, repository, lease, stop):
        from jobstreaming.exception import MAX_RETRY_AFTER_SECONDS

        self.repository = repository
        self.lease = lease
        self.stop = stop
        self.started = monotonic()
        self.pacing = HostRateLimiter(max_retry_after_seconds=MAX_RETRY_AFTER_SECONDS)
        self.deferred = threading.Event()
        self.counts = {"listing": 0, "detail": 0, "other": 0}

    def fetch_detail(self, fetch):
        from jobstreaming.exception import RateLimitError

        # The SDK retries listing pages. Its separate targeted detail operation
        # returns the first typed error. Replay that read under the same limiter.
        for attempt in range(3):
            try:
                return fetch()
            except RateLimitError as error:
                if self.deferred.is_set() or attempt == 2 or error.retry_after is None or error.retry_after > self.pacing.max_retry_after_seconds:
                    raise

    def send(self, unit_id, send_request, request, *args, **kwargs):
        from jobstreaming.exception import RateLimitError, StreamCancelledError

        def deferred_error():
            error = RateLimitError("LinkedIn deferred this search.")
            # The workspace owns continuation of this cursor, outside the SDK retry loop.
            error.retryable = False
            return error

        if self.deferred.is_set():
            raise deferred_error()
        try:
            with self.pacing.slot("linkedin", min_interval_seconds=LINKEDIN_REQUEST_INTERVAL_SECONDS,
                                  max_concurrency=1, cancel_event=self.stop):
                if self.deferred.is_set():
                    raise deferred_error()
                response = send_request(request, *args, **kwargs)
                self.observe(unit_id, response)
                if response.status_code == 429:
                    retry_after = _retry_after_seconds(response.headers.get("Retry-After"), datetime.now(timezone.utc))
                    # The SDK caps long Retry-After values before classifying them.
                    # Preserve the original deadline and release the worker to assess saved jobs.
                    if retry_after is None or retry_after > self.pacing.max_retry_after_seconds:
                        self.deferred.set()
                        response.close()
                        raise deferred_error()
                    self.pacing.note_retry_after("linkedin", retry_after)
                return response
        except CancelledError:
            raise StreamCancelledError("Discovery stopped.") from None

    def observe(self, unit_id, response):
        # Only the endpoint category leaves the transport.
        path = urlsplit(response.url).path
        if path.endswith("/jobs-guest/jobs/api/seeMoreJobPostings/search"):
            phase = "listing"
        elif "/jobs/view/" in path:
            phase = "detail"
        else:
            phase = "other"
        received = datetime.now(timezone.utc) if response.status_code == 429 else None
        self.counts[phase] += 1
        if received is None:
            return
        elapsed_ms = round((monotonic() - self.started) * 1000)
        try:
            self.repository.record_rate_limit_response(self.lease, {
                "board": "linkedin", "unitId": unit_id, "phase": phase, "httpStatus": 429,
                "leaseEpoch": self.lease["epoch"], "responses": dict(self.counts), "elapsedMs": elapsed_ms,
                "receivedAt": received.isoformat(timespec="milliseconds"),
                "retryAfterSeconds": _retry_after_seconds(response.headers.get("Retry-After"), received),
            })
        except (AppError, sqlite3.Error):
            # Observability must not replace the provider's response or retry policy.
            logger.warning("Could not record a LinkedIn rate-limit response")


class DiscoveryExecutionAdapter:
    def __init__(self, repository, *, jobs, workspace):
        self.repository, self.jobs = repository, jobs
        self.workspace = Path(workspace)
        self._signals = {}
        self._linkedin_requests = {}
        self._admit = None

    def bind_admission(self, admission):
        self._admit = admission

    def begin(self, lease):
        key = (lease["run_id"], lease["epoch"])
        self._signals[key] = threading.Event()

    def stop(self, lease):
        key = (lease["run_id"], lease["epoch"])
        self._linkedin_requests.pop(key, None)
        signal = self._signals.pop(key, None)
        if signal is not None:
            signal.set()

    def _exhaust_budget(self, lease):
        key = (lease["run_id"], lease["epoch"])
        self._signals[key].set()

    def _budget_unit(self, lease, unit, *, cursor=None):
        recorded = self.repository.unit(lease["run_id"], unit["unit_id"])
        self.repository.save_unit(
            lease, unit, status="budget_exhausted", cursor=cursor,
            result={**((recorded or {}).get("result") or {}), "termination": "budget_exhaustion"},
        )

    def _checkpoint_path(self, run_id, unit_id):
        base = self.workspace / "discovery-checkpoints"
        directory = base / fingerprint(run_id)
        path = directory / (unit_id + ".sqlite3")
        if base.is_symlink() or directory.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(self.workspace.resolve()):
            raise AppError("discovery_checkpoint_path_unsafe", "The provider checkpoint is outside this workspace.", 409)
        return path

    async def run_board_unit(self, context, lease, unit, settings, previous, turn=None):
        # Validate unsupported scope per board before touching its provider.
        for site in unit["sites"]:
            provider_scope(site, location=unit["location"], remote_only=unit["remote_only"], hours_old=unit["hours_old"])
        key = (lease["run_id"], lease["epoch"])
        stop = self._signals[key]
        from jobstreaming import ErrorEvent, JobEvent, ProgressEvent, SearchCompleteEvent, SiteCompleteEvent
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
        checkpoint_path = self._checkpoint_path(lease["run_id"], unit["unit_id"])
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        store = SqliteCheckpointStore(checkpoint_path)
        parent = settings.get("_resumeUnits", {}).get(unit["unit_id"])
        if parent and store.load() is None:
            source = self._checkpoint_path(parent, unit["unit_id"])
            last = SqliteCheckpointStore(source).load() if source.is_file() else None
            if last is None:
                raise AppError("discovery_resume_checkpoint_missing", "The saved LinkedIn search position is unavailable.", 409)
            # Each continuation owns a fresh store. Keep its parent's exact
            # provider cursor and all acknowledged job keys, including exclusions.
            store.save(last.model_copy(update={"revision": 0}))
        recorded = (previous or {}).get("result") or {}
        if spec.results_per_site is None:
            for reason in recorded.get("sourceTerminations", {}).values():
                if reason != "source_exhausted":
                    raise AppError("discovery_provider_" + reason, "The source stopped before confirmed exhaustion; start a new search to retry.", 502)
        self.repository.save_unit(lease, unit, status="running", result=recorded)
        loop = asyncio.get_running_loop()
        linkedin = None
        if "linkedin" in spec.sites:
            if key not in self._linkedin_requests:
                self._linkedin_requests[key] = _LinkedInRequests(self.repository, lease, stop)
            linkedin = self._linkedin_requests[key]

        def consume():
            from jobctrl.features.discovery.adapters.synthetic_jobstreaming import controlled_registry

            gateway = JobStreamingGateway()
            registry = controlled_registry(self.workspace)
            page_accepted = None
            if linkedin is not None:
                registry = gateway.configure_linkedin_transport(registry, partial(linkedin.send, unit["unit_id"]))
                if settings.get("_roleTargetPolicy") == ROLE_TARGET_POLICY:
                    page_accepted = threading.Event()
            terminations = dict(recorded.get("sourceTerminations", {}))
            with gateway.open_stream(
                spec, checkpoint_store=store, cancel_event=stop, registry=registry,
                linkedin_page_accepted=page_accepted,
            ) as stream:
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
                        # Saved-role admission obtains detail only after the
                        # receipt, exclusion and existing-posting checks.
                        needs_role_detail = event.site.value == "linkedin" and settings.get("_roleTargetPolicy") == ROLE_TARGET_POLICY
                        targeted_detail = partial(gateway.fetch_detail_for_job_event, event, registry=registry)
                        if event.site.value == "linkedin" and linkedin is not None:
                            targeted_detail = partial(linkedin.fetch_detail, targeted_detail)
                        if not needs_role_detail and (age is None or age["accepted"]) and not posting["description"] and self._needs_detail(posting):
                            detail = targeted_detail()
                            if detail is not None:
                                detail_row = gateway.frame_for_job_event(event, spec, job=detail).iloc[0].to_dict()
                                posting["description"] = str(detail_row.get("description") or "")
                        async def fetch_role_detail():
                            detail = await asyncio.to_thread(targeted_detail)
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
                    if page_accepted is not None and isinstance(event, ProgressEvent) and event.site.value == "linkedin":
                        page_accepted.set()
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
