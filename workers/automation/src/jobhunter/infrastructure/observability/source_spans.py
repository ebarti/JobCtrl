"""OpenTelemetry spans for source locator and registry validation."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode


@contextmanager
def source_validation_span(
    *,
    tenant_id: str,
    source_id: str,
    source_kind: str,
    policy_id: str,
    state: str,
    validation_result: str = "ok",
    scope_name: str = "jobhunter.discovery.sources",
) -> Iterator[None]:
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("discovery.source.validate") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("source.kind", source_kind)
        span.set_attribute("policy.id", policy_id)
        span.set_attribute("source.state", state)
        span.set_attribute("validation.result", validation_result)
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def locator_span(
    *,
    tenant_id: str,
    candidate_id: str,
    source_kind: str,
    url_domain: str,
    method: str,
    status: str,
    http_status_code: int,
    confidence: float,
    decision: str | None = None,
    scope_name: str = "jobhunter.discovery.locator",
) -> Iterator[None]:
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("discovery.locator.probe") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("source.candidate_id", candidate_id)
        span.set_attribute("source.kind", source_kind)
        span.set_attribute("url.domain", url_domain)
        span.set_attribute("locator.method", method)
        span.set_attribute("locator.status", status)
        span.set_attribute("http.status_code", http_status_code)
        span.set_attribute("confidence", confidence)
        if decision is not None:
            span.set_attribute("locator.decision", decision)
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise
