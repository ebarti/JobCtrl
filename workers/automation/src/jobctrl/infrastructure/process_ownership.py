"""Termination for original child handles captured by launch-owning adapters."""

from __future__ import annotations

import os
import platform
import signal
import subprocess


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
            if process.returncode is not None:
                return
            try:
                if os.getpgid(launched_pid) != launched_pid or os.getsid(launched_pid) != launched_pid:
                    raise ProcessOwnershipError("Apply process no longer owns its launch session")
                os.killpg(launched_pid, signal.SIGKILL)
            except ProcessLookupError:
                # The group may have exited between inspection and signal.
                # Still reap/verify the original child below.
                pass
    process.wait(timeout=10)
