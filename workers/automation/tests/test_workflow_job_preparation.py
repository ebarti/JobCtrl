"""Tests for ``JobPreparationWorkflow``."""

from __future__ import annotations

import asyncio
from datetime import timedelta
import threading
from types import SimpleNamespace
import uuid

import pytest
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy, WorkflowIDConflictPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.materials.activities import cover_letter_activity, render_pdf_activity, tailor_job_activity
from jobctrl.pipeline import preparation
from jobctrl.preparation import workflow as prep_workflow_mod
from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobctrl.scoring.activities import score_job_activity
from jobctrl.llm import SpendBudgetStatus


_JOB_ID = JobId("10000000-0000-4000-8000-000000000001")


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


@pytest.mark.asyncio
async def test_preparation_workflow_runs_requested_steps_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[object, object]] = []

    async def fake_execute_activity(activity_fn, payload, **_kwargs):
        calls.append((activity_fn, payload))
        return SimpleNamespace(status="ok")

    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)

    result = await JobPreparationWorkflow()._execute_steps(
        JobPreparationInput(
            tenant_id="local",
            job_id=_JOB_ID,
            steps=["pdf", "score", "cover", "tailor"],
            target_version="1",
            idempotency_key="preparation:test",
        )
    )

    assert result.steps_completed == ["score", "tailor", "cover", "pdf"]
    assert result.steps_failed == []
    assert [fn.__name__ for fn, _payload in calls] == [
        "score_job_activity",
        "tailor_job_activity",
        "cover_letter_activity",
        "render_pdf_activity",
    ]
    assert [payload.job_id for _fn, payload in calls] == [_JOB_ID] * 4
    assert all(not hasattr(payload, "job_url") for _fn, payload in calls)


@pytest.mark.asyncio
async def test_preparation_workflow_treats_already_done_step_as_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_activity(_activity_fn, _payload, **_kwargs):
        return SimpleNamespace(status="already_done")

    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)

    result = await JobPreparationWorkflow()._execute_steps(
        JobPreparationInput(
            tenant_id="local",
            job_id=_JOB_ID,
            steps=["cover"],
            target_version="1",
            idempotency_key="preparation:test",
        )
    )

    assert result.steps_completed == ["cover"]
    assert result.failure is None


@pytest.mark.asyncio
async def test_preparation_material_cancel_activity_retries_are_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A persistently failing cancel-cohort activity must not hang cancellation."""

    captured: dict[str, object] = {}

    async def fake_execute_activity(_activity_fn, _payload, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(prep_workflow_mod.workflow, "patched", lambda _patch_id: True)
    monkeypatch.setattr(
        prep_workflow_mod.workflow,
        "info",
        lambda: SimpleNamespace(run_id="run-cancel"),
    )
    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)

    await prep_workflow_mod._cancel_material_stage_state(
        "tailor",
        JobPreparationInput(
            tenant_id="local",
            job_id=_JOB_ID,
            steps=["tailor"],
            target_version="1",
            idempotency_key="preparation:cancel-bound",
        ),
    )

    retry_policy = captured["retry_policy"]
    assert retry_policy.maximum_attempts == 5


@pytest.mark.asyncio
async def test_preparation_workflow_stops_dependents_when_tailor_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def fake_execute_activity(activity_fn, _payload, **_kwargs):
        calls.append(activity_fn.__name__)
        return SimpleNamespace(
            status="skipped" if activity_fn.__name__ == "tailor_job_activity" else "ok",
            reason="Posting snapshot is quarantined.",
        )

    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)

    result = await JobPreparationWorkflow()._execute_steps(
        JobPreparationInput(
            tenant_id="local",
            job_id=_JOB_ID,
            steps=["tailor", "cover", "pdf"],
            target_version="1",
            idempotency_key="preparation:skip-dependents",
        )
    )

    assert result.steps_completed == []
    assert result.steps_skipped == ["tailor"]
    assert result.steps_failed == []
    assert result.failure is None
    assert calls == ["tailor_job_activity"]


@pytest.mark.asyncio
async def test_preparation_workflow_reports_pdf_error_as_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_execute_activity(_activity_fn, _payload, **_kwargs):
        return SimpleNamespace(status="error", error="No approved material is renderable.")

    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)

    result = await JobPreparationWorkflow()._execute_steps(
        JobPreparationInput(
            tenant_id="local",
            job_id=_JOB_ID,
            steps=["pdf"],
            target_version="1",
            idempotency_key="preparation:pdf-error",
        )
    )

    assert result.steps_completed == []
    assert result.steps_skipped == []
    assert result.steps_failed == ["pdf"]
    assert result.error_code == "pdf_render_failed"
    assert result.failure == "pdf: No approved material is renderable."


def test_preparation_workflow_rejects_url_shaped_job_id() -> None:
    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        JobPreparationInput(
            tenant_id="local",
            job_id=JobId("https://example.com/jobs/legacy"),
            steps=["score"],
            target_version="1",
            idempotency_key="preparation:test",
        )


@pytest.mark.asyncio
async def test_preparation_workflow_records_failed_step_and_error_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recoveries: list[tuple[str, JobPreparationInput]] = []

    async def fake_recover(stage: str, payload: JobPreparationInput) -> None:
        recoveries.append((stage, payload))

    async def fake_execute_activity(activity_fn, _payload, **_kwargs):
        if activity_fn.__name__ != "tailor_job_activity":
            return SimpleNamespace(status="ok")
        try:
            raise ApplicationError("missing materials", type="missing_input", non_retryable=True)
        except ApplicationError as exc:
            raise ActivityError(
                "tailor failed",
                scheduled_event_id=1,
                started_event_id=2,
                identity="unit-test",
                activity_type="tailor_job",
                activity_id="activity-1",
                retry_state=None,
            ) from exc

    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(prep_workflow_mod, "_recover_stage_state", fake_recover)

    result = await JobPreparationWorkflow()._execute_steps(
        JobPreparationInput(
            tenant_id="local",
            job_id=_JOB_ID,
            steps=["score", "tailor", "cover"],
            target_version="1",
            idempotency_key="preparation:test",
        )
    )

    assert result.steps_completed == ["score"]
    assert result.steps_failed == ["tailor"]
    assert result.error_code == "missing_input"
    assert result.failure is not None
    assert result.failure.startswith("tailor:")
    assert len(recoveries) == 1
    assert recoveries[0][0] == "tailor"


@pytest.mark.asyncio
async def test_preparation_workflow_recovers_owned_score_after_retry_exhaustion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["score", "tailor"],
        target_version="1",
        idempotency_key="preparation:score-owner-loss",
    )
    recoveries: list[tuple[str, JobPreparationInput]] = []

    async def fake_recover(stage: str, failed_payload: JobPreparationInput) -> None:
        recoveries.append((stage, failed_payload))

    async def fake_execute_activity(activity_fn, _payload, **_kwargs):
        if activity_fn.__name__ != "score_job_activity":
            return SimpleNamespace(status="ok")
        try:
            raise ApplicationError("heartbeat timed out", type="Timeout", non_retryable=False)
        except ApplicationError as exc:
            raise ActivityError(
                "score failed",
                scheduled_event_id=1,
                started_event_id=2,
                identity="killed-worker",
                activity_type="score_job",
                activity_id="activity-1",
                retry_state=None,
            ) from exc

    monkeypatch.setattr(prep_workflow_mod.workflow, "execute_activity", fake_execute_activity)
    monkeypatch.setattr(prep_workflow_mod, "_recover_stage_state", fake_recover)

    result = await JobPreparationWorkflow()._execute_steps(payload)

    assert result.steps_completed == []
    assert result.steps_failed == ["score"]
    assert recoveries == [("score", payload)]


def test_preparation_workflow_specs_are_deterministic_for_duplicate_triggers() -> None:
    first = preparation.build_preparation_workflow_spec(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=3,
        source_event_id="source-1",
    )
    second = preparation.build_preparation_workflow_spec(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=3,
        source_event_id="source-1",
    )

    assert first.workflow_id == second.workflow_id
    assert first.workflow_id is not None
    assert first.workflow_id.startswith("prep-preparation:")
    assert first.id_conflict_policy is WorkflowIDConflictPolicy.USE_EXISTING
    assert first.id_reuse_policy is None
    assert first.args[0] == second.args[0]


@pytest.mark.asyncio
async def test_duplicate_preparation_workflow_start_attaches_without_duplicate_steps() -> None:
    queue = f"prep-overlap-{uuid.uuid4()}"
    workflow_id = f"prep-preparation:{uuid.uuid4().hex}"
    score_started = asyncio.Event()
    release_score = asyncio.Event()
    calls: list[str] = []

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload) -> None:
        return None

    @activity.defn(name="score_job")
    async def score_job(_payload) -> dict[str, str]:
        calls.append("score")
        score_started.set()
        await release_score.wait()
        return {"status": "ok"}

    @activity.defn(name="tailor_job")
    async def tailor_job(_payload) -> dict[str, str]:
        calls.append("tailor")
        return {"status": "approved"}

    @activity.defn(name="cover_letter")
    async def cover_letter(_payload) -> dict[str, str]:
        calls.append("cover")
        return {"status": "ok"}

    @activity.defn(name="render_pdf")
    async def render_pdf(_payload) -> dict[str, object]:
        calls.append("pdf")
        return {"status": "ok", "rendered": []}

    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["score", "tailor", "cover", "pdf"],
        target_version="1",
        idempotency_key=workflow_id.removeprefix("prep-"),
    )

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPreparationWorkflow],
            activities=[
                _check_spend_budget,
                record_started,
                record_outcome,
                score_job,
                tailor_job,
                cover_letter,
                render_pdf,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            first = await env.client.start_workflow(
                JobPreparationWorkflow.run,
                payload,
                id=workflow_id,
                task_queue=queue,
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            )
            await asyncio.wait_for(score_started.wait(), timeout=5)
            second = await env.client.start_workflow(
                JobPreparationWorkflow.run,
                payload,
                id=workflow_id,
                task_queue=queue,
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            )

            assert second.first_execution_run_id == first.first_execution_run_id

            release_score.set()
            assert (await first.result()).steps_completed == ["score", "tailor", "cover", "pdf"]
            assert (await second.result()).steps_completed == ["score", "tailor", "cover", "pdf"]

    assert calls == ["score", "tailor", "cover", "pdf"]


@pytest.mark.asyncio
async def test_preparation_workflow_fails_fast_when_budget_exceeded_and_spends_nothing() -> None:
    """I4 under streaming: a job fanned out mid-run after the daily spend cap is
    hit fails fast at its OWN preflight with non-retryable ``budget_exceeded``
    and runs zero spendful step activities. Each prep workflow is an independent
    root workflow, so this bounds cost per discovered job no matter how many
    per-family/per-job fan-outs streaming issues; earlier prep workflows that
    already ran are unaffected."""
    queue = f"prep-budget-{uuid.uuid4()}"
    calls: list[str] = []

    @activity.defn(name="check_spend_budget")
    async def budget_exceeded(_payload):
        from jobctrl.domain.errors import BudgetExceededError, to_application_error

        raise to_application_error(
            BudgetExceededError("LLM daily spend budget exceeded: $30.0000 spent of $25.00 for 2026-07-05.")
        )

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload) -> None:
        return None

    @activity.defn(name="score_job")
    async def score_job(_payload) -> dict[str, str]:
        calls.append("score")
        return {"status": "ok"}

    @activity.defn(name="tailor_job")
    async def tailor_job(_payload) -> dict[str, str]:
        calls.append("tailor")
        return {"status": "approved"}

    @activity.defn(name="cover_letter")
    async def cover_letter(_payload) -> dict[str, str]:
        calls.append("cover")
        return {"status": "ok"}

    @activity.defn(name="render_pdf")
    async def render_pdf(_payload) -> dict[str, object]:
        calls.append("pdf")
        return {"status": "ok", "rendered": []}

    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["score", "tailor", "cover", "pdf"],
        target_version="1",
        idempotency_key=f"preparation:{uuid.uuid4().hex}",
    )

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPreparationWorkflow],
            activities=[
                budget_exceeded,
                record_started,
                record_outcome,
                score_job,
                tailor_job,
                cover_letter,
                render_pdf,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            with pytest.raises(WorkflowFailureError) as excinfo:
                await env.client.execute_workflow(
                    JobPreparationWorkflow.run,
                    payload,
                    id=f"prep-{payload.idempotency_key}",
                    task_queue=queue,
                )

    # The preflight failure surfaces as an ActivityError wrapping the
    # non-retryable budget ApplicationError.
    cause = excinfo.value.cause
    assert isinstance(cause, ActivityError)
    app_error = cause.cause
    assert isinstance(app_error, ApplicationError)
    assert app_error.type == "budget_exceeded"
    # No spendful step activity ran — the preflight blocked before score/tailor/cover/pdf.
    assert calls == []


@pytest.mark.asyncio
async def test_preparation_workflow_resumes_at_cover_after_worker_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = f"prep-restart-{uuid.uuid4()}"
    cover_failed = threading.Event()
    calls: list[str] = []
    cover_attempts = 0

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload) -> None:
        return None

    def fake_score_job(_payload, **_kwargs) -> dict[str, object]:
        calls.append("score")
        return {"status": "ok", "score_version": 1}

    def fake_tailor_job(_payload, **_kwargs) -> dict[str, object]:
        calls.append("tailor")
        return {"status": "approved", "materials": SimpleNamespace(generation=1)}

    def fake_cover_letter(_payload, **_kwargs) -> dict[str, object]:
        nonlocal cover_attempts
        cover_attempts += 1
        calls.append("cover")
        if cover_attempts == 1:
            cover_failed.set()
            raise RuntimeError("temporary cover outage")
        return {"status": "ok", "materialsGeneration": 1}

    def fake_render_pdf(_payload) -> dict[str, object]:
        calls.append("pdf")
        return {"status": "ok", "rendered": []}

    monkeypatch.setattr("jobctrl.scoring.activities._score_one_job", fake_score_job)
    monkeypatch.setattr("jobctrl.materials.activities._tailor_one_job", fake_tailor_job)
    monkeypatch.setattr("jobctrl.materials.activities._cover_one_job", fake_cover_letter)
    monkeypatch.setattr("jobctrl.materials.activities._render_pdf_for_job", fake_render_pdf)

    activities = [
        _check_spend_budget,
        record_started,
        record_outcome,
        score_job_activity,
        tailor_job_activity,
        cover_letter_activity,
        render_pdf_activity,
    ]
    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["score", "tailor", "cover", "pdf"],
        target_version="1",
        idempotency_key=f"preparation:{uuid.uuid4().hex}",
    )
    original_cover_retry = prep_workflow_mod._COVER_RETRY
    prep_workflow_mod._COVER_RETRY = RetryPolicy(
        initial_interval=timedelta(milliseconds=100),
        maximum_interval=timedelta(milliseconds=100),
        maximum_attempts=3,
        non_retryable_error_types=["configuration", "authentication", "missing_input"],
    )

    try:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=activities,
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    JobPreparationWorkflow.run,
                    payload,
                    id=f"prep-{payload.idempotency_key}",
                    task_queue=queue,
                    id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
                )
                assert await asyncio.wait_for(asyncio.to_thread(cover_failed.wait, 10), timeout=11)
                await asyncio.sleep(0.5)

            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=activities,
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                await env.sleep(timedelta(seconds=20))
                result = await asyncio.wait_for(handle.result(), timeout=30)
    finally:
        prep_workflow_mod._COVER_RETRY = original_cover_retry

    assert result.steps_completed == ["score", "tailor", "cover", "pdf"]
    assert result.steps_failed == []
    assert calls == ["score", "tailor", "cover", "cover", "pdf"]


@pytest.mark.asyncio
async def test_preparation_workflow_resumes_pdf_after_worker_loss(
    monkeypatch: pytest.MonkeyPatch,
    request: pytest.FixtureRequest,
) -> None:
    queue = f"prep-pdf-worker-loss-{uuid.uuid4()}"
    first_render_started = threading.Event()
    release_lost_worker = threading.Event()
    attempts = 0

    request.addfinalizer(release_lost_worker.set)

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload) -> None:
        return None

    def fake_render_pdf(_payload) -> dict[str, object]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            first_render_started.set()
            if not release_lost_worker.wait(timeout=120):
                raise TimeoutError("lost PDF worker fixture was not released")
        return {"status": "ok", "rendered": ["resume_pdf"]}

    monkeypatch.setattr("jobctrl.materials.activities._render_pdf_for_job", fake_render_pdf)
    from jobctrl.infrastructure.temporal import run_in_activity

    original_run_blocking = run_in_activity.run_blocking_with_heartbeat

    async def simulate_process_kill(fn, **kwargs):
        return await original_run_blocking(fn, **kwargs, cancel_wait_seconds=0)

    monkeypatch.setattr(
        run_in_activity,
        "run_blocking_with_heartbeat",
        simulate_process_kill,
    )
    monkeypatch.setattr(
        prep_workflow_mod,
        "_DEFAULT_HEARTBEAT_TIMEOUT",
        timedelta(seconds=2),
    )
    original_cover_retry = prep_workflow_mod._COVER_RETRY
    prep_workflow_mod._COVER_RETRY = RetryPolicy(
        initial_interval=timedelta(milliseconds=100),
        maximum_interval=timedelta(milliseconds=100),
        maximum_attempts=3,
    )
    activities = [
        record_started,
        record_outcome,
        render_pdf_activity,
    ]
    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["pdf"],
        target_version="1",
        idempotency_key=f"preparation:{uuid.uuid4().hex}",
    )

    try:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            first_worker = Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=activities,
                workflow_runner=UnsandboxedWorkflowRunner(),
                graceful_shutdown_timeout=timedelta(0),
                max_cached_workflows=0,
            )
            first_worker_run = asyncio.create_task(first_worker.run())
            handle = await env.client.start_workflow(
                JobPreparationWorkflow.run,
                payload,
                id=f"prep-{payload.idempotency_key}",
                task_queue=queue,
            )
            assert await asyncio.to_thread(first_render_started.wait, 30)
            first_worker_run.cancel()
            await asyncio.gather(first_worker_run, return_exceptions=True)

            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=activities,
                workflow_runner=UnsandboxedWorkflowRunner(),
                max_cached_workflows=0,
                ):
                    result = await asyncio.wait_for(handle.result(), timeout=120)
            release_lost_worker.set()
            await asyncio.sleep(0)
    finally:
        prep_workflow_mod._COVER_RETRY = original_cover_retry

    assert result.steps_completed == ["pdf"]
    assert result.steps_failed == []
    assert attempts == 2


@pytest.mark.asyncio
async def test_preparation_workflow_retries_pdf_when_renderer_returns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = f"prep-pdf-renderer-return-{uuid.uuid4()}"
    attempts = 0

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload) -> None:
        return None

    def fake_render_pdf(_payload) -> dict[str, object]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("renderer executable temporarily unavailable")
        return {"status": "ok", "rendered": ["resume_pdf"]}

    monkeypatch.setattr("jobctrl.materials.activities._render_pdf_for_job", fake_render_pdf)
    original_cover_retry = prep_workflow_mod._COVER_RETRY
    prep_workflow_mod._COVER_RETRY = RetryPolicy(
        initial_interval=timedelta(milliseconds=100),
        maximum_interval=timedelta(milliseconds=100),
        maximum_attempts=3,
    )
    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["pdf"],
        target_version="1",
        idempotency_key=f"preparation:{uuid.uuid4().hex}",
    )

    try:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=[record_started, record_outcome, render_pdf_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await asyncio.wait_for(
                    env.client.execute_workflow(
                        JobPreparationWorkflow.run,
                        payload,
                        id=f"prep-{payload.idempotency_key}",
                        task_queue=queue,
                    ),
                    timeout=30,
                )
    finally:
        prep_workflow_mod._COVER_RETRY = original_cover_retry

    assert result.steps_completed == ["pdf"]
    assert result.steps_failed == []
    assert attempts == 2


@pytest.mark.asyncio
async def test_preparation_workflow_retries_transient_tailor_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = f"prep-tailor-retry-{uuid.uuid4()}"
    attempts = 0

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload) -> None:
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload) -> None:
        return None

    def fake_tailor_job(_payload, **_kwargs) -> dict[str, object]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary tailoring outage")
        return {"status": "approved", "materials": SimpleNamespace(generation=1)}

    monkeypatch.setattr("jobctrl.materials.activities._tailor_one_job", fake_tailor_job)
    payload = JobPreparationInput(
        tenant_id="local",
        job_id=_JOB_ID,
        steps=["tailor"],
        target_version="1",
        idempotency_key=f"preparation:{uuid.uuid4().hex}",
    )
    original_tailor_retry = prep_workflow_mod._TAILOR_RETRY
    prep_workflow_mod._TAILOR_RETRY = RetryPolicy(
        initial_interval=timedelta(milliseconds=100),
        maximum_interval=timedelta(milliseconds=100),
        maximum_attempts=3,
        non_retryable_error_types=["configuration", "authentication", "missing_input"],
    )

    try:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=[
                    _check_spend_budget,
                    record_started,
                    record_outcome,
                    tailor_job_activity,
                ],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                result = await asyncio.wait_for(
                    env.client.execute_workflow(
                        JobPreparationWorkflow.run,
                        payload,
                        id=f"prep-{payload.idempotency_key}",
                        task_queue=queue,
                        id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
                    ),
                    timeout=30,
                )
    finally:
        prep_workflow_mod._TAILOR_RETRY = original_tailor_retry

    assert result.steps_completed == ["tailor"]
    assert result.steps_failed == []
    assert attempts == 2
