"""Cleanup privacy through the real Claude kit with synthetic SDK messages."""
from __future__ import annotations

import asyncio
import threading
import uuid
from types import SimpleNamespace

import pytest
from claude_agent_sdk import ResultMessage

import jobctrl.llm as accounting
from jobctrl.infrastructure.llm import agent_runtime_claude
from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService
from jobctrl.infrastructure.llm.llm_client import ClaudeSdkBackend
from jobctrl.llm_lanes import bind_llm_lane


def _receipt(*, failed, input_tokens, output_tokens):
    return ResultMessage(
        subtype='error_max_budget_usd' if failed else 'success',
        duration_ms=1, duration_api_ms=1, is_error=failed, num_turns=1,
        session_id='synthetic-session', result='synthetic output',
        usage={'input_tokens': input_tokens, 'output_tokens': output_tokens},
    )


def _call(backend):
    return backend._call(
        [{'role': 'user', 'content': 'synthetic'}], response_schema=None,
        temperature=None, max_tokens=None, thinking_budget=None,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize('terminal_failed', [False, True])
@pytest.mark.parametrize('cleanup_fails', [False, True])
async def test_cancel_during_runtime_close_preserves_usage_without_raw_logs(
    monkeypatch, caplog, in_memory_exporter, terminal_failed, cleanup_fails,
):
    monkeypatch.setattr('jobctrl.infrastructure.setup_probes.bundled_claude_sdk_options', lambda: {})
    monkeypatch.setattr(accounting, 'enforce_spend_budget', lambda _lane=None: None)
    spend = []
    monkeypatch.setattr(accounting, 'record_llm_spend', lambda **values: spend.append(values))
    monkeypatch.setenv('JOBCTRL_TRACE_CONTENT', '1')
    marker = uuid.uuid4().hex
    observed, finish_stream, closing, release_close = (threading.Event() for _ in range(4))
    close_calls = 0
    service = AgentRuntimeService(capacity=1)
    monkeypatch.setattr(agent_runtime_claude, 'agent_runtime_service', lambda: service)

    def blocked_query(*, prompt, options):
        async def stream():
            yield _receipt(failed=terminal_failed, input_tokens=11, output_tokens=7)
            observed.set()
            await asyncio.to_thread(finish_stream.wait, 5)
        return stream()

    def other_query(*, prompt, options):
        async def stream():
            yield _receipt(failed=False, input_tokens=5, output_tokens=3)
        return stream()

    async def blocked_close(_self):
        nonlocal close_calls
        close_calls += 1
        # The first request's close occurs when the second request has filled
        # the idle cache. The second runtime is closed at service shutdown.
        if close_calls == 1:
            closing.set()
            await asyncio.to_thread(release_close.wait, 5)
            if cleanup_fails:
                raise OSError(marker)

    monkeypatch.setattr(agent_runtime_claude.ClaudeAgentRuntime, 'aclose', blocked_close)
    def options(**kwargs):
        return SimpleNamespace(**kwargs)

    first = ClaudeSdkBackend(model='claude-synthetic', query_fn=blocked_query, options_factory=options)
    second = ClaudeSdkBackend(model='claude-synthetic', query_fn=other_query, options_factory=options)
    running = None
    try:
        with bind_llm_lane('tailoring'):
            running = asyncio.create_task(_call(first))
            assert await asyncio.to_thread(observed.wait, 5)
            assert await _call(second) == 'synthetic output'
            finish_stream.set()
            assert await asyncio.to_thread(closing.wait, 5)
            running.cancel('first cancellation')
            await asyncio.sleep(0)

            async def cancellation_reached_runtime_loop():
                while not any(task.cancelling() for task in service._pool._running):
                    await asyncio.sleep(0)
                # Allow the cancelled waiter's callbacks to run before close.
                await asyncio.sleep(0)
                await asyncio.sleep(0)

            barrier = asyncio.run_coroutine_threadsafe(cancellation_reached_runtime_loop(), service._loop)
            await asyncio.wait_for(asyncio.wrap_future(barrier), 5)
            assert not running.done()
            running.cancel('repeated cancellation')
            await asyncio.sleep(0)
            release_close.set()
            with pytest.raises(asyncio.CancelledError) as caught:
                await asyncio.wait_for(running, 5)
            assert caught.value.args == ('first cancellation',)
    finally:
        finish_stream.set()
        release_close.set()
        if running is not None and not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
        await asyncio.to_thread(service.close)

    assert close_calls == 2
    assert sorted((row['input_tokens'], row['output_tokens'], row['lane']) for row in spend) == [
        (5, 3, 'tailoring'), (11, 7, 'tailoring'),
    ]
    assert ('Claude cleanup failed after a terminal receipt during cancellation' in caplog.text) is cleanup_fails
    assert marker not in caplog.text
    assert not [record for record in caplog.records if record.name == 'asyncio']
    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 2
    assert marker not in repr([span.attributes for span in spans])
    cancelled_span = next(span for span in spans if span.attributes.get('gen_ai.usage.input_tokens') == 11)
    assert cancelled_span.attributes['gen_ai.usage.output_tokens'] == 7
    assert cancelled_span.attributes.get('jobctrl.llm.success') is not True
    assert 'langfuse.observation.output' not in cancelled_span.attributes
