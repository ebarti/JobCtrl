"""Privacy-bounded adapter span, independent of business runtime packages."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
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
    """Trace an adapter invocation without exporting raw query or error text."""
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span(
        "discovery.adapter.fetch", record_exception=False, set_status_on_exception=False
    ) as span:
        span.set_attribute("langfuse.observation.type", "span")
        span.set_attribute("tenant.id", tenant_id)
        span.set_attribute("run.id", hashlib.sha256(run_id.encode()).hexdigest())
        span.set_attribute("source.id", source_id)
        span.set_attribute("adapter.kind", adapter_kind)
        span.set_attribute("page.count", int(page_count))
        span.set_attribute("result.count", int(result_count))
        if error_class is not None:
            span.set_attribute("error.class", error_class)
        try:
            yield
        except Exception:
            span.set_status(Status(StatusCode.ERROR))
            raise
