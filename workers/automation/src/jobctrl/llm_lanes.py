"""Explicit product-lane context for LLM accounting and admission."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from functools import wraps
from inspect import iscoroutinefunction
from typing import Awaitable, Callable, Literal, ParamSpec, TypeVar, cast, overload

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
P = ParamSpec("P")
R = TypeVar("R")


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


@overload
def lane_bound(lane: LlmLane | str) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]: ...


@overload
def lane_bound(lane: LlmLane | str) -> Callable[[Callable[P, R]], Callable[P, R]]: ...


def lane_bound(lane: LlmLane | str) -> Callable:
    """Bind a constant lane at an owning domain or activity method boundary."""
    validated = validate_llm_lane(lane)

    def decorate(function: Callable) -> Callable:
        if iscoroutinefunction(function):
            @wraps(function)
            async def async_wrapper(*args: object, **kwargs: object) -> object:
                with bind_llm_lane(validated):
                    return await function(*args, **kwargs)

            return async_wrapper

        @wraps(function)
        def sync_wrapper(*args: object, **kwargs: object) -> object:
            with bind_llm_lane(validated):
                return function(*args, **kwargs)

        return sync_wrapper

    return decorate


__all__ = [
    "LEGACY_LLM_LANE",
    "LLM_LANES",
    "LlmLane",
    "LlmLaneError",
    "bind_llm_lane",
    "current_llm_lane",
    "lane_bound",
    "validate_llm_lane",
]
