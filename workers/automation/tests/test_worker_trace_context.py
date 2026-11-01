"""Workflow/model trace joins survive reusable executor and stage fan-out hops."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import asyncio
import contextvars
import dataclasses
import threading

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags
import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from jobctrl.llm_lanes import lane_bound
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.infrastructure.temporal import run_in_activity
from jobctrl.infrastructure.workflow_run_context import (
    carry_workflow_run_context,
    current_workflow_id,
    workflow_run_context,
)


def _span(identity: int) -> NonRecordingSpan:
    return NonRecordingSpan(SpanContext(
        trace_id=identity, span_id=identity + 100,
        is_remote=False, trace_flags=TraceFlags(1),
    ))


def _identity() -> tuple[int, int, str | None]:
    context = trace.get_current_span().get_span_context()
    return context.trace_id, context.span_id, current_workflow_id()


def test_concurrent_workflows_keep_distinct_submitting_trace_parents() -> None:
    rendezvous = threading.Barrier(2)

    def inspect():
        rendezvous.wait(timeout=3)
        return _identity()

    wrappers = []
    for number in (1, 2):
        with trace.use_span(_span(number)), workflow_run_context(f"synthetic-{number}"):
            wrappers.append(carry_workflow_run_context(inspect))
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(wrapper) for wrapper in wrappers]
        assert [future.result(timeout=5) for future in futures] == [
            (1, 101, "synthetic-1"), (2, 102, "synthetic-2"),
        ]
        assert pool.submit(_identity).result(timeout=5) == (0, 0, None)


def test_same_wrapper_can_run_concurrently_without_reentering_a_python_context() -> None:
    rendezvous = threading.Barrier(2)

    def inspect():
        rendezvous.wait(timeout=3)
        return _identity()

    with trace.use_span(_span(3)), workflow_run_context("synthetic-shared"):
        wrapper = carry_workflow_run_context(inspect)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(wrapper) for _ in range(2)]
        assert [future.result(timeout=5) for future in futures] == [
            (3, 103, "synthetic-shared"), (3, 103, "synthetic-shared"),
        ]


@pytest.mark.parametrize("fails", [False, True])
def test_reused_thread_restores_its_context_and_does_not_copy_other_contextvars(fails) -> None:
    unrelated = contextvars.ContextVar("synthetic_unrelated", default="unbound")

    def inspect():
        assert _identity() == (4, 104, "synthetic-caller")
        assert unrelated.get() == "worker-value"
        if fails:
            raise RuntimeError("synthetic failure")
        return "complete"

    token = unrelated.set("caller-value")
    try:
        with trace.use_span(_span(4)), workflow_run_context("synthetic-caller"):
            wrapper = carry_workflow_run_context(inspect)
    finally:
        unrelated.reset(token)

    def reused():
        with trace.use_span(_span(5)), workflow_run_context("synthetic-worker"):
            token = unrelated.set("worker-value")
            try:
                if fails:
                    with pytest.raises(RuntimeError, match="synthetic failure"):
                        wrapper()
                else:
                    assert wrapper() == "complete"
                assert _identity() == (5, 105, "synthetic-worker")
                assert unrelated.get() == "worker-value"
            finally:
                unrelated.reset(token)

    with ThreadPoolExecutor(max_workers=1) as pool:
        for _ in range(3):
            pool.submit(reused).result(timeout=5)
            assert pool.submit(_identity).result(timeout=5) == (0, 0, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("owned_executor", [False, True])
@pytest.mark.parametrize("fails", [False, True])
async def test_real_activity_handoff_joins_nested_model_spans_and_keeps_exports_private(
    monkeypatch, owned_executor, fails,
) -> None:
    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("synthetic.activity")
    monkeypatch.setattr(trace, "get_tracer", provider.get_tracer)
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda _lane: None)
    monkeypatch.setattr("jobctrl.infrastructure.llm.attempt_admission.check_model_attempt_admission", lambda: None)
    executor = run_in_activity.ActivityThreadPoolExecutor(max_workers=1) if owned_executor else None
    monkeypatch.setattr(run_in_activity, "_ACTIVITY_EXECUTOR", executor)
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, workflow_id="synthetic-traced-workflow")
    secret = "synthetic private prompt completion and exception"
    observed = []

    @lane_bound("scoring")
    def generate():
        assert not activity.in_activity()
        observed.append(current_workflow_id())
        with llm_generation_span(
            model="gpt-6.1-sol", messages=[{"role": "user", "content": secret}],
            params={"structured": True, "effort": "max", "private": secret},
        ) as record:
            if fails:
                raise RuntimeError(secret)
            record(secret)

    def blocking():
        assert not activity.in_activity()
        observed.append(current_workflow_id())
        with tracer.start_as_current_span("scoring.score_job", record_exception=False, set_status_on_exception=False):
            with ThreadPoolExecutor(max_workers=1) as fanout:
                fanout.submit(carry_workflow_run_context(generate)).result(timeout=5)

    async def activity_probe():
        return await run_in_activity.run_blocking_with_heartbeat(
            blocking, starting_message="synthetic tracing probe", poll_interval=0.01,
        )

    try:
        with tracer.start_as_current_span("synthetic.activity", record_exception=False, set_status_on_exception=False) as parent:
            parent_context = parent.get_span_context()
            if fails:
                with pytest.raises(RuntimeError, match=secret):
                    await env.run(activity_probe)
            else:
                await env.run(activity_probe)
            assert trace.get_current_span().get_span_context() == parent_context
        spans = {span.name: span for span in exporter.get_finished_spans()}
        assert set(spans) == {"synthetic.activity", "scoring.score_job", "llm.gpt-6.1-sol"}
        scoring = spans["scoring.score_job"]
        generation = spans["llm.gpt-6.1-sol"]
        assert scoring.parent.span_id == parent_context.span_id
        assert generation.parent.span_id == scoring.context.span_id
        assert {span.context.trace_id for span in spans.values()} == {parent_context.trace_id}
        assert observed == ["synthetic-traced-workflow", "synthetic-traced-workflow"]
        assert generation.attributes["jobctrl.llm.success"] is not fails
        assert generation.attributes["gen_ai.request.reasoning_effort"] == "max"
        assert not generation.events
        assert secret not in str(generation.attributes)
        assert secret not in str(generation.status)
    finally:
        if executor is not None:
            executor.shutdown(wait=True)
        provider.shutdown()


@pytest.mark.asyncio
async def test_cancellation_rotation_keeps_settling_and_replacement_parents_separate(monkeypatch) -> None:
    from types import SimpleNamespace

    entered = threading.Event()
    release = threading.Event()
    canceled = threading.Event()
    executor = run_in_activity.ActivityThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(run_in_activity, "_ACTIVITY_EXECUTOR", executor)
    monkeypatch.setattr(run_in_activity, "_RETIRED_ACTIVITY_EXECUTORS", [])
    monkeypatch.setattr(activity, "in_activity", lambda: False)
    monkeypatch.setattr(activity, "info", lambda: SimpleNamespace(activity_type="synthetic"))
    monkeypatch.setattr(activity, "heartbeat", lambda *_args: None)

    def slow():
        entered.set()
        assert release.wait(timeout=5)
        return _identity()

    with trace.use_span(_span(10)), workflow_run_context("synthetic-settling"):
        pending = asyncio.create_task(run_in_activity.run_blocking_with_heartbeat(
            slow, starting_message="synthetic slow", on_cancel=canceled.set,
            poll_interval=0.01, cancel_wait_seconds=0,
        ))
    try:
        assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 2), timeout=3)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert canceled.is_set()
        replacement = run_in_activity._ACTIVITY_EXECUTOR
        assert replacement is not executor
        abandoned = run_in_activity._RETIRED_ACTIVITY_EXECUTORS[0][1]
        with trace.use_span(_span(11)), workflow_run_context("synthetic-replacement"):
            actual = await asyncio.wait_for(run_in_activity.run_blocking_with_heartbeat(
                _identity, starting_message="synthetic replacement", poll_interval=0.01,
            ), timeout=2)
        assert actual == (11, 111, "synthetic-replacement")
        assert replacement.submit(_identity).result(timeout=2) == (0, 0, None)
        release.set()
        assert await asyncio.wait_for(asyncio.shield(abandoned), timeout=2) == (
            10, 110, "synthetic-settling",
        )
        assert _identity() == (0, 0, None)
    finally:
        release.set()
        if not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        executor.shutdown(wait=True)
        replacement = run_in_activity._ACTIVITY_EXECUTOR
        if replacement is not executor:
            replacement.shutdown(wait=True)
