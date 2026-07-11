"""Codex SDK CODEX_HOME isolation + permissions-profile regression tests.

These tests pin both invariants for the Codex analysis leg:

* JobCtrl uses its own ``<APP_DIR>/codex_home`` so app-server session state does
  not clutter the user's normal Codex app history;
* prompt-driven commands can read only ``CODEX_HOME/workspace`` plus Codex's
  minimal runtime paths, not ``CODEX_HOME/auth.json``.
"""

from __future__ import annotations

import stat
from pathlib import Path
from typing import Any

import pytest

import jobctrl.config
from jobctrl.infrastructure.analysis import codex_analysis_adapter as adapter


def _isolate_homes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, Path]:
    """Redirect ``APP_DIR`` and source ``CODEX_HOME`` under ``tmp_path``."""

    app_dir = tmp_path / "jobctrl"
    source_codex_home = tmp_path / "source-codex"
    source_codex_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setenv("CODEX_HOME", str(source_codex_home))
    return app_dir, source_codex_home


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_config_overrides_select_workspace_only_permission_profile() -> None:
    profile = adapter._CODEX_PERMISSION_PROFILE
    overrides = adapter._CODEX_CONFIG_OVERRIDES

    assert "features.plugins=false" in overrides
    assert "features.apps=false" in overrides
    assert "features.shell_tool=false" in overrides
    assert "allow_login_shell=false" in overrides
    assert 'shell_environment_policy={inherit="none"}' in overrides
    assert f'default_permissions="{profile}"' in overrides

    profile_override = next(value for value in overrides if value.startswith(f"permissions.{profile}="))
    assert '":root"="deny"' in profile_override
    assert '":minimal"="read"' in profile_override
    assert '":workspace_roots"={"."="read"}' in profile_override
    assert "network={enabled=false}" in profile_override


def test_prepare_isolated_codex_home_copies_auth_outside_workspace(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    payload = b'{"OPENAI_API_KEY":"sk-isolation-token"}'
    (source_codex_home / "auth.json").write_bytes(payload)

    dirs = adapter._prepare_isolated_codex_home()

    assert dirs.codex_home == app_dir / "codex_home"
    assert dirs.workdir == dirs.codex_home / "workspace"
    assert dirs.process_home == dirs.codex_home / "home"
    assert _mode(dirs.codex_home) == 0o700
    assert _mode(dirs.workdir) == 0o700
    assert _mode(dirs.process_home) == 0o700

    copied_auth = dirs.codex_home / "auth.json"
    assert copied_auth.is_file()
    assert copied_auth.read_bytes() == payload
    assert _mode(copied_auth) == 0o600
    assert not (dirs.workdir / "auth.json").exists()


def test_isolated_codex_env_is_minimal_for_jobctrl_home(tmp_path: Path) -> None:
    codex_home = tmp_path / "codex_home"
    process_home = codex_home / "home"

    env = adapter._isolated_codex_env(codex_home, process_home)

    assert env == {"CODEX_HOME": str(codex_home), "HOME": str(process_home)}


def test_bundled_codex_uses_only_api_key_and_never_reads_or_copies_consumer_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text(
        '{"tokens":{"access_token":"consumer"}}',
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-bundled")
    monkeypatch.setenv("CODEX_API_KEY", "consumer-alias")
    monkeypatch.setenv("CODEX_ACCESS_TOKEN", "consumer-access")
    monkeypatch.setenv("CODEX_AGENT_IDENTITY_AUTH", "consumer-identity")
    monkeypatch.setenv("CODEX_REFRESH_TOKEN_URL_OVERRIDE", "https://consumer.test/refresh")
    monkeypatch.setenv("CODEX_REVOKE_TOKEN_URL_OVERRIDE", "https://consumer.test/revoke")

    def unexpected_consumer_auth_read() -> Path:
        raise AssertionError("bundled Codex must not resolve ambient CODEX_HOME/auth.json")

    monkeypatch.setattr(adapter, "codex_auth_path", unexpected_consumer_auth_read)

    dirs = adapter._prepare_isolated_codex_home()
    env = adapter._isolated_codex_env(dirs.codex_home, dirs.process_home)

    assert dirs.codex_home == app_dir / "provider-runtime/codex"
    assert not (dirs.codex_home / "auth.json").exists()
    assert (source_codex_home / "auth.json").is_file()
    assert env == {
        "CODEX_HOME": str(dirs.codex_home),
        "HOME": str(dirs.process_home),
        "OPENAI_API_KEY": "sk-bundled",
        "CODEX_API_KEY": "",
        "CODEX_ACCESS_TOKEN": "",
        "CODEX_AGENT_IDENTITY_AUTH": "",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE": "",
        "CODEX_REVOKE_TOKEN_URL_OVERRIDE": "",
    }


def test_bundled_codex_factory_forces_api_login_with_ephemeral_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import jobctrl.runtime
    import openai_codex

    app_dir = tmp_path / "jobctrl"
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-bundled")
    monkeypatch.setattr(jobctrl.runtime, "activate_provider_pack", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: tmp_path / "codex-bin")

    class FakeAsyncCodex:
        def __init__(self, *, config: Any) -> None:
            self.config = config

    monkeypatch.setattr(openai_codex, "AsyncCodex", FakeAsyncCodex)

    codex = adapter._load_async_codex_factory()()

    assert codex.config.config_overrides == (
        *adapter._CODEX_CONFIG_OVERRIDES,
        'forced_login_method="api"',
        'cli_auth_credentials_store="ephemeral"',
    )
    assert codex.config.env["OPENAI_API_KEY"] == "sk-bundled"
    assert all(
        codex.config.env[key] == ""
        for key in adapter._CODEX_BUNDLED_NEUTRALIZED_AUTH_ENV
    )


@pytest.mark.asyncio
async def test_live_factory_uses_jobctrl_codex_home_without_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text('{"OPENAI_API_KEY":"sk-fake-factory"}')
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: tmp_path / "codex-bin")

    class FakeAsyncCodex:
        instances: list["FakeAsyncCodex"] = []

        def __init__(self, *, config: Any) -> None:
            self.config = config
            self.exited = False
            FakeAsyncCodex.instances.append(self)

        async def __aenter__(self) -> "FakeAsyncCodex":
            codex_home = Path(self.config.env["CODEX_HOME"])
            assert codex_home == app_dir / "codex_home"
            assert Path(self.config.cwd) == codex_home / "workspace"
            assert Path(self.config.env["HOME"]) == codex_home / "home"
            assert (codex_home / "auth.json").is_file()
            assert not (Path(self.config.cwd) / "auth.json").exists()
            assert self.config.config_overrides == adapter._CODEX_CONFIG_OVERRIDES
            return self

        async def __aexit__(self, *exc: Any) -> None:
            self.exited = True

    import openai_codex

    monkeypatch.setattr(openai_codex, "AsyncCodex", FakeAsyncCodex)

    factory = adapter._load_async_codex_factory()
    async with factory() as codex:
        config = codex.config
        codex_home = Path(config.env["CODEX_HOME"])
        assert Path(config.cwd) == codex_home / "workspace"
        assert (source_codex_home / "auth.json").is_file()

    assert FakeAsyncCodex.instances[0].exited is True
    assert codex_home.exists()
    assert (source_codex_home / "auth.json").is_file()


@pytest.mark.asyncio
async def test_live_factory_uses_same_jobctrl_codex_home_when_contexts_overlap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text('{"OPENAI_API_KEY":"sk-fake-concurrent"}')
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: tmp_path / "codex-bin")

    class FakeAsyncCodex:
        instances: list["FakeAsyncCodex"] = []

        def __init__(self, *, config: Any) -> None:
            self.config = config
            FakeAsyncCodex.instances.append(self)

        async def __aenter__(self) -> "FakeAsyncCodex":
            assert (Path(self.config.env["CODEX_HOME"]) / "auth.json").is_file()
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

    import openai_codex

    monkeypatch.setattr(openai_codex, "AsyncCodex", FakeAsyncCodex)

    factory = adapter._load_async_codex_factory()
    first_context = factory()
    second_context = factory()

    first_home = Path(FakeAsyncCodex.instances[0].config.env["CODEX_HOME"])
    second_home = Path(FakeAsyncCodex.instances[1].config.env["CODEX_HOME"])
    assert first_home == second_home == app_dir / "codex_home"

    async with first_context as first_codex:
        async with second_context as second_codex:
            assert Path(first_codex.config.cwd) == first_home / "workspace"
            assert Path(second_codex.config.cwd) == first_home / "workspace"
            assert (first_home / "auth.json").is_file()


@pytest.mark.asyncio
async def test_pinned_app_server_denies_auth_file_and_strips_provider_key_from_commands(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text('{"OPENAI_API_KEY":"sk-fake-runtime"}')
    monkeypatch.setenv("OPENAI_API_KEY", "sk-command-must-not-see-this")

    from openai_codex.generated.v2_all import CommandExecResponse

    factory = adapter._load_async_codex_factory()
    async with factory() as codex:
        config = codex._client._sync.config
        codex_home = Path(config.env["CODEX_HOME"])
        assert Path(config.cwd) == codex_home / "workspace"
        assert (codex_home / "auth.json").is_file()

        response = await codex._client.request(
            "command/exec",
            {
                "command": [
                    "/bin/sh",
                    "-c",
                    'if cat "$CODEX_HOME/auth.json" >/dev/null 2>&1; '
                    'then printf "FILE:READABLE "; else printf "FILE:DENIED "; fi; '
                    'printf "ENV:%s" "${OPENAI_API_KEY-}"',
                ],
                "cwd": config.cwd,
                "permissionProfile": adapter._CODEX_PERMISSION_PROFILE,
                "timeoutMs": 5000,
            },
            response_model=CommandExecResponse,
        )

    assert response.exit_code == 0
    assert "sk-fake-runtime" not in response.stdout
    assert "sk-command-must-not-see-this" not in response.stdout
    assert response.stdout == "FILE:DENIED ENV:"
    assert codex_home.exists()
