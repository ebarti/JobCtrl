"""The registered RPC, scanner and real Gmail client share one bounded contract."""

from __future__ import annotations

import base64
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from jobctrl import config
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.rpc.messages import JsonRpcRequest
from jobctrl.infrastructure import determinations
from jobctrl.infrastructure.gmail import client as client_module
from jobctrl.infrastructure.gmail import feedback as feedback_module
from jobctrl.infrastructure.gmail.client import GmailClient, GmailFeedbackInputError
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
from tests.test_gmail_feedback import FeedbackModel, JOB_ID, RECIPIENT, seed_existing_evidence, seed_feedback_db


PRIVATE_BODY = "Synthetic private body: the project is proceeding."


class BodyCitingFeedbackModel(FeedbackModel):
    def chat_json(self, messages, *, response_schema, **kwargs):
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if response_schema["title"] == "MessageOutcome":
            result["citations"] = [{"source_id": "message", "quote": PRIVATE_BODY, "exact_values": []}]
        return result


def _rpc_server(monkeypatch, db_path: Path, http: httpx.Client, model: FeedbackModel) -> JsonRpcServer:
    monkeypatch.setattr(config, "APP_DIR", db_path.parent)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(client_module, "get_access_token", lambda: "synthetic-token")
    monkeypatch.setattr(feedback_module, "GmailClient", lambda: GmailClient(http=http))

    def dependencies(conn, **_kwargs):
        return dict(
            llm=model,
            repository=determinations.SqliteDeterminationRepository(conn),
            tenant_id="local",
            provider="synthetic",
            model="synthetic",
            lane="enrichment",
            preflight=lambda: None,
        )

    monkeypatch.setattr(determinations, "determination_dependencies", dependencies)
    server = JsonRpcServer()

    async def canceler(_run_id: str) -> None:
        return None

    register_default_handlers(server, canceler=canceler)
    return server


def _scan(server: JsonRpcServer, db_path: Path, **overrides):
    response = server.dispatch(
        JsonRpcRequest(
            method="gmail_feedback_scan",
            id=1,
            params={
                "expectedAppDir": str(db_path.parent),
                "expectedDbPath": str(db_path),
                "recipientEmail": RECIPIENT,
                "limit": 1,
                "maxResultsPerAnchor": 5,
                "windowDays": 7,
                **overrides,
            },
        )
    )
    assert response is not None
    return response.to_dict()["result"]


def _transport(requests: list[httpx.Request]):
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": "synthetic-message"}]})
        headers = [
            {"name": "From", "value": "person@unrelated.example"},
            {"name": "To", "value": RECIPIENT},
            {"name": "Subject", "value": "A neutral note"},
            {"name": "Date", "value": "Mon, 01 Jun 2026 12:00:00 +0000"},
        ]
        payload = {"id": "synthetic-message", "threadId": "synthetic-thread", "payload": {"headers": headers}}
        if request.url.params.get("format") == "metadata":
            payload["internalDate"] = "1780315200000"
        else:
            payload["payload"].update(
                mimeType="text/plain", body={"data": base64.urlsafe_b64encode(PRIVATE_BODY.encode()).decode()}
            )
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handle)


@pytest.mark.parametrize("linked", [True, False])
def test_real_rpc_client_reaches_source_bound_model_without_lexical_filter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, linked: bool
) -> None:
    db_path = seed_feedback_db(tmp_path)
    requests: list[httpx.Request] = []
    model = BodyCitingFeedbackModel(linked=linked)
    with httpx.Client(transport=_transport(requests)) as http:
        server = _rpc_server(monkeypatch, db_path, http, model)
        result = _scan(server, db_path)

        assert result["ok"] is True, result
        listing = requests[0]
        assert listing.url.path.endswith("/messages")
        assert listing.url.params["maxResults"] == "5"
        query = listing.url.params["q"]
        start = int(datetime(2026, 6, 1, 10, tzinfo=timezone.utc).timestamp())
        end = int(datetime(2026, 6, 8, 10, tzinfo=timezone.utc).timestamp())
        assert query == f'to:"{RECIPIENT}" after:{start - 1} before:{end + 1}'
        assert "application" not in query.lower() and "ExampleCo" not in query
        assert len(model.calls) == (2 if linked else 1)
        assert result["linkedEvidenceCount"] == int(linked)
        assert result["unlinkedCandidateCount"] == int(not linked)
        assert sum(req.url.params.get("format") == "full" for req in requests) == int(linked)
        assert PRIVATE_BODY not in json.dumps(result)

        if linked:
            assert result["evidence"][0]["jobId"] == JOB_ID
            repeated = _scan(server, db_path)
            assert repeated["duplicateMessageCount"] == 1
            assert repeated["linkedEvidenceCount"] == 0
            assert len(model.calls) == 2
            with sqlite3.connect(db_path) as conn:
                assert conn.execute("SELECT COUNT(*) FROM application_email_evidence").fetchone()[0] == 1
                assert conn.execute("SELECT COUNT(*) FROM application_outcome_suggestions").fetchone()[0] == 1
                bindings = conn.execute(
                    "SELECT entity_kind, entity_id, determination_kind FROM semantic_entity_bindings"
                ).fetchall()
                assert sorted(bindings) == sorted([
                    ("message", "synthetic-message", "message_link"),
                    ("outcome_suggestion", result["suggestions"][0]["suggestionId"], "message_outcome"),
                ])
                outcome = conn.execute(
                    "SELECT envelope_json FROM semantic_determinations WHERE kind='message_outcome'"
                ).fetchone()[0]
                assert PRIVATE_BODY in outcome


def test_empty_anchor_set_never_searches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = seed_feedback_db(tmp_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute("DELETE FROM jobs")
    requests: list[httpx.Request] = []
    model = FeedbackModel()
    with httpx.Client(transport=_transport(requests)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, model), db_path)
    assert result["ok"] is True
    assert result["scannedAnchorCount"] == 0
    assert requests == []
    assert model.calls == []


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"recipientEmail": 'candidate@example.com"}OR{from:other'}, "invalid_recipient"),
        ({"recipientEmail": "candidate@-invalid.example"}, "invalid_recipient"),
        ({"maxResultsPerAnchor": "not-a-number"}, "invalid_scan_options"),
    ],
)
def test_rpc_rejects_invalid_inputs_without_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, overrides: dict, code: str
) -> None:
    db_path = seed_feedback_db(tmp_path)
    requests: list[httpx.Request] = []
    with httpx.Client(transport=_transport(requests)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, FeedbackModel()), db_path, **overrides)
    assert result["ok"] is False
    assert result["failureCode"] == code
    assert requests == []
    assert str(overrides) not in json.dumps(result)


@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "gmail_auth_required"), (403, "gmail_provider_error"), (429, "gmail_rate_limited"),
     (503, "gmail_provider_unavailable")],
)
def test_rpc_reports_provider_failure_without_response_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status: int, code: str
) -> None:
    db_path = seed_feedback_db(tmp_path)
    requests: list[httpx.Request] = []

    def fail(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, text=PRIVATE_BODY)

    with httpx.Client(transport=httpx.MockTransport(fail)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, FeedbackModel()), db_path)
    assert len(requests) == 1
    assert result["ok"] is False
    assert result["failureCode"] == code
    assert result["status"] == "unavailable"
    assert PRIVATE_BODY not in json.dumps(result)


@pytest.mark.parametrize(
    ("exception_type", "code"),
    [(httpx.ReadTimeout, "gmail_timeout"), (httpx.ConnectError, "gmail_transport_error")],
)
def test_rpc_reports_transport_failure_without_exception_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, exception_type, code: str
) -> None:
    db_path = seed_feedback_db(tmp_path)

    def fail(request: httpx.Request) -> httpx.Response:
        raise exception_type(PRIVATE_BODY, request=request)

    with httpx.Client(transport=httpx.MockTransport(fail)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, FeedbackModel()), db_path)
    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["failureCode"] == code
    assert PRIVATE_BODY not in json.dumps(result)


def test_transient_provider_failure_can_be_retried_without_duplicate_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = seed_feedback_db(tmp_path)
    requests: list[httpx.Request] = []
    normal = _transport(requests)
    failed = False

    def fail_once(request: httpx.Request) -> httpx.Response:
        nonlocal failed
        if not failed and request.url.path.endswith("/messages"):
            failed = True
            return httpx.Response(503, text=PRIVATE_BODY)
        return normal.handle_request(request)

    with httpx.Client(transport=httpx.MockTransport(fail_once)) as http:
        server = _rpc_server(monkeypatch, db_path, http, BodyCitingFeedbackModel())
        first = _scan(server, db_path)
        second = _scan(server, db_path)
        third = _scan(server, db_path)
    assert first["failureCode"] == "gmail_provider_unavailable"
    assert second["ok"] is True and second["linkedEvidenceCount"] == 1
    assert third["duplicateMessageCount"] == 1
    assert PRIVATE_BODY not in json.dumps([first, second, third])
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM application_email_evidence").fetchone()[0] == 1


def test_rpc_preserves_accepted_evidence_on_model_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = seed_feedback_db(tmp_path)
    seed_existing_evidence(db_path, provider_message_id="previously-accepted")

    class UnavailableModel(FeedbackModel):
        def chat_json(self, *args, **kwargs):
            raise DeterminationFailure("provider_unavailable")

    requests: list[httpx.Request] = []
    with httpx.Client(transport=_transport(requests)) as http:
        result = _scan(_rpc_server(monkeypatch, db_path, http, UnavailableModel()), db_path)
    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["failureCode"] == "provider_unavailable"
    assert PRIVATE_BODY not in json.dumps(result)
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT provider_message_id, body_text FROM application_email_evidence").fetchall() == [
            ("previously-accepted", "existing body")
        ]


def test_client_enforces_precise_dates_and_result_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_module, "get_access_token", lambda: "synthetic-token")
    start = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
    end = datetime(2026, 6, 8, 10, 0, tzinfo=timezone.utc)
    requests: list[httpx.Request] = []
    ids = ["early", "start", "end", "late", *[f"extra-{index}" for index in range(21)]]
    dates = [int(start.timestamp() * 1000) - 1, int(start.timestamp() * 1000),
             int(end.timestamp() * 1000), int(end.timestamp() * 1000) + 1,
             *[int(start.timestamp() * 1000) - 1] * 21]

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": ident} for ident in ids]})
        ident = request.url.path.rsplit("/", 1)[1]
        return httpx.Response(200, json={"id": ident, "internalDate": str(dates[ids.index(ident)])})

    with httpx.Client(transport=httpx.MockTransport(handle)) as http:
        results = GmailClient(http=http).search_feedback_emails(
            to_email=RECIPIENT, after=start, before=end, max_results=200
        )
    assert [item["id"] for item in results] == ["start", "end"]
    assert requests[0].url.params["maxResults"] == "20"
    assert len(requests) == 21  # One listing and at most 20 metadata reads.


def test_client_rejects_invalid_date_range_before_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_module, "get_access_token", lambda: "synthetic-token")
    requests: list[httpx.Request] = []
    with httpx.Client(transport=_transport(requests)) as http:
        client = GmailClient(http=http)
        with pytest.raises(GmailFeedbackInputError):
            client.search_feedback_emails(
                to_email=RECIPIENT, after=datetime(2026, 6, 1), before=datetime(2026, 6, 2)
            )
        with pytest.raises(GmailFeedbackInputError):
            client.search_feedback_emails(
                to_email=RECIPIENT,
                after=datetime(2026, 6, 2, tzinfo=timezone.utc),
                before=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        with pytest.raises(GmailFeedbackInputError):
            client.search_feedback_emails(
                to_email=RECIPIENT,
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
                before=datetime(2026, 6, 2, tzinfo=timezone.utc),
                max_results="invalid",
            )
    assert requests == []


def test_client_rounds_metadata_bounds_inward(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_module, "get_access_token", lambda: "synthetic-token")
    start = datetime(2026, 6, 1, 10, 0, 0, 500, tzinfo=timezone.utc)
    end = datetime(2026, 6, 1, 10, 0, 0, 1500, tzinfo=timezone.utc)
    start_ms = int(start.timestamp() * 1000)
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": str(value)} for value in range(3)]})
        ident = request.url.path.rsplit("/", 1)[1]
        return httpx.Response(200, json={"id": ident, "internalDate": str(start_ms + int(ident))})

    with httpx.Client(transport=httpx.MockTransport(handle)) as http:
        client = GmailClient(http=http)
        assert [item["id"] for item in client.search_feedback_emails(
            to_email=RECIPIENT, after=start, before=end, max_results=3
        )] == ["1"]
        client.search_feedback_emails(to_email=RECIPIENT, after=start, before=end, max_results=0)
    assert requests[4].url.params["maxResults"] == "1"
