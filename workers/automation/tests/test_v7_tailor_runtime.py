"""Exact-v7 proof for the canonical per-job tailoring execution path."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.use_cases import TailoringPrerequisiteError
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.materials import activities as activities_module
from jobctrl.materials.activities import TailorJobActivityInput
from jobctrl.scoring import tailor as tailor_module

_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_ID = canonical_job_id("30000000-0000-4000-8000-000000000001")


@pytest.fixture()
def conn() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return candidate


def _seed_job(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
    url: str,
    fit_score: int = 8,
    eligibility_status: str = "eligible",
    hard_blockers: list[str] | None = None,
) -> None:
    now = "2026-07-31T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            url,
            "Platform Engineer",
            "Acme",
            "Build reliable backend systems.",
            now,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier, attempts_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            "enriched",
            "Build reliable backend systems with Python.",
            url,
            now,
            "full",
            now,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, ?, 1, ?, ?, '[]', ?, NULL, '{}', '{}')
        """,
        (
            str(tenant_id),
            str(job_id),
            fit_score,
            json.dumps(
                {
                    "technical_fit": fit_score,
                    "experience_fit": fit_score,
                    "role_fit": fit_score,
                    "reasoning": "seeded exact-v7 score",
                    "fit_band": "excellent",
                    "confidence": "high",
                    "eligibility": {
                        "status": eligibility_status,
                        "hard_blockers": hard_blockers or [],
                        "warnings": [],
                    },
                }
            ),
            now,
        ),
    )
    tailor_module.ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at=now,
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'succeeded'
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (str(tenant_id), str(job_id)),
    )
    conn.commit()


def _fake_approved_result(job: dict) -> dict:
    return {
        "url": job["url"],
        "title": job["title"],
        "site": job.get("site"),
        "status": "approved",
        "attempts": 1,
        "path": "/tmp/tailored.txt",
        "pdf_path": "/tmp/tailored.pdf",
        "materials": SimpleNamespace(generation=1),
    }


def _snapshot(tenant_id: TenantId) -> ProfileSnapshot:
    return ProfileSnapshot.from_profile(
        Profile.from_dict(
            tenant_id,
            {
                "personal": {"full_name": "Candidate"},
                "resume": {
                    "executive_profile": {
                        "baseline_text": "Python platform engineer."
                    },
                    "experience_entries": [
                        {
                            "id": "platform",
                            "title": "Platform Engineer",
                            "company": "Previous Co",
                            "bullets": ["Built Python platform services."],
                        }
                    ],
                    "education_entries": [],
                    "skill_categories": [
                        {"id": "skills", "label": "Skills", "items": ["Python"]}
                    ],
                },
            },
        )
    )


class _FakeAnalyzeUseCase:
    def execute(self, *, job: dict, tenant_id: TenantId, force: bool = False):
        _ = force
        analysis = JobAnalysis(
            role_framing="Platform engineering.",
            inferred_seniority="senior",
            ideal_candidate_narrative="A Python platform engineer.",
            requirements=[],
            keywords=[ReasonedKeyword(keyword="Python", evidence_span="Python")],
        )
        return SimpleNamespace(
            analysis=EmployerAnalysis.build(
                tenant_id=tenant_id,
                job_id=canonical_job_id(str(job["job_id"])),
                generation=1,
                snapshot_hash=compute_snapshot_hash(
                    str(job.get("full_description") or "")
                ),
                canonical=analysis,
                sub_analyses=(),
                failures=(),
                agreement=AnalysisAgreement(score=1.0),
                legs_attempted=2,
            )
        )


class _CancelingTailorLlm:
    model = "test-model"

    def __init__(self, cancel_event: threading.Event) -> None:
        self._cancel_event = cancel_event
        self.calls = 0

    def chat(self, *_args, **_kwargs) -> str:
        self.calls += 1
        self._cancel_event.set()
        return "{}"


def test_tailor_default_runner_fences_cancellation_before_material_or_terminal_write(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The production runner and default shared UOW retain the cancel fence."""

    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/canceled-tailor")
    conn.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (?, ?, 1, 1, 1, 1, 'requirement-fit-v1', 8, 'strong',
                  'high', '{}', '2026-07-31T12:00:00+00:00')
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    cancel_event = threading.Event()
    llm = _CancelingTailorLlm(cancel_event)
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "get_llm_adapter", lambda: llm)
    monkeypatch.setattr(
        tailor_module,
        "_build_analyze_use_case",
        lambda **_kwargs: _FakeAnalyzeUseCase(),
    )
    monkeypatch.setattr(tailor_module, "_build_voice_port", lambda: None)

    with pytest.raises(RuntimeError, match="tailor activity canceled before persistence"):
        tailor_module.tailor_job_by_id(
            _JOB_ID,
            tenant_id=_TENANT_A,
            snapshot=_snapshot(_TENANT_A),
            tailor_models=("codex:test-model",),
            llm_model=None,
            pdf_renderer=object(),
            workflow_id="workflow-run-canceled",
            cancel_event=cancel_event,
        )

    assert llm.calls == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM job_materials WHERE tenant_id = ? AND job_id = ?",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == 0
    state = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "running"
    assert json.loads(state["metadata_json"])["activityOwner"] == (
        "workflow-run-canceled"
    )
    terminal_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'tailor' AND event_type IN ('StageCompleted', 'StageFailed')",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    assert terminal_events == 0


def test_tailor_job_by_id_is_tenant_scoped_and_writes_canonical_state(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/a")
    _seed_job(conn, tenant_id=_TENANT_B, url="https://example.com/b")
    calls: list[tuple[str, str]] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append((str(job["tenant_id"]), str(job["url"])))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [(str(_TENANT_A), "https://example.com/a")]
    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "succeeded"
    other_tenant_state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_B), str(_JOB_ID)),
    ).fetchone()
    assert other_tenant_state["state"] == "pending"
    event = conn.execute(
        """
        SELECT tenant_id, job_id, event_type FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        ORDER BY event_id DESC LIMIT 1
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert dict(event) == {
        "tenant_id": str(_TENANT_A),
        "job_id": str(_JOB_ID),
        "event_type": "StageCompleted",
    }


def test_tailor_job_by_id_terminalizes_unhandled_item_exception(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/exception")
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("provider failed")),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        workflow_id="workflow-run-owned",
    )

    assert result["status"] == "error"
    state = conn.execute(
        "SELECT state, error_code, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "failed"
    assert state["error_code"] == "ERROR"
    event = conn.execute(
        "SELECT event_type FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'tailor' ORDER BY event_id DESC LIMIT 1",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert event["event_type"] == "StageFailed"


def test_tailor_job_by_id_blocks_stale_requirement_fit_without_consuming_retry(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/stale-fit")
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            TailoringPrerequisiteError(
                reason="requirement_fit_generation_mismatch",
                job_id=str(_JOB_ID),
                analysis_generation=2,
                report_generation=1,
            )
        ),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        workflow_id="workflow-run-stale-fit",
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "requirement_fit_generation_mismatch"
    state = conn.execute(
        "SELECT state, attempt_count, error_code, retryable, blocked_by_json, next_action "
        "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "blocked",
        0,
        "REQUIREMENT_FIT_STALE",
        1,
        '["score"]',
        "Rescore this job, then run Tailor again.",
    )
    event = conn.execute(
        "SELECT event_type, payload_json FROM job_events "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor' "
        "ORDER BY event_id DESC LIMIT 1",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert event["event_type"] == "StageBlocked"
    assert json.loads(event["payload_json"])["errorCode"] == "REQUIREMENT_FIT_STALE"


def test_tailor_job_replay_closes_running_state_from_committed_approved_resume(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/replayed-tailor")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'running'
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    approved = SimpleNamespace(is_resume_approved=True, generation=3)
    repository = SimpleNamespace(load_current_approved=lambda *_args: approved)
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "SqliteMaterialsRepository", lambda _conn: repository)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "already_done"
    assert result["materials"] is approved
    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "succeeded"


def test_retailor_job_replay_reuses_generation_committed_by_same_activity_owner(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/replayed-retailor")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'running', metadata_json = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (
            json.dumps({
                "activityOwner": "workflow-run-owned",
                "retailor": True,
                "priorApprovedGeneration": 2,
            }),
            str(_TENANT_A),
            str(_JOB_ID),
        ),
    )
    conn.commit()
    approved = SimpleNamespace(is_resume_approved=True, generation=3)
    repository = SimpleNamespace(load_current_approved=lambda *_args: approved)
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "SqliteMaterialsRepository", lambda _conn: repository)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        retailor=True,
        workflow_id="workflow-run-owned",
    )

    assert result["status"] == "already_done"
    assert result["materials"] is approved
    assert conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()["state"] == "succeeded"


def test_tailor_job_by_id_enforces_score_boundary_before_generation(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/low-fit", fit_score=6)
    calls: list[str] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    skipped = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        min_score=7,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert skipped["reason"] == "score_below_threshold"
    skipped_rows = conn.execute(
        """
        SELECT stage, state, error_code, error_message, retryable
          FROM job_stage_states
         WHERE tenant_id = ? AND job_id = ?
           AND stage IN ('tailor', 'cover', 'apply')
         ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert {row["state"] for row in skipped_rows} == {"skipped"}
    assert {row["error_code"] for row in skipped_rows} == {"MIN_SCORE"}
    assert all("6/10" in row["error_message"] for row in skipped_rows)
    assert {row["retryable"] for row in skipped_rows} == {0}

    approved = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        min_score=7,
        allow_low_fit_override=True,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert approved["status"] == "approved"
    assert calls == [str(_JOB_ID)]
    restored_rows = conn.execute(
        """
        SELECT stage, state, error_code
          FROM job_stage_states
         WHERE tenant_id = ? AND job_id = ?
           AND stage IN ('tailor', 'cover', 'apply')
         ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert {row["stage"]: row["state"] for row in restored_rows} == {
        "apply": "pending",
        "cover": "pending",
        "tailor": "succeeded",
    }
    assert {row["error_code"] for row in restored_rows} == {None}


def test_tailor_job_by_id_skips_blocked_scores_without_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(
        conn,
        tenant_id=_TENANT_A,
        url="https://example.com/blocked",
        eligibility_status="blocked",
        hard_blockers=["Sponsorship is required."],
    )

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("blocked job reached generation"),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["reason"] == "score_eligibility_blocked"
    rows = conn.execute(
        """
        SELECT stage, state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage IN ('tailor', 'cover', 'apply')
        ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert {row["stage"]: row["state"] for row in rows} == {
        "apply": "blocked",
        "cover": "blocked",
        "tailor": "blocked",
    }


def test_tailor_job_by_id_generates_for_historical_salary_only_block(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(
        conn,
        tenant_id=_TENANT_A,
        url="https://example.com/salary-advisory",
        fit_score=9,
        eligibility_status="blocked",
        hard_blockers=["Base salary is below the preferred compensation range."],
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'blocked', error_code = 'SCORE_ELIGIBILITY_BLOCKED',
            error_message = 'Score eligibility blocks tailoring: salary below range',
            retryable = 0, blocked_by_json = '["score"]'
        WHERE tenant_id = ? AND job_id = ? AND stage IN ('tailor', 'cover', 'apply')
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    calls: list[str] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [str(_JOB_ID)]


@pytest.mark.parametrize(
    ("score_state", "seed_staleness"),
    [
        ("stale", False),
        ("succeeded", True),
    ],
)
def test_tailor_job_by_id_rejects_stale_score_state_before_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    score_state: str,
    seed_staleness: bool,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/stale-score")
    tailor_module.ensure_job_stage_rows(
        conn,
        _JOB_ID,
        tenant_id=_TENANT_A,
        discovered_at="2026-07-31T12:00:00+00:00",
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (score_state, str(_TENANT_A), str(_JOB_ID)),
    )
    if seed_staleness:
        conn.execute(
            """
            INSERT INTO job_score_staleness (
                tenant_id, job_id, stale_reason,
                old_policy_version, new_policy_version, marked_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                str(_TENANT_A),
                str(_JOB_ID),
                "policy_changed",
                1,
                2,
                "2026-07-31T12:00:01+00:00",
            ),
        )
    conn.commit()
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("stale score reached generation"),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["reason"] == "not_eligible"


@pytest.mark.parametrize(
    ("active_state", "confidence", "quarantine_reason"),
    [
        ("closed", "high", None),
        ("active", "low", "contradictory_snapshot"),
    ],
)
def test_tailor_job_by_id_rejects_inactive_or_quarantined_postings(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    active_state: str,
    confidence: str,
    quarantine_reason: str | None,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/quarantined")
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, latest_confidence,
            latest_quarantine_reason, updated_at
        ) VALUES (?, ?, '{}', 1, ?, ?, ?, ?)
        """,
        (
            str(_TENANT_A),
            str(_JOB_ID),
            active_state,
            confidence,
            quarantine_reason,
            "2026-07-31T12:00:01+00:00",
        ),
    )
    conn.commit()
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail(
            "inactive or quarantined posting reached generation"
        ),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    if confidence == "low":
        assert result["reason"] == "enrichment_quarantined"
        state = conn.execute(
            "SELECT state, error_code, retryable, blocked_by_json "
            "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(_TENANT_A), str(_JOB_ID)),
        ).fetchone()
        assert state is not None
        assert dict(state) == {
            "state": "blocked",
            "error_code": "ENRICHMENT_QUARANTINED",
            "retryable": 1,
            "blocked_by_json": '["enrich"]',
        }
    else:
        assert result["reason"] == "not_eligible"


def test_tailor_job_by_id_allows_explicit_low_confidence_override_state(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/override")
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, latest_confidence,
            latest_quarantine_reason, updated_at
        ) VALUES (?, ?, '{}', 1, 'active', 'low', 'none', ?)
        """,
        (
            str(_TENANT_A),
            str(_JOB_ID),
            "2026-07-31T12:00:01+00:00",
        ),
    )
    conn.commit()
    calls: list[str] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [str(_JOB_ID)]


@pytest.mark.parametrize("retry_state", ["running", "failed"])
def test_tailor_job_by_id_allows_temporal_retry_to_reenter_generation(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    retry_state: str,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/retry")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?, attempt_count = 1
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (retry_state, str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    calls: list[str] = []
    running_attempt_counts: list[int] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        running_attempt_counts.append(
            int(
                conn.execute(
                    "SELECT attempt_count FROM job_stage_states "
                    "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
                    (str(_TENANT_A), str(_JOB_ID)),
                ).fetchone()[0]
            )
        )
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [str(_JOB_ID)]
    assert running_attempt_counts == [1]
    state = conn.execute(
        """
        SELECT state, attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == ("succeeded", 2)


def test_tailor_job_by_id_keeps_inner_retry_exhaustion_outer_retryable(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/inner-retries")

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        return {
            "url": job["url"],
            "status": "exhausted_retries",
            "attempts": 4,
            "error": "No parseable candidate",
        }

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "exhausted_retries"
    state = conn.execute(
        """
        SELECT state, attempt_count, retryable, next_action
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "failed",
        1,
        1,
        "jobctrl retry tailor https://example.com/inner-retries",
    )
    event_payload = json.loads(
        conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor' "
            "AND event_type = 'StageFailed' ORDER BY event_id DESC LIMIT 1",
            (str(_TENANT_A), str(_JOB_ID)),
        ).fetchone()[0]
    )
    assert {
        key: event_payload[key]
        for key in (
            "attempts",
            "generationAttempts",
            "generationStatus",
            "retryable",
        )
    } == {
        "attempts": 1,
        "generationAttempts": 4,
        "generationStatus": "exhausted_retries",
        "retryable": True,
    }


def test_tailor_job_by_id_marks_fifth_durable_failure_exhausted(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/outer-retries")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'failed', attempt_count = 4
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        return {
            "url": job["url"],
            "status": "failed_validation",
            "attempts": 4,
            "error": "Candidate did not pass validation",
        }

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "exhausted"
    assert result["inner_status"] == "failed_validation"
    assert result["reason"] == "durable_attempt_budget_exhausted"
    state = conn.execute(
        """
        SELECT state, attempt_count, retryable, next_action
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "exhausted",
        5,
        0,
        "jobctrl retry tailor https://example.com/outer-retries --reset-attempts",
    )


def test_tailor_job_by_id_does_not_reenter_generation_after_exhaustion(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/already-exhausted")
    conn.execute(
        "UPDATE job_stage_states SET state = 'exhausted', attempt_count = 5, retryable = 0 "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    prior_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("exhausted job re-entered generation"),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result == {
        "url": "https://example.com/already-exhausted",
        "job_id": str(_JOB_ID),
        "status": "exhausted",
        "reason": "durable_attempt_budget_exhausted",
        "error": "Tailor durable attempt budget exhausted.",
    }
    state = conn.execute(
        "SELECT state, attempt_count, retryable FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == ("exhausted", 5, 0)
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == prior_events


def test_legacy_tailor_batch_counts_all_failures_and_exhausts_durable_budget(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/legacy-batch-exhaustion"
    job_id = _JOB_ID
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=job_id, url=url)
    job = {
        "tenant_id": str(LOCAL_TENANT),
        "job_id": str(job_id),
        "url": url,
        "title": "Platform Engineer",
        "site": None,
        "discovered_at": "2026-07-31T12:00:00+00:00",
    }

    def fake_tailor(candidate: dict, *_args, **_kwargs) -> dict:
        return {
            "url": candidate["url"],
            "title": candidate["title"],
            "site": candidate.get("site"),
            "status": "exhausted_retries",
            "attempts": 4,
            "error": "No parseable candidate",
        }

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "get_jobs_by_stage", lambda **_kwargs: [job])
    monkeypatch.setattr(
        tailor_module.db_module,
        "effective_tailoring_min_score",
        lambda score: score,
    )
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    first = tailor_module.run_tailoring(
        snapshot=SimpleNamespace(),
        tenant_id=LOCAL_TENANT,
        llm_model=None,
    )
    assert first["failed"] == 1
    assert first["errors"] == 0
    assert first["exhausted"] == 0
    assert tuple(
        conn.execute(
            "SELECT state, attempt_count, retryable FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
    ) == ("failed", 1, 1)

    conn.execute(
        "UPDATE job_stage_states SET state = 'failed', attempt_count = 4, retryable = 1 "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()
    fifth = tailor_module.run_tailoring(
        snapshot=SimpleNamespace(),
        tenant_id=LOCAL_TENANT,
        llm_model=None,
    )
    assert fifth["failed"] == 1
    assert fifth["errors"] == 0
    assert fifth["exhausted"] == 1
    assert tuple(
        conn.execute(
            "SELECT state, attempt_count, retryable FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
    ) == ("exhausted", 5, 0)


def test_legacy_tailor_batch_blocks_stale_fit_without_consuming_retry(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/legacy-batch-stale-fit"
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=_JOB_ID, url=url)
    job = {
        "tenant_id": str(LOCAL_TENANT),
        "job_id": str(_JOB_ID),
        "url": url,
        "title": "Platform Engineer",
        "site": None,
        "discovered_at": "2026-07-31T12:00:00+00:00",
    }

    def stale_fit(*_args, **_kwargs) -> dict:
        raise TailoringPrerequisiteError(
            reason="requirement_fit_generation_mismatch",
            job_id=str(_JOB_ID),
            analysis_generation=2,
            report_generation=1,
        )

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "get_jobs_by_stage", lambda **_kwargs: [job])
    monkeypatch.setattr(
        tailor_module.db_module,
        "effective_tailoring_min_score",
        lambda score: score,
    )
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", stale_fit)

    result = tailor_module.run_tailoring(
        snapshot=SimpleNamespace(),
        tenant_id=LOCAL_TENANT,
        llm_model=None,
    )

    assert result["blocked"] == 1
    assert result["failed"] == 0
    assert result["errors"] == 0
    assert result["exhausted"] == 0
    state = conn.execute(
        "SELECT state, attempt_count, error_code, retryable, blocked_by_json "
        "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "blocked",
        0,
        "REQUIREMENT_FIT_STALE",
        1,
        '["score"]',
    )
    event = conn.execute(
        "SELECT event_type FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'tailor' ORDER BY event_id DESC LIMIT 1",
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert event["event_type"] == "StageBlocked"


def test_tailor_job_by_id_rejects_deleted_and_url_shaped_targets_before_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/deleted")
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at)
        VALUES (?, ?, ?, ?, NULL)
        """,
        (str(_TENANT_A), str(_JOB_ID), "2026-07-31T12:00:01+00:00", "test"),
    )
    conn.commit()
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("rejected job reached generation"),
    )

    deleted = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert deleted == {
        "job_id": str(_JOB_ID),
        "status": "skipped",
        "reason": "not_found",
    }
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    monkeypatch.setattr(
        tailor_module,
        "get_connection",
        lambda: pytest.fail("URL-shaped JobId must fail before opening storage"),
    )
    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        tailor_module.tailor_job_by_id(
            JobId("https://example.com/legacy"),
            tenant_id=_TENANT_A,
        )


def test_tailor_job_activity_wires_canonical_job_id_to_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_tailor_job_by_id(job_id: JobId, **kwargs: object) -> dict[str, object]:
        captured["job_id"] = job_id
        captured.update(kwargs)
        return {"status": "approved"}

    monkeypatch.setattr(tailor_module, "tailor_job_by_id", fake_tailor_job_by_id)
    payload = TailorJobActivityInput(
        tenant_id=str(_TENANT_A),
        job_id=_JOB_ID,
        min_score=8,
        retailor=True,
    )

    assert activities_module._tailor_one_job(payload) == {"status": "approved"}
    assert captured["job_id"] == _JOB_ID
    assert captured["tenant_id"] == _TENANT_A
    assert captured["min_score"] == 8
    assert captured["retailor"] is True


def test_tailor_one_job_passes_canonical_id_to_materials_use_case() -> None:
    captured: dict[str, object] = {}

    class FakeUseCase:
        def execute(self, **kwargs: object) -> SimpleNamespace:
            captured.update(kwargs)
            return SimpleNamespace(
                text_path="/tmp/tailored.txt",
                pdf_path="/tmp/tailored.pdf",
                status="approved",
                attempts=1,
                materials=SimpleNamespace(generation=1),
                error=None,
            )

    result = tailor_module._tailor_one_job(
        {
            "job_id": str(_JOB_ID),
            "url": "https://example.com/materials",
            "title": "Platform Engineer",
        },
        "",
        SimpleNamespace(),
        "normal",
        use_case=FakeUseCase(),
    )

    assert result["status"] == "approved"
    assert captured["job_id"] == _JOB_ID
