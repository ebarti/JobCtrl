"""Failure-path unit checks for the native session census fence.

Native membership and process handoffs are exercised separately with actual
owned processes; the values below only exercise the verifier's control flow.
"""

import pytest

from jobctrl.infrastructure import process_ownership


@pytest.mark.parametrize('denied_call', [1, 2])
def test_darwin_process_list_reports_explicit_permission_denial(denied_call):
    import ctypes
    import errno
    from types import SimpleNamespace

    calls = []

    def list_pids(*_args):
        calls.append(1)
        if len(calls) == denied_call:
            ctypes.set_errno(errno.EPERM)
            return 0
        return ctypes.sizeof(ctypes.c_int)

    with pytest.raises(process_ownership.ProcessInspectionDenied, match='denied a process inspection'):
        process_ownership._darwin_process_ids(SimpleNamespace(proc_listpids=list_pids))


@pytest.mark.parametrize('expected_tasks', [1, 2])
def test_scoped_census_reports_denial_only_when_scope_cannot_be_accounted(monkeypatch, expected_tasks):
    import ctypes
    import errno
    from types import SimpleNamespace

    class Function:
        def __call__(self, pid, flavor, _arg, pointer, _size):
            if pid == 1:
                ctypes.set_errno(errno.EACCES)
                return 0
            info = pointer._obj
            if flavor == 17:
                info.unique_id, info.pid_version = 22, 1
            elif flavor == 13:
                info.pid, info.pgid, info.state = pid, pid, 1
            elif flavor == 20:
                info.ids[0] = 42
            return ctypes.sizeof(info)

    library = SimpleNamespace(proc_listpids=Function(), proc_pidinfo=Function())
    monkeypatch.setattr(ctypes, 'CDLL', lambda *_args, **_kwargs: library)
    monkeypatch.setattr(process_ownership, '_darwin_process_ids', lambda _: {1, 2})
    monkeypatch.setattr(process_ownership, 'os', SimpleNamespace(getsid=lambda _pid: 123))
    if expected_tasks == 2:
        with pytest.raises(process_ownership.ProcessInspectionDenied, match='denied a process inspection'):
            process_ownership._darwin_process_inventory(native_scope=(42, expected_tasks))
    else:
        inventory, complete = process_ownership._darwin_process_inventory(native_scope=(42, expected_tasks))
        assert complete and set(inventory) == {2}


def test_native_census_rejects_a_fork_during_an_empty_observation(monkeypatch):
    counts = iter(((10, 2), (11, 2)))
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: next(counts))
    monkeypatch.setattr(process_ownership, "_read_process_inventory", lambda **_: ({}, True))
    monkeypatch.setattr(process_ownership, "_SESSION_EXIT_TIMEOUT_SECONDS", 0)

    with pytest.raises(process_ownership.ProcessOwnershipError, match="ownership retained"):
        process_ownership._wait_for_session_exit(123, native_coalitions=(10, 11))


@pytest.mark.parametrize("counts,complete", [(((10, 2), (10, 3)), True), (((10, 2), (10, 2)), False)])
def test_native_census_refuses_changed_or_unaccounted_owned_tasks(monkeypatch, counts, complete):
    readings = iter(counts)
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: next(readings))
    monkeypatch.setattr(process_ownership, "_read_process_inventory", lambda **_: ({}, complete))
    monkeypatch.setattr(process_ownership, "_SESSION_EXIT_TIMEOUT_SECONDS", 0)

    with pytest.raises(process_ownership.ProcessOwnershipError, match="ownership retained"):
        process_ownership._wait_for_session_exit(123, native_coalitions=(10, 11))


def test_missing_native_fence_keeps_the_strict_inventory_proof(monkeypatch):
    old = {1: ((1,), 2, True, 2)}
    changed = {1: ((2,), 2, True, 2)}
    samples = iter(((old, True), (changed, True), (changed, True)))
    calls = []
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: None)

    def read(**kwargs):
        calls.append(kwargs)
        return next(samples)

    monkeypatch.setattr(process_ownership, "_read_process_inventory", read)
    monkeypatch.setattr(process_ownership.time, "sleep", lambda _: None)
    process_ownership._wait_for_session_exit(123, native_coalitions=(10, 11))

    assert calls == [{}, {}, {}]


def test_failed_second_fence_cannot_reuse_a_relaxed_inventory(monkeypatch):
    counts = iter(((10, 2), None, None, None, None, None))
    # The relaxed first observation is identical to the next strict one. It
    # must not count as one half of the strict fallback's two observations.
    sample = {1: ((1,), 2, True, 2)}
    calls = []
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: next(counts))

    def read(**kwargs):
        calls.append(kwargs)
        return sample, True

    monkeypatch.setattr(process_ownership, "_read_process_inventory", read)
    monkeypatch.setattr(process_ownership.time, "sleep", lambda _: None)
    process_ownership._wait_for_session_exit(123, native_coalitions=(10, 11))

    assert calls == [{"native_scope": (10, 8)}, {}, {}]


@pytest.mark.parametrize("complete,after,pgid,verified", [
    (True, (10, 2), 123, True),
    (False, (10, 2), 123, False),
    (True, (11, 2), 123, False),
    (True, (10, 2), 456, False),
])
def test_only_a_fenced_live_launch_group_authorizes_escalation(monkeypatch, complete, after, pgid, verified):
    readings = iter(((10, 2), after))
    monkeypatch.setattr(process_ownership, "_native_coalition_counts", lambda _: next(readings))
    monkeypatch.setattr(
        process_ownership, "_read_process_inventory",
        lambda **_: ({321: ((1,), 123, True, pgid)}, complete),
    )
    with pytest.raises(process_ownership.ProcessOwnershipError) as caught:
        process_ownership._wait_for_session_exit(123, native_coalitions=(10, 11), timeout_seconds=0)
    assert isinstance(caught.value, process_ownership._VerifiedLaunchGroupOccupied) is verified
