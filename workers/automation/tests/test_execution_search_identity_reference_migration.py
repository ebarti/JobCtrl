"""Schema-v9 execution and accepted-search-receipt migration contracts."""

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
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchUnitLease
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
    SqliteDiscoverySearchUnitRepository,
)


PREVIOUS_SCHEMA_VERSION = 8
REFERENCE_TABLES = (
    "discovery_execution_jobs",
    "discovery_search_unit_jobs",
)


def _downgrade_execution_search_references_to_v8(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE discovery_search_unit_jobs")
    conn.execute("DROP TABLE discovery_execution_jobs")
    conn.executescript(
        """
        CREATE TABLE discovery_execution_jobs (
            tenant_id                TEXT NOT NULL,
            discover_workflow_id     TEXT NOT NULL,
            discover_run_id          TEXT NOT NULL,
            job_url                  TEXT NOT NULL,
            cohort_kind              TEXT NOT NULL
                CHECK (cohort_kind IN (
                    'observed_this_run', 'existing_backlog'
                )),
            source_family            TEXT,
            source_run_id            TEXT,
            preparation_workflow_id  TEXT,
            work_plan_state          TEXT NOT NULL DEFAULT 'pending'
                CHECK (work_plan_state IN (
                    'pending', 'planned', 'not_eligible', 'failed'
                )),
            required_steps_json      TEXT,
            work_plan_reason         TEXT,
            linked_at                TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, job_url
            ),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_discovery_execution_jobs_cohort
            ON discovery_execution_jobs(
                tenant_id, discover_workflow_id, discover_run_id, cohort_kind
            );
        CREATE INDEX idx_discovery_execution_jobs_plan
            ON discovery_execution_jobs(
                tenant_id, discover_workflow_id, discover_run_id,
                work_plan_state
            );
        CREATE INDEX idx_discovery_execution_jobs_job
            ON discovery_execution_jobs(tenant_id, job_url, linked_at);

        CREATE TABLE discovery_search_unit_jobs (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            job_url                TEXT NOT NULL,
            was_new                INTEGER NOT NULL CHECK (was_new IN (0, 1)),
            accepted_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id,
                unit_id, job_url
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE,
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_discovery_search_unit_jobs_execution
            ON discovery_search_unit_jobs(
                tenant_id, discover_workflow_id, discover_run_id, was_new
            );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="Example"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-29T10:00:00+00:00",
    )


def _user_version(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def _columns(db_path: Path, table: str) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}
    finally:
        conn.close()


def _insert_search_unit(
    conn: sqlite3.Connection,
    *,
    workflow_id: str,
    run_id: str,
    unit_id: str,
) -> None:
    conn.execute(
        """
        INSERT INTO discovery_search_units (
            tenant_id, discover_workflow_id, discover_run_id, unit_id,
            ordinal, request_json, request_fingerprint, state,
            created_at, updated_at
        ) VALUES (
            'local', ?, ?, ?, 0, '{}', 'fixture-fingerprint', 'completed',
            '2026-07-29T10:00:00+00:00',
            '2026-07-29T10:05:00+00:00'
        )
        """,
        (workflow_id, run_id, unit_id),
    )


def test_v8_execution_and_receipts_migrate_to_stable_job_id_and_reopen(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    pre_upgrade = tmp_path / "jobctrl-v8.db"
    conn = init_db(db_path)
    job_id = str(uuid.uuid4())
    storage_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform-engineer"
    repository = SqliteJobRepository(conn)
    repository.save(_discovered_job(storage_url, JobId(job_id)))
    repository.save(_discovered_job(current_url, JobId(job_id)))
    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner_job_id = JobId(str(uuid.uuid4()))
    repository.save(_discovered_job(uuid_shaped_url, uuid_url_owner_job_id))
    repository.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )
    _downgrade_execution_search_references_to_v8(conn)

    workflow_id = "discover-local"
    run_id = "temporal-run-1"
    unit_id = "unit-1"
    _insert_search_unit(
        conn,
        workflow_id=workflow_id,
        run_id=run_id,
        unit_id=unit_id,
    )
    conn.execute(
        """
        INSERT INTO discovery_execution_jobs (
            tenant_id, discover_workflow_id, discover_run_id, job_url,
            cohort_kind, source_family, source_run_id,
            preparation_workflow_id, work_plan_state,
            required_steps_json, work_plan_reason, linked_at
        ) VALUES (
            'local', ?, ?, ?, 'observed_this_run', 'greenhouse',
            'source-run-1', 'prepare-job-1', 'planned',
            '["enrich","score"]', 'selected_for_preparation',
            '2026-07-29T10:01:00+00:00'
        )
        """,
        (workflow_id, run_id, current_url),
    )
    conn.execute(
        """
        INSERT INTO discovery_search_unit_jobs (
            tenant_id, discover_workflow_id, discover_run_id,
            unit_id, job_url, was_new, accepted_at
        ) VALUES (
            'local', ?, ?, ?, ?, 1, '2026-07-29T10:02:00+00:00'
        )
        """,
        (workflow_id, run_id, unit_id, storage_url),
    )
    conn.execute(
        """
        INSERT INTO discovery_execution_jobs (
            tenant_id, discover_workflow_id, discover_run_id, job_url,
            cohort_kind, source_family, source_run_id,
            work_plan_state, linked_at
        ) VALUES (
            'local', ?, ?, ?, 'observed_this_run', 'synthetic',
            'source-run-uuid-url', 'pending',
            '2026-07-29T10:03:00+00:00'
        )
        """,
        (workflow_id, run_id, uuid_shaped_url),
    )
    conn.execute(
        """
        INSERT INTO discovery_search_unit_jobs (
            tenant_id, discover_workflow_id, discover_run_id,
            unit_id, job_url, was_new, accepted_at
        ) VALUES (
            'local', ?, ?, ?, ?, 0, '2026-07-29T10:04:00+00:00'
        )
        """,
        (workflow_id, run_id, unit_id, uuid_shaped_url),
    )
    conn.commit()
    before_counts = {
        table: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in REFERENCE_TABLES
    }
    close_connection(db_path)
    shutil.copy2(db_path, pre_upgrade)

    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION == 10
    assert "job_id" in _columns(db_path, "discovery_execution_jobs")
    assert "job_url" not in _columns(db_path, "discovery_execution_jobs")
    assert "job_id" in _columns(db_path, "discovery_search_unit_jobs")
    assert "job_url" not in _columns(db_path, "discovery_search_unit_jobs")

    check = sqlite3.connect(db_path)
    try:
        after_counts = {
            table: int(check.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in REFERENCE_TABLES
        }
        assert after_counts == before_counts
        assert check.execute(
            """
            SELECT job_id, cohort_kind, source_family, source_run_id,
                   preparation_workflow_id, work_plan_state,
                   required_steps_json, work_plan_reason, linked_at
            FROM discovery_execution_jobs
            WHERE source_run_id = 'source-run-1'
            """
        ).fetchone() == (
            job_id,
            "observed_this_run",
            "greenhouse",
            "source-run-1",
            "prepare-job-1",
            "planned",
            '["enrich","score"]',
            "selected_for_preparation",
            "2026-07-29T10:01:00+00:00",
        )
        assert check.execute(
            """
            SELECT job_id
            FROM discovery_execution_jobs
            WHERE source_run_id = 'source-run-uuid-url'
            """
        ).fetchone() == (str(uuid_url_owner_job_id),)
        assert check.execute(
            """
            SELECT job_id, was_new, accepted_at
            FROM discovery_search_unit_jobs
            WHERE accepted_at = '2026-07-29T10:02:00+00:00'
            """
        ).fetchone() == (
            job_id,
            1,
            "2026-07-29T10:02:00+00:00",
        )
        assert check.execute(
            """
            SELECT job_id
            FROM discovery_search_unit_jobs
            WHERE accepted_at = '2026-07-29T10:04:00+00:00'
            """
        ).fetchone() == (str(uuid_url_owner_job_id),)
        assert check.execute("PRAGMA foreign_key_check").fetchone() is None
    finally:
        check.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION

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
            str(row[1]) for row in previous.execute("PRAGMA table_info(discovery_execution_jobs)").fetchall()
        }
        assert "job_url" in {
            str(row[1]) for row in previous.execute("PRAGMA table_info(discovery_search_unit_jobs)").fetchall()
        }
    finally:
        previous.close()


def test_unresolved_v8_receipt_rolls_back_and_remains_retryable(
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
    _downgrade_execution_search_references_to_v8(conn)
    _insert_search_unit(
        conn,
        workflow_id="discover-local",
        run_id="temporal-run-1",
        unit_id="unit-1",
    )
    conn.execute(
        """
        INSERT INTO discovery_search_unit_jobs (
            tenant_id, discover_workflow_id, discover_run_id,
            unit_id, job_url, was_new, accepted_at
        ) VALUES (
            'local', 'discover-local', 'temporal-run-1', 'unit-1',
            'https://example.com/jobs/missing', 0,
            '2026-07-29T10:02:00+00:00'
        )
        """
    )
    conn.commit()
    close_connection(db_path)

    with pytest.raises(
        RuntimeError,
        match="could not resolve discovery_search_unit_jobs.job_url",
    ):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == PREVIOUS_SCHEMA_VERSION
    assert "job_url" in _columns(db_path, "discovery_execution_jobs")
    assert "job_url" in _columns(db_path, "discovery_search_unit_jobs")
    check = sqlite3.connect(db_path)
    try:
        assert check.execute("SELECT COUNT(*) FROM discovery_search_unit_jobs").fetchone()[0] == 1
        assert not check.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%_v9'
            """
        ).fetchall()
        check.execute(
            """
            UPDATE discovery_search_unit_jobs
            SET job_url = ?
            WHERE unit_id = 'unit-1'
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
            SELECT job_id
            FROM discovery_search_unit_jobs
            WHERE unit_id = 'unit-1'
            """
        ).fetchone() == (job_id,)
    finally:
        migrated.close()


def test_live_writes_prefer_uuid_shaped_posting_url_over_same_text_job_id(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    uuid_shaped_url = str(uuid.uuid4())
    url_owner_job_id = JobId(str(uuid.uuid4()))
    repository = SqliteJobRepository(conn)
    repository.save(_discovered_job(uuid_shaped_url, url_owner_job_id))
    repository.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )
    execution = DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="temporal-run-uuid-url",
    )

    execution_repository = SqliteDiscoveryExecutionRepository(conn)
    execution_repository.link_job(
        execution,
        uuid_shaped_url,
        cohort_kind="existing_backlog",
        linked_at="2026-07-29T11:00:00+00:00",
    )
    assert conn.execute(
        """
        SELECT job_id
        FROM discovery_execution_jobs
        WHERE discover_run_id = ?
        """,
        (execution.temporal_run_id,),
    ).fetchone()[0] == str(url_owner_job_id)
    membership = execution_repository.get(execution, uuid_shaped_url)
    assert membership is not None
    assert membership.job_url == uuid_shaped_url

    _insert_search_unit(
        conn,
        workflow_id=execution.workflow_id,
        run_id=execution.temporal_run_id,
        unit_id="search-0000-0123456789abcdef",
    )
    conn.execute(
        """
        UPDATE discovery_search_units
        SET state = 'running',
            lease_owner = 'attempt-1',
            lease_attempt = 1,
            lease_epoch = 1
        WHERE discover_run_id = ?
          AND unit_id = 'search-0000-0123456789abcdef'
        """,
        (execution.temporal_run_id,),
    )
    lease = DiscoverySearchUnitLease(
        execution=execution,
        unit_id="search-0000-0123456789abcdef",
        owner_token="attempt-1",
        attempt=1,
        epoch=1,
    )
    SqliteDiscoverySearchUnitRepository(conn).record_accepted_job(
        lease,
        uuid_shaped_url,
        was_new=True,
        accepted_at="2026-07-29T11:01:00+00:00",
    )
    assert conn.execute(
        """
        SELECT job_id
        FROM discovery_search_unit_jobs
        WHERE discover_run_id = ?
        """,
        (execution.temporal_run_id,),
    ).fetchone()[0] == str(url_owner_job_id)
