"""Unit tests for the worker startup browser preflight and its worker gate.

These are hermetic: ``playwright.sync_api.sync_playwright`` is monkeypatched so
no real browser (or browser install) is needed. The preflight resolves the
Chromium path, checks it exists, and then does a real headless launch (the
headless-shell binary is separate from the full chromium binary and was the
thing missing in the incident), so the fakes model both the resolved path and
the launch outcome.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from jobctrl import cli
from jobctrl.infrastructure.preflight import (
    BUNDLED_PLAYWRIGHT_REMEDIATION,
    PLAYWRIGHT_INSTALL_COMMAND,
    PLAYWRIGHT_WORKTREE_GC_WARNING,
    check_playwright_chromium,
)

# The helper imports ``playwright.sync_api`` at call time; skip the whole module
# rather than erroring on the monkeypatch target if playwright is not installed.
pytest.importorskip("playwright.sync_api")

_CHECK_TARGET = "jobctrl.infrastructure.preflight.check_playwright_chromium"


class _FakeBrowser:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeChromium:
    def __init__(self, executable_path: str, launch_error: Exception | None = None) -> None:
        self.executable_path = executable_path
        self._launch_error = launch_error

    def launch(self, *, headless: bool = True) -> _FakeBrowser:
        # Mirrors the real driver: launch(headless=True) is where a missing
        # chromium_headless_shell binary surfaces, so a failing launch raises.
        if self._launch_error is not None:
            raise self._launch_error
        return _FakeBrowser()


class _FakePlaywright:
    def __init__(self, executable_path: str, launch_error: Exception | None = None) -> None:
        self.chromium = _FakeChromium(executable_path, launch_error)


class _FakeSyncPlaywrightContext:
    """Stand-in for the ``sync_playwright()`` context manager."""

    def __init__(self, executable_path: str, launch_error: Exception | None = None) -> None:
        self._executable_path = executable_path
        self._launch_error = launch_error

    def __enter__(self) -> _FakePlaywright:
        return _FakePlaywright(self._executable_path, self._launch_error)

    def __exit__(self, *exc: object) -> bool:
        return False


def _patch_sync_playwright(
    monkeypatch: pytest.MonkeyPatch,
    executable_path: str,
    *,
    launch_error: Exception | None = None,
) -> None:
    monkeypatch.setattr(
        "playwright.sync_api.sync_playwright",
        lambda: _FakeSyncPlaywrightContext(executable_path, launch_error),
    )


# --- check_playwright_chromium -------------------------------------------------


def test_check_reports_available_when_binary_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    binary = tmp_path / "chrome-headless-shell"
    binary.write_bytes(b"#!/bin/sh\n")
    _patch_sync_playwright(monkeypatch, str(binary))

    ok, message = check_playwright_chromium()

    assert ok is True
    assert message == f"Playwright Chromium available at {binary}"


def test_check_reports_missing_binary_with_actionable_message(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A resolvable path whose file does not exist — the exact incident shape:
    # the revision directory was garbage-collected out from under this venv.
    missing = tmp_path / "chromium_headless_shell-1208" / "chrome-headless-shell"
    _patch_sync_playwright(monkeypatch, str(missing))

    ok, message = check_playwright_chromium()

    assert ok is False
    # Actionable: names the missing path, the fix command, and the GC gotcha.
    assert str(missing) in message
    assert PLAYWRIGHT_INSTALL_COMMAND in message
    assert PLAYWRIGHT_WORKTREE_GC_WARNING in message


def test_check_reports_failure_when_headless_shell_launch_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The exact incident shape a path check alone would miss: the full chromium
    # binary resolves and exists, but launch(headless=True) uses the separate
    # chromium_headless_shell executable, which was garbage-collected. Only the
    # real launch catches it.
    binary = tmp_path / "chrome"
    binary.write_bytes(b"#!/bin/sh\n")
    launch_error = RuntimeError(
        "BrowserType.launch: Executable doesn't exist at "
        "~/Library/Caches/ms-playwright/chromium_headless_shell-1208/"
        "chrome-headless-shell"
    )
    _patch_sync_playwright(monkeypatch, str(binary), launch_error=launch_error)

    ok, message = check_playwright_chromium()

    assert ok is False
    # The raised launch error is surfaced verbatim, plus the fix + GC gotcha.
    assert "Executable doesn't exist" in message
    assert PLAYWRIGHT_INSTALL_COMMAND in message
    assert PLAYWRIGHT_WORKTREE_GC_WARNING in message


def test_check_reports_failure_when_driver_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom() -> _FakeSyncPlaywrightContext:
        raise RuntimeError("Executable doesn't exist")

    monkeypatch.setattr("playwright.sync_api.sync_playwright", _boom)

    ok, message = check_playwright_chromium()

    assert ok is False
    assert "Executable doesn't exist" in message
    assert PLAYWRIGHT_INSTALL_COMMAND in message
    assert PLAYWRIGHT_WORKTREE_GC_WARNING in message


@pytest.mark.parametrize("failure", ["missing", "launch"])
def test_bundled_preflight_uses_jobctrl_repair_without_uv_guidance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failure: str
) -> None:
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_PAYLOAD_DIR", str(tmp_path / "payload"))
    if failure == "missing":
        _patch_sync_playwright(monkeypatch, str(tmp_path / "missing-chromium"))
    else:
        binary = tmp_path / "chromium"
        binary.write_bytes(b"#!/bin/sh\n")
        _patch_sync_playwright(monkeypatch, str(binary), launch_error=RuntimeError("headless shell missing"))

    ok, message = check_playwright_chromium()

    assert ok is False
    assert BUNDLED_PLAYWRIGHT_REMEDIATION in message
    assert PLAYWRIGHT_INSTALL_COMMAND not in message
    assert PLAYWRIGHT_WORKTREE_GC_WARNING not in message


# --- worker startup gate -------------------------------------------------------


def test_worker_gate_raises_when_browser_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JOBCTRL_SKIP_BROWSER_PREFLIGHT", raising=False)
    monkeypatch.setattr(_CHECK_TARGET, lambda: (False, "boom"))

    with pytest.raises(typer.Exit) as excinfo:
        cli._preflight_browsers_or_exit()

    assert excinfo.value.exit_code == 1


def test_worker_gate_passes_when_browser_available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JOBCTRL_SKIP_BROWSER_PREFLIGHT", raising=False)
    monkeypatch.setattr(_CHECK_TARGET, lambda: (True, "ok"))

    # Should not raise.
    cli._preflight_browsers_or_exit()


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_worker_gate_skipped_by_escape_hatch(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("JOBCTRL_SKIP_BROWSER_PREFLIGHT", value)

    def _must_not_run() -> tuple[bool, str]:
        raise AssertionError("preflight must not run when the escape hatch is set")

    monkeypatch.setattr(_CHECK_TARGET, _must_not_run)

    # Escape hatch returns before the check is consulted.
    cli._preflight_browsers_or_exit()


def test_worker_command_aborts_before_temporal_when_browser_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The gate runs after bootstrap but before any Temporal connection."""
    monkeypatch.delenv("JOBCTRL_SKIP_BROWSER_PREFLIGHT", raising=False)
    monkeypatch.setattr(
        _CHECK_TARGET,
        lambda: (False, "Playwright Chromium binary is missing at /nope"),
    )

    result = CliRunner().invoke(cli.app, ["worker"])

    assert result.exit_code == 1, result.output
    # Rich may soft-wrap; collapse whitespace before asserting.
    normalized = " ".join(result.output.split())
    assert "Worker preflight failed" in normalized
    assert "JOBCTRL_SKIP_BROWSER_PREFLIGHT=1" in normalized
