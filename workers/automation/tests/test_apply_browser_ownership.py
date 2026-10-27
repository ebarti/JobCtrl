"""Apply lifecycle proof using owned processes; never invoke a real browser."""

from __future__ import annotations

import os
import socket
import subprocess
import sys

import pytest

from jobctrl.apply import chrome


@pytest.fixture(autouse=True)
def isolate_browser_registry(monkeypatch):
    monkeypatch.setattr(chrome, "_chrome_procs", {})
    monkeypatch.setattr(chrome, "_chrome_identities", {})
    monkeypatch.setattr(chrome, "_launching_workers", set())
    monkeypatch.setattr(chrome, "_launching_ports", set())


class _OwnedChildren(list):
    """Own child handles and the unmodified process factory for each trial."""


@pytest.fixture
def browser_seam(tmp_path, monkeypatch):
    """Keep real process creation/cleanup and substitute only Chrome/CDP."""
    popen = subprocess.Popen
    children = _OwnedChildren()
    children.popen = popen
    monkeypatch.setattr(chrome.config, "CHROME_WORKER_DIR", tmp_path / "profiles")
    monkeypatch.setattr(chrome, "require_system_browser_capability", lambda _: sys.executable)
    monkeypatch.setattr(chrome, "_wait_for_browser_cdp_endpoint", lambda *_: None)
    monkeypatch.setattr(chrome, "install_public_destination_cdp_guard", lambda *_, **__: None)
    monkeypatch.setattr(chrome, "install_dry_run_cdp_guard", lambda *_, **__: None)

    def spawn(_command, **kwargs):
        process = popen([sys.executable, "-c", "import time; time.sleep(120)"], **kwargs)
        children.append(process)
        return process

    monkeypatch.setattr(chrome.subprocess, "Popen", spawn)
    yield children
    # Own every cleanup target independently of the production registry.
    for process in children:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
    with chrome._chrome_lock:
        for worker_id, process in tuple(chrome._chrome_procs.items()):
            if process in children:
                chrome._chrome_procs.pop(worker_id, None)
                chrome._chrome_identities.pop(worker_id, None)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def launch(worker_id=1, **kwargs):
    return chrome.launch_chrome(
        worker_id, port=kwargs.pop("port", free_port()),
        approved_application_url="https://apply.example.com/job", **kwargs,
    )


@pytest.mark.parametrize("cleanup", [chrome.cleanup_on_exit, chrome.kill_all_chrome])
def test_empty_cleanup_preserves_real_listener_client_and_process_group(tmp_path, cleanup):
    # The base port was swept even with no browser. An independently owned child
    # listens on that exact resource and keeps an established client alive.
    script = (
        "import socket,time,json; s=socket.socket(); s.bind(('127.0.0.1',0)); "
        "s.listen(); print(s.getsockname()[1],flush=True); c,_=s.accept(); "
        "c.sendall(b'owned-control'); time.sleep(120)"
    )
    with subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.PIPE, text=True,
        start_new_session=os.name != "nt",
    ) as control:
        try:
            port = int(control.stdout.readline())
            with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
                assert client.recv(32) == b"owned-control"
                original = chrome.BASE_CDP_PORT
                chrome.BASE_CDP_PORT = port
                try:
                    cleanup()
                finally:
                    chrome.BASE_CDP_PORT = original
                assert control.poll() is None
                client.settimeout(0.05)
                with pytest.raises(TimeoutError):
                    client.recv(1)
        finally:
            control.kill()
            control.wait(timeout=5)


def test_import_and_exit_without_browser_preserve_independent_listener(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        env = dict(os.environ, JOBCTRL_DIR=str(tmp_path / "workspace"))
        result = subprocess.run(
            [sys.executable, "-c", (
                "from jobctrl.apply import chrome; "
                f"chrome.BASE_CDP_PORT={port}; "
                "import jobctrl.apply.launcher; "
                "assert not chrome._chrome_procs"
            )], env=env, capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, result.stderr
        with socket.create_connection(("127.0.0.1", port), timeout=3):
            pass


def test_occupied_port_refuses_before_profile_or_process_creation(browser_seam, tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        with pytest.raises(chrome.BrowserCapabilityError, match="unavailable.*different port"):
            launch(port=listener.getsockname()[1])
        with socket.create_connection(listener.getsockname(), timeout=3):
            pass
    assert browser_seam == []
    assert not (tmp_path / "profiles").exists()
    assert 1 not in chrome._launching_workers


def test_verified_browser_cleanup_preserves_other_browser_and_control(browser_seam):
    first = launch(11)
    second = launch(12)
    # An arbitrary caller-supplied handle cannot select another owned worker.
    chrome.cleanup_worker(11, second)
    assert first.poll() is None
    assert second.poll() is None
    chrome.cleanup_workers([11])
    assert first.wait(timeout=5) != 0
    assert second.poll() is None
    chrome.cleanup_on_exit()
    assert second.wait(timeout=5) != 0
    assert 11 not in chrome._chrome_procs
    assert 12 not in chrome._chrome_procs


@pytest.mark.parametrize("failure", [RuntimeError("guard failed"), KeyboardInterrupt(), SystemExit(1)])
def test_launch_failure_and_cancellation_clean_exact_browser(browser_seam, monkeypatch, failure):
    control = launch(21)

    def fail(*_):
        raise failure

    monkeypatch.setattr(chrome, "_wait_for_browser_cdp_endpoint", fail)
    with pytest.raises(type(failure)):
        launch(22)
    assert browser_seam[-1].wait(timeout=5) != 0
    assert control.poll() is None
    assert 22 not in chrome._chrome_procs
    assert 22 not in chrome._launching_workers
    assert not chrome._launching_ports


def test_spawn_failure_releases_admission_without_signals(browser_seam, monkeypatch):
    def fail(*_, **__):
        raise OSError("synthetic launch failure")

    monkeypatch.setattr(chrome.subprocess, "Popen", fail)
    with pytest.raises(OSError, match="synthetic"):
        launch(23)
    assert 23 not in chrome._launching_workers
    assert 23 not in chrome._chrome_procs
    assert not chrome._launching_ports
    assert browser_seam == []


def test_duplicate_worker_refuses_before_replacing_owned_handle(browser_seam):
    first = launch(31)
    with pytest.raises(chrome.BrowserCapabilityError, match="already has an owner"):
        launch(31)
    assert chrome._chrome_procs[31] is first
    assert len(browser_seam) == 1
    assert first.poll() is None


def test_changed_pid_identity_receives_no_signal(browser_seam, monkeypatch):
    first = launch(41)
    original_pid = first.pid
    # An identity now referring to a recycled PID must not acquire authority.
    control = launch(42)
    try:
        first.pid = control.pid
        with pytest.raises(chrome.BrowserCapabilityError, match="ownership"):
            chrome.cleanup_worker(41, first)
        assert chrome._chrome_procs[41] is first
        assert control.poll() is None
    finally:
        first.pid = original_pid
    assert first.poll() is None


def test_reaped_root_retires_only_after_empty_session_census(browser_seam, monkeypatch):
    process = launch(51)
    process.kill()
    process.wait(timeout=5)
    calls = []
    if os.name != "nt":
        monkeypatch.setattr(os, "killpg", lambda *args: calls.append(args))
    chrome.cleanup_worker(51, process)
    assert calls == []


def test_unregistered_process_and_numeric_pid_receive_no_signal(browser_seam):
    process = launch(61)
    identity = chrome._chrome_identities.pop(61)
    try:
        chrome._kill_process_tree(process.pid)
        assert process.poll() is None
    finally:
        chrome._chrome_identities[61] = identity


@pytest.mark.skipif(os.name == "nt", reason="POSIX session ownership")
def test_unverified_group_refuses_without_signalling(browser_seam, monkeypatch):
    process = launch(71)
    signals = []
    monkeypatch.setattr(os, "getpgid", lambda pid: pid + 1)
    monkeypatch.setattr(os, "killpg", lambda *args: signals.append(args))
    with pytest.raises(chrome.BrowserCapabilityError, match="launch session"):
        chrome.cleanup_worker(71, process)
    assert signals == []
    assert process.poll() is None
    assert chrome._chrome_procs[71] is process


def test_windows_root_handle_exit_retains_unverified_descendant_ownership(monkeypatch):
    # Kernel handles are the Windows ownership primitive; model only that API
    # on POSIX. This does not claim execution on a Windows host.
    calls = []

    class WindowsHandle:
        pid = 43210

        def poll(self):
            return None

        def kill(self):
            calls.append("kernel-handle")

        def wait(self, timeout):
            calls.append(("wait", timeout))

    process = WindowsHandle()
    monkeypatch.setattr(chrome.platform, "system", lambda: "Windows")
    monkeypatch.setattr(chrome.subprocess, "run", lambda *_, **__: pytest.fail("no PID tree tools"))
    with chrome._chrome_lock:
        chrome._chrome_procs[81] = process
        chrome._chrome_identities[81] = (process, process.pid)
    try:
        with pytest.raises(chrome.BrowserCapabilityError, match="Windows Apply descendant exit"):
            chrome.cleanup_worker(81, process)
        assert chrome._chrome_procs[81] is process
        assert chrome._chrome_identities[81] == (process, process.pid)
    finally:
        chrome._chrome_procs.pop(81, None)
        chrome._chrome_identities.pop(81, None)
    assert calls == ["kernel-handle", ("wait", 10)]


@pytest.mark.skipif(os.name == "nt", reason="POSIX session ownership")
def test_owned_session_descendants_exit_while_unrelated_group_survives(browser_seam, tmp_path, monkeypatch):
    import time

    real_popen = browser_seam.popen
    port_file = tmp_path / "child-port"
    child_code = (
        "import socket,time; from pathlib import Path; s=socket.socket(); "
        "s.bind(('127.0.0.1',0)); s.listen(); "
        f"Path({str(port_file)!r}).write_text(str(s.getsockname()[1])); time.sleep(120)"
    )
    parent_code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}]); time.sleep(120)"
    )

    def spawn(_command, **kwargs):
        process = real_popen([sys.executable, "-c", parent_code], **kwargs)
        browser_seam.append(process)
        return process

    monkeypatch.setattr(chrome.subprocess, "Popen", spawn)
    process = launch(91)
    deadline = time.monotonic() + 5
    while not port_file.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert port_file.exists(), "owned browser child did not become ready"
    port = int(port_file.read_text())
    with socket.create_connection(("127.0.0.1", port), timeout=3):
        pass
    with real_popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True) as control:
        actual_killpg = os.killpg
        recorded = []

        def kill_group(pid, sig):
            recorded.append((pid, sig))
            assert process._waitpid_lock.locked()
            actual_killpg(pid, sig)

        monkeypatch.setattr(os, "killpg", kill_group)
        try:
            chrome.cleanup_worker(91, process)
            assert process.returncode != 0
            assert recorded == [(process.pid, 9)]
            assert control.poll() is None
            with socket.socket() as probe:
                assert probe.connect_ex(("127.0.0.1", port)) != 0
        finally:
            control.kill()
            control.wait(timeout=5)


@pytest.mark.skipif(os.name == "nt", reason="POSIX Popen reaping fence")
def test_concurrent_poll_cannot_reap_leader_during_group_signal(browser_seam, monkeypatch):
    import threading

    process = launch(101)
    actual_killpg = os.killpg
    observed = []

    def kill_group(pid, sig):
        actual_killpg(pid, sig)
        poller = threading.Thread(target=lambda: observed.append(process.poll()))
        poller.start()
        poller.join(timeout=3)
        assert not poller.is_alive()
        assert process.returncode is None

    monkeypatch.setattr(os, "killpg", kill_group)
    chrome.cleanup_worker(101, process)
    assert observed == [None]
    assert process.returncode != 0


def test_failed_exit_is_reported_and_does_not_skip_other_owned_cleanup(browser_seam, monkeypatch):
    first = launch(111)
    second = launch(112)
    actual_wait = first.wait

    def timeout(*_, **__):
        raise subprocess.TimeoutExpired("owned synthetic browser", 10)

    monkeypatch.setattr(first, "wait", timeout)
    with pytest.raises(chrome.BrowserCapabilityError, match=r"workers \[111\]"):
        chrome.cleanup_workers([111, 112])
    assert chrome._chrome_procs[111] is first
    assert 112 not in chrome._chrome_procs
    assert second.returncode != 0
    monkeypatch.setattr(first, "wait", actual_wait)
    actual_wait(timeout=5)
    chrome.cleanup_worker(111, first)


@pytest.mark.skipif(os.name == "nt", reason="POSIX Popen reaping fence")
def test_disappeared_group_still_waits_for_original_child(browser_seam, monkeypatch):
    process = launch(131)
    actual_wait = process.wait
    process.kill()
    waits = []

    def missing_group(_pid):
        raise ProcessLookupError()

    def wait(*, timeout):
        waits.append(timeout)
        return actual_wait(timeout=timeout)

    monkeypatch.setattr(os, "getpgid", missing_group)
    monkeypatch.setattr(process, "wait", wait)
    chrome.cleanup_worker(131, process)
    assert waits == [10]
    assert process.returncode != 0
    monkeypatch.setattr(process, "wait", actual_wait)


@pytest.mark.skipif(os.name == "nt", reason="POSIX session completion")
@pytest.mark.parametrize("root_reaped,separate_group", [(True, False), (True, True), (False, True)])
def test_live_session_child_blocks_cleanup_after_root_exit_then_retry_settles(
    browser_seam, tmp_path, monkeypatch, root_reaped, separate_group,
):
    import time
    from jobctrl.infrastructure import process_ownership

    monkeypatch.setattr(process_ownership, "_SESSION_EXIT_TIMEOUT_SECONDS", 0.15)
    control = launch(201)
    selected_peer = launch(203)
    port_file = tmp_path / "surviving-child-port"
    child_code = (
        "import os,socket; from pathlib import Path; "
        + ("os.setpgid(0,0); " if separate_group else "")
        + "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); "
        + f"Path({str(port_file)!r}).write_text(str(s.getsockname()[1])); "
        + "c,_=s.accept(); assert c.recv(16)==b'exit'; c.close(); s.close()"
    )
    parent_code = (
        "import subprocess,sys,time; from pathlib import Path; "
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
        f"p=Path({str(port_file)!r}); "
        "\nwhile not p.exists(): time.sleep(0.01)\n"
        + ("time.sleep(120)\n" if not root_reaped else "")
    )

    def spawn(_command, **kwargs):
        process = browser_seam.popen([sys.executable, "-c", parent_code], **kwargs)
        browser_seam.append(process)
        return process

    monkeypatch.setattr(chrome.subprocess, "Popen", spawn)
    root = launch(202)
    deadline = time.monotonic() + 5
    while not port_file.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert port_file.exists(), "owned surviving child did not start"
    if root_reaped:
        assert root.wait(timeout=5) == 0
    else:
        assert root.poll() is None
    port = int(port_file.read_text())
    signals = []
    actual_killpg = os.killpg

    def signal_group(pid, sig):
        signals.append((pid, sig))
        actual_killpg(pid, sig)

    monkeypatch.setattr(os, "killpg", signal_group)
    expected_signals = ([(root.pid, 9)] if not root_reaped else []) + [(selected_peer.pid, 9)]
    exited_child = False
    try:
        with pytest.raises(chrome.BrowserCapabilityError, match=r"workers \[202\]"):
            chrome.cleanup_workers([202, 203])
        assert chrome._chrome_procs[202] is root
        assert chrome._chrome_identities[202] == (root, root.pid)
        assert 203 not in chrome._chrome_procs
        assert selected_peer.returncode != 0
        assert signals == expected_signals
        assert control.poll() is None
        # The child is still live after its original root has exited/reaped.
        # Request its own controlled exit; do not signal an unanchored old PID.
        with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
            client.sendall(b"exit")
        exited_child = True
        chrome.cleanup_workers([202])
        assert 202 not in chrome._chrome_procs
        assert 202 not in chrome._chrome_identities
        assert signals == expected_signals
        assert control.poll() is None
    finally:
        if not exited_child:
            with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
                client.sendall(b"exit")


@pytest.mark.skipif(os.name == "nt", reason="POSIX session completion")
def test_incomplete_session_census_retains_reaped_browser_owner(browser_seam, monkeypatch):
    from jobctrl.infrastructure import process_ownership

    process = launch(211)
    process.kill()
    process.wait(timeout=5)

    def unreadable(_session_id):
        raise process_ownership.ProcessOwnershipError("synthetic census denied")

    monkeypatch.setattr(process_ownership, "_active_session_members", unreadable)
    monkeypatch.setattr(os, "killpg", lambda *_: pytest.fail("reaped owner cannot signal a group"))
    with pytest.raises(chrome.BrowserCapabilityError, match="census denied"):
        chrome.cleanup_worker(211, process)
    assert chrome._chrome_procs[211] is process
    assert chrome._chrome_identities[211] == (process, process.pid)


@pytest.mark.skipif(os.name == "nt", reason="POSIX actual provider/session cleanup")
def test_actual_provider_cleanup_failure_retains_owner_cleans_peer_and_retries(browser_seam, monkeypatch):
    from jobctrl.infrastructure import process_ownership
    from jobctrl.infrastructure.apply import claude_code_cli

    monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_PROCS", {})
    monkeypatch.setattr(claude_code_cli, "_ACTIVE_CLAUDE_IDENTITIES", {})
    owners = [
        browser_seam.popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
        for _ in range(3)
    ]
    first, peer, control = owners
    for worker_id, process in zip((301, 302, 303), owners):
        claude_code_cli._register_active_claude_process(worker_id, process)
    original_terminate = process_ownership.terminate_owned_process

    def failed_exit(process, *, launched_pid):
        if process is first:
            raise subprocess.TimeoutExpired("owned synthetic provider", 10)
        return original_terminate(process, launched_pid=launched_pid)

    monkeypatch.setattr(process_ownership, "terminate_owned_process", failed_exit)
    try:
        with pytest.raises(RuntimeError, match=r"workers \[301\]"):
            claude_code_cli.kill_active_claude_processes(worker_ids=(301, 302))
        assert first.poll() is None
        assert claude_code_cli._ACTIVE_CLAUDE_PROCS[301] is first
        assert claude_code_cli._ACTIVE_CLAUDE_IDENTITIES[301] == (first, first.pid)
        assert 302 not in claude_code_cli._ACTIVE_CLAUDE_PROCS
        assert peer.returncode != 0
        assert control.poll() is None
        monkeypatch.setattr(process_ownership, "terminate_owned_process", original_terminate)
        claude_code_cli.kill_active_claude_processes(worker_ids=(301,))
        assert 301 not in claude_code_cli._ACTIVE_CLAUDE_PROCS
        assert first.returncode != 0
        assert claude_code_cli._ACTIVE_CLAUDE_PROCS[303] is control
        assert control.poll() is None
    finally:
        for process in owners:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
