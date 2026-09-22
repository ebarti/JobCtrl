"""Native provider-secret storage and explicit plaintext env migration."""

from __future__ import annotations

import hashlib
import ctypes
import json
import os
import platform
import re
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping, MutableMapping, Sequence

NATIVE_CREDENTIAL_SERVICE = "JobCtrl"
MACOS_SECURITY_BINARY = "/usr/bin/security"
LINUX_SECRET_TOOL_BINARY = "/usr/bin/secret-tool"
NATIVE_COMMAND_TIMEOUT_SECONDS = 5.0
MACOS_COMMAND_TIMEOUT_SECONDS = 2.0
WINDOWS_COMMAND_TIMEOUT_SECONDS = 15.0
WINDOWS_CREDENTIAL_BLOB_MAX_BYTES = 2_560
LINUX_SECRET_TOOL_MAX_INPUT_BYTES = 8_191
MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES = 128
PROVIDER_SECRET_KEYS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "CAPSOLVER_API_KEY",
)

NativeStoreKind = Literal["macos_keychain", "windows_credential_manager", "linux_secret_service"]
NativeCredentialStatus = Literal["explicit", "loaded", "missing", "unavailable", "unsupported"]
NativeCredentialReason = Literal[
    "environment_precedence",
    "loaded",
    "item_not_found",
    "empty_value",
    "binary_missing",
    "command_failed",
    "timeout",
    "unsupported_platform",
]


@dataclass(frozen=True)
class NativeCredentialDiagnostic:
    key: str
    status: NativeCredentialStatus
    reason: NativeCredentialReason


class NativeCredentialError(RuntimeError):
    """Sanitized native-store failure."""


class NativeCredentialMigrationError(RuntimeError):
    """Sanitized fail-closed migration failure."""


def native_store_kind(system_name: str | None = None) -> NativeStoreKind | None:
    system = system_name or platform.system()
    if system == "Darwin":
        return "macos_keychain"
    if system == "Windows":
        return "windows_credential_manager"
    if system == "Linux":
        return "linux_secret_service"
    return None


def native_store_label(system_name: str | None = None) -> str:
    return {
        "macos_keychain": "macOS Keychain",
        "windows_credential_manager": "Windows Credential Manager",
        "linux_secret_service": "Linux Secret Service",
    }.get(native_store_kind(system_name), "native credential store")


def native_credential_target(
    key: str,
    *,
    service: str = NATIVE_CREDENTIAL_SERVICE,
    system_name: str | None = None,
) -> tuple[str, ...]:
    _validate_key(key)
    system = system_name or platform.system()
    if system == "Darwin":
        return (service, key)
    if system == "Linux":
        return ("service", service, "key", key)
    if system == "Windows":
        return (f"{service}:{key}", service)
    return ()


class NativeCredentialStore:
    def __init__(
        self,
        *,
        system_name: str | None = None,
        service: str = NATIVE_CREDENTIAL_SERVICE,
        environ: Mapping[str, str] | None = None,
        run=subprocess.run,
    ) -> None:
        self.system_name = system_name or platform.system()
        self.service = service
        self.environ = environ if environ is not None else os.environ
        self.run = run
        if not (service == NATIVE_CREDENTIAL_SERVICE or re.fullmatch(r"JobCtrl-QA-[0-9a-f-]{36}", service, re.I)):
            raise NativeCredentialError("credential namespace is invalid")

    @property
    def kind(self) -> NativeStoreKind | None:
        return native_store_kind(self.system_name)

    def read(self, key: str) -> str | None:
        completed = self._execute("read", key)
        if completed.returncode == 44:
            return None
        if completed.returncode != 0:
            raise NativeCredentialError("native credential read failed")
        value = _parse_macos_typed_password(completed.stderr) if self.system_name == "Darwin" else completed.stdout
        if not value:
            raise NativeCredentialError("native credential read failed")
        return value

    def inspect(self, key: str) -> bool:
        completed = self._execute("inspect", key)
        if completed.returncode == 44:
            return False
        if completed.returncode != 0:
            raise NativeCredentialError("native credential inspection failed")
        return True

    def write(self, key: str, value: str) -> None:
        _validate_value(self.system_name, value)
        completed = self._execute("set", key, value)
        if completed.returncode != 0:
            raise NativeCredentialError("native credential write failed")

    def delete(self, key: str) -> None:
        completed = self._execute("delete", key)
        if completed.returncode not in (0, 44):
            raise NativeCredentialError("native credential delete failed")

    def _execute(self, operation: str, key: str, value: str | None = None) -> subprocess.CompletedProcess[str]:
        _validate_key(key)
        try:
            if self.system_name == "Darwin":
                return self._execute_macos(operation, key, value)
            if self.system_name == "Linux":
                return self._execute_linux(operation, key, value)
            if self.system_name == "Windows":
                return self._execute_windows(operation, key, value)
        except subprocess.TimeoutExpired as exc:
            raise NativeCredentialError("native credential command timed out") from exc
        except (OSError, subprocess.SubprocessError) as exc:
            raise NativeCredentialError("native credential command failed") from exc
        raise NativeCredentialError("native credential storage is unsupported")

    def _execute_macos(self, operation: str, key: str, value: str | None) -> subprocess.CompletedProcess[str]:
        if not os.access(MACOS_SECURITY_BINARY, os.X_OK):
            raise NativeCredentialError("native credential helper is unavailable")
        if operation == "set":
            command = [MACOS_SECURITY_BINARY, "add-generic-password", "-s", self.service, "-a", key, "-U", "-w"]
            input_value = f"{value}\n{value}\n"
        elif operation == "delete":
            command = [MACOS_SECURITY_BINARY, "delete-generic-password", "-s", self.service, "-a", key]
            input_value = None
        else:
            command = [MACOS_SECURITY_BINARY, "find-generic-password", "-s", self.service, "-a", key]
            if operation == "read":
                command.append("-g")
            input_value = None
        completed = self.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            input=input_value,
            timeout=MACOS_COMMAND_TIMEOUT_SECONDS,
        )
        if _is_macos_missing(completed.returncode, completed.stderr):
            return _completed(command, 44)
        return completed

    def _execute_linux(self, operation: str, key: str, value: str | None) -> subprocess.CompletedProcess[str]:
        if not os.access(LINUX_SECRET_TOOL_BINARY, os.X_OK):
            raise NativeCredentialError("native credential helper is unavailable")
        attributes = ["service", self.service, "key", key]
        timeout = NATIVE_COMMAND_TIMEOUT_SECONDS
        if operation == "set":
            return self.run(
                [LINUX_SECRET_TOOL_BINARY, "store", f"--label={self.service} {key}", *attributes],
                check=False,
                capture_output=True,
                text=True,
                input=value,
                timeout=timeout,
            )
        if operation == "delete":
            cleared = self.run(
                [LINUX_SECRET_TOOL_BINARY, "clear", *attributes],
                check=False,
                capture_output=True,
                text=True,
                input=None,
                timeout=timeout,
            )
            if cleared.returncode == 0 or cleared.stderr or cleared.stdout or cleared.returncode != 1:
                return cleared
            after = self._execute_linux("inspect", key, None)
            return after if after.returncode == 44 else cleared

        lookup = self.run(
            [LINUX_SECRET_TOOL_BINARY, "lookup", *attributes],
            check=False,
            capture_output=True,
            text=True,
            input=None,
            timeout=timeout,
        )
        if lookup.returncode == 0 or lookup.stderr or lookup.returncode != 1 or lookup.stdout:
            return lookup
        search = self.run(
            [LINUX_SECRET_TOOL_BINARY, "search", "--all", *attributes],
            check=False,
            capture_output=True,
            text=True,
            input=None,
            timeout=timeout,
        )
        if search.returncode != 0:
            return search
        if not search.stdout and not search.stderr:
            return _completed(search.args, 44)
        if operation == "inspect":
            return _completed(search.args, 0)
        return _completed(search.args, 1, stderr="credential item is not readable")

    def _execute_windows(self, operation: str, key: str, value: str | None) -> subprocess.CompletedProcess[str]:
        system_root = self.environ.get("SystemRoot", "").strip() or self.environ.get("WINDIR", "").strip()
        if not system_root:
            raise NativeCredentialError("native credential helper is unavailable")
        powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        payload = json.dumps(
            {"operation": operation, "service": self.service, "key": key, **({"value": value} if value is not None else {})},
            ensure_ascii=True,
        )
        return self.run(
            [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            input=payload,
            timeout=WINDOWS_COMMAND_TIMEOUT_SECONDS,
        )


def load_native_credential_fallbacks(
    *,
    env: MutableMapping[str, str] = os.environ,
    system_name: str | None = None,
    store: NativeCredentialStore | None = None,
) -> tuple[NativeCredentialDiagnostic, ...]:
    diagnostics: list[NativeCredentialDiagnostic] = []
    active_store = store or NativeCredentialStore(system_name=system_name)
    for key in PROVIDER_SECRET_KEYS:
        if env.get(key):
            diagnostics.append(NativeCredentialDiagnostic(key, "explicit", "environment_precedence"))
            continue
        if active_store.kind is None:
            diagnostics.append(NativeCredentialDiagnostic(key, "unsupported", "unsupported_platform"))
            continue
        try:
            value = active_store.read(key)
        except NativeCredentialError:
            diagnostics.append(NativeCredentialDiagnostic(key, "unavailable", "command_failed"))
            continue
        if value is None:
            diagnostics.append(NativeCredentialDiagnostic(key, "missing", "item_not_found"))
        elif value == "":
            diagnostics.append(NativeCredentialDiagnostic(key, "unavailable", "empty_value"))
        else:
            env[key] = value
            diagnostics.append(NativeCredentialDiagnostic(key, "loaded", "loaded"))
    return tuple(diagnostics)


@dataclass(frozen=True)
class MigrationResult:
    migrated_keys: tuple[str, ...]
    source_files: tuple[str, ...]
    already_completed: bool


def migrate_persistent_env_credentials(
    paths: Sequence[Path],
    marker_path: Path,
    *,
    store: NativeCredentialStore | None = None,
) -> MigrationResult:
    """Move fixed allowlisted secrets from exact env files into the native store."""

    with _exclusive_migration_lock(marker_path):
        return _migrate_persistent_env_credentials(paths, marker_path, store=store)


def _migrate_persistent_env_credentials(
    paths: Sequence[Path],
    marker_path: Path,
    *,
    store: NativeCredentialStore | None = None,
) -> MigrationResult:
    """Run one migration while the caller holds the marker-scoped lock."""

    if marker_path.is_symlink():
        raise NativeCredentialMigrationError("credential migration refuses a symbolic-link marker")
    if marker_path.exists():
        _validate_completion_marker(marker_path)
        return MigrationResult((), (), True)
    active_store = store or NativeCredentialStore()
    if active_store.kind is None:
        raise NativeCredentialMigrationError("native credential storage is unsupported")

    sources: list[tuple[Path, str, os.stat_result]] = []
    assignments: dict[str, list[str]] = {}
    for candidate in paths:
        expanded = candidate.expanduser()
        if expanded.is_symlink():
            raise NativeCredentialMigrationError("credential migration refuses symbolic-link sources")
        path = expanded.resolve(strict=False)
        if not path.exists():
            continue
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise NativeCredentialMigrationError("credential migration requires regular files")
        text = _read_utf8_exact(path)
        for key, values in _parse_secret_assignments(text).items():
            assignments.setdefault(key, []).extend(values)
        sources.append((path, text, metadata))

    effective: dict[str, str] = {}
    for key, values in assignments.items():
        if not values or not values[-1]:
            continue
        effective[key] = values[-1]
    if not effective:
        _write_marker(marker_path, ())
        return MigrationResult((), tuple(str(path) for path, _, _ in sources), False)

    updated_sources: dict[Path, str] = {}
    for path, original, _metadata in sources:
        updated = _remove_migrated_assignments(original, set(effective))
        _reject_retained_secret_references(updated, set(effective))
        updated_sources[path] = updated

    snapshots: dict[str, str | None] = {}
    changed_store: list[str] = []
    rewritten: list[tuple[Path, str, os.stat_result, str, os.stat_result]] = []
    try:
        for key, value in effective.items():
            _validate_value(active_store.system_name, value)
            existing = active_store.read(key)
            snapshots[key] = existing
            if existing is not None and existing != value:
                raise NativeCredentialMigrationError("native credential conflict; source files were preserved")
        for key, value in effective.items():
            if snapshots[key] is None:
                active_store.write(key, value)
                changed_store.append(key)
            if active_store.read(key) != value:
                raise NativeCredentialMigrationError("native credential verification failed; source files were preserved")

        for path, original, metadata in sources:
            current = _read_utf8_exact(path)
            current_meta = path.stat()
            if _fingerprint(current, current_meta) != _fingerprint(original, metadata):
                raise NativeCredentialMigrationError("credential source changed during migration")
            updated = updated_sources[path]
            if updated == original:
                continue
            _atomic_write(
                path,
                updated,
                stat.S_IMODE(metadata.st_mode),
                expected=_fingerprint(original, metadata),
            )
            rewritten.append((path, original, metadata, updated, path.stat()))
        _write_marker(marker_path, tuple(sorted(effective)))
    except Exception as exc:
        recovery_failed = False
        for path, original, metadata, updated, updated_metadata in reversed(rewritten):
            try:
                current = _read_utf8_exact(path)
                if _fingerprint(current, path.stat()) != _fingerprint(updated, updated_metadata):
                    recovery_failed = True
                    continue
                _atomic_write(
                    path,
                    original,
                    stat.S_IMODE(metadata.st_mode),
                    expected=_fingerprint(updated, updated_metadata),
                )
            except OSError:
                recovery_failed = True
        # If even one plaintext source could not be restored, keep every
        # verified native value. Deleting it here could remove the only
        # surviving copy of a credential.
        if not recovery_failed:
            for key in reversed(changed_store):
                try:
                    previous = snapshots[key]
                    if previous is None:
                        active_store.delete(key)
                    else:
                        active_store.write(key, previous)
                except NativeCredentialError:
                    recovery_failed = True
        if recovery_failed:
            raise NativeCredentialMigrationError("credential migration failed and recovery was incomplete") from exc
        if isinstance(exc, NativeCredentialMigrationError):
            raise
        raise NativeCredentialMigrationError("credential migration failed; source files were preserved") from exc
    return MigrationResult(tuple(sorted(effective)), tuple(str(path) for path, _, _ in sources), False)


@contextmanager
def _exclusive_migration_lock(marker_path: Path):
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = marker_path.with_name(f".{marker_path.name}.lock")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except FileExistsError as exc:
        raise NativeCredentialMigrationError("another credential migration is already in progress") from exc
    try:
        yield
    finally:
        os.close(descriptor)
        lock_path.unlink(missing_ok=True)


def _validate_completion_marker(path: Path) -> None:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4_096:
        raise NativeCredentialMigrationError("credential migration completion marker is invalid")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise NativeCredentialMigrationError("credential migration completion marker is invalid") from exc
    if not isinstance(payload, dict) or set(payload) != {"version", "migratedKeys"}:
        raise NativeCredentialMigrationError("credential migration completion marker is invalid")
    keys = payload.get("migratedKeys")
    if (
        payload.get("version") != 1
        or not isinstance(keys, list)
        or any(not isinstance(key, str) or key not in PROVIDER_SECRET_KEYS for key in keys)
        or len(keys) != len(set(keys))
    ):
        raise NativeCredentialMigrationError("credential migration completion marker is invalid")


_ASSIGNMENT_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", re.ASCII)
_SUPPORTED_PREFIX_RE = re.compile(
    r"^\s*(?:export\s+)?(" + "|".join(PROVIDER_SECRET_KEYS) + r")\b",
    re.ASCII,
)


def _parse_secret_assignments(text: str) -> dict[str, list[str]]:
    _reject_multiline_assignments(text)
    found: dict[str, list[str]] = {}
    for line in text.splitlines():
        match = _ASSIGNMENT_RE.match(line)
        if not match:
            if _SUPPORTED_PREFIX_RE.match(line):
                raise NativeCredentialMigrationError("credential migration found a malformed assignment")
            continue
        if match.group(1) not in PROVIDER_SECRET_KEYS:
            continue
        key = match.group(1)
        raw = line[match.end():].lstrip()
        value = _parse_shell_literal(raw)
        found.setdefault(key, []).append(value)
    return found


def _parse_shell_literal(raw: str) -> str:
    """Parse only assignments whose value is identical under bash `source`."""

    if not raw:
        return ""
    if raw[0] == "'":
        closing = raw.find("'", 1)
        if closing < 0 or not _only_trailing_comment(raw[closing + 1:]):
            raise NativeCredentialMigrationError("credential migration found an ambiguous quoted assignment")
        value = raw[1:closing]
        if "\\" in value:
            raise NativeCredentialMigrationError("credential migration refuses ambiguous escape sequences")
        return value
    if raw[0] == '"':
        value: list[str] = []
        index = 1
        while index < len(raw):
            character = raw[index]
            if character == '"':
                if not _only_trailing_comment(raw[index + 1:]):
                    raise NativeCredentialMigrationError("credential migration found an ambiguous quoted assignment")
                return "".join(value)
            if character in ("$", "`"):
                raise NativeCredentialMigrationError("credential migration refuses interpolated assignments")
            if character == "\\":
                index += 1
                if index >= len(raw):
                    raise NativeCredentialMigrationError("credential migration found a malformed assignment")
                escaped = raw[index]
                if escaped in ('"', "\\"):
                    value.append(escaped)
                elif escaped in ("$", "`"):
                    raise NativeCredentialMigrationError("credential migration refuses interpolated assignments")
                else:
                    raise NativeCredentialMigrationError("credential migration refuses ambiguous escape sequences")
            else:
                value.append(character)
            index += 1
        raise NativeCredentialMigrationError("credential migration refuses multiline env assignments")

    match = re.fullmatch(r"([^\s#]*)(?:\s+#.*)?", raw)
    if match is None:
        raise NativeCredentialMigrationError("credential migration found an ambiguous unquoted assignment")
    value = match.group(1)
    if re.search(r"[\\$`'\"!;&|<>(){}*?\[\]~]", value):
        raise NativeCredentialMigrationError("credential migration refuses shell-expanded assignments")
    return value


def _only_trailing_comment(value: str) -> bool:
    if not value.strip():
        return True
    return value[0].isspace() and value.lstrip().startswith("#")


def _reject_multiline_assignments(text: str) -> None:
    """Fail closed instead of interpreting assignment-like quoted content."""

    for line in text.splitlines():
        if "=" not in line:
            continue
        raw = line.split("=", 1)[1].lstrip()
        if not raw or raw[0] not in ("'", '"'):
            continue
        quote = raw[0]
        escaped = False
        for character in raw[1:]:
            if quote == '"' and character == "\\" and not escaped:
                escaped = True
                continue
            if character == quote and not escaped:
                break
            escaped = False
        else:
            raise NativeCredentialMigrationError("credential migration refuses multiline env assignments")


def _remove_migrated_assignments(text: str, keys: set[str]) -> str:
    retained: list[str] = []
    for line in text.splitlines(keepends=True):
        match = _ASSIGNMENT_RE.match(line)
        if match and match.group(1) in keys:
            continue
        retained.append(line)
    return "".join(retained)


def _reject_retained_secret_references(text: str, keys: set[str]) -> None:
    """Reject env assignments whose value depends on a secret being removed."""

    alternatives = "|".join(re.escape(key) for key in sorted(keys))
    reference = re.compile(rf"\$(?:\{{(?:{alternatives})(?:[^}}]*)\}}|(?:{alternatives})\b)")
    for line in text.splitlines():
        match = _ASSIGNMENT_RE.match(line)
        if match and reference.search(line[match.end():]):
            raise NativeCredentialMigrationError(
                "credential migration found a retained assignment that depends on a migrated credential"
            )


def _atomic_write(
    path: Path,
    text: str,
    mode: int,
    *,
    expected: tuple[int, int, str] | None = None,
) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        _set_temporary_mode(descriptor, Path(temporary), path, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if expected is not None:
            current = _read_utf8_exact(path)
            if _fingerprint(current, path.stat()) != expected:
                raise NativeCredentialMigrationError("credential source changed during migration")
        os.replace(temporary, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        Path(temporary).unlink(missing_ok=True)
        raise


def _read_utf8_exact(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def _set_temporary_mode(descriptor: int, temporary: Path, destination: Path, mode: int) -> None:
    if os.name == "nt":
        # Python 3.11/3.12 do not expose fchmod on Windows, and os.replace does
        # not preserve the replaced file's DACL. Copy the exact source DACL to
        # the empty temp before any plaintext is written.
        if destination.exists():
            _copy_windows_dacl(destination, temporary)
        return
    os.fchmod(descriptor, mode & 0o777)


def _copy_windows_dacl(source: Path, destination: Path) -> None:
    dacl_information = 0x00000004
    protected_dacl_information = 0x80000000
    unprotected_dacl_information = 0x20000000
    se_dacl_protected = 0x1000
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    get_security = advapi32.GetFileSecurityW
    set_security = advapi32.SetFileSecurityW
    get_control = advapi32.GetSecurityDescriptorControl
    get_security.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
    get_security.restype = ctypes.c_int
    set_security.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p]
    set_security.restype = ctypes.c_int
    get_control.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint16), ctypes.POINTER(ctypes.c_uint32)]
    get_control.restype = ctypes.c_int
    needed = ctypes.c_uint32(0)
    get_security(str(source), dacl_information, None, 0, ctypes.byref(needed))
    if needed.value == 0:
        raise OSError(ctypes.get_last_error(), "could not read source file permissions")
    descriptor = ctypes.create_string_buffer(needed.value)
    if not get_security(
        str(source), dacl_information, descriptor, needed.value, ctypes.byref(needed)
    ):
        raise OSError(ctypes.get_last_error(), "could not read source file permissions")
    control = ctypes.c_uint16(0)
    revision = ctypes.c_uint32(0)
    if not get_control(descriptor, ctypes.byref(control), ctypes.byref(revision)):
        raise OSError(ctypes.get_last_error(), "could not inspect source file permissions")
    security_information = dacl_information | (
        protected_dacl_information if control.value & se_dacl_protected else unprotected_dacl_information
    )
    if not set_security(str(destination), security_information, descriptor):
        raise OSError(ctypes.get_last_error(), "could not protect credential migration temp file")


def _write_marker(path: Path, keys: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"version": 1, "migratedKeys": list(keys)}, sort_keys=True) + "\n"
    _atomic_write(path, payload, 0o600)


def _fingerprint(text: str, metadata: os.stat_result) -> tuple[int, int, str]:
    return metadata.st_ino, metadata.st_mtime_ns, hashlib.sha256(text.encode("utf-8")).hexdigest()


def _validate_key(key: str) -> None:
    if key not in PROVIDER_SECRET_KEYS:
        raise NativeCredentialError("credential key is not allowlisted")


def _validate_value(system_name: str, value: str) -> None:
    if not value or "\x00" in value or "\r" in value or "\n" in value or len(value) > 8_000:
        raise NativeCredentialError("credential value is unsupported")
    if system_name == "Darwin" and len(value.encode("utf-8")) > MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES:
        raise NativeCredentialError("credential value is unsupported")
    if system_name == "Linux" and len(value.encode("utf-8")) > LINUX_SECRET_TOOL_MAX_INPUT_BYTES:
        raise NativeCredentialError("credential value is unsupported")
    if system_name == "Windows" and len(value.encode("utf-16-le")) > WINDOWS_CREDENTIAL_BLOB_MAX_BYTES:
        raise NativeCredentialError("credential value is unsupported")


def _is_macos_missing(returncode: int, stderr: str) -> bool:
    if returncode == 44:
        return True
    sanitized = re.sub(r"^security:\s*[^:\r\n]+:\s*", "", stderr.strip(), flags=re.I)
    return sanitized.lower() in {
        "the specified item could not be found.",
        "the specified item could not be found in the keychain.",
    }


def _parse_macos_typed_password(stderr: str) -> str | None:
    line = next((entry for entry in stderr.splitlines() if entry.startswith("password: ")), None)
    if line is None:
        return None
    payload = line[len("password: "):]
    hex_match = re.match(r"^0x([0-9a-f]+)(?:\s|$)", payload, re.I)
    if hex_match:
        try:
            return bytes.fromhex(hex_match.group(1)).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    if not (payload.startswith('"') and payload.endswith('"')):
        return None
    # `security -g` leaves embedded ASCII quotes unescaped. Binary and
    # backslash-bearing values use the typed 0x form, so only trim delimiters.
    return payload[1:-1]


def _completed(args: object, code: int, *, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args, code, stdout=stdout, stderr=stderr)


WINDOWS_CREDENTIAL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class JobCtrlCred {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
 [DllImport("advapi32.dll", EntryPoint="CredFree")] public static extern void CredFree(IntPtr buffer);
}
'@
try {
 Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
 [Console]::InputEncoding = New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
 Add-Type -TypeDefinition $source -ErrorAction Stop
 $data = [Console]::In.ReadToEnd() | ConvertFrom-Json; $target = [string]$data.service + ':' + [string]$data.key; $pointer = [IntPtr]::Zero
 if ($data.operation -eq 'set') { $bytes=[Text.Encoding]::Unicode.GetBytes([string]$data.value); if ($bytes.Length -gt 2560) { exit 1 }; $blob=[Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length); try { [Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length); $credential=New-Object JobCtrlCred+CREDENTIAL; $credential.Type=1; $credential.TargetName=$target; $credential.UserName=[string]$data.service; $credential.CredentialBlob=$blob; $credential.CredentialBlobSize=$bytes.Length; $credential.Persist=2; if (-not [JobCtrlCred]::CredWrite([ref]$credential,0)) { exit 1 }; exit 0 } finally { for($i=0;$i -lt $bytes.Length;$i++){[Runtime.InteropServices.Marshal]::WriteByte($blob,$i,0)}; [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob); [Array]::Clear($bytes,0,$bytes.Length) } }
 if ($data.operation -eq 'delete') { if ([JobCtrlCred]::CredDelete($target,1,0)){exit 0}; if([Runtime.InteropServices.Marshal]::GetLastWin32Error()-eq 1168){exit 44}; exit 1 }
 if (-not [JobCtrlCred]::CredRead($target,1,0,[ref]$pointer)) { if([Runtime.InteropServices.Marshal]::GetLastWin32Error()-eq 1168){exit 44}; exit 1 }
 try { if($data.operation -eq 'inspect'){exit 0}; $credential=[Runtime.InteropServices.Marshal]::PtrToStructure($pointer,[type][JobCtrlCred+CREDENTIAL]); if($credential.CredentialBlobSize -eq 0){exit 1}; $secret=[Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob,$credential.CredentialBlobSize/2); [Console]::Out.Write($secret); exit 0 } finally { [JobCtrlCred]::CredFree($pointer) }
} catch { exit 1 }
"""
