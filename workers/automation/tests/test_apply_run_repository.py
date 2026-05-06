"""Phase 8 (S-29): SqliteApplyRunRepository round-trip + queries."""

from pathlib import Path

import pytest

from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.domain.apply import (
    Applied,
    ApplyRun,
    ApplyRunStatus,
    Failed,
    TokenUsage,
    new_apply_run_id,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.apply import SqliteApplyRunRepository


@pytest.fixture()
def repo(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    conn = get_connection(db_path)
    yield SqliteApplyRunRepository(conn)
    close_connection(db_path)


def _starting_run() -> ApplyRun:
    return ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=3,
        model="sonnet",
        dry_run=False,
        headless=True,
        attempts=2,
    )


def test_save_then_load_round_trips_starting_run(repo):
    run = _starting_run()
    repo.save(run)

    loaded = repo.load(LOCAL_TENANT, run.run_id)
    assert loaded is not None
    assert loaded.run_id == run.run_id
    assert loaded.status == ApplyRunStatus.STARTING
    assert loaded.headless is True
    assert loaded.attempts == 2


def test_save_then_load_round_trips_terminal_applied_run(repo):
    run = _starting_run().transition_to_in_progress()
    run = run.record_event(event_type="X", occurred_at="t1", payload={"k": 1})
    completed = run.complete(
        result=Applied(applied_at="t9", verification_confidence=0.7),
        finished_at="t9",
        token_usage=TokenUsage(input=100, output=50, cost_usd=0.123),
        duration_ms=12345,
    )
    repo.save(completed)

    loaded = repo.load(LOCAL_TENANT, completed.run_id)
    assert loaded is not None
    assert loaded.is_succeeded
    assert loaded.duration_ms == 12345
    assert loaded.submission_result is not None
    assert loaded.submission_result.kind == "applied"
    # Token usage round-trips.
    assert loaded.token_usage is not None
    assert loaded.token_usage.input == 100
    assert loaded.token_usage.cost_usd == pytest.approx(0.123)
    # Event timeline preserved.
    assert len(loaded.events) == 1
    assert loaded.events[0].event_type == "X"
    assert loaded.events[0].payload == {"k": 1}


def test_list_recent_orders_by_started_at_desc(repo):
    a = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("a"),
        started_at="2024-01-01T00:00:00+00:00",
    )
    b = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("b"),
        started_at="2024-02-01T00:00:00+00:00",
    )
    repo.save(a)
    repo.save(b)
    recent = repo.list_recent(LOCAL_TENANT, limit=10)
    assert [r.run_id for r in recent] == [b.run_id, a.run_id]


def test_list_active_excludes_terminal_runs(repo):
    starting = _starting_run()
    in_progress = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("p"),
        started_at="t1",
    ).transition_to_in_progress()
    failed = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("f"),
        started_at="t2",
    ).complete(result=Failed(error="x", retryable=True), finished_at="t9")
    for r in (starting, in_progress, failed):
        repo.save(r)

    active = repo.list_active(LOCAL_TENANT)
    statuses = {r.status for r in active}
    assert statuses == {ApplyRunStatus.STARTING, ApplyRunStatus.IN_PROGRESS}


def test_save_replaces_event_timeline(repo):
    run = _starting_run()
    repo.save(run.record_event(event_type="A", occurred_at="t1"))

    loaded = repo.load(LOCAL_TENANT, run.run_id)
    assert loaded is not None
    assert len(loaded.events) == 1

    # Re-save with a different timeline — old events must be gone.
    refreshed = run.record_event(event_type="B", occurred_at="t2")
    repo.save(refreshed)
    reloaded = repo.load(LOCAL_TENANT, run.run_id)
    assert reloaded is not None
    assert [e.event_type for e in reloaded.events] == ["B"]


def test_load_returns_none_for_unknown_run(repo):
    assert repo.load(LOCAL_TENANT, new_apply_run_id()) is None


def test_save_hydrates_title_site_application_url_from_jobs_row(tmp_path):
    """Round-1 review H1: the dashboard apply-runs widget + CLI runs
    table read ``title`` / ``site`` / ``application_url`` directly from
    the apply_runs row. The repository must populate those columns from
    the parent ``jobs`` row at save time so the widgets show real
    values instead of "Untitled" / "Unknown company"."""
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    conn = get_connection(db_path)
    try:
        # Seed the parent job row.
        conn.execute(
            """
            INSERT INTO jobs (url, title, site, application_url)
            VALUES (?, ?, ?, ?)
            """,
            (
                "https://example.com/job",
                "Platform Engineer",
                "ExampleCo",
                "https://example.com/apply",
            ),
        )
        conn.commit()

        repo = SqliteApplyRunRepository(conn)
        run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="t0",
        )
        repo.save(run)

        row = conn.execute(
            "SELECT title, site, application_url FROM apply_runs WHERE run_id = ?",
            (str(run.run_id),),
        ).fetchone()
        assert row is not None
        assert row["title"] == "Platform Engineer"
        assert row["site"] == "ExampleCo"
        assert row["application_url"] == "https://example.com/apply"
    finally:
        close_connection(db_path)


def test_save_leaves_denormalised_columns_null_when_jobs_row_missing(tmp_path):
    """Hydration is best-effort: if the parent ``jobs`` row doesn't
    exist (synthesised aggregate, unit test seeding only apply_runs),
    the columns stay NULL — no crash."""
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    conn = get_connection(db_path)
    try:
        repo = SqliteApplyRunRepository(conn)
        run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/orphan"),
            started_at="t0",
        )
        repo.save(run)

        row = conn.execute(
            "SELECT title, site, application_url FROM apply_runs WHERE run_id = ?",
            (str(run.run_id),),
        ).fetchone()
        assert row is not None
        assert row["title"] is None
        assert row["site"] is None
        assert row["application_url"] is None
    finally:
        close_connection(db_path)
