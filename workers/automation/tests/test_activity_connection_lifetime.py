"""An idle activity pool must not retain SQLite's writer or lose accepted data."""

import asyncio
import sqlite3
import threading
from types import SimpleNamespace

import pytest

from jobctrl.database import close_connection, get_connection
from jobctrl.infrastructure.temporal import finalize
from jobctrl.infrastructure.temporal.run_in_activity import ActivityThreadPoolExecutor


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["failure", "unfinished_success", "committed_success"])
async def test_default_blocking_executor_releases_activity_writer(tmp_path, monkeypatch, outcome):
    from jobctrl.infrastructure.temporal import run_in_activity

    path = tmp_path / "default-executor.db"
    with sqlite3.connect(path) as setup:
        setup.execute("CREATE TABLE proof (value TEXT)")
        setup.execute("INSERT INTO proof VALUES ('accepted artifact')")
    monkeypatch.setattr(run_in_activity, "_ACTIVITY_EXECUTOR", None)
    monkeypatch.setattr("temporalio.activity.heartbeat", lambda *_args: None)
    monkeypatch.setattr("temporalio.activity.info", lambda: SimpleNamespace(activity_type="synthetic"))

    def run():
        conn = get_connection(path)
        conn.execute("INSERT INTO proof VALUES ('attempt')")
        if outcome == "failure":
            raise RuntimeError("synthetic provider failure")
        if outcome == "committed_success":
            conn.commit()
        return "complete"

    if outcome == "committed_success":
        assert await run_in_activity.run_blocking_with_heartbeat(run, starting_message="synthetic") == "complete"
    else:
        message = "synthetic provider failure" if outcome == "failure" else "activity_transaction_unfinished"
        with pytest.raises(RuntimeError, match=message):
            await run_in_activity.run_blocking_with_heartbeat(run, starting_message="synthetic")
    with sqlite3.connect(path, timeout=0.1) as peer:
        peer.execute("INSERT INTO proof VALUES ('independent heartbeat')")
        peer.commit()
        rows = [row[0] for row in peer.execute("SELECT value FROM proof")]
        assert rows == ["accepted artifact", *(["attempt"] if outcome == "committed_success" else []), "independent heartbeat"]


@pytest.mark.parametrize("outcome", ["failure", "unfinished_success", "committed_success"])
def test_reused_activity_thread_releases_writer_and_preserves_committed_data(tmp_path, outcome):
    path = tmp_path / "activity.db"
    with sqlite3.connect(path) as setup:
        setup.execute("CREATE TABLE proof (value TEXT)")
        setup.execute("INSERT INTO proof VALUES ('accepted artifact')")
    peer = sqlite3.connect(path, timeout=0.1)

    def run():
        conn = get_connection(path)
        conn.execute("INSERT INTO proof VALUES ('attempt')")
        if outcome == "failure":
            raise RuntimeError("synthetic provider failure")
        if outcome == "committed_success":
            conn.commit()
        return "complete"

    try:
        with ActivityThreadPoolExecutor(max_workers=1) as pool:
            for attempt in range(3):
                pending = pool.submit(run)
                if outcome == "committed_success":
                    assert pending.result(timeout=5) == "complete"
                else:
                    message = "synthetic provider failure" if outcome == "failure" else "activity_transaction_unfinished"
                    with pytest.raises(RuntimeError, match=message):
                        pending.result(timeout=5)
                peer.execute("INSERT INTO proof VALUES ('independent heartbeat')")
                peer.commit()
                rows = [row[0] for row in peer.execute("SELECT value FROM proof")]
                assert rows.count("accepted artifact") == 1
                assert rows.count("independent heartbeat") == attempt + 1
                assert rows.count("attempt") == (attempt + 1 if outcome == "committed_success" else 0)
    finally:
        peer.close()


@pytest.mark.parametrize("failure_phase", ["event", "projection"])
def test_lifecycle_failure_releases_writer_before_activity_retry(tmp_path, monkeypatch, failure_phase):
    path = tmp_path / "lifecycle.db"
    with sqlite3.connect(path) as setup:
        setup.execute("CREATE TABLE proof (value TEXT)")
        setup.execute("INSERT INTO proof VALUES ('accepted artifact')")
    monkeypatch.setattr("jobctrl.database.DB_PATH", path)
    monkeypatch.setattr(
        "jobctrl.infrastructure.temporal.runtime_guard.assert_activity_runtime",
        lambda **_kwargs: None,
    )

    def fail_after_write(conn, *_args, **_kwargs):
        conn.execute("INSERT INTO proof VALUES ('lifecycle event')")
        if failure_phase == "event":
            raise RuntimeError("synthetic lifecycle failure")

    def fail_projection(_self):
        raise RuntimeError("synthetic lifecycle failure")

    monkeypatch.setattr("jobctrl.state.record_job_event", fail_after_write)
    monkeypatch.setattr(
        "jobctrl.infrastructure.projections.projection_builder.ProjectionBuilder.refresh",
        fail_projection,
    )
    peer = sqlite3.connect(path, timeout=0.1)
    try:
        with pytest.raises(RuntimeError, match="synthetic lifecycle failure"):
            finalize._emit(None, None, SimpleNamespace(event_type="WorkflowFailed", payload={}))
        peer.execute("INSERT INTO proof VALUES ('independent heartbeat')")
        peer.commit()
        expected = ["accepted artifact"]
        if failure_phase == "projection":
            expected.append("lifecycle event")
        assert [row[0] for row in peer.execute("SELECT value FROM proof")] == [*expected, "independent heartbeat"]
    finally:
        close_connection(path)
        peer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("marker", ["start", "outcome"])
async def test_lifecycle_sqlite_wait_does_not_block_activity_event_loop(monkeypatch, marker):
    entered = threading.Event()
    release = threading.Event()
    writer_threads = []

    def emit(*_args):
        writer_threads.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2), "activity event loop could not release the writer"

    monkeypatch.setattr(finalize, "_emit", emit)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.run_in_activity._ACTIVITY_EXECUTOR", None)
    monkeypatch.setattr("temporalio.activity.heartbeat", lambda *_args: None)
    monkeypatch.setattr("temporalio.activity.info", lambda: SimpleNamespace(activity_type="lifecycle"))
    if marker == "start":
        pending = asyncio.create_task(
            finalize.record_workflow_started(finalize.WorkflowStartedInput("local", "synthetic", "SyntheticWorkflow"))
        )
    else:
        pending = asyncio.create_task(
            finalize.record_workflow_outcome(
                finalize.WorkflowOutcomeInput("local", "synthetic", "SyntheticWorkflow", "succeeded")
            )
        )
    try:
        assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 2), timeout=3)
        assert len(writer_threads) == 1
        assert writer_threads[0] != threading.get_ident()
        release.set()
        await asyncio.wait_for(pending, timeout=3)
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)
