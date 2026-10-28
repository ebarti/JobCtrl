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
import time
from types import SimpleNamespace


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
    from tests.test_apply_use_cases import _FakeSnapshot

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
            deadline = time.monotonic() + 120
            while not release.exists():
                if browser.handle.poll() is not None:
                    raise RuntimeError("synthetic owned cancellation reached only its listener")
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
