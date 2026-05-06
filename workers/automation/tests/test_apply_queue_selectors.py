"""Phase 8 (S-30): empirical proof that ``database.get_jobs_by_stage``
``pending_apply`` / ``applied`` selectors and ``get_stats`` see new
``ApplyRun`` writes (no dual-write to legacy jobs.* columns).

Mirrors the Phase-5/6/7 ``test_*_queue_selectors`` pattern.
"""

from pathlib import Path

import pytest

from jobhunter.database import (
    close_connection,
    get_connection,
    get_jobs_by_stage,
    get_stats,
    init_db,
)
from jobhunter.domain.apply import (
    Applied,
    ApplyRun,
    Failed,
    new_apply_run_id,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.apply import SqliteApplyRunRepository


@pytest.fixture()
def conn(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    yield get_connection(db_path)
    close_connection(db_path)


def _insert_apply_ready_job(conn, *, url: str = "https://example.com/job"):
    """Insert a job that satisfies the materials/score gates so the
    pending_apply selector should pick it."""
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url,
            fit_score, tailored_resume_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Eng",
            "ExampleCo",
            "Build distributed systems.",
            "https://example.com/apply",
            9,
            "/tmp/resume.txt",
        ),
    )
    conn.commit()


def test_pending_apply_includes_jobs_with_no_apply_run(conn):
    _insert_apply_ready_job(conn)
    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    assert len(rows) == 1
    assert rows[0]["url"] == "https://example.com/job"


def test_pending_apply_excludes_jobs_with_succeeded_apply_run(conn):
    """After the new launcher writes a succeeded ApplyRun, the
    pending_apply selector must drop the job (and applied selector
    must include it)."""
    _insert_apply_ready_job(conn)
    repo = SqliteApplyRunRepository(conn)
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="t0",
        ).complete(
            result=Applied(applied_at="t9", verification_confidence=1.0),
            finished_at="t9",
        )
    )
    pending = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    applied = get_jobs_by_stage(conn, "applied")
    assert pending == []
    assert len(applied) == 1
    assert applied[0]["url"] == "https://example.com/job"


def test_pending_apply_excludes_jobs_with_in_progress_apply_run(conn):
    """A starting/in-progress run is the lock — the queue must skip it."""
    _insert_apply_ready_job(conn)
    repo = SqliteApplyRunRepository(conn)
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="t0",
        ).transition_to_in_progress()
    )
    pending = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    assert pending == []


def test_pending_apply_includes_jobs_with_failed_apply_run(conn):
    """A failed run leaves the job re-queued (the eligibility checker
    enforces the per-attempt cap; the SQL selector only checks for an
    ACTIVE lock)."""
    _insert_apply_ready_job(conn)
    repo = SqliteApplyRunRepository(conn)
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="t0",
        ).complete(
            result=Failed(error="boom", retryable=True),
            finished_at="t9",
        )
    )
    pending = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    assert len(pending) == 1


def test_get_stats_reflects_apply_runs(conn):
    _insert_apply_ready_job(conn)
    # Pre-condition: nothing applied.
    stats = get_stats(conn)
    assert stats["applied"] == 0

    repo = SqliteApplyRunRepository(conn)
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="t0",
        ).complete(
            result=Applied(applied_at="t9", verification_confidence=1.0),
            finished_at="t9",
        )
    )
    stats_after = get_stats(conn)
    assert stats_after["applied"] == 1
    assert stats_after["ready_to_apply"] == 0


def test_apply_join_tie_breaks_by_run_id_on_same_started_at(conn):
    """Round-1 review L1: when two apply_runs rows share an identical
    ``started_at`` (e.g. same-second retries), the join must
    deterministically return ONE parent jobs row — the previous
    MAX(started_at) GROUP BY pattern duplicated the parent row.

    The tie-breaker is run_id DESC, so the row with the
    lexicographically larger run_id wins.
    """
    _insert_apply_ready_job(conn, url="https://example.com/job-tied")
    repo = SqliteApplyRunRepository(conn)
    # Two failed runs, identical started_at.
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id="run-aaaa",
            job_id=JobId("https://example.com/job-tied"),
            started_at="2026-05-01T00:00:00+00:00",
        ).complete(
            result=Failed(error="first", retryable=True),
            finished_at="2026-05-01T00:00:01+00:00",
        )
    )
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id="run-bbbb",
            job_id=JobId("https://example.com/job-tied"),
            started_at="2026-05-01T00:00:00+00:00",
        ).complete(
            result=Failed(error="second", retryable=True),
            finished_at="2026-05-01T00:00:02+00:00",
        )
    )
    # The selector must return ONE row, not two. The ORDER BY in the
    # tie-breaker subquery picks ``run-bbbb`` (lex max).
    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    matching = [r for r in rows if r["url"] == "https://example.com/job-tied"]
    assert len(matching) == 1
    assert matching[0]["apply_status"] == "failed"
    assert matching[0]["apply_task_id"] == "run-bbbb"


def test_pending_apply_promotes_apply_status_into_row_dict(conn):
    """The SELECT in get_jobs_by_stage promotes the apply_runs status
    into the legacy ``apply_status`` slot so downstream consumers
    that still read ``row["apply_status"]`` see canonical values."""
    _insert_apply_ready_job(conn, url="https://example.com/job-with-fail")
    repo = SqliteApplyRunRepository(conn)
    repo.save(
        ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job-with-fail"),
            started_at="t0",
        ).complete(
            result=Failed(error="boom", retryable=True),
            finished_at="t9",
        )
    )
    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    matching = [r for r in rows if r["url"] == "https://example.com/job-with-fail"]
    assert len(matching) == 1
    # Legacy column stays NULL — the COALESCE in the SELECT promotes
    # the apply_runs.status onto the dict's ``apply_status`` key.
    assert matching[0]["apply_status"] == "failed"
