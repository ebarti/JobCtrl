"""P1b error inversion, retry, and cancellation regressions."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import patch

import pytest
from temporalio import activity, workflow
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctl.database import init_db
from jobctl.discovery import smartextract, workday
from jobctl.discovery.jobspy import DiscoveryCancelled, run_discovery
from jobctl.domain.errors import (
    AuthenticationError,
    BrowserTransientError,
    ConfigurationError,
    JobCtlError,
    LlmTransientError,
    MissingInputError,
    SourceUnavailableError,
    TransientNetworkError,
    to_application_error,
)
from jobctl.enrichment.activities import EnrichActivityInput, EnrichActivityOutput, enrich_activity
from jobctl.infrastructure.discovery import production_wiring
from jobctl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
from jobctl.materials.activities import TailorActivityInput, TailorActivityOutput, tailor_activity
from jobctl.pipeline import runner as pipeline_runner
from jobctl.scoring.activities import ScoreActivityInput, ScoreActivityOutput, score_activity

_P1B_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=1),
    maximum_attempts=3,
    non_retryable_error_types=["configuration", "authentication", "missing_input"],
)
_OK_OBSERVED = ({"status": "ok"}, 0.0, "ok")


@workflow.defn(name="P1bScoreHarness")
class _P1bScoreHarness:
    @workflow.run
    async def run(self, payload: ScoreActivityInput) -> ScoreActivityOutput:
        return await workflow.execute_activity(
            score_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=_P1B_RETRY,
        )


@workflow.defn(name="P1bEnrichHarness")
class _P1bEnrichHarness:
    @workflow.run
    async def run(self, payload: EnrichActivityInput) -> EnrichActivityOutput:
        return await workflow.execute_activity(
            enrich_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=_P1B_RETRY,
        )


@workflow.defn(name="P1bTailorHarness")
class _P1bTailorHarness:
    @workflow.run
    async def run(self, payload: TailorActivityInput) -> TailorActivityOutput:
        return await workflow.execute_activity(
            tailor_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=_P1B_RETRY,
        )


_cooperative_observed_cancel = threading.Event()
_ignore_cancel_released = threading.Event()


@workflow.defn(name="P1bRunInActivityWorkflow")
class _P1bRunInActivityWorkflow:
    @workflow.run
    async def run(self, ignore_cancel: bool) -> str:
        return await workflow.execute_activity(
            _p1b_blocking_activity,
            ignore_cancel,
            start_to_close_timeout=timedelta(minutes=5),
            heartbeat_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@activity.defn(name="p1b_blocking_activity")
async def _p1b_blocking_activity(ignore_cancel: bool) -> str:
    cancel_event = threading.Event()

    def _blocking() -> str:
        if ignore_cancel:
            _ignore_cancel_released.wait(timeout=5)
            return "ignored"
        while not cancel_event.is_set():
            time.sleep(0.01)
        _cooperative_observed_cancel.set()
        return "cooperative-stop"

    return await run_blocking_with_heartbeat(
        _blocking,
        starting_message="p1b test starting",
        progress_message="p1b test still running",
        poll_interval=0.05,
        on_cancel=cancel_event.set,
        cancel_wait_seconds=0.2,
        activity_name="p1b_test_activity",
        job_context={"test": "p1b"},
    )


@dataclass(frozen=True)
class _ActivityCase:
    name: str
    workflow_class: type
    workflow_run: Callable[..., Any]
    payload: object
    activity: Callable[..., Any]


_ACTIVITY_CASES = (
    _ActivityCase("score", _P1bScoreHarness, _P1bScoreHarness.run, ScoreActivityInput(tenant_id="local"), score_activity),
    _ActivityCase("enrich", _P1bEnrichHarness, _P1bEnrichHarness.run, EnrichActivityInput(tenant_id="local"), enrich_activity),
    _ActivityCase("tailor", _P1bTailorHarness, _P1bTailorHarness.run, TailorActivityInput(tenant_id="local"), tailor_activity),
)


def test_error_taxonomy_maps_to_temporal_application_errors() -> None:
    cases: tuple[tuple[type[JobCtlError], str, bool], ...] = (
        (ConfigurationError, "configuration", True),
        (AuthenticationError, "authentication", True),
        (MissingInputError, "missing_input", True),
        (TransientNetworkError, "transient_network", False),
        (BrowserTransientError, "browser_transient", False),
        (LlmTransientError, "llm_transient", False),
        (SourceUnavailableError, "source_unavailable", False),
    )

    for error_type, expected_code, expected_non_retryable in cases:
        app_error = to_application_error(error_type("boom"))
        assert app_error.type == expected_code
        assert app_error.non_retryable is expected_non_retryable

    unknown = to_application_error(RuntimeError("plain boom"))
    assert unknown.type == "unclassified"
    assert unknown.non_retryable is False


def _application_error_from_failure(exc: WorkflowFailureError) -> ApplicationError:
    cause = exc.cause
    if isinstance(cause, ActivityError) and isinstance(cause.cause, ApplicationError):
        return cause.cause
    if isinstance(cause, ApplicationError):
        return cause
    raise AssertionError(f"Expected ApplicationError cause, got {cause!r}")


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _ACTIVITY_CASES, ids=lambda case: case.name)
async def test_activity_wrapper_configuration_error_is_non_retryable(case: _ActivityCase) -> None:
    attempts = 0

    def _raise_configuration(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise ConfigurationError("missing local config")

    queue = f"p1b-{case.name}-config-{uuid.uuid4()}"
    with patch("jobctl.pipeline.runner._run_stage_observed", side_effect=_raise_configuration):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[case.workflow_class],
                activities=[case.activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                with pytest.raises(WorkflowFailureError) as exc_info:
                    await env.client.execute_workflow(
                        case.workflow_run,
                        case.payload,
                        id=f"p1b-{case.name}-config-wf-{uuid.uuid4()}",
                        task_queue=queue,
                    )

    app_error = _application_error_from_failure(exc_info.value)
    assert attempts == 1
    assert app_error.type == "configuration"
    assert app_error.non_retryable is True


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _ACTIVITY_CASES, ids=lambda case: case.name)
async def test_activity_wrapper_transient_error_retries_then_succeeds(case: _ActivityCase) -> None:
    attempts = 0

    def _transient_then_ok(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise TransientNetworkError("temporary outage")
        return _OK_OBSERVED

    queue = f"p1b-{case.name}-transient-{uuid.uuid4()}"
    with patch("jobctl.pipeline.runner._run_stage_observed", side_effect=_transient_then_ok):
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[case.workflow_class],
                activities=[case.activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output = await env.client.execute_workflow(
                    case.workflow_run,
                    case.payload,
                    id=f"p1b-{case.name}-transient-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    assert attempts == 3
    assert output.status == "ok"


@pytest.mark.asyncio
async def test_run_in_activity_cancel_event_stops_cooperative_thread() -> None:
    _cooperative_observed_cancel.clear()
    queue = f"p1b-run-in-activity-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[_P1bRunInActivityWorkflow],
            activities=[_p1b_blocking_activity],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                _P1bRunInActivityWorkflow.run,
                False,
                id=f"p1b-run-in-activity-wf-{uuid.uuid4()}",
                task_queue=queue,
            )
            await asyncio.sleep(0.2)
            await handle.cancel()
            with pytest.raises(WorkflowFailureError) as exc_info:
                await handle.result()

    assert isinstance(exc_info.value.cause, CancelledError)
    assert _cooperative_observed_cancel.is_set()


@pytest.mark.asyncio
async def test_run_in_activity_records_abandoned_thread_when_cancel_ignored(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    cancel_event = threading.Event()
    monkeypatch.setattr(
        "jobctl.infrastructure.temporal.run_in_activity.activity.heartbeat",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "jobctl.infrastructure.temporal.run_in_activity.activity.info",
        lambda: SimpleNamespace(activity_type="p1b_test_activity"),
    )

    async def _drive() -> None:
        await run_blocking_with_heartbeat(
            lambda: "ignored" if release.wait(timeout=5) else "timed-out",
            starting_message="p1b test starting",
            progress_message="p1b test still running",
            poll_interval=0.01,
            on_cancel=cancel_event.set,
            cancel_wait_seconds=0.05,
            activity_name="p1b_test_activity",
            job_context={"test": "p1b"},
        )

    with patch(
        "jobctl.infrastructure.temporal.run_in_activity._record_abandoned_thread_metric",
    ) as metric_mock:
        with caplog.at_level(logging.WARNING, logger="jobctl.infrastructure.temporal.run_in_activity"):
            task = asyncio.create_task(_drive())
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            release.set()

    assert cancel_event.is_set()
    assert any(record.message == "abandoned_thread" for record in caplog.records)
    metric_mock.assert_called_once()


def test_run_stage_observed_reraises_after_stage_failed_event(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, str, str, dict[str, Any]]] = []
    monkeypatch.setattr(
        pipeline_runner,
        "_record_pipeline_event",
        lambda stage, event_type, level, _message, payload: events.append((stage, event_type, level, payload)),
    )
    monkeypatch.setattr(pipeline_runner, "_record_operational_attempt", lambda **_kwargs: None)

    def _raise() -> dict[str, Any]:
        raise MissingInputError("profile missing")

    with pytest.raises(MissingInputError):
        pipeline_runner._run_stage_observed("score", _raise, {}, mode="test", pass_number=2)

    failed = [event for event in events if event[1] == "StageFailed"]
    assert len(failed) == 1
    stage, event_type, level, payload = failed[0]
    assert (stage, event_type, level) == ("score", "StageFailed", "error")
    assert payload["mode"] == "test"
    assert payload["passNumber"] == 2
    assert isinstance(payload["durationMs"], int)
    assert payload["errorCode"] == "MissingInputError"
    assert payload["errorMessage"] == "profile missing"


def test_jobspy_cancel_event_stops_before_first_search() -> None:
    cancel_event = threading.Event()
    cancel_event.set()
    cfg = {
        "queries": [{"query": "python", "tier": 1}],
        "locations": [{"location": "Remote"}],
        "defaults": {},
    }

    with pytest.raises(DiscoveryCancelled):
        run_discovery(cfg=cfg, cancel_event=cancel_event)


def test_ats_cancel_event_stops_before_adapter_scrape(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = init_db(tmp_path / "ats.db")
    cancel_event = threading.Event()
    cancel_event.set()

    class _Source:
        should_run = True
        source_id = "greenhouse:acme"
        adapter_config: dict[str, str] = {}

    class _Adapter:
        def scrape(self, **_kwargs):
            raise AssertionError("scrape should not run after cancellation")

    monkeypatch.setattr(production_wiring, "_adapter_for_source", lambda *_args, **_kwargs: _Adapter())

    with pytest.raises(TransientNetworkError):
        production_wiring.run_scheduled_ats_sources(
            conn,
            [_Source()],
            search_cfg={"queries": [{"query": "python"}], "locations": [{"location": "Remote"}]},
            run_id="p1b-cancel",
            cancel_event=cancel_event,
        )


def test_workday_cancel_event_stops_before_employer_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancel_event = threading.Event()
    cancel_event.set()
    monkeypatch.setattr(workday, "workday_search", lambda *_args, **_kwargs: pytest.fail("network should not run"))

    with pytest.raises(TransientNetworkError):
        workday.scrape_employers(
            "",
            {"acme": {"name": "Acme"}},
            accept_locs=[],
            reject_locs=[],
            cancel_event=cancel_event,
        )


def test_smartextract_cancel_event_stops_before_page_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancel_event = threading.Event()
    cancel_event.set()
    monkeypatch.setattr(
        smartextract,
        "collect_page_intelligence",
        lambda *_args, **_kwargs: pytest.fail("page request should not run"),
    )

    with pytest.raises(TransientNetworkError):
        smartextract._run_one_site("Acme", "https://example.com/jobs", cancel_event=cancel_event)
