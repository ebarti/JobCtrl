"""Opt-in real native-store proof; all credentials and files are synthetic.

Requires Node workspace dependencies and python-dotenv. Linux must run inside
an owned dbus-run-session with --linux-session; it never uses the user's bus.
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
spec = importlib.util.spec_from_file_location(
    "native_credentials_host_under_test",
    ROOT / "workers/automation/src/jobctrl/native_credentials.py",
)
assert spec and spec.loader
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


def windows_acl(path: Path, *, restrict: bool = False) -> str:
    """Set/check synthetic file permissions; never prints an account or secret."""
    script = r"""
$ErrorActionPreference = 'Stop'
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


def main() -> int:
    global PHASE
    parser = argparse.ArgumentParser()
    parser.add_argument("--linux-session", action="store_true")
    args = parser.parse_args()
    if platform.system() == "Linux" and not args.linux_session:
        raise RuntimeError("Linux native QA requires an owned D-Bus session")
    # Carry OS/session plumbing only, never ambient provider credentials.
    safe_env = {key: os.environ[key] for key in (
        "PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP",
        "TMPDIR", "LOCALAPPDATA", "APPDATA", "DBUS_SESSION_BUS_ADDRESS",
    ) if key in os.environ}
    os.environ.clear()
    os.environ.update(safe_env)
    service = f"JobCtrl-QA-{uuid.uuid4()}"
    store = native.NativeCredentialStore(service=service)
    key = "GEMINI_API_KEY"
    daemon = None
    with tempfile.TemporaryDirectory(prefix="jobctrl-native-host-") as directory:
        owned = Path(directory)
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
            global PHASE
            PHASE = f"api_{operation}"
            payload = {"service": service, "configPath": str(owned / "config.json"), "operation": operation, "value": value}
            result = subprocess.run(
                [shutil.which("node") or "node", str(ROOT / "apps/api/node_modules/tsx/dist/cli.mjs"), str(ROOT / "apps/api/test/native-credentials-host.ts")],
                input=json.dumps(payload), encoding="utf-8", capture_output=True, timeout=60, cwd=ROOT,
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

        try:
            PHASE = "initial_native_read"
            assert store.read(key) is None, "Synthetic target must start absent"
            # Cross-runtime exactness, including quote/backslash/Unicode and hex-looking ASCII.
            maximum_ascii = {"Darwin": 128, "Windows": 1280, "Linux": 8000}[platform.system()]
            for value in ("  synthetic-" + secrets.token_hex(16) + "  ", 'synthetic-"quoted"-\\-snowman-☃', "deadbeef001122", "s" * maximum_ascii):
                response = api("set", value)
                entry = next(item for item in response["credentials"] if item["key"] == key)
                assert entry["configured"] is True
                assert response["store"]["requiresWorkerRestart"] is True
                PHASE = "cross_runtime_readback"
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
            source.write_text(f"KEEP=untouched\n{key}='{value}'\n", encoding="utf-8")
            acl_before = windows_acl(source, restrict=True) if platform.system() == "Windows" else None
            marker = owned / "migration.json"
            PHASE = "migration"
            result = native.migrate_persistent_env_credentials([source], marker, store=store)
            assert not result.already_completed
            assert source.read_text(encoding="utf-8") == "KEEP=untouched\n"
            if acl_before is not None:
                assert windows_acl(source) == acl_before, "Migration widened the source DACL"
            assert store.read(key) == value, "Migrated credential must survive source removal"
            assert value not in marker.read_text(encoding="utf-8")
            assert native.migrate_persistent_env_credentials([source], marker, store=store).already_completed
            response = api("list")
            assert value not in json.dumps(response)
            assert next(item for item in response["credentials"] if item["key"] == key)["configured"] is True
            env = {name: "synthetic-inherited" for name in native.PROVIDER_SECRET_KEYS}
            PHASE = "runtime_precedence"
            native.load_native_credential_fallbacks(env=env, store=store)
            assert env[key] == "synthetic-inherited"
            env[key] = ""
            native.load_native_credential_fallbacks(env=env, store=store)
            assert env[key] == value
            api("delete")
            assert store.read(key) is None
            if acl_before is not None:
                PHASE = "windows_acl_rollback"
                original = f"KEEP=untouched\n{key}='{value}'\n"
                source.write_text(original, encoding="utf-8")
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
                assert source.read_text(encoding="utf-8") == original
                assert windows_acl(source) == acl_before, "Rollback widened the source DACL"
                assert store.read(key) is None
        finally:
            try:
                store.delete(key)
                assert store.read(key) is None, "Synthetic native credential cleanup failed"
            finally:
                if daemon is not None:
                    daemon.terminate()
                    try:
                        daemon.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait(timeout=5)
    print(json.dumps({"platform": platform.system(), "nativeStore": store.kind, "status": "passed", "apiPythonParity": True, "migration": True, "cleanup": True}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Native command output and credential-bearing assertion operands stay private.
        print(json.dumps({"platform": platform.system(), "status": "failed", "phase": PHASE, "errorType": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
