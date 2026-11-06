"""Native secret boundary and OS-user-wide, recoverable credential mutations.

Only allowlisted, non-secret provider configuration enters application settings.
Native values are read only for execution or an in-memory rollback snapshot.
"""

from __future__ import annotations

import ctypes
import errno
import json
import os
import platform
import re
import sqlite3
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError, ConflictError
from jobctrl.app.settings import PROVIDER_CONFIGURATION_KEYS
from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.native_credentials import (
    LINUX_SECRET_TOOL_MAX_INPUT_BYTES,
    MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES,
    PROVIDER_SECRET_KEYS,
    WINDOWS_CREDENTIAL_BLOB_MAX_BYTES,
    NativeCredentialError,
    NativeCredentialStore,
    _validate_value,
)

SECRET_KEYS = frozenset(PROVIDER_SECRET_KEYS)
CREDENTIAL_KEYS = (
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_WORKSPACE_ID",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION", "ANTHROPIC_FOUNDRY_RESOURCE", "AWS_PROFILE", "AWS_REGION",
    "GEMINI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "CAPSOLVER_API_KEY",
)
_LABELS = {
    "OPENAI_API_KEY": "OpenAI API key", "ANTHROPIC_API_KEY": "Anthropic API key",
    "GEMINI_API_KEY": "Gemini API key", "CAPSOLVER_API_KEY": "CapSolver API key",
    "CLAUDE_CODE_USE_BEDROCK": "Claude Amazon Bedrock mode",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS": "Claude Platform on AWS mode",
    "ANTHROPIC_AWS_WORKSPACE_ID": "Claude Platform on AWS workspace",
    "CLAUDE_CODE_USE_VERTEX": "Claude Google Cloud Agent Platform mode",
    "CLAUDE_CODE_USE_FOUNDRY": "Claude Microsoft Foundry mode",
    "ANTHROPIC_VERTEX_PROJECT_ID": "Claude Google Cloud project",
    "CLOUD_ML_REGION": "Claude Google Cloud region",
    "ANTHROPIC_FOUNDRY_RESOURCE": "Claude Microsoft Foundry resource",
    "AWS_PROFILE": "AWS profile", "AWS_REGION": "AWS region",
    "GOOGLE_GENAI_USE_VERTEXAI": "Google Vertex AI mode",
    "GOOGLE_CLOUD_PROJECT": "Google Cloud project",
    "GOOGLE_CLOUD_LOCATION": "Google Cloud location",
    "GOOGLE_APPLICATION_CREDENTIALS": "Google service-account JSON path",
}
_FAILURES = {
    "busy": "Another credential update is in progress. Retry after it finishes.",
    "ownership_unverified": (
        "Credential update ownership could not be verified. Restore process inspection or verify "
        "the previous helper has exited before clearing its coordination record."
    ),
    "operational_failure": "The native credential store is temporarily unavailable. Unlock it and retry.",
    "partial_failure": (
        "Credential update failed and native-store recovery was incomplete. Provider credentials "
        "may be partially updated; inspect the native credential store before retrying."
    ),
    "unsupported_platform": "Native credential storage is unavailable on this platform.",
}
_LOCK_NAME = ".jobctrl-credential-mutations.sqlite3"
_OUTPUT_LIMIT = 131072
_CLAUDE_CLOUD_FLAGS = frozenset({"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
                                 "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"})


def _enabled(value: str | None) -> bool:
    return isinstance(value, str) and value.strip().lower() in {"1", "true", "yes", "on"}


class CredentialStoreError(AppError):
    def __init__(self, reason: str):
        super().__init__("credential_store_unavailable", _FAILURES[reason],
                         409 if reason == "busy" else 503, {"reason": reason})
        self.reason = reason


def _user_home() -> Path:
    # HOME/JOBCTRL_DIR are workspace-local overrides; the native namespace is not.
    if os.name == "nt":
        from ctypes import wintypes
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        path = ctypes.create_unicode_buffer(32768)
        shell.SHGetFolderPathW.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.HANDLE,
                                          wintypes.DWORD, wintypes.LPWSTR]
        if shell.SHGetFolderPathW(None, 40, None, 0, path) != 0:
            raise CredentialStoreError("operational_failure")
        return Path(path.value)
    import pwd
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


def read_process_identity(pid: int) -> dict:
    """Observe exact native process birth identity; inability is never absence."""
    if type(pid) is not int or pid <= 0:
        return {"state": "unverified"}
    try:
        system = platform.system()
        if system == "Linux":
            value = Path(f"/proc/{pid}/stat").read_text()
            tail = value[value.rfind(")") + 1:].split()
            if len(tail) < 20 or not tail[19].isdigit():
                return {"state": "unverified"}
            if tail[0] in {"Z", "X"}:
                return {"state": "exited"}
            boot = str(uuid.UUID(Path("/proc/sys/kernel/random/boot_id").read_text().strip()))
            return {"state": "alive", "identity": f"linux:{boot}:{tail[19]}"}
        if system == "Darwin":
            class Unique(ctypes.Structure):
                _fields_ = [("uuid", ctypes.c_byte * 16), ("unique_id", ctypes.c_uint64),
                            ("parent_unique_id", ctypes.c_uint64), ("pid_version", ctypes.c_int32),
                            ("reserved2", ctypes.c_uint32), ("reserved3", ctypes.c_uint64),
                            ("reserved4", ctypes.c_uint64)]

            class Short(ctypes.Structure):
                _fields_ = [("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32),
                            ("pgid", ctypes.c_uint32), ("state", ctypes.c_uint32),
                            ("remaining", ctypes.c_byte * 48)]

            class BSD(ctypes.Structure):
                _fields_ = [("data", ctypes.c_byte * 136)]

            lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                        ctypes.c_void_p, ctypes.c_int]
            lib.proc_pidinfo.restype = ctypes.c_int

            def read(flavor, kind):
                result = kind()
                ctypes.set_errno(0)
                size = lib.proc_pidinfo(pid, flavor, 1, ctypes.byref(result), ctypes.sizeof(result))
                if size != ctypes.sizeof(result):
                    if size == 0 and ctypes.get_errno() == errno.ESRCH:
                        raise ProcessLookupError()
                    raise OSError("process inspection unavailable")
                return result

            before = read(17, Unique)
            short = read(13, Short)
            bsd = bytes(read(3, BSD).data)
            after = read(17, Unique)
            seconds, micros = struct.unpack_from("=QQ", bsd, 120)
            if (short.pid != pid or struct.unpack_from("=I", bsd, 12)[0] != pid
                    or not before.unique_id or not seconds
                    or (before.unique_id, before.pid_version) != (after.unique_id, after.pid_version)):
                return {"state": "unverified"}
            return ({"state": "exited"} if short.state == 5 else
                    {"state": "alive", "identity": f"darwin:{seconds}:{micros}"})
        if system == "Windows":
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.WaitForSingleObject.restype = wintypes.DWORD
            kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME),
                                              ctypes.POINTER(wintypes.FILETIME),
                                              ctypes.POINTER(wintypes.FILETIME),
                                              ctypes.POINTER(wintypes.FILETIME)]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x101000, False, pid)
            if not handle:
                return {"state": "exited" if ctypes.get_last_error() == 87 else "unverified"}
            try:
                state = kernel.WaitForSingleObject(handle, 0)
                if state == 0:
                    return {"state": "exited"}
                if state != 258:
                    return {"state": "unverified"}
                created, exited, cpu, user = (wintypes.FILETIME() for _ in range(4))
                if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                              ctypes.byref(cpu), ctypes.byref(user)):
                    return {"state": "unverified"}
                return {"state": "alive",
                        "identity": f"windows:{created.dwHighDateTime}:{created.dwLowDateTime}"}
            finally:
                kernel.CloseHandle(handle)
    except (ProcessLookupError, FileNotFoundError):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return {"state": "exited"}
        except OSError:
            pass
    except (OSError, ValueError, IndexError, AttributeError, struct.error):
        pass
    return {"state": "unverified"}


def _valid_identity(value) -> bool:
    patterns = {"Darwin": r"darwin:[1-9]\d*:\d+",
                "Linux": r"linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+",
                "Windows": r"windows:\d+:\d+"}
    return (isinstance(value, str) and len(value) <= 200
            and re.fullmatch(patterns.get(platform.system(), r"(?!)"), value) is not None)


def _regular_file(path: Path, *, max_bytes: int | None = None) -> os.stat_result:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or (hasattr(os, "getuid") and info.st_uid != os.getuid())
            or (max_bytes is not None and info.st_size > max_bytes)):
        raise CredentialStoreError("ownership_unverified")
    return info


def _sync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _resume_registered_windows_child(child: subprocess.Popen) -> None:
    """Resume the sole suspended primary thread of this owned process handle."""
    from ctypes import wintypes

    class ThreadEntry(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("thread_id", wintypes.DWORD),
                    ("owner_pid", wintypes.DWORD), ("base_priority", wintypes.LONG),
                    ("delta_priority", wintypes.LONG), ("flags", wintypes.DWORD)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.Thread32First.restype = wintypes.BOOL
    kernel.Thread32Next.argtypes = kernel.Thread32First.argtypes
    kernel.Thread32Next.restype = wintypes.BOOL
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    kernel.GetProcessIdOfThread.argtypes = [wintypes.HANDLE]
    kernel.GetProcessIdOfThread.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(4, 0)
    if snapshot in (None, ctypes.c_void_p(-1).value):
        raise NativeCredentialError("native credential helper resume failed")
    try:
        entry = ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        found = []
        success = kernel.Thread32First(snapshot, ctypes.byref(entry))
        while success:
            if entry.owner_pid == child.pid:
                found.append(entry.thread_id)
            entry.size = ctypes.sizeof(entry)
            success = kernel.Thread32Next(snapshot, ctypes.byref(entry))
        if len(found) != 1 or child.poll() is not None:
            raise NativeCredentialError("native credential helper resume failed")
        handle = kernel.OpenThread(0x0802, False, found[0])
        if not handle:
            raise NativeCredentialError("native credential helper resume failed")
        try:
            if (kernel.GetProcessIdOfThread(handle) != child.pid or child.poll() is not None
                    or kernel.ResumeThread(handle) != 1):
                raise NativeCredentialError("native credential helper resume failed")
        finally:
            kernel.CloseHandle(handle)
    finally:
        kernel.CloseHandle(snapshot)


class MutationGuard:
    """Empty SQLite writer transaction plus a crash-surviving helper identity."""

    def __init__(self, path: Path, timeout: float = 30.0,
                 identity_reader: Callable[[int], dict] = read_process_identity):
        self.path = path
        self.marker_path = path.with_name(path.name + ".inflight")
        self.timeout = timeout
        self.identity_reader = identity_reader
        self.marker: dict | None = None

    def _observe(self, pid: int) -> dict:
        try:
            value = self.identity_reader(pid)
            return value if isinstance(value, dict) else {"state": "unverified"}
        except Exception:
            return {"state": "unverified"}

    def _read(self) -> dict | None:
        try:
            _regular_file(self.marker_path, max_bytes=4096)
            descriptor = os.open(self.marker_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
                value = json.load(handle)
            if (not isinstance(value, dict) or set(value) != {
                    "version", "id", "ownerPid", "ownerIdentity", "childPid", "childIdentity"}
                    or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["id"], str)
                    or str(uuid.UUID(value["id"])) != value["id"]
                    or type(value["ownerPid"]) is not int or value["ownerPid"] <= 0
                    or not _valid_identity(value["ownerIdentity"])
                    or (value["childPid"] is None and value["childIdentity"] is not None)
                    or (value["childPid"] is not None and (type(value["childPid"]) is not int
                        or value["childPid"] <= 0 or not _valid_identity(value["childIdentity"])))):
                raise ValueError("marker")
            return value
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError, KeyError):
            raise CredentialStoreError("ownership_unverified") from None

    def _publish(self) -> None:
        temporary = self.marker_path.with_name(self.marker_path.name + "." + self.marker["id"] + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(self.marker, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.marker_path)
            _sync_directory(self.marker_path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def acquire(self):
        database = None
        try:
            try:
                descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(descriptor)
            except FileExistsError:
                pass
            _regular_file(self.path)
            database = sqlite3.connect(self.path, timeout=0)
            deadline = time.monotonic() + self.timeout
            while True:
                try:
                    database.execute("BEGIN IMMEDIATE")
                    break
                except sqlite3.OperationalError as error:
                    if error.sqlite_errorcode not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                        raise
                    if time.monotonic() >= deadline:
                        raise CredentialStoreError("busy") from None
                    time.sleep(min(0.02, max(0, deadline - time.monotonic())))
            while (previous := self._read()) is not None:
                pid = previous["childPid"] or previous["ownerPid"]
                identity = previous["childIdentity"] or previous["ownerIdentity"]
                observed = self._observe(pid)
                if observed.get("state") == "exited" or (observed.get("state") == "alive"
                        and _valid_identity(observed.get("identity")) and observed["identity"] != identity):
                    # A reused PID is never signalled. Recheck the exact marker before retiring it.
                    if self._read() != previous:
                        raise CredentialStoreError("ownership_unverified")
                    self.marker_path.unlink()
                    _sync_directory(self.marker_path.parent)
                    break
                if observed.get("state") != "alive" or not _valid_identity(observed.get("identity")):
                    raise CredentialStoreError("ownership_unverified")
                if time.monotonic() >= deadline:
                    raise CredentialStoreError("busy")
                time.sleep(min(0.02, max(0, deadline - time.monotonic())))
            yield self
        except CredentialStoreError:
            raise
        except (OSError, sqlite3.Error):
            raise CredentialStoreError("operational_failure") from None
        finally:
            if database is not None:
                database.close()

    def begin(self) -> None:
        if self._read() is not None:
            raise CredentialStoreError("ownership_unverified")
        owner = self._observe(os.getpid())
        if owner.get("state") != "alive" or not _valid_identity(owner.get("identity")):
            raise CredentialStoreError("ownership_unverified")
        self.marker = {"version": 1, "id": str(uuid.uuid4()), "ownerPid": os.getpid(),
                       "ownerIdentity": owner["identity"], "childPid": None, "childIdentity": None}
        self._publish()

    def started(self, child: subprocess.Popen) -> None:
        observed = self._observe(child.pid)
        if (child.poll() is not None or observed.get("state") != "alive"
                or not _valid_identity(observed.get("identity"))):
            raise CredentialStoreError("ownership_unverified")
        self.marker.update(childPid=child.pid, childIdentity=observed["identity"])
        self._publish()

    def clear(self) -> None:
        if self.marker is None or self._read() != self.marker:
            raise CredentialStoreError("ownership_unverified")
        self.marker_path.unlink()
        _sync_directory(self.marker_path.parent)
        self.marker = None


# The POSIX process is registered while blocked on this descriptor. exec retains
# its PID/birth identity. A crash before registration cannot orphan a mutator.
_EXEC_GATE = """import json,os
header=bytearray()
while True:
    value=os.read(0,1)
    if not value: raise SystemExit(1)
    if value==b'\\n': break
    header.extend(value)
    if len(header)>131072: raise SystemExit(1)
command=json.loads(header)
os.execv(command[0],command)
"""


class _ControlledStore(NativeCredentialStore):
    def __init__(self, *, helper: Path, **kwargs):
        super().__init__(**kwargs)
        self.helper = helper

    def _execute(self, operation, key, value=None):
        if key not in SECRET_KEYS:
            raise NativeCredentialError("credential key is invalid")
        command = ([sys.executable, "-I", "-B", str(self.helper)] if self.helper.suffix == ".py" else [str(self.helper)])
        return self.run([*command, operation, key], check=False, capture_output=True,
                        text=True, input=value, timeout=5.0, enrollment=operation in {"set", "delete"})

    def read(self, key):
        result = self._execute("read", key)
        if result.returncode == 44:
            return None
        if result.returncode or not result.stdout:
            raise NativeCredentialError("native credential read failed")
        return result.stdout


class CredentialService:
    def __init__(self, runtime_or_workspace, *, settings=None, environ: Mapping[str, str] | None = None,
                 system_name: str | None = None, lock_path: Path | None = None, native_service: str = "JobCtrl",
                 lock_timeout: float = 30.0, identity_reader=read_process_identity):
        self.runtime = runtime_or_workspace if hasattr(runtime_or_workspace, "workspace") else None
        self.workspace = Path(self.runtime.workspace if self.runtime else runtime_or_workspace)
        self.settings = settings or (self.runtime.settings if self.runtime else None)
        self.environ = dict(os.environ if environ is None else environ)
        self.system_name = system_name or platform.system()
        self._local = threading.local()
        self.lock_timeout = lock_timeout
        self.identity_reader = identity_reader
        self.synthetic = synthetic_boundary(self.workspace)
        helper = self.environ.get("JOBCTRL_E2E_CREDENTIAL_HELPER")
        if helper and not self.synthetic:
            raise AppError("synthetic_boundary_unowned", "Credential helpers require an owned E2E workspace.", 503)
        if self.synthetic:
            if not helper:
                # A synthetic process must never even inspect the real native store.
                self.store = None
            else:
                path = Path(helper)
                if (not path.is_absolute() or not path.is_relative_to(self.workspace.resolve())
                        or path.resolve() != path or not os.access(path, os.X_OK)):
                    raise AppError("synthetic_boundary_unowned", "The credential helper must be owned by this workspace.", 503)
                _regular_file(path, max_bytes=1024 * 1024)
                self.store = _ControlledStore(helper=path, system_name=self.system_name,
                                             service="JobCtrl-QA-" + str(uuid.uuid5(uuid.NAMESPACE_URL, self.synthetic["token"])),
                                             environ=self.environ, run=self._run_command)
            shared_lock = self.environ.get("JOBCTRL_E2E_CREDENTIAL_LOCK")
            if shared_lock:
                candidate = Path(shared_lock)
                expected = self.workspace.resolve().parent / _LOCK_NAME
                if candidate != expected or candidate.resolve(strict=False) != candidate:
                    raise AppError("synthetic_boundary_unowned", "The credential coordination path must be owned by this E2E run.", 503)
                self.lock_path = lock_path or candidate
            else:
                self.lock_path = lock_path or self.workspace / _LOCK_NAME
        else:
            self.store = NativeCredentialStore(system_name=self.system_name, service=native_service, environ=self.environ,
                                               run=self._run_command)
            self.lock_path = lock_path or _user_home() / _LOCK_NAME

    @property
    def max_secret_bytes(self) -> int | None:
        return {"Darwin": MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES,
                "Windows": WINDOWS_CREDENTIAL_BLOB_MAX_BYTES,
                "Linux": LINUX_SECRET_TOOL_MAX_INPUT_BYTES}.get(self.system_name)

    def configuration(self) -> dict:
        return dict(self.settings.get("providerConfiguration", {})) if self.settings else {}

    def _environment_owned(self, key: str) -> bool:
        aliases = ("GEMINI_API_KEY", "GOOGLE_API_KEY") if key == "GEMINI_API_KEY" else (key,)
        return any(bool(self.environ.get(name, "").strip()) for name in aliases)

    def native_fallback_allowed(self, key: str) -> bool:
        flags = (_CLAUDE_CLOUD_FLAGS if key == "ANTHROPIC_API_KEY" else
                 ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_VERTEXAI") if key == "GEMINI_API_KEY" else ())
        return not self._environment_owned(key) and not any(_enabled(self.environ.get(flag)) for flag in flags)

    def list(self) -> dict:
        if getattr(self._local, "guard", None) is not None:
            return self._list_unlocked()
        with MutationGuard(self.lock_path, self.lock_timeout, self.identity_reader).acquire():
            return self._list_unlocked()

    def _list_unlocked(self) -> dict:
        saved = self.settings.snapshot() if self.settings else None
        configured: dict[str, bool | None] = {key: bool(value.strip())
                                            for key, value in (saved["providerConfiguration"] if saved else {}).items()}
        for key in PROVIDER_CONFIGURATION_KEYS:
            configured.setdefault(key, False)
        supported = self.store is not None and self.store.kind is not None
        for key in SECRET_KEYS:
            try:
                configured[key] = self.store.inspect(key) if supported else None
            except (NativeCredentialError, CredentialStoreError, OSError):
                configured[key] = None
        reason = ("unsupported_platform" if not supported else
                  "inspection_failed" if any(configured[key] is None for key in SECRET_KEYS) else None)
        credentials = []
        for key in CREDENTIAL_KEYS:
            configuration = key in PROVIDER_CONFIGURATION_KEYS
            owned = self._environment_owned(key)
            status = configured[key]
            source = ("config" if status else "absent") if configuration else (
                "environment" if owned else "native_store" if status is True
                else "absent" if status is False else "inspection_unknown")
            credentials.append({"key": key, "label": _LABELS[key], "configured": status,
                                "storage": "config" if configuration else "native_store",
                                "effectiveSource": source,
                                "editable": configuration or (supported and status is not None and not owned)})
        return {"ok": True, "revision": saved["revision"] if saved else 1, "store": {"kind": "config_and_native_credential_store",
                "nativeStore": self.store.kind if self.store else None,
                "maxSecretBytes": self.max_secret_bytes, "available": reason is None,
                "unavailableReason": reason, "requiresWorkerRestart": False}, "credentials": credentials}

    def execution_environment(self, configuration: Mapping | None = None, *, provider: str | None = None) -> dict[str, str]:
        """Resolve one call's credentials without changing process/global settings."""
        values = self.metadata_environment(configuration)
        selected = ({"claude": ("ANTHROPIC_API_KEY",), "google": ("GEMINI_API_KEY",),
                     "codex": ()}.get(provider, tuple(SECRET_KEYS)))
        for key in selected:
            if self._environment_owned(key):
                continue
            if not self.native_fallback_allowed(key):
                # A saved alternative API key cannot replace an explicitly
                # selected launch-environment cloud authentication route.
                values.pop(key, None)
                continue
            if self.store is None or self.store.kind is None:
                continue
            try:
                value = self.store.read(key)
            except (NativeCredentialError, OSError):
                raise CredentialStoreError("operational_failure") from None
            if value:
                values[key] = value
        return values

    def metadata_environment(self, configuration: Mapping | None = None) -> dict[str, str]:
        """Configuration and launch overrides only; never read a native value."""
        values = {key: value for key, value in self.environ.items() if isinstance(value, str)}
        claude_cloud_owned = any(_enabled(self.environ.get(flag)) for flag in _CLAUDE_CLOUD_FLAGS)
        for key, value in (configuration if configuration is not None else self.configuration()).items():
            if key in _CLAUDE_CLOUD_FLAGS and claude_cloud_owned and not values.get(key, "").strip():
                continue
            if key in PROVIDER_CONFIGURATION_KEYS and not values.get(key, "").strip():
                values[key] = value
        values["JOBCTRL_DIR"] = str(self.workspace)
        return values

    def _validate_operations(self, operations) -> list[dict]:
        if not isinstance(operations, list) or not 1 <= len(operations) <= len(CREDENTIAL_KEYS):
            raise AppError("invalid_credentials", "Supply a bounded list of credential operations.")
        captured = []
        seen = set()
        for operation in operations:
            if not isinstance(operation, dict):
                raise AppError("invalid_credentials", "Credential operations must be objects.")
            op, key = operation.get("operation"), operation.get("key")
            if (not isinstance(op, str) or not isinstance(key, str)
                    or op not in {"set", "delete"} or key not in CREDENTIAL_KEYS or key in seen
                    or set(operation) != ({"operation", "key", "value"} if op == "set" else {"operation", "key"})):
                raise AppError("invalid_credentials", "Credential operations contain an invalid or repeated key.")
            seen.add(key)
            if op == "set":
                value = operation["value"]
                if (not isinstance(value, str) or not 1 <= len(value) <= 8000
                        or any(character in value for character in "\r\n\0")):
                    raise AppError("invalid_credentials", "Credential values must be bounded single-line strings.")
                if key in PROVIDER_CONFIGURATION_KEYS and len(value) > 4096:
                    raise AppError("invalid_credentials", "Provider configuration exceeds its limit.")
            if key in SECRET_KEYS:
                if self._environment_owned(key):
                    raise AppError("credential_managed_by_environment",
                                   "This credential is managed by the launch environment and cannot be changed here.",
                                   409, {"key": key})
                if self.store is None or self.store.kind is None:
                    raise CredentialStoreError("unsupported_platform")
                if op == "set":
                    try:
                        _validate_value(self.system_name, operation["value"])
                    except NativeCredentialError:
                        raise AppError("credential_value_unsupported",
                                       "This credential exceeds the native store's secure input limit.",
                                       400, {"key": key, "maxBytes": self.max_secret_bytes}) from None
            captured.append(dict(operation))
        return captured

    def apply_batch(self, operations: list[dict], *, expected_revision: int | None = None) -> dict:
        if expected_revision is not None and (type(expected_revision) is not int or expected_revision < 1):
            raise AppError("invalid_revision", "A saved settings revision must be a positive integer.")
        captured = self._validate_operations(operations)
        guard = MutationGuard(self.lock_path, self.lock_timeout, self.identity_reader)
        with guard.acquire():
            self._local.guard = guard
            self._local.mutation_attempted = False
            try:
                self._validate_operations(captured)
                saved = self.settings.snapshot() if self.settings else None
                if expected_revision is not None and (saved is None or saved["revision"] != expected_revision):
                    raise ConflictError()
                secrets = [item for item in captured if item["key"] in SECRET_KEYS]
                snapshots = {}
                try:
                    for operation in secrets:
                        key = operation["key"]
                        value = self.store.read(key)
                        if value is not None:
                            _validate_value(self.system_name, value)
                        snapshots[key] = value
                except (NativeCredentialError, OSError):
                    raise CredentialStoreError("operational_failure") from None
                try:
                    for operation in secrets:
                        self._apply_secret(operation)
                    configuration = dict(saved["providerConfiguration"]) if saved else {}
                    config_ops = [item for item in captured if item["key"] in PROVIDER_CONFIGURATION_KEYS]
                    for operation in config_ops:
                        if operation["operation"] == "set":
                            configuration[operation["key"]] = operation["value"].strip()
                        else:
                            configuration.pop(operation["key"], None)
                    if saved is not None:
                        # Native writes participate in the same revision fence
                        # as non-secret connection configuration.
                        self.settings.update({"providerConfiguration": configuration}, expected_revision=saved["revision"])
                    elif config_ops:
                        if self.settings is None:
                            raise CredentialStoreError("operational_failure")
                except Exception as error:
                    # An unresolved helper may still write; do not race rollback against it.
                    if guard.marker is not None:
                        raise CredentialStoreError("partial_failure") from None
                    if (isinstance(error, CredentialStoreError) and error.reason == "ownership_unverified"
                            and not self._local.mutation_attempted):
                        raise error
                    restored = True
                    for key, value in snapshots.items():
                        try:
                            self._apply_secret({"operation": "delete" if value is None else "set",
                                                "key": key, **({"value": value} if value is not None else {})})
                        except Exception:
                            restored = False
                            if guard.marker is not None:
                                break
                    if isinstance(error, ConflictError) and restored:
                        raise error
                    if isinstance(error, CredentialStoreError) and error.reason == "ownership_unverified" and restored:
                        raise error
                    raise CredentialStoreError("operational_failure" if restored else "partial_failure") from None
                if self.runtime:
                    with self.runtime.database.transaction() as connection:
                        self.runtime.events.append(connection, "CredentialsUpdated", {"keys": [item["key"] for item in captured]},
                                                   feature="credentials")
                return self.list()
            finally:
                self._local.guard = None

    def _apply_secret(self, operation: dict) -> None:
        if operation["operation"] == "set":
            self.store.write(operation["key"], operation["value"])
        else:
            self.store.delete(operation["key"])

    def migrate_persistent_env(self, paths, marker: Path):
        """Explicit plaintext migration under the same native mutation authority."""
        from jobctrl.native_credentials import (
            NativeCredentialMigrationError,
            _exclusive_migration_lock,
            migrate_explicit_env_credentials,
            _require_absent_sources,
        )

        if self.store is None or self.store.kind is None:
            raise CredentialStoreError("unsupported_platform")
        guard = MutationGuard(self.lock_path, self.lock_timeout, self.identity_reader)
        with guard.acquire():
            self._local.guard = guard
            try:
                # The global native mutation lock serializes every target
                # writer. Reuse the native atomic source/ACL/rollback adapter
                # without importing legacy configuration or global APP_DIR.
                eligible, skipped = [], []
                owner = self.workspace.resolve(strict=True)
                lexical_owner = Path(os.path.abspath(self.workspace.expanduser()))
                for candidate in paths:
                    path = Path(candidate).expanduser()
                    lexical = Path(os.path.abspath(path.parent))
                    resolved = path.parent.resolve(strict=False)
                    if lexical.is_relative_to(lexical_owner) and not resolved.is_relative_to(owner):
                        raise NativeCredentialMigrationError("credential source redirects outside its owned workspace")
                    if not path.parent.is_dir():
                        _require_absent_sources([path])
                        if resolved.is_relative_to(owner):
                            raise NativeCredentialMigrationError("the JobCtrl credential source directory is missing; no migration marker was written")
                        skipped.append(path)
                    else:
                        eligible.append(path)
                with _exclusive_migration_lock(marker):
                    result = migrate_explicit_env_credentials(
                        eligible, marker, store=self.store, check_skipped=lambda: _require_absent_sources(skipped))
                if result.migrated_keys and self.settings is not None:
                    for attempt in range(5):
                        saved = self.settings.snapshot()
                        try:
                            self.settings.update({"providerConfiguration": saved["providerConfiguration"]},
                                                 expected_revision=saved["revision"])
                            break
                        except ConflictError:
                            if attempt == 4:
                                raise AppError("credential_migration_metadata_failed",
                                               "Credential migration completed, but status could not be refreshed. Check credential status before editing.", 503) from None
                    if self.runtime:
                        with self.runtime.database.transaction() as connection:
                            self.runtime.events.append(connection, "CredentialsUpdated", {"keys": list(result.migrated_keys)},
                                                       feature="credentials")
                return result
            finally:
                self._local.guard = None

    @contextmanager
    def mutation_guard(self):
        """Use the same native authority for explicit provider enrollment."""
        guard = MutationGuard(self.lock_path, self.lock_timeout, self.identity_reader)
        with guard.acquire():
            self._local.guard = guard
            self._local.mutation_attempted = False
            try:
                yield guard
            finally:
                self._local.guard = None

    def run_provider_enrollment(self, command, *, input: str | None = None,
                                environment: Mapping[str, str], working_directory: Path, timeout: float = 120.0):
        return self._run_command(command, input=input, timeout=timeout, enrollment=True,
                                 child_environment=environment, child_cwd=working_directory)

    def _run_command(self, command, *, input=None, timeout=5.0, enrollment=False,
                     child_environment: Mapping[str, str] | None = None, child_cwd: Path | None = None, **kwargs):
        guard = getattr(self._local, "guard", None)
        mutating = (enrollment or "add-generic-password" in command or "delete-generic-password" in command
                    or (len(command) > 1 and command[1] in {"store", "clear", "set", "delete"})
                    or (self.system_name == "Windows" and input and '"operation": "set"' in input)
                    or (self.system_name == "Windows" and input and '"operation": "delete"' in input))
        if mutating and guard is None:
            raise CredentialStoreError("operational_failure")
        if mutating:
            guard.begin()
        child = None
        known_exited = False
        try:
            wire_input = input or ""
            launch = command
            if mutating and os.name != "nt":
                launch = [sys.executable, "-I", "-B", "-c", _EXEC_GATE]
                wire_input = json.dumps(command, ensure_ascii=True) + "\n" + wire_input
            allowed = {"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR",
                       "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"}
            environment = (dict(child_environment) if child_environment is not None else
                           {key: value for key, value in self.environ.items() if key in allowed or key.startswith("JOBCTRL_E2E_")})
            suspended = enrollment and os.name == "nt"
            child = subprocess.Popen(launch, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, encoding="utf-8", env=environment,
                                     cwd=str(child_cwd) if child_cwd is not None else None,
                                     **({"creationflags": 0x00000004} if suspended else {}))  # CREATE_SUSPENDED
            if mutating:
                guard.started(child)
                self._local.mutation_attempted = True
                if suspended:
                    _resume_registered_windows_child(child)
            stdout, stderr = child.communicate(wire_input, timeout=timeout)
            known_exited = True
            if len(stdout) > _OUTPUT_LIMIT or len(stderr) > _OUTPUT_LIMIT:
                raise NativeCredentialError("native credential output exceeds its limit")
            return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            raise NativeCredentialError("native credential command timed out") from None
        except (OSError, subprocess.SubprocessError, UnicodeError):
            raise NativeCredentialError("native credential command failed") from None
        finally:
            if child is not None and not known_exited:
                # This exact owned Popen handle is authority. Never signal a marker PID.
                try:
                    child.kill()
                    child.communicate(timeout=1.0)
                    known_exited = True
                except (OSError, subprocess.SubprocessError):
                    pass
            if mutating and (known_exited or child is None):
                guard.clear()


def build_credential_routes(runtime, *, service: CredentialService | None = None) -> tuple[Route, ...]:
    service = service or CredentialService(runtime)

    async def read_payload(request):
        try:
            return await request.json()
        except (ValueError, UnicodeDecodeError):
            raise AppError("invalid_json", "The request must contain valid JSON.") from None

    def saved_revision(value):
        if value is None:
            raise AppError("expected_revision_required", "Check credential status and supply its saved revision.", 428)
        if type(value) is not int or value < 1:
            raise AppError("invalid_revision", "A saved credential revision must be a positive integer.")
        return value

    async def credentials(request):
        if request.method in {"GET", "HEAD"}:
            return JSONResponse(await run_in_threadpool(service.list))
        if request.method != "PATCH":
            raise AppError("method_not_allowed", "This credential operation is unavailable.", 405)
        payload = await read_payload(request)
        if not isinstance(payload, dict) or set(payload) - {"key", "value", "expectedRevision"}:
            raise AppError("invalid_credentials", "Supply a credential key and value.")
        result = await run_in_threadpool(service.apply_batch,
                                        [{"operation": "set", "key": payload.get("key"), "value": payload.get("value")}],
                                        expected_revision=saved_revision(payload.get("expectedRevision")))
        return JSONResponse(result)

    async def batch(request):
        payload = await read_payload(request)
        if not isinstance(payload, dict) or set(payload) - {"operations", "expectedRevision"}:
            raise AppError("invalid_credentials", "Supply credential operations.")
        result = await run_in_threadpool(service.apply_batch, payload.get("operations"),
                                        expected_revision=saved_revision(payload.get("expectedRevision")))
        return JSONResponse(result)

    async def remove(request):
        supplied = request.query_params.get("expectedRevision")
        revision = int(supplied) if supplied and supplied.isdecimal() and len(supplied) <= 16 else None
        result = await run_in_threadpool(service.apply_batch,
                                        [{"operation": "delete", "key": request.path_params["key"]}],
                                        expected_revision=saved_revision(revision))
        return JSONResponse(result)

    return (Route("/v1/credentials", credentials, methods=["GET", "PATCH"]),
            Route("/v1/credentials/batch", batch, methods=["PATCH"]),
            Route("/v1/credentials/{key}", remove, methods=["DELETE"]))
