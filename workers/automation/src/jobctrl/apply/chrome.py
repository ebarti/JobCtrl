"""Chrome lifecycle management for apply workers.

Handles launching an isolated Chrome instance with remote debugging,
worker profile setup/cloning, and cross-platform process cleanup.
"""

import json
import logging
import platform
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

from jobctrl import config
from jobctrl.infrastructure.network import validate_public_http_url

logger = logging.getLogger(__name__)

# CDP port base — each worker uses BASE_CDP_PORT + worker_id
BASE_CDP_PORT = 9222

# Track Chrome processes per worker for cleanup
_chrome_procs: dict[int, subprocess.Popen] = {}
_chrome_lock = threading.Lock()
_dry_run_guards: dict[int, "_DryRunCdpGuard"] = {}
_dry_run_guards_lock = threading.Lock()
_public_destination_guards: dict[int, "_PublicDestinationCdpGuard"] = {}
_public_destination_guards_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Cross-platform process helpers
# ---------------------------------------------------------------------------

def _kill_process_tree(pid: int) -> None:
    """Kill a process and all its children.

    On Windows, Chrome spawns 10+ child processes (GPU, renderer, etc.),
    so taskkill /T is needed to kill the entire tree. On Unix, os.killpg
    handles the process group.
    """
    import signal as _signal

    try:
        if platform.system() == "Windows":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        else:
            # Unix: kill entire process group
            import os
            try:
                os.killpg(os.getpgid(pid), _signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                # Process already gone or owned by another user
                try:
                    os.kill(pid, _signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
    except Exception:
        logger.debug("Failed to kill process tree for PID %d", pid, exc_info=True)


def _kill_on_port(port: int) -> None:
    """Kill any process listening on a specific port (zombie cleanup).

    Uses netstat on Windows, lsof on macOS/Linux.
    """
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=10,
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    pid = line.strip().split()[-1]
                    if pid.isdigit():
                        _kill_process_tree(int(pid))
        else:
            # macOS / Linux
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True, timeout=10,
            )
            for pid_str in result.stdout.strip().splitlines():
                pid_str = pid_str.strip()
                if pid_str.isdigit():
                    _kill_process_tree(int(pid_str))
    except FileNotFoundError:
        logger.debug("Port-kill tool not found (netstat/lsof) for port %d", port)
    except Exception:
        logger.debug("Failed to kill process on port %d", port, exc_info=True)


# ---------------------------------------------------------------------------
# Worker profile management
# ---------------------------------------------------------------------------

def setup_worker_profile(worker_id: int) -> Path:
    """Create an isolated Chrome profile for a worker.

    On first run, clones from an existing worker profile (preferred, since
    it already has session cookies) or from the user's real Chrome profile.
    Subsequent runs reuse the existing worker profile.

    Args:
        worker_id: Numeric worker identifier.

    Returns:
        Path to the worker's Chrome user-data directory.
    """
    profile_dir = config.CHROME_WORKER_DIR / f"worker-{worker_id}"
    if (profile_dir / "Default").exists():
        return profile_dir  # Already initialized

    # Find a source: prefer existing worker (has session cookies), else user profile
    source: Path | None = None
    for wid in range(10):
        if wid == worker_id:
            continue
        candidate = config.CHROME_WORKER_DIR / f"worker-{wid}"
        if (candidate / "Default").exists():
            source = candidate
            break
    if source is None:
        source = config.get_chrome_user_data()

    logger.info("[worker-%d] Copying Chrome profile from %s (first time setup)...",
                worker_id, source.name)
    profile_dir.mkdir(parents=True, exist_ok=True)

    # Copy essential profile dirs -- skip caches and heavy transient data
    skip = {
        "ShaderCache", "GrShaderCache", "Service Worker", "Cache",
        "Code Cache", "GPUCache", "CacheStorage", "Crashpad",
        "BrowserMetrics", "SafeBrowsing", "Crowd Deny",
        "MEIPreload", "SSLErrorAssistant", "recovery", "Temp",
        "SingletonLock", "SingletonSocket", "SingletonCookie",
    }

    for item in source.iterdir():
        if item.name in skip:
            continue
        dst = profile_dir / item.name
        try:
            if item.is_dir():
                shutil.copytree(
                    str(item), str(dst), dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(
                        "Cache", "Code Cache", "GPUCache", "Service Worker",
                    ),
                )
            else:
                shutil.copy2(str(item), str(dst))
        except (PermissionError, OSError):
            pass  # skip locked files

    return profile_dir


def _suppress_restore_nag(profile_dir: Path) -> None:
    """Clear Chrome's 'restore pages' nag by fixing Preferences.

    Chrome writes exit_type=Crashed when killed, which triggers a
    'Restore pages?' prompt on next launch. This patches it out.
    """
    prefs_file = profile_dir / "Default" / "Preferences"
    if not prefs_file.exists():
        return

    try:
        prefs = json.loads(prefs_file.read_text(encoding="utf-8"))
        prefs.setdefault("profile", {})["exit_type"] = "Normal"
        prefs.setdefault("session", {})["restore_on_startup"] = 4  # 4 = open blank
        prefs.setdefault("session", {}).pop("startup_urls", None)
        prefs["credentials_enable_service"] = False
        prefs.setdefault("password_manager", {})["saving_enabled"] = False
        prefs.setdefault("autofill", {})["profile_enabled"] = False
        prefs_file.write_text(json.dumps(prefs), encoding="utf-8")
    except Exception:
        logger.debug("Could not patch Chrome preferences", exc_info=True)


# ---------------------------------------------------------------------------
# Chrome launch / kill
# ---------------------------------------------------------------------------

def launch_chrome(worker_id: int, port: int | None = None,
                  headless: bool = False, dry_run: bool = False) -> subprocess.Popen:
    """Launch a Chrome instance with remote debugging for a worker.

    Args:
        worker_id: Numeric worker identifier.
        port: CDP port. Defaults to BASE_CDP_PORT + worker_id.
        headless: Run Chrome in headless mode (no visible window).

    Returns:
        subprocess.Popen handle for the Chrome process.
    """
    if port is None:
        port = BASE_CDP_PORT + worker_id

    profile_dir = setup_worker_profile(worker_id)

    # Kill any zombie Chrome from a previous run on this port
    _kill_on_port(port)

    # Patch preferences to suppress restore nag
    _suppress_restore_nag(profile_dir)

    chrome_exe = config.get_chrome_path()

    cmd = [
        chrome_exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1024,768",
        "--disable-session-crashed-bubble",
        "--disable-features=InfiniteSessionRestore,PasswordManagerOnboarding",
        "--hide-crash-restore-bubble",
        "--noerrdialogs",
        "--password-store=basic",
        "--disable-save-password-bubble",
        "--disable-popup-blocking",
        # Block dangerous permissions at browser level
        "--deny-permission-prompts",
        "--disable-notifications",
    ]
    if headless:
        cmd.append("--headless=new")

    # On Unix, start in a new process group so we can kill the whole tree
    kwargs: dict = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if platform.system() != "Windows":
        import os
        kwargs["preexec_fn"] = os.setsid

    proc = subprocess.Popen(cmd, **kwargs)
    with _chrome_lock:
        _chrome_procs[worker_id] = proc

    # Give Chrome time to start and open the debug port
    time.sleep(3)
    if dry_run:
        install_dry_run_cdp_guard(port)
    else:
        install_public_destination_cdp_guard(port)
    logger.info("[worker-%d] Chrome started on port %d (pid %d)",
                worker_id, port, proc.pid)
    return proc


_FORM_SUBMIT_GUARD_SOURCE = """
(() => {
  window.__jobctrl_dryrun_installed = true;
  const bindingName = "jobctrlDryRunBlocked";
  const absoluteUrl = (url) => {
    try { return new URL(String(url || window.location.href), window.location.href).toString(); }
    catch (_) { return String(url || window.location.href); }
  };
  const report = (details) => {
    try {
      const binding = window[bindingName];
      if (typeof binding === "function") {
        binding(JSON.stringify({
          channel: details.channel || "dom",
          method: details.method || "POST",
          url: absoluteUrl(details.url),
          resourceType: details.resourceType || "Document",
        }));
      }
    } catch (_) {}
  };
  const block = (event, details) => {
    window.__jobctrl_dryrun_blocked = true;
    report(details || {});
    if (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    throw new Error("JobCtrl dry-run blocked browser submission channel");
  };
  const originalSubmit = HTMLFormElement.prototype.submit;
  const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
  HTMLFormElement.prototype.submit = function submit() {
    return block(null, {
      channel: "form_submit",
      method: (this.method || "POST").toUpperCase(),
      url: this.action || window.location.href,
      resourceType: "Document",
    });
  };
  HTMLFormElement.prototype.requestSubmit = function requestSubmit() {
    return block(null, {
      channel: "form_request_submit",
      method: (this.method || "POST").toUpperCase(),
      url: this.action || window.location.href,
      resourceType: "Document",
    });
  };
  Object.defineProperty(HTMLFormElement.prototype.submit, "name", { value: originalSubmit.name });
  Object.defineProperty(HTMLFormElement.prototype.requestSubmit, "name", { value: originalRequestSubmit.name });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    return block(event, {
      channel: "form_submit",
      method: ((form && form.method) || "POST").toUpperCase(),
      url: (form && form.action) || window.location.href,
      resourceType: "Document",
    });
  }, true);

  if (navigator.sendBeacon) {
    navigator.sendBeacon = function sendBeacon(url, data) {
      window.__jobctrl_dryrun_blocked = true;
      report({
        channel: "sendBeacon",
        method: "POST",
        url,
        resourceType: "Ping",
      });
      return false;
    };
  }

  if (window.WebSocket) {
    const OriginalWebSocket = window.WebSocket;
    function DryRunWebSocket(url, protocols) {
      window.__jobctrl_dryrun_blocked = true;
      report({
        channel: "WebSocket",
        method: "WEBSOCKET",
        url,
        resourceType: "WebSocket",
      });
      throw new Error("JobCtrl dry-run blocked WebSocket creation");
    }
    DryRunWebSocket.prototype = OriginalWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      try { Object.defineProperty(DryRunWebSocket, key, { value: OriginalWebSocket[key] }); }
      catch (_) {}
    }
    window.WebSocket = DryRunWebSocket;
  }
})();
"""


def install_dry_run_cdp_guard(port: int) -> "_DryRunCdpGuard":
    """Install the public-destination + dry-run CDP guard for this worker."""
    guard = _DryRunCdpGuard(port)
    with _dry_run_guards_lock:
        _dry_run_guards[int(port)] = guard
    guard.start()
    return guard


def install_public_destination_cdp_guard(port: int) -> "_PublicDestinationCdpGuard":
    """Install the live apply public-destination guard on Chrome pages."""
    guard = _PublicDestinationCdpGuard(port)
    with _public_destination_guards_lock:
        _public_destination_guards[int(port)] = guard
    guard.start()
    return guard


def get_dry_run_cdp_guard_evidence(port: int) -> dict[str, object]:
    """Return sanitized dry-run guard evidence collected for ``port``."""
    with _dry_run_guards_lock:
        guard = _dry_run_guards.get(int(port))
    if guard is None:
        return {
            "coverage": "full",
            "blocked_channels": (),
            "blocked_requests": (),
        }
    return guard.evidence()


class _ApplyCdpGuard:
    def __init__(self, port: int, *, enforce_dry_run: bool) -> None:
        self._port = int(port)
        self._enforce_dry_run = enforce_dry_run
        self._seen: set[str] = set()
        self._blocked: list[dict[str, str]] = []
        self._blocked_keys: set[tuple[str, str, str, str]] = set()
        self._request_initiators: dict[str, str] = {}
        self._lock = threading.Lock()

    @property
    def enforce_dry_run(self) -> bool:
        return self._enforce_dry_run

    def start(self) -> None:
        self._attach_existing_targets()
        watcher = threading.Thread(
            target=self._watch_targets,
            name=f"apply-cdp-guard-{self._port}",
            daemon=True,
        )
        watcher.start()

    def _watch_targets(self) -> None:
        while True:
            self._attach_existing_targets()
            time.sleep(1.0)

    def _attach_existing_targets(self) -> None:
        for target in _cdp_json(self._port, "/json/list"):
            if not isinstance(target, dict) or target.get("type") != "page":
                continue
            target_id = str(target.get("id") or "")
            ws_url = str(target.get("webSocketDebuggerUrl") or "")
            if not target_id or not ws_url:
                continue
            with self._lock:
                if target_id in self._seen:
                    continue
                self._seen.add(target_id)
            thread = threading.Thread(
                target=_run_apply_page_session,
                args=(ws_url, self),
                name=f"apply-cdp-page-{target_id[:8]}",
                daemon=True,
            )
            thread.start()

    def record_blocked_request(
        self,
        *,
        channel: str,
        method: str,
        url: str,
        resource_type: str,
    ) -> None:
        request = {
            "channel": (channel or "network")[:80],
            "method": (method or "GET").upper()[:16],
            "url": _sanitize_evidence_url(url),
            "resource_type": (resource_type or "Other")[:80],
        }
        key = (
            request["channel"],
            request["method"],
            request["url"],
            request["resource_type"],
        )
        with self._lock:
            if key in self._blocked_keys:
                return
            self._blocked_keys.add(key)
            if len(self._blocked) < 100:
                self._blocked.append(request)

    def evidence(self) -> dict[str, object]:
        with self._lock:
            blocked = tuple(dict(item) for item in self._blocked)
        return {
            "coverage": _dry_run_coverage(blocked),
            "blocked_channels": _dry_run_blocked_channels(blocked),
            "blocked_requests": blocked,
        }

    def record_request_initiator(self, request_id: str, initiator_type: str) -> None:
        if not request_id:
            return
        with self._lock:
            self._request_initiators[request_id] = (initiator_type or "")[:40]

    def request_initiator(self, request_id: str) -> str:
        if not request_id:
            return ""
        with self._lock:
            return self._request_initiators.pop(request_id, "")


class _DryRunCdpGuard(_ApplyCdpGuard):
    def __init__(self, port: int) -> None:
        super().__init__(port, enforce_dry_run=True)


class _PublicDestinationCdpGuard(_ApplyCdpGuard):
    def __init__(self, port: int) -> None:
        super().__init__(port, enforce_dry_run=False)


def _cdp_json(port: int, path: str) -> object:
    try:
        with urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        logger.debug("CDP request failed for port %d path %s", port, path, exc_info=True)
        return []


def _run_apply_page_session(ws_url: str, guard: _ApplyCdpGuard) -> None:
    try:
        import websocket
    except Exception:
        logger.exception("websocket-client is required for apply CDP enforcement")
        return
    try:
        ws = websocket.create_connection(ws_url, timeout=2, suppress_origin=True)
    except Exception:
        logger.debug("CDP websocket connect failed for %s", ws_url, exc_info=True)
        return
    counter = 0

    def send(method: str, params: dict | None = None) -> None:
        nonlocal counter
        counter += 1
        ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))

    try:
        send("Page.enable")
        send("Network.enable")
        if guard.enforce_dry_run:
            send("Runtime.enable")
            send("Runtime.addBinding", {"name": "jobctrlDryRunBlocked"})
            send("Page.addScriptToEvaluateOnNewDocument", {"source": _FORM_SUBMIT_GUARD_SOURCE})
        send(
            "Fetch.enable",
            {
                "patterns": [
                    {
                        "urlPattern": "*",
                        "requestStage": "Request",
                    }
                ]
            },
        )
        if guard.enforce_dry_run:
            send("Runtime.evaluate", {"expression": _FORM_SUBMIT_GUARD_SOURCE})
        while True:
            try:
                raw_message = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            message = json.loads(raw_message)
            method_name = message.get("method")
            if guard.enforce_dry_run and method_name == "Runtime.bindingCalled":
                _record_binding_call(message, guard)
                continue
            if guard.enforce_dry_run and method_name == "Network.webSocketCreated":
                params = message.get("params") or {}
                guard.record_blocked_request(
                    channel="WebSocket",
                    method="WEBSOCKET",
                    url=str(params.get("url") or ""),
                    resource_type="WebSocket",
                )
                continue
            if method_name == "Network.requestWillBeSent":
                if guard.enforce_dry_run:
                    _record_request_initiator(message, guard)
                continue
            if method_name != "Fetch.requestPaused":
                continue
            params = message.get("params") or {}
            request = params.get("request") or {}
            request_id = params.get("requestId")
            network_id = str(params.get("networkId") or "")
            method = str(request.get("method") or "GET").upper()
            url = str(request.get("url") or "")
            resource_type = str(params.get("resourceType") or "Other")
            initiator_type = guard.request_initiator(network_id)
            public_decision = validate_public_http_url(url)
            if request_id and not public_decision.allowed:
                guard.record_blocked_request(
                    channel="public_destination",
                    method=method,
                    url=url,
                    resource_type=resource_type,
                )
                send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
            elif request_id and guard.enforce_dry_run and _should_block_dry_run_request(
                method,
                resource_type=resource_type,
                initiator_type=initiator_type,
            ):
                guard.record_blocked_request(
                    channel="network",
                    method=method,
                    url=url,
                    resource_type=resource_type,
                )
                send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
            elif request_id:
                send("Fetch.continueRequest", {"requestId": request_id})
    except Exception:
        logger.debug("CDP dry-run page session ended", exc_info=True)
    finally:
        try:
            ws.close()
        except Exception:
            pass


def _record_binding_call(message: dict, guard: _DryRunCdpGuard) -> None:
    params = message.get("params") or {}
    if params.get("name") != "jobctrlDryRunBlocked":
        return
    try:
        payload = json.loads(str(params.get("payload") or "{}"))
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    guard.record_blocked_request(
        channel=str(payload.get("channel") or "dom"),
        method=str(payload.get("method") or "POST"),
        url=str(payload.get("url") or ""),
        resource_type=str(payload.get("resourceType") or payload.get("resource_type") or "Document"),
    )


def _record_request_initiator(message: dict, guard: _DryRunCdpGuard) -> None:
    params = message.get("params") or {}
    request_id = str(params.get("requestId") or "")
    initiator = params.get("initiator") or {}
    initiator_type = ""
    if isinstance(initiator, dict):
        initiator_type = str(initiator.get("type") or "")
    guard.record_request_initiator(request_id, initiator_type)


def _should_block_dry_run_request(
    method: str,
    *,
    resource_type: str = "Other",
    initiator_type: str = "",
) -> bool:
    method_name = str(method or "GET").upper()
    if method_name not in {"GET", "HEAD"}:
        return True
    if str(resource_type or "Other") != "Document":
        return True
    return str(initiator_type or "").strip().lower() != "other"


def _sanitize_evidence_url(url: str) -> str:
    try:
        parsed = urlparse(str(url or ""))
    except Exception:
        return ""
    if not parsed.scheme or not parsed.netloc:
        return str(url or "").split("?", 1)[0].split("#", 1)[0][:500]
    path = parsed.path or "/"
    if len(path) > 200:
        path = path[:200]
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def _dry_run_coverage(blocked: tuple[dict[str, str], ...]) -> str:
    partial_resources = {
        "Document",
        "EventSource",
        "Fetch",
        "Font",
        "Image",
        "Media",
        "Script",
        "WebSocket",
        "XHR",
    }
    partial_channels = {"form_submit", "form_request_submit", "WebSocket"}
    for item in blocked:
        if item.get("resource_type") in partial_resources:
            return "partial"
        if item.get("channel") in partial_channels:
            return "partial"
    return "full"


def _dry_run_blocked_channels(blocked: tuple[dict[str, str], ...]) -> tuple[str, ...]:
    channels = {
        f"{item.get('channel') or 'network'}:{item.get('method') or 'GET'}"
        for item in blocked
    }
    return tuple(sorted(channels))


def cleanup_worker(worker_id: int, process: subprocess.Popen | None) -> None:
    """Kill a worker's Chrome instance and remove it from tracking.

    Args:
        worker_id: Numeric worker identifier.
        process: The Popen handle returned by launch_chrome.
    """
    if process and process.poll() is None:
        _kill_process_tree(process.pid)
    with _chrome_lock:
        _chrome_procs.pop(worker_id, None)
    logger.info("[worker-%d] Chrome cleaned up", worker_id)


def kill_all_chrome() -> None:
    """Kill all Chrome instances and any port zombies.

    Called during graceful shutdown to ensure no orphan Chrome processes.
    """
    with _chrome_lock:
        procs = dict(_chrome_procs)
        _chrome_procs.clear()

    for wid, proc in procs.items():
        if proc.poll() is None:
            _kill_process_tree(proc.pid)
        _kill_on_port(BASE_CDP_PORT + wid)

    # Sweep base port in case of zombies
    _kill_on_port(BASE_CDP_PORT)


def reset_worker_dir(worker_id: int) -> Path:
    """Wipe and recreate a worker's isolated working directory.

    Each job gets a fresh working directory so that file conflicts
    (resume PDFs, MCP configs) don't bleed between jobs.

    Args:
        worker_id: Numeric worker identifier.

    Returns:
        Path to the clean worker directory.
    """
    worker_dir = config.APPLY_WORKER_DIR / f"worker-{worker_id}"
    if worker_dir.exists():
        shutil.rmtree(str(worker_dir), ignore_errors=True)
    worker_dir.mkdir(parents=True, exist_ok=True)
    return worker_dir


def cleanup_on_exit() -> None:
    """Atexit handler: kill all Chrome processes and sweep CDP ports.

    Register this with atexit.register() at application startup.
    """
    with _chrome_lock:
        procs = dict(_chrome_procs)
        _chrome_procs.clear()

    for wid, proc in procs.items():
        if proc.poll() is None:
            _kill_process_tree(proc.pid)
        _kill_on_port(BASE_CDP_PORT + wid)

    # Sweep base port for any orphan
    _kill_on_port(BASE_CDP_PORT)
