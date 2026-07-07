"""Unit tests for StageStateMachine — one test per S8.5 transition row + rejections.

Coverage map to ddd-target.md S8.5 transition table:
  Row 1:  test_pending_to_queued           — Pending  -> Queued   (Enqueue)
  Row 2:  test_pending_to_running          — Pending  -> Running  (Start)
  Row 3:  test_pending_to_blocked          — Pending  -> Blocked  (Block)
  Row 4:  test_pending_to_skipped          — Pending  -> Skipped  (Skip)
  Row 5:  test_queued_to_running           — Queued   -> Running  (Start)
  Row 6:  test_queued_to_canceled          — Queued   -> Canceled (Cancel)
  Row 7:  test_running_to_succeeded        — Running  -> Succeeded (Complete)
  Row 8:  test_running_to_failed           — Running  -> Failed   (Fail)
  Row 9:  test_running_to_canceled         — Running  -> Canceled (Cancel)
  Row 10: test_failed_to_pending           — Failed   -> Pending  (Reset)
  Row 11: test_failed_to_exhausted         — Failed   -> Exhausted (Exhaust)
  Row 12: test_blocked_to_pending          — Blocked  -> Pending  (Unblock)
  Row 13: test_exhausted_to_pending        — Exhausted -> Pending (Reset)
  Row 14: test_canceled_to_pending         — Canceled -> Pending  (Reset)
  Row 15: test_succeeded_to_stale          — Succeeded -> Stale   (MarkStale)
  Row 16: test_stale_to_pending            — Stale    -> Pending  (Reset)
"""

from __future__ import annotations

import pytest

from jobctl.domain.pipeline_types import (
    Blocked,
    Canceled,
    Exhausted,
    Failed,
    Pending,
    Queued,
    Running,
    Skipped,
    Stage,
    Stale,
    Succeeded,
)
from jobctl.domain.pipeline.state_machine import (
    StageTransition,
    TransitionRejected,
    transition,
)


# ── Row 1: Pending -> Queued (Enqueue) ──────────────────────────────────────


def test_pending_to_queued():
    result = transition(Pending(), StageTransition.Enqueue, queued_at="2025-01-01T00:00:00Z")
    assert isinstance(result, Queued)
    assert result.queued_at == "2025-01-01T00:00:00Z"


# ── Row 2: Pending -> Running (Start) ──────────────────────────────────────


def test_pending_to_running():
    result = transition(
        Pending(attempt_count=2),
        StageTransition.Start,
        started_at="2025-01-01T00:00:00Z",
    )
    assert isinstance(result, Running)
    assert result.attempt_count == 3  # incremented from 2
    assert result.started_at == "2025-01-01T00:00:00Z"


# ── Row 3: Pending -> Blocked (Block) ──────────────────────────────────────


def test_pending_to_blocked():
    result = transition(
        Pending(),
        StageTransition.Block,
        blocked_by=(Stage.Enrich,),
        error_code="BLOCKED_UPSTREAM",
        error_message="upstream not done",
    )
    assert isinstance(result, Blocked)
    assert result.blocked_by == (Stage.Enrich,)
    assert result.error_code == "BLOCKED_UPSTREAM"


# ── Row 4: Pending -> Skipped (Skip) ───────────────────────────────────────


def test_pending_to_skipped():
    result = transition(Pending(), StageTransition.Skip, reason="below score threshold")
    assert isinstance(result, Skipped)
    assert result.reason == "below score threshold"


# ── Row 5: Queued -> Running (Start) ───────────────────────────────────────


def test_queued_to_running():
    result = transition(
        Queued(queued_at="2025-01-01T00:00:00Z"),
        StageTransition.Start,
        attempt_count=1,
        started_at="2025-01-01T00:01:00Z",
    )
    assert isinstance(result, Running)
    assert result.attempt_count == 1
    assert result.started_at == "2025-01-01T00:01:00Z"


# ── Row 6: Queued -> Canceled (Cancel) ─────────────────────────────────────


def test_queued_to_canceled():
    result = transition(
        Queued(queued_at="2025-01-01T00:00:00Z"),
        StageTransition.Cancel,
        canceled_at="2025-01-01T00:02:00Z",
        reason="user requested",
    )
    assert isinstance(result, Canceled)
    assert result.canceled_at == "2025-01-01T00:02:00Z"
    assert result.reason == "user requested"


# ── Row 7: Running -> Succeeded (Complete) ─────────────────────────────────


def test_running_to_succeeded():
    result = transition(
        Running(attempt_count=1, started_at="2025-01-01T00:00:00Z"),
        StageTransition.Complete,
        finished_at="2025-01-01T00:05:00Z",
        duration_ms=300_000,
    )
    assert isinstance(result, Succeeded)
    assert result.attempt_count == 1
    assert result.finished_at == "2025-01-01T00:05:00Z"
    assert result.duration_ms == 300_000


# ── Row 8: Running -> Failed (Fail) ────────────────────────────────────────


def test_running_to_failed():
    result = transition(
        Running(attempt_count=2, started_at="2025-01-01T00:00:00Z"),
        StageTransition.Fail,
        max_attempts=5,
        error_code="TIMEOUT",
        error_message="request timed out",
        retryable=True,
    )
    assert isinstance(result, Failed)
    assert result.attempt_count == 2
    assert result.max_attempts == 5
    assert result.error_code == "TIMEOUT"
    assert result.retryable is True


# ── Row 9: Running -> Canceled (Cancel) ────────────────────────────────────


def test_running_to_canceled():
    result = transition(
        Running(attempt_count=1, started_at="2025-01-01T00:00:00Z"),
        StageTransition.Cancel,
        canceled_at="2025-01-01T00:03:00Z",
    )
    assert isinstance(result, Canceled)
    assert result.canceled_at == "2025-01-01T00:03:00Z"


# ── Row 10: Failed -> Pending (Reset) ──────────────────────────────────────


def test_failed_to_pending():
    result = transition(
        Failed(attempt_count=3, max_attempts=5, error_code="ERR", error_message="oops"),
        StageTransition.Reset,
    )
    assert isinstance(result, Pending)
    assert result.attempt_count == 3  # preserved (not reset)


def test_failed_to_pending_with_reset_attempts():
    result = transition(
        Failed(attempt_count=3, max_attempts=5, error_code="ERR", error_message="oops"),
        StageTransition.Reset,
        reset_attempts=True,
    )
    assert isinstance(result, Pending)
    assert result.attempt_count == 0  # reset


# ── Row 11: Failed -> Exhausted (Exhaust) ──────────────────────────────────


def test_failed_to_exhausted():
    result = transition(
        Failed(attempt_count=5, max_attempts=5, error_code="ERR", error_message="oops"),
        StageTransition.Exhaust,
    )
    assert isinstance(result, Exhausted)
    assert result.attempt_count == 5
    assert result.max_attempts == 5
    assert result.error_code == "ERR"


# ── Row 12: Blocked -> Pending (Unblock) ───────────────────────────────────


def test_blocked_to_pending():
    result = transition(
        Blocked(blocked_by=(Stage.Enrich,), error_code="BLOCKED", error_message="upstream"),
        StageTransition.Unblock,
    )
    assert isinstance(result, Pending)
    assert result.attempt_count == 0


# ── Row 13: Exhausted -> Pending (Reset) ───────────────────────────────────


def test_exhausted_to_pending():
    result = transition(
        Exhausted(attempt_count=5, max_attempts=5, error_code="MAX", error_message="done"),
        StageTransition.Reset,
    )
    assert isinstance(result, Pending)
    assert result.attempt_count == 0  # always reset on exhausted
    assert result.max_attempts == 5  # preserved


# ── Row 14: Canceled -> Pending (Reset) ────────────────────────────────────


def test_canceled_to_pending():
    result = transition(
        Canceled(canceled_at="2025-01-01T00:00:00Z"),
        StageTransition.Reset,
    )
    assert isinstance(result, Pending)
    assert result.attempt_count == 0


# ── Row 15: Succeeded -> Stale (MarkStale) ─────────────────────────────────


def test_succeeded_to_stale():
    result = transition(
        Succeeded(attempt_count=1, finished_at="2025-01-01T00:05:00Z", duration_ms=300_000),
        StageTransition.MarkStale,
        reason="upstream re-enriched",
    )
    assert isinstance(result, Stale)
    assert result.reason == "upstream re-enriched"


# ── Row 16: Stale -> Pending (Reset) ───────────────────────────────────────


def test_stale_to_pending():
    result = transition(
        Stale(reason="upstream re-enriched"),
        StageTransition.Reset,
    )
    assert isinstance(result, Pending)
    assert result.attempt_count == 0


# ── Rejected transitions ───────────────────────────────────────────────────


class TestRejectedTransitions:
    """Verify that invalid transitions produce TransitionRejected."""

    @pytest.mark.parametrize(
        ("current", "trigger"),
        [
            (Succeeded(attempt_count=1), StageTransition.Start),
            (Succeeded(attempt_count=1), StageTransition.Fail),
            (Succeeded(attempt_count=1), StageTransition.Complete),
            (Running(attempt_count=1), StageTransition.Start),
            (Running(attempt_count=1), StageTransition.Reset),
            (Pending(), StageTransition.Complete),
            (Pending(), StageTransition.Fail),
            (Pending(), StageTransition.Cancel),
            (Blocked(), StageTransition.Start),
            (Skipped(), StageTransition.Reset),
            (Exhausted(attempt_count=3, max_attempts=3), StageTransition.Exhaust),
        ],
    )
    def test_rejected_transition(self, current, trigger):
        result = transition(current, trigger)
        assert isinstance(result, TransitionRejected)
        assert result.current_state is current
        assert result.attempted_transition is trigger
        assert "not allowed" in result.reason
