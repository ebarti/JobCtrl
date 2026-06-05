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
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.preparation import PreparationWorkItem, PreparationWorkItemKind
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


def test_all_stage_expands_to_primary_discover_only_and_keeps_maintenance_explicit() -> None:
    assert runner.PRIMARY_STAGE_ORDER == ("discover",)
    assert runner.MAINTENANCE_STAGE_ORDER == ("score", "tailor", "cover")
    assert runner.SUPPORTED_STAGE_ORDER == ("discover", "score", "tailor", "cover")
    assert runner._resolve_stages(["all"]) == ["discover"]
    assert runner._resolve_stages(["score", "tailor", "cover"]) == ["score", "tailor", "cover"]


def test_run_pipeline_default_uses_primary_stage_order(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(runner, "load_env", lambda: None)
    monkeypatch.setattr(runner, "ensure_dirs", lambda: None)
    monkeypatch.setattr(runner, "init_db", lambda: None)
    empty_stats = {
        "total": 0,
        "pending_detail": 0,
        "with_description": 0,
        "scored": 0,
        "tailored": 0,
        "with_cover_letter": 0,
        "ready_to_apply": 0,
        "applied": 0,
    }
    monkeypatch.setattr(runner, "get_stats", lambda: empty_stats)

    def fake_run_sequential(ordered, min_score, **_kwargs):
        captured["ordered"] = ordered
        captured["min_score"] = min_score
        return {
            "stages": [{"stage": stage, "status": "ok", "elapsed": 0.0} for stage in ordered],
            "errors": {},
            "elapsed": 0.0,
        }

    monkeypatch.setattr(runner, "_run_sequential", fake_run_sequential)

    result = runner.run_pipeline(stages=None, min_score=8)

    assert captured == {"ordered": ["discover"], "min_score": 8}
    assert [stage["stage"] for stage in result["stages"]] == ["discover"]


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


def test_discovery_preparation_auto_retries_failed_work_item_in_same_drain(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/transient-score-failure"
    _seed_enriched_job(conn, url)
    score_calls = 0
    tailor_calls = 0

    def fail_once_score(item, **_kwargs):
        nonlocal score_calls
        score_calls += 1
        if score_calls == 1:
            raise RuntimeError("temporary scoring outage")
        _save_score(conn, str(item.job_id), 8)
        return {"scoreVersion": 1}

    def fake_tailor(item, **_kwargs):
        nonlocal tailor_calls
        tailor_calls += 1
        return {"status": "approved", "materialsGeneration": 1}

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_score_item", fail_once_score)
    monkeypatch.setattr(preparation, "_tailor_item", fake_tailor)

    first_stats = preparation.drain_discovery_preparation(min_score=7)

    assert first_stats["status"] == "ok"
    assert first_stats["retried"]["score_job"] == 1
    assert first_stats["completed"]["score_job"] == 1
    assert first_stats["completed"]["tailor_resume"] == 1
    assert score_calls == 2
    assert tailor_calls == 1
    rows = conn.execute(
        "SELECT kind, state, attempts, last_error FROM preparation_work_items ORDER BY kind"
    ).fetchall()
    assert [(row["kind"], row["state"], row["attempts"], row["last_error"]) for row in rows] == [
        ("score_job", "completed", 2, ""),
        ("tailor_resume", "completed", 1, ""),
    ]


def test_tailor_work_item_runs_cover_for_approved_job(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "https://example.com/job/tailored-for-cover"
    item = PreparationWorkItem.queued(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=1,
        source_event_id="source-1",
        created_at="2026-06-05T00:00:00+00:00",
    )
    tailor_calls: list[tuple[str, dict[str, object]]] = []
    cover_calls: list[dict[str, object]] = []

    def fake_tailor_job_by_url(job_url: str, **kwargs: object) -> dict[str, object]:
        tailor_calls.append((job_url, kwargs))
        return {"status": "approved", "materials": SimpleNamespace(generation=3)}

    def fake_run_cover_letters(**kwargs: object) -> dict[str, object]:
        cover_calls.append(kwargs)
        return {"generated": 1, "errors": 0, "elapsed": 0.1}

    monkeypatch.setattr("jobhunter.scoring.tailor.tailor_job_by_url", fake_tailor_job_by_url)
    monkeypatch.setattr("jobhunter.scoring.cover_letter.run_cover_letters", fake_run_cover_letters)

    result = preparation._tailor_item(
        item,
        min_score=7,
        validation_mode="normal",
        workers=2,
        llm_model="local:model",
        tailor_models=("local:tailor",),
        tailor_judge_model="local:judge",
        tailor_judge_min_score=0.9,
        tenant_id=LOCAL_TENANT,
    )

    assert result == {
        "cover": {"generated": 1, "errors": 0, "elapsed": 0.1},
        "materialsGeneration": 3,
        "status": "approved",
    }
    assert tailor_calls == [
        (
            url,
            {
                "min_score": 7,
                "validation_mode": "normal",
                "workers": 2,
                "llm_model": "local:model",
                "tailor_models": ("local:tailor",),
                "tailor_judge_model": "local:judge",
                "tailor_judge_min_score": 0.9,
                "tenant_id": LOCAL_TENANT,
            },
        )
    ]
    assert cover_calls == [
        {
            "min_score": 7,
            "limit": 1,
            "validation_mode": "normal",
            "llm_model": "local:model",
            "job_urls": (url,),
            "tenant_id": LOCAL_TENANT,
        }
    ]


def test_discovery_preparation_retries_limited_failed_work_item_on_later_drain(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/limited-score-failure"
    _seed_enriched_job(conn, url)
    score_calls = 0
    tailor_calls = 0

    def fail_once_score(item, **_kwargs):
        nonlocal score_calls
        score_calls += 1
        if score_calls == 1:
            raise RuntimeError("temporary scoring outage")
        _save_score(conn, str(item.job_id), 8)
        return {"scoreVersion": 1}

    def fake_tailor(item, **_kwargs):
        nonlocal tailor_calls
        tailor_calls += 1
        return {"status": "approved", "materialsGeneration": 1}

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_score_item", fail_once_score)
    monkeypatch.setattr(preparation, "_tailor_item", fake_tailor)

    first_stats = preparation.drain_discovery_preparation(min_score=7, limit=1)

    assert first_stats["status"] == "ok"
    assert first_stats["retried"]["score_job"] == 1
    assert score_calls == 1
    assert tailor_calls == 0

    second_stats = preparation.drain_discovery_preparation(min_score=7)

    assert second_stats["status"] == "ok"
    assert second_stats["completed"]["score_job"] == 1
    assert second_stats["completed"]["tailor_resume"] == 1
    assert score_calls == 2
    assert tailor_calls == 1
    rows = conn.execute(
        "SELECT kind, state, attempts, last_error FROM preparation_work_items ORDER BY kind"
    ).fetchall()
    assert [(row["kind"], row["state"], row["attempts"], row["last_error"]) for row in rows] == [
        ("score_job", "completed", 2, ""),
        ("tailor_resume", "completed", 1, ""),
    ]


def test_discovery_preparation_recovers_stale_running_work_item(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/stale-running-tailor"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, 8)
    repo = SqlitePreparationWorkItemRepository(conn)
    queued = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=1,
        source_event_id="",
        now="2026-05-26T00:00:00+00:00",
    )
    claimed = repo.claim_next(
        tenant_id=LOCAL_TENANT,
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        now="2026-05-26T00:01:00+00:00",
    )
    assert claimed is not None
    conn.execute(
        "UPDATE preparation_work_items SET updated_at = ? WHERE item_id = ?",
        ("2026-05-26T00:01:00+00:00", queued.item_id),
    )
    conn.commit()

    def fake_tailor(item, **_kwargs):
        return {"status": "approved", "materialsGeneration": 1}

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_tailor_item", fake_tailor)

    stats = preparation.drain_discovery_preparation(min_score=7)

    assert stats["status"] == "ok"
    assert stats["recovered"]["tailor_resume"] == 1
    assert stats["completed"]["tailor_resume"] == 1
    row = conn.execute(
        "SELECT state, attempts, last_error FROM preparation_work_items WHERE item_id = ?",
        (queued.item_id,),
    ).fetchone()
    assert row["state"] == "completed"
    assert row["attempts"] == 2
    assert row["last_error"] == ""


def test_discovery_preparation_exhausts_retry_budget(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/permanent-score-failure"
    _seed_enriched_job(conn, url)
    score_calls = 0

    def fail_score(item, **_kwargs):
        nonlocal score_calls
        score_calls += 1
        raise RuntimeError("permanent scoring outage")

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    monkeypatch.setattr(preparation, "_score_item", fail_score)

    stats = preparation.drain_discovery_preparation(min_score=7)

    assert stats["status"] == "partial"
    assert stats["retried"]["score_job"] == 2
    assert stats["failed"]["score_job"] == 1
    assert score_calls == 3
    row = conn.execute(
        "SELECT state, attempts, last_error FROM preparation_work_items WHERE kind = 'score_job'"
    ).fetchone()
    assert row["state"] == "failed"
    assert row["attempts"] == 3
    assert row["last_error"] == "permanent scoring outage"


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


def test_threshold_recompute_requeues_same_threshold_after_new_active_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/job/repeated-threshold"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, 6)
    materials_repo = SqliteMaterialsRepository(conn)
    materials_repo.save(_approved_materials(url))

    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    first_stats = preparation.drain_discovery_preparation(min_score=7)

    assert first_stats["completed"]["suppress_tailored_artifacts"] == 1
    first_suppressed = materials_repo.load(LOCAL_TENANT, JobId(url))
    assert first_suppressed is not None
    assert first_suppressed.tailored_resume is not None
    assert first_suppressed.tailored_resume.status.value == "suppressed"

    superseded, fresh = MaterialsSetFactory.next_generation(
        first_suppressed,
        created_at="2026-05-26T00:03:00+00:00",
    )
    second_artifact = Artifact.create(
        type=ArtifactType.TAILORED_RESUME,
        path="/tmp/repeated-threshold-g2.txt",
        created_at="2026-05-26T00:04:00+00:00",
        render_format=RenderFormat.TEXT,
        size_bytes=256,
    )
    materials_repo.save(superseded)
    materials_repo.save(
        fresh.with_resume_attempt(
            second_artifact,
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2026-05-26T00:05:00+00:00",
        )
    )

    second_stats = preparation.drain_discovery_preparation(min_score=7)

    assert second_stats["queued"]["suppress_tailored_artifacts"] == 1
    assert second_stats["completed"]["suppress_tailored_artifacts"] == 1
    second_suppressed = materials_repo.load(LOCAL_TENANT, JobId(url))
    assert second_suppressed is not None
    assert second_suppressed.generation == 2
    assert second_suppressed.tailored_resume is not None
    assert second_suppressed.tailored_resume.status.value == "suppressed"
    rows = conn.execute(
        "SELECT source_event_id, state FROM preparation_work_items "
        "WHERE kind = 'suppress_tailored_artifacts' ORDER BY created_at, source_event_id"
    ).fetchall()
    assert [row["state"] for row in rows] == ["completed", "completed"]
    assert len({row["source_event_id"] for row in rows}) == 2


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


def test_discovery_source_failure_records_failed_progress(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, str, str, dict]] = []
    scheduled = runner.ScheduledSource(
        source_id="jobspy:linkedin",
        display_name="LinkedIn",
        source_kind=runner.SourceKind.BROAD_BOARD,
        priority=runner.SourcePriority.STANDARD,
        configured_state=runner.SourceState.ACTIVE,
        crawl_budget=1,
        decision="run",
        reason="scheduled",
        recommended_state="normal",
    )

    monkeypatch.setattr(runner, "get_connection", lambda: conn)
    monkeypatch.setattr(runner, "_record_source_state_changes", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_record_discovery_run_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **_kwargs: None)
    monkeypatch.setattr(
        runner,
        "_record_pipeline_event",
        lambda stage, event_type, _level, message, payload=None: events.append(
            (stage, event_type, message, payload or {})
        ),
    )

    def fail_source() -> None:
        raise RuntimeError("source outage")

    result = runner._run_discovery_source(
        "jobspy",
        "JobSpy",
        (scheduled,),
        fail_source,
        progress_completed=1,
        progress_total=5,
    )

    assert result == "error: source outage"
    failed_event = [event for event in events if event[1] == "StageFailed"][0]
    assert failed_event[0] == "discover"
    assert failed_event[2] == "Discovery source jobspy failed: source outage"
    assert failed_event[3]["progress"] == {
        "completed": 2,
        "total": 5,
        "percent": 40,
        "currentStep": "JobSpy",
        "status": "failed",
        "message": "JobSpy failed",
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
