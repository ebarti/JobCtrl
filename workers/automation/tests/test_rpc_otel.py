"""Tests for the JSON-RPC dispatch span emitted on every method call."""

from __future__ import annotations

import io

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode, set_tracer_provider

from jobhunter.domain.rpc.messages import JsonRpcRequest, WorkflowStartSpec
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


# --- Streaming dispatch ----------------------------------------------------


def test_rpc_streaming_dispatch_emits_span(in_memory_exporter):
    """A streaming-mode call must emit the same rpc.<method> span as sync."""
    server = JsonRpcServer()

    def stream(_params):
        yield {"step": "one"}

    server.register("watch", stream, mode="streaming")

    stdout = io.StringIO()
    line = '{"jsonrpc":"2.0","method":"watch","params":{},"id":7}'
    response = server._handle_line(line, stdout)
    assert response is not None

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "rpc.watch"
    attrs = dict(span.attributes or {})
    assert attrs["rpc.method"] == "watch"
    assert attrs["rpc.id"] == "7"
    assert attrs["langfuse.trace.name"] == "watch"
    assert attrs["langfuse.observation.type"] == "span"


def test_rpc_streaming_dispatch_marks_error_on_mid_stream_failure(in_memory_exporter):
    server = JsonRpcServer()

    def stream(_params):
        yield {"ok": 1}
        raise RuntimeError("stream-blew-up")

    server.register("watch", stream, mode="streaming")

    stdout = io.StringIO()
    server._handle_line('{"jsonrpc":"2.0","method":"watch","params":{},"id":1}', stdout)

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    assert "stream-blew-up" in (spans[0].status.description or "")


# --- Workflow dispatch error markers ---------------------------------------


class _FakeWorkflow:
    pass


def test_rpc_workflow_mode_marks_span_error_on_starter_failure(in_memory_exporter):
    async def starter(_spec):
        raise RuntimeError("temporal-down")

    server = JsonRpcServer(workflow_starter=starter)
    server.register(
        "start",
        lambda _p: WorkflowStartSpec(workflow=_FakeWorkflow, args=()),
        mode="workflow",
    )

    server.dispatch(JsonRpcRequest(method="start", params={}, id=1))

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    assert "temporal-down" in (spans[0].status.description or "")


def test_rpc_workflow_mode_marks_span_error_on_missing_starter(in_memory_exporter):
    server = JsonRpcServer()  # no workflow_starter wired
    server.register(
        "start",
        lambda _p: WorkflowStartSpec(workflow=_FakeWorkflow, args=()),
        mode="workflow",
    )

    server.dispatch(JsonRpcRequest(method="start", params={}, id=1))

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    assert "workflow_starter" in (spans[0].status.description or "")


def test_rpc_workflow_mode_marks_span_error_on_handler_returning_non_spec(in_memory_exporter):
    async def starter(_spec):  # pragma: no cover — must not be reached
        raise AssertionError("starter must not be called")

    server = JsonRpcServer(workflow_starter=starter)
    server.register("start", lambda _p: {"not": "a spec"}, mode="workflow")

    server.dispatch(JsonRpcRequest(method="start", params={}, id=1))

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR


def test_rpc_workflow_mode_marks_span_error_on_handler_raising_while_building_spec(in_memory_exporter):
    async def starter(_spec):  # pragma: no cover
        raise AssertionError("starter must not be called")

    def handler(_params):
        raise RuntimeError("spec-build-failed")

    server = JsonRpcServer(workflow_starter=starter)
    server.register("start", handler, mode="workflow")

    server.dispatch(JsonRpcRequest(method="start", params={}, id=1))

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    assert "spec-build-failed" in (spans[0].status.description or "")
