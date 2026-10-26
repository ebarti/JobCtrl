"""Crash/restart recovery distinguishes local process exit from external outcome."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import pytest
from typer.testing import CliRunner

from jobctrl import cli, config, database
from jobctrl.apply import launcher
from jobctrl.infrastructure import apply_controls
from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state
from tests.test_exact_v7_apply_acquire_job_identity import LOCAL_JOB_ID, LOCAL_TENANT, _insert_ready_job


@pytest.fixture()
def world(tmp_path, monkeypatch):
    path = tmp_path / "jobctrl.db"
    (tmp_path / "owned-owner-probe").write_text("synthetic apply owner 1173")
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(database, "DB_PATH", path)
    conn = database.init_db(path)
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "score", "succeeded", validate_transition=False)
    for row in conn.execute("SELECT artifact_id FROM job_materials_artifacts").fetchall():
        artifact = tmp_path / (hashlib.sha256(row[0].encode()).hexdigest() + ".txt")
        artifact.write_text("Accepted synthetic material " + row[0])
        conn.execute("UPDATE job_materials_artifacts SET path=? WHERE artifact_id=?", (str(artifact), row[0]))
    conn.commit()
    monkeypatch.setattr(launcher, "get_connection", lambda: conn)
    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    try:
        yield conn, path
    finally:
        database.close_connection(path)


def fingerprint(conn):
    rows = [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts ORDER BY artifact_id")]
    return {"rows": hashlib.sha256(json.dumps(rows).encode()).hexdigest(),
            "files": [hashlib.sha256(Path(r[0]).read_bytes()).hexdigest() for r in conn.execute("SELECT path FROM job_materials_artifacts ORDER BY artifact_id")]}


@pytest.mark.parametrize("blocker", ["none", "intent", "older_intent", "needs_verification"])
@pytest.mark.parametrize("entry", ["startup", "cli", "caller"])
def test_skip_then_owner_process_death_allows_only_safe_explicit_reset(world, monkeypatch, blocker, entry):
    conn, path = world
    before = fingerprint(conn)
    child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("apply_stopped_owner_probe.py")),
                              str(path.parent), LOCAL_JOB_ID, "intent" if blocker == "intent" else "none"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        ready = path.parent / "owner-ready.json"
        deadline = time.monotonic() + 15
        while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists(), child.communicate(timeout=5)
        context = json.loads(ready.read_text())
        if blocker == "older_intent":
            record_job_event(conn, LOCAL_JOB_ID, "apply", "ApplySubmitIntended", payload={"run_id": "earlier-owner"})
            conn.commit()
        # Independent writer follows the canonical manual Skip event contract.
        with sqlite3.connect(path) as writer:
            writer.row_factory = sqlite3.Row
            set_stage_state(writer, LOCAL_JOB_ID, "apply", "skipped", attempt_count=1,
                            retryable=False, error_code=None, validate_transition=False)
            record_job_event(writer, LOCAL_JOB_ID, "apply", "StageSkipped", payload={
                "manualDisposition": "skip", "previousState": "needs_verification" if blocker == "needs_verification" else "running"})
        stopped = tuple(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE stage='apply'").fetchone())
        assert launcher.recover_ambiguous_running_apply() == 0  # Owner is still alive.
        with pytest.raises(ValueError):
            reset_job_stage(conn, LOCAL_JOB_ID, "apply")
        child.communicate("exit without settlement\n", timeout=10)
        assert child.returncode == 0
        # Reopen storage, as a restarted launcher or maintenance command does.
        database.close_connection(path)
        conn = database.init_db(path)
        monkeypatch.setattr(launcher, "get_connection", lambda: conn)
        if entry == "caller":
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("UPDATE jobs SET title='Caller transaction'")
            record = launcher._record_apply_terminal_event_once
            def fail_after_ack(*args, **kwargs):
                record(*args, **kwargs)
                raise RuntimeError("synthetic failure after acknowledgement")
            with monkeypatch.context() as failure:
                failure.setattr(launcher, "_record_apply_terminal_event_once", fail_after_ack)
                assert launcher.recover_ambiguous_running_apply() == 0
            assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='LockReleased'").fetchone()[0] == 0
            assert conn.in_transaction and conn.execute("SELECT title FROM jobs").fetchone()[0] == 'Caller transaction'
            assert launcher.recover_ambiguous_running_apply() == 1
            assert conn.in_transaction
            conn.rollback()
            assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='LockReleased'").fetchone()[0] == 0
            assert launcher.recover_ambiguous_running_apply() == 1
        elif entry == "cli":
            result = CliRunner().invoke(cli.app, ["apply", "--recover-stopped"])
            assert result.exit_code == 0, result.output
            assert "Acknowledged 1" in result.output and "reset separately" in result.output
        else:
            assert launcher.recover_ambiguous_running_apply() == 1
        assert launcher.recover_ambiguous_running_apply() == 0
        assert tuple(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE stage='apply'").fetchone()) == stopped
        assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False) is None
        counts = dict(conn.execute("SELECT event_type,COUNT(*) FROM job_events GROUP BY event_type"))
        assert counts["ApplyRunStarted"] == counts["StageSkipped"] == counts["LockReleased"] == 1
        assert counts.get("ApplySubmitIntended", 0) == int(blocker in {"intent", "older_intent"})
        ack = json.loads(conn.execute("SELECT payload_json FROM job_events WHERE event_type='LockReleased'").fetchone()[0])
        assert ack["run_id"] == context["run_id"] and ack["recovery_reason"] == "owner_process_exited"
        from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        outcome = conn.execute("SELECT status,result FROM apply_run_projections WHERE run_id=?", (context["run_id"],)).fetchone()
        assert tuple(outcome) == ("manual", "manual")  # Local stop, no assertion about provider success/failure.
        if blocker == "none":
            reset_job_stage(conn, LOCAL_JOB_ID, "apply")
            assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False)
            assert conn.execute("SELECT attempt_count FROM job_stage_states WHERE stage='apply'").fetchone()[0] == 2
        else:
            with pytest.raises(ValueError, match="intent|verification"):
                reset_job_stage(conn, LOCAL_JOB_ID, "apply")
        assert fingerprint(conn) == before
        print(json.dumps({"blocker": blocker, "entry": entry, "job": LOCAL_JOB_ID, "run": context["run_id"], "owner_pid": child.pid,
                          "recovered_events": counts, "sender_calls": 0, "skip_stage": stopped, "run_outcome": tuple(outcome),
                          "artifacts_before": before, "artifacts_after": fingerprint(conn)}))
        database.close_connection(path)
    finally:
        if child.poll() is None:
            child.kill()  # Only this fixture's child, behind the owned deadline.
        child.communicate(timeout=5)


@pytest.mark.parametrize("owner", [None, {}, {"pid": True}, {"pid": -1}, {"pid": "42"}, {"pid": 1, "hostname_sha256": "other-host"}])
def test_owner_absence_requires_exact_local_provenance(owner):
    assert apply_controls.apply_owner_process_exited(owner) is False


def test_live_or_permission_denied_process_does_not_release_ownership(monkeypatch):
    owner = apply_controls.local_apply_process()
    assert apply_controls.apply_owner_process_exited(owner) is False
    if os.name != "nt":
        def denied(*_):
            raise PermissionError("synthetic denied process query")
        monkeypatch.setattr(os, "kill", denied)
        assert apply_controls.apply_owner_process_exited(owner) is False


def test_recovery_cli_never_launches_apply_or_resets_running_work(world, monkeypatch):
    conn, _ = world
    monkeypatch.setattr(launcher, "main", lambda **_: pytest.fail("Recovery launched Apply"))
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False)
    before = [tuple(r) for r in conn.execute("SELECT * FROM job_stage_states")]
    events = [tuple(r) for r in conn.execute("SELECT * FROM job_events")]
    result = CliRunner().invoke(cli.app, ["apply", "--recover-stopped"])
    assert result.exit_code == 0, result.output
    assert "Acknowledged 0" in result.output and "reset separately" in result.output
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_stage_states")] == before
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_events")] == events


@pytest.mark.parametrize("provenance", ["legacy", "foreign", "live", "terminal_workflow", "newer_owner"])
def test_unknown_or_active_latest_owner_stays_blocked(world, monkeypatch, provenance):
    conn, _ = world
    context = {"workflow_id": "test-live-owner"}
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False, run_ctx=context)
    started = conn.execute("SELECT event_id,payload_json FROM job_events WHERE event_type='ApplyRunStarted'").fetchone()
    payload = json.loads(started[1])
    if provenance == "legacy":
        payload.pop("owner_process")
    if provenance == "foreign":
        payload["owner_process"]["hostname_sha256"] = "another-host"
    if provenance == "newer_owner":
        payload["owner_process"]["pid"] = 0x7FFFFFFE
    conn.execute("UPDATE job_events SET payload_json=? WHERE event_id=?", (json.dumps(payload), started[0]))
    if provenance == "terminal_workflow":
        conn.execute("INSERT INTO workflow_run_projections (workflow_id,status) VALUES ('test-live-owner','canceled')")
    if provenance == "newer_owner":
        record_job_event(conn, LOCAL_JOB_ID, "apply", "ApplyRunStarted", payload={
            "run_id": "newer-owner", "owner_process": apply_controls.local_apply_process()})
        monkeypatch.setattr(launcher, "apply_owner_process_exited", lambda owner: owner["pid"] == 0x7FFFFFFE)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", attempt_count=1, validate_transition=False)
    record_job_event(conn, LOCAL_JOB_ID, "apply", "StageSkipped", payload={"manualDisposition": "skip", "previousState": "running"})
    conn.commit()
    events = [tuple(r) for r in conn.execute("SELECT * FROM job_events")]
    assert launcher.recover_ambiguous_running_apply() == 0
    with pytest.raises(ValueError, match="settlement"):
        reset_job_stage(conn, LOCAL_JOB_ID, "apply")
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_events")] == events


def test_recovery_acknowledgement_cannot_cross_tenant_job_identity(world, monkeypatch):
    conn, _ = world
    _insert_ready_job(conn, "other", LOCAL_JOB_ID, url="https://example.test/other-owned")
    for tenant, run_id, pid in [("local", "exited-owner", 0x7FFFFFFE), ("other", "live-owner", os.getpid())]:
        ensure_job_stage_rows(conn, LOCAL_JOB_ID, tenant_id=tenant)
        set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", tenant_id=tenant, attempt_count=2, validate_transition=False)
        record_job_event(conn, LOCAL_JOB_ID, "apply", "ApplyRunStarted", tenant_id=tenant,
                         payload={"run_id": run_id, "owner_process": {**apply_controls.local_apply_process(), "pid": pid}})
        record_job_event(conn, LOCAL_JOB_ID, "apply", "StageSkipped", tenant_id=tenant,
                         payload={"manualDisposition": "skip", "previousState": "running"})
    conn.commit()
    before = [tuple(r) for r in conn.execute("SELECT * FROM job_stage_states ORDER BY tenant_id,stage")]
    monkeypatch.setattr(launcher, "apply_owner_process_exited", lambda owner: owner["pid"] == 0x7FFFFFFE)
    assert launcher.recover_ambiguous_running_apply() == 1
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_stage_states ORDER BY tenant_id,stage")] == before
    acknowledgements = conn.execute("SELECT tenant_id,job_id,payload_json FROM job_events WHERE event_type='LockReleased'").fetchall()
    assert len(acknowledgements) == 1
    assert tuple(acknowledgements[0][:2]) == ("local", LOCAL_JOB_ID)
    assert json.loads(acknowledgements[0][2])["run_id"] == "exited-owner"


@pytest.mark.parametrize("handle,wait,error,expected", [(None, 0, 87, True), (None, 0, 5, False),
                                                       (42, 0, 0, True), (42, 258, 0, False), (42, 0xFFFFFFFF, 0, False)])
def test_windows_query_uses_wait_only_handle_and_fails_closed(monkeypatch, handle, wait, error, expected):
    import ctypes
    from types import SimpleNamespace

    calls = []
    class Function:
        def __init__(self, name, result):
            self.name, self.result = name, result
        def __call__(self, *args):
            calls.append((self.name, args))
            return self.result
    kernel = SimpleNamespace(OpenProcess=Function("open", handle), WaitForSingleObject=Function("wait", wait), CloseHandle=Function("close", True))
    owner = apply_controls.local_apply_process()
    with monkeypatch.context() as windows:
        windows.setattr(sys, "platform", "win32")
        windows.setattr(ctypes, "WinDLL", lambda *a, **kw: kernel, raising=False)
        windows.setattr(ctypes, "get_last_error", lambda: error, raising=False)
        windows.setattr(os, "kill", lambda *_: pytest.fail("Windows used mutating os.kill"))
        assert apply_controls.apply_owner_process_exited(owner) is expected
    assert calls[0] == ("open", (0x00100000, False, owner["pid"]))
    if handle:
        assert calls[1:] == [("wait", (handle, 0)), ("close", (handle,))]
    else:
        assert len(calls) == 1
