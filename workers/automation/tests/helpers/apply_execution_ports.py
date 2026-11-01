"""Controlled browser/model/network/profile ports for a literal native QA payload.

Imported only by the native test's authenticated Python fixture. Production
modules expose no flag or alternate interpreter hook for this fixture.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import uuid


def _publish_ready(path: Path, evidence: dict) -> None:
    # Existence is the reader's readiness signal, so publish only complete JSON.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as stream:
            temporary = Path(stream.name)
            json.dump(evidence, stream)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def install() -> None:
    from jobctrl import config, database
    from jobctrl.apply import chrome, launcher, ownership
    from jobctrl.domain.apply.value_objects import DryRunComplete
    from jobctrl.domain.ports.apply import AgentResult, BrowserSession
    from jobctrl.infrastructure import apply as adapters, network
    from jobctrl.infrastructure.process_ownership import terminate_owned_process
    from jobctrl.infrastructure import process_ownership
    from tests.test_apply_use_cases import _FakeSnapshot

    # Observe the real census without changing its authority or deadline. Only
    # aggregate inventory differences and the exact owned session are saved.
    original_read = process_ownership._read_process_inventory
    original_wait = process_ownership._wait_for_session_exit
    original_ids = process_ownership._darwin_process_ids
    census_context = threading.local()
    churn = os.environ.get("JOBCTRL_TEST_CENSUS_CHURN_DIR")

    def observed_ids(library):
        pids = original_ids(library)
        if churn and getattr(census_context, "trace", None) is not None:
            # The native Go test starts a real child in an unrelated coalition
            # after enumeration and before the session rows are inspected.
            from jobctrl.apply.native_custody import _current_coalitions
            directory = Path(churn)
            token = uuid.uuid4().hex
            (directory / f"request-{token}").touch()
            ack = directory / f"ack-{token}.json"
            deadline = time.monotonic() + 5
            while not ack.exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("owned unrelated census-churn fixture did not respond")
                time.sleep(.002)
            response = json.loads(ack.read_text())
            foreign = response.get("coalitions")
            if (response.get("error") or not isinstance(foreign, list) or len(foreign) != 2
                    or any(type(value) is not int or value <= 0 for value in foreign)
                    or foreign == _current_coalitions()):
                raise RuntimeError("census-churn fixture did not create an independent process")
        return pids

    def observed_read(**kwargs):
        trace = getattr(census_context, "trace", None)
        try:
            inventory, complete = original_read(**kwargs)
        except Exception as exc:
            if trace is not None:
                trace["samples"].append({"error": type(exc).__name__})
            raise
        if trace is not None:
            previous = trace["previous"]
            changes = None if previous is None else sum(
                1 for pid in previous.keys() | inventory.keys() if previous.get(pid) != inventory.get(pid)
            )
            members = sorted(pid for pid, (_, sid, active, _) in inventory.items()
                             if active and sid == trace["session_id"])
            trace["samples"].append({"complete": complete, "inventory_size": len(inventory),
                                     "inventory_changes": changes, "session_members": members})
            trace["previous"] = inventory
        return inventory, complete

    def observed_wait(session_id, **kwargs):
        prior = getattr(census_context, "trace", None)
        trace = {"session_id": session_id, "samples": [], "previous": None, "outcome": "refused"}
        census_context.trace = trace
        try:
            original_wait(session_id, **kwargs)
            trace["outcome"] = "verified"
        finally:
            census_context.trace = prior
            trace.pop("previous")
            directory = config.APP_DIR / "qa-census-observations"
            directory.mkdir(mode=0o700, exist_ok=True)
            path = directory / f"{uuid.uuid4().hex}.json"
            path.write_text(json.dumps(trace))
            path.chmod(0o600)

    if churn:
        from tests.helpers.apply_session_fence_native import exercise_once
        exercise_once(Path(churn))

    process_ownership._read_process_inventory = observed_read
    process_ownership._wait_for_session_exit = observed_wait
    process_ownership._darwin_process_ids = observed_ids

    class Ports:
        def __init__(self):
            self.processes = {}

        def launch(self, config):
            process = ownership.spawn_owned_apply_process(config.worker_id, "browser",
                [sys.executable, "-u", "-c", "import socket,sys,time;s=socket.socket();s.bind(('127.0.0.1',int(sys.argv[1])));s.listen();print('ready',flush=True);time.sleep(180)", str(config.cdp_port)],
                stdout=subprocess.PIPE, text=True, start_new_session=True)
            if process.stdout.readline().strip() != "ready":
                raise RuntimeError("synthetic owned listener failed")
            process.stdout.close()
            directory = Path(config.user_data_dir)
            (directory / "accepted-native-bytes").write_bytes(b"accepted owned native Apply bytes")
            self.processes[config.worker_id] = process
            return BrowserSession(config=config, pid=process.pid, handle=process, worker_dir=str(directory), browser_ws_url=f"ws://127.0.0.1:{config.cdp_port}/devtools/browser/synthetic-{config.worker_id}")

        def cleanup(self, browser):
            self.cleanup_workers((browser.worker_id,))

        def cleanup_workers(self, worker_ids):
            for worker_id in worker_ids:
                process = self.processes.get(worker_id)
                if process is not None:
                    terminate_owned_process(process, launched_pid=process.pid)

        def submit_application(self, *, browser, **_kwargs):
            conn = database.get_connection()
            claim = conn.execute("SELECT job_id,json_extract(payload_json,'$.run_id') FROM job_events "
                "WHERE event_type='ApplyRunStarted' AND json_extract(payload_json,'$.worker_id')=? "
                "ORDER BY event_id DESC LIMIT 1", (browser.worker_id,)).fetchone()
            if claim is None:
                raise RuntimeError("synthetic agent did not join its canonical claim")
            job, run_id = str(claim[0]), str(claim[1])
            controls = config.APP_DIR / "qa-native-controls"
            controls.mkdir(mode=0o700, exist_ok=True)
            evidence = {"job_id": job, "run_id": run_id, "worker_id": browser.worker_id,
                        "port": browser.cdp_port, "pid": browser.pid, "work_dir": browser.worker_dir,
                        "scope_id": os.environ["JOBCTRL_APPLY_EXECUTION_SCOPE"]}
            _publish_ready(controls / f"ready-{job}.json", evidence)
            release = controls / f"release-{job}"
            probe = controls / f"probe-{job}.json"
            deadline = time.monotonic() + 120
            while not release.exists():
                if browser.handle.poll() is not None:
                    raise RuntimeError("synthetic owned cancellation reached only its listener")
                if probe.exists():
                    request = json.loads(probe.read_text())
                    probe.unlink()
                    _publish_ready(controls / f"alive-{job}.json", {
                        "nonce": request["nonce"], "job_id": job, "run_id": run_id,
                        "worker_id": browser.worker_id, "pid": browser.pid,
                        "scope_id": evidence["scope_id"],
                    })
                if time.monotonic() > deadline:
                    raise TimeoutError("native QA did not release controlled external port")
                time.sleep(.01)
            if release.read_text() == "fail":
                raise RuntimeError("synthetic owned failure")
            return AgentResult(submission_result=DryRunComplete(navigated_to="https://example.com/apply"), duration_ms=1)

    ports = Ports()
    adapters.LocalChromeAdapter = lambda: ports
    adapters.ClaudeCodeCliAdapter = lambda: ports
    chrome.cleanup_workers = ports.cleanup_workers
    launcher._load_profile_snapshot = _FakeSnapshot
    network.validate_public_http_url = lambda _url: SimpleNamespace(allowed=True, reason="")
    marker = config.APP_DIR / "qa-batch-worker-crash"
    if marker.is_file():
        mode = marker.read_text()
        calls = 0
        original_acquire = launcher.acquire_job

        def crash_before_claim(**kwargs):
            nonlocal calls
            calls += 1
            if mode == "one_dry_run" and calls == 1:
                job = original_acquire(**kwargs)
                if job is None:
                    raise RuntimeError("synthetic native claim was unavailable")
                return job
            if mode == "after_progress" and calls == 1:
                return {"tenant_id": "local", "job_id": str(uuid.uuid4()), "title": "synthetic"}
            raise RuntimeError("synthetic pre-claim worker crash")

        launcher.acquire_job = crash_before_claim
        if mode in {"after_progress", "one_dry_run"}:
            from jobctrl.domain.apply.value_objects import Applied

            launcher.run_job = lambda *_args, **_kwargs: (
                DryRunComplete(navigated_to="https://example.test/apply") if mode == "one_dry_run"
                else Applied(applied_at="2026-10-28T00:00:00Z", verification_confidence=1.0), 1,
            )
            launcher.mark_result = lambda *_args, **_kwargs: None
