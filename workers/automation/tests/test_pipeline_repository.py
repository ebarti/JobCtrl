"""Tests for SqlitePipelineStateRepository — round-trip, optimistic locking, list_by_stage."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.pipeline.aggregate import JobPipelineState, OptimisticLockError
from jobctrl.domain.pipeline_types import (
    Blocked,
    Canceled,
    Failed,
    Running,
    Skipped,
    Stage,
    Succeeded,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.pipeline.sqlite_repository import SqlitePipelineStateRepository
from jobctrl.state import ensure_job_stage_rows, get_stage_state_row, set_stage_state


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
            next_action="jobctrl retry enrich",
        ),
    )
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    enrich = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich, Failed)
    assert enrich.error_code == "TIMEOUT"
    assert enrich.retryable is True
    assert enrich.next_action == "jobctrl retry enrich"


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


# ---------------------------------------------------------------------------
# PR 6: shared write path through state.set_stage_state
# ---------------------------------------------------------------------------


def _job_events(conn, job_url: str) -> list[tuple[str, str | None, str | None]]:
    """Return (event_type, stage, level) rows for one job ordered by id."""
    rows = conn.execute(
        "SELECT event_type, stage, level FROM job_events "
        "WHERE job_url = ? ORDER BY event_id",
        (job_url,),
    ).fetchall()
    return [(r["event_type"], r["stage"], r["level"]) for r in rows]


def test_save_emits_event_per_changed_stage(db):
    """save() emits exactly one event per stage whose state changed."""
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None

    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    agg.set_stage_state(Stage.Score, Running(attempt_count=1, started_at="2026-05-01T00:01:00Z"))
    repo.save(agg)

    events = _job_events(db, "https://example.com/job")
    stages_with_events = sorted({stage for _, stage, _ in events if stage is not None})
    assert stages_with_events == ["enrich", "score"], events
    types_by_stage = {stage: event_type for event_type, stage, _ in events}
    assert types_by_stage["enrich"] == "StageStarted"
    assert types_by_stage["score"] == "StageStarted"


def test_save_does_not_emit_for_idempotent_writes(db):
    """save() must not emit an event when the persisted state is unchanged."""
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None

    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)

    db.execute("DELETE FROM job_events")
    db.commit()

    # Re-load + save without changing anything.
    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    repo.save(reloaded)

    events = _job_events(db, "https://example.com/job")
    assert events == [], events


def test_save_emits_state_specific_event_types(db):
    """Each terminal state has a dedicated event type."""
    repo = SqlitePipelineStateRepository(db)

    # Set up: drive enrich Pending -> Running -> Failed in two saves.
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)

    db.execute("DELETE FROM job_events")
    db.commit()

    agg.set_stage_state(
        Stage.Enrich,
        Failed(
            attempt_count=1,
            max_attempts=5,
            error_code="TIMEOUT",
            error_message="timed out",
            retryable=True,
        ),
    )
    repo.save(agg)

    events = _job_events(db, "https://example.com/job")
    assert events == [("StageFailed", "enrich", "error")], events


def test_save_event_emission_matches_canonical_helper(db):
    """A repo.save() flow produces the same row state as a sequence of canonical
    set_stage_state() calls would (regression: dual write path is gone).
    """
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    # Path A: write Enrich Running -> Succeeded via the repository.
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)
    agg.set_stage_state(
        Stage.Enrich,
        Succeeded(attempt_count=1, finished_at="2026-05-01T00:01:00Z", duration_ms=60000),
    )
    repo.save(agg)
    repo_row = get_stage_state_row(db, "https://example.com/job", "enrich")

    # Path B: identical writes via canonical set_stage_state on a sibling job.
    _insert_job(db, url="https://example.com/twin")
    ensure_job_stage_rows(db, "https://example.com/twin", discovered_at="2026-04-29T10:00:00+00:00")
    db.commit()
    set_stage_state(
        db,
        "https://example.com/twin",
        "enrich",
        "running",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
    )
    set_stage_state(
        db,
        "https://example.com/twin",
        "enrich",
        "succeeded",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
        finished_at="2026-05-01T00:01:00Z",
        duration_ms=60000,
    )
    db.commit()
    twin_row = get_stage_state_row(db, "https://example.com/twin", "enrich")

    lifecycle_columns = (
        "state",
        "attempt_count",
        "max_attempts",
        "started_at",
        "finished_at",
        "duration_ms",
        "error_code",
        "error_message",
        "retryable",
        "blocked_by_json",
        "next_action",
        "metadata_json",
    )
    assert {
        column: repo_row[column] for column in lifecycle_columns
    } == {
        column: twin_row[column] for column in lifecycle_columns
    }


def test_save_attempts_counter_progresses_across_calls(db):
    """The attempt_count is preserved across successive save() calls."""
    repo = SqlitePipelineStateRepository(db)

    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    enrich_state = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich_state, Running)
    assert enrich_state.attempt_count == 1

    reloaded.set_stage_state(Stage.Enrich, Running(attempt_count=2, started_at="2026-05-01T00:02:00Z"))
    repo.save(reloaded)

    final = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert final is not None
    final_state = final.get_stage_state(Stage.Enrich)
    assert isinstance(final_state, Running)
    assert final_state.attempt_count == 2


def test_save_blocked_state_round_trip(db):
    """Blocked persists blocked_by + emits StageBlocked."""
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    agg.set_stage_state(
        Stage.Enrich,
        Blocked(
            blocked_by=(Stage.Discover,),
            error_code="BLOCKED",
            error_message="upstream not done",
        ),
    )
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert reloaded is not None
    state = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(state, Blocked)
    assert state.blocked_by == (Stage.Discover,)

    events = _job_events(db, "https://example.com/job")
    assert ("StageBlocked", "enrich", "warn") in events


def test_save_skipped_state_emits_stage_skipped(db):
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Skipped(reason="below threshold"))
    repo.save(agg)

    events = _job_events(db, "https://example.com/job")
    assert ("StageSkipped", "enrich", "info") in events


def test_save_canceled_state_emits_stage_canceled(db):
    repo = SqlitePipelineStateRepository(db)
    # Cancel is a valid transition only from Queued/Running, so seed Running.
    agg = repo.load(LOCAL_TENANT, "https://example.com/job")
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)

    db.execute("DELETE FROM job_events")
    db.commit()

    agg.set_stage_state(
        Stage.Enrich,
        Canceled(canceled_at="2026-05-01T00:01:00Z", reason="user canceled"),
    )
    repo.save(agg)

    events = _job_events(db, "https://example.com/job")
    assert ("StageCanceled", "enrich", "info") in events


def test_save_does_not_use_legacy_dual_write_path(db):
    """Regression: the bespoke UPDATE/INSERT INTO job_stage_states blocks are gone.

    Asserts the repository module no longer contains literal 'INSERT INTO
    job_stage_states' or 'UPDATE job_stage_states' SQL — it must call into
    the canonical helper instead.
    """
    import inspect

    from jobctrl.infrastructure.pipeline import sqlite_repository

    source = inspect.getsource(sqlite_repository)
    assert "INSERT INTO job_stage_states" not in source, source
    assert "UPDATE job_stage_states" not in source, source


def test_set_stage_state_with_expected_version_round_trip(db):
    """state.set_stage_state honours expected_version when supplied."""
    set_stage_state(
        db,
        "https://example.com/job",
        "enrich",
        "running",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
        expected_version=0,
        validate_transition=False,
    )
    db.commit()

    row = get_stage_state_row(db, "https://example.com/job", "enrich")
    assert row["state"] == "running"
    assert row["version"] == 1


def test_set_stage_state_expected_version_mismatch_raises(db):
    """state.set_stage_state raises OptimisticLockError on stale expected_version."""
    # Bump version to 1.
    set_stage_state(
        db,
        "https://example.com/job",
        "enrich",
        "running",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
        expected_version=0,
        validate_transition=False,
    )
    db.commit()

    with pytest.raises(OptimisticLockError) as exc:
        set_stage_state(
            db,
            "https://example.com/job",
            "enrich",
            "succeeded",
            attempt_count=1,
            started_at="2026-05-01T00:00:00Z",
            finished_at="2026-05-01T00:01:00Z",
            duration_ms=60000,
            expected_version=0,  # stale
            validate_transition=False,
        )
    assert exc.value.expected_version == 0
    assert exc.value.actual_version == 1


def test_set_stage_state_expected_version_inserts_when_missing(db):
    """When the row does not exist, expected_version=0 inserts at version 1."""
    _insert_job(db, url="https://example.com/fresh")
    db.commit()

    set_stage_state(
        db,
        "https://example.com/fresh",
        "enrich",
        "pending",
        expected_version=0,
        validate_transition=False,
    )
    db.commit()

    row = get_stage_state_row(db, "https://example.com/fresh", "enrich")
    assert row["state"] == "pending"
    assert row["version"] == 1
