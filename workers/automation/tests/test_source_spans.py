"""Regression tests for source locator and source-validation spans."""

from __future__ import annotations

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider


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


def test_source_validation_span_records_source_metadata_without_content(in_memory_exporter) -> None:
    from jobctrl.infrastructure.observability.source_spans import source_validation_span

    with source_validation_span(
        tenant_id="local",
        source_id="smart_extract:remoteok",
        source_kind="smart_extract",
        policy_id="smart_extract_experimental",
        state="experimental",
        validation_result="ok",
    ):
        pass

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    attrs = dict(spans[0].attributes or {})
    assert spans[0].name == "discovery.source.validate"
    assert attrs["langfuse.observation.type"] == "span"
    assert attrs["tenant.id"] == "local"
    assert attrs["source.id"] == "smart_extract:remoteok"
    assert attrs["source.kind"] == "smart_extract"
    assert attrs["policy.id"] == "smart_extract_experimental"
    assert attrs["validation.result"] == "ok"
    assert "http.url" not in attrs
    assert "langfuse.observation.input" not in attrs


def test_locator_span_records_decision_without_candidate_url(in_memory_exporter) -> None:
    from jobctrl.infrastructure.observability.source_spans import locator_span

    with locator_span(
        tenant_id="local",
        candidate_id="candidate-1",
        source_kind="employer_careers_page",
        url_domain="example.com",
        method="aggregator_backtrace",
        status="manual_action_required",
        http_status_code=200,
        confidence=0.82,
        decision="manual_action_required",
    ):
        pass

    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    attrs = dict(spans[0].attributes or {})
    assert spans[0].name == "discovery.locator.probe"
    assert attrs["tenant.id"] == "local"
    assert attrs["source.candidate_id"] == "candidate-1"
    assert attrs["url.domain"] == "example.com"
    assert attrs["locator.method"] == "aggregator_backtrace"
    assert attrs["locator.status"] == "manual_action_required"
    assert attrs["http.status_code"] == 200
    assert attrs["confidence"] == 0.82
    assert attrs["locator.decision"] == "manual_action_required"
    assert "candidate_url" not in attrs
