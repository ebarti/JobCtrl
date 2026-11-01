"""Synthetic scan privacy across HTTP logs and recording OTel spans."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote_plus

import httpx
import pytest
from opentelemetry import trace
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

from jobctrl.infrastructure.gmail import client as client_module
from jobctrl.infrastructure.gmail.client import GmailClient
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.infrastructure.observability.otel import _scrub_url_credentials
from jobctrl.llm_lanes import bind_llm_lane
from jobctrl.llm_request_context import bind_determination_request
from tests.test_gmail_feedback import RECIPIENT, seed_feedback_db
from tests.test_gmail_feedback_client_contract import (
    PRIVATE_BODY,
    BodyCitingFeedbackModel,
    _rpc_server,
    _scan,
    _transport,
)


class TracedFeedbackModel(BodyCitingFeedbackModel):
    def chat_json(self, messages, *, response_schema, **kwargs):
        with llm_generation_span(
            model="synthetic-model",
            messages=[{"role": message.role, "content": message.content} for message in messages],
            params={"structured": True},
            response_schema=response_schema,
        ) as record:
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            record(json.dumps(result))
            return result


def span_text(spans) -> str:
    return unquote_plus(json.dumps([
        {
            "name": span.name,
            "attributes": dict(span.attributes or {}),
            "events": [dict(event.attributes or {}) for event in span.events],
            "status": str(span.status),
        }
        for span in spans
    ]))


@pytest.fixture
def no_model_spend(monkeypatch):
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "jobctrl.infrastructure.llm.attempt_admission.check_model_attempt_admission",
        lambda: None,
    )


@pytest.mark.parametrize("content_flag", ["0", "1"])
def test_gmail_transport_never_logs_or_traces_recipient(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog, in_memory_exporter, no_model_spend, content_flag: str
) -> None:
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", content_flag)
    caplog.set_level(logging.INFO, logger="httpx")
    requests: list[httpx.Request] = []
    db_path = seed_feedback_db(tmp_path)
    with httpx.Client(transport=_transport(requests)) as http:
        HTTPXClientInstrumentor.instrument_client(
            http, tracer_provider=trace.get_tracer_provider(), request_hook=_scrub_url_credentials
        )
        result = _scan(_rpc_server(monkeypatch, db_path, http, TracedFeedbackModel(linked=False)), db_path)
    assert result["ok"] is True
    assert len(requests) == 2
    assert RECIPIENT in unquote_plus(str(requests[0].url))  # The provider still receives the recipient bound.
    assert RECIPIENT not in unquote_plus(caplog.text)
    assert "Gmail HTTP request completed with status 200" in caplog.text
    spans = in_memory_exporter.get_finished_spans()
    assert RECIPIENT not in span_text(spans)
    gmail_span = next(span for span in spans if span.name == "gmail.feedback.search")
    assert gmail_span.attributes["jobctrl.gmail.metadata_count"] == 1
    assert gmail_span.status.is_ok


@pytest.mark.parametrize("content_flag", ["0", "1"])
def test_gmail_model_content_stays_out_of_spans_but_remains_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, in_memory_exporter, no_model_spend, content_flag: str
) -> None:
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", content_flag)
    requests: list[httpx.Request] = []
    db_path = seed_feedback_db(tmp_path)
    with httpx.Client(transport=_transport(requests)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, TracedFeedbackModel()), db_path)
    assert result["ok"] is True and result["linkedEvidenceCount"] == 1
    spans = in_memory_exporter.get_finished_spans()
    generations = [span for span in spans if span.name == "llm.synthetic-model"]
    assert {span.attributes["jobctrl.llm.determination_kind"] for span in generations} == {
        "message_link", "message_outcome"
    }
    for span in generations:
        assert "langfuse.observation.input" not in span.attributes
        assert "langfuse.observation.output" not in span.attributes
    assert RECIPIENT not in span_text(generations)
    assert PRIVATE_BODY not in span_text(generations)
    assert any(span.name == "gmail.message.read" for span in spans)
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM semantic_entity_bindings").fetchone()[0] == 2
        assert PRIVATE_BODY in conn.execute(
            "SELECT envelope_json FROM semantic_determinations WHERE kind='message_outcome'"
        ).fetchone()[0]


@pytest.mark.parametrize("content_flag", ["0", "1"])
def test_failed_gmail_model_call_does_not_export_source_or_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, in_memory_exporter, no_model_spend, content_flag: str
) -> None:
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", content_flag)

    class FailingOutcomeModel(TracedFeedbackModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema["title"] != "MessageOutcome":
                return super().chat_json(messages, response_schema=response_schema, **kwargs)
            with llm_generation_span(
                model="synthetic-model",
                messages=[{"role": message.role, "content": message.content} for message in messages],
                params={"structured": True},
            ):
                raise RuntimeError(PRIVATE_BODY)

    db_path = seed_feedback_db(tmp_path)
    requests: list[httpx.Request] = []
    with httpx.Client(transport=_transport(requests)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, FailingOutcomeModel()), db_path)
    assert result["ok"] is False and result["failureCode"] == "provider_error"
    spans = in_memory_exporter.get_finished_spans()
    assert PRIVATE_BODY not in span_text(spans)
    assert RECIPIENT not in span_text(spans)
    assert any(span.name == "llm.synthetic-model" and not span.status.is_ok for span in spans)
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM application_email_evidence").fetchone()[0] == 0


@pytest.mark.parametrize("transport_failure", [False, True])
def test_gmail_errors_keep_type_and_retry_headers_without_private_diagnostics(
    monkeypatch: pytest.MonkeyPatch, caplog, in_memory_exporter, transport_failure: bool
) -> None:
    monkeypatch.setattr(client_module, "get_access_token", lambda: "synthetic-token")
    caplog.set_level(logging.DEBUG, logger="httpx")
    caplog.set_level(logging.DEBUG, logger="httpcore.http11")

    def fail(request: httpx.Request) -> httpx.Response:
        logging.getLogger("httpcore.http11").debug("private transport: %s %s", RECIPIENT, PRIVATE_BODY)
        if transport_failure:
            raise httpx.ConnectError(f"{RECIPIENT} {PRIVATE_BODY}", request=request)
        return httpx.Response(503, headers={"Retry-After": "3"}, text=PRIVATE_BODY)

    with httpx.Client(transport=httpx.MockTransport(fail)) as http:
        HTTPXClientInstrumentor.instrument_client(
            http, tracer_provider=trace.get_tracer_provider(), request_hook=_scrub_url_credentials
        )
        expected_error = httpx.ConnectError if transport_failure else httpx.HTTPStatusError
        with pytest.raises(expected_error) as caught:
            GmailClient(http=http).search_feedback_emails(
                to_email=RECIPIENT,
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
                before=datetime(2026, 6, 2, tzinfo=timezone.utc),
            )
    assert RECIPIENT not in str(caught.value)
    assert RECIPIENT not in str(caught.value.request.url)
    if not transport_failure:
        assert caught.value.response.status_code == 503
        assert caught.value.response.headers["Retry-After"] == "3"
    rendered = unquote_plus(caplog.text) + span_text(in_memory_exporter.get_finished_spans())
    assert RECIPIENT not in rendered
    assert PRIVATE_BODY not in rendered
    failed_span = next(span for span in in_memory_exporter.get_finished_spans() if span.name == "gmail.feedback.search")
    assert failed_span.status.is_ok is False
    assert failed_span.attributes["error.type"] in {"HTTPStatusError", "ConnectError"}


def test_concurrent_unrelated_http_keeps_logs_and_spans(
    monkeypatch: pytest.MonkeyPatch, caplog, in_memory_exporter
) -> None:
    monkeypatch.setattr(client_module, "get_access_token", lambda: "synthetic-token")
    caplog.set_level(logging.INFO, logger="httpx")
    entered = threading.Event()
    release = threading.Event()

    def gmail(request: httpx.Request) -> httpx.Response:
        entered.set()
        assert release.wait(timeout=5)
        return httpx.Response(200, json={"messages": []})

    def run_gmail() -> list[dict]:
        with httpx.Client(transport=httpx.MockTransport(gmail)) as http:
            HTTPXClientInstrumentor.instrument_client(http, tracer_provider=trace.get_tracer_provider())
            return GmailClient(http=http).search_feedback_emails(
                to_email=RECIPIENT,
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
                before=datetime(2026, 6, 2, tzinfo=timezone.utc),
            )

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run_gmail)
        try:
            assert entered.wait(timeout=5)
            with httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(200))) as http:
                HTTPXClientInstrumentor.instrument_client(http, tracer_provider=trace.get_tracer_provider())
                http.get("https://unrelated.example/path", params={"q": "concurrent-query"})
        finally:
            release.set()
        assert future.result(timeout=5) == []
    assert "concurrent-query" in caplog.text
    rendered = span_text(in_memory_exporter.get_finished_spans())
    assert "concurrent-query" in rendered
    assert RECIPIENT not in rendered


def test_sensitive_determination_context_crosses_sdk_thread(
    monkeypatch: pytest.MonkeyPatch, in_memory_exporter, no_model_spend
) -> None:
    from jobctrl.infrastructure.llm.llm_client import _run_sync

    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", "1")

    async def generation() -> None:
        with llm_generation_span(
            model="threaded-model", messages=[{"role": "user", "content": PRIVATE_BODY}], params={}
        ) as record:
            record(PRIVATE_BODY)

    async def running_loop() -> None:
        _run_sync(generation())

    with bind_llm_lane("enrichment"), bind_determination_request("message_outcome", "a" * 64):
        asyncio.run(running_loop())
    span = next(span for span in in_memory_exporter.get_finished_spans() if span.name == "llm.threaded-model")
    assert span.attributes["jobctrl.llm.determination_kind"] == "message_outcome"
    assert "langfuse.observation.input" not in span.attributes
    assert "langfuse.observation.output" not in span.attributes
    assert PRIVATE_BODY not in span_text([span])


@pytest.mark.parametrize("content_flag", ["0", "1"])
def test_unrelated_http_and_model_tracing_keep_their_existing_behavior(
    monkeypatch: pytest.MonkeyPatch, caplog, in_memory_exporter, no_model_spend, content_flag: str
) -> None:
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", content_flag)
    caplog.set_level(logging.INFO, logger="httpx")
    with httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(200))) as http:
        HTTPXClientInstrumentor.instrument_client(
            http, tracer_provider=trace.get_tracer_provider(), request_hook=_scrub_url_credentials
        )
        http.get("https://unrelated.example/path", params={"q": "unrelated-query"})
    with bind_llm_lane("enrichment"):
        with llm_generation_span(
            model="other-model", messages=[{"role": "user", "content": "unrelated-input"}], params={}
        ) as record:
            record("unrelated-output")
    spans = in_memory_exporter.get_finished_spans()
    assert "unrelated-query" in caplog.text
    assert "unrelated-query" in span_text(spans)
    generation = next(span for span in spans if span.name == "llm.other-model")
    text = span_text([generation])
    assert ("unrelated-input" in text) is (content_flag == "1")
    assert ("unrelated-output" in text) is (content_flag == "1")
