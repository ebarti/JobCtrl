"""ApplyRun aggregate root.

See ddd-target.md §4.6. ``ApplyRun`` is the canonical fact about one
autonomous job-application attempt for a single ``(TenantId, JobId)``
pair, identified by ``(TenantId, ApplyRunId)``. It owns a list of
``ApplyRunEvent`` child entities and transitions through the seven-state
lifecycle from §4.6:

    ``starting → in_progress``
    ``in_progress → succeeded | failed | captcha | login_issue |``
    ``                expired | manual | dry_run_complete``

Invariants enforced here:

  * ``ApplyRun`` references a valid ``JobId`` (non-empty string).
  * The aggregate identity ``(tenant_id, run_id)`` is the repository
    primary key — concurrent ``in_progress`` runs for the same
    ``JobId`` are prevented at the orchestrator boundary (see
    ``ApplyRunRepository.list_active``).
  * A ``DryRunComplete`` result MUST coincide with ``dry_run = True``
    (per §4.6: dry runs never mark the job applied).
  * Once a terminal state is reached, the result must be set and the
    matching ``SubmissionResult`` variant must agree with the status
    enum.
  * ``TokenUsage`` is recorded by the orchestrator before transitioning
    to a terminal state (allowed to be ``None`` only when the agent
    crashed before producing a result message).
  * Event numbering is monotonic 1..N per aggregate (the aggregate
    assigns ``event_id`` in ``record_event``).

The aggregate is immutable; lifecycle helpers return new instances via
``dataclasses.replace``.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping

from jobctrl.domain.apply.entities import ApplyRunEvent
from jobctrl.domain.apply.value_objects import (
    Applied,
    ApplyRunId,
    Captcha,
    DryRunComplete,
    Expired,
    Failed,
    LoginIssue,
    Manual,
    SubmissionResult,
    SUBMISSION_RESULT_TYPES,
    TokenUsage,
    submission_result_kind,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import TenantId


class ApplyRunStatus:
    """Pseudo-enum of the eight aggregate-level states from §4.6.

    Implemented as bare string constants so the projection layer can
    round-trip through the ``apply_run_projections.status`` TEXT column
    without an extra converter.
    """

    STARTING = "starting"
    IN_PROGRESS = "in_progress"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CAPTCHA = "captcha"
    LOGIN_ISSUE = "login_issue"
    EXPIRED = "expired"
    MANUAL = "manual"
    DRY_RUN_COMPLETE = "dry_run_complete"


_VALID_STATUSES: frozenset[str] = frozenset(
    {
        ApplyRunStatus.STARTING,
        ApplyRunStatus.IN_PROGRESS,
        ApplyRunStatus.SUCCEEDED,
        ApplyRunStatus.FAILED,
        ApplyRunStatus.CAPTCHA,
        ApplyRunStatus.LOGIN_ISSUE,
        ApplyRunStatus.EXPIRED,
        ApplyRunStatus.MANUAL,
        ApplyRunStatus.DRY_RUN_COMPLETE,
    }
)

# Terminal states (no further transitions allowed).
_TERMINAL_STATUSES: frozenset[str] = frozenset(
    {
        ApplyRunStatus.SUCCEEDED,
        ApplyRunStatus.FAILED,
        ApplyRunStatus.CAPTCHA,
        ApplyRunStatus.LOGIN_ISSUE,
        ApplyRunStatus.EXPIRED,
        ApplyRunStatus.MANUAL,
        ApplyRunStatus.DRY_RUN_COMPLETE,
    }
)

# Mapping from SubmissionResult kind to terminal ApplyRunStatus.
_KIND_TO_STATUS: dict[str, str] = {
    "applied": ApplyRunStatus.SUCCEEDED,
    "failed": ApplyRunStatus.FAILED,
    "captcha": ApplyRunStatus.CAPTCHA,
    "login_issue": ApplyRunStatus.LOGIN_ISSUE,
    "expired": ApplyRunStatus.EXPIRED,
    "manual": ApplyRunStatus.MANUAL,
    "email_only": ApplyRunStatus.MANUAL,
    "dry_run_complete": ApplyRunStatus.DRY_RUN_COMPLETE,
}


@dataclass(frozen=True)
class ApplyRun:
    """Aggregate root for one autonomous apply attempt.

    Identity: ``(tenant_id, run_id)``. The repository keys on the
    same pair so each run row is uniquely addressable; the
    ``ApplyRunRepository.list_active`` selector enforces the §4.6
    "at most one in_progress per JobId" invariant at the
    application-service boundary (the aggregate cannot enforce it
    on its own because it has no knowledge of sibling runs).
    """

    tenant_id: TenantId
    run_id: ApplyRunId
    job_id: JobId
    status: str = ApplyRunStatus.STARTING
    started_at: str = ""
    finished_at: str | None = None
    submission_result: SubmissionResult | None = None
    events: tuple[ApplyRunEvent, ...] = field(default_factory=tuple)
    token_usage: TokenUsage | None = None
    dry_run: bool = False
    headless: bool = False
    attempts: int = 1
    model: str | None = None
    worker_id: int | None = None
    duration_ms: int | None = None

    # ------------------------------------------------------------------
    # Invariants
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:
        if not isinstance(self.run_id, str) or not str(self.run_id).strip():
            raise ValueError("ApplyRun.run_id must be a non-empty string")
        if not isinstance(self.job_id, str) or not str(self.job_id).strip():
            raise ValueError("ApplyRun.job_id must be a non-empty string")
        if self.status not in _VALID_STATUSES:
            raise ValueError(
                f"ApplyRun.status must be one of {sorted(_VALID_STATUSES)!r}, "
                f"got {self.status!r}"
            )
        if not isinstance(self.events, tuple):
            raise ValueError("ApplyRun.events must be a tuple")
        if not isinstance(self.dry_run, bool):
            raise ValueError("ApplyRun.dry_run must be a bool")
        if not isinstance(self.headless, bool):
            raise ValueError("ApplyRun.headless must be a bool")
        if not isinstance(self.attempts, int) or self.attempts <= 0:
            raise ValueError("ApplyRun.attempts must be a positive int")
        if (
            self.submission_result is not None
            and not isinstance(self.submission_result, SUBMISSION_RESULT_TYPES)
        ):
            raise ValueError(
                "ApplyRun.submission_result must be a SubmissionResult variant or None"
            )

        # Event numbering is monotonic 1..N per aggregate.
        for index, event in enumerate(self.events, start=1):
            if event.event_id != index:
                raise ValueError(
                    "ApplyRun.events must be numbered 1..N, "
                    f"position {index} has event_id={event.event_id}"
                )

        # Terminal-state coherence.
        if self.is_terminal:
            if self.submission_result is None:
                raise ValueError(
                    "ApplyRun.submission_result must be set when status is terminal"
                )
            expected_status = _KIND_TO_STATUS[
                submission_result_kind(self.submission_result)
            ]
            if expected_status != self.status:
                raise ValueError(
                    f"ApplyRun.status {self.status!r} does not match "
                    f"submission_result kind {submission_result_kind(self.submission_result)!r} "
                    f"(expected {expected_status!r})"
                )
            if self.finished_at is None or not self.finished_at.strip():
                raise ValueError(
                    "ApplyRun.finished_at must be set when status is terminal"
                )

        # Dry-run invariant: a successful "applied" result is forbidden
        # on a dry-run aggregate (per §4.6).
        if self.dry_run and isinstance(self.submission_result, Applied):
            raise ValueError(
                "ApplyRun.dry_run is True but submission_result is Applied — "
                "dry runs must never mark a job applied"
            )

        # Conversely a non-dry-run cannot end in DryRunComplete.
        if (
            not self.dry_run
            and isinstance(self.submission_result, DryRunComplete)
        ):
            raise ValueError(
                "ApplyRun.dry_run is False but submission_result is DryRunComplete; "
                "set dry_run=True for dry-run aggregates"
            )

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def start(
        cls,
        *,
        tenant_id: TenantId,
        run_id: ApplyRunId,
        job_id: JobId,
        started_at: str,
        worker_id: int | None = None,
        model: str | None = None,
        dry_run: bool = False,
        headless: bool = False,
        attempts: int = 1,
    ) -> "ApplyRun":
        """Create a fresh aggregate in the ``starting`` state."""
        if not isinstance(started_at, str) or not started_at.strip():
            raise ValueError("ApplyRun.start: started_at must be a non-empty string")
        return cls(
            tenant_id=tenant_id,
            run_id=run_id,
            job_id=job_id,
            status=ApplyRunStatus.STARTING,
            started_at=started_at,
            finished_at=None,
            submission_result=None,
            events=(),
            token_usage=None,
            dry_run=dry_run,
            headless=headless,
            attempts=attempts,
            model=model,
            worker_id=worker_id,
            duration_ms=None,
        )

    # ------------------------------------------------------------------
    # Lifecycle transitions
    # ------------------------------------------------------------------

    def transition_to_in_progress(
        self,
        *,
        worker_id: int | None = None,
    ) -> "ApplyRun":
        """Transition starting → in_progress.

        Called once Chrome and Claude Code are both up and the agent
        is producing output. Optionally records the worker_id (when
        the launcher allocated it lazily).
        """
        if self.status != ApplyRunStatus.STARTING:
            raise ValueError(
                "ApplyRun.transition_to_in_progress: aggregate must be in starting "
                f"state, got {self.status!r}"
            )
        return replace(
            self,
            status=ApplyRunStatus.IN_PROGRESS,
            worker_id=worker_id if worker_id is not None else self.worker_id,
        )

    def record_event(
        self,
        *,
        event_type: str,
        occurred_at: str,
        level: str = "info",
        message: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> "ApplyRun":
        """Append a new ``ApplyRunEvent`` to the timeline.

        The aggregate assigns the next monotonic ``event_id``.
        Returns a new aggregate instance with the event appended.
        """
        next_id = len(self.events) + 1
        event = ApplyRunEvent(
            event_id=next_id,
            event_type=event_type,
            level=level,
            message=message,
            payload=dict(payload) if payload is not None else {},
            occurred_at=occurred_at,
        )
        return replace(self, events=self.events + (event,))

    def complete(
        self,
        *,
        result: SubmissionResult,
        finished_at: str,
        token_usage: TokenUsage | None = None,
        duration_ms: int | None = None,
    ) -> "ApplyRun":
        """Transition to a terminal state with the given submission result.

        The new status is derived from the ``SubmissionResult`` variant.
        Once complete the aggregate is immutable; subsequent transition
        attempts will raise.
        """
        if self.is_terminal:
            raise ValueError(
                f"ApplyRun.complete: already in terminal state {self.status!r}"
            )
        if not isinstance(result, SUBMISSION_RESULT_TYPES):
            raise ValueError(
                "ApplyRun.complete: result must be a SubmissionResult variant"
            )
        new_status = _KIND_TO_STATUS[submission_result_kind(result)]
        return replace(
            self,
            status=new_status,
            submission_result=result,
            finished_at=finished_at,
            token_usage=token_usage if token_usage is not None else self.token_usage,
            duration_ms=duration_ms if duration_ms is not None else self.duration_ms,
        )

    # ------------------------------------------------------------------
    # Predicates
    # ------------------------------------------------------------------

    @property
    def is_starting(self) -> bool:
        return self.status == ApplyRunStatus.STARTING

    @property
    def is_in_progress(self) -> bool:
        return self.status == ApplyRunStatus.IN_PROGRESS

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_STATUSES

    @property
    def is_succeeded(self) -> bool:
        return self.status == ApplyRunStatus.SUCCEEDED

    @property
    def is_failed(self) -> bool:
        return self.status == ApplyRunStatus.FAILED

    @property
    def event_count(self) -> int:
        return len(self.events)

    @property
    def last_event(self) -> ApplyRunEvent | None:
        return self.events[-1] if self.events else None

    # ------------------------------------------------------------------
    # Serialisation (used by the SQLite adapter)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-friendly dict representation."""
        return {
            "tenant_id": str(self.tenant_id),
            "run_id": str(self.run_id),
            "job_id": str(self.job_id),
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "submission_result": (
                _result_to_dict(self.submission_result)
                if self.submission_result is not None
                else None
            ),
            "events": [event.to_dict() for event in self.events],
            "token_usage": (
                {
                    "input": self.token_usage.input,
                    "output": self.token_usage.output,
                    "cache_read": self.token_usage.cache_read,
                    "cache_create": self.token_usage.cache_create,
                    "cost_usd": self.token_usage.cost_usd,
                }
                if self.token_usage is not None
                else None
            ),
            "dry_run": self.dry_run,
            "headless": self.headless,
            "attempts": self.attempts,
            "model": self.model,
            "worker_id": self.worker_id,
            "duration_ms": self.duration_ms,
        }


def _result_to_dict(result: SubmissionResult) -> dict[str, Any]:
    """Serialise a ``SubmissionResult`` variant to a dict.

    The ``kind`` discriminator is always present; the remaining fields
    are variant-specific. ``submission_result_from_dict`` consumes this
    payload to reconstruct the variant on load.
    """
    kind = submission_result_kind(result)
    payload: dict[str, Any] = {"kind": kind}
    if isinstance(result, Applied):
        payload["applied_at"] = result.applied_at
        payload["verification_confidence"] = result.verification_confidence
    elif isinstance(result, Failed):
        payload["error"] = result.error
        payload["retryable"] = result.retryable
    elif isinstance(result, Captcha):
        payload["details"] = result.details
    elif isinstance(result, LoginIssue):
        payload["details"] = result.details
    elif isinstance(result, Manual):
        payload["reason"] = result.reason
    elif isinstance(result, DryRunComplete):
        payload["navigated_to"] = result.navigated_to
        payload["coverage"] = result.coverage
        payload["blocked_channels"] = list(result.blocked_channels)
    elif isinstance(result, Expired):
        pass  # No additional fields.
    return payload


def submission_result_from_dict(data: Mapping[str, Any]) -> SubmissionResult:
    """Reconstruct a ``SubmissionResult`` variant from its dict payload."""
    kind = data.get("kind")
    if kind == "applied":
        return Applied(
            applied_at=str(data.get("applied_at", "")),
            verification_confidence=float(data.get("verification_confidence", 0.0)),
        )
    if kind == "failed":
        return Failed(
            error=str(data.get("error", "")),
            retryable=bool(data.get("retryable", True)),
        )
    if kind == "captcha":
        return Captcha(details=str(data.get("details", "")))
    if kind == "login_issue":
        return LoginIssue(details=str(data.get("details", "")))
    if kind == "expired":
        return Expired()
    if kind == "manual":
        return Manual(reason=str(data.get("reason", "")))
    if kind == "dry_run_complete":
        blocked_channels = data.get("blocked_channels") or ()
        if isinstance(blocked_channels, list):
            blocked_channels = tuple(str(channel) for channel in blocked_channels)
        elif not isinstance(blocked_channels, tuple):
            blocked_channels = (str(blocked_channels),) if blocked_channels else ()
        return DryRunComplete(
            navigated_to=str(data.get("navigated_to", "")),
            coverage=str(data.get("coverage") or "full"),
            blocked_channels=blocked_channels,
        )
    raise ValueError(f"Unknown SubmissionResult kind: {kind!r}")
