"""Actual abrupt owner death retains only that attempt; peers still progress."""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import pytest

from jobctrl import database
from jobctrl.apply import chrome, launcher, ownership
from jobctrl.apply.process_birth import ApplyCustodyJournal, CustodyUnverified, retire_run_custody
from jobctrl.domain.apply.aggregate import ApplyRun
from jobctrl.domain.apply.value_objects import ApplyRunId
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.domain.events.base import create_domain_event
from jobctrl.state import record_job_event, set_stage_state

from .test_apply_launcher_ownership import owned_runtime as owned_runtime, _ControlledPorts, _events
from jobctrl.infrastructure import apply as apply_adapters


_OWNER = r'''
import json,os,subprocess,sys,time
from pathlib import Path
from jobctrl import config
from jobctrl.apply import launcher,ownership
app,job,evidence,phase,control_text=sys.argv[1:]
control_fd=int(control_text)
config.ensure_dirs()
run=ownership.ApplyLauncherRun()
with run.lease():
 run.allocate_workers(1)
 ctx={'run_id':'old-'+run.identity,'dry_run':True,'launcher_run':run}
 assert launcher.acquire_job(target_job_id=job,run_ctx=ctx,approval_required=False)
 wid=run.worker_ids[0]
 directory=config.APPLY_WORKER_DIR/f'worker-{wid}'
 sentinel=directory/'accepted.txt'; sentinel.write_bytes(b'accepted owner bytes')
 lease_fd=run._journal.owner_descriptor
 lease_info=os.fstat(lease_fd)
 fd_probe=subprocess.run([sys.executable,'-c',"import os,sys;fd,dev,ino=map(int,sys.argv[1:]);\ntry: s=os.fstat(fd);print('inherited' if (s.st_dev,s.st_ino)==(dev,ino) else 'closed')\nexcept OSError: print('closed')",str(lease_fd),str(lease_info.st_dev),str(lease_info.st_ino)],capture_output=True,text=True,timeout=5,close_fds=False)
 assert fd_probe.stdout.strip()=='closed'
 data={'lease_inherited':False,'launcher_id':run.identity,'run_id':ctx['run_id'],'worker_id':wid,'journal':str(run._journal.path),'sentinel':str(sentinel)}
 Path(evidence).write_text(json.dumps(data))
 if phase=='before_spawn':
  run._journal.reserve(wid,'browser')
  os._exit(71)
 child_code="import pathlib,sys,os; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); os.read(int(sys.argv[2]),1) if sys.argv[3]!='root_exited' else None; pathlib.Path(sys.argv[1]+'.exited').write_text('joined')"
 command=[sys.executable,'-u','-c',child_code,evidence+'.child',str(control_fd),phase]
 original=ownership.subprocess.Popen
 if phase=='publication_gap':
  def interrupted(*a,**kw):
   proc=original(*a,**kw)
   while not Path(evidence+'.child').exists(): time.sleep(.01)
   os._exit(71)
  ownership.subprocess.Popen=interrupted
 proc=run.spawn(wid,'browser',command,start_new_session=True,pass_fds=(control_fd,))
 while not Path(evidence+'.child').exists(): time.sleep(.01)
 if phase=='root_exited':
  proc.wait(timeout=5)
 os._exit(71)
'''


def _wait(path):
    deadline = time.monotonic() + 10
    while not path.exists():
        assert time.monotonic() < deadline
        time.sleep(.01)
    return path.read_text()


@pytest.mark.parametrize("phase", ["before_spawn", "publication_gap", "registered", "root_exited"])
def test_ended_source_owner_allows_best_effort_retry_and_distinct_successor(owned_runtime, monkeypatch, tmp_path, phase):
    app, first, second = owned_runtime
    evidence = tmp_path / "owner.json"
    control_read, control_write = os.pipe()
    owner = subprocess.Popen([sys.executable, "-c", _OWNER, str(app), str(first), str(evidence), phase, str(control_read)],
        env={**os.environ, "JOBCTRL_DIR": str(app)}, start_new_session=True, pass_fds=(control_read,))
    os.close(control_read)
    child_pid = None
    ports = _ControlledPorts()
    try:
        assert owner.wait(timeout=15) == 71
        data = json.loads(_wait(evidence))
        assert data["lease_inherited"] is False
        journal = Path(data["journal"])
        before = journal.read_bytes()
        sentinel = Path(data["sentinel"])
        child_path = Path(str(evidence) + ".child")
        if child_path.exists():
            child_pid = int(child_path.read_text())
        # Even a root that already exited is not positive escaped-tree proof.
        with pytest.raises(CustodyUnverified):
            retire_run_custody(app, data["launcher_id"])
        assert journal.read_bytes() == before
        conn = database.get_connection()
        ports.release.set()
        monkeypatch.setattr(apply_adapters, "LocalChromeAdapter", lambda: ports)
        monkeypatch.setattr(apply_adapters, "ClaudeCodeCliAdapter", lambda: ports)
        monkeypatch.setattr(chrome, "cleanup_workers", ports.cleanup_workers)
        retry = ownership.ApplyLauncherRun()
        # Ordinary untargeted restart discovers the old running row and
        # records honest best-effort recovery after its lifetime lease ended.
        assert launcher.main(limit=1, dry_run=True, launcher_run=retry, install_signal_handlers=False) == (0, 0)
        assert any(kind == "DryRunCompleted" for kind, _ in _events(conn, first))
        recovered = [json.loads(payload) for kind, payload in _events(conn, first) if kind == "ApplyClaimSettled"]
        assert any(row.get("owner_lifetime_released") and row["full_tree_verified"] is False for row in recovered)
        accepted = _events(conn, first)
        launcher.mark_result(first, "applied", task_id=data["run_id"], run_ctx={"run_id": data["run_id"]})
        assert _events(conn, first) == accepted
        successor = ownership.ApplyLauncherRun()
        assert launcher.main(target_job_id=second, dry_run=True, launcher_run=successor,
                             install_signal_handlers=False) == (0, 0)
        assert any(kind == "DryRunCompleted" for kind, _ in _events(conn, second))
        assert data["worker_id"] not in successor.worker_ids
        assert sentinel.read_bytes() == b"accepted owner bytes"
        assert journal.read_bytes() == before
        if child_pid and phase != "root_exited":
            os.kill(child_pid, 0)
    finally:
        ports.close()
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=5)
        # The test retained a private control-pipe handle to this exact child.
        # Ask it to exit through that handle; no orphan numeric PID is signalled.
        try:
            os.write(control_write, b"x")
        except BrokenPipeError:
            pass
        finally:
            os.close(control_write)
        if child_pid is not None:
            _wait(Path(str(evidence) + ".child.exited"))
            from jobctrl.infrastructure.process_ownership import verify_session_exit, ProcessOwnershipError
            deadline = time.monotonic() + 10
            while True:
                try:
                    verify_session_exit(child_pid)
                    break
                except ProcessOwnershipError:
                    assert time.monotonic() < deadline, "owned synthetic child did not finish after its control pipe closed"


def test_synchronous_failed_spawn_durably_aborts_only_its_intent(owned_runtime, monkeypatch):
    app, _, _ = owned_runtime
    run = ownership.ApplyLauncherRun()
    def fail(*_args, **_kwargs):
        raise OSError(errno.EAGAIN, "controlled no-created-child spawn failure")
    monkeypatch.setattr(ownership.subprocess, "Popen", fail)
    with run.lease():
        run.allocate_workers(1)
        with pytest.raises(OSError):
            run.spawn(run.worker_ids[0], "browser", [sys.executable, "-c", "pass"])
        assert run._journal.value["births"] == []
        assert json.loads(run._journal.path.read_text())["births"] == []
    assert not list((app / "apply-runs").glob("*/custody.json"))


def test_old_run_cannot_publish_result_aggregate_artifacts_release_or_bus_event(owned_runtime):
    _, first, second = owned_runtime
    conn = database.get_connection()
    old, current = "old-" + uuid.uuid4().hex, "new-" + uuid.uuid4().hex
    for run_id in (old, current):
        record_job_event(conn, first, "apply", "ApplyClaimAcquired", tenant_id="local", payload={"run_id": run_id})
        record_job_event(conn, first, "apply", "ApplyRunStarted", tenant_id="local", payload={"run_id": run_id})
    set_stage_state(conn, first, "apply", "running", tenant_id="local", validate_transition=False)
    conn.commit()
    accepted = _events(conn, first)
    artifacts = [tuple(row) for row in conn.execute("SELECT * FROM job_artifacts")]
    launcher.mark_result(first, "applied", task_id=old, run_ctx={"run_id": old})
    launcher.release_lock(first, run_ctx={"run_id": old})
    aggregate = ApplyRun.start(tenant_id=TenantId("local"), job_id=canonical_job_id(str(first)),
                              run_id=ApplyRunId(old), started_at="2026-10-27T00:00:00Z")
    with pytest.raises(launcher.ApplyOwnershipLost):
        launcher.SqliteApplyRunRepository().save(aggregate.record_event(event_type="AgentFinished",
            occurred_at="2026-10-27T00:00:01Z", payload={"log_path": "/unowned/must-not-persist"}))
    emitted = []
    class Sink:
        def publish(self, event):
            emitted.append(event)
    bus = launcher._OwnedApplyPublisher(Sink())
    with pytest.raises(launcher.ApplyOwnershipLost):
        bus.publish(create_domain_event("ApplicationSubmitted", TenantId("local"), {"run_id": old, "job_id": str(first)}))
    with pytest.raises(launcher.ApplyOwnershipLost):
        bus.publish(create_domain_event("ApplyRunStarted", TenantId("local"), {"run_id": current, "job_id": str(second)}))
    assert emitted == []
    assert _events(conn, first) == accepted
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_artifacts")] == artifacts
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "running"
    launcher.mark_result(first, "failed", "controlled current outcome", task_id=current, run_ctx={"run_id": current})
    terminal = _events(conn, first)
    launcher.mark_result(first, "applied", task_id=old, run_ctx={"run_id": old})
    assert _events(conn, first) == terminal


@pytest.mark.parametrize("fault", ["symlink", "wrong_run", "malformed", "hardlink"])
def test_damaged_exact_custody_refuses_without_modification(owned_runtime, tmp_path, fault):
    app, first, _ = owned_runtime
    run = ownership.ApplyLauncherRun()
    with run.lease():
        run.claim("local", str(first), "synthetic-old-run")
    path = run._journal.path
    if fault == "wrong_run":
        value = json.loads(path.read_text())
        value["run_id"] = uuid.uuid4().hex
        path.write_text(json.dumps(value))
    elif fault == "malformed":
        path.write_text("not json")
    elif fault == "symlink":
        foreign = tmp_path / "foreign"
        path.rename(foreign)
        path.symlink_to(foreign)
    else:
        os.link(path, tmp_path / "retained-hardlink")
    before = path.read_bytes()
    with pytest.raises((CustodyUnverified, ValueError)):
        journal = ApplyCustodyJournal(app, run.identity)
        journal.load()
    assert path.read_bytes() == before
