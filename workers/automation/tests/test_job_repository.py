"""Phase 7 / S-25: SqliteJobRepository round-trip + soft-delete + restore.

The repository sits on the existing wide ``jobs`` table (per migration
plan §8 the per-aggregate table narrowing is deferred). These tests pin
the discovery-column round-trip plus the soft-delete tombstone shape so
the aggregate's ``deleted_at`` field stays consistent with the
``jobctrl_deleted_jobs`` table the API also writes to.
"""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.database import init_db, resurface_deleted_job
from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.discovery.sqlite_repository import JobUrlConflict


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    db_path = tmp_path / "jobctrl.db"
    return init_db(db_path)


def _make_job(url: str = "https://example.com/jobs/1") -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        posting_url=PostingUrl(value=url),
        source=Source(board="greenhouse"),
        employer=Employer(name="Acme Corp"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(
            title="Senior Engineer",
            salary="$200k",
            description="Build great things.",
            location="Remote",
        ),
        discovered_at="2026-05-01T00:00:00+00:00",
    )


def test_save_then_load_round_trips(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    original = _make_job()
    repo.save(original)

    loaded = repo.load(LOCAL_TENANT, original.job_id)
    assert loaded is not None
    assert loaded.posting_url.value == original.posting_url.value
    assert loaded.source.board == "greenhouse"
    assert loaded.search_strategy is SearchStrategy.JOBSPY
    assert loaded.metadata.title == "Senior Engineer"
    assert loaded.metadata.salary == "$200k"
    assert loaded.metadata.location == "Remote"
    assert loaded.discovered_at == "2026-05-01T00:00:00+00:00"
    assert loaded.is_deleted is False


def test_load_by_url_finds_jobs(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    found = repo.load_by_url(LOCAL_TENANT, job.posting_url)
    assert found is not None
    assert found.job_id == job.job_id


def test_load_by_url_returns_none_for_unknown(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    assert repo.load_by_url(LOCAL_TENANT, PostingUrl(value="https://nope/")) is None


def test_save_idempotent_preserves_discovered_at(conn: sqlite3.Connection) -> None:
    """Re-saving the same URL must not reset the discovery timestamp."""
    repo = SqliteJobRepository(conn)
    original = _make_job()
    repo.save(original)

    rediscovered = original.with_metadata(JobMetadata(title="Staff Engineer", salary="$250k", location="Remote"))
    # Bump the discovered_at on the in-memory aggregate; the persisted
    # row should keep the original timestamp.
    rediscovered = Job.discover(
        tenant_id=rediscovered.tenant_id,
        job_id=rediscovered.job_id,
        posting_url=rediscovered.posting_url,
        source=rediscovered.source,
        employer=rediscovered.employer,
        search_strategy=rediscovered.search_strategy,
        metadata=rediscovered.metadata,
        discovered_at="2026-05-09T00:00:00+00:00",
    )
    repo.save(rediscovered)
    loaded = repo.load(LOCAL_TENANT, original.job_id)
    assert loaded is not None
    assert loaded.metadata.title == "Staff Engineer"
    assert loaded.discovered_at == "2026-05-01T00:00:00+00:00"  # preserved


def test_save_rejects_url_owned_by_different_job(conn: sqlite3.Connection) -> None:
    """The §4.1 dedup invariant: same URL ⇒ same job_id."""
    repo = SqliteJobRepository(conn)
    repo.save(_make_job())
    intruder = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("different-id"),
        posting_url=PostingUrl(value="https://example.com/jobs/1"),
        source=Source(board="linkedin"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.MANUAL,
        metadata=JobMetadata(title="x"),
        discovered_at="2026-05-02T00:00:00+00:00",
    )
    with pytest.raises(JobUrlConflict):
        repo.save(intruder)


def test_list_recent_orders_by_discovered_at_desc(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    older = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/old"),
        posting_url=PostingUrl(value="https://example.com/old"),
        source=Source(board="greenhouse"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.MANUAL,
        metadata=JobMetadata(title="Older"),
        discovered_at="2026-04-01T00:00:00+00:00",
    )
    newer = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/new"),
        posting_url=PostingUrl(value="https://example.com/new"),
        source=Source(board="greenhouse"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.MANUAL,
        metadata=JobMetadata(title="Newer"),
        discovered_at="2026-05-01T00:00:00+00:00",
    )
    repo.save(older)
    repo.save(newer)
    rows = repo.list_recent(LOCAL_TENANT, limit=10)
    assert [j.posting_url.value for j in rows] == [
        "https://example.com/new",
        "https://example.com/old",
    ]


def test_list_recent_hides_soft_deleted_by_default(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    repo.save(_make_job("https://example.com/a"))
    repo.save(_make_job("https://example.com/b"))
    repo.soft_delete(
        LOCAL_TENANT,
        JobId("https://example.com/a"),
        reason="test",
        deleted_at="2026-05-02T00:00:00+00:00",
    )
    visible = repo.list_recent(LOCAL_TENANT)
    urls = {j.posting_url.value for j in visible}
    assert urls == {"https://example.com/b"}

    all_jobs = repo.list_recent(LOCAL_TENANT, include_deleted=True)
    assert {j.posting_url.value for j in all_jobs} == {
        "https://example.com/a",
        "https://example.com/b",
    }


def test_soft_delete_writes_tombstone_row(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    deleted = repo.soft_delete(
        LOCAL_TENANT,
        job.job_id,
        reason="not interested",
        deleted_at="2026-05-02T00:00:00+00:00",
    )
    assert deleted is not None and deleted.is_deleted

    row = conn.execute(
        "SELECT deleted_at, reason, restored_at FROM jobctrl_deleted_jobs WHERE job_url = ?",
        (str(job.job_id),),
    ).fetchone()
    assert row is not None
    assert row["deleted_at"] == "2026-05-02T00:00:00+00:00"
    assert row["reason"] == "not interested"
    assert row["restored_at"] is None

    # load picks up the deleted_at
    loaded = repo.load(LOCAL_TENANT, job.job_id)
    assert loaded is not None and loaded.is_deleted


def test_soft_delete_returns_none_for_unknown_job(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    assert (
        repo.soft_delete(
            LOCAL_TENANT,
            JobId("https://nope/"),
            reason=None,
            deleted_at="2026-05-02T00:00:00+00:00",
        )
        is None
    )


def test_restore_clears_tombstone(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    repo.soft_delete(
        LOCAL_TENANT,
        job.job_id,
        reason="x",
        deleted_at="2026-05-02T00:00:00+00:00",
    )
    restored = repo.restore(LOCAL_TENANT, job.job_id)
    assert restored is not None
    assert restored.is_deleted is False
    assert restored.deleted_at is None

    loaded = repo.load(LOCAL_TENANT, job.job_id)
    assert loaded is not None
    assert loaded.is_deleted is False

    # Tombstone row carries restored_at (audit history preserved)
    row = conn.execute(
        "SELECT restored_at FROM jobctrl_deleted_jobs WHERE job_url = ?",
        (str(job.job_id),),
    ).fetchone()
    assert row is not None
    assert row["restored_at"] is not None


def test_resurface_deleted_job_clears_tombstone_and_records_event(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    repo.soft_delete(
        LOCAL_TENANT,
        job.job_id,
        reason="not right now",
        deleted_at="2026-05-02T00:00:00+00:00",
    )

    resurface_deleted_job(conn, str(job.job_id), resurfaced_at="2026-05-03T00:00:00+00:00")

    row = conn.execute(
        "SELECT restored_at FROM jobctrl_deleted_jobs WHERE job_url = ?",
        (str(job.job_id),),
    ).fetchone()
    assert row is not None
    assert row["restored_at"] == "2026-05-03T00:00:00+00:00"
    event = conn.execute(
        "SELECT event_type, message FROM job_events WHERE job_url = ? ORDER BY event_id DESC LIMIT 1",
        (str(job.job_id),),
    ).fetchone()
    assert event is not None
    assert event["event_type"] == "JobRestored"
    assert event["message"] == "Job resurfaced because discovery observed it again."


def test_restore_is_noop_for_undeleted_job(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    restored = repo.restore(LOCAL_TENANT, job.job_id)
    assert restored is not None
    assert restored.is_deleted is False
