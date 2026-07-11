"""Startup preflight checks for the local worker runtime.

Discovery scraping and HTML/CSS PDF rendering both launch Playwright Chromium.
When that browser binary is missing the worker still boots and connects to
Temporal, then fails hours into a Discover run the first time an activity tries
to launch a browser. These checks let the worker startup gate and
``jobctrl doctor`` fail fast at startup with an actionable message instead of
deep inside a long-running workflow.
"""

from __future__ import annotations

from jobctrl.runtime import is_bundled_runtime

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
BUNDLED_PLAYWRIGHT_REMEDIATION = (
    "The managed core browser is missing or damaged in the JobCtrl runtime payload. "
    "Run 'jobctrl update' to repair the installed runtime; if it persists, reinstall JobCtrl."
)


def _playwright_remediation() -> str:
    """Give installed users a product action and contributors the source action."""

    if is_bundled_runtime():
        return BUNDLED_PLAYWRIGHT_REMEDIATION
    return (
        f"Install it with '{PLAYWRIGHT_INSTALL_COMMAND}'. "
        f"Note: {PLAYWRIGHT_WORKTREE_GC_WARNING}."
    )


def check_playwright_chromium() -> tuple[bool, str]:
    """Report whether this venv's Playwright Chromium can actually launch.

    Performs a real ``chromium.launch(headless=True)`` + ``close()``. The
    Playwright ``executable_path`` property resolves the full browser, whereas
    headless launch uses ``chromium_headless_shell``. The bundled core now
    intentionally ships only that separately licensed headless shell, so a
    full-browser path check would reject a healthy runtime. Launch + close is
    the authoritative, network-free startup gate.

    Returns ``(ok, message)``. On any failure (browsers never installed, the
    headless-shell binary missing so launch fails, or the driver raising) the
    message is actionable: installed users receive a JobCtrl runtime repair
    action, while source contributors receive the pinned Playwright command and
    the shared-cache GC warning that bites multi-worktree setups.
    """
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            browser.close()
    except Exception as exc:  # noqa: BLE001 - any resolution or launch failure is a preflight failure.
        return False, (
            f"Playwright Chromium unavailable: {exc}. "
            f"{_playwright_remediation()}"
        )

    return True, "Playwright Chromium headless launch succeeded"
