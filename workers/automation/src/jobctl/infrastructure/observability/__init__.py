"""OpenTelemetry → Langfuse observability layer."""

from jobctl.infrastructure.observability.adapter_spans import (
    adapter_fetch_span,
    canonicalize_span,
    dedupe_span,
)
from jobctl.infrastructure.observability.enrichment_spans import (
    active_verify_span,
    content_acquire_span,
    content_render_span,
    llm_fallback_extraction_span,
)
from jobctl.infrastructure.observability.llm_spans import llm_generation_span
from jobctl.infrastructure.observability.otel import (
    init_otel,
    is_otel_enabled,
    langfuse_disabled,
    shutdown_otel,
)
from jobctl.infrastructure.observability.source_spans import locator_span, source_validation_span

__all__ = [
    "active_verify_span",
    "adapter_fetch_span",
    "canonicalize_span",
    "content_acquire_span",
    "content_render_span",
    "dedupe_span",
    "init_otel",
    "is_otel_enabled",
    "langfuse_disabled",
    "llm_fallback_extraction_span",
    "llm_generation_span",
    "locator_span",
    "shutdown_otel",
    "source_validation_span",
]
