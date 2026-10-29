"""Graceful termination of owned children without signalling a peer."""

from __future__ import annotations

import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure import process_ownership


pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX launch-session ownership")


def _wait_file(path: Path) -> str:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            value = path.read_text()
            if value:
                return value
        except FileNotFoundError:
            pass
        time.sleep(.01)
    raise AssertionError(f"synthetic child did not publish {path.name}")


def _limit_fixture_enumeration(monkeypatch, pids: set[int]) -> None:
    # Only constrain enumeration; identity, session and liveness remain real
    # kernel observations of the known synthetic processes in this test.
    if sys.platform == "darwin":
        original = process_ownership._darwin_process_ids
        monkeypatch.setattr(process_ownership, "_darwin_process_ids", lambda library: original(library) & pids)
    elif sys.platform.startswith("linux"):
        original = process_ownership._linux_process_ids
        monkeypatch.setattr(process_ownership, "_linux_process_ids", lambda: original() & pids)


def test_cleanup_budget_expiring_during_grace_never_forces_owned_child(monkeypatch, tmp_path):
    """A deadline shorter than grace retains the live child without SIGKILL."""
    program = (
        "import signal, sys, time; from pathlib import Path; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "Path(sys.argv[1]).write_text('ready'); time.sleep(30)"
    )
    ready = tmp_path / "ready"
    owner = subprocess.Popen(
        [sys.executable, "-I", "-B", "-c", program, str(ready)], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, env={"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"},
        start_new_session=True,
    )
    original_kill, original_killpg = os.kill, os.killpg
    signals = []
    try:
        assert _wait_file(ready) == "ready"
        _limit_fixture_enumeration(monkeypatch, {owner.pid})
        monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", 0.5)

        def term(pid, sig):
            assert pid == owner.pid and sig == signal.SIGTERM
            signals.append(sig)
            return original_kill(pid, sig)

        def force(pgid, sig):
            assert pgid == owner.pid
            signals.append(sig)
            return original_killpg(pgid, sig)

        monkeypatch.setattr(process_ownership.os, "kill", term)
        monkeypatch.setattr(process_ownership.os, "killpg", force)
        started = time.monotonic()
        with process_ownership.cleanup_budget(0.15):
            with pytest.raises(process_ownership.ProcessOwnershipError, match="deadline"):
                process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert time.monotonic() - started < 0.5
        assert signals == [signal.SIGTERM]
        assert owner.poll() is None
    finally:
        if owner.poll() is None:
            original_kill(owner.pid, signal.SIGKILL)
        owner.wait(timeout=5)


def _guard_owned_signals(monkeypatch, owner_pid: int) -> None:
    class GuardedOS:
        def __getattr__(self, name):
            return getattr(os, name)

        def kill(self, pid, sig):
            assert pid == owner_pid and sig == signal.SIGTERM
            return os.kill(pid, sig)

        def killpg(self, pgid, sig):
            assert pgid == owner_pid and sig == signal.SIGKILL
            return os.killpg(pgid, sig)

    monkeypatch.setattr(process_ownership, "os", GuardedOS())


def test_real_interrupt_cleans_only_selected_owned_process(monkeypatch, tmp_path):
    from jobctrl.apply import chrome, ownership
    from jobctrl.infrastructure.apply import claude_code_cli

    command = [sys.executable, "-I", "-B", "-c", "import time; time.sleep(30)"]
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"}
    owner = subprocess.Popen(command, start_new_session=True, env=env)
    peer = subprocess.Popen(command, start_new_session=True, env=env)
    try:
        _guard_owned_signals(monkeypatch, owner.pid)
        _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid, peer.pid})
        monkeypatch.setattr(chrome, "_chrome_procs", {1: owner, 2: peer})
        monkeypatch.setattr(chrome, "_chrome_identities", {1: (owner, owner.pid), 2: (peer, peer.pid)})
        monkeypatch.setattr(chrome, "_chrome_endpoints", {})
        monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_PROCS", {})
        monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_IDENTITIES", {})
        run = ownership.ApplyLauncherRun(worker_ids=(1,))
        assert run.interrupt()
        assert owner.returncode is not None
        assert peer.poll() is None
        assert chrome._chrome_procs == {2: peer}
        assert not run.stop_event.is_set()
    finally:
        for process in (owner, peer):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)


def test_real_late_birth_retains_both_handles_and_fences_worker(monkeypatch, tmp_path):
    from jobctrl import runtime
    from jobctrl.apply import chrome, ownership
    from jobctrl.infrastructure.apply import claude_code_cli

    command = [sys.executable, "-I", "-B", "-c", "import time; time.sleep(30)"]
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"}
    owner = subprocess.Popen(command, start_new_session=True, env=env)
    late = subprocess.Popen(command, start_new_session=True, env=env)
    try:
        _guard_owned_signals(monkeypatch, owner.pid)
        _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid, late.pid})
        monkeypatch.setattr(chrome, "_chrome_procs", {})
        monkeypatch.setattr(chrome, "_chrome_identities", {})
        monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_PROCS", {})
        monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_IDENTITIES", {})
        monkeypatch.setattr(runtime, "is_bundled_runtime", lambda: True)
        run = ownership.ApplyLauncherRun(worker_ids=(1,))
        run._birth_processes["first"] = (1, owner, owner.pid)
        actual_terminate = process_ownership.terminate_owned_process

        def register_after_snapshot(process, *, launched_pid):
            assert process is owner and launched_pid == owner.pid
            with run._lock:
                run._birth_processes["late"] = (1, late, late.pid)
            actual_terminate(process, launched_pid=launched_pid)

        monkeypatch.setattr(process_ownership, "terminate_owned_process", register_after_snapshot)
        with pytest.raises(ownership.ApplyLauncherCleanupIncomplete):
            run.verify_worker_cleanup(1)
        assert owner.returncode is not None and late.poll() is None
        assert run.stop_event.is_set() and run._cleanup_error
        assert run._birth_processes == {"first": (1, owner, owner.pid), "late": (1, late, late.pid)}
    finally:
        for process in (owner, late):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)


def test_interrupt_retains_blocked_pipe_and_reuses_close_worker(monkeypatch, tmp_path):
    from jobctrl import runtime
    from jobctrl.apply import chrome, ownership
    from jobctrl.infrastructure.apply import claude_code_cli

    read_fd, write_fd = os.pipe()
    owner = subprocess.Popen(
        [sys.executable, "-I", "-B", "-c", "pass"], stdout=write_fd, start_new_session=True,
        env={"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"},
    )
    owner.wait(timeout=5)
    stream = os.fdopen(read_fd, "r")
    owner.stdout = stream
    reader_started = threading.Event()
    reader = threading.Thread(target=lambda: (reader_started.set(), stream.readline()))
    writer_open = True
    try:
        os.write(write_fd, b"x")
        reader.start()
        assert reader_started.wait(1)
        deadline = time.monotonic() + 2
        while select.select([read_fd], [], [], 0)[0] and time.monotonic() < deadline:
            time.sleep(.005)
        assert not select.select([read_fd], [], [], 0)[0]
        assert reader.is_alive()

        monkeypatch.setattr(ownership, "_CLEANUP_PASS_TIMEOUT_SECONDS", 0.15)
        monkeypatch.setattr(runtime, "is_bundled_runtime", lambda: False)
        monkeypatch.setattr(chrome, "_chrome_procs", {})
        monkeypatch.setattr(chrome, "_chrome_identities", {})
        monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_PROCS", {})
        monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_IDENTITIES", {})
        run = ownership.ApplyLauncherRun(worker_ids=(1,))
        run._birth_processes["owner"] = (1, owner, owner.pid)
        started = time.monotonic()
        assert not run.interrupt()
        assert time.monotonic() - started < 0.5
        assert run.stop_event.is_set() and run._cleanup_error
        assert run._birth_processes == {"owner": (1, owner, owner.pid)}
        closing = run._stream_closures[("owner", "stdout")]
        assert not closing.done.is_set()

        assert not run.interrupt()
        assert run._stream_closures == {("owner", "stdout"): closing}
        os.close(write_fd)
        writer_open = False
        reader.join(timeout=2)
        assert not reader.is_alive() and closing.done.wait(2)
        assert run.interrupt()
        assert stream.closed and not run._birth_processes and not run._stream_closures
    finally:
        if writer_open:
            os.close(write_fd)
        if reader.ident is not None:
            reader.join(timeout=2)
        if not reader.is_alive() and not stream.closed:
            stream.close()


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin libSystem fallback")
def test_darwin_waitid_fallback_observes_child_without_reaping(monkeypatch):
    owner = subprocess.Popen(["/bin/cat"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             start_new_session=True)
    stopped = False
    try:
        # Exercise the fallback even on a newer interpreter that has os.waitid.
        monkeypatch.delattr(os, "waitid", raising=False)
        with owner._waitpid_lock:
            assert process_ownership._waitid_nowait(owner.pid) is None
            # The retained handle and reap lock pin this owned child's PID.
            os.kill(owner.pid, signal.SIGSTOP)
            stopped = True
            deadline = time.monotonic() + 5
            event = process_ownership._waitid_nowait(owner.pid, stopped=True)
            while event is None and time.monotonic() < deadline:
                time.sleep(.01)
                event = process_ownership._waitid_nowait(owner.pid, stopped=True)
            assert event is not None and (event.si_pid, event.si_code) == (owner.pid, os.CLD_STOPPED)
            event = process_ownership._waitid_nowait(owner.pid)
            assert event is None or (event.si_pid, event.si_code) == (owner.pid, os.CLD_STOPPED)
            os.kill(owner.pid, signal.SIGCONT)
            stopped = False
            owner.stdin.close()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                event = process_ownership._waitid_nowait(owner.pid)
                if event is not None and event.si_code == os.CLD_EXITED:
                    break
                time.sleep(.01)
            assert event is not None and (event.si_pid, event.si_code) == (owner.pid, os.CLD_EXITED)
            event = process_ownership._waitid_nowait(owner.pid)
            assert event is not None and (event.si_pid, event.si_code) == (owner.pid, os.CLD_EXITED)
            assert owner.returncode is None
        assert owner.wait(timeout=5) == 0
    finally:
        if stopped:
            owner.send_signal(signal.SIGCONT)
        if not owner.stdin.closed:
            owner.stdin.close()
        try:
            owner.wait(timeout=5)
        except subprocess.TimeoutExpired:
            owner.kill()
            owner.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin libSystem fallback")
@pytest.mark.parametrize("fault", ["unsupported-abi", "missing-library", "errno", "foreign", "unknown", "invalid-empty"])
def test_darwin_waitid_fallback_fails_closed_before_signal(monkeypatch, fault):
    import ctypes
    import errno

    owner = subprocess.Popen(["/bin/cat"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             start_new_session=True)
    try:
        monkeypatch.delattr(os, "waitid", raising=False)
        if fault == "unsupported-abi":
            sizeof = ctypes.sizeof
            monkeypatch.setattr(ctypes, "sizeof", lambda kind: 4 if kind is ctypes.c_void_p else sizeof(kind))
        elif fault == "missing-library":
            def unavailable(*_args, **_kwargs):
                raise OSError("synthetic missing libSystem")
            monkeypatch.setattr(ctypes, "CDLL", unavailable)
        else:
            class SyntheticWaitid:
                def __call__(self, selector, pid, result, options):
                    assert selector == os.P_PID and pid == owner.pid
                    assert options == os.WEXITED | os.WNOHANG | os.WNOWAIT
                    assert self.argtypes[0:2] == [ctypes.c_int, ctypes.c_uint]
                    assert self.argtypes[3] is ctypes.c_int and self.restype is ctypes.c_int
                    if fault == "errno":
                        ctypes.set_errno(errno.ECHILD)
                        return -1
                    info = result._obj
                    info.si_pid = owner.pid + 1 if fault == "foreign" else owner.pid if fault == "unknown" else 0
                    info.si_signo = signal.SIGCHLD
                    info.si_code = os.CLD_EXITED if fault == "foreign" else 999
                    return 0
            monkeypatch.setattr(ctypes, "CDLL", lambda *_args, **_kwargs: SimpleNamespace(waitid=SyntheticWaitid()))
        signals = []
        with monkeypatch.context() as signals_patch:
            signals_patch.setattr(os, "kill", lambda pid, sig: signals.append((pid, sig)))
            signals_patch.setattr(os, "killpg", lambda pid, sig: signals.append((pid, sig)))
            with pytest.raises(process_ownership.ProcessOwnershipError) as failure:
                process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        if fault == "errno":
            assert isinstance(failure.value.__cause__, OSError)
            assert failure.value.__cause__.errno == errno.ECHILD
        assert not signals
    finally:
        owner.stdin.close()
        try:
            owner.wait(timeout=5)
        except subprocess.TimeoutExpired:
            owner.kill()
            owner.wait(timeout=5)


@pytest.mark.parametrize("mode", ["cooperative", "stubborn", "root-exits"])
def test_original_child_gets_grace_before_verified_group_kill(tmp_path, monkeypatch, mode):
    ready, received = tmp_path / "ready", tmp_path / "received"
    child_ready, child_stop, child_done = (tmp_path / name for name in ("child", "stop", "done"))
    script = """
import os,signal,subprocess,sys,time
from pathlib import Path
ready,received,mode=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
child_ready,child_stop,child_done=map(Path,sys.argv[4:])
if mode in ('stubborn','root-exits'):
    child_code='''import os,signal,sys,time
from pathlib import Path
ready,stop,done=map(Path,sys.argv[1:])
signal.signal(signal.SIGTERM,signal.SIG_IGN)
ready.write_text(str(os.getpid()))
deadline=time.monotonic()+15
while not stop.exists() and time.monotonic()<deadline: time.sleep(.01)
done.write_text('done')
'''
    subprocess.Popen([sys.executable,'-c',child_code,str(child_ready),str(child_stop),str(child_done)])
    while not child_ready.exists(): time.sleep(.01)
def stop(signum,frame):
    received.write_text('term')
    if mode!='stubborn': sys.exit(0)
signal.signal(signal.SIGTERM,stop)
ready.write_text('ready')
deadline=time.monotonic()+15
while time.monotonic()<deadline: time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready), str(received), mode,
                              str(child_ready), str(child_stop), str(child_done)], start_new_session=True)
    peer = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    calls = []
    original_killpg = os.killpg

    def kill_owned_group(pgid, requested):
        assert pgid == owner.pid and requested == signal.SIGKILL
        calls.append((pgid, requested, time.monotonic()))
        return original_killpg(pgid, requested)

    monkeypatch.setattr(os, "killpg", kill_owned_group)
    try:
        _wait_file(ready)
        fixture_pids = {os.getpid(), owner.pid, peer.pid}
        if mode != "cooperative":
            child = int(_wait_file(child_ready))
            assert os.getsid(child) == owner.pid and os.getpgid(child) == owner.pid
            fixture_pids.add(child)
        _limit_fixture_enumeration(monkeypatch, fixture_pids)
        started = time.monotonic()
        process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert _wait_file(received) == "term"
        assert peer.poll() is None
        if mode == "cooperative":
            assert owner.returncode == 0
            assert not calls
        else:
            assert owner.returncode == (0 if mode == "root-exits" else -signal.SIGKILL)
            assert len(calls) == 1 and calls[0][:2] == (owner.pid, signal.SIGKILL)
            assert calls[0][2] - started >= process_ownership._PROCESS_TERMINATION_GRACE_SECONDS - .1
            inventory, _ = process_ownership._read_process_inventory()
            assert child not in inventory or not inventory[child][2]
    finally:
        child_stop.touch()
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=5)
        if peer.poll() is None:
            peer.terminate()
        peer.wait(timeout=5)


@pytest.mark.parametrize("reap_leader", [False, True])
def test_exited_leader_cannot_authorize_signal_to_surviving_child(tmp_path, monkeypatch, reap_leader):
    ready, child_ready, stop, child_done = (tmp_path / name for name in ("ready", "child", "stop", "done"))
    release_root = tmp_path / "release-root"
    script = """
import os,signal,sys,time
from pathlib import Path
ready,child_ready,stop,done,release=map(Path,sys.argv[1:])
child=os.fork()
if child==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    child_ready.write_text(str(os.getpid()))
    deadline=time.monotonic()+15
    while not stop.exists() and time.monotonic()<deadline: time.sleep(.01)
    done.write_text('done')
    sys.exit(0)
ready.write_text('ready')
while not release.exists(): time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready), str(child_ready), str(stop),
                              str(child_done), str(release_root)], start_new_session=True)
    peer = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    calls = []
    original_killpg = os.killpg
    monkeypatch.setattr(os, "killpg", lambda pgid, requested: (calls.append((pgid, requested)), original_killpg(pgid, requested))[1])
    try:
        _wait_file(ready)
        child = int(_wait_file(child_ready))
        assert os.getsid(child) == owner.pid
        _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid, child, peer.pid})
        release_root.touch()
        if reap_leader:
            assert owner.wait(timeout=5) == 0
        else:
            deadline = time.monotonic() + 5
            while (process_ownership._waitid_nowait(owner.pid) is None
                   and time.monotonic() < deadline):
                time.sleep(.01)
            assert process_ownership._waitid_nowait(owner.pid) is not None
            assert owner.returncode is None
        with pytest.raises(process_ownership.ProcessOwnershipError, match="ownership retained"):
            process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert owner.returncode == 0
        assert not calls
        assert os.getsid(child) == owner.pid
        assert peer.poll() is None
    finally:
        stop.touch()
        if child_ready.exists():
            _wait_file(child_done)
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=5)
        if peer.poll() is None:
            peer.terminate()
        peer.wait(timeout=5)


@pytest.mark.parametrize("fault", ["unavailable", "unknown", "foreign"])
def test_unavailable_child_exit_check_does_not_authorize_force(tmp_path, monkeypatch, fault):
    ready = tmp_path / "ready"
    script = """
import signal,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
Path(sys.argv[1]).write_text('ready')
while True: time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready)], start_new_session=True)
    peer = None
    try:
        peer = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
        monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", .1)

        def unavailable(*_args):
            if fault == "unavailable":
                raise OSError("unavailable")
            return SimpleNamespace(si_pid=owner.pid + 1 if fault == "foreign" else owner.pid, si_code=999)

        monkeypatch.setattr(process_ownership, "_waitid_nowait", unavailable)
        _wait_file(ready)
        with pytest.raises(process_ownership.ProcessOwnershipError, match="Cannot (verify|determine)"):
            process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert owner.poll() is None
        assert peer.poll() is None
    finally:
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=5)
        if peer is not None:
            if peer.poll() is None:
                peer.terminate()
            peer.wait(timeout=5)


@pytest.mark.parametrize("recover", [False, True])
def test_grace_census_failure_never_forces_an_unverified_group(tmp_path, monkeypatch, recover):
    ready, received, stop = (tmp_path / name for name in ("ready", "received", "stop"))
    script = """
import signal,sys,time
from pathlib import Path
ready,received,stop=map(Path,sys.argv[1:])
signal.signal(signal.SIGTERM,lambda *_: received.write_text('term'))
ready.write_text('ready')
deadline=time.monotonic()+5
while not stop.exists() and time.monotonic()<deadline: time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready), str(received), str(stop)],
                             start_new_session=True)
    peer = subprocess.Popen(["/bin/sleep", "5"], start_new_session=True)
    monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", .2)
    monkeypatch.setattr(process_ownership, "_SESSION_EXIT_POLL_SECONDS", .01)
    _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid, peer.pid})
    original_inventory = process_ownership._read_process_inventory
    reads = []
    signals = []

    def census(**kwargs):
        reads.append(time.monotonic())
        if not recover or len(reads) <= 2:
            raise process_ownership.ProcessOwnershipError("synthetic inspection unavailable")
        return original_inventory(**kwargs)

    monkeypatch.setattr(process_ownership, "_read_process_inventory", census)
    monkeypatch.setattr(os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    try:
        _wait_file(ready)
        if recover:
            # A separate owned thread releases this child after transient
            # inspection failure, within the original grace interval.
            import threading
            timer = threading.Timer(.08, stop.touch)
            timer.start()
        started = time.monotonic()
        if recover:
            process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
            timer.join(timeout=1)
            assert owner.returncode == 0
        else:
            with pytest.raises(process_ownership.ProcessOwnershipError, match="(verify|unavailable|retained)"):
                process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
            assert time.monotonic() - started >= .18
            assert owner.poll() is None
        assert _wait_file(received) == "term"
        assert not signals
        assert peer.poll() is None
    finally:
        stop.touch()
        owner.wait(timeout=5)
        if peer.poll() is None:
            peer.terminate()
        peer.wait(timeout=5)


@pytest.mark.parametrize("recover", [False, True])
def test_unscoped_incomplete_grace_census_retries_without_unverified_force(tmp_path, monkeypatch, recover):
    ready, received, stop = (tmp_path / name for name in ("ready", "received", "stop"))
    script = """
import signal,sys,time
from pathlib import Path
ready,received,stop=map(Path,sys.argv[1:])
signal.signal(signal.SIGTERM,lambda *_: received.write_text('term'))
ready.write_text('ready')
while not stop.exists(): time.sleep(.01)
"""
    owner = None
    peer = None
    try:
        owner = subprocess.Popen([sys.executable, "-c", script, str(ready), str(received), str(stop)],
                                 start_new_session=True)
        peer = subprocess.Popen(["/bin/sleep", "5"], start_new_session=True)
        grace, retry = .15, .25
        monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", grace)
        monkeypatch.setattr(process_ownership, "_UNSCOPED_CENSUS_RETRY_SECONDS", retry, raising=False)
        monkeypatch.setattr(process_ownership, "_SESSION_EXIT_POLL_SECONDS", .01)
        _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid, peer.pid})
        actual_read, actual_kill, actual_killpg = process_ownership._read_process_inventory, os.kill, os.killpg
        term_at, samples, signals = [], [], []

        def signal_child(pid, requested):
            if pid == owner.pid and requested == signal.SIGTERM:
                term_at.append(time.monotonic())
            return actual_kill(pid, requested)

        def census(**kwargs):
            inventory, complete = actual_read(**kwargs)
            now = time.monotonic()
            if not recover or now < term_at[0] + grace + .04:
                complete = False
            row = inventory.get(owner.pid)
            samples.append((now, complete, bool(row and row[2] and row[1] == owner.pid and row[3] == owner.pid)))
            return inventory, complete

        def kill_group(pid, requested):
            signals.append((pid, requested, time.monotonic(), samples[-1]))
            return actual_killpg(pid, requested)

        monkeypatch.setattr(os, "kill", signal_child)
        monkeypatch.setattr(os, "killpg", kill_group)
        monkeypatch.setattr(process_ownership, "_read_process_inventory", census)
        _wait_file(ready)
        if recover:
            process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
            assert owner.returncode == -signal.SIGKILL
            assert len(signals) == 1
            pid, requested, signaled_at, proof = signals[0]
            assert (pid, requested) == (owner.pid, signal.SIGKILL)
            assert signaled_at >= term_at[0] + grace + .04
            assert proof[1:] == (True, True) and proof[0] >= term_at[0] + grace
        else:
            with pytest.raises(process_ownership.ProcessOwnershipError, match="(verify|unavailable|retained)"):
                process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
            assert time.monotonic() >= term_at[0] + grace + retry - .02
            assert owner.poll() is None and not signals
        assert _wait_file(received) == "term"
        assert peer.poll() is None
        assert any(not complete and at >= term_at[0] + grace for at, complete, _ in samples)
    finally:
        stop.touch()
        if owner is not None:
            try:
                owner.wait(timeout=5)
            except subprocess.TimeoutExpired:
                owner.kill()
                owner.wait(timeout=5)
        if peer is not None:
            if peer.poll() is None:
                peer.terminate()
            peer.wait(timeout=5)


def test_native_scoped_census_refusal_does_not_enter_unscoped_retry(tmp_path, monkeypatch):
    ready, stop = tmp_path / "ready", tmp_path / "stop"
    script = """
import signal,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
Path(sys.argv[1]).write_text('ready')
while not Path(sys.argv[2]).exists(): time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready), str(stop)], start_new_session=True)
    try:
        owner._jobctrl_birth_coalitions = (10, 11)
        monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", .1)
        monkeypatch.setattr(process_ownership, "_UNSCOPED_CENSUS_RETRY_SECONDS", .25)
        monkeypatch.setattr(process_ownership, "_SESSION_EXIT_POLL_SECONDS", .01)
        monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: None)
        monkeypatch.setattr(process_ownership, "_read_process_inventory", lambda **_: ({}, False))
        calls = []
        actual_wait = process_ownership._wait_for_session_exit

        def observe_wait(*args, **kwargs):
            calls.append(kwargs)
            return actual_wait(*args, **kwargs)

        monkeypatch.setattr(process_ownership, "_wait_for_session_exit", observe_wait)
        monkeypatch.setattr(os, "killpg", lambda *_: pytest.fail("incomplete native scope cannot authorize force"))
        _wait_file(ready)
        with pytest.raises(process_ownership.ProcessOwnershipError, match="ownership retained"):
            process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert owner.poll() is None
        assert calls and all(not kwargs.get("stop_on_verified_group") for kwargs in calls)
    finally:
        stop.touch()
        try:
            owner.wait(timeout=5)
        except subprocess.TimeoutExpired:
            owner.kill()
            owner.wait(timeout=5)


def test_unscoped_retry_accepts_verified_exit_without_force(tmp_path, monkeypatch):
    ready = tmp_path / "ready"
    script = """
import signal,sys,time
from pathlib import Path
def stop(*_):
 time.sleep(.15)
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
Path(sys.argv[1]).write_text('ready')
while True: time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready)], start_new_session=True)
    try:
        grace = .1
        monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", grace)
        monkeypatch.setattr(process_ownership, "_UNSCOPED_CENSUS_RETRY_SECONDS", .4)
        monkeypatch.setattr(process_ownership, "_SESSION_EXIT_POLL_SECONDS", .01)
        _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid})
        actual_read, actual_kill = process_ownership._read_process_inventory, os.kill
        term_at, samples = [], []

        def signal_child(pid, requested):
            if pid == owner.pid and requested == signal.SIGTERM:
                term_at.append(time.monotonic())
            return actual_kill(pid, requested)

        def census(**kwargs):
            inventory, complete = actual_read(**kwargs)
            now = time.monotonic()
            if now < term_at[0] + grace + .1:
                complete = False
            row = inventory.get(owner.pid)
            samples.append((now, complete, bool(row and row[2])))
            return inventory, complete

        monkeypatch.setattr(os, "kill", signal_child)
        monkeypatch.setattr(os, "killpg", lambda *_: pytest.fail("exited session cannot authorize force"))
        monkeypatch.setattr(process_ownership, "_read_process_inventory", census)
        _wait_file(ready)
        process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert owner.returncode == 0
        assert any(not complete and at >= term_at[0] + grace for at, complete, _ in samples)
        assert sum(complete and not active for _, complete, active in samples) >= 2
    finally:
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin process inventory and owned churn")
def test_concurrent_poll_with_owned_churn_retries_an_incomplete_grace_census(monkeypatch):
    import select
    import threading

    reader, writer = os.pipe()
    owner = None
    peer = None
    churners = []
    try:
        owner = subprocess.Popen([sys.executable, "-u", "-c",
                                  "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                                  "print('ready',flush=True); time.sleep(30)"],
                                 stdout=subprocess.PIPE, start_new_session=True)
        assert select.select([owner.stdout], [], [], 5)[0]
        assert owner.stdout.readline().strip() == b"ready"
        peer = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
        grace = .2
        monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", grace)
        monkeypatch.setattr(process_ownership, "_UNSCOPED_CENSUS_RETRY_SECONDS", .6)
        monkeypatch.setattr(process_ownership, "_SESSION_EXIT_POLL_SECONDS", .01)
        actual_ids = process_ownership._darwin_process_ids
        actual_read, actual_kill, actual_killpg = process_ownership._read_process_inventory, os.kill, os.killpg
        term_at, samples, signals, observed = [], [], [], []

        def ids_with_owned_churn(library):
            pids = actual_ids(library)
            if term_at and grace - .05 <= time.monotonic() - term_at[0] < grace + .08 and len(churners) < 16:
                # This separate-session child starts after enumeration. It
                # remains until the test closes its private lifetime pipe.
                churners.append(subprocess.Popen(["/bin/cat"], stdin=reader, stdout=subprocess.DEVNULL,
                                                 start_new_session=True))
            return pids

        def census(**kwargs):
            inventory, complete = actual_read(**kwargs)
            row = inventory.get(owner.pid)
            samples.append((time.monotonic(), complete,
                            bool(row and row[2] and row[1] == owner.pid and row[3] == owner.pid)))
            return inventory, complete

        def signal_child(pid, requested):
            allowed = {owner.pid, peer.pid, *(child.pid for child in churners)}
            assert pid in allowed and requested in (signal.SIGTERM, signal.SIGSTOP, signal.SIGKILL)
            if pid == owner.pid and requested == signal.SIGTERM:
                term_at.append(time.monotonic())
            return actual_kill(pid, requested)

        def kill_group(pid, requested):
            assert pid == owner.pid and requested == signal.SIGKILL
            signals.append((pid, requested, time.monotonic(), samples[-1]))
            actual_killpg(pid, requested)
            poller = threading.Thread(target=lambda: observed.append(owner.poll()))
            poller.start()
            poller.join(timeout=3)
            assert not poller.is_alive() and owner.returncode is None

        monkeypatch.setattr(process_ownership, "_darwin_process_ids", ids_with_owned_churn)
        monkeypatch.setattr(process_ownership, "_read_process_inventory", census)
        monkeypatch.setattr(os, "kill", signal_child)
        monkeypatch.setattr(os, "killpg", kill_group)
        owner.send_signal(signal.SIGSTOP)
        deadline = time.monotonic() + 5
        event = process_ownership._waitid_nowait(owner.pid, stopped=True)
        while event is None and time.monotonic() < deadline:
            time.sleep(.01)
            event = process_ownership._waitid_nowait(owner.pid, stopped=True)
        assert event is not None and event.si_pid == owner.pid and event.si_code == os.CLD_STOPPED
        process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert owner.returncode == -signal.SIGKILL and observed == [None]
        assert peer.poll() is None and churners and all(child.poll() is None for child in churners)
        assert any(not complete and at >= term_at[0] + grace for at, complete, _ in samples)
        assert len(signals) == 1
        pid, requested, signaled_at, proof = signals[0]
        assert (pid, requested) == (owner.pid, signal.SIGKILL)
        assert signaled_at >= term_at[0] + grace and proof[1:] == (True, True)
    finally:
        os.close(writer)
        os.close(reader)
        if owner is not None:
            if owner.poll() is None:
                owner.kill()
            owner.wait(timeout=5)
        if peer is not None:
            if peer.poll() is None:
                peer.terminate()
            peer.wait(timeout=5)
        for child in churners:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin denies group signals when only an unreaped zombie remains")
def test_zombie_group_signal_denial_still_requires_actual_exit_proof(tmp_path, monkeypatch):
    ready, finish = tmp_path / "ready", tmp_path / "finish"
    script = """
import signal,sys,time
from pathlib import Path
def stop(signum,frame):
 while not Path(sys.argv[2]).exists(): time.sleep(.01)
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
Path(sys.argv[1]).write_text('ready')
while True: time.sleep(.01)
"""
    owner = subprocess.Popen([sys.executable, "-c", script, str(ready), str(finish)], start_new_session=True)
    peer = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    original_killpg = os.killpg
    denied = []
    monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", .2)

    def record_denial(pgid, requested):
        # The real grace census has already found this live group. Let its
        # original child exit before the signal, while its PID remains pinned.
        finish.touch()
        deadline = time.monotonic() + 5
        while (process_ownership._waitid_nowait(owner.pid) is None
               and time.monotonic() < deadline):
            time.sleep(.01)
        assert process_ownership._waitid_nowait(owner.pid) is not None
        try:
            original_killpg(pgid, requested)
        except PermissionError:
            denied.append(True)
            raise

    monkeypatch.setattr(os, "killpg", record_denial)
    try:
        _wait_file(ready)
        _limit_fixture_enumeration(monkeypatch, {os.getpid(), owner.pid, peer.pid})
        process_ownership.terminate_owned_process(owner, launched_pid=owner.pid)
        assert denied == [True]
        assert owner.returncode == 0
        assert peer.poll() is None
    finally:
        finish.touch()
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=5)
        if peer.poll() is None:
            peer.terminate()
        peer.wait(timeout=5)
