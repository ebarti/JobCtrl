"""Reproduce automatic retry of terminal content outcomes in owned SQLite."""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from jobctrl.domain.errors import MATERIAL_REJECTION_STATUSES
from jobctrl.pipeline.automatic_preparation import _retry_due
from tests import test_v7_cover_runtime as cover
from tests.test_v7_tailor_runtime import conn as conn, _seed_job, _TENANT_A, _JOB_ID, tailor_module

cover_conn = cover.conn


@pytest.mark.parametrize('status', sorted(MATERIAL_REJECTION_STATUSES))
def test_terminal_content_does_not_become_a_new_automatic_attempt(conn, tmp_path, monkeypatch, status):
    _seed_job(conn, tenant_id=_TENANT_A, url='https://example.test/terminal-content')
    calls = []
    def reject(job, *_args, **_kwargs):
        calls.append(job['job_id'])
        return {'url': job['url'], 'status': status, 'attempts': 3, 'error': 'Owned bounded content rejection'}
    monkeypatch.setattr(tailor_module, 'get_connection', lambda: conn)
    monkeypatch.setattr(tailor_module, 'TAILORED_DIR', tmp_path / 'tailored')
    monkeypatch.setattr(tailor_module, '_build_pdf_renderer', lambda: object())
    monkeypatch.setattr(tailor_module, '_tailor_one_job', reject)
    result = tailor_module.tailor_job_by_id(_JOB_ID, tenant_id=_TENANT_A, snapshot=SimpleNamespace(), llm_model=None)
    assert result['status'] == status
    state = dict(conn.execute("SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='tailor'",
                             (str(_TENANT_A), str(_JOB_ID))).fetchone())
    assert state['state'] == 'failed' and state['attempt_count'] == 1
    state['updated_at'] = '2026-01-01T00:00:00+00:00'
    assert not _retry_due(state, datetime(2026, 10, 25, tzinfo=timezone.utc))
    # An explicit new request remains possible; the automatic coordinator cannot
    # spend another complete correction budget without that request.
    second = tailor_module.tailor_job_by_id(_JOB_ID, tenant_id=_TENANT_A, snapshot=SimpleNamespace(), llm_model=None)
    assert second['status'] == status and len(calls) == 2



@pytest.mark.parametrize('status', sorted(MATERIAL_REJECTION_STATUSES))
def test_cover_terminal_content_is_not_automatically_retried(cover_conn, tmp_path, monkeypatch, status):
    from jobctrl.domain.materials.use_cases import CoverLetterOutcome
    from jobctrl.infrastructure.materials import SqliteMaterialsRepository
    cover._seed_target(cover_conn, tenant_id=cover._TENANT_A)
    cover._seed_eligible_score(cover_conn, tenant_id=cover._TENANT_A)
    cover._seed_approved_resume(cover_conn, tmp_path, tenant_id=cover._TENANT_A)
    repository = SqliteMaterialsRepository(cover_conn)
    accepted = repository.load_current_approved(cover._TENANT_A, cover._JOB_ID)
    before = accepted.tailored_resume.artifact_id
    class RejectedContent:
        def execute(self, **kwargs):
            return CoverLetterOutcome(materials=accepted, status=status, error='Owned bounded content rejection')
    monkeypatch.setattr(cover.cover_letter_module, '_build_use_case', lambda **kwargs: RejectedContent())
    result = cover.cover_letter_module.cover_letter_by_id(
        cover._JOB_ID, tenant_id=cover._TENANT_A, snapshot=cover._snapshot(cover._TENANT_A),
        repository=repository, llm_port=cover._CoverLlm(), pdf_renderer=cover._PdfRenderer(),
    )
    assert result['status'] == status
    state = dict(cover_conn.execute("SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='cover'",
        (str(cover._TENANT_A), str(cover._JOB_ID))).fetchone())
    assert state['state'] == 'failed' and state['attempt_count'] == 1
    state['updated_at'] = '2026-01-01T00:00:00+00:00'
    assert not _retry_due(state, datetime(2026, 10, 25, tzinfo=timezone.utc))
    event = cover_conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='cover' AND event_type='StageFailed' ORDER BY event_id DESC LIMIT 1",
        (str(cover._TENANT_A), str(cover._JOB_ID))).fetchone()
    assert json.loads(event[0])['retryable'] is False
    assert repository.load_current_approved(cover._TENANT_A, cover._JOB_ID).tailored_resume.artifact_id == before
