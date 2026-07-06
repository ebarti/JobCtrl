"""Apply Automation infrastructure adapters.

See ddd-target.md §5.6. Local-mode adapters live here:

    ``LocalChromeAdapter``        — wraps ``apply/chrome.py`` Chrome
                                     lifecycle behind ``BrowserPort``.
    ``ClaudeCodeCliAdapter``      — wraps the ``claude`` subprocess
                                     behind ``AutonomousAgentPort``.

PR 4 of the Temporal stack removed the ``SqliteApplyRunRepository``;
``apply_run_projections`` (sourced from ``job_events``) is now the
canonical apply lifecycle row.
"""

from jobhunter.infrastructure.apply.claude_code_cli import ClaudeCodeCliAdapter
from jobhunter.infrastructure.apply.email_sender import GmailEmailApplicationSender
from jobhunter.infrastructure.apply.local_chrome import LocalChromeAdapter

__all__ = [
    "ClaudeCodeCliAdapter",
    "GmailEmailApplicationSender",
    "LocalChromeAdapter",
]
