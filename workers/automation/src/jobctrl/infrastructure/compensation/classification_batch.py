"""Bound independent provider-row determinations with thread-owned connections."""
from __future__ import annotations

import contextvars
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

from jobctrl.database import close_thread_connections, get_connection
from jobctrl.domain.compensation.classification import ModelBenchmarkClassifier
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.llm.attempt_admission import model_attempt_admission


class _Stop:
    def __init__(self, cancel_event):
        self._lock = threading.Lock()
        self.error: BaseException | None = None
        self.cancel_event = cancel_event

    def abort(self, error):
        with self._lock:
            if self.error is None:
                self.error = error

    def check(self):
        with self._lock:
            error = self.error
        if error is not None:
            raise error
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise DeterminationFailure("compensation_refresh_canceled")


def classify_batch(connection, observations, dependencies, *, capacity, execution_guard, on_abort, cancel_event):
    """Only the coordinator may invoke a guard that owns a SQLite connection."""
    if connection.in_transaction:
        raise DeterminationFailure("classification_transaction_unfinished")
    database = connection.execute("PRAGMA database_list").fetchone()[2]
    if not database:
        raise DeterminationFailure("classification_database_unavailable")
    database = Path(database).resolve()
    stop = _Stop(cancel_event)
    results = {}

    def check():
        stop.check()
        if execution_guard is not None:
            execution_guard()

    def leaf(key, observation):
        try:
            stop.check()
            conn = get_connection(database)
            deps = dict(dependencies, repository=SqliteDeterminationRepository(conn), on_terminal_failure=stop.abort)
            preflight = deps["preflight"]

            def guarded_preflight():
                stop.check()
                return preflight()

            deps["preflight"] = guarded_preflight
            with model_attempt_admission(stop.check):
                stop.check()
                return key, ModelBenchmarkClassifier(**deps).classify(observation)
        except BaseException as error:
            stop.abort(error)
            raise
        finally:
            if close_thread_connections():
                error = DeterminationFailure("classification_transaction_unfinished")
                stop.abort(error)
                raise error

    executor = ThreadPoolExecutor(max_workers=capacity, thread_name_prefix="jobctrl-compensation-classification")
    pending = set()
    submitted = []
    items = iter(observations.items())

    def submit_next():
        check()
        try:
            key, row = next(items)
        except StopIteration:
            return
        future = executor.submit(contextvars.copy_context().run, leaf, key, row)
        pending.add(future)
        submitted.append(future)

    try:
        for _ in range(min(capacity, len(observations))):
            submit_next()
        while pending:
            check()
            done, _ = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
            for future in done:
                pending.remove(future)
                key, result = future.result()
                results[key] = result
                submit_next()
        check()
        return results
    except BaseException as error:
        stop.abort(error)
        for future in pending:
            future.cancel()
        # Release publication ownership on its coordinator thread before
        # waiting for admitted model calls to settle and account usage.
        if on_abort is not None:
            on_abort(error)
        raise
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
        for future in submitted:
            try:
                future.result()
            except BaseException:
                pass  # Preserve the group's original failure after draining.
