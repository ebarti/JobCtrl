"""Compensation classification, refresh leases, caching and accepted results."""

from pathlib import Path
import pytest
from jobctrl.database import init_db, close_connection
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.compensation.automatic_refresh import (
    AutomaticCompensationRefreshResult,
    refresh_automatic_compensation_benchmarks,
)
from jobctrl.infrastructure.compensation.levels_fyi_public import LevelsFyiPublicTarget
from jobctrl.infrastructure.compensation.refresh_state import (
    SqliteCompensationRefreshStateRepository,
    StaleCompensationRefreshLease,
)
from jobctrl.infrastructure.compensation.benchmark_materialization import materialize_automatic_compensation_estimates
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    SqliteMarketCompensationRepository,
    ReportedCompensationSourceLoad,
)
from tests.compensation_fakes import (
    NOW,
    FRESH,
    JOB,
    ClassificationModel,
    put_job,
    observation,
    configure_classifier,
    refresh,
)


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "owned.sqlite"
    conn = init_db(path)
    yield conn
    close_connection(path)


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


@pytest.mark.parametrize("family,has_range", [("software_engineering", True), ("sales", False)])
def test_identical_provider_row_is_matched_only_by_model_codes(database, monkeypatch, family, has_range):
    put_job(database)
    model = ClassificationModel(family=family)
    configure_classifier(monkeypatch, model)
    result = refresh(database)
    assert result.direct_results == int(has_range)
    materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    estimate = SqliteMarketCompensationRepository(database).get_estimate("local", JOB)
    assert (estimate is not None and estimate.estimate_state == "estimated_range") == has_range
    classification = database.execute(
        "SELECT envelope_json FROM semantic_determinations WHERE kind='benchmark_classification'"
    ).fetchone()[0]
    assert family in classification
    if has_range:
        assert (estimate.minimum_amount, estimate.maximum_amount) == (60000, 90000)


def test_seven_day_refresh_boundary_and_unchanged_classification_cache(database, monkeypatch):
    put_job(database)
    model = ClassificationModel()
    configure_classifier(monkeypatch, model)
    calls = []

    def load(targets):
        calls.append(targets)
        return ReportedCompensationSourceLoad(observations=(observation(),))

    assert refresh(database, load=load).direct_results == 1
    assert refresh(database, now="2026-08-19T07:59:59Z", load=load).status == "skipped"
    assert len(calls) == 1 and len(model.calls) == 1
    assert refresh(database, now=FRESH, load=load).direct_results == 1
    assert len(calls) == 2 and len(model.calls) == 1
    assert database.execute("SELECT COUNT(*) FROM compensation_direct_benchmark_facts").fetchone()[0] == 2


@pytest.mark.parametrize(
    "failure", ["provider_unavailable", "budget_denied", "malformed_json", "schema_violation", "non_verbatim_quote"]
)
def test_failed_classification_preserves_range_and_records_its_distinct_failure(database, monkeypatch, failure):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    repository = SqliteMarketCompensationRepository(database)
    before = repository.get_estimate("local", JOB)
    configure_classifier(monkeypatch, ClassificationModel(fault=DeterminationFailure(failure)))
    with pytest.raises(DeterminationFailure) as error:
        refresh(database, now=FRESH, rows=[observation(source_url="https://example.org/new-snapshot")])
    assert error.value.code == failure
    assert repository.get_estimate("local", JOB) == before
    row = database.execute("SELECT refresh_status,last_error_code FROM compensation_market_refresh_state").fetchone()
    assert tuple(row) == ("failed", failure)


def test_source_failure_preserves_latest_result_and_retries_next_day(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    before = database.execute("SELECT last_direct_fact_id FROM compensation_market_refresh_state").fetchone()[0]

    def unavailable(targets):
        raise RuntimeError("Private provider body")

    result = refresh(database, now=FRESH, load=unavailable)
    assert result.failed_results == 1
    row = database.execute(
        "SELECT last_direct_fact_id,last_error_code,next_refresh_at FROM compensation_market_refresh_state"
    ).fetchone()
    assert row[0] == before and row[1] == "reported_sources_unavailable"
    assert row[2] == "2026-08-20T08:00:00.000000Z"
    assert refresh(database, now="2026-08-20T07:59:59Z", load=unavailable).status == "skipped"


def test_expired_refresh_lease_cannot_publish_slice_result(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    with pytest.raises(StaleCompensationRefreshLease):
        refresh(database, clock=lambda: "2026-08-12T09:00:01Z")
    row = database.execute(
        "SELECT refresh_status,last_direct_fact_id FROM compensation_market_refresh_state"
    ).fetchone()
    assert tuple(row) == ("refreshing", None)


def test_forced_refresh_is_bounded_to_a_current_slice(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    slices = SqliteCompensationRefreshStateRepository(database).discover_active_job_slices("local").slices
    assert refresh(database, now="2026-08-13T08:00:00Z", force=slices).slices_claimed == 1
    with pytest.raises(ValueError, match="one to five"):
        refresh(database, force=())
