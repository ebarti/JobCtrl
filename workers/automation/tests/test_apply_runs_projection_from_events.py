"""PR 4: ``apply_run_projections`` is sourced from ``job_events`` after
the ``apply_runs`` table is dropped.

The projector watches for the apply lifecycle events the launcher /
``SubmitApplicationUseCase`` emit:

  * ``ApplyRunStarted``       — opens a row (status="starting").
  * ``ApplyRunInProgress``    — flips to ``in_progress``.
  * ``ApplicationSubmitted``  — terminal, status="succeeded".
  * ``ApplicationFailed``     — terminal, status="failed" (or the
                                specific submission_result kind).
  * ``DryRunCompleted``       — terminal, status="dry_run_complete".

Every event payload includes a ``run_id`` so the projector can key
multiple events under one row.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import record_job_event, utc_now


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(
    conn: sqlite3.Connection,
    job_id: JobId,
    url: str,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site, strategy, location, salary,
                          discovered_at, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            url,
            "Eng",
            "ExampleCo",
            "jobspy",
            "Remote",
            "",
            utc_now(),
            "x",
        ),
    )
    conn.execute(
        "INSERT INTO job_enrichments(tenant_id,job_id,current_status,application_url,updated_at) "
        "VALUES (?,?,'pending',?,?)",
        (str(tenant_id), str(job_id), url, utc_now()),
    )


def _row_value(row, key, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return value if value is not None else default


def test_started_event_opens_row(conn: sqlite3.Connection) -> None:
    job_id = JobId("00000000-0000-4000-8000-000000000101")
    url = "https://example.com/job"
    _seed_job(conn, job_id, url)
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-1",
            "model": "haiku",
            "dry_run": False,
            "worker_id": 7,
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-1",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "starting"
    assert _row_value(row, "job_id") == str(job_id)
    assert _row_value(row, "model") == "haiku"
    assert _row_value(row, "worker_id") == 7
    assert _row_value(row, "started_at") == "2026-05-04T13:00:00+00:00"


def test_submitted_event_terminates_row_as_succeeded(
    conn: sqlite3.Connection,
) -> None:
    job_id = JobId("00000000-0000-4000-8000-000000000102")
    url = "https://example.com/job-applied"
    _seed_job(conn, job_id, url)
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-2",
            "model": "haiku",
            "dry_run": False,
            "worker_id": 1,
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationSubmitted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-2",
            "finished_at": "2026-05-04T13:05:00+00:00",
            "duration_ms": 300_000,
            "result": "applied",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-2",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "succeeded"
    assert _row_value(row, "result") == "applied"
    assert _row_value(row, "finished_at") == "2026-05-04T13:05:00+00:00"
    assert _row_value(row, "duration_ms") == 300_000


def test_failed_event_terminates_row_as_failed(conn: sqlite3.Connection) -> None:
    job_id = JobId("00000000-0000-4000-8000-000000000103")
    url = "https://example.com/job-failed"
    _seed_job(conn, job_id, url)
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-3",
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationFailed",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-3",
            "finished_at": "2026-05-04T13:02:00+00:00",
            "result": "failed",
            "error": "boom",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-3",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "failed"
    assert _row_value(row, "result") == "failed"
    assert _row_value(row, "finished_at") == "2026-05-04T13:02:00+00:00"


def test_dry_run_completed_event_terminates_row(conn: sqlite3.Connection) -> None:
    job_id = JobId("00000000-0000-4000-8000-000000000104")
    url = "https://example.com/job-dry"
    _seed_job(conn, job_id, url)
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-4",
            "dry_run": True,
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "DryRunCompleted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-4",
            "finished_at": "2026-05-04T13:01:00+00:00",
            "result": "dry_run_complete",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?", ("run-4",)
    ).fetchone()
    assert row is not None
    assert _row_value(row, "status") == "dry_run_complete"
    assert _row_value(row, "dry_run") == 1


def test_event_timeline_collected_per_run(conn: sqlite3.Connection) -> None:
    job_id = JobId("00000000-0000-4000-8000-000000000105")
    url = "https://example.com/job-events"
    _seed_job(conn, job_id, url)
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={"run_id": "run-5", "started_at": "t0"},
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunEvent",
        tenant_id=LOCAL_TENANT,
        payload={"run_id": "run-5", "step": "form_filled"},
        message="Filled application form",
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationSubmitted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-5",
            "finished_at": "t9",
            "result": "applied",
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT events_json FROM apply_run_projections WHERE run_id = ?",
        ("run-5",),
    ).fetchone()
    assert row is not None
    events = json.loads(_row_value(row, "events_json", "[]"))
    # All three apply-stage events are surfaced in chronological order.
    types = [event.get("event_type") for event in events]
    assert types == ["ApplyRunStarted", "ApplyRunEvent", "ApplicationSubmitted"]


def test_projection_rebuild_is_deterministic(conn: sqlite3.Connection) -> None:
    """Running the projector twice produces the same row state — no
    duplicates, no churn."""
    job_id = JobId("00000000-0000-4000-8000-000000000106")
    url = "https://example.com/job-deterministic"
    _seed_job(conn, job_id, url)
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-6",
            "started_at": "2026-05-04T13:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationSubmitted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-6",
            "finished_at": "2026-05-04T13:05:00+00:00",
            "result": "applied",
        },
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    row_first = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?",
        ("run-6",),
    ).fetchone()
    assert row_first is not None
    builder.refresh()
    rows_after = conn.execute(
        "SELECT * FROM apply_run_projections WHERE run_id = ?",
        ("run-6",),
    ).fetchall()
    assert len(rows_after) == 1
    # Status / result identical across refreshes.
    assert _row_value(rows_after[0], "status") == _row_value(row_first, "status")
    assert _row_value(rows_after[0], "finished_at") == _row_value(
        row_first, "finished_at"
    )


def test_apply_runs_are_isolated_by_tenant(conn: sqlite3.Connection) -> None:
    shared_job_id = JobId("00000000-0000-4000-8000-000000000107")
    other_tenant = TenantId("other")
    _seed_job(conn, shared_job_id, "https://example.com/job-local")
    _seed_job(
        conn,
        shared_job_id,
        "https://example.com/job-other",
        tenant_id=other_tenant,
    )
    for tenant_id, run_id in ((LOCAL_TENANT, "local-run"), (other_tenant, "other-run")):
        record_job_event(
            conn,
            shared_job_id,
            "apply",
            "ApplyRunStarted",
            tenant_id=tenant_id,
            payload={"run_id": run_id, "started_at": "2026-05-04T13:00:00+00:00"},
        )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    local_rows = conn.execute(
        "SELECT run_id, tenant_id, job_id FROM apply_run_projections ORDER BY run_id"
    ).fetchall()
    assert [tuple(row) for row in local_rows] == [
        ("local-run", str(LOCAL_TENANT), str(shared_job_id))
    ]

    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=other_tenant).refresh()
    other_rows = conn.execute(
        "SELECT run_id, tenant_id, job_id FROM apply_run_projections ORDER BY run_id"
    ).fetchall()
    assert [tuple(row) for row in other_rows] == [
        ("local-run", str(LOCAL_TENANT), str(shared_job_id)),
        ("other-run", str(other_tenant), str(shared_job_id)),
    ]


@pytest.mark.parametrize('late_status,intended,expected', [
    ('applied', True, ('manual', 'needs_verification')),
    ('dry_run', True, ('manual', 'needs_verification')),
    ('manual', True, ('manual', 'needs_verification')),
    ('dry_run', False, ('dry_run_complete', 'dry_run_complete')),
    ('failed', False, ('failed', 'failed')),
    ('failed', True, ('manual', 'needs_verification')),
])
def test_late_settlement_projects_original_outcome_without_clearing_skip(conn, late_status, intended, expected):
    from jobctrl.apply.launcher import mark_result
    from jobctrl.state import ensure_job_stage_rows, set_stage_state
    from unittest.mock import patch
    job_id = JobId('00000000-0000-4000-8000-000000000108')
    _seed_job(conn, job_id, 'https://example.test/late')
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(conn, job_id, 'apply', 'skipped', attempt_count=2, retryable=False, validate_transition=False)
    record_job_event(conn, job_id, 'apply', 'ApplyRunStarted', payload={'run_id': 'original'})
    record_job_event(conn, job_id, 'apply', 'StageSkipped', payload={'manualDisposition': 'skip', 'previousState': 'running'})
    if intended:
        record_job_event(conn, job_id, 'apply', 'ApplySubmitIntended', payload={'run_id': 'original'})
    if late_status == 'applied':
        record_job_event(conn, job_id, 'apply', 'EmailApplicationSent', payload={'run_id': 'original', 'message_id': 'owned-message'})
    conn.commit()
    before = tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone())
    with patch('jobctrl.apply.launcher.get_connection', lambda: conn):
        mark_result(job_id, late_status, run_ctx={'run_id': 'original'})
        mark_result(job_id, late_status, run_ctx={'run_id': 'original'})
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='original'").fetchone()) == expected
    assert tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()) == before
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='LockReleased'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationSubmitted'").fetchone()[0] == 0


@pytest.mark.parametrize('late_status', ['applied', 'dry_run', 'failed', 'manual'])
@pytest.mark.parametrize('receipt_kind', ['exact', 'missing', 'unbound', 'wrong_operation', 'wrong_run', 'wrong_job', 'wrong_tenant', 'wrong_stage', 'empty_message', 'wrong_channel'])
def test_late_intent_requires_exact_receipt_despite_conflicting_terminal(conn, late_status, receipt_kind):
    from unittest.mock import patch
    from jobctrl.apply.launcher import mark_result
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    job = JobId('00000000-0000-4000-8000-000000000117')
    peer = JobId('00000000-0000-4000-8000-000000000118')
    _seed_job(conn, job, 'https://example.test/receipt-target')
    _seed_job(conn, peer, 'https://example.test/receipt-peer')
    if receipt_kind == 'wrong_tenant':
        _seed_job(conn, job, 'https://example.test/foreign', tenant_id=TenantId('other'))
    ensure_job_stage_rows(conn, job)
    ensure_job_stage_rows(conn, peer)
    set_stage_state(conn, job, 'apply', 'skipped', attempt_count=2, retryable=False, validate_transition=False)
    set_stage_state(conn, peer, 'apply', 'running', attempt_count=1, validate_transition=False)
    record_job_event(conn, peer, 'apply', 'ApplyClaimAcquired', payload={'run_id': 'peer-run', 'launcher_id': 'peer-launcher'})
    record_job_event(conn, peer, 'apply', 'ApplyRunStarted', payload={'run_id': 'peer-run'})
    operation = {'tenant_id': 'local', 'job_id': str(job), 'run_id': 'original', 'intent_id': 'email:original',
                 'material_version': '1', 'candidate_fingerprint': 'synthetic-fingerprint'}
    record_job_event(conn, job, 'apply', 'ApplyRunStarted', payload={'run_id': 'original'})
    record_job_event(conn, job, 'apply', 'ApplySubmitIntended', payload={
        'run_id': 'original', 'submission_channel': 'browser' if receipt_kind == 'wrong_channel' else 'email', 'operation': operation,
    })
    record_job_event(conn, job, 'apply', 'StageSkipped', payload={'manualDisposition': 'skip', 'previousState': 'running'})
    if receipt_kind != 'missing':
        receipt = {'run_id': 'original', 'provider': 'gmail', 'message_id': 'synthetic-message',
                   'thread_id': None, 'operation': dict(operation)}
        if receipt_kind == 'unbound':
            receipt.pop('operation')
        elif receipt_kind == 'wrong_operation':
            receipt['operation']['candidate_fingerprint'] = 'other-fingerprint'
        elif receipt_kind == 'wrong_run':
            receipt['run_id'] = 'other-run'
        elif receipt_kind == 'empty_message':
            receipt['message_id'] = ''
        receipt_job = peer if receipt_kind == 'wrong_job' else job
        receipt_tenant = TenantId('other') if receipt_kind == 'wrong_tenant' else LOCAL_TENANT
        record_job_event(conn, receipt_job, 'score' if receipt_kind == 'wrong_stage' else 'apply',
                         'EmailApplicationSent', tenant_id=receipt_tenant, payload=receipt)
    if receipt_kind != 'exact':
        # A same-run terminal claim cannot turn an unbound receipt into proof.
        terminal = 'DryRunCompleted' if late_status == 'dry_run' else 'ApplicationSubmitted'
        record_job_event(conn, job, 'apply', terminal, payload={'run_id': 'original', 'result': 'dry_run_complete' if late_status == 'dry_run' else 'applied'})
    conn.commit()
    stage_before = tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job,)).fetchone())
    peer_before = [tuple(row) for row in conn.execute("SELECT * FROM job_events WHERE tenant_id='local' AND job_id=? ORDER BY event_id", (peer,))]
    peer_stage = tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (peer,)).fetchone())
    with patch('jobctrl.apply.launcher.get_connection', lambda: conn):
        mark_result(job, late_status, run_ctx={'run_id': 'original'})
        mark_result(job, late_status, run_ctx={'run_id': 'original'})
    release = conn.execute("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='LockReleased'", (job,)).fetchone()
    assert json.loads(release[0])['late_status'] == ('applied' if receipt_kind == 'exact' else 'needs_verification')
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    expected = ('succeeded', 'applied') if receipt_kind == 'exact' else ('manual', 'needs_verification')
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='original'").fetchone()) == expected
    assert tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job,)).fetchone()) == stage_before
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_events WHERE tenant_id='local' AND job_id=? ORDER BY event_id", (peer,))] == peer_before
    assert tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (peer,)).fetchone()) == peer_stage


@pytest.mark.parametrize('state', ['running', 'skipped'])
@pytest.mark.parametrize('status', ['applied', 'dry_run'])
@pytest.mark.parametrize('receipt_kind', [
    'before', 'after', 'before_and_after', 'duplicate_receipt', 'duplicate_intent',
    'forged_operation', 'unbound', 'wrong_run', 'wrong_job', 'wrong_tenant', 'wrong_stage',
])
def test_mark_result_requires_receipt_after_unique_intent_for_repeat_evidence(tmp_path, monkeypatch, state, status, receipt_kind):
    from jobctrl.apply import launcher
    from jobctrl.database import get_connection
    from jobctrl.domain.apply.repeat_application import evaluate_repeat_application
    from jobctrl.infrastructure.apply_controls import APPLY_ADMISSIBLE_SQL, APPLY_SUBMIT_INTENT_SQL
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    db_path = tmp_path / 'receipt-order.db'
    conn = init_db(db_path)
    monkeypatch.setattr(launcher, 'get_connection', lambda: get_connection(db_path))
    job = JobId('00000000-0000-4000-8000-000000000191')
    peer = JobId('00000000-0000-4000-8000-000000000192')
    try:
        _seed_job(conn, job, 'https://example.test/receipt-order')
        _seed_job(conn, peer, 'https://example.test/receipt-order-peer')
        if receipt_kind == 'wrong_tenant':
            _seed_job(conn, job, 'https://example.test/receipt-order-foreign', tenant_id=TenantId('other'))
        for candidate in (job, peer):
            ensure_job_stage_rows(conn, candidate)
            set_stage_state(conn, candidate, 'apply', 'running', attempt_count=1, validate_transition=False)
        record_job_event(conn, peer, 'apply', 'ApplyClaimAcquired', payload={'run_id': 'peer-run', 'launcher_id': 'peer-launcher'})
        record_job_event(conn, peer, 'apply', 'ApplyRunStarted', payload={'run_id': 'peer-run'})
        record_job_event(conn, job, 'apply', 'ApplyRunStarted', payload={'run_id': 'original'})
        operation = {'tenant_id': 'local', 'job_id': str(job), 'run_id': 'original', 'intent_id': 'email:original',
                     'material_version': '1', 'candidate_fingerprint': 'synthetic-fingerprint'}
        intent = {'run_id': 'original', 'submission_channel': 'email', 'operation': operation}
        receipt = {'run_id': 'original', 'provider': 'gmail', 'message_id': 'synthetic-message',
                   'thread_id': None, 'operation': dict(operation)}
        if receipt_kind in {'before', 'before_and_after'}:
            record_job_event(conn, job, 'apply', 'EmailApplicationSent', payload=receipt)
        record_job_event(conn, job, 'apply', 'ApplySubmitIntended', payload=intent)
        if receipt_kind == 'duplicate_intent':
            record_job_event(conn, job, 'apply', 'ApplySubmitIntended', payload=intent)
        if state == 'skipped':
            set_stage_state(conn, job, 'apply', 'skipped', retryable=False, validate_transition=False)
            record_job_event(conn, job, 'apply', 'StageSkipped', payload={'manualDisposition': 'skip', 'previousState': 'running'})
        if receipt_kind != 'before':
            if receipt_kind == 'forged_operation':
                receipt['operation']['candidate_fingerprint'] = 'other-fingerprint'
            elif receipt_kind == 'unbound':
                receipt.pop('operation')
            elif receipt_kind == 'wrong_run':
                receipt['run_id'] = 'other-run'
            receipt_job = peer if receipt_kind == 'wrong_job' else job
            receipt_tenant = TenantId('other') if receipt_kind == 'wrong_tenant' else LOCAL_TENANT
            record_job_event(conn, receipt_job, 'score' if receipt_kind == 'wrong_stage' else 'apply',
                             'EmailApplicationSent', tenant_id=receipt_tenant, payload=receipt)
            if receipt_kind == 'duplicate_receipt':
                record_job_event(conn, job, 'apply', 'EmailApplicationSent', payload=receipt)
        conn.commit()
        peer_events = [tuple(row) for row in conn.execute('SELECT * FROM job_events WHERE job_id=? ORDER BY event_id', (peer,))]
        peer_stage = tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (peer,)).fetchone())
        intent_events = [tuple(row) for row in conn.execute("SELECT * FROM job_events WHERE tenant_id='local' AND job_id=? AND event_type='ApplySubmitIntended' ORDER BY event_id", (job,))]
        stage_before = tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job,)).fetchone())
        expected_confirmed = receipt_kind in {'after', 'before_and_after', 'duplicate_receipt'}
        original_confirmation = launcher._has_email_confirmation
        lock_checks = []
        def check_writer_lock(current, *args):
            assert current.in_transaction
            with sqlite3.connect(db_path, timeout=0) as competitor:
                with pytest.raises(sqlite3.OperationalError, match='locked'):
                    competitor.execute('BEGIN IMMEDIATE')
            lock_checks.append(True)
            return original_confirmation(current, *args)
        monkeypatch.setattr(launcher, '_has_email_confirmation', check_writer_lock)
        launcher.mark_result(job, status, run_ctx={'run_id': 'original'})
        if receipt_kind != 'duplicate_intent' or state == 'skipped':
            assert lock_checks
        submitted = conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id=? AND event_type='ApplicationSubmitted'", (job,)).fetchone()[0]
        assert submitted == int(expected_confirmed)
        evaluation = evaluate_repeat_application(conn, target_job_id=job, record_audit=False)
        assert evaluation['status'] == ('blocked' if expected_confirmed else 'clear')
        assert bool(evaluation['matches']) is expected_confirmed
        stage_after = tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job,)).fetchone())
        if state == 'skipped':
            assert stage_after == stage_before
            release = conn.execute("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='LockReleased'", (job,)).fetchone()
            assert json.loads(release[0])['late_status'] == ('applied' if expected_confirmed else 'needs_verification')
        else:
            assert stage_after[0] == ('succeeded' if expected_confirmed else 'needs_verification')
        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        if state == 'skipped':
            expected_projection = ('succeeded', 'applied') if expected_confirmed else ('manual', 'needs_verification')
            assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='original'").fetchone()) == expected_projection
        close_connection(db_path)
        conn = get_connection(db_path)
        launcher.mark_result(job, status, run_ctx={'run_id': 'original'})
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id=? AND event_type='ApplicationSubmitted'", (job,)).fetchone()[0] == submitted
        assert evaluate_repeat_application(conn, target_job_id=job, record_audit=False)['status'] == ('blocked' if expected_confirmed else 'clear')
        # "clear" means no confirmed application fact, never permission to
        # retry an operation whose durable intent remains unresolved.
        controls = conn.execute(
            f"SELECT ({APPLY_SUBMIT_INTENT_SQL}), ({APPLY_ADMISSIBLE_SQL}) FROM jobs WHERE tenant_id='local' AND job_id=?", (job,),
        ).fetchone()
        assert tuple(controls) == (1, 0)
        assert [tuple(row) for row in conn.execute("SELECT * FROM job_events WHERE tenant_id='local' AND job_id=? AND event_type='ApplySubmitIntended' ORDER BY event_id", (job,))] == intent_events
        assert tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (job,)).fetchone()) == stage_after
        assert [tuple(row) for row in conn.execute('SELECT * FROM job_events WHERE job_id=? ORDER BY event_id', (peer,))] == peer_events
        assert tuple(conn.execute("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'", (peer,)).fetchone()) == peer_stage
    finally:
        close_connection(db_path)


@pytest.mark.parametrize('receipt_run', [None, 'other-run', 'other-job'])
def test_late_applied_without_matching_recorded_send_remains_uncertain(conn, receipt_run):
    job_id = JobId('00000000-0000-4000-8000-000000000109')
    _seed_job(conn, job_id, 'https://example.test/unconfirmed')
    record_job_event(conn, job_id, 'apply', 'ApplyRunStarted', payload={'run_id': 'original'})
    if receipt_run:
        receipt_job = job_id
        if receipt_run == 'other-job':
            receipt_job = JobId('00000000-0000-4000-8000-000000000112')
            _seed_job(conn, receipt_job, 'https://example.test/foreign')
        record_job_event(conn, receipt_job, 'apply', 'EmailApplicationSent', payload={'run_id': 'original' if receipt_run == 'other-job' else receipt_run})
    record_job_event(conn, job_id, 'apply', 'LockReleased', payload={'run_id': 'original', 'stage_preserved': True, 'late_status': 'applied'})
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='original'").fetchone()) == ('manual', 'needs_verification')


@pytest.mark.parametrize('terminal,payload,expected', [
    ('ApplicationSubmitted', {}, ('succeeded', 'applied')),
    ('ApplicationFailed', {'result': {'kind': 'captcha'}}, ('captcha', 'captcha')),
    ('DryRunCompleted', {}, ('dry_run_complete', 'dry_run_complete')),
    ('ApplyManualSkip', {}, ('manual', 'manual')),
])
def test_late_cleanup_preserves_previously_recorded_terminal_outcome(conn, terminal, payload, expected):
    job_id = JobId('00000000-0000-4000-8000-000000000110')
    _seed_job(conn, job_id, 'https://example.test/terminal')
    record_job_event(conn, job_id, 'apply', 'ApplyRunStarted', payload={'run_id': 'original'})
    record_job_event(conn, job_id, 'apply', terminal, payload={'run_id': 'original', **payload})
    record_job_event(conn, job_id, 'apply', 'LockReleased', payload={'run_id': 'original', 'stage_preserved': True, 'late_status': 'failed'})
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='original'").fetchone()) == expected


@pytest.mark.parametrize('fail_refresh', [False, True])
@pytest.mark.parametrize('caller_owned', [False, True])
def test_existing_late_outcome_projection_repairs_without_new_events_atomically(conn, monkeypatch, fail_refresh, caller_owned):
    job_id = JobId('00000000-0000-4000-8000-000000000111')
    _seed_job(conn, job_id, 'https://example.test/restored')
    record_job_event(conn, job_id, 'apply', 'ApplyRunStarted', payload={'run_id': 'old'})
    record_job_event(conn, job_id, 'apply', 'ApplySubmitIntended', payload={'run_id': 'old'})
    record_job_event(conn, job_id, 'apply', 'EmailApplicationSent', payload={'run_id': 'old'})
    record_job_event(conn, job_id, 'apply', 'LockReleased', payload={'run_id': 'old', 'stage_preserved': True, 'late_status': 'applied'})
    conn.commit()
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    conn.execute("UPDATE apply_run_projections SET status='failed',result='failed' WHERE run_id='old'")
    conn.execute("DELETE FROM projection_backfills WHERE name='late_apply_settlement_v3:local'")
    conn.commit()
    events = [tuple(r) for r in conn.execute('SELECT * FROM job_events')]
    rebuild = builder._rebuild_apply_runs
    if caller_owned:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("UPDATE jobs SET title='Caller edit' WHERE job_id=?", (job_id,))
    if fail_refresh:
        def fail_after_projection():
            rebuild()
            raise RuntimeError('synthetic backfill failure')
        monkeypatch.setattr(builder, '_rebuild_apply_runs', fail_after_projection)
        with pytest.raises(RuntimeError, match='synthetic backfill failure'):
            builder.refresh()
        assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='old'").fetchone()) == ('failed', 'failed')
        assert conn.execute("SELECT 1 FROM projection_backfills WHERE name='late_apply_settlement_v3:local'").fetchone() is None
        monkeypatch.setattr(builder, '_rebuild_apply_runs', rebuild)
    builder.refresh()
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='old'").fetchone()) == ('manual', 'needs_verification')
    assert [tuple(r) for r in conn.execute('SELECT * FROM job_events')] == events
    if caller_owned:
        assert conn.in_transaction
        assert conn.execute('SELECT title FROM jobs WHERE job_id=?', (job_id,)).fetchone()[0] == 'Caller edit'
        conn.rollback()
        assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='old'").fetchone()) == ('failed', 'failed')
        assert conn.execute("SELECT 1 FROM projection_backfills WHERE name='late_apply_settlement_v3:local'").fetchone() is None
        builder.refresh()
    assert builder.refresh() == 0


def test_late_outcome_backfill_is_tenant_scoped(conn):
    job_id = JobId('00000000-0000-4000-8000-000000000113')
    for tenant in [LOCAL_TENANT, TenantId('other')]:
        _seed_job(conn, job_id, f'https://example.test/{tenant}', tenant_id=tenant)
        for event_type, extra in [
            ('ApplyRunStarted', {}), ('EmailApplicationSent', {}),
            ('LockReleased', {'late_status': 'applied', 'stage_preserved': True}),
        ]:
            record_job_event(conn, job_id, 'apply', event_type, tenant_id=tenant,
                             payload={'run_id': f'old-{tenant}', **extra})
    conn.commit()
    for tenant in [LOCAL_TENANT, TenantId('other')]:
        ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant).refresh()
    conn.execute("UPDATE apply_run_projections SET status='failed',result='failed'")
    conn.execute("DELETE FROM projection_backfills WHERE name LIKE 'late_apply_settlement_v3:%'")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='old-local'").fetchone()) == ('manual', 'needs_verification')
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='old-other'").fetchone()) == ('failed', 'failed')
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=TenantId('other')).refresh()
    assert tuple(conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id='old-other'").fetchone()) == ('manual', 'needs_verification')
