"""Context manager that wraps a single LLM call in a Langfuse-shaped span."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Callable, Iterator

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

RecordResponse = Callable[..., None]


def _message_character_count(messages: list[dict]) -> int:
    """Return a content-size metric without serializing message content."""
    return sum(
        len(content)
        for message in messages
        if isinstance((content := message.get("content")), str)
    )


def _provider_name(*, model: str, scope_name: str) -> str | None:
    """Infer the provider from safe, operator-controlled metadata."""
    scope_suffix = scope_name.rsplit(".", 1)[-1].lower()
    if scope_suffix in {"claude", "codex", "google", "antigravity"}:
        return {
            "claude": "anthropic",
            "codex": "openai",
            "google": "google",
            "antigravity": "google",
        }[scope_suffix]

    normalized_model = model.lower()
    if normalized_model.startswith("claude"):
        return "anthropic"
    if normalized_model.startswith("gemini"):
        return "google"
    if normalized_model.startswith(("gpt-", "o1", "o3", "o4")):
        return "openai"
    return None


@contextmanager
def llm_generation_span(
    *,
    model: str,
    messages: list[dict],
    params: dict,
    scope_name: str = "jobctrl.llm",
    schema_fingerprint: str | None = None,
) -> Iterator[RecordResponse]:
    """Open a ``langfuse.observation.type=generation`` span around an LLM call.

    Yields a ``record_response(text, *, input_tokens, output_tokens)`` callable
    so the caller can attach content-free response size + token counts after
    the LLM returns. Exceptions raised inside the ``with`` block mark the span
    failed without exporting their potentially private messages, then re-raise.
    """
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span(
        f"llm.{model}",
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        span.set_attribute("langfuse.observation.type", "generation")
        span.set_attribute("langfuse.observation.model.name", model)
        span.set_attribute("gen_ai.request.model", model)
        operation = "chat_json" if params.get("structured") is True else "chat"
        span.set_attribute("gen_ai.operation.name", operation)
        span.set_attribute("jobctrl.llm.operation", operation)
        span.set_attribute("jobctrl.llm.stage", scope_name)
        if schema_fingerprint is not None:
            span.set_attribute("jobctrl.llm.schema_fingerprint", schema_fingerprint)
        span.set_attribute("jobctrl.llm.input.message_count", len(messages))
        span.set_attribute(
            "jobctrl.llm.input.character_count",
            _message_character_count(messages),
        )
        span.set_attribute("jobctrl.llm.request.parameter_count", len(params))
        provider = _provider_name(model=model, scope_name=scope_name)
        if provider is not None:
            span.set_attribute("gen_ai.provider.name", provider)

        def record(
            text: str,
            *,
            input_tokens: int | None = None,
            output_tokens: int | None = None,
        ) -> None:
            span.set_attribute("gen_ai.response.model", model)
            span.set_attribute("jobctrl.llm.output.character_count", len(text))
            if input_tokens is not None and output_tokens is not None:
                span.set_attribute(
                    "langfuse.observation.usage_details",
                    json.dumps(
                        {
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "total_tokens": input_tokens + output_tokens,
                        }
                    ),
                )
            if input_tokens is not None:
                span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
            if output_tokens is not None:
                span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
            try:
                from jobctrl.llm import record_llm_spend

                record_llm_spend(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    model=model,
                )
            except Exception:  # noqa: BLE001 - spend telemetry must not fail the LLM call
                pass

        try:
            yield record
        except Exception as exc:
            from jobctrl.infrastructure.llm.provider_errors import ProviderCallError

            error_type = type(exc).__name__
            if isinstance(exc, ProviderCallError):
                context = span.get_span_context()
                trace_id = f"{context.trace_id:032x}" if context.is_valid else None
                span_id = f"{context.span_id:016x}" if context.is_valid else None
                exc.attach_trace(trace_id=trace_id, span_id=span_id)
                for key, value in exc.envelope.telemetry_attributes().items():
                    span.set_attribute(key, value)
                span.set_attribute("error.type", exc.envelope.error_type)
                status_description = (
                    "LLM provider call failed "
                    f"({exc.envelope.category}:{exc.envelope.code})"
                )
            else:
                span.set_attribute("error.type", error_type)
                # SDK adapters that do not expose a typed provider error still
                # need the same bounded, queryable failure dimensions. Do not
                # serialize their exception text or object graph.
                for key, value in {
                    "jobctrl.llm.failure.provider": provider or "unknown",
                    "jobctrl.llm.failure.model": model,
                    "jobctrl.llm.failure.operation": operation,
                    "jobctrl.llm.failure.category": "provider_exception",
                    "jobctrl.llm.failure.type": error_type,
                    "jobctrl.llm.failure.code": "sdk_exception",
                    "jobctrl.llm.failure.retryable": False,
                }.items():
                    span.set_attribute(key, value)
                status_description = f"LLM call failed ({error_type})"
            span.set_attribute("jobctrl.llm.success", False)
            span.set_status(Status(StatusCode.ERROR, status_description))
            raise
        else:
            span.set_attribute("jobctrl.llm.success", True)
            span.set_status(Status(StatusCode.OK))
