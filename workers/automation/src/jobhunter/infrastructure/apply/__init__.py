"""Apply Automation infrastructure adapters.

See ddd-target.md §5.6. Local-mode adapters live here:

    ``LocalChromeAdapter``        — wraps ``apply/chrome.py`` Chrome
                                     lifecycle behind ``BrowserPort``.
    ``ClaudeCodeCliAdapter``      — wraps the ``claude`` subprocess
                                     behind ``AutonomousAgentPort``.
    ``SqliteApplyRunRepository``  — round-trips ``ApplyRun`` aggregates
                                     against the existing ``apply_runs``
                                     + ``apply_run_events`` tables.
"""

from jobhunter.infrastructure.apply.claude_code_cli import ClaudeCodeCliAdapter
from jobhunter.infrastructure.apply.local_chrome import LocalChromeAdapter
from jobhunter.infrastructure.apply.sqlite_apply_run_repository import (
    SqliteApplyRunRepository,
)

__all__ = [
    "ClaudeCodeCliAdapter",
    "LocalChromeAdapter",
    "SqliteApplyRunRepository",
]
