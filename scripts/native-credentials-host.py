"""Opt-in real native-store proof; all credentials and files are synthetic.

Requires Node workspace dependencies and the locked core worker runtime. Linux
must run inside an owned dbus-run-session with --linux-session; it never uses
the user's bus.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PHASE = "setup"
PHASE_STARTED = time.monotonic()
PHASE_NAMES = {
    "setup", "migration_runtime", "api_set", "api_delete", "api_list", "initial_native_read",
    "cross_runtime_readback", "windows_acl_setup", "migration_setup", "migration",
    "migration_result", "migration_source_readback", "migration_acl_readback",
    "migration_native_readback", "migration_marker", "migration_once",
    "runtime_precedence", "windows_acl_rollback", "cleanup_native_delete",
    "cleanup_native_read", "cleanup_daemon", "cleanup_files",
}
spec = importlib.util.spec_from_file_location(
    "native_credentials_host_under_test",
    ROOT / "workers/automation/src/jobctrl/native_credentials.py",
)
assert spec and spec.loader
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


class NativeHostProofFailure(RuntimeError):
    def __init__(self, primary: dict | None, cleanup: list[dict]) -> None:
        super().__init__("Native host proof failed")
        self.primary = primary
        self.cleanup = cleanup


def set_phase(phase: str) -> None:
    global PHASE, PHASE_STARTED
    if phase not in PHASE_NAMES:
        raise ValueError("Native QA phase is not recognized")
    PHASE = phase
    PHASE_STARTED = time.monotonic()


def error_type(error: BaseException | None) -> str:
    name = type(error).__name__
    return name if name in {
        "AssertionError", "FileNotFoundError", "JSONDecodeError", "NativeCredentialError",
        "NativeCredentialMigrationError", "OSError", "PermissionError", "RuntimeError",
        "TimeoutExpired", "TypeError", "ValueError",
    } else "None" if error is None else "OtherError"


def failure(error: BaseException) -> dict:
    return {"phase": PHASE, "elapsedMs": round((time.monotonic() - PHASE_STARTED) * 1000),
            "errorType": error_type(error), "causeType": error_type(error.__cause__)}


WINDOWS_PHASES = {
    "script_started", "module_load", "module_loaded", "compilation", "compiled",
    "input_parsing", "input_parsed", "native_call", "native_returned", "script_exit",
}
WINDOWS_PHASE_PREFIX = "JOBCTRL_NATIVE_QA_PHASE:"


def windows_phases(stderr: str | bytes | None) -> list[dict]:
    text = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else stderr or ""
    phases = []
    for line in text.splitlines():
        prefix, separator, timing = line.rpartition(":")
        if not separator or not prefix.startswith(WINDOWS_PHASE_PREFIX):
            continue
        phase = prefix[len(WINDOWS_PHASE_PREFIX):]
        if phase in WINDOWS_PHASES and timing.isascii() and timing.isdecimal() and len(timing) <= 16:
            phases.append({"phase": phase, "elapsedMs": int(timing)})
    return phases


def instrument_windows_script(script: str) -> str:
    def mark(phase: str) -> str:
        return f"Write-JobCtrlQaPhase '{phase}'"

    # Exact anchors fail closed if the product script changes. Only fixed
    # stderr markers are added; request bytes, native calls and exits stay intact.
    replacements = (
        (' Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop',
         "module_load", "module_loaded"),
        (" Add-Type -TypeDefinition $source -ErrorAction Stop", "compilation", "compiled"),
        (" $data = [Console]::In.ReadToEnd() | ConvertFrom-Json;", "input_parsing", "input_parsed"),
    )
    for anchor, before, after in replacements:
        if script.count(anchor) != 1:
            raise RuntimeError("Native Windows QA diagnostic boundary changed")
        script = script.replace(anchor, f" {mark(before)}\n{anchor}\n {mark(after)};", 1)
    for anchor in (
        "if (-not [JobCtrlCred]::CredWrite([ref]$credential,0))",
        "if ([JobCtrlCred]::CredDelete($target,1,0))",
        "if (-not [JobCtrlCred]::CredRead($target,1,0,[ref]$pointer))",
    ):
        if script.count(anchor) != 1:
            raise RuntimeError("Native Windows QA diagnostic boundary changed")
        script = script.replace(anchor, f"{mark('native_call')}; {anchor}", 1)
    anchor = " try { if($data.operation -eq 'inspect')"
    if script.count(anchor) != 1:
        raise RuntimeError("Native Windows QA diagnostic boundary changed")
    script = script.replace(anchor, f" {mark('native_returned')}\n{anchor}", 1)
    # These markers run after conditional Win32-error checks. Do not place
    # diagnostic calls between a failed native call and GetLastWin32Error().
    script = script.replace("exit ", f"{mark('script_exit')}; exit ")
    preamble = r"""
$jobctrlQaClock = [Diagnostics.Stopwatch]::StartNew()
function Write-JobCtrlQaPhase([string]$jobctrlPhase) {
  [Console]::Error.WriteLine('JOBCTRL_NATIVE_QA_PHASE:' + $jobctrlPhase + ':' + $jobctrlQaClock.ElapsedMilliseconds)
}
Write-JobCtrlQaPhase 'script_started'
"""
    return preamble + script


def native_run(command: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    if not command or command[-1] != native.WINDOWS_CREDENTIAL_SCRIPT:
        return subprocess.run(command, **kwargs)
    instrumented = [*command[:-1], instrument_windows_script(command[-1])]
    started = time.monotonic()
    stderr = None
    error = None
    try:
        result = subprocess.run(instrumented, **kwargs)
        stderr = result.stderr
        return result
    except (OSError, subprocess.SubprocessError) as caught:
        error = caught
        stderr = getattr(caught, "stderr", None)
        raise
    finally:
        print(json.dumps({"phase": PHASE, "windowsPhases": windows_phases(stderr),
                          "elapsedMs": round((time.monotonic() - started) * 1000),
                          "errorType": error_type(error)}), file=sys.stderr, flush=True)


def cleanup_owned_target(store, key: str, daemon) -> list[dict]:
    failures = []
    try:
        set_phase("cleanup_native_delete")
        store.delete(key)
        set_phase("cleanup_native_read")
        assert store.read(key) is None, "Synthetic native credential cleanup failed"
    except Exception as error:
        failures.append(failure(error))
    if daemon is not None:
        try:
            set_phase("cleanup_daemon")
            daemon.terminate()
            try:
                daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=5)
        except Exception as error:
            failures.append(failure(error))
    return failures


def failure_diagnostic(error: Exception) -> dict:
    # TemporaryDirectory cleanup can also raise while the proof is unwinding.
    # Recover its typed context without serializing any exception messages.
    proof = error
    seen = set()
    while proof is not None and not isinstance(proof, NativeHostProofFailure) and id(proof) not in seen:
        seen.add(id(proof))
        proof = proof.__context__
    if isinstance(proof, NativeHostProofFailure):
        primary, cleanup = proof.primary, list(proof.cleanup)
        if proof is not error:
            cleanup.append(failure(error))
    elif PHASE == "cleanup_files":
        primary, cleanup = None, [failure(error)]
    else:
        primary, cleanup = failure(error), []
    first = primary or cleanup[0]
    return {"platform": platform.system(), "status": "failed", **first,
            "primaryFailure": primary, "cleanupFailures": cleanup}


def windows_acl(path: Path, *, restrict: bool = False) -> str:
    """Set/check synthetic file permissions; never prints an account or secret."""
    script = r"""
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.restrict) {
  $parent = Split-Path -Parent $request.path
  $directoryAcl = Get-Acl -LiteralPath $parent
  $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
  $broad = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $directoryAcl.AddAccessRule($broad)
  Set-Acl -LiteralPath $parent -AclObject $directoryAcl
  $acl = Get-Acl -LiteralPath $request.path
  $acl.SetAccessRuleProtection($true, $false)
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($current, 'FullControl', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $request.path -AclObject $acl
}
$result = Get-Acl -LiteralPath $request.path
[Console]::Out.Write($result.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
"""
    binary = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run(
        [str(binary), "-NoProfile", "-NonInteractive", "-Command", script],
        input=json.dumps({"path": str(path), "restrict": restrict}),
        encoding="utf-8", capture_output=True, timeout=30,
    )
    if result.returncode or not result.stdout:
        raise RuntimeError("Windows synthetic ACL fixture failed")
    return result.stdout


def assert_windows_acl_preserved(before: str, after: str) -> None:
    before_flags, _, before_entries = before.partition("(")
    after_flags, _, after_entries = after.partition("(")
    # SetFileSecurity may clear AI on a copied protected file. The exact ACEs
    # and P protection still govern access; a regular file has no child ACLs
    # to propagate. Do not normalize protection, inheritance requests or ACEs.
    same_protected_access = (
        "P" in before_flags and "P" in after_flags
        and before_flags.replace("AI", "") == after_flags.replace("AI", "")
        and before_entries == after_entries
    )
    preserved = before == after or same_protected_access
    if not preserved:
        flags = [value if all(char in "D:PAIR" for char in value) else "unrecognized"
                 for value in (before_flags, after_flags)]
        print(json.dumps({"windowsAclMismatch": True, "controlFlags": flags,
                          "accessEntriesEqual": before_entries == after_entries}), flush=True)
    assert preserved, "Migration changed the source DACL"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--linux-session", action="store_true")
    args = parser.parse_args()
    if platform.system() == "Linux" and not args.linux_session:
        raise RuntimeError("Linux native QA requires an owned D-Bus session")
    service = f"JobCtrl-QA-{uuid.uuid4()}"
    key = "GEMINI_API_KEY"
    # Carry OS/session plumbing only, never ambient provider credentials.
    safe_env = {key: os.environ[key] for key in (
        "PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP",
        "TMPDIR", "LOCALAPPDATA", "APPDATA", "DBUS_SESSION_BUS_ADDRESS",
        "SystemDrive", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)",
        "ProgramW6432", "ProgramData", "HOMEDRIVE", "HOMEPATH",
    ) if key in os.environ}
    os.environ.clear()
    os.environ.update(safe_env)
    store = native.NativeCredentialStore(service=service, run=native_run)
    daemon = None
    with tempfile.TemporaryDirectory(prefix="jobctrl-native-host-") as directory:
        owned = Path(directory)
        os.environ.update({
            "JOBCTRL_DIR": str(owned),
            "JOBCTRL_CONFIG_PATH": str(owned / "config.json"),
            "LANGFUSE_DISABLE": "1",
            "OTEL_SDK_DISABLED": "true",
        })
        if args.linux_session:
            for name, folder in (("HOME", "home"), ("XDG_DATA_HOME", "data"), ("XDG_RUNTIME_DIR", "run")):
                location = owned / folder
                location.mkdir(mode=0o700)
                os.environ[name] = str(location)
            daemon = subprocess.Popen(
                ["gnome-keyring-daemon", "--foreground", "--components=secrets", "--unlock"],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            assert daemon.stdin
            daemon.stdin.write(secrets.token_hex(24).encode())
            daemon.stdin.close()
            deadline = time.monotonic() + 15
            while True:
                try:
                    # Looking up a secret before our daemon owns the bus name can
                    # activate a different daemon with the bus launcher's HOME.
                    # Query the bus itself, which never activates Secret Service.
                    owner = subprocess.run(
                        ["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus",
                         "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner",
                         "string:org.freedesktop.secrets"],
                        capture_output=True, text=True, timeout=5,
                    )
                    if owner.returncode or "boolean true" not in owner.stdout:
                        raise native.NativeCredentialError("Owned daemon is not ready")
                    store.inspect(key)
                    break
                except native.NativeCredentialError:
                    if daemon.poll() is not None or time.monotonic() >= deadline:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            daemon.wait(timeout=5)
                        raise RuntimeError("Owned Linux Secret Service did not become ready") from None
                    time.sleep(0.1)

        def api(operation: str, value: str | None = None, *, expect_failure: bool = False) -> dict:
            set_phase(f"api_{operation}")
            payload = {"service": service, "configPath": str(owned / "config.json"), "operation": operation, "value": value}
            result = subprocess.run(
                [shutil.which("node") or "node", str(ROOT / "apps/api/node_modules/tsx/dist/cli.mjs"), str(ROOT / "apps/api/test/native-credentials-host.ts")],
                input=json.dumps(payload), encoding="utf-8", capture_output=True, timeout=60, cwd=ROOT,
                env={**os.environ, "JOBCTRL_PYTHON_EXECUTABLE": sys.executable},
            )
            if value and (value in result.stdout or value in result.stderr):
                raise RuntimeError("Native API bridge exposed a secret")
            if expect_failure:
                assert result.returncode != 0, "Oversized native credential must be rejected"
                return {}
            if result.returncode:
                raise RuntimeError("Native API bridge failed")
            response = json.loads(result.stdout)
            return response

        primary_failure = None
        cleanup_failures = []
        try:
            # Verify the real migration lock runtime before writing a credential.
            set_phase("migration_runtime")
            from jobctrl import config

            assert config.APP_DIR == owned
            assert config.get_config_path() == owned / "config.json"
            set_phase("initial_native_read")
            assert store.read(key) is None, "Synthetic target must start absent"
            # Cross-runtime exactness, including quote/backslash/Unicode and hex-looking ASCII.
            maximum_ascii = {"Darwin": 128, "Windows": 1280, "Linux": 8000}[platform.system()]
            for value in ("  synthetic-" + secrets.token_hex(16) + "  ", 'synthetic-"quoted"-\\-snowman-☃', "deadbeef001122", "s" * maximum_ascii):
                response = api("set", value)
                entry = next(item for item in response["credentials"] if item["key"] == key)
                assert entry["configured"] is True
                assert response["store"]["requiresWorkerRestart"] is True
                set_phase("cross_runtime_readback")
                assert store.read(key) == value, "API writer / Python reader exactness"
            oversize = {"Darwin": "é" * 65, "Windows": "é" * 1281, "Linux": "é" * 4096}[platform.system()]
            api("set", oversize, expect_failure=True)
            assert store.read(key) == value, "Rejected API write changed the native credential"
            try:
                store.write(key, oversize)
            except native.NativeCredentialError:
                pass
            else:
                raise AssertionError("Python must reject oversized native writes")
            assert store.read(key) == value, "Rejected Python write changed the native credential"
            api("delete")
            assert store.read(key) is None, "API delete must remove Python-visible entry"
            api("delete")

            value = "synthetic-migration-" + secrets.token_hex(20)
            source = owned / ".env"
            source.write_bytes(f"KEEP=untouched\r\n{key}='{value}'\r\n".encode("utf-8"))
            set_phase("windows_acl_setup" if platform.system() == "Windows" else "migration_setup")
            acl_before = windows_acl(source, restrict=True) if platform.system() == "Windows" else None
            marker = owned / "migration.json"
            set_phase("migration")
            result = native.migrate_persistent_env_credentials([source], marker, store=store)
            set_phase("migration_result")
            assert not result.already_completed
            set_phase("migration_source_readback")
            assert source.read_bytes() == b"KEEP=untouched\r\n"
            if acl_before is not None:
                set_phase("migration_acl_readback")
                assert_windows_acl_preserved(acl_before, windows_acl(source))
            set_phase("migration_native_readback")
            assert store.read(key) == value, "Migrated credential must survive source removal"
            set_phase("migration_marker")
            assert value not in marker.read_text(encoding="utf-8")
            set_phase("migration_once")
            assert native.migrate_persistent_env_credentials([source], marker, store=store).already_completed
            response = api("list")
            assert value not in json.dumps(response)
            assert next(item for item in response["credentials"] if item["key"] == key)["configured"] is True
            env = {name: "synthetic-inherited" for name in native.PROVIDER_SECRET_KEYS}
            set_phase("runtime_precedence")
            native.load_native_credential_fallbacks(env=env, store=store)
            assert env[key] == "synthetic-inherited"
            env[key] = ""
            native.load_native_credential_fallbacks(env=env, store=store)
            assert env[key] == value
            api("delete")
            assert store.read(key) is None
            if acl_before is not None:
                set_phase("windows_acl_rollback")
                original = f"KEEP=untouched\r\n{key}='{value}'\r\n".encode("utf-8")
                source.write_bytes(original)
                write_marker = native._write_marker

                def fail_marker(*_args, **_kwargs):
                    raise OSError("synthetic marker failure")

                native._write_marker = fail_marker
                try:
                    try:
                        native.migrate_persistent_env_credentials([source], owned / "rollback.json", store=store)
                    except native.NativeCredentialMigrationError:
                        pass
                    else:
                        raise AssertionError("Injected marker failure must fail migration")
                finally:
                    native._write_marker = write_marker
                assert source.read_bytes() == original
                assert_windows_acl_preserved(acl_before, windows_acl(source))
                assert store.read(key) is None
        except Exception as error:
            primary_failure = failure(error)
        finally:
            cleanup_failures = cleanup_owned_target(store, key, daemon)
        set_phase("cleanup_files")
        if primary_failure or cleanup_failures:
            raise NativeHostProofFailure(primary_failure, cleanup_failures)
    print(json.dumps({"platform": platform.system(), "nativeStore": store.kind, "status": "passed", "apiPythonParity": True, "migration": True, "cleanup": True}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Never serialize exception messages, request bytes, or raw command output.
        print(json.dumps(failure_diagnostic(error)), file=sys.stderr)
        raise SystemExit(1) from None
