"""Pipeline stage and stage-state domain types.

PascalCase variants are the domain representation used in-memory.
Lowercase strings are the serialized form for persistence and transport.

See ddd-target.md §4.7 (Pipeline Orchestration), §8.5 (State Machine), §11 (Glossary).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------


class Stage(Enum):
    """The six pipeline stages in canonical order (domain PascalCase)."""

    Discover = "Discover"
    Enrich = "Enrich"
    Score = "Score"
    Tailor = "Tailor"
    Cover = "Cover"
    Apply = "Apply"


STAGES: tuple[Stage, ...] = tuple(Stage)

_STAGE_TO_SERIALIZED: dict[Stage, str] = {s: s.value.lower() for s in Stage}
_SERIALIZED_TO_STAGE: dict[str, Stage] = {v: k for k, v in _STAGE_TO_SERIALIZED.items()}


def serialize_stage(stage: Stage) -> str:
    """Convert a domain Stage to its lowercase serialized form."""
    return _STAGE_TO_SERIALIZED[stage]


def deserialize_stage(value: str) -> Stage:
    """Convert a lowercase serialized string back to a domain Stage.

    Raises ValueError on invalid input.
    """
    try:
        return _SERIALIZED_TO_STAGE[value.lower()]
    except KeyError:
        raise ValueError(f'Invalid serialized stage: "{value}"') from None


# ---------------------------------------------------------------------------
# StageState — discriminated union via frozen dataclasses
# ---------------------------------------------------------------------------

STAGE_STATE_KINDS: tuple[str, ...] = (
    "Pending",
    "Queued",
    "Running",
    "Succeeded",
    "Failed",
    "Blocked",
    "Skipped",
    "Exhausted",
    "NeedsVerification",
    "Stale",
    "Canceled",
)

_SERIALIZED_TO_KIND: dict[str, str] = {k.lower(): k for k in STAGE_STATE_KINDS}
_SERIALIZED_TO_KIND["needs_verification"] = "NeedsVerification"


@dataclass(frozen=True)
class Pending:
    kind: str = field(default="Pending", init=False)
    attempt_count: int = 0
    max_attempts: int = 0
    next_action: str | None = None


@dataclass(frozen=True)
class Queued:
    kind: str = field(default="Queued", init=False)
    queued_at: str = ""


@dataclass(frozen=True)
class Running:
    kind: str = field(default="Running", init=False)
    attempt_count: int = 0
    started_at: str = ""


@dataclass(frozen=True)
class Succeeded:
    kind: str = field(default="Succeeded", init=False)
    attempt_count: int = 0
    finished_at: str = ""
    duration_ms: int = 0


@dataclass(frozen=True)
class Failed:
    kind: str = field(default="Failed", init=False)
    attempt_count: int = 0
    max_attempts: int = 0
    error_code: str = ""
    error_message: str = ""
    retryable: bool = False
    next_action: str | None = None


@dataclass(frozen=True)
class Blocked:
    kind: str = field(default="Blocked", init=False)
    blocked_by: tuple[Stage, ...] = ()
    error_code: str = ""
    error_message: str = ""


@dataclass(frozen=True)
class Skipped:
    kind: str = field(default="Skipped", init=False)
    reason: str = ""


@dataclass(frozen=True)
class Exhausted:
    kind: str = field(default="Exhausted", init=False)
    attempt_count: int = 0
    max_attempts: int = 0
    error_code: str = ""
    error_message: str = ""
    next_action: str | None = None


@dataclass(frozen=True)
class NeedsVerification:
    kind: str = field(default="NeedsVerification", init=False)
    reason: str = ""
    next_action: str | None = None


@dataclass(frozen=True)
class Stale:
    kind: str = field(default="Stale", init=False)
    reason: str = ""


@dataclass(frozen=True)
class Canceled:
    kind: str = field(default="Canceled", init=False)
    canceled_at: str = ""
    reason: str | None = None


StageState = Pending | Queued | Running | Succeeded | Failed | Blocked | Skipped | Exhausted | NeedsVerification | Stale | Canceled


def serialize_stage_state(state: StageState) -> str:
    """Convert a domain StageState to its lowercase serialized form."""
    if state.kind == "NeedsVerification":
        return "needs_verification"
    return state.kind.lower()


def deserialize_stage_state_kind(value: str) -> str:
    """Convert a lowercase string to a StageState kind name (PascalCase).

    Raises ValueError on invalid input.
    """
    kind = _SERIALIZED_TO_KIND.get(value.lower())
    if kind is None:
        raise ValueError(f'Invalid serialized stage state: "{value}"')
    return kind
