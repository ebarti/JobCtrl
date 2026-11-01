"""Durable per-launch custody; session exit never proves escaped-tree retirement.

Record intent before spawn. Interrupted publication remains unknown until exact
native completion. No recovered PID/session grants authority to signal.
"""

from __future__ import annotations

import ctypes
from contextlib import contextmanager
import errno
import json
from hashlib import sha256
import os
from pathlib import Path
import platform
import stat
import tempfile
import uuid


class CustodyUnverified(RuntimeError):
    """The persisted resource set cannot yet be proved settled."""


def boot_identity() -> str:
    if platform.system() == "Linux":
        value = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    elif platform.system() == "Darwin":
        library = ctypes.CDLL(None, use_errno=True)
        size = ctypes.c_size_t(0)
        key = b"kern.bootsessionuuid"
        if library.sysctlbyname(key, None, ctypes.byref(size), None, 0) != 0:
            raise CustodyUnverified("Cannot read Apply kernel boot identity")
        buffer = ctypes.create_string_buffer(size.value)
        if library.sysctlbyname(key, buffer, ctypes.byref(size), None, 0) != 0:
            raise CustodyUnverified("Cannot read Apply kernel boot identity")
        value = buffer.value.decode("ascii")
    else:
        raise CustodyUnverified("Durable Apply process custody is unavailable on this platform")
    return str(uuid.UUID(value))


def _id(value: object) -> bool:
    return isinstance(value, str) and len(value) == 32 and all(c in "0123456789abcdef" for c in value)


def _regular(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
        raise CustodyUnverified("Apply custody metadata must be an owned single-link regular file")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise CustodyUnverified("Apply custody metadata must be private to its owner")
    return info


def _directory(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise CustodyUnverified("Apply custody directory must be private and must not redirect")


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _read(path: Path, *, with_bytes: bool = False):
    before = _regular(path)
    if before.st_size > 1_000_000:
        raise CustodyUnverified("Apply custody metadata is oversized")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise CustodyUnverified("Apply custody metadata identity changed")
        def object_pairs(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise CustodyUnverified("Apply custody metadata contains repeated fields")
                value[key] = item
            return value

        content = stream.read()
        value = json.loads(content.decode("utf-8"), object_pairs_hook=object_pairs)
    if not isinstance(value, dict):
        raise CustodyUnverified("Apply custody metadata is malformed")
    return (value, content) if with_bytes else value


_NATIVE_SCOPE_KEYS = {"schemaVersion", "id", "instanceId", "stateDir", "runtimeHome", "bootSession",
                      "jobLabel", "domain", "rootPid", "rootIdentity", "coalitionIds"}


def _valid_execution_root_identity(pid: object, identity: object) -> bool:
    """Match the native controller's PID and unsigned start-time contract."""
    if type(pid) is not int or not 0 < pid < 2**63 or not isinstance(identity, str) or len(identity) > 128:
        return False
    parts = identity.split(":")
    if len(parts) != 3 or parts[0] != str(pid):
        return False
    if any(not value.isascii() or not value.isdigit() for value in parts[1:]):
        return False
    seconds, micros = int(parts[1]), int(parts[2])
    return 0 < seconds < 2**64 and 0 <= micros < 1_000_000


def validate_native_binding(binding: dict | None, app_dir: Path) -> None:
    """Validate dedicated Apply custody, including legacy purpose-less receipts."""
    _validate_execution_binding(binding, app_dir, purpose="apply", allow_legacy=True)


def validate_source_runtime_binding(binding: dict, app_dir: Path) -> None:
    """Validate a source-fleet receipt without granting Apply completion authority."""
    _validate_execution_binding(binding, app_dir, purpose="source", allow_legacy=False)


def _validate_execution_binding(binding: dict | None, app_dir: Path, *, purpose: str, allow_legacy: bool) -> None:
    if binding is None and allow_legacy:
        return
    if not isinstance(binding, dict) or set(binding) != {"scope", "receipt_sha256"}:
        raise CustodyUnverified("Apply native custody binding is malformed")
    scope = binding["scope"]
    digest = binding["receipt_sha256"]
    instance_id = sha256(str(app_dir.resolve(strict=True)).encode("utf-8")).hexdigest()
    if (
        not isinstance(scope, dict) or set(scope) not in (_NATIVE_SCOPE_KEYS, _NATIVE_SCOPE_KEYS | {"purpose"})
        or ("purpose" in scope and scope["purpose"] != purpose)
        or (not allow_legacy and scope.get("purpose") != purpose)
        or type(scope["schemaVersion"]) is not int or scope["schemaVersion"] != 1
        or not _id(scope["id"]) or scope["instanceId"] != instance_id
        or scope["stateDir"] != str(app_dir.resolve(strict=True))
        or not isinstance(scope["runtimeHome"], str) or not os.path.isabs(scope["runtimeHome"])
        or scope["runtimeHome"] != os.path.abspath(scope["runtimeHome"])
        or scope["jobLabel"] != f"dev.jobctrl.exec.{instance_id}.{scope['id']}"
        or scope["domain"] not in (f"gui/{os.getuid()}", f"user/{os.getuid()}")
        or not _valid_execution_root_identity(scope["rootPid"], scope["rootIdentity"])
        or not isinstance(scope["coalitionIds"], list) or len(scope["coalitionIds"]) != 2
        or any(type(value) is not int or not 0 < value < 2**64 for value in scope["coalitionIds"])
        or not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)
    ):
        raise CustodyUnverified("Apply native custody binding does not match this workspace")
    try:
        if str(uuid.UUID(scope["bootSession"])) != scope["bootSession"]:
            raise ValueError("noncanonical boot")
    except (ValueError, TypeError, AttributeError) as exc:
        raise CustodyUnverified("Apply native scope boot identity is malformed") from exc


def _write(path: Path, value: dict) -> None:
    if path.exists() or path.is_symlink():
        _regular(path)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _lock_lifetime(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _close_lifetime(descriptor: int) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


class ApplyCustodyJournal:
    def __init__(self, app_dir: Path, run_id: str, *, native_custody: dict | None = None):
        self.app_dir = app_dir.resolve(strict=True)
        if not _id(run_id):
            raise CustodyUnverified("Invalid Apply launcher identity")
        self.run_id = run_id
        self.root = self.app_dir / "apply-runs"
        self.directory = self.root / run_id
        self.path = self.directory / "custody.json"
        self.value: dict | None = None
        validate_native_binding(native_custody, self.app_dir)
        self.native_custody = native_custody
        self.owner_descriptor: int | None = None

    def load(self) -> dict | None:
        _directory(self.root)
        _directory(self.directory)
        if not self.path.exists() and not self.path.is_symlink():
            return None
        value = _read(self.path)
        if (set(value) != {"schema", "run_id", "app_dir", "owner_pid", "births", "jobs", "native_custody",
                           "owner_lock_identity", "cleanup_failure", "source_best_effort"}
                or type(value["schema"]) is not int or value["schema"] != 3
                or value["run_id"] != self.run_id or value["app_dir"] != str(self.app_dir)
                or type(value["owner_pid"]) is not int or value["owner_pid"] <= 0
                or not isinstance(value["births"], list) or not isinstance(value["jobs"], list)):
            raise CustodyUnverified("Apply custody does not match its physical workspace and run")
        validate_native_binding(value["native_custody"], self.app_dir)
        identity = value["owner_lock_identity"]
        if (not isinstance(identity, list) or len(identity) != 2
                or any(type(item) is not int or item < 0 for item in identity)
                or value["source_best_effort"] not in (True, False) or type(value["source_best_effort"]) is not bool
                or (value["cleanup_failure"] is not None and not isinstance(value["cleanup_failure"], str))):
            raise CustodyUnverified("Apply owner lifetime metadata is malformed")
        seen = set()
        for birth in value["births"]:
            if (not isinstance(birth, dict) or set(birth) != {"id", "worker_id", "kind"}
                    or not _id(birth["id"]) or birth["id"] in seen or type(birth["worker_id"]) is not int
                    or birth["worker_id"] < 0 or not isinstance(birth["kind"], str) or birth["kind"] not in {"browser", "agent"}):
                raise CustodyUnverified("Apply birth intent is malformed")
            seen.add(birth["id"])
        for job in value["jobs"]:
            if (not isinstance(job, dict) or set(job) != {"tenant_id", "job_id", "run_id", "worker_id"}
                    or any(not isinstance(job[k], str) or not job[k] for k in ("tenant_id", "job_id", "run_id"))
                    or type(job["worker_id"]) is not int or job["worker_id"] < 0):
                raise CustodyUnverified("Apply job custody is malformed")
        self.value = value
        return value

    def create(self) -> None:
        self.root.mkdir(mode=0o700, exist_ok=True)
        _directory(self.root)
        self.directory.mkdir(mode=0o700)
        _sync_directory(self.root)
        path = self.directory / "owner.lock"
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.set_inheritable(descriptor, False)
            _lock_lifetime(descriptor)
            info = os.fstat(descriptor)
            from jobctrl.runtime import is_bundled_runtime
            self.value = {"schema": 3, "run_id": self.run_id, "app_dir": str(self.app_dir),
                          "owner_pid": os.getpid(), "births": [], "jobs": [],
                          "native_custody": json.loads(json.dumps(self.native_custody)),
                          "owner_lock_identity": [info.st_dev, info.st_ino], "cleanup_failure": None,
                          "source_best_effort": not is_bundled_runtime() and self.native_custody is None}
            os.fsync(descriptor)
            _sync_directory(self.directory)
            _write(self.path, self.value)
            self.owner_descriptor = descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def close_owner(self) -> None:
        if self.owner_descriptor is not None:
            descriptor, self.owner_descriptor = self.owner_descriptor, None
            _close_lifetime(descriptor)

    def record_cleanup_failure(self, message: str | None) -> None:
        if self.value is not None and self.value["cleanup_failure"] != message:
            self.value["cleanup_failure"] = message
            _write(self.path, self.value)

    @contextmanager
    def ended_source_owner(self):
        """Acquire only an existing exact lifetime file; no descendant proof."""
        if (self.value is None or self.value.get("source_best_effort") is not True
                or self.value["native_custody"] is not None):
            raise CustodyUnverified("Apply owner has no source best-effort recovery contract")
        path = self.directory / "owner.lock"
        _regular(path)
        descriptor = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        locked = False
        try:
            info = os.fstat(descriptor)
            current = path.lstat()
            if ([info.st_dev, info.st_ino] != self.value["owner_lock_identity"]
                    or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)
                    or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                raise CustodyUnverified("Apply source lifetime file identity changed")
            try:
                _lock_lifetime(descriptor)
                locked = True
            except OSError as exc:
                if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise CustodyUnverified("The accepted Apply source owner is still active") from exc
                raise
            if _read(self.path) != self.value or self.value["cleanup_failure"] is not None:
                raise CustodyUnverified("Apply source cleanup has a recorded failure or changed ownership")
            current = path.lstat()
            if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
                raise CustodyUnverified("Apply source lifetime file changed during recovery")
            yield
        finally:
            if locked:
                _close_lifetime(descriptor)
            else:
                os.close(descriptor)

    def reserve(self, worker_id: int, kind: str) -> str:
        birth_id = uuid.uuid4().hex
        self.value["births"].append({"id": birth_id, "worker_id": worker_id, "kind": kind})
        _write(self.path, self.value)
        return birth_id

    def abort_unspawned(self, birth_id: str) -> None:
        """Only synchronous Popen OSError knows no surviving child was created."""
        self.value["births"] = [row for row in self.value["births"] if row["id"] != birth_id]
        _write(self.path, self.value)

    def claim(self, tenant_id: str, job_id: str, run_id: str, worker_id: int = 0) -> None:
        row = {"tenant_id": tenant_id, "job_id": job_id, "run_id": run_id, "worker_id": worker_id}
        if row not in self.value["jobs"]:
            self.value["jobs"].append(row)
            _write(self.path, self.value)

    def retire(self, *, verify_native_completion=None) -> None:
        if _read(self.path) != self.value:
            raise CustodyUnverified("Apply custody changed before retirement")
        if self.value["births"] or self.value["jobs"]:
            if verify_native_completion is None:
                raise CustodyUnverified("Retained Apply custody requires authenticated native completion")
            verify_native_completion(self.value["native_custody"])
        self.path.unlink()
        _sync_directory(self.directory)
        self.value = None


def retire_run_custody(app_dir: Path, run_id: str) -> list[dict]:
    """Retire only the selected manifest after actual native completion."""
    from jobctrl.apply.native_custody import verify_native_completion
    journal = ApplyCustodyJournal(app_dir, run_id)
    value = journal.load()
    if value is None:
        return []
    jobs = list(value["jobs"])
    journal.retire(verify_native_completion=lambda binding: verify_native_completion(binding, journal.app_dir))
    return jobs
