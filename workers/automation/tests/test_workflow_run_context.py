"""Canonical run ownership on events emitted during Temporal-run work.

Regression coverage for the run-drawer "Review activity" invariant: events a
workflow run actually produces must carry that run's canonical ``workflowId``
in their payload, across the activity's blocking executor hop and per-stage
thread fan-out.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import dataclasses
from pathlib import Path

import pytest
from temporalio.testing import ActivityEnvironment

from jobctrl.database import init_db
from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
from jobctrl.infrastructure.workflow_run_context import (
    carry_workflow_run_context,
    current_workflow_id,
    workflow_run_context,
)
from jobctrl.state import record_job_event


class _NullPublisher:
    def publish(self, _event) -> None:  # noqa: ANN001 — matches EventPublisher port
        return None


def _event_payload_workflow_ids(conn) -> list[tuple[str, str | None]]:
    rows = conn.execute(
        """
        SELECT event_type, json_extract(payload_json, '$.workflowId') AS workflow_id
        FROM job_events
        ORDER BY event_id
        """
    ).fetchall()
    return [(row["event_type"], row["workflow_id"]) for row in rows]


def test_current_workflow_id_is_none_outside_any_run() -> None:
    assert current_workflow_id() is None


def test_workflow_run_context_binds_and_restores() -> None:
    with workflow_run_context("pipeline-outer"):
        assert current_workflow_id() == "pipeline-outer"
        with workflow_run_context("pipeline-inner"):
            assert current_workflow_id() == "pipeline-inner"
        assert current_workflow_id() == "pipeline-outer"
    assert current_workflow_id() is None


def test_carry_workflow_run_context_rebinds_in_pool_threads() -> None:
    with workflow_run_context("pipeline-fanout-wf"):
        probe = carry_workflow_run_context(current_workflow_id)
    with ThreadPoolExecutor(max_workers=1) as executor:
        # Fresh pool threads have no ambient context of their own.
        assert executor.submit(current_workflow_id).result() is None
        # The wrapper carries the submitting activity's owning run across.
        assert executor.submit(probe).result() == "pipeline-fanout-wf"


def test_record_job_event_stamps_ambient_run_ownership(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "run-context.db")
    publisher = _NullPublisher()
    with workflow_run_context("pipeline-run-owner"):
        record_job_event(
            conn,
            None,
            "score",
            "StageStarted",
            message="score stage started",
            publisher=publisher,
        )
        record_job_event(
            conn,
            None,
            "score",
            "StageCompleted",
            message="explicit ownership wins",
            payload={"workflowId": "explicit-owner"},
            publisher=publisher,
        )
        record_job_event(
            conn,
            None,
            "score",
            "StageFailed",
            message="snake-case ownership is respected",
            payload={"workflow_id": "explicit-snake-owner"},
            publisher=publisher,
        )
    record_job_event(
        conn,
        None,
        "score",
        "StageProgress",
        message="outside any run",
        publisher=publisher,
    )
    conn.commit()

    assert _event_payload_workflow_ids(conn) == [
        ("StageStarted", "pipeline-run-owner"),
        ("StageCompleted", "explicit-owner"),
        ("StageFailed", None),
        ("StageProgress", None),
    ]


@pytest.mark.asyncio
async def test_run_blocking_with_heartbeat_carries_the_owning_workflow_id() -> None:
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, workflow_id="pipeline-blocking-wf")

    async def probe() -> tuple[str | None, str | None]:
        blocking = await run_blocking_with_heartbeat(
            current_workflow_id,
            starting_message="ownership probe starting",
            activity_name="ownership_probe",
        )

        def fanout() -> str | None:
            owned = carry_workflow_run_context(current_workflow_id)
            with ThreadPoolExecutor(max_workers=1) as executor:
                return executor.submit(owned).result()

        nested = await run_blocking_with_heartbeat(
            fanout,
            starting_message="fanout probe starting",
            activity_name="ownership_fanout_probe",
        )
        return blocking, nested

    assert await env.run(probe) == ("pipeline-blocking-wf", "pipeline-blocking-wf")
