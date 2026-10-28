"""Per-run Apply process, cancellation and resource ownership."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
import logging
import socket
import subprocess
import threading
from typing import Iterator
import uuid

from jobctrl import config
from jobctrl.apply.process_birth import ApplyCustodyJournal, CustodyUnverified


log = logging.getLogger(__name__)


_WORKER_RUNS: dict[int, "ApplyLauncherRun"] = {}
_WORKER_RUNS_LOCK = threading.RLock()


class ApplyLauncherCleanupIncomplete(RuntimeError):
    """Owned cleanup remains unresolved; its exact run custody is retained."""


class ApplyLauncherBusy(RuntimeError):
    """Another launcher still owns this workspace; no Apply claim was made."""


@dataclass
class ApplyLauncherRun:
    identity: str = field(default_factory=lambda: uuid.uuid4().hex)
    stop_event: threading.Event = field(default_factory=threading.Event)
    worker_ids: tuple[int, ...] = ()
    ports: tuple[int, ...] = ()
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    _cancel_guard: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _cleanup_error: str | None = field(default=None, init=False, repr=False)
    _cancel_thread: threading.Thread | None = field(default=None, init=False, repr=False)
    _finishing: bool = field(default=False, init=False, repr=False)
    _admitted: bool = field(default=False, init=False, repr=False)
    _cleanup_done: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _journal: ApplyCustodyJournal | None = field(default=None, init=False, repr=False)
    _birth_processes: dict = field(default_factory=dict, init=False, repr=False)

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
                    raise ApplyLauncherCleanupIncomplete("Apply owned cleanup remains unresolved; its files and custody are retained.")
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
        with self._lock:
            if self._journal is None or not self._admitted or self.stop_event.is_set():
                raise CustodyUnverified("Apply process birth has no active run custody")
            birth_id = self._journal.reserve(worker_id, kind)
            try:
                process = subprocess.Popen(command, **kwargs)
            except OSError:
                self._journal.abort_unspawned(birth_id)
                raise
            self._birth_processes[birth_id] = (worker_id, process, process.pid)
            return process

    def _cleanup_workers(self, workers: tuple[int, ...]) -> list[str]:
        from jobctrl.apply.chrome import cleanup_workers
        from jobctrl.infrastructure.apply.claude_code_cli import kill_active_claude_processes
        from jobctrl.infrastructure.process_ownership import terminate_owned_process

        errors = []
        for worker_id in workers:
            worker_errors = []
            for cleanup in (
                lambda: kill_active_claude_processes(worker_ids=(worker_id,)),
                lambda: cleanup_workers((worker_id,)),
            ):
                try:
                    cleanup()
                except Exception as exc:
                    log.exception("Apply launcher %s process cleanup failed", self.identity)
                    worker_errors.append(str(exc))
            if not worker_errors:
                # Own birth handles cover cancellation before an adapter has
                # registered its process. Never use that fallback to override
                # an adapter's explicit ownership/exit refusal.
                with self._lock:
                    births = [(process, pid) for owner, process, pid in self._birth_processes.values()
                              if owner == worker_id]
                    for process, pid in births:
                        try:
                            from jobctrl.runtime import is_bundled_runtime
                            if not is_bundled_runtime() and process.poll() is not None:
                                # The adapter already joined this exact tracked
                                # root. Source best effort does not upgrade that
                                # into a second full-session/tree proof demand.
                                process.wait(timeout=10)
                            else:
                                terminate_owned_process(process, launched_pid=pid)
                        except Exception as exc:
                            worker_errors.append(str(exc))
            with self._lock:
                for birth_id, (owner, process, _pid) in tuple(self._birth_processes.items()):
                    if owner == worker_id and process.poll() is not None:
                        for stream in (process.stdout, process.stderr):
                            if stream is not None:
                                stream.close()
                        if not worker_errors:
                            # Release in-memory routing/handles after scoped
                            # cleanup, retaining full-tree custody on disk.
                            del self._birth_processes[birth_id]
            errors.extend(worker_errors)
        return errors

    def verify_worker_cleanup(self, worker_id: int) -> None:
        """Fence the next claim/reset until this worker's prior exit is proven."""
        errors = self._cleanup_workers((worker_id,))
        if errors:
            self.stop_event.set()
            with self._lock:
                self._cleanup_error = "; ".join(errors)
                if self._journal is not None:
                    self._journal.record_cleanup_failure(self._cleanup_error)
            raise ApplyLauncherCleanupIncomplete(
                "Apply worker cleanup could not verify exit; no further job was claimed and prior runtime files are retained."
            )

    def interrupt(self) -> bool:
        """Interrupt only this run's agent/browser processes; retain its lease."""
        with self._lock:
            workers = self.worker_ids
        errors = self._cleanup_workers(workers)
        with self._lock:
            self._cleanup_error = "; ".join(errors) if errors else None
            if self._journal is not None:
                self._journal.record_cleanup_failure(self._cleanup_error)
        return not errors

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
            raise ApplyLauncherCleanupIncomplete(
                "Apply cleanup could not verify owned process exit; its exact custody and files remain retained."
            )


def spawn_owned_apply_process(worker_id: int, kind: str, command: list[str], **kwargs) -> subprocess.Popen:
    """Adapter birth seam; admitted Apply resources always use durable custody."""
    with _WORKER_RUNS_LOCK:
        run = _WORKER_RUNS.get(worker_id)
    if run is None:
        # Standalone low-level adapter calls retain their exact-handle contract.
        # Product Apply entry points bind workers under main's workspace lease.
        return subprocess.Popen(command, **kwargs)
    return run.spawn(worker_id, kind, command, **kwargs)
