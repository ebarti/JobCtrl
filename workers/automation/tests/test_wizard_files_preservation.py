"""Exercise the full wizard against owned synthetic files and settings."""
from __future__ import annotations

import io
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest
from dotenv import dotenv_values
from typer.testing import CliRunner

from jobctrl import cli, config, native_credentials
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.pipeline import runner
from jobctrl.wizard import init as wizard
from tests.test_location_free_remote_discovery import _LinkedIn, _ZipRecruiter, _registry
from tests.test_native_credentials import FakeStore
from tests.test_wizard_profile_preservation import (
    _prepare_wizard,
    _profile,
    _profile_rows,
    _save_concurrent_profile,
    _seed,
    owned_workspace as owned_workspace,
)


def _paths(tmp_path, monkeypatch):
    app_dir = tmp_path / "owned-app"
    app_dir.mkdir()
    monkeypatch.setattr(wizard, "APP_DIR", app_dir)
    monkeypatch.setattr(wizard, "RESUME_PATH", app_dir / "resume.txt")
    monkeypatch.setattr(wizard, "RESUME_PDF_PATH", app_dir / "resume.pdf")
    monkeypatch.setattr(wizard, "ENV_PATH", app_dir / ".env")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(app_dir / "config.json"))
    return app_dir


def _seed_existing(conn, app_dir):
    raw = _seed(conn).replace(
        '"synthetic_note": "preserve"',
        '"synthetic_note": "preserve", "automation": '
        '{"auto_apply": true, "apply_approval_required": false, "min_fit_score": 8}',
    )
    conn.execute("UPDATE discovery_settings SET search_config_json=?", (raw,))
    conn.commit()
    (app_dir / "resume.txt").write_bytes(b"owned original text\r\n")
    (app_dir / "resume.pdf").write_bytes(b"owned original pdf\x00")
    (app_dir / ".env").write_bytes(
        b"\xef\xbb\xbf# owned configuration\r\n\r\n  export GEMINI_API_KEY='old synthetic key'\r\n"
        b"ANTHROPIC_API_KEY='other synthetic key'\r\nCUSTOM_SETTING=keep-exactly  \r\n"
    )
    (app_dir / "config.json").write_bytes(b'{ "synthetic_setting": "preserve exact bytes" }\n')
    return raw


def _install_prompts(monkeypatch, *, source, replace_resume=False, change_ai=False, enable_ai=False, change_apply=False,
                     on_key=None, on_loop=None, api_key="synthetic'\\new key"):
    original_ask = wizard.Prompt.ask
    original_confirm = wizard.Confirm.ask

    def ask(question, **kwargs):
        if question == "Resume file path":
            return str(source)
        if question == "Provider":
            return "google"
        if question.startswith("Gemini API key"):
            if on_key:
                on_key()
            return api_key
        return original_ask(question, **kwargs)

    def confirm(question, **kwargs):
        if question == "Replace or add a resume file?":
            return replace_resume
        if question == "Add or update an AI provider credential?":
            return change_ai
        if question == "Enable AI scoring and resume tailoring?":
            return enable_ai
        if question == "Change the saved Apply automation settings?":
            return change_apply
        if question == "Enable the standing auto-apply loop?":
            if on_loop:
                on_loop()
            return False
        return original_confirm(question, **kwargs)

    monkeypatch.setattr(wizard.Prompt, "ask", ask)
    monkeypatch.setattr(wizard.Confirm, "ask", confirm)


def _files(app_dir):
    return {name: (app_dir / name).read_bytes() for name in ("resume.txt", "resume.pdf", ".env", "config.json")}


def _saved(conn):
    return conn.execute("SELECT search_config_json, created_at, updated_at FROM discovery_settings").fetchone()


@pytest.mark.parametrize("accept_filter", [False, True])
@pytest.mark.parametrize("replace_resume", [False, True])
def test_full_wizard_retains_files_profile_and_settings_until_explicit_acceptance(
    owned_workspace, tmp_path, monkeypatch, accept_filter, replace_resume,
):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    raw = _seed_existing(conn, app_dir)
    source = tmp_path / "new-synthetic-resume.txt"
    source.write_bytes(b"deliberate synthetic replacement\n")
    files_before, profile_before, row_before = _files(app_dir), _profile_rows(conn), tuple(_saved(conn))
    _prepare_wizard(monkeypatch, conn, accept_filter=accept_filter, real_steps=True)
    _install_prompts(monkeypatch, source=source, replace_resume=replace_resume)

    result = CliRunner().invoke(cli.app, ["init"])
    assert _profile_rows(conn) == profile_before
    assert (app_dir / ".env").read_bytes() == files_before[".env"]
    assert (app_dir / "config.json").read_bytes() == files_before["config.json"]
    assert (app_dir / "resume.pdf").read_bytes() == files_before["resume.pdf"]
    if not accept_filter:
        assert result.exit_code == 1, result.output
        assert tuple(_saved(conn)) == row_before and _saved(conn)[0] == raw
        assert (app_dir / "resume.txt").read_bytes() == files_before["resume.txt"]
        return

    assert result.exit_code == 0, result.output
    expected_resume = source.read_bytes() if replace_resume else files_before["resume.txt"]
    assert (app_dir / "resume.txt").read_bytes() == expected_resume
    saved = json.loads(_saved(conn)[0])
    assert saved["automation"] == {"auto_apply": True, "apply_approval_required": False, "min_fit_score": 8}
    assert saved["tiers"] == [] and saved["synthetic_note"] == "preserve"
    execution = DiscoveryExecutionRef("local", "owned-real-steps", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    result_source = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="owned-real-steps-1",
    )
    assert result_source["status"] == "ok"
    assert [(r.search_term, r.location, r.is_remote) for r in _LinkedIn.requests] == [
        ("Canonical synthetic role", "Synthetic City", False),
        ("Canonical synthetic role", None, True),
    ]


def test_full_wizard_explicit_credential_update_preserves_other_env_and_loop_decline_preserves_approval(
    owned_workspace, tmp_path, monkeypatch,
):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    _seed_existing(conn, app_dir)
    before, profile_before = _files(app_dir), _profile_rows(conn)
    _prepare_wizard(monkeypatch, conn, accept_filter=True, real_steps=True)
    _install_prompts(monkeypatch, source=tmp_path / "unused.txt", change_ai=True, change_apply=True)

    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert _profile_rows(conn) == profile_before
    assert (app_dir / "config.json").read_bytes() == before["config.json"]
    assert (app_dir / "resume.txt").read_bytes() == before["resume.txt"]
    assert (app_dir / "resume.pdf").read_bytes() == before["resume.pdf"]
    env = (app_dir / ".env").read_bytes()
    assert env.startswith(b"\xef\xbb\xbf# owned configuration\r\n\r\n  export GEMINI_API_KEY=")
    assert b"ANTHROPIC_API_KEY='other synthetic key'\r\nCUSTOM_SETTING=keep-exactly  \r\n" in env
    parsed = dotenv_values(stream=io.StringIO(env.decode()), interpolate=False)
    assert parsed["GEMINI_API_KEY"] == "synthetic'\\new key"
    assert parsed["ANTHROPIC_API_KEY"] == "other synthetic key"
    assert json.loads(_saved(conn)[0])["automation"] == {
        "auto_apply": False, "apply_approval_required": False, "min_fit_score": 8,
    }


def test_full_wizard_and_setup_env_writers_serialize_their_updates(owned_workspace, tmp_path, monkeypatch):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    _seed_existing(conn, app_dir)
    monkeypatch.setenv("SYNTHETIC_CONCURRENT_SETTING", "original")
    _prepare_wizard(monkeypatch, conn, accept_filter=True, real_steps=True)
    _install_prompts(monkeypatch, source=tmp_path / "unused.txt", change_ai=True)
    started, completed = threading.Event(), threading.Event()
    failures: list[Exception] = []

    def setup_update():
        started.set()
        try:
            cli._write_env_updates(
                app_dir / ".env", {"SYNTHETIC_CONCURRENT_SETTING": "changed"}, dry_run=False, quiet=True,
            )
        except Exception as exc:
            failures.append(exc)
        finally:
            completed.set()

    other = threading.Thread(target=setup_update)
    original_replace = os.replace

    def replace_while_setup_waits(source, destination):
        if Path(destination) == app_dir / ".env":
            other.start()
            assert started.wait(2)
            assert not completed.wait(0.05), "setup must wait for the wizard's file lock"
        original_replace(source, destination)

    monkeypatch.setattr(wizard.os, "replace", replace_while_setup_waits)
    result = CliRunner().invoke(cli.app, ["init"])
    if other.ident is not None:
        other.join(timeout=5)
    assert result.exit_code == 0, result.output
    assert completed.is_set() and not failures
    parsed = dotenv_values(app_dir / ".env", interpolate=False)
    assert parsed["GEMINI_API_KEY"] == "synthetic'\\new key"
    assert parsed["ANTHROPIC_API_KEY"] == "other synthetic key"
    assert parsed["SYNTHETIC_CONCURRENT_SETTING"] == "changed"
    assert parsed["CUSTOM_SETTING"] == "keep-exactly"


def test_full_wizard_does_not_restore_plaintext_during_concurrent_native_migration(
    owned_workspace, tmp_path, monkeypatch,
):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    _seed_existing(conn, app_dir)
    before, profile_before = _files(app_dir), _profile_rows(conn)
    _prepare_wizard(monkeypatch, conn, accept_filter=True, real_steps=True)
    migration_locked, release_migration = threading.Event(), threading.Event()
    wizard_attempted, wizard_finished = threading.Event(), threading.Event()
    failures: list[Exception] = []
    wizard_results = []

    class BlockingFakeStore(FakeStore):
        def write(self, key, value):
            super().write(key, value)
            if not migration_locked.is_set():
                migration_locked.set()
                if not release_migration.wait(5):
                    raise AssertionError("synthetic migration was not released")

    store = BlockingFakeStore()
    marker = app_dir / "native-migration.json"

    def migrate():
        try:
            native_credentials.migrate_persistent_env_credentials([app_dir / ".env"], marker, store=store)
        except Exception as exc:
            failures.append(exc)

    migration_thread = threading.Thread(target=migrate)

    def start_migration():
        migration_thread.start()
        assert migration_locked.wait(3)

    _install_prompts(monkeypatch, source=tmp_path / "unused.txt", change_ai=True, on_key=start_migration)
    original_replace = wizard._replace_wizard_files

    def observed_replace(updates, revisions, *, resource):
        if app_dir / ".env" in updates:
            wizard_attempted.set()
        return original_replace(updates, revisions, resource=resource)

    monkeypatch.setattr(wizard, "_replace_wizard_files", observed_replace)

    def run_wizard():
        try:
            wizard_results.append(CliRunner().invoke(cli.app, ["init"]))
        finally:
            wizard_finished.set()

    wizard_thread = threading.Thread(target=run_wizard)
    wizard_thread.start()
    try:
        assert migration_locked.wait(3)
        assert wizard_attempted.wait(3)
        assert not wizard_finished.wait(0.05), "the wizard must wait for the migration's file lock"
    finally:
        release_migration.set()
        wizard_thread.join(timeout=5)
        if migration_thread.ident is not None:
            migration_thread.join(timeout=5)
    assert not wizard_thread.is_alive() and not migration_thread.is_alive()
    assert not failures
    assert wizard_results and wizard_results[0].exit_code == 1
    assert "changed" in wizard_results[0].output.lower()
    assert store.values == {"GEMINI_API_KEY": "old synthetic key", "ANTHROPIC_API_KEY": "other synthetic key"}
    assert (app_dir / ".env").read_bytes() == (
        b"\xef\xbb\xbf# owned configuration\r\n\r\nCUSTOM_SETTING=keep-exactly  \r\n"
    )
    assert marker.exists()
    assert (app_dir / "resume.txt").read_bytes() == before["resume.txt"]
    assert (app_dir / "resume.pdf").read_bytes() == before["resume.pdf"]
    assert (app_dir / "config.json").read_bytes() == before["config.json"]
    assert _profile_rows(conn) == profile_before


def test_native_migration_waits_for_wizard_and_migrates_the_updated_credential(
    owned_workspace, tmp_path, monkeypatch,
):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    _seed_existing(conn, app_dir)
    before, profile_before = _files(app_dir), _profile_rows(conn)
    _prepare_wizard(monkeypatch, conn, accept_filter=True, real_steps=True)
    _install_prompts(monkeypatch, source=tmp_path / "unused.txt", change_ai=True, api_key="new-synthetic-key")
    wizard_locked, release_wizard = threading.Event(), threading.Event()
    migration_attempted, store_read = threading.Event(), threading.Event()
    wizard_results = []
    failures: list[Exception] = []

    class ObservedFakeStore(FakeStore):
        def read(self, key):
            store_read.set()
            return super().read(key)

    store = ObservedFakeStore()
    marker = app_dir / "native-migration.json"

    def migrate():
        try:
            native_credentials.migrate_persistent_env_credentials([app_dir / ".env"], marker, store=store)
        except Exception as exc:
            failures.append(exc)

    migration_thread = threading.Thread(target=migrate)
    original_lock = config.config_file_lock

    @contextmanager
    def observed_lock(*args, **kwargs):
        if threading.current_thread() is migration_thread:
            migration_attempted.set()
        with original_lock(*args, **kwargs):
            yield

    monkeypatch.setattr(config, "config_file_lock", observed_lock)
    original_replace = os.replace

    def pause_wizard_replace(source, destination):
        if threading.current_thread() is wizard_thread and Path(destination) == app_dir / ".env":
            wizard_locked.set()
            assert release_wizard.wait(5)
        original_replace(source, destination)

    monkeypatch.setattr(wizard.os, "replace", pause_wizard_replace)

    def run_wizard():
        wizard_results.append(CliRunner().invoke(cli.app, ["init"]))

    wizard_thread = threading.Thread(target=run_wizard)
    wizard_thread.start()
    try:
        assert wizard_locked.wait(3)
        migration_thread.start()
        assert migration_attempted.wait(3)
        assert not store_read.wait(0.05), "migration must wait for the wizard's file lock"
    finally:
        release_wizard.set()
        wizard_thread.join(timeout=5)
        if migration_thread.ident is not None:
            migration_thread.join(timeout=5)
    assert not wizard_thread.is_alive() and not migration_thread.is_alive()
    assert not failures
    assert wizard_results and wizard_results[0].exit_code == 0, wizard_results[0].output if wizard_results else ""
    assert store.values == {"GEMINI_API_KEY": "new-synthetic-key", "ANTHROPIC_API_KEY": "other synthetic key"}
    assert (app_dir / ".env").read_bytes() == (
        b"\xef\xbb\xbf# owned configuration\r\n\r\nCUSTOM_SETTING=keep-exactly  \r\n"
    )
    assert marker.exists()
    assert (app_dir / "resume.txt").read_bytes() == before["resume.txt"]
    assert (app_dir / "resume.pdf").read_bytes() == before["resume.pdf"]
    assert (app_dir / "config.json").read_bytes() == before["config.json"]
    assert _profile_rows(conn) == profile_before


@pytest.mark.parametrize("changed", ["resume", "env", "profile"])
def test_full_wizard_refuses_to_overwrite_concurrent_changes(owned_workspace, tmp_path, monkeypatch, changed):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    original = _seed_existing(conn, app_dir)
    before = _files(app_dir)
    source = tmp_path / "replacement.txt"
    source.write_bytes(b"replacement")
    concurrent = []

    def change_before_search():
        if changed == "resume":
            (app_dir / "resume.txt").write_bytes(b"concurrent synthetic resume")
        elif changed == "profile":
            _save_concurrent_profile(_profile("Concurrent synthetic role"))
            concurrent.append(_profile_rows(conn))

    def change_before_key():
        (app_dir / ".env").write_bytes(before[".env"] + b"CONCURRENT_SETTING=keep\n")

    _prepare_wizard(monkeypatch, conn, accept_filter=True, before_search=change_before_search, real_steps=True)
    _install_prompts(
        monkeypatch, source=source, replace_resume=changed == "resume", change_ai=changed == "env",
        on_key=change_before_key if changed == "env" else None,
    )
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 1, result.output
    assert "changed" in result.output.lower()
    assert (app_dir / "resume.pdf").read_bytes() == before["resume.pdf"]
    if changed == "resume":
        assert (app_dir / "resume.txt").read_bytes() == b"concurrent synthetic resume"
        assert (app_dir / ".env").read_bytes() == before[".env"]
        assert _saved(conn)[0] == original
    elif changed == "env":
        assert (app_dir / ".env").read_bytes() == before[".env"] + b"CONCURRENT_SETTING=keep\n"
        assert (app_dir / "resume.txt").read_bytes() == before["resume.txt"]
    else:
        assert _profile_rows(conn) == concurrent[0]
        assert _saved(conn)[0] == original
        assert _files(app_dir) == before


@pytest.mark.parametrize("changed_control", ["auto_apply", "min_fit_score"])
def test_full_wizard_fences_selected_apply_control_but_retains_unrelated_concurrent_change(
    owned_workspace, tmp_path, monkeypatch, changed_control,
):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    _seed_existing(conn, app_dir)
    before, profile_before = _files(app_dir), _profile_rows(conn)

    def change_automation():
        other = sqlite3.connect(config.DB_PATH)
        try:
            raw = other.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
            data = json.loads(raw)
            data["automation"][changed_control] = False if changed_control == "auto_apply" else 9
            other.execute("UPDATE discovery_settings SET search_config_json=?", (json.dumps(data),))
            other.commit()
        finally:
            other.close()

    _prepare_wizard(monkeypatch, conn, accept_filter=True, real_steps=True)
    _install_prompts(monkeypatch, source=tmp_path / "unused.txt", change_apply=True, on_loop=change_automation)
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == (1 if changed_control == "auto_apply" else 0), result.output
    if changed_control == "auto_apply":
        assert "changed" in result.output.lower()
    automation = json.loads(_saved(conn)[0])["automation"]
    assert automation == {
        "auto_apply": False, "apply_approval_required": False,
        "min_fit_score": 9 if changed_control == "min_fit_score" else 8,
    }
    assert _files(app_dir) == before and _profile_rows(conn) == profile_before


@pytest.mark.parametrize("enable_ai", [False, True])
def test_first_use_full_wizard_saves_new_resume_and_default_approval(owned_workspace, tmp_path, monkeypatch, enable_ai):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    source = tmp_path / "first-use-synthetic.txt"
    source.write_bytes(b"first use synthetic resume")
    _prepare_wizard(monkeypatch, conn, accept_filter=False, real_steps=True)
    _install_prompts(monkeypatch, source=source, enable_ai=enable_ai)
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry",
        lambda *_a, **_k: _registry(_LinkedIn, _ZipRecruiter),
    )

    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert (app_dir / "resume.txt").read_bytes() == source.read_bytes()
    if enable_ai:
        parsed = dotenv_values(app_dir / ".env", interpolate=False)
        assert parsed["GEMINI_API_KEY"] == "synthetic'\\new key"
    else:
        assert not (app_dir / ".env").exists()
    saved = json.loads(_saved(conn)[0])
    assert saved["automation"]["auto_apply"] is False
    assert saved["automation"]["apply_approval_required"] is True
    execution = DiscoveryExecutionRef("local", "owned-real-first-use", "owned-run")
    plan = runner.plan_discovery_source_families(discovery_execution=execution)
    result_source = runner.run_discovery_source_family(
        "jobspy", discovery_execution=execution, next_run_settings=plan["next_run_settings"],
        activity_attempt=1, activity_owner_token="owned-real-first-use-1",
    )
    assert result_source["status"] == "ok"
    for adapter in (_LinkedIn, _ZipRecruiter):
        assert [(r.search_term, r.location, r.is_remote, r.hours_old) for r in adapter.requests] == [
            ("Wizard synthetic value", "Wizard synthetic city", True, 72),
        ]


def test_first_use_loop_decline_retains_concurrently_chosen_approval(owned_workspace, tmp_path, monkeypatch):
    conn = owned_workspace
    app_dir = _paths(tmp_path, monkeypatch)
    source = tmp_path / "first-use-synthetic.txt"
    source.write_bytes(b"first use synthetic resume")

    def save_concurrent_approval():
        other = sqlite3.connect(config.DB_PATH)
        try:
            raw = other.execute("SELECT search_config_json FROM discovery_settings").fetchone()[0]
            data = json.loads(raw)
            data.setdefault("automation", {})["apply_approval_required"] = False
            other.execute("UPDATE discovery_settings SET search_config_json=?", (json.dumps(data),))
            other.commit()
        finally:
            other.close()

    _prepare_wizard(monkeypatch, conn, accept_filter=False, real_steps=True)
    _install_prompts(monkeypatch, source=source, on_loop=save_concurrent_approval)
    result = CliRunner().invoke(cli.app, ["init"])
    assert result.exit_code == 0, result.output
    assert (app_dir / "resume.txt").read_bytes() == source.read_bytes()
    assert json.loads(_saved(conn)[0])["automation"] == {"auto_apply": False, "apply_approval_required": False}
