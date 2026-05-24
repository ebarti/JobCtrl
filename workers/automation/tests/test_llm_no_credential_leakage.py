"""Regression: the Gemini API key MUST NOT appear in any exported span attribute.

Originally the native Gemini path passed ``params={"key": self.api_key}`` to
``httpx.post``. ``HTTPXClientInstrumentor`` then captured the full URL into
``http.url`` and shipped it to Langfuse — exfiltrating the key on every call.

This test wires an in-memory exporter and an instrumented ``httpx.Client`` whose
transport is a ``MockTransport`` that serves a canned Gemini response. After one
LLM call we walk every span attribute and assert no value contains the test
API key substring.
"""

from __future__ import annotations

import httpx
import pytest
from opentelemetry import trace as trace_api
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import set_tracer_provider
from opentelemetry.util._once import Once

_TEST_KEY = "TEST_KEY_DEADBEEFCAFE"


@pytest.fixture
def in_memory_exporter(monkeypatch):
    """Stand up a TracerProvider piped to an in-memory exporter."""
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider(provider)
    yield exporter
    exporter.clear()


def test_gemini_native_path_does_not_leak_api_key(in_memory_exporter, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", _TEST_KEY)

    from jobhunter.llm import LLMClient

    # Replace the LLMClient's internal httpx.Client with one we can instrument
    # individually and whose transport is a MockTransport (so no network is hit).
    def _gemini_response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            json={
                "candidates": [{"content": {"parts": [{"text": "ok"}]}}],
                "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
            },
        )

    client = LLMClient(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-3-flash-preview",
        api_key=_TEST_KEY,
    )
    # Drop the production httpx.Client and install one with a MockTransport,
    # then attach the OTel httpx instrumentor explicitly to that client so the
    # spans the production code emits are still captured.
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(_gemini_response))
    HTTPXClientInstrumentor.instrument_client(client._client)
    client._use_native_gemini = True  # force native generateContent path

    try:
        client.chat([{"role": "user", "content": "hello"}])
    finally:
        client.close()

    spans = in_memory_exporter.get_finished_spans()
    assert spans, "expected at least one span (LLM generation + httpx client)"

    leaks: list[tuple[str, str, str]] = []
    for span in spans:
        for key, value in (span.attributes or {}).items():
            if _TEST_KEY in str(value):
                leaks.append((span.name, key, str(value)))

    assert not leaks, (
        "API key leaked into span attributes:\n  "
        + "\n  ".join(f"{name}.{k} = {v}" for name, k, v in leaks)
    )
