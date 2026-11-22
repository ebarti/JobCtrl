"""Public HTTP credential journey with owned external native-store boundaries.

Default: executable synthetic helpers, safe on supported development hosts.
--platform-native: fresh GitHub-hosted runner only, random disposable native
namespace; never opens the JobCtrl production credential namespace. Linux also
requires --linux-session inside a fresh dbus-run-session.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import signal
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workers/automation/src"))

_HELPER = r'''from pathlib import Path
import json,os,sys,time
root=Path(__file__).parent
operation,key=sys.argv[1:]
control=json.loads((root/'control.json').read_text()) if (root/'control.json').exists() else {}
with (root/'calls.jsonl').open('a') as log: log.write(json.dumps({'operation':operation,'key':key,'pid':os.getpid()})+'\n')
if control.get('delay_operation')==operation:
    entry={'operation':operation,'key':key,'pid':os.getpid()}
    if control.get('exec_before_delay'):
        (root/'helper-before-exec.json').write_text(json.dumps(entry))
        deadline=time.monotonic()+5
        while not (root/'release-helper-exec').exists():
            if time.monotonic()>=deadline: raise SystemExit(2)
            time.sleep(0.003)
        control.update(exec_before_delay=False,after_exec=True)
        (root/'control.json').write_text(json.dumps(control))
        os.execv(sys.executable,[sys.executable,'-I','-B',__file__,operation,key])
    if control.get('after_exec'):
        (root/'helper-after-exec.json').write_text(json.dumps(entry))
    if control.get('delay_once'): (root/'control.json').unlink()
    time.sleep(control.get('delay_seconds',0))
if control.get('fail_operation')==operation and control.get('fail_key',key)==key:
    if control.get('once'): (root/'control.json').unlink()
    raise SystemExit(1)
if control.get('fail_mutations') and operation in {'set','delete'}: raise SystemExit(1)
value=root/(key+'.synthetic-value')
if operation=='inspect': raise SystemExit(0 if value.exists() else 44)
if operation=='read':
    if not value.exists(): raise SystemExit(44)
    sys.stdout.write(value.read_text()); raise SystemExit(0)
if operation=='set': value.write_text(sys.stdin.read()); raise SystemExit(0)
if operation=='delete': value.unlink(missing_ok=True); raise SystemExit(0)
raise SystemExit(2)
'''

_CODEX_LOGIN_HELPER = r'''from pathlib import Path
import json,os,sys
root=Path(__file__).parent
control=json.loads((root/'codex-control.json').read_text()) if (root/'codex-control.json').exists() else {}
home=Path(os.environ['CODEX_HOME'])
with (root/'codex-calls.jsonl').open('a') as output:
    output.write(json.dumps({'arguments':sys.argv[1:],'ambient_key':bool(os.getenv('OPENAI_API_KEY') or os.getenv('CODEX_API_KEY')),'owned_cwd':Path.cwd().name=='workspace' and Path.cwd().parent==home})+'\n')
if sys.argv[1:]==['login','status']:
    raise SystemExit(1 if control.get('fail_status') else 0 if (home/'auth.json').is_file() else 2)
if sys.argv[1:] not in (['login'],['login','--with-api-key']): raise SystemExit(3)
if control.get('fail_login'): raise SystemExit(1)
payload=({'OPENAI_API_KEY':sys.stdin.read().rstrip('\r\n')} if '--with-api-key' in sys.argv else {'tokens':{'access_token':'synthetic-subscription-token'}})
home.mkdir(mode=0o700,parents=True,exist_ok=True)
(home/'auth.json').write_text(json.dumps({} if control.get('malformed_auth') else payload))
if control.get('concurrent_auth'):
    (root/'codex_home'/'auth.json').write_text(json.dumps({'tokens':{'access_token':'synthetic-concurrent-login-token'}}))
sys.stdout.write('sensitive-provider-output')
raise SystemExit(0)
'''


def recovery_journey(owned: Path, state: Path, client, check) -> None:
    """Use independent real API processes and exact owned process handles."""
    import httpx
    from jobctrl.app.credentials import read_process_identity

    processes = []
    pending = []
    inspection_failures = []
    marker = owned / "mutations.sqlite3.inflight"
    server_code = """from pathlib import Path
import os,uvicorn
from jobctrl.app.bootstrap import create_application
from jobctrl.app.credentials import CredentialService
from jobctrl.app.http import create_http_app
application=create_application(Path(os.environ['JOBCTRL_DIR']),enabled_features=[])
service=CredentialService(application.runtime,lock_path=Path(os.environ['JOBCTRL_E2E_SHARED_LOCK']))
port=int(os.environ['JOBCTRL_E2E_API_PORT'])
uvicorn.run(create_http_app(application,port=port,credential_service=service),host='127.0.0.1',port=port,log_level='critical',access_log=False)
"""

    def launch(name):
        workspace = owned / name
        workspace.mkdir(mode=0o700)
        token = secrets.token_hex(32)
        (workspace / ".jobctrl-e2e-owned.json").write_text(json.dumps({"version": 1, "workspace": str(workspace), "token": token}))
        helper = workspace / "native-helper.py"
        helper.write_text("#!" + sys.executable + "\n" + _HELPER.replace("root=Path(__file__).parent", "root=Path(" + repr(str(state)) + ")"))
        helper.chmod(0o700)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        environment = {**os.environ, "PYTHONPATH": str(ROOT / "workers/automation/src"), "JOBCTRL_DIR": str(workspace),
                       "JOBCTRL_E2E_TOKEN": token, "JOBCTRL_E2E_CREDENTIAL_HELPER": str(helper),
                       "JOBCTRL_E2E_SHARED_LOCK": str(owned / "mutations.sqlite3"), "JOBCTRL_E2E_API_PORT": str(port)}
        process = subprocess.Popen([sys.executable, "-c", server_code], env=environment,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(process)
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Recovery API exited.")
            try:
                if httpx.get(base + "/v1/health", trust_env=False, timeout=1).status_code == 200:
                    return process, base
            except httpx.HTTPError:
                pass
            time.sleep(0.02)
        raise RuntimeError("Recovery API did not start.")

    def save(base, value):
        try:
            with httpx.Client(base_url=base, headers={"Origin": base}, trust_env=False, timeout=15) as remote:
                saved = credential_metadata(remote)
                remote.patch("/v1/credentials/batch", json={"expectedRevision": saved["revision"],
                             "operations": [{"operation": "set", "key": "GEMINI_API_KEY", "value": value}]})
        except httpx.HTTPError:
            pass  # Deliberate death of the exact owned API is the fault.
        except CredentialInspectionError as error:
            inspection_failures.append(error)

    def mutate_peer(value):
        saved = credential_metadata(client)
        return client.patch("/v1/credentials/batch", json={"expectedRevision": saved["revision"],
                            "operations": [{"operation": "set", "key": "GEMINI_API_KEY", "value": value}]})

    try:
        control = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import sys; sys.stdin.buffer.read()"],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(control)
        owner_identity = read_process_identity(os.getpid())
        control_identity = read_process_identity(control.pid)
        check("stale_birth_control_ready", owner_identity.get("state") == control_identity.get("state") == "alive"
              and owner_identity["identity"] != control_identity["identity"])
        # A deliberately stale birth record is a fault, never signal authority.
        marker.write_text(json.dumps({"version": 1, "id": str(uuid.uuid4()), "ownerPid": os.getpid(),
                                      "ownerIdentity": owner_identity["identity"], "childPid": control.pid,
                                      "childIdentity": owner_identity["identity"]}))
        credential_metadata(client)
        check("stale_birth_retired_without_signal", not marker.exists() and control.poll() is None)

        process, base = launch("recovery-live-helper")
        (state / "control.json").write_text(json.dumps({"delay_operation": "set", "delay_seconds": 1.5,
                                                       "delay_once": True, "exec_before_delay": True}))
        request = threading.Thread(target=save, args=(base, "synthetic-orphan"))
        pending.append(request)
        request.start()
        deadline = time.monotonic() + 5
        observed = None
        entered = None
        while time.monotonic() < deadline:
            try:
                observed = json.loads(marker.read_text())
                entered = json.loads((state / "helper-before-exec.json").read_text())
                if (observed.get("ownerPid") == process.pid and observed.get("childPid") is not None
                        and entered == {"operation": "set", "key": "GEMINI_API_KEY", "pid": observed["childPid"]}):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.003)
        if inspection_failures:
            raise inspection_failures[0]
        check("real_helper_registered", observed is not None and observed.get("ownerPid") == process.pid
              and observed.get("childPid") is not None)
        check("registered_helper_entered", entered == {"operation": "set", "key": "GEMINI_API_KEY", "pid": observed["childPid"]})
        process.kill()
        process.wait(timeout=3)
        started = time.monotonic()
        (state / "release-helper-exec").write_text("owned-helper-only")
        response = mutate_peer("synthetic-after-orphan")
        check("successor_waits_orphan_helper", response.status_code == 200 and time.monotonic() - started >= 1.2)
        check("orphan_helper_exec_preserves_custody", json.loads((state / "helper-after-exec.json").read_text()) == entered)
        check("orphan_custody_retired", not marker.exists() and (state / "GEMINI_API_KEY.synthetic-value").read_text() == "synthetic-after-orphan")
        (state / "control.json").unlink(missing_ok=True)

        process, base = launch("recovery-before-registration")
        caught = False
        for attempt in range(6):
            previous = (state / "GEMINI_API_KEY.synthetic-value").read_bytes()
            request = threading.Thread(target=save, args=(base, "synthetic-early-" + str(attempt)))
            pending.append(request)
            request.start()
            deadline = time.monotonic() + 4
            while request.is_alive() and time.monotonic() < deadline:
                try:
                    observed = json.loads(marker.read_text())
                except (OSError, ValueError):
                    continue
                if observed.get("ownerPid") != process.pid or observed.get("childPid") is not None:
                    continue
                # This still-live Popen handle owns the process; marker PIDs
                # never grant signal authority. Freeze before checking stage.
                os.kill(process.pid, signal.SIGSTOP)
                time.sleep(0.01)
                try:
                    frozen = json.loads(marker.read_text())
                except (OSError, ValueError):
                    frozen = {}
                if frozen.get("ownerPid") == process.pid and frozen.get("childPid", "missing") is None:
                    process.kill()
                    process.wait(timeout=3)
                    caught = True
                    break
                os.kill(process.pid, signal.SIGCONT)
            request.join(timeout=5)
            if inspection_failures:
                raise inspection_failures[0]
            if caught:
                break
        check("owner_death_before_registration", caught)
        time.sleep(0.05)
        check("unregistered_helper_cannot_mutate", (state / "GEMINI_API_KEY.synthetic-value").read_bytes() == previous)
        response = mutate_peer("synthetic-after-owner-only")
        check("owner_only_marker_recovers", response.status_code == 200 and not marker.exists())
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
        for request in pending:
            request.join(timeout=3)


def file_security(path: Path):
    if os.name != "nt":
        return stat.S_IMODE(path.stat().st_mode)
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.GetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p,
                                      wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.GetFileSecurityW.restype = wintypes.BOOL
    needed = wintypes.DWORD()
    advapi.GetFileSecurityW(str(path), 4, None, 0, ctypes.byref(needed))
    if not needed.value:
        raise RuntimeError("Owned source DACL is unavailable.")
    buffer = ctypes.create_string_buffer(needed.value)
    if not advapi.GetFileSecurityW(str(path), 4, buffer, needed.value, ctypes.byref(needed)):
        raise RuntimeError("Owned source DACL is unavailable.")
    return buffer.raw


class CredentialInspectionError(RuntimeError):
    def __init__(self, response):
        super().__init__("Credential inspection failed.")
        self.http_status = response.status_code
        try:
            payload = response.json()
            value = payload.get("error", {}) if isinstance(payload, dict) else {}
            details = value.get("details", {}) if isinstance(value, dict) else {}
            code = value.get("code") if isinstance(value, dict) else None
            reason = details.get("reason") if isinstance(details, dict) else None
        except ValueError:
            code = reason = None
        self.error_code = code if code == "credential_store_unavailable" else "unknown"
        self.store_reason = reason if isinstance(reason, str) and reason in {
            "busy", "ownership_unverified", "operational_failure", "partial_failure", "unsupported_platform"
        } else "unknown"


def credential_metadata(client) -> dict:
    response = client.get("/v1/credentials")
    if response.status_code != 200:
        raise CredentialInspectionError(response)
    return response.json()


def error_metadata(error: Exception) -> dict:
    """Report allowlisted execution metadata without response bodies or locals."""
    metadata = {"errorType": type(error).__name__}
    if isinstance(error, CredentialInspectionError):
        metadata.update(httpStatus=error.http_status, errorCode=error.error_code,
                        credentialStoreReason=error.store_reason)
    for name in ("errno", "winerror"):
        value = getattr(error, name, None)
        if type(value) is int:
            metadata[name] = value
    frames = []
    current = error.__traceback__
    while current is not None:
        frames.append({"file": Path(current.tb_frame.f_code.co_filename).name, "line": current.tb_lineno})
        current = current.tb_next
    metadata["frames"] = frames[-20:]
    return metadata


def native_observation(payload, elapsed_ms: int, *, completed=None, error=None) -> dict:
    """Allowlist only execution metadata from an unchanged real native call."""
    from jobctrl.native_credentials import NativeCredentialError, PROVIDER_SECRET_KEYS
    try:
        data = json.loads(payload or "{}")
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    result = {"operation": data.get("operation") if data.get("operation") in ("inspect", "read", "set", "delete") else "unknown",
              "key": data.get("key") if data.get("key") in PROVIDER_SECRET_KEYS else "unknown",
              "elapsedMs": elapsed_ms}
    if error is not None:
        result["errorType"] = type(error).__name__
        result["outcome"] = ("timeout" if isinstance(error, subprocess.TimeoutExpired) or
                             (isinstance(error, NativeCredentialError) and error.args == ("native credential command timed out",))
                             else "exception")
    elif completed is not None:
        result["returnCode"] = completed.returncode
        result["outcome"] = {0: "success", 44: "item_not_found"}.get(completed.returncode, "nonzero_exit")
    return result


def initial_metadata_diagnostic(value: dict) -> dict:
    from jobctrl.app.credentials import CREDENTIAL_KEYS
    store = value.get("store", {})
    reason = store.get("unavailableReason")
    return {"storeAvailable": store.get("available") is True,
            "unavailableReason": reason if reason in (None, "inspection_failed", "unsupported_platform") else "unknown",
            "configured": {item["key"]: item.get("configured") if type(item.get("configured")) is bool or item.get("configured") is None else "invalid"
                           for item in value.get("credentials", []) if item.get("key") in CREDENTIAL_KEYS}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform-native", action="store_true")
    parser.add_argument("--linux-session", action="store_true")
    args = parser.parse_args()
    if args.platform_native and not (os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"):
        raise RuntimeError("Platform-native QA requires a fresh GitHub-hosted runner.")
    if args.platform_native and platform.system() == "Linux" and not args.linux_session:
        raise RuntimeError("Linux native QA requires an owned D-Bus session.")
    # Retain OS/session plumbing only. No inherited credentials or provider homes.
    allowed = {"PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "SystemDrive",
               "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
               "ProgramData", "DBUS_SESSION_BUS_ADDRESS"}
    native_macos = args.platform_native and platform.system() == "Darwin"
    if native_macos:
        # Keychain uses this OS-user context. Secret isolation comes from the
        # random QA service; application data still lives in the owned workspace.
        allowed.add("HOME")
    if os.name == "nt":
        allowed = {key.upper() for key in allowed}
    environment = {key: value for key, value in os.environ.items()
                   if (key.upper() if os.name == "nt" else key) in allowed}
    os.environ.clear()
    os.environ.update(environment)
    import httpx
    import uvicorn
    from jobctrl.app.bootstrap import create_application
    from jobctrl.app.credentials import CredentialService
    from jobctrl.app.http import create_http_app

    native_observations = []
    initial_diagnostic = None

    class ObservedCredentialService(CredentialService):
        def _run_command(self, command, **kwargs):
            if len(native_observations) >= 4:
                return super()._run_command(command, **kwargs)
            started = time.monotonic()
            try:
                completed = super()._run_command(command, **kwargs)
            except Exception as error:
                native_observations.append(native_observation(kwargs.get("input"), round((time.monotonic() - started) * 1000), error=error))
                raise
            native_observations.append(native_observation(kwargs.get("input"), round((time.monotonic() - started) * 1000), completed=completed))
            return completed

    checks: list[str] = []
    daemon = None
    server = None
    thread = None
    service = None
    cleanup_owned = False
    phase = "allocate"
    allocated = None
    success = False
    cleanup_ok = True
    try:
        temporary_root = Path("/private/tmp/jobctrl-transform-1428") if sys.platform == "darwin" else Path(tempfile.gettempdir())
        temporary_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        allocated = tempfile.TemporaryDirectory(prefix="native-credentials-e2e-", dir=temporary_root)
        owned = Path(allocated.name).resolve()
        workspace = owned / "workspace"
        workspace.mkdir(mode=0o700)
        for key, name in (("HOME", "home"), ("USERPROFILE", "home"), ("APPDATA", "appdata"),
                          ("LOCALAPPDATA", "localappdata"), ("XDG_DATA_HOME", "data"), ("XDG_RUNTIME_DIR", "run")):
            if native_macos and key == "HOME":
                continue
            location = owned / name
            location.mkdir(mode=0o700, exist_ok=True)
            os.environ[key] = str(location)
        os.environ.update(JOBCTRL_DIR=str(workspace), LANGFUSE_DISABLE="1", OTEL_SDK_DISABLED="true")
        namespace = "JobCtrl-QA-" + str(uuid.uuid4())
        if not args.platform_native:
            token = secrets.token_hex(32)
            (workspace / ".jobctrl-e2e-owned.json").write_text(json.dumps({"version": 1, "workspace": str(workspace), "token": token}))
            helper = workspace / "native-helper.py"
            helper.write_text("#!" + sys.executable + "\n" + _HELPER)
            helper.chmod(0o700)
            os.environ.update(JOBCTRL_SYNTHETIC_BOUNDARIES="1", JOBCTRL_E2E_TOKEN=token,
                              JOBCTRL_E2E_CREDENTIAL_HELPER=str(helper))
            login_helper = workspace / "codex-login-helper.py"
            login_helper.write_text(_CODEX_LOGIN_HELPER)
            login_helper.chmod(0o700)
            os.environ["JOBCTRL_E2E_CODEX_LOGIN_HELPER"] = str(login_helper)
        elif args.linux_session:
            phase = "owned_secret_service"
            daemon = subprocess.Popen(["gnome-keyring-daemon", "--foreground", "--components=secrets", "--unlock"],
                                      stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            daemon.stdin.write(secrets.token_hex(24).encode())
            daemon.stdin.close()
            deadline = time.monotonic() + 15
            while True:
                observed = subprocess.run(["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus",
                                           "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner",
                                           "string:org.freedesktop.secrets"], capture_output=True, text=True, timeout=3)
                if observed.returncode == 0 and "boolean true" in observed.stdout:
                    break
                if daemon.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Owned Secret Service did not become ready.")
                time.sleep(0.05)
        phase = "application"
        application = create_application(workspace, enabled_features=[])
        service_type = ObservedCredentialService if args.platform_native and platform.system() == "Windows" else CredentialService
        service = service_type(application.runtime, native_service=namespace, lock_path=owned / "mutations.sqlite3")
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.listen()
        server = uvicorn.Server(uvicorn.Config(create_http_app(application, port=port, credential_service=service),
                                               host="127.0.0.1", port=port, log_level="critical", access_log=False))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started:
            if not thread.is_alive() or time.monotonic() >= deadline:
                raise RuntimeError("Credential API did not start.")
            time.sleep(0.02)
        base = f"http://127.0.0.1:{port}"

        def check(name, condition):
            if not condition:
                raise AssertionError(name)
            checks.append(name)

        with httpx.Client(base_url=base, headers={"Origin": base}, trust_env=False, timeout=20) as client:
            def metadata():
                return credential_metadata(client)

            def batch(operations, revision=None):
                saved = metadata() if revision is None else {"revision": revision}
                return client.patch("/v1/credentials/batch", json={"expectedRevision": saved["revision"], "operations": operations})

            phase = "initial_metadata"
            initial = metadata()
            initial_diagnostic = initial_metadata_diagnostic(initial)
            check("disposable_namespace_empty", all(item["configured"] is False for item in initial["credentials"]))
            check("native_store_available", initial["store"]["available"] is True)
            cleanup_owned = True
            secret = "synthetic-credential-" + uuid.uuid4().hex
            phase = "head_dispatch"
            response = client.request("HEAD", "/v1/credentials", json={"key": "GEMINI_API_KEY", "value": secret})
            check("head_is_read_only", response.status_code == 200 and metadata()["revision"] == initial["revision"])
            check("head_cannot_store_submitted_value", all(item["configured"] is False for item in metadata()["credentials"]))
            phase = "save_readback"
            response = batch([{"operation": "set", "key": "GEMINI_API_KEY", "value": secret}], initial["revision"])
            check("http_native_save", response.status_code == 200)
            saved = response.json()
            check("secret_never_returned", secret not in response.text)
            check("secret_write_revision", saved["revision"] > initial["revision"])
            check("actual_native_readback", service.execution_environment(provider="google").get("GEMINI_API_KEY") == secret)
            phase = "fences"
            refused = batch([{"operation": "delete", "key": "GEMINI_API_KEY"}], initial["revision"])
            check("stale_write_refused", refused.status_code == 409 and service.execution_environment(provider="google").get("GEMINI_API_KEY") == secret)
            refused = batch([{"operation": "set", "key": "GEMINI_API_KEY", "value": "é" * (service.max_secret_bytes // 2 + 1)}])
            check("platform_byte_limit_before_write", refused.status_code == 400 and service.execution_environment(provider="google").get("GEMINI_API_KEY") == secret)
            refused = batch([{"operation": [], "key": "GEMINI_API_KEY"}])
            check("invalid_operation_refused", refused.status_code == 400)
            phase = "configuration"
            response = batch([{"operation": "set", "key": "GOOGLE_CLOUD_PROJECT", "value": "synthetic-project"},
                              {"operation": "set", "key": "GEMINI_API_KEY", "value": secret}])
            check("combined_secret_configuration", response.status_code == 200 and client.get("/v1/settings").json()["providerConfiguration"]["GOOGLE_CLOUD_PROJECT"] == "synthetic-project")
            check("events_ids_only", secret not in json.dumps(application.runtime.events.since()))
            if not args.platform_native:
                phase = "rollback"
                before = metadata()["revision"]
                (workspace / "control.json").write_text(json.dumps({"fail_operation": "set", "fail_key": "ANTHROPIC_API_KEY", "once": True}))
                failed = batch([{"operation": "set", "key": "GEMINI_API_KEY", "value": "synthetic-replacement"},
                                {"operation": "set", "key": "ANTHROPIC_API_KEY", "value": "synthetic-other"}], before)
                check("failed_batch_exact_rollback", failed.status_code == 503 and service.execution_environment(provider="google").get("GEMINI_API_KEY") == secret and metadata()["revision"] == before)
                (workspace / "control.json").write_text(json.dumps({"fail_operation": "inspect"}))
                unknown = metadata()
                check("inspection_failure_is_unknown", unknown["store"]["unavailableReason"] == "inspection_failed" and all(item["configured"] is None for item in unknown["credentials"] if item["storage"] == "native_store"))
                (workspace / "control.json").unlink()
                marker = service.lock_path.with_name(service.lock_path.name + ".inflight")
                marker.write_text('{"unknown":"ownership"}')
                refused = client.patch("/v1/credentials/batch", json={"expectedRevision": before, "operations": [{"operation": "delete", "key": "GEMINI_API_KEY"}]})
                check("unknown_ownership_preserved", refused.status_code == 503 and marker.read_text() == '{"unknown":"ownership"}')
                marker.unlink()
                if os.name != "nt":
                    phase = "independent_process_recovery"
                    recovery_journey(owned, workspace, client, check)
            phase = "remove"
            response = batch([{"operation": "delete", "key": "GEMINI_API_KEY"}])
            check("http_native_remove", response.status_code == 200 and service.execution_environment(provider="google").get("GEMINI_API_KEY") is None)
            phase = "explicit_migration"
            source = workspace / "legacy-provider.env"
            source.write_text("# owned synthetic migration\nGEMINI_API_KEY=" + secret + "\nKEEP_SYNTHETIC=yes\n")
            source.chmod(0o600)
            security = file_security(source)
            before = metadata()["revision"]
            marker = workspace / ".native-credentials-migrated.json"
            migrated = service.migrate_persistent_env([source], marker)
            check("explicit_migration_uses_native_boundary", migrated.migrated_keys == ("GEMINI_API_KEY",)
                  and service.execution_environment(provider="google").get("GEMINI_API_KEY") == secret)
            check("migration_source_preserved_without_plaintext", secret not in source.read_text()
                  and "KEEP_SYNTHETIC=yes" in source.read_text() and secret not in marker.read_text())
            check("migration_source_permissions_preserved", file_security(source) == security)
            check("migration_fences_credential_edits", metadata()["revision"] > before)
            check("migration_is_once", service.migrate_persistent_env([source], marker).already_completed)
            if not args.platform_native:
                phase = "codex_explicit_login"
                key = "synthetic-codex-api-key"
                check("codex_native_key_seeded", batch([{"operation": "set", "key": "OPENAI_API_KEY", "value": key}]).status_code == 200)
                response = client.post("/v1/providers/codex/login", json={})
                target = workspace / "codex_home" / "auth.json"
                check("explicit_codex_key_login", response.status_code == 200 and response.json()["ok"] is True
                      and json.loads(target.read_text())["OPENAI_API_KEY"] == key)
                check("codex_login_secret_free", key not in response.text and "sensitive-provider-output" not in response.text)
                calls = [json.loads(line) for line in (workspace / "codex-calls.jsonl").read_text().splitlines()]
                check("codex_key_stdin_only", all(not call["ambient_key"] and key not in json.dumps(call["arguments"]) for call in calls))
                check("codex_login_owned_workdir", all(call["owned_cwd"] for call in calls))
                check("codex_real_post_login_status", calls[-1]["arguments"] == ["login", "status"])
                previous = target.read_bytes()
                (workspace / "codex-control.json").write_text(json.dumps({"fail_status": True}))
                failed = client.post("/v1/providers/codex/login", json={})
                check("failed_codex_verification_preserves_auth", failed.status_code == 503 and target.read_bytes() == previous)
                (workspace / "codex-control.json").write_text(json.dumps({"malformed_auth": True}))
                failed = client.post("/v1/providers/codex/login", json={})
                check("malformed_codex_auth_preserves_auth", failed.status_code == 503 and target.read_bytes() == previous)
                (workspace / "codex-control.json").write_text(json.dumps({"concurrent_auth": True}))
                failed = client.post("/v1/providers/codex/login", json={})
                check("concurrent_codex_login_fenced", failed.status_code == 409
                      and json.loads(target.read_text())["tokens"]["access_token"] == "synthetic-concurrent-login-token")
                (workspace / "codex-control.json").unlink()
                check("codex_native_key_removed", batch([{"operation": "delete", "key": "OPENAI_API_KEY"}]).status_code == 200)
                response = client.post("/v1/providers/codex/login", json={})
                check("explicit_codex_subscription_login", response.status_code == 200 and response.json()["ok"] is True
                      and json.loads(target.read_text())["tokens"]["access_token"] == "synthetic-subscription-token")
                refused = client.post("/v1/providers/codex/login", json={"unexpected": "input"})
                check("codex_login_payload_rejected", refused.status_code == 400)
                check("codex_login_candidate_cleanup", not list(workspace.glob(".codex-login-*")))
        phase = "cleanup"
        service.apply_batch([{"operation": "delete", "key": key} for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CAPSOLVER_API_KEY")])
        check("native_namespace_cleaned", all(item["configured"] is False for item in service.list()["credentials"] if item["storage"] == "native_store"))
        cleanup_owned = False
        server.should_exit = True
        thread.join(timeout=5)
        check("api_stopped", not thread.is_alive())
        success = True
    except Exception as error:
        # Never print request bodies, command outputs, paths or exception text.
        print(json.dumps({"status": "failed", "phase": phase, **error_metadata(error), "passed": checks,
                          "initialMetadata": initial_diagnostic, "nativeObservations": native_observations[-32:]}), file=sys.stderr)
    finally:
        if cleanup_owned and service is not None:
            try:
                service.apply_batch([{"operation": "delete", "key": key} for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CAPSOLVER_API_KEY")])
            except Exception as error:
                cleanup_ok = False
                print(json.dumps({"status": "cleanup_failed", "phase": "native_namespace", **error_metadata(error)}), file=sys.stderr)
        if server is not None:
            server.should_exit = True
        if thread is not None:
            thread.join(timeout=5)
        if daemon is not None:
            daemon.terminate()
            try:
                daemon.wait(timeout=3)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=3)
        if allocated is not None:
            allocated.cleanup()
    if success and cleanup_ok:
        print(json.dumps({"status": "passed", "platform": platform.system(), "boundary": "native_disposable_namespace" if args.platform_native else "owned_external_helper",
                          "checks": checks, "count": len(checks), "cleanup": True,
                          **({"initialMetadata": initial_diagnostic, "nativeObservations": native_observations} if native_observations else {})}))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
