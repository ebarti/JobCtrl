"""Exercise the real kit Codex adapter with owned synthetic SDK transports."""
from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.llm import agent_runtime_codex as adapter
from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError


@pytest.fixture
def service(monkeypatch):
    owner = AgentRuntimeService(capacity=2)
    monkeypatch.setattr(adapter, 'agent_runtime_service', lambda: owner)
    yield owner
    owner.close()


def approval():
    return 'deny-all'


class Transport:
    def __init__(self):
        self.clients = []
        self.threads = []
        self.active = 0
        self.peak = 0
        self.both_started = threading.Event()
        self.release = threading.Event()
        self.block_turns = False
        self.expected_parallelism = 2

    def factory(self):
        client = Client(self)
        self.clients.append(client)
        return client


class Client:
    def __init__(self, owner):
        self.owner = owner
        self.closed = False
        self.close_count = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        self.closed = True
        self.close_count += 1

    async def thread_start(self, **kwargs):
        thread = Thread(self.owner, kwargs)
        self.owner.threads.append(thread)
        return thread


class Thread:
    def __init__(self, owner, kwargs):
        self.owner = owner
        self.kwargs = kwargs
        self.id = f'owned-thread-{len(owner.threads)}'

    async def run(self, prompt, **kwargs):
        self.owner.active += 1
        self.owner.peak = max(self.owner.peak, self.owner.active)
        if self.owner.active == self.owner.expected_parallelism:
            self.owner.both_started.set()
        try:
            if self.owner.block_turns:
                await asyncio.to_thread(self.owner.release.wait)
            if prompt == 'owned-failed-turn':
                return SimpleNamespace(status='failed', error=SimpleNamespace(message='owned private detail'))
            return SimpleNamespace(
                status='completed', final_response=json.dumps({'marker': prompt}), error=None,
                usage=SimpleNamespace(total=SimpleNamespace(input_tokens=5, output_tokens=3)),
            )
        finally:
            self.owner.active -= 1


async def call(factory, marker, model='owned-model'):
    return await adapter.call_codex_runtime(
        factory=factory, approval=approval, model=model, effort='max', prompt=marker,
        operation='chat_json', output_schema={
            'type': 'object', 'properties': {'marker': {'type': 'string', 'enum': [marker]}},
            'required': ['marker'], 'additionalProperties': False,
        },
    )


@pytest.mark.asyncio
async def test_kit_reuses_one_process_with_distinct_ephemeral_threads(service):
    transport = Transport()
    factory = transport.factory
    first = await call(factory, 'owned-one')
    second = await call(factory, 'owned-two')
    assert len(transport.clients) == 1
    assert not transport.clients[0].closed
    assert first.session_id != second.session_id
    assert first.runtime_metadata['sdk_process_reused'] is False
    assert second.runtime_metadata['sdk_process_reused'] is True
    assert second.runtime_metadata['sdk_process_start_count'] == 1
    assert second.runtime_metadata['sdk_process_reuse_count'] == 1
    assert (second.input_tokens, second.output_tokens) == (5, 3)
    assert [json.loads(first.text), json.loads(second.text)] == [
        {'marker': 'owned-one'}, {'marker': 'owned-two'},
    ]
    for thread in transport.threads:
        assert thread.kwargs['ephemeral'] is True
        assert thread.kwargs['approval_mode'] == 'deny-all'
        assert thread.kwargs['config'] == {'model_reasoning_effort': 'max'}
        assert 'sandbox' not in thread.kwargs


@pytest.mark.asyncio
async def test_actual_kit_instances_keep_independent_requests_parallel(service):
    transport = Transport()
    transport.block_turns = True
    transport.expected_parallelism = 3
    factory = transport.factory
    running = [asyncio.create_task(call(factory, marker)) for marker in ('owned-a', 'owned-b', 'owned-c')]
    try:
        assert await asyncio.to_thread(transport.both_started.wait, 2)
        assert transport.peak == len(transport.clients) == 3
        transport.release.set()
        results = await asyncio.gather(*running)
        assert {json.loads(result.text)['marker'] for result in results} == {'owned-a', 'owned-b', 'owned-c'}
        assert len({result.session_id for result in results}) == 3
    finally:
        transport.release.set()
        await asyncio.gather(*running, return_exceptions=True)


@pytest.mark.asyncio
async def test_changed_model_replaces_the_idle_kit_runtime(service):
    transport = Transport()
    factory = transport.factory
    await call(factory, 'owned-first', model='owned-model-a')
    await call(factory, 'owned-second', model='owned-model-b')
    assert len(transport.clients) == 2
    assert transport.clients[0].closed and transport.clients[0].close_count == 1
    assert not transport.clients[1].closed


@pytest.mark.asyncio
async def test_failed_native_turn_evicts_client_without_leaking_provider_text(service):
    transport = Transport()
    factory = transport.factory
    with pytest.raises(ProviderCallError) as caught:
        await call(factory, 'owned-failed-turn')
    assert 'owned private detail' not in str(caught.value) + json.dumps(caught.value.envelope.to_dict())
    assert transport.clients[0].closed and transport.clients[0].close_count == 1
    await call(factory, 'owned-next')
    assert len(transport.clients) == 2


@pytest.mark.asyncio
async def test_cancel_during_sdk_start_waits_for_publication_before_close(service):
    publication_started = threading.Event()
    publish = threading.Event()
    contexts = []

    class StartingClient(Client):
        async def __aenter__(self):
            self.published = False
            async def start():
                publication_started.set()
                await asyncio.to_thread(publish.wait)
                self.published = True
                return self
            self.starting = asyncio.create_task(start())
            return await asyncio.shield(self.starting)

        async def __aexit__(self, *args):
            self.closed_before_publication = not self.published
            return await super().__aexit__(*args)

    def factory():
        client = StartingClient(Transport())
        contexts.append(client)
        return client

    running = asyncio.create_task(call(factory, 'owned-cancel-at-start'))
    try:
        assert await asyncio.to_thread(publication_started.wait, 2)
        running.cancel()
        await asyncio.sleep(0.02)
        assert not running.done(), 'Cancellation must settle SDK startup before releasing its runtime.'
        publish.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(running, 2)
        assert contexts[0].published and contexts[0].closed
        assert not contexts[0].closed_before_publication
        assert contexts[0].close_count == 1
    finally:
        publish.set()
        await asyncio.gather(running, return_exceptions=True)



@pytest.mark.asyncio
async def test_tool_free_instructions_use_supported_sdk_field_and_preserve_task(service):
    import inspect
    from openai_codex import AsyncCodex
    from jobctrl.infrastructure.llm.task_instructions import CODEX_TASK_INSTRUCTIONS

    assert "base_instructions" in inspect.signature(AsyncCodex.thread_start).parameters
    transport = Transport()
    outcome = await call(transport.factory, "owned-task")
    assert transport.threads[0].kwargs["base_instructions"] == CODEX_TASK_INSTRUCTIONS
    assert json.loads(outcome.text) == {"marker": "owned-task"}
    assert transport.threads[0].kwargs["approval_mode"] == "deny-all"
    assert transport.threads[0].kwargs["config"] == {"model_reasoning_effort": "max"}


@pytest.mark.asyncio
async def test_changed_instruction_profile_replaces_idle_process(service, monkeypatch):
    transport = Transport()
    factory = transport.factory
    await call(factory, "owned-before")
    monkeypatch.setattr(adapter, "CODEX_TASK_INSTRUCTION_PROFILE", "b" * 64)
    await call(factory, "owned-after")
    assert len(transport.clients) == 2
    assert transport.clients[0].closed
    assert not transport.clients[1].closed
