"""Tests for ``llm_generation_span`` — the Langfuse-shaped LLM span helper."""

from __future__ import annotations

import json

import pytest


def _attrs(span) -> dict:
    return dict(span.attributes or {})


def _exported_span_text(span) -> str:
    """Flatten every exported attribute/status/event surface for leak checks."""
    return json.dumps(
        {
            "attributes": _attrs(span),
            "status": span.status.description,
            "events": [
                {"name": event.name, "attributes": dict(event.attributes or {})}
                for event in span.events
            ],
        },
        default=str,
        sort_keys=True,
    )


def test_llm_generation_span_sets_langfuse_attributes(in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    private_sentinel = "PRIVATE_RESUME_SENTINEL"
    messages = [{"role": "user", "content": f"hi {private_sentinel}"}]
    params = {
        "temperature": 0.0,
        "max_tokens": 100,
        "private_extension": private_sentinel,
    }

    with llm_generation_span(model="gemini-3.5-flash", messages=messages, params=params) as record:
        record(f"hello {private_sentinel}", input_tokens=5, output_tokens=2)

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    attrs = _attrs(spans[0])
    assert attrs["langfuse.observation.type"] == "generation"
    assert attrs["langfuse.observation.model.name"] == "gemini-3.5-flash"
    assert "langfuse.observation.model.parameters" not in attrs
    assert "langfuse.observation.input" not in attrs
    assert "langfuse.observation.output" not in attrs
    assert attrs["gen_ai.operation.name"] == "chat"
    assert attrs["gen_ai.provider.name"] == "google"
    assert attrs["jobctrl.llm.stage"] == "jobctrl.llm"
    assert attrs["jobctrl.llm.input.message_count"] == 1
    assert attrs["jobctrl.llm.input.character_count"] == len(messages[0]["content"])
    assert attrs["jobctrl.llm.output.character_count"] == len(f"hello {private_sentinel}")
    assert attrs["jobctrl.llm.request.parameter_count"] == len(params)
    assert attrs["jobctrl.llm.success"] is True
    usage = json.loads(attrs["langfuse.observation.usage_details"])
    assert usage == {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}
    # Mirror into GenAI semconv so Langfuse + OTel-native dashboards both work.
    assert attrs["gen_ai.request.model"] == "gemini-3.5-flash"
    assert attrs["gen_ai.response.model"] == "gemini-3.5-flash"
    assert attrs["gen_ai.usage.input_tokens"] == 5
    assert attrs["gen_ai.usage.output_tokens"] == 2
    assert private_sentinel not in _exported_span_text(spans[0])


def test_llm_generation_span_records_spend_once(monkeypatch, in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    calls: list[dict] = []

    def fake_record_llm_spend(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr("jobctrl.llm.record_llm_spend", fake_record_llm_spend)

    with llm_generation_span(model="gemini-3.5-flash", messages=[], params={}) as record:
        record("hello", input_tokens=5, output_tokens=2)

    assert calls == [
        {
            "input_tokens": 5,
            "output_tokens": 2,
            "model": "gemini-3.5-flash",
        }
    ]


def test_llm_generation_span_handles_unknown_tokens(in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    with llm_generation_span(model="gpt-4o-mini", messages=[], params={}) as record:
        record("done", input_tokens=None, output_tokens=None)

    spans = in_memory_exporter.get_finished_spans()
    attrs = _attrs(spans[0])
    assert "langfuse.observation.usage_details" not in attrs
    assert "gen_ai.usage.input_tokens" not in attrs


def test_llm_generation_span_records_content_free_failure(caplog, in_memory_exporter):
    from opentelemetry.trace import StatusCode

    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    private_sentinel = "PRIVATE_JOB_TEXT_SENTINEL"
    with pytest.raises(RuntimeError, match=private_sentinel):
        with llm_generation_span(
            model="m",
            messages=[{"role": "user", "content": private_sentinel}],
            params={},
        ):
            raise RuntimeError(f"provider echoed {private_sentinel}")

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    attrs = _attrs(span)
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description == "LLM call failed (RuntimeError)"
    assert attrs["error.type"] == "RuntimeError"
    assert attrs["jobctrl.llm.failure.provider"] == "unknown"
    assert attrs["jobctrl.llm.failure.model"] == "m"
    assert attrs["jobctrl.llm.failure.operation"] == "chat"
    assert attrs["jobctrl.llm.failure.category"] == "provider_exception"
    assert attrs["jobctrl.llm.failure.type"] == "RuntimeError"
    assert attrs["jobctrl.llm.failure.code"] == "sdk_exception"
    assert attrs["jobctrl.llm.failure.retryable"] is False
    assert attrs["jobctrl.llm.success"] is False
    assert span.events == ()
    assert private_sentinel not in _exported_span_text(span)
    assert private_sentinel not in caplog.text


def test_llm_generation_span_exports_safe_provider_failure_attributes(in_memory_exporter):
    from opentelemetry.trace import StatusCode

    from jobctrl.infrastructure.llm.provider_errors import (
        ProviderCallError,
        ProviderFailureEnvelope,
    )
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    private_sentinel = "PRIVATE_PROVIDER_ERROR_TEXT"
    failure = ProviderCallError(
        ProviderFailureEnvelope(
            provider="openai",
            model="codex-test-model",
            operation="chat_json",
            category="provider_turn",
            error_type="codex_turn_error",
            code="builder_error",
            retryable=True,
            message_code="builder_error",
            additional_detail_code="schema_validation_failed",
            additional_details_present=True,
            codex_error_code="server_overloaded",
        )
    )

    with pytest.raises(ProviderCallError):
        with llm_generation_span(
            model="codex-test-model",
            messages=[{"role": "user", "content": private_sentinel}],
            params={"structured": True},
            scope_name="jobctrl.llm.codex",
            schema_fingerprint="schema-safe-fingerprint",
        ):
            raise failure

    span = in_memory_exporter.get_finished_spans()[0]
    attrs = _attrs(span)
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description == "LLM provider call failed (provider_turn:builder_error)"
    assert attrs["jobctrl.llm.operation"] == "chat_json"
    assert attrs["jobctrl.llm.schema_fingerprint"] == "schema-safe-fingerprint"
    assert attrs["jobctrl.llm.failure.provider"] == "openai"
    assert attrs["jobctrl.llm.failure.model"] == "codex-test-model"
    assert attrs["jobctrl.llm.failure.operation"] == "chat_json"
    assert attrs["jobctrl.llm.failure.category"] == "provider_turn"
    assert attrs["jobctrl.llm.failure.type"] == "codex_turn_error"
    assert attrs["jobctrl.llm.failure.code"] == "builder_error"
    assert attrs["jobctrl.llm.failure.retryable"] is True
    assert attrs["jobctrl.llm.failure.additional_details_present"] is True
    assert attrs["jobctrl.llm.failure.provider_code"] == "server_overloaded"
    assert failure.envelope.trace_id is not None
    assert failure.envelope.span_id is not None
    assert private_sentinel not in _exported_span_text(span)
