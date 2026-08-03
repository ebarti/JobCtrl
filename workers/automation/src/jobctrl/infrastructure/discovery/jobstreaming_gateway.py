"""Anti-corruption adapter for the JobStreaming provider contract.

JobCtrl owns search planning, durable acceptance, limits, and orchestration.
JobStreaming owns board concurrency, board cursors, and replay-safe event
delivery.  This module is the only place where those provider event and model
types are translated into the DataFrame shape used by the legacy discovery
storage path.  Later durability phases can therefore consume the same typed
stream without teaching the domain layer about provider classes.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from typing import Any

import pandas as pd
from jobstreaming import (
    AckMode,
    AdapterRegistry,
    CheckpointStore,
    Scraper,
    ErrorEvent,
    JobEvent,
    ProgressEvent,
    SearchCompleteEvent,
    SearchRequest,
    SearchStream,
    Site,
    SiteCompleteEvent,
    WarningEvent,
    build_search_request,
    default_registry,
    stream_search,
)
from jobstreaming.result import jobs_to_dataframe


@dataclass(frozen=True, slots=True)
class JobStreamingSearchSpec:
    """Immutable JobCtrl search input translated to one provider request."""

    sites: tuple[str, ...]
    query: str
    location: str
    results_per_site: int
    hours_old: int | None = None
    remote_only: bool = False
    country_indeed: str = "usa"
    linkedin_fetch_description: bool = False

    def __post_init__(self) -> None:
        if not self.sites:
            raise ValueError("sites must contain at least one board")
        if not self.query.strip():
            raise ValueError("query must be non-empty")
        if not self.location.strip():
            raise ValueError("location must be non-empty")
        if self.results_per_site < 1:
            raise ValueError("results_per_site must be positive")

    @classmethod
    def from_legacy_options(cls, options: dict[str, Any]) -> JobStreamingSearchSpec:
        """Translate the previous ``scrape_jobs`` keyword surface exactly."""

        raw_sites = options.get("site_name")
        if isinstance(raw_sites, str):
            sites = (raw_sites,)
        else:
            sites = tuple(str(site) for site in (raw_sites or ()))
        return cls(
            sites=sites,
            query=str(options.get("search_term") or ""),
            location=str(options.get("location") or ""),
            results_per_site=int(options.get("results_wanted") or 0),
            hours_old=(int(options["hours_old"]) if options.get("hours_old") is not None else None),
            remote_only=bool(options.get("is_remote", False)),
            country_indeed=str(options.get("country_indeed") or "usa"),
            linkedin_fetch_description=bool(options.get("linkedin_fetch_description", False)),
        )


@dataclass(frozen=True, slots=True)
class JobStreamingFailure:
    """Provider failure projected into stable JobCtrl-owned fields."""

    site: str
    code: str
    error_type: str
    message: str
    retryable: bool
    reset_checkpoint: bool


@dataclass(frozen=True)
class JobStreamingBatch:
    """Collected compatibility result plus typed provider outcomes."""

    frame: pd.DataFrame
    failures: tuple[JobStreamingFailure, ...]
    warnings: tuple[str, ...]
    completed: bool


class JobStreamingSearchError(RuntimeError):
    """Raised when every selected board fails without yielding a posting."""

    def __init__(self, failure: JobStreamingFailure) -> None:
        self.failure = failure
        super().__init__(f"{failure.site} failed [{failure.code}]: {failure.error_type}: {failure.message}")


_TLS_CLIENT_SITES = frozenset({Site.GLASSDOOR, Site.ZIP_RECRUITER})


class _IntegralTlsTimeoutAdapter(Scraper):
    """Normalize JobStreaming 0.0.2's float timeout for tls-client adapters."""

    def __init__(self, delegate: Scraper) -> None:
        super().__init__(
            delegate.site,
            proxies=delegate.proxies,
            ca_cert=delegate.ca_cert,
            user_agent=delegate.user_agent,
        )
        self._delegate = delegate
        self.capabilities = delegate.capabilities

    def scrape(
        self,
        scraper_input: SearchRequest,
        context: Any | None = None,
    ) -> Any:
        timeout = max(1, math.ceil(scraper_input.request_timeout))
        normalized = scraper_input.model_copy(
            update={"request_timeout": timeout},
        )
        return self._delegate.scrape(normalized, context=context)


def _normalize_tls_adapter_timeouts(
    registry: AdapterRegistry | None,
) -> AdapterRegistry:
    """Keep the pinned provider fingerprint while satisfying tls-client's int ABI."""

    source = registry or default_registry()
    normalized = source.copy()
    for site in _TLS_CLIENT_SITES:
        if site not in source.sites:
            continue

        def factory(*, _site: Site = site, **kwargs: Any) -> Scraper:
            return _IntegralTlsTimeoutAdapter(source.create(_site, **kwargs))

        normalized.register(
            site,
            factory,
            replace=True,
            cursor_schema_version=source.cursor_schema_version(site),
        )
    return normalized


class JobStreamingGateway:
    """Build and consume the pinned JobStreaming 0.0.2 event contract."""

    @staticmethod
    def build_request(spec: JobStreamingSearchSpec) -> SearchRequest:
        return build_search_request(
            site_name=list(spec.sites),
            search_term=spec.query,
            location=spec.location,
            results_wanted=spec.results_per_site,
            hours_old=spec.hours_old,
            is_remote=spec.remote_only,
            country_indeed=spec.country_indeed,
            description_format="markdown",
            linkedin_fetch_description=spec.linkedin_fetch_description,
        )

    def open_stream(
        self,
        spec: JobStreamingSearchSpec,
        *,
        proxies: list[str] | str | None = None,
        user_agent: str | None = None,
        checkpoint_store: CheckpointStore | None = None,
        resume: bool = True,
        max_retries: int = 2,
        retry_backoff: float = 5.0,
        cancel_event: threading.Event | None = None,
        registry: AdapterRegistry | None = None,
    ) -> SearchStream:
        """Open an explicit-ack stream without consuming any event.

        Durable callers must persist each event before calling ``ack``. Keeping
        that decision outside this adapter prevents a provider checkpoint from
        outrunning JobCtrl's durable write.
        """

        return stream_search(
            self.build_request(spec),
            proxies=proxies,
            user_agent=user_agent,
            checkpoint_store=checkpoint_store,
            resume=resume,
            max_retries=max_retries,
            retry_backoff=retry_backoff,
            ack_mode=AckMode.EXPLICIT,
            cancel_event=cancel_event,
            registry=_normalize_tls_adapter_timeouts(registry),
        )

    @classmethod
    def frame_for_job_event(
        cls,
        event: JobEvent,
        spec: JobStreamingSearchSpec,
    ) -> pd.DataFrame:
        """Project one provider event into the legacy storage frame.

        The stable provider key travels with the row so replayed deliveries use
        the same JobCtrl idempotency keys even when the Temporal activity run
        and its operational discovery run id have changed.
        """

        frame = jobs_to_dataframe(
            [(event.site, event.job)],
            cls.build_request(spec),
        )
        frame["jobstreaming_job_key"] = event.job_key
        return frame

    def collect(
        self,
        spec: JobStreamingSearchSpec,
        *,
        proxies: list[str] | str | None = None,
        user_agent: str | None = None,
        max_retries: int = 2,
        retry_backoff: float = 5.0,
        cancel_event: threading.Event | None = None,
        registry: AdapterRegistry | None = None,
    ) -> JobStreamingBatch:
        """Collect a stream for the compatibility storage path.

        This compatibility collector deliberately has no durable checkpoint
        parameter: its in-memory frame is not a durable consumer. Explicit
        acknowledgement still exercises the provider contract, while a killed
        batch simply starts over instead of skipping an unstored event.
        """

        request = self.build_request(spec)
        jobs = []
        failures: list[JobStreamingFailure] = []
        warnings: list[str] = []
        completed = False
        with self.open_stream(
            spec,
            proxies=proxies,
            user_agent=user_agent,
            resume=False,
            max_retries=max_retries,
            retry_backoff=retry_backoff,
            cancel_event=cancel_event,
            registry=registry,
        ) as stream:
            for event in stream:
                if isinstance(event, JobEvent):
                    jobs.append((event.site, event.job))
                elif isinstance(event, ErrorEvent):
                    failures.append(
                        JobStreamingFailure(
                            site=event.site.value,
                            code=event.code.value,
                            error_type=event.error_type,
                            message=event.message,
                            retryable=event.retryable,
                            reset_checkpoint=event.reset_checkpoint,
                        )
                    )
                elif isinstance(event, WarningEvent):
                    warnings.append(f"{event.site.value}: {event.message}")
                elif isinstance(event, SearchCompleteEvent):
                    completed = event.completed
                elif isinstance(event, (ProgressEvent, SiteCompleteEvent)):
                    pass
                stream.ack(event)

        return JobStreamingBatch(
            frame=jobs_to_dataframe(jobs, request),
            failures=tuple(failures),
            warnings=tuple(warnings),
            completed=completed,
        )


def scrape_legacy_options(
    options: dict[str, Any],
    *,
    max_retries: int = 2,
    retry_backoff: float = 5.0,
    user_agent: str | None = None,
) -> JobStreamingBatch:
    """Compatibility shim used while persistence moves to per-event writes."""

    spec = JobStreamingSearchSpec.from_legacy_options(options)
    batch = JobStreamingGateway().collect(
        spec,
        proxies=options.get("proxies"),
        user_agent=user_agent,
        max_retries=max_retries,
        retry_backoff=retry_backoff,
    )
    failed_sites = {failure.site for failure in batch.failures}
    if batch.frame.empty and failed_sites.issuperset(spec.sites):
        raise JobStreamingSearchError(batch.failures[0])
    return batch
