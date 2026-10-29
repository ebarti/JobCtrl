"""Per-run Apply process, cancellation and resource ownership."""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
import logging
import socket
import subprocess
import threading
from typing import Any, Callable, Iterator
import uuid
from weakref import WeakValueDictionary, ref

from jobctrl import config
from jobctrl.apply.process_birth import ApplyCustodyJournal, CustodyUnverified


log = logging.getLogger(__name__)

_CLEANUP_PASS_TIMEOUT_SECONDS = 10.0

_WORKER_RUNS: dict[int, "ApplyLauncherRun"] = {}
_WORKER_RUNS_LOCK = threading.RLock()


class ApplyLauncherCleanupIncomplete(RuntimeError):
    """Owned cleanup remains unresolved; its exact run custody is retained."""


class ApplyLauncherBusy(RuntimeError):
    """Another launcher still owns this workspace; no Apply claim was made."""


@dataclass
class _StreamClose:
    stream: Any
    done: threading.Event = field(default_factory=threading.Event)
    failure: str | None = None

    def run(self) -> None:
        try:
            self.stream.close()
        except BaseException as exc:
            self.failure = type(exc).__name__
        finally:
            self.done.set()


def _poll_owned_process(process: subprocess.Popen) -> int | None:
    from jobctrl.infrastructure.process_ownership import INSPECTION_DENIED_MESSAGE, ProcessInspectionDenied

    try:
        return process.poll()
    except PermissionError as exc:
        raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc


@dataclass
class ApplyLauncherRun:
    identity: str = field(default_factory=lambda: uuid.uuid4().hex)
    stop_event: threading.Event = field(default_factory=threading.Event)
    worker_ids: tuple[int, ...] = ()
    ports: tuple[int, ...] = ()
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    _cancel_guard: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _cleanup_guard: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _worker_cleanup_guards: WeakValueDictionary = field(default_factory=WeakValueDictionary, repr=False)
    _cleanup_failed: threading.Event = field(default_factory=threading.Event, repr=False)
    _inspection_denied: threading.Event = field(default_factory=threading.Event, repr=False)
    _signal_denied: threading.Event = field(default_factory=threading.Event, repr=False)
    _cleanup_failure_token: tuple | None = field(default=None, init=False, repr=False)
    _birth_epoch: int = field(default=0, init=False, repr=False)
    _cleanup_error: str | None = field(default=None, init=False, repr=False)
    _cancel_thread: threading.Thread | None = field(default=None, init=False, repr=False)
    _finishing: bool = field(default=False, init=False, repr=False)
    _admitted: bool = field(default=False, init=False, repr=False)
    _cleanup_done: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _journal: ApplyCustodyJournal | None = field(default=None, init=False, repr=False)
    _birth_processes: dict = field(default_factory=dict, init=False, repr=False)
    _stream_closures: dict = field(default_factory=dict, init=False, repr=False)

    @contextmanager
    def lease(self) -> Iterator[None]:
        """Own one fresh manifest; peers are independently admitted."""
        from jobctrl.apply.native_custody import capture_native_custody
        config.APP_DIR.mkdir(parents=True, exist_ok=True)
        app_dir = config.APP_DIR.resolve(strict=True)
        journal = ApplyCustodyJournal(app_dir, self.identity, native_custody=capture_native_custody(app_dir))
        journal.create()
        with self._lock:
            self._journal = journal
        with self._cancel_guard:
            self._admitted = True
        try:
            yield
        finally:
            try:
                journal.record_cleanup_failure(self._cleanup_error)
                with self._cancel_guard:
                    self._admitted = False
                with _WORKER_RUNS_LOCK:
                    for worker_id in self.worker_ids:
                        if _WORKER_RUNS.get(worker_id) is self:
                            del _WORKER_RUNS[worker_id]
                if not journal.value["births"] and not journal.value["jobs"]:
                    journal.retire()
                if self._cleanup_error is not None:
                    raise ApplyLauncherCleanupIncomplete(self._cleanup_message(
                        "Apply owned cleanup remains unresolved; its files and custody are retained."
                    ))
            finally:
                journal.close_owner()

    def claim(self, tenant_id: str, job_id: str, run_id: str, worker_id: int = 0) -> None:
        with self._lock:
            if not self._admitted or self.stop_event.is_set():
                raise CustodyUnverified("Stopped Apply launcher cannot claim a job")
            self._journal.claim(tenant_id, job_id, run_id, worker_id)

    def allocate_workers(self, count: int) -> None:
        """Use fresh profile/file identities and OS-selected loopback ports.

        Chrome independently refuses an occupied port at launch; selecting an
        available port never authorizes signalling a process that later owns it.
        Hold all reservations together so workers cannot choose the same port.
        """
        reservations: list[socket.socket] = []
        try:
            with self._lock:
                for _ in range(count):
                    reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    reservations.append(reservation)
                    reservation.bind(("127.0.0.1", 0))
                config.APPLY_WORKER_DIR.mkdir(parents=True, exist_ok=True)
                worker_ids = []
                for _ in range(count):
                    while True:
                        # Stay exact in JSON/JavaScript readers. Exclusive
                        # directory creation also fences retained crash files.
                        worker_id = 1024 + (uuid.uuid4().int >> 77)
                        worker_dir = config.APPLY_WORKER_DIR / f"worker-{worker_id}"
                        if (config.CHROME_WORKER_DIR / f"worker-{worker_id}").exists():
                            continue
                        try:
                            worker_dir.mkdir(mode=0o700)
                        except FileExistsError:
                            continue
                        worker_ids.append(worker_id)
                        break
                self.worker_ids += tuple(worker_ids)
                if self._journal is not None:
                    with _WORKER_RUNS_LOCK:
                        for worker_id in self.worker_ids:
                            _WORKER_RUNS[worker_id] = self
                self.ports += tuple(sock.getsockname()[1] for sock in reservations)
        finally:
            for reservation in reservations:
                reservation.close()

    def new_attempt(self) -> tuple[int, int]:
        with self._lock:
            self.allocate_workers(1)
            return self.worker_ids[-1], self.ports[-1]

    def spawn(self, worker_id: int, kind: str, command: list[str], **kwargs) -> subprocess.Popen:
        """Journal before spawn; interrupted publication retains unknown custody."""
        epoch = self._birth_epoch
        if epoch % 2:
            raise CustodyUnverified("Apply process birth was interrupted by cleanup")
        with self._worker_cleanup_guard(worker_id):
            with self._lock:
                if epoch != self._birth_epoch:
                    raise CustodyUnverified("Apply process birth was interrupted by cleanup")
                if self._journal is None or not self._admitted or self.stop_event.is_set():
                    raise CustodyUnverified("Apply process birth has no active run custody")
                binding = self._journal.native_custody
                coalitions = None
                if (binding is not None and binding["scope"].get("purpose") == "apply"
                        and kwargs.get("start_new_session") is True and kwargs.get("preexec_fn") is None):
                    from jobctrl.apply.native_custody import _current_coalitions
                    expected = tuple(binding["scope"]["coalitionIds"])
                    try:
                        if tuple(_current_coalitions()) == expected:
                            coalitions = expected
                    except (CustodyUnverified, OSError):
                        pass  # The original full-inventory proof remains available.
                birth_id = self._journal.reserve(worker_id, kind)
                try:
                    process = subprocess.Popen(command, **kwargs)
                except OSError:
                    self._journal.abort_unspawned(birth_id)
                    raise
                self._birth_processes[birth_id] = (worker_id, process, process.pid)
                process._jobctrl_apply_birth = (ref(self), birth_id, worker_id, process.pid, epoch)
                if coalitions is not None:
                    try:
                        if tuple(_current_coalitions()) == coalitions:
                            # The native receipt and both sides of Popen bind this
                            # child birth to its inherited coalition. This is only
                            # a census fence, never authority to signal or proof
                            # that escaped descendants have exited.
                            process._jobctrl_birth_coalitions = coalitions
                    except (CustodyUnverified, OSError):
                        pass
                return process

    def _publish_birth(self, worker_id: int, process: subprocess.Popen, birth_id: str, launched_pid: int,
                       epoch: int, publish: Callable[[], None]) -> None:
        # Serialize publication against cleanup of this worker, without holding
        # the shared run lock while waiting for an adapter registry.
        with self._worker_cleanup_guard(worker_id):
            with self._lock:
                birth = self._birth_processes.get(birth_id)
                if (not self._admitted or self._journal is None or self.stop_event.is_set()
                        or epoch % 2 or self._birth_epoch != epoch or launched_pid != process.pid
                        or birth is None or birth[0] != worker_id or birth[1] is not process
                        or birth[2] != launched_pid):
                    raise CustodyUnverified("Apply process publication was interrupted by cleanup")
            publish()

    def _cleanup_workers(self, workers: tuple[int, ...]) -> list[str]:
        from jobctrl.infrastructure.process_ownership import cleanup_budget

        # The per-handle proof may wait for transient system census churn.
        # Share one bound across a pass so many handles cannot each consume it.
        with cleanup_budget(_CLEANUP_PASS_TIMEOUT_SECONDS):
            return self._cleanup_workers_within_budget(workers)

    def _worker_cleanup_guard(self, worker_id: int) -> threading.RLock:
        from jobctrl.infrastructure.process_ownership import cleanup_lock

        with cleanup_lock(self._lock):
            guard = self._worker_cleanup_guards.get(worker_id)
            if guard is None:
                guard = threading.RLock()
                self._worker_cleanup_guards[worker_id] = guard
            return guard

    def _close_birth_streams(self, birth_id: str, process: subprocess.Popen) -> None:
        from jobctrl.infrastructure.process_ownership import (
            ProcessOwnershipError, _within_cleanup_budget, cleanup_lock,
        )

        for name in ("stdout", "stderr"):
            stream = getattr(process, name)
            if stream is None:
                continue
            key = (birth_id, name)
            with cleanup_lock(self._lock):
                closing = self._stream_closures.get(key)
                if closing is not None and closing.stream is not stream:
                    raise ProcessOwnershipError("Apply process stream identity changed; ownership retained")
                if closing is None:
                    closing = _StreamClose(stream)
                    self._stream_closures[key] = closing
                    try:
                        threading.Thread(target=closing.run, name="apply-stream-close", daemon=True).start()
                    except Exception:
                        del self._stream_closures[key]
                        raise
            # A reader can hold a buffered stream's lock while a descendant
            # keeps its pipe open. Never wait for close() under the run lock,
            # and reuse the same close worker if a later pass retries.
            if not closing.done.wait(_within_cleanup_budget(_CLEANUP_PASS_TIMEOUT_SECONDS)):
                raise ProcessOwnershipError("Apply process stream did not close; ownership retained")
            if closing.failure is not None:
                with cleanup_lock(self._lock):
                    if self._stream_closures.get(key) is closing:
                        del self._stream_closures[key]
                raise ProcessOwnershipError(f"Apply process stream close failed ({closing.failure}); ownership retained")

    def _cleanup_workers_within_budget(self, workers: tuple[int, ...]) -> list[str]:
        from jobctrl.apply.chrome import cleanup_workers
        from jobctrl.infrastructure.apply.claude_code_cli import kill_active_claude_processes
        from jobctrl.infrastructure.process_ownership import (
            ProcessOwnershipError, _require_cleanup_budget, cleanup_lock, is_process_inspection_denied,
            is_process_signal_denied, terminate_owned_process,
        )

        errors = []
        for worker_id in workers:
            try:
                _require_cleanup_budget()
            except ProcessOwnershipError as exc:
                errors.append(str(exc))
                break
            worker_errors = []
            verified_births = {}
            for cleanup in (
                lambda: kill_active_claude_processes(worker_ids=(worker_id,)),
                lambda: cleanup_workers((worker_id,)),
            ):
                try:
                    cleanup()
                except Exception as exc:
                    log.exception("Apply launcher %s process cleanup failed", self.identity)
                    if is_process_inspection_denied(exc):
                        self._inspection_denied.set()
                    if is_process_signal_denied(exc):
                        self._signal_denied.set()
                    worker_errors.append(str(exc))
            if not worker_errors:
                # Own birth handles cover cancellation before an adapter has
                # registered its process. Never use that fallback to override
                # an adapter's explicit ownership/exit refusal.
                try:
                    with cleanup_lock(self._lock):
                        births = [(birth_id, process, pid)
                                  for birth_id, (owner, process, pid) in self._birth_processes.items()
                                  if owner == worker_id]
                    for birth_id, process, pid in births:
                        try:
                            from jobctrl.runtime import is_bundled_runtime
                            if not is_bundled_runtime() and _poll_owned_process(process) is not None:
                                # The adapter already joined this exact tracked
                                # root. Source best effort does not upgrade that
                                # into a second full-session/tree proof demand.
                                try:
                                    process.wait(timeout=10)
                                except PermissionError as exc:
                                    from jobctrl.infrastructure.process_ownership import (
                                        INSPECTION_DENIED_MESSAGE, ProcessInspectionDenied,
                                    )
                                    raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc
                            else:
                                terminate_owned_process(process, launched_pid=pid)
                            verified_births[birth_id] = (process, pid)
                        except Exception as exc:
                            if is_process_inspection_denied(exc):
                                self._inspection_denied.set()
                            if is_process_signal_denied(exc):
                                self._signal_denied.set()
                            worker_errors.append(str(exc))
                except Exception as exc:
                    if is_process_inspection_denied(exc):
                        self._inspection_denied.set()
                    if is_process_signal_denied(exc):
                        self._signal_denied.set()
                    worker_errors.append(str(exc))
            if not worker_errors:
                for birth_id, (process, _pid) in verified_births.items():
                    try:
                        self._close_birth_streams(birth_id, process)
                    except Exception as exc:
                        worker_errors.append(str(exc))
                        break
            try:
                with cleanup_lock(self._lock):
                    for birth_id, (owner, process, pid) in self._birth_processes.items():
                        proof = verified_births.get(birth_id)
                        if (owner == worker_id and not worker_errors
                                and (proof is None or proof[0] is not process or proof[1] != pid)):
                            worker_errors.append("Apply process was registered during cleanup; ownership retained")
                    for birth_id, (owner, process, _pid) in tuple(self._birth_processes.items()):
                        if owner == worker_id and _poll_owned_process(process) is not None:
                            if not worker_errors:
                                # Release in-memory routing/handles after scoped
                                # cleanup, retaining full-tree custody on disk.
                                del self._birth_processes[birth_id]
                                for name in ("stdout", "stderr"):
                                    self._stream_closures.pop((birth_id, name), None)
            except Exception as exc:
                if is_process_inspection_denied(exc):
                    self._inspection_denied.set()
                if is_process_signal_denied(exc):
                    self._signal_denied.set()
                worker_errors.append(str(exc))
            errors.extend(worker_errors)
        return errors

    def _cleanup_message(self, fallback: str) -> str:
        from jobctrl.infrastructure.process_ownership import (
            INSPECTION_AND_SIGNAL_DENIED_MESSAGE, INSPECTION_DENIED_MESSAGE, SIGNAL_DENIED_MESSAGE,
        )

        inspection_denied, signal_denied = self._inspection_denied.is_set(), self._signal_denied.is_set()
        if inspection_denied and signal_denied:
            return INSPECTION_AND_SIGNAL_DENIED_MESSAGE
        if inspection_denied:
            return INSPECTION_DENIED_MESSAGE
        return SIGNAL_DENIED_MESSAGE if signal_denied else fallback

    def _retain_cleanup_failure(self, error: str) -> None:
        from jobctrl.infrastructure.process_ownership import ProcessOwnershipError, cleanup_lock

        # The run lock may itself be the unavailable resource. Fence claims and
        # retain the error without waiting for that lock; lease() will persist
        # it if this pass cannot acquire the lock to update the journal now.
        self._cleanup_failure_token = (object(), self._inspection_denied.is_set(), self._signal_denied.is_set(), error)
        self.stop_event.set()
        self._cleanup_failed.set()
        self._cleanup_error = error
        try:
            with cleanup_lock(self._lock):
                if self._journal is not None:
                    self._journal.record_cleanup_failure(error)
        except ProcessOwnershipError:
            pass

    def verify_worker_cleanup(self, worker_id: int) -> None:
        """Fence the next claim/reset until this worker's prior exit is proven."""
        from jobctrl.infrastructure.process_ownership import ProcessOwnershipError, cleanup_budget, cleanup_lock

        with cleanup_budget(_CLEANUP_PASS_TIMEOUT_SECONDS):
            try:
                with cleanup_lock(self._worker_cleanup_guard(worker_id)):
                    errors = self._cleanup_workers_within_budget((worker_id,))
                    if not errors:
                        with cleanup_lock(self._lock):
                            if any(owner == worker_id for owner, _process, _pid in self._birth_processes.values()):
                                errors = ["Apply process was registered during cleanup; ownership retained"]
                    if errors:
                        self._retain_cleanup_failure("; ".join(errors))
                    elif self._cleanup_failed.is_set():
                        errors = ["Concurrent Apply cleanup remained unverified"]
            except ProcessOwnershipError as exc:
                errors = [str(exc)]
                self._retain_cleanup_failure(str(exc))
        if errors:
            raise ApplyLauncherCleanupIncomplete(self._cleanup_message(
                "Apply worker cleanup could not verify exit; no further job was claimed and prior runtime files are retained."
            ))

    def interrupt(self) -> bool:
        """Interrupt only this run's agent/browser processes; retain its lease."""
        from jobctrl.infrastructure.process_ownership import (
            ProcessOwnershipError, _require_cleanup_budget, cleanup_budget, cleanup_lock,
        )

        with cleanup_budget(_CLEANUP_PASS_TIMEOUT_SECONDS):
            try:
                with cleanup_lock(self._cleanup_guard):
                    # Odd epochs fence births already waiting for the run lock
                    # as well as births attempted while this pass is active.
                    # The next even epoch reopens admission for later jobs.
                    self._birth_epoch += 1
                    try:
                        with cleanup_lock(self._lock):
                            workers = self.worker_ids
                            guards = tuple(self._worker_cleanup_guard(worker_id) for worker_id in workers)
                        with ExitStack() as held_workers:
                            available, pending = [], []
                            for worker_id, guard in zip(workers, guards):
                                _require_cleanup_budget()
                                if guard.acquire(blocking=False):
                                    held_workers.callback(guard.release)
                                    available.append(worker_id)
                                else:
                                    pending.append(guard)
                            if pending and available:
                                # Settle available workers before a contended
                                # peer can consume the rest of the pass.
                                preliminary_errors = self._cleanup_workers_within_budget(tuple(available))
                                if preliminary_errors:
                                    self._retain_cleanup_failure("; ".join(preliminary_errors))
                            for guard in pending:
                                held_workers.enter_context(cleanup_lock(guard))
                            failure_token = self._cleanup_failure_token
                            errors = self._cleanup_workers_within_budget(workers)
                            if errors:
                                self._retain_cleanup_failure("; ".join(errors))
                                return False
                            with cleanup_lock(self._lock):
                                if (self.worker_ids != workers or
                                        any(owner in workers for owner, _process, _pid in self._birth_processes.values())):
                                    self._retain_cleanup_failure("Apply process was registered during cleanup; ownership retained")
                                    return False
                                if self._cleanup_failure_token is not failure_token:
                                    return False
                                prior_inspection = self._inspection_denied.is_set()
                                prior_signal = self._signal_denied.is_set()
                                self._cleanup_error = None
                                self._cleanup_failed.clear()
                                self._inspection_denied.clear()
                                self._signal_denied.clear()
                                if self._cleanup_failure_token is not failure_token:
                                    concurrent = self._cleanup_failure_token
                                    self._cleanup_failed.set()
                                    if prior_inspection or concurrent[1]:
                                        self._inspection_denied.set()
                                    if prior_signal or concurrent[2]:
                                        self._signal_denied.set()
                                    self._cleanup_error = concurrent[3]
                                    return False
                                if self._journal is not None:
                                    self._journal.record_cleanup_failure(self._cleanup_error)
                            return self._cleanup_error is None and not self._cleanup_failed.is_set()
                    finally:
                        self._birth_epoch += 1
            except ProcessOwnershipError as exc:
                self._retain_cleanup_failure(str(exc))
                return False

    def cancel(self) -> None:
        """Deliver cancellation without waiting for child exit on the event loop."""
        self.stop_event.set()
        with self._cancel_guard:
            if self._admitted and self._cancel_thread is None and not self._finishing:
                self._cancel_thread = threading.Thread(
                    target=self._cancel_resources, name=f"apply-cancel-{self.identity[:8]}", daemon=True,
                )
                self._cancel_thread.start()

    def _cancel_resources(self) -> None:
        # A worker may already have passed its stop check when cancellation
        # arrives. Retain custody of resources registered after the first pass
        # until every launcher worker has returned and finish() fences births.
        while True:
            self.interrupt()
            if self._cleanup_done.wait(0.1):
                return

    def request_stop(self) -> None:
        self.stop_event.set()
        self.interrupt()

    def finish(self) -> None:
        # Fence late cancellation before joining its owned cleanup thread. The
        # launcher keeps the lease until every cleanup attempt has returned.
        with self._cancel_guard:
            self._finishing = True
            self._cleanup_done.set()
            cancel_thread = self._cancel_thread
        if cancel_thread is not None:
            cancel_thread.join()
        self.request_stop()
        if self._cleanup_error is None:
            # All blocking workers joined and tracked cleanup succeeded.
            # Source completion is explicit best effort for escaped children;
            # installed full-tree custody still needs its native scope proof.
            from jobctrl.apply.launcher import settle_finished_apply_claims
            with self._lock:
                settle_finished_apply_claims(self)
        if self._cleanup_error is not None:
            raise ApplyLauncherCleanupIncomplete(self._cleanup_message(
                "Apply cleanup could not verify owned process exit; its exact custody and files remain retained."
            ))


def spawn_owned_apply_process(worker_id: int, kind: str, command: list[str], **kwargs) -> subprocess.Popen:
    """Adapter birth seam; admitted Apply resources always use durable custody."""
    with _WORKER_RUNS_LOCK:
        run = _WORKER_RUNS.get(worker_id)
    if run is None:
        # Standalone low-level adapter calls retain their exact-handle contract.
        # Product Apply entry points bind workers under main's workspace lease.
        return subprocess.Popen(command, **kwargs)
    return run.spawn(worker_id, kind, command, **kwargs)


def publish_owned_apply_process(worker_id: int, process: subprocess.Popen, publish: Callable[[], None]) -> None:
    """Publish an adapter handle only while its exact tracked birth is current."""
    binding = getattr(process, "_jobctrl_apply_birth", None)
    if binding is None:
        publish()  # Standalone adapter: the adapter's own guard retains authority.
        return
    owner_ref, birth_id, owner, launched_pid, epoch = binding
    run = owner_ref()
    if run is None or owner != worker_id:
        raise CustodyUnverified("Apply process publication has no active run custody")
    run._publish_birth(worker_id, process, birth_id, launched_pid, epoch, publish)
