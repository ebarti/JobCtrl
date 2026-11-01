"""Owned source-bound classification concurrency, not model quality evaluation."""
from concurrent.futures import ThreadPoolExecutor
import threading
from types import SimpleNamespace

import pytest

from jobctrl.database import close_connection, close_thread_connections, get_connection, init_db
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.compensation.automatic_refresh import run_automatic_compensation_refresh
from jobctrl.infrastructure.compensation.interpretation import classify_observations
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.compensation.sqlite_market_repository import ReportedCompensationSourceLoad
from jobctrl.llm_lanes import current_llm_lane
from tests.compensation_fakes import ClassificationModel, FRESH, configure_classifier, dependencies, observation, put_job, refresh


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "classification.sqlite"
    conn = init_db(path)
    yield conn
    close_connection(path)


def test_independent_rows_overlap_with_the_configured_capacity(database, monkeypatch):
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=2),
    )
    coordinator = threading.get_ident()
    barrier = threading.Barrier(2)
    lock = threading.Lock()
    active = maximum = 0
    threads = set()

    class Model(ClassificationModel):
        def chat_json(self, *args, **kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                threads.add(threading.get_ident())
            try:
                barrier.wait(timeout=3)
                return super().chat_json(*args, **kwargs)
            finally:
                with lock:
                    active -= 1

    model = Model()
    rows = tuple(observation(source_url=f"https://example.test/source/{index}") for index in range(4))
    results = classify_observations(
        database, rows, tenant_id="local", dependencies=dependencies(database, model, "compensation"),
    )
    assert maximum == 2 and coordinator not in threads
    assert len(model.calls) == len(results) == 4
    assert [row.source_url for row in results] == [row.source_url for row in rows]
    repository = SqliteDeterminationRepository(database)
    for row in results:
        accepted = repository.find("local", row.determination_id)
        assert accepted is not None and accepted.entity_id == row.classification_entity_id
        assert accepted.kind == "benchmark_classification" and accepted.lane == "compensation"
        assert row.classification is not None


def test_duplicate_and_cached_provider_identity_do_not_repeat_model_work(database, monkeypatch):
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=2),
    )
    model = ClassificationModel()
    rows = (observation(), observation(minimum=65000), observation(source_url="https://example.test/other"))
    deps = dependencies(database, model, "compensation")
    first = classify_observations(database, rows, tenant_id="local", dependencies=deps)
    assert len(model.calls) == 2
    assert first[0].determination_id == first[1].determination_id
    assert first[0].minimum_amount != first[1].minimum_amount
    second = classify_observations(database, rows, tenant_id="local", dependencies=deps)
    assert len(model.calls) == 2
    assert [row.determination_id for row in first] == [row.determination_id for row in second]


def test_spend_preflight_rejects_the_batch_before_any_model_call(database, monkeypatch):
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=2),
    )
    model = ClassificationModel()
    deps = dependencies(database, model, "compensation")
    checked = []

    def denied():
        checked.append(current_llm_lane())
        raise DeterminationFailure("budget_denied")

    deps["preflight"] = denied
    aborted = []
    with pytest.raises(DeterminationFailure) as error:
        classify_observations(
            database, tuple(observation(source_url=f"https://example.test/{i}") for i in range(4)),
            tenant_id="local", dependencies=deps, on_abort=aborted.append,
        )
    assert error.value.code == "budget_denied" and checked and set(checked) == {"compensation"}
    assert model.calls == [] and len(aborted) == 1
    assert database.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0
    database.execute("BEGIN IMMEDIATE")
    database.rollback()


def test_cancel_releases_refresh_before_admitted_calls_drain_and_preserves_range(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    before = tuple(database.execute(
        "SELECT last_direct_fact_id,last_result_kind FROM compensation_market_refresh_state",
    ).fetchone())
    path = database.execute("PRAGMA database_list").fetchone()[2]
    cancel = threading.Event()
    started = threading.Event()
    release = threading.Event()
    lock = threading.Lock()
    active = 0

    class Model(ClassificationModel):
        def chat_json(self, *args, **kwargs):
            nonlocal active
            with lock:
                active += 1
                if active == 2:
                    started.set()
            assert release.wait(timeout=5)
            return super().chat_json(*args, **kwargs)

    model = Model()
    configure_classifier(monkeypatch, model)
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.concurrency.resolve_max_concurrent_activities",
        lambda: SimpleNamespace(value=2),
    )

    def run():
        conn = get_connection(path)
        try:
            return run_automatic_compensation_refresh(
                conn, tenant_id="local", owner="owned-cancellation", now=FRESH,
                load_observations=lambda _targets: ReportedCompensationSourceLoad(observations=tuple(
                    observation(source_url=f"https://example.test/cancel/{i}") for i in range(6)
                )),
                load_fx_rates=lambda: (), load_price_levels=lambda: (),
                completion_clock=lambda: FRESH, cancel_event=cancel,
            )
        finally:
            close_thread_connections()

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(run)
            assert started.wait(timeout=5)
            cancel.set()
            # A second owned connection observes release while the admitted
            # source-bound model calls remain deliberately held above.
            import time
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                state = database.execute(
                    "SELECT refresh_status,last_error_code,lease_owner FROM compensation_market_refresh_state",
                ).fetchone()
                if tuple(state) == ("failed", "compensation_refresh_canceled", None):
                    break
                time.sleep(0.01)
            assert tuple(state) == ("failed", "compensation_refresh_canceled", None)
            assert not future.done()
            assert tuple(database.execute(
                "SELECT last_direct_fact_id,last_result_kind FROM compensation_market_refresh_state",
            ).fetchone()) == before
            release.set()
            with pytest.raises(DeterminationFailure) as error:
                future.result(timeout=5)
            assert error.value.code == "compensation_refresh_canceled"
    finally:
        release.set()
    assert len(model.calls) == 2
    assert database.execute("SELECT COUNT(*) FROM compensation_direct_benchmark_facts").fetchone()[0] == 1
    assert database.execute("SELECT next_refresh_at FROM compensation_market_refresh_state").fetchone()[0] == FRESH.replace("Z", ".000000Z")
