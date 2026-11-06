"""Durable invalidations read by SSE only after their canonical transaction commits."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from jobctrl.app.database import Database
from jobctrl.app.errors import NotFoundError


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EventStore:
    def __init__(self, database: Database):
        self.database = database

    def append(self, connection: sqlite3.Connection, event_type: str, payload: dict,
               *, feature: str, aggregate_id: str | None = None, level: str = "info", stage: str | None = None) -> int:
        if not connection.in_transaction:
            raise RuntimeError("Events must share a canonical write transaction")
        if not event_type or any(character in event_type for character in "\r\n\0"):
            raise ValueError("Invalid event type")
        if level not in {"debug", "info", "warn", "error"}:
            raise ValueError("Invalid event level")
        # A stage already recorded by its owner can be projected literally. The
        # runtime never derives stage/meaning from event names or prose.
        stage = stage if stage is not None else payload.get("stage")
        if stage is not None and (not isinstance(stage, str) or len(stage) > 120):
            raise ValueError("Invalid event stage")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode()) > 65536:
            raise ValueError("Event invalidation is too large")
        cursor = connection.execute(
            "INSERT INTO app_events(event_type,feature,aggregate_id,occurred_at,payload_json,level,stage) VALUES (?,?,?,?,?,?,?)",
            (event_type, feature, aggregate_id, now(), encoded, level, stage),
        )
        return int(cursor.lastrowid)

    def since(self, after: int = 0, *, limit: int = 200) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM app_events WHERE event_id>? ORDER BY event_id LIMIT ?", (after, min(limit, 1000))
            ).fetchall()
        return [{
            "eventId": str(row["event_id"]), "type": row["event_type"], "feature": row["feature"],
            "aggregateId": row["aggregate_id"], "tenantId": "local", "occurredAt": row["occurred_at"],
            "payload": json.loads(row["payload_json"]),
            "level": row["level"], "stage": row["stage"],
        } for row in rows]

    def latest_id(self) -> int:
        with self.database.connect() as connection:
            return int(connection.execute("SELECT COALESCE(MAX(event_id),0) FROM app_events").fetchone()[0])

    def page(self, *, before: int | None = None, limit: int = 100, feature: str | None = None,
             event_type: str | None = None, level: str | None = None, stage: str | None = None,
             aggregate_id: str | None = None, since: str | None = None, until: str | None = None, q: str = "") -> dict:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM app_events WHERE (? IS NULL OR event_id<?) "
                "AND (? IS NULL OR feature=?) AND (? IS NULL OR event_type=?) AND (? IS NULL OR level=?) "
                "AND (? IS NULL OR stage=?) AND (? IS NULL OR aggregate_id=?) "
                "AND (? IS NULL OR occurred_at>=?) AND (? IS NULL OR occurred_at<=?) "
                "AND (?='' OR event_type LIKE ? ESCAPE '\\' OR feature LIKE ? ESCAPE '\\' "
                "OR aggregate_id LIKE ? ESCAPE '\\' OR payload_json LIKE ? ESCAPE '\\') ORDER BY event_id DESC LIMIT ?",
                (before, before, feature, feature, event_type, event_type, level, level, stage, stage,
                 aggregate_id, aggregate_id, since, since, until, until, q, pattern, pattern, pattern, pattern, limit + 1),
            ).fetchall()
        more = len(rows) > limit
        events = [{
            "eventId": str(row["event_id"]), "type": row["event_type"], "feature": row["feature"],
            "aggregateId": row["aggregate_id"], "tenantId": "local", "occurredAt": row["occurred_at"],
            "payload": json.loads(row["payload_json"]),
            "level": row["level"], "stage": row["stage"],
        } for row in rows[:limit]]
        return {"events": events, "nextCursor": events[-1]["eventId"] if more else None, "hasMore": more}

    def get(self, event_id: int) -> dict:
        records = self.since(event_id - 1, limit=1)
        if not records or records[0]["eventId"] != str(event_id):
            raise NotFoundError("The activity event does not exist.")
        return records[0]
