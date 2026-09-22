from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

import pytest
from typer.testing import CliRunner

from jobctrl import native_credentials as credentials
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
        real_read_text = Path.read_text

        def guarded_read_text(path: Path, *args: object, **kwargs: object) -> str:
            if path == second:
                raise OSError("private path and content must not escape")
            return real_read_text(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", guarded_read_text)

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
    destination = Path(__file__)
    temporary = Path("temporary")
    monkeypatch.setattr(credentials.os, "name", "nt")
    monkeypatch.setattr(
        credentials.os,
        "fchmod",
        lambda *_args: (_ for _ in ()).throw(AssertionError("fchmod must not run on Windows")),
    )
    copied: list[tuple[Path, Path]] = []
    monkeypatch.setattr(credentials, "_copy_windows_dacl", lambda source, target: copied.append((source, target)))
    credentials._set_temporary_mode(123, temporary, destination, 0o600)
    assert copied == [(destination, temporary)]


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777
