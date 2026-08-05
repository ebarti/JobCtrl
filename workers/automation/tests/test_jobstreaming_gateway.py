from __future__ import annotations

import pandas as pd
from jobstreaming import (
    AdapterCapabilities,
    AdapterRegistry,
    JobPost,
    JobEvent,
    JobResponse,
    MemoryCheckpointStore,
    RateLimitError,
    Scraper,
    Site,
)

from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
    JobStreamingBatch,
    JobStreamingFailure,
    JobStreamingGateway,
    JobStreamingSearchSpec,
    scrape_legacy_options,
)


class _PostingAdapter(Scraper):
    capabilities = AdapterCapabilities(filters=frozenset({"location", "is_remote"}))

    def __init__(self, **_: object) -> None:
        super().__init__(Site.INDEED)

    def scrape(self, request, context=None) -> JobResponse:
        assert context is not None
        context.emit_job(
            JobPost(
                id="indeed-1",
                title="Director of Engineering",
                company_name="Example",
                job_url="https://example.test/jobs/1",
                description="A sufficiently detailed role description.",
                is_remote=True,
            ),
            {"page": 2},
        )
        return JobResponse()


class _RateLimitedAdapter(Scraper):
    def __init__(self, **_: object) -> None:
        super().__init__(Site.LINKEDIN)

    def scrape(self, request, context=None) -> JobResponse:
        raise RateLimitError("slow down")


class _TlsTimeoutInspectingAdapter(Scraper):
    seen_timeouts: list[object] = []

    def __init__(self, **_: object) -> None:
        super().__init__(Site.GLASSDOOR)

    def scrape(self, request, context=None) -> JobResponse:
        del context
        type(self).seen_timeouts.append(request.request_timeout)
        if not isinstance(request.request_timeout, int):
            raise ValueError("TLS timeout must be an integer")
        return JobResponse()


def test_request_translation_is_immutable_and_preserves_search_options() -> None:
    spec = JobStreamingSearchSpec(
        sites=("indeed", "linkedin"),
        query="Director of Engineering",
        location="Barcelona, Spain",
        results_per_site=37,
        hours_old=48,
        remote_only=True,
        country_indeed="spain",
        linkedin_fetch_description=True,
    )

    request = JobStreamingGateway.build_request(spec)

    assert tuple(site.value for site in request.sites) == ("indeed", "linkedin")
    assert request.search_term == "Director of Engineering"
    assert request.location == "Barcelona, Spain"
    assert request.results_wanted == 37
    assert request.hours_old == 48
    assert request.is_remote is True
    assert request.country.value[0] == "spain"
    assert request.linkedin_fetch_description is True
    assert request.fingerprint() == JobStreamingGateway.build_request(spec).fingerprint()


def test_collect_preserves_partial_results_and_projects_typed_failure() -> None:
    registry = AdapterRegistry()
    registry.register(Site.INDEED, _PostingAdapter)
    registry.register(Site.LINKEDIN, _RateLimitedAdapter)
    result = JobStreamingGateway().collect(
        JobStreamingSearchSpec(
            sites=("indeed", "linkedin"),
            query="Director of Engineering",
            location="Remote",
            results_per_site=10,
            remote_only=True,
        ),
        registry=registry,
        max_retries=0,
    )

    assert result.frame[["site", "title", "company"]].to_dict("records") == [
        {
            "site": "indeed",
            "title": "Director of Engineering",
            "company": "Example",
        }
    ]
    assert len(result.failures) == 1
    assert result.failures[0].site == "linkedin"
    assert result.failures[0].code == "rate_limited"
    assert result.failures[0].retryable is True
    assert result.completed is False


def test_tls_backed_adapters_receive_an_integral_request_timeout() -> None:
    _TlsTimeoutInspectingAdapter.seen_timeouts = []
    registry = AdapterRegistry()
    registry.register(Site.GLASSDOOR, _TlsTimeoutInspectingAdapter)

    result = JobStreamingGateway().collect(
        JobStreamingSearchSpec(
            sites=("glassdoor",),
            query="Director of Engineering",
            location="Remote",
            results_per_site=10,
            remote_only=True,
        ),
        registry=registry,
        max_retries=0,
    )

    assert [
        (type(timeout), timeout)
        for timeout in _TlsTimeoutInspectingAdapter.seen_timeouts
    ] == [(int, 30)]
    assert result.failures == ()
    assert result.completed is True


def test_durable_stream_does_not_checkpoint_until_the_consumer_acknowledges() -> None:
    registry = AdapterRegistry()
    registry.register(Site.INDEED, _PostingAdapter)
    checkpoint_store = MemoryCheckpointStore()
    gateway = JobStreamingGateway()
    spec = JobStreamingSearchSpec(
        sites=("indeed",),
        query="Director of Engineering",
        location="Remote",
        results_per_site=10,
    )

    first_stream = gateway.open_stream(
        spec,
        checkpoint_store=checkpoint_store,
        registry=registry,
    )
    first = next(first_stream)
    assert isinstance(first, JobEvent)
    first_stream.close()

    checkpoint = checkpoint_store.load()
    assert checkpoint is not None
    assert checkpoint.revision == 0
    assert checkpoint.adapters["indeed"].seen_job_keys == ()

    with gateway.open_stream(
        spec,
        checkpoint_store=checkpoint_store,
        registry=registry,
    ) as resumed:
        replayed = next(resumed)
        assert isinstance(replayed, JobEvent)
        assert replayed.job.id == first.job.id
        resumed.ack(replayed)


def test_job_event_projection_preserves_the_provider_idempotency_key() -> None:
    registry = AdapterRegistry()
    registry.register(Site.INDEED, _PostingAdapter)
    gateway = JobStreamingGateway()
    spec = JobStreamingSearchSpec(
        sites=("indeed",),
        query="Director of Engineering",
        location="Remote",
        results_per_site=10,
    )

    with gateway.open_stream(spec, registry=registry, resume=False) as stream:
        event = next(stream)
        assert isinstance(event, JobEvent)
        frame = gateway.frame_for_job_event(event, spec)

    assert frame.loc[0, "job_url"] == "https://example.test/jobs/1"
    assert frame.loc[0, "jobstreaming_job_key"] == event.job_key


def test_proxy_and_user_agent_reach_the_provider_constructor() -> None:
    seen: dict[str, object] = {}

    class InspectingAdapter(_PostingAdapter):
        def __init__(self, **kwargs: object) -> None:
            seen.update(kwargs)
            super().__init__()

    registry = AdapterRegistry()
    registry.register(Site.INDEED, InspectingAdapter)

    JobStreamingGateway().collect(
        JobStreamingSearchSpec(
            sites=("indeed",),
            query="Director of Engineering",
            location="Remote",
            results_per_site=10,
        ),
        proxies=["http://proxy.test:8080"],
        user_agent="JobCtrl/test",
        registry=registry,
    )

    assert seen["proxies"] == ["http://proxy.test:8080"]
    assert seen["user_agent"] == "JobCtrl/test"


def test_compatibility_shim_keeps_empty_success_when_only_one_board_failed(
    monkeypatch,
) -> None:
    partial_empty = JobStreamingBatch(
        frame=pd.DataFrame(),
        failures=(
            JobStreamingFailure(
                site="linkedin",
                code="rate_limited",
                error_type="RateLimitError",
                message="slow down",
                retryable=True,
                reset_checkpoint=False,
            ),
        ),
        warnings=(),
        completed=False,
    )
    monkeypatch.setattr(
        JobStreamingGateway,
        "collect",
        lambda *_args, **_kwargs: partial_empty,
    )

    result = scrape_legacy_options(
        {
            "site_name": ["indeed", "linkedin"],
            "search_term": "Director of Engineering",
            "location": "Remote",
            "results_wanted": 10,
        }
    )

    assert result is partial_empty
