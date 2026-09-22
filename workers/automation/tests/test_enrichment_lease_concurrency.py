"""Bounded concurrency evidence for enrichment execution leases."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import multiprocessing
from pathlib import Path
import queue
import sqlite3
import threading
import time
import traceback

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.enrichment import StaleEnrichmentExecutionLease
from jobctrl.infrastructure.enrichment.execution_lease import (
    claim_enrichment_execution_lease,
    fence_enrichment_execution_lease,
)

_PROCESS_DEADLINE = 8.0


def _claim(conn, owner, *, run_id, phase=1, attempt=1):
    return claim_enrichment_execution_lease(
        conn,
        DiscoveryExecutionRef(
            tenant_id="local",
            workflow_id="lease-concurrency-fixture",
            temporal_run_id=run_id,
        ),
        owner_token=owner,
        activity_phase=phase,
        activity_attempt=attempt,
    )


def _writer_wait_probe(path):
    holder = sqlite3.connect(path, timeout=1)
    claimant = sqlite3.connect(path, timeout=1)
    try:
        claimant.execute("PRAGMA busy_timeout=80")
        holder.execute("BEGIN IMMEDIATE")
        started = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            _claim(claimant, "blocked", run_id="writer-wait")
        elapsed = time.monotonic() - started
        holder.rollback()
        recovered = _claim(claimant, "recovered", run_id="writer-wait")
        return elapsed, recovered.activity_attempt
    finally:
        if holder.in_transaction:
            holder.rollback()
        claimant.close()
        holder.close()


def _exclusive_owner_probe(path):
    barrier = threading.Barrier(3)
    results = []

    def contend(owner):
        conn = sqlite3.connect(path, timeout=2)
        conn.execute("PRAGMA busy_timeout=2000")
        try:
            barrier.wait(timeout=2)
            try:
                lease = _claim(conn, owner, run_id="same-key")
            except StaleEnrichmentExecutionLease:
                results.append((owner, "stale", None))
            else:
                results.append((owner, "claimed", lease))
        finally:
            conn.close()

    threads = [threading.Thread(target=contend, args=(owner,)) for owner in ("a", "b")]
    for thread in threads:
        thread.start()
    barrier.wait(timeout=2)
    for thread in threads:
        thread.join(timeout=3)
    assert not any(thread.is_alive() for thread in threads)
    assert sorted(outcome for _owner, outcome, _lease in results) == ["claimed", "stale"]
    winner = next(lease for _owner, outcome, lease in results if outcome == "claimed")

    conn = sqlite3.connect(path, timeout=2)
    try:
        newer = _claim(conn, "newer", run_id="same-key", attempt=2)
        with pytest.raises(StaleEnrichmentExecutionLease):
            fence_enrichment_execution_lease(conn, winner)
        terminal = _claim(conn, "terminal", run_id="same-key", phase=2)
        with pytest.raises(StaleEnrichmentExecutionLease):
            _claim(conn, "delayed-live", run_id="same-key", attempt=99)
        count = conn.execute(
            "SELECT COUNT(*) FROM job_events "
            "WHERE entity_kind = 'discovery_enrichment_lease'"
        ).fetchone()[0]
        return newer.activity_attempt, terminal.activity_phase, count
    finally:
        conn.close()


def _worker_pool_probe(path):
    from jobctrl import config, database
    from jobctrl.enrichment.activities import EnrichActivityInput, _claim_activity_enrichment_lease

    config.DB_PATH = path
    database.DB_PATH = path
    payload = EnrichActivityInput(
        tenant_id="local",
        workflow_id="lease-concurrency-fixture",
        workflow_run_id="worker-pool",
    )
    pool = ThreadPoolExecutor(max_workers=1)

    def claim(attempt):
        lease = _claim_activity_enrichment_lease(
            payload,
            activity_attempt=attempt,
            activity_owner_token=f"worker-{attempt}",
        )
        conn = database.get_connection()
        return (
            threading.get_ident(),
            id(conn),
            conn.execute("PRAGMA busy_timeout").fetchone()[0],
            lease.activity_attempt,
        )

    try:
        first = pool.submit(claim, 1).result(timeout=3)
        second = pool.submit(claim, 2).result(timeout=3)
        pool.submit(database.close_connection, path).result(timeout=3)
        return first, second
    finally:
        # This probe is itself killable at the process deadline; never let a
        # ThreadPoolExecutor context manager join a wedged SQLite call.
        pool.shutdown(wait=False, cancel_futures=True)


def _injected_connection_probe(path):
    from jobctrl.enrichment.activities import EnrichActivityInput, _claim_activity_enrichment_lease

    payload = EnrichActivityInput(
        tenant_id="local",
        workflow_id="lease-concurrency-fixture",
        workflow_run_id="injected",
    )
    wrong_thread_error = []
    default = sqlite3.connect(path)

    def claim_default():
        try:
            _claim_activity_enrichment_lease(
                payload,
                activity_attempt=1,
                activity_owner_token="wrong-thread",
                conn=default,
            )
        except BaseException as exc:
            wrong_thread_error.append((type(exc).__name__, str(exc)))

    thread = threading.Thread(target=claim_default)
    thread.start()
    thread.join(timeout=2)
    assert not thread.is_alive()
    default.close()

    shared = sqlite3.connect(path, timeout=1, check_same_thread=False)
    shared.execute("PRAGMA busy_timeout=1")
    entered = threading.Event()
    release = threading.Event()
    started = threading.Event()
    done = threading.Event()
    result = []

    def block():
        entered.set()
        assert release.wait(timeout=2)
        return 1

    shared.create_function("block_until_released", 0, block)
    holder = threading.Thread(
        target=lambda: shared.execute("SELECT block_until_released()").fetchone()
    )

    def claim_shared():
        started.set()
        lease = _claim_activity_enrichment_lease(
            payload,
            activity_attempt=1,
            activity_owner_token="shared",
            conn=shared,
        )
        result.append(lease.activity_attempt)
        done.set()

    claimant = threading.Thread(target=claim_shared)
    holder.start()
    assert entered.wait(timeout=2)
    claimant.start()
    assert started.wait(timeout=2)
    completed_while_held = done.wait(timeout=0.1)
    release.set()
    holder.join(timeout=2)
    claimant.join(timeout=2)
    assert not holder.is_alive() and not claimant.is_alive()
    shared.close()
    return wrong_thread_error, completed_while_held, result


_PROBES = {
    "writer": _writer_wait_probe,
    "owners": _exclusive_owner_probe,
    "pool": _worker_pool_probe,
    "injected": _injected_connection_probe,
}


def _child(result_queue, name, path):
    try:
        result_queue.put(("ok", _PROBES[name](Path(path))))
    except BaseException:
        result_queue.put(("error", traceback.format_exc()))


def _isolated(name, path):
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()
    process = context.Process(target=_child, args=(result_queue, name, str(path)))
    process.start()
    process.join(timeout=_PROCESS_DEADLINE)
    if process.is_alive():
        process.terminate()
        process.join(timeout=2)
        pytest.fail(f"{name} exceeded the {_PROCESS_DEADLINE:g}s process deadline")
    try:
        status, result = result_queue.get(timeout=1)
    except queue.Empty:
        pytest.fail(f"{name} exited with code {process.exitcode} without evidence")
    finally:
        result_queue.close()
        result_queue.join_thread()
    assert process.exitcode == 0
    assert status == "ok", result
    return result


@pytest.fixture
def database_path(tmp_path):
    path = tmp_path / "lease-concurrency.db"
    init_db(path)
    close_connection(path)
    return path


def test_database_open_paths_have_bounded_wait_budgets(tmp_path):
    path = tmp_path / "timeouts.db"
    created = init_db(path)
    assert created.execute("PRAGMA busy_timeout").fetchone()[0] == 10_000
    close_connection(path)
    admitted = init_db(path)
    assert admitted.execute("PRAGMA busy_timeout").fetchone()[0] == 30_000
    close_connection(path)


def test_separate_writer_wait_is_bounded_and_recovers(database_path):
    elapsed, attempt = _isolated("writer", database_path)
    # The process deadline is the hard guard. This broad lower bound proves
    # the 80ms fixture wait was observed, not a production latency promise.
    assert 0.02 <= elapsed < _PROCESS_DEADLINE
    assert attempt == 1


def test_concurrent_same_key_claims_preserve_semantic_fencing(database_path):
    newer_attempt, terminal_phase, event_count = _isolated("owners", database_path)
    assert (newer_attempt, terminal_phase, event_count) == (2, 2, 3)


def test_worker_pool_reuses_its_thread_local_connection(database_path):
    first, second = _isolated("pool", database_path)
    assert first[:3] == second[:3]
    assert first[2] == 10_000
    assert (first[3], second[3]) == (1, 2)


def test_injected_connection_diagnostic_separates_mutex_from_busy_wait(database_path):
    wrong_thread, completed_while_held, shared_result = _isolated(
        "injected", database_path
    )
    assert wrong_thread[0][0] == "ProgrammingError"
    assert "created in a thread" in wrong_thread[0][1]
    assert completed_while_held is False
    assert shared_result == [1]
