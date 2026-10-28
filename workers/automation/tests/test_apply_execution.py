"""Negative request/result authority tests; actual positive cleanup is native QA."""
from __future__ import annotations


import subprocess
import sys
import time

import pytest

from jobctrl import config
from jobctrl.apply import execution
from jobctrl.apply.ownership import ApplyLauncherCleanupIncomplete
from jobctrl.apply.process_birth import CustodyUnverified


def _options():
    return dict(limit=1, target_job_id=None, tenant_id="local", min_score=7,
                headless=False, model="default", dry_run=True, continuous=False,
                poll_interval=60, workers=1, approval_required=True, workflow_id="synthetic-owned")


@pytest.mark.parametrize("fault", ["extra", "bool_limit", "zero_workers", "wrong_job", "missing"])
def test_execution_request_rejects_structural_authority_changes(fault):
    value = _options()
    if fault == "extra":
        value["executable"] = "/foreign/not-authorized"
    elif fault == "bool_limit":
        value["limit"] = True
    elif fault == "zero_workers":
        value["workers"] = 0
    elif fault == "wrong_job":
        value["target_job_id"] = ["other"]
    else:
        value.pop("workflow_id")
    with pytest.raises(ValueError):
        execution._options(value)


def test_plain_result_and_zero_exit_never_substitute_for_native_completion(tmp_path, monkeypatch):
    app = tmp_path / "app"
    app.mkdir()
    monkeypatch.setattr(config, "APP_DIR", app)
    script = tmp_path / "pretend-native.py"
    script.write_text("""import json,os,sys
from pathlib import Path
r=json.load(sys.stdin)
p=Path(os.environ['JOBCTRL_DIR'])/'apply-invocations'/r['request_id']/'result.json'
p.write_text(json.dumps({'schema':1,'request_id':r['request_id'],'launcher_id':r['launcher_id'],'native_custody':None,'output':[0,0],'error':None}))
p.chmod(0o600)
""")
    monkeypatch.setenv("JOBCTRL_DIR", str(app))
    monkeypatch.setattr(execution, "_native_command", lambda: [sys.executable, str(script)])
    with pytest.raises(ApplyLauncherCleanupIncomplete):
        execution.ScopedApplyExecution().run(_options())


def test_cancel_signals_only_exact_unreaped_controller_and_never_peer(tmp_path):
    controller = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
    peer = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
    owned = execution.ScopedApplyExecution()
    owned._process, owned._launched_pid = controller, controller.pid
    try:
        owned.cancel()
        assert controller.wait(timeout=5) < 0
        assert peer.poll() is None
        owned.cancel()
        assert peer.poll() is None
    finally:
        for process in (controller, peer):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)


def test_missing_native_locator_refuses_before_invocation_or_claim(tmp_path, monkeypatch):
    app = tmp_path / "app"
    app.mkdir()
    monkeypatch.setattr(config, "APP_DIR", app)
    monkeypatch.delenv("JOBCTRL_RUNTIME_HOME", raising=False)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    with pytest.raises(CustodyUnverified):
        execution.ScopedApplyExecution().run(_options())
    assert list(app.iterdir()) == []


def test_cancel_can_signal_controller_while_driver_waits_for_its_exit(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    app = tmp_path / "app"
    app.mkdir()
    marker = tmp_path / "controller-ready"
    monkeypatch.setattr(config, "APP_DIR", app)
    command = [sys.executable, "-c", "import pathlib,sys,time;sys.stdin.read();pathlib.Path(sys.argv[1]).write_text('ready');time.sleep(30)", str(marker)]
    monkeypatch.setattr(execution, "_native_command", lambda: command)
    owned = execution.ScopedApplyExecution()
    with ThreadPoolExecutor(max_workers=2) as executor:
        runner = executor.submit(owned.run, _options())
        cancelling = None
        try:
            deadline = time.monotonic() + 5
            while not marker.exists():
                assert time.monotonic() < deadline
                time.sleep(.01)
            cancelling = executor.submit(owned.cancel)
            cancelling.result(timeout=1)
            with pytest.raises(RuntimeError):
                runner.result(timeout=5)
        finally:
            process = owned._process
            if process is not None and process.returncode is None:
                process.kill()
            if cancelling is not None:
                cancelling.result(timeout=5)
            if not runner.done():
                with pytest.raises(RuntimeError):
                    runner.result(timeout=5)
