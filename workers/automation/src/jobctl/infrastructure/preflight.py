"""Startup preflight checks for the local worker runtime.

Discovery scraping and HTML/CSS PDF rendering both launch Playwright Chromium.
When that browser binary is missing the worker still boots and connects to
Temporal, then fails hours into a Discover run the first time an activity tries
to launch a browser. These checks let the worker startup gate and
``jobctl doctor`` fail fast at startup with an actionable message instead of
deep inside a long-running workflow.
"""

from __future__ import annotations

from pathlib import Path

# Shared remediation text so the worker gate, ``doctor``, and the error message
# all point users at exactly one fix. The GC warning matters because multiple
# git worktrees share ``~/Library/Caches/ms-playwright``: running
# ``playwright install`` from a checkout on a newer Playwright version
# garbage-collects the older browser revision this venv still needs.
PLAYWRIGHT_INSTALL_COMMAND = (
    "uv --project workers/automation run playwright install chromium"
)
PLAYWRIGHT_WORKTREE_GC_WARNING = (
    "playwright install from another checkout can garbage-collect this "
    "version's browsers from the shared ~/Library/Caches/ms-playwright cache; "
    "set PLAYWRIGHT_SKIP_BROWSER_GC=1 when installing elsewhere"
)


def check_playwright_chromium() -> tuple[bool, str]:
    """Report whether this venv's Playwright Chromium can actually launch.

    Resolves ``chromium.executable_path`` and checks the file exists, then does
    a real ``chromium.launch(headless=True)`` + ``close()``. The launch matters:
    ``executable_path`` resolves the *full* chromium binary, but
    ``launch(headless=True)`` runs the separate ``chromium_headless_shell``
    executable — which is exactly the binary the 2026-07-04 incident was missing.
    A path-existence check alone would pass in that state yet still crash every
    scrape, so the launch is what makes this a definitive gate. It costs ~1s once
    at worker startup / ``doctor`` and needs no network.

    Returns ``(ok, message)``. On success the message names the resolved path.
    On any failure (browsers never installed, the resolved binary missing, the
    headless-shell binary missing so launch fails, or the driver raising) the
    message is actionable: it names the missing path when known, the install
    command, and the shared-cache GC gotcha that bites multi-worktree setups.
    """
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            executable_path = str(playwright.chromium.executable_path)
            if not Path(executable_path).exists():
                return False, (
                    f"Playwright Chromium binary is missing at {executable_path}. "
                    f"Install it with '{PLAYWRIGHT_INSTALL_COMMAND}'. "
                    f"Note: {PLAYWRIGHT_WORKTREE_GC_WARNING}."
                )
            # A launch(headless=True) uses chromium_headless_shell, a different
            # binary from the one executable_path resolves. Launch + close is the
            # only check that catches a missing headless shell (the incident).
            browser = playwright.chromium.launch(headless=True)
            browser.close()
    except Exception as exc:  # noqa: BLE001 - any resolution or launch failure is a preflight failure.
        return False, (
            f"Playwright Chromium unavailable: {exc}. "
            f"Install it with '{PLAYWRIGHT_INSTALL_COMMAND}'. "
            f"Note: {PLAYWRIGHT_WORKTREE_GC_WARNING}."
        )

    return True, f"Playwright Chromium available at {executable_path}"
