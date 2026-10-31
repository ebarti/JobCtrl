"""Synthetic product-path checks for manual capture recovery."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
import json
import sqlite3
import threading
import uuid

import pytest
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl.database import get_connection
from jobctrl.discovery.manual_capture_workflow import (
    ManualCaptureImportWorkflow, ManualCaptureImportWorkflowInput, ManualCaptureImportWorkflowResult,
    _DEFAULT_TIMEOUT, execute_manual_capture_import, manual_capture_import_activity,
)
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery import production_wiring
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.infrastructure.temporal.finalize import (
    emit_workflow_outcome, emit_workflow_started, record_workflow_outcome, record_workflow_started,
)
from tests.temporal_env import time_skipping_env
from tests.test_manual_capture_workflow import _CAPTURE_HTML, _isolate_runtime, _pending_payload, _seed_pending
from tests.workflow_determination_fakes import install_page_models


_UNRECOGNIZED = '<html><body><div>Unrecognized captured page</div></body></html>'
_production_selection_builder = production_wiring.build_manual_capture_posting_extractor


@pytest.fixture(autouse=True)
def models(monkeypatch):
    from tests.manual_capture_fakes import install_manual_capture_selection
    install_page_models(monkeypatch)
    install_manual_capture_selection(monkeypatch)


def _pending(conn, item='manual-1'):
    row = conn.execute('SELECT status, retry_context_json, job_id FROM manual_capture_queue WHERE item_id=?', (item,)).fetchone()
    assert row['status'] == 'pending'
    assert row['job_id'] is None
    return json.loads(row['retry_context_json'])['manual_capture_draft']


def _counts(conn):
    return tuple(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in
                 ('jobs', 'job_source_observations', 'posting_snapshot_sets'))


def test_failed_extraction_retains_content_and_corrected_retry_commits_once(monkeypatch, tmp_path):
    from tests.page_fakes import PageModel
    page_model = PageModel(page_kind='unknown')
    install_page_models(monkeypatch, model=page_model)
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    payload = replace(_pending_payload(), content_text=_UNRECOGNIZED)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(payload, conn=conn)
    assert exc.value.type == 'manual_capture_extraction_failed'
    assert _pending(conn)['content'] == _UNRECOGNIZED
    assert _counts(conn) == (0, 0, 0)
    page_model.page_kind = 'posting'
    corrected = replace(payload, content_text=_CAPTURE_HTML)
    first = execute_manual_capture_import(corrected, conn=conn)
    assert first.status == 'succeeded'
    assert _counts(conn) == (1, 1, 1)
    assert conn.execute('SELECT latest_snapshot_version FROM posting_snapshot_sets').fetchone()[0] == 1
    assert 'manual_capture_draft' not in first.retry_context
    assert execute_manual_capture_import(corrected, conn=conn) == first
    assert _counts(conn) == (1, 1, 1)
    assert _UNRECOGNIZED not in ''.join(str(row[0]) for row in conn.execute('SELECT payload_json FROM job_events'))


def test_prepared_reservation_survives_same_run_retry_and_clears_after_commit(monkeypatch, tmp_path):
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    generation = 'prepared-generation'
    marker = {'generation': generation, 'fingerprint': 'synthetic', 'source': 'manual'}
    conn.execute('UPDATE manual_capture_queue SET retry_context_json=? WHERE item_id=?',
                 (json.dumps({'manual_capture_generation': generation, 'manual_capture_api_admission': marker}), 'manual-1'))
    conn.commit()
    payload = replace(_pending_payload(), capture_generation=generation)
    first = {'scheduled_us': 1, 'run_id': 'same-run', 'activity_id': '1', 'attempt': 1}
    original = production_wiring.build_page_interpreter
    def unavailable(*_args, **_kwargs):
        raise DeterminationFailure('provider_error')
    monkeypatch.setattr(production_wiring, 'build_page_interpreter', unavailable)
    with pytest.raises(ApplicationError):
        execute_manual_capture_import(payload, conn=conn, attempt_authority=first)
    retained = json.loads(conn.execute('SELECT retry_context_json FROM manual_capture_queue').fetchone()[0])
    assert retained['manual_capture_api_admission'] == marker
    assert retained['manual_capture_draft']['content'] == _CAPTURE_HTML
    monkeypatch.setattr(production_wiring, 'build_page_interpreter', original)
    second = {**first, 'scheduled_us': 2, 'attempt': 2}
    assert execute_manual_capture_import(payload, conn=conn, attempt_authority=second).status == 'succeeded'
    accepted = json.loads(conn.execute('SELECT retry_context_json FROM manual_capture_queue').fetchone()[0])
    assert 'manual_capture_api_admission' not in accepted
    assert _counts(conn) == (1, 1, 1)


@pytest.mark.parametrize('code', ['provider_error', 'source_binding_invalid', 'schema_violation'])
def test_model_failure_does_not_publish_and_keeps_draft(monkeypatch, tmp_path, code):
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    def fail(*_args, **_kwargs):
        raise DeterminationFailure(code)
    monkeypatch.setattr(production_wiring, 'build_page_interpreter', fail)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert exc.value.type == f'semantic_determination_{code}'
    assert _pending(conn)['content'] == _CAPTURE_HTML
    assert _counts(conn) == (0, 0, 0)


def test_invalid_model_citations_never_fall_back_to_page_text(monkeypatch, tmp_path):
    from tests.page_fakes import PageModel

    class InvalidCitation(PageModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            result['availability']['citations'][0]['quote'] = 'not in the source'
            return result

    install_page_models(monkeypatch, model=InvalidCitation())
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert exc.value.type.startswith('semantic_determination_')
    assert _pending(conn)['content'] == _CAPTURE_HTML
    assert _counts(conn) == (0, 0, 0)


@pytest.mark.parametrize('table', ['posting_snapshot_sets', 'manual_capture_queue'])
def test_database_failure_rolls_back_publication_and_retry_is_idempotent(tmp_path, table):
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    condition = " WHEN NEW.status = 'imported'" if table == 'manual_capture_queue' else ''
    action = 'UPDATE' if table == 'manual_capture_queue' else 'INSERT'
    conn.execute(f"CREATE TRIGGER test_fail BEFORE {action} ON {table}{condition} BEGIN SELECT RAISE(ABORT, 'controlled failure'); END")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert _pending(conn)['content'] == _CAPTURE_HTML
    assert _counts(conn) == (0, 0, 0)
    conn.execute('DROP TRIGGER test_fail')
    conn.commit()
    first = execute_manual_capture_import(_pending_payload(), conn=conn)
    assert execute_manual_capture_import(_pending_payload(), conn=conn) == first
    assert _counts(conn) == (1, 1, 1)


def test_cancellation_after_acquisition_leaves_retained_input(monkeypatch, tmp_path):
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    canceled = threading.Event()
    original = production_wiring._manual_capture_acquisition_service
    def wrapper(*args, **kwargs):
        service = original(*args, **kwargs)
        class Paused:
            def acquire(self, **call):
                result = service.acquire(**call)
                canceled.set()
                return result
        return Paused()
    monkeypatch.setattr(production_wiring, '_manual_capture_acquisition_service', wrapper)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn, cancel_event=canceled)
    assert exc.value.type == 'manual_capture_state_changed'
    assert _pending(conn)['content'] == _CAPTURE_HTML
    assert _counts(conn) == (0, 0, 0)


@pytest.mark.parametrize(('kind', 'access'), [('unknown', 'clear'), ('listing', 'clear'), ('posting', 'login_required')])
def test_existing_accepted_evidence_survives_failed_capture(monkeypatch, tmp_path, kind, access):
    from tests.page_fakes import PageModel
    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    first = execute_manual_capture_import(_pending_payload(), conn=conn)
    snapshots = conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0]
    enrichment = tuple(conn.execute('SELECT * FROM job_enrichments').fetchone())
    _seed_pending(path, item_id='manual-2')
    install_page_models(monkeypatch, model=PageModel(page_kind=kind, access=access, availability='unknown'))
    with pytest.raises(ApplicationError):
        execute_manual_capture_import(replace(_pending_payload('manual-2'), content_text=_UNRECOGNIZED), conn=conn)
    assert _pending(conn, 'manual-2')['content'] == _UNRECOGNIZED
    assert conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0] == snapshots
    assert tuple(conn.execute('SELECT * FROM job_enrichments').fetchone()) == enrichment
    assert conn.execute('SELECT job_id FROM jobs').fetchone()[0] == first.job_id
    assert _counts(conn) == (1, 1, 1)


def test_deletion_during_model_work_does_not_restore_owner(monkeypatch, tmp_path):
    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    first = execute_manual_capture_import(_pending_payload(), conn=conn)
    snapshots = conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0]
    _seed_pending(path, item_id='manual-2')
    original = production_wiring._manual_capture_acquisition_service
    def wrapper(*args, **kwargs):
        service = original(*args, **kwargs)
        class DeleteOwner:
            def acquire(self, **call):
                result = service.acquire(**call)
                other = sqlite3.connect(path)
                other.row_factory = sqlite3.Row
                SqliteJobRepository(other).soft_delete(TenantId('local'), canonical_job_id(first.job_id),
                                                       reason='user', deleted_at='2026-10-28T10:00:00Z')
                other.close()
                return result
        return DeleteOwner()
    monkeypatch.setattr(production_wiring, '_manual_capture_acquisition_service', wrapper)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload('manual-2'), conn=conn)
    assert exc.value.type == 'manual_capture_state_changed'
    assert _pending(conn, 'manual-2')['content'] == _CAPTURE_HTML
    assert conn.execute('SELECT restored_at FROM jobctrl_deleted_jobs').fetchone()[0] is None
    assert conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0] == snapshots
    assert _counts(conn) == (1, 1, 1)


def test_dismissal_during_model_work_is_not_overwritten(monkeypatch, tmp_path):
    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    original = production_wiring._manual_capture_acquisition_service
    def wrapper(*args, **kwargs):
        service = original(*args, **kwargs)
        class Dismiss:
            def acquire(self, **call):
                result = service.acquire(**call)
                other = sqlite3.connect(path)
                other.execute("UPDATE manual_capture_queue SET status='dismissed', retry_context_json='{}' WHERE item_id='manual-1'")
                other.commit()
                other.close()
                return result
        return Dismiss()
    monkeypatch.setattr(production_wiring, '_manual_capture_acquisition_service', wrapper)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert exc.value.type == 'manual_capture_state_changed'
    assert conn.execute('SELECT status FROM manual_capture_queue').fetchone()[0] == 'dismissed'
    assert _counts(conn) == (0, 0, 0)


def test_concurrent_attempts_publish_only_once(monkeypatch, tmp_path):
    from jobctrl.discovery import manual_capture_workflow as module

    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    barrier = threading.Barrier(2)
    original = module._capture_row
    local = threading.local()
    def synchronized(*args, **kwargs):
        row = original(*args, **kwargs)
        if not getattr(local, 'waited', False):
            local.waited = True
            barrier.wait(timeout=15)
        return row
    monkeypatch.setattr(module, '_capture_row', synchronized)
    def run():
        other = sqlite3.connect(path, timeout=15)
        other.row_factory = sqlite3.Row
        try:
            return execute_manual_capture_import(_pending_payload(), conn=other)
        except ApplicationError as exc:
            return exc.type
        finally:
            other.close()
    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _: run(), range(2)))
    assert sum(getattr(outcome, 'status', None) == 'succeeded' for outcome in outcomes) == 1
    assert 'manual_capture_state_changed' in outcomes
    assert _counts(conn) == (1, 1, 1)
    assert conn.execute('SELECT latest_snapshot_version FROM posting_snapshot_sets').fetchone()[0] == 1


@pytest.mark.asyncio
async def test_real_temporal_failure_and_corrected_retry_replay(monkeypatch, tmp_path):
    from tests.page_fakes import PageModel
    page_model = PageModel(page_kind='unknown')
    install_page_models(monkeypatch, model=page_model)
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    _seed_pending(tmp_path / 'jobctrl.db')
    payload = replace(_pending_payload(), content_text=_UNRECOGNIZED,
                      expected_app_dir=app_dir, expected_db_path=db_path)
    queue = f'manual-recovery-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            histories = []
            for current in [payload, replace(payload, content_text=_CAPTURE_HTML)]:
                if current is not payload:
                    page_model.page_kind = 'posting'
                handle = await env.client.start_workflow(ManualCaptureImportWorkflow.run, current,
                                                         id=f'manual-recovery-{uuid.uuid4()}', task_queue=queue)
                result = await handle.result()
                histories.append(await handle.fetch_history())
                if current is payload:
                    assert result.status == 'failed'
                    assert result.error_code == 'manual_capture_extraction_failed'
                    assert _pending(get_connection())['content'] == _UNRECOGNIZED
                else:
                    assert result.status == 'succeeded'
                projection = get_connection().execute(
                    'SELECT status,error_code FROM workflow_run_projections WHERE workflow_id=?', (handle.id,),
                ).fetchone()
                assert tuple(projection) == (result.status, result.error_code)
            assert _counts(get_connection()) == (1, 1, 1)
        for history in histories:
            await Replayer(workflows=[ManualCaptureImportWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)


@pytest.mark.asyncio
async def test_real_temporal_database_failure_retains_draft_and_reports_safe_code(monkeypatch, tmp_path):
    from jobctrl.discovery import manual_capture_workflow as module

    monkeypatch.setattr(module, '_MANUAL_CAPTURE_RETRY', RetryPolicy(maximum_attempts=1))
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    conn.execute("CREATE TRIGGER test_fail BEFORE INSERT ON posting_snapshot_sets BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END")
    conn.commit()
    payload = replace(_pending_payload(), expected_app_dir=app_dir, expected_db_path=db_path)
    queue = f'manual-database-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            histories = []
            for attempt in range(2):
                if attempt:
                    conn.execute('DROP TRIGGER test_fail')
                    conn.commit()
                handle = await env.client.start_workflow(ManualCaptureImportWorkflow.run, payload,
                                                         id=f'manual-database-{uuid.uuid4()}', task_queue=queue)
                result = await handle.result()
                histories.append(await handle.fetch_history())
                if not attempt:
                    assert (result.status, result.error_code) == ('failed', 'manual_capture_database_error')
                    assert _pending(get_connection())['content'] == _CAPTURE_HTML
                    assert _counts(get_connection()) == (0, 0, 0)
                else:
                    assert result.status == 'succeeded'
                    assert _counts(get_connection()) == (1, 1, 1)
        for history in histories:
            await Replayer(workflows=[ManualCaptureImportWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)


def _historical_false_import(conn):
    """Construct the old persisted shape with its original source observation."""
    first = execute_manual_capture_import(_pending_payload(), conn=conn)
    snapshot = json.loads(conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0])
    snapshot['snapshots'] = []
    snapshot['failures'] = [{'source_id': 'manual:test', 'error_class': 'EXTRACTION_EXHAUSTED',
                             'message': 'synthetic failure', 'retryable': True, 'failed_at': '2026-10-28'}]
    conn.execute('UPDATE posting_snapshot_sets SET snapshot_set_json=?, latest_snapshot_version=0', (json.dumps(snapshot),))
    conn.execute("UPDATE manual_capture_queue SET retry_context_json=json_remove(retry_context_json, '$.manual_capture_generation', '$.manual_capture_admission')")
    conn.execute('DELETE FROM job_enrichments')
    conn.commit()
    return first


def test_evidenced_historical_failure_requires_content_then_reuses_original_observation(tmp_path):
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    first = _historical_false_import(conn)
    # A URL alone does not recover the absent original page or claim success.
    with pytest.raises(ApplicationError):
        execute_manual_capture_import(replace(_pending_payload(), content_text=None), conn=conn)
    assert conn.execute('SELECT status FROM manual_capture_queue').fetchone()[0] == 'imported'
    recovered = execute_manual_capture_import(_pending_payload(), conn=conn)
    assert recovered.job_id == first.job_id
    assert _counts(conn) == (1, 1, 1)
    assert conn.execute('SELECT latest_snapshot_version FROM posting_snapshot_sets').fetchone()[0] == 1
    assert execute_manual_capture_import(_pending_payload(), conn=conn) == recovered


@pytest.mark.asyncio
async def test_temporal_retry_preserves_same_run_authority_after_legacy_reopen(monkeypatch, tmp_path):
    from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from tests.page_fakes import PageModel

    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    old = _historical_false_import(conn)
    class TemporarilyUnavailable(PageModel):
        attempts = 0
        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema['title'] == 'PageInterpretation':
                self.attempts += 1
                if self.attempts == 1:
                    raise RuntimeError('synthetic provider failure')
            return super().chat_json(messages, response_schema=response_schema, **kwargs)
    model = TemporarilyUnavailable()
    def build(connection, *, tenant_id):
        return ModelPageInterpreter(llm=model, repository=SqliteDeterminationRepository(connection),
                                    tenant_id=tenant_id, provider='synthetic', model='retry-test',
                                    lane='enrichment', preflight=lambda: None)
    monkeypatch.setattr(production_wiring, 'build_page_interpreter', build)
    payload = replace(_pending_payload(), expected_app_dir=app_dir, expected_db_path=db_path)
    queue = f'manual-legacy-retry-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            result = await env.client.execute_workflow(
                ManualCaptureImportWorkflow.run, payload, id=f'manual-legacy-{uuid.uuid4()}', task_queue=queue,
            )
    assert result.status == 'succeeded' and result.job_id == old.job_id
    assert model.attempts == 2
    assert _counts(get_connection()) == (1, 1, 1)
    assert get_connection().execute('SELECT latest_snapshot_version FROM posting_snapshot_sets').fetchone()[0] == 1


@pytest.mark.parametrize('case', ['no_observation', 'wrong_source', 'bad_provenance', 'deleted'])
def test_unbound_or_deleted_historical_capture_never_reopens(tmp_path, case):
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    first = _historical_false_import(conn)
    if case == 'no_observation':
        conn.execute('DELETE FROM job_source_observations')
    elif case == 'wrong_source':
        conn.execute("UPDATE job_source_observations SET source_id='other-source'")
    elif case == 'bad_provenance':
        conn.execute("UPDATE manual_capture_queue SET retry_context_json='{}'")
    else:
        SqliteJobRepository(conn).soft_delete(TenantId('local'), canonical_job_id(first.job_id),
                                             reason='user', deleted_at='2026-10-28T10:00:00Z')
    conn.commit()
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert exc.value.type == {
        'deleted': 'manual_capture_state_changed', 'bad_provenance': 'capture_replay_mismatch',
        'no_observation': 'manual_capture_extraction_failed', 'wrong_source': 'manual_capture_extraction_failed',
    }[case]
    assert conn.execute('SELECT status FROM manual_capture_queue').fetchone()[0] == 'imported'
    assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 1
    assert conn.execute('SELECT latest_snapshot_version FROM posting_snapshot_sets').fetchone()[0] == 0


@pytest.mark.parametrize(('quality', 'expected_quarantine'), [('high', False), ('low', True)])
def test_source_bound_model_quality_controls_quarantine(monkeypatch, tmp_path, quality, expected_quarantine):
    from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from tests.page_fakes import PageModel

    model = PageModel(quality=quality)
    def build(connection, *, tenant_id):
        return ModelPageInterpreter(llm=model, repository=SqliteDeterminationRepository(connection),
                                    tenant_id=tenant_id, provider='synthetic', model='synthetic',
                                    lane='enrichment', preflight=lambda: None)
    monkeypatch.setattr(production_wiring, 'build_page_interpreter', build)
    conn = _seed_pending(tmp_path / 'jobctrl.db', tenant_id='other')
    result = execute_manual_capture_import(replace(_pending_payload(), tenant_id='other'), conn=conn)
    snapshot = json.loads(conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0])['snapshots'][0]
    ids = {value.split(':', 1)[1] for value in snapshot['evidence'] if '_determination:' in value}
    persisted = conn.execute('SELECT determination_id,tenant_id FROM semantic_determinations').fetchall()
    assert ids == {row['determination_id'] for row in persisted}
    assert {row['tenant_id'] for row in persisted} == {'other'}
    assert bool(conn.execute('SELECT 1 FROM discovery_quarantine_entries WHERE job_id=?', (result.job_id,)).fetchone()) == expected_quarantine
    assert len(model.calls) == 2


@pytest.mark.asyncio
async def test_real_temporal_cancellation_fences_late_publication(monkeypatch, tmp_path):
    import asyncio
    from jobctrl.discovery import manual_capture_workflow as workflow_module
    from temporalio.client import WorkflowFailureError

    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    _seed_pending(tmp_path / 'jobctrl.db')
    payload = replace(_pending_payload(), expected_app_dir=app_dir, expected_db_path=db_path)
    reached = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    original_acquisition = production_wiring._manual_capture_acquisition_service
    original_execute = workflow_module.execute_manual_capture_import
    observed = {}

    def execute(*args, **kwargs):
        observed['cancel_event'] = kwargs['cancel_event']
        try:
            return original_execute(*args, **kwargs)
        finally:
            finished.set()

    def acquisition(*args, **kwargs):
        service = original_acquisition(*args, **kwargs)
        class Paused:
            def acquire(self, **call):
                result = service.acquire(**call)
                reached.set()
                if not release.wait(15):
                    raise RuntimeError('controlled cancellation wait timed out')
                return result
        return Paused()

    monkeypatch.setattr(workflow_module, 'execute_manual_capture_import', execute)
    monkeypatch.setattr(production_wiring, '_manual_capture_acquisition_service', acquisition)
    queue = f'manual-cancel-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            handle = await env.client.start_workflow(ManualCaptureImportWorkflow.run, payload,
                                                     id=f'manual-cancel-{uuid.uuid4()}', task_queue=queue)
            try:
                for _ in range(200):
                    if reached.is_set():
                        break
                    await asyncio.sleep(.05)
                assert reached.is_set()
                await handle.cancel()
                for _ in range(200):
                    if observed.get('cancel_event') and observed['cancel_event'].is_set():
                        break
                    await asyncio.sleep(.05)
                assert observed['cancel_event'].is_set()
            finally:
                release.set()
            with pytest.raises(WorkflowFailureError):
                await handle.result()
            for _ in range(200):
                if finished.is_set():
                    break
                await asyncio.sleep(.05)
            assert finished.is_set()
            assert _pending(get_connection())['content'] == _CAPTURE_HTML
            assert _counts(get_connection()) == (0, 0, 0)
            projection = get_connection().execute(
                'SELECT status,error_code FROM workflow_run_projections WHERE workflow_id=?', (handle.id,),
            ).fetchone()
            assert tuple(projection) == ('canceled', 'workflow_canceled')
            history = await handle.fetch_history()
        await Replayer(workflows=[ManualCaptureImportWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)


@workflow.defn(name='ManualCaptureImportWorkflow')
class LegacyWorkflow:
    @workflow.run
    async def run(self, payload: ManualCaptureImportWorkflowInput) -> ManualCaptureImportWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id, workflow_type='ManualCaptureImportWorkflow',
            input_summary={'itemId': payload.item_id, 'captureMode': payload.capture_mode,
                           'hasCapturedUrl': bool(payload.captured_url),
                           'hasContent': bool(payload.content_text or payload.content_html_base64)},
            started_at=started_at, expected_app_dir=payload.expected_app_dir, expected_db_path=payload.expected_db_path,
        )
        output = await workflow.execute_activity(manual_capture_import_activity, payload,
                                                  start_to_close_timeout=_DEFAULT_TIMEOUT,
                                                  retry_policy=RetryPolicy(
                                                      initial_interval=timedelta(seconds=2),
                                                      maximum_interval=timedelta(seconds=10), maximum_attempts=2,
                                                      non_retryable_error_types=['invalid_capture_input', 'not_found',
                                                                                 'capture_replay_mismatch',
                                                                                 'RuntimeIdentityMismatch'],
                                                  ))
        await emit_workflow_outcome(
            tenant_id=payload.tenant_id, workflow_type='ManualCaptureImportWorkflow', status='succeeded',
            started_at=started_at, expected_app_dir=payload.expected_app_dir, expected_db_path=payload.expected_db_path,
        )
        return ManualCaptureImportWorkflowResult(status=output.status, item_id=output.item_id,
                                                 job_id=output.job_id, imported_at=output.imported_at,
                                                 retry_context=dict(output.retry_context))


@pytest.mark.asyncio
async def test_legacy_manual_capture_history_replays_with_cancellation_patch(monkeypatch, tmp_path):
    from tests.test_manual_capture_workflow import _successful_manual_capture_import

    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    payload = replace(_pending_payload(), expected_app_dir=app_dir, expected_db_path=db_path)
    queue = f'manual-legacy-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[LegacyWorkflow],
                          activities=[_successful_manual_capture_import, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            handle = await env.client.start_workflow(LegacyWorkflow.run, payload,
                                                     id=f'manual-legacy-{uuid.uuid4()}', task_queue=queue)
            assert (await handle.result()).status == 'succeeded'
            history = await handle.fetch_history()
        await Replayer(workflows=[ManualCaptureImportWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)


def test_unverified_historical_receipt_preserves_older_snapshot_and_original_observation(tmp_path):
    from datetime import datetime, timezone
    import hashlib
    from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher, _manual_capture_posting
    from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository

    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    first = execute_manual_capture_import(_pending_payload(), conn=conn)
    before_set = json.loads(conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0])
    before_enrichment = tuple(conn.execute('SELECT * FROM job_enrichments').fetchone())
    _seed_pending(path, item_id='manual-2')
    now = datetime.now(timezone.utc).isoformat()
    posting = _manual_capture_posting(source_id='manual:test', item_id='manual-2',
                                      url=_pending_payload().captured_url, content=_UNRECOGNIZED,
                                      originating_url=_pending_payload().captured_url)
    DiscoverJobsUseCase(repository=SqliteJobRepository(conn), publisher=DurableJobEventPublisher(conn, stage='discover'),
                        refresh_existing_job=False).execute(tenant_id=TenantId('local'), postings=(posting,),
                                                           run_id='manual-capture:manual-2')
    original_observation = tuple(conn.execute('SELECT * FROM job_source_observations').fetchone())
    repo = SqlitePostingSnapshotSetRepository(conn)
    current = repo.load(TenantId('local'), canonical_job_id(first.job_id))
    failed, _ = current.record_capture_failure(source_id='manual:test', error_class='EXTRACTION_EXHAUSTED',
                                                message='Synthetic failure; item identity was not recorded',
                                                retryable=True, failed_at=now)
    repo.save(failed)
    context = json.loads(conn.execute("SELECT retry_context_json FROM manual_capture_queue WHERE item_id='manual-1'").fetchone()[0])
    context.pop('manual_capture_generation', None)
    context.pop('manual_capture_admission', None)
    context['manual_capture_provenance']['captured_at'] = now
    conn.execute("""UPDATE manual_capture_queue SET status='imported',job_id=?,imported_at=?,captured_url=?,
                 content_sha256=?,content_length=?,capture_mode='saved_html',note='captured by user',
                 future_manual_action_required=1,retry_context_json=? WHERE item_id='manual-2'""",
                 (first.job_id, now, posting.posting_url.value, hashlib.sha256(_UNRECOGNIZED.encode()).hexdigest(),
                  len(_UNRECOGNIZED), json.dumps(context)))
    conn.commit()
    # Explicit resubmission is a new capture, not an attribution of the old failure.
    recovered = execute_manual_capture_import(_pending_payload('manual-2'), conn=conn)
    assert recovered.job_id == first.job_id
    after_set = json.loads(conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0])
    assert after_set['snapshots'][0] == before_set['snapshots'][0]
    assert len(after_set['snapshots']) == 2
    assert tuple(conn.execute('SELECT * FROM job_enrichments').fetchone()) == before_enrichment
    assert tuple(conn.execute('SELECT * FROM job_source_observations').fetchone()) == original_observation
    assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 1
    assert conn.execute("SELECT status FROM manual_capture_queue WHERE item_id='manual-2'").fetchone()[0] == 'imported'


@pytest.mark.parametrize(('kind', 'access'), [
    ('listing', 'clear'), ('other', 'clear'), ('unknown', 'clear'),
    ('posting', 'login_required'), ('posting', 'challenge'),
])
def test_cited_page_decision_blocks_non_posting_or_protected_capture(monkeypatch, tmp_path, kind, access):
    from tests.page_fakes import PageModel
    install_page_models(monkeypatch, model=PageModel(page_kind=kind, access=access, availability='unknown'))
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert exc.value.type == 'manual_capture_extraction_failed'
    assert _pending(conn)['content'] == _CAPTURE_HTML
    assert _counts(conn) == (0, 0, 0)
    receipt = json.loads(conn.execute("SELECT envelope_json FROM semantic_determinations WHERE kind='page_interpretation'").fetchone()[0])
    assert receipt['result']['page_kind']['value'] == kind
    assert receipt['result']['access_state']['value'] == access
    assert receipt['tenant_id'] == 'local'
    assert receipt['entity_id'] == _pending_payload().captured_url
    assert _pending(conn)['page_determination_id'] == receipt['determination_id']


def test_late_page_decision_cannot_change_rotated_draft_during_retry(monkeypatch, tmp_path):
    from jobctrl.discovery import manual_capture_workflow as module
    from tests.page_fakes import PageModel

    page_model = PageModel(page_kind='listing')
    install_page_models(monkeypatch, model=page_model)
    _isolate_runtime(monkeypatch, tmp_path)
    _seed_pending(tmp_path / 'jobctrl.db')
    payload = _pending_payload()
    old_waiting, release_old, fresh_waiting, release_fresh = (threading.Event() for _ in range(4))
    original_retain, original_read = production_wiring._retain_manual_capture_decision, module._capture_row

    def retain(*args, **kwargs):
        old_waiting.set()
        assert release_old.wait(10)
        return original_retain(*args, **kwargs)

    def old_import():
        with pytest.raises(ApplicationError) as error:
            execute_manual_capture_import(payload)
        assert error.value.type == 'manual_capture_extraction_failed'

    def paused_read(*args, **kwargs):
        row = original_read(*args, **kwargs)
        fresh_waiting.set()
        assert release_fresh.wait(10)
        return row

    monkeypatch.setattr(production_wiring, '_retain_manual_capture_decision', retain)
    with ThreadPoolExecutor(max_workers=2) as executor:
        try:
            old = executor.submit(old_import)
            assert old_waiting.wait(10)
            conn = get_connection()
            conn.execute('BEGIN IMMEDIATE')
            context = json.loads(conn.execute("SELECT retry_context_json FROM manual_capture_queue WHERE item_id='manual-1'").fetchone()[0])
            context['manual_capture_generation'] = uuid.uuid4().hex
            context['manual_capture_draft']['token'] = uuid.uuid4().hex
            raw = json.dumps(context)
            conn.execute("UPDATE manual_capture_queue SET retry_context_json=? WHERE item_id='manual-1'", (raw,))
            conn.commit()
            page_model.page_kind = 'posting'
            monkeypatch.setattr(module, '_capture_row', paused_read)
            fresh_payload = replace(payload, capture_generation=context['manual_capture_generation'],
                                    content_text=_CAPTURE_HTML.replace('Build reliable', 'Build corrected reliable'))
            fresh = executor.submit(execute_manual_capture_import, fresh_payload)
            assert fresh_waiting.wait(10)
            release_old.set()
            old.result(timeout=10)
            assert conn.execute("SELECT retry_context_json FROM manual_capture_queue WHERE item_id='manual-1'").fetchone()[0] == raw
            release_fresh.set()
            assert fresh.result(timeout=10).status == 'succeeded'
            assert _counts(conn) == (1, 1, 1)
        finally:
            release_old.set()
            release_fresh.set()


@pytest.mark.parametrize('early_return', ['identity_lost', 'http_status', 'incomplete_evidence'])
def test_missing_page_decision_blocks_extraction_and_keeps_draft(monkeypatch, tmp_path, early_return):
    from tests.manual_capture_fakes import install_manual_capture_selection
    from tests.page_fakes import PageModel

    page_model = PageModel(page_kind='listing', access='login_required')
    install_page_models(monkeypatch, model=page_model)
    selection_model = install_manual_capture_selection(monkeypatch)
    original = production_wiring._detail_page_from_manual_content
    def page(url, content):
        result = original(url, content)
        if early_return == 'http_status':
            return replace(result, status=404)
        if early_return == 'incomplete_evidence':
            return replace(result, status_evidence_complete=False)
        return result
    monkeypatch.setattr(production_wiring, '_detail_page_from_manual_content', page)
    payload = _pending_payload()
    if early_return == 'identity_lost':
        payload = replace(payload, captured_url='https://example.test/')
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(payload, conn=conn)
    assert exc.value.type == 'manual_capture_extraction_failed'
    assert page_model.calls == [] and selection_model.calls == []
    assert _pending(conn)['content'] == payload.content_text
    assert _counts(conn) == (0, 0, 0)
    assert conn.execute('SELECT COUNT(*) FROM semantic_determinations').fetchone()[0] == 0


def test_selected_source_excludes_neighboring_posting_and_retains_citation(monkeypatch, tmp_path):
    from tests.manual_capture_fakes import install_manual_capture_selection
    from tests.workflow_determination_fakes import ImportModel

    model = ImportModel()
    model.selected_posting = 0
    install_manual_capture_selection(monkeypatch, model=model)
    html = '''<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"Neighbor Job",
      "url":"https://example.test/jobs/other","description":"Neighbor description from a different posting."}</script>
      <script type="application/ld+json">{"@type":"JobPosting","title":"Intended Job",
      "url":"https://example.test/jobs/staff-engineer","description":"Intended description from the selected posting."}</script>
      </head><body>Intended Job</body></html>'''
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(replace(_pending_payload(), content_text=html), conn=conn)
    assert exc.value.type == 'semantic_determination_field_binding_invalid'
    assert _pending(conn)['content'] == html
    assert _counts(conn) == (0, 0, 0)
    model.selected_posting = 1
    output = execute_manual_capture_import(replace(_pending_payload(), content_text=html), conn=conn)
    assert conn.execute('SELECT title FROM jobs WHERE job_id=?', (output.job_id,)).fetchone()[0] == 'Intended Job'
    assert conn.execute('SELECT full_description FROM job_enrichments WHERE job_id=?', (output.job_id,)).fetchone()[0] == 'Intended description from the selected posting.'
    envelope = json.loads(conn.execute("SELECT envelope_json FROM semantic_determinations WHERE kind='posting_extraction'").fetchone()[0])
    assert envelope['result']['description']['value'] == 'Intended description from the selected posting.'
    assert envelope['result']['description']['source_id'] == 'posting:1:description'
    snapshot = json.loads(conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0])['snapshots'][0]
    assert f"posting_extraction_determination:{envelope['determination_id']}" in snapshot['evidence']


def test_production_selection_obeys_enrichment_spend_preflight(monkeypatch, tmp_path):
    from tests.workflow_determination_fakes import ImportModel

    model = ImportModel()
    lanes = []
    denied = True
    def preflight(*, lane):
        lanes.append(lane)
        if denied:
            raise RuntimeError('synthetic budget denial')

    monkeypatch.setattr(production_wiring, 'build_manual_capture_posting_extractor', _production_selection_builder)
    monkeypatch.setattr('jobctrl.infrastructure.llm.get_llm_adapter', lambda: model)
    monkeypatch.setattr('jobctrl.infrastructure.llm.llm_client._effective_default_selection', lambda _: ('synthetic', 'model'))
    monkeypatch.setattr('jobctrl.llm.enforce_spend_budget', preflight)
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(_pending_payload(), conn=conn)
    assert exc.value.type == 'semantic_determination_budget_denied'
    assert lanes == ['enrichment']
    assert model.calls == []
    assert _pending(conn)['content'] == _CAPTURE_HTML
    assert _counts(conn) == (0, 0, 0)
    denied = False
    assert execute_manual_capture_import(_pending_payload(), conn=conn).status == 'succeeded'
    assert lanes == ['enrichment', 'enrichment']
    receipt = json.loads(conn.execute("SELECT envelope_json FROM semantic_determinations WHERE kind='posting_extraction'").fetchone()[0])
    assert (receipt['tenant_id'], receipt['lane'], receipt['entity_id']) == ('local', 'enrichment', _pending_payload().captured_url)


@pytest.mark.asyncio
@pytest.mark.parametrize(('kind', 'access', 'root_url'), [
    ('listing', 'clear', False), ('posting', 'login_required', False), ('listing', 'login_required', True),
])
async def test_real_temporal_requires_accessible_bound_page_decision(monkeypatch, tmp_path, kind, access, root_url):
    from tests.page_fakes import PageModel
    install_page_models(monkeypatch, model=PageModel(page_kind=kind, access=access, availability='unknown'))
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    _seed_pending(tmp_path / 'jobctrl.db')
    payload = replace(_pending_payload(), expected_app_dir=app_dir, expected_db_path=db_path)
    if root_url:
        payload = replace(payload, captured_url='https://example.test/')
    queue = f'manual-page-{uuid.uuid4()}'
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=queue, workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            handle = await env.client.start_workflow(ManualCaptureImportWorkflow.run, payload,
                                                     id=f'manual-page-{uuid.uuid4()}', task_queue=queue)
            result = await handle.result()
            assert (result.status, result.error_code) == ('failed', 'manual_capture_extraction_failed')
            assert tuple(get_connection().execute(
                'SELECT status,error_code FROM workflow_run_projections WHERE workflow_id=?', (handle.id,),
            ).fetchone()) == ('failed', 'manual_capture_extraction_failed')
            assert _pending(get_connection())['content'] == _CAPTURE_HTML
            assert _counts(get_connection()) == (0, 0, 0)
            history = await handle.fetch_history()
        await Replayer(workflows=[ManualCaptureImportWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)


@pytest.mark.asyncio
@pytest.mark.parametrize('pause_before_read', [False, True])
async def test_timed_out_temporal_attempt_cannot_replace_newer_draft(monkeypatch, tmp_path, pause_before_read):
    import asyncio
    from temporalio import activity
    from jobctrl.discovery import manual_capture_workflow as module
    from tests.page_fakes import PageModel

    model = PageModel(page_kind='unknown')
    install_page_models(monkeypatch, model=model)
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    _seed_pending(tmp_path / 'jobctrl.db')
    payload = replace(_pending_payload(), expected_app_dir=app_dir, expected_db_path=db_path)
    newer = replace(payload, content_text='<html><body>New synthetic input for review</body></html>')
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    original_read = module._capture_row
    original_execute = module.execute_manual_capture_import
    old_thread = {}
    def read(*args, **kwargs):
        row = None if pause_before_read else original_read(*args, **kwargs)
        if not entered.is_set():
            old_thread['id'] = threading.get_ident()
            entered.set()
            assert release.wait(20)
        return original_read(*args, **kwargs) if pause_before_read else row
    def execute(*args, **kwargs):
        try:
            return original_execute(*args, **kwargs)
        finally:
            if threading.get_ident() == old_thread.get('id'):
                finished.set()
    monkeypatch.setattr(module, '_capture_row', read)
    monkeypatch.setattr(module, 'execute_manual_capture_import', execute)
    monkeypatch.setattr(module, '_DEFAULT_TIMEOUT', timedelta(seconds=2))
    monkeypatch.setattr(module, '_MANUAL_CAPTURE_RETRY', RetryPolicy(maximum_attempts=1))
    heartbeat = activity.heartbeat
    old_run = {'id': None}
    def partitioned_heartbeat(*args):
        if old_run['id'] and activity.info().workflow_run_id == old_run['id'] and args and args[0] != 'manual-capture import starting':
            return
        return heartbeat(*args)
    monkeypatch.setattr(activity, 'heartbeat', partitioned_heartbeat)
    queue = f'manual-stale-{uuid.uuid4()}'
    workflow_id = module.manual_capture_import_workflow_id('local', payload.item_id)
    try:
        async with time_skipping_env() as env:
            async with Worker(env.client, task_queue=queue, workflows=[ManualCaptureImportWorkflow],
                              activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                              workflow_runner=UnsandboxedWorkflowRunner()):
                old = await env.client.start_workflow(ManualCaptureImportWorkflow.run, payload, id=workflow_id, task_queue=queue)
                old_run['id'] = old.result_run_id or old.first_execution_run_id
                assert await asyncio.to_thread(entered.wait, 10)
                assert (await asyncio.wait_for(old.result(), 12)).status == 'failed'
                new = await env.client.start_workflow(ManualCaptureImportWorkflow.run, newer, id=workflow_id, task_queue=queue)
                assert (await asyncio.wait_for(new.result(), 12)).status == 'failed'
                assert _pending(get_connection())['content'] == newer.content_text
                model.page_kind = 'posting'
                release.set()
                assert await asyncio.to_thread(finished.wait, 10)
                assert _pending(get_connection())['content'] == newer.content_text
                assert _counts(get_connection()) == (0, 0, 0)
    finally:
        release.set()


@pytest.mark.asyncio
async def test_temporal_conflict_rejects_overlapping_capture_requests(monkeypatch, tmp_path):
    import asyncio
    from temporalio.exceptions import WorkflowAlreadyStartedError
    from jobctrl.infrastructure.rpc import workflow_starter
    from jobctrl.workflow_specs import build_manual_capture_import_workflow_spec

    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    _seed_pending(tmp_path / 'jobctrl.db')
    entered, release = threading.Event(), threading.Event()
    original = production_wiring._manual_capture_acquisition_service
    def acquisition(*args, **kwargs):
        service = original(*args, **kwargs)
        class Paused:
            def acquire(self, **call):
                entered.set()
                assert release.wait(15)
                return service.acquire(**call)
        return Paused()
    monkeypatch.setattr(production_wiring, '_manual_capture_acquisition_service', acquisition)
    params = {'tenantId': 'local', 'itemId': 'manual-1', 'captureMode': 'saved_html',
              'contentText': _CAPTURE_HTML, 'capturedUrl': _pending_payload().captured_url,
              'expectedAppDir': app_dir, 'expectedDbPath': db_path, 'futureManualActionRequired': True}
    async with time_skipping_env() as env:
        async def client():
            return env.client
        monkeypatch.setattr(workflow_starter, 'get_temporal_client', client)
        async with Worker(env.client, task_queue=workflow_starter.JOBCTRL_TASK_QUEUE,
                          workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            first = await workflow_starter.default_workflow_starter(build_manual_capture_import_workflow_spec(params))
            try:
                assert await asyncio.to_thread(entered.wait, 10)
                for candidate in [params, {**params, 'contentText': 'different synthetic input'}]:
                    with pytest.raises(WorkflowAlreadyStartedError):
                        await workflow_starter.default_workflow_starter(build_manual_capture_import_workflow_spec(candidate))
            finally:
                release.set()
            assert (await first.result()).status == 'succeeded'
            retry = await workflow_starter.default_workflow_starter(build_manual_capture_import_workflow_spec(params))
            assert (await retry.result()).status == 'succeeded'


def test_started_before_dismissal_cannot_claim_an_explicitly_reopened_item(monkeypatch, tmp_path):
    from jobctrl.domain.discovery.source_registry import ManualActionReason
    from jobctrl.workflow_specs import build_manual_capture_import_workflow_spec

    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    conn = get_connection()
    url = _pending_payload().captured_url
    item_id = production_wiring.enqueue_manual_capture_for_job_url_import(
        conn, originating_url=url, reason=ManualActionReason.LOGIN_REQUIRED,
    )
    params = {'tenantId': 'local', 'itemId': item_id, 'captureMode': 'saved_html',
              'contentText': _CAPTURE_HTML, 'capturedUrl': url, 'expectedAppDir': app_dir, 'expectedDbPath': db_path}
    old = build_manual_capture_import_workflow_spec(params).args[0]
    assert old.capture_generation is None
    conn.execute("UPDATE manual_capture_queue SET status='dismissed', retry_context_json=json_set(retry_context_json, '$.manual_capture_generation', 'dismissal-marker') WHERE item_id=?", (item_id,))
    conn.commit()
    assert production_wiring.enqueue_manual_capture_for_job_url_import(
        conn, originating_url=url, reason=ManualActionReason.LOGIN_REQUIRED,
    ) == item_id
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(old, conn=conn, attempt_authority={
            'scheduled_us': 1, 'run_id': 'old', 'activity_id': '1', 'attempt': 1,
        })
    assert exc.value.type == 'manual_capture_state_changed'
    assert conn.execute('SELECT status FROM manual_capture_queue WHERE item_id=?', (item_id,)).fetchone()[0] == 'pending'
    retained = json.loads(conn.execute('SELECT retry_context_json FROM manual_capture_queue WHERE item_id=?', (item_id,)).fetchone()[0])
    retained['manual_capture_draft'] = {'content': 'Newer synthetic review'}
    conn.execute('UPDATE manual_capture_queue SET retry_context_json=? WHERE item_id=?', (json.dumps(retained), item_id))
    conn.commit()
    # A request received after the reopen must still carry the generation the
    # caller reviewed, rather than adopting the newly opened generation.
    delayed = build_manual_capture_import_workflow_spec({**params, 'expectedCaptureGeneration': old.capture_generation}).args[0]
    assert delayed.capture_generation is None
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(delayed, conn=conn, attempt_authority={
            'scheduled_us': 2, 'run_id': 'delayed', 'activity_id': '1', 'attempt': 1,
        })
    assert exc.value.type == 'manual_capture_state_changed'
    assert json.loads(conn.execute('SELECT retry_context_json FROM manual_capture_queue WHERE item_id=?', (item_id,)).fetchone()[0])['manual_capture_draft']['content'] == 'Newer synthetic review'
    new = build_manual_capture_import_workflow_spec(params).args[0]
    assert new.capture_generation and new.capture_generation != old.capture_generation
    assert execute_manual_capture_import(new, conn=conn, attempt_authority={
        'scheduled_us': 3, 'run_id': 'new', 'activity_id': '1', 'attempt': 1,
    }).status == 'succeeded'


def test_legacy_direct_bridge_explains_supervised_capture_fence(monkeypatch, tmp_path, capsys):
    from io import StringIO
    import sys
    from jobctrl.discovery import manual_capture_import as bridge

    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    context = {'manual_capture_admission': {'scheduled_us': 10, 'run_id': 'owned', 'activity_id': '1', 'attempt': 1},
               'manual_capture_draft': {'content': 'Synthetic retained input'}}
    conn.execute('UPDATE manual_capture_queue SET retry_context_json=?', (json.dumps(context),))
    conn.commit()
    monkeypatch.setattr(sys, 'stdin', StringIO(json.dumps({
        'itemId': 'manual-1', 'captureMode': 'saved_html', 'capturedUrl': _pending_payload().captured_url,
        'contentText': _CAPTURE_HTML,
    })))
    assert bridge.main(['--db-path', str(path)]) == 2
    captured = capsys.readouterr()
    assert 'Review and retry it in Discovery' in captured.err
    assert 'Synthetic retained input' not in captured.err
    verify = sqlite3.connect(path)
    verify.row_factory = sqlite3.Row
    try:
        assert _pending(verify)['content'] == 'Synthetic retained input'
    finally:
        verify.close()


def test_url_import_cannot_hide_a_retained_manual_draft(monkeypatch, tmp_path):
    from jobctrl.discovery.job_url_import_workflow import execute_job_url_import, JobUrlImportWorkflowInput
    from tests.page_fakes import PageModel

    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    accepted = execute_manual_capture_import(_pending_payload(), conn=conn)
    snapshot = conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0]
    _seed_pending(path, item_id='manual-2')
    conn.execute("UPDATE manual_capture_queue SET source_id='manual_url_import' WHERE item_id='manual-2'")
    conn.commit()
    install_page_models(monkeypatch, model=PageModel(page_kind='unknown'))
    with pytest.raises(ApplicationError):
        execute_manual_capture_import(replace(_pending_payload('manual-2'), content_text=_UNRECOGNIZED), conn=conn)
    draft = _pending(conn, 'manual-2')
    result = execute_job_url_import(
        JobUrlImportWorkflowInput(tenant_id='local', url=_pending_payload().captured_url),
        conn=conn, url_validator=lambda _: type('Allowed', (), {'allowed': True})(),
    )
    assert result.outcome == 'imported' and result.job_id == accepted.job_id
    assert _pending(conn, 'manual-2') == draft
    assert conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0] == snapshot


def test_cited_rendered_selection_accepts_short_posting_without_length_threshold(monkeypatch, tmp_path):
    from tests.manual_capture_fakes import install_manual_capture_selection
    from tests.page_fakes import PageModel

    class ExplicitRenderedSelection:
        def chat_json(self, messages, *, response_schema, **_kwargs):
            assert response_schema['title'] == 'PostingSelectionExtraction'
            data = json.loads(messages[1].content)
            lines = next(source['lines'] for source in data['context']['line_inventory']
                         if source['source_id'] == 'rendered_page')
            description_line = next(line['line_id'] for line in lines if line['text'].strip() == 'Build safe systems.')
            title = {'value': 'Short role', 'citations': [{'source_id': 'rendered_page', 'quote': 'Short role',
                                                         'exact_values': []}], 'rationale': 'Explicit source selection'}
            empty = {'value': '', 'citations': [], 'rationale': 'Not present'}
            return {'title': title, 'employer': empty, 'location': empty, 'salary': empty, 'application_url': empty,
                    'description': {'source_id': 'rendered_page', 'first_line_id': description_line,
                                    'last_line_id': description_line, 'rationale': 'Explicit source selection'},
                    'source_origins': []}

    install_page_models(monkeypatch, model=PageModel(page_kind='posting', access='unknown', availability='unknown'))
    install_manual_capture_selection(monkeypatch, model=ExplicitRenderedSelection())
    html = '<main><h1>Short role</h1><p>Build safe systems.</p></main>'
    conn = _seed_pending(tmp_path / 'jobctrl.db')
    output = execute_manual_capture_import(replace(_pending_payload(), content_text=html), conn=conn)
    assert output.status == 'succeeded'
    assert conn.execute('SELECT full_description FROM job_enrichments WHERE job_id=?', (output.job_id,)).fetchone()[0] == 'Build safe systems.'
    snapshot = json.loads(conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0])['snapshots'][0]
    assert snapshot['active_state'] == 'unknown'


def test_existing_quarantine_evidence_is_not_overwritten(monkeypatch, tmp_path):
    from tests.page_fakes import PageModel

    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    first = execute_manual_capture_import(_pending_payload(), conn=conn)
    conn.execute("""INSERT INTO discovery_quarantine_entries
                 (tenant_id,job_id,source_id,reason,status) VALUES ('local',?,?,'user_review_requested','pending')""",
                 (first.job_id, 'older-source'))
    conn.commit()
    quarantine = tuple(conn.execute('SELECT * FROM discovery_quarantine_entries').fetchone())
    snapshot = conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0]
    _seed_pending(path, item_id='manual-2')
    install_page_models(monkeypatch, model=PageModel(quality='low'))
    html = _CAPTURE_HTML.replace('Build reliable', 'Build dependable')
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(replace(_pending_payload('manual-2'), content_text=html), conn=conn)
    assert exc.value.type == 'manual_capture_state_changed'
    assert _pending(conn, 'manual-2')['content'] == html
    assert tuple(conn.execute('SELECT * FROM discovery_quarantine_entries').fetchone()) == quarantine
    assert conn.execute('SELECT snapshot_set_json FROM posting_snapshot_sets').fetchone()[0] == snapshot


def test_permanent_deletion_of_content_duplicate_during_selection_is_not_recreated(monkeypatch, tmp_path):
    path = tmp_path / 'jobctrl.db'
    conn = _seed_pending(path)
    html = _CAPTURE_HTML.replace('"title": "Staff Engineer",',
                                 '"title": "Staff Engineer", "hiringOrganization": {"name": "Synthetic Acme"},')
    first = execute_manual_capture_import(replace(_pending_payload(), content_text=html), conn=conn)
    _seed_pending(path, item_id='manual-2')
    other_url = 'https://example.test/jobs/staff-engineer-2'
    second_html = html.replace(_pending_payload().captured_url, other_url)
    original = production_wiring._manual_capture_acquisition_service
    def wrapper(*args, **kwargs):
        service = original(*args, **kwargs)
        class Delete:
            def acquire(self, **call):
                result = service.acquire(**call)
                other = sqlite3.connect(path)
                other.execute("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?", (first.job_id,))
                other.commit()
                other.close()
                return result
        return Delete()
    monkeypatch.setattr(production_wiring, '_manual_capture_acquisition_service', wrapper)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(replace(_pending_payload('manual-2'), captured_url=other_url,
                                              content_text=second_html), conn=conn)
    assert exc.value.type == 'manual_capture_state_changed'
    assert _pending(conn, 'manual-2')['content'] == second_html
    assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0
