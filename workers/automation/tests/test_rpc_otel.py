"""Tests for the JSON-RPC dispatch span emitted on every method call."""

from __future__ import annotations

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode, set_tracer_provider

from jobhunter.domain.rpc.messages import JsonRpcRequest
from jobhunter.infrastructure.rpc.server import JsonRpcServer


@pytest.fixture
def in_memory_exporter(monkeypatch):
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


def test_dispatch_emits_span_with_method_attributes(in_memory_exporter):
    server = JsonRpcServer()
    server.register("ping", lambda _params: "pong")

    request = JsonRpcRequest(method="ping", params={}, id=42)
    response = server.dispatch(request)

    assert response is not None
    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "rpc.ping"
    attrs = _attrs(span)
    assert attrs["rpc.method"] == "ping"
    assert attrs["rpc.id"] == "42"
    assert attrs["langfuse.trace.name"] == "ping"
    assert attrs["langfuse.observation.type"] == "span"


def test_dispatch_marks_error_status_on_handler_failure(in_memory_exporter):
    server = JsonRpcServer()

    def boom(_params):
        raise RuntimeError("boom-rpc")

    server.register("boom", boom)
    server.dispatch(JsonRpcRequest(method="boom", params={}, id=1))

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    assert "boom-rpc" in (spans[0].status.description or "")
