"""Schema-v8 discovery identity-reference migration contracts."""

from __future__ import annotations

import shutil
import sqlite3
import uuid
from pathlib import Path

import pytest

from jobctrl.database import (
    SCHEMA_VERSION,
    _assert_schema_version_supported,
    close_connection,
    init_db,
)
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


PREVIOUS_SCHEMA_VERSION = 7
REFERENCE_TABLES = (
    "job_source_observations",
    "job_canonical_identities",
    "job_duplicate_links",
    "job_rejected_duplicate_links",
)


def _downgrade_discovery_references_to_v7(conn: sqlite3.Connection) -> None:
    for table in reversed(REFERENCE_TABLES):
        conn.execute(f'DROP TABLE "{table}"')
    conn.executescript(
        """
        CREATE TABLE job_source_observations (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            source_observation_id    TEXT NOT NULL,
            job_url                  TEXT NOT NULL,
            source_id                TEXT NOT NULL,
            source_native_id         TEXT NOT NULL,
            observed_url             TEXT NOT NULL,
            normalized_observed_url  TEXT NOT NULL,
            run_id                   TEXT NOT NULL DEFAULT '',
            observed_at              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_observation_id),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_job_source_observations_native
            ON job_source_observations(
                tenant_id, source_id, source_native_id
            );
        CREATE UNIQUE INDEX idx_job_source_observations_normalized_url
            ON job_source_observations(
                tenant_id, normalized_observed_url
            );
        CREATE INDEX idx_job_source_observations_job
            ON job_source_observations(tenant_id, job_url);

        CREATE TABLE job_canonical_identities (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_url            TEXT NOT NULL,
            canonical_url      TEXT NOT NULL,
            ats_kind           TEXT NOT NULL,
            source_native_id   TEXT NOT NULL,
            confidence         REAL NOT NULL,
            resolved_at        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_canonical_identities_canonical_url
            ON job_canonical_identities(tenant_id, canonical_url);

        CREATE TABLE job_duplicate_links (
            tenant_id                        TEXT NOT NULL DEFAULT 'local',
            duplicate_link_id                TEXT NOT NULL,
            surviving_job_id                 TEXT NOT NULL,
            superseded_job_or_observation_id TEXT NOT NULL,
            reason                           TEXT NOT NULL,
            confidence                       REAL NOT NULL,
            linked_at                        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, duplicate_link_id)
        );
        CREATE INDEX idx_job_duplicate_links_surviving
            ON job_duplicate_links(tenant_id, surviving_job_id);

        CREATE TABLE job_rejected_duplicate_links (
            tenant_id     TEXT NOT NULL DEFAULT 'local',
            owner_job_url TEXT NOT NULL,
            candidate_url TEXT NOT NULL,
            reason        TEXT NOT NULL,
            rejected_at   TEXT NOT NULL,
            PRIMARY KEY (tenant_id, owner_job_url, candidate_url)
        );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _user_version(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def _columns(db_path: Path, table: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        return {
            str(row[1])
            for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
        }
    finally:
        conn.close()


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="Example"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-28T10:00:00+00:00",
    )


def test_v7_discovery_references_migrate_to_stable_job_id_and_reopen(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    pre_upgrade = tmp_path / "jobctrl-v7.db"
    conn = init_db(db_path)
    job_id = str(uuid.uuid4())
    storage_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform-engineer"
    observed_url = "https://aggregator.example/view/123?ref=feed"
    normalized_observed_url = "https://aggregator.example/view/123"
    candidate_url = "https://another.example/jobs/duplicate"
    stable_job_id = JobId(job_id)
    repository = SqliteJobRepository(conn)
    repository.save(_discovered_job(storage_url, stable_job_id))
    repository.save(_discovered_job(current_url, stable_job_id))
    aliases = conn.execute(
        """
        SELECT alias_value, retired_at
        FROM job_identity_aliases
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (job_id,),
    ).fetchall()
    assert {str(row[0]): row[1] is None for row in aliases} == {
        storage_url: False,
        current_url: True,
    }
    _downgrade_discovery_references_to_v7(conn)
    conn.execute(
        """
        INSERT INTO job_source_observations (
            tenant_id, source_observation_id, job_url, source_id,
            source_native_id, observed_url, normalized_observed_url,
            run_id, observed_at
        ) VALUES ('local', 'obs-1', ?, 'feed:example', 'native-123', ?, ?,
                  'discover-run', '2026-07-28T10:01:00+00:00')
        """,
        (storage_url, observed_url, normalized_observed_url),
    )
    conn.execute(
        """
        INSERT INTO job_canonical_identities (
            tenant_id, job_url, canonical_url, ats_kind, source_native_id,
            confidence, resolved_at
        ) VALUES ('local', ?, ?, 'greenhouse', 'native-123', 0.98,
                  '2026-07-28T10:02:00+00:00')
        """,
        (storage_url, current_url),
    )
    conn.execute(
        """
        INSERT INTO job_duplicate_links (
            tenant_id, duplicate_link_id, surviving_job_id,
            superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES ('local', 'dup-1', ?, 'obs-duplicate',
                  'canonical_url_match', 0.95,
                  '2026-07-28T10:03:00+00:00')
        """,
        (current_url,),
    )
    conn.execute(
        """
        INSERT INTO job_rejected_duplicate_links (
            tenant_id, owner_job_url, candidate_url, reason, rejected_at
        ) VALUES ('local', ?, ?, 'employer_mismatch',
                  '2026-07-28T10:04:00+00:00')
        """,
        (current_url, candidate_url),
    )
    conn.commit()
    before_counts = {
        table: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in REFERENCE_TABLES
    }
    close_connection(db_path)
    shutil.copy2(db_path, pre_upgrade)

    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION == 17
    assert "job_id" in _columns(db_path, "job_source_observations")
    assert "job_url" not in _columns(db_path, "job_source_observations")
    assert "job_id" in _columns(db_path, "job_canonical_identities")
    assert "job_url" not in _columns(db_path, "job_canonical_identities")
    assert "owner_job_id" in _columns(
        db_path,
        "job_rejected_duplicate_links",
    )
    assert "owner_job_url" not in _columns(
        db_path,
        "job_rejected_duplicate_links",
    )

    check = sqlite3.connect(db_path)
    check.row_factory = sqlite3.Row
    try:
        after_counts = {
            table: int(
                check.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            )
            for table in REFERENCE_TABLES
        }
        assert after_counts == before_counts
        observation = check.execute(
            """
            SELECT job_id, observed_url, normalized_observed_url
            FROM job_source_observations
            """
        ).fetchone()
        canonical = check.execute(
            """
            SELECT job_id, canonical_url
            FROM job_canonical_identities
            """
        ).fetchone()
        duplicate = check.execute(
            """
            SELECT surviving_job_id, superseded_job_or_observation_id
            FROM job_duplicate_links
            """
        ).fetchone()
        rejected = check.execute(
            """
            SELECT owner_job_id, candidate_url
            FROM job_rejected_duplicate_links
            """
        ).fetchone()
        assert tuple(observation) == (
            job_id,
            observed_url,
            normalized_observed_url,
        )
        assert tuple(canonical) == (job_id, current_url)
        assert tuple(duplicate) == (job_id, "obs-duplicate")
        assert tuple(rejected) == (job_id, candidate_url)
        assert check.execute("PRAGMA foreign_key_check").fetchone() is None
    finally:
        check.close()

    first_check = sqlite3.connect(db_path)
    try:
        first_rows = first_check.execute(
            """
            SELECT job_id, observed_url
            FROM job_source_observations
            """
        ).fetchall()
    finally:
        first_check.close()
    init_db(db_path)
    close_connection(db_path)
    reopened = sqlite3.connect(db_path)
    try:
        assert (
            reopened.execute(
                """
                SELECT job_id, observed_url
                FROM job_source_observations
                """
            ).fetchall()
            == first_rows
        )
    finally:
        reopened.close()

    previous = sqlite3.connect(pre_upgrade)
    try:
        assert (
            _assert_schema_version_supported(
                previous,
                supported_version=PREVIOUS_SCHEMA_VERSION,
            )
            == PREVIOUS_SCHEMA_VERSION
        )
        assert "job_url" in {
            str(row[1])
            for row in previous.execute(
                "PRAGMA table_info(job_source_observations)"
            ).fetchall()
        }
    finally:
        previous.close()


def test_unresolved_v7_reference_rolls_back_and_remains_retryable(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = str(uuid.uuid4())
    job_url = "https://example.com/jobs/valid"
    conn.execute(
        """
        INSERT INTO jobs (url, tenant_id, job_id, title)
        VALUES (?, 'local', ?, 'Engineer')
        """,
        (job_url, job_id),
    )
    conn.commit()
    _downgrade_discovery_references_to_v7(conn)
    conn.execute(
        """
        INSERT INTO job_duplicate_links (
            tenant_id, duplicate_link_id, surviving_job_id,
            superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES ('local', 'dup-orphan', 'https://example.com/jobs/missing',
                  'obs-missing', 'canonical_url_match', 0.9,
                  '2026-07-28T10:00:00+00:00')
        """
    )
    conn.commit()
    close_connection(db_path)

    with pytest.raises(
        RuntimeError,
        match="could not resolve job_duplicate_links.surviving_job_id",
    ):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == PREVIOUS_SCHEMA_VERSION
    assert "job_url" in _columns(db_path, "job_source_observations")
    check = sqlite3.connect(db_path)
    try:
        row = check.execute(
            """
            SELECT surviving_job_id
            FROM job_duplicate_links
            WHERE duplicate_link_id = 'dup-orphan'
            """
        ).fetchone()
        assert row == ("https://example.com/jobs/missing",)
        assert (
            check.execute(
                "SELECT COUNT(*) FROM job_source_observations"
            ).fetchone()[0]
            == 0
        )
        assert not check.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%_v8'
            """
        ).fetchall()
        check.execute(
            """
            UPDATE job_duplicate_links
            SET surviving_job_id = ?
            WHERE duplicate_link_id = 'dup-orphan'
            """,
            (job_url,),
        )
        check.commit()
    finally:
        check.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    migrated = sqlite3.connect(db_path)
    try:
        assert migrated.execute(
            """
            SELECT surviving_job_id
            FROM job_duplicate_links
            WHERE duplicate_link_id = 'dup-orphan'
            """
        ).fetchone() == (job_id,)
        assert migrated.execute(
            """
            SELECT job_id, observed_url, run_id
            FROM job_source_observations
            """
        ).fetchone() == (job_id, job_url, "backfill")
    finally:
        migrated.close()
