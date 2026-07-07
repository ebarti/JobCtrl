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
    scope_name: str = "jobctl.discovery.sources",
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
    scope_name: str = "jobctl.discovery.locator",
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


@contextmanager
def discovery_run_span(
    *,
    tenant_id: str,
    run_id: str,
    source_ids: tuple[str, ...],
    profile_snapshot_id: str | None,
    scope_name: str = "jobctl.discovery.scheduler",
) -> Iterator[None]:
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("discovery.run") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("run.id", run_id)
        span.set_attribute("source.ids", ",".join(source_ids))
        span.set_attribute("source.count", len(source_ids))
        if profile_snapshot_id:
            span.set_attribute("profile.snapshot_id", profile_snapshot_id)
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise


@contextmanager
def source_quality_aggregation_span(
    *,
    tenant_id: str,
    source_id: str,
    window: str,
    event_count: int,
    span_count: int = 0,
    scope_name: str = "jobctl.operations.source_quality",
) -> Iterator[None]:
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span("operations.source_quality.aggregate") as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("source.id", source_id)
        span.set_attribute("window", window)
        span.set_attribute("event.count", event_count)
        span.set_attribute("span.count", span_count)
        try:
            yield
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise
