"""Driven ports for the Apply Automation context.

See ddd-target.md §5.6 (``BrowserPort``, ``AutonomousAgentPort``,
``ApplyRunRepository``, seam justification).

These ports isolate the two heaviest infrastructure dependencies in
the worker: the Chrome browser lifecycle and the Claude apply runtime
subprocess. Local-mode adapters wrap the existing ``apply/chrome.py``
and ``apply/launcher.py`` subprocess code; cloud-mode adapters can
swap to Browserbase / direct Anthropic API without the use cases
needing to know.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Protocol

from jobhunter.domain.apply.aggregate import ApplyRun
from jobhunter.domain.apply.value_objects import (
    ApplyPrompt,
    ApplyRunId,
    BrowserWorkerConfig,
    SubmissionResult,
    TokenUsage,
)
from jobhunter.domain.tenant import TenantId


__all__ = [
    "AgentResult",
    "ApplyRunRepository",
    "AutonomousAgentPort",
    "BrowserPort",
    "BrowserSession",
    "EmailApplicationCandidate",
    "EmailApplicationSenderPort",
    "EmailApplicationSendResult",
]


# ---------------------------------------------------------------------------
# BrowserSession (value object returned by BrowserPort.launch)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BrowserSession:
    """The handle returned by ``BrowserPort.launch``.

    Carries the connection metadata the autonomous agent needs to
    drive the browser (CDP port + isolated user-data dir) plus
    bookkeeping fields the saga needs for cleanup (PID, worker_dir).
    The opaque ``handle`` field is the underlying adapter object — for
    the local Chrome adapter it's the ``subprocess.Popen``; cloud
    adapters keep their own session token here. Use cases never read
    it; only the matching adapter does.
    """

    config: BrowserWorkerConfig
    pid: int | None = None
    worker_dir: str | None = None
    handle: Any | None = None
    dry_run_evidence: Callable[[], Mapping[str, Any]] | None = None

    @property
    def cdp_port(self) -> int:
        return self.config.cdp_port

    @property
    def worker_id(self) -> int:
        return self.config.worker_id


# ---------------------------------------------------------------------------
# BrowserPort
# ---------------------------------------------------------------------------


class BrowserPort(Protocol):
    """Driven port: manage the browser lifecycle for one apply run.

    ``launch`` opens a fresh browser session with isolated CDP +
    user-data dir; ``cleanup`` tears the session down. Adapters MUST
    make ``cleanup`` idempotent (the saga calls it from a ``finally``
    block whether or not ``launch`` succeeded).
    """

    def launch(self, config: BrowserWorkerConfig) -> BrowserSession:
        """Launch the browser and return a connected session.

        Raises an implementation-specific exception on launch failure
        so the saga can route to the ``BrowserFailed`` compensation
        branch.
        """
        ...

    def cleanup(self, session: BrowserSession) -> None:
        """Tear down a browser session.

        Idempotent: callers always invoke this in a ``finally`` block,
        possibly after ``launch`` already failed. Adapters MUST tolerate
        a session whose underlying handle is already dead.
        """
        ...


# ---------------------------------------------------------------------------
# AutonomousAgentPort
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentResult:
    """The structured outcome of one autonomous agent run.

    Returned by ``AutonomousAgentPort.submit_application``. The
    ``submission_result`` carries the §4.6 discriminated-union variant
    that drives ``ApplyRun.complete``. ``events`` is the timeline the
    agent emitted (one ``ApplyRunEvent`` per logical step); the use
    case folds them into the aggregate via ``record_event``. The
    ``raw_output`` field is the full unparsed agent output, kept on
    the result so debug logs can reconstruct exactly what the agent
    said.
    """

    submission_result: SubmissionResult
    token_usage: TokenUsage | None = None
    duration_ms: int | None = None
    events: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    raw_output: str = ""


class AutonomousAgentPort(Protocol):
    """Driven port: run one autonomous agent against an open browser session.

    The local adapter spawns the resolved Claude runtime with the MCP
    config rendered to disk; the cloud adapter calls the Anthropic
    API directly with tool use. Both produce the same ``AgentResult``
    shape so the use case is portable.
    """

    def submit_application(
        self,
        *,
        prompt: ApplyPrompt,
        browser: BrowserSession,
        model: str,
        dry_run: bool = False,
        timeout_seconds: int | None = None,
    ) -> AgentResult:
        """Run the agent against ``browser`` with ``prompt`` and return its outcome.

        Raises ``TimeoutError`` if ``timeout_seconds`` is exceeded;
        the saga routes timeouts to the ``Failed(retryable=True)``
        terminal state via the process manager.
        """
        ...


@dataclass(frozen=True)
class EmailApplicationCandidate:
    """Owned email application preview approved before any send."""

    recipient_email: str
    subject: str
    body: str
    attachment_artifact_id: str
    attachment_name: str
    attachment_path: str


@dataclass(frozen=True)
class EmailApplicationSendResult:
    """Provider metadata returned after an owned email application send."""

    provider: str = "gmail"
    message_id: str = ""
    thread_id: str = ""


class EmailApplicationSenderPort(Protocol):
    """Driven port: send an approved email application outside the agent."""

    def send_email_application(self, candidate: EmailApplicationCandidate) -> EmailApplicationSendResult:
        """Send the approved candidate and return provider metadata."""
        ...


# ---------------------------------------------------------------------------
# ApplyRunRepository
# ---------------------------------------------------------------------------


class ApplyRunRepository(Protocol):
    """Persistence port for the ``ApplyRun`` aggregate.

    All methods are tenant-scoped. ``save`` is an upsert keyed on
    ``(tenant_id, run_id)`` — saving a previously stored aggregate
    overwrites it (event order + lifecycle progression encode
    versioning inside the aggregate, not at the row level).
    ``list_active`` returns the in-flight runs (status in
    {starting, in_progress}) so the orchestrator can enforce the
    §4.6 "at most one in_progress per JobId" invariant before
    starting a new run.
    """

    def load(self, tenant_id: TenantId, run_id: ApplyRunId) -> ApplyRun | None:
        """Return the persisted aggregate or ``None``."""
        ...

    def save(self, run: ApplyRun) -> None:
        """Upsert the aggregate (and its events)."""
        ...

    def list_recent(
        self, tenant_id: TenantId, *, limit: int = 50
    ) -> list[ApplyRun]:
        """Return the newest aggregates ordered by ``started_at`` DESC."""
        ...

    def list_active(self, tenant_id: TenantId) -> list[ApplyRun]:
        """Return aggregates whose status is ``starting`` or ``in_progress``."""
        ...
