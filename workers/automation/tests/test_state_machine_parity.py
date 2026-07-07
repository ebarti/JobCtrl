"""TS↔Python parity test driven from the shared fixture.

The TS counterpart lives at
``packages/domain-types/test/state_machine_parity.test.ts``.  Both load
``packages/domain-types/test/fixtures/state_machine_transitions.json`` and
assert identical outputs for every §8.5 row plus the rejection cases.
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

import pytest

from jobctl.domain.pipeline.state_machine import (
    StageTransition,
    TransitionRejected,
    _VALID_KIND_TRANSITIONS,
    is_valid_transition,
    transition,
)
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


REPO = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPO / "packages" / "domain-types" / "test" / "fixtures" / "state_machine_transitions.json"


_STATE_BY_KIND: dict[str, type[StageState]] = {
    "Pending": Pending,
    "Queued": Queued,
    "Running": Running,
    "Succeeded": Succeeded,
    "Failed": Failed,
    "Blocked": Blocked,
    "Skipped": Skipped,
    "Exhausted": Exhausted,
    "Stale": Stale,
    "Canceled": Canceled,
}


# ---------------------------------------------------------------------------
# camelCase ↔ snake_case bridge
# ---------------------------------------------------------------------------

# Field-name translation between the JS-style fixture and Python dataclasses.
_CAMEL_TO_SNAKE: dict[str, str] = {
    "kind": "kind",
    "attemptCount": "attempt_count",
    "maxAttempts": "max_attempts",
    "queuedAt": "queued_at",
    "startedAt": "started_at",
    "finishedAt": "finished_at",
    "canceledAt": "canceled_at",
    "durationMs": "duration_ms",
    "errorCode": "error_code",
    "errorMessage": "error_message",
    "retryable": "retryable",
    "nextAction": "next_action",
    "reason": "reason",
    "blockedBy": "blocked_by",
    "resetAttempts": "reset_attempts",
}


def _to_snake(d: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in d.items():
        if k not in _CAMEL_TO_SNAKE:
            raise KeyError(f"unknown fixture field {k!r} — extend _CAMEL_TO_SNAKE")
        out[_CAMEL_TO_SNAKE[k]] = v
    return out


def _build_state(payload: dict[str, Any]) -> StageState:
    snake = _to_snake(payload)
    kind = snake.pop("kind")
    cls = _STATE_BY_KIND[kind]
    if "blocked_by" in snake and isinstance(snake["blocked_by"], list):
        snake["blocked_by"] = tuple(snake["blocked_by"])
    return cls(**snake)


def _state_to_camel_dict(state: StageState) -> dict[str, Any]:
    """Serialise a Python ``StageState`` back into the fixture's camelCase shape."""
    if not is_dataclass(state):
        raise TypeError(f"expected dataclass, got {type(state).__name__}")
    snake = asdict(state)
    snake["kind"] = type(state).__name__
    out: dict[str, Any] = {}
    snake_to_camel = {v: k for k, v in _CAMEL_TO_SNAKE.items()}
    for snake_key, value in snake.items():
        camel_key = snake_to_camel.get(snake_key)
        if camel_key is None:
            continue
        # Skip Python defaults that map to JS-side absent fields.
        if value is None:
            continue
        if isinstance(value, tuple):
            value = list(value)
        out[camel_key] = value
    return out


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    assert FIXTURE_PATH.exists(), f"missing fixture: {FIXTURE_PATH}"
    return json.loads(FIXTURE_PATH.read_text("utf-8"))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_valid_kind_transitions_count_matches_table() -> None:
    assert len(_VALID_KIND_TRANSITIONS) == 16


def test_fixture_covers_every_row_of_valid_transitions(fixture: dict[str, Any]) -> None:
    derived: set[tuple[str, str]] = set()
    for case in fixture["validTransitions"]:
        from_state = _build_state(case["from"])
        result = transition(from_state, StageTransition[case["trigger"]], **_to_snake(case.get("inputs", {})))
        assert not isinstance(result, TransitionRejected), case["name"]
        derived.add((type(from_state).__name__, type(result).__name__))
    assert derived == _VALID_KIND_TRANSITIONS


def test_python_outputs_match_expected_for_every_valid_case(fixture: dict[str, Any]) -> None:
    failures: list[str] = []
    for case in fixture["validTransitions"]:
        from_state = _build_state(case["from"])
        kwargs = _to_snake(case.get("inputs", {}))
        result = transition(from_state, StageTransition[case["trigger"]], **kwargs)
        assert not isinstance(result, TransitionRejected), case["name"]
        actual = _state_to_camel_dict(result)
        # Normalise expected dict by stripping nullish optionals (parity with TS compact()).
        expected = {k: v for k, v in case["expected"].items() if v is not None}
        if actual != expected:
            failures.append(f"{case['name']}: expected {expected}, got {actual}")
    assert not failures, "\n".join(failures)


def test_rejections_match_python(fixture: dict[str, Any]) -> None:
    for case in fixture["rejections"]:
        from_state = _build_state(case["from"])
        result = transition(from_state, StageTransition[case["trigger"]])
        assert isinstance(result, TransitionRejected), case["name"]


def test_is_valid_transition_agrees_with_transition_on_every_fixture_row(
    fixture: dict[str, Any],
) -> None:
    for case in fixture["validTransitions"]:
        from_state = _build_state(case["from"])
        kwargs = _to_snake(case.get("inputs", {}))
        result = transition(from_state, StageTransition[case["trigger"]], **kwargs)
        assert not isinstance(result, TransitionRejected)
        assert is_valid_transition(type(from_state).__name__, type(result).__name__)


def test_stage_transition_enum_has_eleven_triggers() -> None:
    assert len(list(StageTransition)) == 11
