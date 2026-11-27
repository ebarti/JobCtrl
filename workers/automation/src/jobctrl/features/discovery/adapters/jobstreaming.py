"""Anti-corruption adapter for the JobStreaming provider contract.

JobCtrl owns search planning, durable acceptance, limits, and orchestration.
JobStreaming owns board concurrency, board cursors, and replay-safe event
delivery.  This module is the only place where those provider event and model
types are translated into the DataFrame shape used by the feature-owned ingestion path.  Later durability phases can therefore consume the same typed
stream without teaching the domain layer about provider classes.
"""

from __future__ import annotations

import math
import threading
from contextvars import ContextVar
from dataclasses import dataclass
from functools import partial
from typing import Any

import pandas as pd
from jobstreaming import (
    AckMode,
    AdapterRegistry,
    CheckpointStore,
    Scraper,
    InvalidRequestError,
    JobEvent,
    JobPost,
    SearchFilter,
    SearchRequest,
    SearchStream,
    Site,
    build_search_request,
    default_registry,
    fetch_job_detail,
    stream_search,
)

from jobstreaming.batch import jobs_to_dataframe

from jobctrl.app.errors import AppError
from jobctrl.features.discovery.remote_search import RemoteSearchConfigurationError as RemoteSearchConfigurationError
from jobctrl.features.discovery.remote_search import provider_scope, validate_remote_search_scope


detail_job_key: ContextVar[str | None] = ContextVar("discovery_detail_job_key", default=None)


def supported_boards() -> tuple[str, ...]:
    return tuple(site.value for site in default_registry().sites)


@dataclass(frozen=True, slots=True)
class JobStreamingSearchSpec:
    """Immutable JobCtrl search input translated to one provider request."""

    sites: tuple[str, ...]
    query: str
    location: str
    results_per_site: int | None
    hours_old: int | None = None
    remote_only: bool = False
    country_indeed: str = "usa"
    linkedin_fetch_description: bool = False

    def __post_init__(self) -> None:
        if not self.sites:
            raise ValueError("sites must contain at least one board")
        if not self.query.strip():
            raise ValueError("query must be non-empty")
        if not isinstance(self.location, str) or (
            not self.location.strip() and not (self.location == "" and self.remote_only)
        ):
            raise ValueError("location must be non-empty unless remote-only")
        if self.results_per_site is not None and self.results_per_site < 1:
            raise ValueError("results_per_site must be positive")


_TLS_CLIENT_SITES = frozenset({Site.GLASSDOOR, Site.ZIP_RECRUITER})


class UnsupportedRemoteSearch(InvalidRequestError):
    """A board cannot apply the selected Remote search scope exactly."""


class _ReviewedPageContext:
    """Let the board advance only after the consumer commits the current page."""

    def __init__(self, context: Any, page_accepted: threading.Event) -> None:
        self._context = context
        self._page_accepted = page_accepted

    def __getattr__(self, name: str) -> Any:
        return getattr(self._context, name)

    def emit_progress(self, *args: Any, **kwargs: Any) -> None:
        self._page_accepted.clear()
        self._context.emit_progress(*args, **kwargs)
        while not self._context.cancelled:
            if self._page_accepted.wait(0.1):
                return


class _RemoteScopeAdapter:
    """Check the actual adapter before it can issue a broadened request."""

    def __init__(self, delegate: Any, page_accepted: threading.Event | None = None) -> None:
        self._delegate = delegate
        self._page_accepted = page_accepted
        self.site = delegate.site
        self.capabilities = delegate.capabilities

    def scrape(self, scraper_input: SearchRequest, context: Any | None = None) -> Any:
        scope = provider_scope(
            self.site.value, location=scraper_input.location or "",
            remote_only=scraper_input.is_remote, hours_old=scraper_input.hours_old,
        )
        required = {SearchFilter.IS_REMOTE} if scraper_input.is_remote else set()
        if scope["location"]:
            required.add(SearchFilter.LOCATION)
        if scope["hours_old"]:
            required.add(SearchFilter.HOURS_OLD)
        if not required.issubset(self.capabilities.filters):
            raise UnsupportedRemoteSearch("The board cannot apply the selected search filters.")
        normalized = scraper_input.model_copy(update={"hours_old": scope["hours_old"]})
        if context is not None and self._page_accepted is not None:
            context = _ReviewedPageContext(context, self._page_accepted)
        return self._delegate.scrape(normalized, context=context)

    def close(self) -> None:
        close = getattr(self._delegate, "close", None)
        if callable(close):
            close()


def _remote_safe_registry(
    spec: JobStreamingSearchSpec, registry: AdapterRegistry | None,
    page_accepted: threading.Event | None,
) -> AdapterRegistry:
    """Retain unsupported boards as failures instead of broadening a search."""
    normalized = _normalize_tls_adapter_timeouts(registry)
    guarded = normalized.copy()
    registered = {site.value for site in normalized.sites}
    for site in spec.sites:
        if site not in registered:
            continue
        cursor_version = normalized.cursor_schema_version(site)

        def guarded_factory(*, _site: str = site, **kwargs: Any) -> _RemoteScopeAdapter:
            return _RemoteScopeAdapter(
                normalized.create(_site, **kwargs),
                page_accepted,
            )

        # The provider's public cursor-version contract must remain unchanged
        # for existing checkpoints. Version 1 is the registry default.
        options = {"cursor_schema_version": cursor_version} if cursor_version != 1 else {}
        guarded.register(site, guarded_factory, replace=True, **options)
    return guarded


def _apply_provider_filter_evidence(
    frame: pd.DataFrame,
    spec: JobStreamingSearchSpec,
) -> pd.DataFrame:
    """Preserve provider-owned facts that listing text cannot reconstruct.

    LinkedIn applies its remote-only request as a provider filter. Its listing
    card can still contain only a country/region, and JobStreaming otherwise
    derives ``is_remote`` from the title, location, and optional description.
    When description fetching is disabled, treating that derived false as
    stronger than the provider-filter result would drop valid remote listings.
    """

    if frame.empty or not spec.remote_only or "site" not in frame.columns:
        return frame
    linkedin_rows = frame["site"].astype(str).str.casefold().eq(Site.LINKEDIN.value)
    if not linkedin_rows.any():
        return frame
    projected = frame.copy()
    projected.loc[linkedin_rows, "is_remote"] = True
    return projected


class _IntegralTlsTimeoutAdapter(Scraper):
    """Normalize the provider timeout for tls-client adapters that require ints."""

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

    def close(self) -> None:
        self._delegate.close()


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
        )
    return normalized


class JobStreamingGateway:
    """Build and consume the pinned JobStreaming event contract."""

    @staticmethod
    def configure_transport(registry, site, requests):
        """Preserve SDK-owned sessions and observe unmodified response deadlines."""
        source = registry or default_registry()
        if site not in {adapter.value for adapter in source.sites}:
            return source
        observed = source.copy()

        def factory(**kwargs):
            adapter = source.create(site, **kwargs)
            # Some SDK adapters sleep between pages inside one stream. A resumed
            # page still honors the longest configured native interval.
            requests.interval = max(requests.interval, getattr(adapter, "delay", 0) + getattr(adapter, "band_delay", 0))
            installed = set()

            def observe(session):
                transports = tuple(session.adapters.values()) if hasattr(session, "adapters") else (session,)
                for transport in transports:
                    if id(transport) in installed:
                        continue
                    method = "send" if hasattr(transport, "send") else "execute_request"
                    if hasattr(transport, method):
                        setattr(transport, method, partial(requests.send, getattr(transport, method)))
                        installed.add(id(transport))
                return session

            if getattr(adapter, "session", None) is not None:
                observe(adapter.session)
            register = adapter.track_transport
            adapter.track_transport = lambda session: observe(register(session))
            return adapter

        cursor_version = source.cursor_schema_version(site)
        options = {"cursor_schema_version": cursor_version} if cursor_version != 1 else {}
        observed.register(site, factory, replace=True, **options)
        return observed

    @staticmethod
    def build_request(spec: JobStreamingSearchSpec) -> SearchRequest:
        if spec.results_per_site is None:
            try:
                from jobstreaming import SiteTerminationReason  # noqa: F401

                SearchRequest(site_type=spec.sites, results_wanted=None)
            except (ImportError, ValueError, TypeError):
                raise AppError(
                    "discovery_source_policy_unsupported",
                    "This search requires JobStreaming with uncapped results and typed source termination. Update the worker dependency before retrying.",
                    503,
                ) from None
        request = build_search_request(
            site_name=list(spec.sites),
            search_term=spec.query,
            location=spec.location or None,
            results_wanted=spec.results_per_site,
            hours_old=spec.hours_old,
            is_remote=spec.remote_only,
            country_indeed=spec.country_indeed,
            description_format="markdown",
            linkedin_fetch_description=spec.linkedin_fetch_description,
        )
        if spec.results_per_site is None and request.results_wanted is not None:
            raise AppError("discovery_source_policy_unsupported", "The provider cannot retain the automatic source fetch policy.", 503)
        return request

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
        page_accepted: threading.Event | None = None,
    ) -> SearchStream:
        """Open an explicit-ack stream without consuming any event.

        Durable callers must persist each event before calling ``ack``. Keeping
        that decision outside this adapter prevents a provider checkpoint from
        outrunning JobCtrl's durable write.
        """

        validate_remote_search_scope(
            spec.sites,
            location=spec.location,
            remote_only=spec.remote_only,
            hours_old=spec.hours_old,
        )
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
            registry=_remote_safe_registry(spec, registry, page_accepted),
        )

    @staticmethod
    def restore_posting(stored: dict) -> JobPost:
        # These SDK enums have tuple-valued members. JSON encodes them as arrays
        # and the pinned SDK requires their exact tuple values for validation.
        posting = dict(stored)
        location = posting.get("location")
        if location and isinstance(location.get("country"), list):
            posting["location"] = {**location, "country": tuple(location["country"])}
        if posting.get("job_type"):
            posting["job_type"] = [tuple(item) if isinstance(item, list) else item for item in posting["job_type"]]
        return JobPost.model_validate(posting)

    @classmethod
    def frame_for_job_event(
        cls,
        event: JobEvent,
        spec: JobStreamingSearchSpec,
        *,
        job: JobPost | None = None,
    ) -> pd.DataFrame:
        """Project one provider event into the provider-neutral ingestion frame.

        The stable provider key travels with the row so replayed deliveries use
        the same JobCtrl idempotency keys even when the Temporal activity run
        and its operational discovery run id have changed.
        """

        frame = _apply_provider_filter_evidence(
            jobs_to_dataframe(
                [(event.site, job or event.job)],
                cls.build_request(spec),
            ),
            spec,
        )
        frame["jobstreaming_job_key"] = event.job_key
        return frame

    @staticmethod
    def fetch_detail_for_job_event(
        event: JobEvent,
        *,
        proxies: list[str] | str | None = None,
        user_agent: str | None = None,
        request_timeout: float = 30,
        registry: AdapterRegistry | None = None,
    ) -> JobPost | None:
        """Fetch detail for one known provider event without starting a search.

        JobCtrl owns the selective decision. JobStreaming owns the provider
        transport and returns the same immutable posting with any available
        detail attached. The original event key remains the durable
        acknowledgement identity when the caller reprojects the result.
        """

        token = detail_job_key.set(event.job_key)
        try:
            return fetch_job_detail(
                event.site,
                event.job,
                proxies=proxies,
                user_agent=user_agent,
                description_format="markdown",
                request_timeout=request_timeout,
                registry=_normalize_tls_adapter_timeouts(registry),
            )
        finally:
            detail_job_key.reset(token)
