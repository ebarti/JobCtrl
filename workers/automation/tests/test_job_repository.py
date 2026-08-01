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

from jobctrl.database import init_db
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
        job_id=job_id or JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, url))),
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


def test_reopen_round_trips_employer_separately_from_source(tmp_path: Path) -> None:
    db_path = tmp_path / "employer-source.db"
    writer = init_db(db_path)
    original = _make_job().with_employer(Employer(name="Acme"))
    SqliteJobRepository(writer).save(original)
    writer.close()

    reader = init_db(db_path)
    try:
        loaded = SqliteJobRepository(reader).load(LOCAL_TENANT, original.job_id)
        stored = reader.execute(
            "SELECT company, site FROM jobs WHERE tenant_id = ? AND job_id = ?",
            (str(LOCAL_TENANT), str(original.job_id)),
        ).fetchone()
        assert loaded is not None
        assert loaded.employer.name == "Acme"
        assert loaded.source.board == "greenhouse"
        assert tuple(stored) == ("Acme", "greenhouse")
    finally:
        reader.close()


def test_explicit_locator_resolution_finds_jobs(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    identity = repo.resolve_by_posting_url(LOCAL_TENANT, job.posting_url)
    assert identity is not None
    found = repo.load(LOCAL_TENANT, identity.job_id)
    assert found is not None
    assert found.posting_url == job.posting_url
    assert found.job_id == job.job_id


def test_save_preserves_supplied_stable_job_id(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    stable_id = JobId("1d4d7064-21e7-49dc-b53c-90676906af6e")
    job = _make_job(job_id=stable_id)

    repo.save(job)

    found_by_id = repo.load(LOCAL_TENANT, stable_id)
    assert found_by_id is not None
    assert found_by_id.job_id == stable_id
    assert found_by_id.posting_url == job.posting_url
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(job.posting_url.value))


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
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 1, 8, '{}', '["python"]', ?)
        """,
        (str(LOCAL_TENANT), str(stable_id), "2026-05-01T01:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, updated_at
        ) VALUES (?, ?, 'score', 'succeeded', ?)
        """,
        (str(LOCAL_TENANT), str(stable_id), "2026-05-01T01:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO preparation_work_items (
            item_id, tenant_id, job_id, kind, target_version,
            source_event_id, state, idempotency_key, created_at,
            updated_at, available_at
        ) VALUES (
            'prep-alias', ?, ?, 'score', 1,
            'event-alias', 'completed', 'prep-alias-key', ?, ?, ?
        )
        """,
        (
            str(LOCAL_TENANT),
            str(stable_id),
            "2026-05-01T01:00:00+00:00",
            "2026-05-01T01:00:00+00:00",
            "2026-05-01T01:00:00+00:00",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_artifacts (
            tenant_id, job_id, stage, artifact_type, status, path, created_at
        ) VALUES (?, ?, 'tailor', 'resume_pdf', 'accepted', ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(stable_id),
            "artifacts/resume-alias.pdf",
            "2026-05-01T01:00:00+00:00",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type,
            occurred_at, payload_json
        ) VALUES (?, ?, 7, 'score', 'JobScored', ?, '{}')
        """,
        (str(LOCAL_TENANT), str(stable_id), "2026-05-01T01:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source,
            occurred_at, recorded_at
        ) VALUES (?, 'outcome-alias', ?, 'interview', 'user', ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(stable_id),
            "2026-05-01T02:00:00+00:00",
            "2026-05-01T02:00:00+00:00",
        ),
    )
    conn.commit()

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
    locator_rows = conn.execute(
        """
        SELECT locator_value, is_current, retired_at
        FROM job_locators
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY locator_value
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
    assert storage_row["url"] == replacement_url.value
    assert {
        row["locator_value"]: (row["is_current"], row["retired_at"] is None)
        for row in locator_rows
    } == {
        original_url.value: (0, False),
        replacement_url.value: (1, True),
    }
    assert observation_row["job_id"] == str(stable_id)
    dependent_rows = conn.execute(
        """
        SELECT 'job_scores' AS relation, job_id FROM job_scores
        WHERE tenant_id = ? AND job_id = ?
        UNION ALL
        SELECT 'job_stage_states', job_id FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ?
        UNION ALL
        SELECT 'preparation_work_items', job_id FROM preparation_work_items
        WHERE tenant_id = ? AND job_id = ?
        UNION ALL
        SELECT 'job_artifacts', job_id FROM job_artifacts
        WHERE tenant_id = ? AND job_id = ?
        UNION ALL
        SELECT 'job_events', job_id FROM job_events
        WHERE tenant_id = ? AND job_id = ?
        UNION ALL
        SELECT 'application_outcomes', job_id FROM application_outcomes
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(stable_id)) * 6,
    ).fetchall()
    assert {row["relation"]: row["job_id"] for row in dependent_rows} == {
        "job_scores": str(stable_id),
        "job_stage_states": str(stable_id),
        "preparation_work_items": str(stable_id),
        "job_artifacts": str(stable_id),
        "job_events": str(stable_id),
        "application_outcomes": str(stable_id),
    }
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert by_original_url is not None
    loaded_by_original_url = repo.load(LOCAL_TENANT, by_original_url.job_id)
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


def test_explicit_locator_resolution_returns_none_for_unknown(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    assert repo.resolve_by_posting_url(LOCAL_TENANT, PostingUrl(value="https://nope/")) is None


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
    identity = repo.resolve_by_posting_url(
        LOCAL_TENANT,
        PostingUrl(value="https://example.com/jobs/1"),
    )
    assert identity is not None
    owner = repo.load(LOCAL_TENANT, identity.job_id)
    assert owner is not None
    assert owner.metadata.title == "Senior Engineer"


def test_list_recent_orders_by_discovered_at_desc(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    older = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("236e953a-4d76-5659-bd18-b8a75f2b46f7"),
        posting_url=PostingUrl(value="https://example.com/old"),
        source=Source(board="greenhouse"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.MANUAL,
        metadata=JobMetadata(title="Older"),
        discovered_at="2026-04-01T00:00:00+00:00",
    )
    newer = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("e0d3c715-6368-592f-88ee-5f0b94ef395c"),
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
        _make_job("https://example.com/a").job_id,
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
            JobId("c726db63-04d4-4de5-a4e8-c1d6ebfe6090"),
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


def test_restore_is_noop_for_undeleted_job(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _make_job()
    repo.save(job)
    restored = repo.restore(LOCAL_TENANT, job.job_id)
    assert restored is not None
    assert restored.is_deleted is False
