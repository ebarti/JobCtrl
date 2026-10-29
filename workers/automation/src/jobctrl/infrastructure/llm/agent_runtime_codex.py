"""Codex kit dispatch with JobCtrl permissions and lossless typed turn failures.

The kit owns client reuse and shutdown. The small SDK facade keeps the public
turn stream because the vendor convenience run method discards TurnError data.
Every kit task creates a fresh ephemeral conversation.
"""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
from agent_runtime_kit.adapters.codex import CodexAgentRuntime

from jobctrl.infrastructure.llm.agent_runtime_pool import agent_runtime_service
from jobctrl.infrastructure.llm.codex_turn import CodexTurnOutcome, run_codex_turn
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, codex_protocol_error, provider_exception_error
from jobctrl.infrastructure.llm.task_instructions import (
    CODEX_TASK_INSTRUCTIONS, CODEX_TASK_INSTRUCTION_PROFILE,
)


@dataclass
class _Call:
    model: str
    operation: str
    effort: str
    record_usage: Callable[[int | None, int | None], None] | None
    record_usage_details: Callable[[int | None, int | None], None] | None = None
    outcome: CodexTurnOutcome | None = None


_call: contextvars.ContextVar[_Call] = contextvars.ContextVar('jobctrl_codex_kit_call')


@dataclass(frozen=True)
class AgentGeneration:
    text: str
    input_tokens: int | None
    output_tokens: int | None
    runtime_metadata: dict[str, Any]
    session_id: str | None = None


@dataclass
class _Config:
    cwd: str | None = None
    env: dict[str, str] | None = None
    config_overrides: tuple[str, ...] = ()


class _CodexCleanupError(RuntimeError):
    """A content-free failure at the SDK cleanup boundary."""


def _safe_exception_tree(
    error: BaseException, *, group_message: str, failure_factory: Callable[[BaseException], BaseException],
) -> BaseException:
    """Rebuild SDK errors without their contents while retaining control flow."""
    pending = [(error, False)]
    sanitized: list[BaseException] = []
    while pending:
        current, expanded = pending.pop()
        if isinstance(current, BaseExceptionGroup):
            if not expanded:
                pending.append((current, True))
                pending.extend((item, False) for item in reversed(current.exceptions))
                continue
            count = len(current.exceptions)
            children = sanitized[-count:]
            del sanitized[-count:]
            sanitized.append(BaseExceptionGroup(group_message, children))
        elif isinstance(current, asyncio.CancelledError):
            sanitized.append(asyncio.CancelledError())
        elif isinstance(current, KeyboardInterrupt):
            sanitized.append(KeyboardInterrupt())
        elif isinstance(current, SystemExit):
            # Non-integer exit payloads are printed by Python; retain their
            # failure exit status without forwarding potentially private text.
            code = current.code
            sanitized.append(SystemExit(code if type(code) in (int, bool) or code is None else 1))
        elif isinstance(current, GeneratorExit):
            sanitized.append(GeneratorExit())
        else:
            sanitized.append(failure_factory(current))
    return sanitized[0]


def _safe_cleanup_exception(error: BaseException) -> BaseException:
    """Retain cleanup control flow without forwarding SDK exception contents."""
    return _safe_exception_tree(
        error, group_message='Codex client cleanup failed.',
        failure_factory=lambda _error: _CodexCleanupError('Codex client cleanup failed.'),
    )


class _Thread:
    def __init__(self, thread: Any) -> None:
        self._thread = thread
        self.id = getattr(thread, 'id', None)

    async def run(
        self, prompt: str, *, approval_mode: Any, sandbox: Any = None,
        model: str | None = None, cwd: str | None = None,
        output_schema: dict | None = None, effort: str | None = None,
    ) -> Any:
        state = _call.get()
        kwargs = dict(approval_mode=approval_mode, sandbox=sandbox, model=model, cwd=cwd,
                      output_schema=output_schema, effort=effort)
        outcome = await run_codex_turn(
            self._thread, prompt, model=state.model, operation=state.operation,
            run_kwargs={key: value for key, value in kwargs.items() if value is not None},
            record_usage=state.record_usage,
            record_usage_details=state.record_usage_details,
        )
        state.outcome = outcome
        return SimpleNamespace(
            status='completed', final_response=outcome.final_response, items=[],
            usage=SimpleNamespace(total=SimpleNamespace(
                input_tokens=outcome.input_tokens, output_tokens=outcome.output_tokens,
            )),
        )


class _Client:
    def __init__(self, factory: Callable[[], Any]) -> None:
        self._context = factory()
        self._managed_startup = bool(getattr(factory, 'jobctrl_managed_startup', False))
        self._entered = False
        self._startup = None

    async def __aenter__(self) -> _Client:
        if self._managed_startup:
            # The native context joins process publication itself. Keep the
            # initialize handshake cancellable instead of shielding all entry.
            failure = None
            try:
                self._client = await self._context.__aenter__()
            except ProviderCallError:
                raise
            except Exception as error:
                state = _call.get()
                failure = provider_exception_error(
                    provider='openai', model=state.model, operation=state.operation, error=error,
                )
            except BaseExceptionGroup as error:
                state = _call.get()

                def classify(item: BaseException) -> ProviderCallError:
                    if isinstance(item, ProviderCallError):
                        # Keep the bounded envelope, not the original error's
                        # potentially private notes or cause chain.
                        return ProviderCallError(item.envelope)
                    return provider_exception_error(
                        provider='openai', model=state.model, operation=state.operation, error=item,
                    )

                failure = _safe_exception_tree(
                    error, group_message='Codex managed startup failed.', failure_factory=classify,
                )
            if failure is not None:
                # Classify before the kit can chain the SDK exception into a
                # traceback. Direct cancellation and fatal control flow bypass
                # this; mixed groups retain those members without SDK details.
                raise failure from None
            self._entered = True
            return self
        self._startup = asyncio.create_task(self._context.__aenter__())
        try:
            await asyncio.wait({self._startup})
            self._client = self._startup.result()
        except asyncio.CancelledError:
            if await self._join_startup():
                logging.getLogger(__name__).warning('Codex startup failed during cancellation.')
            raise
        except BaseException:
            await self._join_startup()
            raise
        return self

    async def _join_startup(self) -> bool:
        if self._startup is None:
            return False
        while not self._startup.done():
            try:
                await asyncio.wait({self._startup})
            except asyncio.CancelledError:
                continue
        # Retrieve startup failure without replacing the caller's original
        # exception. The kit still owns unconditional context teardown.
        if self._startup.done() and not self._startup.cancelled():
            return self._startup.exception() is not None
        return False

    async def __aexit__(self, *args: Any) -> None:
        await self._join_startup()
        # A failed managed entry already closed its app-server and storage.
        if not self._managed_startup or self._entered:
            safe_error = None
            try:
                await self._context.__aexit__(*args)
            except BaseException as error:
                safe_error = _safe_cleanup_exception(error)
            if safe_error is not None:
                # The kit does not report BaseExceptionGroups itself. Keep a
                # safe diagnostic while preserving their control-flow members.
                if isinstance(safe_error, BaseExceptionGroup) and not isinstance(safe_error, Exception):
                    logging.getLogger(__name__).warning('Codex client cleanup failed.')
                # The kit may call this while handling another failure, so
                # suppress any inherited context in event-loop tracebacks too.
                raise safe_error from None

    async def thread_start(
        self, *, approval_mode: Any, sandbox: Any = None, model: str | None = None,
        cwd: str | None = None, developer_instructions: str | None = None,
    ) -> _Thread:
        state = _call.get()
        # None must not replace the app-server's named filesystem profile.
        kwargs = dict(approval_mode=approval_mode, sandbox=sandbox, model=model, cwd=cwd,
                      developer_instructions=developer_instructions)
        kwargs = {key: value for key, value in kwargs.items() if value is not None}
        kwargs.update(
            ephemeral=True, base_instructions=CODEX_TASK_INSTRUCTIONS,
            config={'model_reasoning_effort': state.effort},
        )
        return _Thread(await self._client.thread_start(**kwargs))


class _OwnedRuntime:
    def __init__(self, runtime: CodexAgentRuntime, temporary: tempfile.TemporaryDirectory | None) -> None:
        self._runtime = runtime
        self._temporary = temporary

    async def run(self, task: AgentTask):
        return await self._runtime.run(task)

    async def aclose(self) -> None:
        try:
            await self._runtime.aclose()
        finally:
            if self._temporary is not None:
                self._temporary.cleanup()


def _factory_key(factory: Callable[[], Any], model: str, effort: str, approval: Callable[[], Any]):
    configuration = getattr(factory, 'jobctrl_runtime_config', None)
    if configuration is None:
        # Injected SDK factories remain isolated and are retained by their runtime;
        # their identity cannot be recycled while a cached member still owns them.
        return ('injected-codex', id(factory), model, effort, id(approval), CODEX_TASK_INSTRUCTION_PROFILE)
    home = Path(configuration['env']['CODEX_HOME'])
    auth = home / 'auth.json'
    auth_fingerprint = hashlib.sha256(auth.read_bytes()).hexdigest() if auth.is_file() else None
    value = {**configuration, 'auth_fingerprint': auth_fingerprint, 'model': model, 'effort': effort,
             'instruction_profile': CODEX_TASK_INSTRUCTION_PROFILE}
    return ('codex', hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest())


def _runtime(factory: Callable[[], Any], approval: Callable[[], Any]) -> _OwnedRuntime:
    from jobctrl.infrastructure.analysis.codex_analysis_adapter import (
        _CODEX_PERMISSION_PROFILE, _codex_config_overrides,
    )
    configuration = getattr(factory, 'jobctrl_runtime_config', None)
    temporary = None
    if configuration is None:
        # A test/injected SDK must not cause policy inspection of ambient auth.
        temporary = tempfile.TemporaryDirectory(prefix='jobctrl-kit-codex-')
        environment = {'CODEX_HOME': temporary.name, 'HOME': temporary.name}
        overrides = ()
    else:
        environment = configuration['env']
        overrides = _codex_config_overrides(Path(configuration['codex_bin']))
    overrides = tuple(value for value in overrides if value != f'default_permissions="{_CODEX_PERMISSION_PROFILE}"')
    runtime = CodexAgentRuntime(
        env=environment, config_overrides=overrides, reuse_process=True,
        codex_cls=lambda **_kwargs: _Client(factory), config_cls=_Config,
        sandbox_cls=SimpleNamespace(), approval_mode_cls=SimpleNamespace(deny_all=approval()),
    )
    return _OwnedRuntime(runtime, temporary)


async def call_codex_runtime(
    *, factory: Callable[[], Any], approval: Callable[[], Any], model: str,
    effort: str, prompt: str, operation: str, output_schema: dict | None,
    record_usage: Callable[[int | None, int | None], None] | None = None,
    record_usage_details: Callable[[int | None, int | None], None] | None = None,
) -> AgentGeneration:
    from jobctrl.infrastructure.analysis.codex_analysis_adapter import _CODEX_PERMISSION_PROFILE

    configuration = getattr(factory, 'jobctrl_runtime_config', None)
    state = _Call(model, operation, effort, record_usage, record_usage_details)
    token = _call.set(state)
    try:
        task = AgentTask(
            goal=prompt, model=model, reasoning_effort=effort, output_schema=output_schema,
            working_directory=Path(configuration['cwd']) if configuration else None,
            permissions=PermissionProfile(
                mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY,
                native_profile=_CODEX_PERMISSION_PROFILE,
            ),
        )
        result = await agent_runtime_service().run_async(
            _factory_key(factory, model, effort, approval), lambda: _runtime(factory, approval), task,
        )
        if state.outcome is None:
            raise codex_protocol_error(model=model, operation=operation, code='runtime_completion_missing', retryable=True)
        # A completed native turn may fail the kit's schema check. Keep the raw
        # result so JobCtrl's owning strict parser retains its existing distinct
        # malformed_json/schema_violation repair authority. Never accept it here.
        outcome = state.outcome
        return AgentGeneration(
            outcome.final_response, outcome.input_tokens, outcome.output_tokens, dict(result.metadata),
            session_id=result.session_id,
        )
    finally:
        _call.reset(token)
