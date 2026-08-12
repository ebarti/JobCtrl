from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.compensation import (
    LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    ReportedCompensationObservation,
    build_price_level_fact,
)
from jobctrl.infrastructure.compensation.automatic_refresh import (
    run_automatic_compensation_refresh,
)
from jobctrl.infrastructure.compensation.benchmark_materialization import (
    CANONICAL_BENCHMARK_ESTIMATOR_VERSION,
    materialize_automatic_compensation_estimates,
)
from jobctrl.infrastructure.compensation.refresh_state import (
    SqliteCompensationRefreshStateRepository,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    ReportedCompensationSourceLoad,
    SqliteMarketCompensationRepository,
)


NOW = "2026-08-12T08:00:00Z"
FRESH_UNTIL = "2026-08-19T08:00:00Z"
JOB_ONE = "11111111-1111-4111-8111-111111111111"
JOB_TWO = "22222222-2222-4222-8222-222222222222"


def test_direct_benchmark_materializes_every_matching_job_idempotently(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Senior Software Engineer")
        _insert_job(conn, job_id=JOB_TWO, title="Senior Backend Engineer")
        refreshed = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(_observation(country="Spain"),)
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=lambda: NOW,
        )
        assert refreshed.direct_results == 1

        first = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )

        assert first.jobs_considered == 2
        assert first.jobs_with_benchmark == 2
        assert first.estimates_written == 2
        estimates = SqliteMarketCompensationRepository(conn)
        for job_id in (JOB_ONE, JOB_TWO):
            estimate = estimates.get_estimate("local", job_id)
            assert estimate is not None
            assert estimate.estimate_state == "estimated_range"
            assert (estimate.minimum_amount, estimate.maximum_amount) == (
                60_000,
                90_000,
            )
            assert estimate.currency == "EUR"
            assert estimate.period == "year"
            assert estimate.estimator_version.startswith(f"{CANONICAL_BENCHMARK_ESTIMATOR_VERSION}:direct:")
        projection = conn.execute(
            """
            SELECT list.compensation_summary_json, detail.compensation_audit_json
            FROM job_list_projections AS list
            JOIN job_detail_projections AS detail
              ON detail.tenant_id = list.tenant_id
             AND detail.job_id = list.job_id
            WHERE list.tenant_id = 'local' AND list.job_id = ?
            """,
            (JOB_ONE,),
        ).fetchone()
        assert projection is not None
        summary = json.loads(projection["compensation_summary_json"])
        assert summary["market"]["recordStatus"] == "recorded"
        assert summary["market"]["displayRange"] == "EUR 60000-90000/year"
        audit = json.loads(projection["compensation_audit_json"])
        assert audit["market"]["estimate"]["geographyScope"] == "country"
        assert {source["geographyScope"] for source in audit["market"]["estimate"]["sources"]} == {"country"}

        event_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM job_events
            WHERE tenant_id = 'local' AND event_type = 'CompensationFactsUpdated'
            """
        ).fetchone()[0]
        second = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )
        assert second.estimates_written == 0
        assert second.estimates_unchanged == 2
        assert (
            conn.execute(
                """
                SELECT COUNT(*)
                FROM job_events
                WHERE tenant_id = 'local'
                  AND event_type = 'CompensationFactsUpdated'
                """
            ).fetchone()[0]
            == event_count
        )
    finally:
        close_connection(db_path)


def test_materialization_retry_repairs_projection_after_save_event_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Senior Software Engineer")
        run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(_observation(country="Spain"),)
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=lambda: NOW,
        )
        original = SqliteMarketCompensationRepository._record_updated_event

        def fail_before_event(_repository, _estimate) -> None:
            raise sqlite3.OperationalError("simulated compensation event failure")

        monkeypatch.setattr(
            SqliteMarketCompensationRepository,
            "_record_updated_event",
            fail_before_event,
        )
        with pytest.raises(sqlite3.OperationalError, match="simulated compensation event failure"):
            materialize_automatic_compensation_estimates(
                conn,
                tenant_id="local",
                materialized_at=NOW,
            )

        repository = SqliteMarketCompensationRepository(conn)
        assert repository.get_estimate("local", JOB_ONE) is None
        assert (
            conn.execute(
                """
                SELECT COUNT(*) FROM job_events
                WHERE tenant_id = 'local' AND job_id = ?
                  AND event_type = 'CompensationFactsUpdated'
                """,
                (JOB_ONE,),
            ).fetchone()[0]
            == 0
        )

        monkeypatch.setattr(
            SqliteMarketCompensationRepository,
            "_record_updated_event",
            original,
        )
        retried = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )

        assert retried.estimates_written == 1
        assert retried.projections_refreshed == 1
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["recordStatus"] == "recorded"
        assert summary["market"]["displayRange"] == "EUR 60000-90000/year"
        assert audit["market"]["recordStatus"] == "recorded"
    finally:
        close_connection(db_path)


def test_materialization_retry_repairs_projection_after_clear_event_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Senior Software Engineer")
        run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(_observation(country="Spain"),)
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=lambda: NOW,
        )
        materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )
        conn.execute(
            "UPDATE jobs SET title = 'Unclassified Opportunity' WHERE tenant_id = 'local' AND job_id = ?",
            (JOB_ONE,),
        )
        conn.commit()
        event_count = conn.execute(
            """
            SELECT COUNT(*) FROM job_events
            WHERE tenant_id = 'local' AND job_id = ?
              AND event_type = 'CompensationFactsUpdated'
            """,
            (JOB_ONE,),
        ).fetchone()[0]
        original = SqliteMarketCompensationRepository._record_cleared_event

        def fail_before_event(_repository, **_kwargs) -> None:
            raise sqlite3.OperationalError("simulated compensation clear event failure")

        monkeypatch.setattr(
            SqliteMarketCompensationRepository,
            "_record_cleared_event",
            fail_before_event,
        )
        with pytest.raises(sqlite3.OperationalError, match="simulated compensation clear event failure"):
            materialize_automatic_compensation_estimates(
                conn,
                tenant_id="local",
                materialized_at="2026-08-12T09:00:00Z",
            )

        repository = SqliteMarketCompensationRepository(conn)
        assert repository.get_estimate("local", JOB_ONE) is not None
        assert (
            conn.execute(
                """
                SELECT COUNT(*) FROM job_events
                WHERE tenant_id = 'local' AND job_id = ?
                  AND event_type = 'CompensationFactsUpdated'
                """,
                (JOB_ONE,),
            ).fetchone()[0]
            == event_count
        )
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["recordStatus"] == "recorded"
        assert audit["market"]["recordStatus"] == "recorded"

        monkeypatch.setattr(
            SqliteMarketCompensationRepository,
            "_record_cleared_event",
            original,
        )
        retried = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at="2026-08-12T09:00:00Z",
        )

        assert retried.estimates_cleared == 1
        assert retried.projections_refreshed == 1
        assert repository.get_estimate("local", JOB_ONE) is None
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["recordStatus"] == "not_requested"
        assert summary["market"]["displayRange"] is None
        assert audit["market"]["recordStatus"] == "not_requested"
    finally:
        close_connection(db_path)


def test_out_of_bounds_geographic_extrapolation_remains_visible_with_warnings(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Senior Software Engineer")
        refreshed = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(_observation(country="Germany"),)
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (
                _price_level(country="DE", index=100),
                _price_level(country="ES", index=2_000),
            ),
            completion_clock=lambda: NOW,
        )
        assert refreshed.extrapolated_results == 1
        assert refreshed.insufficient_results == 1
        state_repository = SqliteCompensationRefreshStateRepository(conn)
        benchmark_slice = state_repository.discover_active_job_slices("local").slices[0]
        state = state_repository.get(benchmark_slice)
        assert state is not None
        assert state.refresh_status == "insufficient_evidence"
        assert state.last_result_kind == "extrapolated"

        result = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )

        assert result.estimates_written == 1
        estimate = SqliteMarketCompensationRepository(conn).get_estimate("local", JOB_ONE)
        assert estimate is not None
        assert (estimate.minimum_amount, estimate.maximum_amount) == (
            1_200_000,
            1_800_000,
        )
        assert {
            "benchmark_extrapolated",
            "cost_of_living_only",
            "factor_out_of_bounds",
        }.issubset(estimate.warnings)
        projection = conn.execute(
            """
            SELECT list.compensation_summary_json, detail.compensation_audit_json
            FROM job_list_projections AS list
            JOIN job_detail_projections AS detail
              ON detail.tenant_id = list.tenant_id
             AND detail.job_id = list.job_id
            WHERE list.tenant_id = 'local' AND list.job_id = ?
            """,
            (JOB_ONE,),
        ).fetchone()
        assert projection is not None
        market = json.loads(projection["compensation_summary_json"])["market"]
        assert market["displayRange"] == "EUR 1200000-1800000/year"
        assert market["warningCount"] >= 3
        audit = json.loads(projection["compensation_audit_json"])["market"]["estimate"]
        assert audit["geographyScope"] == "country"
        assert {source["geographyScope"] for source in audit["sources"]} == {"country"}
        assert {
            "benchmark_extrapolated",
            "cost_of_living_only",
            "factor_out_of_bounds",
        }.issubset({warning["code"] for warning in audit["warnings"]})
    finally:
        close_connection(db_path)


def test_failed_refresh_keeps_last_range_visible_and_marks_it_stale(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Senior Software Engineer")
        first = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(_observation(country="Spain"),)
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=lambda: NOW,
        )
        assert first.direct_results == 1
        materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )

        def unavailable(_targets):
            raise RuntimeError("provider unavailable")

        failed = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-2",
            now=FRESH_UNTIL,
            load_observations=unavailable,
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=lambda: FRESH_UNTIL,
        )
        assert failed.failed_results == 1

        result = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=FRESH_UNTIL,
        )

        assert result.estimates_written == 1
        estimate = SqliteMarketCompensationRepository(conn).get_estimate("local", JOB_ONE)
        assert estimate is not None
        assert (estimate.minimum_amount, estimate.maximum_amount) == (60_000, 90_000)
        assert "stale_source_snapshot" in estimate.warnings
        summary = json.loads(
            conn.execute(
                """
                SELECT compensation_summary_json
                FROM job_list_projections
                WHERE tenant_id = 'local' AND job_id = ?
                """,
                (JOB_ONE,),
            ).fetchone()["compensation_summary_json"]
        )
        assert summary["market"]["recordStatus"] == "recorded"
        assert summary["market"]["displayRange"] == "EUR 60000-90000/year"
        assert summary["market"]["warningCount"] >= 1
    finally:
        close_connection(db_path)


def test_role_change_clears_only_the_automatic_estimator_owned_range(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Senior Software Engineer")
        _insert_job(conn, job_id=JOB_TWO, title="Senior Backend Engineer")
        run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discover-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(_observation(country="Spain"),)
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=lambda: NOW,
        )
        materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at=NOW,
        )
        conn.execute(
            """
            UPDATE jobs SET title = 'Unclassified Opportunity'
            WHERE tenant_id = 'local'
            """
        )
        conn.execute(
            """
            UPDATE job_market_compensation_estimates
            SET estimator_version = 'company-role-reported-compensation-v2'
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (JOB_TWO,),
        )
        conn.commit()

        result = materialize_automatic_compensation_estimates(
            conn,
            tenant_id="local",
            materialized_at="2026-08-12T09:00:00Z",
        )

        assert result.estimates_cleared == 1
        repository = SqliteMarketCompensationRepository(conn)
        assert repository.get_estimate("local", JOB_ONE) is None
        assert repository.get_estimate("local", JOB_TWO) is not None
        summary = json.loads(
            conn.execute(
                """
                SELECT compensation_summary_json
                FROM job_list_projections
                WHERE tenant_id = 'local' AND job_id = ?
                """,
                (JOB_ONE,),
            ).fetchone()["compensation_summary_json"]
        )
        assert summary["market"]["recordStatus"] == "not_requested"
        assert summary["market"]["displayRange"] is None
    finally:
        close_connection(db_path)


def _insert_job(conn, *, job_id: str, title: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, location, site, discovered_at
        ) VALUES (
            'local', ?, ?, ?, 'Example', 'Madrid, Spain', 'example', ?
        )
        """,
        (job_id, f"https://jobs.example.com/{job_id}", title, NOW),
    )
    conn.commit()


def _projected_compensation(conn, job_id: str) -> tuple[dict, dict]:
    row = conn.execute(
        """
        SELECT list.compensation_summary_json, detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = 'local' AND list.job_id = ?
        """,
        (job_id,),
    ).fetchone()
    assert row is not None
    return (
        json.loads(row["compensation_summary_json"]),
        json.loads(row["compensation_audit_json"]),
    )


def _observation(*, country: str) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name=LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
        role_title="Senior Software Engineer",
        minimum_amount=60_000,
        maximum_amount=90_000,
        currency="EUR",
        period="year",
        component="total_compensation",
        location=country,
        level_label="Senior",
        release_year=2026,
        snapshot_version=f"levels-public-{country.casefold()}",
        sample_count=20,
        attribution="Data source: Levels.fyi (https://www.levels.fyi)",
        source_url="https://www.levels.fyi/t/software-engineer",
    )


def _price_level(*, country: str, index: float):
    return build_price_level_fact(
        tenant_id="local",
        country_code=country,
        category="actual_individual_consumption",
        reference_year=2025,
        base_geography_code="EU27_2020",
        index_value=index,
        source_id="eurostat",
        source_snapshot_id="eurostat-shared-snapshot",
        source_url="https://ec.europa.eu/eurostat/",
        attribution="Eurostat purchasing power parities",
        as_of_date="2025-12-31",
        fetched_at=NOW,
        fresh_until=FRESH_UNTIL,
    )


def _unexpected_fx():
    raise AssertionError("EUR-only evidence must not fetch FX")
