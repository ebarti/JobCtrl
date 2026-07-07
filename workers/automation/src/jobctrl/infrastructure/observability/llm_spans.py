"""Context manager that wraps a single LLM call in a Langfuse-shaped span."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Callable, Iterator

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

RecordResponse = Callable[..., None]


@contextmanager
def llm_generation_span(
    *,
    model: str,
    messages: list[dict],
    params: dict,
    scope_name: str = "jobctrl.llm",
) -> Iterator[RecordResponse]:
    """Open a ``langfuse.observation.type=generation`` span around an LLM call.

    Yields a ``record_response(text, *, input_tokens, output_tokens)`` callable
    so the caller can attach the response payload + token counts after the
    LLM returns. Exceptions raised inside the ``with`` block are recorded
    on the span (StatusCode.ERROR) and re-raised.
    """
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span(f"llm.{model}") as span:
        span.set_attribute("langfuse.observation.type", "generation")
        span.set_attribute("langfuse.observation.model.name", model)
        span.set_attribute("langfuse.observation.model.parameters", json.dumps(params))
        span.set_attribute("langfuse.observation.input", json.dumps(messages))
        span.set_attribute("gen_ai.request.model", model)

        def record(
            text: str,
            *,
            input_tokens: int | None = None,
            output_tokens: int | None = None,
        ) -> None:
            span.set_attribute("langfuse.observation.output", text)
            span.set_attribute("gen_ai.response.model", model)
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
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            raise
