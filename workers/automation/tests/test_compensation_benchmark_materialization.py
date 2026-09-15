from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from dataclasses import replace

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
                observations=(_observation(country="Spain"), replace(_observation(country="Spain"),
                    company_name="Peer Cloud", minimum_amount=180_000, maximum_amount=220_000))
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
        assert summary["market"]["benchmarkKind"] == "direct"
        assert summary["market"]["displayRange"] == "EUR 60000-90000/year"
        audit = json.loads(projection["compensation_audit_json"])
        assert audit["market"]["estimate"]["geographyScope"] == "country"
        assert audit["market"]["estimate"]["evidence"][0]["companyName"] == LEVELS_FYI_MARKET_AGGREGATE_COMPANY
        assert audit["market"]["estimate"]["aggregateBucket"] == "reported company-role compensation"
        assert {source["geographyScope"] for source in audit["market"]["estimate"]["sources"]} == {"country"}
        lineage = audit["market"]["estimate"]["benchmarkLineage"]
        assert lineage["kind"] == "direct"
        assert lineage["roleFamilyCode"] == "software_engineering"
        assert lineage["seniorityLabel"] == "senior"
        assert lineage["targetGeography"] == {
            "countryCode": "ES",
            "subdivisionCode": None,
            "locality": None,
            "scope": "country",
        }
        assert lineage["asOfDate"] == "2026-01-01"
        assert lineage["freshUntil"] == "2026-08-19T08:00:00.000000Z"
        assert lineage["priceLevelInputs"] == []
        assert lineage["directInputs"] == [
            {
                "factId": lineage["factId"],
                "inputRole": "anchor",
                "weight": 1.0,
                "geography": lineage["targetGeography"],
                "marketScope": "market",
                "normalizedCompany": None,
                "minimumAmountEur": 60_000,
                "maximumAmountEur": 90_000,
                "confidenceScore": 0.76,
                "sampleCount": 20,
                "sourceId": "levels_fyi",
                "sourceProvenance": "public",
                "sourceSnapshotId": "levels-public-spain",
                "asOfDate": "2026-01-01",
                "fetchedAt": "2026-08-12T08:00:00.000000Z",
                "freshUntil": "2026-08-19T08:00:00.000000Z",
            }
        ]

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


def test_all_level_benchmark_is_context_not_principal_pay_even_for_legacy_projections(tmp_path: Path) -> None:
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
    from jobctrl.domain.tenant import LOCAL_TENANT

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Principal Software Engineer")
        all_levels = replace(_observation(country="Spain"), role_title="Software Engineer", level_label=None)
        run_automatic_compensation_refresh(
            conn, tenant_id="local", owner="principal-all-levels", now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(observations=(all_levels,)),
            load_fx_rates=_unexpected_fx, load_price_levels=lambda: (), completion_clock=lambda: NOW,
        )
        materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        estimate = SqliteMarketCompensationRepository(conn).get_estimate("local", JOB_ONE)
        assert estimate is not None
        assert estimate.estimate_state == "insufficient_evidence"
        assert estimate.insufficient_reasons == ("weak_level_match",)
        assert estimate.minimum_amount is None and estimate.maximum_amount is None
        assert estimate.confidence_band == "none"
        assert estimate.confidence_score == 0
        assert estimate.sample_count == 20
        assert estimate.evidence[0].level_score == 0
        assert estimate.evidence[0].minimum_amount == 60_000
        assert estimate.evidence[0].maximum_amount == 90_000
        assert estimate.evidence[0].sample_count == 20

        # Reproduce a pre-fix canonical row and a stale v3 projection, without
        # requesting provider data or changing the canonical source observations.
        legacy_evidence = [dict(estimate.evidence[0].__dict__, level_score=1.0)]
        conn.execute("""UPDATE job_market_compensation_estimates SET estimate_state='estimated_range',
            minimum_amount=60000, maximum_amount=90000, confidence_band='medium', confidence_score=0.76,
            insufficient_reasons_json='[]', selected_evidence_json=? WHERE job_id=?""",
            (json.dumps(legacy_evidence), JOB_ONE))
        for table in ("job_list_projections", "job_detail_projections"):
            conn.execute(f"UPDATE {table} SET compensation_summary_json=json_set(compensation_summary_json, '$.projectionVersion', 3)")
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).refresh()
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["projectionVersion"] == 4
        assert summary["market"]["estimateState"] == "insufficient_evidence"
        assert summary["market"]["displayRange"] is None
        assert summary["market"]["confidenceBand"] == "none"
        assert audit["market"]["estimate"]["evidence"][0]["levelScore"] == 0
        assert audit["market"]["estimate"]["evidence"][0]["minimumAmount"] == 60_000
        assert conn.execute("SELECT minimum_amount FROM job_market_compensation_estimates WHERE job_id=?", (JOB_ONE,)).fetchone()[0] == 60_000
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

        def fail_before_event(_repository, _estimate, *, publisher) -> None:
            del publisher
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
        assert market["benchmarkKind"] == "extrapolated"
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
        lineage = audit["benchmarkLineage"]
        assert lineage["kind"] == "extrapolated"
        assert lineage["targetGeography"]["countryCode"] == "ES"
        assert lineage["anchorGeography"]["countryCode"] == "DE"
        assert lineage["rawFactor"] == 20
        assert lineage["shrinkageWeight"] == 0
        assert lineage["lowerFactorBound"] == 0.1
        assert lineage["upperFactorBound"] == 10
        assert lineage["factorBoundState"] == "above_upper_bound"
        assert lineage["matchedCompanyCount"] == 0
        assert lineage["formulaVersion"] == "geo-shrinkage-v1"
        assert [
            (item["inputRole"], item["countryCode"], item["indexValue"]) for item in lineage["priceLevelInputs"]
        ] == [
            ("source_price_level", "DE", 100),
            ("target_price_level", "ES", 2_000),
        ]
        assert [(item["inputRole"], item["geography"]["countryCode"]) for item in lineage["directInputs"]] == [
            ("anchor", "DE")
        ]
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


def test_automatic_uses_exact_principal_peers_before_all_level_market_and_retains_on_failure(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "peers.db")
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Principal Software Engineer")
        generic = replace(_observation(country="Spain"), role_title="Software Engineer", level_label="all levels")
        peer = replace(generic, company_name="Peer Cloud", level_label="Principal", sample_count=4,
                       minimum_amount=150_000, maximum_amount=170_000,
                       source_url="https://www.levels.fyi/companies/peer-cloud/salaries/software-engineer/levels/principal/locations/spain")
        seen_targets = []
        def load(targets):
            seen_targets.extend(targets)
            return ReportedCompensationSourceLoad(observations=(generic, peer))
        run_automatic_compensation_refresh(conn, tenant_id="local", owner="peer-run", now=NOW,
            load_observations=load, load_fx_rates=_unexpected_fx, load_price_levels=lambda: (), completion_clock=lambda: NOW)
        assert seen_targets[0].seniority_label == "principal"
        result = materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        estimate = SqliteMarketCompensationRepository(conn).get_estimate("local", JOB_ONE)
        assert result.estimates_written == 1
        assert estimate is not None and estimate.estimate_state == "estimated_range"
        assert (estimate.minimum_amount, estimate.maximum_amount) == (150_000, 170_000)
        assert estimate.confidence_band == "low"
        assert estimate.aggregate_bucket == "reported regional company peer cohort"
        assert {row.company_name for row in estimate.evidence} == {"peer cloud"}
        assert estimate.evidence[0].level_label == "principal"
        assert estimate.evidence[0].source_url == peer.source_url
        # Same-country peer facts are same-location evidence, not a mismatch.
        assert estimate.match_scope == "same_location_role_fallback"
        assert "location_mismatch" not in estimate.warnings
        assert estimate.evidence[0].location == "Spain"
        assert estimate.evidence[0].location_score >= 0.78
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["benchmarkKind"] is None
        assert audit["market"]["estimate"]["benchmarkLineage"] is None
        assert audit["market"]["estimate"]["matchScope"] == "same_location_role_fallback"
        assert audit["market"]["estimate"]["aggregateBucket"] == "reported regional company peer cohort"
        # The next failed refresh cannot demote accepted peers to generic context,
        # even after its evidence freshness window ends.
        later = "2026-08-21T08:00:00Z"
        run_automatic_compensation_refresh(conn, tenant_id="local", owner="failed-run", now=later,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(observations=(), source_errors=("levels_fyi_public_unavailable",)),
            load_fx_rates=_unexpected_fx, load_price_levels=lambda: (), completion_clock=lambda: later)
        materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=later)
        assert SqliteMarketCompensationRepository(conn).get_estimate("local", JOB_ONE) == estimate
    finally:
        close_connection()


@pytest.mark.parametrize(("producer", "consumer", "level", "failed_rows"), [
    ("explicit", "explicit", "Senior", "empty"),
    ("explicit", "explicit", "Principal", "empty"),
    ("explicit", "explicit", "Principal", "stale"),
    ("explicit", "explicit", "Principal", "irrelevant"),
    ("automatic", "explicit", "Principal", "empty"),
    ("automatic", "explicit", "Principal", "generic"),
    ("explicit", "automatic", "Principal", "empty"),
    ("explicit", "automatic", "Principal", "generic"),
])
def test_failed_refresh_retains_same_job_across_producers_and_empty_results(
    tmp_path, monkeypatch, producer, consumer, level, failed_rows,
) -> None:
    from jobctrl.infrastructure.compensation import refresh

    conn = init_db(tmp_path / "cross-path.db")
    try:
        title = f"{level} Software Engineer"
        _insert_job(conn, job_id=JOB_ONE, title=title)
        observation = replace(_observation(country="Spain"), role_title=title, level_label=level)
        repository = SqliteMarketCompensationRepository(conn)
        if producer == "automatic":
            run_automatic_compensation_refresh(conn, tenant_id="local", owner="accepted", now=NOW,
                load_observations=lambda _: ReportedCompensationSourceLoad(observations=(observation,)),
                load_fx_rates=_unexpected_fx, load_price_levels=lambda: (), completion_clock=lambda: NOW)
            materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        else:
            repository.backfill_from_jobs((replace(observation, company_name="Example"),), estimated_at=NOW)
            from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
            ProjectionBuilder(conn_factory=lambda: conn).refresh()
        accepted = repository.get_estimate("local", JOB_ONE)
        assert accepted is not None and accepted.estimate_state == "estimated_range"
        if level == "Principal":
            assert accepted.seniority_label == ("principal" if producer == "automatic" else "staff_plus")
        failed_observations = {
            "empty": (),
            "generic": (replace(observation, role_title="Software Engineer", level_label="all levels"),),
            "stale": (replace(observation, release_year=2000),),
            "irrelevant": (replace(observation, role_title="Senior Marketing Analyst", level_label="Senior"),),
        }[failed_rows]
        source_load = ReportedCompensationSourceLoad(observations=failed_observations,
            source_errors=("levels_fyi_public_unavailable",))
        if consumer == "explicit":
            monkeypatch.setattr(refresh, "get_connection", lambda: conn)
            monkeypatch.setattr(refresh, "load_default_reported_compensation_observations", lambda **_: source_load)
            result = refresh.refresh_compensation_facts(tenant_id="local", job_id=JOB_ONE, include_euro_top_tech=False)
            assert result["reportedObservationsLoaded"] == len(failed_observations)
        else:
            later = "2026-08-21T08:00:00Z"
            run_automatic_compensation_refresh(conn, tenant_id="local", owner="failed", now=later,
                load_observations=lambda _: source_load, load_fx_rates=_unexpected_fx,
                load_price_levels=lambda: (), completion_clock=lambda: later)
            materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=later)
        assert repository.get_estimate("local", JOB_ONE) == accepted
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["estimateState"] == "estimated_range"
        assert audit["market"]["estimate"]["minimumAmount"] == accepted.minimum_amount
    finally:
        close_connection()


@pytest.mark.parametrize("consumer", ["explicit", "automatic"])
@pytest.mark.parametrize("change", ["role", "country", "unsupported_old_population"])
def test_failed_refresh_does_not_retain_changed_job_or_wrong_source_population(tmp_path, monkeypatch, consumer, change):
    from jobctrl.infrastructure.compensation import refresh

    conn = init_db(tmp_path / "changed-job.db")
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Director of Software Engineering")
        observation = replace(_observation(country="Spain"), company_name="Example",
            role_title="Director of Software Engineering", level_label="Director")
        repository = SqliteMarketCompensationRepository(conn)
        repository.backfill_from_jobs((observation,), estimated_at=NOW)
        accepted = repository.get_estimate("local", JOB_ONE)
        assert accepted is not None and accepted.estimate_state == "estimated_range"
        if change == "role":
            conn.execute("UPDATE jobs SET title = 'Principal Software Engineer' WHERE job_id = ?", (JOB_ONE,))
        elif change == "country":
            conn.execute("UPDATE jobs SET location = 'Germany' WHERE job_id = ?", (JOB_ONE,))
        else:
            # Replay the candidate-1 persisted defect, not its now-fixed estimator.
            repository.save_estimate(replace(accepted, evidence=(replace(accepted.evidence[0],
                role_title="Principal Infrastructure Engineer", level_label="Principal / Director"),)))
        source_load = ReportedCompensationSourceLoad(observations=(), source_errors=("levels_fyi_public_unavailable",))
        if consumer == "explicit":
            monkeypatch.setattr(refresh, "get_connection", lambda: conn)
            monkeypatch.setattr(refresh, "load_default_reported_compensation_observations", lambda **_: source_load)
            refresh.refresh_compensation_facts(tenant_id="local", job_id=JOB_ONE, include_euro_top_tech=False)
        else:
            run_automatic_compensation_refresh(conn, tenant_id="local", owner="failed", now=NOW,
                load_observations=lambda _: source_load, load_fx_rates=_unexpected_fx,
                load_price_levels=lambda: (), completion_clock=lambda: NOW)
            materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        current = repository.get_estimate("local", JOB_ONE)
        assert current is not None and current.estimate_state == "source_unavailable"
        assert current.minimum_amount is None and current.maximum_amount is None
        summary, _ = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["displayRange"] is None
    finally:
        close_connection()


@pytest.mark.parametrize("change", ["none", "target_country", "missing_reference", "corrupt_fact", "mismatched_component"])
def test_failed_explicit_refresh_checks_extrapolated_target_not_source_geography(tmp_path, monkeypatch, change):
    from jobctrl.infrastructure.compensation import refresh

    conn = init_db(tmp_path / "extrapolated-retention.db")
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Principal Software Engineer")
        anchor = replace(_observation(country="Germany"), role_title="Principal Software Engineer", level_label="Principal")
        run_automatic_compensation_refresh(conn, tenant_id="local", owner="extrapolated", now=NOW,
            load_observations=lambda _: ReportedCompensationSourceLoad(observations=(anchor,)),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (_price_level(country="DE", index=100), _price_level(country="ES", index=90)),
            completion_clock=lambda: NOW)
        materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        repository = SqliteMarketCompensationRepository(conn)
        accepted = repository.get_estimate("local", JOB_ONE)
        assert accepted is not None and accepted.estimate_state == "estimated_range"
        assert (accepted.minimum_amount, accepted.maximum_amount) == (54_000, 81_000)
        assert {row.location for row in accepted.evidence} == {"DE"}
        _, before_audit = _projected_compensation(conn, JOB_ONE)
        lineage = before_audit["market"]["estimate"]["benchmarkLineage"]
        assert lineage["targetGeography"]["countryCode"] == "ES"
        assert lineage["anchorGeography"]["countryCode"] == "DE"
        if change == "target_country":
            conn.execute("UPDATE jobs SET location = 'France' WHERE job_id = ?", (JOB_ONE,))
        elif change == "missing_reference":
            repository.save_estimate(replace(accepted,
                estimator_version=f"{CANONICAL_BENCHMARK_ESTIMATOR_VERSION}:extrapolated:33333333-3333-4333-8333-333333333333"))
        elif change == "corrupt_fact":
            from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import SqliteCompensationBenchmarkRepository
            def corrupt_reference(*_args, **_kwargs):
                raise ValueError("extrapolated fact does not match its immutable content hash")
            monkeypatch.setattr(SqliteCompensationBenchmarkRepository, "get_extrapolated", corrupt_reference)
        elif change == "mismatched_component":
            repository.save_estimate(replace(accepted, component="base_salary"))
        monkeypatch.setattr(refresh, "get_connection", lambda: conn)
        monkeypatch.setattr(refresh, "load_default_reported_compensation_observations", lambda **_: ReportedCompensationSourceLoad(
            observations=(), source_errors=("levels_fyi_public_unavailable",)))
        refresh.refresh_compensation_facts(tenant_id="local", job_id=JOB_ONE, include_euro_top_tech=False)
        current = repository.get_estimate("local", JOB_ONE)
        summary, audit = _projected_compensation(conn, JOB_ONE)
        if change == "none":
            assert current == accepted
            assert audit["market"]["estimate"]["benchmarkLineage"] == lineage
            assert audit["market"]["estimate"]["evidence"][0]["location"] == "DE"
            assert summary["market"]["displayRange"] == "EUR 54000-81000/year"
        else:
            assert current is not None and current.estimate_state == "source_unavailable"
            assert summary["market"]["displayRange"] is None
    finally:
        close_connection()


def test_automatic_anonymous_report_preserves_provider_and_limited_sample_scope(tmp_path):
    conn = init_db(tmp_path / "anonymous-source.db")
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Principal Infrastructure Engineer")
        observation = replace(_observation(country="Spain"), source_id="euro_top_tech",
            company_name="Euro Top Tech community", role_title="Principal Infrastructure Engineer",
            level_label="Principal / Director", sample_count=1, minimum_amount=156_000, maximum_amount=156_000,
            source_url="https://www.eurotoptech.com/data", attribution="Euro Top Tech community reports")
        run_automatic_compensation_refresh(conn, tenant_id="local", owner="anonymous", now=NOW,
            load_observations=lambda _: ReportedCompensationSourceLoad(observations=(observation,)),
            load_fx_rates=_unexpected_fx, load_price_levels=lambda: (), completion_clock=lambda: NOW)
        materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        estimate = SqliteMarketCompensationRepository(conn).get_estimate("local", JOB_ONE)
        assert estimate is not None and estimate.estimate_state == "estimated_range"
        assert (estimate.minimum_amount, estimate.maximum_amount) == (156_000, 156_000)
        assert estimate.confidence_band == "low" and estimate.confidence_score <= 0.45
        assert estimate.aggregate_bucket == "reported regional source sample"
        assert estimate.evidence[0].company_name == "Euro Top Tech community"
        assert estimate.evidence[0].source_id == "euro_top_tech"
        assert estimate.evidence[0].company_score == 0
        assert estimate.evidence[0].sample_count == 1
        assert estimate.evidence[0].source_url == observation.source_url
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["confidenceBand"] == "low"
        assert audit["market"]["estimate"]["evidence"][0]["companyName"] == "Euro Top Tech community"
        assert audit["market"]["estimate"]["aggregateBucket"] == "reported regional source sample"
        assert audit["market"]["estimate"]["benchmarkLineage"]["directInputs"][0]["sourceId"] == "euro_top_tech"
    finally:
        close_connection()


@pytest.mark.parametrize("evidence_location", ["Remote Europe", None])
def test_failed_automatic_refresh_retains_explicit_estimate_with_estimator_location_semantics(
    tmp_path, evidence_location,
) -> None:
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

    conn = init_db(tmp_path / "explicit-location.db")
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Principal Software Engineer")
        observation = replace(_observation(country="Spain"), company_name="Example",
            role_title="Principal Software Engineer", level_label="Principal", location=evidence_location)
        repository = SqliteMarketCompensationRepository(conn)
        repository.backfill_from_jobs((observation,), estimated_at=NOW)
        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        accepted = repository.get_estimate("local", JOB_ONE)
        assert accepted is not None and accepted.estimate_state == "estimated_range"
        assert accepted.match_scope == "exact_company_role"
        assert accepted.estimator_version == "company-role-reported-compensation-v4"
        assert {row.location for row in accepted.evidence} == {evidence_location}
        assert "location_mismatch" not in accepted.warnings
        later = "2026-08-21T08:00:00Z"
        run_automatic_compensation_refresh(conn, tenant_id="local", owner="failed", now=later,
            load_observations=lambda _: ReportedCompensationSourceLoad(
                observations=(), source_errors=("levels_fyi_public_unavailable",)),
            load_fx_rates=_unexpected_fx, load_price_levels=lambda: (), completion_clock=lambda: later)
        result = materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=later)
        # The estimator accepted Europe-wide/unlabeled evidence at its 0.78
        # location rule; a failed refresh must not re-judge it as a mismatch.
        assert result.estimates_written == 0 and result.estimates_cleared == 0
        assert repository.get_estimate("local", JOB_ONE) == accepted
        summary, audit = _projected_compensation(conn, JOB_ONE)
        assert summary["market"]["estimateState"] == "estimated_range"
        assert audit["market"]["estimate"]["minimumAmount"] == accepted.minimum_amount
    finally:
        close_connection()


def test_unchanged_failed_state_does_not_rewrite_the_unavailable_placeholder(tmp_path) -> None:
    conn = init_db(tmp_path / "unavailable-idempotent.db")
    try:
        _insert_job(conn, job_id=JOB_ONE, title="Principal Software Engineer")
        source_load = ReportedCompensationSourceLoad(observations=(), source_errors=("levels_fyi_public_unavailable",))
        run_automatic_compensation_refresh(conn, tenant_id="local", owner="failed", now=NOW,
            load_observations=lambda _: source_load, load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (), completion_clock=lambda: NOW)
        first = materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=NOW)
        repository = SqliteMarketCompensationRepository(conn)
        placeholder = repository.get_estimate("local", JOB_ONE)
        assert first.estimates_written == 1 and first.projections_refreshed >= 1
        assert placeholder is not None and placeholder.estimate_state == "source_unavailable"
        assert placeholder.estimator_version == f"{CANONICAL_BENCHMARK_ESTIMATOR_VERSION}:unavailable"
        assert placeholder.estimated_at == "2026-08-12T08:00:00.000000Z"
        events_before = conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id = ?", (JOB_ONE,)).fetchone()[0]
        second = materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at="2026-08-12T09:00:00Z")
        assert second.estimates_written == 0 and second.estimates_unchanged == 1
        assert second.projections_refreshed == 0
        assert repository.get_estimate("local", JOB_ONE) == placeholder
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id = ?", (JOB_ONE,)).fetchone()[0] == events_before
    finally:
        close_connection()
