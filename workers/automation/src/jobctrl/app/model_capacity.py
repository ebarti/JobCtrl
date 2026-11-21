"""Opt-in admission waiting for an already owned, cancellable action."""

import asyncio
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from .errors import AppError


class ModelCapacityBusy(AppError):
    """Another call holds capacity. No provider receipt has been allocated."""


@dataclass(frozen=True)
class _CapacityWait:
    cancelled: Callable[[], bool]
    on_wait: Callable[[str], None] | None
    lane: str | None


_waiting: ContextVar[_CapacityWait | None] = ContextVar("model_capacity_wait", default=None)


@contextmanager
def wait_for_model_capacity(cancelled: Callable[[], bool], *, on_wait: Callable[[str], None] | None = None,
                            lane: str | None = None) -> Iterator[None]:
    token = _waiting.set(_CapacityWait(cancelled, on_wait, lane))
    try:
        yield
    finally:
        _waiting.reset(token)


async def admit_model_call(lane: str, admit: Callable[[], str]) -> str:
    policy = _waiting.get()
    if policy is None or policy.lane is not None and policy.lane != lane:
        return admit()
    last_reason = None
    while not policy.cancelled():
        try:
            return admit()
        except ModelCapacityBusy as busy:
            if policy.on_wait is not None and last_reason != busy.code:
                policy.on_wait(busy.code)
            last_reason = busy.code
        await asyncio.sleep(1)
    raise asyncio.CancelledError()
