"""Digest application ports, independent of a persistence or transport SDK."""

from dataclasses import dataclass
from typing import Any, ContextManager, Protocol


@dataclass(frozen=True)
class DigestReadScope:
    since: str | None
    source_context: Any


class DigestRepository(Protocol):
    def read_scope(self) -> ContextManager[DigestReadScope]: ...
    def acknowledge(self, requested: str | None = None) -> dict: ...


class SpendReader(Protocol):
    def spend(self) -> dict: ...


class SettingsReader(Protocol):
    def snapshot(self) -> dict: ...
