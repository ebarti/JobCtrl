"""Happy-path test for ``profile_import_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.actions import LocalActionResult
from jobhunter.profile.activities import (
    ProfileImportActivityInput,
    ProfileImportActivityOutput,
    profile_import_activity,
)


@workflow.defn(name="ProfileImportHarness")
class _ProfileImportHarness:
    @workflow.run
    async def run(
        self, payload: ProfileImportActivityInput
    ) -> ProfileImportActivityOutput:
        return await workflow.execute_activity(
            profile_import_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_profile_import_activity_returns_draft_from_local_action():
    fake_result = LocalActionResult(
        ok=True,
        action_id="act-test",
        stage="profile_import",
        status="succeeded",
        started_at="2026-05-07T00:00:00Z",
        finished_at="2026-05-07T00:00:01Z",
        duration_ms=1000,
        result={
            "status": "ok",
            "draft": {
                "source": "pdf",
                "profile": {"name": "Test User"},
                "style": {"tone": "professional"},
            },
        },
    )
    queue = f"profile-{uuid.uuid4()}"

    with patch(
        "jobhunter.actions.run_local_action",
        return_value=fake_result,
    ) as run_action_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_ProfileImportHarness],
                activities=[profile_import_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: ProfileImportActivityOutput = await env.client.execute_workflow(
                    _ProfileImportHarness.run,
                    ProfileImportActivityInput(
                        tenant_id="local",
                        pdf_path="/tmp/resume.pdf",
                    ),
                    id=f"profile-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    run_action_mock.assert_called_once()
    request = run_action_mock.call_args.args[0]
    assert request.stage == "profile_import"
    assert request.pdf_path == "/tmp/resume.pdf"
    assert output.status == "succeeded"
    assert output.draft["source"] == "pdf"
    assert output.draft["profile"] == {"name": "Test User"}
    assert output.error is None
