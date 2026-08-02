from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.discovery.sqlite_execution_repository import (
    SqliteDiscoveryExecutionRepository,
)


@pytest.fixture
def execution_db(tmp_path: Path):
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        yield conn
    finally:
        close_connection(db_path)


def _execution(*, tenant_id: str = "local") -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id=tenant_id,
        workflow_id=f"discover-{tenant_id}",
        temporal_run_id="temporal-run-1",
    )


def _insert_job(
    conn,
    job_id: JobId,
    *,
    tenant_id: str = "local",
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title)
        VALUES (?, ?, ?, 'Director of Engineering')
        """,
        (
            tenant_id,
            str(job_id),
            f"https://example.test/{tenant_id}/jobs/{job_id}",
        ),
    )
    conn.commit()


def test_repository_construction_does_not_mutate_exact_v7_schema(
    execution_db,
) -> None:
    schema_version = execution_db.execute("PRAGMA schema_version").fetchone()[0]
    total_changes = execution_db.total_changes

    SqliteDiscoveryExecutionRepository(execution_db)

    assert execution_db.execute("PRAGMA schema_version").fetchone()[0] == schema_version
    assert execution_db.total_changes == total_changes


def test_execution_membership_is_tenant_scoped_and_keyed_by_job_id(
    execution_db,
) -> None:
    job_id = JobId("498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6")
    _insert_job(execution_db, job_id)
    repository = SqliteDiscoveryExecutionRepository(execution_db)
    execution = _execution()

    linked = repository.link_job(
        execution,
        job_id,
        cohort_kind="observed_this_run",
        source_family="jobspy",
        source_run_id="source-run-1",
        linked_at="2026-07-30T10:00:00+00:00",
    )

    assert linked.job_id == job_id
    assert linked.execution == execution
    assert linked.source_run_id == "source-run-1"
    row = execution_db.execute(
        """
        SELECT tenant_id, job_id
        FROM discovery_execution_jobs
        WHERE discover_workflow_id = ?
          AND discover_run_id = ?
        """,
        (execution.workflow_id, execution.temporal_run_id),
    ).fetchone()
    assert tuple(row) == ("local", str(job_id))


def test_execution_membership_rejects_url_shaped_and_unknown_identity(
    execution_db,
) -> None:
    repository = SqliteDiscoveryExecutionRepository(execution_db)
    execution = _execution()

    with pytest.raises(ValueError, match="canonical UUID"):
        repository.link_job(
            execution,
            JobId("https://example.test/jobs/not-an-id"),
            cohort_kind="existing_backlog",
        )

    with pytest.raises(KeyError, match="No stable Job identity"):
        repository.link_job(
            execution,
            JobId("498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6"),
            cohort_kind="existing_backlog",
        )

    assert execution_db.execute(
        "SELECT COUNT(*) FROM discovery_execution_jobs"
    ).fetchone()[0] == 0


@pytest.mark.parametrize(
    "job_id",
    [
        JobId(" 498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6"),
        JobId("498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6 "),
    ],
)
def test_execution_membership_rejects_whitespace_wrapped_identity(
    execution_db,
    job_id: JobId,
) -> None:
    repository = SqliteDiscoveryExecutionRepository(execution_db)

    with pytest.raises(ValueError, match="canonical UUID"):
        repository.link_job(
            _execution(),
            job_id,
            cohort_kind="existing_backlog",
        )

    assert execution_db.execute(
        "SELECT COUNT(*) FROM discovery_execution_jobs"
    ).fetchone()[0] == 0


def test_execution_membership_cannot_cross_tenants(execution_db) -> None:
    job_id = JobId("498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6")
    _insert_job(execution_db, job_id, tenant_id="tenant-a")
    repository = SqliteDiscoveryExecutionRepository(execution_db)

    with pytest.raises(KeyError, match="No stable Job identity"):
        repository.link_job(
            _execution(tenant_id="tenant-b"),
            job_id,
            cohort_kind="existing_backlog",
        )

    assert execution_db.execute(
        "SELECT COUNT(*) FROM discovery_execution_jobs"
    ).fetchone()[0] == 0


def test_work_plan_retry_is_exact_and_memberships_order_by_job_id(
    execution_db,
) -> None:
    first_id = JobId("00000000-0000-4000-8000-000000000001")
    second_id = JobId("00000000-0000-4000-8000-000000000002")
    _insert_job(execution_db, second_id)
    _insert_job(execution_db, first_id)
    repository = SqliteDiscoveryExecutionRepository(execution_db)
    execution = _execution()
    repository.link_job(
        execution,
        second_id,
        cohort_kind="existing_backlog",
    )
    repository.link_job(
        execution,
        first_id,
        cohort_kind="existing_backlog",
    )

    planned = repository.set_work_plan(
        execution,
        first_id,
        state="planned",
        required_steps=["score", "tailor"],
        preparation_workflow_id="prep-first",
    )
    replay = repository.set_work_plan(
        execution,
        first_id,
        state="planned",
        required_steps=["score", "tailor"],
        preparation_workflow_id="prep-first",
    )

    assert replay == planned
    assert planned.required_steps == ("score", "tailor")
    assert [
        membership.job_id
        for membership in repository.list_for_execution(execution)
    ] == [first_id, second_id]
    with pytest.raises(ValueError, match="immutable"):
        repository.set_work_plan(
            execution,
            first_id,
            state="planned",
            required_steps=["score"],
            preparation_workflow_id="prep-first",
        )
