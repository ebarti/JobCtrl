from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from jobctrl import cli
from jobctrl.discovery import execution_reconciliation
from jobctrl.discovery.execution_reconciliation import LegacyDiscoveryRecoveryError


def test_worker_heartbeat_loop_retries_after_iteration_failure(monkeypatch):
    calls: list[tuple[str, str, datetime | None, int | None]] = []

    class StopLoop(BaseException):
        pass

    def iteration(
        task_queue: str,
        worker_id: str,
        *,
        worker_started_at: datetime | None = None,
        max_concurrent_activities: int | None = None,
        activity_snapshot=None,
        task_queue_observation=None,
    ) -> tuple[int, int]:
        assert activity_snapshot is None
        assert task_queue_observation is None
        calls.append((task_queue, worker_id, worker_started_at, max_concurrent_activities))
        if len(calls) == 1:
            raise sqlite3.OperationalError("database is locked")
        if len(calls) == 3:
            raise StopLoop
        return (0, 0)

    async def no_sleep(_seconds: float) -> None:
        return None

    started_at = datetime(2026, 6, 6, 13, 40, tzinfo=UTC)
    monkeypatch.setattr(cli, "_worker_heartbeat_iteration", iteration)
    monkeypatch.setattr(cli.asyncio, "sleep", no_sleep)

    with pytest.raises(StopLoop):
        asyncio.run(
            cli._worker_heartbeat_loop(
                "jobctrl-default",
                "worker-test",
                worker_started_at=started_at,
                max_concurrent_activities=7,
                interval_seconds=0,
            )
        )

    assert calls == [
        ("jobctrl-default", "worker-test", started_at, 7),
        ("jobctrl-default", "worker-test", started_at, 7),
        ("jobctrl-default", "worker-test", started_at, 7),
    ]


def _recovery_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE workflow_run_projections (
            workflow_id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            workflow_type TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            temporal_run_id TEXT
        );
        CREATE TABLE discovery_execution_jobs (
            tenant_id TEXT NOT NULL,
            discover_workflow_id TEXT NOT NULL,
            discover_run_id TEXT NOT NULL,
            job_id TEXT NOT NULL
        );
        CREATE TABLE pipeline_step_projections (
            tenant_id TEXT NOT NULL,
            discover_workflow_id TEXT NOT NULL,
            discover_run_id TEXT NOT NULL,
            step_kind TEXT NOT NULL,
            item_key TEXT NOT NULL
        );
        CREATE TABLE discovery_execution_recoveries (
            tenant_id TEXT NOT NULL,
            discover_workflow_id TEXT NOT NULL,
            discover_run_id TEXT NOT NULL,
            state TEXT NOT NULL,
            mode TEXT NOT NULL,
            decoder_version INTEGER NOT NULL,
            history_event_id INTEGER NOT NULL,
            expected_membership_count INTEGER NOT NULL,
            persisted_membership_count INTEGER NOT NULL,
            expected_step_count INTEGER NOT NULL,
            persisted_step_count INTEGER NOT NULL,
            key_digest TEXT NOT NULL,
            last_error_code TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, discover_workflow_id, discover_run_id)
        );
        """
    )
    return conn


def test_recovery_candidates_keep_open_runs_and_only_latest_incomplete_terminal() -> None:
    conn = _recovery_connection()
    rows = (
        ("discover-open", "in_progress", "2026-07-16T10:00:00Z", "run-open"),
        ("discover-latest", "succeeded", "2026-07-16T09:00:00Z", "run-latest"),
        ("discover-old", "failed", "2026-07-16T08:00:00Z", "run-old"),
    )
    conn.executemany(
        """
        INSERT INTO workflow_run_projections (
            workflow_id, tenant_id, workflow_type, status, started_at, temporal_run_id
        ) VALUES (?, 'local', 'DiscoverWorkflow', ?, ?, ?)
        """,
        rows,
    )
    # An open execution remains retryable while its exact history can grow,
    # even after partial durable recovery.
    for table in ("discovery_execution_jobs", "pipeline_step_projections"):
        if table == "discovery_execution_jobs":
            conn.execute(
                f"INSERT INTO {table} VALUES "
                "('local', 'discover-open', 'run-open', '11111111-1111-4111-8111-111111111111')"
            )
        else:
            conn.execute(
                f"INSERT INTO {table} VALUES ('local', 'discover-open', 'run-open', 'source_planning', 'plan')"
            )

    assert cli._legacy_discovery_recovery_candidates(conn, tenant_id="local") == [
        {"workflow_id": "discover-open", "temporal_run_id": "run-open"},
        {"workflow_id": "discover-latest", "temporal_run_id": "run-latest"},
    ]


def test_recovery_candidates_skip_ready_latest_terminal_checkpoint() -> None:
    conn = _recovery_connection()
    conn.execute(
        """
        INSERT INTO workflow_run_projections (
            workflow_id, tenant_id, workflow_type, status, started_at, temporal_run_id
        ) VALUES ('discover-done', 'local', 'DiscoverWorkflow', 'succeeded',
                  '2026-07-16T09:00:00Z', 'run-done')
        """
    )
    digest = execution_reconciliation._recovery_key_digest(set(), set())
    conn.execute(
        """
        INSERT INTO discovery_execution_recoveries VALUES (
            'local', 'discover-done', 'run-done', 'ready', 'native', 3, 12,
            0, 0, 0, 0, ?, NULL, '2026-07-16T09:01:00Z'
        )
        """,
        (digest,),
    )

    assert cli._legacy_discovery_recovery_candidates(conn, tenant_id="local") == []


def test_recovery_candidates_skip_terminal_incomplete_checkpoint() -> None:
    conn = _recovery_connection()
    conn.execute(
        """
        INSERT INTO workflow_run_projections (
            workflow_id, tenant_id, workflow_type, status, started_at, temporal_run_id
        ) VALUES ('discover-incomplete', 'local', 'DiscoverWorkflow', 'failed',
                  '2026-07-16T09:00:00Z', 'run-incomplete')
        """
    )
    digest = execution_reconciliation._recovery_key_digest({"22222222-2222-4222-8222-222222222222"}, set())
    conn.execute(
        "INSERT INTO discovery_execution_jobs VALUES "
        "('local', 'discover-incomplete', 'run-incomplete', "
        "'22222222-2222-4222-8222-222222222222')"
    )
    conn.execute(
        """
        INSERT INTO discovery_execution_recoveries VALUES (
            'local', 'discover-incomplete', 'run-incomplete', 'incomplete',
            'reconstructed', 2, 12, 1, 1, 0, 0, ?,
            'legacy-fanout-terminal-failed', '2026-07-16T09:01:00Z'
        )
        """,
        (digest,),
    )

    assert cli._legacy_discovery_recovery_candidates(conn, tenant_id="local") == []


def test_recovery_candidates_repair_stale_ready_checkpoint() -> None:
    conn = _recovery_connection()
    conn.execute(
        """
        INSERT INTO workflow_run_projections (
            workflow_id, tenant_id, workflow_type, status, started_at, temporal_run_id
        ) VALUES ('discover-stale', 'local', 'DiscoverWorkflow', 'succeeded',
                  '2026-07-16T09:00:00Z', 'run-stale')
        """
    )
    conn.execute(
        """
        INSERT INTO discovery_execution_jobs VALUES (
            'local', 'discover-stale', 'run-stale',
            '33333333-3333-4333-8333-333333333333'
        )
        """
    )
    stale_digest = execution_reconciliation._recovery_key_digest({"44444444-4444-4444-8444-444444444444"}, set())
    conn.execute(
        """
        INSERT INTO discovery_execution_recoveries VALUES (
            'local', 'discover-stale', 'run-stale', 'ready', 'native', 1, 12,
            1, 1, 0, 0, ?, NULL, '2026-07-16T09:01:00Z'
        )
        """,
        (stale_digest,),
    )

    assert cli._legacy_discovery_recovery_candidates(conn, tenant_id="local") == [
        {"workflow_id": "discover-stale", "temporal_run_id": "run-stale"}
    ]


def test_recovery_candidates_do_not_infer_readiness_from_projection_counts() -> None:
    conn = _recovery_connection()
    conn.execute(
        """
        INSERT INTO workflow_run_projections (
            workflow_id, tenant_id, workflow_type, status, started_at, temporal_run_id
        ) VALUES ('discover-partial', 'local', 'DiscoverWorkflow', 'failed',
                  '2026-07-16T09:00:00Z', 'run-partial')
        """
    )
    conn.execute(
        "INSERT INTO discovery_execution_jobs VALUES "
        "('local', 'discover-partial', 'run-partial', "
        "'22222222-2222-4222-8222-222222222222')"
    )
    conn.execute(
        "INSERT INTO pipeline_step_projections VALUES "
        "('local', 'discover-partial', 'run-partial', 'source_planning', 'plan')"
    )

    assert cli._legacy_discovery_recovery_candidates(conn, tenant_id="local") == [
        {"workflow_id": "discover-partial", "temporal_run_id": "run-partial"}
    ]


@pytest.mark.asyncio
async def test_recovery_isolates_ambiguous_run_and_continues(monkeypatch) -> None:
    candidates = [
        {"workflow_id": "discover-ambiguous", "temporal_run_id": "run-a"},
        {"workflow_id": "discover-exact", "temporal_run_id": "run-b"},
    ]
    calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        cli,
        "_legacy_discovery_recovery_candidates",
        lambda _conn, *, tenant_id: candidates,
    )

    async def reconcile(_client, *, workflow_id, temporal_run_id, **_kwargs):
        calls.append((workflow_id, temporal_run_id))
        if workflow_id == "discover-ambiguous":
            raise LegacyDiscoveryRecoveryError("source_run_mapping_not_unique")
        return SimpleNamespace(
            activities_recovered=3,
            jobs_linked=2,
            work_plans_recovered=2,
        )

    monkeypatch.setattr(
        execution_reconciliation,
        "reconcile_legacy_discovery_execution",
        reconcile,
    )

    changed = await cli._reconcile_legacy_discovery_executions(
        object(),
        tenant_id="local",
        conn=object(),
    )

    assert changed == 1
    assert calls == [
        ("discover-ambiguous", "run-a"),
        ("discover-exact", "run-b"),
    ]


def test_heartbeat_retries_legacy_recovery_periodically(monkeypatch) -> None:
    class StopLoop(BaseException):
        pass

    async def no_sleep(_seconds: float) -> None:
        return None

    async def no_queue_observation(_client, _queue):
        return None

    async def no_workflow_changes(_client):
        return 0

    async def stop_from_recovery(_client):
        raise StopLoop

    monkeypatch.setattr(cli.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(cli, "_safe_task_queue_observation", no_queue_observation)
    monkeypatch.setattr(cli, "_worker_heartbeat_iteration", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(cli, "_reconcile_workflow_runs", no_workflow_changes)
    monkeypatch.setattr(cli, "_reconcile_legacy_discovery_executions", stop_from_recovery)

    with pytest.raises(StopLoop):
        asyncio.run(
            cli._worker_heartbeat_loop(
                "jobctrl-default",
                "worker-test",
                interval_seconds=0,
                temporal_client=object(),
            )
        )
