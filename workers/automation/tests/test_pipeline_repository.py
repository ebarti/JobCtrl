"""Tests for SqlitePipelineStateRepository — round-trip, optimistic locking, list_by_stage."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.domain.pipeline.aggregate import JobPipelineState, OptimisticLockError
from jobhunter.domain.pipeline_types import (
    Failed,
    Running,
    Stage,
    Succeeded,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.pipeline.sqlite_repository import SqlitePipelineStateRepository
from jobhunter.state import ensure_job_stage_rows


def _insert_job(conn, url: str = "https://example.com/job") -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO jobs (url, title, site, strategy, discovered_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (url, "Platform Engineer", "ExampleCo", "test", "2026-04-29T10:00:00+00:00"),
    )
    conn.commit()


@pytest.fixture()
def db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn)
    ensure_job_stage_rows(conn, "https://example.com/job", discovered_at="2026-04-29T10:00:00+00:00")
    conn.commit()
    yield conn
    close_connection(db_path)


def test_load_returns_none_for_unknown_job(db):
    repo = SqlitePipelineStateRepository(db)
    result = repo.load(LOCAL_TENANT, "https://nonexistent.example.com/job")
    assert result is None


def test_roundtrip_save_and_load(db):
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    assert agg.version == 0  # initial

    # Mutate one stage
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)
    assert agg.version == 1

    # Re-load and verify
    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    assert reloaded.version == 1
    enrich = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich, Running)
    assert enrich.attempt_count == 1
    assert enrich.started_at == "2026-05-01T00:00:00Z"


def test_roundtrip_succeeded_state(db):
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None

    agg.set_stage_state(
        Stage.Score,
        Succeeded(attempt_count=1, finished_at="2026-05-01T00:05:00Z", duration_ms=5000),
    )
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    score = reloaded.get_stage_state(Stage.Score)
    assert isinstance(score, Succeeded)
    assert score.finished_at == "2026-05-01T00:05:00Z"
    assert score.duration_ms == 5000


def test_roundtrip_failed_state(db):
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None

    agg.set_stage_state(
        Stage.Enrich,
        Failed(
            attempt_count=2,
            max_attempts=5,
            error_code="TIMEOUT",
            error_message="timed out",
            retryable=True,
            next_action="jobhunter retry enrich",
        ),
    )
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    enrich = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich, Failed)
    assert enrich.error_code == "TIMEOUT"
    assert enrich.retryable is True
    assert enrich.next_action == "jobhunter retry enrich"


def test_optimistic_lock_conflict(db):
    repo = SqlitePipelineStateRepository(db)

    # Load two copies of the same aggregate
    agg1 = repo.load(LOCAL_TENANT, "https://example.com/job")
    agg2 = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg1 is not None and agg2 is not None

    # Save the first
    agg1.set_stage_state(Stage.Enrich, Running(attempt_count=1))
    repo.save(agg1)
    assert agg1.version == 1

    # Second save with stale version should fail
    agg2.set_stage_state(Stage.Enrich, Running(attempt_count=2))
    with pytest.raises(OptimisticLockError) as exc_info:
        repo.save(agg2)
    assert exc_info.value.expected_version == 0
    assert exc_info.value.actual_version == 1


def test_list_by_stage(db):
    repo = SqlitePipelineStateRepository(db)
    results = repo.list_by_stage(LOCAL_TENANT, "discover")
    assert len(results) == 1
    assert results[0].job_url == "https://example.com/job"


def test_list_by_stage_with_state_filter(db):
    repo = SqlitePipelineStateRepository(db)

    # discover is succeeded, enrich is pending
    results_succeeded = repo.list_by_stage(LOCAL_TENANT, "discover", state_filter="succeeded")
    assert len(results_succeeded) == 1

    results_failed = repo.list_by_stage(LOCAL_TENANT, "discover", state_filter="failed")
    assert len(results_failed) == 0


def test_save_creates_new_rows_for_new_job(db):
    """Save an aggregate for a job that has no existing rows in job_stage_states."""
    _insert_job(db, url="https://example.com/new-job")

    repo = SqlitePipelineStateRepository(db)
    agg = JobPipelineState.new_for_job(LOCAL_TENANT, "https://example.com/new-job")
    agg.set_stage_state(Stage.Discover, Succeeded(attempt_count=1, finished_at="2026-05-01T00:00:00Z"))
    repo.save(agg)
    assert agg.version == 1

    reloaded = repo.load(LOCAL_TENANT, "https://example.com/new-job")
    assert reloaded is not None
    assert reloaded.version == 1
    assert isinstance(reloaded.get_stage_state(Stage.Discover), Succeeded)
