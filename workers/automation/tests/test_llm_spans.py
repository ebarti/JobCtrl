"""Tests for ``llm_generation_span`` — the Langfuse-shaped LLM span helper."""

from __future__ import annotations

import json

import pytest

from jobctrl.llm_lanes import bind_llm_lane


@pytest.fixture(autouse=True)
def _llm_lane(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("JOBCTRL_TRACE_CONTENT", raising=False)
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda _lane=None: None)
    with bind_llm_lane("tailoring"):
        yield


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


@pytest.mark.parametrize("effort", ["high", "max", "PRIVATE_EFFORT_SENTINEL"])
def test_effort_metadata_only_exports_known_protocol_values(in_memory_exporter, effort):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    with llm_generation_span(model="gpt-6.1-sol", messages=[], params={"effort": effort}):
        pass
    span = in_memory_exporter.get_finished_spans()[0]
    if effort == "PRIVATE_EFFORT_SENTINEL":
        assert effort not in _exported_span_text(span)
        assert "gen_ai.request.reasoning_effort" not in _attrs(span)
    else:
        assert _attrs(span)["gen_ai.request.reasoning_effort"] == effort


def test_llm_generation_span_records_spend_once(monkeypatch, in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    calls: list[dict] = []
    monkeypatch.setattr("jobctrl.llm._utc_spend_day", lambda: "2042-06-09")

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
            "day": "2042-06-09",
            "lane": "tailoring",
        }
    ]


def test_llm_generation_span_deduplicates_repeated_usage_callback(
    monkeypatch,
    in_memory_exporter,
):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    calls: list[dict] = []
    monkeypatch.setattr("jobctrl.llm.record_llm_spend", lambda **kwargs: calls.append(kwargs))

    with llm_generation_span(model="gemini-3.5-flash", messages=[], params={}) as record:
        record("hello", input_tokens=5, output_tokens=2)
        record("hello", input_tokens=5, output_tokens=2)

    assert len(calls) == 1


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



def test_numeric_subcounts_and_reuse_are_diagnostics_without_additional_spend(monkeypatch, in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
    from jobctrl.llm_request_context import bind_determination_request

    spend = []
    monkeypatch.setattr("jobctrl.llm.record_llm_spend", lambda **kwargs: spend.append(kwargs))
    with bind_determination_request("artifact_quality", "a" * 64):
        with llm_generation_span(
            model="gpt-test", messages=[], params={}, instruction_profile="b" * 64,
        ) as record:
            record("", input_tokens=19, output_tokens=9)
            record("", cached_input_tokens=11, reasoning_output_tokens=7)
            record("owned", input_tokens=19, output_tokens=9, runtime_metadata={
                "sdk_process_reused": True, "sdk_process_start_count": 1,
                "sdk_process_reuse_count": 3, "cwd": "PRIVATE_PATH_SENTINEL",
            })
    span = in_memory_exporter.get_finished_spans()[0]
    attrs = _attrs(span)
    assert attrs["jobctrl.llm.determination_id"] == "a" * 64
    assert attrs["jobctrl.llm.determination_kind"] == "artifact_quality"
    assert attrs["jobctrl.llm.instruction_profile"] == "b" * 64
    assert attrs["jobctrl.llm.usage.cached_input_tokens"] == 11
    assert attrs["jobctrl.llm.usage.reasoning_output_tokens"] == 7
    assert attrs["jobctrl.llm.runtime.sdk_process_reused"] is True
    assert attrs["jobctrl.llm.runtime.sdk_process_reuse_count"] == 3
    assert json.loads(attrs["langfuse.observation.usage_details"]) == {
        "input_tokens": 19, "output_tokens": 9, "total_tokens": 28,
    }
    assert len(spend) == 1
    assert "PRIVATE_PATH_SENTINEL" not in _exported_span_text(span)


def test_unknown_detail_values_and_arbitrary_identity_content_are_not_exported(in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
    from jobctrl.llm_request_context import bind_determination_request

    with bind_determination_request("PRIVATE KIND SENTINEL", "PRIVATE ID SENTINEL"):
        with llm_generation_span(
            model="gpt-test", messages=[], params={}, instruction_profile="PRIVATE PROFILE SENTINEL",
        ) as record:
            record("", cached_input_tokens=-1, reasoning_output_tokens=True,
                   runtime_metadata={"sdk_process_reused": "PRIVATE REUSE SENTINEL",
                                     "sdk_process_start_count": -1})
    span = in_memory_exporter.get_finished_spans()[0]
    assert not any(key.startswith("jobctrl.llm.usage.") for key in _attrs(span))
    assert "PRIVATE" not in _exported_span_text(span)


@pytest.mark.parametrize("flag", ["1", "true", " yes "])
def test_explicit_content_capture_snapshots_request_and_retains_final_response(
    monkeypatch, in_memory_exporter, flag,
):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", flag)
    messages = [{"role": "user", "content": "Synthetic fact: café team of 3."}]
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    with llm_generation_span(
        model="gpt-test", messages=messages, params={"private_extension": "DO_NOT_EXPORT"},
        response_schema=schema, runtime_instructions="Synthetic runtime instructions",
        runtime_prompt="Synthetic exact provider prompt",
    ) as record:
        messages[0]["content"] = "caller mutation"
        schema["type"] = "caller mutation"
        record("", input_tokens=10, output_tokens=5)
        record('{"answer":"Synthetic response"}')
        record("", cached_input_tokens=0, reasoning_output_tokens=2)
    span = in_memory_exporter.get_finished_spans()[0]
    attrs = _attrs(span)
    request = json.loads(attrs["langfuse.observation.input"])
    assert request["messages"][0]["content"] == "Synthetic fact: café team of 3."
    assert request["response_schema"]["type"] == "object"
    assert request["runtime_instructions"] == "Synthetic runtime instructions"
    assert request["runtime_prompt"] == "Synthetic exact provider prompt"
    assert attrs["langfuse.observation.output"] == '{"answer":"Synthetic response"}'
    assert attrs["jobctrl.llm.output.character_count"] == len('{"answer":"Synthetic response"}')
    assert attrs["jobctrl.llm.content_capture"] == "enabled"
    assert "DO_NOT_EXPORT" not in _exported_span_text(span)


@pytest.mark.parametrize("flag", ["", "0", "false", "enabled", "PRIVATE_FLAG"])
def test_content_capture_requires_explicit_flag(monkeypatch, in_memory_exporter, flag):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", flag)
    with llm_generation_span(
        model="gpt-test", messages=[{"role": "user", "content": "PRIVATE_INPUT"}], params={},
        response_schema={"description": "PRIVATE_SCHEMA"}, runtime_instructions="PRIVATE_RUNTIME",
    ) as record:
        record("PRIVATE_OUTPUT")
    text = _exported_span_text(in_memory_exporter.get_finished_spans()[0])
    assert "PRIVATE" not in text
    assert "langfuse.observation.input" not in text
    assert "langfuse.observation.output" not in text


def test_enabled_capture_keeps_failure_text_private(monkeypatch, in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", "1")
    with pytest.raises(RuntimeError):
        with llm_generation_span(model="gpt-test", messages=[], params={}):
            raise RuntimeError("PRIVATE_EXCEPTION_MESSAGE")
    attrs = _attrs(in_memory_exporter.get_finished_spans()[0])
    assert json.loads(attrs["langfuse.observation.input"]) == {"messages": []}
    assert "langfuse.observation.output" not in attrs
    assert "PRIVATE_EXCEPTION_MESSAGE" not in _exported_span_text(in_memory_exporter.get_finished_spans()[0])


def test_capture_serialization_failure_does_not_fail_model_work(monkeypatch, in_memory_exporter):
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", "1")
    with llm_generation_span(model="gpt-test", messages=[], params={}, response_schema={"value": object()}) as record:
        record("Synthetic response")
    attrs = _attrs(in_memory_exporter.get_finished_spans()[0])
    assert attrs["jobctrl.llm.content_capture"] == "input_serialization_failed"
    assert attrs["jobctrl.llm.success"] is True



def test_content_opt_in_without_recording_does_not_serialize_bodies(monkeypatch, tmp_path):
    from contextlib import nullcontext
    import sqlite3
    from types import SimpleNamespace

    from opentelemetry import trace

    import jobctrl.database as database
    from jobctrl.infrastructure.observability import llm_spans

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    database.init_db(db_path)
    monkeypatch.setattr("jobctrl.llm._utc_spend_day", lambda: "2042-06-09")
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", "1")
    attributes = []

    class NonRecordingSpan(trace.NonRecordingSpan):
        def set_attribute(self, key, value):
            attributes.append((key, value))

    monkeypatch.setattr(llm_spans.trace, "get_tracer", lambda _name: SimpleNamespace(
        start_as_current_span=lambda *_args, **_kwargs: nullcontext(NonRecordingSpan(trace.INVALID_SPAN_CONTEXT)),
    ))

    markers = ("PRIVATE_PROMPT", "PRIVATE_OUTPUT", "PRIVATE_SCHEMA", "PRIVATE_INSTRUCTIONS", "PRIVATE_RUNTIME")
    original_dumps = json.dumps
    serializations = []

    def guarded_dumps(value, *args, **kwargs):
        assert all(marker not in repr(value) for marker in markers), "Private provider content was serialized"
        serializations.append(value)
        return original_dumps(value, *args, **kwargs)

    monkeypatch.setattr(llm_spans.json, "dumps", guarded_dumps)
    try:
        with llm_spans.llm_generation_span(
            model="gpt-test", messages=[{"role": "user", "content": "PRIVATE_PROMPT"}], params={},
            response_schema={"marker": "PRIVATE_SCHEMA", "unused_non_json_value": object()},
            runtime_instructions="PRIVATE_INSTRUCTIONS", runtime_prompt="PRIVATE_RUNTIME",
        ) as record:
            record("PRIVATE_OUTPUT", input_tokens=5, output_tokens=2)
            receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
            receipt_text = receipt.read_text()
            assert all(marker not in receipt_text for marker in markers)

        assert all(marker not in repr(attributes) for marker in markers)
        assert any(isinstance(value, dict) and value.get("day") == "2042-06-09"
                   and value.get("input_tokens") == 5 and value.get("output_tokens") == 2
                   for value in serializations)
        with sqlite3.connect(db_path) as raw:
            assert raw.execute("SELECT day, lane, input_tokens, output_tokens FROM llm_spend").fetchone() == (
                "2042-06-09", "tailoring", 5, 2,
            )
        assert not list((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    finally:
        database.close_connection(db_path)
