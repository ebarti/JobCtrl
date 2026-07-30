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
    InventoryProofIdentity,
    registry_inventory_fingerprint,
    validate_identity_cutover_inventory_proof,
    worker_inventory_fingerprint,
)
from jobctrl.infrastructure.temporal.workflow_dispatch_control import (
    ensure_workflow_dispatch_control_tables,
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


def _seal(
    db_path: Path,
    *,
    proof_id: str = "proof-one",
    temporal_namespace: str = "default",
    temporal_namespace_id: str = "namespace-id-one",
    authority_workflow_id: str = "cutover-authority-marker",
    authority_run_id: str = "marker-run-one",
) -> None:
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
                control_key, proof_version, proof_id, fence_blocked_at,
                registry_inventory_digest, registry_entry_count,
                worker_inventory_digest, worker_entry_count,
                worker_quiescent_at, temporal_namespace,
                temporal_namespace_id, authority_workflow_id,
                authority_run_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                CONTROL_KEY,
                INVENTORY_PROOF_VERSION,
                proof_id,
                fence_blocked_at,
                registry.digest,
                registry.entry_count,
                workers.digest,
                workers.entry_count,
                "2026-07-30T00:00:01+00:00",
                temporal_namespace,
                temporal_namespace_id,
                authority_workflow_id,
                authority_run_id,
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
    assert result.identity == InventoryProofIdentity(
        proof_id="proof-one",
        fence_blocked_at=_fence_epoch(db_path),
        temporal_namespace="default",
        temporal_namespace_id="namespace-id-one",
        authority_workflow_id="cutover-authority-marker",
        authority_run_id="marker-run-one",
    )


@pytest.mark.parametrize(
    ("field", "expected_state"),
    [
        ("proof_id", "proof_identity_missing"),
        ("temporal_namespace", "temporal_authority_unproven"),
        ("temporal_namespace_id", "temporal_authority_unproven"),
        ("authority_workflow_id", "temporal_authority_unproven"),
        ("authority_run_id", "temporal_authority_unproven"),
    ],
)
def test_inventory_proof_requires_generation_and_temporal_authority(
    db_path: Path,
    field: str,
    expected_state: str,
) -> None:
    _block(db_path)
    values = {
        "proof_id": "proof-one",
        "temporal_namespace": "default",
        "temporal_namespace_id": "namespace-id-one",
        "authority_workflow_id": "cutover-authority-marker",
        "authority_run_id": "marker-run-one",
    }
    values[field] = ""
    _seal(db_path, **values)

    with sqlite3.connect(db_path) as conn:
        result = validate_identity_cutover_inventory_proof(
            conn,
            fence_blocked_at=_fence_epoch(db_path),
        )

    assert result.state == expected_state
    assert result.identity is None


def test_control_table_upgrade_adds_fail_closed_proof_authority_columns(
    tmp_path: Path,
) -> None:
    path = tmp_path / "legacy-proof.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE workflow_identity_cutover_inventory_proof (
                control_key                TEXT PRIMARY KEY,
                proof_version              INTEGER NOT NULL,
                fence_blocked_at            TEXT NOT NULL,
                registry_inventory_digest  TEXT NOT NULL,
                registry_entry_count       INTEGER NOT NULL,
                worker_inventory_digest    TEXT NOT NULL,
                worker_entry_count         INTEGER NOT NULL,
                worker_quiescent_at         TEXT NOT NULL,
                created_at                  TEXT NOT NULL
            )
            """
        )
        ensure_workflow_dispatch_control_tables(conn)
        columns = {
            str(row[1]): str(row[4] or "")
            for row in conn.execute(
                """
                PRAGMA table_info(workflow_identity_cutover_inventory_proof)
                """
            )
        }

    assert columns["proof_id"] == "''"
    assert columns["temporal_namespace"] == "''"
    assert columns["temporal_namespace_id"] == "''"
    assert columns["authority_workflow_id"] == "''"
    assert columns["authority_run_id"] == "''"


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
