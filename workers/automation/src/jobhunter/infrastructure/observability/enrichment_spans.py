"""OpenTelemetry spans for PR3 Enrichment content acquisition.

See ``docs/plans/proposed/2026-05-12-job-search-discovery-rfc.md``
§"Observability". The four spans defined here cover content
acquisition, rendered-browser extraction, the LLM fallback, and
active verification. Span attributes intentionally omit raw posting
text, private notes, resumes, cover letters, and credentials per the
RFC's security guidance.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode


@contextmanager
def content_acquire_span(
    *,
    tenant_id: str,
    job_id: str,
    source_id: str,
    extraction_tier: str,
    policy_id: str,
    snapshot_hash: str | None = None,
    scope_name: str = "jobhunter.enrichment.content",
) -> Iterator[Span]:
    """Span for ``ContentAcquisitionService.acquire``.

    The optional ``snapshot_hash`` is the SHA-256 description hash
    computed by the service when the cascade succeeds. Spans for
    failed captures pass ``None``.
    """
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("enrichment.content.acquire") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("job.id", job_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("extraction.tier", extraction_tier)
        span.set_attribute("policy.id", policy_id)
        if snapshot_hash is not None:
            span.set_attribute("snapshot.hash", snapshot_hash)
        try:
            yield span
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def content_render_span(
    *,
    tenant_id: str,
    job_id: str,
    source_id: str,
    render_result: str,
    http_status_code: int | None = None,
    scope_name: str = "jobhunter.enrichment.content",
) -> Iterator[Span]:
    """Span for rendered-browser detail extraction.

    ``render_result`` is one of ``ok``, ``timeout``, ``not_found``,
    ``blocked``, ``parse_error``. The HTTP status from the navigation
    is included when known; otherwise omitted.
    """
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("enrichment.content.render") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("job.id", job_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("render.result", render_result)
        if http_status_code is not None:
            span.set_attribute("http.status_code", http_status_code)
        try:
            yield span
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def llm_fallback_extraction_span(
    *,
    tenant_id: str,
    job_id: str,
    source_id: str,
    schema_version: str,
    parse_result: str,
    scope_name: str = "jobhunter.enrichment.content.llm",
) -> Iterator[Span]:
    """Span for the LLM fallback extraction stage.

    The span carries Langfuse-friendly metadata; the actual model
    call still goes through ``llm_generation_span`` so token / cost
    metadata are populated. Raw posting text is never set on this
    span — only IDs, schema version, and parse outcome.
    """
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("enrichment.content.llm_fallback") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("job.id", job_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("extraction.tier", "llm_assisted")
        span.set_attribute("schema.version", schema_version)
        span.set_attribute("parse.result", parse_result)
        try:
            yield span
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def active_verify_span(
    *,
    tenant_id: str,
    job_id: str,
    source_id: str,
    active_state: str,
    verification_method: str,
    http_status_code: int | None = None,
    scope_name: str = "jobhunter.enrichment.active",
) -> Iterator[Span]:
    """Span for ``ActiveStateVerifier.verify``."""
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("enrichment.active.verify") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("job.id", job_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("active.state", active_state)
        span.set_attribute("verification.method", verification_method)
        if http_status_code is not None:
            span.set_attribute("http.status_code", http_status_code)
        try:
            yield span
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


__all__ = [
    "active_verify_span",
    "content_acquire_span",
    "content_render_span",
    "llm_fallback_extraction_span",
]
