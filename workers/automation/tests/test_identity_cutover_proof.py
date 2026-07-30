from __future__ import annotations

import os
import socket
import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.temporal.identity_cutover_proof import (
    CONTROL_KEY,
    INVENTORY_PROOF_VERSION,
    registry_inventory_fingerprint,
    validate_identity_cutover_inventory_proof,
    worker_inventory_fingerprint,
)
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    set_workflow_dispatches_blocked,
)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "jobctrl.db"
    conn = init_db(path)
    conn.commit()
    close_connection(path)
    return path


def _fence_epoch(db_path: Path) -> str:
    with sqlite3.connect(db_path) as conn:
        return str(
            conn.execute(
                """
                SELECT blocked_at
                FROM workflow_dispatch_control
                WHERE control_key = ?
                """,
                (CONTROL_KEY,),
            ).fetchone()[0]
        )


def _seal(db_path: Path) -> None:
    with sqlite3.connect(db_path) as conn:
        registry = registry_inventory_fingerprint(conn)
        workers = worker_inventory_fingerprint(conn)
        fence_blocked_at = str(
            conn.execute(
                """
                SELECT blocked_at
                FROM workflow_dispatch_control
                WHERE control_key = ?
                """,
                (CONTROL_KEY,),
            ).fetchone()[0]
        )
        conn.execute(
            """
            INSERT INTO workflow_identity_cutover_inventory_proof (
                control_key, proof_version, fence_blocked_at,
                registry_inventory_digest, registry_entry_count,
                worker_inventory_digest, worker_entry_count,
                worker_quiescent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                CONTROL_KEY,
                INVENTORY_PROOF_VERSION,
                fence_blocked_at,
                registry.digest,
                registry.entry_count,
                workers.digest,
                workers.entry_count,
                "2026-07-30T00:00:01+00:00",
                "2026-07-30T00:00:01+00:00",
            ),
        )


def _block(db_path: Path) -> None:
    set_workflow_dispatches_blocked(
        blocked=True,
        reason="identity-cutover",
        db_path=db_path,
    )


def test_inventory_proof_is_missing_until_recovery_seals_current_fence(
    db_path: Path,
) -> None:
    _block(db_path)

    with sqlite3.connect(db_path) as conn:
        result = validate_identity_cutover_inventory_proof(
            conn,
            fence_blocked_at=_fence_epoch(db_path),
        )

    assert result.state == "proof_missing"


def test_inventory_proof_validates_exact_registry_and_worker_inventories(
    db_path: Path,
) -> None:
    _block(db_path)
    _seal(db_path)

    with sqlite3.connect(db_path) as conn:
        result = validate_identity_cutover_inventory_proof(
            conn,
            fence_blocked_at=_fence_epoch(db_path),
        )

    assert result.valid is True


def test_inventory_proof_fails_after_registry_membership_changes(
    db_path: Path,
) -> None:
    _block(db_path)
    _seal(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO workflow_dispatch_registry (
                launch_id, workflow_id, temporal_run_id,
                workflow_type, state, created_at, updated_at
            ) VALUES (
                'late-launch', 'late-workflow', NULL,
                'JobPipelineWorkflow', 'uncertain', ?, ?
            )
            """,
            (
                "2026-07-30T00:00:02+00:00",
                "2026-07-30T00:00:02+00:00",
            ),
        )

    with sqlite3.connect(db_path) as conn:
        result = validate_identity_cutover_inventory_proof(
            conn,
            fence_blocked_at=_fence_epoch(db_path),
        )

    assert result.state == "registry_inventory_changed"


def test_reactivating_fence_invalidates_prior_inventory_proof(
    db_path: Path,
) -> None:
    _block(db_path)
    _seal(db_path)

    _block(db_path)

    with sqlite3.connect(db_path) as conn:
        proof_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM workflow_identity_cutover_inventory_proof
            """
        ).fetchone()[0]

    assert proof_count == 0


@pytest.mark.parametrize(
    "recorded_hostname",
    [
        socket.gethostname(),
        "hostname-before-local-drift",
    ],
)
def test_inventory_proof_cannot_certify_a_live_worker_pid(
    db_path: Path,
    recorded_hostname: str,
) -> None:
    _block(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE worker_runtime_heartbeats (
                worker_id TEXT PRIMARY KEY,
                component TEXT NOT NULL,
                pid INTEGER NOT NULL,
                hostname TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO worker_runtime_heartbeats (
                worker_id, component, pid, hostname
            ) VALUES (?, 'temporal-worker', ?, ?)
            """,
            ("live-worker", os.getpid(), recorded_hostname),
        )
    _seal(db_path)

    with sqlite3.connect(db_path) as conn:
        result = validate_identity_cutover_inventory_proof(
            conn,
            fence_blocked_at=_fence_epoch(db_path),
        )

    assert result.state == "worker_process_live"
    assert result.detail == "live-worker"
