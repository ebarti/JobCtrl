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
from jobctrl.browser_capabilities import (
    BrowserCapabilityError,
    require_system_browser_capability,
    system_browser_capability_is_enabled,
)
from jobctrl.apply.origins import canonical_http_origin
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
_PROTECTED_PAGE_TARGET_TYPES = frozenset({"page", "iframe"})
_BLOCKED_WORKER_TARGET_TYPES = frozenset(
    {"worker", "shared_worker", "service_worker"}
)


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
    """Create or reuse an isolated, JobCtrl-owned Chrome profile for a worker.

    This function intentionally never discovers, reads, or copies a host
    browser profile. Authentication for a system browser is an explicit
    capability choice; a bare auto-apply enable starts from a clean profile.

    Args:
        worker_id: Numeric worker identifier.

    Returns:
        Path to the worker's Chrome user-data directory.
    """
    profile_dir = config.CHROME_WORKER_DIR / f"worker-{worker_id}"
    if (profile_dir / "Default").exists():
        return profile_dir  # Already initialized
    profile_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    profile_dir.chmod(0o700)
    (profile_dir / "Default").mkdir(mode=0o700, exist_ok=True)
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

def launch_chrome(
    worker_id: int,
    port: int | None = None,
    headless: bool = False,
    dry_run: bool = False,
    *,
    approved_application_url: str = "",
) -> subprocess.Popen:
    """Launch a Chrome instance with remote debugging for a worker.

    Args:
        worker_id: Numeric worker identifier.
        port: CDP port. Defaults to BASE_CDP_PORT + worker_id.
        headless: Run Chrome in headless mode (no visible window).

    Returns:
        subprocess.Popen handle for the Chrome process.
    """
    # This is the final process-launch boundary.  Do this before creating or
    # reading a worker profile so disabled means no authenticated-browser I/O.
    chrome_exe = str(require_system_browser_capability("auto-apply-browser"))
    # Authorization must be complete before any profile or browser process is
    # touched. The guard canonicalizes the same value again when it owns the
    # request boundary.
    canonical_http_origin(approved_application_url)

    if port is None:
        port = BASE_CDP_PORT + worker_id

    profile_dir = setup_worker_profile(worker_id)

    # Kill any zombie Chrome from a previous run on this port
    _kill_on_port(port)

    # Patch preferences to suppress restore nag
    _suppress_restore_nag(profile_dir)

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

    # Give Chrome time to start and open the debug port. The synchronous guard
    # startup below does not return until every initial page acknowledges
    # Fetch.enable and browser-level paused auto-attach protects future pages.
    time.sleep(3)
    try:
        if dry_run:
            install_dry_run_cdp_guard(
                port,
                approved_application_url=approved_application_url,
                worker_id=worker_id,
                process=proc,
            )
        else:
            install_public_destination_cdp_guard(
                port,
                approved_application_url=approved_application_url,
                worker_id=worker_id,
                process=proc,
            )
    except Exception:
        cleanup_worker(worker_id, proc)
        raise
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


def install_dry_run_cdp_guard(
    port: int,
    *,
    approved_application_url: str,
    worker_id: int | None = None,
    process: subprocess.Popen | None = None,
) -> "_DryRunCdpGuard":
    """Install the public-destination + dry-run CDP guard for this worker."""
    guard = _DryRunCdpGuard(
        port,
        approved_application_url=approved_application_url,
        worker_id=worker_id,
        process=process,
    )
    with _dry_run_guards_lock:
        _dry_run_guards[int(port)] = guard
    try:
        guard.start()
    except Exception:
        with _dry_run_guards_lock:
            if _dry_run_guards.get(int(port)) is guard:
                _dry_run_guards.pop(int(port), None)
        raise
    return guard


def install_public_destination_cdp_guard(
    port: int,
    *,
    approved_application_url: str,
    worker_id: int | None = None,
    process: subprocess.Popen | None = None,
) -> "_PublicDestinationCdpGuard":
    """Install the live apply public-destination guard on Chrome pages."""
    guard = _PublicDestinationCdpGuard(
        port,
        approved_application_url=approved_application_url,
        worker_id=worker_id,
        process=process,
    )
    with _public_destination_guards_lock:
        _public_destination_guards[int(port)] = guard
    try:
        guard.start()
    except Exception:
        with _public_destination_guards_lock:
            if _public_destination_guards.get(int(port)) is guard:
                _public_destination_guards.pop(int(port), None)
        raise
    return guard


def get_dry_run_cdp_guard_evidence(port: int) -> dict[str, object]:
    """Return sanitized dry-run guard evidence collected for ``port``."""
    with _dry_run_guards_lock:
        guard = _dry_run_guards.get(int(port))
    if guard is None:
        return {
            "coverage": "unprotected",
            "blocked_channels": (),
            "blocked_requests": (),
            "protected_targets": 0,
        }
    return guard.evidence()


class _ApplyCdpGuard:
    def __init__(
        self,
        port: int,
        *,
        enforce_dry_run: bool,
        approved_application_url: str,
        capability_checker=None,
        worker_id: int | None = None,
        process: subprocess.Popen | None = None,
    ) -> None:
        self._port = int(port)
        self._enforce_dry_run = enforce_dry_run
        self._approved_origin = canonical_http_origin(approved_application_url)
        self._capability_checker = capability_checker
        self._worker_id = worker_id
        self._process = process
        self._revoked = threading.Event()
        self._termination_lock = threading.Lock()
        self._termination_requested = False
        self._protected_targets: set[str] = set()
        self._blocked: list[dict[str, str]] = []
        self._blocked_keys: set[tuple[str, str, str, str]] = set()
        self._request_initiators: dict[str, str] = {}
        self._lock = threading.Lock()

    @property
    def enforce_dry_run(self) -> bool:
        return self._enforce_dry_run

    def start(self) -> None:
        session = _BrowserApplyGuardSession.connect(self._port, self)
        session.arm_and_wait_until_ready()
        watcher = threading.Thread(
            target=session.run,
            name=f"apply-cdp-guard-{self._port}",
            daemon=True,
        )
        watcher.start()

    def live_submission_allowed(self) -> bool:
        """Fail closed when the live browser capability has been revoked.

        The live guard owns the CDP request boundary, so this is deliberately
        checked for each paused HTTP request as well as by the background
        watcher. Dry-run has its separate no-submit guard and does not need an
        authenticated submission authorization check here.
        """

        if self._enforce_dry_run:
            return True
        if self._revoked.is_set():
            return False
        if self._capability_checker is None:
            return True
        try:
            enabled = self._capability_checker()
        except BrowserCapabilityError:
            self._revoked.set()
            return False
        if enabled is False:
            self._revoked.set()
            return False
        return True

    def close_owned_browser(self) -> None:
        """Terminate the single worker browser once its capability is revoked."""

        with self._termination_lock:
            if self._termination_requested:
                return
            self._termination_requested = True
        if self._worker_id is None or self._process is None:
            return
        with _chrome_lock:
            tracked = _chrome_procs.get(self._worker_id)
            if tracked is not self._process or self._process.poll() is not None:
                return
            _kill_process_tree(self._process.pid)

    def record_protected_target(self, target_id: str) -> None:
        if not target_id:
            return
        with self._lock:
            self._protected_targets.add(target_id)

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

    def destination_is_approved(self, url: str) -> bool:
        try:
            return canonical_http_origin(url) == self._approved_origin
        except ValueError:
            return False

    def evidence(self) -> dict[str, object]:
        with self._lock:
            blocked = tuple(dict(item) for item in self._blocked)
            protected_targets = len(self._protected_targets)
        return {
            "coverage": _dry_run_coverage(blocked, protected_targets=protected_targets),
            "blocked_channels": _dry_run_blocked_channels(blocked),
            "blocked_requests": blocked,
            "protected_targets": protected_targets,
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
    def __init__(
        self,
        port: int,
        *,
        approved_application_url: str,
        worker_id: int | None = None,
        process: subprocess.Popen | None = None,
    ) -> None:
        super().__init__(
            port,
            enforce_dry_run=True,
            approved_application_url=approved_application_url,
            worker_id=worker_id,
            process=process,
        )


class _PublicDestinationCdpGuard(_ApplyCdpGuard):
    def __init__(
        self,
        port: int,
        *,
        approved_application_url: str,
        capability_checker=None,
        worker_id: int | None = None,
        process: subprocess.Popen | None = None,
    ) -> None:
        super().__init__(
            port,
            enforce_dry_run=False,
            approved_application_url=approved_application_url,
            capability_checker=capability_checker
            or (lambda: system_browser_capability_is_enabled("auto-apply-browser")),
            worker_id=worker_id,
            process=process,
        )


class _BrowserApplyGuardSession:
    """One browser-level CDP session that fail-closed protects every page."""

    def __init__(self, websocket_module, websocket_connection, guard: _ApplyCdpGuard) -> None:
        self._websocket_module = websocket_module
        self._ws = websocket_connection
        self._guard = guard
        self._counter = 0
        self._pending: dict[int, tuple[str, str, str]] = {}
        self._setup_pending: dict[str, set[int]] = {}
        self._session_targets: dict[str, str] = {}
        self._target_sessions: dict[str, str] = {}
        self._target_types: dict[str, str] = {}
        self._initial_targets: set[str] | None = None
        self._fetch_ready_targets: set[str] = set()
        self._resumed_targets: set[str] = set()
        self._discover_ready = False
        self._auto_attach_ready = False

    @classmethod
    def connect(cls, port: int, guard: _ApplyCdpGuard) -> "_BrowserApplyGuardSession":
        try:
            import websocket
        except Exception as exc:
            raise BrowserCapabilityError(
                "websocket-client is required for apply CDP enforcement"
            ) from exc
        version = _cdp_json(port, "/json/version")
        ws_url = (
            str(version.get("webSocketDebuggerUrl") or "")
            if isinstance(version, dict)
            else ""
        )
        if not ws_url:
            raise BrowserCapabilityError("Chrome browser-level CDP endpoint is unavailable")
        try:
            connection = websocket.create_connection(
                ws_url,
                timeout=0.25,
                suppress_origin=True,
            )
        except Exception as exc:
            raise BrowserCapabilityError("Chrome browser-level CDP connection failed") from exc
        return cls(websocket, connection, guard)

    def _send(
        self,
        method: str,
        params: dict | None = None,
        *,
        session_id: str = "",
        pending: tuple[str, str, str] | None = None,
    ) -> int:
        self._counter += 1
        payload: dict[str, object] = {
            "id": self._counter,
            "method": method,
            "params": params or {},
        }
        if session_id:
            payload["sessionId"] = session_id
        self._ws.send(json.dumps(payload))
        if pending is not None:
            self._pending[self._counter] = pending
        return self._counter

    def arm_and_wait_until_ready(self, *, timeout: float = 8.0) -> None:
        """Synchronously arm auto-attach and every page present at startup."""

        if not self._guard.live_submission_allowed():
            self._guard.close_owned_browser()
            self._close()
            raise BrowserCapabilityError("auto-apply browser capability was revoked during launch")
        self._send(
            "Target.setDiscoverTargets",
            {"discover": True},
            pending=("discover", "", ""),
        )
        self._send(
            "Target.setAutoAttach",
            {
                "autoAttach": True,
                "waitForDebuggerOnStart": True,
                "flatten": True,
            },
            pending=("auto_attach", "", ""),
        )
        self._send("Target.getTargets", pending=("initial_targets", "", ""))

        deadline = time.monotonic() + timeout
        try:
            while not self._startup_ready():
                if time.monotonic() >= deadline:
                    raise BrowserCapabilityError(
                        "Chrome CDP guard did not acknowledge Fetch.enable for every initial page"
                    )
                if not self._guard.live_submission_allowed():
                    raise BrowserCapabilityError(
                        "auto-apply browser capability was revoked while arming Chrome"
                    )
                self._receive_one()
        except Exception:
            self._guard.close_owned_browser()
            self._close()
            raise

    def _startup_ready(self) -> bool:
        return (
            self._discover_ready
            and self._auto_attach_ready
            and self._initial_targets is not None
            and self._initial_targets <= self._fetch_ready_targets
            and self._initial_targets <= self._resumed_targets
        )

    def _receive_one(self) -> None:
        try:
            raw_message = self._ws.recv()
        except self._websocket_module.WebSocketTimeoutException:
            return
        if not raw_message:
            raise BrowserCapabilityError("Chrome browser-level CDP connection closed")
        message = json.loads(raw_message)
        if not isinstance(message, dict):
            raise BrowserCapabilityError("Chrome returned an invalid CDP message")
        self._handle_message(message)

    def _handle_message(self, message: dict) -> None:
        message_id = message.get("id")
        if isinstance(message_id, int) and message_id in self._pending:
            kind, session_id, target_id = self._pending.pop(message_id)
            if message.get("error"):
                if kind == "attach" and target_id in self._target_sessions:
                    return
                error = message.get("error") or {}
                detail = (
                    str(error.get("message") or "")
                    if isinstance(error, dict)
                    else ""
                )
                target_type = self._target_types.get(target_id, "unknown")
                raise BrowserCapabilityError(
                    "Chrome rejected required CDP guard command "
                    f"{kind} for {target_type} target {target_id}"
                    + (f": {detail}" if detail else "")
                )
            self._handle_response(
                kind,
                session_id=session_id,
                target_id=target_id,
                message=message,
                message_id=message_id,
            )
            return

        method_name = message.get("method")
        if method_name == "Target.attachedToTarget":
            params = message.get("params") or {}
            target_info = params.get("targetInfo") or {}
            session_id = str(params.get("sessionId") or "")
            target_id = str(target_info.get("targetId") or "")
            if not session_id:
                raise BrowserCapabilityError("Chrome auto-attached a target without a session")
            target_type = str(target_info.get("type") or "")
            if target_type in _PROTECTED_PAGE_TARGET_TYPES and target_id:
                self._configure_target(
                    session_id,
                    target_id,
                    target_type=target_type,
                )
            elif target_type in _BLOCKED_WORKER_TARGET_TYPES and target_id:
                self._block_worker_target(
                    target_id=target_id,
                    target_type=target_type,
                    url=str(target_info.get("url") or ""),
                )
            else:
                self._send(
                    "Runtime.runIfWaitingForDebugger",
                    session_id=session_id,
                )
            return
        if method_name == "Target.targetDestroyed":
            params = message.get("params") or {}
            self._forget_target(str(params.get("targetId") or ""))
            return
        if method_name == "Target.detachedFromTarget":
            params = message.get("params") or {}
            self._forget_session(str(params.get("sessionId") or ""))
            return
        session_id = str(message.get("sessionId") or "")
        if session_id and session_id in self._session_targets:
            keep_running = _handle_apply_page_event(
                message,
                self._guard,
                lambda method, params=None: self._send(
                    method,
                    params,
                    session_id=session_id,
                ),
            )
            if not keep_running:
                raise BrowserCapabilityError("auto-apply browser capability was revoked")

    def _handle_response(
        self,
        kind: str,
        *,
        session_id: str,
        target_id: str,
        message: dict,
        message_id: int,
    ) -> None:
        if kind == "discover":
            self._discover_ready = True
            return
        if kind == "auto_attach":
            self._auto_attach_ready = True
            return
        if kind == "initial_targets":
            result = message.get("result") or {}
            target_infos = result.get("targetInfos") or []
            if not isinstance(target_infos, list):
                raise BrowserCapabilityError("Chrome returned an invalid initial target list")
            initial_target_types = {
                str(item.get("targetId")): str(item.get("type"))
                for item in target_infos
                if isinstance(item, dict)
                and item.get("type") in _PROTECTED_PAGE_TARGET_TYPES
                and item.get("targetId")
            }
            for item in target_infos:
                if (
                    isinstance(item, dict)
                    and item.get("type") in _BLOCKED_WORKER_TARGET_TYPES
                    and item.get("targetId")
                ):
                    self._block_worker_target(
                        target_id=str(item.get("targetId")),
                        target_type=str(item.get("type")),
                        url=str(item.get("url") or ""),
                    )
            self._target_types.update(initial_target_types)
            self._initial_targets = set(initial_target_types)
            for initial_target in sorted(self._initial_targets):
                if initial_target not in self._target_sessions:
                    self._send(
                        "Target.attachToTarget",
                        {"targetId": initial_target, "flatten": True},
                        pending=("attach", "", initial_target),
                    )
            return
        if kind == "attach":
            result = message.get("result") or {}
            attached_session = str(result.get("sessionId") or "")
            if not attached_session:
                raise BrowserCapabilityError(
                    "Chrome did not return a protected CDP session"
                )
            self._configure_target(
                attached_session,
                target_id,
                target_type=self._target_types.get(target_id, "page"),
            )
            return
        if kind == "setup":
            pending = self._setup_pending.get(session_id)
            if pending is None:
                return
            pending.discard(message_id)
            if not pending:
                self._send(
                    "Runtime.runIfWaitingForDebugger",
                    session_id=session_id,
                    pending=("resume", session_id, target_id),
                )
            return
        if kind == "fetch_enable":
            self._guard.record_protected_target(target_id)
            self._fetch_ready_targets.add(target_id)
            pending = self._setup_pending.get(session_id)
            if pending is None:
                return
            pending.discard(message_id)
            if not pending:
                self._send(
                    "Runtime.runIfWaitingForDebugger",
                    session_id=session_id,
                    pending=("resume", session_id, target_id),
                )
            return
        if kind == "resume":
            self._resumed_targets.add(target_id)

    def _configure_page(self, session_id: str, target_id: str) -> None:
        self._configure_target(session_id, target_id, target_type="page")

    def _block_worker_target(
        self,
        *,
        target_id: str,
        target_type: str,
        url: str,
    ) -> None:
        self._guard.record_blocked_request(
            channel="worker_target",
            method="TARGET",
            url=url,
            resource_type=target_type,
        )
        # Worker CDP targets do not expose Fetch.enable. Close them while
        # waitForDebuggerOnStart still prevents attacker-controlled worker code
        # from executing outside the page-target request guard.
        self._send(
            "Target.closeTarget",
            {"targetId": target_id},
        )

    def _configure_target(
        self,
        session_id: str,
        target_id: str,
        *,
        target_type: str,
    ) -> None:
        existing_session = self._target_sessions.get(target_id)
        if existing_session == session_id:
            return
        # Chrome can race our initial Target.attachToTarget call with the
        # browser-level auto-attach event and deliver two flattened sessions
        # for one target. Arm both before resuming either; keeping only the
        # first would create an unprotected resume window.
        if existing_session is None:
            self._target_sessions[target_id] = session_id
        self._session_targets[session_id] = target_id
        self._target_types[target_id] = target_type
        page_target = target_type in {"page", "iframe"}
        setup_commands: list[tuple[str, dict | None]] = [
            ("Network.enable", None),
            (
                "Target.setAutoAttach",
                {
                    "autoAttach": True,
                    "waitForDebuggerOnStart": True,
                    "flatten": True,
                },
            ),
        ]
        if page_target:
            setup_commands.insert(0, ("Page.enable", None))
        if self._guard.enforce_dry_run and page_target:
            setup_commands.extend(
                [
                    ("Runtime.enable", None),
                    ("Runtime.addBinding", {"name": "jobctrlDryRunBlocked"}),
                    (
                        "Page.addScriptToEvaluateOnNewDocument",
                        {"source": _FORM_SUBMIT_GUARD_SOURCE},
                    ),
                ]
            )
        setup_commands.append(
            (
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
        )
        if self._guard.enforce_dry_run and page_target:
            setup_commands.append(
                ("Runtime.evaluate", {"expression": _FORM_SUBMIT_GUARD_SOURCE})
            )
        pending_ids: set[int] = set()
        self._setup_pending[session_id] = pending_ids
        for method, params in setup_commands:
            kind = "fetch_enable" if method == "Fetch.enable" else "setup"
            command_id = self._send(
                method,
                params,
                session_id=session_id,
                pending=(kind, session_id, target_id),
            )
            pending_ids.add(command_id)

    def _forget_target(self, target_id: str) -> None:
        if not target_id:
            return
        if self._initial_targets is not None:
            self._initial_targets.discard(target_id)
        self._fetch_ready_targets.discard(target_id)
        self._resumed_targets.discard(target_id)
        self._target_types.pop(target_id, None)
        session_id = self._target_sessions.pop(target_id, "")
        if session_id:
            self._session_targets.pop(session_id, None)
            self._setup_pending.pop(session_id, None)

    def _forget_session(self, session_id: str) -> None:
        target_id = self._session_targets.pop(session_id, "")
        self._setup_pending.pop(session_id, None)
        if target_id and self._target_sessions.get(target_id) == session_id:
            self._target_sessions.pop(target_id, None)
            self._target_types.pop(target_id, None)

    def run(self) -> None:
        try:
            while True:
                if not self._guard.live_submission_allowed():
                    self._guard.close_owned_browser()
                    return
                self._receive_one()
        except Exception:
            logger.debug("Browser-level apply CDP guard ended", exc_info=True)
            self._guard.close_owned_browser()
        finally:
            self._close()

    def _close(self) -> None:
        try:
            self._ws.close()
        except Exception:
            pass


def _cdp_json(port: int, path: str) -> object:
    try:
        with urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        logger.debug("CDP request failed for port %d path %s", port, path, exc_info=True)
        return []


def _run_apply_page_session(target_id: str, ws_url: str, guard: _ApplyCdpGuard) -> None:
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
        guard.record_protected_target(target_id)
        while True:
            try:
                raw_message = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            message = json.loads(raw_message)
            if not _handle_apply_page_event(message, guard, send):
                break
    except Exception:
        logger.debug("CDP dry-run page session ended", exc_info=True)
    finally:
        try:
            ws.close()
        except Exception:
            pass


def _handle_apply_page_event(message: dict, guard: _ApplyCdpGuard, send) -> bool:
    """Handle one session event; return false after a fail-closed revocation."""

    method_name = message.get("method")
    if guard.enforce_dry_run and method_name == "Runtime.bindingCalled":
        _record_binding_call(message, guard)
        return True
    if guard.enforce_dry_run and method_name == "Network.webSocketCreated":
        params = message.get("params") or {}
        guard.record_blocked_request(
            channel="WebSocket",
            method="WEBSOCKET",
            url=str(params.get("url") or ""),
            resource_type="WebSocket",
        )
        return True
    if method_name == "Network.requestWillBeSent":
        if guard.enforce_dry_run:
            _record_request_initiator(message, guard)
        return True
    if method_name != "Fetch.requestPaused":
        return True
    params = message.get("params") or {}
    request = params.get("request") or {}
    request_id = params.get("requestId")
    network_id = str(params.get("networkId") or "")
    method = str(request.get("method") or "GET").upper()
    url = str(request.get("url") or "")
    resource_type = str(params.get("resourceType") or "Other")
    initiator_type = guard.request_initiator(network_id)
    if request_id and not guard.live_submission_allowed():
        guard.record_blocked_request(
            channel="capability_revoked",
            method=method,
            url=url,
            resource_type=resource_type,
        )
        send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
        # Closing both the page and the owned browser prevents existing
        # WebSocket/other channels from continuing after revocation.
        send("Page.close")
        guard.close_owned_browser()
        return False
    public_decision = validate_public_http_url(url)
    if request_id and not public_decision.allowed:
        guard.record_blocked_request(
            channel="public_destination",
            method=method,
            url=url,
            resource_type=resource_type,
        )
        send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
    elif request_id and not guard.destination_is_approved(url):
        guard.record_blocked_request(
            channel="approval_origin",
            method=method,
            url=url,
            resource_type=resource_type,
        )
        send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
    elif (
        request_id
        and guard.enforce_dry_run
        and _should_block_dry_run_request(
            method,
            resource_type=resource_type,
            initiator_type=initiator_type,
        )
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
    return True


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


def _dry_run_coverage(blocked: tuple[dict[str, str], ...], *, protected_targets: int = 1) -> str:
    if protected_targets <= 0 and not blocked:
        return "unprotected"
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
