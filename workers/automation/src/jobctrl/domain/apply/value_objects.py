"""Apply Automation value objects.

See ddd-target.md §4.6. Every value object is a frozen dataclass; the
constructors enforce simple invariants up front so the aggregate can
trust them.

Value objects defined here:

  ``ApplyRunId``         — opaque UUID identity for one ``ApplyRun``.
                           Wrapped via ``NewType`` for type-safety; the
                           underlying string is the stable wire format.
  ``BrowserWorkerConfig`` — Chrome worker bookkeeping (worker_id,
                           cdp_port, headless flag, user_data_dir).
  ``ApplyPrompt``        — autonomous-agent input bundle (prompt text +
                           MCP config payload).
  ``TokenUsage``         — Claude Code token + cost telemetry recorded
                           on completion.
  ``SubmissionResult``   — discriminated union with seven variants per
                           §4.6: ``Applied``, ``Failed``, ``Captcha``,
                           ``LoginIssue``, ``Expired``, ``Manual``,
                           ``DryRunComplete``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping, NewType, Union


# ---------------------------------------------------------------------------
# ApplyRunId
# ---------------------------------------------------------------------------

ApplyRunId = NewType("ApplyRunId", str)


def new_apply_run_id() -> ApplyRunId:
    """Generate a fresh random ``ApplyRunId`` (UUID4 hex)."""
    return ApplyRunId(uuid.uuid4().hex)


# ---------------------------------------------------------------------------
# BrowserWorkerConfig
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BrowserWorkerConfig:
    """Bookkeeping for a browser worker slot.

    ``cdp_port`` is the Chrome DevTools Protocol port the agent will
    connect to. ``user_data_dir`` is the worker-isolated profile
    directory (so multiple workers do not stomp on each other's
    cookies). The local adapter resolves these from the legacy
    ``BASE_CDP_PORT + worker_id`` / ``CHROME_WORKER_DIR / worker-N``
    convention; cloud adapters can override with managed-session
    metadata.
    """

    worker_id: int
    cdp_port: int
    headless: bool = False
    user_data_dir: str | None = None
    dry_run: bool = False
    approved_application_url: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.worker_id, int) or self.worker_id < 0:
            raise ValueError(
                "BrowserWorkerConfig.worker_id must be a non-negative int"
            )
        if not isinstance(self.cdp_port, int) or self.cdp_port <= 0:
            raise ValueError(
                "BrowserWorkerConfig.cdp_port must be a positive int"
            )
        if not isinstance(self.headless, bool):
            raise ValueError("BrowserWorkerConfig.headless must be a bool")
        if not isinstance(self.dry_run, bool):
            raise ValueError("BrowserWorkerConfig.dry_run must be a bool")
        if not isinstance(self.approved_application_url, str):
            raise ValueError(
                "BrowserWorkerConfig.approved_application_url must be a string"
            )


# ---------------------------------------------------------------------------
# ApplyPrompt
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApplyPrompt:
    """The rendered autonomous-agent prompt bundle.

    ``text`` is the full instruction string handed to ``claude -p``.
    ``mcp_config`` is the MCP server descriptor (Playwright + Gmail in
    local mode); the adapter writes it to a per-worker JSON file before
    spawning the subprocess.
    """

    text: str
    mcp_config: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("ApplyPrompt.text must be a non-empty string")
        if not isinstance(self.mcp_config, Mapping):
            raise ValueError("ApplyPrompt.mcp_config must be a Mapping")

    @property
    def char_count(self) -> int:
        return len(self.text)


# ---------------------------------------------------------------------------
# TokenUsage
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TokenUsage:
    """Claude Code usage telemetry recorded on completion."""

    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_create: int = 0
    cost_usd: float = 0.0

    def __post_init__(self) -> None:
        for field_name in ("input", "output", "cache_read", "cache_create"):
            value = getattr(self, field_name)
            if not isinstance(value, int) or value < 0:
                raise ValueError(
                    f"TokenUsage.{field_name} must be a non-negative int"
                )
        if not isinstance(self.cost_usd, (int, float)) or self.cost_usd < 0:
            raise ValueError("TokenUsage.cost_usd must be a non-negative number")


# ---------------------------------------------------------------------------
# SubmissionResult — discriminated union (§4.6)
# ---------------------------------------------------------------------------
#
# Each variant carries a ``kind`` literal so callers can pattern-match
# without isinstance checks. The variants are intentionally distinct
# dataclasses (rather than a single tagged dict) so the type checker can
# flag malformed combinations at construction time.


@dataclass(frozen=True)
class Applied:
    """Variant: application successfully submitted."""

    kind: str = field(default="applied", init=False)
    applied_at: str = ""
    verification_confidence: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.applied_at, str) or not self.applied_at.strip():
            raise ValueError("Applied.applied_at must be a non-empty ISO timestamp")
        if not isinstance(self.verification_confidence, (int, float)):
            raise ValueError("Applied.verification_confidence must be numeric")
        if not 0.0 <= float(self.verification_confidence) <= 1.0:
            raise ValueError(
                "Applied.verification_confidence must be in [0.0, 1.0]"
            )


@dataclass(frozen=True)
class Failed:
    """Variant: submission failed (network, validation, agent error, ...)."""

    kind: str = field(default="failed", init=False)
    error: str = ""
    retryable: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.error, str) or not self.error.strip():
            raise ValueError("Failed.error must be a non-empty string")
        if not isinstance(self.retryable, bool):
            raise ValueError("Failed.retryable must be a bool")


@dataclass(frozen=True)
class Captcha:
    """Variant: blocked by a CAPTCHA the agent could not solve."""

    kind: str = field(default="captcha", init=False)
    details: str = ""


@dataclass(frozen=True)
class LoginIssue:
    """Variant: login required and credentials/account flow failed."""

    kind: str = field(default="login_issue", init=False)
    details: str = ""


@dataclass(frozen=True)
class Expired:
    """Variant: job posting is no longer available."""

    kind: str = field(default="expired", init=False)


@dataclass(frozen=True)
class Manual:
    """Variant: ATS requires manual steps (e.g. 1Password login)."""

    kind: str = field(default="manual", init=False)
    reason: str = ""


@dataclass(frozen=True)
class EmailOnlyApplication:
    """Variant: the agent detected an email-only application address."""

    kind: str = field(default="email_only", init=False)
    recipient_email: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.recipient_email, str) or "@" not in self.recipient_email:
            raise ValueError("EmailOnlyApplication.recipient_email must be an email address")


@dataclass(frozen=True)
class DryRunComplete:
    """Variant: dry run finished without submitting (per §4.6 invariant)."""

    kind: str = field(default="dry_run_complete", init=False)
    navigated_to: str = ""
    coverage: str = "full"
    blocked_channels: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.coverage not in {"full", "partial"}:
            raise ValueError("DryRunComplete.coverage must be 'full' or 'partial'")
        if isinstance(self.blocked_channels, str):
            object.__setattr__(self, "blocked_channels", (self.blocked_channels,))
        elif not isinstance(self.blocked_channels, tuple):
            object.__setattr__(
                self,
                "blocked_channels",
                tuple(str(channel) for channel in self.blocked_channels),
            )
        for channel in self.blocked_channels:
            if not isinstance(channel, str):
                raise ValueError("DryRunComplete.blocked_channels must contain strings")


SubmissionResult = Union[
    Applied,
    Failed,
    Captcha,
    LoginIssue,
    Expired,
    Manual,
    EmailOnlyApplication,
    DryRunComplete,
]


# Alias every variant into a single set so ``isinstance`` checks read
# cleanly elsewhere without listing all seven types.
SUBMISSION_RESULT_TYPES: tuple[type, ...] = (
    Applied,
    Failed,
    Captcha,
    LoginIssue,
    Expired,
    Manual,
    EmailOnlyApplication,
    DryRunComplete,
)


def submission_result_kind(result: SubmissionResult) -> str:
    """Return the ``kind`` literal for a ``SubmissionResult`` variant."""
    return getattr(result, "kind")


__all__ = [
    "Applied",
    "ApplyPrompt",
    "ApplyRunId",
    "BrowserWorkerConfig",
    "Captcha",
    "DryRunComplete",
    "EmailOnlyApplication",
    "Expired",
    "Failed",
    "LoginIssue",
    "Manual",
    "SUBMISSION_RESULT_TYPES",
    "SubmissionResult",
    "TokenUsage",
    "new_apply_run_id",
    "submission_result_kind",
]


# The launcher's approval-gate refusal vocabulary. Pinned cross-runtime to
# packages/domain-types/test/fixtures/apply_approval_gate_reasons.json (the
# TypeScript source is APPLY_REVIEW_APPROVAL_GATE_REASONS in
# packages/contracts); tests/test_apply_approval_vocabulary.py enforces that
# every literal _approval_refusal_reason can return stays inside this set.
APPROVAL_GATE_REFUSAL_REASONS: frozenset[str] = frozenset(
    {
        "awaiting_approval",
        "awaiting_dry_run",
        "approval_stale_materials",
        "approval_stale_profile",
        "approval_stale_url",
        "approval_stale_email_candidate",
        "override_evidence_invalid",
    }
)
