"""JobStreaming search execution, checkpoints and durable admission."""

from __future__ import annotations

import asyncio

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
from jobctrl.features.discovery.adapters.checkpoints import ProviderCheckpointStore

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
        self.repository = repository
        self.lease = lease
        self.stop = stop
        self.started = monotonic()
        self.counts = {"listing": 0, "detail": 0, "other": 0}
        self.limited = False
        self.advertised = False

    def send(self, unit_id, send_request, request, *args, **kwargs):
        from jobstreaming.exception import RateLimitError, StreamCancelledError
        while not self.stop.is_set():
            slot = self.repository.reserve_board_request(self.lease, "linkedin", LINKEDIN_REQUEST_INTERVAL_SECONDS)
            if slot["cooldown"] > 0:
                self.limited = True
                self.advertised = True
                raise RateLimitError("The source is cooling down.", retry_after=slot["cooldown"])
            if not slot["pace"]:
                response = send_request(request, *args, **kwargs)
                self.observe(unit_id, response)
                return response
            self.stop.wait(slot["pace"])
        raise StreamCancelledError("Discovery stopped.")

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
        delay = _retry_after_seconds(response.headers.get("Retry-After"), received)
        self.limited = True
        self.advertised = delay is not None
        self.repository.record_rate_limit_response(self.lease, {
            "board": "linkedin", "unitId": unit_id, "phase": phase, "httpStatus": 429,
            "leaseEpoch": self.lease["epoch"], "responses": dict(self.counts), "elapsedMs": elapsed_ms,
            "receivedAt": received.isoformat(timespec="milliseconds"), "retryAfterSeconds": delay,
        })


class DiscoveryExecutionAdapter:
    def __init__(self, repository, *, jobs, workspace):
        self.repository, self.jobs = repository, jobs
        self.workspace = Path(workspace)
        self._signals = {}
        self._admit = None

    def bind_admission(self, admission):
        self._admit = admission

    def begin(self, lease):
        key = (lease["run_id"], lease["epoch"])
        self._signals[key] = threading.Event()

    def stop(self, lease):
        key = (lease["run_id"], lease["epoch"])
        signal = self._signals.pop(key, None)
        if signal is not None:
            signal.set()

    async def run_board_unit(self, context, lease, unit, settings, previous, turn=None):
        """Receive at most one SDK page and drain its saved listings before advancing."""
        from jobstreaming.exception import JobStreamingError
        from jobctrl.features.discovery.adapters.jobstreaming import JobStreamingGateway, JobStreamingSearchSpec
        from jobctrl.features.discovery.adapters.synthetic_jobstreaming import controlled_registry

        spec = JobStreamingSearchSpec(**{k: tuple(v) if k == "sites" else v for k, v in unit.items()
                                         if k not in {"unit_id", "cursor", "source_family", "source_id"}})
        validate_remote_search_scope(spec.sites, location=spec.location, remote_only=spec.remote_only, hours_old=spec.hours_old)
        if not settings.get("_criteriaAsOf") and any(
            provider_scope(site, location=spec.location, remote_only=spec.remote_only, hours_old=spec.hours_old)["localAgeCheck"]
            for site in spec.sites
        ):
            raise AppError("discovery_criteria_reference_missing", "Restart this search to bind its posting-age reference.", 409)
        key = lease["run_id"], lease["epoch"]
        stop = self._signals[key]
        gateway = JobStreamingGateway()
        registry = controlled_registry(self.workspace)
        linkedin = None
        if "linkedin" in spec.sites:
            linkedin = _LinkedInRequests(self.repository, lease, stop)
            registry = gateway.configure_linkedin_transport(registry, partial(linkedin.send, unit["unit_id"]))
        recorded = dict((previous or {}).get("result") or {})
        pending = self.repository.pending_postings(lease, unit)
        try:
            if not pending and not recorded.get("sourceTerminations"):
                self.repository.save_unit(lease, unit, status="running", result=recorded)
                await asyncio.to_thread(self._receive_page, context, lease, unit, spec, registry, gateway, stop, recorded)
                pending = self.repository.pending_postings(lease, unit)
            for receipt_key, listing, detail in pending:
                if context.cancelled():
                    raise AppError("action_cancelled", "Discovery was cancelled.", 409)
                result = await self._process_listing(context, lease, unit, settings, spec, gateway, registry, receipt_key, listing, detail)
                if result["budget_reached"]:
                    self.repository.save_unit(lease, unit, status="budget_exhausted", result={**recorded, "termination": "budget_exhaustion"})
                    return
                if turn and turn.record(result):
                    self.repository.save_unit(lease, unit, status="waiting_for_query_turn", result=recorded)
                    return True
        except JobStreamingError as error:
            if context.cancelled() or stop.is_set():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409) from None
            if error.code.value != "rate_limited":
                raise AppError("discovery_provider_" + error.code.value, "The search source could not complete the request.", 502) from None
            board = unit["sites"][0]
            if linkedin and linkedin.limited:
                advertised = linkedin.advertised
            else:
                advertised = error.retry_after is not None
                self.repository.record_rate_limit_response(lease, {"board": board, "unitId": unit["unit_id"],
                    "phase": "acquisition", "retryAfterSeconds": error.retry_after, "leaseEpoch": lease["epoch"]})
            if advertised:
                self.repository.save_unit(lease, unit, status="waiting_for_source", result=recorded)
                return True
            raise board_rate_limit_error() from None
        reasons = recorded.get("sourceTerminations", {})
        if reasons:
            for site, reason in reasons.items():
                if spec.results_per_site is None and reason != "source_exhausted":
                    raise AppError("discovery_provider_" + reason, "The source stopped before confirmed exhaustion.", 502)
                self.repository.source_result(lease, "jobstreaming:" + site, "completed")
                self.repository.source_recovered(lease, site)
            self.repository.save_unit(lease, unit, status="completed", result=recorded)
            return
        self.repository.save_unit(lease, unit, status="page_received", result=recorded)
        return True

    def _receive_page(self, context, lease, unit, spec, registry, gateway, stop, recorded):
        from jobstreaming import ErrorEvent, JobEvent, ProgressEvent, SearchCompleteEvent, SiteCompleteEvent
        from jobstreaming.exception import RateLimitError

        store = ProviderCheckpointStore(self.repository, lease, unit["unit_id"])
        page_reviewed = threading.Event()
        with gateway.open_stream(spec, checkpoint_store=store, cancel_event=stop, registry=registry,
                                 page_accepted=page_reviewed, max_retries=0) as stream:
            def acknowledge(connection):
                with store.writing(connection):
                    stream.ack(event)

            for event in stream:
                if context.cancelled():
                    raise AppError("action_cancelled", "Discovery was cancelled.", 409)
                self.repository.heartbeat(lease)
                if isinstance(event, JobEvent):
                    site = event.site.value
                    receipt = "jobstreaming:" + fingerprint([lease["run_id"], unit["unit_id"], site, event.job_key])
                    listing = {"job": event.job.model_dump(mode="json"), "site": site, "key": event.job_key,
                               "emittedAt": event.emitted_at.isoformat()}
                    self.repository.record_listing(lease, unit, receipt, site, event.job_key, listing, acknowledge)
                    continue
                if isinstance(event, ErrorEvent):
                    if event.reset_checkpoint:
                        raise AppError("discovery_checkpoint_incompatible", "The provider requires an explicit cursor reset.", 409)
                    if event.code.value == "rate_limited":
                        # An error can carry the cursor for a prefetched page. Keep
                        # the last acknowledged page, including its pending jobs.
                        raise RateLimitError("A search source requested a cooldown.", retry_after=event.retry_after)
                    if event.code.value == "authentication_configuration":
                        raise board_access_error(event)
                    raise AppError("discovery_provider_" + event.code.value, "The source could not complete its search.", 502)
                if isinstance(event, SiteCompleteEvent):
                    reason = event.reason.value if event.reason else "unknown"
                    recorded.setdefault("sourceTerminations", {})[event.site.value] = reason
                    recorded["termination"] = reason
                    with self.repository.database.transaction() as conn:
                        self.repository.save_unit(lease, unit, status="page_received", result=recorded, connection=conn)
                        acknowledge(conn)
                    continue
                if isinstance(event, ProgressEvent):
                    with self.repository.database.transaction() as conn:
                        self.repository.save_unit(lease, unit, status="page_received", result=recorded, connection=conn)
                        acknowledge(conn)
                    if event.progress.has_more is not False:
                        return
                    page_reviewed.set()
                    continue
                stream.ack(event)
                if isinstance(event, SearchCompleteEvent) and event.completed:
                    return
            raise AppError("discovery_provider_incomplete", "The provider search has not completed.", 502)

    async def _process_listing(self, context, lease, unit, settings, spec, gateway, registry, key, listing, cached):
        from jobstreaming import JobEvent, Site

        event = JobEvent(sequence=0, emitted_at=datetime.fromisoformat(listing["emittedAt"]), site=Site(listing["site"]),
                         job=gateway.restore_posting(listing["job"]), job_key=listing["key"], resume_state={})
        row = gateway.frame_for_job_event(event, spec).iloc[0].to_dict()
        def text(field):
            value = row.get(field)
            return str(value) if value is not None and str(value).lower() not in {"nan","none","<na>"} else ""
        posting = {"url": text("job_url"), "title": text("title"), "company": text("company"),
                   "description": text("description"), "location": text("location"),
                   "salary": " ".join(filter(None, (text("min_amount"), text("max_amount"), text("currency"), text("interval")))),
                   "application_url": text("job_url_direct"), "source_id": "jobstreaming:" + listing["site"],
                   "source_native_id": event.job_key, "observed_at": listing["emittedAt"],
                   "provenance": {"authority": "provider", "provider": "jobstreaming", "sourceKind": "search_result", "jobKey": event.job_key}}
        scope = provider_scope(listing["site"], location=spec.location, remote_only=spec.remote_only, hours_old=spec.hours_old)
        age = None
        if scope["localAgeCheck"]:
            age = posting_age_evidence(listing["site"], event.job.date_posted, hours_old=spec.hours_old, reference=settings["_criteriaAsOf"])
            posting["provenance"].update(postingAge=age, providerHoursOld=scope["hours_old"])

        async def fetch_detail():
            if cached is not None:
                return cached.get("description")
            detail = await asyncio.to_thread(gateway.fetch_detail_for_job_event, event, registry=registry)
            description = detail.description if detail and detail.job_url == event.job.job_url else None
            self.repository.save_posting_detail(lease, key, {"description": description})
            return description

        check_role = listing["site"] == "linkedin" and settings.get("_roleTargetPolicy") == ROLE_TARGET_POLICY
        if not check_role and (age is None or age["accepted"]) and not posting["description"] and self._needs_detail(posting):
            posting["description"] = await fetch_detail() or ""
        return await self._admit(context, lease, unit, settings, posting, key, forced_exclusion=age is not None and not age["accepted"],
                                 fetch_detail=fetch_detail if check_role else None)

    def _needs_detail(self, posting):
        return any(
            job["title"].strip() == posting["title"].strip()
            and job["company"].strip() == posting["company"].strip()
            and job["description"]
            for job in self.jobs.list_job_snapshots(include_inactive=True)
        )
