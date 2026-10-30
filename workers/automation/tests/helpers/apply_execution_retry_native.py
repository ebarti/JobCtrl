"""Same-job native dry-run retry while an independently owned peer is live.

The Go fixture supplies a verified installed payload with controlled external
ports. Every job, artifact, listener and run is synthetic and task-owned.
Arguments: WORKER_SOURCE APP_DIR EVIDENCE_DIR.
"""
from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import time
import uuid

source_arg, app_arg, evidence_arg = sys.argv[1:]
source = Path(source_arg)
sys.path[:0] = [str(source), str(source.parent)]
app, evidence = Path(app_arg).resolve(), Path(evidence_arg).resolve()
os.environ["JOBCTRL_DIR"] = str(app)
os.environ["LANGFUSE_DISABLE"] = "1"
os.environ["OTEL_SDK_DISABLED"] = "true"

from jobctrl import config, database  # noqa: E402
from jobctrl.apply.execution import ScopedApplyExecution  # noqa: E402
from jobctrl.apply.native_custody import verify_native_completion  # noqa: E402
from jobctrl.browser_capabilities import (  # noqa: E402
    enable_system_browser_capability,
    load_browser_capability_catalog,
)
from tests.test_apply_regressions import _insert_ready_job  # noqa: E402


def wait_json(path: Path, *, nonce: str | None = None, future: Future | None = None) -> dict:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if path.exists():
            value = json.loads(path.read_text())
            if nonce is None or value.get("nonce") == nonce:
                return value
        if future is not None and future.done():
            future.result()
            raise RuntimeError(f"native run ended before publishing {path.name}")
        time.sleep(.01)
    raise RuntimeError(f"owned native fixture did not publish {path.name}")


def publish_probe(path: Path, nonce: str) -> None:
    temporary = path.with_name(f".{path.name}.{nonce}")
    temporary.write_text(json.dumps({"nonce": nonce}))
    temporary.replace(path)


def seed_job(conn, name: str) -> tuple[str, list[Path]]:
    job = _insert_ready_job(conn, url=f"https://example.com/native-retry-{name}")
    directory = app / "qa-inputs" / str(job)
    directory.mkdir(parents=True, mode=0o700)
    paths = []
    for artifact_type, filename in (("tailored_resume", "resume.txt"), ("resume_pdf", "resume.pdf")):
        path = directory / filename
        path.write_bytes(f"owned synthetic {name} {artifact_type}".encode())
        conn.execute("UPDATE job_materials_artifacts SET path=? WHERE tenant_id='local' AND job_id=? "
                     "AND generation=1 AND artifact_type=?", (str(path), job, artifact_type))
        paths.append(path)
    conn.commit()
    return job, paths


def events(conn, job: str) -> list[tuple]:
    return [tuple(row) for row in conn.execute(
        "SELECT event_type,payload_json FROM job_events "
        "WHERE tenant_id='local' AND job_id=? ORDER BY event_id", (job,))]


def stage(conn, job: str) -> tuple:
    return tuple(conn.execute("SELECT * FROM job_stage_states "
                              "WHERE tenant_id='local' AND job_id=? AND stage='apply'", (job,)).fetchone())


def claims(conn, job: str) -> list[tuple]:
    return [tuple(row) for row in conn.execute(
        "SELECT json_extract(payload_json,'$.run_id'), json_extract(payload_json,'$.launcher_id') "
        "FROM job_events WHERE tenant_id='local' AND job_id=? AND stage='apply' "
        "AND event_type='ApplyClaimAcquired' ORDER BY event_id", (job,))]


def started_runs(conn, job: str) -> list[str]:
    return [row[0] for row in conn.execute(
        "SELECT json_extract(payload_json,'$.run_id') FROM job_events "
        "WHERE tenant_id='local' AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' ORDER BY event_id", (job,))]


def require_retired(conn, job: str, execution: ScopedApplyExecution, owner: dict) -> None:
    result_path = app / "apply-invocations" / execution.identity / "result.json"
    result = json.loads(result_path.read_text())
    binding = result["native_custody"]
    if (result["request_id"] != execution.identity or result["launcher_id"] != execution.identity
            or result["error"] is not None or binding["scope"]["id"] != owner["scope_id"]):
        raise RuntimeError("native result does not bind the original claim to its exact execution")
    verify_native_completion(binding, app)
    if (app / "apply-runs" / execution.identity / "custody.json").exists():
        raise RuntimeError("the first native run still holds its custody journal")
    retired = conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id='local' AND job_id=? AND stage='apply' "
        "AND event_type='ApplyCustodyRetired' AND json_extract(payload_json,'$.run_id')=? "
        "AND json_extract(payload_json,'$.launcher_id')=? "
        "AND json_extract(payload_json,'$.native_completion')=1",
        (job, owner["run_id"], execution.identity),
    ).fetchone()
    if not retired:
        raise RuntimeError("first claim has no matching native custody retirement")
    if conn.execute(
        "SELECT count(*) FROM job_events WHERE tenant_id='local' AND job_id=? AND stage='apply' "
        "AND event_type='DryRunCompleted' AND json_extract(payload_json,'$.run_id')=?",
        (job, owner["run_id"]),
    ).fetchone()[0] != 1:
        raise RuntimeError("the retired owner did not complete its synthetic dry run")
    if conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id='local' AND job_id=? AND stage='apply' "
        "AND event_type IN ('ApplySubmitIntended','ApplicationSubmitted') LIMIT 1", (job,),
    ).fetchone():
        raise RuntimeError("a dry-run fixture recorded a submission")
    # The Go fixture separately checks each escaped preflight writer after all
    # runs. Check the first one now, before admitting the successor.
    ticks = evidence / f"ticks-{owner['scope_id']}"
    previous = ticks.read_bytes()
    time.sleep(.05)
    if ticks.read_bytes() != previous:
        raise RuntimeError("first native completion left its escaped writer active")


def main() -> None:
    config.ensure_dirs()
    conn = database.init_db()
    controls = app / "qa-native-controls"
    controls.mkdir(mode=0o700, exist_ok=True)
    catalog = load_browser_capability_catalog(
        path=source.parent.parent.parent / "packaging/distribution/capability-policy.json"
    )
    enable_system_browser_capability("auto-apply-browser", evidence / "owned-version-browser", app_dir=app, catalog=catalog)
    target, target_artifacts = seed_job(conn, "target")
    peer_job, peer_artifacts = seed_job(conn, "peer")
    accepted_artifacts = {path: path.read_bytes() for path in target_artifacts + peer_artifacts}
    executor = ThreadPoolExecutor(max_workers=2)
    pending: list[tuple[ScopedApplyExecution, Future[tuple[int, int]]]] = []

    def start(job: str) -> tuple[ScopedApplyExecution, Future[tuple[int, int]]]:
        execution = ScopedApplyExecution()
        options = dict(limit=1, target_job_id=job, tenant_id="local", min_score=7,
                       headless=True, model="default", dry_run=True, continuous=False,
                       poll_interval=60, workers=1, approval_required=False,
                       workflow_id="synthetic-native-retry-" + uuid.uuid4().hex)
        future = executor.submit(execution.run, options)
        pending.append((execution, future))
        return execution, future

    def assert_peer(owner: dict, future: Future, prior_events: list[tuple], prior_stage: tuple) -> None:
        if future.done():
            raise RuntimeError("peer native run ended before the retry completed")
        nonce = uuid.uuid4().hex
        publish_probe(controls / f"probe-{peer_job}.json", nonce)
        alive = wait_json(controls / f"alive-{peer_job}.json", nonce=nonce, future=future)
        for key in ("job_id", "run_id", "worker_id", "pid", "scope_id"):
            if alive.get(key) != owner[key]:
                raise RuntimeError("live peer no longer has its original owned identity")
        if (events(conn, peer_job) != prior_events or stage(conn, peer_job) != prior_stage
                or (Path(owner["work_dir"]) / "accepted-native-bytes").read_bytes()
                != b"accepted owned native Apply bytes"):
            raise RuntimeError("selected run changed peer events, state or files")
        if any(path.read_bytes() != content for path, content in accepted_artifacts.items()):
            raise RuntimeError("selected run changed an accepted synthetic material")

    try:
        first, first_future = start(target)
        owner = wait_json(controls / f"ready-{target}.json", future=first_future)
        peer_run, peer_future = start(peer_job)
        peer = wait_json(controls / f"ready-{peer_job}.json", future=peer_future)
        if owner["job_id"] != target or peer["job_id"] != peer_job:
            raise RuntimeError("native fixture claimed a different job")
        if any(owner[key] == peer[key] for key in ("run_id", "worker_id", "scope_id", "port", "work_dir")):
            raise RuntimeError("concurrent native jobs shared an ownership identity")
        if (claims(conn, target) != [(owner["run_id"], first.identity)]
                or started_runs(conn, target) != [owner["run_id"]]):
            raise RuntimeError("first native execution did not acquire the selected job")
        peer_events, peer_stage = events(conn, peer_job), stage(conn, peer_job)
        assert_peer(peer, peer_future, peer_events, peer_stage)
        first_file = Path(owner["work_dir"]) / "accepted-native-bytes"
        first_bytes = first_file.read_bytes()
        if first_bytes != b"accepted owned native Apply bytes":
            raise RuntimeError("first native run did not create its owned attempt file")
        (controls / f"release-{target}").write_text("complete")
        if first_future.result(timeout=90) != (0, 0):
            raise RuntimeError("first dry-run had an unexpected outcome")
        require_retired(conn, target, first, owner)
        retryable = conn.execute(
            "SELECT state,error_code,retryable FROM job_stage_states "
            "WHERE tenant_id='local' AND job_id=? AND stage='apply'", (target,),
        ).fetchone()
        if tuple(retryable) != ("skipped", "DRY_RUN", 1):
            raise RuntimeError("first synthetic dry run did not leave a retryable stage")
        assert_peer(peer, peer_future, peer_events, peer_stage)
        (controls / f"ready-{target}.json").unlink()
        (controls / f"release-{target}").unlink()
        successor_run, successor_future = start(target)
        successor = wait_json(controls / f"ready-{target}.json", future=successor_future)
        if successor["job_id"] != target:
            raise RuntimeError("retry did not claim the selected job")
        if any(successor[key] == owner[key] for key in ("run_id", "worker_id", "scope_id", "work_dir")):
            raise RuntimeError("same-job retry reused an earlier ownership identity or file namespace")
        if any(successor[key] == peer[key] for key in ("run_id", "worker_id", "scope_id", "port", "work_dir")):
            raise RuntimeError("same-job retry collided with the live peer")
        if (claims(conn, target) != [(owner["run_id"], first.identity), (successor["run_id"], successor_run.identity)]
                or started_runs(conn, target) != [owner["run_id"], successor["run_id"]]):
            raise RuntimeError("same-job retry lacks a fresh canonical claim")
        successor_file = Path(successor["work_dir"]) / "accepted-native-bytes"
        if (first_file.read_bytes() != first_bytes or successor_file.read_bytes() != first_bytes
                or os.stat(first_file).st_ino == os.stat(successor_file).st_ino):
            raise RuntimeError("same-job retry did not preserve distinct per-attempt files")
        assert_peer(peer, peer_future, peer_events, peer_stage)
        (controls / f"release-{target}").write_text("complete")
        if successor_future.result(timeout=90) != (0, 0):
            raise RuntimeError("same-job retry had an unexpected outcome")
        require_retired(conn, target, successor_run, successor)
        assert_peer(peer, peer_future, peer_events, peer_stage)
        (controls / f"release-{peer_job}").write_text("complete")
        if peer_future.result(timeout=90) != (0, 0):
            raise RuntimeError("peer dry-run did not finish independently")
        require_retired(conn, peer_job, peer_run, peer)
        (evidence / "native-retry-results.json").write_text(json.dumps({
            "first_request": first.identity, "first_run": owner["run_id"],
            "second_request": successor_run.identity, "second_run": successor["run_id"],
            "peer_request": peer_run.identity, "peer_run": peer["run_id"],
        }))
    finally:
        for job in (target, peer_job):
            (controls / f"release-{job}").write_text("complete")
        for execution, future in pending:
            if not future.done():
                execution.cancel()  # Exact still-owned Popen, never an inferred PID.
        executor.shutdown(wait=True, cancel_futures=True)
        database.close_thread_connections()


main()
