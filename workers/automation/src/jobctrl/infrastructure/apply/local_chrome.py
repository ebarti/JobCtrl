"""LocalChromeAdapter — local-mode ``BrowserPort`` adapter.

Wraps the existing ``jobctrl.apply.chrome`` Chrome lifecycle helpers
(``launch_chrome`` / ``cleanup_worker`` / ``reset_worker_dir``) behind
the ``BrowserPort`` Protocol so the apply use cases never import
Chrome subprocess code directly. Cloud mode swaps in a Browserbase
adapter without touching the use cases.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from pathlib import Path

from jobctrl.apply import chrome as _chrome
from jobctrl.browser_capabilities import require_system_browser_capability
from jobctrl.domain.apply.value_objects import BrowserWorkerConfig
from jobctrl.domain.ports.apply import BrowserSession

log = logging.getLogger(__name__)


class LocalChromeAdapter:
    """``BrowserPort`` implementation backed by a local Chrome process.

    ``launch`` starts Chrome with an OS-assigned endpoint and joins its
    private profile receipt to the exact launched browser identity. The
    returned session carries the actual verified port. Cleanup selects only
    that session's original owned process handle.

    The adapter is stateless — each ``launch`` call creates a brand
    new ``BrowserSession`` value object and the underlying
    ``subprocess.Popen`` handle is stashed on it for cleanup.
    """

    def launch(self, config: BrowserWorkerConfig) -> BrowserSession:
        # Keep the port boundary fail-closed even if a future BrowserPort
        # implementation bypasses ``apply.chrome``.
        require_system_browser_capability("auto-apply-browser")
        if config.user_data_dir:
            # The use case may prepare resume/cover-letter uploads before
            # browser launch. Preserve that directory when it is supplied.
            worker_dir = Path(config.user_data_dir).expanduser()
            worker_dir.mkdir(parents=True, exist_ok=True)
        else:
            # Standalone adapter callers still get the legacy fresh workspace.
            worker_dir = _chrome.reset_worker_dir(config.worker_id)
        proc = _chrome.launch_chrome(
            worker_id=config.worker_id,
            port=config.cdp_port,
            headless=config.headless,
            dry_run=config.dry_run,
            approved_application_url=config.approved_application_url,
        )
        actual_port, browser_ws = _chrome.get_worker_endpoint(config.worker_id, proc)
        config = replace(config, cdp_port=actual_port)
        log.info(
            "LocalChromeAdapter.launch: worker_id=%d port=%d pid=%d headless=%s",
            config.worker_id,
            config.cdp_port,
            proc.pid,
            config.headless,
        )
        return BrowserSession(
            config=config,
            pid=proc.pid,
            worker_dir=str(worker_dir),
            handle=proc,
            browser_ws_url=browser_ws,
            dry_run_evidence=(
                lambda port=config.cdp_port: _chrome.get_dry_run_cdp_guard_evidence(port)
            )
            if config.dry_run
            else None,
        )

    def cleanup(self, session: BrowserSession) -> None:
        proc = session.handle
        if proc is None:
            return
        try:
            _chrome.cleanup_worker(session.worker_id, proc)
        except Exception:  # noqa: BLE001 — cleanup MUST be idempotent
            log.exception(
                "LocalChromeAdapter.cleanup: failed for worker %d (best-effort)",
                session.worker_id,
            )


__all__ = ["LocalChromeAdapter"]
