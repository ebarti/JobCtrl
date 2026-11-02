from __future__ import annotations

import json
import errno
import os
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from jobctrl import cli as cli_module, config, native_credentials as credentials
from jobctrl.cli import app


SECRET = "synthetic-secret-must-not-leak"


class FakeStore:
    kind = "macos_keychain"
    system_name = "Darwin"

    def __init__(self, values: dict[str, str] | None = None) -> None:
        self.values = dict(values or {})
        self.fail_write = False
        self.fail_readback = False

    def read(self, key: str) -> str | None:
        value = self.values.get(key)
        return f"{value}-corrupt" if self.fail_readback and value is not None else value

    def write(self, key: str, value: str) -> None:
        if self.fail_write:
            raise credentials.NativeCredentialError("sanitized write failure")
        self.values[key] = value

    def delete(self, key: str) -> None:
        self.values.pop(key, None)


def test_cross_runtime_native_target_mapping_contract() -> None:
    assert credentials.native_credential_target("GEMINI_API_KEY", system_name="Darwin") == (
        "JobCtrl",
        "GEMINI_API_KEY",
    )
    assert credentials.native_credential_target("GEMINI_API_KEY", system_name="Linux") == (
        "service",
        "JobCtrl",
        "key",
        "GEMINI_API_KEY",
    )
    assert credentials.native_credential_target("GEMINI_API_KEY", system_name="Windows") == (
        "JobCtrl:GEMINI_API_KEY",
        "JobCtrl",
    )
    assert credentials.native_store_label("Linux") == "Linux Secret Service"
    assert credentials.native_store_label("Windows") == "Windows Credential Manager"


def test_native_fallback_preserves_nonempty_environment_precedence() -> None:
    store = FakeStore({key: f"native-{key}" for key in credentials.PROVIDER_SECRET_KEYS})
    env = {"ANTHROPIC_API_KEY": "inherited"}

    diagnostics = credentials.load_native_credential_fallbacks(env=env, store=store)  # type: ignore[arg-type]

    assert env["ANTHROPIC_API_KEY"] == "inherited"
    assert env["GEMINI_API_KEY"] == "native-GEMINI_API_KEY"
    assert next(item for item in diagnostics if item.key == "ANTHROPIC_API_KEY").status == "explicit"
    assert SECRET not in repr(diagnostics)


def test_linux_absence_and_idempotent_delete_are_confirmed_by_metadata_search(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(os, "access", lambda *_args: True)
    calls: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        if command[1] in {"clear", "lookup"}:
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="")
        if command[1] == "search":
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        raise AssertionError(command)

    store = credentials.NativeCredentialStore(system_name="Linux", run=run)
    assert store.read("OPENAI_API_KEY") is None
    store.delete("OPENAI_API_KEY")
    assert [call[1] for call in calls] == ["lookup", "search", "clear", "lookup", "search"]


def test_windows_runner_keeps_unicode_secret_out_of_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["command"] = command
        captured["input"] = kwargs["input"]
        captured["timeout"] = kwargs["timeout"]
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    value = f"  {SECRET}-☃  "
    store = credentials.NativeCredentialStore(
        system_name="Windows",
        environ={"SystemRoot": r"C:\Windows"},
        run=run,
    )
    store.write("ANTHROPIC_API_KEY", value)

    assert value not in json.dumps(captured["command"])
    assert json.loads(str(captured["input"]))["value"] == value
    assert captured.get("timeout") == credentials.WINDOWS_COMMAND_TIMEOUT_SECONDS
    script = str(captured["command"][-1])
    assert 'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"' in script
    assert script.index("Import-Module") < script.index("Add-Type")
    assert "InputEncoding" in str(captured["command"])
    assert "OutputEncoding" in str(captured["command"])


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        ('password: "deadbeef"', "deadbeef"),
        ('password: "quote-""', 'quote-"'),
        (f'password: 0x{"snowman-☃".encode().hex()} "display"', "snowman-☃"),
    ],
)
def test_macos_typed_private_read_is_exact(monkeypatch: pytest.MonkeyPatch, stderr: str, expected: str) -> None:
    monkeypatch.setattr(os, "access", lambda *_args: True)

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        assert command[-1] == "-g"
        return subprocess.CompletedProcess(command, 0, stdout="metadata", stderr=stderr)

    assert credentials.NativeCredentialStore(system_name="Darwin", run=run).read("GEMINI_API_KEY") == expected


def test_migration_moves_duplicates_and_quoted_values_once_without_touching_unrelated_lines(tmp_path: Path) -> None:
    first = tmp_path / "first.env"
    second = tmp_path / "second.env"
    marker = tmp_path / "state" / "migration.json"
    first.write_text(f"OTHER=keep\nANTHROPIC_API_KEY='{SECRET}-old'\n", encoding="utf-8")
    second.write_text(
        f'export ANTHROPIC_API_KEY="{SECRET}-final" # launcher override\nGEMINI_API_KEY=gemini-value\n',
        encoding="utf-8",
    )
    store = FakeStore()

    result = credentials.migrate_persistent_env_credentials([first, second], marker, store=store)  # type: ignore[arg-type]

    assert result.migrated_keys == ("ANTHROPIC_API_KEY", "GEMINI_API_KEY")
    assert store.values == {
        "ANTHROPIC_API_KEY": f"{SECRET}-final",
        "GEMINI_API_KEY": "gemini-value",
    }
    assert first.read_text(encoding="utf-8") == "OTHER=keep\n"
    assert second.read_text(encoding="utf-8") == ""
    assert stat_mode(marker) == 0o600
    assert SECRET not in marker.read_text(encoding="utf-8")
    assert credentials.migrate_persistent_env_credentials([first, second], marker, store=store).already_completed  # type: ignore[arg-type]


def test_migration_preserves_crlf_bytes_in_retained_lines(tmp_path: Path) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker"
    source.write_bytes(f"KEEP=one\r\nANTHROPIC_API_KEY={SECRET}\r\nTAIL=two\r\n".encode())

    credentials.migrate_persistent_env_credentials([source], marker, store=FakeStore())  # type: ignore[arg-type]

    assert source.read_bytes() == b"KEEP=one\r\nTAIL=two\r\n"


def test_migration_locks_each_existing_source_directory_once_in_stable_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_dir, second_dir = tmp_path / "a", tmp_path / "b"
    first_dir.mkdir()
    second_dir.mkdir()
    first, second = first_dir / ".env", second_dir / ".env"
    first.write_text("ANTHROPIC_API_KEY=first-synthetic\n", encoding="utf-8")
    second.write_text("ANTHROPIC_API_KEY=lower-precedence\nGEMINI_API_KEY=second-synthetic\n", encoding="utf-8")
    missing = tmp_path / "missing" / ".env"
    marker = tmp_path / "marker"
    acquired: list[Path] = []
    original_lock = config.config_file_lock

    @contextmanager
    def observed_lock(*, path):
        with original_lock(path=path):
            acquired.append(path.parent)
            yield

    monkeypatch.setattr(config, "config_file_lock", observed_lock)
    store = FakeStore()
    credentials.migrate_persistent_env_credentials(
        [second, first, first_dir / "absent.env", missing], marker, store=store,  # type: ignore[arg-type]
    )
    assert acquired == [first_dir.resolve(), second_dir.resolve()]
    assert not missing.parent.exists()
    assert store.values == {"ANTHROPIC_API_KEY": "first-synthetic", "GEMINI_API_KEY": "second-synthetic"}
    assert first.read_text(encoding="utf-8") == "" and second.read_text(encoding="utf-8") == ""


def test_absent_source_in_read_only_unrelated_directory_does_not_block_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    owned, unrelated = tmp_path / "owned", tmp_path / "unrelated"
    owned.mkdir()
    unrelated.mkdir(mode=0o500)
    source = owned / ".env"
    source.write_text("KEEP=unchanged\nGEMINI_API_KEY=synthetic-owned\n", encoding="utf-8")
    absent = unrelated / ".env"
    marker = owned / "marker"
    original_lock = config.config_file_lock
    denied = []
    before = unrelated.stat().st_mtime_ns

    @contextmanager
    def denied_lock(*, path):
        if path.parent == unrelated.resolve():
            denied.append(path)
            raise PermissionError(errno.EACCES, "synthetic read-only directory")
        with original_lock(path=path):
            yield

    monkeypatch.setattr(config, "config_file_lock", denied_lock)
    store = FakeStore()
    result = credentials.migrate_persistent_env_credentials([source, absent], marker, store=store)  # type: ignore[arg-type]
    assert result.migrated_keys == ("GEMINI_API_KEY",)
    assert store.values == {"GEMINI_API_KEY": "synthetic-owned"}
    assert source.read_text(encoding="utf-8") == "KEEP=unchanged\n"
    assert marker.exists() and denied
    assert list(unrelated.iterdir()) == [] and unrelated.stat().st_mtime_ns == before


def test_denied_owned_inner_workspace_cannot_publish_marker_after_second_workspace_creates_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    outer = tmp_path / "outer"
    inner = outer / "inner"
    inner.mkdir(parents=True, mode=0o500)
    source = inner / ".env"
    marker = outer / "custom-marker.json"
    store = FakeStore()
    monkeypatch.setattr(config, "APP_DIR", outer)
    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-prior")
    original_lock = config.config_file_lock
    original_check = credentials._require_absent_sources
    absence_checked, release_migration = threading.Event(), threading.Event()
    outcomes: list[object] = []

    @contextmanager
    def denied_outer_lock(*, path):
        if threading.current_thread() is migration_thread and path.parent == inner.resolve():
            raise PermissionError(errno.EACCES, "synthetic owned directory lock denied")
        with original_lock(path=path):
            yield

    def pause_after_absence(paths):
        original_check(paths)
        if source in paths:
            absence_checked.set()
            assert release_migration.wait(5)

    monkeypatch.setattr(config, "config_file_lock", denied_outer_lock)
    monkeypatch.setattr(credentials, "_require_absent_sources", pause_after_absence)

    def migrate():
        try:
            outcomes.append(credentials.migrate_persistent_env_credentials([source], marker, store=store))  # type: ignore[arg-type]
        except Exception as exc:
            outcomes.append(exc)

    migration_thread = threading.Thread(target=migrate)
    migration_thread.start()
    try:
        assert absence_checked.wait(3)
        assert stat_mode(inner) == 0o500
        # A second workspace owns the inner directory and can repair its mode.
        monkeypatch.setattr(config, "APP_DIR", inner)
        cli_module._write_env_updates(source, {"GEMINI_API_KEY": "synthetic-late"}, dry_run=False, quiet=True)
        assert source.exists() and not marker.exists()
    finally:
        release_migration.set()
        migration_thread.join(timeout=5)
    assert not migration_thread.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], credentials.NativeCredentialMigrationError)
    assert "cannot be locked" in str(outcomes[0]) and "retry" in str(outcomes[0])
    assert not marker.exists() and store.values == {}
    assert source.read_text(encoding="utf-8").endswith("GEMINI_API_KEY=synthetic-late\n")

    # Once the inner workspace has created the source, retry migrates it.
    monkeypatch.setattr(config, "APP_DIR", outer)
    result = credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]
    assert result.migrated_keys == ("GEMINI_API_KEY",)
    assert store.values == {"GEMINI_API_KEY": "synthetic-late"}
    assert "synthetic-late" not in source.read_text(encoding="utf-8") and marker.exists()


def test_custom_marker_in_source_directory_keeps_writer_blocked_through_marker_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = tmp_path / "owned"
    owner.mkdir()
    source = owner / ".env"
    marker = owner / "custom-marker.json"
    source.write_text("KEEP=synthetic\nGEMINI_API_KEY=synthetic-key\n", encoding="utf-8")
    monkeypatch.setattr(config, "APP_DIR", owner)
    monkeypatch.setenv("SYNTHETIC_SETTING", "prior")
    store = FakeStore()
    marker_waiting, release_marker = threading.Event(), threading.Event()
    writer_attempted, writer_finished = threading.Event(), threading.Event()
    outcomes: list[object] = []
    original_marker = credentials._write_marker
    original_lock = config.config_file_lock

    def pause_marker(path, keys):
        marker_waiting.set()
        assert release_marker.wait(5)
        original_marker(path, keys)

    @contextmanager
    def observed_lock(*, path):
        if threading.current_thread() is writer_thread:
            writer_attempted.set()
        with original_lock(path=path) as lock:
            yield lock

    monkeypatch.setattr(credentials, "_write_marker", pause_marker)
    monkeypatch.setattr(config, "config_file_lock", observed_lock)

    def migrate():
        try:
            outcomes.append(credentials.migrate_persistent_env_credentials([source], marker, store=store))  # type: ignore[arg-type]
        except Exception as exc:
            outcomes.append(exc)

    def write_setting():
        try:
            cli_module._write_env_updates(source, {"SYNTHETIC_SETTING": "updated"}, dry_run=False, quiet=True)
        except Exception as exc:
            outcomes.append(exc)
        finally:
            writer_finished.set()

    migration_thread = threading.Thread(target=migrate)
    writer_thread = threading.Thread(target=write_setting)
    migration_thread.start()
    try:
        assert marker_waiting.wait(3)
        assert (owner / ".custom-marker.json.lock").is_file()
        assert (owner / ".config.lock").is_dir() and not marker.exists()
        writer_thread.start()
        assert writer_attempted.wait(3)
        assert not writer_finished.wait(0.05), "the writer must wait until the marker is published"
    finally:
        release_marker.set()
        migration_thread.join(timeout=5)
        if writer_thread.ident is not None:
            writer_thread.join(timeout=5)
    assert not migration_thread.is_alive() and not writer_thread.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], credentials.MigrationResult)
    assert marker.exists() and not (owner / ".custom-marker.json.lock").exists()
    assert not (owner / ".config.lock").exists()
    assert store.values == {"GEMINI_API_KEY": "synthetic-key"}
    assert source.read_text(encoding="utf-8") == "KEEP=synthetic\nSYNTHETIC_SETTING=updated\n"


@pytest.mark.parametrize("kind", ["file", "symlink"])
def test_denied_lock_refuses_a_source_that_appeared_before_absence_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str,
) -> None:
    owned, unrelated = tmp_path / "owned", tmp_path / "unrelated"
    owned.mkdir()
    unrelated.mkdir()
    source = owned / ".env"
    original = "GEMINI_API_KEY=synthetic-owned\n"
    source.write_text(original, encoding="utf-8")
    appeared = unrelated / ".env"
    marker = owned / "marker"
    original_lock = config.config_file_lock

    @contextmanager
    def denied_lock(*, path):
        if path.parent == unrelated.resolve():
            if kind == "file":
                appeared.write_text("ANTHROPIC_API_KEY=synthetic-late\n", encoding="utf-8")
            else:
                appeared.symlink_to(unrelated / "missing-target")
            raise PermissionError(errno.EACCES, "synthetic denied lock")
        with original_lock(path=path):
            yield

    monkeypatch.setattr(config, "config_file_lock", denied_lock)
    store = FakeStore()
    with pytest.raises(credentials.NativeCredentialMigrationError, match="unlocked credential source exists"):
        credentials.migrate_persistent_env_credentials([source, appeared], marker, store=store)  # type: ignore[arg-type]
    assert source.read_text(encoding="utf-8") == original and store.values == {}
    if kind == "symlink":
        assert appeared.is_symlink()
    else:
        assert appeared.read_text(encoding="utf-8") == "ANTHROPIC_API_KEY=synthetic-late\n"
    assert not marker.exists()


@pytest.mark.parametrize("missing_parent", [False, True])
def test_source_appearing_in_unlocked_directory_rolls_back_before_completion_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing_parent: bool,
) -> None:
    owned, unrelated = tmp_path / "owned", tmp_path / "unrelated"
    owned.mkdir()
    if not missing_parent:
        unrelated.mkdir()
    source = owned / ".env"
    original = b"KEEP=unchanged\r\nGEMINI_API_KEY=synthetic-owned\r\n"
    source.write_bytes(original)
    appeared = unrelated / ".env"
    marker = owned / "marker"
    original_lock = config.config_file_lock

    @contextmanager
    def denied_lock(*, path):
        if path.parent == unrelated.resolve():
            raise PermissionError(errno.EACCES, "synthetic denied lock")
        with original_lock(path=path):
            yield

    monkeypatch.setattr(config, "config_file_lock", denied_lock)

    class AppearingSourceStore(FakeStore):
        def write(self, key: str, value: str) -> None:
            super().write(key, value)
            appeared.parent.mkdir(parents=True, exist_ok=True)
            appeared.write_text("ANTHROPIC_API_KEY=synthetic-late\n", encoding="utf-8")

    store = AppearingSourceStore()
    with pytest.raises(credentials.NativeCredentialMigrationError, match="unlocked credential source exists"):
        credentials.migrate_persistent_env_credentials([source, appeared], marker, store=store)  # type: ignore[arg-type]
    assert source.read_bytes() == original and store.values == {}
    assert appeared.read_text(encoding="utf-8") == "ANTHROPIC_API_KEY=synthetic-late\n"
    assert not marker.exists()


def test_missing_bundled_env_parent_refuses_marker_even_if_setup_creates_source_after_absence_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = tmp_path / "owned"
    owner.mkdir()
    source = owner / "nested" / ".env"
    marker = tmp_path / "custom-marker.json"
    monkeypatch.setattr(config, "APP_DIR", owner)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_ENV_FILE", str(source))
    monkeypatch.setenv("GEMINI_API_KEY", "test-preexisting-process-value")
    assert config.get_env_path() == source
    fake_store = FakeStore()
    monkeypatch.setattr(credentials, "NativeCredentialStore", lambda: fake_store)
    absence_checked, release_migration = threading.Event(), threading.Event()
    original_check = credentials._require_absent_sources
    results = []

    def pause_after_absence(paths):
        original_check(paths)
        if source in paths:
            absence_checked.set()
            assert release_migration.wait(5)

    monkeypatch.setattr(credentials, "_require_absent_sources", pause_after_absence)

    def migrate():
        results.append(CliRunner().invoke(app, ["credentials", "migrate", "--marker", str(marker)]))

    migration_thread = threading.Thread(target=migrate)
    migration_thread.start()
    try:
        assert absence_checked.wait(3)
        # This real setup writer creates the source in the exact former gap:
        # the absence check has passed, but the marker has not been published.
        cli_module._write_env_updates(source, {"GEMINI_API_KEY": "synthetic-new"}, dry_run=False, quiet=True)
        assert not marker.exists()
    finally:
        release_migration.set()
        migration_thread.join(timeout=5)
    assert not migration_thread.is_alive()
    assert results and results[0].exit_code == 1
    output = " ".join(results[0].output.lower().split())
    assert "directory is missing" in output and "retry" in output
    assert not marker.exists() and fake_store.values == {}
    assert source.read_text(encoding="utf-8").endswith("GEMINI_API_KEY=synthetic-new\n")

    # Once setup creates the parent, a normal retry migrates that exact source.
    result = CliRunner().invoke(app, ["credentials", "migrate", "--marker", str(marker)])
    assert result.exit_code == 0, result.output
    assert fake_store.values == {"GEMINI_API_KEY": "synthetic-new"}
    assert "synthetic-new" not in source.read_text(encoding="utf-8")
    assert marker.exists()


def test_default_first_use_allows_missing_optional_source_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    owner = tmp_path / "owned"
    source = owner / ".env"
    optional = tmp_path / "optional" / ".env"
    marker = owner / "marker.json"
    monkeypatch.setattr(config, "APP_DIR", owner)
    store = FakeStore()

    result = credentials.migrate_persistent_env_credentials([source, optional], marker, store=store)  # type: ignore[arg-type]
    assert not result.already_completed and result.migrated_keys == ()
    assert marker.exists() and not source.exists() and not optional.parent.exists()


@pytest.mark.parametrize("workspace", ["outer", "inner"])
def test_nested_workspaces_refuse_missing_shared_owned_source_without_creating_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workspace: str,
) -> None:
    outer = tmp_path / "outer"
    inner = outer / "inner"
    inner.mkdir(parents=True)
    source = inner / "missing" / ".env"
    owner = outer if workspace == "outer" else inner
    monkeypatch.setattr(config, "APP_DIR", owner)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_ENV_FILE", str(source))
    marker = tmp_path / f"{workspace}-marker.json"
    store = FakeStore()
    assert config.get_env_path() == source

    with pytest.raises(credentials.NativeCredentialMigrationError, match="directory is missing"):
        credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]
    assert not source.parent.exists() and not marker.exists() and store.values == {}


def test_owned_source_parent_symlink_cannot_escape_to_missing_external_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner, external = tmp_path / "owned", tmp_path / "external"
    owner.mkdir()
    external.mkdir()
    (owner / "link").symlink_to(external, target_is_directory=True)
    monkeypatch.setattr(config, "APP_DIR", owner)
    source = owner / "link" / "missing" / ".env"
    marker = tmp_path / "marker.json"
    store = FakeStore()

    with pytest.raises(credentials.NativeCredentialMigrationError, match="resolves outside"):
        credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]
    assert not (external / "missing").exists() and not marker.exists() and store.values == {}


def test_failed_migration_restores_exact_crlf_source_bytes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker"
    original = f"KEEP=one\r\nANTHROPIC_API_KEY={SECRET}\r\n".encode()
    source.write_bytes(original)
    store = FakeStore()
    monkeypatch.setattr(
        credentials,
        "_write_marker",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("synthetic marker failure")),
    )

    with pytest.raises(credentials.NativeCredentialMigrationError):
        credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]

    assert source.read_bytes() == original
    assert store.values == {}


@pytest.mark.parametrize("content", ["", "{", '{"version":999,"migratedKeys":[]}'])
def test_migration_rejects_invalid_completion_markers_without_touching_sources(
    content: str,
    tmp_path: Path,
) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker"
    original = f"OPENAI_API_KEY={SECRET}\n"
    source.write_text(original, encoding="utf-8")
    marker.write_text(content, encoding="utf-8")
    store = FakeStore()

    with pytest.raises(credentials.NativeCredentialMigrationError, match="marker is invalid"):
        credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]

    assert source.read_text(encoding="utf-8") == original
    assert store.values == {}


def test_existing_native_conflict_and_write_failure_preserve_plaintext(tmp_path: Path) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker.json"
    original = f"ANTHROPIC_API_KEY={SECRET}\n"
    source.write_text(original, encoding="utf-8")

    with pytest.raises(credentials.NativeCredentialMigrationError, match="conflict") as conflict:
        credentials.migrate_persistent_env_credentials(
            [source], marker, store=FakeStore({"ANTHROPIC_API_KEY": "different"})  # type: ignore[arg-type]
        )
    assert SECRET not in str(conflict.value)
    assert source.read_text(encoding="utf-8") == original
    assert not marker.exists()

    failing = FakeStore()
    failing.fail_write = True
    with pytest.raises(credentials.NativeCredentialMigrationError):
        credentials.migrate_persistent_env_credentials([source], marker, store=failing)  # type: ignore[arg-type]
    assert source.read_text(encoding="utf-8") == original
    assert failing.values == {}


def test_migration_rejects_platform_oversize_before_native_or_source_mutation(tmp_path: Path) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker.json"
    original = f"ANTHROPIC_API_KEY={'x' * 129}\n"
    source.write_text(original, encoding="utf-8")
    store = FakeStore()

    with pytest.raises(credentials.NativeCredentialMigrationError):
        credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]

    assert source.read_text(encoding="utf-8") == original
    assert store.values == {}
    assert not marker.exists()


def test_migration_refuses_symlinks_malformed_interpolation_and_multiline_sources(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    target = tmp_path / "target.env"
    target.write_text(f"OPENAI_API_KEY={SECRET}\n", encoding="utf-8")
    link = tmp_path / "link.env"
    link.symlink_to(target)
    marker = tmp_path / "marker"
    store = FakeStore()
    with pytest.raises(credentials.NativeCredentialMigrationError, match="symbolic-link"):
        credentials.migrate_persistent_env_credentials([link], marker, store=store)  # type: ignore[arg-type]
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(credentials.NativeCredentialMigrationError, match="symbolic-link"):
        credentials.migrate_persistent_env_credentials([Path("~/link.env")], marker, store=store)  # type: ignore[arg-type]

    for content in (
        "GEMINI_API_KEY without equals\n",
        'GEMINI_API_KEY="$EXPANDED"\n',
        f'OTHER="line one\nGEMINI_API_KEY=not-an-assignment\nline three"\nGEMINI_API_KEY={SECRET}\n',
    ):
        target.write_text(content, encoding="utf-8")
        with pytest.raises(credentials.NativeCredentialMigrationError):
            credentials.migrate_persistent_env_credentials([target], marker, store=store)  # type: ignore[arg-type]
        assert target.read_text(encoding="utf-8") == content
        assert store.values == {}


def test_shell_literal_parser_preserves_safe_quotes_and_rejects_ambiguous_escapes() -> None:
    assert credentials._parse_shell_literal("'literal punctuation !@#%'") == "literal punctuation !@#%"
    assert credentials._parse_shell_literal("'literal' # comment") == "literal"
    assert credentials._parse_shell_literal('"quote-\\\"-slash-\\\\"') == 'quote-"-slash-\\'
    assert credentials._parse_shell_literal("plain-token_123./:+@%,-") == "plain-token_123./:+@%,-"
    with pytest.raises(credentials.NativeCredentialMigrationError, match="ambiguous escape"):
        credentials._parse_shell_literal("'literal\\\\path'")
    with pytest.raises(credentials.NativeCredentialMigrationError, match="ambiguous escape"):
        credentials._parse_shell_literal(r'"literal\tpath"')
    with pytest.raises(credentials.NativeCredentialMigrationError, match="ambiguous"):
        credentials._parse_shell_literal(r"escaped\ space")
    with pytest.raises(credentials.NativeCredentialMigrationError, match="ambiguous"):
        credentials._parse_shell_literal("'literal'#shell-data")
    with pytest.raises(credentials.NativeCredentialMigrationError, match="ambiguous"):
        credentials._parse_shell_literal('"literal"#shell-data')


def test_migration_refuses_retained_assignments_that_depend_on_removed_secrets(tmp_path: Path) -> None:
    first = tmp_path / "first.env"
    second = tmp_path / "second.env"
    marker = tmp_path / "marker"
    first_text = f"OPENAI_API_KEY={SECRET}\n"
    second_text = "OTHER_TOKEN=${OPENAI_API_KEY}-derived\n"
    first.write_text(first_text, encoding="utf-8")
    second.write_text(second_text, encoding="utf-8")
    store = FakeStore()

    with pytest.raises(credentials.NativeCredentialMigrationError, match="depends"):
        credentials.migrate_persistent_env_credentials([first, second], marker, store=store)  # type: ignore[arg-type]

    assert first.read_text(encoding="utf-8") == first_text
    assert second.read_text(encoding="utf-8") == second_text
    assert store.values == {}
    assert not marker.exists()


@pytest.mark.parametrize("failure", ["invalid_utf8", "unreadable"])
def test_public_migration_cli_sanitizes_source_read_failures(
    failure: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    first = tmp_path / "first.env"
    second = tmp_path / "second.env"
    marker = tmp_path / "marker"
    first.write_text(f"OPENAI_API_KEY={SECRET}\n", encoding="utf-8")
    if failure == "invalid_utf8":
        second.write_bytes(b"GEMINI_API_KEY=\xff\n")
    else:
        second.write_text("GEMINI_API_KEY=unreadable\n", encoding="utf-8")
        real_read_exact = credentials._read_utf8_exact

        def guarded_read_exact(path: Path) -> str:
            if path == second:
                raise OSError("private path and content must not escape")
            return real_read_exact(path)

        monkeypatch.setattr(credentials, "_read_utf8_exact", guarded_read_exact)

    result = CliRunner().invoke(
        app,
        [
            "credentials",
            "migrate",
            "--env-file",
            str(first),
            "--env-file",
            str(second),
            "--marker",
            str(marker),
        ],
    )

    assert result.exit_code == 1
    assert "could not be inspected safely" in result.output
    assert SECRET not in result.output
    assert str(first) not in result.output
    assert str(second) not in result.output
    assert "Traceback" not in result.output
    assert first.read_text(encoding="utf-8") == f"OPENAI_API_KEY={SECRET}\n"
    assert not marker.exists()


def test_guarded_rollback_preserves_concurrent_edit_and_verified_native_copy(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    first = tmp_path / "first.env"
    second = tmp_path / "second.env"
    marker = tmp_path / "marker"
    first.write_text(f"ANTHROPIC_API_KEY={SECRET}\n", encoding="utf-8")
    second.write_text(f"GEMINI_API_KEY={SECRET}\n", encoding="utf-8")
    store = FakeStore()
    real_atomic_write = credentials._atomic_write
    writes = 0

    def concurrent_write(
        path: Path,
        text: str,
        mode: int,
        *,
        expected: tuple[int, int, str] | None = None,
    ) -> None:
        nonlocal writes
        writes += 1
        real_atomic_write(path, text, mode, expected=expected)
        if writes == 1:
            path.write_text(text + "USER_SETTING=preserve\n", encoding="utf-8")
            second.write_text(second.read_text(encoding="utf-8") + "OTHER=changed\n", encoding="utf-8")

    monkeypatch.setattr(credentials, "_atomic_write", concurrent_write)
    with pytest.raises(credentials.NativeCredentialMigrationError, match="recovery was incomplete"):
        credentials.migrate_persistent_env_credentials([first, second], marker, store=store)  # type: ignore[arg-type]

    assert "USER_SETTING=preserve" in first.read_text(encoding="utf-8")
    assert "OTHER=changed" in second.read_text(encoding="utf-8")
    assert store.values == {"ANTHROPIC_API_KEY": SECRET, "GEMINI_API_KEY": SECRET}
    assert not marker.exists()


def test_marker_scoped_lock_prevents_a_losing_migration_from_compensating_the_winner(tmp_path: Path) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker"
    source.write_text(f"ANTHROPIC_API_KEY={SECRET}\n", encoding="utf-8")
    write_started = threading.Event()
    allow_write = threading.Event()

    class BlockingStore(FakeStore):
        def write(self, key: str, value: str) -> None:
            write_started.set()
            assert allow_write.wait(timeout=5)
            super().write(key, value)

    store = BlockingStore()
    outcomes: list[object] = []

    def migrate() -> None:
        try:
            outcomes.append(credentials.migrate_persistent_env_credentials([source], marker, store=store))  # type: ignore[arg-type]
        except Exception as exc:  # pragma: no cover - retained for thread diagnostics
            outcomes.append(exc)

    winner = threading.Thread(target=migrate)
    winner.start()
    assert write_started.wait(timeout=5)
    try:
        with pytest.raises(credentials.NativeCredentialMigrationError, match="already in progress"):
            credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]
    finally:
        allow_write.set()
        winner.join(timeout=5)

    assert not winner.is_alive()
    assert len(outcomes) == 1 and isinstance(outcomes[0], credentials.MigrationResult)
    assert source.read_text(encoding="utf-8") == ""
    assert store.values == {"ANTHROPIC_API_KEY": SECRET}
    assert marker.exists()


def test_atomic_replacement_detects_edit_during_temp_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / ".env"
    marker = tmp_path / "marker"
    source.write_text(f"ANTHROPIC_API_KEY={SECRET}\n", encoding="utf-8")
    store = FakeStore()
    real_fsync = credentials.os.fsync
    injected = False

    def fsync_and_edit(descriptor: int) -> None:
        nonlocal injected
        real_fsync(descriptor)
        if not injected:
            injected = True
            source.write_text(source.read_text(encoding="utf-8") + "USER_SETTING=preserve\n", encoding="utf-8")

    monkeypatch.setattr(credentials.os, "fsync", fsync_and_edit)
    with pytest.raises(credentials.NativeCredentialMigrationError, match="source changed"):
        credentials.migrate_persistent_env_credentials([source], marker, store=store)  # type: ignore[arg-type]

    assert "USER_SETTING=preserve" in source.read_text(encoding="utf-8")
    assert store.values == {}
    assert not marker.exists()


def test_windows_temporary_mode_path_does_not_require_fchmod(monkeypatch: pytest.MonkeyPatch) -> None:
    native_name = os.name
    native_fchmod = getattr(os, "fchmod", None)
    monkeypatch.setattr(credentials, "os", SimpleNamespace(**vars(os)))
    destination = Path(__file__)
    temporary = Path("temporary")
    monkeypatch.setattr(credentials.os, "name", "nt")
    monkeypatch.setattr(
        credentials.os,
        "fchmod",
        lambda *_args: (_ for _ in ()).throw(AssertionError("fchmod must not run on Windows")),
        raising=False,
    )
    copied: list[tuple[Path, Path]] = []
    monkeypatch.setattr(credentials, "_copy_windows_dacl", lambda source, target: copied.append((source, target)))
    credentials._set_temporary_mode(123, temporary, destination, 0o600)
    assert copied == [(destination, temporary)]
    assert os.name == native_name
    assert getattr(os, "fchmod", None) is native_fchmod


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777
