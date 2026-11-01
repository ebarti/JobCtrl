"""Apply census and cleanup budgets with exclusively synthetic handles."""

from __future__ import annotations

import errno
import subprocess
import signal
import sys
import threading
from types import SimpleNamespace

import pytest

from jobctrl.apply import chrome
from jobctrl.apply.ownership import ApplyLauncherCleanupIncomplete, ApplyLauncherRun
from jobctrl.apply.process_birth import CustodyUnverified
from jobctrl.infrastructure import process_ownership
from jobctrl.infrastructure.apply import claude_code_cli


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now = round(self.now + seconds, 9)


class SyntheticProcess:
    def __init__(self, pid, *, live=False, clock=None):
        self.pid = pid
        self.returncode = None if live else 0
        self._waitpid_lock = threading.Lock()
        self.clock = clock
        self.waits = []
        self.stdout = None
        self.stderr = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.returncode is None:
            self.clock.sleep(timeout)
            raise subprocess.TimeoutExpired('synthetic owned child', timeout)
        return self.returncode


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(process_ownership, 'time', clock)
    monkeypatch.setattr(process_ownership, 'platform', SimpleNamespace(system=lambda: 'Darwin'))
    return clock


def inventory(generation=1, *, session=9000, occupied=False):
    rows = {17: ((generation,), 700, True, 17)}
    if occupied:
        rows[18] = ((1,), session, True, 18)
    return rows


def test_transient_census_instability_settles_before_worker_cleanup_is_fenced(clock, monkeypatch):
    process = SyntheticProcess(9000)
    monkeypatch.setattr(chrome, '_chrome_procs', {1: process})
    monkeypatch.setattr(chrome, '_chrome_identities', {1: (process, process.pid)})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', lambda **_: None)
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *_: pytest.fail('reaped handle signaled'))
    samples = []

    def observe():
        samples.append(clock.now)
        return inventory(), clock.now >= 1.3

    monkeypatch.setattr(process_ownership, '_read_process_inventory', observe)
    run = ApplyLauncherRun(worker_ids=(1,))
    run.verify_worker_cleanup(1)
    assert not run.stop_event.is_set()
    assert len(process.waits) == 1
    assert chrome._chrome_procs == {}
    assert samples[-2] >= 1.3
    assert samples[-1] > samples[-2]


def test_many_unverified_agent_and_browser_handles_share_bounded_cleanup(clock, monkeypatch):
    workers = tuple(range(1, 17))
    browsers = {wid: SyntheticProcess(9000 + wid) for wid in workers}
    agents = {wid: SyntheticProcess(10000 + wid) for wid in workers}
    monkeypatch.setattr(chrome, '_chrome_procs', browsers.copy())
    monkeypatch.setattr(chrome, '_chrome_identities', {wid: (proc, proc.pid) for wid, proc in browsers.items()})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', agents.copy())
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {wid: (proc, proc.pid) for wid, proc in agents.items()})
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *_: pytest.fail('reaped handle signaled'))
    monkeypatch.setattr(process_ownership, '_read_process_inventory', lambda: (inventory(), False))
    run = ApplyLauncherRun(worker_ids=workers)
    errors = run._cleanup_workers(workers)
    assert errors
    assert clock.now <= 10.1
    assert any(proc.waits for proc in (*browsers.values(), *agents.values()))
    assert any(not proc.waits for proc in (*browsers.values(), *agents.values()))
    assert chrome._chrome_procs == browsers
    assert claude_code_cli._ACTIVE_CLAUDE_PROCS == agents


def test_many_unresponsive_roots_still_receive_only_verified_owned_signals(clock, monkeypatch):
    workers = tuple(range(1, 17))
    browsers = {wid: SyntheticProcess(9000 + wid, live=True, clock=clock) for wid in workers}
    monkeypatch.setattr(chrome, '_chrome_procs', browsers.copy())
    monkeypatch.setattr(chrome, '_chrome_identities', {wid: (proc, proc.pid) for wid, proc in browsers.items()})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', lambda **_: None)
    monkeypatch.setattr(process_ownership.os, 'getpgid', lambda pid: pid)
    monkeypatch.setattr(process_ownership.os, 'getsid', lambda pid: pid)
    monkeypatch.setattr(process_ownership, '_waitid_nowait', lambda *_args, **_kwargs: None)
    terms, forces = {}, []
    by_pid = {proc.pid: proc for proc in browsers.values()}

    def term(pid, sig):
        assert sig == signal.SIGTERM and pid in by_pid
        terms[pid] = clock.now

    def force(pid, sig):
        assert sig == signal.SIGKILL and pid in terms
        forces.append((pid, clock.now))
        by_pid[pid].returncode = -signal.SIGKILL

    def observe():
        pid = next(reversed(terms))
        rows = inventory(session=pid, occupied=by_pid[pid].returncode is None)
        if 18 in rows:
            rows[18] = ((1,), pid, True, pid)
        return rows, True

    monkeypatch.setattr(process_ownership.os, 'kill', term)
    monkeypatch.setattr(process_ownership.os, 'killpg', force)
    monkeypatch.setattr(process_ownership, '_read_process_inventory', observe)
    run = ApplyLauncherRun(worker_ids=workers)
    errors = run._cleanup_workers(workers)
    assert errors
    assert clock.now <= 10.1
    assert forces and len(forces) < len(browsers)
    assert all(at - terms[pid] >= process_ownership._PROCESS_TERMINATION_GRACE_SECONDS - 1e-6
               for pid, at in forces)
    assert set(terms) - {pid for pid, _ in forces}
    assert all(proc.pid in by_pid for proc in chrome._chrome_procs.values())
    assert set(chrome._chrome_procs.values()) == {proc for proc in browsers.values() if proc.returncode is None}


@pytest.mark.parametrize('condition', ['incomplete', 'occupied', 'changing'])
def test_persistent_uncertain_census_never_retires_session(clock, monkeypatch, condition):
    samples = []

    def observe():
        samples.append(clock.now)
        if condition == 'incomplete':
            return inventory(), False
        if condition == 'occupied':
            return inventory(occupied=True), True
        return inventory(generation=len(samples)), True

    monkeypatch.setattr(process_ownership, '_read_process_inventory', observe)
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *_: pytest.fail('census cannot signal'))
    with pytest.raises(process_ownership.ProcessOwnershipError, match='ownership retained'):
        process_ownership.verify_session_exit(9000)
    assert clock.now >= 2.0
    assert len(samples) > 1


@pytest.mark.parametrize('mode', ['linux', 'darwin', 'darwin-scoped'])
def test_census_stops_between_slow_kernel_reads_when_budget_expires(clock, monkeypatch, mode):
    calls = []

    if mode == 'linux':
        monkeypatch.setattr(process_ownership, 'platform', SimpleNamespace(system=lambda: 'Linux'))
        monkeypatch.setattr(process_ownership, '_linux_process_ids', lambda: set(range(1, 11)))

        class SlowPath:
            def __init__(self, *_args):
                pass

            def __truediv__(self, _part):
                return self

            def read_bytes(self):
                calls.append(1)
                clock.sleep(.06)
                return b'1 (synthetic) S ' + b'1 ' * 19

        monkeypatch.setattr(process_ownership, 'Path', SlowPath)
        observe = process_ownership._read_process_inventory
    else:
        import ctypes

        class Function:
            def __call__(self, pid, flavor, _arg, pointer, _size):
                calls.append(1)
                clock.sleep(.06)
                info = pointer._obj
                if flavor == 17:
                    info.unique_id, info.pid_version = pid, 1
                elif flavor == 13:
                    info.pid, info.pgid, info.state = pid, pid, 1
                return ctypes.sizeof(info)

        library = SimpleNamespace(proc_listpids=Function(), proc_pidinfo=Function())
        monkeypatch.setattr(ctypes, 'CDLL', lambda *_args, **_kwargs: library)
        monkeypatch.setattr(process_ownership, '_darwin_process_ids', lambda _: set(range(1, 11)))
        scope = (42, 10) if mode == 'darwin-scoped' else None

        def observe():
            return process_ownership._darwin_process_inventory(native_scope=scope)

    with process_ownership.cleanup_budget(.1):
        with pytest.raises(process_ownership.CleanupDeadlineExceeded):
            observe()
    assert len(calls) == 2
    assert clock.now == pytest.approx(.12)


def test_reused_pid_generation_and_session_handoff_require_new_stable_proof(clock, monkeypatch):
    observations = [
        (inventory(1), True),
        (inventory(2), True),
        (inventory(2, occupied=True), True),
        (inventory(2), True),
        (inventory(3), True),
        (inventory(3), True),
    ]
    seen = []

    def observe():
        value = observations[len(seen)]
        seen.append(value)
        return value

    monkeypatch.setattr(process_ownership, '_read_process_inventory', observe)
    process_ownership.verify_session_exit(9000)
    assert seen == observations


def test_stale_handle_or_session_identity_never_authorizes_signal(clock, monkeypatch):
    process = SyntheticProcess(9000, live=True, clock=clock)
    signals = []
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *args: signals.append(args))
    with pytest.raises(process_ownership.ProcessOwnershipError, match='ownership'):
        process_ownership.terminate_owned_process(process, launched_pid=9001)
    monkeypatch.setattr(process_ownership, '_waitid_nowait', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(process_ownership.os, 'getpgid', lambda _pid: 1234)
    monkeypatch.setattr(process_ownership.os, 'getsid', lambda pid: pid)
    with pytest.raises(process_ownership.ProcessOwnershipError, match='no longer owns'):
        process_ownership.terminate_owned_process(process, launched_pid=9000)
    assert signals == []
    assert not process.waits


@pytest.mark.parametrize('adapter', ['agent', 'browser'])
@pytest.mark.parametrize('denied', [True, False])
def test_cleanup_reports_only_verified_inspection_denial_without_private_details(clock, monkeypatch, adapter, denied):
    process = SyntheticProcess(9001)
    peer = SyntheticProcess(9002)
    monkeypatch.setattr(process_ownership, 'platform', SimpleNamespace(system=lambda: 'Linux'))
    monkeypatch.setattr(process_ownership, '_linux_process_ids', lambda: {process.pid})

    class RestrictedPath:
        def __init__(self, *_args):
            pass

        def __truediv__(self, _part):
            return self

        def read_bytes(self):
            kind = PermissionError if denied else OSError
            raise kind(errno.EACCES if denied else errno.EIO, 'private inspection data', '/private/example')

    monkeypatch.setattr(process_ownership, 'Path', RestrictedPath)
    browsers = {1: process, 2: peer} if adapter == 'browser' else {}
    agents = {1: process, 2: peer} if adapter == 'agent' else {}
    monkeypatch.setattr(chrome, '_chrome_procs', browsers.copy())
    monkeypatch.setattr(chrome, '_chrome_identities', {wid: (proc, proc.pid) for wid, proc in browsers.items()})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', agents.copy())
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {wid: (proc, proc.pid) for wid, proc in agents.items()})
    run = ApplyLauncherRun(worker_ids=(1,))
    with pytest.raises(ApplyLauncherCleanupIncomplete) as failure:
        run.verify_worker_cleanup(1)
    message = str(failure.value)
    assert (message == process_ownership.INSPECTION_DENIED_MESSAGE) is denied
    assert '/private/example' not in message and 'private inspection data' not in message
    assert run.stop_event.is_set() and run._cleanup_error
    assert (chrome._chrome_procs if adapter == 'browser' else claude_code_cli._ACTIVE_CLAUDE_PROCS) == {1: process, 2: peer}


@pytest.mark.parametrize('adapter', ['agent', 'browser'])
@pytest.mark.parametrize('denied', [True, False])
def test_cleanup_preserves_denial_observed_before_shared_deadline(clock, monkeypatch, adapter, denied):
    from jobctrl.apply import ownership

    process = SyntheticProcess(9001)
    browsers = {1: process} if adapter == 'browser' else {}
    agents = {1: process} if adapter == 'agent' else {}
    monkeypatch.setattr(chrome, '_chrome_procs', browsers.copy())
    monkeypatch.setattr(chrome, '_chrome_identities', {wid: (proc, proc.pid) for wid, proc in browsers.items()})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', agents.copy())
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {wid: (proc, proc.pid) for wid, proc in agents.items()})
    monkeypatch.setattr(ownership, '_CLEANUP_PASS_TIMEOUT_SECONDS', .1)
    samples = []

    def observe():
        process_ownership._require_cleanup_budget()
        samples.append(clock.now)
        if denied:
            raise process_ownership.ProcessInspectionDenied(process_ownership.INSPECTION_DENIED_MESSAGE)
        raise process_ownership.ProcessOwnershipError('synthetic unknown inspection failure')

    monkeypatch.setattr(process_ownership, '_read_process_inventory', observe)
    run = ApplyLauncherRun(worker_ids=(1,))
    with pytest.raises(ApplyLauncherCleanupIncomplete) as failure:
        run.verify_worker_cleanup(1)
    assert len(samples) >= 4
    assert (str(failure.value) == process_ownership.INSPECTION_DENIED_MESSAGE) is denied
    assert run.stop_event.is_set() and run._cleanup_error
    assert (chrome._chrome_procs if adapter == 'browser' else claude_code_cli._ACTIVE_CLAUDE_PROCS) == {1: process}


@pytest.mark.parametrize('stage', ['verification', 'retirement'])
@pytest.mark.parametrize('denied', [True, False])
def test_tracked_birth_poll_failure_is_classified_without_disclosing_details(monkeypatch, stage, denied):
    from jobctrl import runtime

    process = SyntheticProcess(9001)
    calls = []

    def poll():
        calls.append(1)
        if stage == 'verification' or len(calls) == 2:
            kind = PermissionError if denied else OSError
            raise kind(errno.EACCES if denied else errno.EIO, 'private details', '/private/example')
        return 0

    monkeypatch.setattr(process, 'poll', poll)
    monkeypatch.setattr(runtime, 'is_bundled_runtime', lambda: False)
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    run = ApplyLauncherRun(worker_ids=(1,))
    run._birth_processes['owner'] = (1, process, process.pid)
    with pytest.raises(ApplyLauncherCleanupIncomplete) as failure:
        run.verify_worker_cleanup(1)
    assert (str(failure.value) == process_ownership.INSPECTION_DENIED_MESSAGE) is denied
    assert '/private/example' not in str(failure.value)
    assert run._birth_processes == {'owner': (1, process, process.pid)}
    assert run.stop_event.is_set()


@pytest.mark.parametrize('operation', ['waitid', 'getpgid', 'getsid', 'term', 'killpg'])
def test_cleanup_distinguishes_denied_inspection_from_denied_signal(clock, monkeypatch, operation):
    process = SyntheticProcess(9001, live=True, clock=clock)
    monkeypatch.setattr(chrome, '_chrome_procs', {1: process})
    monkeypatch.setattr(chrome, '_chrome_identities', {1: (process, process.pid)})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})

    def denied(*_args, **_kwargs):
        raise PermissionError(errno.EACCES, 'private details', '/private/example')

    monkeypatch.setattr(process_ownership, '_waitid_nowait', denied if operation == 'waitid' else lambda *_: None)
    monkeypatch.setattr(process_ownership.os, 'getpgid', denied if operation == 'getpgid' else lambda pid: pid)
    monkeypatch.setattr(process_ownership.os, 'getsid', denied if operation == 'getsid' else lambda pid: pid)
    def term(*_args):
        if operation == 'term':
            denied()
        assert operation == 'killpg'

    monkeypatch.setattr(process_ownership.os, 'kill', term)
    monkeypatch.setattr(process_ownership.os, 'killpg', denied if operation == 'killpg' else lambda *_: pytest.fail('unexpected group signal'))
    if operation == 'killpg':
        rows = inventory(session=process.pid, occupied=True)
        rows[18] = ((1,), process.pid, True, process.pid)
        monkeypatch.setattr(process_ownership, '_read_process_inventory', lambda: (rows, True))
    run = ApplyLauncherRun(worker_ids=(1,))
    with pytest.raises(ApplyLauncherCleanupIncomplete) as failure:
        run.verify_worker_cleanup(1)
    message = str(failure.value)
    if operation in ('term', 'killpg'):
        assert message == process_ownership.SIGNAL_DENIED_MESSAGE
    else:
        assert message == process_ownership.INSPECTION_DENIED_MESSAGE
    assert '/private/example' not in message and 'private details' not in message
    assert chrome._chrome_procs == {1: process}


def test_cleanup_reports_both_signal_and_later_inspection_denial(clock, monkeypatch):
    process = SyntheticProcess(9001, live=True, clock=clock)
    monkeypatch.setattr(chrome, '_chrome_procs', {1: process})
    monkeypatch.setattr(chrome, '_chrome_identities', {1: (process, process.pid)})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    monkeypatch.setattr(process_ownership, '_waitid_nowait', lambda *_: None)
    monkeypatch.setattr(process_ownership.os, 'getpgid', lambda pid: pid)
    monkeypatch.setattr(process_ownership.os, 'getsid', lambda pid: pid)
    monkeypatch.setattr(process_ownership.os, 'kill', lambda *_: None)

    def denied(*_args):
        raise PermissionError(errno.EACCES, 'private details', '/private/example')

    def observe(_pid, *, timeout_seconds=None, **_kwargs):
        if timeout_seconds is not None:
            clock.sleep(timeout_seconds)
            raise process_ownership._VerifiedLaunchGroupOccupied('verified group')
        raise process_ownership.ProcessInspectionDenied(process_ownership.INSPECTION_DENIED_MESSAGE)

    monkeypatch.setattr(process_ownership.os, 'killpg', denied)
    monkeypatch.setattr(process_ownership, '_wait_for_session_exit', observe)
    monkeypatch.setattr(process, 'wait', lambda timeout: 0)
    run = ApplyLauncherRun(worker_ids=(1,))
    with pytest.raises(ApplyLauncherCleanupIncomplete) as failure:
        run.verify_worker_cleanup(1)
    assert str(failure.value) == process_ownership.INSPECTION_AND_SIGNAL_DENIED_MESSAGE
    assert chrome._chrome_procs == {1: process}


@pytest.mark.parametrize('stage', ['before-snapshot', 'before-record'])
def test_interrupt_budget_includes_run_lock_at_real_entry_point(monkeypatch, stage):
    import time
    from jobctrl.apply import ownership

    run = ApplyLauncherRun(worker_ids=(1,))
    monkeypatch.setattr(ownership, '_CLEANUP_PASS_TIMEOUT_SECONDS', 0.1)
    entered, release = threading.Event(), threading.Event()

    def occupy():
        with run._lock:
            entered.set()
            release.wait(2)

    holder = threading.Thread(target=occupy)
    if stage == 'before-snapshot':
        holder.start()
        assert entered.wait(1)
    else:
        def finish_cleanup(_workers):
            holder.start()
            assert entered.wait(1)
            return []
        monkeypatch.setattr(run, '_cleanup_workers_within_budget', finish_cleanup)

    try:
        started = time.monotonic()
        assert run.interrupt() is False
        elapsed = time.monotonic() - started
        assert elapsed < 0.5
        assert run.stop_event.is_set()
        assert run._cleanup_error is not None
    finally:
        release.set()
        if holder.ident is not None:
            holder.join(timeout=2)
    assert not holder.is_alive()


def test_cleanup_does_not_wait_unbounded_for_contended_browser_registry(monkeypatch):
    import time
    from jobctrl.apply import ownership

    run = ApplyLauncherRun(worker_ids=(1,))
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    result = []
    monkeypatch.setattr(ownership, '_CLEANUP_PASS_TIMEOUT_SECONDS', 0.1, raising=False)
    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', lambda **_: None)

    def occupy_registry():
        with chrome._chrome_lock:
            entered.set()
            release.wait(3)

    def clean():
        result.extend(run._cleanup_workers((1,)))
        done.set()

    holder = threading.Thread(target=occupy_registry)
    worker = threading.Thread(target=clean)
    holder.start()
    try:
        assert entered.wait(1)
        worker.start()
        before = time.monotonic()
        assert done.wait(0.5), 'cleanup waited beyond its shared deadline for the browser registry'
        assert time.monotonic() - before < 0.5
        assert result
    finally:
        release.set()
        holder.join(timeout=3)
        if worker.ident is not None:
            worker.join(timeout=3)
    assert not holder.is_alive()
    assert not worker.is_alive()


@pytest.mark.parametrize('guard', ['agent', 'reap', 'run'])
def test_cleanup_fails_closed_when_an_ownership_lock_exceeds_budget(monkeypatch, guard):
    from jobctrl.apply import ownership

    run = ApplyLauncherRun(worker_ids=(1,))
    process = SyntheticProcess(9001, live=True)
    monkeypatch.setattr(ownership, '_CLEANUP_PASS_TIMEOUT_SECONDS', 0.1)
    monkeypatch.setattr(chrome, '_chrome_procs', {1: process} if guard == 'reap' else {})
    monkeypatch.setattr(chrome, '_chrome_identities', {1: (process, process.pid)} if guard == 'reap' else {})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *_: pytest.fail('unverified handle signaled'))
    lock = {'agent': claude_code_cli._ACTIVE_CLAUDE_LOCK, 'reap': process._waitpid_lock, 'run': run._lock}[guard]
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    result = []

    def occupy():
        with lock:
            entered.set()
            release.wait(3)

    def clean():
        result.extend(run._cleanup_workers((1,)))
        done.set()

    holder, worker = threading.Thread(target=occupy), threading.Thread(target=clean)
    holder.start()
    try:
        assert entered.wait(1)
        worker.start()
        assert done.wait(0.5), f'cleanup waited beyond its deadline for the {guard} lock'
        assert result
        assert not process.waits
    finally:
        release.set()
        holder.join(timeout=3)
        if worker.ident is not None:
            worker.join(timeout=3)
    assert not holder.is_alive()
    assert not worker.is_alive()


@pytest.mark.parametrize('dry_run', [False, True])
def test_independent_worker_can_claim_and_finish_while_peer_cleanup_fails(monkeypatch, dry_run):
    run = ApplyLauncherRun(worker_ids=(101, 102))
    first_entered, peer_entered, failure_recorded = (threading.Event() for _ in range(3))
    claims, accepted, errors = [], [], []
    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', lambda **_: None)

    def cleanup(workers):
        if workers == (101,):
            first_entered.set()
            assert peer_entered.wait(2)
            raise RuntimeError('synthetic cleanup refusal')

    def first():
        try:
            run.verify_worker_cleanup(101)
            errors.append('first cleanup unexpectedly succeeded')
        except ApplyLauncherCleanupIncomplete:
            failure_recorded.set()

    def peer():
        try:
            run.verify_worker_cleanup(102)
            claims.append((102, dry_run))
            peer_entered.set()
            assert failure_recorded.wait(2) and run.stop_event.is_set()
            accepted.append((102, dry_run, 'accepted'))
        except Exception as exc:
            errors.append(str(exc))

    monkeypatch.setattr(chrome, 'cleanup_workers', cleanup)
    owner, other = threading.Thread(target=first), threading.Thread(target=peer)
    owner.start()
    try:
        assert first_entered.wait(1)
        other.start()
        owner.join(timeout=3)
        other.join(timeout=3)
        assert not owner.is_alive() and not other.is_alive()
        assert not errors
        assert claims == [(102, dry_run)]
        assert accepted == [(102, dry_run, 'accepted')]
        assert run.stop_event.is_set() and run._cleanup_error
    finally:
        peer_entered.set()
        failure_recorded.set()
        owner.join(timeout=2)
        if other.ident is not None:
            other.join(timeout=2)


def test_peer_verification_cannot_clear_another_workers_failure_or_denial(monkeypatch):
    run = ApplyLauncherRun(worker_ids=(101, 102))
    peer_entered, failure_recorded = threading.Event(), threading.Event()
    failures = []
    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', lambda **_: None)

    def cleanup(workers):
        if workers == (101,):
            assert peer_entered.wait(2)
            raise process_ownership.ProcessInspectionDenied(process_ownership.INSPECTION_DENIED_MESSAGE)
        if workers == (102,):
            peer_entered.set()
            assert failure_recorded.wait(2)

    def verify(worker):
        try:
            run.verify_worker_cleanup(worker)
            failures.append('unexpected success')
        except ApplyLauncherCleanupIncomplete as exc:
            failures.append(str(exc))
            if worker == 101:
                failure_recorded.set()

    monkeypatch.setattr(chrome, 'cleanup_workers', cleanup)
    first, peer = threading.Thread(target=verify, args=(101,)), threading.Thread(target=verify, args=(102,))
    first.start()
    peer.start()
    try:
        first.join(timeout=3)
        peer.join(timeout=3)
        assert not first.is_alive() and not peer.is_alive()
        assert failures == [process_ownership.INSPECTION_DENIED_MESSAGE] * 2
        assert run._cleanup_failed.is_set() and run._inspection_denied.is_set() and run._cleanup_error

        def still_denied(workers):
            if workers == (101,):
                raise process_ownership.ProcessInspectionDenied(process_ownership.INSPECTION_DENIED_MESSAGE)

        monkeypatch.setattr(chrome, 'cleanup_workers', still_denied)
        assert not run.interrupt()
        assert run._inspection_denied.is_set() and run._cleanup_error
        monkeypatch.setattr(chrome, 'cleanup_workers', lambda _workers: None)
        assert run.interrupt()
        assert not run._cleanup_failed.is_set() and not run._inspection_denied.is_set()
        assert run._cleanup_error is None and run.stop_event.is_set()
    finally:
        peer_entered.set()
        failure_recorded.set()
        first.join(timeout=2)
        peer.join(timeout=2)


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
def test_slow_owned_adapter_cleanup_does_not_block_independent_peer(monkeypatch, adapter):
    first, peer, control = (SyntheticProcess(pid, live=True) for pid in (9001, 9002, 9003))
    entered, release, peer_finished = (threading.Event() for _ in range(3))
    failures = []

    def terminate(process, *, launched_pid):
        assert launched_pid == process.pid and process in (first, peer)
        if process is first:
            entered.set()
            assert release.wait(2)
            raise process_ownership.ProcessOwnershipError('synthetic retained owner')

    if adapter == 'browser':
        monkeypatch.setattr(chrome, '_chrome_procs', {1: first, 2: peer, 3: control})
        monkeypatch.setattr(chrome, '_chrome_identities', {wid: (proc, proc.pid) for wid, proc in chrome._chrome_procs.items()})
        monkeypatch.setattr(chrome, '_chrome_endpoints', {})
        monkeypatch.setattr(chrome, 'terminate_owned_process', terminate)
        def cleanup(worker):
            chrome.cleanup_workers((worker,))

        registry = chrome._chrome_procs
    else:
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {1: first, 2: peer, 3: control})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {wid: (proc, proc.pid) for wid, proc in claude_code_cli._ACTIVE_CLAUDE_PROCS.items()})
        monkeypatch.setattr(process_ownership, 'terminate_owned_process', terminate)
        def cleanup(worker):
            claude_code_cli.kill_active_claude_processes(worker_ids=(worker,))

        registry = claude_code_cli._ACTIVE_CLAUDE_PROCS

    def first_cleanup():
        try:
            cleanup(1)
        except Exception as exc:
            failures.append(str(exc))

    def peer_cleanup():
        try:
            cleanup(2)
            peer_finished.set()
        except Exception as exc:
            failures.append(f'peer: {exc}')

    owner, other = threading.Thread(target=first_cleanup), threading.Thread(target=peer_cleanup)
    owner.start()
    try:
        assert entered.wait(1)
        other.start()
        assert peer_finished.wait(1), 'unrelated cleanup waited for the first owner'
        assert registry == {1: first, 3: control}
    finally:
        release.set()
        owner.join(timeout=2)
        if other.ident is not None:
            other.join(timeout=2)
    assert not owner.is_alive() and not other.is_alive()
    assert len(failures) == 1 and not failures[0].startswith('peer:')
    assert registry == {1: first, 3: control}


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
def test_concurrent_cleanup_of_same_handle_is_serialized(monkeypatch, adapter):
    process = SyntheticProcess(9001, live=True)
    entered, release = threading.Event(), threading.Event()
    calls, errors = [], []

    def terminate(owned, *, launched_pid):
        assert owned is process and launched_pid == process.pid
        calls.append(owned)
        entered.set()
        assert release.wait(2)

    if adapter == 'browser':
        monkeypatch.setattr(chrome, '_chrome_procs', {1: process})
        monkeypatch.setattr(chrome, '_chrome_identities', {1: (process, process.pid)})
        monkeypatch.setattr(chrome, '_chrome_endpoints', {})
        monkeypatch.setattr(chrome, 'terminate_owned_process', terminate)
        def cleanup():
            chrome.cleanup_worker(1, process)

        registry = chrome._chrome_procs
    else:
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {1: process})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {1: (process, process.pid)})
        monkeypatch.setattr(process_ownership, 'terminate_owned_process', terminate)
        def cleanup():
            claude_code_cli.kill_active_claude_processes(worker_ids=(1,))

        registry = claude_code_cli._ACTIVE_CLAUDE_PROCS

    def invoke():
        try:
            cleanup()
        except Exception as exc:
            errors.append(str(exc))

    first, second = threading.Thread(target=invoke), threading.Thread(target=invoke)
    first.start()
    try:
        assert entered.wait(1)
        second.start()
        second.join(timeout=.1)
        assert second.is_alive()
        assert calls == [process]
    finally:
        release.set()
        first.join(timeout=2)
        if second.ident is not None:
            second.join(timeout=2)
    assert not first.is_alive() and not second.is_alive()
    assert not errors and calls == [process] and not registry


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
def test_waiting_cleanup_never_signals_a_replacement_handle(monkeypatch, adapter):
    first, replacement = SyntheticProcess(9001, live=True), SyntheticProcess(9002, live=True)
    guard_observed = threading.Event()
    errors, signals = [], []

    def terminate(process, *, launched_pid):
        signals.append((process, launched_pid))

    if adapter == 'browser':
        monkeypatch.setattr(chrome, '_chrome_procs', {1: first})
        monkeypatch.setattr(chrome, '_chrome_identities', {1: (first, first.pid)})
        monkeypatch.setattr(chrome, '_chrome_endpoints', {})
        monkeypatch.setattr(chrome, 'terminate_owned_process', terminate)
        guard = chrome._chrome_worker_guard(1)
        original_guard = chrome._chrome_worker_guard

        def observed_guard(worker_id):
            result = original_guard(worker_id)
            guard_observed.set()
            return result

        monkeypatch.setattr(chrome, '_chrome_worker_guard', observed_guard)

        def cleanup():
            chrome.cleanup_worker(1, first)

        def replace():
            with chrome._chrome_lock:
                chrome._chrome_procs[1] = replacement
                chrome._chrome_identities[1] = (replacement, replacement.pid)

        registry = chrome._chrome_procs
    else:
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {1: first})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {1: (first, first.pid)})
        monkeypatch.setattr(process_ownership, 'terminate_owned_process', terminate)
        guard = claude_code_cli._agent_worker_guard(1)
        original_guard = claude_code_cli._agent_worker_guard

        def observed_guard(worker_id):
            result = original_guard(worker_id)
            guard_observed.set()
            return result

        monkeypatch.setattr(claude_code_cli, '_agent_worker_guard', observed_guard)

        def cleanup():
            claude_code_cli.kill_active_claude_processes(worker_ids=(1,))

        def replace():
            with claude_code_cli._ACTIVE_CLAUDE_LOCK:
                claude_code_cli._ACTIVE_CLAUDE_PROCS[1] = replacement
                claude_code_cli._ACTIVE_CLAUDE_IDENTITIES[1] = (replacement, replacement.pid)

        registry = claude_code_cli._ACTIVE_CLAUDE_PROCS

    def invoke():
        try:
            cleanup()
        except Exception as exc:
            errors.append(str(exc))

    worker = threading.Thread(target=invoke)
    with guard:
        worker.start()
        assert guard_observed.wait(1)
        replace()
    worker.join(timeout=2)
    assert not worker.is_alive()
    assert not signals and registry == {1: replacement}
    if adapter == 'agent':
        assert errors
    else:
        assert not errors


def test_browser_endpoint_is_fenced_while_its_termination_is_in_progress(monkeypatch):
    process = SyntheticProcess(9001, live=True)
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(chrome, '_chrome_procs', {1: process})
    monkeypatch.setattr(chrome, '_chrome_identities', {1: (process, process.pid)})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})

    def terminate(owned, *, launched_pid):
        assert owned is process and launched_pid == process.pid
        entered.set()
        assert release.wait(2)

    monkeypatch.setattr(chrome, 'terminate_owned_process', terminate)
    worker = threading.Thread(target=lambda: chrome.cleanup_worker(1, process))
    worker.start()
    try:
        assert entered.wait(1)
        with chrome._chrome_lock:
            with pytest.raises(chrome.BrowserCapabilityError, match='live Apply browser'):
                chrome._require_live_browser(1, process)
    finally:
        release.set()
        worker.join(timeout=2)
    assert not worker.is_alive()


def test_interrupt_deadline_includes_wait_for_selected_worker_guard(monkeypatch):
    from jobctrl.apply import ownership

    run = ApplyLauncherRun(worker_ids=(101,))
    monkeypatch.setattr(ownership, '_CLEANUP_PASS_TIMEOUT_SECONDS', .1)
    guard = run._worker_cleanup_guard(101)
    entered, release = threading.Event(), threading.Event()

    def occupy():
        with guard:
            entered.set()
            release.wait(2)

    holder = threading.Thread(target=occupy)
    holder.start()
    try:
        assert entered.wait(1)
        assert not run.interrupt()
        assert run.stop_event.is_set() and run._cleanup_error
    finally:
        release.set()
        holder.join(timeout=2)
    assert not holder.is_alive()


def test_interrupt_cleans_available_peer_before_waiting_for_blocked_worker(monkeypatch):
    from jobctrl.apply import ownership

    run = ApplyLauncherRun(worker_ids=(101, 102))
    blocked, peer = SyntheticProcess(9001, live=True), SyntheticProcess(9002, live=True)
    run._birth_processes['blocked'] = (101, blocked, blocked.pid)
    monkeypatch.setattr(ownership, '_CLEANUP_PASS_TIMEOUT_SECONDS', .1)
    monkeypatch.setattr(chrome, '_chrome_procs', {102: peer})
    monkeypatch.setattr(chrome, '_chrome_identities', {102: (peer, peer.pid)})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    signals = []

    original_os = process_ownership.os

    class GuardedOS:
        def __getattr__(self, name):
            return getattr(original_os, name)

        def getpgid(self, pid):
            assert pid == peer.pid
            return pid

        def getsid(self, pid):
            assert pid == peer.pid
            return pid

        def kill(self, pid, sig):
            assert pid == peer.pid and sig == signal.SIGTERM
            signals.append((pid, sig))
            peer.returncode = 0

        def killpg(self, *_args):
            pytest.fail('an unverified group was signaled')

    monkeypatch.setattr(process_ownership, 'os', GuardedOS())
    monkeypatch.setattr(process_ownership, '_waitid_nowait', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(process_ownership, '_read_process_inventory', lambda: ({}, True))
    guard = run._worker_cleanup_guard(101)
    entered, release = threading.Event(), threading.Event()

    def occupy():
        with guard:
            entered.set()
            release.wait(2)

    holder = threading.Thread(target=occupy)
    holder.start()
    try:
        assert entered.wait(1)
        assert not run.interrupt()
        assert signals == [(peer.pid, signal.SIGTERM)]
        assert chrome._chrome_procs == {}
        assert run._birth_processes == {'blocked': (101, blocked, blocked.pid)}
        assert run.stop_event.is_set() and run._cleanup_error
    finally:
        release.set()
        holder.join(timeout=2)
    assert not holder.is_alive()
    assert run._cleanup_failed.is_set() and run._cleanup_error
    blocked.returncode = 0
    assert run.interrupt()
    assert not run._birth_processes and not run._cleanup_failed.is_set()
    assert run._cleanup_error is None and run.stop_event.is_set()
    assert signals == [(peer.pid, signal.SIGTERM)]


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
@pytest.mark.parametrize('winner', ['publication', 'interrupt'])
def test_adapter_publication_and_interrupt_share_the_birth_guard(monkeypatch, adapter, winner):
    import time
    from jobctrl import runtime
    from jobctrl.apply import ownership

    class Journal:
        native_custody = None

        def reserve(self, _worker, _kind):
            return 'birth'

        def record_cleanup_failure(self, _error):
            pass

    process = SyntheticProcess(9001, live=True)
    run = ApplyLauncherRun(worker_ids=(1,))
    run._journal = Journal()
    run._admitted = True
    monkeypatch.setattr(ownership.subprocess, 'Popen', lambda *_args, **_kwargs: process)
    monkeypatch.setattr(runtime, 'is_bundled_runtime', lambda: False)
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(chrome, '_chrome_unpublished', {})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(chrome, '_launching_workers', set())
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_UNPUBLISHED', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_RESERVATIONS', {})
    assert run.spawn(1, adapter, ['synthetic']) is process
    terminating, release = threading.Event(), threading.Event()
    terminated, publication, interruption = [], [], []

    def terminate(owned, *, launched_pid):
        assert owned is process and launched_pid == process.pid
        terminated.append(owned)
        if winner == 'interrupt':
            terminating.set()
            assert release.wait(2)
        owned.returncode = 0

    monkeypatch.setattr(chrome, 'terminate_owned_process', terminate)
    monkeypatch.setattr(process_ownership, 'terminate_owned_process', terminate)
    registry_lock = chrome._chrome_lock if adapter == 'browser' else claude_code_cli._ACTIVE_CLAUDE_LOCK
    registry = chrome._chrome_procs if adapter == 'browser' else claude_code_cli._ACTIVE_CLAUDE_PROCS
    register = chrome._register_owned_browser if adapter == 'browser' else claude_code_cli._register_active_claude_process

    def publish():
        try:
            register(1, process)
            publication.append('published')
        except CustodyUnverified:
            publication.append('refused')

    publisher = threading.Thread(target=publish)
    interrupter = threading.Thread(target=lambda: interruption.append(run.interrupt()))
    guard = run._worker_cleanup_guard(1)
    try:
        if winner == 'publication':
            with registry_lock:
                publisher.start()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if not guard.acquire(blocking=False):
                        break
                    guard.release()
                    time.sleep(.005)
                else:
                    pytest.fail('publication did not acquire its worker guard')
                interrupter.start()
                deadline = time.monotonic() + 2
                while not run._birth_epoch % 2 and time.monotonic() < deadline:
                    time.sleep(.005)
                assert run._birth_epoch % 2
        else:
            interrupter.start()
            assert terminating.wait(2)
            publisher.start()
            publisher.join(timeout=.1)
            assert publisher.is_alive()
            release.set()
        publisher.join(timeout=3)
        interrupter.join(timeout=3)
        assert not publisher.is_alive() and not interrupter.is_alive()
        assert publication == (['published'] if winner == 'publication' else ['refused'])
        assert interruption == [True] and terminated == [process]
        assert not registry and not run._birth_processes
    finally:
        release.set()
        if publisher.ident is not None:
            publisher.join(timeout=2)
        if interrupter.ident is not None:
            interrupter.join(timeout=2)


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
def test_failed_standalone_publication_retains_new_child_without_replacing_owner(monkeypatch, tmp_path, adapter):
    from jobctrl.apply import ownership
    from jobctrl.domain.apply.value_objects import ApplyPrompt, BrowserWorkerConfig
    from jobctrl.domain.ports.apply import BrowserSession

    prior, unpublished = SyntheticProcess(9001, live=True), SyntheticProcess(9002, live=True)
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(chrome, '_chrome_unpublished', {})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_UNPUBLISHED', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_RESERVATIONS', {})
    calls = []

    def spawn(worker_id, _kind, _command, **_kwargs):
        assert worker_id == 1
        if adapter == 'browser':
            with chrome._chrome_lock:
                chrome._chrome_procs[1] = prior
                chrome._chrome_identities[1] = (prior, prior.pid)
        else:
            with claude_code_cli._ACTIVE_CLAUDE_LOCK:
                claude_code_cli._ACTIVE_CLAUDE_PROCS[1] = prior
                claude_code_cli._ACTIVE_CLAUDE_IDENTITIES[1] = (prior, prior.pid)
        return unpublished

    def refuse(process, *, launched_pid):
        calls.append((process, launched_pid))
        assert process is unpublished and launched_pid == unpublished.pid
        raise process_ownership.ProcessOwnershipError('synthetic cleanup refusal')

    monkeypatch.setattr(ownership, 'spawn_owned_apply_process', spawn)
    monkeypatch.setattr(chrome, 'terminate_owned_process', refuse)
    monkeypatch.setattr(process_ownership, 'terminate_owned_process', refuse)
    if adapter == 'browser':
        monkeypatch.setattr(chrome, 'setup_worker_profile', lambda _worker: tmp_path)
        monkeypatch.setattr(chrome, '_suppress_restore_nag', lambda _path: None)
        with pytest.raises(process_ownership.ProcessOwnershipError, match='synthetic cleanup refusal'):
            chrome._launch_chrome_owned(1, None, True, True, chrome_exe='synthetic',
                                        approved_application_url='https://example.test/apply')
        assert chrome._chrome_procs == {1: prior}
        assert chrome._chrome_unpublished == {1: [(unpublished, unpublished.pid)]}
        retry = chrome._cleanup_unpublished_browser
    else:
        from jobctrl import llm
        monkeypatch.setattr(llm, 'enforce_spend_budget', lambda *_args, **_kwargs: None)
        monkeypatch.setattr(claude_code_cli, 'resolve_claude_apply_binary', lambda: '/synthetic/claude')
        monkeypatch.setattr(claude_code_cli, '_claude_supports_budget_flag', lambda *_args, **_kwargs: False)
        monkeypatch.setattr(claude_code_cli, '_apply_subprocess_env', lambda: {})
        session = BrowserSession(config=BrowserWorkerConfig(worker_id=1, cdp_port=1, headless=True),
                                 pid=1, worker_dir=str(tmp_path / 'worker'))
        with pytest.raises(process_ownership.ProcessOwnershipError, match='synthetic cleanup refusal'):
            claude_code_cli.ClaudeCodeCliAdapter(log_dir=tmp_path, app_dir=tmp_path).submit_application(
                prompt=ApplyPrompt(text='synthetic', mcp_config={}), browser=session, model='default', dry_run=True,
            )
        assert claude_code_cli._ACTIVE_CLAUDE_PROCS == {1: prior}
        assert claude_code_cli._ACTIVE_CLAUDE_UNPUBLISHED == {1: [(unpublished, unpublished.pid)]}
        assert not claude_code_cli._ACTIVE_CLAUDE_LAUNCHING and not claude_code_cli._ACTIVE_CLAUDE_RESERVATIONS
        retry = claude_code_cli._cleanup_unpublished_agent
    assert calls == [(unpublished, unpublished.pid)]

    def settle(process, *, launched_pid):
        assert process is unpublished and launched_pid == unpublished.pid
        process.returncode = 0

    monkeypatch.setattr(chrome, 'terminate_owned_process', settle)
    monkeypatch.setattr(process_ownership, 'terminate_owned_process', settle)
    assert retry(1) == []
    assert (chrome._chrome_procs if adapter == 'browser' else claude_code_cli._ACTIVE_CLAUDE_PROCS) == {1: prior}
    assert not (chrome._chrome_unpublished if adapter == 'browser' else claude_code_cli._ACTIVE_CLAUDE_UNPUBLISHED)


def test_existing_standalone_agent_owner_refuses_before_new_spawn(monkeypatch, tmp_path):
    from jobctrl import llm
    from jobctrl.apply import ownership
    from jobctrl.domain.apply.value_objects import ApplyPrompt, BrowserWorkerConfig
    from jobctrl.domain.ports.apply import BrowserSession

    prior = SyntheticProcess(9001, live=True)
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {1: prior})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {1: (prior, prior.pid)})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_UNPUBLISHED', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_RESERVATIONS', {})
    monkeypatch.setattr(ownership, 'spawn_owned_apply_process', lambda *_args, **_kwargs: pytest.fail('unexpected spawn'))
    monkeypatch.setattr(llm, 'enforce_spend_budget', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(claude_code_cli, 'resolve_claude_apply_binary', lambda: '/synthetic/claude')
    monkeypatch.setattr(claude_code_cli, '_claude_supports_budget_flag', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(claude_code_cli, '_apply_subprocess_env', lambda: {})
    config_path = tmp_path / '.mcp-apply-1.json'
    config_path.write_bytes(b'accepted synthetic configuration')
    session = BrowserSession(config=BrowserWorkerConfig(worker_id=1, cdp_port=1, headless=True),
                             pid=1, worker_dir=str(tmp_path / 'worker'))
    with pytest.raises(process_ownership.ProcessOwnershipError, match='already has an owner'):
        claude_code_cli.ClaudeCodeCliAdapter(log_dir=tmp_path, app_dir=tmp_path).submit_application(
            prompt=ApplyPrompt(text='synthetic', mcp_config={}), browser=session, model='default', dry_run=True,
        )
    assert claude_code_cli._ACTIVE_CLAUDE_PROCS == {1: prior}
    assert not claude_code_cli._ACTIVE_CLAUDE_UNPUBLISHED and not claude_code_cli._ACTIVE_CLAUDE_RESERVATIONS
    assert config_path.read_bytes() == b'accepted synthetic configuration'


def test_agent_reservation_survives_unregister_until_config_unlink(monkeypatch, tmp_path):
    import io
    from pathlib import Path
    from jobctrl import llm
    from jobctrl.apply import ownership
    from jobctrl.domain.apply.value_objects import ApplyPrompt, BrowserWorkerConfig
    from jobctrl.domain.ports.apply import BrowserSession

    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_UNPUBLISHED', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_RESERVATIONS', {})
    monkeypatch.setattr(llm, 'enforce_spend_budget', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(claude_code_cli, 'resolve_claude_apply_binary', lambda: '/synthetic/claude')
    monkeypatch.setattr(claude_code_cli, '_claude_supports_budget_flag', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(claude_code_cli, '_apply_subprocess_env', lambda: {})
    monkeypatch.setattr(process_ownership, 'terminate_owned_process', lambda *_args, **_kwargs: None)
    spawned = []

    class FailingInput:
        def write(self, _value):
            raise RuntimeError('synthetic input failure')

    def spawn(*_args, **_kwargs):
        process = SyntheticProcess(9001 + len(spawned), live=True)
        process.stdin = FailingInput()
        process.stdout = io.StringIO('')
        spawned.append(process)
        return process

    monkeypatch.setattr(ownership, 'spawn_owned_apply_process', spawn)
    config_path = tmp_path / '.mcp-apply-1.json'
    unlink_entered, release = threading.Event(), threading.Event()
    original_unlink = Path.unlink
    unlink_calls = []

    def unlink(path, *args, **kwargs):
        if path == config_path:
            unlink_calls.append(path)
            if len(unlink_calls) == 1:
                unlink_entered.set()
                assert release.wait(2)
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'unlink', unlink)
    session = BrowserSession(config=BrowserWorkerConfig(worker_id=1, cdp_port=1, headless=True),
                             pid=1, worker_dir=str(tmp_path / 'worker'))
    adapter = claude_code_cli.ClaudeCodeCliAdapter(log_dir=tmp_path, app_dir=tmp_path)
    first_errors = []

    def first():
        try:
            adapter.submit_application(prompt=ApplyPrompt(text='first', mcp_config={'marker': 'first'}),
                                       browser=session, model='default', dry_run=True)
        except Exception as exc:
            first_errors.append(str(exc))

    worker = threading.Thread(target=first)
    worker.start()
    try:
        assert unlink_entered.wait(2)
        assert not claude_code_cli._ACTIVE_CLAUDE_PROCS
        assert 1 in claude_code_cli._ACTIVE_CLAUDE_RESERVATIONS
        accepted = config_path.read_bytes()
        with pytest.raises(process_ownership.ProcessOwnershipError, match='already has an owner'):
            adapter.submit_application(prompt=ApplyPrompt(text='second', mcp_config={'marker': 'second'}),
                                       browser=session, model='default', dry_run=True)
        assert config_path.read_bytes() == accepted
        assert len(spawned) == 1
    finally:
        release.set()
        worker.join(timeout=2)
    assert not worker.is_alive() and first_errors == ['synthetic input failure']
    assert not config_path.exists() and not claude_code_cli._ACTIVE_CLAUDE_RESERVATIONS
    with pytest.raises(RuntimeError, match='synthetic input failure'):
        adapter.submit_application(prompt=ApplyPrompt(text='later', mcp_config={'marker': 'later'}),
                                   browser=session, model='default', dry_run=True)
    assert len(spawned) == 2 and not config_path.exists()


def test_interrupt_can_complete_while_joined_agents_file_reservation_remains(monkeypatch):
    process = SyntheticProcess(9001, live=True)
    token = object()
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(chrome, '_chrome_unpublished', {})
    monkeypatch.setattr(chrome, '_launching_workers', set())
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {1: process})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {1: (process, process.pid)})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_UNPUBLISHED', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_RESERVATIONS', {1: token})
    terminated = []

    def terminate(owned, *, launched_pid):
        assert owned is process and launched_pid == process.pid
        terminated.append(owned)
        owned.returncode = 0

    monkeypatch.setattr(process_ownership, 'terminate_owned_process', terminate)
    run = ApplyLauncherRun(worker_ids=(1,))
    assert run.interrupt()
    assert not run.stop_event.is_set() and run._cleanup_error is None
    assert not claude_code_cli._ACTIVE_CLAUDE_PROCS
    assert claude_code_cli._ACTIVE_CLAUDE_RESERVATIONS == {1: token}
    claude_code_cli._kill_process_tree_if_alive(process)
    claude_code_cli._unregister_active_claude_process(1, process)
    assert terminated == [process]


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
def test_all_handle_cleanup_reports_an_in_progress_launch(monkeypatch, adapter):
    if adapter == 'browser':
        monkeypatch.setattr(chrome, '_chrome_procs', {})
        monkeypatch.setattr(chrome, '_chrome_identities', {})
        monkeypatch.setattr(chrome, '_chrome_unpublished', {})
        monkeypatch.setattr(chrome, '_launching_workers', {1})
        with pytest.raises(chrome.BrowserCapabilityError, match='could not verify'):
            chrome.kill_all_chrome()
        chrome._launching_workers.clear()
        chrome.kill_all_chrome()
    else:
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_UNPUBLISHED', {})
        token = object()
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {1: token})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_RESERVATIONS', {1: token})
        with pytest.raises(RuntimeError, match='could not verify'):
            claude_code_cli.kill_active_claude_processes()
        claude_code_cli._ACTIVE_CLAUDE_LAUNCHING.clear()
        claude_code_cli._ACTIVE_CLAUDE_RESERVATIONS.clear()
        claude_code_cli.kill_active_claude_processes()


@pytest.mark.parametrize('adapter', ['browser', 'agent'])
def test_run_owned_publication_conflict_retains_both_exact_handles(monkeypatch, adapter):
    from jobctrl.apply import ownership

    class Journal:
        native_custody = None

        def reserve(self, _worker, _kind):
            return 'birth'

    prior, unpublished = SyntheticProcess(9001, live=True), SyntheticProcess(9002, live=True)
    run = ApplyLauncherRun(worker_ids=(1,))
    run._journal = Journal()
    run._admitted = True
    monkeypatch.setattr(ownership.subprocess, 'Popen', lambda *_args, **_kwargs: unpublished)
    assert run.spawn(1, adapter, ['synthetic']) is unpublished
    if adapter == 'browser':
        monkeypatch.setattr(chrome, '_chrome_procs', {1: prior})
        monkeypatch.setattr(chrome, '_chrome_identities', {1: (prior, prior.pid)})
        register = chrome._register_owned_browser
        registry = chrome._chrome_procs
        expected = chrome.BrowserCapabilityError
    else:
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', {1: prior})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {1: (prior, prior.pid)})
        monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_LAUNCHING', {})
        register = claude_code_cli._register_active_claude_process
        registry = claude_code_cli._ACTIVE_CLAUDE_PROCS
        expected = process_ownership.ProcessOwnershipError
    with pytest.raises(expected, match='Cannot replace'):
        register(1, unpublished)
    assert registry == {1: prior}
    assert run._birth_processes == {'birth': (1, unpublished, unpublished.pid)}
    assert prior.poll() is None and unpublished.poll() is None


def test_cleanup_preserves_reaped_birth_registered_after_snapshot(monkeypatch):
    """A late process needs its own proof even if an earlier sibling settled."""
    from jobctrl import runtime

    run = ApplyLauncherRun(worker_ids=(1,))
    first, late = SyntheticProcess(9001), SyntheticProcess(9002)
    run._birth_processes['first'] = (1, first, first.pid)
    inserted = threading.Event()
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', lambda **_: None)
    monkeypatch.setattr(runtime, 'is_bundled_runtime', lambda: True)

    def add_late_birth():
        with run._lock:
            run._birth_processes['late'] = (1, late, late.pid)
        inserted.set()

    worker = threading.Thread(target=add_late_birth)

    def settle(process, *, launched_pid):
        assert process is first and launched_pid == first.pid
        worker.start()
        assert inserted.wait(2)

    monkeypatch.setattr(process_ownership, 'terminate_owned_process', settle)
    with pytest.raises(ApplyLauncherCleanupIncomplete):
        run.verify_worker_cleanup(1)
    worker.join(timeout=2)
    assert not worker.is_alive()
    assert run.stop_event.is_set()
    assert run._birth_processes == {'first': (1, first, first.pid), 'late': (1, late, late.pid)}


@pytest.mark.parametrize('late_worker', [1, 3])
def test_interrupt_refuses_birth_registered_after_an_earlier_worker_was_checked(monkeypatch, late_worker):
    run = ApplyLauncherRun(worker_ids=(1, 2))
    late = SyntheticProcess(9003, live=True)
    monkeypatch.setattr(chrome, '_chrome_procs', {})
    monkeypatch.setattr(chrome, '_chrome_identities', {})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    inserted = []

    def clean_agent(*, worker_ids):
        if worker_ids == (2,):
            with run._lock:
                if late_worker == 3:
                    run.worker_ids += (3,)
                run._birth_processes['late'] = (late_worker, late, late.pid)
                inserted.append(late)

    monkeypatch.setattr(claude_code_cli, 'kill_active_claude_processes', clean_agent)
    monkeypatch.setattr(process_ownership.os, 'kill', lambda *_: pytest.fail('late birth signaled'))
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *_: pytest.fail('late birth signaled'))
    assert run.interrupt() is False
    assert inserted == [late]
    assert run.stop_event.is_set() and run._cleanup_error
    assert run._birth_processes == {'late': (late_worker, late, late.pid)}


def test_interrupt_fences_birth_before_return_then_reopens_admission(monkeypatch, tmp_path):
    run = ApplyLauncherRun(worker_ids=(1,))
    at_return, release = threading.Event(), threading.Event()
    result = []

    class FailureFlag:
        def __init__(self):
            self.flag = threading.Event()
            self.reads = 0

        def clear(self):
            self.flag.clear()

        def set(self):
            self.flag.set()

        def is_set(self):
            self.reads += 1
            if self.reads == 1:
                at_return.set()
                assert release.wait(2)
            return self.flag.is_set()

    class Journal:
        native_custody = None

        def reserve(self, _worker, _kind):
            return 'new-birth'

        def record_cleanup_failure(self, _error):
            pass

    run._cleanup_failed = FailureFlag()
    run._journal = Journal()
    run._admitted = True
    monkeypatch.setattr(run, '_cleanup_workers_within_budget', lambda _workers: [])
    thread = threading.Thread(target=lambda: result.append(run.interrupt()))
    thread.start()
    try:
        assert at_return.wait(1)
        with pytest.raises(CustodyUnverified, match='interrupted by cleanup'):
            run.spawn(1, 'agent', ['/unused/synthetic-executable'])
    finally:
        release.set()
        thread.join(timeout=2)
    assert not thread.is_alive() and result == [True]
    assert not run.stop_event.is_set()
    process = run.spawn(1, 'agent', [sys.executable, '-I', '-B', '-c', 'pass'],
                        start_new_session=True, env={'HOME': str(tmp_path), 'PATH': '/usr/bin:/bin'})
    assert process.wait(timeout=5) == 0
    assert run._birth_processes['new-birth'] == (1, process, process.pid)


def test_many_slow_but_stable_handles_can_all_settle_in_one_pass(clock, monkeypatch):
    workers = tuple(range(1, 17))
    browsers = {wid: SyntheticProcess(9000 + wid) for wid in workers}
    agents = {wid: SyntheticProcess(10000 + wid) for wid in workers}
    monkeypatch.setattr(chrome, '_chrome_procs', browsers.copy())
    monkeypatch.setattr(chrome, '_chrome_identities', {wid: (proc, proc.pid) for wid, proc in browsers.items()})
    monkeypatch.setattr(chrome, '_chrome_endpoints', {})
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_PROCS', agents.copy())
    monkeypatch.setattr(claude_code_cli, '_ACTIVE_CLAUDE_IDENTITIES', {wid: (proc, proc.pid) for wid, proc in agents.items()})
    monkeypatch.setattr(process_ownership.os, 'killpg', lambda *_: pytest.fail('reaped handle signaled'))

    def observe():
        clock.sleep(0.125)
        return inventory(), True

    monkeypatch.setattr(process_ownership, '_read_process_inventory', observe)
    run = ApplyLauncherRun(worker_ids=workers)
    assert run._cleanup_workers(workers) == []
    assert clock.now == pytest.approx(8.64)
    assert chrome._chrome_procs == {}
    assert claude_code_cli._ACTIVE_CLAUDE_PROCS == {}
