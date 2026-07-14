"""Bundled payload isolation and provider-auth contract tests."""

from __future__ import annotations

import importlib
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from typer.testing import CliRunner

from jobctrl import config, runtime
from jobctrl import cli as cli_module
from jobctrl.cli import app
from jobctrl.infrastructure import setup_probes
from jobctrl.provider_packs import (
    ProviderWheelSpec,
    install_provider_pack,
    parse_provider_pack_spec,
)


def _bundled_env(tmp_path: Path) -> dict[str, str]:
    payload = tmp_path / "payload"
    payload.mkdir()
    return {
        runtime.RUNTIME_MODE_ENV: "bundled",
        runtime.PAYLOAD_DIR_ENV: str(payload),
    }


def _write_active_provider_pack(
    state: Path,
    pack_id: str,
    *,
    exact_packages: tuple[str, ...],
    files: dict[str, tuple[bytes, int]],
) -> tuple[Path, dict[str, object]]:
    """Write a minimal installer-shaped active pack for a core-only probe."""

    version = "1.0-test"
    wheel_inputs = state.parent / "wheel-inputs" / pack_id
    wheel_inputs.mkdir(parents=True)
    wheels: list[dict[str, object]] = []
    for index, package in enumerate(exact_packages):
        filename = f"{package.replace('-', '_')}-1.0-py3-none-any.whl"
        wheel_path = wheel_inputs / filename
        members = files if index == 0 else {}
        with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, (content, mode) in members.items():
                info = zipfile.ZipInfo(relative)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | mode) << 16
                archive.writestr(info, content)
            marker = zipfile.ZipInfo(
                f"{package.replace('-', '_')}-1.0.dist-info/WHEEL"
            )
            marker.create_system = 3
            marker.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(marker, b"Wheel-Version: 1.0\n")
        wheels.append(
            {
                "package": package,
                "version": "1.0",
                "url": f"https://files.pythonhosted.org/packages/{filename}",
                "sha256": hashlib.sha256(wheel_path.read_bytes()).hexdigest(),
                "sizeBytes": wheel_path.stat().st_size,
            }
        )
    pack = {
        "id": pack_id,
        "version": version,
        "owner": "test",
        "source": f"https://pypi.org/project/{exact_packages[0]}/",
        "license": "test-only",
        "redistribution": "official-download",
        "isolation": "independent-site-packages",
        "exactPackages": list(exact_packages),
        "wheels": wheels,
    }
    spec = parse_provider_pack_spec(pack)

    def fetch(wheel: ProviderWheelSpec, destination: Path) -> None:
        shutil.copyfile(wheel_inputs / wheel.filename, destination)

    installed = install_provider_pack(spec, app_dir=state, fetcher=fetch)
    return installed / "site-packages", pack


def test_bundled_load_env_reads_only_state_owned_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / ".env").write_text("JOBCTRL_OWNED_SENTINEL=owned\n", encoding="utf-8")
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / ".env").write_text("JOBCTRL_CWD_SENTINEL=leaked\n", encoding="utf-8")
    monkeypatch.chdir(checkout)
    monkeypatch.setattr(config, "APP_DIR", state)
    monkeypatch.setattr(config, "_KEYCHAIN_FALLBACK_DIAGNOSTICS", ())
    for key, value in _bundled_env(tmp_path).items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("JOBCTRL_OWNED_SENTINEL", raising=False)
    monkeypatch.delenv("JOBCTRL_CWD_SENTINEL", raising=False)

    config.load_env()

    assert os.environ["JOBCTRL_OWNED_SENTINEL"] == "owned"
    assert "JOBCTRL_CWD_SENTINEL" not in os.environ


def test_bundled_env_override_must_remain_inside_state(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    outside = tmp_path / "outside.env"
    outside.write_text("SECRET=do-not-read\n", encoding="utf-8")
    monkeypatch.setattr(config, "APP_DIR", state)
    for key, value in _bundled_env(tmp_path).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv(runtime.ENV_FILE_ENV, str(outside))

    with pytest.raises(runtime.RuntimeConfigurationError, match="inside the JobCtrl state"):
        config.get_env_path()


def test_bundled_default_env_rejects_symlink_outside_state(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    outside = tmp_path / "outside.env"
    outside.write_text("SECRET=do-not-read\n", encoding="utf-8")
    (state / ".env").symlink_to(outside)
    monkeypatch.setattr(config, "APP_DIR", state)
    for key, value in _bundled_env(tmp_path).items():
        monkeypatch.setenv(key, value)

    with pytest.raises(runtime.RuntimeConfigurationError, match="inside the JobCtrl state"):
        config.get_env_path()


def test_payload_paths_require_absolute_root_and_reject_traversal(tmp_path: Path) -> None:
    env = _bundled_env(tmp_path)
    component = Path(env[runtime.PAYLOAD_DIR_ENV]) / "python" / "bin" / "python3"
    component.parent.mkdir(parents=True)
    component.write_text("", encoding="utf-8")

    assert runtime.payload_path("python/bin/python3", env) == component
    with pytest.raises(runtime.RuntimeConfigurationError, match="safe relative"):
        runtime.payload_path("../outside", env, require_exists=False)
    with pytest.raises(runtime.RuntimeConfigurationError, match="absolute"):
        runtime.payload_dir({**env, runtime.PAYLOAD_DIR_ENV: "relative"})


def test_bundled_provider_binary_overrides_are_always_rejected(tmp_path: Path) -> None:
    malicious = tmp_path / "state/provider-packs/extra-bin"
    malicious.parent.mkdir(parents=True)
    malicious.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    malicious.chmod(0o755)
    base = _bundled_env(tmp_path)

    with pytest.raises(runtime.RuntimeConfigurationError, match="overrides are disabled"):
        setup_probes.resolve_claude_apply_binary(
            {**base, "JOBCTRL_CLAUDE_BIN": str(malicious)}
        )
    with pytest.raises(runtime.RuntimeConfigurationError, match="overrides are disabled"):
        setup_probes.resolve_codex_binary({**base, "JOBCTRL_CODEX_BIN": str(malicious)})


def test_bundled_codex_auth_requires_persisted_cli_state(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    monkeypatch.setattr(config, "APP_DIR", app_dir)
    base = {**_bundled_env(tmp_path), "CODEX_HOME": str(tmp_path / "source-empty")}

    raw_only = setup_probes.probe_codex_auth({**base, "OPENAI_API_KEY": "sk-bundled"})
    alias_only = setup_probes.probe_codex_auth({**base, "CODEX_API_KEY": "consumer-alias"})
    missing = setup_probes.probe_codex_auth(base)
    auth = app_dir / "codex_home/auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text('{"tokens":{"access_token":"bundled-test"}}', encoding="utf-8")
    monkeypatch.setattr(
        setup_probes,
        "_cached_verify_codex_connection",
        lambda values: (True, "connected", "Codex CLI authentication verified"),
    )
    ready = setup_probes.probe_codex_auth(base)

    assert ready.ok is True
    assert raw_only.ok is False
    assert alias_only.ok is False
    assert "not enrolled" in alias_only.note
    assert missing.ok is False


@pytest.mark.parametrize(
    "consumer_env",
    [
        {"CLAUDE_CODE_OAUTH_TOKEN": "oauth"},
        {"CLAUDE_CODE_OAUTH_REFRESH_TOKEN": "refresh"},
        {"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR": "9"},
        {"CCR_OAUTH_TOKEN_FILE": "/tmp/consumer-oauth"},
        {"ANTHROPIC_AUTH_TOKEN": "consumer"},
    ],
)
def test_bundled_claude_rejects_consumer_auth(
    tmp_path: Path,
    consumer_env: dict[str, str],
) -> None:
    probe = setup_probes.probe_claude_auth({**_bundled_env(tmp_path), **consumer_env})

    assert probe.ok is False
    assert "consumer OAuth" in probe.note


@pytest.mark.parametrize(
    ("auth", "expected"),
    [
        ({"ANTHROPIC_API_KEY": "api"}, "ANTHROPIC_API_KEY"),
        ({"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_PROFILE": "work"}, "Amazon Bedrock"),
        (
            {
                "CLAUDE_CODE_USE_FOUNDRY": "yes",
                "ANTHROPIC_FOUNDRY_RESOURCE": "resource",
                "ANTHROPIC_FOUNDRY_API_KEY": "key",
            },
            "Microsoft Foundry",
        ),
    ],
)
def test_bundled_claude_accepts_only_api_and_supported_cloud_modes(
    tmp_path: Path,
    auth: dict[str, str],
    expected: str,
) -> None:
    probe = setup_probes.probe_claude_auth({**_bundled_env(tmp_path), **auth})

    assert probe.ok is True
    assert expected in probe.note


def test_bundled_claude_child_is_isolated_and_omits_consumer_tokens(tmp_path: Path) -> None:
    env = {
        **_bundled_env(tmp_path),
        "ANTHROPIC_API_KEY": "api-key",
        "CLAUDE_CODE_OAUTH_TOKEN": "consumer-oauth",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN": "consumer-refresh",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR": "9",
        "CCR_OAUTH_TOKEN_FILE": "/tmp/consumer-oauth",
        "ANTHROPIC_AUTH_TOKEN": "consumer-token",
        "GOOGLE_ANTIGRAVITY_OAUTH_TOKEN": "unrelated-oauth",
    }

    sdk_options = setup_probes.bundled_claude_sdk_options(env)
    sdk_env = sdk_options["env"]
    assert sdk_options["setting_sources"] == []
    assert sdk_options["extra_args"] == {"bare": None}
    assert sdk_env["CLAUDE_CODE_OAUTH_TOKEN"] == ""
    assert sdk_env["CLAUDE_CODE_OAUTH_REFRESH_TOKEN"] == ""
    assert sdk_env["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"] == ""
    assert sdk_env["CCR_OAUTH_TOKEN_FILE"] == ""
    assert sdk_env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert "HOME" not in sdk_env

    child_env = setup_probes.bundled_claude_process_auth_env(env)
    assert child_env["ANTHROPIC_API_KEY"] == "api-key"
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in child_env
    assert "ANTHROPIC_AUTH_TOKEN" not in child_env
    assert "GOOGLE_ANTIGRAVITY_OAUTH_TOKEN" not in child_env


def test_bundled_antigravity_does_not_accept_consumer_session(tmp_path: Path) -> None:
    env = {
        **_bundled_env(tmp_path),
        "GOOGLE_ANTIGRAVITY_OAUTH_TOKEN": "oauth",
        "GOOGLE_ANTIGRAVITY_SESSION": "session",
    }

    with pytest.raises(RuntimeError, match="not reused"):
        setup_probes.antigravity_auth_kwargs(env)


def test_bundled_antigravity_accepts_key_or_vertex(tmp_path: Path) -> None:
    base = _bundled_env(tmp_path)
    credentials = tmp_path / ".config" / "gcloud" / "application_default_credentials.json"
    credentials.parent.mkdir(parents=True)
    credentials.write_text(
        json.dumps(
            {
                "type": "authorized_user",
                "client_id": "test-client",
                "client_secret": "test-secret",
                "refresh_token": "test-refresh",
            }
        ),
        encoding="utf-8",
    )
    assert setup_probes.antigravity_auth_kwargs({**base, "GEMINI_API_KEY": "key"}) == {
        "api_key": "key"
    }
    assert setup_probes.antigravity_auth_kwargs(
        {
            **base,
            "HOME": str(tmp_path),
            "GOOGLE_GENAI_USE_VERTEXAI": "1",
            "GOOGLE_CLOUD_PROJECT": "project-a",
        }
    ) == {"vertex": True, "project": "project-a"}


def test_bundled_setup_never_runs_repository_toolchains(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    commands: list[list[str]] = []
    for key, value in _bundled_env(tmp_path).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(config, "_KEYCHAIN_FALLBACK_DIAGNOSTICS", ())

    def capture(command: list[str], **_kwargs: object) -> int:
        commands.append(command)
        return 0

    monkeypatch.setattr(cli_module, "_run_setup_step", capture)

    result = CliRunner().invoke(
        app,
        ["setup", "--non-interactive", "--dry-run", "--json"],
    )

    assert result.exit_code == 0, result.output
    flattened = {part for command in commands for part in command}
    assert {"pnpm", "uv", "corepack", "playwright"}.isdisjoint(flattened)
    assert commands == [[os.sys.executable, "-I", "-B", "-m", "jobctrl", "doctor"]]


def test_bundled_setup_never_launches_codex_login_for_consumer_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    for key, value in _bundled_env(tmp_path).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("CODEX_API_KEY", "unsupported-consumer-alias")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthesis-key")
    monkeypatch.setattr(config, "_KEYCHAIN_FALLBACK_DIAGNOSTICS", ())
    subprocess_calls: list[list[str]] = []

    def unexpected_subprocess(command: list[str], **_kwargs: object) -> None:
        subprocess_calls.append(command)
        raise AssertionError(f"bundled setup attempted a login subprocess: {command}")

    monkeypatch.setattr(subprocess, "run", unexpected_subprocess)

    result = CliRunner().invoke(
        app,
        [
            "setup",
            "--launch-logins",
            "--non-interactive",
            "--dry-run",
            "--skip-doctor",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert subprocess_calls == []
    assert "codex login" not in result.output


def test_core_modules_import_with_provider_imports_blocked() -> None:
    script = """
import importlib.abc
import sys

BLOCKED = ("claude_agent_sdk", "openai_codex", "codex_cli_bin", "google.antigravity")

class BlockProviders(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if any(fullname == name or fullname.startswith(name + ".") for name in BLOCKED):
            raise ImportError(f"provider import attempted during core boot: {fullname}")
        return None

sys.meta_path.insert(0, BlockProviders())
import jobctrl.cli
import jobctrl.infrastructure.analysis.claude_analysis_adapter
import jobctrl.infrastructure.analysis.codex_analysis_adapter
import jobctrl.infrastructure.analysis.antigravity_analysis_adapter
"""

    completed = subprocess.run(
        [sys.executable, "-c", script],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr


def test_bundled_sdk_probes_activate_core_only_provider_packs_before_import(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Exercise activation's defensive bytecode suppression even though the
    # production launcher also invokes Python with `-B`.
    monkeypatch.setattr(sys, "dont_write_bytecode", False)
    state = tmp_path / "state"
    claude_site, claude_pack = _write_active_provider_pack(
        state,
        "claude-agent-sdk",
        exact_packages=("claude-agent-sdk",),
        files={
            "claude_agent_sdk/__init__.py": (b"", 0o644),
            "claude_agent_sdk/_cli_version.py": (
                b"__cli_version__ = 'claude-test-1.0'\n",
                0o644,
            ),
            "claude_agent_sdk/_bundled/claude": (b"#!/bin/sh\nexit 0\n", 0o755),
        },
    )
    codex_site, codex_pack = _write_active_provider_pack(
        state,
        "codex-provider-runtime",
        exact_packages=("openai-codex", "openai-codex-cli-bin"),
        files={
            "openai_codex/__init__.py": (b"", 0o644),
            "codex_cli_bin/__init__.py": (
                b"from pathlib import Path\n"
                b"def bundled_codex_path():\n"
                b"    return str(Path(__file__).resolve().parent / 'bin' / 'codex')\n",
                0o644,
            ),
            "codex_cli_bin/bin/codex": (
                b"#!/bin/sh\nprintf 'codex-test 1.0\\n'\n",
                0o755,
            ),
        },
    )
    antigravity_site, antigravity_pack = _write_active_provider_pack(
        state,
        "antigravity-provider-runtime",
        exact_packages=("google-antigravity",),
        files={
            "google/antigravity/__init__.py": (b"", 0o644),
            "google/antigravity/bin/localharness": (b"#!/bin/sh\nexit 0\n", 0o755),
            "google_antigravity-1.0.dist-info/METADATA": (
                b"Metadata-Version: 2.1\nName: google-antigravity\nVersion: 1.0\n",
                0o644,
            ),
        },
    )

    bundled_env = _bundled_env(tmp_path)
    lock_path = Path(bundled_env[runtime.PAYLOAD_DIR_ENV]) / "release/provider-packs.lock.json"
    lock_path.parent.mkdir()
    lock_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "platform": "darwin-arm64",
                "python": "cpython-3.12",
                "coreSelector": "core-only probe fixture",
                "packs": [claude_pack, codex_pack, antigravity_pack],
            }
        ),
        encoding="utf-8",
    )
    for key, value in bundled_env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(config, "APP_DIR", state)

    provider_prefixes = ("claude_agent_sdk", "openai_codex", "codex_cli_bin", "google")

    def is_provider_module(name: str) -> bool:
        return name in provider_prefixes or name.startswith(
            tuple(f"{prefix}." for prefix in provider_prefixes)
        )

    saved_modules = {
        name: module
        for name, module in sys.modules.items()
        if is_provider_module(name)
    }
    for name in saved_modules:
        sys.modules.pop(name, None)
    core_sys_path = [entry for entry in sys.path if "site-packages" not in entry]
    monkeypatch.setattr(sys, "path", core_sys_path)

    try:
        for module_name in (
            "claude_agent_sdk",
            "openai_codex",
            "codex_cli_bin",
            "google.antigravity",
        ):
            with pytest.raises(ModuleNotFoundError):
                importlib.import_module(module_name)

        claude = setup_probes.probe_claude_sdk()
        codex = setup_probes.probe_codex_sdk()
        antigravity = setup_probes.probe_antigravity_sdk()

        assert claude.ok, claude.note
        assert "claude-test-1.0" in claude.note
        assert codex.ok, codex.note
        assert "codex-test 1.0" in codex.note
        assert antigravity.ok, antigravity.note
        assert "google-antigravity 1.0" in antigravity.note
        assert {str(claude_site), str(codex_site), str(antigravity_site)}.issubset(sys.path)
        assert sys.dont_write_bytecode is True
        assert not any(state.rglob("__pycache__"))
    finally:
        for name in tuple(sys.modules):
            if is_provider_module(name):
                sys.modules.pop(name, None)
        sys.modules.update(saved_modules)
