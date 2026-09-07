"""The producer's activity stop must leave its jobs available to the terminal pass."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from jobctrl.database import init_db
from jobctrl.discovery.activities import DiscoveryEnrichmentActivityInput, discovery_enrichment_activity
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment.detail import (
    _queue_enrichment_cohort,
    _settle_interrupted_enrichment_cohort,
    cancel_enrichment_cohort,
)
from jobctrl.state import ensure_job_stage_rows


def test_live_activity_stop_preserves_the_terminal_enrichment_cohort(tmp_path, monkeypatch):
    conn = init_db(tmp_path / "handoff.db")
    job_id = JobId("10000000-0000-4000-8000-000000000001")
    execution = DiscoveryExecutionRef(tenant_id="local", workflow_id="discover-local", temporal_run_id="run-1")
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site) VALUES ('local', ?, ?, ?, 'linkedin')",
        (str(job_id), "https://www.linkedin.com/jobs/view/1234567890", "Engineering lead"),
    )
    ensure_job_stage_rows(conn, job_id)
    conn.commit()
    _queue_enrichment_cohort(
        conn,
        (job_id,),
        tenant_id=LOCAL_TENANT,
        workflow_id=execution.workflow_id,
        workflow_run_id=execution.temporal_run_id,
    )

    def stop_live_consumer(**kwargs):
        _settle_interrupted_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=execution.workflow_id,
            workflow_run_id=execution.temporal_run_id,
            cancel_event=kwargs["cancel_event"],
        )
        return {"status": "ok"}

    async def stop_then_run(fn, *, on_cancel, **_kwargs):
        on_cancel()
        return fn()

    monkeypatch.setattr("jobctrl.pipeline.runner.run_discovery_enrichment_stage", stop_live_consumer)
    monkeypatch.setattr("jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat", stop_then_run)
    monkeypatch.setattr("jobctrl.discovery.activities.activity.heartbeat", lambda *_args: None)
    monkeypatch.setattr(
        "jobctrl.enrichment.activities.activity.cancellation_details", lambda: SimpleNamespace(cancel_requested=True)
    )
    asyncio.run(
        discovery_enrichment_activity(
            DiscoveryEnrichmentActivityInput(
                tenant_id="local",
                stream_while_discovering=True,
                discovery_execution=execution,
            )
        )
    )

    stage = conn.execute(
        "SELECT state, attempt_count FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(job_id),)
    ).fetchone()
    assert tuple(stage) == ("pending", 0)
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type = 'StageCanceled'").fetchone()[0] == 0
    # The real terminal selector can reclaim the released job under the same run.
    _queue_enrichment_cohort(
        conn,
        (job_id,),
        tenant_id=LOCAL_TENANT,
        workflow_id=execution.workflow_id,
        workflow_run_id=execution.temporal_run_id,
    )
    assert (
        conn.execute(
            "SELECT state FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(job_id),)
        ).fetchone()[0]
        == "queued"
    )

    # A real workflow cancellation still terminalizes that exact cohort.
    assert (
        cancel_enrichment_cohort(
            conn,
            (job_id,),
            tenant_id=LOCAL_TENANT,
            workflow_id=execution.workflow_id,
            workflow_run_id=execution.temporal_run_id,
        )
        == 1
    )
    assert (
        conn.execute(
            "SELECT state FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'", (str(job_id),)
        ).fetchone()[0]
        == "canceled"
    )
    conn.close()
