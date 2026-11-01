"""Request-local identities for content-free model-call tracing."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True)
class DeterminationRequest:
    kind: str
    fingerprint: str


_request: ContextVar[DeterminationRequest | None] = ContextVar(
    "jobctrl_determination_request", default=None,
)


def current_determination_request() -> DeterminationRequest | None:
    return _request.get()


@contextmanager
def bind_determination_request(kind: str, fingerprint: str) -> Iterator[None]:
    token = _request.set(DeterminationRequest(kind, fingerprint))
    try:
        yield
    finally:
        _request.reset(token)
