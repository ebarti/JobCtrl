from __future__ import annotations

import uuid

import pytest
from temporalio import activity
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.database import get_connection, init_db
from jobhunter.infrastructure.compensation.workflow import (
    CompensationRefreshWorkflow,
    CompensationRefreshWorkflowInput,
)
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobhunter.llm import SpendBudgetStatus
from jobhunter.profile.activities import ProfileImportActivityInput, ProfileImportActivityOutput
from jobhunter.profile.workflow import ProfileImportWorkflow, ProfileImportWorkflowInput


@activity.defn(name="check_spend_budget")
async def _check_spend_budget(_payload) -> SpendBudgetStatus:
    return SpendBudgetStatus(
        day="2026-07-03",
        input_tokens=0,
        output_tokens=0,
        estimated_usd=0.0,
        daily_budget_usd=25.0,
        exceeded=False,
    )


@activity.defn(name="profile_import")
async def _profile_import(payload: ProfileImportActivityInput) -> ProfileImportActivityOutput:
    return ProfileImportActivityOutput(
        status="succeeded",
        draft={
            "source": payload.pdf_path,
            "profile": {"name": "Imported Candidate"},
        },
    )


@activity.defn(name="profile_import")
async def _profile_import_missing_input(_payload: ProfileImportActivityInput) -> ProfileImportActivityOutput:
    raise ApplicationError("missing profile PDF", type="missing_input", non_retryable=True)


@activity.defn(name="refresh_compensation")
async def _refresh_compensation(payload: CompensationRefreshWorkflowInput) -> dict:
    return {
        "ok": True,
        "jobUrl": payload.job_url,
        "postedFactsRefreshed": 1,
        "estimatesRefreshed": 1,
    }


def _isolate_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path) -> tuple[str, str]:
    from jobhunter import config
    import jobhunter.database as database

    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    init_db(db_path)
    return str(tmp_path), str(db_path)


def _workflow_row(workflow_id: str):
    conn = get_connection()
    return conn.execute(
        "SELECT status, workflow_type, error_code, events_json "
        "FROM workflow_run_projections WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()


@pytest.mark.asyncio
async def test_profile_import_workflow_runs_activity_and_projects_succeeded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    queue = f"profile-import-{uuid.uuid4()}"
    workflow_id = f"profile-import-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[ProfileImportWorkflow],
            activities=[
                _check_spend_budget,
                _profile_import,
                record_workflow_started,
                record_workflow_outcome,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                ProfileImportWorkflow.run,
                ProfileImportWorkflowInput(
                    tenant_id="local",
                    pdf_path="/tmp/resume.pdf",
                    expected_app_dir=app_dir,
                    expected_db_path=db_path,
                ),
                id=workflow_id,
                task_queue=queue,
            )

    row = _workflow_row(workflow_id)
    assert result.status == "succeeded"
    assert result.draft["profile"] == {"name": "Imported Candidate"}
    assert row["status"] == "succeeded"
    assert row["workflow_type"] == "ProfileImportWorkflow"
    assert "WorkflowCompleted" in row["events_json"]


@pytest.mark.asyncio
async def test_compensation_refresh_workflow_runs_activity_and_projects_succeeded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    queue = f"comp-refresh-{uuid.uuid4()}"
    workflow_id = f"comp-refresh-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[CompensationRefreshWorkflow],
            activities=[
                _check_spend_budget,
                _refresh_compensation,
                record_workflow_started,
                record_workflow_outcome,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                CompensationRefreshWorkflow.run,
                CompensationRefreshWorkflowInput(
                    tenant_id="local",
                    job_url="https://example.test/job",
                    expected_app_dir=app_dir,
                    expected_db_path=db_path,
                ),
                id=workflow_id,
                task_queue=queue,
            )

    row = _workflow_row(workflow_id)
    assert result.status == "succeeded"
    assert result.result["postedFactsRefreshed"] == 1
    assert row["status"] == "succeeded"
    assert row["workflow_type"] == "CompensationRefreshWorkflow"
    assert "WorkflowCompleted" in row["events_json"]


@pytest.mark.asyncio
async def test_profile_import_workflow_records_typed_activity_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    app_dir, db_path = _isolate_runtime(monkeypatch, tmp_path)
    queue = f"profile-import-fail-{uuid.uuid4()}"
    workflow_id = f"profile-import-fail-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[ProfileImportWorkflow],
            activities=[
                _check_spend_budget,
                _profile_import_missing_input,
                record_workflow_started,
                record_workflow_outcome,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            result = await env.client.execute_workflow(
                ProfileImportWorkflow.run,
                ProfileImportWorkflowInput(
                    tenant_id="local",
                    pdf_path="/tmp/missing.pdf",
                    expected_app_dir=app_dir,
                    expected_db_path=db_path,
                ),
                id=workflow_id,
                task_queue=queue,
            )

    row = _workflow_row(workflow_id)
    assert result.status == "failed"
    assert result.error_code == "missing_input"
    assert row["status"] == "failed"
    assert row["error_code"] == "missing_input"
    assert "WorkflowFailed" in row["events_json"]
