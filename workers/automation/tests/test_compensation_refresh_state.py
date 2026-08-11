from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.compensation import BenchmarkGeography, build_direct_benchmark_fact
from jobctrl.infrastructure.compensation.refresh_state import (
    SqliteCompensationRefreshStateRepository,
    StaleCompensationRefreshLease,
)
from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import (
    SqliteCompensationBenchmarkRepository,
)


def test_discovers_unique_active_country_role_slices(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(
            conn,
            job_id="11111111-1111-4111-8111-111111111111",
            title="Senior Platform Engineer",
            location="Madrid, Spain",
        )
        _insert_job(
            conn,
            job_id="22222222-2222-4222-8222-222222222222",
            title="Senior Platform Engineer",
            location="Barcelona, Spain",
        )
        _insert_job(
            conn,
            job_id="33333333-3333-4333-8333-333333333333",
            title="Unmapped Wizard",
            location="Berlin, Germany",
        )
        _insert_job(
            conn,
            job_id="44444444-4444-4444-8444-444444444444",
            title="Senior Data Engineer",
            location="Remote",
        )
        _insert_job(
            conn,
            job_id="55555555-5555-4555-8555-555555555555",
            title="Senior Data Engineer",
            location="Berlin, Germany",
            is_deleted=1,
        )
        conn.commit()

        result = SqliteCompensationRefreshStateRepository(conn).discover_active_job_slices("local")

        assert result.jobs_considered == 4
        assert result.jobs_without_role_family == 1
        assert result.jobs_without_country == 1
        assert len(result.slices) == 1
        benchmark_slice = result.slices[0]
        assert benchmark_slice.role_family_code == "infrastructure_platform"
        assert benchmark_slice.seniority_label == "senior"
        assert benchmark_slice.geography.country_code == "ES"
        assert benchmark_slice.geography.scope == "country"
    finally:
        close_connection(db_path)


def test_due_claims_are_leased_and_refresh_on_the_seven_day_boundary(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteCompensationRefreshStateRepository(conn)
    try:
        _insert_job(
            conn,
            job_id="11111111-1111-4111-8111-111111111111",
            title="Senior Platform Engineer",
            location="Madrid, Spain",
        )
        conn.commit()
        benchmark_slice = repository.discover_active_job_slices("local").slices[0]
        now = "2026-08-12T08:00:00Z"
        repository.ensure_slices((benchmark_slice,), now=now)

        first_leases = repository.claim_due(
            (benchmark_slice,),
            owner="run-1:attempt-1",
            now=now,
            lease_expires_at="2026-08-12T09:00:00Z",
        )
        assert len(first_leases) == 1
        first_lease = first_leases[0]
        assert first_lease.benchmark_slice == benchmark_slice
        assert (
            repository.claim_due(
                (benchmark_slice,),
                owner="run-1:attempt-1",
                now="2026-08-12T08:01:00Z",
                lease_expires_at="2026-08-12T09:01:00Z",
            )
            == ()
        )

        repository.mark_insufficient(
            first_lease,
            completed_at="2026-08-12T08:02:00Z",
            next_refresh_at="2026-08-19T08:02:00Z",
            error_code="no_direct_anchor",
        )
        state = repository.get(benchmark_slice)
        assert state is not None
        assert state.refresh_status == "insufficient_evidence"
        assert state.attempt_count == 1
        assert state.lease_owner is None
        assert (
            repository.claim_due(
                (benchmark_slice,),
                owner="run-2:attempt-1",
                now="2026-08-19T08:01:59Z",
                lease_expires_at="2026-08-19T09:01:59Z",
            )
            == ()
        )
        refreshed_leases = repository.claim_due(
            (benchmark_slice,),
            owner="run-2:attempt-1",
            now="2026-08-19T08:02:00Z",
            lease_expires_at="2026-08-19T09:02:00Z",
        )
        assert tuple(lease.benchmark_slice for lease in refreshed_leases) == (benchmark_slice,)
    finally:
        close_connection(db_path)


def test_expired_lease_cannot_publish_a_refresh_result(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteCompensationRefreshStateRepository(conn)
    try:
        _insert_job(
            conn,
            job_id="11111111-1111-4111-8111-111111111111",
            title="Senior Platform Engineer",
            location="Madrid, Spain",
        )
        conn.commit()
        benchmark_slice = repository.discover_active_job_slices("local").slices[0]
        repository.ensure_slices(
            (benchmark_slice,),
            now="2026-08-12T08:00:00Z",
        )
        lease = repository.claim_due(
            (benchmark_slice,),
            owner="run-1:attempt-1",
            now="2026-08-12T08:00:00Z",
            lease_expires_at="2026-08-12T08:05:00Z",
        )[0]

        with pytest.raises(StaleCompensationRefreshLease):
            repository.mark_failed(
                lease,
                completed_at="2026-08-12T08:05:00Z",
                retry_at="2026-08-12T08:05:00Z",
                error_code="source_unavailable",
            )
    finally:
        close_connection(db_path)


def test_stale_token_cannot_publish_after_same_owner_reclaims_expired_lease(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteCompensationRefreshStateRepository(conn)
    try:
        _insert_job(
            conn,
            job_id="11111111-1111-4111-8111-111111111111",
            title="Senior Platform Engineer",
            location="Madrid, Spain",
        )
        conn.commit()
        benchmark_slice = repository.discover_active_job_slices("local").slices[0]
        repository.ensure_slices((benchmark_slice,), now="2026-08-12T08:00:00Z")
        first = repository.claim_due(
            (benchmark_slice,),
            owner="stable-worker",
            now="2026-08-12T08:00:00Z",
            lease_expires_at="2026-08-12T08:05:00Z",
        )[0]
        assert (
            repository.claim_due(
                (benchmark_slice,),
                owner="stable-worker",
                now="2026-08-12T08:01:00Z",
                lease_expires_at="2026-08-12T08:06:00Z",
            )
            == ()
        )
        second = repository.claim_due(
            (benchmark_slice,),
            owner="stable-worker",
            now="2026-08-12T08:05:00Z",
            lease_expires_at="2026-08-12T08:10:00Z",
        )[0]
        assert first.token != second.token

        with pytest.raises(StaleCompensationRefreshLease):
            repository.mark_insufficient(
                first,
                completed_at="2026-08-12T08:05:30Z",
                next_refresh_at="2026-08-19T08:05:30Z",
                error_code="no_direct_anchor",
            )

        state = repository.get(benchmark_slice)
        assert state is not None
        assert state.lease_owner == second.token
    finally:
        close_connection(db_path)


def test_refresh_state_rejects_a_result_from_another_geography(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    state_repository = SqliteCompensationRefreshStateRepository(conn)
    try:
        _insert_job(
            conn,
            job_id="11111111-1111-4111-8111-111111111111",
            title="Senior Software Engineer",
            location="Madrid, Spain",
        )
        conn.commit()
        benchmark_slice = state_repository.discover_active_job_slices("local").slices[0]
        state_repository.ensure_slices((benchmark_slice,), now="2026-08-12T08:00:00Z")
        lease = state_repository.claim_due(
            (benchmark_slice,),
            owner="run-1",
            now="2026-08-12T08:00:00Z",
            lease_expires_at="2026-08-12T09:00:00Z",
        )[0]
        wrong_country = SqliteCompensationBenchmarkRepository(conn).save_direct(
            build_direct_benchmark_fact(
                tenant_id="local",
                role_family_code=benchmark_slice.role_family_code,
                seniority_label=benchmark_slice.seniority_label,
                geography=BenchmarkGeography("DE"),
                market_scope="market",
                normalized_company=None,
                component="total_compensation",
                original_currency="EUR",
                original_period="year",
                original_minimum_amount=80_000,
                original_maximum_amount=100_000,
                eur_annual_minimum_amount=80_000,
                eur_annual_maximum_amount=100_000,
                confidence_interval_minimum_amount=72_000,
                confidence_interval_maximum_amount=110_000,
                confidence_score=0.8,
                sample_count=20,
                source_id="test-source",
                source_provenance="manual",
                source_snapshot_id="snapshot-de",
                source_url="https://example.com/source",
                attribution="Test compensation evidence",
                fx_reference={"rate_to_eur": 1, "reference_id": "eur-identity"},
                as_of_date="2026-08-01",
                fetched_at="2026-08-12T08:00:00Z",
                fresh_until="2026-08-19T08:00:00Z",
            )
        )

        with pytest.raises(ValueError, match="does not match"):
            state_repository.mark_result(
                lease,
                completed_at="2026-08-12T08:01:00Z",
                next_refresh_at="2026-08-19T08:01:00Z",
                result_kind="direct",
                fact_id=wrong_country.fact_id,
            )
    finally:
        close_connection(db_path)


def _insert_job(
    conn,
    *,
    job_id: str,
    title: str,
    location: str,
    is_deleted: int = 0,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, location, site,
            discovered_at
        ) VALUES ('local', ?, ?, ?, 'Acme', ?, 'example', ?)
        """,
        (
            job_id,
            f"https://jobs.example.com/{job_id}",
            title,
            location,
            "2026-08-12T07:00:00Z",
        ),
    )
    if is_deleted:
        conn.execute(
            """
            INSERT INTO jobctrl_deleted_jobs (
                tenant_id, job_id, deleted_at, reason, restored_at
            ) VALUES ('local', ?, '2026-08-12T07:30:00Z', 'test', NULL)
            """,
            (job_id,),
        )
