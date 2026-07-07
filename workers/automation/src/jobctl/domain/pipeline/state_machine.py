"""StageStateMachine — pure function implementing the 16-transition table (ddd-target.md S8.5).

No I/O, no DB, no event publishing. Given a current StageState and a
StageTransition trigger, returns the new StageState or a TransitionRejected error.

Callers decide what to do with the result (publish events, persist, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto
from typing import Callable

from jobctl.domain.pipeline_types import (
    Blocked,
    Canceled,
    Exhausted,
    Failed,
    Pending,
    Queued,
    Running,
    Skipped,
    Stale,
    StageState,
    Succeeded,
)


class StageTransition(Enum):
    """Triggers that drive state machine transitions."""

    Enqueue = auto()
    Start = auto()
    Complete = auto()
    Fail = auto()
    Block = auto()
    Skip = auto()
    Reset = auto()
    Cancel = auto()
    Exhaust = auto()
    Unblock = auto()
    MarkStale = auto()


@dataclass(frozen=True)
class TransitionRejected:
    """Returned when a transition is not allowed from the current state."""

    current_state: StageState
    attempted_transition: StageTransition
    reason: str


TransitionResult = StageState | TransitionRejected


def transition(current: StageState, trigger: StageTransition, **kwargs) -> TransitionResult:
    """Apply a state transition.  Pure function — no side effects.

    Keyword arguments are forwarded to the resulting StageState constructor
    (e.g. ``error_code``, ``reason``, ``blocked_by``).

    Returns the new StageState on success, or TransitionRejected on failure.
    """
    handler = _HANDLERS.get((current.kind, trigger))
    if handler is None:
        return TransitionRejected(
            current_state=current,
            attempted_transition=trigger,
            reason=f"Transition {trigger.name} is not allowed from {current.kind}",
        )
    return handler(current, **kwargs)


# ---------------------------------------------------------------------------
# Transition handlers — one per row of the S8.5 table
# ---------------------------------------------------------------------------


def _pending_to_queued(current: Pending, **kwargs) -> Queued:
    return Queued(queued_at=kwargs.get("queued_at", ""))


def _pending_to_running(current: Pending, **kwargs) -> Running:
    return Running(
        attempt_count=current.attempt_count + 1,
        started_at=kwargs.get("started_at", ""),
    )


def _pending_to_blocked(current: Pending, **kwargs) -> Blocked:
    return Blocked(
        blocked_by=kwargs.get("blocked_by", ()),
        error_code=kwargs.get("error_code", "BLOCKED_UPSTREAM"),
        error_message=kwargs.get("error_message", ""),
    )


def _pending_to_skipped(current: Pending, **kwargs) -> Skipped:
    return Skipped(reason=kwargs.get("reason", ""))


def _queued_to_running(current: Queued, **kwargs) -> Running:
    return Running(
        attempt_count=kwargs.get("attempt_count", 1),
        started_at=kwargs.get("started_at", ""),
    )


def _queued_to_canceled(current: Queued, **kwargs) -> Canceled:
    return Canceled(
        canceled_at=kwargs.get("canceled_at", ""),
        reason=kwargs.get("reason", None),
    )


def _running_to_succeeded(current: Running, **kwargs) -> Succeeded:
    return Succeeded(
        attempt_count=current.attempt_count,
        finished_at=kwargs.get("finished_at", ""),
        duration_ms=kwargs.get("duration_ms", 0),
    )


def _running_to_failed(current: Running, **kwargs) -> Failed:
    return Failed(
        attempt_count=current.attempt_count,
        max_attempts=kwargs.get("max_attempts", 0),
        error_code=kwargs.get("error_code", ""),
        error_message=kwargs.get("error_message", ""),
        retryable=kwargs.get("retryable", True),
        next_action=kwargs.get("next_action", None),
    )


def _running_to_canceled(current: Running, **kwargs) -> Canceled:
    return Canceled(
        canceled_at=kwargs.get("canceled_at", ""),
        reason=kwargs.get("reason", None),
    )


def _failed_to_pending(current: Failed, **kwargs) -> Pending:
    reset_attempts = kwargs.get("reset_attempts", False)
    return Pending(
        attempt_count=0 if reset_attempts else current.attempt_count,
        max_attempts=current.max_attempts,
        next_action=kwargs.get("next_action", None),
    )


def _failed_to_exhausted(current: Failed, **kwargs) -> Exhausted:
    return Exhausted(
        attempt_count=current.attempt_count,
        max_attempts=current.max_attempts,
        error_code=kwargs.get("error_code", current.error_code),
        error_message=kwargs.get("error_message", current.error_message),
        next_action=kwargs.get("next_action", None),
    )


def _blocked_to_pending(current: Blocked, **kwargs) -> Pending:
    return Pending(
        attempt_count=kwargs.get("attempt_count", 0),
        max_attempts=kwargs.get("max_attempts", 0),
        next_action=kwargs.get("next_action", None),
    )


def _exhausted_to_pending(current: Exhausted, **kwargs) -> Pending:
    return Pending(
        attempt_count=0,
        max_attempts=current.max_attempts,
        next_action=kwargs.get("next_action", None),
    )


def _canceled_to_pending(current: Canceled, **kwargs) -> Pending:
    return Pending(
        attempt_count=kwargs.get("attempt_count", 0),
        max_attempts=kwargs.get("max_attempts", 0),
        next_action=kwargs.get("next_action", None),
    )


def _succeeded_to_stale(current: Succeeded, **kwargs) -> Stale:
    return Stale(reason=kwargs.get("reason", ""))


def _stale_to_pending(current: Stale, **kwargs) -> Pending:
    return Pending(
        attempt_count=kwargs.get("attempt_count", 0),
        max_attempts=kwargs.get("max_attempts", 0),
        next_action=kwargs.get("next_action", None),
    )


# Dispatch table keyed by (current_kind, trigger). Each handler is an
# ``(StageState, **kwargs) -> StageState`` callable; the type ignore on the
# row signatures is acceptable here because the dispatch is value-based and
# the handlers themselves enforce the input ``StageState`` subclass at call
# time via positional typing.
_Handler = Callable[..., StageState]
_HANDLERS: dict[tuple[str, StageTransition], _Handler] = {
    # Row 1:  Pending  -> Queued   (Enqueue)
    ("Pending", StageTransition.Enqueue): _pending_to_queued,
    # Row 2:  Pending  -> Running  (Start)
    ("Pending", StageTransition.Start): _pending_to_running,
    # Row 3:  Pending  -> Blocked  (Block)
    ("Pending", StageTransition.Block): _pending_to_blocked,
    # Row 4:  Pending  -> Skipped  (Skip)
    ("Pending", StageTransition.Skip): _pending_to_skipped,
    # Row 5:  Queued   -> Running  (Start)
    ("Queued", StageTransition.Start): _queued_to_running,
    # Row 6:  Queued   -> Canceled (Cancel)
    ("Queued", StageTransition.Cancel): _queued_to_canceled,
    # Row 7:  Running  -> Succeeded (Complete)
    ("Running", StageTransition.Complete): _running_to_succeeded,
    # Row 8:  Running  -> Failed   (Fail)
    ("Running", StageTransition.Fail): _running_to_failed,
    # Row 9:  Running  -> Canceled (Cancel)
    ("Running", StageTransition.Cancel): _running_to_canceled,
    # Row 10: Failed   -> Pending  (Reset)
    ("Failed", StageTransition.Reset): _failed_to_pending,
    # Row 11: Failed   -> Exhausted (Exhaust)
    ("Failed", StageTransition.Exhaust): _failed_to_exhausted,
    # Row 12: Blocked  -> Pending  (Unblock)
    ("Blocked", StageTransition.Unblock): _blocked_to_pending,
    # Row 13: Exhausted -> Pending (Reset)
    ("Exhausted", StageTransition.Reset): _exhausted_to_pending,
    # Row 14: Canceled -> Pending  (Reset)
    ("Canceled", StageTransition.Reset): _canceled_to_pending,
    # Row 15: Succeeded -> Stale   (MarkStale)
    ("Succeeded", StageTransition.MarkStale): _succeeded_to_stale,
    # Row 16: Stale    -> Pending  (Reset)
    ("Stale", StageTransition.Reset): _stale_to_pending,
}


# ---------------------------------------------------------------------------
# Valid (from_kind, to_kind) pairs — derived from handler return type annotations.
# Used by set_stage_state for transition validation without needing a trigger.
# ---------------------------------------------------------------------------

_VALID_KIND_TRANSITIONS: frozenset[tuple[str, str]] = frozenset(
    {
        ("Pending", "Queued"),
        ("Pending", "Running"),
        ("Pending", "Blocked"),
        ("Pending", "Skipped"),
        ("Queued", "Running"),
        ("Queued", "Canceled"),
        ("Running", "Succeeded"),
        ("Running", "Failed"),
        ("Running", "Canceled"),
        ("Failed", "Pending"),
        ("Failed", "Exhausted"),
        ("Blocked", "Pending"),
        ("Exhausted", "Pending"),
        ("Canceled", "Pending"),
        ("Succeeded", "Stale"),
        ("Stale", "Pending"),
    }
)


def is_valid_transition(from_kind: str, to_kind: str) -> bool:
    """Check if transitioning from *from_kind* to *to_kind* is allowed.

    Uses the §8.5 transition table. Both arguments are PascalCase kind names.
    This is a quick lookup for callers (like ``set_stage_state``) that know the
    target state but not the trigger.
    """
    return (from_kind, to_kind) in _VALID_KIND_TRANSITIONS
