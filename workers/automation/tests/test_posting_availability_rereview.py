"""Re-review regressions across canonical availability/content/Apply boundaries."""
from datetime import timedelta
import threading

import pytest

from jobctrl.enrichment import availability, detail
from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState, QuarantineReason, SnapshotConfidence
from jobctrl.domain.enrichment.snapshot_services import _quarantine_for_capture
from jobctrl.enrichment import availability_workflow
from .test_saved_posting_availability import saved_job as _saved_job, JOB_ID, NOW, URL

saved_job = _saved_job


@pytest.mark.parametrize('confidence, expected', [
    (SnapshotConfidence.MEDIUM, QuarantineReason.NONE),
    (SnapshotConfidence.HIGH, QuarantineReason.NONE),
    (SnapshotConfidence.LOW, QuarantineReason.LOW_CONFIDENCE_EXTRACTION),
])
def test_unknown_availability_does_not_quarantine_trusted_content(confidence, expected):
    assert _quarantine_for_capture(confidence=confidence, active_state=ActiveState.UNKNOWN,
                                   has_apply_url=True, filter_override=None) is expected


def test_unknown_canonical_capture_does_not_create_pending_review(saved_job):
    detail._record_posting_snapshot_from_cascade(saved_job, job_id=JOB_ID, url=URL, source_id='synthetic',
        title='Synthetic', cascade_result={'full_description': 'Build reliable synthetic systems. ' * 30,
        'tier_used': 1, 'application_url': URL + '/apply', 'active_state': 'unknown'}, captured_at=NOW.isoformat())
    assert saved_job.execute("SELECT COUNT(*) FROM discovery_quarantine_entries WHERE status='pending'").fetchone()[0] == 0
    payload = availability._latest(saved_job, 'local', 'posting_snapshot', JOB_ID + ':1')
    assert payload['quarantineReason'] == 'none'
    assert payload['quarantined'] is False


def test_active_recheck_resolves_legacy_availability_only_review(saved_job, monkeypatch):
    # Historical capture policy is the only seam; canonical persistence and
    # the availability reversal run unchanged.
    with monkeypatch.context() as old_policy:
        old_policy.setattr(detail, '_quarantine_for_capture', lambda **_: QuarantineReason.UNKNOWN_ACTIVE_STATE)
        detail._record_posting_snapshot_from_cascade(saved_job, job_id=JOB_ID, url=URL, source_id='synthetic',
            title='Synthetic', cascade_result={'full_description': 'Build reliable systems. ' * 30,
            'tier_used': 1, 'application_url': URL + '/apply', 'active_state': 'unknown'}, captured_at=NOW.isoformat())
    assert saved_job.execute("SELECT status FROM discovery_quarantine_entries").fetchone()[0] == 'pending'
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    availability.complete_check(saved_job, claim, verdict='active', reason='verified', method='fixture', lineage=[], now=NOW)
    assert saved_job.execute("SELECT status FROM discovery_quarantine_entries").fetchone()[0] == 'resolved'


@pytest.mark.parametrize('reason', ['host_pacing_or_cooldown', 'shared_host_cooldown'])
def test_prefixed_browser_local_refusal_preserves_evidence_and_backoff(saved_job, reason):
    claim, _ = availability.claim_job(saved_job, JOB_ID, now=NOW)
    value = availability.complete_check(saved_job, claim, verdict='unknown',
        reason='browser_guard: ' + reason, method='anonymous_browser', lineage=[], now=NOW)
    assert value['requestStatus'] == 'deferred'
    assert not availability._latest(saved_job, 'local', 'posting_availability', JOB_ID)
    assert not value['checkInProgress']


@pytest.mark.parametrize('age, expected', [(timedelta(days=21), False), (timedelta(minutes=2), True)])
def test_unknown_apply_review_has_a_recency_bound(saved_job, monkeypatch, age, expected):
    from jobctrl.apply import launcher
    from .test_apply_regressions import _insert_ready_job, _seed_current_apply_binding, _insert_review_decision
    job = _insert_ready_job(saved_job, url=URL + '-review')
    _seed_current_apply_binding(saved_job, job_id=job)
    _insert_review_decision(saved_job, job_id=job, decision='approve_submit', decided_at=(NOW - age).isoformat(),
        materials_generation=1, profile_version=1, application_url='https://example.com/apply')
    monkeypatch.setattr(launcher, '_utc_now', lambda: NOW.isoformat())
    assert launcher._has_current_apply_review(saved_job, 'local', job) is expected


def test_unattended_claim_uses_recent_bound_review_for_unknown(saved_job, monkeypatch):
    from jobctrl.apply import launcher
    from .test_apply_regressions import _insert_ready_job, _seed_current_apply_binding, _insert_review_decision
    job = _insert_ready_job(saved_job, url=URL + '-reviewed')
    _seed_current_apply_binding(saved_job, job_id=job)
    _insert_review_decision(saved_job, job_id=job, decision='approve_submit', decided_at=NOW.isoformat(),
        materials_generation=1, profile_version=1, application_url='https://example.com/apply')
    claim, _ = availability.claim_job(saved_job, job, now=NOW)
    availability.complete_check(saved_job, claim, verdict='unknown', reason='identity_lost', method='fixture', lineage=[], now=NOW)
    monkeypatch.setattr(availability, '_now', lambda: NOW)
    monkeypatch.setattr(launcher, '_utc_now', lambda: NOW.isoformat())
    monkeypatch.setattr(launcher, 'get_connection', lambda: saved_job)
    acquired = launcher.acquire_job(target_job_id=job, approval_required=False)
    assert acquired['job_id'] == job
    with launcher._authorize_posting_before_submit('local', job, URL + '-reviewed', acquired['apply_run_id']):
        assert saved_job.in_transaction


def test_unknown_top_candidate_does_not_starve_fresh_active_peer(saved_job, monkeypatch):
    from jobctrl.apply import launcher
    from .test_apply_regressions import _insert_ready_job
    first = _insert_ready_job(saved_job, url='https://example.com/a-unknown')
    second = _insert_ready_job(saved_job, url='https://example.com/b-active')
    claim, _ = availability.claim_job(saved_job, first, now=NOW)
    availability.complete_check(saved_job, claim, verdict='unknown', reason='identity_lost', method='fixture', lineage=[], now=NOW)
    active, _ = availability.claim_job(saved_job, second, now=NOW)
    availability.complete_check(saved_job, active, verdict='active', reason='fixture', method='fixture', lineage=[], now=NOW)
    monkeypatch.setattr(availability, '_now', lambda: NOW)
    monkeypatch.setattr(launcher, 'get_connection', lambda: saved_job)
    assert launcher.acquire_job(approval_required=False)['job_id'] == second


def test_one_apply_poll_refreshes_once_and_can_claim_an_active_peer(saved_job, monkeypatch):
    from jobctrl.apply import launcher
    from .test_apply_regressions import _insert_ready_job
    urls = [f'https://93.184.216.{ip}/jobs/owned-synthetic' for ip in (34, 35, 36)]
    jobs = [_insert_ready_job(saved_job, url=url) for url in urls]
    unchanged = availability._latest(saved_job, 'local', 'posting_availability', jobs[1])
    claim, _ = availability.claim_job(saved_job, jobs[2], now=NOW)
    availability.complete_check(saved_job, claim, verdict='active', reason='fixture', method='fixture', lineage=[], now=NOW)
    monkeypatch.setattr(availability, '_now', lambda: NOW)
    monkeypatch.setattr(launcher, 'get_connection', lambda: saved_job)
    calls = []
    def transport(url):
        calls.append(url)
        return availability.Response(url, url, 429, b'Synthetic unavailable data')
    monkeypatch.setattr(availability, 'public_get', transport)
    assert launcher.acquire_job(approval_required=False)['job_id'] == jobs[2]
    assert calls == [urls[0]]
    assert availability._latest(saved_job, 'local', 'posting_availability', jobs[1]) == unchanged


def test_submit_time_unknown_retains_the_already_claimed_attempt_without_intent(saved_job, monkeypatch):
    from jobctrl.apply import launcher
    from jobctrl.domain.errors import SourceUnavailableError
    from .test_apply_regressions import _insert_ready_job
    job = _insert_ready_job(saved_job, url=URL + '-late-unknown')
    claim, _ = availability.claim_job(saved_job, job, now=NOW)
    availability.complete_check(saved_job, claim, verdict='active', reason='fixture', method='fixture', lineage=[], now=NOW)
    monkeypatch.setattr(availability, '_now', lambda: NOW)
    monkeypatch.setattr(launcher, 'get_connection', lambda: saved_job)
    acquired = launcher.acquire_job(target_job_id=job, approval_required=False)
    assert acquired is not None
    later = NOW + timedelta(minutes=2)
    monkeypatch.setattr(availability, '_now', lambda: later)
    claim, _ = availability.claim_job(saved_job, job, now=later)
    availability.complete_check(saved_job, claim, verdict='unknown', reason='access_challenge', method='fixture', lineage=[], now=later)
    with pytest.raises(SourceUnavailableError):
        with launcher._authorize_posting_before_submit('local', job, URL + '-late-unknown', acquired['apply_run_id']):
            pytest.fail('unattended unknown reached submit intent')
    assert saved_job.execute("SELECT attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (job,)).fetchone()[0] == 1
    assert not saved_job.execute("SELECT 1 FROM job_events WHERE event_type='ApplySubmitIntended' AND job_id=?", (job,)).fetchone()


def test_saturated_sweep_repeats_without_per_job_writes(saved_job, monkeypatch):
    for i in range(80):
        availability._event(saved_job, 'local', 'availability_acquisition', f'admitted-{i}', {}, now=NOW)
    saved_job.commit()
    monkeypatch.setattr(availability, '_now', lambda: NOW)
    before = saved_job.execute('SELECT COUNT(*) FROM job_events').fetchone()[0]
    for _ in range(3):
        result = availability_workflow.run_availability_sweep(saved_job, 'local')
        assert result['checked'] == 0
        assert result['deferredReason'] == 'workspace_hourly_quota'
    assert saved_job.execute('SELECT COUNT(*) FROM job_events').fetchone()[0] == before


def test_sweep_deadline_and_cancellation_stop_before_next_job(saved_job, monkeypatch):
    instant = [0.0]
    cancel = threading.Event()
    calls = []
    monkeypatch.setattr(availability_workflow.time, 'monotonic', lambda: instant[0])
    monkeypatch.setattr(availability, 'due_jobs', lambda *_a, **_kw: [JOB_ID] * 25)
    def check(job, **_kw):
        calls.append(job)
        instant[0] += 121
        if len(calls) == 2:
            cancel.set()
        return {'verdict': 'unknown'}
    monkeypatch.setattr(availability, 'check_availability', check)
    result = availability_workflow.run_availability_sweep(saved_job, 'local', cancel_event=cancel, budget_seconds=180)
    assert result['checked'] == 1
    assert result['deferredReason'] == 'sweep_deadline'
    instant[0] = 0
    calls.clear()
    cancel.set()
    assert availability_workflow.run_availability_sweep(saved_job, 'local', cancel_event=cancel)['checked'] == 0


def test_cancel_during_http_does_not_persist_a_late_verdict(saved_job):
    canceled = threading.Event()
    def fetch(url):
        canceled.set()
        html = ('<script type="application/ld+json">{"@type":"JobPosting","url":"' + URL + '","description":"Synthetic role"}</script>').encode()
        return availability.Response(url, url, 200, html)
    value = availability.check_availability(JOB_ID, conn=saved_job, transport=fetch, cancel_event=canceled)
    assert value['requestStatus'] == 'deferred'
    assert not availability._latest(saved_job, 'local', 'posting_availability', JOB_ID)
