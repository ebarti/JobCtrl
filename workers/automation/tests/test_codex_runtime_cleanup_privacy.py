"""Codex startup and cleanup use synthetic clients and owned storage only."""
from __future__ import annotations

import asyncio
import json
import threading
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.analysis.codex_analysis_adapter import _codex_client_context
from jobctrl.infrastructure.llm.agent_runtime_codex import _Client, _CodexCleanupError, _safe_cleanup_exception


def test_cleanup_exception_sanitization_preserves_control_flow_in_nested_groups():
    marker = uuid.uuid4().hex
    original = BaseExceptionGroup(marker, [
        KeyboardInterrupt(marker), SystemExit(marker), SystemExit(23), SystemExit(False), SystemExit(True),
        GeneratorExit(marker),
        BaseExceptionGroup(marker, [asyncio.CancelledError(marker), OSError(marker)]),
    ])
    safe = _safe_cleanup_exception(original)
    assert isinstance(safe, BaseExceptionGroup)
    keyboard, failed_exit, numeric_exit, false_exit, true_exit, generator, nested = safe.exceptions
    assert isinstance(keyboard, KeyboardInterrupt) and keyboard.args == ()
    assert isinstance(failed_exit, SystemExit) and failed_exit.code == 1
    assert isinstance(numeric_exit, SystemExit) and numeric_exit.code == 23
    assert isinstance(false_exit, SystemExit) and false_exit.code is False
    assert isinstance(true_exit, SystemExit) and true_exit.code is True
    assert isinstance(generator, GeneratorExit) and generator.args == ()
    assert isinstance(nested, BaseExceptionGroup)
    cancellation, failure = nested.exceptions
    assert isinstance(cancellation, asyncio.CancelledError) and cancellation.args == ()
    assert isinstance(failure, _CodexCleanupError)
    assert marker not in repr(safe)
    assert all(item.__context__ is None for item in (*safe.exceptions, *nested.exceptions))


def test_cleanup_sanitization_handles_deeply_nested_exception_groups():
    marker = uuid.uuid4().hex
    original = BaseExceptionGroup(marker, [asyncio.CancelledError(marker), OSError(marker)])
    for _ in range(1200):
        original = BaseExceptionGroup(marker, [original])
    safe = _safe_cleanup_exception(original)
    for _ in range(1200):
        assert isinstance(safe, BaseExceptionGroup)
        assert safe.message == 'Codex client cleanup failed.'
        safe = safe.exceptions[0]
    assert isinstance(safe, BaseExceptionGroup)
    assert isinstance(safe.exceptions[0], asyncio.CancelledError)
    assert isinstance(safe.exceptions[1], _CodexCleanupError)


@pytest.mark.asyncio
@pytest.mark.parametrize('phase', ['startup', 'shutdown'])
@pytest.mark.parametrize('failure', [False, True])
@pytest.mark.parametrize('cancellations', [0, 1, 2])
async def test_native_context_joins_cancellation_without_logging_private_errors(
    tmp_path, caplog, phase, failure, cancellations,
):
    marker = uuid.uuid4().hex
    original = OSError(marker)
    entered, release = asyncio.Event(), asyncio.Event()
    closed = []
    roots = []
    home = tmp_path / 'owned-home'
    home.mkdir()

    class Client:
        def __init__(self, *, config):
            self._client = self
            for entry in config.config_overrides:
                name, value = entry.split('=', 1)
                if name in {'sqlite_home', 'log_dir'}:
                    roots.append((name, Path(json.loads(value))))

        async def start(self):
            if phase == 'startup':
                entered.set()
                await release.wait()
                if failure:
                    raise original

        async def __aenter__(self):
            return self

        async def close(self):
            if phase == 'shutdown':
                entered.set()
                await release.wait()
            assert all(path.exists() if name == 'sqlite_home' else path.parent.exists() for name, path in roots)
            closed.append(True)
            if phase == 'shutdown' and failure:
                raise original

    async def use():
        async with _codex_client_context(
            Client, SimpleNamespace,
            configuration={'env': {'CODEX_HOME': str(home)}, 'config_overrides': (), 'cwd': str(tmp_path)},
        ):
            pass

    running = asyncio.create_task(use())
    try:
        await asyncio.wait_for(entered.wait(), 2)
        for _ in range(cancellations):
            running.cancel()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not running.done()
        release.set()
        if failure:
            with pytest.raises(OSError) as caught:
                await asyncio.wait_for(running, 2)
            assert caught.value is original
        elif cancellations:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(running, 2)
        else:
            await asyncio.wait_for(running, 2)
        assert closed == [True]
        assert all(not path.parent.exists() for _, path in roots)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert ('Codex startup or cleanup failed during cancellation' in caplog.text) is (failure and bool(cancellations))
        assert not [record for record in caplog.records if record.name == 'asyncio']
        assert marker not in caplog.text
    finally:
        release.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', [False, True])
@pytest.mark.parametrize('cancellations', [0, 1, 2])
async def test_injected_client_joins_cancelled_startup_without_logging_private_errors(
    caplog, failure, cancellations,
):
    marker = uuid.uuid4().hex
    original = OSError(marker)
    entered, release = asyncio.Event(), asyncio.Event()
    closed = []

    class Context:
        async def __aenter__(self):
            entered.set()
            await release.wait()
            if failure:
                raise original
            return self

        async def __aexit__(self, *_args):
            closed.append(True)

    client = _Client(Context)
    running = asyncio.create_task(client.__aenter__())
    try:
        await asyncio.wait_for(entered.wait(), 2)
        for _ in range(cancellations):
            running.cancel()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not running.done()
        release.set()
        if cancellations:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(running, 2)
        elif failure:
            with pytest.raises(OSError) as caught:
                await asyncio.wait_for(running, 2)
            assert caught.value is original
        else:
            assert await asyncio.wait_for(running, 2) is client
        await client.__aexit__(None, None, None)
        assert closed == [True]
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert ('Codex startup failed during cancellation' in caplog.text) is (failure and bool(cancellations))
        assert not [record for record in caplog.records if record.name == 'asyncio']
        assert marker not in caplog.text
    finally:
        release.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('phase,exception_kind', [
    ('startup', 'error'), ('startup', 'group'), ('startup', 'cancelled'), ('startup', 'cancelled_group'),
    ('startup', 'fatal_group'), ('shutdown', 'error'), ('shutdown', 'group'), ('shutdown', 'cancelled'),
    ('shutdown', 'cancelled_group'), ('shutdown', 'fatal_group'),
])
async def test_kit_cancellation_joins_failed_native_lifecycle_without_private_logs(
    monkeypatch, tmp_path, caplog, phase, exception_kind,
):
    import jobctrl.config
    import openai_codex
    from jobctrl.infrastructure.analysis import codex_analysis_adapter as adapter
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService

    marker = uuid.uuid4().hex
    primary_marker = uuid.uuid4().hex
    entered, release, closed = (threading.Event() for _ in range(3))
    roots = []
    binary = tmp_path / 'synthetic-codex'
    binary.write_text('#!/bin/sh\nexit 0\n')
    binary.chmod(0o700)
    monkeypatch.setattr(jobctrl.config, 'APP_DIR', tmp_path / 'app')
    monkeypatch.setattr(adapter, 'ensure_jobctrl_codex_auth', lambda: None)
    monkeypatch.setattr(adapter, 'resolve_codex_binary', lambda: binary)

    def fail():
        if exception_kind == 'group':
            raise BaseExceptionGroup('synthetic cleanup failure', [asyncio.CancelledError(), OSError(marker)])
        if exception_kind == 'cancelled':
            raise asyncio.CancelledError(marker)
        if exception_kind == 'cancelled_group':
            raise BaseExceptionGroup('synthetic cancellation', [asyncio.CancelledError(marker)])
        if exception_kind == 'fatal_group':
            raise BaseExceptionGroup(marker, [KeyboardInterrupt(marker), SystemExit(3), OSError(marker)])
        raise OSError(marker)

    class Client:
        def __init__(self, *, config):
            self._client = self
            for entry in config.config_overrides:
                if entry.startswith(('sqlite_home=', 'log_dir=')):
                    name, value = entry.split('=', 1)
                    roots.append((name, Path(json.loads(value))))

        async def start(self):
            if phase == 'startup':
                entered.set()
                await asyncio.to_thread(release.wait, 5)
                fail()

        async def __aenter__(self):
            return self

        async def thread_start(self, **_kwargs):
            async def run(_prompt, **_kwargs):
                raise OSError(primary_marker)
            return SimpleNamespace(id='synthetic-thread', run=run)

        async def close(self):
            if phase == 'shutdown':
                entered.set()
                await asyncio.to_thread(release.wait, 5)
            assert all(path.exists() if name == 'sqlite_home' else path.parent.exists() for name, path in roots)
            closed.set()
            if phase == 'shutdown':
                fail()

    monkeypatch.setattr(openai_codex, 'AsyncCodex', Client)
    service = AgentRuntimeService(capacity=1)
    monkeypatch.setattr(kit_adapter, 'agent_runtime_service', lambda: service)
    running = asyncio.create_task(kit_adapter.call_codex_runtime(
        factory=adapter._load_async_codex_factory(), approval=lambda: 'deny-all', model='synthetic-model',
        effort='max', prompt='synthetic', operation='chat_json', output_schema=None,
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        running.cancel('first cancellation')
        await asyncio.sleep(0)

        async def cancellation_reached_runtime_loop():
            while not any(task.cancelling() for task in service._pool._running):
                await asyncio.sleep(0)
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        barrier = asyncio.run_coroutine_threadsafe(cancellation_reached_runtime_loop(), service._loop)
        await asyncio.wait_for(asyncio.wrap_future(barrier), 5)
        assert not running.done()
        running.cancel('repeated cancellation')
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError) as caught:
            await asyncio.wait_for(running, 5)
        assert caught.value.args == ('first cancellation',)
        assert closed.is_set()
        assert roots and all(not path.parent.exists() for _, path in roots)
    finally:
        release.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
        await asyncio.to_thread(service.close)

    if phase == 'startup' and exception_kind == 'cancelled':
        warning = None
    elif phase == 'startup':
        warning = 'Codex startup or cleanup failed during cancellation'
    elif exception_kind in {'group', 'cancelled_group', 'fatal_group'}:
        warning = 'Codex client cleanup failed.'
    else:
        warning = 'failed to close Codex app-server after run failure:'
    if warning is not None:
        assert warning in caplog.text
    if phase == 'startup':
        assert not [record for record in caplog.records if record.name == 'asyncio']
    else:
        for record in caplog.records:
            if record.name == 'asyncio' and record.exc_info:
                expected = BaseExceptionGroup if exception_kind in {'group', 'cancelled_group', 'fatal_group'} else _CodexCleanupError
                assert isinstance(record.exc_info[1], expected)
                assert record.exc_info[1].__suppress_context__
    assert marker not in caplog.text
    assert primary_marker not in caplog.text


@pytest.mark.asyncio
async def test_kit_timeout_quarantines_pending_cleanup_until_it_settles(monkeypatch, tmp_path, caplog):
    import agent_runtime_kit.adapters.codex as vendor_codex
    import jobctrl.config
    import openai_codex
    from agent_runtime_kit import AgentRuntimeError
    from jobctrl.infrastructure.analysis import codex_analysis_adapter as adapter
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService

    marker = uuid.uuid4().hex
    entered, release, closed = (threading.Event() for _ in range(3))
    roots = []
    binary = tmp_path / 'synthetic-codex'
    binary.write_text('#!/bin/sh\nexit 0\n')
    binary.chmod(0o700)
    monkeypatch.setattr(jobctrl.config, 'APP_DIR', tmp_path / 'app')
    monkeypatch.setattr(adapter, 'ensure_jobctrl_codex_auth', lambda: None)
    monkeypatch.setattr(adapter, 'resolve_codex_binary', lambda: binary)

    class Client:
        def __init__(self, *, config):
            self._client = self
            for entry in config.config_overrides:
                if entry.startswith(('sqlite_home=', 'log_dir=')):
                    name, value = entry.split('=', 1)
                    roots.append((name, Path(json.loads(value))))

        async def start(self):
            pass

        async def __aenter__(self):
            return self

        async def thread_start(self, **_kwargs):
            async def run(_prompt, **_kwargs):
                raise OSError('synthetic turn failure')
            return SimpleNamespace(id='synthetic-thread', run=run)

        async def close(self):
            entered.set()
            await asyncio.to_thread(release.wait, 5)
            assert all(path.exists() if name == 'sqlite_home' else path.parent.exists() for name, path in roots)
            closed.set()
            raise OSError(marker)

    monkeypatch.setattr(openai_codex, 'AsyncCodex', Client)
    original_finish = vendor_codex.finish_vendor_cleanup
    async def short_cleanup_timeout(operation):
        return await original_finish(operation, timeout=0.05)
    monkeypatch.setattr(vendor_codex, 'finish_vendor_cleanup', short_cleanup_timeout)
    original_runtime = kit_adapter._runtime
    made = []
    def capture_runtime(*args, **kwargs):
        instance = original_runtime(*args, **kwargs)
        made.append(instance)
        return instance
    monkeypatch.setattr(kit_adapter, '_runtime', capture_runtime)
    service = AgentRuntimeService(capacity=1)
    monkeypatch.setattr(kit_adapter, 'agent_runtime_service', lambda: service)
    running = asyncio.create_task(kit_adapter.call_codex_runtime(
        factory=adapter._load_async_codex_factory(), approval=lambda: 'deny-all', model='synthetic-model',
        effort='max', prompt='synthetic', operation='chat_json', output_schema=None,
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        running.cancel('caller cancellation')
        with pytest.raises(asyncio.CancelledError) as caught:
            await asyncio.wait_for(running, 5)
        assert caught.value.args == ('caller cancellation',)
        assert not closed.is_set()
        assert len(made) == 1

        async def inspect_quarantine():
            quarantine = made[0]._runtime._cleanup_quarantine
            with pytest.raises(AgentRuntimeError):
                quarantine.ensure_ready('codex')
            pending = tuple(quarantine._pending)
            assert len(pending) == 1 and not pending[0].done()
            assert roots and all(path.exists() if name == 'sqlite_home' else path.parent.exists()
                                 for name, path in roots)
            return pending

        pending = await asyncio.wait_for(
            asyncio.wrap_future(asyncio.run_coroutine_threadsafe(inspect_quarantine(), service._loop)), 5,
        )
        release.set()

        async def join_quarantine():
            await asyncio.gather(*pending, return_exceptions=True)
            made[0]._runtime._cleanup_quarantine.ensure_ready('codex')

        await asyncio.wait_for(
            asyncio.wrap_future(asyncio.run_coroutine_threadsafe(join_quarantine(), service._loop)), 5,
        )
        assert closed.is_set()
        assert all(not path.parent.exists() for _, path in roots)
    finally:
        release.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
        await asyncio.to_thread(service.close)
    assert 'vendor cleanup did not finish within' in caplog.text
    assert marker not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize('close_kind', ['none', 'failure', 'group'])
@pytest.mark.parametrize('entry_phase', ['startup', 'initialization'])
@pytest.mark.parametrize('error_kind', ['value', 'transport', 'authentication', 'group'])
@pytest.mark.parametrize('owner', ['backend', 'analysis'])
async def test_managed_entry_failure_keeps_safe_diagnostics_without_private_details(
    monkeypatch, tmp_path, caplog, in_memory_exporter, close_kind, entry_phase, error_kind, owner,
):
    import traceback
    import jobctrl.config
    import jobctrl.llm as accounting
    import openai_codex
    from jobctrl.infrastructure.analysis import codex_analysis_adapter as adapter
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService
    from jobctrl.infrastructure.llm.llm_client import CodexSdkBackend
    from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, provider_exception_error
    from jobctrl.llm_lanes import bind_llm_lane

    marker = uuid.uuid4().hex
    primary_marker = uuid.uuid4().hex
    if error_kind == 'transport':
        initial_error = OSError(primary_marker)
    elif error_kind == 'authentication':
        initial_error = type('AuthenticationError', (Exception,), {})(primary_marker)
    elif error_kind == 'group':
        initial_error = ExceptionGroup('synthetic entry failure', [ValueError(primary_marker)])
    else:
        initial_error = ValueError(primary_marker)
    phases = []
    roots = []
    binary = tmp_path / 'synthetic-codex'
    binary.write_text('#!/bin/sh\nexit 0\n')
    binary.chmod(0o700)
    monkeypatch.setattr(jobctrl.config, 'APP_DIR', tmp_path / 'app')
    monkeypatch.setattr(adapter, 'ensure_jobctrl_codex_auth', lambda: None)
    monkeypatch.setattr(adapter, 'resolve_codex_binary', lambda: binary)
    monkeypatch.setattr(accounting, 'enforce_spend_budget', lambda _lane=None: None)

    class Client:
        def __init__(self, *, config):
            self._client = self
            for entry in config.config_overrides:
                if entry.startswith(('sqlite_home=', 'log_dir=')):
                    name, value = entry.split('=', 1)
                    roots.append((name, Path(json.loads(value))))

        async def start(self):
            phases.append('started')
            if entry_phase == 'startup':
                raise initial_error

        async def __aenter__(self):
            phases.append('initializing')
            raise initial_error

        async def close(self):
            assert all(path.exists() if name == 'sqlite_home' else path.parent.exists() for name, path in roots)
            phases.append('closed')
            if close_kind == 'failure':
                raise OSError(marker)
            if close_kind == 'group':
                raise ExceptionGroup('synthetic close failure', [OSError(marker)])

    monkeypatch.setattr(openai_codex, 'AsyncCodex', Client)
    service = AgentRuntimeService(capacity=1)
    monkeypatch.setattr(kit_adapter, 'agent_runtime_service', lambda: service)
    factory = adapter._load_async_codex_factory()
    backend = CodexSdkBackend(model='synthetic-model', async_codex_factory=factory,
                              approval_mode_factory=lambda: 'deny-all')
    analysis = adapter.CodexAnalysisAdapter(model='synthetic-model', async_codex_factory=factory)
    try:
        with bind_llm_lane('tailoring'), pytest.raises(ProviderCallError) as caught:
            if owner == 'backend':
                await backend._call([{'role': 'user', 'content': 'synthetic'}], response_schema=None,
                                    temperature=None, max_tokens=None, thinking_budget=None)
            else:
                await analysis.draft('synthetic', 'synthetic')
        rendered = ''.join(traceback.format_exception(caught.value))
        assert marker not in rendered
        assert primary_marker not in rendered
        assert marker not in caplog.text
        assert primary_marker not in caplog.text
        assert caught.value.__cause__ is None
        assert caught.value.__context__ is None
        expected_error = provider_exception_error(
            provider='openai', model='synthetic-model', operation='chat' if owner == 'backend' else 'chat_json',
            error=initial_error,
        )
        actual = caught.value.envelope
        expected_envelope = expected_error.envelope
        for field in ('provider', 'model', 'operation', 'category', 'error_type', 'code', 'retryable'):
            assert getattr(actual, field) == getattr(expected_envelope, field)
        if error_kind == 'transport':
            assert (actual.category, actual.code, actual.retryable) == ('provider_transport', 'transport_error', True)
        elif error_kind == 'value':
            assert (actual.category, actual.code, actual.retryable) == ('provider_exception', 'sdk_exception', False)
        spans = in_memory_exporter.get_finished_spans()
        assert len(spans) == 1
        assert primary_marker not in repr(spans[0].attributes) + str(spans[0].status)
        assert ('Codex client cleanup failed during startup' in caplog.text) is (close_kind != 'none')
        expected = ['started', 'closed'] if entry_phase == 'startup' else ['started', 'initializing', 'closed']
        assert phases == expected
        assert roots and all(not path.parent.exists() for _, path in roots)
    finally:
        await asyncio.to_thread(service.close)


@pytest.mark.asyncio
@pytest.mark.parametrize('initial_kind', ['error', 'cancelled', 'fatal_group'])
@pytest.mark.parametrize('entry_phase', ['startup', 'initialization'])
async def test_failed_entry_preserves_primary_control_flow_when_close_fails(tmp_path, caplog, initial_kind, entry_phase):
    import traceback

    marker = uuid.uuid4().hex
    if initial_kind == 'cancelled':
        initial_error = asyncio.CancelledError('synthetic-sdk-cancellation')
    elif initial_kind == 'fatal_group':
        initial_error = BaseExceptionGroup('synthetic initialization', [KeyboardInterrupt(), SystemExit(17)])
    else:
        initial_error = ValueError('synthetic initialization failure')
    home = tmp_path / 'home'
    home.mkdir()
    phases = []

    class Client:
        def __init__(self, *, config):
            self._client = self

        async def start(self):
            phases.append('started')
            if entry_phase == 'startup':
                raise initial_error

        async def __aenter__(self):
            phases.append('initializing')
            raise initial_error

        async def close(self):
            phases.append('closed')
            raise OSError(marker)

    with pytest.raises(type(initial_error)) as caught:
        async with _codex_client_context(
            Client, SimpleNamespace,
            configuration={'env': {'CODEX_HOME': str(home)}, 'config_overrides': (), 'cwd': str(tmp_path)},
        ):
            pytest.fail('failed initialization must not enter the context')
    assert caught.value is initial_error
    assert marker not in ''.join(traceback.format_exception(caught.value))
    assert marker not in caplog.text
    assert 'Codex client cleanup failed during startup' in caplog.text
    expected = ['started', 'closed'] if entry_phase == 'startup' else ['started', 'initializing', 'closed']
    assert phases == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('cleanup_kind', ['cancelled', 'fatal_group'])
@pytest.mark.parametrize('entry_phase', ['startup', 'initialization'])
async def test_failed_entry_preserves_cleanup_control_flow_without_private_details(
    tmp_path, caplog, cleanup_kind, entry_phase,
):
    import traceback

    marker = uuid.uuid4().hex
    home = tmp_path / 'home'
    home.mkdir()
    phases = []

    class Client:
        def __init__(self, *, config):
            self._client = self

        async def start(self):
            phases.append('started')
            if entry_phase == 'startup':
                raise ValueError('synthetic startup failure')

        async def __aenter__(self):
            phases.append('initializing')
            raise ValueError('synthetic initialization failure')

        async def close(self):
            phases.append('closed')
            if cleanup_kind == 'cancelled':
                raise asyncio.CancelledError(marker)
            raise BaseExceptionGroup(marker, [asyncio.CancelledError(marker), KeyboardInterrupt(marker),
                                               SystemExit(23), OSError(marker)])

    expected = asyncio.CancelledError if cleanup_kind == 'cancelled' else BaseExceptionGroup
    with pytest.raises(expected) as caught:
        async with _codex_client_context(
            Client, SimpleNamespace,
            configuration={'env': {'CODEX_HOME': str(home)}, 'config_overrides': (), 'cwd': str(tmp_path)},
        ):
            pytest.fail('failed initialization must not enter the context')
    if cleanup_kind == 'cancelled':
        assert caught.value.args == ()
    else:
        cancelled, interrupted, terminated, failure = caught.value.exceptions
        assert isinstance(cancelled, asyncio.CancelledError)
        assert isinstance(interrupted, KeyboardInterrupt)
        assert isinstance(terminated, SystemExit) and terminated.code == 23
        assert isinstance(failure, _CodexCleanupError)
    assert marker not in ''.join(traceback.format_exception(caught.value))
    assert marker not in caplog.text
    assert 'Codex client cleanup failed during startup' in caplog.text
    expected_phases = ['started', 'closed'] if entry_phase == 'startup' else ['started', 'initializing', 'closed']
    assert phases == expected_phases


@pytest.mark.asyncio
@pytest.mark.parametrize('entry_phase', ['startup', 'initialization'])
async def test_cancelled_managed_entry_joins_failed_close_without_private_details(monkeypatch, tmp_path, caplog, entry_phase):
    import jobctrl.config
    import jobctrl.llm as accounting
    import openai_codex
    from jobctrl.infrastructure.analysis import codex_analysis_adapter as adapter
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService
    from jobctrl.infrastructure.llm.llm_client import CodexSdkBackend
    from jobctrl.llm_lanes import bind_llm_lane

    marker = uuid.uuid4().hex
    initializing, release_start, closing, release = (threading.Event() for _ in range(4))
    roots = []
    binary = tmp_path / 'synthetic-codex'
    binary.write_text('#!/bin/sh\nexit 0\n')
    binary.chmod(0o700)
    monkeypatch.setattr(jobctrl.config, 'APP_DIR', tmp_path / 'app')
    monkeypatch.setattr(adapter, 'ensure_jobctrl_codex_auth', lambda: None)
    monkeypatch.setattr(adapter, 'resolve_codex_binary', lambda: binary)
    monkeypatch.setattr(accounting, 'enforce_spend_budget', lambda _lane=None: None)

    class Client:
        def __init__(self, *, config):
            self._client = self
            for entry in config.config_overrides:
                if entry.startswith(('sqlite_home=', 'log_dir=')):
                    name, value = entry.split('=', 1)
                    roots.append((name, Path(json.loads(value))))

        async def start(self):
            if entry_phase == 'startup':
                initializing.set()
                await asyncio.to_thread(release_start.wait, 5)

        async def __aenter__(self):
            initializing.set()
            await asyncio.Event().wait()

        async def close(self):
            closing.set()
            await asyncio.to_thread(release.wait, 5)
            assert all(path.exists() if name == 'sqlite_home' else path.parent.exists() for name, path in roots)
            raise OSError(marker)

    monkeypatch.setattr(openai_codex, 'AsyncCodex', Client)
    service = AgentRuntimeService(capacity=1)
    monkeypatch.setattr(kit_adapter, 'agent_runtime_service', lambda: service)
    backend = CodexSdkBackend(model='synthetic-model', async_codex_factory=adapter._load_async_codex_factory(),
                              approval_mode_factory=lambda: 'deny-all')
    with bind_llm_lane('tailoring'):
        running = asyncio.create_task(backend._call([{'role': 'user', 'content': 'synthetic'}],
            response_schema=None, temperature=None, max_tokens=None, thinking_budget=None))
    try:
        assert await asyncio.to_thread(initializing.wait, 5)
        running.cancel('first cancellation')
        if entry_phase == 'startup':
            await asyncio.sleep(0)
            assert not running.done()
            release_start.set()
        assert await asyncio.to_thread(closing.wait, 5)
        assert not running.done()
        running.cancel('repeated cancellation')
        await asyncio.sleep(0)
        assert not running.done()
        release.set()
        with pytest.raises(asyncio.CancelledError) as caught:
            await asyncio.wait_for(running, 5)
        assert caught.value.args == ('first cancellation',)
        assert roots and all(not path.parent.exists() for _, path in roots)
    finally:
        release_start.set()
        release.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
        await asyncio.to_thread(service.close)
    assert 'Codex client cleanup failed during startup' in caplog.text
    assert marker not in caplog.text
    assert not [record for record in caplog.records if record.name == 'asyncio']


@pytest.mark.asyncio
@pytest.mark.parametrize('cause_kind', ['none', 'error', 'cancelled'])
async def test_managed_entry_preserves_already_typed_provider_failure_identity(cause_kind):
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, provider_exception_error

    failure = provider_exception_error(
        provider='openai', model='synthetic-model', operation='chat', error=ValueError('synthetic'),
    )
    cause = None
    if cause_kind == 'error':
        cause = ValueError('synthetic provider cause')
    elif cause_kind == 'cancelled':
        cause = asyncio.CancelledError('synthetic-sdk-cancellation')
    failure.__cause__ = cause

    class Context:
        async def __aenter__(self):
            raise failure

    def factory():
        return Context()

    factory.jobctrl_managed_startup = True
    token = kit_adapter._call.set(kit_adapter._Call('synthetic-model', 'chat', 'high', None))
    try:
        with pytest.raises(ProviderCallError) as caught:
            await kit_adapter._Client(factory).__aenter__()
        assert caught.value is failure
        assert caught.value.__cause__ is cause
    finally:
        kit_adapter._call.reset(token)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['cancelled', 'fatal_group'])
async def test_managed_entry_preserves_cancellation_and_fatal_control_flow(kind):
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter

    if kind == 'cancelled':
        failure = asyncio.CancelledError('synthetic-sdk-cancellation')
    else:
        failure = BaseExceptionGroup('synthetic control flow', [KeyboardInterrupt(), SystemExit(17)])

    class Context:
        async def __aenter__(self):
            raise failure

    def factory():
        return Context()

    factory.jobctrl_managed_startup = True
    token = kit_adapter._call.set(kit_adapter._Call('synthetic-model', 'chat', 'high', None))
    try:
        with pytest.raises(type(failure)) as caught:
            await kit_adapter._Client(factory).__aenter__()
    finally:
        kit_adapter._call.reset(token)
    if kind == 'cancelled':
        assert caught.value is failure
    else:
        assert caught.value.message == 'Codex managed startup failed.'
        interrupted, terminated = caught.value.exceptions
        assert isinstance(interrupted, KeyboardInterrupt)
        assert isinstance(terminated, SystemExit) and terminated.code == 17


@pytest.mark.asyncio
async def test_managed_entry_sanitizes_deep_mixed_groups_without_recursion():
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.provider_errors import ProviderCallError

    marker = uuid.uuid4().hex
    failure = BaseExceptionGroup(marker, [asyncio.CancelledError(marker), OSError(marker)])
    for _ in range(1200):
        failure = BaseExceptionGroup(marker, [failure])

    class Context:
        async def __aenter__(self):
            raise failure

    def factory():
        return Context()

    factory.jobctrl_managed_startup = True
    token = kit_adapter._call.set(kit_adapter._Call('synthetic-model', 'chat', 'high', None))
    try:
        with pytest.raises(BaseExceptionGroup) as caught:
            await kit_adapter._Client(factory).__aenter__()
    finally:
        kit_adapter._call.reset(token)
    safe = caught.value
    for _ in range(1200):
        assert isinstance(safe, BaseExceptionGroup)
        assert safe.message == 'Codex managed startup failed.'
        safe = safe.exceptions[0]
    cancelled, transport_error = safe.exceptions
    assert isinstance(cancelled, asyncio.CancelledError) and cancelled.args == ()
    assert isinstance(transport_error, ProviderCallError)
    assert transport_error.envelope.code == 'transport_error'


@pytest.mark.asyncio
@pytest.mark.parametrize('owner', ['backend', 'analysis'])
@pytest.mark.parametrize('entry_phase', ['startup', 'initialization'])
@pytest.mark.parametrize('close_fails', [False, True])
@pytest.mark.parametrize('group_kind', ['cancelled', 'fatal'])
async def test_managed_entry_mixed_groups_keep_safe_classification_and_control_types(
    monkeypatch, tmp_path, caplog, in_memory_exporter, owner, entry_phase, close_fails, group_kind,
):
    import logging
    import traceback
    import jobctrl.config
    import jobctrl.llm as accounting
    import openai_codex
    from jobctrl.infrastructure.analysis import codex_analysis_adapter as adapter
    from jobctrl.infrastructure.llm import agent_runtime_codex as kit_adapter
    from jobctrl.infrastructure.llm.agent_runtime_pool import AgentRuntimeService
    from jobctrl.infrastructure.llm.llm_client import CodexSdkBackend
    from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, ProviderFailureEnvelope
    from jobctrl.llm_lanes import bind_llm_lane

    primary_marker, cleanup_marker = uuid.uuid4().hex, uuid.uuid4().hex
    operation = 'chat' if owner == 'backend' else 'chat_json'
    typed_failure = ProviderCallError(ProviderFailureEnvelope(
        provider='openai', model='synthetic-model', operation=operation, category='provider_turn',
        error_type='codex_turn_error', code='unauthorized', retryable=False, http_status=401,
    ))
    typed_failure.__cause__ = OSError(primary_marker)
    typed_failure.add_note(primary_marker)
    controls = ([asyncio.CancelledError(primary_marker)] if group_kind == 'cancelled' else
                [KeyboardInterrupt(primary_marker), SystemExit(primary_marker), SystemExit(23),
                 SystemExit(False), SystemExit(True), GeneratorExit(primary_marker)])
    initial_error = BaseExceptionGroup(primary_marker, [
        *controls, ExceptionGroup(primary_marker, [ValueError(primary_marker), OSError(primary_marker), typed_failure]),
    ])
    phases = []
    roots = []
    binary = tmp_path / 'synthetic-codex'
    binary.write_text('#!/bin/sh\nexit 0\n')
    binary.chmod(0o700)
    monkeypatch.setattr(jobctrl.config, 'APP_DIR', tmp_path / 'app')
    monkeypatch.setattr(adapter, 'ensure_jobctrl_codex_auth', lambda: None)
    monkeypatch.setattr(adapter, 'resolve_codex_binary', lambda: binary)
    monkeypatch.setattr(accounting, 'enforce_spend_budget', lambda _lane=None: None)
    monkeypatch.setenv('JOBCTRL_TRACE_CONTENT', '1')

    class Client:
        def __init__(self, *, config):
            self._client = self
            for entry in config.config_overrides:
                if entry.startswith(('sqlite_home=', 'log_dir=')):
                    name, value = entry.split('=', 1)
                    roots.append((name, Path(json.loads(value))))

        async def start(self):
            phases.append('started')
            if entry_phase == 'startup':
                raise initial_error

        async def __aenter__(self):
            phases.append('initializing')
            raise initial_error

        async def close(self):
            assert all(path.exists() if name == 'sqlite_home' else path.parent.exists() for name, path in roots)
            phases.append('closed')
            if close_fails:
                raise OSError(cleanup_marker)

    monkeypatch.setattr(openai_codex, 'AsyncCodex', Client)
    service = AgentRuntimeService(capacity=1)
    monkeypatch.setattr(kit_adapter, 'agent_runtime_service', lambda: service)
    factory = adapter._load_async_codex_factory()
    backend = CodexSdkBackend(model='synthetic-model', async_codex_factory=factory,
                              approval_mode_factory=lambda: 'deny-all')
    analysis = adapter.CodexAnalysisAdapter(model='synthetic-model', async_codex_factory=factory)
    try:
        with bind_llm_lane('tailoring'), pytest.raises(BaseExceptionGroup) as caught:
            if owner == 'backend':
                await backend._call([{'role': 'user', 'content': 'synthetic'}], response_schema=None,
                                    temperature=None, max_tokens=None, thinking_budget=None)
            else:
                await analysis.draft('synthetic', 'synthetic')
        try:
            raise caught.value
        except BaseExceptionGroup:
            logging.getLogger('jobctrl.synthetic.group-test').exception('Synthetic handled failure')
        rendered = ''.join(traceback.format_exception(caught.value))
        assert primary_marker not in rendered + caplog.text
        assert cleanup_marker not in rendered + caplog.text
        assert caught.value.message == 'Codex managed startup failed.'
        assert caught.value.__cause__ is None
        assert caught.value.__context__ is None
        group_controls = caught.value.exceptions[:-1]
        if group_kind == 'cancelled':
            assert len(group_controls) == 1 and isinstance(group_controls[0], asyncio.CancelledError)
            assert group_controls[0].args == ()
        else:
            interrupted, failed_exit, numeric_exit, false_exit, true_exit, generator = group_controls
            assert isinstance(interrupted, KeyboardInterrupt) and interrupted.args == ()
            assert isinstance(failed_exit, SystemExit) and failed_exit.code == 1
            assert isinstance(numeric_exit, SystemExit) and numeric_exit.code == 23
            assert isinstance(false_exit, SystemExit) and false_exit.code is False
            assert isinstance(true_exit, SystemExit) and true_exit.code is True
            assert isinstance(generator, GeneratorExit) and generator.args == ()
        nested = caught.value.exceptions[-1]
        assert isinstance(nested, ExceptionGroup)
        value_error, transport_error, safe_typed_failure = nested.exceptions
        assert all(isinstance(error, ProviderCallError) for error in nested.exceptions)
        for error in nested.exceptions:
            assert (error.envelope.provider, error.envelope.model, error.envelope.operation) == (
                'openai', 'synthetic-model', operation,
            )
        assert safe_typed_failure.envelope.to_dict() == typed_failure.envelope.to_dict()
        assert safe_typed_failure.__cause__ is None
        assert not getattr(safe_typed_failure, '__notes__', ())
        assert (value_error.envelope.error_type, value_error.envelope.code, value_error.retryable) == (
            'value_error', 'sdk_exception', False,
        )
        assert (transport_error.envelope.category, transport_error.envelope.code, transport_error.retryable) == (
            'provider_transport', 'transport_error', True,
        )
        assert ('Codex client cleanup failed during startup' in caplog.text) is close_fails
        expected_phases = ['started', 'closed'] if entry_phase == 'startup' else ['started', 'initializing', 'closed']
        assert phases == expected_phases
        assert roots and all(not path.parent.exists() for _, path in roots)
        spans = in_memory_exporter.get_finished_spans()
        assert len(spans) == 1
        assert primary_marker not in repr(spans[0].attributes) + str(spans[0].status)
    finally:
        await asyncio.to_thread(service.close)
