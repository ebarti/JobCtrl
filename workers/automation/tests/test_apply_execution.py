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
from .test_apply_launcher_ownership import owned_runtime as owned_runtime


def _options():
    return dict(limit=1, target_job_id=None, tenant_id="local", min_score=7,
                headless=False, model="default", dry_run=True, continuous=False,
                poll_interval=60, workers=1, approval_required=True, workflow_id="synthetic-owned")


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize(
    ("completion_verified", "tamper"),
    [(False, None), (True, None), (True, "missing"), (True, "pending"),
     (True, "foreign_id"), (True, "foreign_binding"), (True, "symlink"), (True, "wrong_counts")],
)
def test_native_terminal_metric_waits_for_completion(
    owned_runtime, monkeypatch, tmp_path, dry_run, completion_verified, tamper,
):
    """A synthetic controller runs the real child and launcher; only attestation is injected."""
    import json
    from jobctrl import database

    app, _, _ = owned_runtime
    script = tmp_path / "synthetic-native-controller.py"
    script.write_text('''
import os
from pathlib import Path
from jobctrl.apply import chrome, execution, launcher
from jobctrl import browser_capabilities
class NoLive:
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def update(self, *args): pass
launcher.Live = NoLive
launcher._load_profile_snapshot = lambda: object()
launcher.acquire_job = lambda **kwargs: None
chrome.cleanup_workers = lambda *args, **kwargs: None
browser_capabilities.require_system_browser_capability = lambda name: Path('/synthetic/browser')
scope = 'b' * 32
os.environ['JOBCTRL_APPLY_EXECUTION_SCOPE'] = scope
execution.capture_native_custody = lambda _app: {'scope': {'id': scope, 'purpose': 'apply'}}
execution.main()
''')
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    monkeypatch.setattr(execution, "_native_command", lambda: [sys.executable, str(script)])
    scoped = execution.ScopedApplyExecution()
    run_id = f"apply:{scoped.identity}"
    at_verification = []

    def verify(binding, _root):
        rows = database.get_connection().execute(
            "SELECT outcome FROM operational_attempt_metrics WHERE stage='apply' AND attempt_kind='apply_batch' "
            "AND run_id=? ORDER BY metric_id", (run_id,),
        ).fetchall()
        at_verification.extend(row["outcome"] for row in rows)
        path = app / "apply-invocations" / scoped.identity / "terminal-metric.json"
        assert path.stat().st_mode & 0o077 == 0
        value = json.loads(path.read_text())
        assert value["request_id"] == scoped.identity and value["native_custody"] == binding
        assert set(value) == {"schema", "request_id", "native_custody", "state", "outcome", "duration_ms", "counts", "error_class"}
        if not completion_verified:
            raise CustodyUnverified("synthetic native completion refusal")
        if tamper:
            if tamper == "missing":
                path.unlink()
            elif tamper == "symlink":
                foreign = tmp_path / "foreign-metric.json"
                foreign.write_text(json.dumps(value))
                path.unlink()
                path.symlink_to(foreign)
            else:
                if tamper == "pending":
                    value = {key: value[key] for key in ("schema", "request_id", "native_custody")}
                    value["state"] = "pending"
                elif tamper == "foreign_id":
                    value["request_id"] = "a" * 32
                elif tamper == "foreign_binding":
                    value["native_custody"] = {"scope": {"id": "c" * 32, "purpose": "apply"}}
                else:
                    value["counts"]["applied"] = 7
                path.write_text(json.dumps(value))

    monkeypatch.setattr(execution, "verify_native_completion", verify)
    options = _options() | {"dry_run": dry_run}
    if completion_verified:
        assert scoped.run(options) == (0, 0)
    else:
        with pytest.raises(ApplyLauncherCleanupIncomplete) as caught:
            scoped.run(options)
        assert not hasattr(caught.value, "counts")

    assert at_verification == ["started"]
    rows = database.get_connection().execute(
        "SELECT outcome, total_count, metadata_json FROM operational_attempt_metrics "
        "WHERE stage='apply' AND attempt_kind='apply_batch' AND run_id=? ORDER BY metric_id", (run_id,),
    ).fetchall()
    expected = ["started"] if tamper else [
        "started", ("dry_run" if dry_run else "succeeded") if completion_verified else "failed",
    ]
    assert [row["outcome"] for row in rows] == expected
    if tamper:
        return
    metadata = json.loads(rows[-1]["metadata_json"])
    if completion_verified:
        assert (rows[-1]["total_count"], metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"]) == (0, 0, 0, 0)
    else:
        assert rows[-1]["total_count"] is None
        assert metadata["countsKnown"] is False
        assert (metadata["applied"], metadata["failedJobs"], metadata["workerCrashes"]) == (None, None, None)


@pytest.mark.parametrize("crash", [False, True])
@pytest.mark.parametrize("completion_verified", [False, True])
def test_legacy_child_keeps_its_single_terminal_metric(owned_runtime, monkeypatch, tmp_path, crash, completion_verified):
    """A legacy child keeps its original metric even when later verification is refused."""
    from jobctrl import database
    from jobctrl.apply.batch_outcome import ApplyBatchWorkersCrashed

    app, _, _ = owned_runtime
    script = tmp_path / "legacy-native-controller.py"
    script.write_text(f'''
import json, os, sys
from pathlib import Path
from jobctrl import browser_capabilities
from jobctrl.apply import chrome, launcher, ownership
from jobctrl.apply.batch_outcome import ApplyBatchWorkersCrashed
class NoLive:
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def update(self, *args): pass
launcher.Live = NoLive
launcher._load_profile_snapshot = lambda: object()
chrome.cleanup_workers = lambda *args, **kwargs: None
browser_capabilities.require_system_browser_capability = lambda name: Path('/synthetic/browser')
def acquire(**kwargs):
    if {crash!r}: raise RuntimeError('synthetic pre-claim crash')
    return None
launcher.acquire_job = acquire
request = json.load(sys.stdin)
value = {{'schema': 1, 'request_id': request['request_id'], 'launcher_id': request['launcher_id'],
          'native_custody': {{'scope': {{'id': 'b' * 32, 'purpose': 'apply'}}}}, 'output': None, 'error': None}}
code = 0
try:
    value['output'] = list(launcher.main(**request['options'], install_signal_handlers=False,
                                        launcher_run=ownership.ApplyLauncherRun(identity=request['launcher_id'])))
except ApplyBatchWorkersCrashed as exc:
    value['error'] = {{'code': 'apply_worker_crashed', 'counts': exc.counts.to_dict()}}
    code = 1
path = Path(os.environ['JOBCTRL_DIR']) / 'apply-invocations' / request['request_id'] / 'result.json'
path.write_text(json.dumps(value)); path.chmod(0o600)
sys.exit(code)
''')
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    monkeypatch.setattr(execution, "_native_command", lambda: [sys.executable, str(script)])
    def verify(_binding, _root):
        if not completion_verified:
            raise CustodyUnverified("synthetic legacy completion refusal")

    monkeypatch.setattr(execution, "verify_native_completion", verify)
    scoped = execution.ScopedApplyExecution()
    options = _options() | {"dry_run": False}
    if not completion_verified:
        with pytest.raises(ApplyLauncherCleanupIncomplete):
            scoped.run(options)
    elif crash:
        with pytest.raises(ApplyBatchWorkersCrashed) as caught:
            scoped.run(options)
        assert caught.value.counts.to_dict() == {"applied": 0, "failed": 0, "worker_crashes": 1}
    else:
        assert scoped.run(options) == (0, 0)
    rows = database.get_connection().execute(
        "SELECT outcome FROM operational_attempt_metrics WHERE stage='apply' AND attempt_kind='apply_batch' "
        "AND run_id=? ORDER BY metric_id", (f"apply:{scoped.identity}",),
    ).fetchall()
    assert [row["outcome"] for row in rows] == ["started", "failed" if crash else "succeeded"]
    marker = execution._read(app / "apply-invocations" / scoped.identity / "terminal-metric.json")
    assert marker == {"schema": 1, "request_id": scoped.identity, "state": "requested"}


def test_direct_source_launcher_still_publishes_one_terminal_metric(owned_runtime, monkeypatch):
    from jobctrl import database
    from jobctrl.apply import launcher, ownership

    monkeypatch.setattr(launcher, "acquire_job", lambda **_kwargs: None)
    run = ownership.ApplyLauncherRun()
    assert launcher.main(limit=1, workers=1, dry_run=False, install_signal_handlers=False, launcher_run=run) == (0, 0)
    rows = database.get_connection().execute(
        "SELECT outcome FROM operational_attempt_metrics WHERE stage='apply' AND attempt_kind='apply_batch' "
        "AND run_id=? ORDER BY metric_id", (f"apply:{run.identity}",),
    ).fetchall()
    assert [row["outcome"] for row in rows] == ["started", "succeeded"]


def test_new_native_child_without_request_preserves_legacy_metric(owned_runtime, monkeypatch):
    import io
    import json
    from types import SimpleNamespace
    from jobctrl import database
    from jobctrl.apply import launcher

    app, _, _ = owned_runtime
    request_id, scope_id = "a" * 32, "b" * 32
    directory = app / "apply-invocations" / request_id
    directory.parent.mkdir(mode=0o700)
    directory.mkdir(mode=0o700)
    monkeypatch.setenv("JOBCTRL_APPLY_EXECUTION_SCOPE", scope_id)
    monkeypatch.setattr(execution, "capture_native_custody", lambda _app: {"scope": {"id": scope_id, "purpose": "apply"}})
    request = {"schema": 1, "request_id": request_id, "launcher_id": request_id, "options": _options() | {"dry_run": False}}
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode())))
    monkeypatch.setattr(launcher, "acquire_job", lambda **_kwargs: None)
    execution.main()

    rows = database.get_connection().execute(
        "SELECT outcome FROM operational_attempt_metrics WHERE stage='apply' AND attempt_kind='apply_batch' "
        "AND run_id=? ORDER BY metric_id", (f"apply:{request_id}",),
    ).fetchall()
    assert [row["outcome"] for row in rows] == ["started", "succeeded"]
    assert not (directory / "terminal-metric.json").exists()
    result = execution._read(directory / "result.json")
    assert set(result) == {"schema", "request_id", "launcher_id", "native_custody", "output", "error"}
    assert result["output"] == [0, 0] and result["error"] is None


@pytest.mark.parametrize("fault", ["foreign_id", "boolean_schema", "symlink"])
def test_native_child_refuses_invalid_metric_request_before_launch(owned_runtime, monkeypatch, tmp_path, fault):
    import io
    import json
    from types import SimpleNamespace
    from jobctrl.apply import launcher

    app, _, _ = owned_runtime
    request_id, scope_id = "a" * 32, "b" * 32
    directory = app / "apply-invocations" / request_id
    directory.parent.mkdir(mode=0o700)
    directory.mkdir(mode=0o700)
    marker = directory / "terminal-metric.json"
    value = {"schema": True if fault == "boolean_schema" else 1,
             "request_id": "c" * 32 if fault == "foreign_id" else request_id, "state": "requested"}
    if fault == "symlink":
        foreign = tmp_path / "foreign.json"
        foreign.write_text(json.dumps(value))
        marker.symlink_to(foreign)
    else:
        execution._write(marker, value)
    monkeypatch.setenv("JOBCTRL_APPLY_EXECUTION_SCOPE", scope_id)
    monkeypatch.setattr(execution, "capture_native_custody", lambda _app: {"scope": {"id": scope_id, "purpose": "apply"}})
    request = {"schema": 1, "request_id": request_id, "launcher_id": request_id, "options": _options()}
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode())))
    launched = []
    monkeypatch.setattr(launcher, "main", lambda **_kwargs: launched.append(True))
    with pytest.raises(CustodyUnverified):
        execution.main()
    assert launched == []


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


@pytest.mark.parametrize(
    ("error", "exit_code", "expected"),
    [
        (None, 0, "legacy"),
        ("ApplyLauncherCleanupIncomplete", 1, "legacy_cleanup"),
        ("ApplyLauncherBusy", 1, "legacy_busy"),
        ({"code": "apply_worker_crashed", "counts": {"applied": 2, "failed": 1, "worker_crashes": 1}}, 1, "crash"),
        ({"code": "apply_launcher_cleanup_incomplete", "counts": {"applied": 2, "failed": 1, "worker_crashes": 1}}, 1, "cleanup"),
        ({"code": "apply_worker_crashed", "counts": {"applied": 0, "failed": 0, "worker_crashes": True}}, 1, "invalid"),
        ({"code": "apply_worker_crashed", "counts": {"applied": 0, "failed": 0, "worker_crashes": 1}}, 0, "invalid"),
        ({"code": "unknown", "counts": {"applied": 0, "failed": 0, "worker_crashes": 0}}, 1, "invalid"),
    ],
)
def test_native_result_decodes_legacy_and_structured_failures_after_completion(
    tmp_path, monkeypatch, error, exit_code, expected,
):
    """Parser isolation only; the native integration tests prove actual authority."""
    import json
    from jobctrl.apply.batch_outcome import ApplyBatchCleanupIncomplete, ApplyBatchWorkersCrashed
    from jobctrl.apply.ownership import ApplyLauncherBusy

    app = tmp_path / "app"
    app.mkdir()
    monkeypatch.setattr(config, "APP_DIR", app)
    monkeypatch.setenv("JOBCTRL_DIR", str(app))
    script = tmp_path / "synthetic_controller.py"
    script.write_text(
        "import json,os,sys\n"
        "from pathlib import Path\n"
        "request=json.load(sys.stdin)\n"
        f"error=json.loads({json.dumps(json.dumps(error))})\n"
        "result={'schema':1,'request_id':request['request_id'],'launcher_id':request['launcher_id'],"
        "'native_custody':None,'output':[2,1] if error is None else None,'error':error}\n"
        "path=Path(os.environ['JOBCTRL_DIR'])/'apply-invocations'/request['request_id']/'result.json'\n"
        "path.write_text(json.dumps(result))\n"
        "path.chmod(0o600)\n"
        f"sys.exit({exit_code})\n"
    )
    monkeypatch.setattr(execution, "_native_command", lambda: [sys.executable, str(script)])
    verified = []
    monkeypatch.setattr(execution, "verify_native_completion", lambda binding, root: verified.append((binding, root)))
    scoped = execution.ScopedApplyExecution()
    if expected == "legacy":
        assert scoped.run(_options()) == (2, 1)
    else:
        error_type = {"crash": ApplyBatchWorkersCrashed, "cleanup": ApplyBatchCleanupIncomplete,
                      "legacy_cleanup": ApplyLauncherCleanupIncomplete, "legacy_busy": ApplyLauncherBusy,
                      "invalid": ValueError}[expected]
        with pytest.raises(error_type) as caught:
            scoped.run(_options())
        if expected in {"crash", "cleanup"}:
            assert caught.value.counts.to_dict() == {"applied": 2, "failed": 1, "worker_crashes": 1}
        elif expected in {"legacy_cleanup", "legacy_busy"}:
            assert not hasattr(caught.value, "counts")
    assert verified == [(None, app.resolve())]


@pytest.mark.parametrize("exit_code", [1, 211])
def test_structured_counts_cannot_bypass_missing_native_completion(tmp_path, monkeypatch, exit_code):
    app = tmp_path / "app"
    app.mkdir()
    monkeypatch.setattr(config, "APP_DIR", app)
    monkeypatch.setenv("JOBCTRL_DIR", str(app))
    script = tmp_path / "unverified_controller.py"
    script.write_text(
        "import json,os,sys\n"
        "from pathlib import Path\n"
        "request=json.load(sys.stdin)\n"
        "result={'schema':1,'request_id':request['request_id'],'launcher_id':request['launcher_id'],"
        "'native_custody':None,'output':None,'error':{'code':'apply_worker_crashed',"
        "'counts':{'applied':7,'failed':0,'worker_crashes':1}}}\n"
        "path=Path(os.environ['JOBCTRL_DIR'])/'apply-invocations'/request['request_id']/'result.json'\n"
        "path.write_text(json.dumps(result))\n"
        "path.chmod(0o600)\n"
        f"sys.exit({exit_code})\n"
    )
    monkeypatch.setattr(execution, "_native_command", lambda: [sys.executable, str(script)])
    with pytest.raises(ApplyLauncherCleanupIncomplete) as caught:
        execution.ScopedApplyExecution().run(_options())
    assert not hasattr(caught.value, "counts")
    assert "cleanup remains unverified" in str(caught.value)


@pytest.mark.parametrize("kind", ["crash", "cleanup"])
def test_native_module_publishes_structured_failure_counts(tmp_path, monkeypatch, kind):
    import io
    import json
    from types import SimpleNamespace

    from jobctrl.apply import launcher
    from jobctrl.apply.batch_outcome import ApplyBatchCleanupIncomplete, ApplyBatchCounts, ApplyBatchWorkersCrashed

    app = tmp_path / "app"
    request_id = "a" * 32
    scope_id = "b" * 32
    directory = app / "apply-invocations" / request_id
    app.mkdir(mode=0o700)
    directory.parent.mkdir(mode=0o700)
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(config, "APP_DIR", app)
    monkeypatch.setenv("JOBCTRL_APPLY_EXECUTION_SCOPE", scope_id)
    monkeypatch.setattr(execution, "capture_native_custody", lambda _app: {"scope": {"id": scope_id, "purpose": "apply"}})
    request = {"schema": 1, "request_id": request_id, "launcher_id": request_id, "options": _options()}
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode())))
    counts = ApplyBatchCounts(2, 1, 1)
    failure = ApplyBatchWorkersCrashed(counts) if kind == "crash" else ApplyBatchCleanupIncomplete("cleanup", counts)
    monkeypatch.setattr(launcher, "main", lambda **_kwargs: (_ for _ in ()).throw(failure))
    with pytest.raises(type(failure)):
        execution.main()
    result = execution._read(directory / "result.json")
    assert set(result) == {"schema", "request_id", "launcher_id", "native_custody", "output", "error"}
    assert result["output"] is None
    assert result["error"] == {
        "code": "apply_worker_crashed" if kind == "crash" else "apply_launcher_cleanup_incomplete",
        "counts": counts.to_dict(),
    }
