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


def test_exited_leader_cannot_authorize_reused_group(browser_seam, monkeypatch):
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


def test_windows_cleanup_uses_original_process_handle_not_pid_tree(monkeypatch):
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
        chrome.cleanup_worker(81, process)
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
