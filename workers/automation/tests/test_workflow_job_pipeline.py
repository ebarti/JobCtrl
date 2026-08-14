"""Tests for ``JobPipelineWorkflow``.

Exercises the workflow end-to-end via Temporal's ``WorkflowEnvironment`` with
the underlying stage runners stubbed so the test stays fast and hermetic.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import ApplicationError, CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow
from jobctrl.discovery.activities import (
    AutomaticCompensationRefreshActivityOutput,
    DiscoveryEnrichmentActivityOutput,
    DiscoveryPreparationFanoutOutput,
    PlanDiscoverySourcesOutput,
)
from jobctrl.discovery.workflow import DiscoverWorkflow
from jobctrl.enrichment.activities import (
    cancel_enrichment_cohort_activity,
    enrich_activity,
)
from jobctrl.database import get_connection
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobctrl.infrastructure.preparation_recovery import (
    assert_material_activity_commit_allowed,
    cancel_preparation_state_activity,
)
from jobctrl.materials.activities import (
    cover_activity,
    tailor_activity,
)
from jobctrl.pipeline.workflow import (
    _COVER_RETRY,
    _ENRICH_RETRY,
    _MAX_SELECTED_BATCH_TIMEOUT,
    _SELECTED_BATCH_TIMEOUT_PATCH,
    _SCORE_RETRY,
    _TAILOR_RETRY,
    _activity_timeout,
    _apply_child_job_id,
    _cancel_material_stage_state,
    _cancel_owned_enrichment,
    _pipeline_spends,
    _selected_batch_timeout,
    JobPipelineWorkflow,
    JobPipelineWorkflowInput,
)
from jobctrl.scoring.activities import score_activity
from jobctrl.llm import SpendBudgetStatus
from jobctrl.workflow_specs import (
    build_pipeline_workflow_spec,
    build_run_stage_workflow_spec,
)
from jobctrl.state import ensure_job_stage_rows, set_stage_state


def test_selected_batch_timeout_scales_by_worker_waves_and_is_capped() -> None:
    job_ids = tuple(JobId(f"20000000-0000-4000-8000-{index:012d}") for index in range(20))

    assert _selected_batch_timeout(
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["tailor"],
            job_ids=job_ids[:9],
            workers=4,
        )
    ) == timedelta(minutes=90)
    assert _selected_batch_timeout(
        JobPipelineWorkflowInput(
            tenant_id="local",
            stages=["tailor"],
            job_ids=job_ids[:1],
            workers=4,
        )
    ) == timedelta(minutes=30)
    assert (
        _selected_batch_timeout(
            JobPipelineWorkflowInput(
                tenant_id="local",
                stages=["tailor"],
                job_ids=job_ids,
                workers=1,
            )
        )
        == _MAX_SELECTED_BATCH_TIMEOUT
    )

    selected_payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["tailor"],
        job_ids=job_ids[:9],
        workers=4,
    )
    with patch(
        "jobctrl.pipeline.workflow.workflow.patched",
        side_effect=AssertionError("single-item batches do not need a patch marker"),
    ):
        assert _activity_timeout(
            JobPipelineWorkflowInput(
                tenant_id="local",
                stages=["tailor"],
                job_ids=job_ids[:1],
                workers=4,
            )
        ) == timedelta(minutes=30)
    with patch(
        "jobctrl.pipeline.workflow.workflow.patched",
        return_value=False,
    ) as patched:
        assert _activity_timeout(selected_payload) == timedelta(minutes=30)
        patched.assert_called_once_with(_SELECTED_BATCH_TIMEOUT_PATCH)
    with patch(
        "jobctrl.pipeline.workflow.workflow.patched",
        return_value=True,
    ) as patched:
        assert _activity_timeout(selected_payload) == timedelta(minutes=90)
        patched.assert_called_once_with(_SELECTED_BATCH_TIMEOUT_PATCH)


@pytest.mark.parametrize(
    ("stage", "queue_stage", "retailor"),
    [
        ("tailor", "pending_tailor", True),
        ("cover", "pending_cover", False),
    ],
)
def test_global_material_run_freezes_exact_selected_cohort(
    stage: str,
    queue_stage: str,
    retailor: bool,
) -> None:
    job_ids = [f"21000000-0000-4000-8000-{index:012d}" for index in range(3)]
    rows = [{"tenant_id": "local", "job_id": job_id} for job_id in job_ids]

    with (
        patch("jobctrl.database.get_connection", return_value=object()) as connection,
        patch("jobctrl.database.get_jobs_by_stage", return_value=rows) as selector,
    ):
        spec = build_run_stage_workflow_spec(
            {
                "tenantId": "local",
                "stage": stage,
                "limit": 25,
                "workers": 2,
                "minScore": 8,
                "retailor": True,
            }
        )

    payload = spec.args[0]
    assert payload.job_ids == tuple(JobId(job_id) for job_id in job_ids)
    assert payload.material_selection_resolved is True
    connection.assert_called_once_with()
    selector.assert_called_once_with(
        conn=connection.return_value,
        stage=queue_stage,
        min_score=8,
        limit=25,
        retailor=retailor,
    )


@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.asyncio
async def test_resolved_empty_material_batch_is_a_no_op(stage: str) -> None:
    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=[stage],
        material_selection_resolved=True,
    )

    with patch(
        "jobctrl.pipeline.workflow._execute_stage",
        side_effect=AssertionError("an empty frozen cohort must not dispatch an activity"),
    ):
        result = await JobPipelineWorkflow()._execute_stages(payload)

    assert result.stages_completed == [stage]
    assert result.stages_failed == []
    assert _pipeline_spends(payload) is False


def test_global_material_run_preserves_batch_apply_selector() -> None:
    job_ids = [
        "22000000-0000-4000-8000-000000000001",
        "22000000-0000-4000-8000-000000000002",
    ]
    rows = [{"tenant_id": "local", "job_id": job_id} for job_id in job_ids]

    with (
        patch("jobctrl.database.get_connection", return_value=object()),
        patch("jobctrl.database.get_jobs_by_stage", return_value=rows),
    ):
        spec = build_run_stage_workflow_spec(
            {
                "tenantId": "local",
                "stages": ["tailor", "cover", "apply"],
                "dryRun": True,
            }
        )

    payload = spec.args[0]
    assert payload.job_ids == tuple(JobId(job_id) for job_id in job_ids)
    assert payload.material_selection_resolved is True
    assert payload.apply_selector_keys == ()
    assert _apply_child_job_id(payload) is None


def test_multi_stage_global_material_run_freezes_each_queue_independently() -> None:
    tailor_ids = [f"24000000-0000-4000-8000-{index:012d}" for index in range(2)]
    cover_ids = [f"25000000-0000-4000-8000-{index:012d}" for index in range(2)]
    rows_by_queue = {
        "pending_tailor": [{"tenant_id": "local", "job_id": job_id} for job_id in tailor_ids],
        "pending_cover": [{"tenant_id": "local", "job_id": job_id} for job_id in cover_ids],
    }

    with (
        patch("jobctrl.database.get_connection", return_value=object()),
        patch(
            "jobctrl.database.get_jobs_by_stage",
            side_effect=lambda **kwargs: rows_by_queue[kwargs["stage"]],
        ) as selector,
    ):
        spec = build_run_stage_workflow_spec(
            {
                "tenantId": "local",
                "stages": ["tailor", "cover"],
                "minScore": 8,
                "limit": 25,
            }
        )

    payload = spec.args[0]
    assert payload.job_ids == tuple(JobId(job_id) for job_id in tailor_ids)
    assert payload.cover_job_ids == tuple(JobId(job_id) for job_id in cover_ids)
    assert payload.material_selection_resolved is True
    assert [call.kwargs["stage"] for call in selector.call_args_list] == [
        "pending_tailor",
        "pending_cover",
    ]


def test_score_first_global_run_freezes_material_cohorts() -> None:
    """``run score tailor cover`` must not reach the legacy unscoped material runner."""

    tailor_ids = ["27000000-0000-4000-8000-000000000001"]
    cover_ids = ["28000000-0000-4000-8000-000000000001"]
    rows_by_queue = {
        "pending_tailor": [{"tenant_id": "local", "job_id": job_id} for job_id in tailor_ids],
        "pending_cover": [{"tenant_id": "local", "job_id": job_id} for job_id in cover_ids],
    }

    with (
        patch("jobctrl.database.get_connection", return_value=object()),
        patch(
            "jobctrl.database.get_jobs_by_stage",
            side_effect=lambda **kwargs: rows_by_queue[kwargs["stage"]],
        ) as selector,
    ):
        spec = build_run_stage_workflow_spec(
            {
                "tenantId": "local",
                "stages": ["score", "tailor", "cover"],
            }
        )

    payload = spec.args[0]
    assert payload.stages == ["score", "tailor", "cover"]
    assert payload.job_ids == tuple(JobId(job_id) for job_id in tailor_ids)
    assert payload.cover_job_ids == tuple(JobId(job_id) for job_id in cover_ids)
    assert payload.material_selection_resolved is True
    assert [call.kwargs["stage"] for call in selector.call_args_list] == [
        "pending_tailor",
        "pending_cover",
    ]


@pytest.mark.asyncio
async def test_empty_tailor_cohort_still_covers_frozen_cover_backlog() -> None:
    """An empty Tailor queue must not no-op a Cover stage with frozen backlog."""

    cover_backlog = (
        JobId("26000000-0000-4000-8000-000000000001"),
        JobId("26000000-0000-4000-8000-000000000002"),
    )
    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["tailor", "cover"],
        material_selection_resolved=True,
        cover_job_ids=cover_backlog,
        limit=25,
    )
    dispatched: list[tuple[str, tuple[JobId, ...], int]] = []

    async def fake_execute_stage(stage: str, stage_payload: JobPipelineWorkflowInput):
        dispatched.append((stage, stage_payload.job_ids, stage_payload.limit))
        return {"status": "ok", "stages": [{"stage": stage}]}

    with patch("jobctrl.pipeline.workflow._execute_stage", side_effect=fake_execute_stage):
        result = await JobPipelineWorkflow()._execute_stages(payload)

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert dispatched == [("cover", cover_backlog, 0)]
    assert _pipeline_spends(payload) is True


@pytest.mark.asyncio
async def test_cover_unions_frozen_backlog_with_approved_tailor_subset() -> None:
    """Cover must keep pre-existing pending_cover stragglers alongside approved Tailor output."""

    tailor_cohort = (
        JobId("29000000-0000-4000-8000-000000000001"),
        JobId("29000000-0000-4000-8000-000000000002"),
    )
    cover_backlog = (JobId("29000000-0000-4000-8000-000000000009"),)
    approved_job_id = tailor_cohort[0]
    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["tailor", "cover"],
        material_selection_resolved=True,
        job_ids=tailor_cohort,
        cover_job_ids=cover_backlog,
        limit=25,
    )
    dispatched: list[tuple[str, tuple[JobId, ...], int]] = []

    async def fake_execute_stage(stage: str, stage_payload: JobPipelineWorkflowInput):
        dispatched.append((stage, stage_payload.job_ids, stage_payload.limit))
        if stage == "tailor":
            return {
                "status": "ok",
                "stages": [{"stage": "tailor", "approvedJobIds": [str(approved_job_id)]}],
            }
        return {"status": "ok", "stages": [{"stage": stage}]}

    with patch("jobctrl.pipeline.workflow._execute_stage", side_effect=fake_execute_stage):
        result = await JobPipelineWorkflow()._execute_stages(payload)

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert dispatched == [
        ("tailor", tailor_cohort, 25),
        ("cover", (*cover_backlog, approved_job_id), 0),
    ]


@pytest.mark.asyncio
async def test_resolved_empty_multi_stage_material_run_is_a_no_op() -> None:
    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["tailor", "cover"],
        material_selection_resolved=True,
    )

    with patch(
        "jobctrl.pipeline.workflow._execute_stage",
        side_effect=AssertionError("empty frozen cohorts must not dispatch an activity"),
    ):
        result = await JobPipelineWorkflow()._execute_stages(payload)

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert _pipeline_spends(payload) is False


@pytest.mark.asyncio
async def test_score_first_resolved_run_keeps_score_unscoped_and_feeds_tailor() -> None:
    """Score keeps its global sweep and its newly scored jobs join the frozen Tailor cohort."""

    frozen_tailor = (JobId("2a000000-0000-4000-8000-000000000001"),)
    scored_job_id = JobId("2a000000-0000-4000-8000-000000000002")
    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["score", "tailor"],
        material_selection_resolved=True,
        job_ids=frozen_tailor,
        limit=25,
    )
    dispatched: list[tuple[str, tuple[JobId, ...]]] = []

    async def fake_execute_stage(stage: str, stage_payload: JobPipelineWorkflowInput):
        dispatched.append((stage, stage_payload.job_ids))
        if stage == "score":
            return {
                "status": "ok",
                "stages": [{"stage": "score", "scoredJobIds": [str(scored_job_id)]}],
            }
        return {"status": "ok", "stages": [{"stage": stage}]}

    with patch("jobctrl.pipeline.workflow._execute_stage", side_effect=fake_execute_stage):
        result = await JobPipelineWorkflow()._execute_stages(payload)

    assert result.stages_completed == ["score", "tailor"]
    assert result.stages_failed == []
    assert dispatched == [
        ("score", ()),
        ("tailor", (*frozen_tailor, scored_job_id)),
    ]


@pytest.fixture(autouse=True)
def permit_browser_for_existing_pipeline_workflow_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pipeline workflow tests exercise child-workflow behavior after policy validation."""

    from jobctrl import browser_capabilities

    monkeypatch.setattr(
        browser_capabilities,
        "require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


_OK_OBSERVED = ({"status": "ok"}, 0.0, "ok")
_APPLY_JOB_ID = "90000000-0000-4000-8000-000000000001"


def test_stage_retry_policies_are_stage_specific():
    assert _ENRICH_RETRY.maximum_attempts == 3
    assert _SCORE_RETRY.maximum_attempts == 3
    assert _TAILOR_RETRY.maximum_attempts == 3
    assert _COVER_RETRY.maximum_attempts == 3
    assert _ENRICH_RETRY.initial_interval == timedelta(seconds=5)
    assert _SCORE_RETRY.initial_interval == timedelta(seconds=5)
    assert _TAILOR_RETRY.initial_interval == timedelta(seconds=10)
    assert _COVER_RETRY.initial_interval == timedelta(seconds=10)
    assert _TAILOR_RETRY.maximum_interval == timedelta(seconds=120)
    assert _COVER_RETRY.maximum_interval == timedelta(seconds=120)


@pytest.mark.asyncio
async def test_cancel_owned_enrichment_is_patch_gated_for_replay_safety() -> None:
    """A cancellation recorded pre-patch must not schedule the cancel activity on replay."""

    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["enrich"],
        job_ids=(JobId("20000000-0000-4000-8000-000000000001"),),
        workers=1,
    )
    with (
        patch("jobctrl.pipeline.workflow.workflow.patched", return_value=False) as patched,
        patch(
            "jobctrl.pipeline.workflow.workflow.execute_activity",
            side_effect=AssertionError("unpatched replay must not schedule cancel_enrichment_cohort"),
        ),
    ):
        await _cancel_owned_enrichment(payload)
    patched.assert_called_once_with("pipeline-enrich-cancellation-v1")

    with (
        patch("jobctrl.pipeline.workflow.workflow.patched", return_value=True),
        patch(
            "jobctrl.pipeline.workflow.workflow.info",
            return_value=SimpleNamespace(workflow_id="wf-cancel", run_id="run-cancel"),
        ),
        patch(
            "jobctrl.pipeline.workflow.workflow.execute_activity",
            new=AsyncMock(),
        ) as execute_activity,
    ):
        await _cancel_owned_enrichment(payload)
    assert execute_activity.await_count == 1
    assert execute_activity.call_args.kwargs["retry_policy"].maximum_attempts == 5


@pytest.mark.asyncio
async def test_pipeline_material_cancel_activity_retries_are_bounded() -> None:
    """A persistently failing cancel-cohort activity must not hang cancellation."""

    payload = JobPipelineWorkflowInput(
        tenant_id="local",
        stages=["tailor"],
        job_ids=(JobId("20000000-0000-4000-8000-000000000002"),),
        workers=1,
    )
    with (
        patch("jobctrl.pipeline.workflow.workflow.patched", return_value=True),
        patch(
            "jobctrl.pipeline.workflow.workflow.info",
            return_value=SimpleNamespace(run_id="run-cancel"),
        ),
        patch(
            "jobctrl.pipeline.workflow.workflow.execute_activity",
            new=AsyncMock(),
        ) as execute_activity,
    ):
        await _cancel_material_stage_state("tailor", payload)
    assert execute_activity.await_count == 1
    assert execute_activity.call_args.kwargs["retry_policy"].maximum_attempts == 5


def _all_activities():
    return [
        _check_spend_budget,
        _plan_discovery_sources,
        _discovery_enrichment,
        _automatic_compensation_refresh,
        _discovery_preparation_fanout,
        enrich_activity,
        cancel_enrichment_cohort_activity,
        score_activity,
        tailor_activity,
        cover_activity,
        apply_activity,
        record_workflow_started,
        record_workflow_outcome,
        _recover_preparation_state,
        cancel_preparation_state_activity,
    ]


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


@activity.defn(name="recover_preparation_state")
async def _recover_preparation_state(_payload) -> dict[str, int]:
    return {"restored": 0, "failed": 0}


@activity.defn(name="plan_discovery_sources")
async def _plan_discovery_sources(_payload) -> PlanDiscoverySourcesOutput:
    return PlanDiscoverySourcesOutput(families=[], progress_total=2, start_count=0)


@activity.defn(name="discovery_enrichment")
async def _discovery_enrichment(_payload) -> DiscoveryEnrichmentActivityOutput:
    return DiscoveryEnrichmentActivityOutput(status="ok")


@activity.defn(name="automatic_compensation_refresh")
async def _automatic_compensation_refresh(
    _payload,
) -> AutomaticCompensationRefreshActivityOutput:
    return AutomaticCompensationRefreshActivityOutput(status="skipped")


@activity.defn(name="discovery_preparation_fanout")
async def _discovery_preparation_fanout(_payload) -> DiscoveryPreparationFanoutOutput:
    return DiscoveryPreparationFanoutOutput(started=0, queued=0, targets=0)


@pytest.mark.asyncio
async def test_pipeline_workflow_runs_requested_stages_in_order():
    queue = f"pipeline-{uuid.uuid4()}"

    with patch(
        "jobctrl.pipeline.runner._run_stage_observed",
        return_value=_OK_OBSERVED,
    ) as observed_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["discover", "enrich", "score"],
                    ),
                    id=f"pipeline-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["discover", "enrich", "score"]
    assert result.stages_failed == []
    assert result.failure is None

    invoked_stages = [call.args[0] for call in observed_mock.call_args_list]
    assert invoked_stages == ["enrich", "score"]


@pytest.mark.asyncio
async def test_selected_pipeline_scores_only_canonically_enriched_subset():
    """Blocked/failed Enrich rows never poison the downstream Score batch."""

    queue = f"pipeline-enrich-subset-{uuid.uuid4()}"
    selected = tuple(JobId(str(uuid.uuid4())) for _ in range(3))
    enriched = (selected[0], selected[2])
    score_calls: list[JobId] = []

    def fake_selected_enrichment(_payload, **_kwargs):
        return {
            "status": "partial",
            "elapsed": 0.01,
            "errors": {},
            "stages": [
                {
                    "stage": "enrich",
                    "status": "partial",
                    "selected": len(selected),
                    "enrichedJobIds": [str(job_id) for job_id in enriched],
                }
            ],
        }

    def fake_score_job_by_id(job_id: JobId, **_kwargs):
        score_calls.append(job_id)
        return SimpleNamespace(ok=True, error=None)

    with (
        patch(
            "jobctrl.enrichment.activities._run_selected_enrichment",
            side_effect=fake_selected_enrichment,
        ),
        patch(
            "jobctrl.scoring.scorer.score_job_by_id",
            side_effect=fake_score_job_by_id,
        ),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["enrich", "score"],
                        job_ids=selected,
                        workers=1,
                    ),
                    id=f"pipeline-enrich-subset-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["enrich", "score"]
    assert result.stages_failed == []
    assert score_calls == list(enriched)


@pytest.mark.asyncio
async def test_pipeline_workflow_rejects_unknown_stage_as_non_retryable():
    """Unknown stage names surface as a non-retryable ``ApplicationError``."""
    queue = f"pipeline-unknown-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPipelineWorkflow, DiscoverWorkflow],
            activities=_all_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError) as exc_info:
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["bogus"],
                    ),
                    id=f"pipeline-unknown-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    cause = exc_info.value.cause
    assert isinstance(cause, ApplicationError)
    assert cause.non_retryable is True
    assert "Unknown stage" in str(cause.message)


@pytest.mark.asyncio
async def test_pipeline_workflow_runs_apply_as_child_workflow():
    """Passing ``apply`` delegates to ``ApplyWorkflow`` while preserving order."""
    queue = f"pipeline-apply-{uuid.uuid4()}"
    workflow_id = f"pipeline-apply-wf-{uuid.uuid4()}"

    with patch("jobctrl.apply.launcher.main", return_value=(1, 0)) as apply_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow, ApplyWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["apply"],
                        dry_run=True,
                        model="sonnet",
                        headless=True,
                        min_score=8,
                        limit=2,
                        workers=3,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    assert result.stages_completed == ["apply"]
    assert result.stages_failed == []
    assert apply_mock.call_args.kwargs == {
        "limit": 2,
        "target_job_id": None,
        "tenant_id": "local",
        "min_score": 8,
        "headless": True,
        "model": "sonnet",
        "dry_run": True,
        "workers": 3,
        "approval_required": True,
        "workflow_id": f"{workflow_id}-apply",
        "install_signal_handlers": False,
    }


@pytest.mark.asyncio
async def test_pipeline_workflow_preserves_canonical_apply_target():
    queue = f"pipeline-apply-target-{uuid.uuid4()}"
    workflow_id = f"pipeline-apply-target-wf-{uuid.uuid4()}"

    with patch("jobctrl.apply.launcher.main", return_value=(0, 0)) as apply_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow, ApplyWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["apply"],
                        job_id=_APPLY_JOB_ID,
                        apply_selector_keys=("jobId",),
                        dry_run=True,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    assert result.stages_completed == ["apply"]
    assert apply_mock.call_args.kwargs["target_job_id"] == _APPLY_JOB_ID


@pytest.mark.asyncio
async def test_pipeline_rejects_present_legacy_apply_selector_before_child_start():
    queue = f"pipeline-apply-selector-{uuid.uuid4()}"

    with patch("jobctrl.apply.launcher.main", return_value=(0, 0)) as apply_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow, ApplyWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                with pytest.raises(WorkflowFailureError) as exc_info:
                    await env.client.execute_workflow(
                        JobPipelineWorkflow.run,
                        JobPipelineWorkflowInput(
                            tenant_id="local",
                            stages=["apply"],
                            apply_selector_keys=("jobUrls",),
                            dry_run=True,
                        ),
                        id=f"pipeline-apply-selector-wf-{uuid.uuid4()}",
                        task_queue=queue,
                    )

    cause = exc_info.value.cause
    assert isinstance(cause, ApplicationError)
    assert cause.non_retryable is True
    assert "canonical jobId" in str(cause.message)
    apply_mock.assert_not_called()


@pytest.mark.parametrize(
    "selector",
    [
        {"jobId": None},
        {"jobId": ""},
        {"jobId": "   "},
        {"jobIds": None},
        {"jobIds": []},
        {"jobIds": [_APPLY_JOB_ID]},
        {"jobUrl": None},
        {"jobUrl": ""},
        {"jobUrl": "   "},
        {"jobUrl": "https://example.test/job"},
        {"jobUrls": None},
        {"jobUrls": []},
        {"jobUrls": [""]},
        {"jobUrls": ["   "]},
        {"jobUrls": ["https://example.test/job"]},
    ],
)
def test_pipeline_apply_spec_boundaries_reject_present_unsupported_or_empty_selectors(
    selector: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="apply (accepts|jobId)"):
        build_run_stage_workflow_spec({"tenantId": "local", "stage": "apply", **selector})
    with pytest.raises(ValueError, match="apply (accepts|jobId)"):
        build_pipeline_workflow_spec(
            {"tenantId": "local", **selector},
            stages=["apply"],
            limit=1,
        )


def test_pipeline_apply_spec_boundaries_preserve_batch_and_canonical_target() -> None:
    batch = build_run_stage_workflow_spec({"tenantId": "local", "stage": "apply"})
    (batch_payload,) = batch.args
    assert batch_payload.apply_selector_keys == ()
    assert batch_payload.job_id is None

    targeted = build_pipeline_workflow_spec(
        {"tenantId": "local", "jobId": _APPLY_JOB_ID},
        stages=["apply"],
        limit=1,
    )
    (targeted_payload,) = targeted.args
    assert targeted_payload.apply_selector_keys == ("jobId",)
    assert targeted_payload.job_id == _APPLY_JOB_ID


def test_condition_recovery_run_stage_uses_a_stable_reusable_workflow_id() -> None:
    reason = "condition_resolved:authenticated_linkedin_browser_unavailable"
    first = build_run_stage_workflow_spec({"tenantId": "local", "stage": "enrich", "reason": reason})
    replay = build_run_stage_workflow_spec({"tenantId": "local", "stage": "enrich", "reason": reason})

    assert first.workflow_id == replay.workflow_id
    assert first.workflow_id is not None
    assert first.workflow_id.startswith("condition-recovery-")
    assert first.id_reuse_policy is WorkflowIDReusePolicy.ALLOW_DUPLICATE


def test_profile_continuation_uses_exactly_once_durable_event_identity() -> None:
    first = build_run_stage_workflow_spec({"tenantId": "local", "stage": "score", "reason": "profile_updated:42"})
    replay = build_run_stage_workflow_spec({"tenantId": "local", "stage": "score", "reason": "profile_updated:42"})

    assert first.workflow_id == replay.workflow_id
    assert first.workflow_id is not None
    assert first.workflow_id.startswith("profile-continuation-")
    assert first.id_reuse_policy is WorkflowIDReusePolicy.REJECT_DUPLICATE


@pytest.mark.parametrize(
    "selector_kwargs",
    [
        {"jobUrl": "https://example.test/job"},
        {"jobUrl": ""},
        {"jobUrls": ["https://example.test/job"]},
    ],
)
def test_pipeline_apply_spec_rejects_direct_legacy_scope_arguments(
    selector_kwargs: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="apply accepts only a canonical jobId"):
        build_pipeline_workflow_spec(
            {"tenantId": "local", **selector_kwargs},
            stages=["apply"],
            limit=1,
        )


@pytest.mark.asyncio
async def test_pipeline_workflow_records_failed_stage_and_stops():
    queue = f"pipeline-fail-{uuid.uuid4()}"

    def _runner(stage, _runner_func, _kwargs, **_ignored):
        if stage == "enrich":
            raise RuntimeError("boom")
        return _OK_OBSERVED

    with patch("jobctrl.pipeline.runner._run_stage_observed", side_effect=_runner):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                # Override retry on the workflow side by reaching attempts
                # quickly — the workflow uses its default retry policy which
                # caps at 3 attempts. ``RuntimeError`` is retryable, so the
                # workflow surfaces ActivityError after the third attempt.
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["discover", "enrich", "score"],
                    ),
                    id=f"pipeline-fail-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["discover"]
    assert result.stages_failed == ["enrich"]
    assert result.failure is not None
    assert result.failure.startswith("enrich:")
    assert "score" not in result.stages_completed
    assert "score" not in result.stages_failed


@pytest.mark.asyncio
async def test_pipeline_workflow_records_failed_stage_output_and_stops():
    queue = f"pipeline-stage-output-fail-{uuid.uuid4()}"

    def _runner(stage, _runner_func, _kwargs, **_ignored):
        if stage == "tailor":
            return (
                {"status": "failed", "error": "judge rejected all candidates"},
                0.1,
                "failed",
            )
        return _OK_OBSERVED

    with patch("jobctrl.pipeline.runner._run_stage_observed", side_effect=_runner) as observed_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["score", "tailor", "cover"],
                    ),
                    id=f"pipeline-stage-output-fail-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["score"]
    assert result.stages_failed == ["tailor"]
    assert result.failure is not None
    assert result.failure.startswith("tailor: llm_transient")
    assert "judge rejected all candidates" in result.failure
    invoked_stages = [call.args[0] for call in observed_mock.call_args_list]
    assert invoked_stages == ["score", "tailor", "tailor", "tailor"]


@pytest.mark.asyncio
async def test_pipeline_workflow_records_failed_apply_child_result_and_stops():
    queue = f"pipeline-apply-output-fail-{uuid.uuid4()}"

    with patch("jobctrl.apply.launcher.main", return_value=(0, 1)) as apply_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow, ApplyWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["apply", "score"],
                        dry_run=True,
                    ),
                    id=f"pipeline-apply-output-fail-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == []
    assert result.stages_failed == ["apply"]
    assert result.failure == "apply: failed"
    apply_mock.assert_called_once()


@pytest.mark.asyncio
async def test_pipeline_workflow_forwards_validation_mode_to_tailor_and_cover():
    queue = f"pipeline-validation-{uuid.uuid4()}"

    with patch(
        "jobctrl.pipeline.runner._run_stage_observed",
        return_value=_OK_OBSERVED,
    ) as observed_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["tailor", "cover"],
                        validation_mode="lenient",
                    ),
                    id=f"pipeline-validation-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    by_stage = {call.args[0]: call.args[2].get("validation_mode") for call in observed_mock.call_args_list}
    assert by_stage == {"tailor": "lenient", "cover": "lenient"}


@pytest.mark.asyncio
async def test_job_scoped_tailor_continuation_runs_cover_for_same_job_after_success():
    queue = f"pipeline-tailor-cover-{uuid.uuid4()}"
    job_id = JobId("10000000-0000-4000-8000-000000000001")
    tailored_job_ids: list[JobId] = []
    cover_job_ids: list[JobId] = []

    def fake_tailor_job_by_id(selected_job_id: JobId, **_kwargs):
        tailored_job_ids.append(selected_job_id)
        return {"status": "approved"}

    def fake_cover_letter_by_id(selected_job_id: JobId, **_kwargs):
        cover_job_ids.append(selected_job_id)
        return {"status": "ok", "generated": 1, "errors": 0, "elapsed": 0.01}

    with (
        patch("jobctrl.scoring.tailor.tailor_job_by_id", side_effect=fake_tailor_job_by_id),
        patch("jobctrl.scoring.cover_letter.cover_letter_by_id", side_effect=fake_cover_letter_by_id),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["tailor", "cover"],
                        job_id=job_id,
                        limit=1,
                    ),
                    id=f"pipeline-tailor-cover-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert tailored_job_ids == [job_id]
    assert cover_job_ids == [job_id]


@pytest.mark.asyncio
async def test_current_policy_tailor_continuation_covers_only_approved_jobs():
    queue = f"pipeline-current-policy-tailor-cover-{uuid.uuid4()}"
    selected_job_id = JobId("10000000-0000-4000-8000-000000000002")
    unrelated_pending_cover_job_id = JobId("10000000-0000-4000-8000-000000000003")
    tailored_job_ids: list[JobId] = []
    cover_job_ids: list[JobId] = []

    def fake_current_policy_job_ids(_conn, **kwargs):
        assert kwargs["limit"] == 1
        return (selected_job_id,)

    def fake_tailor_job_by_id(job_id: JobId, **_kwargs):
        tailored_job_ids.append(job_id)
        return {"status": "approved"}

    def fake_cover_letter_by_id(job_id: JobId, **_kwargs):
        cover_job_ids.append(job_id)
        assert job_id != unrelated_pending_cover_job_id
        return {"status": "ok", "generated": 1, "errors": 0, "elapsed": 0.01}

    with (
        patch("jobctrl.database.get_connection", return_value=object()),
        # This test mocks the DB layer wholesale (get_connection returns a
        # dummy), so stub the finalize writer — the finalize wiring itself is
        # covered by test_workflow_finalize.py.
        patch("jobctrl.infrastructure.temporal.finalize._emit"),
        patch(
            "jobctrl.pipeline.current_policy_selectors.tailoring_current_policy_job_ids",
            side_effect=fake_current_policy_job_ids,
        ),
        patch("jobctrl.scoring.tailor.tailor_job_by_id", side_effect=fake_tailor_job_by_id),
        patch("jobctrl.scoring.cover_letter.cover_letter_by_id", side_effect=fake_cover_letter_by_id),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["tailor", "cover"],
                        limit=1,
                        retailor=True,
                        tailor_current_policy_only=True,
                    ),
                    id=f"pipeline-current-policy-tailor-cover-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert tailored_job_ids == [selected_job_id]
    assert cover_job_ids == [selected_job_id]


@pytest.mark.asyncio
async def test_frozen_current_policy_cohort_uses_selected_tailor_path():
    queue = f"pipeline-frozen-current-policy-{uuid.uuid4()}"
    selected_job_id = JobId("10000000-0000-4000-8000-000000000004")
    tailored_job_ids: list[JobId] = []

    def fake_tailor_job_by_id(job_id: JobId, **_kwargs):
        tailored_job_ids.append(job_id)
        return {"status": "approved"}

    with (
        patch(
            "jobctrl.pipeline.current_policy_selectors.tailoring_current_policy_job_ids",
            side_effect=AssertionError("a frozen policy cohort must not be selected again"),
        ),
        patch("jobctrl.scoring.tailor.tailor_job_by_id", side_effect=fake_tailor_job_by_id),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["tailor"],
                        job_ids=(selected_job_id,),
                        retailor=True,
                        tailor_current_policy_only=True,
                        material_selection_resolved=True,
                    ),
                    id=f"pipeline-frozen-current-policy-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["tailor"]
    assert result.stages_failed == []
    assert tailored_job_ids == [selected_job_id]


@pytest.mark.asyncio
async def test_selected_tailor_partial_continues_cover_for_approved_subset():
    queue = f"pipeline-tailor-partial-{uuid.uuid4()}"
    approved_job_id = JobId("10000000-0000-4000-8000-000000000011")
    failed_job_id = JobId("10000000-0000-4000-8000-000000000012")
    cover_job_ids: list[JobId] = []

    def fake_tailor_job_by_id(job_id: JobId, **_kwargs):
        if job_id == approved_job_id:
            return {"status": "approved"}
        return {"status": "error", "error": "validation exhausted"}

    def fake_cover_letter_by_id(job_id: JobId, **_kwargs):
        cover_job_ids.append(job_id)
        return {"status": "ok", "generated": 1, "errors": 0, "elapsed": 0.01}

    with (
        patch("jobctrl.scoring.tailor.tailor_job_by_id", side_effect=fake_tailor_job_by_id),
        patch("jobctrl.scoring.cover_letter.cover_letter_by_id", side_effect=fake_cover_letter_by_id),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["tailor", "cover"],
                        job_ids=(approved_job_id, failed_job_id),
                    ),
                    id=f"pipeline-tailor-partial-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert cover_job_ids == [approved_job_id]


@pytest.mark.asyncio
async def test_pipeline_workflow_preserves_stage_options():
    queue = f"pipeline-options-{uuid.uuid4()}"

    with patch(
        "jobctrl.pipeline.runner._run_stage_observed",
        return_value=_OK_OBSERVED,
    ) as observed_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["discover", "score", "tailor"],
                        rescore=True,
                        retailor=True,
                        min_score=8,
                        validation_mode="strict",
                        tailor_models=("codex:fast", "claude:accurate"),
                        tailor_judge_model="gemini:judge",
                        tailor_judge_min_score=0.9,
                    ),
                    id=f"pipeline-options-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    by_stage = {call.args[0]: call.args[2] for call in observed_mock.call_args_list}
    assert "discover" not in by_stage
    assert by_stage["score"]["rescore"] is True
    assert by_stage["tailor"]["min_score"] == 8
    assert by_stage["tailor"]["retailor"] is True
    assert by_stage["tailor"]["tailor_models"] == ("codex:fast", "claude:accurate")
    assert by_stage["tailor"]["tailor_judge_model"] == "gemini:judge"
    assert by_stage["tailor"]["tailor_judge_min_score"] == pytest.approx(0.9)


# ---------------------------------------------------------------------------
# Cancellation: a workflow cancel must surface CancelledError inside the
# running activity. We use a custom workflow that calls a long-running
# activity, then cancel the workflow mid-flight and verify the activity
# observed the cancellation.
# ---------------------------------------------------------------------------


_cancel_observed = False


@activity.defn(name="LongRunningActivity")
async def _long_running_activity() -> str:
    global _cancel_observed
    activity.heartbeat("start")
    try:
        for _ in range(120):
            await asyncio.sleep(0.5)
            activity.heartbeat("tick")
    except asyncio.CancelledError:
        _cancel_observed = True
        raise
    return "done"


@workflow.defn(name="CancellableHarness")
class _CancellableHarness:
    @workflow.run
    async def run(self) -> str:
        return await workflow.execute_activity(
            _long_running_activity,
            start_to_close_timeout=timedelta(minutes=5),
            heartbeat_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@pytest.mark.asyncio
async def test_workflow_cancel_propagates_to_activity_as_cancelled_error():
    """Cancelling the workflow surfaces ``CancelledError`` inside the activity."""
    global _cancel_observed
    _cancel_observed = False
    queue = f"cancel-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[_CancellableHarness],
            activities=[_long_running_activity],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                _CancellableHarness.run,
                id=f"cancel-wf-{uuid.uuid4()}",
                task_queue=queue,
            )
            # Give the activity a moment to start before cancelling.
            await asyncio.sleep(0.5)
            await handle.cancel()

            with pytest.raises(WorkflowFailureError) as exc_info:
                await handle.result()

    # The workflow surfaces the cancellation as CancelledError.
    assert isinstance(exc_info.value.cause, CancelledError)
    assert _cancel_observed is True


@pytest.mark.asyncio
async def test_pipeline_enrich_cancel_terminalizes_exact_selected_cohort():
    """A real pipeline cancel cannot leave its selected Enrich rows pending."""

    from jobctrl.domain.errors import TransientNetworkError

    conn = get_connection()
    selected = tuple(JobId(str(uuid.uuid4())) for _ in range(2))
    unrelated = JobId(str(uuid.uuid4()))
    discovered_at = "2026-08-05T00:00:00+00:00"
    for index, job_id in enumerate((*selected, unrelated)):
        url = f"https://example.test/cancel-cohort/{job_id}"
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
            "VALUES ('local', ?, ?, 'Engineer', ?, ?)",
            (
                str(job_id),
                url,
                "RemoteOK" if index != 1 else "Job Bank Canada",
                discovered_at,
            ),
        )
        conn.execute(
            "INSERT INTO job_locators (tenant_id, job_id, locator_kind, locator_value, "
            "is_current, first_seen_at, last_seen_at) "
            "VALUES ('local', ?, 'posting_url', ?, 1, ?, ?)",
            (str(job_id), url, discovered_at, discovered_at),
        )
        ensure_job_stage_rows(conn, job_id)
    conn.commit()

    started = threading.Event()

    def blocking_batch(
        _conn,
        _site,
        _jobs,
        *,
        cancel_event=None,
        **_kwargs,
    ):
        started.set()
        assert cancel_event is not None
        assert cancel_event.wait(timeout=15)
        raise TransientNetworkError("enrichment canceled")

    queue = f"pipeline-enrich-cancel-{uuid.uuid4()}"
    workflow_id = f"pipeline-enrich-cancel-wf-{uuid.uuid4()}"
    with patch("jobctrl.enrichment.detail.scrape_site_batch", side_effect=blocking_batch):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["enrich"],
                        job_ids=selected,
                        workers=2,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )
                observed = await asyncio.wait_for(
                    asyncio.to_thread(started.wait, 10),
                    timeout=12,
                )
                assert observed is True
                await handle.cancel()
                with pytest.raises(WorkflowFailureError) as exc_info:
                    await handle.result()

    assert isinstance(exc_info.value.cause, CancelledError)
    states = {
        str(row[0]): str(row[1])
        for row in conn.execute(
            "SELECT job_id, state FROM job_stage_states "
            "WHERE tenant_id = 'local' AND stage = 'enrich' "
            "AND job_id IN (?, ?, ?)",
            (str(selected[0]), str(selected[1]), str(unrelated)),
        ).fetchall()
    }
    assert states[str(selected[0])] == "canceled"
    assert states[str(selected[1])] == "canceled"
    assert states[str(unrelated)] == "pending"


@pytest.mark.parametrize(
    ("stage", "runner_patch"),
    (
        ("tailor", "jobctrl.scoring.tailor.tailor_job_by_id"),
        ("cover", "jobctrl.scoring.cover_letter.cover_letter_by_id"),
    ),
)
@pytest.mark.asyncio
async def test_pipeline_material_cancel_stops_fanout_and_fences_late_writes(
    stage: str,
    runner_patch: str,
):
    """Real workflow cancellation closes the exact cohort without late writes."""

    conn = get_connection()
    selected = tuple(JobId(str(uuid.uuid4())) for _ in range(4))
    discovered_at = "2026-08-06T00:00:00+00:00"
    for job_id in selected:
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
            "VALUES ('local', ?, ?, 'Engineer', 'synthetic', ?)",
            (
                str(job_id),
                f"https://example.test/material-cancel/{stage}/{job_id}",
                discovered_at,
            ),
        )
        ensure_job_stage_rows(conn, job_id)
    conn.commit()

    first_wave_started = threading.Event()
    first_wave_fenced = threading.Event()
    started: list[str] = []
    fenced: list[str] = []
    late_writes: list[str] = []
    lock = threading.Lock()

    def blocking_material_job(job_id: JobId, **kwargs):
        cancel_event = kwargs.get("cancel_event")
        workflow_id = str(kwargs.get("workflow_id") or "")
        assert cancel_event is not None
        assert workflow_id
        thread_conn = get_connection()
        set_stage_state(
            thread_conn,
            job_id,
            stage,
            "running",
            metadata={"activityOwner": workflow_id},
            validate_transition=False,
        )
        thread_conn.commit()
        with lock:
            started.append(str(job_id))
            if len(started) == 2:
                first_wave_started.set()
        assert cancel_event.wait(timeout=15)
        try:
            assert_material_activity_commit_allowed(
                thread_conn,
                tenant_id="local",
                job_id=str(job_id),
                stage=stage,
                workflow_id=workflow_id,
                cancel_event=cancel_event,
            )
        except RuntimeError:
            with lock:
                fenced.append(str(job_id))
                if len(fenced) == 2:
                    first_wave_fenced.set()
            raise
        late_writes.append(str(job_id))
        thread_conn.execute(
            "INSERT INTO job_events "
            "(tenant_id, job_id, stage, event_type, occurred_at, payload_json) "
            "VALUES ('local', ?, ?, 'ForbiddenLateMaterialCommit', ?, '{}')",
            (str(job_id), stage, discovered_at),
        )
        thread_conn.commit()
        return {"status": "approved" if stage == "tailor" else "ok"}

    queue = f"pipeline-{stage}-cancel-{uuid.uuid4()}"
    workflow_id = f"pipeline-{stage}-cancel-wf-{uuid.uuid4()}"
    with patch(runner_patch, side_effect=blocking_material_job):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=[stage],
                        job_ids=selected,
                        workers=2,
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )
                observed = await asyncio.wait_for(
                    asyncio.to_thread(first_wave_started.wait, 10),
                    timeout=12,
                )
                assert observed is True
                await handle.cancel()
                with pytest.raises(WorkflowFailureError) as exc_info:
                    await handle.result()

    assert isinstance(exc_info.value.cause, CancelledError)
    assert first_wave_fenced.wait(timeout=5)
    assert len(started) == 2
    assert set(started) == {str(selected[0]), str(selected[1])}
    assert sorted(fenced) == sorted(started)
    assert late_writes == []
    rows = conn.execute(
        "SELECT job_id, state FROM job_stage_states WHERE tenant_id = 'local' AND stage = ? AND job_id IN (?, ?, ?, ?)",
        (stage, *(str(job_id) for job_id in selected)),
    ).fetchall()
    assert {str(row["job_id"]): str(row["state"]) for row in rows} == {str(job_id): "canceled" for job_id in selected}
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events "
            "WHERE tenant_id = 'local' AND event_type = 'ForbiddenLateMaterialCommit' "
            "AND job_id IN (?, ?, ?, ?)",
            tuple(str(job_id) for job_id in selected),
        ).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_materials WHERE tenant_id = 'local' AND job_id IN (?, ?, ?, ?)",
            tuple(str(job_id) for job_id in selected),
        ).fetchone()[0]
        == 0
    )


@pytest.mark.asyncio
async def test_pipeline_enrich_timeout_retries_without_false_cancellation():
    """An activity timeout releases its cohort; only user cancel terminalizes it."""

    from jobctrl.domain.errors import TransientNetworkError
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat as production_run_blocking,
    )

    conn = get_connection()
    job_id = JobId(str(uuid.uuid4()))
    discovered_at = "2026-08-06T00:00:00+00:00"
    url = f"https://example.test/timeout-cohort/{job_id}"
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
        "VALUES ('local', ?, ?, 'Engineer', 'RemoteOK', ?)",
        (str(job_id), url, discovered_at),
    )
    conn.execute(
        "INSERT INTO job_locators (tenant_id, job_id, locator_kind, locator_value, "
        "is_current, first_seen_at, last_seen_at) "
        "VALUES ('local', ?, 'posting_url', ?, 1, ?, ?)",
        (str(job_id), url, discovered_at, discovered_at),
    )
    ensure_job_stage_rows(conn, job_id)
    conn.commit()

    calls = 0

    def timeout_once(
        _conn,
        _site,
        _jobs,
        *,
        cancel_event=None,
        **_kwargs,
    ):
        nonlocal calls
        calls += 1
        if calls == 1:
            assert cancel_event is not None
            assert cancel_event.wait(timeout=10)
            raise TransientNetworkError("attempt interrupted")
        return {
            "processed": 0,
            "ok": 0,
            "partial": 0,
            "error": 0,
            "blocked": 0,
            "tiers": {1: 0, 2: 0, 3: 0},
        }

    async def fast_heartbeat(fn, **kwargs):
        kwargs["poll_interval"] = 0.05
        kwargs["cancel_wait_seconds"] = 1.0
        return await production_run_blocking(fn, **kwargs)

    queue = f"pipeline-enrich-timeout-{uuid.uuid4()}"
    workflow_id = f"pipeline-enrich-timeout-wf-{uuid.uuid4()}"
    with (
        patch("jobctrl.enrichment.detail.scrape_site_batch", side_effect=timeout_once),
        patch(
            "jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat",
            side_effect=fast_heartbeat,
        ),
        patch(
            "jobctrl.pipeline.workflow._DEFAULT_TIMEOUT",
            timedelta(seconds=1),
        ),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, DiscoverWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["enrich"],
                        job_ids=(job_id,),
                    ),
                    id=workflow_id,
                    task_queue=queue,
                )

    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'",
        (str(job_id),),
    ).fetchone()
    canceled_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = 'local' "
        "AND job_id = ? AND stage = 'enrich' AND event_type = 'StageCanceled'",
        (str(job_id),),
    ).fetchone()[0]
    assert result.stages_completed == ["enrich"]
    assert result.stages_failed == []
    assert calls == 2
    assert row is not None and str(row[0]) == "pending"
    assert canceled_events == 0
