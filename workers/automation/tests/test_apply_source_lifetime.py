"""Best-effort source recovery protects logical owners, failures and submit intent.

All data is synthetic; there are no browser, credential or provider launches.
"""
from __future__ import annotations

import os

import pytest

from jobctrl import database
from jobctrl.apply import launcher, ownership
from jobctrl.state import record_job_event, set_stage_state

from .test_apply_launcher_ownership import owned_runtime as owned_runtime, _events


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
