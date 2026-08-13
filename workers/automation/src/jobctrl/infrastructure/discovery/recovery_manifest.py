"""Keep native Discover recovery proofs aligned with canonical live writes.

The Temporal history reconciler proves the historical boundary.  After that
boundary, native writers carry the exact Discover execution identity and can
advance the same key-set proof in their own transaction.  Reconstructed
histories remain owned exclusively by the reconciler.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Iterable
from datetime import UTC, datetime


CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION = 3


def recovery_key_digest(
    membership_keys: Iterable[str],
    step_keys: Iterable[tuple[str, str]],
) -> str:
    """Return the cross-runtime digest for one execution's exact key sets."""

    def key_hex(value: str) -> str:
        return value.encode("utf-8").hex()

    canonical = json.dumps(
        {
            "memberships": sorted(key_hex(value) for value in set(membership_keys)),
            "steps": sorted(
                key_hex(
                    json.dumps(
                        [step_kind, item_key],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )
                for step_kind, item_key in set(step_keys)
            ),
        },
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def advance_ready_native_recovery_manifest(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
    updated_at: str | None = None,
) -> bool:
    """Advance one verified native proof inside the caller's transaction.

    Missing recovery/projection tables mean the repository is running against
    a deliberately minimal compatibility fixture and therefore has no proof to
    advance.  Other database errors are allowed to escape so the canonical
    write and its proof roll back together.
    """

    try:
        manifest = conn.execute(
            """
            SELECT state, mode, decoder_version
            FROM discovery_execution_recoveries
            WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
            """,
            (tenant_id, workflow_id, temporal_run_id),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        if _is_missing_table(exc):
            return False
        raise
    if manifest is None:
        return False

    state = str(_row_value(manifest, "state", 0))
    mode = str(_row_value(manifest, "mode", 1))
    try:
        decoder_version = int(_row_value(manifest, "decoder_version", 2))
    except (TypeError, ValueError):
        return False
    if state != "ready" or mode != "native" or decoder_version != CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION:
        return False

    memberships = _membership_keys(conn, tenant_id, workflow_id, temporal_run_id)
    steps = _step_keys(conn, tenant_id, workflow_id, temporal_run_id)
    membership_count = len(memberships)
    step_count = len(steps)
    cursor = conn.execute(
        """
        UPDATE discovery_execution_recoveries
        SET expected_membership_count = ?, persisted_membership_count = ?,
            expected_step_count = ?, persisted_step_count = ?,
            key_digest = ?, last_error_code = NULL, updated_at = ?
        WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
          AND state = 'ready' AND mode = 'native' AND decoder_version = ?
        """,
        (
            membership_count,
            membership_count,
            step_count,
            step_count,
            recovery_key_digest(memberships, steps),
            updated_at or datetime.now(UTC).isoformat(),
            tenant_id,
            workflow_id,
            temporal_run_id,
            CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION,
        ),
    )
    return bool(cursor.rowcount)


def advance_ready_native_recovery_manifests_for_tenant(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    updated_at: str | None = None,
) -> int:
    """Advance every ready native proof after a tenant step-projection fold."""

    try:
        rows = conn.execute(
            """
            SELECT discover_workflow_id, discover_run_id
            FROM discovery_execution_recoveries
            WHERE tenant_id = ? AND state = 'ready' AND mode = 'native'
              AND decoder_version = ?
            """,
            (tenant_id, CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        if _is_missing_table(exc):
            return 0
        raise

    changed = 0
    for row in rows:
        workflow_id = str(_row_value(row, "discover_workflow_id", 0))
        temporal_run_id = str(_row_value(row, "discover_run_id", 1))
        changed += int(
            advance_ready_native_recovery_manifest(
                conn,
                tenant_id=tenant_id,
                workflow_id=workflow_id,
                temporal_run_id=temporal_run_id,
                updated_at=updated_at,
            )
        )
    return changed


def _membership_keys(
    conn: sqlite3.Connection,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> set[str]:
    rows = conn.execute(
        """
        SELECT job_id FROM discovery_execution_jobs
        WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
        """,
        (tenant_id, workflow_id, temporal_run_id),
    ).fetchall()
    return {str(_row_value(row, "job_id", 0)) for row in rows}


def _step_keys(
    conn: sqlite3.Connection,
    tenant_id: str,
    workflow_id: str,
    temporal_run_id: str,
) -> set[tuple[str, str]]:
    try:
        rows = conn.execute(
            """
            SELECT step_kind, item_key FROM pipeline_step_projections
            WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
            """,
            (tenant_id, workflow_id, temporal_run_id),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        if _is_missing_table(exc):
            return set()
        raise
    return {
        (
            str(_row_value(row, "step_kind", 0)),
            str(_row_value(row, "item_key", 1)),
        )
        for row in rows
    }


def _row_value(row: object, key: str, index: int) -> object:
    if isinstance(row, sqlite3.Row):
        return row[key]
    return row[index]  # type: ignore[index]


def _is_missing_table(exc: sqlite3.OperationalError) -> bool:
    return "no such table" in str(exc).lower()


__all__ = [
    "CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION",
    "advance_ready_native_recovery_manifest",
    "advance_ready_native_recovery_manifests_for_tenant",
    "recovery_key_digest",
]
