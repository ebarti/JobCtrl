"""Compensation classification, refresh leases, caching and accepted results."""

import io
from pathlib import Path
from types import SimpleNamespace
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
    EURO_TOP_TECH_DATA_ENTRIES_URL,
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
            assert loaded.source_errors == ()
            return expected

        monkeypatch.setattr(
            "jobctrl.infrastructure.compensation.automatic_refresh.run_automatic_compensation_refresh",
            fake_run,
        )

        requests = []

        def public_feed(request, timeout):
            requests.append(request.full_url)
            return io.BytesIO(b'{"rows": [], "hasMore": false}')

        result = refresh_automatic_compensation_benchmarks(
            tenant_id="local",
            owner="discover-local-policy-test",
            now=NOW,
            conn=conn,
            opener=SimpleNamespace(open=public_feed),
        )

        assert result == expected
        assert requests == [EURO_TOP_TECH_DATA_ENTRIES_URL]
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


def test_inflight_refresh_is_reported_as_deferred_instead_of_fresh_success(database):
    put_job(database)
    state = SqliteCompensationRefreshStateRepository(database)
    slices = state.discover_active_job_slices("local").slices
    state.ensure_slices(slices, now=NOW)
    leases = state.claim_due(
        slices, owner="other-owned-refresh", now=NOW, lease_expires_at="2026-08-12T09:00:00Z",
    )
    assert leases
    result = refresh(
        database, load=lambda _targets: (_ for _ in ()).throw(AssertionError("lease is already owned")),
    )
    assert result.status == "completed_with_warnings"
    assert result.warnings == ("compensation_refresh_in_progress",)
    assert result.slices_claimed == 0
    assert all(state.get(lease.benchmark_slice).lease_owner == lease.token for lease in leases)


@pytest.mark.parametrize(
    "deferred_status,expected_warning,expected_failures",
    [("refreshing", "compensation_refresh_in_progress", 0),
     ("failed", "compensation_refresh_failed_backoff", 1),
     ("fresh", None, 0)],
)
def test_mixed_refresh_keeps_nonclaimed_slice_status_and_accepted_result(
    database, monkeypatch, deferred_status, expected_warning, expected_failures,
):
    put_job(database, job_id="22222222-2222-4222-8222-222222222222", country="PT")
    configure_classifier(monkeypatch, ClassificationModel(country="PT"))
    assert refresh(database).direct_results == 1
    state = SqliteCompensationRefreshStateRepository(database)
    deferred_slice = state.discover_active_job_slices("local").slices[0]
    if deferred_status != "fresh":
        lease, = state.claim_due(
            (deferred_slice,), owner="other-owned-refresh", now=NOW,
            lease_expires_at="2026-08-12T09:00:00Z", force=True,
        )
        if deferred_status == "failed":
            state.mark_failed(
                lease, completed_at=NOW, retry_at="2026-08-12T09:00:00Z",
                error_code="reported_sources_unavailable",
            )
    before = state.get(deferred_slice)
    assert before.last_direct_fact_id is not None
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel(country="ES"))

    result = refresh(database, rows=[observation(source_url="https://example.org/es-snapshot")])

    assert result.status == ("completed_with_warnings" if expected_warning else "succeeded")
    assert result.warnings == ((expected_warning,) if expected_warning else ())
    assert result.slices_claimed == 1
    assert result.direct_results == 1
    assert result.failed_results == expected_failures
    assert state.get(deferred_slice) == before


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
    deferred = refresh(database, now="2026-08-20T07:59:59Z", load=unavailable)
    assert deferred.status == "completed_with_warnings"
    assert deferred.failed_results == 1
    assert deferred.warnings == ("compensation_refresh_failed_backoff",)
    assert database.execute("SELECT last_direct_fact_id FROM compensation_market_refresh_state").fetchone()[0] == before


def test_expired_refresh_lease_cannot_publish_slice_result(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    with pytest.raises(StaleCompensationRefreshLease):
        refresh(database, clock=lambda: "2026-08-12T09:00:01Z")
    row = database.execute(
        "SELECT refresh_status,last_direct_fact_id FROM compensation_market_refresh_state"
    ).fetchone()
    assert tuple(row) == ("refreshing", None)


def test_live_classification_renews_ownership_without_changing_source_decisions(database, monkeypatch):
    import threading
    from datetime import datetime, timedelta

    put_job(database)
    clock = [datetime.fromisoformat(NOW.replace("Z", "+00:00"))]
    lock = threading.Lock()
    barrier = threading.Barrier(2)
    renewals = []
    original = SqliteCompensationRefreshStateRepository.renew_leases

    def renew(repository, leases, **kwargs):
        result = original(repository, leases, **kwargs)
        renewals.append(result)
        return result

    class Model(ClassificationModel):
        def chat_json(self, *args, **kwargs):
            barrier.wait(timeout=3)
            with lock:
                clock[0] += timedelta(minutes=15)
            return super().chat_json(*args, **kwargs)

    model = Model()
    configure_classifier(monkeypatch, model)
    monkeypatch.setattr(SqliteCompensationRefreshStateRepository, "renew_leases", renew)
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=2),
    )
    result = refresh(
        database, rows=[observation(source_url=f"https://example.org/renew/{i}") for i in range(6)],
        clock=lambda: clock[0].isoformat(),
    )
    assert clock[0].hour == 9 and clock[0].minute == 30
    assert renewals and result.direct_results == 1 and result.failed_results == 0
    assert len(model.calls) == 6
    state = database.execute(
        "SELECT refresh_status,lease_owner,last_direct_fact_id FROM compensation_market_refresh_state",
    ).fetchone()
    assert state[0] == "succeeded" and state[1] is None and state[2]


def test_lease_renewal_is_atomic_and_never_resurrects_a_stale_owner(database):
    put_job(database)
    put_job(database, job_id="22222222-2222-4222-8222-222222222222", country="PT")
    repository = SqliteCompensationRefreshStateRepository(database)
    slices = repository.discover_active_job_slices("local").slices
    assert len(slices) == 2
    repository.ensure_slices(slices, now=NOW)
    leases = repository.claim_due(slices, owner="owned-renewal", now=NOW, lease_expires_at="2026-08-12T09:00:00Z")
    renewed = repository.renew_leases(leases, now="2026-08-12T08:30:00Z", lease_expires_at="2026-08-12T09:30:00Z")
    assert [lease.token for lease in renewed] == [lease.token for lease in leases]
    with pytest.raises(StaleCompensationRefreshLease):
        repository.check_current(leases, now="2026-08-12T08:30:00Z")
    database.execute(
        "UPDATE compensation_market_refresh_state SET lease_owner='replacement' WHERE country_code=?",
        (renewed[-1].benchmark_slice.geography.country_code,),
    )
    database.commit()
    before = [repository.get(item) for item in slices]
    with pytest.raises(StaleCompensationRefreshLease):
        repository.renew_leases(renewed, now="2026-08-12T08:45:00Z", lease_expires_at="2026-08-12T09:45:00Z")
    assert [repository.get(item) for item in slices] == before
    with pytest.raises(StaleCompensationRefreshLease):
        repository.renew_leases((renewed[0],), now="2026-08-12T09:31:00Z", lease_expires_at="2026-08-12T10:31:00Z")
    assert [repository.get(item) for item in slices] == before


def test_source_phase_cancellation_releases_ownership_before_classification(database, monkeypatch):
    import threading
    from jobctrl.infrastructure.compensation.automatic_refresh import run_automatic_compensation_refresh

    put_job(database)
    model = ClassificationModel()
    configure_classifier(monkeypatch, model)
    cancel = threading.Event()

    def load(_targets):
        cancel.set()
        return ReportedCompensationSourceLoad(observations=(observation(),))

    with pytest.raises(DeterminationFailure) as error:
        run_automatic_compensation_refresh(
            database, tenant_id="local", owner="owned-source-stop", now=NOW,
            load_observations=load, load_fx_rates=lambda: (), load_price_levels=lambda: (),
            completion_clock=lambda: NOW, cancel_event=cancel,
        )
    assert error.value.code == "compensation_refresh_canceled" and model.calls == []
    assert tuple(database.execute(
        "SELECT refresh_status,last_error_code,lease_owner FROM compensation_market_refresh_state",
    ).fetchone()) == ("failed", "compensation_refresh_canceled", None)


def test_forced_refresh_is_bounded_to_a_current_slice(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    slices = SqliteCompensationRefreshStateRepository(database).discover_active_job_slices("local").slices
    assert refresh(database, now="2026-08-13T08:00:00Z", force=slices).slices_claimed == 1
    with pytest.raises(ValueError, match="one to five"):
        refresh(database, force=())
