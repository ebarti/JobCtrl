"""Bound independent letter reviews without sharing SQLite connections.

The coordinator is never a member of this pool. Already-admitted SDK work is
allowed to settle and account usage; cancellation rejects subsequent review
attempts and no partial pair can become an accepted artifact.
"""
from __future__ import annotations

import atexit
import contextvars
import os
import threading
from concurrent.futures import ThreadPoolExecutor, wait
from copy import deepcopy
from pathlib import Path

from jobctrl.database import close_thread_connections, get_connection
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.ports.letter_reviews import LetterReviewResults
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.llm.attempt_admission import model_attempt_admission


class _ReviewStop:
    def __init__(self):
        self._lock = threading.Lock()
        self._stopped = threading.Event()
        self.error: BaseException | None = None

    def abort(self, error: BaseException) -> None:
        with self._lock:
            if self.error is None:
                self.error = error
            self._stopped.set()

    def check(self) -> None:
        with self._lock:
            if self._stopped.is_set():
                raise DeterminationFailure("review_canceled")


class LetterReviewPool:
    """At most ``capacity`` active review leaves across every letter pair."""

    def __init__(self, capacity: int):
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 1:
            raise ValueError("letter review capacity must be a positive integer")
        self.capacity = capacity
        self._executor = ThreadPoolExecutor(max_workers=capacity, thread_name_prefix="jobctrl-letter-review")
        self._lock = threading.Condition()
        self._groups: set[_ReviewStop] = set()
        self._closed = False
        self._drained = False

    def review(self, claims, quality, execution_guard):
        if execution_guard is not None:
            execution_guard()
        stop = _ReviewStop()
        while True:
            if execution_guard is not None:
                execution_guard()
            with self._lock:
                if self._closed:
                    raise DeterminationFailure("review_canceled")
                # At most N pairs / 2N leaves outstanding, including canceled
                # pairs whose admitted sibling is still settling.
                if len(self._groups) < self.capacity:
                    self._groups.add(stop)
                    futures = [self._executor.submit(contextvars.copy_context().run, fn, stop) for fn in (claims, quality)]
                    break
                self._lock.wait(timeout=0.1)
        try:
            pending = set(futures)
            while pending:
                if execution_guard is not None:
                    execution_guard()  # Always on the owning coordinator thread.
                stop.check()
                _, pending = wait(pending, timeout=0.1)
            if execution_guard is not None:
                execution_guard()
            stop.check()
            return LetterReviewResults(*(future.result() for future in futures))
        except BaseException as failure:
            error = stop.error or failure
            stop.abort(error)
            for future in futures:
                future.cancel()
            raise error
        finally:
            # Do not release a request's resources or close runtimes while its
            # admitted sibling is still persisting/recording usage.
            for future in futures:
                try:
                    future.result()
                except BaseException:
                    pass  # Preserve the pair's original failure, including cancellation.
            with self._lock:
                self._groups.discard(stop)
                self._lock.notify_all()

    def close(self):
        with self._lock:
            self._closed = True
            for group in self._groups:
                group.abort(DeterminationFailure("review_canceled"))
            self._lock.notify_all()
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._lock:
            self._drained = True
            self._lock.notify_all()


_pool_lock = threading.Lock()
_pool: tuple[int, LetterReviewPool] | None = None


def configure_letter_reviews(capacity: int) -> LetterReviewPool:
    """Capture worker capacity; a running process never silently resizes it."""
    global _pool
    with _pool_lock:
        if _pool is None or _pool[0] != os.getpid():
            _pool = (os.getpid(), LetterReviewPool(capacity))
        elif _pool[1]._closed:
            if not _pool[1]._drained:
                raise DeterminationFailure("review_canceled")
            # Only an explicit new worker/test scope may reopen after shutdown.
            _pool = (os.getpid(), LetterReviewPool(capacity))
        elif _pool[1].capacity != capacity:
            raise RuntimeError("letter review capacity changed before shutdown")
        return _pool[1]


def _letter_review_pool() -> LetterReviewPool:
    with _pool_lock:
        current = _pool
    if current is not None and current[0] == os.getpid():
        return current[1]
    from jobctrl.infrastructure.temporal.concurrency import resolve_max_concurrent_activities
    return configure_letter_reviews(resolve_max_concurrent_activities().value)


def close_letter_reviews() -> None:
    global _pool
    with _pool_lock:
        current = _pool
    if current is not None and current[0] == os.getpid():
        current[1].close()


class ParallelLetterReviews:
    def __init__(self, database: Path, dependencies: dict):
        self._database = database
        # Model, effort and product lane are captured by the constructed adapter.
        self._dependencies = {key: value for key, value in dependencies.items() if key != "repository"}

    def review(self, *, claim_request, quality_request, execution_guard=None):
        # Separate copies prevent either review from modifying its peer's inputs.
        claims, quality = deepcopy(claim_request), deepcopy(quality_request)

        def leaf(kind, request, stop):
            try:
                stop.check()
                from jobctrl.database import DB_PATH

                if self._database != Path(DB_PATH).resolve():
                    raise DeterminationFailure("review_database_mismatch")
                conn = get_connection(self._database)
                deps = dict(self._dependencies, repository=SqliteDeterminationRepository(conn), on_terminal_failure=stop.abort)
                budget_preflight = deps["preflight"]

                def preflight():
                    stop.check()
                    return budget_preflight()

                deps["preflight"] = preflight
                with model_attempt_admission(stop.check):
                    stop.check()
                    if kind == "claims":
                        return ModelClaimVerifier(**deps).verify(**request)
                    return ModelArtifactQualityJudge(**deps).judge(**request)
            except BaseException as error:
                stop.abort(error)
                raise
            finally:
                if close_thread_connections():
                    # Never commit an unfinished writer when a pool thread is reused.
                    stop.abort(RuntimeError("review_transaction_unfinished"))

        return _letter_review_pool().review(
            lambda stop: leaf("claims", claims, stop),
            lambda stop: leaf("quality", quality, stop),
            execution_guard,
        )


atexit.register(close_letter_reviews)
