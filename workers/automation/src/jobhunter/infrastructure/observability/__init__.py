"""OpenTelemetry → Langfuse observability layer."""

from jobhunter.infrastructure.observability.llm_spans import llm_generation_span
from jobhunter.infrastructure.observability.otel import (
    init_otel,
    is_otel_enabled,
    shutdown_otel,
)

__all__ = ["init_otel", "is_otel_enabled", "llm_generation_span", "shutdown_otel"]
