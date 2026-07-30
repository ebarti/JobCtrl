"""Durable proof contract for the stable-identity cutover inventory.

The exact-run preflight cannot infer that a local inventory is complete merely
because a projection or dispatch table is empty. A preceding recovery step must
backfill every pre-fence Temporal execution into the dispatch registry, stop the
supported JobCtrl worker processes, and seal the resulting registry and worker
inventories for the current fence epoch.

This module validates that seal. It deliberately does not create one: proof
creation belongs to the later recovery/handoff step that can inspect Temporal
and verify process shutdown.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from typing import Any

CONTROL_KEY = "stable-job-id-cutover"
INVENTORY_PROOF_VERSION = 1
INVENTORY_PROOF_TABLE = "workflow_identity_cutover_inventory_proof"
WORKER_HEARTBEAT_TABLE = "worker_runtime_heartbeats"


@dataclass(frozen=True)
class InventoryFingerprint:
    digest: str
    entry_count: int


@dataclass(frozen=True)
class InventoryProofObservation:
    state: str
    detail: str | None = None

    @property
    def valid(self) -> bool:
        return self.state == "valid"


def validate_identity_cutover_inventory_proof(
    conn: sqlite3.Connection,
    *,
    fence_blocked_at: str | None,
) -> InventoryProofObservation:
    """Validate the recovery seal and current worker-process quiescence."""

    if not fence_blocked_at:
        return InventoryProofObservation("missing_fence_epoch")
    tables = _table_names(conn)
    if INVENTORY_PROOF_TABLE not in tables:
        return InventoryProofObservation("proof_table_missing")
    row = conn.execute(
        f"""
        SELECT proof_version, fence_blocked_at,
               registry_inventory_digest, registry_entry_count,
               worker_inventory_digest, worker_entry_count,
               worker_quiescent_at
        FROM {INVENTORY_PROOF_TABLE}
        WHERE control_key = ?
        """,
        (CONTROL_KEY,),
    ).fetchone()
    if row is None:
        return InventoryProofObservation("proof_missing")

    proof_version = _integer(row[0])
    if proof_version != INVENTORY_PROOF_VERSION:
        return InventoryProofObservation(
            "proof_version_unsupported",
            str(proof_version),
        )
    if str(row[1] or "") != fence_blocked_at:
        return InventoryProofObservation("proof_fence_epoch_mismatch")
    if not str(row[6] or "").strip():
        return InventoryProofObservation("worker_quiescence_unproven")

    registry = registry_inventory_fingerprint(conn)
    if str(row[2] or "") != registry.digest or _integer(row[3]) != registry.entry_count:
        return InventoryProofObservation("registry_inventory_changed")

    worker = worker_inventory_fingerprint(conn)
    if str(row[4] or "") != worker.digest or _integer(row[5]) != worker.entry_count:
        return InventoryProofObservation("worker_inventory_changed")

    live_worker = _live_local_worker(conn)
    if live_worker is not None:
        return InventoryProofObservation("worker_process_live", live_worker)
    return InventoryProofObservation("valid")


def registry_inventory_fingerprint(
    conn: sqlite3.Connection,
) -> InventoryFingerprint:
    """Hash the complete dispatch registry in stable row order."""

    rows = conn.execute(
        """
        SELECT launch_id, workflow_id, temporal_run_id,
               workflow_type, state, created_at, updated_at
        FROM workflow_dispatch_registry
        ORDER BY launch_id
        """
    ).fetchall()
    return _fingerprint(rows)


def worker_inventory_fingerprint(
    conn: sqlite3.Connection,
) -> InventoryFingerprint:
    """Hash worker identities and their last exact activity observations."""

    if WORKER_HEARTBEAT_TABLE not in _table_names(conn):
        return _fingerprint(())
    columns = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({WORKER_HEARTBEAT_TABLE})").fetchall()}
    selected = (
        "worker_id",
        "component",
        "pid",
        "hostname",
        "app_dir",
        "db_path",
        "task_queue",
        "started_at",
        "last_seen_at",
        "active_activity_count",
        "heartbeat_schema_version",
    )
    expressions = [column if column in columns else f"NULL AS {column}" for column in selected]
    rows = conn.execute(
        f"""
        SELECT {", ".join(expressions)}
        FROM {WORKER_HEARTBEAT_TABLE}
        ORDER BY worker_id
        """
    ).fetchall()
    return _fingerprint(rows)


def _live_local_worker(conn: sqlite3.Connection) -> str | None:
    if WORKER_HEARTBEAT_TABLE not in _table_names(conn):
        return None
    columns = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({WORKER_HEARTBEAT_TABLE})").fetchall()}
    required = {"worker_id", "component", "pid", "hostname"}
    if not required.issubset(columns):
        return "heartbeat_schema_incomplete"
    rows = conn.execute(
        f"""
        SELECT worker_id, pid, hostname
        FROM {WORKER_HEARTBEAT_TABLE}
        WHERE component = 'temporal-worker'
        ORDER BY worker_id
        """
    ).fetchall()
    for worker_id, raw_pid, _hostname in rows:
        # Hostname is descriptive provenance, not a liveness authority. It can
        # drift while a worker process remains alive, and a restored heartbeat
        # can reuse a local PID. Both cases must block until recovery explicitly
        # retires the stale worker identity.
        pid = _integer(raw_pid)
        if pid > 0 and _pid_is_alive(pid):
            return str(worker_id or pid)
    return None


def _pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _fingerprint(rows: Any) -> InventoryFingerprint:
    normalized = [[value for value in tuple(row)] for row in rows]
    payload = json.dumps(
        normalized,
        sort_keys=False,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return InventoryFingerprint(
        digest=hashlib.sha256(payload).hexdigest(),
        entry_count=len(normalized),
    )


def _integer(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            """
        ).fetchall()
    }


__all__ = [
    "CONTROL_KEY",
    "INVENTORY_PROOF_TABLE",
    "INVENTORY_PROOF_VERSION",
    "InventoryFingerprint",
    "InventoryProofObservation",
    "registry_inventory_fingerprint",
    "validate_identity_cutover_inventory_proof",
    "worker_inventory_fingerprint",
]
