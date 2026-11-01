"""Unverified Apply ownership cannot be released by a stage label or root exit."""
from __future__ import annotations

from hashlib import sha256
import json
import os
import uuid

import pytest
from typer.testing import CliRunner

from jobctrl import cli, config, database
from jobctrl.apply import launcher
from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state
from tests.test_exact_v7_apply_acquire_job_identity import LOCAL_JOB_ID, LOCAL_TENANT, _insert_ready_job


@pytest.fixture()
def world(tmp_path, monkeypatch):
    path = tmp_path / "owned.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(database, "DB_PATH", path)
    conn = database.init_db(path)
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "score", "succeeded", validate_transition=False)
    conn.commit()
    monkeypatch.setattr(launcher, "get_connection", lambda: conn)
    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    try:
        yield conn
    finally:
        database.close_connection(path)


def test_untracked_stopped_owner_recovery_is_nonmutating(world, monkeypatch):
    conn = world
    monkeypatch.setattr(launcher, "main", lambda **_: pytest.fail("Recovery launched Apply"))
    context = {"run_id": "untracked-owner"}
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False, run_ctx=context)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", attempt_count=1, retryable=False, validate_transition=False)
    record_job_event(conn, LOCAL_JOB_ID, "apply", "StageSkipped", payload={
        "manualDisposition": "skip", "previousState": "running",
    })
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")]
    result = CliRunner().invoke(cli.app, ["apply", "--recover-stopped"])
    assert result.exit_code == 0, result.output
    assert "Recovered 0" in result.output
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")] == before
    with pytest.raises(ValueError, match="prior admitted run"):
        reset_job_stage(conn, LOCAL_JOB_ID, "apply")
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False) is None


def test_running_relabel_cannot_erase_a_durable_stop_during_recovery(world, monkeypatch):
    conn = world
    context = {'run_id': 'untracked-owner'}
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False, run_ctx=context)
    record_job_event(conn, LOCAL_JOB_ID, 'apply', 'StageSkipped', payload={
        'manualDisposition': 'skip', 'previousState': 'running',
    })
    conn.commit()
    before = [tuple(row) for row in conn.execute('SELECT * FROM job_stage_states ORDER BY stage')]
    monkeypatch.setattr(launcher, '_workflow_terminal_or_gone', lambda *_args, **_kwargs: True)
    assert launcher.recover_ambiguous_running_apply() == 0
    assert [tuple(row) for row in conn.execute('SELECT * FROM job_stage_states ORDER BY stage')] == before
    with pytest.raises(ValueError, match='prior admitted run'):
        reset_job_stage(conn, LOCAL_JOB_ID, 'apply')
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False) is None


def test_targeted_native_claim_checks_running_owner_for_custody(world, monkeypatch):
    from jobctrl import runtime

    conn = world
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "running", attempt_count=1, validate_transition=False)
    conn.commit()
    seen = []
    monkeypatch.setattr(runtime, "is_bundled_runtime", lambda *_args: True)
    monkeypatch.setattr(launcher, "_has_unsettled_apply_owner", lambda _conn, *, tenant_id, job_id: seen.append((tenant_id, job_id)) or True)
    assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False, run_ctx={"dry_run": True}) is None
    assert seen == [(LOCAL_TENANT, LOCAL_JOB_ID)]
    assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
                              (LOCAL_TENANT, LOCAL_JOB_ID)).fetchone()) == ("running", 1)


@pytest.mark.parametrize("boundary", ["verified", "unverified", "intent", "successor"])
def test_native_stopped_running_relabel_requires_exact_custody_before_reset(world, monkeypatch, boundary):
    from jobctrl import runtime
    from jobctrl.apply import native_custody
    from jobctrl.apply.ownership import ApplyLauncherRun
    from jobctrl.apply.process_birth import CustodyUnverified
    from jobctrl.infrastructure.apply_controls import capture_apply_dispatch_frontier

    conn = world
    app_dir = config.APP_DIR.resolve()
    identity = uuid.uuid4().hex
    instance = sha256(str(app_dir).encode()).hexdigest()
    binding = {"scope": {
        "schemaVersion": 1, "id": identity, "instanceId": instance, "stateDir": str(app_dir),
        "runtimeHome": "/synthetic/runtime", "bootSession": str(uuid.uuid4()),
        "jobLabel": f"dev.jobctrl.exec.{instance}.{identity}", "domain": f"gui/{os.getuid()}",
        "rootPid": 12345, "rootIdentity": "12345:1700000000:123", "coalitionIds": [1, 2], "purpose": "apply",
    }, "receipt_sha256": "a" * 64}
    verified = []

    def verify(actual, actual_app):
        assert actual == binding and actual_app == app_dir
        if boundary == "unverified":
            raise CustodyUnverified("synthetic missing native proof")
        verified.append(actual)

    monkeypatch.setattr(native_custody, "capture_native_custody", lambda _app: binding)
    monkeypatch.setattr(native_custody, "verify_native_completion", verify)
    monkeypatch.setattr(runtime, "is_bundled_runtime", lambda *_args: True)
    owner = ApplyLauncherRun()
    with owner.lease():
        context = {"launcher_run": owner, "dry_run": True}
        assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False, run_ctx=context)
        set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", attempt_count=1, retryable=False, validate_transition=False)
        record_job_event(conn, LOCAL_JOB_ID, "apply", "StageSkipped", payload={
            "manualDisposition": "skip", "previousState": "running",
        })
        # A pre-upgrade writer left the local row running after the saved Stop.
        set_stage_state(conn, LOCAL_JOB_ID, "apply", "running", attempt_count=1, retryable=True, validate_transition=False)
        if boundary == "intent":
            record_job_event(conn, LOCAL_JOB_ID, "apply", "ApplySubmitIntended", payload={"run_id": context["run_id"]})
        elif boundary == "successor":
            record_job_event(conn, LOCAL_JOB_ID, "apply", "ApplyClaimAcquired", payload={"run_id": "successor", "launcher_id": "successor-launcher"})
        conn.commit()

    with pytest.raises(ValueError):
        reset_job_stage(conn, LOCAL_JOB_ID, "apply")
    if boundary == "unverified":
        with pytest.raises(CustodyUnverified, match="synthetic missing native proof"):
            launcher.recover_apply_custody(owner.identity)
    elif boundary == "successor":
        launcher.recover_apply_custody(owner.identity)
        assert verified
    else:
        assert launcher.recover_ambiguous_running_apply(only_stopped=True) == 1
        assert verified

    stage = tuple(conn.execute(
        "SELECT state,attempt_count,retryable FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone())
    retired = [json.loads(row[0]) for row in conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND event_type='ApplyCustodyRetired'",
        (LOCAL_TENANT, LOCAL_JOB_ID),
    )]
    if boundary == "verified":
        assert stage == ("skipped", 1, 0)
        assert len(retired) == 1
        assert (retired[0]["run_id"], retired[0]["launcher_id"], retired[0]["native_completion"]) == (
            context["run_id"], owner.identity, True,
        )
        reset_job_stage(conn, LOCAL_JOB_ID, "apply")
        frontier, _ = capture_apply_dispatch_frontier(conn, tenant_id=LOCAL_TENANT, job_id=LOCAL_JOB_ID)
        assert launcher.acquire_job(target_job_id=LOCAL_JOB_ID, approval_required=False,
                                    run_ctx={"dry_run": True, "dispatch_frontier": frontier}) is not None
    else:
        assert stage == ("running", 1, 1)
        assert len(retired) == int(boundary == "intent")
        with pytest.raises(ValueError):
            reset_job_stage(conn, LOCAL_JOB_ID, "apply")
