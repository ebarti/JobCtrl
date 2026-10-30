"""Authenticated source fleets supply observation context, never completion authority."""

from threading import Lock
from types import SimpleNamespace

import pytest

from jobctrl.apply import native_custody, ownership, process_birth
from jobctrl.infrastructure import process_ownership

from .test_apply_launcher_ownership import owned_runtime as owned_runtime
from .test_apply_source_lifetime import _synthetic_runtime_scope


def test_source_fleet_binds_census_only_to_its_exact_spawn(owned_runtime, monkeypatch, tmp_path):
    app, _, _ = owned_runtime
    scope, _ = _synthetic_runtime_scope(app, tmp_path, monkeypatch)
    monkeypatch.setattr(process_birth, "boot_identity", lambda: scope["bootSession"])
    process = SimpleNamespace(pid=12345, returncode=None, _waitpid_lock=Lock())
    seen = []
    monkeypatch.setattr(ownership.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(native_custody, "_source_child_in_scope",
                        lambda child, coalitions: seen.append((child, coalitions)) or True, raising=False)

    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        assert owner._journal.native_custody is None
        assert owner._journal.value["source_best_effort"] is True
        assert owner.spawn(1, "agent", ["synthetic"], start_new_session=True) is process
        assert seen == [(process, (11, 22))]
        assert process._jobctrl_birth_source_coalitions == (11, 22)
        assert not hasattr(process, "_jobctrl_birth_coalitions")


@pytest.mark.parametrize("options", [{}, {"start_new_session": False},
                                      {"start_new_session": True, "preexec_fn": lambda: None}])
def test_source_scope_never_fences_an_unverified_birth(owned_runtime, monkeypatch, tmp_path, options):
    app, _, _ = owned_runtime
    scope, _ = _synthetic_runtime_scope(app, tmp_path, monkeypatch)
    monkeypatch.setattr(process_birth, "boot_identity", lambda: scope["bootSession"])
    process = SimpleNamespace(pid=12345, returncode=None, _waitpid_lock=Lock())
    monkeypatch.setattr(ownership.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(native_custody, "_source_child_in_scope", lambda *_: pytest.fail("unverified birth admitted"))

    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        owner.spawn(1, "agent", ["synthetic"], **options)
        assert not hasattr(process, "_jobctrl_birth_source_coalitions")


def test_source_scope_requires_matching_parent_before_spawn(owned_runtime, monkeypatch, tmp_path):
    app, _, _ = owned_runtime
    scope, _ = _synthetic_runtime_scope(app, tmp_path, monkeypatch)
    monkeypatch.setattr(process_birth, "boot_identity", lambda: scope["bootSession"])
    process = SimpleNamespace(pid=12345, returncode=None, _waitpid_lock=Lock())
    monkeypatch.setattr(ownership.subprocess, "Popen", lambda *_args, **_kwargs: process)
    owner = ownership.ApplyLauncherRun()
    with owner.lease():
        monkeypatch.setattr(native_custody, "_current_coalitions", lambda: [11, 23])
        monkeypatch.setattr(native_custody, "_source_child_in_scope", lambda *_: pytest.fail("foreign parent admitted"))
        owner.spawn(1, "agent", ["synthetic"], start_new_session=True)
        assert not hasattr(process, "_jobctrl_birth_source_coalitions")


@pytest.mark.parametrize("fault", ["none", "foreign_child", "changed_child", "changed_parent", "session",
                                    "group", "exited", "exited_after", "reaped_or_reused", "missing_lock",
                                    "unavailable", "not_darwin"])
def test_source_scope_fence_requires_exact_live_child(monkeypatch, fault):
    process = SimpleNamespace(pid=12345, returncode=None, _waitpid_lock=Lock())
    parent = iter(([11, 22], [11, 23] if fault == "changed_parent" else [11, 22]))
    child = iter(([11, 23] if fault == "foreign_child" else [11, 22],
                  [11, 23] if fault == "changed_child" else [11, 22]))
    events = iter((None, object() if fault == "exited_after" else None))
    monkeypatch.setattr(native_custody, "platform", SimpleNamespace(system=lambda: "Linux" if fault == "not_darwin" else "Darwin"))
    monkeypatch.setattr(native_custody, "_current_coalitions", lambda: next(parent))

    def child_scope(pid):
        assert pid == process.pid and process._waitpid_lock.locked()
        if fault == "unavailable":
            raise native_custody.CustodyUnverified("unavailable")
        return next(child)

    monkeypatch.setattr(native_custody, "_process_coalitions", child_scope)
    monkeypatch.setattr(native_custody, "_child_session_group",
                        lambda pid: (pid + (fault == "session"), pid + (fault == "group")))

    def inspect(pid):
        assert pid == process.pid and process._waitpid_lock.locked()
        if fault == "reaped_or_reused":
            raise ChildProcessError("original child is no longer waitable")
        return next(events)

    monkeypatch.setattr(process_ownership, "_waitid_nowait", inspect)
    if fault == "exited":
        process.returncode = -15
    elif fault == "missing_lock":
        del process._waitpid_lock
    assert native_custody._source_child_in_scope(process, (11, 22)) is (fault == "none")


def test_source_scoped_session_proof_ignores_unrelated_host_churn(monkeypatch):
    counts = iter(((10, 2), (10, 2), (10, 2), (10, 2)))
    inventories = iter((({50: ((1, 1), 50, True, 50)}, True),
                        ({51: ((2, 1), 51, True, 51)}, True)))
    calls = []
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: next(counts))
    monkeypatch.setattr(process_ownership, "_read_process_inventory",
                        lambda **kwargs: calls.append(kwargs) or next(inventories))
    process_ownership._wait_for_session_exit(123, native_coalitions=(11, 22))
    process_ownership._wait_for_session_exit(123, native_coalitions=(11, 22))
    assert calls == [{"native_scope": (11, 8)}, {"native_scope": (11, 8)}]


@pytest.mark.parametrize("fault", ["fork", "incomplete", "surviving_session_member"])
def test_source_scoped_session_proof_refuses_relevant_uncertainty(monkeypatch, fault):
    counts = iter(((10, 2), (11, 2) if fault == "fork" else (10, 2)))
    inventory = {123: ((99, 2), 123, True, 123)} if fault == "surviving_session_member" else {}
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: next(counts))
    monkeypatch.setattr(process_ownership, "_read_process_inventory", lambda **_: (inventory, fault != "incomplete"))
    with pytest.raises(process_ownership.ProcessOwnershipError):
        process_ownership._wait_for_session_exit(123, native_coalitions=(11, 22), timeout_seconds=0)


def test_source_scoped_census_rejects_pid_generation_reuse(monkeypatch):
    import ctypes

    class Function:
        identity_reads = 0

        def __call__(self, pid, flavor, _arg, pointer, _size):
            info = pointer._obj
            if flavor == 17:
                self.identity_reads += 1
                info.unique_id, info.pid_version = 42, self.identity_reads
            elif flavor == 13:
                info.pid, info.pgid, info.state = pid, pid, 1
            elif flavor == 20:
                info.ids[0] = 11
            return ctypes.sizeof(info)

    library = SimpleNamespace(proc_listpids=Function(), proc_pidinfo=Function())
    monkeypatch.setattr(ctypes, "CDLL", lambda *_args, **_kwargs: library)
    monkeypatch.setattr(process_ownership, "_darwin_process_ids", lambda _: {123})
    monkeypatch.setattr(process_ownership, "os", SimpleNamespace(getsid=lambda _pid: 123))
    inventory, complete = process_ownership._darwin_process_inventory(native_scope=(11, 1))
    assert inventory == {} and complete is False


def test_source_scope_missing_counter_requires_two_strict_matching_censuses(monkeypatch):
    first = {50: ((1, 1), 50, True, 50)}
    changed = {51: ((2, 1), 51, True, 51)}
    samples = iter(((first, True), (changed, True), (changed, True)))
    calls = []
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: None)
    monkeypatch.setattr(process_ownership, "_read_process_inventory", lambda **kwargs: calls.append(kwargs) or next(samples))
    monkeypatch.setattr(process_ownership.time, "sleep", lambda _: None)
    process_ownership._wait_for_session_exit(123, native_coalitions=(11, 22))
    assert calls == [{}, {}, {}]


@pytest.mark.parametrize("scope", ["source", "native"])
def test_source_fence_failure_retains_original_strict_retry(monkeypatch, scope):
    class OwnedChild:
        pid = 123
        returncode = None
        _waitpid_lock = Lock()

        def wait(self, timeout):
            self.returncode = -15
            return self.returncode

    child = OwnedChild()
    setattr(child, "_jobctrl_birth_source_coalitions" if scope == "source" else "_jobctrl_birth_coalitions", (11, 22))
    signals, calls = [], []
    fake_os = SimpleNamespace(getpgid=lambda pid: pid, getsid=lambda pid: pid,
                              kill=lambda pid, sig: signals.append((pid, sig)),
                              killpg=lambda *_: pytest.fail("unverified group was signalled"))
    monkeypatch.setattr(process_ownership, "os", fake_os)
    monkeypatch.setattr(process_ownership, "platform", SimpleNamespace(system=lambda: "Darwin"))
    monkeypatch.setattr(process_ownership, "_waitid_nowait", lambda _pid: None)
    monkeypatch.setattr(process_ownership, "_PROCESS_TERMINATION_GRACE_SECONDS", 0)

    def wait_for_exit(_pid, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise process_ownership.ProcessOwnershipError("census unavailable")

    monkeypatch.setattr(process_ownership, "_wait_for_session_exit", wait_for_exit)
    if scope == "native":
        with pytest.raises(process_ownership.ProcessOwnershipError, match="census unavailable"):
            process_ownership.terminate_owned_process(child, launched_pid=child.pid)
        assert len(calls) == 1
    else:
        process_ownership.terminate_owned_process(child, launched_pid=child.pid)
        assert len(calls) == 3 and calls[1]["stop_on_verified_group"] is True
        assert "native_coalitions" not in calls[1] and calls[2]["native_coalitions"] == (11, 22)
        assert child.returncode == -15
    assert len(signals) == 1 and signals[0][0] == child.pid
