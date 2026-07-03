"""Browser-layer dry-run guard integration coverage."""

from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from jobhunter.apply import chrome


class _HostileEmployerHandler(BaseHTTPRequestHandler):
    posts: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook name
        employer_origin = f"http://127.0.0.1.nip.io:{self.server.server_port}"
        body = f"""
        <!doctype html>
        <html>
          <body>
            <form id="application-form" method="post" action="{employer_origin}/form-submit">
              <button type="submit">Submit</button>
            </form>
            <script>
              fetch("{employer_origin}/auto-submit", {{ method: "POST", body: "auto" }}).catch(() => {{}});
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

    def log_message(self, _format: str, *_args: object) -> None:
        return


def test_dry_run_cdp_guard_blocks_hostile_employer_posts(tmp_path, monkeypatch):
    try:
        chrome.config.get_chrome_path()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))

    _HostileEmployerHandler.posts = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _HostileEmployerHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    def setup_profile(worker_id: int) -> Path:
        profile = tmp_path / f"profile-{worker_id}"
        (profile / "Default").mkdir(parents=True, exist_ok=True)
        return profile

    monkeypatch.setattr(chrome, "setup_worker_profile", setup_profile)
    real_popen = chrome.subprocess.Popen

    def popen_with_loopback_host_mapping(cmd, **kwargs):
        mapped_cmd = [
            *cmd,
            "--host-resolver-rules=MAP 127.0.0.1.nip.io 127.0.0.1",
            "--no-proxy-server",
        ]
        return real_popen(mapped_cmd, **kwargs)

    monkeypatch.setattr(chrome.subprocess, "Popen", popen_with_loopback_host_mapping)
    try:
        dry_port = _free_port()
        dry_proc = chrome.launch_chrome(
            worker_id=901,
            port=dry_port,
            headless=True,
            dry_run=True,
        )
        try:
            _wait_for_page_target(dry_port)
            _wait_for_dry_run_guard(dry_port)
            blocked = _navigate_and_read_blocked_flag(
                dry_port,
                f"http://127.0.0.1:{server.server_port}/",
            )
            time.sleep(1.0)
            assert blocked is True
            assert _HostileEmployerHandler.posts == []
        finally:
            chrome.cleanup_worker(901, dry_proc)

        live_port = _free_port()
        live_proc = chrome.launch_chrome(
            worker_id=902,
            port=live_port,
            headless=True,
            dry_run=False,
        )
        try:
            _navigate_and_read_blocked_flag(
                live_port,
                f"http://127.0.0.1:{server.server_port}/",
            )
            deadline = time.time() + 5
            while not _HostileEmployerHandler.posts and time.time() < deadline:
                time.sleep(0.1)
            assert _HostileEmployerHandler.posts
        finally:
            chrome.cleanup_worker(902, live_proc)
    finally:
        server.shutdown()
        server.server_close()


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
                        "return Boolean(window.__jobhunter_dryrun_blocked); })()"
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
                        "expression": "Boolean(window.__jobhunter_dryrun_blocked)",
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
        if _evaluate_boolean(port, "Boolean(window.__jobhunter_dryrun_installed)"):
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
