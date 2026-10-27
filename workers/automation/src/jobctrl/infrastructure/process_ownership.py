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
    _wait_for_session_exit(launched_pid)


def _wait_for_session_exit(session_id: int) -> None:
    """Read-only completion proof, including other groups in the old session.

    After the leader is reaped, a numeric session/group is no longer signal
    authority. Occupancy (including a reused ID) or an incomplete census keeps
    cleanup unresolved. Two complete empty observations permit retirement;
    disappeared PIDs force another census, and zombies have already exited.
    """
    deadline = time.monotonic() + _SESSION_EXIT_TIMEOUT_SECONDS
    empty_observations = 0
    while True:
        members, complete = _active_session_members(session_id)
        empty_observations = empty_observations + 1 if complete and not members else 0
        if empty_observations >= 2:
            return
        if time.monotonic() >= deadline:
            raise ProcessOwnershipError(
                "Apply process root exited but its launch session is still occupied "
                "or exit cannot be verified; ownership retained without further signals"
            )
        time.sleep(_SESSION_EXIT_POLL_SECONDS)


def _active_session_members(session_id: int) -> tuple[set[int], bool]:
    system = platform.system()
    try:
        if system == "Darwin":
            return _darwin_active_session_members(session_id)
        if system == "Linux":
            members = set()
            complete = True
            for entry in Path("/proc").iterdir():
                if not entry.name.isdecimal():
                    continue
                try:
                    # Linux proc(5): fields after the final ')' are state,
                    # parent PID, group and session. Command text is ignored.
                    fields = (entry / "stat").read_bytes().rsplit(b")", 1)[1].split()
                except FileNotFoundError:
                    complete = False
                    continue
                if len(fields) < 4:
                    raise ProcessOwnershipError("Incomplete Apply process session census")
                if int(fields[3]) == session_id and fields[0] not in {b"Z", b"X"}:
                    members.add(int(entry.name))
            return members, complete
    except (OSError, ValueError, IndexError) as exc:
        raise ProcessOwnershipError("Cannot verify Apply process session exit") from exc
    raise ProcessOwnershipError(f"Apply process session exit verification is unavailable on {system}")


def _darwin_active_session_members(session_id: int) -> tuple[set[int], bool]:
    """Read numeric kernel process metadata, without invoking a shell or ps."""
    import ctypes
    import errno

    class BsdShortInfo(ctypes.Structure):
        # sys/proc_info.h: proc_bsdshortinfo, PROC_PIDT_SHORTBSDINFO=13.
        _fields_ = [
            ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32),
            ("pgid", ctypes.c_uint32), ("state", ctypes.c_uint32),
            ("remaining", ctypes.c_byte * 48),
        ]

    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    library.proc_listpids.restype = ctypes.c_int
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    needed = library.proc_listpids(1, 0, None, 0)  # PROC_ALL_PIDS
    if needed <= 0:
        raise ProcessOwnershipError("Cannot enumerate Apply process session")
    pids = (ctypes.c_int * (needed // ctypes.sizeof(ctypes.c_int) + 256))()
    used = library.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
    if used <= 0 or used >= ctypes.sizeof(pids) or used % ctypes.sizeof(ctypes.c_int):
        raise ProcessOwnershipError("Incomplete Apply process session census")
    members = set()
    complete = True
    for pid in pids[:used // ctypes.sizeof(ctypes.c_int)]:
        if pid <= 0:
            continue
        try:
            matches = os.getsid(pid) == session_id
        except ProcessLookupError:
            matches = None
        if matches is False:
            continue
        info = BsdShortInfo()
        # arg=1 also inspects zombies; getsid alone does not find them on macOS.
        size = library.proc_pidinfo(pid, 13, 1, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            if size == 0 and ctypes.get_errno() == errno.ESRCH:
                complete = False
                continue
            raise ProcessOwnershipError("Cannot inspect Apply process session member")
        if info.pid != pid:
            raise ProcessOwnershipError("Apply process session census identity changed")
        if info.state == 5:  # SZOMB: exited, waiting for its parent to reap.
            continue
        if matches is None:
            complete = False
        else:
            members.add(pid)
    return members, complete
