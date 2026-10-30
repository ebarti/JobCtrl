"""Synthetic Apply ownership inside the real source-controller execution scope.

The Darwin Go integration test invokes this helper with a private workspace.
It starts only owned Python sleepers; no browser, provider or sender is used.
"""
from __future__ import annotations

from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main() -> None:
    automation = Path(sys.argv[1]).resolve(strict=True)
    evidence = Path(sys.argv[2])
    sys.path.insert(0, str(automation))
    sys.path.insert(0, str(automation / "src"))

    import jobctrl
    from jobctrl import config, database
    from jobctrl.apply import launcher, native_custody, ownership
    from jobctrl.apply.process_birth import boot_identity
    from jobctrl.enrichment import availability
    from tests.source_scope_child_evidence import OwnedChildEvidence
    from tests.test_apply_regressions import _insert_ready_job

    assert Path(jobctrl.__file__).resolve().is_relative_to(automation / "src")
    app = Path(os.environ["JOBCTRL_DIR"]).resolve(strict=True)
    assert app == config.APP_DIR.resolve(strict=True)
    scope_id = os.environ["JOBCTRL_EXECUTION_SCOPE"]
    runtime = Path(os.environ["JOBCTRL_RUNTIME_HOME"])
    from hashlib import sha256
    instance = sha256(str(app).encode()).hexdigest()
    scope = json.loads((runtime / "instances" / instance / "executions" / f"{scope_id}.json").read_text())
    boot = boot_identity()
    assert scope["purpose"] == "source" and scope["bootSession"] == boot
    assert scope["coalitionIds"] == native_custody._current_coalitions()
    assert native_custody.capture_native_custody(app) is None

    config.ensure_dirs()
    conn = database.init_db()
    first = _insert_ready_job(conn, url="https://example.com/first", application_url="https://example.com/apply-first")
    peer_job = _insert_ready_job(conn, url="https://example.com/peer", application_url="https://example.com/apply-peer")

    # This fixture seeds fresh availability; fail if a refresh would contact
    # an employer. The controller also confines this scope to loopback.
    def unexpected_refresh(*_args, **_kwargs):
        raise AssertionError("synthetic Apply probe must not refresh availability")

    availability.require_fresh_active = unexpected_refresh
    for kind in ("tailored_resume", "resume_pdf"):
        path = app / f"synthetic-{kind}"
        path.write_bytes(b"owned synthetic material")
        conn.execute("UPDATE job_materials_artifacts SET path=? WHERE artifact_type=?", (str(path), kind))
    conn.commit()

    def events(job_id):
        return [tuple(row) for row in conn.execute(
            "SELECT event_type,payload_json FROM job_events WHERE job_id=? ORDER BY event_id", (job_id,),
        )]

    def stage(job_id):
        return tuple(conn.execute(
            "SELECT state,attempt_count FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'",
            (job_id,),
        ).fetchone())

    def sleeper(run, worker, name):
        marker = app / f"{name}.ready"
        code = "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(60)"
        process = run.spawn(worker, "agent", [sys.executable, "-c", code, str(marker)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
        trace.capture(name, process)
        assert process._jobctrl_birth_source_coalitions == tuple(scope["coalitionIds"])
        deadline = time.monotonic() + 10
        while not marker.exists():
            assert process.poll() is None and time.monotonic() < deadline
            time.sleep(0.01)
        return process

    runs = []
    trace = OwnedChildEvidence(app, scope["coalitionIds"])
    trace.install()
    with ExitStack() as stack:
        def finish_trace():
            if trace.finish():
                raise RuntimeError("Owned synthetic child exit could not be reaped; custody retained")
            if trace.scoped_after_reap != {"first", "peer"}:
                raise RuntimeError("Real source-scoped census was not verified after both child exits")
        stack.callback(finish_trace)
        try:
            first_run, peer_run = ownership.ApplyLauncherRun(), ownership.ApplyLauncherRun()
            runs.extend((first_run, peer_run))
            stack.enter_context(first_run.lease())
            stack.enter_context(peer_run.lease())
            assert first_run._journal.native_custody is None and first_run._journal.value["source_best_effort"]
            first_run.allocate_workers(1)
            peer_run.allocate_workers(1)
            first_worker, peer_worker = first_run.worker_ids[0], peer_run.worker_ids[0]
            first_ctx = {"dry_run": True, "launcher_run": first_run, "worker_id": first_worker}
            peer_ctx = {"dry_run": True, "launcher_run": peer_run, "worker_id": peer_worker}
            assert launcher.acquire_job(target_job_id=first, worker_id=first_worker, run_ctx=first_ctx, approval_required=False)
            assert launcher.acquire_job(target_job_id=peer_job, worker_id=peer_worker, run_ctx=peer_ctx, approval_required=False)
            first_child = sleeper(first_run, first_worker, "first")
            peer_child = sleeper(peer_run, peer_worker, "peer")
            peer_before = events(peer_job)
            peer_stage = stage(peer_job)
            # A pending reset must not let another owner steal a live claim.
            conn.execute("UPDATE job_stage_states SET state='pending' WHERE tenant_id='local' AND job_id=? AND stage='apply'", (first,))
            conn.commit()
            first_before = events(first)
            assert launcher.acquire_job(target_job_id=first, run_ctx={"dry_run": True}, approval_required=False) is None
            assert events(first) == first_before
            conn.execute("UPDATE job_stage_states SET state='running' WHERE tenant_id='local' AND job_id=? AND stage='apply'", (first,))
            conn.commit()
            launcher.mark_result(first, "dry_run", run_ctx=first_ctx)
            first_run.finish()
            assert first_child.poll() is not None
            assert peer_child.poll() is None and events(peer_job) == peer_before and stage(peer_job) == peer_stage
            settled = [json.loads(payload) for kind, payload in events(first) if kind == "ApplyClaimSettled"]
            assert any(value["run_id"] == first_ctx["run_id"] and value["source_best_effort"] is True
                       and value["tracked_cleanup_completed"] is True and value["full_tree_verified"] is False
                       for value in settled)

            retry = ownership.ApplyLauncherRun()
            runs.append(retry)
            with retry.lease():
                retry.allocate_workers(1)
                retry_ctx = {"dry_run": True, "launcher_run": retry, "worker_id": retry.worker_ids[0]}
                assert launcher.acquire_job(target_job_id=first, worker_id=retry.worker_ids[0],
                                            run_ctx=retry_ctx, approval_required=False)
                assert retry_ctx["run_id"] != first_ctx["run_id"]
                launcher.mark_result(first, "dry_run", run_ctx=retry_ctx)
                retry.finish()
            assert peer_child.poll() is None and events(peer_job) == peer_before and stage(peer_job) == peer_stage
            launcher.mark_result(peer_job, "dry_run", run_ctx=peer_ctx)
            peer_run.finish()
            assert peer_child.poll() is not None and boot_identity() == boot
            evidence.write_text(json.dumps({"source_context": True, "active_owner_protected": True,
                "peer_preserved": True, "owned_children_cleaned": True, "same_boot_retry": True}))
        finally:
            cleanup_errors = []
            for run in reversed(runs):
                if not run._finishing:
                    try:
                        run.finish()
                    except Exception as exc:
                        cleanup_errors.append(exc)
            if cleanup_errors:
                raise ExceptionGroup("Synthetic Apply cleanup was not verified", cleanup_errors)
    database.close_connection()


if __name__ == "__main__":
    main()
