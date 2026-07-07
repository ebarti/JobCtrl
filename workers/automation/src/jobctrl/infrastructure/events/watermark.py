"""SqliteEventWatermarkRepository — adapter over the ``event_watermarks`` table.

See ddd-target.md §6.3.  The table schema is created in
``database.ensure_state_tables`` (Phase 3, S-10).
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SqliteEventWatermarkRepository:
    """SQLite-backed adapter implementing :class:`EventWatermarkRepository`."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def get(self, projection_name: str) -> int:
        row = self._conn.execute(
            "SELECT last_event_id FROM event_watermarks WHERE projection_name = ?",
            (projection_name,),
        ).fetchone()
        if row is None:
            return 0
        # Support both Row and tuple-style cursors.
        try:
            return int(row["last_event_id"])
        except (KeyError, TypeError, IndexError):
            return int(row[0])

    def set(
        self, projection_name: str, last_event_id: int, *, commit: bool = True
    ) -> None:
        if last_event_id < 0:
            raise ValueError(f"last_event_id must be >= 0 (got {last_event_id})")
        # MAX() keeps the watermark monotonic: a stale or out-of-order writer
        # can never rewind it. updated_at only moves when the value advances.
        self._conn.execute(
            """
            INSERT INTO event_watermarks (projection_name, last_event_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(projection_name) DO UPDATE SET
                last_event_id = MAX(
                    event_watermarks.last_event_id, excluded.last_event_id
                ),
                updated_at    = CASE
                    WHEN excluded.last_event_id > event_watermarks.last_event_id
                        THEN excluded.updated_at
                    ELSE event_watermarks.updated_at
                END
            """,
            (projection_name, int(last_event_id), _utc_now()),
        )
        # commit=False lets an outer transaction (the ProjectionBuilder's
        # deferred-commit path) own the flush so the watermark bump stays
        # atomic with the projection rebuild and the caller's own writes.
        if commit:
            self._conn.commit()
