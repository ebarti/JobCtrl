"""Explicit product-lane context for LLM accounting and admission."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from typing import Literal, cast

LlmLane = Literal[
    "discovery",
    "enrichment",
    "scoring",
    "tailoring",
    "apply",
    "contact",
    "interview",
    "profile",
    "compensation",
]

LLM_LANES: tuple[LlmLane, ...] = (
    "discovery",
    "enrichment",
    "scoring",
    "tailoring",
    "apply",
    "contact",
    "interview",
    "profile",
    "compensation",
)
LEGACY_LLM_LANE = "legacy"

_current_lane: ContextVar[LlmLane | None] = ContextVar("jobctrl_llm_lane", default=None)


class LlmLaneError(ValueError):
    """Raised when an LLM call or observation has no valid product lane."""


def validate_llm_lane(value: object) -> LlmLane:
    """Return a known runtime lane; the migration-only legacy lane is rejected."""
    if not isinstance(value, str) or value not in LLM_LANES:
        raise LlmLaneError(f"unknown LLM lane: {value!r}")
    return cast(LlmLane, value)


def current_llm_lane() -> LlmLane:
    """Return the explicitly bound lane, failing closed when attribution is absent."""
    lane = _current_lane.get()
    if lane is None:
        raise LlmLaneError("an explicit LLM product lane is required")
    return lane


@contextmanager
def bind_llm_lane(lane: LlmLane | str) -> Iterator[LlmLane]:
    """Bind one lane for the current call context without mutating shared adapters."""
    validated = validate_llm_lane(lane)
    token: Token[LlmLane | None] = _current_lane.set(validated)
    try:
        yield validated
    finally:
        _current_lane.reset(token)


__all__ = [
    "LEGACY_LLM_LANE",
    "LLM_LANES",
    "LlmLane",
    "LlmLaneError",
    "bind_llm_lane",
    "current_llm_lane",
    "validate_llm_lane",
]
