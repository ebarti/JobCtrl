"""Exact-v7 regressions for administrative stage resets."""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.state import ensure_job_stage_rows, reset_job_stage, set_stage_state


_JOB_ID = JobId("00000000-0000-4000-8000-000000000001")
_JOB_URL = "https://jobs.example/platform-engineer"
_OTHER_TENANT = TenantId("other")
_NOW = "2026-07-31T09:00:00+00:00"


def _exact_v7_candidate(stage: str) -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    candidate.executemany(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
        VALUES (?, ?, ?, 'Platform Engineer', ?)
        """,
        [
            (str(LOCAL_TENANT), str(_JOB_ID), _JOB_URL, _NOW),
            (str(_OTHER_TENANT), str(_JOB_ID), _JOB_URL, _NOW),
        ],
    )
    candidate.execute(
        """
        UPDATE jobs
        SET tailored_resume_path = 'legacy-resume.md',
            cover_letter_path = 'legacy-cover.md'
        """
    )
    for tenant_id in (LOCAL_TENANT, _OTHER_TENANT):
        ensure_job_stage_rows(candidate, _JOB_ID, tenant_id=tenant_id, discovered_at=_NOW)
        set_stage_state(
            candidate,
            _JOB_ID,
            stage,
            "failed",
            tenant_id=tenant_id,
            error_code="QUALITY_GATE",
            error_message="needs revision",
            validate_transition=False,
        )
        candidate.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status, created_at, updated_at
            ) VALUES (?, ?, 1, 'review_pending', ?, ?)
            """,
            (str(tenant_id), str(_JOB_ID), _NOW, _NOW),
        )
        artifacts = [
            ("tailored_resume", "approved" if stage == "cover" else "rejected", "resume.md", "markdown"),
            ("resume_pdf", "approved" if stage == "cover" else "rejected", "resume.pdf", "pdf"),
        ]
        if stage == "cover":
            artifacts.extend(
                [
                    ("cover_letter", "rejected", "cover.md", "markdown"),
                    ("cover_letter_pdf", "rejected", "cover.pdf", "pdf"),
                ]
            )
        candidate.executemany(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    str(tenant_id),
                    str(_JOB_ID),
                    artifact_type,
                    f"{tenant_id}-{artifact_type}",
                    status,
                    path,
                    render_format,
                    _NOW,
                )
                for artifact_type, status, path, render_format in artifacts
            ],
        )
    candidate.commit()
    return candidate


@pytest.mark.parametrize(
    ("stage", "expected_status", "remaining_artifacts"),
    [
        ("tailor", "resume_in_progress", set()),
        ("cover", "resume_approved", {"tailored_resume", "resume_pdf"}),
    ],
)
def test_reset_materials_uses_tenant_scoped_job_id(
    stage: str,
    expected_status: str,
    remaining_artifacts: set[str],
) -> None:
    candidate = _exact_v7_candidate(stage)

    assert reset_job_stage(candidate, _JOB_URL, stage) == _JOB_URL

    local_materials = candidate.execute(
        """
        SELECT status
        FROM job_materials
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert local_materials is not None
    assert local_materials["status"] == expected_status
    local_artifacts = candidate.execute(
        """
        SELECT artifact_type
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchall()
    assert {row["artifact_type"] for row in local_artifacts} == remaining_artifacts

    local_state = candidate.execute(
        """
        SELECT state
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = ?
        """,
        (str(LOCAL_TENANT), str(_JOB_ID), stage),
    ).fetchone()
    assert local_state is not None
    assert local_state["state"] == "pending"
    local_event = candidate.execute(
        """
        SELECT job_id
        FROM job_events
        WHERE tenant_id = ? AND event_type = 'StageReset'
        ORDER BY event_id DESC
        LIMIT 1
        """,
        (str(LOCAL_TENANT),),
    ).fetchone()
    assert local_event is not None
    assert local_event["job_id"] == str(_JOB_ID)
    legacy_projection = candidate.execute(
        """
        SELECT tailored_resume_path, cover_letter_path
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert legacy_projection is not None
    assert legacy_projection["tailored_resume_path"] == "legacy-resume.md"
    assert legacy_projection["cover_letter_path"] == "legacy-cover.md"

    other_materials = candidate.execute(
        """
        SELECT status
        FROM job_materials
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(_OTHER_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert other_materials is not None
    assert other_materials["status"] == "review_pending"
    other_artifact_count = candidate.execute(
        """
        SELECT COUNT(*)
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id = ? AND generation = 1
        """,
        (str(_OTHER_TENANT), str(_JOB_ID)),
    ).fetchone()[0]
    assert other_artifact_count == (4 if stage == "cover" else 2)


@pytest.mark.parametrize('state', ['pending', 'failed', 'canceled'])
def test_apply_reset_requires_owner_ack_independently_of_stage_label(state):
    from jobctrl.state import record_job_event
    conn = _exact_v7_candidate('apply')
    set_stage_state(conn, _JOB_ID, 'apply', state, validate_transition=False)
    record_job_event(conn, _JOB_ID, 'apply', 'ApplyClaimAcquired', payload={'run_id': 'admitted', 'launcher_id': 'launcher'})
    record_job_event(conn, _JOB_ID, 'apply', 'ApplyRunStarted', payload={'run_id': 'admitted'})
    record_job_event(conn, _JOB_ID, 'apply', 'StageCanceled', payload={'run_id': 'admitted'})
    conn.commit()
    before = [tuple(r) for r in conn.execute('SELECT * FROM job_stage_states')]
    events = conn.execute('SELECT COUNT(*) FROM job_events').fetchone()[0]
    with pytest.raises(ValueError, match='prior admitted run'):
        reset_job_stage(conn, _JOB_ID, 'apply')
    assert [tuple(r) for r in conn.execute('SELECT * FROM job_stage_states')] == before
    assert conn.execute('SELECT COUNT(*) FROM job_events').fetchone()[0] == events
    record_job_event(conn, _JOB_ID, 'apply', 'LockReleased', payload={'run_id': 'other'})
    conn.commit()
    with pytest.raises(ValueError, match='prior admitted run'):
        reset_job_stage(conn, _JOB_ID, 'apply')
    record_job_event(conn, _JOB_ID, 'apply', 'LockReleased', payload={'run_id': 'admitted'})
    conn.commit()
    with pytest.raises(ValueError, match='prior admitted run'):
        reset_job_stage(conn, _JOB_ID, 'apply')
    record_job_event(conn, _JOB_ID, 'apply', 'ApplyClaimSettled', payload={'run_id': 'admitted', 'launcher_id': 'other'})
    conn.commit()
    with pytest.raises(ValueError, match='prior admitted run'):
        reset_job_stage(conn, _JOB_ID, 'apply')
    record_job_event(conn, _JOB_ID, 'apply', 'ApplyClaimSettled', payload={'run_id': 'admitted', 'launcher_id': 'launcher'})
    conn.commit()
    reset_job_stage(conn, _JOB_ID, 'apply')
    assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'", (_JOB_ID,)).fetchone()[0] == 'pending'


@pytest.mark.parametrize(('source', 'payload', 'message', 'refusal'), [
    ('ApplicationManuallyMarked', {}, 'manual attestation', 'applied'),
    ('StageSkipped', {'previousState': 'succeeded', 'manualDisposition': 'skip'}, 'legacy skip', 'applied'),
    ('StageSkipped', {'previousState': 'needs_verification', 'manualDisposition': 'skip'}, 'legacy skip', 'verification'),
    ('ApplicationFailed', {'result': 'needs_verification'}, 'legacy uncertainty', 'verification'),
    ('StageSkipped', {'previousState': 'queued', 'manualDisposition': 'skip'}, 'legacy skip', 'queued'),
    ('ApplyManualSkip', {'result': 'manual'}, 'manual ATS', 'policy'),
    ('StageSkipped', {'reason': 'score_below_threshold', 'fitScore': 3, 'minScore': 7, 'upstreamStage': 'score', 'downstreamStage': 'apply'}, 'Fit score 3/10 is below the materials threshold 7/10.', 'policy'),
])
def test_apply_reset_preserves_legacy_authority_after_repeated_skip(source, payload, message, refusal):
    from jobctrl.state import record_job_event

    conn = _exact_v7_candidate('apply')
    set_stage_state(conn, _JOB_ID, 'apply', 'skipped', attempt_count=2, retryable=False, validate_transition=False)
    record_job_event(conn, _JOB_ID, 'apply', source, payload=payload, message=message)
    record_job_event(conn, _JOB_ID, 'apply', 'StageSkipped', payload={'reason': 'legacy'}, message='Job marked skipped from the local API.')
    record_job_event(conn, _JOB_ID, 'apply', 'StageSkipped', payload={'previousState': 'skipped', 'manualDisposition': 'skip'})
    conn.commit()
    before = [tuple(row) for row in conn.execute('SELECT * FROM job_stage_states')]
    events = [tuple(row) for row in conn.execute('SELECT * FROM job_events ORDER BY event_id')]
    with pytest.raises(ValueError, match=refusal):
        reset_job_stage(conn, _JOB_ID, 'apply', reset_attempts=True)
    assert [tuple(row) for row in conn.execute('SELECT * FROM job_stage_states')] == before
    assert [tuple(row) for row in conn.execute('SELECT * FROM job_events ORDER BY event_id')] == events


def test_apply_reset_recognizes_real_score_policy_event_after_legacy_skip():
    from jobctrl.state import reconcile_score_threshold_skips, record_job_event

    conn = _exact_v7_candidate('apply')
    set_stage_state(conn, _JOB_ID, 'apply', 'pending', validate_transition=False)
    reconcile_score_threshold_skips(conn, tenant_id=LOCAL_TENANT, job_id=_JOB_ID, fit_score=3, min_score=7)
    # The old API overwrote the policy-owned error on repeated manual Skip.
    conn.execute("UPDATE job_stage_states SET state='skipped', error_code=NULL WHERE tenant_id=? AND job_id=? AND stage='apply'", (str(LOCAL_TENANT), str(_JOB_ID)))
    record_job_event(conn, _JOB_ID, 'apply', 'StageSkipped', message='Job marked skipped from the local API.', payload={'reason': 'legacy'})
    conn.commit()
    with pytest.raises(ValueError, match='policy'):
        reset_job_stage(conn, _JOB_ID, 'apply')


def test_apply_reset_does_not_treat_user_score_reason_as_score_policy():
    from jobctrl.state import record_job_event

    conn = _exact_v7_candidate('apply')
    set_stage_state(conn, _JOB_ID, 'apply', 'skipped', retryable=False, error_code=None, validate_transition=False)
    record_job_event(conn, _JOB_ID, 'apply', 'StageSkipped', message='Job marked skipped from the local API.', payload={'reason': 'score_below_threshold'})
    record_job_event(conn, _JOB_ID, 'apply', 'StageSkipped', message='Skipped locally.', payload={'manualDisposition': 'skip', 'previousState': 'skipped', 'reason': 'score_below_threshold'})
    conn.commit()
    reset_job_stage(conn, _JOB_ID, 'apply')
    assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'", (str(LOCAL_TENANT), str(_JOB_ID))).fetchone()[0] == 'pending'


def test_score_clearance_does_not_release_manual_ats_with_user_score_reason():
    from jobctrl.state import record_job_event

    conn = _exact_v7_candidate('apply')
    set_stage_state(conn, _JOB_ID, 'apply', 'skipped', retryable=False, error_code=None, validate_transition=False)
    record_job_event(conn, _JOB_ID, 'apply', 'ApplyManualSkip', message='manual ATS', payload={'result': 'manual'})
    record_job_event(conn, _JOB_ID, 'apply', 'StageSkipped', message='Skipped locally.', payload={'manualDisposition': 'skip', 'previousState': 'skipped', 'previousErrorCode': 'MANUAL_ATS', 'reason': 'score_below_threshold'})
    record_job_event(conn, _JOB_ID, 'apply', 'StageReset', message='apply restored after the score threshold allowed materials.', payload={'reason': 'score_threshold_cleared', 'upstreamStage': 'score', 'downstreamStage': 'apply'})
    conn.commit()
    with pytest.raises(ValueError, match='policy'):
        reset_job_stage(conn, _JOB_ID, 'apply')
