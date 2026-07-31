"""Tests for SqlitePipelineStateRepository — round-trip, optimistic locking, list_by_stage."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
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
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

JOB_URL = "https://example.com/job"
JOB_ID = JobId("00000000-0000-4000-8000-000000000001")
NEW_JOB_ID = JobId("00000000-0000-4000-8000-000000000002")
TWIN_JOB_ID = JobId("00000000-0000-4000-8000-000000000003")
FRESH_JOB_ID = JobId("00000000-0000-4000-8000-000000000004")
UNKNOWN_JOB_ID = JobId("00000000-0000-4000-8000-000000000099")
_UNTRUSTED_ANALYSIS_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


class _Publisher:
    def __init__(self) -> None:
        self.events: list[object] = []

    def publish(self, event: object) -> None:
        self.events.append(event)


def _insert_job(
    conn,
    url: str = JOB_URL,
    job_id: JobId = JOB_ID,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO jobs (
            tenant_id, job_id, url, title, site, strategy, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            url,
            "Platform Engineer",
            "ExampleCo",
            "test",
            "2026-04-29T10:00:00+00:00",
        ),
    )
    conn.commit()


@pytest.fixture()
def db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn)
    ensure_job_stage_rows(
        conn,
        JOB_ID,
        discovered_at="2026-04-29T10:00:00+00:00",
    )
    conn.commit()
    yield conn
    close_connection(db_path)


def test_load_returns_none_for_unknown_job(db):
    repo = SqlitePipelineStateRepository(db)
    result = repo.load(LOCAL_TENANT, UNKNOWN_JOB_ID)
    assert result is None


def test_roundtrip_save_and_load(db):
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None
    assert agg.version == 0  # initial

    # Mutate one stage
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)
    assert agg.version == 1

    # Re-load and verify
    reloaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert reloaded is not None
    assert reloaded.version == 1
    enrich = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich, Running)
    assert enrich.attempt_count == 1
    assert enrich.started_at == "2026-05-01T00:00:00Z"


def test_roundtrip_succeeded_state(db):
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None

    agg.set_stage_state(
        Stage.Score,
        Succeeded(attempt_count=1, finished_at="2026-05-01T00:05:00Z", duration_ms=5000),
    )
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert reloaded is not None
    score = reloaded.get_stage_state(Stage.Score)
    assert isinstance(score, Succeeded)
    assert score.finished_at == "2026-05-01T00:05:00Z"
    assert score.duration_ms == 5000


def test_roundtrip_failed_state(db):
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, JOB_ID)
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

    reloaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert reloaded is not None
    enrich = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich, Failed)
    assert enrich.error_code == "TIMEOUT"
    assert enrich.retryable is True
    assert enrich.next_action == "jobctrl retry enrich"


def test_optimistic_lock_conflict(db):
    repo = SqlitePipelineStateRepository(db)

    # Load two copies of the same aggregate
    agg1 = repo.load(LOCAL_TENANT, JOB_ID)
    agg2 = repo.load(LOCAL_TENANT, JOB_ID)
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
    assert results[0].job_id == JOB_ID


def test_list_by_stage_with_state_filter(db):
    repo = SqlitePipelineStateRepository(db)

    # discover is succeeded, enrich is pending
    results_succeeded = repo.list_by_stage(LOCAL_TENANT, "discover", state_filter="succeeded")
    assert len(results_succeeded) == 1

    results_failed = repo.list_by_stage(LOCAL_TENANT, "discover", state_filter="failed")
    assert len(results_failed) == 0


def test_save_creates_new_rows_for_new_job(db):
    """Save an aggregate for a job that has no existing rows in job_stage_states."""
    _insert_job(
        db,
        url="https://example.com/new-job",
        job_id=NEW_JOB_ID,
    )

    repo = SqlitePipelineStateRepository(db)
    agg = JobPipelineState.new_for_job(LOCAL_TENANT, NEW_JOB_ID)
    agg.set_stage_state(Stage.Discover, Succeeded(attempt_count=1, finished_at="2026-05-01T00:00:00Z"))
    repo.save(agg)
    assert agg.version == 1

    reloaded = repo.load(LOCAL_TENANT, NEW_JOB_ID)
    assert reloaded is not None
    assert reloaded.version == 1
    assert isinstance(reloaded.get_stage_state(Stage.Discover), Succeeded)


# ---------------------------------------------------------------------------
# PR 6: shared write path through state.set_stage_state
# ---------------------------------------------------------------------------


def _job_events(conn, job_id: JobId) -> list[tuple[str, str | None, str | None]]:
    """Return (event_type, stage, level) rows for one job ordered by id."""
    rows = conn.execute(
        "SELECT event_type, stage, level FROM job_events WHERE tenant_id = ? AND job_id = ? ORDER BY event_id",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchall()
    return [(r["event_type"], r["stage"], r["level"]) for r in rows]


def test_save_emits_event_per_changed_stage(db):
    """save() emits exactly one event per stage whose state changed."""
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None

    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    agg.set_stage_state(Stage.Score, Running(attempt_count=1, started_at="2026-05-01T00:01:00Z"))
    repo.save(agg)

    events = _job_events(db, JOB_ID)
    stages_with_events = sorted({stage for _, stage, _ in events if stage is not None})
    assert stages_with_events == ["enrich", "score"], events
    types_by_stage = {stage: event_type for event_type, stage, _ in events}
    assert types_by_stage["enrich"] == "StageStarted"
    assert types_by_stage["score"] == "StageStarted"


def test_current_events_persist_only_canonical_job_identity(db):
    db.execute("DELETE FROM job_events")
    publisher = _Publisher()
    record_job_event(
        db,
        JOB_ID,
        "enrich",
        "StageStarted",
        payload={
            **_UNTRUSTED_ANALYSIS_CONTEXT,
            "jobId": JOB_URL,
            "job_url": JOB_URL,
        },
        publisher=publisher,  # type: ignore[arg-type]
    )

    row = db.execute(
        """
        SELECT tenant_id, job_id, identity_version, payload_json
        FROM job_events
        """
    ).fetchone()
    payload = json.loads(row["payload_json"])
    assert tuple(row[:3]) == (str(LOCAL_TENANT), str(JOB_ID), 1)
    assert payload["jobId"] == str(JOB_ID)
    assert "job_url" not in payload
    assert payload["userContext"] == "Attack vectors:\nPrompt injection"
    assert "job_url" not in row.keys()
    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert getattr(event, "payload")["jobId"] == str(JOB_ID)
    assert "job_url" not in getattr(event, "payload")
    assert getattr(event, "payload")["userContext"] == ("Attack vectors:\nPrompt injection")


def test_run_scoped_events_do_not_invent_a_job_identity(db):
    db.execute("DELETE FROM job_events")
    publisher = _Publisher()

    record_job_event(
        db,
        None,
        "workflow",
        "WorkflowStarted",
        payload=_UNTRUSTED_ANALYSIS_CONTEXT,
        publisher=publisher,  # type: ignore[arg-type]
    )

    row = db.execute(
        """
        SELECT tenant_id, job_id, identity_version, payload_json
        FROM job_events
        """
    ).fetchone()
    payload = json.loads(row["payload_json"])
    assert tuple(row[:3]) == (str(LOCAL_TENANT), None, 1)
    assert "jobId" not in payload
    assert payload["userContext"] == "Attack vectors:\nPrompt injection"
    assert "jobId" not in getattr(publisher.events[0], "payload")


def test_pipeline_identity_rejects_url_shaped_values(db):
    repo = SqlitePipelineStateRepository(db)

    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(JOB_URL))
    with pytest.raises(ValueError, match="canonical UUID"):
        ensure_job_stage_rows(db, JobId(JOB_URL))
    with pytest.raises(ValueError, match="canonical UUID"):
        record_job_event(db, JobId(JOB_URL), "enrich", "StageStarted")


def test_completed_stage_unblocks_the_same_tenant_and_job(db):
    set_stage_state(
        db,
        JOB_ID,
        "score",
        "blocked",
        error_code="BLOCKED",
        error_message="Enrichment has not completed.",
        validate_transition=False,
    )

    set_stage_state(
        db,
        JOB_ID,
        "enrich",
        "succeeded",
        validate_transition=False,
    )

    score = db.execute(
        "SELECT state, error_code FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
        (str(LOCAL_TENANT), str(JOB_ID)),
    ).fetchone()
    assert tuple(score) == ("pending", None)
    reset = db.execute(
        "SELECT tenant_id, job_id, identity_version FROM job_events "
        "WHERE event_type = 'StageReset' AND stage = 'score'",
    ).fetchone()
    assert tuple(reset) == (str(LOCAL_TENANT), str(JOB_ID), 1)


def test_save_does_not_emit_for_idempotent_writes(db):
    """save() must not emit an event when the persisted state is unchanged."""
    repo = SqlitePipelineStateRepository(db)
    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None

    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)

    db.execute("DELETE FROM job_events")
    db.commit()

    # Re-load + save without changing anything.
    reloaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert reloaded is not None
    repo.save(reloaded)

    events = _job_events(db, JOB_ID)
    assert events == [], events


def test_save_emits_state_specific_event_types(db):
    """Each terminal state has a dedicated event type."""
    repo = SqlitePipelineStateRepository(db)

    # Set up: drive enrich Pending -> Running -> Failed in two saves.
    agg = repo.load(LOCAL_TENANT, JOB_ID)
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

    events = _job_events(db, JOB_ID)
    assert events == [("StageFailed", "enrich", "error")], events


def test_save_event_emission_matches_canonical_helper(db):
    """A repo.save() flow produces the same row state as a sequence of canonical
    set_stage_state() calls would (regression: dual write path is gone).
    """
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    # Path A: write Enrich Running -> Succeeded via the repository.
    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)
    agg.set_stage_state(
        Stage.Enrich,
        Succeeded(attempt_count=1, finished_at="2026-05-01T00:01:00Z", duration_ms=60000),
    )
    repo.save(agg)
    repo_row = db.execute(
        "SELECT state, attempt_count, started_at, finished_at, duration_ms "
        "FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(JOB_ID)),
    ).fetchone()

    # Path B: identical writes via canonical set_stage_state on a sibling job.
    _insert_job(
        db,
        url="https://example.com/twin",
        job_id=TWIN_JOB_ID,
    )
    ensure_job_stage_rows(
        db,
        TWIN_JOB_ID,
        discovered_at="2026-04-29T10:00:00+00:00",
    )
    db.commit()
    set_stage_state(
        db,
        TWIN_JOB_ID,
        "enrich",
        "running",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
    )
    set_stage_state(
        db,
        TWIN_JOB_ID,
        "enrich",
        "succeeded",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
        finished_at="2026-05-01T00:01:00Z",
        duration_ms=60000,
    )
    db.commit()
    twin_row = db.execute(
        "SELECT state, attempt_count, started_at, finished_at, duration_ms "
        "FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(TWIN_JOB_ID)),
    ).fetchone()

    assert dict(repo_row) == dict(twin_row)


def test_save_attempts_counter_progresses_across_calls(db):
    """The attempt_count is preserved across successive save() calls."""
    repo = SqlitePipelineStateRepository(db)

    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
    repo.save(agg)

    reloaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert reloaded is not None
    enrich_state = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(enrich_state, Running)
    assert enrich_state.attempt_count == 1

    reloaded.set_stage_state(Stage.Enrich, Running(attempt_count=2, started_at="2026-05-01T00:02:00Z"))
    repo.save(reloaded)

    final = repo.load(LOCAL_TENANT, JOB_ID)
    assert final is not None
    final_state = final.get_stage_state(Stage.Enrich)
    assert isinstance(final_state, Running)
    assert final_state.attempt_count == 2


def test_save_blocked_state_round_trip(db):
    """Blocked persists blocked_by + emits StageBlocked."""
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    agg = repo.load(LOCAL_TENANT, JOB_ID)
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

    reloaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert reloaded is not None
    state = reloaded.get_stage_state(Stage.Enrich)
    assert isinstance(state, Blocked)
    assert state.blocked_by == (Stage.Discover,)

    events = _job_events(db, JOB_ID)
    assert ("StageBlocked", "enrich", "warn") in events


def test_save_skipped_state_emits_stage_skipped(db):
    repo = SqlitePipelineStateRepository(db)
    db.execute("DELETE FROM job_events")
    db.commit()

    agg = repo.load(LOCAL_TENANT, JOB_ID)
    assert agg is not None
    agg.set_stage_state(Stage.Enrich, Skipped(reason="below threshold"))
    repo.save(agg)

    events = _job_events(db, JOB_ID)
    assert ("StageSkipped", "enrich", "info") in events


def test_save_canceled_state_emits_stage_canceled(db):
    repo = SqlitePipelineStateRepository(db)
    # Cancel is a valid transition only from Queued/Running, so seed Running.
    agg = repo.load(LOCAL_TENANT, JOB_ID)
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

    events = _job_events(db, JOB_ID)
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
        JOB_ID,
        "enrich",
        "running",
        attempt_count=1,
        started_at="2026-05-01T00:00:00Z",
        expected_version=0,
        validate_transition=False,
    )
    db.commit()

    row = db.execute(
        "SELECT state, version FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(JOB_ID)),
    ).fetchone()
    assert row["state"] == "running"
    assert row["version"] == 1


def test_set_stage_state_expected_version_mismatch_raises(db):
    """state.set_stage_state raises OptimisticLockError on stale expected_version."""
    # Bump version to 1.
    set_stage_state(
        db,
        JOB_ID,
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
            JOB_ID,
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
    _insert_job(
        db,
        url="https://example.com/fresh",
        job_id=FRESH_JOB_ID,
    )
    db.commit()

    set_stage_state(
        db,
        FRESH_JOB_ID,
        "enrich",
        "pending",
        expected_version=0,
        validate_transition=False,
    )
    db.commit()

    row = db.execute(
        "SELECT state, version FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(FRESH_JOB_ID)),
    ).fetchone()
    assert row["state"] == "pending"
    assert row["version"] == 1
