"""Synthetic email-refusal recovery inside the real source-controller scope."""
from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import socket
import sys


def exercise_email_refusal(app: Path) -> None:
    """Recover a real source-owned claim with only external Apply ports faked."""
    from types import SimpleNamespace

    from pytest import MonkeyPatch

    from jobctrl.apply import launcher, native_custody, ownership
    from jobctrl.domain.tenant import TenantId
    from tests.test_apply_regressions import _email_facts, _insert_ready_job, owned_email_path

    fixture_dir = app / "email-refusal"
    fixture_dir.mkdir(mode=0o700)
    with MonkeyPatch.context() as monkeypatch:
        fixture = owned_email_path.__wrapped__(
            fixture_dir, monkeypatch, SimpleNamespace(node=SimpleNamespace(name="source_scope_email_refusal")),
        )
        state = next(fixture)
        try:
            calls = []
            state.late = lambda: calls.append("agent")
            state.conn.execute("UPDATE jobs SET title='Changed synthetic role' WHERE job_id=?", (state.job_id,))
            state.conn.commit()
            owner = ownership.ApplyLauncherRun()
            with owner.lease():
                assert native_custody.capture_native_custody(app) is None
                assert owner._journal.native_custody is None and owner._journal.value["source_best_effort"]
                ctx = {"workflow_id": "synthetic-source-email", "launcher_run": owner}
                job = launcher.acquire_job(target_job_id=state.job_id, worker_id=1,
                                           approval_required=False, run_ctx=ctx)
                assert job is not None
                # The fake browser/agent never connect; reserve an unused
                # loopback port so an accidental connection cannot reach a
                # listener owned by another process.
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
                    reservation.bind(("127.0.0.1", 0))
                    result, _ = launcher.run_job(job, reservation.getsockname()[1], worker_id=1,
                                                 snapshot=state.snapshot, run_ctx=ctx, tenant_id=TenantId("local"))
                assert result.error == "approval_stale_email_candidate"
                assert _email_facts(state)["ApplyEmailAuthorityRefused"] == 1
            # Admission recovers the ended source owner and parks the same
            # authority atomically with its owner-checked refund.
            for _ in range(3):
                assert launcher.acquire_job(target_job_id=state.job_id, approval_required=False) is None
            assert tuple(state.conn.execute(
                "SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (state.job_id,),
            ).fetchone()) == ("pending", 0)
            facts = _email_facts(state)
            assert facts["ApplyEmailAuthorityParked"] == 1 and facts["ApplySubmitIntended"] == 0
            assert calls == ["agent"] and state.sender_calls == 0
            settled = [json.loads(row[0]) for row in state.conn.execute(
                "SELECT payload_json FROM job_events WHERE job_id=? AND event_type='ApplyClaimSettled'", (state.job_id,),
            )]
            assert any(value["run_id"] == ctx["run_id"] and value["owner_lifetime_released"] is True
                       and value["full_tree_verified"] is False for value in settled)

            peer = _insert_ready_job(state.conn, url="https://example.com/email-peer")
            for kind in ("tailored_resume", "resume_pdf"):
                path = fixture_dir / f"peer-{kind}"
                path.write_bytes(b"owned synthetic material")
                state.conn.execute("UPDATE job_materials_artifacts SET path=? WHERE job_id=? AND artifact_type=?",
                                   (str(path), peer, kind))
            state.conn.commit()
            peer_ctx = {"dry_run": True}
            assert launcher.acquire_job(target_job_id=peer, approval_required=False, run_ctx=peer_ctx) is not None
            state.conn.execute("UPDATE jobs SET title='New synthetic authority' WHERE job_id=?", (state.job_id,))
            state.conn.commit()
            successor_ctx = {}
            assert launcher.acquire_job(target_job_id=state.job_id, approval_required=False,
                                        run_ctx=successor_ctx) is not None
            assert successor_ctx["run_id"] != ctx["run_id"] and calls == ["agent"] and state.sender_calls == 0
        finally:
            try:
                next(fixture)
            except StopIteration:
                pass



def main() -> None:
    automation = Path(sys.argv[1]).resolve(strict=True)
    evidence = Path(sys.argv[2])
    sys.path.insert(0, str(automation))
    sys.path.insert(0, str(automation / "src"))

    import jobctrl
    from jobctrl import config
    from jobctrl.apply import native_custody
    from jobctrl.apply.process_birth import boot_identity

    assert Path(jobctrl.__file__).resolve().is_relative_to(automation / "src")
    app = Path(os.environ["JOBCTRL_DIR"]).resolve(strict=True)
    assert app == config.APP_DIR.resolve(strict=True)
    instance = sha256(str(app).encode()).hexdigest()
    scope = json.loads((Path(os.environ["JOBCTRL_RUNTIME_HOME"]) / "instances" / instance / "executions"
                        / f"{os.environ['JOBCTRL_EXECUTION_SCOPE']}.json").read_text())
    assert scope["purpose"] == "source" and scope["bootSession"] == boot_identity()
    assert scope["coalitionIds"] == native_custody._current_coalitions()
    assert native_custody.capture_native_custody(app) is None
    config.ensure_dirs()
    exercise_email_refusal(app)
    evidence.write_text(json.dumps({"source_context": True, "email_refusal_recovery": True}))


if __name__ == "__main__":
    main()
