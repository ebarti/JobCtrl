from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from jobctrl.infrastructure.llm import llm_client


_TOKEN = "a" * 64


def _owned_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, url: str) -> None:
    marker = {
        "schemaVersion": 1,
        "appDir": str(tmp_path),
        "temporaryRoot": str(tmp_path.parent),
        "token": _TOKEN,
        "device": "1",
        "inode": "1",
    }
    (tmp_path / ".jobctrl-e2e-owned.json").write_text(
        json.dumps(marker),
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_DIR", str(tmp_path))
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_APP_DIR", str(tmp_path))
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL", url)
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_TOKEN", _TOKEN)


def test_live_worker_smoke_provider_requires_complete_owned_loopback_configuration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv(
        "JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL",
        "http://127.0.0.1:31000/provider/chat",
    )
    with pytest.raises(RuntimeError, match="Incomplete live-worker smoke"):
        llm_client._live_worker_smoke_provider_config()

    _owned_environment(
        monkeypatch,
        tmp_path,
        "https://provider.example.test/provider/chat",
    )
    with pytest.raises(RuntimeError, match="loopback HTTP URL"):
        llm_client._live_worker_smoke_provider_config()

    monkeypatch.setenv(
        "JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL",
        "http://127.0.0.1:31000/provider/chat",
    )
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_TOKEN", "b" * 64)
    with pytest.raises(RuntimeError, match="does not own this workspace"):
        llm_client._live_worker_smoke_provider_config()


def test_live_worker_smoke_provider_calls_only_the_owned_fixture_boundary(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    observed: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
            assert self.path == "/provider/chat"
            assert self.headers["Authorization"] == f"Bearer {_TOKEN}"
            length = int(self.headers["Content-Length"])
            observed.append(json.loads(self.rfile.read(length)))
            body = json.dumps({"text": "Synthetic provider response"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _owned_environment(
            monkeypatch,
            tmp_path,
            f"http://127.0.0.1:{server.server_port}/provider/chat",
        )
        backend = llm_client.LiveWorkerSmokeBackend()
        result = backend.chat(
            [{"role": "user", "content": "synthetic prompt"}],
            max_tokens=128,
        )
        assert result == "Synthetic provider response"
        assert observed == [
            {
                "operation": "chat",
                "model": "live-worker-smoke-fixture",
                "messages": [{"role": "user", "content": "synthetic prompt"}],
                "controls": {
                    "temperature": None,
                    "maxTokens": 128,
                    "thinkingBudget": None,
                    "structured": False,
                },
            }
        ]
        with pytest.raises(RuntimeError, match="refuses non-fixture provider"):
            llm_client._make_backend("claude", None)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
