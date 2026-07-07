"""LocalChromeAdapter — local-mode ``BrowserPort`` adapter.

Wraps the existing ``jobctl.apply.chrome`` Chrome lifecycle helpers
(``launch_chrome`` / ``cleanup_worker`` / ``reset_worker_dir``) behind
the ``BrowserPort`` Protocol so the apply use cases never import
Chrome subprocess code directly. Cloud mode swaps in a Browserbase
adapter without touching the use cases.
"""

from __future__ import annotations

import logging
from pathlib import Path

from jobctl.apply import chrome as _chrome
from jobctl.domain.apply.value_objects import BrowserWorkerConfig
from jobctl.domain.ports.apply import BrowserSession

log = logging.getLogger(__name__)


class LocalChromeAdapter:
    """``BrowserPort`` implementation backed by a local Chrome process.

    ``launch`` invokes ``chrome.launch_chrome`` (which sets up the
    isolated profile, kills any zombie process on the port, then
    spawns Chrome with remote debugging on the requested CDP port).
    ``cleanup`` invokes ``chrome.cleanup_worker`` (kill process tree
    on Unix / taskkill /T on Windows). Both calls are idempotent.

    The adapter is stateless — each ``launch`` call creates a brand
    new ``BrowserSession`` value object and the underlying
    ``subprocess.Popen`` handle is stashed on it for cleanup.
    """

    def launch(self, config: BrowserWorkerConfig) -> BrowserSession:
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
        )
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
