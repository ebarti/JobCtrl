"""Request-scoped admission checks; never transfer a SQLite owner guard."""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

_guard: ContextVar[Callable[[], None] | None] = ContextVar("llm_attempt_admission", default=None)


def check_model_attempt_admission() -> None:
    guard = _guard.get()
    if guard is not None:
        guard()


@contextmanager
def model_attempt_admission(guard: Callable[[], None]) -> Iterator[None]:
    token = _guard.set(guard)
    try:
        yield
    finally:
        _guard.reset(token)
