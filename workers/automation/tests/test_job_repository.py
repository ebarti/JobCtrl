"""Phase 7 / S-25: SqliteJobRepository round-trip + soft-delete + restore.

The repository sits on the existing wide ``jobs`` table (per migration
plan §8 the per-aggregate table narrowing is deferred). These tests pin
the discovery-column round-trip plus the soft-delete tombstone shape so
the aggregate's ``deleted_at`` field stays consistent with the
``jobctrl_deleted_jobs`` table the API also writes to.
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl.database import init_db, resurface_deleted_job
from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    JobSourceObservation,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.discovery import (
    SqliteJobIdentityResolver,
    SqliteJobRepository,
)
from jobctrl.infrastructure.discovery.sqlite_repository import JobUrlConflict


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    db_path = tmp_path / "jobctrl.db"
    return init_db(db_path)


def _make_job(
    url: str = "https://example.com/jobs/1",
    *,
    job_id: JobId | None = None,
) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id or JobId(url),
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
    assert found.posting_url == job.posting_url
    assert uuid.UUID(str(found.job_id)).version == 4
    assert str(found.job_id) != job.posting_url.value


def test_save_preserves_supplied_stable_job_id(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    stable_id = JobId("1d4d7064-21e7-49dc-b53c-90676906af6e")
    job = _make_job(job_id=stable_id)

    repo.save(job)

    found_by_id = repo.load(LOCAL_TENANT, stable_id)
    assert found_by_id is not None
    assert found_by_id.job_id == stable_id
    assert found_by_id.posting_url == job.posting_url
    found_by_legacy_url = repo.load(LOCAL_TENANT, JobId(job.posting_url.value))
    assert found_by_legacy_url is not None
    assert found_by_legacy_url.job_id == stable_id


def test_identity_resolver_keeps_job_id_stable_across_url_aliases(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    resolver = SqliteJobIdentityResolver(conn)
    stable_id = JobId("b1bdf251-a7a2-44b9-99fa-cb4097fe6942")
    original_url = PostingUrl(value="https://example.com/jobs/original")
    replacement_url = PostingUrl(value="https://example.com/jobs/current")
    repo.save(_make_job(original_url.value, job_id=stable_id))
    repo.attach_source_observation(
        LOCAL_TENANT,
        stable_id,
        JobSourceObservation(
            source_observation_id="obs-original",
            source_id="greenhouse:acme",
            source_native_id="original",
            observed_url=original_url.value,
            run_id="run-original",
            observed_at="2026-05-01T00:00:00+00:00",
        ),
    )

    returned_id = repo.save(
        _make_job(
            replacement_url.value,
            job_id=stable_id,
        )
    )

    by_id = resolver.resolve_by_job_id(LOCAL_TENANT, stable_id)
    by_original_url = resolver.resolve_by_posting_url(LOCAL_TENANT, original_url)
    by_replacement_url = resolver.resolve_by_posting_url(
        LOCAL_TENANT,
        replacement_url,
    )
    storage_row = conn.execute(
        "SELECT url FROM jobs WHERE tenant_id = ? AND job_id = ?",
        (str(LOCAL_TENANT), str(stable_id)),
    ).fetchone()
    alias_rows = conn.execute(
        """
        SELECT alias_value, retired_at
        FROM job_identity_aliases
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY alias_value
        """,
        (str(LOCAL_TENANT), str(stable_id)),
    ).fetchall()
    observation_row = conn.execute(
        """
        SELECT job_id
        FROM job_source_observations
        WHERE source_observation_id = 'obs-original'
        """
    ).fetchone()
    assert returned_id == stable_id
    assert by_id is not None
    assert by_original_url == by_id
    assert by_replacement_url == by_id
    assert by_id.posting_url == replacement_url
    assert by_id.storage_url == original_url
    assert storage_row["url"] == original_url.value
    assert {row["alias_value"]: row["retired_at"] is None for row in alias_rows} == {
        original_url.value: False,
        replacement_url.value: True,
    }
    assert observation_row["job_id"] == str(stable_id)
    loaded_by_original_url = repo.load(
        LOCAL_TENANT,
        JobId(original_url.value),
    )
    assert loaded_by_original_url is not None
    assert loaded_by_original_url.job_id == stable_id
    assert loaded_by_original_url.posting_url == replacement_url
    assert resolver.resolve_by_job_id(TenantId("other"), stable_id) is None
    assert resolver.resolve_by_posting_url(TenantId("other"), replacement_url) is None


def test_concurrent_first_save_returns_one_stable_url_owner(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "concurrent-jobctrl.db"
    initialized = init_db(db_path)
    initialized.close()
    barrier = threading.Barrier(2)

    class BarrierResolver:
        def __init__(self, connection: sqlite3.Connection) -> None:
            self._delegate = SqliteJobIdentityResolver(connection)
            self._waited = False

        def resolve_by_job_id(
            self,
            tenant_id: TenantId,
            job_id: JobId,
        ):
            return self._delegate.resolve_by_job_id(tenant_id, job_id)

        def resolve_by_posting_url(
            self,
            tenant_id: TenantId,
            posting_url: PostingUrl,
        ):
            resolved = self._delegate.resolve_by_posting_url(
                tenant_id,
                posting_url,
            )
            if resolved is None and not self._waited:
                self._waited = True
                barrier.wait(timeout=5)
            return resolved

    connections = [
        sqlite3.connect(
            db_path,
            timeout=10,
            check_same_thread=False,
        )
        for _ in range(2)
    ]
    for connection in connections:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
    repositories = [
        SqliteJobRepository(
            connection,
            identity_resolver=BarrierResolver(connection),
        )
        for connection in connections
    ]
    candidate_ids = [
        JobId("b1e0e6f4-dafe-4a50-8c2f-55522e5a9ee5"),
        JobId("ac03f977-cf3b-47a0-b060-51f50ec8de49"),
    ]

    def save_candidate(index: int) -> JobId:
        return repositories[index].save(
            _make_job(
                "https://example.com/jobs/concurrent",
                job_id=candidate_ids[index],
            )
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            returned_ids = list(executor.map(save_candidate, range(2)))
        check = sqlite3.connect(db_path)
        try:
            rows = check.execute("SELECT job_id, url FROM jobs").fetchall()
        finally:
            check.close()
    finally:
        for connection in connections:
            connection.close()

    assert len(rows) == 1
    assert returned_ids[0] == returned_ids[1] == JobId(str(rows[0][0]))
    assert rows[0][1] == "https://example.com/jobs/concurrent"


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
        job_id=JobId("18a92504-89e8-4966-a765-ab641919cb6d"),
        posting_url=PostingUrl(value="https://example.com/jobs/1"),
        source=Source(board="linkedin"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.MANUAL,
        metadata=JobMetadata(title="x"),
        discovered_at="2026-05-02T00:00:00+00:00",
    )
    with pytest.raises(JobUrlConflict):
        repo.save(intruder)
    assert conn.in_transaction is False
    owner = repo.load_by_url(
        LOCAL_TENANT,
        PostingUrl(value="https://example.com/jobs/1"),
    )
    assert owner is not None
    assert owner.metadata.title == "Senior Engineer"


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
        """
        SELECT deleted.deleted_at, deleted.reason, deleted.restored_at
        FROM jobctrl_deleted_jobs AS deleted
        JOIN jobs
          ON jobs.tenant_id = deleted.tenant_id
         AND jobs.job_id = deleted.job_id
        WHERE jobs.url = ?
        """,
        (job.posting_url.value,),
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
        """
        SELECT deleted.restored_at
        FROM jobctrl_deleted_jobs AS deleted
        JOIN jobs
          ON jobs.tenant_id = deleted.tenant_id
         AND jobs.job_id = deleted.job_id
        WHERE jobs.url = ?
        """,
        (job.posting_url.value,),
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
        """
        SELECT deleted.restored_at
        FROM jobctrl_deleted_jobs AS deleted
        JOIN jobs
          ON jobs.tenant_id = deleted.tenant_id
         AND jobs.job_id = deleted.job_id
        WHERE jobs.url = ?
        """,
        (job.posting_url.value,),
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
