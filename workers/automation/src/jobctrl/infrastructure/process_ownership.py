"""Termination for original child handles captured by launch-owning adapters."""

from __future__ import annotations

import os
import platform
import signal
import subprocess
import time
from pathlib import Path


_SESSION_EXIT_TIMEOUT_SECONDS = 1.0
_SESSION_EXIT_POLL_SECONDS = 0.02


class ProcessOwnershipError(RuntimeError):
    """The original child can no longer authorize a process/session signal."""


def terminate_owned_process(process: subprocess.Popen, *, launched_pid: int) -> None:
    """Verify and terminate an adapter's original launched child, then await exit.

    Callers must retain the exact Popen and PID at successful process creation,
    serialize their ownership registry, and launch POSIX children with
    start_new_session=True. Never create this authority from discovered PIDs.
    """
    if process.pid != launched_pid:
        raise ProcessOwnershipError("Cannot verify Apply process ownership")
    if platform.system() == "Windows":
        # Popen.kill uses the launch-time kernel handle, not the numeric PID.
        # Descendants are not independently selected with taskkill /T.
        if process.poll() is None:
            process.kill()
    else:
        # CPython uses this lock for every waitpid/reap. Holding it keeps the
        # original child PID allocated across session verification and signal,
        # even if the child exits or another thread calls poll/wait meanwhile.
        reap_lock = getattr(process, "_waitpid_lock", None)
        if reap_lock is None:
            raise ProcessOwnershipError("Cannot verify Apply process ownership")
        with reap_lock:
            if process.returncode is None:
                try:
                    if os.getpgid(launched_pid) != launched_pid or os.getsid(launched_pid) != launched_pid:
                        raise ProcessOwnershipError("Apply process no longer owns its launch session")
                    os.killpg(launched_pid, signal.SIGKILL)
                except ProcessLookupError:
                    # Still verify the original child and the session below.
                    pass
    process.wait(timeout=10)
    if platform.system() == "Windows":
        raise ProcessOwnershipError(
            "Windows Apply descendant exit verification is unavailable; "
            "the original root handle exited but ownership is retained"
        )
    verify_session_exit(launched_pid)


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


def _wait_for_session_exit(session_id: int) -> None:
    """Require matching complete process-generation inventories with no members.

    An empty sampled session is insufficient: a row can fork a successor then
    leave the session before inspection. Fencing enumeration and requiring a
    stable full birth-generation inventory prevents retiring that handoff.
    These read-only observations never recover signal authority.
    """
    deadline = time.monotonic() + _SESSION_EXIT_TIMEOUT_SECONDS
    previous_empty_inventory = None
    while True:
        inventory, complete = _read_process_inventory()
        members = {pid for pid, (_, sid, active, _) in inventory.items() if active and sid == session_id}
        if complete and not members:
            if previous_empty_inventory is not None and inventory == previous_empty_inventory:
                return
            previous_empty_inventory = inventory
        else:
            previous_empty_inventory = None
        if time.monotonic() >= deadline:
            raise ProcessOwnershipError(
                "Apply process root exited but its launch session is still occupied "
                "or exit cannot be verified; ownership retained without further signals"
            )
        time.sleep(_SESSION_EXIT_POLL_SECONDS)


def _active_session_members(session_id: int) -> tuple[set[int], bool]:
    inventory, complete = _read_process_inventory()
    return {pid for pid, (_, sid, active, _) in inventory.items() if active and sid == session_id}, complete


def _linux_process_ids() -> set[int]:
    return {int(entry.name) for entry in Path("/proc").iterdir() if entry.name.isdecimal()}


def _read_process_inventory() -> tuple[_ProcessInventory, bool]:
    system = platform.system()
    try:
        if system == "Darwin":
            return _darwin_process_inventory()
        if system == "Linux":
            inventory = {}
            complete = True
            pids = _linux_process_ids()
            for pid in pids:
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
            return inventory, complete and pids == _linux_process_ids()
    except (OSError, ValueError, IndexError) as exc:
        raise ProcessOwnershipError("Cannot verify Apply process session exit") from exc
    raise ProcessOwnershipError(f"Apply process session exit verification is unavailable on {system}")


def _darwin_process_ids(library) -> set[int]:
    import ctypes

    needed = library.proc_listpids(1, 0, None, 0)  # PROC_ALL_PIDS
    if needed <= 0:
        raise ProcessOwnershipError("Cannot enumerate Apply process session")
    pids = (ctypes.c_int * (needed // ctypes.sizeof(ctypes.c_int) + 256))()
    used = library.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
    if used <= 0 or used >= ctypes.sizeof(pids) or used % ctypes.sizeof(ctypes.c_int):
        raise ProcessOwnershipError("Incomplete Apply process session census")
    return {pid for pid in pids[:used // ctypes.sizeof(ctypes.c_int)] if pid > 0}


def _darwin_process_inventory() -> tuple[_ProcessInventory, bool]:
    """Read stable kernel identity and membership without a shell or ps.

    Short BSD metadata and unique identifiers are unprivileged libproc flavors.
    XNU proc_info.h defines PROC_PIDUNIQIDENTIFIERINFO (17), whose uniqueid and
    PID version bind each row across the separate getsid/status observations.
    See https://github.com/apple/darwin-xnu/blob/main/bsd/sys/proc_info.h.
    An unavailable ABI is an uncertain census, never proof of process death.
    """
    import ctypes
    import errno

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

    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    library.proc_listpids.restype = ctypes.c_int
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int

    def read(pid, flavor, info_type):
        info = info_type()
        # arg=1 permits zombie inspection; an already exited process cannot run.
        size = library.proc_pidinfo(pid, flavor, 1, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            if size == 0 and ctypes.get_errno() == errno.ESRCH:
                raise ProcessLookupError(pid)
            raise ProcessOwnershipError("Cannot inspect Apply process session generation")
        return info

    inventory = {}
    complete = True
    pids = _darwin_process_ids(library)
    for pid in pids:
        try:
            first_identity = read(pid, 17, UniqueInfo)
            first = read(pid, 13, BsdShortInfo)
            sid = None if first.state == 5 else os.getsid(pid)
            second = read(pid, 13, BsdShortInfo)
            second_sid = None if second.state == 5 else os.getsid(pid)
            second_identity = read(pid, 17, UniqueInfo)
        except ProcessLookupError:
            complete = False
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
            complete = False
        inventory[pid] = (birth, second_sid, second.state != 5, second.pgid)
    return inventory, complete and pids == _darwin_process_ids(library)
