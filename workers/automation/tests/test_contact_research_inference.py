"""Structural authority and failure preservation for supervised research.

All pages, model decisions and SQLite workspaces in this file are synthetic.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from jobctrl.domain.contact import (
    ContactLink,
    ContactResearchService,
    ContactResearchSourcePolicy,
    ResearchSourceSpec,
    ResearchTaskStatus,
    RunContactResearchUseCase,
)
from jobctrl.domain.ports.contact import ResearchPageFetch
from jobctrl.domain.ports.llm import LlmFailure
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.contact import SqliteContactResearchTaskRepository
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.llm_lanes import current_llm_lane
from tests.test_contact_research_workflow import (
    _FakeFetcher,
    _FakeLlm,
    _JOB_ID,
    _SECRET_EMAIL,
    _SECRET_NAME,
    _TEAM_URL,
    _counter,
    _run_use_case,
    _setup,
)

PAGE = f"Team: {_SECRET_NAME}; contact {_SECRET_EMAIL}. Synthetic page canary PRIVATE_PAGE_BODY"
SOURCE = (ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),)


def _service(repository, preflight=lambda: None):
    return ContactResearchService(
        policy=ContactResearchSourcePolicy(domain_allowlist=("acme.example",)),
        determination_repository=SqliteDeterminationRepository(repository._conn),
        preflight=preflight,
        provider="synthetic",
        selected_model="synthetic",
    )


def _execute(repository, llm, *, task_id="task-1", preflight=lambda: None, check_cancelled=lambda: None, detailed=False):
    use_case = RunContactResearchUseCase(
        repository=repository,
        service=_service(repository, preflight),
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text=PAGE)),
        llm=llm,
        new_id=_counter(),
        check_cancelled=check_cancelled,
    )
    execute = use_case.execute_with_outcome if detailed else use_case.execute
    return execute(
        LOCAL_TENANT, task_id=task_id, link=ContactLink(employer="Acme", job_id=_JOB_ID),
        sources=SOURCE,
    )


def test_inference_opposing_decisions_bind_receipts_and_keep_contact_values_private(tmp_path):
    conn, repository, contacts = _setup(tmp_path)
    calls = []

    def preflight():
        calls.append(current_llm_lane())

    proposed_model = _FakeLlm([{"name": _SECRET_NAME, "email": _SECRET_EMAIL, "role": "recruiter"}])
    empty_model = _FakeLlm([])
    proposed = _execute(repository, proposed_model, task_id="proposed", preflight=preflight)
    empty = _execute(repository, empty_model, task_id="empty", preflight=preflight)

    assert calls == ["contact", "contact"]
    assert proposed.status is empty.status is ResearchTaskStatus.NEEDS_REVIEW
    assert proposed.source_attempts[0].outcome == "allowed"
    assert empty.source_attempts[0].outcome == "no_candidates"
    assert len(proposed.candidates) == 1 and empty.candidates == ()
    assert contacts.list_for_tenant(LOCAL_TENANT) == []
    assert {attr.value for attr in proposed.candidates[0].attributes} == {_SECRET_NAME, _SECRET_EMAIL}

    receipts = []
    for task in (proposed, empty):
        saved = repository.load(LOCAL_TENANT, task.task_id)
        receipt_id = saved.source_attempts[0].determination_id
        receipt = SqliteDeterminationRepository(conn).find(str(LOCAL_TENANT), receipt_id)
        assert receipt is not None and receipt.entity_id == task.task_id
        assert receipt.kind == "contact_research_extraction" and receipt.lane == "contact"
        assert receipt.provider == "synthetic" and receipt.model == "synthetic"
        receipts.append(receipt_id)
    assert receipts[0] != receipts[1]
    private_blobs = " ".join(str(row[0]) for row in conn.execute("SELECT envelope_json FROM semantic_determinations"))
    private_blobs += " ".join(str(row[0]) for row in conn.execute("SELECT payload_json FROM job_events"))
    for secret in (_SECRET_NAME, _SECRET_EMAIL, "PRIVATE_PAGE_BODY"):
        assert secret not in private_blobs

    # Reusing the identical accepted determination invokes neither provider nor preflight.
    repeat = _service(repository, lambda: pytest.fail("cached receipt should not spend")).research(
        tenant_id=str(LOCAL_TENANT), task_id="proposed", sources=SOURCE,
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text=PAGE)), llm=proposed_model,
        clock=lambda: "2026-01-01T00:00:00Z", new_id=_counter(),
    )
    assert repeat.source_attempts[0].determination_id == receipts[0]
    assert proposed_model.calls == 1
    conn.close()


@pytest.mark.parametrize(
    ("fault", "expected", "detail_code"),
    [
        ("provider_unavailable", "provider_unavailable", "provider_unavailable"),
        ("provider_exception", "provider_failed", "provider_error"),
        ("budget_denied", "spend_denied", "budget_denied"),
        ("malformed_json", "invalid_output", "malformed_json"),
        ("schema", "invalid_output", "schema_violation"),
        ("extra_field", "invalid_output", "schema_violation"),
        ("unknown_role", "invalid_output", "schema_violation"),
        ("warm_intro", "invalid_output", "schema_violation"),
        ("foreign_source", "invalid_output", "foreign_source_id"),
        ("foreign_root_source", "invalid_output", "foreign_source_id"),
        ("bad_span", "invalid_output", "field_binding_invalid"),
    ],
)
def test_inference_failures_persist_safe_distinct_outcomes(tmp_path, fault, expected, detail_code):
    conn, repository, contacts = _setup(tmp_path)
    events = []

    class Model:
        def chat_json(self, messages, **_kwargs):
            events.append("model")
            if fault == "provider_unavailable":
                raise LlmFailure("provider_unavailable")
            if fault == "provider_exception":
                raise RuntimeError("PRIVATE_PROMPT_CANARY")
            if fault == "malformed_json":
                raise json.JSONDecodeError("PRIVATE_PROMPT_CANARY", "secret", 0)
            source_id = json.loads(messages[1].content)["sources"][0]["source_id"]
            if fault == "schema":
                return {"source_id": source_id, "candidates": "bad"}
            if fault == "extra_field":
                return {"source_id": source_id, "candidates": [], "unexpected": "PRIVATE_PROMPT_CANARY"}
            candidate = {
                "name": {"source_id": source_id, "start": 6, "end": 6 + len(_SECRET_NAME)},
                "role": "recruiter", "confidence": 0.8,
            }
            if fault == "unknown_role":
                candidate["role"] = "unknown"
            elif fault == "warm_intro":
                candidate["role"] = "warm_intro"
            elif fault == "foreign_source":
                candidate["name"]["source_id"] = "another_page"
            elif fault == "bad_span":
                candidate["name"]["end"] = len(PAGE) + 1
            if fault == "foreign_root_source":
                source_id = "another_page"
            return {"source_id": source_id, "candidates": [candidate]}

    def preflight():
        assert current_llm_lane() == "contact"
        events.append("preflight")
        if fault == "budget_denied":
            raise RuntimeError("PRIVATE_PROMPT_CANARY")

    task = _execute(repository, Model(), preflight=preflight)
    saved = repository.load(LOCAL_TENANT, task.task_id)
    assert task.status is ResearchTaskStatus.FAILED and saved == task
    assert task.candidates == () and contacts.list_for_tenant(LOCAL_TENANT) == []
    attempt = task.source_attempts[0]
    assert attempt.outcome == task.error_class == expected
    assert detail_code in attempt.detail and attempt.determination_id is None
    assert attempt.outcome != "no_candidates"
    assert events[0] == "preflight"
    if fault == "budget_denied":
        assert events == ["preflight"]
    else:
        assert events[1] == "model"
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0
    persisted = str(conn.execute("SELECT source_attempts_json FROM contact_research_tasks").fetchone()[0])
    persisted += str(conn.execute("SELECT group_concat(payload_json) FROM job_events").fetchone()[0])
    persisted += str(conn.execute("SELECT group_concat(failure_code) FROM semantic_stage_states").fetchone()[0])
    assert "PRIVATE_PROMPT_CANARY" not in persisted and "PRIVATE_PAGE_BODY" not in persisted
    conn.close()


def test_inference_empty_page_is_not_an_accepted_empty_decision(tmp_path):
    conn, repository, _ = _setup(tmp_path)
    model = _FakeLlm([])
    task = RunContactResearchUseCase(
        repository=repository, service=_service(repository),
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="  ")),
        llm=model, new_id=_counter(),
    ).execute(LOCAL_TENANT, task_id="task-1", link=ContactLink(employer="Acme", job_id=_JOB_ID), sources=SOURCE)
    assert task.status is ResearchTaskStatus.FAILED
    assert task.source_attempts[0].outcome == "empty_content" and model.calls == 0
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0
    conn.close()


def test_inference_missing_provider_is_not_an_empty_decision(tmp_path):
    conn, repository, _ = _setup(tmp_path)
    task = _execute(repository, None, preflight=lambda: pytest.fail("no provider can spend"))
    assert task.status is ResearchTaskStatus.FAILED
    assert task.source_attempts[0].outcome == "provider_unavailable"
    assert task.source_attempts[0].determination_id is None
    conn.close()


@pytest.mark.parametrize("with_candidate", [False, True])
def test_inference_successful_retry_clears_current_error_but_retains_attempt_history(tmp_path, with_candidate):
    conn, repository, _ = _setup(tmp_path)

    class Unavailable:
        def chat_json(self, *_args, **_kwargs):
            raise LlmFailure("provider_unavailable")

    failed = _execute(repository, Unavailable())
    assert failed.status is ResearchTaskStatus.FAILED and failed.error_class == "provider_unavailable"
    repeated = _execute(repository, Unavailable())
    assert [attempt.outcome for attempt in repeated.source_attempts] == ["provider_unavailable", "provider_unavailable"]
    model = _FakeLlm([{"name": _SECRET_NAME, "role": "recruiter"}] if with_candidate else [])
    result = _execute(repository, model)
    assert result.status is ResearchTaskStatus.NEEDS_REVIEW
    assert result.error_class is None and result.failed_at is None
    expected = "allowed" if with_candidate else "no_candidates"
    assert [attempt.outcome for attempt in result.source_attempts] == ["provider_unavailable", "provider_unavailable", expected]
    assert len(result.candidates) == int(with_candidate)
    assert repository.load(LOCAL_TENANT, result.task_id) == result
    conn.close()


@pytest.mark.parametrize("cancel_at", ["preflight", "repair"])
def test_inference_cancellation_prevents_later_provider_calls(tmp_path, cancel_at):
    from threading import Event
    from temporalio.exceptions import CancelledError

    conn, repository, contacts = _setup(tmp_path)
    cancelled = Event()
    calls = []

    def check_cancelled():
        if cancelled.is_set():
            raise CancelledError()

    def preflight():
        if cancel_at == "preflight":
            cancelled.set()

    class Model:
        def chat_json(self, *_args, **_kwargs):
            calls.append("model")
            cancelled.set()
            return {"candidates": "malformed"}

    with pytest.raises(CancelledError):
        _execute(repository, Model(), preflight=preflight, check_cancelled=check_cancelled)
    task = repository.load(LOCAL_TENANT, "task-1")
    assert task.status is ResearchTaskStatus.RUNNING and task.candidates == ()
    assert task.source_attempts == () and contacts.list_for_tenant(LOCAL_TENANT) == []
    assert calls == ([] if cancel_at == "preflight" else ["model"])
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0
    assert conn.execute("SELECT failure_code FROM semantic_stage_states").fetchone()[0] == "contact_research_cancelled"
    conn.close()


def test_inference_actual_activity_records_failure_for_api_readers(tmp_path, monkeypatch):
    from jobctrl import database
    from jobctrl.contact import activities
    from jobctrl.contact.workflow import _output_to_result
    from jobctrl.infrastructure import contact as contact_infra, determinations, events

    conn, repository, _ = _setup(tmp_path)

    class FailingModel:
        def chat_json(self, *_args, **_kwargs):
            raise LlmFailure("provider_unavailable")

    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(contact_infra, "GatewayContactResearchFetcher", lambda **_kwargs: _FakeFetcher(
        ResearchPageFetch(outcome="allowed", text=PAGE),
    ))
    monkeypatch.setattr(determinations, "determination_dependencies", lambda connection, **_kwargs: {
        "llm": FailingModel(), "repository": SqliteDeterminationRepository(connection),
        "provider": "synthetic", "model": "synthetic", "preflight": lambda: None,
    })
    monkeypatch.setattr(events, "get_default_publisher", lambda: InProcessEventBus())
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)
    output = activities._run_contact_research(activities.RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="activity-task", employer="Acme", job_id=_JOB_ID,
        sources=(activities.ResearchSourceInput(category="public_web_page", url=_TEAM_URL),),
    ))
    assert output.status == "failed" and output.error_code == "provider_unavailable"
    assert _output_to_result(output).error_code == "provider_unavailable"
    saved = repository.load(LOCAL_TENANT, "activity-task")
    assert saved.source_attempts[0].outcome == "provider_unavailable" and saved.candidates == ()
    projected = conn.execute(
        "SELECT status, source_attempts_json FROM contact_research_task_projections WHERE task_id = ?",
        ("activity-task",),
    ).fetchone()
    assert projected["status"] == "failed"
    assert json.loads(projected["source_attempts_json"])[0]["outcome"] == "provider_unavailable"
    conn.close()


def test_inference_activity_reports_overlap_failure_while_winning_review_survives(tmp_path, monkeypatch):
    from jobctrl import database
    from jobctrl.contact import activities
    from jobctrl.infrastructure import contact as contact_infra, determinations, events

    conn, repository, _ = _setup(tmp_path)
    peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=1)
    peer.row_factory = sqlite3.Row
    peer_repo = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())
    accepted = []

    class OverlappingModel:
        def chat_json(self, *_args, **_kwargs):
            accepted.append(_run_use_case(
                peer_repo, fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person")),
                llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=SOURCE,
            ))
            raise LlmFailure("provider_unavailable")

    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(contact_infra, "GatewayContactResearchFetcher", lambda **_kwargs: _FakeFetcher(
        ResearchPageFetch(outcome="allowed", text=PAGE),
    ))
    monkeypatch.setattr(determinations, "determination_dependencies", lambda connection, **_kwargs: {
        "llm": OverlappingModel(), "repository": SqliteDeterminationRepository(connection),
        "provider": "synthetic", "model": "synthetic", "preflight": lambda: None,
    })
    monkeypatch.setattr(events, "get_default_publisher", lambda: InProcessEventBus())
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)
    try:
        output = activities._run_contact_research(activities.RunContactResearchActivityInput(
            tenant_id=str(LOCAL_TENANT), task_id="task-1", employer="Acme", job_id=_JOB_ID,
            sources=(activities.ResearchSourceInput(category="public_web_page", url=_TEAM_URL),),
        ))
        saved = repository.load(LOCAL_TENANT, "task-1")
        assert output.status == "failed" and output.error_code == "provider_unavailable"
        assert output.candidate_count == 1
        assert saved.status is ResearchTaskStatus.NEEDS_REVIEW and saved.candidates == accepted[0].candidates
        assert [attempt.outcome for attempt in saved.source_attempts] == ["allowed", "provider_unavailable"]
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactResearchSourceAttemptFailed'"
        ).fetchone()[0] == 1
    finally:
        peer.close()
        conn.close()


def test_inference_success_keeps_failure_recorded_by_an_overlapping_attempt(tmp_path):
    conn, repository, _ = _setup(tmp_path)
    peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=1)
    peer.row_factory = sqlite3.Row
    peer_repo = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())

    class Failure:
        def chat_json(self, *_args, **_kwargs):
            raise LlmFailure("provider_unavailable")

    class WinningModel:
        def chat_json(self, messages, **kwargs):
            failed = RunContactResearchUseCase(
                repository=peer_repo, service=_service(peer_repo),
                fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Another synthetic page")),
                llm=Failure(), new_id=_counter(),
            ).execute(LOCAL_TENANT, task_id="task-1", link=ContactLink(employer="Acme", job_id=_JOB_ID), sources=SOURCE)
            assert failed.status is ResearchTaskStatus.FAILED
            return _FakeLlm([{"name": _SECRET_NAME, "role": "recruiter"}]).chat_json(messages, **kwargs)

    try:
        result = _execute(repository, WinningModel())
        saved = repository.load(LOCAL_TENANT, "task-1")
        assert saved == result and saved.status is ResearchTaskStatus.NEEDS_REVIEW
        assert saved.error_class is None and saved.failed_at is None
        assert [attempt.outcome for attempt in saved.source_attempts] == ["provider_unavailable", "allowed"]
        assert len(saved.candidates) == 1
    finally:
        peer.close()
        conn.close()


def test_inference_two_overlapping_failures_each_refresh_the_failed_review(tmp_path):
    conn, repository, contacts = _setup(tmp_path)
    peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=1)
    peer.row_factory = sqlite3.Row
    peer_repo = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())

    class Failure:
        def chat_json(self, *_args, **_kwargs):
            raise LlmFailure("provider_unavailable")

    class OuterFailure:
        def chat_json(self, *_args, **_kwargs):
            peer_task = RunContactResearchUseCase(
                repository=peer_repo, service=_service(peer_repo),
                fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Another synthetic page")),
                llm=Failure(), new_id=_counter(),
            ).execute(LOCAL_TENANT, task_id="task-1", link=ContactLink(employer="Acme", job_id=_JOB_ID), sources=SOURCE)
            assert peer_task.status is ResearchTaskStatus.FAILED
            raise LlmFailure("provider_unavailable")

    try:
        task = _execute(repository, OuterFailure())
        assert task.status is ResearchTaskStatus.FAILED and task.candidates == ()
        assert [attempt.outcome for attempt in task.source_attempts] == ["provider_unavailable", "provider_unavailable"]
        assert contacts.list_for_tenant(LOCAL_TENANT) == []
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactResearchTaskFailed'"
        ).fetchone()[0] == 2
    finally:
        peer.close()
        conn.close()


def test_inference_failure_event_write_is_atomic_with_appended_attempt(tmp_path):
    conn, repository, _ = _setup(tmp_path)
    peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=1)
    peer.row_factory = sqlite3.Row
    peer_repo = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())
    conn.execute("""
        CREATE TRIGGER refuse_synthetic_attempt_event BEFORE INSERT ON job_events
        WHEN NEW.event_type = 'ContactResearchSourceAttemptFailed'
        BEGIN SELECT RAISE(ABORT, 'synthetic event write failure'); END
    """)
    conn.commit()
    accepted = []

    class FailingModel:
        def chat_json(self, *_args, **_kwargs):
            accepted.append(_run_use_case(
                peer_repo, fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person")),
                llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=SOURCE,
            ))
            raise LlmFailure("provider_unavailable")

    try:
        with pytest.raises(sqlite3.IntegrityError, match="synthetic event write failure"):
            _execute(repository, FailingModel(), detailed=True)
        saved = repository.load(LOCAL_TENANT, "task-1")
        assert saved == accepted[0]
        assert [attempt.outcome for attempt in saved.source_attempts] == ["allowed"]
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactResearchSourceAttemptFailed'"
        ).fetchone()[0] == 0
    finally:
        peer.close()
        conn.close()


def test_inference_failed_inflight_refresh_preserves_accepted_review_and_records_failure(tmp_path):
    conn, repository, contacts = _setup(tmp_path)
    peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=1)
    peer.row_factory = sqlite3.Row
    peer_repo = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())
    accepted = []
    accepted_rows = []
    observed = []

    def observe(_event):
        row = peer.execute(
            "SELECT source_attempts_json FROM contact_research_tasks WHERE tenant_id = ? AND task_id = ?",
            (str(LOCAL_TENANT), "task-1"),
        ).fetchone()
        observed.append(json.loads(row[0])[-1]["outcome"])

    repository._publisher.subscribe("ContactResearchSourceAttemptFailed", observe)

    class FailingModel:
        def chat_json(self, *_args, **_kwargs):
            accepted.append(_run_use_case(
                peer_repo,
                fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person at Acme")),
                llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=SOURCE,
            ))
            accepted_rows.append(tuple(peer.execute(
                "SELECT candidate_id, role, attributes_json, status, confirmed_contact_id, confirmed_at "
                "FROM contact_candidates WHERE tenant_id = ? AND task_id = ?",
                (str(LOCAL_TENANT), "task-1"),
            ).fetchone()))
            raise LlmFailure("provider_unavailable")

    try:
        execution = _execute(repository, FailingModel(), detailed=True)
        result = execution.task
        assert execution.attempt_failure == "provider_unavailable"
        saved = repository.load(LOCAL_TENANT, "task-1")
        prior = accepted[0]
        assert prior.status is ResearchTaskStatus.NEEDS_REVIEW and len(prior.candidates) == 1
        assert result == saved
        assert saved.status == prior.status and saved.candidates == prior.candidates
        assert saved.needs_review_at == prior.needs_review_at and saved.completed_at == prior.completed_at
        assert saved.source_attempts[:-1] == prior.source_attempts
        assert saved.source_attempts[-1].outcome == "provider_unavailable"
        assert tuple(conn.execute(
            "SELECT candidate_id, role, attributes_json, status, confirmed_contact_id, confirmed_at "
            "FROM contact_candidates WHERE tenant_id = ? AND task_id = ?",
            (str(LOCAL_TENANT), "task-1"),
        ).fetchone()) == accepted_rows[0]
        assert contacts.list_for_tenant(LOCAL_TENANT) == []
        event = conn.execute(
            "SELECT payload_json FROM job_events WHERE event_type = 'ContactResearchSourceAttemptFailed'"
        ).fetchone()
        assert event is not None
        payload = json.loads(event[0])
        assert payload["taskId"] == "task-1" and payload["outcome"] == "provider_unavailable"
        assert observed == ["provider_unavailable"]
        assert "PRIVATE_PAGE_BODY" not in event[0] and _SECRET_NAME not in event[0] and _SECRET_EMAIL not in event[0]
        projected = conn.execute(
            "SELECT source_attempts_json FROM contact_research_task_projections WHERE task_id = 'task-1'"
        ).fetchone()
        assert json.loads(projected[0])[-1]["outcome"] == "provider_unavailable"
    finally:
        peer.close()
        conn.close()
