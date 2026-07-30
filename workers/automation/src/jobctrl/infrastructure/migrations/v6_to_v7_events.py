"""Explicit v6-to-v7 reconstruction of append-only job event identity."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.infrastructure.migrations.identity_upcast import (
    EVENT_IDENTITY_UPCAST_VERSION,
    upcast_v6_event_identity,
)
from jobctrl.infrastructure.migrations.v6_to_v7_support import (
    has_tenant_job_foreign_key,
    table_columns,
)

_EVENT_TABLES = ("job_events",)
_EVENT_COLUMNS = (
    "event_id",
    "tenant_id",
    "job_id",
    "identity_version",
    "stage",
    "event_type",
    "level",
    "message",
    "occurred_at",
    "payload_json",
    "entity_kind",
    "entity_ref",
    "idempotency_key",
)


def transform_v6_job_events(conn: sqlite3.Connection) -> list[str]:
    """Replace v6 URL-keyed events with v7 tenant-scoped JobId events."""
    if "job_url" not in table_columns(conn, "job_events"):
        raise RuntimeError(
            "the v7 cutover event identity requires the legacy job_url column"
        )

    conn.execute("SAVEPOINT v6_job_events")
    try:
        canonical_rows, expected_event_ids, sequence_high_water = canonical_v6_event_rows(
            conn
        )
        conn.execute('DROP TABLE IF EXISTS "job_events_rebuilt"')
        create_v7_job_events_table(conn, table="job_events_rebuilt")
        conn.executemany(
            """
            INSERT INTO job_events_rebuilt (
                event_id,
                tenant_id,
                job_id,
                identity_version,
                stage,
                event_type,
                level,
                message,
                occurred_at,
                payload_json,
                entity_kind,
                entity_ref,
                idempotency_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            canonical_rows,
        )
        conn.execute('DROP TABLE "job_events"')
        conn.execute('ALTER TABLE "job_events_rebuilt" RENAME TO "job_events"')
        restore_job_event_sequence(
            conn,
            sequence_high_water=sequence_high_water,
        )
        create_v7_job_event_indexes(conn)
        verify_v7_job_events(
            conn,
            expected_event_ids=expected_event_ids,
            expected_sequence_high_water=sequence_high_water,
        )
        conn.execute("RELEASE SAVEPOINT v6_job_events")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT v6_job_events")
        conn.execute("RELEASE SAVEPOINT v6_job_events")
        raise
    return list(_EVENT_TABLES)


def create_v7_job_events_table(conn: sqlite3.Connection, *, table: str) -> None:
    """Create the final event schema using a temporary rebuild table name."""
    conn.execute(
        f"""
        CREATE TABLE "{table}" (
            event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id        TEXT NOT NULL,
            job_id           TEXT,
            identity_version INTEGER NOT NULL,
            stage            TEXT,
            event_type       TEXT NOT NULL,
            level            TEXT NOT NULL DEFAULT 'info',
            message          TEXT,
            occurred_at      TEXT NOT NULL,
            payload_json     TEXT,
            entity_kind      TEXT,
            entity_ref       TEXT,
            idempotency_key  TEXT,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )


def create_v7_job_event_indexes(conn: sqlite3.Connection) -> None:
    """Install the target event read and idempotency indexes."""
    conn.execute(
        """
        CREATE UNIQUE INDEX idx_job_events_idempotency_key
        ON job_events(idempotency_key)
        WHERE idempotency_key IS NOT NULL
        """
    )
    conn.execute(
        """
        CREATE INDEX idx_job_events_job_time
        ON job_events(
            tenant_id,
            job_id,
            occurred_at DESC,
            event_id DESC
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX idx_job_events_stage_time
        ON job_events(
            tenant_id,
            stage,
            occurred_at DESC,
            event_id DESC
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX idx_job_events_entity
        ON job_events(
            tenant_id,
            entity_kind,
            entity_ref,
            occurred_at DESC,
            event_id DESC
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX idx_job_events_tenant_eid
        ON job_events(tenant_id, event_id)
        """
    )


def canonical_v6_event_rows(
    conn: sqlite3.Connection,
) -> tuple[list[tuple[Any, ...]], tuple[int, ...], int]:
    """Upcast v6 event identity while preserving event IDs and payload content."""
    rows = conn.execute(
        """
        SELECT
            event_id,
            job_url,
            stage,
            event_type,
            level,
            message,
            occurred_at,
            payload_json,
            entity_kind,
            entity_ref,
            idempotency_key
        FROM job_events
        ORDER BY event_id
        """
    ).fetchall()
    sequence_row = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
    ).fetchone()
    canonical: list[tuple[Any, ...]] = []
    event_ids: list[int] = []
    for row in rows:
        event_id = int(row[0])
        raw_payload = row[7]
        upcasted = upcast_v6_event_identity(
            conn,
            tenant_id="local",
            event_type=str(row[3]),
            event_job_reference=str(row[1]) if row[1] is not None else None,
            payload=parse_v6_event_payload(raw_payload),
        )
        canonical.append(
            (
                event_id,
                "local",
                upcasted.job_id,
                upcasted.version,
                row[2],
                row[3],
                row[4],
                row[5],
                row[6],
                (
                    json.dumps(
                        upcasted.payload,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    if raw_payload is not None
                    else None
                ),
                row[8],
                (
                    upcasted.job_id
                    if row[8] == "job" and upcasted.job_id is not None
                    else row[9]
                ),
                row[10],
            )
        )
        event_ids.append(event_id)
    max_event_id = max(event_ids, default=0)
    sequence_high_water = max(
        int(sequence_row[0]) if sequence_row is not None else 0,
        max_event_id,
    )
    return canonical, tuple(event_ids), sequence_high_water


def parse_v6_event_payload(raw_payload: Any) -> dict[str, Any]:
    """Decode the object payload required by the historical v6 event log."""
    if raw_payload is None:
        return {}
    try:
        parsed = json.loads(str(raw_payload))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Event identity migration found invalid payload JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("Event identity migration requires object payload JSON")
    return parsed


def restore_job_event_sequence(
    conn: sqlite3.Connection,
    *,
    sequence_high_water: int,
) -> None:
    """Restore the append-only event ID high-water after table replacement."""
    conn.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ('job_events', 'job_events_rebuilt')"
    )
    conn.execute(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('job_events', ?)",
        (sequence_high_water,),
    )


def verify_v7_job_events(
    conn: sqlite3.Connection,
    *,
    expected_event_ids: tuple[int, ...],
    expected_sequence_high_water: int,
) -> None:
    """Verify v7 event identity, ordered history, and sequence continuity."""
    columns = table_columns(conn, "job_events")
    if columns != set(_EVENT_COLUMNS) or len(columns) != len(_EVENT_COLUMNS):
        raise RuntimeError("Event identity migration did not create the v7 schema")
    if not has_tenant_job_foreign_key(conn, "job_events", "job_id"):
        raise RuntimeError("Event identity migration did not create the v7 schema")
    observed_event_ids = tuple(
        int(row[0])
        for row in conn.execute(
            "SELECT event_id FROM job_events ORDER BY event_id"
        ).fetchall()
    )
    if observed_event_ids != expected_event_ids:
        raise RuntimeError("Event identity migration changed event ordering or identity")
    sequence_row = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'job_events'"
    ).fetchone()
    if (
        sequence_row is None
        or int(sequence_row[0]) != expected_sequence_high_water
    ):
        raise RuntimeError("Event identity migration changed the event ID high-water")
    invalid_identity_version = conn.execute(
        "SELECT event_id FROM job_events WHERE identity_version != ? LIMIT 1",
        (EVENT_IDENTITY_UPCAST_VERSION,),
    ).fetchone()
    if invalid_identity_version is not None:
        raise RuntimeError("Event identity migration left an invalid identity version")
    orphan = conn.execute(
        """
        SELECT events.event_id
        FROM job_events AS events
        LEFT JOIN jobs
          ON jobs.tenant_id = events.tenant_id
         AND jobs.job_id = events.job_id
        WHERE events.job_id IS NOT NULL
          AND jobs.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if orphan is not None:
        raise RuntimeError("Event identity migration left an unresolved JobId")
    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError("Event identity migration found a foreign-key violation")


__all__ = [
    "canonical_v6_event_rows",
    "parse_v6_event_payload",
    "restore_job_event_sequence",
    "transform_v6_job_events",
    "verify_v7_job_events",
]
