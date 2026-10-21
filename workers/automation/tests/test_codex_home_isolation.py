"""Codex SDK CODEX_HOME isolation + permissions-profile regression tests.

These tests pin both invariants for the Codex analysis leg:

* JobCtrl uses its own ``<APP_DIR>/codex_home`` so app-server session state does
  not clutter the user's normal Codex app history;
* prompt-driven commands can read only ``CODEX_HOME/workspace`` plus Codex's
  minimal runtime paths, not ``CODEX_HOME/auth.json``.
"""

from __future__ import annotations

import os
import stat
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.request import Request

import pytest

import jobctrl.config
from jobctrl.infrastructure import setup_probes
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


def _assert_private_mode(path: Path, expected: int) -> None:
    if os.name != "nt":
        assert _mode(path) == expected


def _write_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o700)
    return path


def _profile_filesystem_permissions(overrides: tuple[str, ...]) -> dict[str, object]:
    profile_override = next(
        value
        for value in overrides
        if value.startswith(f"permissions.{adapter._CODEX_PERMISSION_PROFILE}=")
    )
    parsed = tomllib.loads(profile_override)
    return parsed["permissions"][adapter._CODEX_PERMISSION_PROFILE]["filesystem"]


def _assert_isolated_auth_env(env: dict[str, str]) -> None:
    credential_keys = set(setup_probes.CODEX_NEUTRALIZED_AUTH_ENV) - {
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
    }
    assert all(env[key] == "" for key in credential_keys)
    assert env["CODEX_REFRESH_TOKEN_URL_OVERRIDE"] == "https://auth.openai.com/oauth/token"
    assert env["CODEX_REVOKE_TOKEN_URL_OVERRIDE"] == "https://auth.openai.com/oauth/revoke"


def test_config_overrides_select_workspace_only_permission_profile() -> None:
    profile = adapter._CODEX_PERMISSION_PROFILE
    binary = Path("/trusted/codex-bin")
    overrides = adapter._codex_config_overrides(binary)

    assert "features.plugins=false" in overrides
    assert "features.apps=false" in overrides
    assert "features.shell_tool=false" in overrides
    assert "allow_login_shell=false" in overrides
    assert 'project_root_markers=[".git"]' in overrides
    assert 'shell_environment_policy={inherit="none"}' in overrides
    assert f'default_permissions="{profile}"' in overrides

    filesystem = _profile_filesystem_permissions(overrides)
    assert filesystem[":root"] == "deny"
    assert filesystem[":minimal"] == "read"
    assert filesystem[":workspace_roots"] == {".": "read"}
    assert filesystem[str(binary)] == "read"
    assert "network={enabled=false}" in overrides[-1]


def test_canonical_codex_binary_resolves_symlink_and_rejects_sibling_access(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    if os.name == "nt":
        pytest.skip("symlink path semantics are covered on supported Unix runtimes")
    binary = _write_executable(tmp_path / 'provider-pack/site-packages/codex "binary"')
    sibling = _write_executable(binary.with_name("sibling-canary"))
    alias = tmp_path / "codex-alias"
    alias.symlink_to(binary)
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: alias)

    canonical = adapter._canonical_codex_binary()
    filesystem = _profile_filesystem_permissions(adapter._codex_config_overrides(canonical))

    assert canonical == binary.resolve()
    assert filesystem == {
        ":root": "deny",
        ":minimal": "read",
        ":workspace_roots": {".": "read"},
        str(canonical): "read",
    }
    assert str(alias) not in filesystem
    assert str(canonical.parent) not in filesystem
    assert str(sibling) not in filesystem


@pytest.mark.parametrize("binary_kind", ["missing", "directory", "not-executable"])
def test_canonical_codex_binary_requires_one_existing_executable_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, binary_kind: str
) -> None:
    binary = tmp_path / "codex-bin"
    if binary_kind == "directory":
        binary.mkdir()
    elif binary_kind == "not-executable":
        binary.write_text("not executable", encoding="utf-8")
        binary.chmod(0o600)
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: binary)

    with pytest.raises(RuntimeError, match="Codex binary"):
        adapter._canonical_codex_binary()


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
    _assert_private_mode(dirs.codex_home, 0o700)
    _assert_private_mode(dirs.workdir, 0o700)
    _assert_private_mode(dirs.process_home, 0o700)

    copied_auth = dirs.codex_home / "auth.json"
    assert copied_auth.is_file()
    assert copied_auth.read_bytes() == payload
    _assert_private_mode(copied_auth, 0o600)
    assert not (dirs.workdir / "auth.json").exists()


def test_catalog_prepare_does_not_copy_ambient_codex_auth(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text(
        '{"OPENAI_API_KEY":"sk-must-not-copy"}',
        encoding="utf-8",
    )

    dirs = adapter._prepare_isolated_codex_home(ensure_auth=False)

    assert dirs.codex_home == app_dir / "codex_home"
    assert not (dirs.codex_home / "auth.json").exists()
    assert (source_codex_home / "auth.json").is_file()


def test_isolated_codex_env_is_minimal_for_jobctrl_home(tmp_path: Path) -> None:
    codex_home = tmp_path / "codex_home"
    process_home = codex_home / "home"

    env = adapter._isolated_codex_env(codex_home, process_home)

    assert env["CODEX_HOME"] == str(codex_home)
    assert env["HOME"] == str(process_home)
    _assert_isolated_auth_env(env)


@pytest.mark.parametrize(
    ("env_key", "expected_path"),
    (
        ("CODEX_REFRESH_TOKEN_URL_OVERRIDE", "/oauth/token"),
        ("CODEX_REVOKE_TOKEN_URL_OVERRIDE", "/oauth/revoke"),
    ),
)
def test_sdk_auth_endpoints_remain_valid_and_ignore_ambient_redirects(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    env_key: str,
    expected_path: str,
) -> None:
    monkeypatch.setenv(env_key, "https://untrusted.invalid/collect")
    overrides = adapter._isolated_codex_env(tmp_path / "codex", tmp_path / "home")
    child_env = {**os.environ, **overrides}  # the SDK merges overrides into ambient env

    # Build the request without sending it: an empty override fails here before
    # authentication can report an expired/rejected saved login.
    request = Request(child_env[env_key], data=b"synthetic", method="POST")

    assert request.type == "https"
    assert request.host == "auth.openai.com"
    assert request.selector == expected_path


def test_bundled_codex_uses_persisted_auth_and_neutralizes_raw_keys(
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

    dirs = adapter._prepare_isolated_codex_home()
    env = adapter._isolated_codex_env(dirs.codex_home, dirs.process_home)

    assert dirs.codex_home == app_dir / "codex_home"
    assert (dirs.codex_home / "auth.json").is_file()
    assert (source_codex_home / "auth.json").is_file()
    assert env == {
        "CODEX_HOME": str(dirs.codex_home),
        "HOME": str(dirs.process_home),
        "OPENAI_API_KEY": "",
        "CODEX_API_KEY": "",
        "CODEX_ACCESS_TOKEN": "",
        "CODEX_AGENT_IDENTITY_AUTH": "",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE": "https://auth.openai.com/oauth/token",
        "CODEX_REVOKE_TOKEN_URL_OVERRIDE": "https://auth.openai.com/oauth/revoke",
    }


def test_bundled_codex_factory_uses_persisted_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import jobctrl.runtime
    import openai_codex

    app_dir = tmp_path / "jobctrl"
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-bundled")
    auth = app_dir / "codex_home/auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text('{"OPENAI_API_KEY":"sk-persisted"}', encoding="utf-8")
    monkeypatch.setattr(jobctrl.runtime, "activate_provider_pack", lambda *_args, **_kwargs: None)
    binary = _write_executable(tmp_path / "codex-bin")
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: binary)

    class FakeAsyncCodex:
        def __init__(self, *, config: Any) -> None:
            self.config = config

    monkeypatch.setattr(openai_codex, "AsyncCodex", FakeAsyncCodex)

    codex = adapter._load_async_codex_factory()()

    assert codex.config.codex_bin == str(binary.resolve())
    assert codex.config.config_overrides == adapter._codex_config_overrides(binary.resolve())
    assert codex.config.env["OPENAI_API_KEY"] == ""
    _assert_isolated_auth_env(codex.config.env)


@pytest.mark.parametrize("factory_name", ["_load_async_codex_factory", "_load_catalog_async_codex_factory"])
@pytest.mark.parametrize("runtime_mode", ["source", "bundled"])
def test_codex_factories_grant_only_the_exact_canonical_binary_across_runtime_layouts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    factory_name: str,
    runtime_mode: str,
) -> None:
    import jobctrl.runtime
    import openai_codex

    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text('{"OPENAI_API_KEY":"sk-source"}', encoding="utf-8")
    binary = _write_executable(
        tmp_path / runtime_mode / "site-packages/codex_cli_bin/bin/codex"
    )
    sibling = _write_executable(binary.with_name("provider-pack-canary"))
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: binary)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", runtime_mode)
    pack_calls: list[tuple[str, Path]] = []

    if runtime_mode == "bundled":
        auth = app_dir / "codex_home/auth.json"
        auth.parent.mkdir(parents=True)
        auth.write_text('{"OPENAI_API_KEY":"sk-bundled"}', encoding="utf-8")
        monkeypatch.setattr(
            jobctrl.runtime,
            "activate_provider_pack",
            lambda pack_id, *, app_dir: pack_calls.append((pack_id, app_dir)),
        )

    class FakeAsyncCodex:
        def __init__(self, *, config: Any) -> None:
            self.config = config

    monkeypatch.setattr(openai_codex, "AsyncCodex", FakeAsyncCodex)

    codex = getattr(adapter, factory_name)()()
    canonical = binary.resolve()
    filesystem = _profile_filesystem_permissions(codex.config.config_overrides)

    assert codex.config.codex_bin == str(canonical)
    assert filesystem[str(canonical)] == "read"
    assert str(canonical.parent) not in filesystem
    assert str(sibling) not in filesystem
    assert pack_calls == ([('codex-provider-runtime', app_dir)] if runtime_mode == "bundled" else [])


@pytest.mark.asyncio
async def test_live_factory_uses_jobctrl_codex_home_without_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir, source_codex_home = _isolate_homes(monkeypatch, tmp_path)
    (source_codex_home / "auth.json").write_text('{"OPENAI_API_KEY":"sk-fake-factory"}')
    binary = _write_executable(tmp_path / "codex-bin")
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: binary)

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
            assert self.config.codex_bin == str(binary.resolve())
            assert self.config.config_overrides == adapter._codex_config_overrides(binary.resolve())
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
    binary = _write_executable(tmp_path / "codex-bin")
    monkeypatch.setattr(adapter, "resolve_codex_binary", lambda: binary)

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


def _kit_workspace_report(dirs):
    from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
    from agent_runtime_kit.adapters.codex import CodexAgentRuntime

    overrides = tuple(value for value in adapter._codex_config_overrides(Path("/owned/codex"))
                      if value != f'default_permissions="{adapter._CODEX_PERMISSION_PROFILE}"')
    runtime = CodexAgentRuntime(
        env=adapter._isolated_codex_env(dirs.codex_home, dirs.process_home),
        config_overrides=overrides,
    )
    task = AgentTask(
        goal="Owned configuration boundary check; no provider call",
        model="gpt-6.1-sol",
        reasoning_effort="max",
        working_directory=dirs.workdir,
        permissions=PermissionProfile(
            mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY,
            native_profile=adapter._CODEX_PERMISSION_PROFILE,
        ),
    )
    return runtime, task, runtime.validate_task(task)


def test_prepared_workspace_bounds_kit_configuration_to_owned_root(monkeypatch, tmp_path):
    retained_home = tmp_path / "retained-user-home"
    ancestor = retained_home / ".codex" / "config.toml"
    ancestor.parent.mkdir(parents=True)
    original = 'sandbox_mode="read-only"\nproject_root_markers=[".foreign-root"]\n'
    ancestor.write_text(original)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", retained_home / ".jobctrl")

    dirs = adapter._prepare_isolated_codex_home(ensure_auth=False)
    runtime, task, report = _kit_workspace_report(dirs)

    assert not report.issues
    paths = runtime._native_config_paths(task)
    assert dirs.codex_home / "config.toml" in paths
    assert Path("/etc/codex/config.toml") in paths
    assert dirs.workdir / ".codex" / "config.toml" in paths
    assert ancestor not in paths
    assert ancestor.read_text() == original
    assert not (dirs.codex_home / "auth.json").exists()


@pytest.mark.parametrize("scope", ["workspace", "isolated_home"])
def test_workspace_root_does_not_hide_effective_config_conflicts(monkeypatch, tmp_path, scope):
    _isolate_homes(monkeypatch, tmp_path)
    dirs = adapter._prepare_isolated_codex_home(ensure_auth=False)
    path = dirs.workdir / ".codex" / "config.toml" if scope == "workspace" else dirs.codex_home / "config.toml"
    path.parent.mkdir(exist_ok=True)
    path.write_text('sandbox_mode="read-only"\n')

    _runtime, _task, report = _kit_workspace_report(dirs)

    assert any(issue.field == "permissions.native_profile" for issue in report.issues)
    assert path.read_text() == 'sandbox_mode="read-only"\n'


@pytest.mark.parametrize("directory", ["codex_home", "workspace", "home"])
def test_redirected_runtime_directories_are_refused_before_auth_or_chmod(monkeypatch, tmp_path, directory):
    app_dir, _source = _isolate_homes(monkeypatch, tmp_path)
    codex_home = app_dir / "codex_home"
    target = codex_home if directory == "codex_home" else codex_home / directory
    target.mkdir(parents=True, mode=0o755)
    original = Path.lstat
    enrolled = []
    monkeypatch.setattr(adapter, "ensure_jobctrl_codex_auth", lambda: enrolled.append(True))

    def with_reparse(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path != target:
            return info
        return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink,
                               st_file_attributes=0x400, st_reparse_tag=0xA0000003)

    mode_before = target.stat().st_mode
    with monkeypatch.context() as patch:
        patch.setattr(Path, "lstat", with_reparse)
        with pytest.raises(RuntimeError, match="Codex"):
            adapter._prepare_isolated_codex_home()
    assert target.stat().st_mode == mode_before
    assert not (target / "auth.json").exists()
    if directory == "codex_home":
        assert enrolled == []
