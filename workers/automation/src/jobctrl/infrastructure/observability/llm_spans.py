"""Context manager that wraps a single LLM call in a Langfuse-shaped span."""

from __future__ import annotations

import json
import os
import re
import sys
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
    instruction_profile: str | None = None,
    response_schema: dict | None = None,
    runtime_instructions: str | None = None,
    runtime_prompt: str | None = None,
) -> Iterator[RecordResponse]:
    """Open a ``langfuse.observation.type=generation`` span around an LLM call.

    Yields a ``record_response(text, *, input_tokens, output_tokens)`` callable
    so the caller can attach content-free response size + token counts after
    the LLM returns. Exceptions raised inside the ``with`` block mark the span
    failed without exporting their potentially private messages, then re-raise.
    JOBCTRL_TRACE_CONTENT explicitly opts into request/response bodies on recording
    spans; credentials, arbitrary parameters and exception text remain excluded.
    """
    from jobctrl.llm import enforce_spend_budget
    from jobctrl.llm_lanes import current_llm_lane

    from jobctrl.infrastructure.llm.attempt_admission import check_model_attempt_admission

    check_model_attempt_admission()
    lane = current_llm_lane()
    enforce_spend_budget(lane)
    tracer = trace.get_tracer(scope_name)
    with tracer.start_as_current_span(
        f"llm.{model}",
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        span.set_attribute("langfuse.observation.type", "generation")
        span.set_attribute("langfuse.observation.model.name", model)
        span.set_attribute("gen_ai.request.model", model)
        effort = params.get("effort")
        if isinstance(effort, str) and effort in {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}:
            span.set_attribute("gen_ai.request.reasoning_effort", effort)
        operation = "chat_json" if params.get("structured") is True else "chat"
        span.set_attribute("gen_ai.operation.name", operation)
        span.set_attribute("jobctrl.llm.operation", operation)
        span.set_attribute("jobctrl.llm.stage", scope_name)
        span.set_attribute("jobctrl.llm.lane", lane)
        if schema_fingerprint is not None:
            span.set_attribute("jobctrl.llm.schema_fingerprint", schema_fingerprint)
        if isinstance(instruction_profile, str) and re.fullmatch(r"[a-f0-9]{64}", instruction_profile):
            span.set_attribute("jobctrl.llm.instruction_profile", instruction_profile)
        from jobctrl.llm_request_context import current_determination_request

        request = current_determination_request()
        if request is not None and re.fullmatch(r"[a-f0-9]{64}", request.fingerprint):
            span.set_attribute("jobctrl.llm.determination_id", request.fingerprint)
            if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", request.kind):
                span.set_attribute("jobctrl.llm.determination_kind", request.kind)
        span.set_attribute("jobctrl.llm.input.message_count", len(messages))
        span.set_attribute(
            "jobctrl.llm.input.character_count",
            _message_character_count(messages),
        )
        span.set_attribute("jobctrl.llm.request.parameter_count", len(params))
        provider = _provider_name(model=model, scope_name=scope_name)
        if provider is not None:
            span.set_attribute("gen_ai.provider.name", provider)

        capture_content = (
            os.environ.get("JOBCTRL_TRACE_CONTENT", "").strip().lower() in {"1", "true", "yes"}
            and span.is_recording()
            and (request is None or request.kind not in {"message_link", "message_outcome"})
        )
        if capture_content:
            request_body = {"messages": messages}
            for name, value in (
                ("response_schema", response_schema),
                ("runtime_instructions", runtime_instructions),
                ("runtime_prompt", runtime_prompt),
            ):
                if value is not None:
                    request_body[name] = value
            try:
                encoded = json.dumps(request_body, ensure_ascii=False, separators=(",", ":"))
            except (TypeError, ValueError):
                # Diagnostic serialization must not change a provider call.
                span.set_attribute("jobctrl.llm.content_capture", "input_serialization_failed")
            else:
                span.set_attribute("langfuse.observation.input", encoded)
                span.set_attribute("jobctrl.llm.content_capture", "enabled")

        from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved, SpendObservation
        from jobctrl.llm import _utc_spend_day

        observation = SpendObservation(day=_utc_spend_day(), lane=lane, provider=provider, model=model)
        usage_recorded = False
        usage_failure: BaseException | None = None
        response_recorded = False

        def record(
            text: str,
            *,
            input_tokens: int | None = None,
            output_tokens: int | None = None,
            cached_input_tokens: int | None = None,
            reasoning_output_tokens: int | None = None,
            runtime_metadata: dict | None = None,
            unresolved_usage: list[dict] | None = None,
            usage_observed: bool = False,
        ) -> None:
            nonlocal usage_recorded, usage_failure, response_recorded
            counts_supplied = usage_observed or input_tokens is not None or output_tokens is not None
            input_tokens = input_tokens if type(input_tokens) is int and input_tokens >= 0 else None
            output_tokens = output_tokens if type(output_tokens) is int and output_tokens >= 0 else None
            span.set_attribute("gen_ai.response.model", model)
            if text or not response_recorded:
                span.set_attribute("jobctrl.llm.output.character_count", len(text))
            response_recorded = response_recorded or bool(text)
            # SDK usage callbacks pass empty text. They must not overwrite the
            # final response, including when accounting arrives after it.
            if capture_content and text:
                span.set_attribute("langfuse.observation.output", text)
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
            # These are subsets of the existing totals, never extra billable
            # categories. Unknown counters stay absent rather than becoming zero.
            for name, value in (
                ("cached_input_tokens", cached_input_tokens),
                ("reasoning_output_tokens", reasoning_output_tokens),
            ):
                if type(value) is int and value >= 0:
                    span.set_attribute("jobctrl.llm.usage." + name, value)
            if runtime_metadata is not None:
                reused = runtime_metadata.get("sdk_process_reused")
                if type(reused) is bool:
                    span.set_attribute("jobctrl.llm.runtime.sdk_process_reused", reused)
                for name in ("sdk_process_start_count", "sdk_process_reuse_count"):
                    value = runtime_metadata.get(name)
                    if type(value) is int and value >= 0:
                        span.set_attribute("jobctrl.llm.runtime." + name, value)
            if usage_recorded:
                return
            if usage_failure is not None:
                return
            if unresolved_usage is None and not counts_supplied:
                return
            from jobctrl.llm import record_llm_spend

            try:
                if unresolved_usage is not None:
                    observation.ambiguous(unresolved_usage, day=_utc_spend_day())
                    raise SpendAccountingUnresolved("Provider usage reports are incomplete or ambiguous.")
                day = _utc_spend_day()
                observation.observed(day=day, input_tokens=input_tokens, output_tokens=output_tokens)
                if input_tokens is None or output_tokens is None:
                    raise SpendAccountingUnresolved("Provider usage has unknown token counts.")
                record_llm_spend(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    model=model,
                    day=day,
                    lane=lane,
                )
            except BaseException as error:
                usage_failure = error
                # Defer this until the owner has classified any provider error;
                # a normal return is still rejected when the span exits.
                return
            usage_recorded = True

        try:
            yield record
            if usage_failure is not None:
                raise usage_failure
        except Exception as exc:
            from jobctrl.infrastructure.llm.provider_errors import ProviderCallError

            error_type = type(exc).__name__
            if exc is usage_failure:
                span.set_attribute("error.type", error_type)
                span.set_attribute("jobctrl.llm.failure.category", "accounting")
                span.set_attribute("jobctrl.llm.failure.code", "spend_unresolved")
                status_description = "LLM spend accounting is unresolved"
            elif isinstance(exc, ProviderCallError):
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
        finally:
            primary = sys.exception()
            if usage_failure is not None:
                span.set_attribute("jobctrl.llm.accounting.unresolved", True)
            if primary is not None and usage_failure is not None and primary is not usage_failure:
                primary.add_note("Persisting observed LLM usage also failed; accounting is unresolved.")
            try:
                observation.close(unresolved=usage_failure is not None)
            except BaseException:
                if primary is None:
                    raise
                primary.add_note("Finishing the LLM spend receipt also failed.")
