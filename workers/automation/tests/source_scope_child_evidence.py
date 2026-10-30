"""Read-only evidence for exact children in the synthetic Darwin source probe."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import subprocess


class _UniqueInfo(ctypes.Structure):
    _fields_ = [
        ("uuid", ctypes.c_byte * 16), ("unique_id", ctypes.c_uint64),
        ("parent_unique_id", ctypes.c_uint64), ("pid_version", ctypes.c_int32),
        ("reserved2", ctypes.c_uint32), ("reserved3", ctypes.c_uint64),
        ("reserved4", ctypes.c_uint64),
    ]


class _CoalitionInfo(ctypes.Structure):
    _fields_ = [("ids", ctypes.c_uint64 * 5)]


class OwnedChildEvidence:
    """Retain Popen handles and record only their kernel identity and session census."""

    def __init__(self, app: Path, expected_coalitions: list[int]):
        from jobctrl.infrastructure import process_ownership

        self.path = app / "source-child-evidence.json"
        self.expected_coalitions = expected_coalitions
        self.children = []
        self.samples = []
        self.samples_omitted = 0
        self.previous_inventory = None
        self.scoped_after_reap = set()
        self.ownership = process_ownership
        self.original_inventory = process_ownership._read_process_inventory
        self.original_wait = process_ownership._wait_for_session_exit
        self.library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.library.proc_pidinfo.restype = ctypes.c_int

    def _read(self, pid: int, flavor: int, info, arg: int):
        result = info()
        size = self.library.proc_pidinfo(pid, flavor, arg, ctypes.byref(result), ctypes.sizeof(result))
        if size != ctypes.sizeof(result):
            raise RuntimeError("Cannot record the directly owned child's kernel identity")
        return result

    def capture(self, name: str, process: subprocess.Popen) -> None:
        item = {"name": name, "process": process, "pid": process.pid, "identity_verified": False}
        self.children.append(item)
        self._write()
        before = self._read(process.pid, 17, _UniqueInfo, 1)
        session, group = os.getsid(process.pid), os.getpgid(process.pid)
        coalitions = list(self._read(process.pid, 20, _CoalitionInfo, 0).ids[:2])
        after = self._read(process.pid, 17, _UniqueInfo, 1)
        birth = (before.unique_id, before.pid_version)
        assert birth[0] and birth == (after.unique_id, after.pid_version)
        assert session == group == process.pid and coalitions == self.expected_coalitions
        item.update({"identity_verified": True, "unique_id": birth[0], "pid_version": birth[1],
                     "session": session, "group": group, "coalitions": coalitions})
        self._write()

    def install(self) -> None:
        self.ownership._read_process_inventory = self._observe_inventory
        self.ownership._wait_for_session_exit = self._observe_wait

    def _observe_wait(self, session_id, *args, **kwargs):
        result = self.original_wait(session_id, *args, **kwargs)
        if (kwargs.get("native_coalitions") == tuple(self.expected_coalitions) and self.samples
                and self.samples[-1].get("scoped") and self.samples[-1].get("complete")):
            for item in self.children:
                if item.get("session") == session_id and item["process"].returncode is not None:
                    self.scoped_after_reap.add(item["name"])
        return result

    def _observe_inventory(self, *args, **kwargs):
        try:
            inventory, complete = self.original_inventory(*args, **kwargs)
        except Exception as exc:
            self.previous_inventory = None
            self._sample({"error": type(exc).__name__})
            raise
        children = []
        for item in self.children:
            if not item["identity_verified"]:
                children.append({"name": item["name"], "identity_verified": False})
                continue
            row = inventory.get(item["pid"])
            same_birth = bool(row and row[0] == (item["unique_id"], item["pid_version"]))
            children.append({"name": item["name"], "captured_birth_seen": same_birth,
                             "captured_birth_active": bool(same_birth and row[2]),
                             "active_in_session": sum(1 for _, sid, active, _ in inventory.values()
                                                      if active and sid == item["session"])})
        unchanged = self.previous_inventory == inventory if self.previous_inventory is not None else None
        self.previous_inventory = inventory
        self._sample({"complete": complete, "scoped": "native_scope" in kwargs,
                      "unchanged_from_previous": unchanged, "children": children})
        return inventory, complete

    def _sample(self, value: dict) -> None:
        if len(self.samples) == 256:
            self.samples.pop(0)
            self.samples_omitted += 1
        self.samples.append(value)

    def _write(self) -> None:
        self.path.write_text(json.dumps({"children": [{k: v for k, v in item.items() if k != "process"}
                                                       for item in self.children], "census": self.samples,
                                         "scoped_after_reap": sorted(self.scoped_after_reap),
                                         "census_samples_omitted": self.samples_omitted}))

    def finish(self) -> list[str]:
        self.ownership._read_process_inventory = self.original_inventory
        self.ownership._wait_for_session_exit = self.original_wait
        unresolved = []
        for item in self.children:
            try:
                item["returncode"] = item["process"].wait(timeout=2)
                item["root_reaped"] = True
            except subprocess.TimeoutExpired:
                item["root_reaped"] = False
                unresolved.append(item["name"])
            except OSError as exc:
                item["root_reaped"] = False
                item["wait_error"] = type(exc).__name__
                unresolved.append(item["name"])
        self._write()
        return unresolved
