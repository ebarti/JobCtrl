"""Apply Automation child entities.

See ddd-target.md §4.6. ``ApplyRunEvent`` is the non-root entity owned
by the ``ApplyRun`` aggregate. Each event is appended exactly once
(monotonic timeline) and persisted alongside the parent aggregate by
``ApplyRunRepository.save``.

Invariants:

  * ``event_id`` is monotonic per aggregate (1, 2, ...). The aggregate
    enforces numbering when appending.
  * ``event_type`` is a non-empty string (PascalCase by convention —
    see §6.4 / §9 wire-format normalization).
  * ``level`` is one of {info, warn, error, debug}.
  * ``occurred_at`` is a non-empty ISO-8601 timestamp string.
  * ``payload`` is a Mapping (commonly the same JSON-serialisable
    payload the legacy launcher emitted via ``_telemetry_emit``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


_VALID_LEVELS = frozenset({"info", "warn", "error", "debug"})


@dataclass(frozen=True)
class ApplyRunEvent:
    """One structured event in an ``ApplyRun``'s timeline."""

    event_id: int
    event_type: str
    level: str = "info"
    message: str | None = None
    payload: Mapping[str, Any] = field(default_factory=dict)
    occurred_at: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.event_id, int) or self.event_id <= 0:
            raise ValueError(
                "ApplyRunEvent.event_id must be a positive int (1-based)"
            )
        if not isinstance(self.event_type, str) or not self.event_type.strip():
            raise ValueError("ApplyRunEvent.event_type must be a non-empty string")
        if self.level not in _VALID_LEVELS:
            raise ValueError(
                f"ApplyRunEvent.level must be one of {sorted(_VALID_LEVELS)!r}, "
                f"got {self.level!r}"
            )
        if self.message is not None and not isinstance(self.message, str):
            raise ValueError("ApplyRunEvent.message must be a string or None")
        if not isinstance(self.payload, Mapping):
            raise ValueError("ApplyRunEvent.payload must be a Mapping")
        if not isinstance(self.occurred_at, str) or not self.occurred_at.strip():
            raise ValueError(
                "ApplyRunEvent.occurred_at must be a non-empty ISO timestamp"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "level": self.level,
            "message": self.message,
            "payload": dict(self.payload),
            "occurred_at": self.occurred_at,
        }
