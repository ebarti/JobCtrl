"""Exact-v7 integration tests for per-job scoring runtime identity."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.events.materials import (
    EmployerAnalyzedPayload,
    create_employer_analyzed,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.scoring import ScoringCriteria
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.scoring import SqliteScoreRepository
from jobctrl.scoring import scorer as scorer_module
from jobctrl.scoring.employer_analysis import EmployerAnalyzedEventRecorder


_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_ID_A = canonical_job_id("10000000-0000-4000-8000-000000000001")
_JOB_ID_B = canonical_job_id("20000000-0000-4000-8000-000000000002")
_POSTING_URL = "https://jobs.example.test/roles/platform-engineer"


class _StrongLlm:
    model = "test-model"

    def __init__(self) -> None:
        self.calls = 0

    def chat_json(self, *_args, **_kwargs) -> dict:
        self.calls += 1
        return {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 8,
            "role_fit": 8,
            "fit_band": "strong",
            "confidence": "high",
            "eligibility": {
                "status": "eligible",
                "hard_blockers": [],
                "warnings": [],
            },
            "matched_signals": ["Python"],
            "missing_signals": [],
            "transferable_signals": [],
            "keywords": ["python"],
            "reasoning": "Strong fit.",
        }


class _BlockedLlm(_StrongLlm):
    def chat_json(self, *_args, **_kwargs) -> dict:
        payload = super().chat_json(*_args, **_kwargs)
        payload["eligibility"] = {
            "status": "blocked",
            "hard_blockers": ["Work authorization required."],
            "warnings": [],
        }
        return payload


@pytest.fixture()
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    connection = init_db(tmp_path / "jobctrl-v7.db")
    monkeypatch.setattr(scorer_module, "get_connection", lambda: connection)
    return connection


def _profile_snapshot(tenant_id: TenantId) -> ProfileSnapshot:
    profile = Profile.from_dict(
        tenant_id,
        {
            "personal": {"full_name": "Candidate"},
            "resume": {
                "executive_profile": {"baseline_text": "Python platform engineer."},
                "experience_entries": [
                    {
                        "id": "platform",
                        "title": "Platform Engineer",
                        "company": "Previous Co",
                        "bullets": ["Built Python services."],
                    }
                ],
                "education_entries": [],
                "skill_categories": [],
            },
        },
    )
    return ProfileSnapshot.from_profile(profile)


def _seed_target(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    posting_url: str = _POSTING_URL,
) -> None:
    now = "2026-07-30T10:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, location, site,
            strategy, discovered_at
        ) VALUES (?, ?, ?, 'Platform Engineer', 'Acme', 'Remote',
                  'example', 'search', ?)
        """,
        (str(tenant_id), str(job_id), posting_url, now),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (str(tenant_id), str(job_id), posting_url, now, now),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            enriched_at, extraction_tier, updated_at
        ) VALUES (?, ?, 'enriched', 'Build Python platform services.', ?,
                  'high', ?)
        """,
        (str(tenant_id), str(job_id), now, now),
    )
    conn.commit()


def _score_by_id(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    llm: _StrongLlm,
):
    return scorer_module.score_job_by_id(
        job_id,
        tenant_id=tenant_id,
        profile_snapshot=_profile_snapshot(tenant_id),
        resume_text="Python platform engineer.",
        criteria=ScoringCriteria(),
        repository=SqliteScoreRepository(conn),
        llm_port=llm,
        require_employer_analysis=False,
    )


def test_score_by_id_isolates_same_job_id_across_tenants(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    _seed_target(conn, tenant_id=_TENANT_B, job_id=_JOB_ID_A)
    llm = _StrongLlm()

    outcome = _score_by_id(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID_A,
        llm=llm,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.job_id == _JOB_ID_A
    assert llm.calls == 1
    assert SqliteScoreRepository(conn).load(_TENANT_A, _JOB_ID_A) is not None
    assert SqliteScoreRepository(conn).load(_TENANT_B, _JOB_ID_A) is None
    stage_rows = conn.execute(
        """
        SELECT tenant_id, job_id, state
        FROM job_stage_states
        WHERE stage = 'score'
        ORDER BY tenant_id
        """
    ).fetchall()
    assert [(row["tenant_id"], row["job_id"], row["state"]) for row in stage_rows] == [
        (str(_TENANT_A), str(_JOB_ID_A), "succeeded"),
    ]
    event = conn.execute(
        """
        SELECT tenant_id, job_id, identity_version
        FROM job_events
        WHERE event_type = 'StageCompleted'
        """
    ).fetchone()
    assert tuple(event) == (str(_TENANT_A), str(_JOB_ID_A), 1)


def test_url_adapter_resolves_locator_inside_requested_tenant(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    _seed_target(conn, tenant_id=_TENANT_B, job_id=_JOB_ID_B)

    outcome = scorer_module.score_job_by_url(
        _POSTING_URL,
        tenant_id=_TENANT_B,
        profile_snapshot=_profile_snapshot(_TENANT_B),
        resume_text="Python platform engineer.",
        criteria=ScoringCriteria(),
        repository=SqliteScoreRepository(conn),
        llm_port=_StrongLlm(),
        require_employer_analysis=False,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.job_id == _JOB_ID_B
    assert SqliteScoreRepository(conn).load(_TENANT_A, _JOB_ID_A) is None
    assert SqliteScoreRepository(conn).load(_TENANT_B, _JOB_ID_B) is not None


def test_score_by_id_blocks_downstream_stages_for_hard_blocker(
    conn: sqlite3.Connection,
) -> None:
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)

    outcome = _score_by_id(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID_A,
        llm=_BlockedLlm(),
    )

    assert outcome.ok is True
    rows = conn.execute(
        """
        SELECT stage, state, error_code
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID_A)),
    ).fetchall()
    state_by_stage = {row["stage"]: (row["state"], row["error_code"]) for row in rows}
    assert state_by_stage["score"] == ("succeeded", None)
    for stage in ("tailor", "cover", "apply"):
        assert state_by_stage[stage] == ("blocked", "SCORE_ELIGIBILITY_BLOCKED")


def test_score_by_id_rejects_url_shaped_identity_before_llm(
    conn: sqlite3.Connection,
) -> None:
    llm = _StrongLlm()

    with pytest.raises(ValueError, match="canonical UUID"):
        _score_by_id(
            conn,
            tenant_id=_TENANT_A,
            job_id=JobId(_POSTING_URL),
            llm=llm,
        )

    assert llm.calls == 0


def test_employer_analysis_event_preserves_tenant_and_job_id(
    conn: sqlite3.Connection,
) -> None:
    event = create_employer_analyzed(
        _TENANT_B,
        EmployerAnalyzedPayload(
            job_id=str(_JOB_ID_B),
            generation=2,
            snapshot_hash="snapshot",
            cache_key="cache-key",
            legs_attempted=3,
            legs_succeeded=2,
            analyzed_at="2026-07-30T10:00:00+00:00",
        ),
    )

    EmployerAnalyzedEventRecorder(conn, stage="score").publish(event)

    row = conn.execute(
        """
        SELECT tenant_id, job_id, stage, event_type
        FROM job_events
        WHERE event_type = 'EmployerAnalyzed'
        """
    ).fetchone()
    assert tuple(row) == (
        str(_TENANT_B),
        str(_JOB_ID_B),
        "score",
        "EmployerAnalyzed",
    )
