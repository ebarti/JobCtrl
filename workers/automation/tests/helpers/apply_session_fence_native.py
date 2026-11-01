"""Exercise a real fork handoff inside the authenticated native Apply scope."""

from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def exercise_once(directory: Path) -> None:
    # One actual Apply invocation performs the probe; concurrent peers skip it.
    try:
        fd = os.open(directory / "handoff-claimed", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return
    os.close(fd)
    from jobctrl import config
    from jobctrl.apply.native_custody import _current_coalitions, capture_native_custody
    from jobctrl.infrastructure import process_ownership

    binding = capture_native_custody(config.APP_DIR)
    if binding is None or binding["scope"].get("purpose") != "apply":
        raise RuntimeError("native handoff probe has no authenticated Apply scope")
    coalitions = tuple(binding["scope"]["coalitionIds"])
    if tuple(_current_coalitions()) != coalitions:
        raise RuntimeError("native handoff probe scope changed")

    state = Path(tempfile.mkdtemp(prefix="handoff-", dir=directory))
    leaf_code = """
import json,os,sys,time
from pathlib import Path
state=Path(sys.argv[1]); deadline=time.monotonic()+30
while time.monotonic()<deadline:
    pid=os.getpid()
    temporary=state/f'{pid}.json.tmp'
    temporary.write_text(json.dumps({'pid':pid,'sid':os.getsid(0)}))
    os.replace(temporary,state/f'{pid}.json')
    command=state/f'{pid}.cmd'
    while not command.exists() and time.monotonic()<deadline: time.sleep(.002)
    if not command.exists(): break
    action=command.read_text(); command.unlink()
    if action=='exit': break
    child=os.fork()
    if child==0: continue
    os.setsid()
    while not (state/f'{child}.json').exists() and time.monotonic()<deadline: time.sleep(.002)
    temporary=state/f'{pid}.ack.tmp'
    temporary.write_text(str(child))
    os.replace(temporary,state/f'{pid}.ack')
(state/f'{os.getpid()}.done').write_text('done')
"""
    root_code = """
import subprocess,sys,time
from pathlib import Path
subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
state=Path(sys.argv[2]); deadline=time.monotonic()+8
while not list(state.glob('*.json')) and time.monotonic()<deadline: time.sleep(.002)
"""
    parent = subprocess.Popen([sys.executable, "-c", root_code, leaf_code, str(state)],
                              start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    real_cdll, real_read, real_counter = ctypes.CDLL, process_ownership._read_process_inventory, process_ownership._native_coalition_counts
    relays, snapshots, counters = [], [], []
    current = [0]

    def wait(path: Path) -> None:
        deadline = time.monotonic() + 8
        while not path.exists():
            if time.monotonic() >= deadline:
                raise RuntimeError("native handoff actor did not respond")
            time.sleep(.002)

    def send(pid: int | str, action: str) -> None:
        tmp = state / f"{pid}.tmp"
        tmp.write_text(action)
        os.replace(tmp, state / f"{pid}.cmd")

    try:
        if parent.wait(timeout=10) != 0:
            raise RuntimeError("native handoff root did not exit")
        actors = list(state.glob("*.json"))
        if len(actors) != 1:
            raise RuntimeError("native handoff actor was not published")
        current[0] = int(actors[0].stem)
        if os.getsid(current[0]) != parent.pid:
            raise RuntimeError("native handoff actor left its original session")

        library = real_cdll("/usr/lib/libproc.dylib", use_errno=True)
        library.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        library.proc_listpids.restype = ctypes.c_int
        library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        library.proc_pidinfo.restype = ctypes.c_int

        class PidInfo:
            def __call__(self, pid, flavor, *args):
                if pid == current[0] and flavor == 17 and len(relays) < 2:
                    send(pid, "relay")
                    wait(state / f"{pid}.ack")
                    current[0] = int((state / f"{pid}.ack").read_text())
                    relays.append(pid)
                return library.proc_pidinfo(pid, flavor, *args)

        def listpids(kind, info, buffer, size):
            needed = library.proc_listpids(kind, info, None, 0)
            actual = (ctypes.c_int * (needed // 4 + 256))()
            used = library.proc_listpids(kind, info, actual, ctypes.sizeof(actual))
            owned = {os.getpid(), binding["scope"]["rootPid"], *(int(path.stem) for path in state.glob("*.json"))}
            pids = sorted(set(actual[:used // 4]) & owned)
            if buffer is not None:
                for index, pid in enumerate(pids[:size // 4]):
                    buffer[index] = pid
            return len(pids) * 4

        class ScopedLibrary:
            proc_listpids = staticmethod(listpids)
            proc_pidinfo = PidInfo()

        def cdll(name, *args, **kwargs):
            return ScopedLibrary() if name == "/usr/lib/libproc.dylib" else real_cdll(name, *args, **kwargs)

        def read(**kwargs):
            inventory, complete = real_read(**kwargs)
            members = [pid for pid, (_, sid, active, _) in inventory.items() if active and sid == parent.pid]
            snapshots.append((complete, members))
            return inventory, complete

        def starts(ids):
            result = real_counter(ids)
            counters.append(result)
            return result

        ctypes.CDLL = cdll
        process_ownership._read_process_inventory = read
        process_ownership._native_coalition_counts = starts
        try:
            process_ownership._wait_for_session_exit(parent.pid, native_coalitions=coalitions)
        except process_ownership.ProcessOwnershipError:
            pass
        else:
            raise RuntimeError("native session fence retired a live relay successor")
        if (len(relays) != 2 or len(snapshots) < 2 or snapshots[:2] != [(True, []), (True, [])]
                or len(counters) < 4 or any(counters[i] is None or counters[i + 1] is None
                                             or counters[i + 1][0] <= counters[i][0] for i in (0, 2))
                or os.getsid(current[0]) != parent.pid):
            raise RuntimeError("native session fence did not observe both real handoffs")
    finally:
        ctypes.CDLL = real_cdll
        process_ownership._read_process_inventory = real_read
        process_ownership._native_coalition_counts = real_counter
        for path in state.glob("*.json"):
            send(path.stem, "exit")
        deadline = time.monotonic() + 8
        while len(list(state.glob("*.done"))) != len(list(state.glob("*.json"))) and time.monotonic() < deadline:
            time.sleep(.01)
        if len(list(state.glob("*.done"))) != len(list(state.glob("*.json"))):
            raise RuntimeError("native handoff actors did not exit")

    (directory / "handoff-proof.json").write_text(json.dumps({"relays": len(relays), "fenced_empty_samples": 2}))
