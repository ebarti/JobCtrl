"""Chrome lifecycle management for apply workers.

Handles launching an isolated Chrome instance with remote debugging,
worker profile setup/cloning, and cross-platform process cleanup.
"""

import json
import logging
import os
import platform
import shutil
import socket
import stat
import subprocess
import threading
import tempfile
import time
from dataclasses import dataclass
from hashlib import sha256
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen
from weakref import WeakValueDictionary

from jobctrl import config
from jobctrl.browser_capabilities import (
    BrowserCapabilityError,
    require_system_browser_capability,
    system_browser_capability_is_enabled,
)
from jobctrl.apply.origins import canonical_http_origin, canonical_http_url
from jobctrl.infrastructure.network import validate_public_http_url
from jobctrl.infrastructure.process_ownership import (
    INSPECTION_AND_SIGNAL_DENIED_MESSAGE, INSPECTION_DENIED_MESSAGE, SIGNAL_DENIED_MESSAGE,
    ProcessInspectionAndSignalDenied, ProcessInspectionDenied, ProcessOwnershipError, ProcessSignalDenied,
    cleanup_lock, is_process_inspection_denied, is_process_signal_denied, terminate_owned_process,
)

logger = logging.getLogger(__name__)

# Legacy caller hint only; Chrome assigns every launched browser its own port.
BASE_CDP_PORT = 9222
_CDP_READY_TIMEOUT_SECONDS = 10.0
_CDP_READY_POLL_SECONDS = 0.1
_CDP_READY_STABLE_PROBES = 10

# Track Chrome processes per worker for cleanup
_chrome_procs: dict[int, subprocess.Popen] = {}
_chrome_identities: dict[int, tuple[subprocess.Popen, int]] = {}
_chrome_unpublished: dict[int, list[tuple[subprocess.Popen, int]]] = {}
_launching_workers: set[int] = set()
_launching_ports: set[int] = set()
_chrome_lock = threading.RLock()
_chrome_worker_guards: WeakValueDictionary = WeakValueDictionary()


@dataclass(frozen=True)
class _BrowserEndpoint:
    process: subprocess.Popen
    pid: int
    profile_dir: Path
    file_identity: tuple[int, int]
    file_bytes: bytes
    port: int
    browser_ws: str


_chrome_endpoints: dict[int, _BrowserEndpoint] = {}
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

def _chrome_worker_guard(worker_id: int) -> threading.RLock:
    with cleanup_lock(_chrome_lock):
        guard = _chrome_worker_guards.get(worker_id)
        if guard is None:
            guard = threading.RLock()
            _chrome_worker_guards[worker_id] = guard
        return guard


def _register_owned_browser(worker_id: int, process: subprocess.Popen) -> None:
    from jobctrl.apply.ownership import publish_owned_apply_process

    def publish() -> None:
        with _chrome_worker_guard(worker_id):
            with _chrome_lock:
                current = _chrome_procs.get(worker_id)
                if current is not None and current is not process:
                    raise BrowserCapabilityError("Cannot replace an owned Apply browser process")
                _chrome_procs[worker_id] = process
                _chrome_identities[worker_id] = (process, process.pid)

    publish_owned_apply_process(worker_id, process, publish)


def _retain_unpublished_browser(worker_id: int, process: subprocess.Popen, launched_pid: int) -> None:
    with cleanup_lock(_chrome_lock):
        pending = _chrome_unpublished.setdefault(worker_id, [])
        if not any(owned is process and pid == launched_pid for owned, pid in pending):
            pending.append((process, launched_pid))


def _cleanup_unpublished_browser(worker_id: int) -> list[Exception]:
    failures = []
    with cleanup_lock(_chrome_worker_guard(worker_id)):
        with cleanup_lock(_chrome_lock):
            pending = tuple(_chrome_unpublished.get(worker_id, ()))
        for process, launched_pid in pending:
            try:
                terminate_owned_process(process, launched_pid=launched_pid)
            except Exception as exc:
                failures.append(exc)
            else:
                with cleanup_lock(_chrome_lock):
                    remaining = [(owned, pid) for owned, pid in _chrome_unpublished.get(worker_id, ())
                                 if owned is not process or pid != launched_pid]
                    if remaining:
                        _chrome_unpublished[worker_id] = remaining
                    else:
                        _chrome_unpublished.pop(worker_id, None)
    return failures


def _kill_process_tree(pid: int, *, process: subprocess.Popen | None = None) -> None:
    """Terminate only a browser still bound to its original launch handle.

    A PID, port, process name or current group alone is never kill authority.
    POSIX Popen's reaping lock keeps the unreaped child PID from being reused
    between verification and the signal. Its launch-created session establishes
    group ownership; a leader already exited before cleanup cannot authorize
    cleanup of leftovers.
    Windows uses the original kernel process handle, never taskkill's PID tree.
    """
    if process is None:
        return
    with cleanup_lock(_chrome_lock):
        owners = [
            worker_id for worker_id, (owned, launched_pid) in _chrome_identities.items()
            if owned is process and launched_pid == pid and process.pid == pid
            and _chrome_procs.get(worker_id) is owned
        ]
        if len(owners) != 1:
            raise BrowserCapabilityError("Cannot verify Apply browser process ownership")
        worker_id = owners[0]
        guard = _chrome_worker_guard(worker_id)
    with cleanup_lock(guard):
        with cleanup_lock(_chrome_lock):
            identity = _chrome_identities.get(worker_id)
            if (_chrome_procs.get(worker_id) is not process or identity is None
                    or identity[0] is not process or identity[1] != pid or process.pid != pid):
                raise BrowserCapabilityError("Cannot verify Apply browser process ownership")
            # Other workers may use the registry while this handle drains,
            # but this browser must not be reused during termination.
            process._jobctrl_browser_terminating = True
        try:
            terminate_owned_process(process, launched_pid=pid)
        except ProcessOwnershipError as exc:
            raise BrowserCapabilityError(str(exc)) from exc


def _require_available_cdp_port(port: int) -> None:
    """Refuse an occupied resource without inspecting or signalling its owner."""
    if not 1 <= port <= 65535:
        raise BrowserCapabilityError("Apply browser CDP port must be between 1 and 65535")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if platform.system() == "Windows":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", port))
    except OSError as exc:
        raise BrowserCapabilityError(
            f"Apply browser port {port} is unavailable; retry with a different port "
            "or stop its owner yourself. JobCtrl did not terminate the occupant."
        ) from exc


# ---------------------------------------------------------------------------
# Worker profile management
# ---------------------------------------------------------------------------

def setup_worker_profile(worker_id: int) -> Path:
    """Create a fresh private Chrome profile for exactly one browser launch.

    This function intentionally never discovers, reads, or copies a host
    browser profile. Authentication for a system browser is an explicit
    capability choice; a bare auto-apply enable starts from a clean profile.

    Args:
        worker_id: Numeric worker identifier.

    Returns:
        Path to the worker's Chrome user-data directory.
    """
    config.CHROME_WORKER_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    profile_dir = Path(tempfile.mkdtemp(prefix=f"worker-{worker_id}-", dir=config.CHROME_WORKER_DIR))
    profile_dir.chmod(0o700)
    (profile_dir / "Default").mkdir(mode=0o700)
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
        port: Legacy validated caller hint; Chrome always binds an assigned port.
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

    if port is not None and (type(port) is not int or not 0 <= port <= 65535):
        raise BrowserCapabilityError("Apply browser CDP port hint must be between 0 and 65535")

    with _chrome_lock:
        if worker_id in _chrome_procs or worker_id in _chrome_unpublished or worker_id in _launching_workers:
            raise BrowserCapabilityError(f"Apply browser worker {worker_id} already has an owner")
        _launching_workers.add(worker_id)

    try:
        return _launch_chrome_owned(
            worker_id, port, headless, dry_run,
            chrome_exe=chrome_exe, approved_application_url=approved_application_url,
        )
    finally:
        with _chrome_lock:
            _launching_workers.discard(worker_id)


def _launch_chrome_owned(
    worker_id: int, port: int | None, headless: bool, dry_run: bool, *,
    chrome_exe: str, approved_application_url: str,
) -> subprocess.Popen:
    # Preserve explicit occupied-hint refusal for callers. This probe conveys
    # no endpoint ownership: Chrome still binds port 0 and publishes its own.
    if port:
        _require_available_cdp_port(port)
    profile_dir = setup_worker_profile(worker_id)
    if (profile_dir / "DevToolsActivePort").exists() or (profile_dir / "DevToolsActivePort").is_symlink():
        raise BrowserCapabilityError("Apply browser profile already contains a CDP endpoint")

    # Patch preferences to suppress restore nag
    _suppress_restore_nag(profile_dir)

    cmd = [
        chrome_exe,
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
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

    # A dedicated session is created by Popen itself; no thread-unsafe preexec.
    kwargs: dict = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if platform.system() != "Windows":
        kwargs["start_new_session"] = True

    from jobctrl.apply.ownership import spawn_owned_apply_process

    proc = spawn_owned_apply_process(worker_id, "browser", cmd, **kwargs)
    registered = False
    try:
        _register_owned_browser(worker_id, proc)
        registered = True
        # Readiness is condition-based because a cold browser can take longer
        # than a fixed delay. The synchronous guard startup below does not
        # return until every initial page acknowledges Fetch.enable and
        # browser-level paused auto-attach protects future pages.
        endpoint = _wait_for_owned_endpoint_file(worker_id, proc, profile_dir)
        port = endpoint.port
        _wait_for_browser_cdp_endpoint(port, proc, expected_browser_ws=endpoint.browser_ws)
        with _chrome_lock:
            _require_live_browser(worker_id, proc)
            _chrome_endpoints[worker_id] = endpoint
        get_worker_endpoint(worker_id, proc)
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
    except BaseException:
        if registered:
            cleanup_worker(worker_id, proc)
        elif getattr(proc, "_jobctrl_apply_birth", None) is None:
            # Retain the exact standalone child before attempting cleanup; a
            # refusal must not discard custody or replace another browser.
            _retain_unpublished_browser(worker_id, proc, proc.pid)
            failures = _cleanup_unpublished_browser(worker_id)
            if failures:
                raise failures[0]
        raise
    logger.info("[worker-%d] Chrome started on port %d (pid %d)",
                worker_id, port, proc.pid)
    return proc


def _require_live_browser(worker_id: int, process: subprocess.Popen) -> None:
    identity = _chrome_identities.get(worker_id)
    if (
        _chrome_procs.get(worker_id) is not process
        or identity is None or identity[0] is not process
        or identity[1] != process.pid
        or getattr(process, "_jobctrl_browser_terminating", False) is True
        or process.poll() is not None
    ):
        raise BrowserCapabilityError("Cannot verify live Apply browser launch ownership")


def _read_private_endpoint(profile_dir: Path) -> tuple[int, str, tuple[int, int], bytes]:
    """Read only the launch's fresh private Chrome-generated endpoint file."""
    directory = profile_dir.lstat()
    if (
        not stat.S_ISDIR(directory.st_mode) or directory.st_mode & 0o077
        or (hasattr(os, "getuid") and directory.st_uid != os.getuid())
    ):
        raise BrowserCapabilityError("Apply browser profile must be a private directory")
    fd = os.open(profile_dir / "DevToolsActivePort", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        identity = os.fstat(fd)
        if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1 or identity.st_mode & 0o022:
            raise BrowserCapabilityError("Apply browser endpoint file is not privately owned")
        if hasattr(os, "getuid") and identity.st_uid != os.getuid():
            raise BrowserCapabilityError("Apply browser endpoint file has another owner")
        raw = os.read(fd, 4097)
    finally:
        os.close(fd)
    try:
        lines = raw.decode("ascii").splitlines()
        if len(raw) > 4096 or len(lines) != 2 or not lines[0].isdigit():
            raise ValueError("invalid endpoint format")
        port = int(lines[0])
        path = lines[1]
        token = path.removeprefix("/devtools/browser/")
        if (
            not 1 <= port <= 65535 or not path.startswith("/devtools/browser/")
            or not token or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in token)
        ):
            raise ValueError("invalid browser endpoint")
    except (UnicodeError, ValueError) as exc:
        raise BrowserCapabilityError("Apply browser endpoint file is malformed") from exc
    return port, f"ws://127.0.0.1:{port}{path}", (identity.st_dev, identity.st_ino), raw


def _wait_for_owned_endpoint_file(
    worker_id: int, process: subprocess.Popen, profile_dir: Path,
) -> _BrowserEndpoint:
    deadline = time.monotonic() + _CDP_READY_TIMEOUT_SECONDS
    while True:
        with _chrome_lock:
            _require_live_browser(worker_id, process)
        try:
            port, browser_ws, identity, raw = _read_private_endpoint(profile_dir)
            return _BrowserEndpoint(process, process.pid, profile_dir, identity, raw, port, browser_ws)
        except FileNotFoundError:
            pass  # Chrome publishes the file after its own successful bind.
        if time.monotonic() >= deadline:
            raise BrowserCapabilityError("Chrome did not publish its private CDP endpoint")
        time.sleep(_CDP_READY_POLL_SECONDS)


def get_worker_endpoint(worker_id: int, process: subprocess.Popen) -> tuple[int, str]:
    """Return the endpoint bound to this exact live worker launch, or refuse."""
    with _chrome_lock:
        _require_live_browser(worker_id, process)
        endpoint = _chrome_endpoints.get(worker_id)
        if endpoint is None or endpoint.process is not process or endpoint.pid != process.pid:
            raise BrowserCapabilityError("Apply browser has no owned CDP endpoint")
        try:
            port, browser_ws, identity, raw = _read_private_endpoint(endpoint.profile_dir)
        except OSError as exc:
            raise BrowserCapabilityError("Apply browser private CDP endpoint is unavailable") from exc
        if (port, browser_ws, identity, raw) != (
            endpoint.port, endpoint.browser_ws, endpoint.file_identity, endpoint.file_bytes,
        ):
            raise BrowserCapabilityError("Apply browser private CDP endpoint changed")
        version = _cdp_json(port, "/json/version")
        if not isinstance(version, dict) or version.get("webSocketDebuggerUrl") != browser_ws:
            raise BrowserCapabilityError("Apply browser CDP endpoint identity changed")
        _require_live_browser(worker_id, process)
        return port, browser_ws


def _wait_for_browser_cdp_endpoint(
    port: int,
    process: subprocess.Popen,
    *,
    timeout_seconds: float = _CDP_READY_TIMEOUT_SECONDS,
    poll_seconds: float = _CDP_READY_POLL_SECONDS,
    stable_probes: int = _CDP_READY_STABLE_PROBES,
    expected_browser_ws: str | None = None,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    ready_url = ""
    ready_count = 0
    while True:
        if process.poll() is not None:
            raise BrowserCapabilityError(
                "Chrome exited before its browser-level CDP endpoint became ready"
            )
        version = _cdp_json(port, "/json/version")
        candidate_url = (
            str(version.get("webSocketDebuggerUrl") or "")
            if isinstance(version, dict)
            else ""
        )
        if candidate_url and expected_browser_ws is not None and candidate_url != expected_browser_ws:
            raise BrowserCapabilityError("Chrome browser-level CDP endpoint identity does not match its private profile")
        if candidate_url and candidate_url == ready_url:
            ready_count += 1
        elif candidate_url:
            ready_url = candidate_url
            ready_count = 1
        else:
            ready_url = ""
            ready_count = 0
        if ready_count >= stable_probes:
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise BrowserCapabilityError(
                "Chrome browser-level CDP endpoint did not become ready"
            )
        time.sleep(min(poll_seconds, remaining))


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
            "allowed_navigations": (),
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
        self._approved_application_url = canonical_http_url(
            approved_application_url
        )
        self._capability_checker = capability_checker
        self._worker_id = worker_id
        self._process = process
        self._revoked = threading.Event()
        self._termination_lock = threading.Lock()
        self._termination_requested = False
        self._protected_targets: set[str] = set()
        self._blocked: list[dict[str, str]] = []
        self._blocked_keys: set[tuple[str, str, str, str]] = set()
        self._navigation_grants = (
            {("GET", self._approved_application_url)}
            if enforce_dry_run
            else set()
        )
        self._allowed_navigations: list[dict[str, str]] = []
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
        _kill_process_tree(self._process.pid, process=self._process)

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

    def consume_navigation_grant(
        self,
        *,
        method: str,
        url: str,
        resource_type: str,
    ) -> bool:
        if (
            not self._enforce_dry_run
            or str(method or "").upper() != "GET"
            or str(resource_type or "") != "Document"
        ):
            return False
        try:
            canonical_url = canonical_http_url(url)
        except ValueError:
            return False
        grant = ("GET", canonical_url)
        with self._lock:
            if grant not in self._navigation_grants:
                return False
            self._navigation_grants.remove(grant)
            self._allowed_navigations.append(
                {
                    "decision": "run_bound_initial_url",
                    "grant_id": "initial_application_url",
                    "method": "GET",
                    "url": _sanitize_evidence_url(canonical_url),
                    "url_fingerprint": sha256(
                        canonical_url.encode("utf-8")
                    ).hexdigest(),
                }
            )
        return True

    def evidence(self) -> dict[str, object]:
        with self._lock:
            blocked = tuple(dict(item) for item in self._blocked)
            allowed_navigations = tuple(
                dict(item) for item in self._allowed_navigations
            )
            protected_targets = len(self._protected_targets)
        return {
            "coverage": _dry_run_coverage(
                blocked,
                protected_targets=protected_targets,
                allowed_navigations=(
                    allowed_navigations if self._enforce_dry_run else None
                ),
            ),
            "blocked_channels": _dry_run_blocked_channels(blocked),
            "blocked_requests": blocked,
            "allowed_navigations": allowed_navigations,
            "protected_targets": protected_targets,
        }


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
        if guard._worker_id is not None and guard._process is not None:
            owned_port, ws_url = get_worker_endpoint(guard._worker_id, guard._process)
            if owned_port != port:
                raise BrowserCapabilityError("Apply guard port does not match its owned browser")
        else:
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
    if method_name != "Fetch.requestPaused":
        return True
    params = message.get("params") or {}
    request = params.get("request") or {}
    request_id = params.get("requestId")
    method = str(request.get("method") or "GET").upper()
    url = str(request.get("url") or "")
    resource_type = str(params.get("resourceType") or "Other")
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
    elif request_id and guard.enforce_dry_run:
        if guard.consume_navigation_grant(
            method=method,
            url=url,
            resource_type=resource_type,
        ):
            send("Fetch.continueRequest", {"requestId": request_id})
        else:
            guard.record_blocked_request(
                channel="network",
                method=method,
                url=url,
                resource_type=resource_type,
            )
            send(
                "Fetch.failRequest",
                {"requestId": request_id, "errorReason": "BlockedByClient"},
            )
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


def _dry_run_coverage(
    blocked: tuple[dict[str, str], ...],
    *,
    protected_targets: int = 1,
    allowed_navigations: tuple[dict[str, str], ...] | None = None,
) -> str:
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
    if allowed_navigations is not None and not allowed_navigations:
        return "unprotected"
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
    if process is None:
        return
    with cleanup_lock(_chrome_worker_guard(worker_id)):
        with cleanup_lock(_chrome_lock):
            if _chrome_procs.get(worker_id) is not process:
                return
        _kill_process_tree(process.pid, process=process)
        with cleanup_lock(_chrome_lock):
            if _chrome_procs.get(worker_id) is process:
                _chrome_procs.pop(worker_id, None)
                _chrome_identities.pop(worker_id, None)
                _chrome_endpoints.pop(worker_id, None)
    logger.info("[worker-%d] Chrome cleaned up", worker_id)


def kill_all_chrome() -> None:
    """Clean up browsers owned by this Python process without port sweeps."""
    with _chrome_lock:
        worker_ids = tuple(dict.fromkeys((*_chrome_procs, *_chrome_unpublished, *_launching_workers)))
    cleanup_workers(worker_ids)


def cleanup_workers(worker_ids: Iterable[int]) -> None:
    """Clean only the exact browser handles currently owned by these workers."""
    worker_ids = tuple(worker_ids)
    with cleanup_lock(_chrome_lock):
        procs = {wid: _chrome_procs[wid] for wid in worker_ids if wid in _chrome_procs}
        pending_workers = tuple(wid for wid in worker_ids if _chrome_unpublished.get(wid))
    failures = []
    inspection_denied = False
    signal_denied = False
    for wid, process in procs.items():
        try:
            cleanup_worker(wid, process)
        except Exception as exc:
            logger.error("[worker-%d] Apply browser cleanup failed: %s", wid, exc)
            failures.append(wid)
            inspection_denied = inspection_denied or is_process_inspection_denied(exc)
            signal_denied = signal_denied or is_process_signal_denied(exc)
    for wid in pending_workers:
        try:
            pending_failures = _cleanup_unpublished_browser(wid)
        except Exception as exc:
            pending_failures = [exc]
        for exc in pending_failures:
            failures.append(wid)
            inspection_denied = inspection_denied or is_process_inspection_denied(exc)
            signal_denied = signal_denied or is_process_signal_denied(exc)
    try:
        with cleanup_lock(_chrome_lock):
            failures.extend(wid for wid in worker_ids
                            if wid in _launching_workers or _chrome_unpublished.get(wid))
    except Exception:
        if not (inspection_denied or signal_denied):
            raise
    if inspection_denied and signal_denied:
        raise ProcessInspectionAndSignalDenied(INSPECTION_AND_SIGNAL_DENIED_MESSAGE)
    if inspection_denied:
        raise ProcessInspectionDenied(INSPECTION_DENIED_MESSAGE)
    if signal_denied:
        raise ProcessSignalDenied(SIGNAL_DENIED_MESSAGE)
    if failures:
        raise BrowserCapabilityError(f"Apply browser cleanup could not verify exit for workers {failures}")


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
    """Atexit handler: clean only browsers launched by this Python process.

    Register this with atexit.register() at application startup.
    """
    try:
        kill_all_chrome()
    except Exception:
        logger.exception("Apply browser exit cleanup incomplete; unverified resources were preserved")
