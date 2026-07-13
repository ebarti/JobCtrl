"""Setup/doctor expose one core-provider gate, not a Claude synthesis gate."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

import jobctrl.config
from jobctrl import cli as cli_module
from jobctrl.cli import app
from jobctrl.infrastructure import setup_probes


_ARGS = [
    "setup",
    "--skip-system",
    "--skip-dependencies",
    "--skip-browsers",
    "--skip-doctor",
    "--non-interactive",
    "--dry-run",
    "--json",
]

_MUTATING_SETUP_ARGS = [arg for arg in _ARGS if arg != "--dry-run"]
_HUMAN_SETUP_ARGS = [arg for arg in _MUTATING_SETUP_ARGS if arg != "--json"]


def _write_codex_auth(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"tokens": {"access_token": "test-access-token"}}),
        encoding="utf-8",
    )


def _prepare_codex_setup_test(
    monkeypatch: pytest.MonkeyPatch,
    *,
    app_dir: Path,
    source_home: Path,
) -> None:
    monkeypatch.setenv("CODEX_HOME", str(source_home))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CODEX_API_KEY", raising=False)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(jobctrl.config, "ensure_dirs", lambda: app_dir.mkdir(parents=True))
    monkeypatch.setattr(jobctrl.config, "load_env", lambda: ())
    monkeypatch.setattr(cli_module, "_write_env_updates", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        setup_probes,
        "resolve_codex_binary",
        lambda env=None: app_dir / "codex",
    )
    monkeypatch.setattr(setup_probes, "_CODEX_AUTH_STATUS_CACHE", {})
    original_verify = setup_probes.verify_codex_connection

    def verify_codex_connection(env=None):
        return original_verify(
            env,
            runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=0),
        )

    monkeypatch.setattr(
        setup_probes,
        "verify_codex_connection",
        verify_codex_connection,
    )

    def probe_analysis_setup(env=None):
        probe = setup_probes.probe_codex_auth(env)
        return [
            setup_probes.ProbeResult(
                "core LLM provider",
                probe.ok,
                "ready: codex" if probe.ok else "authenticate a provider",
            )
        ]

    monkeypatch.setattr(setup_probes, "probe_analysis_setup", probe_analysis_setup)


def test_setup_json_reports_any_provider_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        setup_probes,
        "probe_analysis_setup",
        lambda env=None: [setup_probes.ProbeResult("core LLM provider", True, "ready: codex")],
    )
    monkeypatch.setattr(
        setup_probes,
        "probe_codex_auth",
        lambda env=None: setup_probes.ProbeResult("Codex analysis auth", True, "persisted CLI auth"),
    )

    result = CliRunner().invoke(app, _ARGS)

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["analysisReady"] is True


def test_setup_json_reports_none_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        setup_probes,
        "probe_analysis_setup",
        lambda env=None: [setup_probes.ProbeResult("core LLM provider", False, "authenticate a provider")],
    )
    monkeypatch.setattr(
        setup_probes,
        "probe_codex_auth",
        lambda env=None: setup_probes.ProbeResult("Codex analysis auth", False, "not authenticated"),
    )

    result = CliRunner().invoke(app, _ARGS)

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["analysisReady"] is False
    assert payload["analysisNotReadyReason"] == "authenticate a provider"


def test_setup_copies_and_uses_valid_ambient_codex_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    _write_codex_auth(source_home / "auth.json")
    _prepare_codex_setup_test(
        monkeypatch,
        app_dir=app_dir,
        source_home=source_home,
    )

    result = CliRunner().invoke(app, _MUTATING_SETUP_ARGS)

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["analysisReady"] is True
    core_row = next(row for row in payload["analysis"] if row["name"] == "core LLM provider")
    assert core_row["ok"] is True
    target = app_dir / "codex_home/auth.json"
    assert target.is_file()
    assert target.read_bytes() == (source_home / "auth.json").read_bytes()


def test_setup_human_output_has_no_stale_warning_after_copying_codex_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    _write_codex_auth(source_home / "auth.json")
    _prepare_codex_setup_test(
        monkeypatch,
        app_dir=app_dir,
        source_home=source_home,
    )

    result = CliRunner().invoke(app, _HUMAN_SETUP_ARGS)

    assert result.exit_code == 0, result.output
    assert "core LLM provider" in result.output
    assert "WARN" not in result.output
    assert "Core AI provider ready." in result.output


def test_setup_fallback_prepares_private_owned_codex_home_before_login(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    source_home.mkdir()
    (source_home / "auth.json").write_text("{}", encoding="utf-8")
    _prepare_codex_setup_test(monkeypatch, app_dir=app_dir, source_home=source_home)
    ambient_auth = {
        key: f"ambient-{key.lower()}"
        for key in setup_probes.CODEX_NEUTRALIZED_AUTH_ENV
    }
    for key, value in ambient_auth.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(
        cli_module,
        "_confirm_setup_action",
        lambda prompt, **_kwargs: "Enroll the current OpenAI key" in prompt,
    )
    calls = 0

    def login_runner(_command, **kwargs):
        nonlocal calls
        calls += 1
        target_home = Path(kwargs["env"]["CODEX_HOME"])
        assert all(
            key not in kwargs["env"]
            for key in setup_probes.CODEX_NEUTRALIZED_AUTH_ENV
        )
        assert kwargs["input"] == ambient_auth["OPENAI_API_KEY"] + "\n"
        assert target_home == app_dir / "codex_home"
        assert target_home.is_dir() and not target_home.is_symlink()
        if os.name != "nt":
            assert stat.S_IMODE(target_home.stat().st_mode) == 0o700
        target_auth = target_home / "auth.json"
        _write_codex_auth(target_auth)
        target_auth.chmod(0o600)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", login_runner)

    result = CliRunner().invoke(app, [*_MUTATING_SETUP_ARGS, "--launch-logins"])

    assert result.exit_code == 0, result.output
    assert calls == 1
    assert (source_home / "auth.json").read_text(encoding="utf-8") == "{}"


def test_setup_fallback_rejects_non_directory_owned_codex_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    source_home.mkdir()
    (source_home / "auth.json").write_text("{}", encoding="utf-8")
    _prepare_codex_setup_test(monkeypatch, app_dir=app_dir, source_home=source_home)
    app_dir.mkdir()
    target_home = app_dir / "codex_home"
    target_home.write_text("not a directory", encoding="utf-8")
    monkeypatch.setattr(jobctrl.config, "ensure_dirs", lambda: None)
    monkeypatch.setattr(
        cli_module,
        "_confirm_setup_action",
        lambda prompt, **_kwargs: "Authenticate JobCtrl's Codex CLI" in prompt,
    )
    def unexpected_login(*_args, **_kwargs):
        raise AssertionError("unsafe Codex home reached the login subprocess")

    monkeypatch.setattr(subprocess, "run", unexpected_login)

    result = CliRunner().invoke(app, [*_MUTATING_SETUP_ARGS, "--launch-logins"])

    assert result.exit_code == 1
    assert "Unsafe JobCtrl Codex home" in result.output


@pytest.mark.parametrize("source_kind", ["invalid", "symlink"])
def test_setup_rejects_unsafe_ambient_codex_auth_without_creating_target(
    source_kind: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    source = source_home / "auth.json"
    source.parent.mkdir(parents=True)
    if source_kind == "invalid":
        source.write_text("{}", encoding="utf-8")
    else:
        real_source = tmp_path / "real-auth.json"
        _write_codex_auth(real_source)
        source.symlink_to(real_source)
    _prepare_codex_setup_test(
        monkeypatch,
        app_dir=app_dir,
        source_home=source_home,
    )

    result = CliRunner().invoke(app, _MUTATING_SETUP_ARGS)

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["analysisReady"] is False
    target = app_dir / "codex_home/auth.json"
    assert target.exists() is False
    assert target.parent.exists() is False
    if source_kind == "invalid":
        assert source.read_text(encoding="utf-8") == "{}"
    else:
        assert source.is_symlink()
