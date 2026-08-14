from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.compensation import (
    LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    ReportedCompensationObservation,
    build_price_level_fact,
)
from jobctrl.infrastructure.compensation.automatic_refresh import (
    AutomaticCompensationRefreshResult,
    refresh_automatic_compensation_benchmarks,
    run_automatic_compensation_refresh,
)
from jobctrl.infrastructure.compensation.levels_fyi_public import LevelsFyiPublicTarget
from jobctrl.infrastructure.compensation.refresh_state import (
    SqliteCompensationRefreshStateRepository,
    StaleCompensationRefreshLease,
)
from jobctrl.infrastructure.compensation.sqlite_benchmark_repository import (
    SqliteCompensationBenchmarkRepository,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    ReportedCompensationSourceLoad,
)


NOW = "2026-08-12T08:00:00Z"
FRESH_UNTIL = "2026-08-19T08:00:00Z"


def test_production_refresh_keeps_levels_disabled_without_user_opt_in(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"compensation_sources": {}}', encoding="utf-8")
    conn = init_db(db_path)
    try:
        monkeypatch.setattr(
            "jobctrl.infrastructure.compensation.sqlite_market_repository.get_config_path",
            lambda: settings_path,
        )
        monkeypatch.setattr(
            "jobctrl.infrastructure.compensation.sqlite_market_repository.load_levels_fyi_public_observations",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("production discovery must not fetch Levels without opt-in")
            ),
        )

        expected = AutomaticCompensationRefreshResult(
            status="skipped",
            jobs_considered=0,
            slices_discovered=0,
            slices_claimed=0,
            direct_results=0,
            extrapolated_results=0,
            level_fallback_results=0,
            insufficient_results=0,
            failed_results=0,
            observations_loaded=0,
            observations_rejected=0,
            direct_facts_saved=0,
            price_level_facts_saved=0,
        )

        def fake_run(_conn, **kwargs):
            loaded = kwargs["load_observations"]((LevelsFyiPublicTarget("Software Engineer", "ES"),))
            assert loaded.levels_fyi_public_count == 0
            return expected

        monkeypatch.setattr(
            "jobctrl.infrastructure.compensation.automatic_refresh.run_automatic_compensation_refresh",
            fake_run,
        )

        result = refresh_automatic_compensation_benchmarks(
            tenant_id="local",
            owner="discover-local-policy-test",
            now=NOW,
            conn=conn,
        )

        assert result == expected
    finally:
        close_connection(db_path)


def test_direct_refresh_is_reused_until_the_seven_day_boundary(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    calls = {"observations": 0, "fx": 0, "price": 0}
    try:
        _insert_job(conn, title="Senior Software Engineer", location="Madrid, Spain")

        def load_observations(_targets):
            calls["observations"] += 1
            assert tuple(target.location for target in _targets) == ("ES",)
            return ReportedCompensationSourceLoad(
                observations=(
                    _observation(
                        country="Spain",
                        company=LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
                        level="all levels",
                        minimum=55_000,
                        maximum=85_000,
                    ),
                ),
                levels_fyi_count=1,
                levels_fyi_public_count=1,
            )

        def unexpected_fx():
            calls["fx"] += 1
            raise AssertionError("EUR-only direct evidence must not fetch FX")

        def unexpected_price():
            calls["price"] += 1
            raise AssertionError("a direct target match must not fetch price levels")

        first = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-1",
            now=NOW,
            load_observations=load_observations,
            load_fx_rates=unexpected_fx,
            load_price_levels=unexpected_price,
            completion_clock=_clock(NOW),
        )

        assert first.status == "succeeded"
        assert first.slices_claimed == 1
        assert first.direct_results == 1
        assert first.level_fallback_results == 1
        assert calls == {"observations": 1, "fx": 0, "price": 0}

        def unexpected_observations(_targets):
            raise AssertionError("fresh benchmark slices must not access the network")

        skipped = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-2",
            now="2026-08-19T07:59:59Z",
            load_observations=unexpected_observations,
            load_fx_rates=unexpected_fx,
            load_price_levels=unexpected_price,
            completion_clock=_clock("2026-08-19T07:59:59Z"),
        )
        assert skipped.status == "skipped"
        assert skipped.slices_claimed == 0

        refreshed = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-3",
            now=FRESH_UNTIL,
            load_observations=load_observations,
            load_fx_rates=unexpected_fx,
            load_price_levels=unexpected_price,
            completion_clock=_clock(FRESH_UNTIL),
        )
        assert refreshed.direct_results == 1
        assert calls == {"observations": 2, "fx": 0, "price": 0}
        assert conn.execute("SELECT COUNT(*) FROM compensation_direct_benchmark_facts").fetchone()[0] == 2
    finally:
        close_connection(db_path)


def test_missing_geography_is_extrapolated_from_cost_of_living(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, title="Senior Software Engineer", location="Madrid, Spain")
        result = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(
                    _observation(
                        country="Germany",
                        company=LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
                        level="Senior",
                        minimum=80_000,
                        maximum=100_000,
                    ),
                )
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: _price_levels(de_index=100, es_index=80),
            completion_clock=_clock(NOW),
        )

        assert result.status == "succeeded"
        assert result.direct_results == 0
        assert result.extrapolated_results == 1
        assert result.insufficient_results == 0
        state_repository = SqliteCompensationRefreshStateRepository(conn)
        benchmark_slice = state_repository.discover_active_job_slices("local").slices[0]
        state = state_repository.get(benchmark_slice)
        assert state is not None
        assert state.refresh_status == "succeeded"
        assert state.last_result_kind == "extrapolated"
        assert state.last_extrapolated_fact_id is not None
        fact = SqliteCompensationBenchmarkRepository(conn).get_extrapolated(
            "local",
            state.last_extrapolated_fact_id,
        )
        assert fact is not None
        assert (fact.minimum_amount, fact.maximum_amount) == (64_000, 80_000)
        assert fact.confidence_band == "low"
        assert fact.warnings == ("cost_of_living_only",)
    finally:
        close_connection(db_path)


def test_same_company_country_evidence_adjusts_the_cost_of_living_factor(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, title="Senior Software Engineer", location="Madrid, Spain")
        observations = (
            _observation(
                country="Germany",
                company=LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
                level="Senior",
                minimum=80_000,
                maximum=100_000,
            ),
            _observation(
                country="Germany",
                company="Acme GmbH",
                level="Senior",
                minimum=100_000,
                maximum=100_000,
                marker="acme-de",
            ),
            _observation(
                country="Spain",
                company="Acme SL",
                level="Senior",
                minimum=90_000,
                maximum=90_000,
                marker="acme-es",
            ),
        )
        result = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(observations=observations),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: _price_levels(de_index=100, es_index=70),
            completion_clock=_clock(NOW),
        )

        assert result.extrapolated_results == 1
        row = conn.execute("SELECT fact_id FROM compensation_extrapolated_benchmark_facts").fetchone()
        fact = SqliteCompensationBenchmarkRepository(conn).get_extrapolated(
            "local",
            str(row["fact_id"]),
        )
        assert fact is not None
        assert fact.matched_company_count == 1
        assert 0.7 < fact.raw_factor < 0.9
        assert 0 < fact.shrinkage_weight < 1
        assert "limited_matched_company_evidence" in fact.warnings
    finally:
        close_connection(db_path)


def test_failed_refresh_preserves_the_last_good_result_and_retries_next_day(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, title="Senior Software Engineer", location="Madrid, Spain")
        first = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(
                    _observation(
                        country="Spain",
                        company=LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
                        level="Senior",
                        minimum=60_000,
                        maximum=90_000,
                    ),
                )
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=_clock(NOW),
        )
        assert first.direct_results == 1
        state_repository = SqliteCompensationRefreshStateRepository(conn)
        benchmark_slice = state_repository.discover_active_job_slices("local").slices[0]
        previous = state_repository.get(benchmark_slice)
        assert previous is not None
        previous_fact_id = previous.last_direct_fact_id

        def failed_source(_targets):
            raise RuntimeError("provider unavailable")

        failed = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-2",
            now=FRESH_UNTIL,
            load_observations=failed_source,
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=_clock(FRESH_UNTIL),
        )

        assert failed.status == "completed_with_warnings"
        assert failed.failed_results == 1
        assert "reported_sources_unavailable" in failed.warnings
        current = state_repository.get(benchmark_slice)
        assert current is not None
        assert current.refresh_status == "failed"
        assert current.last_result_kind == "direct"
        assert current.last_direct_fact_id == previous_fact_id
        assert current.next_refresh_at == "2026-08-20T08:00:00.000000Z"
    finally:
        close_connection(db_path)


def test_blocked_public_source_uses_one_day_failure_retry(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, title="Senior Software Engineer", location="Madrid, Spain")

        result = run_automatic_compensation_refresh(
            conn,
            tenant_id="local",
            owner="discovery-1",
            now=NOW,
            load_observations=lambda _targets: ReportedCompensationSourceLoad(
                observations=(),
                source_errors=("euro_top_tech_unavailable",),
            ),
            load_fx_rates=_unexpected_fx,
            load_price_levels=lambda: (),
            completion_clock=_clock(NOW),
        )

        assert result.failed_results == 1
        assert "euro_top_tech_unavailable" in result.warnings
        state_repository = SqliteCompensationRefreshStateRepository(conn)
        benchmark_slice = state_repository.discover_active_job_slices("local").slices[0]
        state = state_repository.get(benchmark_slice)
        assert state is not None
        assert state.refresh_status == "failed"
        assert state.last_error_code == "euro_top_tech_unavailable"
        assert state.next_refresh_at == "2026-08-13T08:00:00.000000Z"
    finally:
        close_connection(db_path)


def test_slow_refresh_cannot_publish_after_its_lease_expires(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        _insert_job(conn, title="Senior Software Engineer", location="Madrid, Spain")

        with pytest.raises(StaleCompensationRefreshLease):
            run_automatic_compensation_refresh(
                conn,
                tenant_id="local",
                owner="discovery-1",
                now=NOW,
                load_observations=lambda _targets: ReportedCompensationSourceLoad(
                    observations=(
                        _observation(
                            country="Spain",
                            company=LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
                            level="Senior",
                            minimum=60_000,
                            maximum=90_000,
                        ),
                    )
                ),
                load_fx_rates=_unexpected_fx,
                load_price_levels=lambda: (),
                completion_clock=_clock("2026-08-12T09:00:00Z"),
            )

        state_repository = SqliteCompensationRefreshStateRepository(conn)
        benchmark_slice = state_repository.discover_active_job_slices("local").slices[0]
        state = state_repository.get(benchmark_slice)
        assert state is not None
        assert state.refresh_status == "refreshing"
        assert state.last_result_kind == "none"
    finally:
        close_connection(db_path)


def _insert_job(conn, *, title: str, location: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, location, site, discovered_at
        ) VALUES (
            'local', '11111111-1111-4111-8111-111111111111',
            'https://jobs.example.com/one', ?, 'Example', ?, 'example', ?
        )
        """,
        (title, location, NOW),
    )
    conn.commit()


def _observation(
    *,
    country: str,
    company: str,
    level: str,
    minimum: int,
    maximum: int,
    marker: str = "market",
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name=company,
        role_title="Senior Software Engineer",
        minimum_amount=minimum,
        maximum_amount=maximum,
        currency="EUR",
        period="year",
        component="total_compensation",
        location=country,
        level_label=level,
        release_year=2026,
        snapshot_version=f"levels-public-{marker}",
        sample_count=20,
        attribution="Data source: Levels.fyi (https://www.levels.fyi)",
        source_url="https://www.levels.fyi/t/software-engineer",
    )


def _price_levels(*, de_index: float, es_index: float):
    return (
        _price(country="DE", index=de_index, marker="de"),
        _price(country="ES", index=es_index, marker="es"),
    )


def _price(*, country: str, index: float, marker: str):
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


def _clock(value: str):
    return lambda: value
