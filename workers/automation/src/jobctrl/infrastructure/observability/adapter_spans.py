"""OpenTelemetry spans for Discovery adapters, canonicalisation, and dedupe.

These mirror the §"Observability" table in
`docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md` so PR 4 can
aggregate per-source quality without additional plumbing.

Three context managers are exposed:

* :func:`adapter_fetch_span` — wraps a single
  ``JobBoardScraperPort.scrape`` call so each adapter run is observable
  with ``run.id``, ``source.id``, ``adapter.kind``, and result counts.
* :func:`canonicalize_span` — wraps the canonical-identity decision
  per posting so Operations can chart canonical URL coverage and ATS
  recognition rates.
* :func:`dedupe_span` — wraps the Discovery write-boundary identity
  dedupe so Operations sees per-stage dedupe outcomes (``new``,
  ``observed``, ``duplicate_linked``, ``duplicate_rejected``).
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode


@contextmanager
def adapter_fetch_span(
    *,
    tenant_id: str,
    run_id: str,
    source_id: str,
    adapter_kind: str,
    page_count: int = 0,
    result_count: int = 0,
    error_class: str | None = None,
    scope_name: str = "jobctrl.discovery.adapters",
) -> Iterator[None]:
    """Span for one ``JobBoardScraperPort.scrape`` invocation."""

    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("discovery.adapter.fetch") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("run.id", run_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("adapter.kind", adapter_kind)
        span.set_attribute("page.count", int(page_count))
        span.set_attribute("result.count", int(result_count))
        if error_class is not None:
            span.set_attribute("error.class", error_class)
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def canonicalize_span(
    *,
    tenant_id: str,
    job_id: str,
    source_id: str,
    canonical_url_present: bool,
    ats_kind: str,
    confidence: float,
    scope_name: str = "jobctrl.discovery.canonicalize",
) -> Iterator[None]:
    """Span for the canonical-identity decision per posting."""

    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("discovery.canonicalize") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("job.id", job_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("canonical.url.present", bool(canonical_url_present))
        span.set_attribute("ats.kind", ats_kind)
        span.set_attribute("confidence", float(confidence))
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def dedupe_span(
    *,
    tenant_id: str,
    job_id: str,
    stage: str,
    result: str,
    confidence: float,
    scope_name: str = "jobctrl.discovery.dedupe",
) -> Iterator[None]:
    """Span for the Discovery write-boundary identity dedupe decision."""

    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("discovery.dedupe") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("job.id", job_id)
        span.set_attribute("dedupe.stage", stage)
        span.set_attribute("dedupe.result", result)
        span.set_attribute("confidence", float(confidence))
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise
