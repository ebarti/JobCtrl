"""In-process native transport seam for tests that replace the Apply runner.

This does not certify native completion. Real native/Temporal composition owns
that proof in tests/helpers/apply_execution_temporal.py and the Go fixture.
"""
from __future__ import annotations

import pytest

from jobctrl.apply import execution, launcher, ownership


class InProcessApplyExecution:
    def __init__(self):
        self.owner = ownership.ApplyLauncherRun()

    def run(self, options):
        from jobctrl import browser_capabilities
        browser_capabilities.require_system_browser_capability("auto-apply-browser")
        options = dict(options)
        options.pop("poll_interval")
        return launcher.main(**options, install_signal_handlers=False, launcher_run=self.owner)

    def cancel(self):
        self.owner.cancel()


@pytest.fixture(autouse=True)
def in_process_apply_execution(monkeypatch):
    monkeypatch.setattr(execution, "ScopedApplyExecution", InProcessApplyExecution)
