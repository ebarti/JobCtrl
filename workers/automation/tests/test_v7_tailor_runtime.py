"""Exact-v7 proof for the canonical per-job tailoring execution path."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId
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
    assert conn.execute(
        """
        SELECT 1 FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_B), str(_JOB_ID)),
    ).fetchone() is None
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
    approved = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        min_score=7,
        allow_low_fit_override=True,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert skipped["reason"] == "not_eligible"
    assert approved["status"] == "approved"
    assert calls == [str(_JOB_ID)]


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
