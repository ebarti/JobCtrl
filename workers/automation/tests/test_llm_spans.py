"""Tests for ``llm_generation_span`` — the Langfuse-shaped LLM span helper."""

from __future__ import annotations

import json

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider


@pytest.fixture
def in_memory_exporter(monkeypatch):
    """Stand up a TracerProvider piped to an in-memory exporter for assertions."""
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider(provider)
    yield exporter
    exporter.clear()


def _attrs(span) -> dict:
    return dict(span.attributes or {})


def test_llm_generation_span_sets_langfuse_attributes(in_memory_exporter):
    from jobhunter.infrastructure.observability.llm_spans import llm_generation_span

    messages = [{"role": "user", "content": "hi"}]
    params = {"temperature": 0.0, "max_tokens": 100}

    with llm_generation_span(model="gemini-3.5-flash", messages=messages, params=params) as record:
        record("hello world", input_tokens=5, output_tokens=2)

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    attrs = _attrs(spans[0])
    assert attrs["langfuse.observation.type"] == "generation"
    assert attrs["langfuse.observation.model.name"] == "gemini-3.5-flash"
    assert json.loads(attrs["langfuse.observation.model.parameters"]) == params
    assert json.loads(attrs["langfuse.observation.input"]) == messages
    assert attrs["langfuse.observation.output"] == "hello world"
    usage = json.loads(attrs["langfuse.observation.usage_details"])
    assert usage == {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}
    # Mirror into GenAI semconv so Langfuse + OTel-native dashboards both work.
    assert attrs["gen_ai.request.model"] == "gemini-3.5-flash"
    assert attrs["gen_ai.response.model"] == "gemini-3.5-flash"
    assert attrs["gen_ai.usage.input_tokens"] == 5
    assert attrs["gen_ai.usage.output_tokens"] == 2


def test_llm_generation_span_handles_unknown_tokens(in_memory_exporter):
    from jobhunter.infrastructure.observability.llm_spans import llm_generation_span

    with llm_generation_span(model="gpt-4o-mini", messages=[], params={}) as record:
        record("done", input_tokens=None, output_tokens=None)

    spans = in_memory_exporter.get_finished_spans()
    attrs = _attrs(spans[0])
    assert "langfuse.observation.usage_details" not in attrs
    assert "gen_ai.usage.input_tokens" not in attrs


def test_llm_generation_span_records_exception(in_memory_exporter):
    from opentelemetry.trace import StatusCode

    from jobhunter.infrastructure.observability.llm_spans import llm_generation_span

    with pytest.raises(RuntimeError):
        with llm_generation_span(model="m", messages=[], params={}):
            raise RuntimeError("boom")

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    assert "boom" in (spans[0].status.description or "")
