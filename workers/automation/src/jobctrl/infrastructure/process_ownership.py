"""Termination for original child handles captured by launch-owning adapters."""

from __future__ import annotations

import errno
import os
import platform
import signal
import subprocess
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator


_SESSION_EXIT_TIMEOUT_SECONDS = 2.0
_SESSION_EXIT_POLL_SECONDS = 0.02
_PROCESS_TERMINATION_GRACE_SECONDS = 2.0
_UNSCOPED_CENSUS_RETRY_SECONDS = 1.0
_CLEANUP_DEADLINE: ContextVar[float | None] = ContextVar("apply_cleanup_deadline", default=None)
INSPECTION_DENIED_MESSAGE = "The system denied a process inspection during Apply cleanup; custody is retained."
SIGNAL_DENIED_MESSAGE = "The system denied a process signal during Apply cleanup; custody is retained."
INSPECTION_AND_SIGNAL_DENIED_MESSAGE = (
    "The system denied process inspection and signaling during Apply cleanup; custody is retained."
)


class ProcessOwnershipError(RuntimeError):
    """The original child can no longer authorize a process/session signal."""


class CleanupDeadlineExceeded(ProcessOwnershipError):
    """The current cleanup pass has no time left to verify ownership."""


class ProcessInspectionDenied(ProcessOwnershipError):
    """A required operating-system process inspection was explicitly denied."""


class ProcessSignalDenied(ProcessOwnershipError):
    """A signal to the originally owned process was explicitly denied."""


class ProcessInspectionAndSignalDenied(ProcessInspectionDenied, ProcessSignalDenied):
    """Separate selected processes encountered both kinds of denial."""


def _caused_by(exc: BaseException, kind: type[BaseException]) -> bool:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, kind):
            return True
        current = current.__cause__ or current.__context__
    return False


def is_process_inspection_denied(exc: BaseException) -> bool:
    return _caused_by(exc, ProcessInspectionDenied)


def is_process_signal_denied(exc: BaseException) -> bool:
    return _caused_by(exc, ProcessSignalDenied)


class _VerifiedLaunchGroupOccupied(ProcessOwnershipError):
    """A complete, fenced observation found a live member of the launch group."""


def _waitid_nowait(pid: int, *, stopped: bool = False):
    """Observe an original child without releasing its PID or reaping it."""
    if type(pid) is not int or not 0 < pid <= 0x7fffffff:
        raise ProcessOwnershipError("Cannot verify Apply child exit identity")
    options = os.WNOHANG | os.WNOWAIT | (os.WSTOPPED if stopped else os.WEXITED)
    waitid = getattr(os, "waitid", None)
    if waitid is not None:
        return waitid(os.P_PID, pid, options)
    if platform.system() != "Darwin":
        raise ProcessOwnershipError("Non-reaping Apply child inspection is unavailable")
    return _darwin_waitid(pid, options)


def _darwin_waitid(pid: int, options: int):
    """Call the Darwin waitid ABI missing from some bundled CPython builds."""
    import ctypes

    # The distributed runtimes are 64-bit Darwin. Refuse an unfamiliar ABI
    # instead of passing a potentially undersized siginfo buffer to libc.
    if (ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ctypes.c_long) != 8
            or ctypes.sizeof(ctypes.c_int) != 4 or ctypes.sizeof(ctypes.c_uint) != 4
            or (os.P_PID, os.WNOHANG, os.WEXITED, os.WNOWAIT, os.WSTOPPED) != (1, 1, 4, 32, 8)
            or (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED, os.CLD_TRAPPED,
                os.CLD_STOPPED, os.CLD_CONTINUED) != (1, 2, 3, 4, 5, 6)):
        raise ProcessOwnershipError("Unsupported Darwin Apply child inspection ABI")

    # Darwin sys/signal.h's siginfo_t; sigval is a pointer-sized union.
    class SigInfo(ctypes.Structure):
        _fields_ = [("si_signo", ctypes.c_int), ("si_errno", ctypes.c_int),
                    ("si_code", ctypes.c_int), ("si_pid", ctypes.c_int),
                    ("si_uid", ctypes.c_uint), ("si_status", ctypes.c_int),
                    ("si_addr", ctypes.c_void_p), ("si_value", ctypes.c_void_p),
                    ("si_band", ctypes.c_long), ("_pad", ctypes.c_ulong * 7)]

    if ctypes.sizeof(SigInfo) != 104 or SigInfo.si_pid.offset != 12 or SigInfo.si_code.offset != 8:
        raise ProcessOwnershipError("Unsupported Darwin Apply child inspection ABI")
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    waitid = library.waitid
    waitid.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.POINTER(SigInfo), ctypes.c_int]
    waitid.restype = ctypes.c_int
    info = SigInfo()
    if waitid(os.P_PID, pid, ctypes.byref(info), options) != 0:
        raise OSError(ctypes.get_errno(), "Darwin waitid failed")
    if info.si_pid == 0:
        if info.si_signo != 0 or info.si_code != 0:
            raise ProcessOwnershipError("Cannot determine Apply child exit state")
        return None
    return info


@contextmanager
def cleanup_budget(seconds: float) -> Iterator[None]:
    """Share a deadline across the selected handles in one cleanup pass."""
    deadline = time.monotonic() + seconds
    previous = _CLEANUP_DEADLINE.get()
    if previous is not None:
        deadline = min(deadline, previous)
    token = _CLEANUP_DEADLINE.set(deadline)
    try:
        yield
    finally:
        _CLEANUP_DEADLINE.reset(token)


def _within_cleanup_budget(seconds: float) -> float:
    deadline = _CLEANUP_DEADLINE.get()
    if deadline is None:
        return seconds
    return max(0.0, min(seconds, deadline - time.monotonic()))


def _require_cleanup_budget() -> None:
    if _CLEANUP_DEADLINE.get() is not None and _within_cleanup_budget(float("inf")) <= 0:
        raise CleanupDeadlineExceeded("Apply cleanup deadline expired; ownership retained")


@contextmanager
def cleanup_lock(lock) -> Iterator[None]:
    """Acquire an ownership lock within the current cleanup pass, if any."""
    _require_cleanup_budget()
    deadline = _CLEANUP_DEADLINE.get()
    acquired = lock.acquire() if deadline is None else lock.acquire(timeout=_within_cleanup_budget(float("inf")))
    if not acquired:
        raise ProcessOwnershipError("Apply cleanup ownership lock was unavailable; ownership retained")
    try:
        _require_cleanup_budget()
        yield
    finally:
        lock.release()


def terminate_owned_process(process: subprocess.Popen, *, launched_pid: int) -> None:
    """Verify and terminate an adapter's original launched child, then await exit.

    Callers must retain the exact Popen and PID at successful process creation,
    serialize their ownership registry, and launch POSIX children with
    start_new_session=True. Never create this authority from discovered PIDs.
    """
    if process.pid != launched_pid:
        raise ProcessOwnershipError("Cannot verify Apply process ownership")
    _require_cleanup_budget()
    force_denied = None
    if platform.system() == "Windows":
        # Popen.kill uses the launch-time kernel handle, not the numeric PID.
        # Descendants are not independently selected with taskkill /T.
        try:
            live = process.poll() is None
        except PermissionError as exc:
            raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc
        if live:
            try:
                process.kill()
            except PermissionError as exc:
                raise ProcessSignalDenied(SIGNAL_DENIED_MESSAGE) from exc
    else:
        # CPython uses this lock for every waitpid/reap. Holding it keeps the
        # original child PID allocated across session verification and signal,
        # even if the child exits or another thread calls poll/wait meanwhile.
        reap_lock = getattr(process, "_waitpid_lock", None)
        if reap_lock is None:
            raise ProcessOwnershipError("Cannot verify Apply process ownership")
        with cleanup_lock(reap_lock):
            if process.returncode is None:
                try:
                    # Do not start signal authority from an already-exited
                    # child. WNOWAIT keeps its original PID reserved.
                    event = _waitid_nowait(launched_pid)
                    if event is None:
                        exited = False
                    elif type(event.si_pid) is not int or type(event.si_code) is not int:
                        raise ProcessOwnershipError("Cannot determine Apply child exit state")
                    elif event.si_pid != launched_pid:
                        raise ProcessOwnershipError("Cannot verify Apply child exit identity")
                    elif event.si_code in (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED):
                        exited = True
                    elif event.si_code in (os.CLD_STOPPED, os.CLD_TRAPPED, os.CLD_CONTINUED):
                        # Darwin may return a pending stop event even when
                        # waitid requested only WEXITED. It is still live.
                        exited = False
                    else:
                        raise ProcessOwnershipError("Cannot determine Apply child exit state")
                except PermissionError as exc:
                    raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc
                except (AttributeError, ChildProcessError, OSError) as exc:
                    raise ProcessOwnershipError("Cannot verify Apply process ownership for cleanup") from exc
                if not exited:
                    try:
                        try:
                            group = os.getpgid(launched_pid)
                            session = os.getsid(launched_pid)
                        except PermissionError as exc:
                            raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc
                        if group != launched_pid or session != launched_pid:
                            raise ProcessOwnershipError("Apply process no longer owns its launch session")
                        # Give the original child the first opportunity to drain
                        # its own resources before signalling its launch group.
                        _require_cleanup_budget()
                        try:
                            os.kill(launched_pid, signal.SIGTERM)
                        except PermissionError as exc:
                            raise ProcessSignalDenied(SIGNAL_DENIED_MESSAGE) from exc
                        grace_deadline = time.monotonic() + _PROCESS_TERMINATION_GRACE_SECONDS
                        coalitions = getattr(process, "_jobctrl_birth_coalitions", None)
                        while True:
                            _require_cleanup_budget()
                            try:
                                _wait_for_session_exit(
                                    launched_pid,
                                    native_coalitions=coalitions,
                                    timeout_seconds=max(0, grace_deadline - time.monotonic()),
                                )
                                break
                            except _VerifiedLaunchGroupOccupied:
                                _require_cleanup_budget()
                                if time.monotonic() < grace_deadline:
                                    time.sleep(_within_cleanup_budget(min(_SESSION_EXIT_POLL_SECONDS, max(0, grace_deadline - time.monotonic()))))
                                    continue
                            except ProcessOwnershipError as exc:
                                try:
                                    _require_cleanup_budget()
                                except ProcessOwnershipError:
                                    if isinstance(exc, ProcessInspectionDenied):
                                        raise exc
                                    raise
                                if time.monotonic() < grace_deadline:
                                    time.sleep(_within_cleanup_budget(min(_SESSION_EXIT_POLL_SECONDS, max(0, grace_deadline - time.monotonic()))))
                                    continue
                                if coalitions is not None:
                                    raise
                                # Unrelated host churn can make the single
                                # grace-deadline census incomplete. Retry only
                                # while the original PID remains unreaped; a
                                # fresh complete group observation is required.
                                try:
                                    _wait_for_session_exit(
                                        launched_pid, timeout_seconds=_UNSCOPED_CENSUS_RETRY_SECONDS,
                                        stop_on_verified_group=True,
                                    )
                                except _VerifiedLaunchGroupOccupied:
                                    pass
                                else:
                                    break
                            # The unreaped PID pins the verified launch group
                            # even if its leader exited during grace or retry.
                            _require_cleanup_budget()
                            try:
                                os.killpg(launched_pid, signal.SIGKILL)
                            except PermissionError as exc:
                                # A verified member can exit between census
                                # and signal, leaving a zombie.
                                force_denied = exc
                            break
                    except ProcessLookupError:
                        # Still verify the original child and the session below.
                        pass
    try:
        process.wait(timeout=_within_cleanup_budget(10))
        if platform.system() == "Windows":
            raise ProcessOwnershipError(
                "Windows Apply descendant exit verification is unavailable; "
                "the original root handle exited but ownership is retained"
            )
        coalitions = getattr(process, "_jobctrl_birth_coalitions", None)
        if coalitions is None:
            verify_session_exit(launched_pid)
        else:
            _wait_for_session_exit(launched_pid, native_coalitions=coalitions)
    except (PermissionError, ProcessInspectionDenied) as exc:
        if force_denied is not None:
            raise ProcessInspectionAndSignalDenied(INSPECTION_AND_SIGNAL_DENIED_MESSAGE) from exc
        raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc
    except (ProcessOwnershipError, subprocess.TimeoutExpired):
        if force_denied is not None:
            raise ProcessSignalDenied(SIGNAL_DENIED_MESSAGE) from force_denied
        raise


def verify_session_exit(session_id: int) -> None:
    """Verify an old session has no live members; never signal or adopt it.

    Recovery callers must independently validate their recorded session ID.
    Any occupied, changing or unavailable observation keeps recovery unresolved.
    """
    if type(session_id) is not int or session_id <= 0:
        raise ProcessOwnershipError("Apply process session identity must be a positive integer")
    if platform.system() not in {"Darwin", "Linux"}:
        raise ProcessOwnershipError("Apply process session exit verification is unavailable on this platform")
    _wait_for_session_exit(session_id)


# PID -> (kernel birth/generation, session, active, process group).
_ProcessInventory = dict[int, tuple[tuple[int, ...], int | None, bool, int]]


def _native_coalition_counts(coalitions: tuple[int, int] | None) -> tuple[int, int] | None:
    """Read the authenticated resource coalition's task-start and exit counts.

    A change fences every fork/exec into this scope, including a session
    member that forks then leaves before the process census inspects it.
    Failure is not proof: callers retain the existing inventory fallback.
    """
    if (platform.system() != "Darwin" or not isinstance(coalitions, tuple) or len(coalitions) != 2
            or any(type(value) is not int or value <= 0 for value in coalitions)):
        return None
    import ctypes
    from jobctrl.apply.native_custody import _current_coalitions
    from jobctrl.apply.process_birth import CustodyUnverified

    try:
        if tuple(_current_coalitions()) != coalitions:
            return None
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        usage = library.coalition_info_resource_usage
        usage.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
        usage.restype = ctypes.c_int
        counts = (ctypes.c_uint64 * 2)()
        if usage(coalitions[0], ctypes.byref(counts), ctypes.sizeof(counts)) != 0:
            return None
        if counts[0] == 0 or counts[1] > counts[0]:
            return None
        return counts[0], counts[1]
    except (AttributeError, CustodyUnverified, OSError):
        return None


def _wait_for_session_exit(session_id: int, *, native_coalitions: tuple[int, int] | None = None,
                           timeout_seconds: float | None = None, stop_on_verified_group: bool = False) -> None:
    """Require a fenced process observation with no live session members.

    An empty sampled session is insufficient: a row can fork a successor then
    leave the session before inspection. A complete census fenced by the exact
    native scope's unchanged task-start count excludes that handoff. Without
    that authority, matching full birth-generation inventories remain required.
    These read-only observations never recover signal authority.

    A caller past its grace deadline may request an early occupied-group
    result during a bounded retry; it still needs a complete observation.
    """
    _require_cleanup_budget()
    timeout = _SESSION_EXIT_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
    deadline = time.monotonic() + _within_cleanup_budget(timeout)
    previous_empty_inventory = None
    inspection_denied = None
    while True:
        try:
            before = _native_coalition_counts(native_coalitions)
            if before is None:
                inventory, complete = _read_process_inventory()
            else:
                # Any task born into the authenticated scope invalidates this
                # pass. Unrelated tasks may start or exit while it runs.
                inventory, complete = _read_process_inventory(
                    native_scope=(native_coalitions[0], before[0] - before[1])
                )
            after = _native_coalition_counts(native_coalitions)
        except ProcessOwnershipError as exc:
            previous_empty_inventory = None
            if isinstance(exc, ProcessInspectionDenied):
                inspection_denied = exc
            if time.monotonic() >= deadline:
                if inspection_denied is not None:
                    raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from inspection_denied
                raise ProcessOwnershipError(f"Cannot verify Apply process session exit: {exc}; ownership retained") from exc
            time.sleep(min(_SESSION_EXIT_POLL_SECONDS, max(0, deadline - time.monotonic())))
            continue
        try:
            _require_cleanup_budget()
        except CleanupDeadlineExceeded:
            if inspection_denied is not None:
                raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from inspection_denied
            raise
        members = {pid for pid, (_, sid, active, _) in inventory.items() if active and sid == session_id}
        if before is not None:
            if complete and not members and before == after:
                return
            # A scope-fenced census is not a strict global inventory and must
            # never be reused as one if the scope fence changed or failed.
            previous_empty_inventory = None
        elif complete and not members:
            if previous_empty_inventory is not None and inventory == previous_empty_inventory:
                return
            previous_empty_inventory = inventory
        else:
            previous_empty_inventory = None
        observed_at = time.monotonic()
        if ((stop_on_verified_group and observed_at < deadline) or
                (not stop_on_verified_group and observed_at >= deadline)) and complete and (
                    before is None or before == after
                ) and any(active and sid == session_id and pgid == session_id
                          for _, sid, active, pgid in inventory.values()):
            raise _VerifiedLaunchGroupOccupied(
                "Apply process launch group is still occupied; ownership retained"
            )
        if observed_at >= deadline:
            raise ProcessOwnershipError(
                "Apply process root exited but its launch session is still occupied "
                "or exit cannot be verified; ownership retained without further signals"
            )
        time.sleep(min(_SESSION_EXIT_POLL_SECONDS, max(0, deadline - time.monotonic())))


def _active_session_members(session_id: int) -> tuple[set[int], bool]:
    inventory, complete = _read_process_inventory()
    return {pid for pid, (_, sid, active, _) in inventory.items() if active and sid == session_id}, complete


def _linux_process_ids() -> set[int]:
    return {int(entry.name) for entry in Path("/proc").iterdir() if entry.name.isdecimal()}


def _read_process_inventory(*, native_scope: tuple[int, int] | None = None) -> tuple[_ProcessInventory, bool]:
    system = platform.system()
    try:
        if system == "Darwin":
            return _darwin_process_inventory(native_scope=native_scope)
        if system == "Linux":
            inventory = {}
            complete = True
            _require_cleanup_budget()
            pids = _linux_process_ids()
            for pid in pids:
                _require_cleanup_budget()
                try:
                    # proc(5): after the final ')' are state (3), parent,
                    # group (5), session (6), ... kernel start ticks (22).
                    fields = (Path("/proc") / str(pid) / "stat").read_bytes().rsplit(b")", 1)[1].split()
                except FileNotFoundError:
                    complete = False
                    continue
                if len(fields) < 20:
                    raise ProcessOwnershipError("Incomplete Apply process session census")
                inventory[pid] = ((int(fields[19]),), int(fields[3]), fields[0] not in {b"Z", b"X"}, int(fields[2]))
            _require_cleanup_budget()
            return inventory, complete and pids == _linux_process_ids()
    except PermissionError as exc:
        raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from exc
    except (OSError, ValueError, IndexError) as exc:
        raise ProcessOwnershipError("Cannot verify Apply process session exit") from exc
    raise ProcessOwnershipError(f"Apply process session exit verification is unavailable on {system}")


def _darwin_process_ids(library) -> set[int]:
    import ctypes

    _require_cleanup_budget()
    ctypes.set_errno(0)
    needed = library.proc_listpids(1, 0, None, 0)  # PROC_ALL_PIDS
    if needed <= 0:
        if ctypes.get_errno() in (errno.EACCES, errno.EPERM):
            raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE)
        raise ProcessOwnershipError("Cannot enumerate Apply process session")
    pids = (ctypes.c_int * (needed // ctypes.sizeof(ctypes.c_int) + 256))()
    _require_cleanup_budget()
    ctypes.set_errno(0)
    used = library.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
    if used <= 0 or used >= ctypes.sizeof(pids) or used % ctypes.sizeof(ctypes.c_int):
        if used <= 0 and ctypes.get_errno() in (errno.EACCES, errno.EPERM):
            raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE)
        raise ProcessOwnershipError("Incomplete Apply process session census")
    return {pid for pid in pids[:used // ctypes.sizeof(ctypes.c_int)] if pid > 0}


def _darwin_process_inventory(*, native_scope: tuple[int, int] | None = None) -> tuple[_ProcessInventory, bool]:
    """Read stable kernel identity and membership without a shell or ps.

    Short BSD metadata and unique identifiers are unprivileged libproc flavors.
    XNU proc_info.h defines PROC_PIDUNIQIDENTIFIERINFO (17), whose uniqueid and
    PID version bind each row across the separate getsid/status observations.
    See https://github.com/apple/darwin-xnu/blob/main/bsd/sys/proc_info.h.
    An unavailable ABI is an uncertain census, never proof of process death.
    """
    import ctypes
    class BsdShortInfo(ctypes.Structure):
        _fields_ = [
            ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32),
            ("pgid", ctypes.c_uint32), ("state", ctypes.c_uint32),
            ("remaining", ctypes.c_byte * 48),
        ]

    class UniqueInfo(ctypes.Structure):
        _fields_ = [
            ("uuid", ctypes.c_byte * 16), ("unique_id", ctypes.c_uint64),
            ("parent_unique_id", ctypes.c_uint64), ("pid_version", ctypes.c_int32),
            ("reserved2", ctypes.c_uint32), ("reserved3", ctypes.c_uint64),
            ("reserved4", ctypes.c_uint64),
        ]

    class CoalitionInfo(ctypes.Structure):
        _fields_ = [("ids", ctypes.c_uint64 * 5)]

    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    library.proc_listpids.restype = ctypes.c_int
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int

    def read(pid, flavor, info_type, arg=1):
        _require_cleanup_budget()
        info = info_type()
        # arg=1 permits zombie inspection; an already exited process cannot run.
        ctypes.set_errno(0)
        size = library.proc_pidinfo(pid, flavor, arg, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            if size == 0:
                error = ctypes.get_errno()
                if error == errno.ESRCH:
                    raise ProcessLookupError(pid)
                if error in (errno.EACCES, errno.EPERM):
                    raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE)
            raise ProcessOwnershipError("Cannot inspect Apply process session generation")
        return info

    inventory = {}
    complete = True
    observed_scope_tasks = 0
    inspection_denied = None
    _require_cleanup_budget()
    pids = _darwin_process_ids(library)
    for pid in pids:
        _require_cleanup_budget()
        try:
            first_identity = read(pid, 17, UniqueInfo)
            first = read(pid, 13, BsdShortInfo)
            _require_cleanup_budget()
            sid = None if first.state == 5 else os.getsid(pid)
            coalition = read(pid, 20, CoalitionInfo, arg=0) if native_scope is not None and first.state != 5 else None
            second = read(pid, 13, BsdShortInfo)
            _require_cleanup_budget()
            second_sid = None if second.state == 5 else os.getsid(pid)
            second_identity = read(pid, 17, UniqueInfo)
        except (ProcessLookupError, ProcessOwnershipError, OSError) as exc:
            # An uninspectable PID can be a live task in exec. In the scoped
            # mode it may be skipped only if every task in the resource
            # coalition is independently accounted for below. The strict
            # fallback retains its original failure handling.
            if isinstance(exc, CleanupDeadlineExceeded):
                raise
            if native_scope is None and isinstance(exc, ProcessLookupError):
                complete = False
            elif native_scope is None:
                raise
            elif isinstance(exc, (ProcessInspectionDenied, PermissionError)):
                inspection_denied = exc
            continue
        birth = (first_identity.unique_id, first_identity.pid_version)
        if first_identity.unique_id == 0 or second_identity.unique_id == 0:
            raise ProcessOwnershipError("Apply process kernel generation is unavailable")
        if (
            first.pid != pid or second.pid != pid
            or birth != (second_identity.unique_id, second_identity.pid_version)
            or first.pgid != second.pgid or (first.state == 5) != (second.state == 5)
            or sid != second_sid
        ):
            if native_scope is None:
                complete = False
            continue
        inventory[pid] = (birth, second_sid, second.state != 5, second.pgid)
        if coalition is not None and second.state != 5 and coalition.ids[0] == native_scope[0]:
            observed_scope_tasks += 1
    if native_scope is not None:
        scoped_complete = complete and observed_scope_tasks == native_scope[1]
        if not scoped_complete and inspection_denied is not None:
            raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE) from inspection_denied
        return inventory, scoped_complete
    _require_cleanup_budget()
    return inventory, complete and pids == _darwin_process_ids(library)
