from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchSpec
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
    SqliteDiscoverySearchUnitRepository,
)


def _execution() -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="temporal-run-1",
    )


def _spec() -> DiscoverySearchSpec:
    return DiscoverySearchSpec(
        query="Director of Engineering",
        provider_location="Barcelona, Spain",
        target_location="Barcelona, Spain",
        sites=("indeed",),
        results_per_site=25,
        hours_old=72,
        remote_only=True,
        country_indeed="spain",
        linkedin_fetch_description=True,
        match_mode="recall",
        target_track="engineering_leadership",
        seniority_floor="director",
        accept_locations=("Barcelona, Spain", "Europe"),
        reject_locations=("United States",),
        local_accept_locations=("Barcelona, Spain",),
    )


@pytest.fixture
def search_db(tmp_path: Path):
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        yield conn
    finally:
        close_connection(db_path)


def test_repository_construction_does_not_mutate_exact_v7_schema(search_db) -> None:
    schema_version = search_db.execute("PRAGMA schema_version").fetchone()[0]
    total_changes = search_db.total_changes

    SqliteDiscoverySearchUnitRepository(search_db)

    assert search_db.execute("PRAGMA schema_version").fetchone()[0] == schema_version
    assert search_db.total_changes == total_changes


def test_accepted_receipts_use_canonical_job_id(search_db) -> None:
    job_id = JobId("498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6")
    posting_url = "https://example.test/jobs/accepted"
    search_db.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, salary, description, location, site, strategy
        ) VALUES ('local', ?, ?, 'Director of Engineering', '', '', '', 'indeed', 'jobspy')
        """,
        (str(job_id), posting_url),
    )
    search_db.commit()
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec()])
    lease = repository.claim_next(execution, "attempt-1", 1)
    assert lease is not None

    repository.record_accepted_job(
        lease,
        job_id,
        was_new=True,
        accepted_at="2026-07-30T10:00:00+00:00",
    )
    repository.record_accepted_job(
        lease,
        job_id,
        was_new=False,
        accepted_at="2026-07-30T10:01:00+00:00",
    )

    unit = repository.get_unit(execution, lease.unit_id)
    assert unit is not None
    assert unit.accepted_jobs == 1
    assert unit.new_jobs == 1
    receipt = search_db.execute(
        "SELECT job_id, was_new FROM discovery_search_unit_jobs"
    ).fetchone()
    assert tuple(receipt) == (str(job_id), 1)


def test_accepted_receipts_reject_url_shaped_identity(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec()])
    lease = repository.claim_next(execution, "attempt-1", 1)
    assert lease is not None

    with pytest.raises(ValueError, match="canonical UUID"):
        repository.record_accepted_job(
            lease,
            JobId("https://example.test/jobs/not-an-id"),
            was_new=True,
        )

    assert search_db.execute(
        "SELECT COUNT(*) FROM discovery_search_unit_jobs"
    ).fetchone()[0] == 0
