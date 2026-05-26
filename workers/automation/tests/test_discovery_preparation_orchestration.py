"""Discovery preparation work-item orchestration tests."""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobhunter.database import init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.preparation import PreparationWorkItemKind
from jobhunter.domain.scoring import FitScore, JobScore, MatchedKeywords, ScoreBreakdown
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import SqliteMaterialsRepository
from jobhunter.infrastructure.preparation import SqlitePreparationWorkItemRepository
from jobhunter.infrastructure.scoring import SqliteScoreRepository
from jobhunter.pipeline import preparation, runner


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_enriched_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Platform Engineer", "Acme", "Build Python platforms.", "2026-05-26T00:00:00+00:00"),
    )
    conn.commit()


def _save_score(conn: sqlite3.Connection, url: str, fit: int) -> None:
    SqliteScoreRepository(conn).save(
        JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            fit_score=FitScore.create(fit),
            breakdown=ScoreBreakdown(reasoning="eligible"),
            matched_keywords=MatchedKeywords.from_iterable(["python"]),
            scored_at=datetime.now(timezone.utc).isoformat(),
        )
    )


def _approved_materials(url: str) -> MaterialsSet:
    artifact = Artifact.create(
        type=ArtifactType.TAILORED_RESUME,
        path=f"/tmp/{url.rsplit('/', 1)[-1]}.txt",
        created_at="2026-05-26T00:01:00+00:00",
        render_format=RenderFormat.TEXT,
        size_bytes=128,
    )
    return MaterialsSet.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        created_at="2026-05-26T00:01:00+00:00",
    ).with_resume_attempt(
        artifact,
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2026-05-26T00:02:00+00:00",
    )


def test_discovery_preparation_drains_score_then_tailor_work_items(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/prep-ready"
    _seed_enriched_job(conn, url)
    calls: list[tuple[str, str]] = []

    def fake_score(item, **_kwargs):
        calls.append((item.kind.value, str(item.job_id)))
        _save_score(conn, str(item.job_id), 8)
        return {"scoreVersion": 1}

    def fake_tailor(item, **_kwargs):
        calls.append((item.kind.value, str(item.job_id)))
        return {"status": "approved", "materialsGeneration": 1}

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_score_item", fake_score)
    monkeypatch.setattr(preparation, "_tailor_item", fake_tailor)

    stats = preparation.drain_discovery_preparation(min_score=7)

    assert stats["status"] == "ok"
    assert calls == [
        (PreparationWorkItemKind.SCORE_JOB.value, url),
        (PreparationWorkItemKind.TAILOR_RESUME.value, url),
    ]
    rows = conn.execute(
        "SELECT kind, state FROM preparation_work_items ORDER BY created_at, kind"
    ).fetchall()
    assert {(row["kind"], row["state"]) for row in rows} == {
        ("score_job", "completed"),
        ("tailor_resume", "completed"),
    }


def test_threshold_recompute_suppresses_now_ineligible_artifacts(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/too-low"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, 6)
    materials_repo = SqliteMaterialsRepository(conn)
    materials_repo.save(_approved_materials(url))

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    stats = preparation.drain_discovery_preparation(min_score=7)

    assert stats["queued"]["suppress_tailored_artifacts"] == 1
    assert stats["completed"]["suppress_tailored_artifacts"] == 1
    suppressed = materials_repo.load(LOCAL_TENANT, JobId(url))
    assert suppressed is not None
    assert suppressed.tailored_resume is not None
    assert suppressed.tailored_resume.status.value == "suppressed"


def test_preparation_work_item_key_includes_source_event_id(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/source-event-key"
    _seed_enriched_job(conn, url)
    repo = SqlitePreparationWorkItemRepository(conn)
    repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=1,
        source_event_id="old-source",
    )
    stats = preparation._new_stats()

    monkeypatch.setattr(preparation, "_latest_source_event_id", lambda *_args: "new-source")

    preparation._enqueue_pending_scores(
        conn=conn,
        repo=repo,
        stats=stats,
        tenant_id=LOCAL_TENANT,
        target_version=1,
    )

    rows = conn.execute(
        "SELECT source_event_id FROM preparation_work_items ORDER BY source_event_id"
    ).fetchall()
    assert [row["source_event_id"] for row in rows] == ["new-source", "old-source"]
    assert stats["queued"]["score_job"] == 1


def test_discover_stage_kwargs_include_preparation_controls() -> None:
    kwargs = runner._build_stage_kwargs(
        "discover",
        min_score=8,
        workers=3,
        validation_mode="strict",
        limit=5,
        llm_model="local:score",
        tailor_models=("local:draft",),
        tailor_judge_model="local:judge",
        tailor_judge_min_score=0.9,
    )

    assert kwargs == {
        "workers": 3,
        "limit": 5,
        "min_score": 8,
        "validation_mode": "strict",
        "llm_model": "local:score",
        "tailor_models": ("local:draft",),
        "tailor_judge_model": "local:judge",
        "tailor_judge_min_score": 0.9,
    }


def test_discover_runs_internal_preparation_after_enrichment(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(runner, "init_db", lambda: conn)
    monkeypatch.setattr(runner, "get_connection", lambda: conn)
    monkeypatch.setattr(runner.config, "load_search_config", lambda: {"disable_jobspy": True})
    monkeypatch.setattr(
        runner,
        "_start_discovery_enrichment_worker",
        lambda *, workers, limit: (
            SimpleNamespace(set=lambda: None),
            {"status": "ok", "passes": 0, "pending": 0},
            SimpleNamespace(join=lambda: None),
        ),
    )
    monkeypatch.setattr(runner, "_record_pipeline_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **_kwargs: None)
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.workday",
        SimpleNamespace(run_workday_discovery=lambda employers=None, workers=1, limit=0, run_id=None: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "jobhunter.discovery.smartextract",
        SimpleNamespace(run_smart_extract=lambda sites=None, workers=1, limit=0: None),
    )

    def fake_drain(**kwargs):
        captured.update(kwargs)
        return {"status": "ok", "has_work": True, "queued": {}, "completed": {}, "failed": {}}

    monkeypatch.setattr(preparation, "drain_discovery_preparation", fake_drain)

    result = runner._run_discover(
        workers=3,
        limit=5,
        min_score=8,
        validation_mode="strict",
        llm_model="local:score",
        tailor_models=("local:draft",),
        tailor_judge_model="local:judge",
        tailor_judge_min_score=0.9,
    )

    assert result["preparation"] == "ok"
    assert captured == {
        "min_score": 8,
        "limit": 5,
        "workers": 3,
        "validation_mode": "strict",
        "llm_model": "local:score",
        "tailor_models": ("local:draft",),
        "tailor_judge_model": "local:judge",
        "tailor_judge_min_score": 0.9,
    }
