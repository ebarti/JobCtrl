"""One shared retry fixture through the canonical owner, CLI and RPC."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time

import pytest
from typer.testing import CliRunner

from jobctrl.database import get_jobs_by_stage, init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.rpc import enrichment_retry
from jobctrl.pipeline.retry import reset_retry_stages
from jobctrl.state import reset_job_stage
from tests.rpc_contract_probe import build_server

JOB = '00000000-0000-4000-8000-000000001008'
PEER = '00000000-0000-4000-8000-000000001009'
SQL = Path(__file__).with_name('fixtures') / 'enrichment_retry.sql'


@pytest.fixture
def conn(tmp_path):
    connection = init_db(tmp_path / 'jobctrl.db')
    connection.executescript(SQL.read_text())
    yield connection
    connection.close()


def rows(conn, table):
    return [dict(row) for row in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')]


def snapshot(conn):
    return {table: rows(conn, table) for table in (
        'job_enrichments', 'job_stage_states', 'job_events', 'job_materials',
        'job_materials_artifacts', 'job_scores', 'application_review_decisions',
    )}


@pytest.mark.parametrize('entry', ['service', 'cli', 'rpc'])
@pytest.mark.parametrize('state,reset_attempts,expected', [
    ('failed', False, 2), ('exhausted', False, 0), ('canceled', True, 0),
])
def test_shared_reset_semantics(conn, monkeypatch, entry, state, reset_attempts, expected):
    conn.execute("UPDATE job_stage_states SET state = ? WHERE job_id = ?", (state, JOB))
    conn.commit()
    before = snapshot(conn)
    if entry == 'service':
        reset_job_stage(conn, 'https://example.test/apply', 'enrich', reset_attempts=reset_attempts)
    elif entry == 'cli':
        from jobctrl import cli, database
        monkeypatch.setattr(cli, '_bootstrap', lambda: None)
        monkeypatch.setattr(database, 'get_connection', lambda: conn)
        args = ['retry', 'enrich', 'https://example.test/apply']
        if reset_attempts:
            args.append('--reset-attempts')
        result = CliRunner().invoke(cli.app, args)
        assert result.exit_code == 0, result.output
        assert 'Reset enrich for retry' in result.output
    else:
        from jobctrl.domain.rpc.messages import JsonRpcRequest
        monkeypatch.setattr(enrichment_retry, 'get_connection', lambda: conn)
        monkeypatch.setattr(enrichment_retry, 'assert_expected_runtime', lambda **_: None)
        response = build_server().dispatch(JsonRpcRequest(method='reset_enrichment', id=1, params={
            'tenantId': 'local', 'expectedAppDir': '/synthetic', 'expectedDbPath': '/synthetic/jobctrl.db',
            'targets': [{'jobId': JOB, 'stage': 'enrich'}], 'resetAttempts': reset_attempts,
        }))
        assert response.error is None
        assert response.result['resets'] == [{'jobId': JOB, 'jobUrl': 'https://example.test/retry', 'stage': 'enrich'}]
    after = snapshot(conn)
    stage = next(row for row in after['job_stage_states'] if row['job_id'] == JOB)
    assert stage['state'] == 'pending'
    assert stage['attempt_count'] == expected
    assert stage['version'] == 8
    assert stage['max_attempts'] == 5
    assert stage['retryable'] == 1
    assert json.loads(stage['blocked_by_json']) == []
    for key in ('started_at', 'finished_at', 'duration_ms', 'error_code', 'error_message', 'next_action', 'metadata_json'):
        assert stage[key] is None
    old, new = before['job_enrichments'][0], after['job_enrichments'][0]
    assert new['current_status'] == 'pending'
    for key in ('full_description', 'application_url', 'enriched_at', 'extraction_tier'):
        assert new[key] == old[key]
    assert json.loads(new['attempts_json']) == json.loads(old['attempts_json'])
    for table in ('job_materials', 'job_materials_artifacts', 'job_scores', 'application_review_decisions'):
        assert after[table] == before[table]
    assert {row['job_id'] for row in get_jobs_by_stage(conn, 'pending_detail')} >= {JOB}
    event = after['job_events'][-1]
    assert event['event_type'] == 'StageReset'
    assert json.loads(event['payload_json'])['reset_attempts'] is (reset_attempts or state == 'exhausted')
    assert not conn.in_transaction


@pytest.mark.parametrize('inherited', [False, True])
def test_failure_rolls_back_complete_cohort_and_keeps_caller_ownership(conn, inherited):
    before = snapshot(conn)
    conn.execute("CREATE TEMP TRIGGER reject_reset BEFORE INSERT ON job_events "
                 "WHEN NEW.job_id = '" + PEER + "' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END")
    if inherited:
        conn.execute("UPDATE jobs SET title = 'caller edit' WHERE job_id = ?", (JOB,))
    with pytest.raises(sqlite3.IntegrityError, match='injected event failure'):
        reset_retry_stages(conn, [(JOB, 'enrich'), (PEER, 'score')], only_failed=True)
    assert conn.in_transaction is inherited
    assert snapshot(conn) == before
    if inherited:
        assert conn.execute('SELECT title FROM jobs WHERE job_id = ?', (JOB,)).fetchone()[0] == 'caller edit'
        conn.rollback()
    conn.execute('DROP TRIGGER reject_reset')
    reset_retry_stages(conn, [(JOB, 'enrich'), (PEER, 'score')], only_failed=True)
    assert len(rows(conn, 'job_events')) == 2
    assert not conn.in_transaction


def test_success_does_not_commit_callers_transaction_or_publish_early(conn, monkeypatch):
    events = []
    monkeypatch.setattr('jobctrl.pipeline.retry.get_default_publisher', lambda: type('Bus', (), {'publish': events.append})())
    before = snapshot(conn)
    conn.execute('BEGIN IMMEDIATE')
    reset_retry_stages(conn, [(JOB, 'enrich')])
    assert conn.in_transaction
    assert events == []
    conn.rollback()
    assert snapshot(conn) == before


def test_stale_bulk_selection_rolls_back_other_targets(conn):
    conn.execute("UPDATE job_stage_states SET state = 'running' WHERE job_id = ?", (PEER,))
    conn.commit()
    before = snapshot(conn)
    with pytest.raises(ValueError, match='target changed'):
        reset_retry_stages(conn, [(JOB, 'enrich'), (PEER, 'score')], only_failed=True)
    assert snapshot(conn) == before
    assert not conn.in_transaction


@pytest.mark.parametrize('override', [
    {'unexpected': True}, {'resetAttempts': 'yes'}, {'onlyFailed': 1},
    {'targets': []}, {'targets': [{'jobId': JOB, 'stage': 'apply'}]},
    {'targets': [{'jobId': 'https://example.test/retry', 'stage': 'enrich'}]},
    {'targets': [{'jobId': JOB, 'stage': 'enrich', 'extra': True}]},
    {'tenantId': 'other'}, {'expectedDbPath': '/wrong/database'},
])
def test_registered_rpc_refuses_invalid_or_foreign_targets_without_writes(conn, monkeypatch, override):
    from jobctrl import config
    from jobctrl.domain.rpc.messages import JsonRpcRequest

    monkeypatch.setattr(enrichment_retry, 'get_connection', lambda: conn)
    before = snapshot(conn)
    response = build_server().dispatch(JsonRpcRequest(method='reset_enrichment', id=1, params={
        'tenantId': 'local', 'expectedAppDir': str(config.APP_DIR), 'expectedDbPath': str(config.DB_PATH),
        'targets': [{'jobId': JOB, 'stage': 'enrich'}], **override,
    }))
    assert response.error is not None
    assert snapshot(conn) == before
    assert not conn.in_transaction


def _writer_probe(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    peer = sqlite3.connect(path)
    conn.execute('PRAGMA busy_timeout=40')
    try:
        peer.execute('BEGIN IMMEDIATE')
        peer.execute("UPDATE job_enrichments SET full_description = 'New accepted content' WHERE job_id = ?", (JOB,))
        start = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match='locked'):
            reset_retry_stages(conn, [(JOB, 'enrich')])
        assert time.monotonic() - start < 1
        assert not conn.in_transaction
        peer.commit()
        reset_retry_stages(conn, [(JOB, 'enrich')])
        assert rows(conn, 'job_enrichments')[0]['full_description'] == 'New accepted content'
    finally:
        peer.close()
        conn.close()


def _concurrent_probe(path):
    barrier = threading.Barrier(2)

    def retry():
        with sqlite3.connect(path, timeout=1) as peer:
            peer.row_factory = sqlite3.Row
            barrier.wait(timeout=2)
            try:
                reset_retry_stages(peer, [(JOB, 'enrich')], only_failed=True)
                return 'reset'
            except ValueError:
                return 'stale'

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: retry(), range(2)))
    assert sorted(results) == ['reset', 'stale']


@pytest.mark.parametrize('probe', ['_writer_probe', '_concurrent_probe'])
def test_bounded_concurrent_writers_and_recovery(conn, probe):
    path = conn.execute('PRAGMA database_list').fetchone()[2]
    result = subprocess.run(
        [sys.executable, '-c',
         f'from tests.test_enrichment_retry import {probe}; import sys; {probe}(sys.argv[1])', path],
        capture_output=True, text=True, timeout=8, cwd=Path(__file__).resolve().parents[1],
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(rows(conn, 'job_events')) == 1


def test_events_publish_only_after_commit_and_failed_refresh_keeps_accepted_artifacts(conn, monkeypatch):
    from jobctrl.domain.enrichment import EnrichmentError, ExtractionTier
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
    from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus

    bus = InProcessEventBus()
    observations = []
    def observe(event):
        path = conn.execute('PRAGMA database_list').fetchone()[2]
        with sqlite3.connect(path) as peer:
            observations.append((event.event_type, peer.execute('SELECT COUNT(*) FROM job_events').fetchone()[0]))
    bus.subscribe('StageReset', observe)
    monkeypatch.setattr('jobctrl.pipeline.retry.get_default_publisher', lambda: bus)
    before = snapshot(conn)
    reset_retry_stages(conn, [(JOB, 'enrich')])
    assert observations == [('StageReset', 1)]
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, canonical_job_id(JOB))
    failed = aggregate.start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at='2026-01-02T00:00:00Z').fail_attempt(
        error=EnrichmentError(code='SYNTHETIC_FAILURE', message='Synthetic unavailable posting', retryable=True),
        finished_at='2026-01-02T00:01:00Z',
    )
    repo.save(failed)
    after = snapshot(conn)
    assert after['job_enrichments'][0]['full_description'] == before['job_enrichments'][0]['full_description']
    assert after['job_enrichments'][0]['application_url'] == before['job_enrichments'][0]['application_url']
    for table in ('job_materials', 'job_materials_artifacts', 'job_scores', 'application_review_decisions'):
        assert after[table] == before[table]


def test_reset_fences_old_worker_then_new_worker_claims(conn):
    from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
    from jobctrl.domain.enrichment import StaleEnrichmentExecutionLease
    from jobctrl.enrichment.detail import _claim_enrich_job_for_activity, _fence_enrich_job_write
    from jobctrl.infrastructure.enrichment.execution_lease import claim_enrichment_execution_lease

    reset_retry_stages(conn, [(JOB, 'enrich')])
    lease = claim_enrichment_execution_lease(conn, DiscoveryExecutionRef(
        tenant_id='local', workflow_id='synthetic-reset', temporal_run_id='synthetic-run',
    ), owner_token='synthetic-owner', activity_phase=1, activity_attempt=1)
    version = _claim_enrich_job_for_activity(conn, canonical_job_id(JOB), tenant_id=LOCAL_TENANT,
        activity_lease=lease, started_at='2026-01-01T01:00:00Z')
    conn.commit()
    reset_retry_stages(conn, [(JOB, 'enrich')])
    with pytest.raises(StaleEnrichmentExecutionLease):
        _fence_enrich_job_write(conn, canonical_job_id(JOB), tenant_id=LOCAL_TENANT,
            activity_lease=lease, claim_version=version)
    new_version = _claim_enrich_job_for_activity(conn, canonical_job_id(JOB), tenant_id=LOCAL_TENANT,
        activity_lease=lease, started_at='2026-01-01T02:00:00Z')
    assert new_version > version
    conn.commit()
    assert JOB not in {row['job_id'] for row in get_jobs_by_stage(conn, 'pending_detail')}


@pytest.mark.parametrize('entry', ['service', 'rpc', 'cli'])
def test_apply_intent_refusal_preserves_mixed_cohort_and_caller_transaction(conn, monkeypatch, entry):
    from jobctrl.state import ensure_job_stage_rows, record_job_event
    from jobctrl.domain.rpc.messages import JsonRpcRequest

    ensure_job_stage_rows(conn, canonical_job_id(PEER))
    conn.execute("UPDATE job_stage_states SET state='failed' WHERE job_id=? AND stage='apply'", (PEER,))
    record_job_event(conn, canonical_job_id(PEER), 'apply', 'ApplySubmitIntended', payload={'run_id': 'original-intent'})
    conn.commit()
    before = snapshot(conn)
    if entry == 'service':
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("UPDATE jobs SET title='caller write' WHERE job_id=?", (JOB,))
        with pytest.raises(ValueError, match='intent'):
            reset_retry_stages(conn, [(JOB, 'enrich'), (PEER, 'apply')])
        assert conn.in_transaction
        assert snapshot(conn) == before
        assert conn.execute('SELECT title FROM jobs WHERE job_id=?', (JOB,)).fetchone()[0] == 'caller write'
        conn.rollback()
    elif entry == 'rpc':
        monkeypatch.setattr(enrichment_retry, 'get_connection', lambda: conn)
        monkeypatch.setattr(enrichment_retry, 'assert_expected_runtime', lambda **_: None)
        response = build_server().dispatch(JsonRpcRequest(method='reset_enrichment', id=1173, params={
            'tenantId': 'local', 'expectedAppDir': '/synthetic', 'expectedDbPath': '/synthetic/jobctrl.db',
            'targets': [{'jobId': JOB, 'stage': 'enrich'}, {'jobId': PEER, 'stage': 'apply'}],
        }))
        assert response.error is not None
        assert 'intent' in response.error.message
    else:
        from jobctrl import cli, database
        monkeypatch.setattr(cli, '_bootstrap', lambda: None)
        monkeypatch.setattr(database, 'get_connection', lambda: conn)
        result = CliRunner().invoke(cli.app, ['retry', 'apply', PEER])
        assert result.exit_code != 0
        assert 'intent' in str(result.exception) or 'intent' in result.output
    assert snapshot(conn) == before
