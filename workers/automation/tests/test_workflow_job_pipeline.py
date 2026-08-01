"""Tests for ``JobPipelineWorkflow``.

Exercises the workflow end-to-end via Temporal's ``WorkflowEnvironment`` with
the underlying stage runners stubbed so the test stays fast and hermetic.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError, CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.apply.activities import apply_activity
from jobctrl.apply.workflow import ApplyWorkflow
from jobctrl.discovery.activities import (
    DiscoveryEnrichmentActivityOutput,
    DiscoveryPreparationFanoutOutput,
    PlanDiscoverySourcesOutput,
)
from jobctrl.discovery.workflow import DiscoverWorkflow
from jobctrl.enrichment.activities import enrich_activity
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobctrl.materials.activities import (
    cover_activity,
    tailor_activity,
)
from jobctrl.pipeline.workflow import (
    _COVER_RETRY,
    _ENRICH_RETRY,
    _SCORE_RETRY,
    _TAILOR_RETRY,
    JobPipelineWorkflow,
    JobPipelineWorkflowInput,
)
from jobctrl.scoring.activities import score_activity
from jobctrl.llm import SpendBudgetStatus
from jobctrl.workflow_specs import (
    build_pipeline_workflow_spec,
    build_run_stage_workflow_spec,
)


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


def _all_activities():
    return [
        _check_spend_budget,
        _plan_discovery_sources,
        _discovery_enrichment,
        _discovery_preparation_fanout,
        enrich_activity,
        score_activity,
        tailor_activity,
        cover_activity,
        apply_activity,
        record_workflow_started,
        record_workflow_outcome,
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


@activity.defn(name="plan_discovery_sources")
async def _plan_discovery_sources(_payload) -> PlanDiscoverySourcesOutput:
    return PlanDiscoverySourcesOutput(families=[], progress_total=2, start_count=0)


@activity.defn(name="discovery_enrichment")
async def _discovery_enrichment(_payload) -> DiscoveryEnrichmentActivityOutput:
    return DiscoveryEnrichmentActivityOutput(status="ok")


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
        build_run_stage_workflow_spec(
            {"tenantId": "local", "stage": "apply", **selector}
        )
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
        patch("jobctrl.pipeline.current_policy_selectors.tailoring_current_policy_job_ids", side_effect=fake_current_policy_job_ids),
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
