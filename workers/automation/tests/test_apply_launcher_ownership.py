"""Real Temporal Apply admission, cancellation, crash and successor ownership.

Only browser/agent/network ports are controlled. Claims, saga, canonical event
writes, workflow retries and history replay retain their production paths.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

from .apply_execution_fixture import in_process_apply_execution as in_process_apply_execution

import pytest
from temporalio import activity
from temporalio.worker import ActivityInboundInterceptor, Interceptor, Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl import browser_capabilities, config, database
from jobctrl.apply import chrome, launcher, ownership
from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow, ApplyWorkflowInput
from jobctrl.domain.apply.value_objects import DryRunComplete
from jobctrl.domain.ports.apply import AgentResult, BrowserSession
from jobctrl.infrastructure import apply as apply_adapters
from jobctrl.infrastructure.temporal import run_in_activity
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.llm import check_spend_budget

from .temporal_env import local_env
from .test_apply_batch_limits import _NoLive
from .test_apply_regressions import _insert_ready_job
from .test_apply_use_cases import _FakeSnapshot


@pytest.fixture
def owned_runtime(tmp_path, monkeypatch):
    app = tmp_path / "workspace"
    app.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("JOBCTRL_DIR", str(app))
    for name, relative in {
        "APP_DIR": ".", "DB_PATH": "jobctrl.db", "LOG_DIR": "logs",
        "APPLY_WORKER_DIR": "apply-workers", "CHROME_WORKER_DIR": "chrome-workers",
        "TAILORED_DIR": "tailored_resumes", "COVER_LETTER_DIR": "cover_letters",
    }.items():
        monkeypatch.setattr(config, name, app / relative)
    monkeypatch.setattr(database, "DB_PATH", config.DB_PATH)
    config.ensure_dirs()
    conn = database.init_db()
    first = _insert_ready_job(conn, url="https://example.com/first")
    second = _insert_ready_job(conn, url="https://example.com/second")
    monkeypatch.setattr(browser_capabilities, "require_system_browser_capability", lambda _name: Path("/synthetic/browser"))
    monkeypatch.setattr(launcher, "_load_profile_snapshot", _FakeSnapshot)
    monkeypatch.setattr(launcher, "Live", _NoLive)
    # The URL transport belongs to the controlled external boundary. No DNS or
    # external request is required to exercise the production Apply owner.
    from jobctrl.infrastructure import network
    from types import SimpleNamespace
    monkeypatch.setattr(network, "validate_public_http_url", lambda _url: SimpleNamespace(allowed=True, reason=""))
    yield app, first, second
    database.close_connection(config.DB_PATH)


class _ControlledPorts:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.failure = False
        self.ignore_cancel = False
        self.processes = {}
        self.sessions = []
        self.files = []
        self.cleanup_ids = []
        self.guard = threading.Lock()

    def launch(self, config):
        # An actual isolated loopback listener proves cleanup cannot silently
        # signal a peer process. It has no browser account or external I/O.
        proc = ownership.spawn_owned_apply_process(
            config.worker_id, "browser", [sys.executable, "-u", "-c", "import socket,sys,time; s=socket.socket(); s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(); print('ready',flush=True); time.sleep(90)", str(config.cdp_port)],
            stdout=subprocess.PIPE, text=True, start_new_session=os.name != "nt",
        )
        assert proc.stdout.readline().strip() == "ready"
        proc.stdout.close()
        directory = Path(config.user_data_dir)
        sentinel = directory / "owned-result.txt"
        sentinel.write_text("accepted synthetic bytes", encoding="utf-8")
        session = BrowserSession(config=config, pid=proc.pid, handle=proc, worker_dir=str(directory), browser_ws_url=f"ws://127.0.0.1:{config.cdp_port}/devtools/browser/synthetic-{config.worker_id}")
        with self.guard:
            self.processes[config.worker_id] = proc
            self.sessions.append(session)
            self.files.append(sentinel)
        return session

    def cleanup(self, session):
        self.cleanup_workers((session.worker_id,))

    def cleanup_workers(self, worker_ids):
        with self.guard:
            self.cleanup_ids.extend(worker_ids)
            processes = [self.processes[wid] for wid in worker_ids if wid in self.processes]
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=5)

    def submit_application(self, *, browser, **kwargs):
        self.started.set()
        deadline = time.monotonic() + 40
        while not self.release.wait(0.01):
            if not self.ignore_cancel and browser.handle.poll() is not None:
                raise RuntimeError("controlled cancellation reached owned browser")
            if time.monotonic() > deadline:
                raise TimeoutError("synthetic agent did not receive test release")
        if self.failure:
            raise RuntimeError("controlled agent failure")
        return AgentResult(submission_result=DryRunComplete(navigated_to="https://example.com/apply"), duration_ms=1)

    def close(self):
        self.release.set()
        self.cleanup_workers(tuple(self.processes))


def _events(conn, job_id):
    return [tuple(row) for row in conn.execute(
        "SELECT event_type, payload_json FROM job_events WHERE job_id=? ORDER BY event_id", (job_id,)
    )]


async def _event(event):
    assert await asyncio.to_thread(event.wait, 15), "owned launcher did not reach controlled agent"


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal", ["complete", "fail", "cancel", "abandon"])
async def test_real_temporal_overlapping_peer_and_replay(owned_runtime, monkeypatch, terminal):
    app, first, second = owned_runtime
    ports = _ControlledPorts()
    releases, entered = {}, {}
    owner_id, runs = [], []
    run_type = ownership.ApplyLauncherRun
    def new_run():
        run = run_type()
        runs.append(run)
        return run
    def submit(*, browser, **kwargs):
        wid = browser.worker_id
        release = releases.setdefault(wid, threading.Event())
        entered.setdefault(wid, threading.Event()).set()
        deadline = time.monotonic() + 40
        while not release.wait(.01):
            if wid == owner_id[0] and terminal != "abandon" and browser.handle.poll() is not None:
                raise RuntimeError("controlled owned cancellation")
            assert time.monotonic() < deadline
        if wid == owner_id[0] and terminal == "fail":
            raise RuntimeError("controlled owner failure")
        return AgentResult(submission_result=DryRunComplete(navigated_to="https://example.com/apply"), duration_ms=1)
    original_launch = ports.launch
    def launch(config):
        session = original_launch(config)
        if not owner_id:
            owner_id.append(config.worker_id)
        return session
    ports.launch = launch
    ports.submit_application = submit
    monkeypatch.setattr(ownership, "ApplyLauncherRun", new_run)
    monkeypatch.setattr(apply_adapters, "LocalChromeAdapter", lambda: ports)
    monkeypatch.setattr(apply_adapters, "ClaudeCodeCliAdapter", lambda: ports)
    monkeypatch.setattr(chrome, "cleanup_workers", ports.cleanup_workers)
    original_helper = run_in_activity.run_blocking_with_heartbeat
    async def responsive(fn, **kwargs):
        return await original_helper(fn, **{**kwargs, "poll_interval": .05, "cancel_wait_seconds": .02 if terminal == "abandon" else 2})
    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", responsive)
    executor = ThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(executor)
    queue = f"apply-owned-{uuid.uuid4()}"
    histories = []
    async def wait_sessions(count):
        deadline = asyncio.get_running_loop().time() + 15
        while len(entered) < count:
            assert asyncio.get_running_loop().time() < deadline
            await asyncio.sleep(.01)
    try:
        async with local_env() as env:
            async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow],
                    activities=[apply_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                    workflow_runner=UnsandboxedWorkflowRunner(), max_concurrent_activities=2,
                    max_heartbeat_throttle_interval=timedelta(milliseconds=20)):
                def payload(job):
                    return ApplyWorkflowInput(tenant_id="local", job_id=job, dry_run=True,
                        expected_app_dir=str(app), expected_db_path=str(config.DB_PATH))
                owner = await env.client.start_workflow(ApplyWorkflow.run, payload(first), id=f"owner-{uuid.uuid4()}", task_queue=queue)
                await wait_sessions(1)
                peer = await env.client.start_workflow(ApplyWorkflow.run, payload(second), id=f"peer-{uuid.uuid4()}", task_queue=queue)
                await wait_sessions(2)
                first_run, peer_run = runs
                owner_session, peer_session = ports.sessions
                conn = database.get_connection()
                peer_events = _events(conn, second)
                peer_stage = tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (second,)).fetchone())
                peer_file = ports.files[1]
                assert first_run.worker_ids != peer_run.worker_ids
                assert owner_session.config.cdp_port != peer_session.config.cdp_port
                if terminal in {"cancel", "abandon"}:
                    await owner.cancel()
                    assert not (await asyncio.wait_for(owner.result(), 15)).ok
                    await _event(first_run.stop_event)
                else:
                    releases[owner_session.worker_id].set()
                    assert (await asyncio.wait_for(owner.result(), 15)).ok is (terminal == "complete")
                first_run.request_stop()
                assert peer_session.handle.poll() is None
                assert not peer_run.stop_event.is_set()
                assert peer_file.read_bytes() == b"accepted synthetic bytes"
                assert _events(conn, second) == peer_events
                assert tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (second,)).fetchone()) == peer_stage
                assert ports.files[0] != peer_file
                if terminal == "abandon":
                    assert not releases[owner_session.worker_id].is_set()
                    releases[owner_session.worker_id].set()
                releases[peer_session.worker_id].set()
                assert (await asyncio.wait_for(peer.result(), 15)).ok
                accepted = _events(conn, second)
                first_run.cancel()
                assert _events(conn, second) == accepted
                assert any(kind == "DryRunCompleted" for kind, _ in accepted)
                histories = [await owner.fetch_history(), await peer.fetch_history()]
            await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflows(
                _history_iterator(histories), raise_on_replay_failure=True)
    finally:
        for release in releases.values():
            release.set()
        ports.close()
        run_in_activity.shutdown_activity_executors()
        executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.asyncio
async def test_real_temporal_dry_run_retry_preserves_successor_and_peer(owned_runtime, monkeypatch, tmp_path):
    """An injected post-result activity exception models acknowledgment loss on retry."""
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    app, first, second = owned_runtime
    ports = _ControlledPorts()
    releases, entered, runs, trace, calls = {}, {}, [], [], []
    owner_wf = 'retry-owner-' + uuid.uuid4().hex
    peer_wf = 'retry-peer-' + uuid.uuid4().hex
    trace_file = tmp_path / 'activity-attempts.jsonl'
    def record(row):
        trace.append(row)
        with trace_file.open('a') as handle:
            handle.write(json.dumps(row) + '\n')
    class CaptureActivity(ActivityInboundInterceptor):
        async def execute_activity(self, input):
            info = activity.info()
            fields = dict(workflow_id=info.workflow_id, activity_type=info.activity_type, attempt=info.attempt)
            record(dict(fields, phase='begin'))
            try:
                result = await self.next.execute_activity(input)
            except BaseException as error:
                record(dict(fields, phase='exception', exception=type(error).__name__, message=str(error)))
                raise
            record(dict(fields, phase='success'))
            return result
    class Capture(Interceptor):
        def intercept_activity(self, next):
            return CaptureActivity(next)
    run_type = ownership.ApplyLauncherRun
    def new_run():
        run = run_type()
        runs.append(run)
        return run
    original_main = launcher.main
    def transient_main(**kwargs):
        result = original_main(**kwargs)
        calls.append((kwargs['workflow_id'], kwargs['launcher_run'].identity, result))
        if kwargs['workflow_id'] == owner_wf and sum(row[0] == owner_wf for row in calls) == 1:
            # Inject strictly after the real launcher has accepted its result
            # and joined tracked cleanup, before Temporal receives the output.
            assert any(kind == 'DryRunCompleted' for kind, _ in _events(database.get_connection(), first))
            raise RuntimeError('controlled lost acknowledgment after accepted dry-run')
        return result
    def submit(*, browser, **kwargs):
        releases.setdefault(browser.worker_id, threading.Event())
        entered[browser.worker_id] = browser
        assert releases[browser.worker_id].wait(20), 'synthetic listener release timed out'
        return AgentResult(submission_result=DryRunComplete(navigated_to='https://example.com/apply'), duration_ms=1)
    def forbid_email(*args, **kwargs):
        raise AssertionError('No email/submission allowed in dry-run retry probe')
    monkeypatch.setattr(ownership, 'ApplyLauncherRun', new_run)
    monkeypatch.setattr(launcher, 'main', transient_main)
    monkeypatch.setattr(apply_adapters, 'LocalChromeAdapter', lambda: ports)
    monkeypatch.setattr(apply_adapters, 'ClaudeCodeCliAdapter', lambda: ports)
    monkeypatch.setattr(apply_adapters.GmailEmailApplicationSender, 'send_email_application', forbid_email)
    monkeypatch.setattr(chrome, 'cleanup_workers', ports.cleanup_workers)
    ports.submit_application = submit
    original_heartbeat = run_in_activity.run_blocking_with_heartbeat
    async def responsive(fn, **kwargs):
        return await original_heartbeat(fn, **{**kwargs, 'poll_interval': .05, 'cancel_wait_seconds': 2})
    monkeypatch.setattr(run_in_activity, 'run_blocking_with_heartbeat', responsive)
    executor = ThreadPoolExecutor(max_workers=4)
    run_in_activity.set_activity_executor(executor)
    async def wait_count(count):
        async with asyncio.timeout(15):
            while len(entered) < count:
                await asyncio.sleep(.01)
    queue = 'retry-investigation-' + uuid.uuid4().hex
    histories = []
    try:
        async with local_env() as env:
            async with Worker(env.client, task_queue=queue, workflows=[ApplyWorkflow],
                activities=[apply_activity, check_spend_budget, record_workflow_started, record_workflow_outcome],
                workflow_runner=UnsandboxedWorkflowRunner(), max_concurrent_activities=2,
                max_heartbeat_throttle_interval=timedelta(milliseconds=20), interceptors=[Capture()]):
                def payload(job):
                    return ApplyWorkflowInput(tenant_id='local', job_id=job, dry_run=True,
                        expected_app_dir=str(app), expected_db_path=str(config.DB_PATH), approval_required=False)
                owner = await env.client.start_workflow(ApplyWorkflow.run, payload(first), id=owner_wf, task_queue=queue)
                await wait_count(1)
                peer = await env.client.start_workflow(ApplyWorkflow.run, payload(second), id=peer_wf, task_queue=queue)
                await wait_count(2)
                old, peer_session = ports.sessions
                conn = database.get_connection()
                peer_events = _events(conn, second)
                peer_stage = tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (second,)).fetchone())
                old_file, peer_file = ports.files
                old_bytes, peer_bytes = old_file.read_bytes(), peer_file.read_bytes()
                releases[old.worker_id].set()
                await wait_count(3)
                successor = ports.sessions[2]
                assert old.handle.poll() is not None
                assert len({old.worker_id, successor.worker_id, peer_session.worker_id}) == 3
                assert len({old.cdp_port, successor.cdp_port, peer_session.cdp_port}) == 3
                assert len({old.worker_dir, successor.worker_dir, peer_session.worker_dir}) == 3
                assert len({run.identity for run in runs}) == 3
                owner_starts = [json.loads(payload) for kind, payload in _events(conn, first) if kind == 'ApplyRunStarted']
                assert len(owner_starts) == 2
                assert owner_starts[0]['run_id'] != owner_starts[1]['run_id']
                successor_stage = tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone())
                assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == 'running'
                before_stale = _events(conn, first)
                before_artifacts = [tuple(row) for row in conn.execute('SELECT * FROM job_artifacts ORDER BY rowid')]
                # Match the old accepted outcome: a stale dry-run callback must
                # not reconcile its successor's running row to skipped.
                launcher.mark_result(first, 'dry_run', run_ctx=owner_starts[0], tenant_id='local')
                launcher.release_lock(first, run_ctx=owner_starts[0], tenant_id='local')
                assert tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()) == successor_stage
                assert _events(conn, first) == before_stale
                assert old_file.read_bytes() == old_bytes
                assert [tuple(row) for row in conn.execute('SELECT * FROM job_artifacts ORDER BY rowid')] == before_artifacts
                assert peer_session.handle.poll() is None
                assert _events(conn, second) == peer_events
                assert tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='apply'", (second,)).fetchone()) == peer_stage
                assert peer_file.read_bytes() == peer_bytes
                releases[successor.worker_id].set()
                assert (await asyncio.wait_for(owner.result(), 20)).ok
                assert old_file.read_bytes() == old_bytes
                assert peer_session.handle.poll() is None
                releases[peer_session.worker_id].set()
                assert (await asyncio.wait_for(peer.result(), 20)).ok
                assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('ApplySubmitIntended','ApplicationSubmitted')").fetchone()[0] == 0
                assert sum(kind == 'DryRunCompleted' for kind, _ in _events(conn, first)) == 2
                assert sum(kind == 'DryRunCompleted' for kind, _ in _events(conn, second)) == 1
                histories = [await owner.fetch_history(), await peer.fetch_history()]
            await Replayer(workflows=[ApplyWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflows(
                _history_iterator(histories), raise_on_replay_failure=True)
        apply_trace = [row for row in trace if row['activity_type'] == 'apply']
        assert [(row['attempt'], row['phase']) for row in apply_trace if row['workflow_id'] == owner_wf] == [(1,'begin'),(1,'exception'),(2,'begin'),(2,'success')]
        assert [(row['attempt'], row['phase']) for row in apply_trace if row['workflow_id'] == peer_wf] == [(1,'begin'),(1,'success')]
        assert next(row for row in apply_trace if row['phase'] == 'exception')['message'] == 'controlled lost acknowledgment after accepted dry-run'
        assert [call[0] for call in calls].count(owner_wf) == 2
        assert [call[0] for call in calls].count(peer_wf) == 1
        for history in histories:
            (tmp_path / (history.workflow_id + '.json')).write_text(history.to_json())
    finally:
        for release in releases.values():
            release.set()
        ports.close()
        run_in_activity.shutdown_activity_executors()
        executor.shutdown(wait=True, cancel_futures=True)
        cleanup = [{'worker_id': worker, 'pid': proc.pid, 'returncode': proc.poll()} for worker, proc in ports.processes.items()]
        (tmp_path / 'owned-cleanup.json').write_text(json.dumps(cleanup))
        assert all(row['returncode'] is not None for row in cleanup)


async def _history_iterator(histories):
    for history in histories:
        yield history


def test_alias_workspaces_admit_distinct_runs_and_never_reuse_resources(owned_runtime, monkeypatch, tmp_path):
    app, _, _ = owned_runtime
    alias = tmp_path / "alias"
    alias.symlink_to(app, target_is_directory=True)
    prior = ownership.ApplyLauncherRun()
    with prior.lease():
        prior.allocate_workers(2)
        sentinel = config.APPLY_WORKER_DIR / f"worker-{prior.worker_ids[0]}" / "accepted"
        sentinel.write_bytes(b"retained")
        monkeypatch.setattr(config, "APP_DIR", alias)
        peer = ownership.ApplyLauncherRun()
        with peer.lease():
            peer.allocate_workers(2)
            assert not set(peer.worker_ids) & set(prior.worker_ids)
            assert not set(peer.ports) & set(prior.ports)
            assert all(0 < port <= 65535 for port in peer.ports)
            assert all(wid < 2**53 for wid in peer.worker_ids)
            assert sentinel.read_bytes() == b"retained"


def test_cancel_callback_returns_while_cleanup_join_is_pending(owned_runtime, monkeypatch):
    run = ownership.ApplyLauncherRun(worker_ids=(101,))
    entered, cleanup_started, cleanup_release, launcher_release = (threading.Event() for _ in range(4))
    def cleanup(_workers):
        cleanup_started.set()
        assert cleanup_release.wait(10)
    monkeypatch.setattr(chrome, "cleanup_workers", cleanup)
    def blocking():
        with run.lease():
            entered.set()
            assert launcher_release.wait(10)
            run.finish()
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(blocking)
        try:
            assert entered.wait(5)
            run.cancel()
            assert cleanup_started.wait(5)
            launcher_release.set()
            with ownership.ApplyLauncherRun().lease():
                pass
            assert not future.done()
        finally:
            cleanup_release.set()
            launcher_release.set()
        future.result(timeout=5)


def test_cancellation_cleans_browser_registered_after_first_cleanup(owned_runtime, monkeypatch):
    run = ownership.ApplyLauncherRun(worker_ids=(102,))
    before_registration = threading.Event()
    allow_registration = threading.Event()
    first_cleanup = threading.Event()
    processes = []

    def cleanup(worker_ids):
        assert tuple(worker_ids) == run.worker_ids
        first_cleanup.set()
        for process in tuple(processes):
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)

    monkeypatch.setattr(chrome, "cleanup_workers", cleanup)

    def launcher_thread():
        with run.lease():
            before_registration.set()
            assert allow_registration.wait(5)
            process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                       start_new_session=os.name != "nt")
            processes.append(process)
            try:
                process.wait(timeout=5)
                assert run.stop_event.is_set()
            finally:
                run.finish()

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(launcher_thread)
        try:
            assert before_registration.wait(5)
            run.cancel()
            assert first_cleanup.wait(5)
            assert processes == []
            allow_registration.set()
            future.result(timeout=10)
            assert processes[0].poll() is not None
        finally:
            allow_registration.set()
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


@pytest.mark.parametrize("inspection_denied", [False, True])
def test_unverified_worker_exit_fences_next_claim_and_preserves_runtime_files(owned_runtime, monkeypatch, inspection_denied):
    from jobctrl.infrastructure.apply.local_chrome import LocalChromeAdapter
    from jobctrl.infrastructure.process_ownership import (
        INSPECTION_DENIED_MESSAGE, ProcessInspectionDenied, ProcessOwnershipError,
    )

    app, first, second = owned_runtime

    class Ports(_ControlledPorts):
        def __init__(self):
            super().__init__()
            self.launch_attempts = 0

        def launch(self, config):
            self.launch_attempts += 1
            if config.worker_id in chrome._chrome_procs:
                raise RuntimeError("browser worker already has an owner")
            session = super().launch(config)
            with chrome._chrome_lock:
                chrome._chrome_procs[config.worker_id] = session.handle
                chrome._chrome_identities[config.worker_id] = (session.handle, session.pid)
            return session

        def cleanup(self, session):
            LocalChromeAdapter().cleanup(session)

        def submit_application(self, **kwargs):
            return AgentResult(submission_result=DryRunComplete(navigated_to="https://example.com/apply"), duration_ms=1)

    ports = Ports()
    monkeypatch.setattr(apply_adapters, "LocalChromeAdapter", lambda: ports)
    monkeypatch.setattr(apply_adapters, "ClaudeCodeCliAdapter", lambda: ports)
    actual_terminate = chrome.terminate_owned_process
    unverified = True

    def terminate(*args, **kwargs):
        if unverified:
            if inspection_denied:
                raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE)
            raise ProcessOwnershipError("controlled exit cannot be verified")
        return actual_terminate(*args, **kwargs)

    monkeypatch.setattr(chrome, "terminate_owned_process", terminate)
    try:
        with pytest.raises(ownership.ApplyLauncherCleanupIncomplete) as failure:
            launcher.main(limit=2, workers=1, dry_run=True, install_signal_handlers=False)
        assert (str(failure.value) == INSPECTION_DENIED_MESSAGE) is inspection_denied
        assert ports.launch_attempts == 1
        assert ports.files[0].read_bytes() == b"accepted synthetic bytes"
        assert all(process.poll() is None for process in ports.processes.values())
        conn = database.get_connection()
        events = _events(conn, first) + _events(conn, second)
        assert sum(kind == "ApplyRunStarted" for kind, _payload in events) == 1
        assert any(kind == "DryRunCompleted" for kind, _payload in events)
        retained = list((app / "apply-runs").glob("*/custody.json"))
        assert retained
        import json
        assert json.loads(retained[0].read_text())["cleanup_failure"] is not None
        assert launcher.acquire_job(target_job_id=first,
                                    run_ctx={"dry_run": True}, approval_required=False) is None
        assert any(process is ports.sessions[0].handle for process in chrome._chrome_procs.values())
    finally:
        ports.close()
        unverified = False
        chrome.cleanup_workers(tuple(ports.processes))


def test_concurrent_attempt_allocation_returns_each_workers_own_pair(owned_runtime, monkeypatch):
    run = ownership.ApplyLauncherRun()
    first_allocated, second_started, second_done = (threading.Event() for _ in range(3))
    original = run.allocate_workers
    first_thread = []
    def controlled_allocate(count):
        original(count)
        if threading.get_ident() == first_thread[0]:
            first_allocated.set()
            assert second_started.wait(5)
            # On the old split allocation/read, the second append completes
            # here and both callers return that same final resource pair.
            second_done.wait(.15)
    monkeypatch.setattr(run, "allocate_workers", controlled_allocate)
    def first():
        first_thread.append(threading.get_ident())
        return run.new_attempt()
    def second():
        second_started.set()
        pair = run.new_attempt()
        second_done.set()
        return pair
    with ThreadPoolExecutor(max_workers=2) as executor:
        one = executor.submit(first)
        assert first_allocated.wait(5)
        two = executor.submit(second)
        first_pair, second_pair = one.result(timeout=5), two.result(timeout=5)
    assert first_pair[0] != second_pair[0]
    assert (first_pair, second_pair) == tuple(zip(run.worker_ids, run.ports))


def test_completed_run_drops_routing_and_reaped_pipe_but_retains_disk_custody(owned_runtime):
    run = ownership.ApplyLauncherRun()
    with run.lease():
        run.allocate_workers(1)
        worker_id = run.worker_ids[0]
        process = run.spawn(worker_id, "agent", [sys.executable, "-c", "print('owned bytes')"],
                            stdout=subprocess.PIPE, text=True, start_new_session=True)
        assert process.stdout.read().strip() == "owned bytes"
        process.wait(timeout=5)
        run.finish()
        assert process.stdout.closed
        assert run._birth_processes == {}
    assert worker_id not in ownership._WORKER_RUNS
    assert run._journal.path.is_file()
    assert len(run._journal.value["births"]) == 1


@pytest.mark.parametrize("outcome", ["failed", "dry_run", "ambiguous"])
def test_clean_no_birth_terminal_claim_releases_without_native_stop(owned_runtime, monkeypatch, outcome):
    from jobctrl.domain.apply.value_objects import Failed
    from jobctrl.state import record_job_event
    app, first, _ = owned_runtime
    def run_job(job, *, run_ctx, **kwargs):
        if outcome == "ambiguous":
            conn = database.get_connection()
            record_job_event(conn, first, "apply", "ApplySubmitIntended", tenant_id="local",
                             payload={"run_id": run_ctx["run_id"]})
            conn.commit()
        if outcome == "dry_run":
            return DryRunComplete(navigated_to="https://example.com/apply"), 1
        return Failed(error="controlled pre-browser terminal", retryable=True), 1
    monkeypatch.setattr(launcher, "run_job", run_job)
    run = ownership.ApplyLauncherRun()
    launcher.main(target_job_id=first, dry_run=True, launcher_run=run, install_signal_handlers=False)
    conn = database.get_connection()
    accepted = _events(conn, first)
    assert any(kind == "ApplyClaimSettled" for kind, _ in accepted)
    assert not run._journal.path.exists()
    # The logical claim is settled; ambiguity is still independently parked.
    next_ctx = {"dry_run": True}
    successor = launcher.acquire_job(target_job_id=first, run_ctx=next_ctx, approval_required=False)
    if outcome == "ambiguous":
        assert successor is None
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "needs_verification"
    else:
        assert successor is not None
        assert _events(conn, first)[:len(accepted)] == accepted


def test_partial_saga_terminal_without_canonical_result_retains_no_birth_claim(owned_runtime, monkeypatch):
    from jobctrl.state import record_job_event
    app, first, _ = owned_runtime
    run = ownership.ApplyLauncherRun()
    with run.lease():
        run.allocate_workers(1)
        ctx = {"dry_run": True, "launcher_run": run}
        assert launcher.acquire_job(target_job_id=first, run_ctx=ctx, approval_required=False)
        conn = database.get_connection()
        record_job_event(conn, first, "apply", "ApplicationFailed", tenant_id="local", payload={"run_id": ctx["run_id"]})
        conn.commit()
        def fail_artifact(*args, **kwargs):
            raise OSError("controlled post-saga artifact persistence failure")
        monkeypatch.setattr(launcher, "_register_apply_log_artifact", fail_artifact)
        with pytest.raises(OSError):
            launcher.mark_result(first, "failed", "controlled", run_ctx=ctx)
        launcher.release_lock(first, run_ctx=ctx)
        run.finish()
        assert run._journal.value["births"] == []
        assert len(run._journal.value["jobs"]) == 1
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (first,)).fetchone()[0] == "running"
        assert not any(kind == "ApplyClaimSettled" for kind, _ in _events(conn, first))
    assert run._journal.path.is_file()


def test_finished_source_run_allows_same_job_retry_without_claiming_full_tree_proof(owned_runtime, monkeypatch):
    import json
    app, first, _ = owned_runtime
    ports = _ControlledPorts()
    ports.release.set()
    monkeypatch.setattr(apply_adapters, "LocalChromeAdapter", lambda: ports)
    monkeypatch.setattr(apply_adapters, "ClaudeCodeCliAdapter", lambda: ports)
    monkeypatch.setattr(chrome, "cleanup_workers", ports.cleanup_workers)
    first_run, successor = ownership.ApplyLauncherRun(), ownership.ApplyLauncherRun()
    try:
        assert launcher.main(target_job_id=first, dry_run=True, launcher_run=first_run,
                             install_signal_handlers=False) == (0, 0)
        conn = database.get_connection()
        settled = [json.loads(payload) for kind, payload in _events(conn, first) if kind == "ApplyClaimSettled"]
        assert settled[-1]["source_best_effort"] is True
        assert settled[-1]["tracked_cleanup_completed"] is True
        assert settled[-1]["full_tree_verified"] is False
        assert settled[-1]["no_process_birth"] is False
        assert first_run._journal.path.is_file()
        assert first_run._journal.value["births"] and not first_run._journal.value["jobs"]
        accepted = ports.files[0].read_bytes()
        assert launcher.main(target_job_id=first, dry_run=True, launcher_run=successor,
                             install_signal_handlers=False) == (0, 0)
        assert first_run.worker_ids != successor.worker_ids
        assert ports.files[0] != ports.files[1]
        assert ports.files[0].read_bytes() == accepted
        assert sum(kind == "DryRunCompleted" for kind, _ in _events(conn, first)) == 2
    finally:
        ports.close()
