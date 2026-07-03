"""Tests for ``JobPipelineWorkflow``.

Exercises the workflow end-to-end via Temporal's ``WorkflowEnvironment`` with
the underlying stage runners stubbed so the test stays fast and hermetic.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError, CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobhunter.apply.activities import apply_activity
from jobhunter.apply.workflow import ApplyWorkflow
from jobhunter.discovery.activities import discover_activity
from jobhunter.enrichment.activities import enrich_activity
from jobhunter.infrastructure.temporal.finalize import (
    record_workflow_outcome,
    record_workflow_started,
)
from jobhunter.materials.activities import (
    cover_activity,
    tailor_activity,
)
from jobhunter.pipeline.workflow import (
    _DEFAULT_RETRY,
    _DEFAULT_TIMEOUT,
    _DISCOVER_RETRY,
    _DISCOVER_TIMEOUT,
    JobPipelineWorkflow,
    JobPipelineWorkflowInput,
)
from jobhunter.scoring.activities import score_activity


_OK_RESULT = {
    "stages": [{"stage": "_", "status": "ok", "elapsed": 0.0}],
    "errors": {},
    "elapsed": 0.0,
}


def test_discover_uses_no_overlap_activity_policy():
    assert _DISCOVER_TIMEOUT > _DEFAULT_TIMEOUT
    assert _DISCOVER_RETRY.maximum_attempts == 1
    assert _DEFAULT_RETRY.maximum_attempts > _DISCOVER_RETRY.maximum_attempts


def _all_activities():
    return [
        discover_activity,
        enrich_activity,
        score_activity,
        tailor_activity,
        cover_activity,
        apply_activity,
        record_workflow_started,
        record_workflow_outcome,
    ]


@pytest.mark.asyncio
async def test_pipeline_workflow_runs_requested_stages_in_order():
    queue = f"pipeline-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=_OK_RESULT,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
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

    invoked_stages = [call.kwargs["stages"][0] for call in runner_mock.call_args_list]
    assert invoked_stages == ["discover", "enrich", "score"]


@pytest.mark.asyncio
async def test_pipeline_workflow_rejects_unknown_stage_as_non_retryable():
    """Unknown stage names surface as a non-retryable ``ApplicationError``."""
    queue = f"pipeline-unknown-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPipelineWorkflow],
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

    with patch("jobhunter.apply.launcher.main", return_value=(1, 0)) as apply_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, ApplyWorkflow],
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
                    id=f"pipeline-apply-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["apply"]
    assert result.stages_failed == []
    assert apply_mock.call_args.kwargs == {
        "limit": 2,
        "target_url": None,
        "min_score": 8,
        "headless": True,
        "model": "sonnet",
        "dry_run": True,
        "workers": 3,
        "install_signal_handlers": False,
    }


@pytest.mark.asyncio
async def test_pipeline_workflow_records_failed_stage_and_stops():
    queue = f"pipeline-fail-{uuid.uuid4()}"

    def _runner(*, stages: list[str], **kwargs):
        if stages == ["enrich"]:
            raise RuntimeError("boom")
        return _OK_RESULT

    with patch("jobhunter.pipeline.run_pipeline", side_effect=_runner):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
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

    def _runner(*, stages: list[str], **kwargs):
        if stages == ["tailor"]:
            return {
                "stages": [{"stage": "tailor", "status": "failed", "elapsed": 0.1}],
                "errors": {"tailor": "judge rejected all candidates"},
                "elapsed": 0.1,
            }
        return _OK_RESULT

    with patch("jobhunter.pipeline.run_pipeline", side_effect=_runner) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
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
    assert result.failure == "tailor: judge rejected all candidates"
    invoked_stages = [call.kwargs["stages"][0] for call in runner_mock.call_args_list]
    assert invoked_stages == ["score", "tailor"]


@pytest.mark.asyncio
async def test_pipeline_workflow_records_failed_apply_child_result_and_stops():
    queue = f"pipeline-apply-output-fail-{uuid.uuid4()}"

    with (
        patch("jobhunter.apply.launcher.main", return_value=(0, 1)) as apply_mock,
        patch("jobhunter.pipeline.run_pipeline", return_value=_OK_RESULT) as runner_mock,
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow, ApplyWorkflow],
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
    runner_mock.assert_not_called()


@pytest.mark.asyncio
async def test_pipeline_workflow_forwards_validation_mode_to_tailor_and_cover():
    queue = f"pipeline-validation-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=_OK_RESULT,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
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

    by_stage = {
        call.kwargs["stages"][0]: call.kwargs.get("validation_mode")
        for call in runner_mock.call_args_list
    }
    assert by_stage == {"tailor": "lenient", "cover": "lenient"}


@pytest.mark.asyncio
async def test_job_scoped_tailor_continuation_runs_cover_for_same_job_after_success():
    queue = f"pipeline-tailor-cover-{uuid.uuid4()}"
    job_url = "https://example.com/job/manual-tailor"
    tailored_urls: list[str] = []
    cover_url_batches: list[tuple[str, ...]] = []

    def fake_tailor_job_by_url(url: str, **_kwargs):
        tailored_urls.append(url)
        return {"status": "approved"}

    def fake_run_cover_letters(*, job_urls: tuple[str, ...] = (), **_kwargs):
        cover_url_batches.append(job_urls)
        return {"generated": len(job_urls), "errors": 0, "elapsed": 0.01}

    with (
        patch("jobhunter.scoring.tailor.tailor_job_by_url", side_effect=fake_tailor_job_by_url),
        patch("jobhunter.scoring.cover_letter.run_cover_letters", side_effect=fake_run_cover_letters),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["tailor", "cover"],
                        job_url=job_url,
                        limit=1,
                    ),
                    id=f"pipeline-tailor-cover-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert result.stages_completed == ["tailor", "cover"]
    assert result.stages_failed == []
    assert tailored_urls == [job_url]
    assert cover_url_batches == [(job_url,)]


@pytest.mark.asyncio
async def test_current_policy_tailor_continuation_covers_only_approved_jobs():
    queue = f"pipeline-current-policy-tailor-cover-{uuid.uuid4()}"
    selected_url = "https://example.com/job/current-policy-selected"
    unrelated_pending_cover_url = "https://example.com/job/unrelated-pending-cover"
    tailored_urls: list[str] = []
    cover_url_batches: list[tuple[str, ...]] = []

    def fake_current_policy_urls(_conn, **kwargs):
        assert kwargs["limit"] == 1
        return (selected_url,)

    def fake_tailor_job_by_url(url: str, **_kwargs):
        tailored_urls.append(url)
        return {"status": "approved"}

    def fake_run_cover_letters(*, job_urls: tuple[str, ...] = (), **_kwargs):
        cover_url_batches.append(job_urls)
        if not job_urls:
            return {"generated": 1, "errors": 0, "elapsed": 0.01, "global": unrelated_pending_cover_url}
        return {"generated": len(job_urls), "errors": 0, "elapsed": 0.01}

    with (
        patch("jobhunter.database.get_connection", return_value=object()),
        # This test mocks the DB layer wholesale (get_connection returns a
        # dummy), so stub the finalize writer — the finalize wiring itself is
        # covered by test_workflow_finalize.py.
        patch("jobhunter.infrastructure.temporal.finalize._emit"),
        patch("jobhunter.pipeline.current_policy_selectors.tailoring_current_policy_job_urls", side_effect=fake_current_policy_urls),
        patch("jobhunter.scoring.tailor.tailor_job_by_url", side_effect=fake_tailor_job_by_url),
        patch("jobhunter.scoring.cover_letter.run_cover_letters", side_effect=fake_run_cover_letters),
    ):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
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
    assert tailored_urls == [selected_url]
    assert cover_url_batches == [(selected_url,)]


@pytest.mark.asyncio
async def test_pipeline_workflow_preserves_stage_options():
    queue = f"pipeline-options-{uuid.uuid4()}"

    with patch(
        "jobhunter.pipeline.run_pipeline",
        return_value=_OK_RESULT,
    ) as runner_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPipelineWorkflow],
                activities=_all_activities(),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["discover", "score", "tailor"],
                        dry_run=True,
                        rescore=True,
                        retailor=True,
                        min_score=8,
                        validation_mode="strict",
                        tailor_models=("local:fast", "openai:accurate"),
                        tailor_judge_model="gemini:judge",
                        tailor_judge_min_score=0.9,
                    ),
                    id=f"pipeline-options-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    by_stage = {
        call.kwargs["stages"][0]: call.kwargs
        for call in runner_mock.call_args_list
    }
    assert by_stage["score"]["dry_run"] is True
    assert by_stage["score"]["rescore"] is True
    assert by_stage["discover"]["dry_run"] is True
    assert by_stage["discover"]["min_score"] == 8
    assert by_stage["discover"]["validation_mode"] == "strict"
    assert by_stage["discover"]["tailor_models"] == ("local:fast", "openai:accurate")
    assert by_stage["discover"]["tailor_judge_model"] == "gemini:judge"
    assert by_stage["discover"]["tailor_judge_min_score"] == pytest.approx(0.9)
    assert by_stage["tailor"]["dry_run"] is True
    assert by_stage["tailor"]["min_score"] == 8
    assert by_stage["tailor"]["retailor"] is True
    assert by_stage["tailor"]["tailor_models"] == ("local:fast", "openai:accurate")
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
