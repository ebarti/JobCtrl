"""Best-effort source recovery protects logical owners, failures and submit intent.

All data is synthetic; there are no browser, credential or provider launches.
"""
from __future__ import annotations

import os
from hashlib import sha256
import json
import uuid

import pytest

from jobctrl import database
from jobctrl.apply import launcher, native_custody, ownership
from jobctrl.apply.process_birth import CustodyUnverified, validate_native_binding
from jobctrl.state import record_job_event, set_stage_state

from .test_apply_launcher_ownership import owned_runtime as owned_runtime, _events


def _synthetic_runtime_scope(app, tmp_path, monkeypatch, purpose="source", domain="gui", root_identity="12345:1700000000:123"):
    """Keep native receipt validation real; only kernel identity is faked."""
    runtime = tmp_path / "runtime"
    instance = sha256(str(app.resolve()).encode()).hexdigest()
    scope_id, boot = uuid.uuid4().hex, str(uuid.uuid4())
    scope = {
        "schemaVersion": 1, "id": scope_id, "instanceId": instance,
        "stateDir": str(app.resolve()), "runtimeHome": str(runtime), "bootSession": boot,
        "jobLabel": f"dev.jobctrl.exec.{instance}.{scope_id}", "domain": f"{domain}/{os.getuid()}",
        "rootPid": 12345, "rootIdentity": root_identity, "coalitionIds": [11, 22], "purpose": purpose,
    }
    directory = runtime / "instances" / instance / "executions"
    directory.mkdir(parents=True, mode=0o700)
    path = directory / f"{scope_id}.json"
    path.write_text(json.dumps(scope))
    path.chmod(0o600)
    monkeypatch.setenv("JOBCTRL_EXECUTION_SCOPE", scope_id)
    monkeypatch.setenv("JOBCTRL_RUNTIME_HOME", str(runtime))
    monkeypatch.setattr(native_custody, "boot_identity", lambda: boot)
    monkeypatch.setattr(native_custody, "_current_coalitions", lambda: [11, 22])
    return scope, path


@pytest.mark.parametrize("domain", ["gui", "user"])
def test_source_fleet_scope_allows_owned_apply_and_ordinary_retry(owned_runtime, monkeypatch, tmp_path, domain):
    app, first, _ = owned_runtime
    scope, _ = _synthetic_runtime_scope(app, tmp_path, monkeypatch, domain=domain)
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        assert owner._journal.native_custody is None
        assert owner._journal.value["source_best_effort"] is True
        ctx = {"dry_run": True, "launcher_run": owner}
        assert launcher.acquire_job(target_job_id=first, run_ctx=ctx, approval_required=False)
    successor = {"dry_run": True}
    assert launcher.acquire_job(target_job_id=first, run_ctx=successor, approval_required=False)
    assert successor["run_id"] != ctx["run_id"]
    recovered = [json.loads(payload) for kind, payload in _events(database.get_connection(), first)
                 if kind == "ApplyClaimSettled"]
    assert any(event["run_id"] == ctx["run_id"] and event["owner_lifetime_released"]
               and event["full_tree_verified"] is False for event in recovered)
    assert scope["purpose"] == "source"


@pytest.mark.parametrize("identity", [
    "synthetic", "12346:1700000000:123", "012345:1:1", "12345:0:0", "12345:1:1000000",
    "12345:bad:1", "12345:+1:1", "12345:1:-1", "12345:18446744073709551616:0", "12345:1:1:0",
    "12345:1:١", "12345:1_0:1", "12345: 1:1",
])
def test_source_fleet_scope_rejects_malformed_root_identity(owned_runtime, monkeypatch, tmp_path, identity):
    app, _, _ = owned_runtime
    _synthetic_runtime_scope(app, tmp_path, monkeypatch, root_identity=identity)
    with pytest.raises(CustodyUnverified):
        native_custody.capture_native_custody(app)


@pytest.mark.parametrize("identity", ["12345:000001:000009", "12345:18446744073709551615:999999"])
def test_source_fleet_scope_accepts_go_unsigned_time_boundaries(owned_runtime, monkeypatch, tmp_path, identity):
    app, _, _ = owned_runtime
    _synthetic_runtime_scope(app, tmp_path, monkeypatch, root_identity=identity)
    assert native_custody.capture_native_custody(app) is None


def test_source_fleet_scope_does_not_steal_active_apply(owned_runtime, monkeypatch, tmp_path):
    app, first, _ = owned_runtime
    _synthetic_runtime_scope(app, tmp_path, monkeypatch)
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        ctx = {"dry_run": True, "launcher_run": owner}
        assert launcher.acquire_job(target_job_id=first, run_ctx=ctx, approval_required=False)
        conn = database.get_connection()
        set_stage_state(conn, first, "apply", "pending", tenant_id="local", validate_transition=False)
        conn.commit()
        before = _events(conn, first)
        assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
        assert _events(conn, first) == before


def test_source_fleet_scope_cannot_prove_apply_completion(owned_runtime, monkeypatch, tmp_path):
    app, _, _ = owned_runtime
    scope, path = _synthetic_runtime_scope(app, tmp_path, monkeypatch)
    binding = {"scope": scope, "receipt_sha256": sha256(path.read_bytes()).hexdigest()}
    assert native_custody.capture_native_custody(app) is None
    assert native_custody.capture_source_census_coalitions(app) == (11, 22)
    with pytest.raises(CustodyUnverified):
        validate_native_binding(binding, app)
    assert native_custody.matches_active_native_receipt(binding, app) is False
    with pytest.raises(CustodyUnverified):
        native_custody.verify_native_completion(binding, app)


@pytest.mark.parametrize("domain", ["gui", "user"])
def test_dedicated_native_apply_scope_keeps_its_custody(owned_runtime, monkeypatch, tmp_path, domain):
    app, _, _ = owned_runtime
    scope, path = _synthetic_runtime_scope(app, tmp_path, monkeypatch, purpose="apply", domain=domain)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_APPLY_EXECUTION_SCOPE", scope["id"])
    binding = {"scope": scope, "receipt_sha256": sha256(path.read_bytes()).hexdigest()}
    assert native_custody.capture_native_custody(app) == binding
    assert native_custody.matches_active_native_receipt(binding, app)
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        assert owner._journal.native_custody == binding
        assert owner._journal.value["source_best_effort"] is False
        # The active receipt alone is never completion proof.
        with pytest.raises(CustodyUnverified):
            native_custody.verify_native_completion(binding, app)
        # Parser control only: a matching synthetic completion is accepted,
        # while changing the attested receipt invalidates it.
        directory = path.parent.parent / "completed-executions"
        directory.mkdir(mode=0o700)
        proof = directory / path.name
        value = {"schemaVersion": 1, "scope": scope, "receiptSha256": binding["receipt_sha256"],
                 "verificationBootSession": scope["bootSession"], "completedAt": "2026-10-30T00:00:00Z"}
        proof.write_text(json.dumps(value))
        proof.chmod(0o600)
        native_custody.verify_native_completion(binding, app)
        value["receiptSha256"] = "b" * 64
        proof.write_text(json.dumps(value))
        with pytest.raises(CustodyUnverified):
            native_custody.verify_native_completion(binding, app)


@pytest.mark.parametrize("fault", [
    "boot", "coalition", "workspace", "runtime", "purpose", "symlink", "bundled", "apply_flag",
    "foreign_domain", "foreign_gui", "oversized_pid", "oversized_coalition",
])
def test_source_fleet_scope_refuses_untrusted_context(owned_runtime, monkeypatch, tmp_path, fault):
    app, _, _ = owned_runtime
    scope, path = _synthetic_runtime_scope(app, tmp_path, monkeypatch)
    if fault == "boot":
        monkeypatch.setattr(native_custody, "boot_identity", lambda: str(uuid.uuid4()))
    elif fault == "coalition":
        monkeypatch.setattr(native_custody, "_current_coalitions", lambda: [11, 23])
    elif fault == "workspace":
        scope["stateDir"] = str(tmp_path / "foreign-workspace")
    elif fault == "runtime":
        scope["runtimeHome"] = str(tmp_path / "foreign-runtime")
    elif fault == "purpose":
        scope["purpose"] = "unrelated"
    elif fault == "symlink":
        other = tmp_path / "foreign-receipt"
        path.rename(other)
        path.symlink_to(other)
    elif fault == "bundled":
        monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    elif fault == "apply_flag":
        monkeypatch.setenv("JOBCTRL_APPLY_EXECUTION_SCOPE", scope["id"])
    elif fault == "foreign_domain":
        scope["domain"] = f"user/{os.getuid() + 1}"
    elif fault == "foreign_gui":
        scope["domain"] = f"gui/{os.getuid() + 1}"
    elif fault == "oversized_pid":
        scope["rootPid"] = 2**63
        scope["rootIdentity"] = f"{2**63}:1:1"
    elif fault == "oversized_coalition":
        scope["coalitionIds"] = [11, 2**64]
    if fault in {"workspace", "runtime", "purpose", "foreign_domain", "foreign_gui", "oversized_pid", "oversized_coalition"}:
        path.write_text(json.dumps(scope))
    with pytest.raises((CustodyUnverified, OSError)):
        with ownership.ApplyLauncherRun().lease():
            pytest.fail("untrusted source scope admitted an Apply owner")


def test_native_apply_scope_rejects_malformed_root_even_with_completion(owned_runtime, monkeypatch, tmp_path):
    app, _, _ = owned_runtime
    scope, path = _synthetic_runtime_scope(app, tmp_path, monkeypatch, purpose="apply", root_identity="12346:1:1")
    binding = {"scope": scope, "receipt_sha256": sha256(path.read_bytes()).hexdigest()}
    completion = path.parent.parent / "completed-executions"
    completion.mkdir(mode=0o700)
    proof = completion / path.name
    proof.write_text(json.dumps({"schemaVersion": 1, "scope": scope, "receiptSha256": binding["receipt_sha256"],
                                 "verificationBootSession": scope["bootSession"], "completedAt": "2026-10-30T00:00:00Z"}))
    proof.chmod(0o600)
    with pytest.raises(CustodyUnverified):
        validate_native_binding(binding, app)
    assert native_custody.matches_active_native_receipt(binding, app) is False
    with pytest.raises(CustodyUnverified):
        native_custody.verify_native_completion(binding, app)


def test_active_source_owner_cannot_be_stolen_by_stage_reset_or_cancellation(owned_runtime):
    _, first, _ = owned_runtime
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        ctx = {"dry_run": True, "launcher_run": owner}
        assert launcher.acquire_job(target_job_id=first, run_ctx=ctx, approval_required=False)
        descriptor = owner._journal.owner_descriptor
        assert descriptor is not None and not os.get_inheritable(descriptor)
        owner.cancel()
        conn = database.get_connection()
        set_stage_state(conn, first, "apply", "pending", tenant_id="local", validate_transition=False)
        conn.commit()
        before = _events(conn, first)
        assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
        assert _events(conn, first) == before
        owner.finish()


def test_generic_stage_reset_cannot_clear_recorded_submit_ambiguity(owned_runtime):
    _, first, _ = owned_runtime
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        ctx = {"dry_run": True, "launcher_run": owner}
        assert launcher.acquire_job(target_job_id=first, run_ctx=ctx, approval_required=False)
        conn = database.get_connection()
        record_job_event(conn, first, "apply", "ApplySubmitIntended", tenant_id="local", payload={"run_id": ctx["run_id"]})
        conn.commit()
        launcher.mark_result(first, "failed", "ambiguous synthetic external result", run_ctx=ctx)
        owner.finish()
    set_stage_state(conn, first, "apply", "pending", tenant_id="local", validate_transition=False)
    conn.commit()
    accepted = _events(conn, first)
    assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
    assert _events(conn, first) == accepted


@pytest.mark.parametrize("fault", ["missing", "symlink", "replacement"])
def test_source_lifetime_recovery_never_creates_or_adopts_replaced_lock(owned_runtime, tmp_path, fault):
    _, first, _ = owned_runtime
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        ctx = {"dry_run": True, "launcher_run": owner}
        assert launcher.acquire_job(target_job_id=first, run_ctx=ctx, approval_required=False)
    path = owner._journal.directory / "owner.lock"
    path.unlink()
    foreign = tmp_path / "foreign-preserved"
    foreign.write_bytes(b"accepted foreign bytes")
    if fault == "symlink":
        path.symlink_to(foreign)
    elif fault == "replacement":
        path.write_bytes(b"replacement-preserved")
        path.chmod(0o600)
    conn = database.get_connection()
    before = _events(conn, first)
    assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
    assert _events(conn, first) == before
    assert foreign.read_bytes() == b"accepted foreign bytes"
    if fault == "missing":
        assert not path.exists()
    elif fault == "replacement":
        assert path.read_bytes() == b"replacement-preserved"
