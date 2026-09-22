from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from jobctrl import config
from jobctrl.infrastructure.llm import llm_client


_TOKEN = "a" * 64


def _owned_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, url: str) -> None:
    metadata = tmp_path.stat()
    marker = {
        "schemaVersion": 1,
        "appDir": str(tmp_path),
        "temporaryRoot": str(tmp_path.parent),
        "token": _TOKEN,
        "device": str(metadata.st_dev),
        "inode": str(metadata.st_ino),
    }
    (tmp_path / ".jobctrl-e2e-owned.json").write_text(
        json.dumps(marker),
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_DIR", str(tmp_path))
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_APP_DIR", str(tmp_path))
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL", url)
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_TOKEN", _TOKEN)
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP", "1")
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP_VALIDATED", "1")


def test_live_worker_smoke_provider_requires_complete_owned_loopback_configuration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP_VALIDATED", "1")
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP", "1")
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


def _credential_free_bootstrap_environment(
    monkeypatch: pytest.MonkeyPatch,
    workspace: Path,
) -> None:
    workspace.mkdir()
    service_home = workspace / "service-home"
    service_home.mkdir()
    metadata = workspace.stat()
    (workspace / ".jobctrl-e2e-owned.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "appDir": str(workspace),
                "temporaryRoot": str(workspace.parent),
                "token": _TOKEN,
                "device": str(metadata.st_dev),
                "inode": str(metadata.st_ino),
            }
        ),
        encoding="utf-8",
    )
    (workspace / "config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config, "APP_DIR", workspace)
    monkeypatch.setattr(config, "ENV_PATH", workspace / ".env")
    for key in config.LIVE_WORKER_SMOKE_CREDENTIAL_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(config.LIVE_WORKER_SMOKE_BOOTSTRAP_ENV, "1")
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE", "1")
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_APP_DIR", str(workspace))
    monkeypatch.setenv("JOBCTRL_LIVE_WORKER_SMOKE_TOKEN", _TOKEN)
    monkeypatch.setenv("JOBCTRL_DIR", str(workspace))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(workspace / "config.json"))
    monkeypatch.setenv("HOME", str(service_home))
    monkeypatch.setenv("USERPROFILE", str(service_home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(service_home / ".config"))


def test_live_worker_bootstrap_ignores_checkout_dotenv_and_never_probes_keychain(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "owned"
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / ".env").write_text(
        "OPENAI_API_KEY=must-not-load\nANTHROPIC_API_KEY=must-not-load\n",
        encoding="utf-8",
    )
    _credential_free_bootstrap_environment(monkeypatch, workspace)
    monkeypatch.chdir(checkout)
    monkeypatch.setattr(
        config,
        "load_provider_configuration",
        lambda: (_ for _ in ()).throw(AssertionError("provider config must not load")),
    )
    monkeypatch.setattr(
        config,
        "load_macos_keychain_fallbacks",
        lambda: (_ for _ in ()).throw(AssertionError("Keychain must not be queried")),
    )

    assert config.load_env() == ()
    assert config.load_env() == ()
    assert config.LIVE_WORKER_SMOKE_BOOTSTRAP_VALIDATED_ENV in os.environ
    assert "OPENAI_API_KEY" not in os.environ
    assert "ANTHROPIC_API_KEY" not in os.environ


def test_live_worker_bootstrap_rejects_provider_config_credentials_and_host_homes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "owned"
    _credential_free_bootstrap_environment(monkeypatch, workspace)
    (workspace / "config.json").write_text(
        json.dumps(
            {
                "provider_connections": {
                    "google": {"mode": "vertex", "project_id": "real-project"}
                }
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="refuses persisted provider configuration"):
        config.load_env()

    (workspace / "config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "real-credential")
    with pytest.raises(RuntimeError, match="provider credentials or credential homes"):
        config.load_env()
    monkeypatch.delenv("AWS_ACCESS_KEY_ID")

    monkeypatch.setenv("HOME", str(tmp_path / "host-home"))
    with pytest.raises(RuntimeError, match="requires owned HOME"):
        config.load_env()


def test_live_worker_provider_requires_completed_credential_free_bootstrap(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _owned_environment(
        monkeypatch,
        tmp_path,
        "http://127.0.0.1:31000/provider/chat",
    )
    monkeypatch.delenv("JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP_VALIDATED")
    with pytest.raises(RuntimeError, match="requires validated credential-free bootstrap"):
        llm_client._live_worker_smoke_provider_config()
