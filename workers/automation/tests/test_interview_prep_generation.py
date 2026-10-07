"""Mechanical interview identity, events, runtime and material-read boundaries."""

from __future__ import annotations


import asyncio


import json


import threading


from pathlib import Path


from types import SimpleNamespace


from typing import Any


import pytest


from jobctrl.database import close_connection, get_connection


from jobctrl.domain.events import (
    InterviewPrepFailedPayload,
    InterviewPrepGeneratedPayload,
    create_interview_prep_failed,
    create_interview_prep_generated,
)


from jobctrl.domain.identifiers import JobId


from jobctrl.domain.tenant import LOCAL_TENANT, TenantId


from jobctrl.infrastructure.migrations.schema_v13 import create_exact_v13_schema


from jobctrl.interview import activities as interview_activities


from jobctrl.interview.activities import (
    GenerateInterviewPrepActivityInput,
    GenerateInterviewPrepActivityOutput,
    InterviewPrepEventRecorder,
    generate_interview_prep_activity,
)


from jobctrl.interview import workflow as interview_workflow


from jobctrl.interview.workflow import InterviewPrepWorkflowInput, InterviewPrepWorkflowResult


JOB_ID = JobId("90000000-0000-4000-8000-000000000021")


JOB_URL = "https://example.test/job/1"


OTHER_TENANT = TenantId("other")


INERT_USER_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}


def test_event_recorder_writes_canonical_job_id_and_safe_payload_fields(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        InterviewPrepEventRecorder(conn).publish(
            create_interview_prep_generated(
                LOCAL_TENANT,
                InterviewPrepGeneratedPayload(
                    job_id=JOB_ID,
                    generation=3,
                    item_count=4,
                    generated_at="2026-07-05T12:00:00Z",
                ),
            )
        )

        row = conn.execute(
            """
            SELECT job_id, payload_json FROM job_events
            WHERE event_type = 'InterviewPrepGenerated'
            """
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert row["job_id"] == JOB_ID
        assert payload["jobId"] == JOB_ID
        assert "job_id" not in payload
        assert payload["item_count"] == 4
        assert payload["itemCount"] == 4
        assert payload["generated_at"] == "2026-07-05T12:00:00Z"
        assert payload["generatedAt"] == "2026-07-05T12:00:00Z"
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.parametrize("event_type", ["InterviewPrepGenerated", "InterviewPrepFailed"])
def test_event_recorder_keeps_same_job_id_events_with_their_originating_tenant(
    tmp_path: Path,
    event_type: str,
) -> None:
    conn = _init_conn(tmp_path)
    try:
        _insert_job(conn, OTHER_TENANT, JOB_ID, "https://example.test/job/other")
        if event_type == "InterviewPrepGenerated":
            event = create_interview_prep_generated(
                OTHER_TENANT,
                InterviewPrepGeneratedPayload(
                    job_id=JOB_ID,
                    generation=3,
                    item_count=4,
                    generated_at="2026-07-05T12:00:00Z",
                ),
            )
        else:
            event = create_interview_prep_failed(
                OTHER_TENANT,
                InterviewPrepFailedPayload(
                    job_id=JOB_ID,
                    generation=3,
                    failed_at="2026-07-05T12:00:00Z",
                    reason_count=2,
                ),
            )

        InterviewPrepEventRecorder(conn).publish(event)

        rows = conn.execute(
            """
            SELECT tenant_id, job_id, event_type FROM job_events
            WHERE stage = 'interview_prep'
            ORDER BY event_id
            """
        ).fetchall()
        assert [tuple(row) for row in rows] == [(OTHER_TENANT, JOB_ID, event_type)]
        assert (
            conn.execute(
                """
            SELECT COUNT(*) FROM job_events
            WHERE tenant_id = ? AND job_id = ? AND stage = 'interview_prep'
            """,
                (LOCAL_TENANT, JOB_ID),
            ).fetchone()[0]
            == 0
        )
    finally:
        close_connection(tmp_path / "jobs.db")


def test_event_recorder_does_not_redirect_to_local_when_only_other_tenant_has_job(
    tmp_path: Path,
) -> None:
    conn = _init_conn(tmp_path, seed_local_job=False)
    try:
        _insert_job(conn, OTHER_TENANT, JOB_ID, "https://example.test/job/other")
        InterviewPrepEventRecorder(conn).publish(
            create_interview_prep_generated(
                OTHER_TENANT,
                InterviewPrepGeneratedPayload(
                    job_id=JOB_ID,
                    generation=3,
                    item_count=4,
                    generated_at="2026-07-05T12:00:00Z",
                ),
            )
        )

        rows = conn.execute(
            """
            SELECT tenant_id, job_id FROM job_events
            WHERE event_type = 'InterviewPrepGenerated'
            """
        ).fetchall()
        assert [tuple(row) for row in rows] == [(OTHER_TENANT, JOB_ID)]
    finally:
        close_connection(tmp_path / "jobs.db")


def test_interview_workflow_and_activity_boundaries_reject_url_identity() -> None:
    with pytest.raises(ValueError, match="canonical UUID"):
        InterviewPrepWorkflowInput(tenant_id="local", job_id=JOB_URL)
    with pytest.raises(ValueError, match="canonical UUID"):
        InterviewPrepWorkflowResult(status="failed", job_id=JOB_URL)
    with pytest.raises(ValueError, match="canonical UUID"):
        GenerateInterviewPrepActivityInput(tenant_id="local", job_id=JOB_URL)
    with pytest.raises(ValueError, match="canonical UUID"):
        GenerateInterviewPrepActivityOutput(
            status="failed",
            job_id=JOB_URL,
            generation=1,
            item_count=0,
        )


@pytest.mark.asyncio
async def test_generate_activity_offloads_generation_and_heartbeats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    heartbeats: list[str] = []
    forwarded: dict[str, str] = {}
    started = threading.Event()
    release = threading.Event()

    def _blocking_generate(
        job_id: JobId,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
        llm_model: str | None = None,
        origin_run_id: str = "",
    ) -> GenerateInterviewPrepActivityOutput:
        forwarded["origin_run_id"] = origin_run_id
        started.set()
        # Stand in for a generation that runs longer than the heartbeat timeout.
        if not release.wait(timeout=5):
            raise AssertionError("release was never set")
        return GenerateInterviewPrepActivityOutput(
            status="accepted",
            job_id=job_id,
            generation=1,
            item_count=1,
        )

    monkeypatch.setattr(interview_activities, "generate_interview_prep_by_job_id", _blocking_generate)
    monkeypatch.setattr(
        interview_activities.activity,
        "heartbeat",
        lambda *args, **_kwargs: heartbeats.append(args[0] if args else ""),
    )
    monkeypatch.setattr(
        interview_activities.activity,
        "info",
        lambda: SimpleNamespace(
            activity_type="generate_interview_prep",
            workflow_run_id="wf-run-heartbeat",
        ),
    )

    task = asyncio.create_task(
        generate_interview_prep_activity(GenerateInterviewPrepActivityInput(tenant_id="local", job_id=JOB_ID))
    )
    # The blocking generation runs in the worker thread pool, so the event loop
    # stays responsive instead of being starved by an inline blocking call.
    await asyncio.get_running_loop().run_in_executor(None, started.wait, 2)
    await asyncio.sleep(0.05)
    assert not task.done()
    assert "interview-prep starting" in heartbeats

    release.set()
    output = await asyncio.wait_for(task, timeout=5)
    assert output.status == "accepted"
    assert heartbeats[-1] == "done"
    assert forwarded["origin_run_id"] == "wf-run-heartbeat"


@pytest.mark.parametrize("tenant_id", [LOCAL_TENANT, OTHER_TENANT])
def test_prep_material_input_uses_only_current_approved_artifact(
    tmp_path: Path,
    tenant_id: TenantId,
) -> None:
    conn = _init_conn(tmp_path)
    try:
        if tenant_id != LOCAL_TENANT:
            _insert_job(conn, tenant_id, JOB_ID, JOB_URL)
        material_path = tmp_path / "approved-synthetic-resume.txt"
        material_path.write_text("Synthetic approved resume.")
        for generation, status in ((1, "approved"), (2, "rejected")):
            conn.execute(
                "INSERT INTO job_materials (tenant_id, job_id, generation, status, "
                "created_at, updated_at) VALUES (?, ?, ?, 'resume_in_progress', 'now', 'now')",
                (tenant_id, JOB_ID, generation),
            )
            conn.execute(
                "INSERT INTO job_materials_artifacts (tenant_id, job_id, generation, "
                "artifact_type, artifact_id, status, path, render_format, created_at) "
                "VALUES (?, ?, ?, 'tailored_resume', ?, ?, ?, 'text', 'now')",
                (tenant_id, JOB_ID, generation, f"resume-{generation}", status, str(material_path)),
            )
            for suffix, artifact_id in (("owned", f"resume-{generation}"), ("unrelated", "other-artifact")):
                conn.execute(
                    "INSERT INTO job_bullet_provenance (tenant_id, job_id, generation, "
                    "bullet_id, artifact_id, section, transform_type, control, generated_text, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 'experience', 'paraphrase', 'never_fabricate', ?, 'now')",
                    (
                        tenant_id,
                        JOB_ID,
                        generation,
                        f"bullet-{generation}-{suffix}",
                        artifact_id,
                        f"synthetic generation {generation} {suffix}",
                    ),
                )
        conn.commit()

        rows = interview_activities._load_accepted_materials(conn, tenant_id, JOB_ID)

        assert [(row["generation"], row["artifactId"], row["bulletId"]) for row in rows] == [
            (1, "resume-1", "bullet-1-owned")
        ]
        conn.execute(
            "UPDATE job_materials_artifacts SET status = 'rejected' WHERE tenant_id = ? AND job_id = ?",
            (tenant_id, JOB_ID),
        )
        assert interview_activities._load_accepted_materials(conn, tenant_id, JOB_ID) == ()
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.asyncio
@pytest.mark.parametrize("raise_error", [False, True])
async def test_workflow_terminal_events_do_not_include_private_failure_text(
    monkeypatch: pytest.MonkeyPatch,
    raise_error: bool,
) -> None:
    from datetime import datetime, timezone

    outcomes: list[dict[str, Any]] = []

    async def record_outcome(**kwargs: Any) -> None:
        outcomes.append(kwargs)

    async def started(**_kwargs: Any) -> None:
        pass

    async def execute(fn: Any, *_args: Any, **_kwargs: Any) -> Any:
        if fn == interview_workflow.check_spend_budget:
            return None
        if raise_error:
            raise RuntimeError("PRIVATE candidate answer and employer excerpt")
        return GenerateInterviewPrepActivityOutput(
            status="failed", job_id=JOB_ID, generation=2, item_count=0, errors=("PRIVATE candidate answer",)
        )

    monkeypatch.setattr(interview_workflow, "emit_workflow_outcome", record_outcome)
    monkeypatch.setattr(interview_workflow, "emit_workflow_started", started)
    monkeypatch.setattr(interview_workflow.workflow, "execute_activity", execute)
    monkeypatch.setattr(interview_workflow.workflow, "now", lambda: datetime.now(timezone.utc))

    result = await interview_workflow.InterviewPrepWorkflow().run(
        InterviewPrepWorkflowInput(tenant_id="local", job_id=JOB_ID)
    )

    assert result.status == "failed"
    assert len(outcomes) == 1
    assert "PRIVATE" not in json.dumps(outcomes, default=str)


def _init_conn(tmp_path: Path, *, seed_local_job: bool = True):
    db_path = tmp_path / "jobs.db"
    conn = get_connection(db_path)
    create_exact_v13_schema(conn)
    if seed_local_job:
        _insert_job(conn, LOCAL_TENANT, JOB_ID, JOB_URL)
    conn.commit()
    return conn


def _insert_job(
    conn,
    tenant_id: TenantId,
    job_id: JobId,
    url: str,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, discovered_at)
        VALUES (?, ?, ?, 'Backend Engineer', 'ExampleCo', '2026-07-31T12:00:00Z')
        """,
        (tenant_id, job_id, url),
    )


def _job() -> dict[str, Any]:
    return {
        "job_id": JOB_ID,
        "url": JOB_URL,
        "title": "Backend Engineer",
        "company": "ExampleCo",
    }
