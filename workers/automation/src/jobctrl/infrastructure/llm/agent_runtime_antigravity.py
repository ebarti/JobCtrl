"""Antigravity kit lifecycle with JobCtrl's finish-only provider configuration."""
from __future__ import annotations

import contextvars
from copy import copy
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
from agent_runtime_kit.adapters.antigravity import AntigravityAgentRuntime

from jobctrl.infrastructure.llm.agent_runtime_pool import agent_runtime_service


@dataclass
class AntigravityGeneration:
    structured: Any = None
    text: str | None = None
    usage: Any = None


@dataclass
class _StepUsage:
    conversation: Any
    receive_steps: Any
    wrapper: Any = None
    count: int = 0
    totals: list[int] = field(default_factory=lambda: [0, 0])
    seen: list[bool] = field(default_factory=lambda: [False, False])
    incomplete: list[bool] = field(default_factory=lambda: [False, False])
    active: bool = True


@dataclass
class _Call:
    factory: Any
    config: Any
    structured: bool
    response: AntigravityGeneration
    record_usage: Any = None
    native_response: Any = None
    usage_counts: tuple[int | None, int | None] | None = None
    last_observed: list[tuple[int | None, int | None] | None] = field(default_factory=lambda: [None, None])
    step_usage: _StepUsage | None = None
    step_authority_lost: bool = False
    source_reports: list[dict] = field(default_factory=list)
    captured_steps: int = 0


_call: contextvars.ContextVar[_Call] = contextvars.ContextVar('jobctrl_antigravity_kit_call')


def _field(value: Any, name: str, default: Any = None) -> Any:
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def _configuration(*, capabilities: Any, policies: Any, workspaces: Any, **_values: Any) -> Any:
    # This exact native config already contains Gemini's schema normalization,
    # supported auth, no workspaces and FINISH only. Never widen it with defaults.
    state = _call.get()
    changes = {'capabilities': capabilities, 'policies': policies, 'workspaces': workspaces}
    if hasattr(state.config, 'model_copy'):
        return state.config.model_copy(update=changes)
    config = copy(state.config)
    if isinstance(config, dict):
        config.update(changes)
    else:
        for name, value in changes.items():
            setattr(config, name, value)
    return config


class _Response:
    def __init__(self, response: Any, state: _Call) -> None:
        self._response = response
        self._state = state

    @property
    async def chunks(self):
        try:
            async for chunk in self._response.chunks:
                _capture_available_usage(self._state)
                yield chunk
        except BaseException:
            _capture_available_usage(self._state)
            raise
        else:
            _capture_available_usage(self._state)
            _restore_step_source(self._state)
        if not self._state.structured:
            self._state.response.text = await self._response.text()

    @property
    def usage_metadata(self):
        return getattr(self._response, 'usage_metadata', None)

    async def structured_output(self):
        value = await self._response.structured_output()
        self._state.response.structured = value
        return value

    def __getattr__(self, name: str):
        return getattr(self._response, name)


class _Agent:
    def __init__(self, config: Any) -> None:
        self._context = _call.get().factory(config)
        self._agent = None

    async def __aenter__(self):
        self._agent = await self._context.__aenter__()
        return self

    async def __aexit__(self, *args):
        try:
            return await self._context.__aexit__(*args)
        finally:
            try:
                state = _call.get()
            except LookupError:
                state = None
            if state is not None:
                _capture_available_usage(state)
                _restore_step_source(state)

    async def chat(self, prompt):
        response = await self._agent.chat(prompt)
        state = _call.get()
        state.native_response = response
        _bind_step_source(state, response, self._agent)
        return _Response(response, state)

    def __getattr__(self, name):
        agent = object.__getattribute__(self, '_agent')
        if agent is None:
            raise AttributeError(name)
        return getattr(agent, name)


async def call_antigravity_runtime(
    *, factory: Any, config: Any, types: Any, model: str, prompt: str, output_schema: dict | None,
    record_usage: Any = None,
) -> AntigravityGeneration:
    from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import _runtime_subdir

    state = _Call(factory, config, output_schema is not None, AntigravityGeneration(), record_usage)
    data_dir = Path(_field(config, 'save_dir') or _runtime_subdir('kit'))
    finish = types.BuiltinTools.FINISH
    token = _call.set(state)
    try:
        task = AgentTask(
            goal=prompt, system=_field(config, 'system_instructions'), model=model, output_schema=output_schema,
            permissions=PermissionProfile(
                mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY,
                allowed_tools=(str(getattr(finish, 'value', finish)),),
            ),
        )
        try:
            await agent_runtime_service().run_async(
                ('antigravity', model, str(data_dir), id(factory), id(types)),
                lambda: AntigravityAgentRuntime(
                    api_key=_field(config, 'api_key'), vertex=_field(config, 'vertex'),
                    project=_field(config, 'project'), location=_field(config, 'location'),
                    data_dir=data_dir, agent_cls=_Agent, config_cls=_configuration,
                    types_module=types, policy_module=SimpleNamespace(), reuse_process=True,
                ),
                task,
            )
        except BaseException as error:
            try:
                _record_available_usage(state)
            except BaseException:
                error.add_note("Persisting observed Google usage also failed.")
            raise
        _record_available_usage(state)
        return state.response
    finally:
        _call.reset(token)


def _record_available_usage(state: _Call) -> None:
    # The reusable agent can start a new turn once the runtime returns. Only
    # snapshots taken before that handoff belong to this call.
    if state.record_usage is not None and (state.usage_counts is not None or state.step_authority_lost):
        counts = state.usage_counts if state.usage_counts is not None else (None, None)
        if state.step_authority_lost or any(value is None for value in counts):
            snapshots = []
            for snapshot in (*state.last_observed, state.usage_counts):
                if snapshot is not None and snapshot not in snapshots:
                    snapshots.append(snapshot)
            reports = [{"input_tokens": snapshot[0], "output_tokens": snapshot[1]} for snapshot in snapshots]
            reports.extend(state.source_reports)
            if state.step_authority_lost:
                reports.append({"source": "step_source_unavailable", "input_tokens": None, "output_tokens": None})
            state.record_usage(*counts, unresolved_usage=reports)
        else:
            state.record_usage(*counts)


def _bind_step_source(state: _Call, response: Any, agent: Any) -> None:
    """Observe native per-step usage before the SDK zero-fills its totals."""
    state.step_authority_lost = True
    try:
        conversation = agent.conversation
        if getattr(response, "_conversation", None) is not conversation:
            return
        original = conversation.receive_steps
        if not callable(original) or getattr(original, "_jobctrl_usage_wrapper", False):
            return
        source = _StepUsage(conversation, original)

        async def receive_steps(*args, **kwargs):
            async for step in original(*args, **kwargs):
                _capture_step_usage(source, step)
                yield step

        receive_steps._jobctrl_usage_wrapper = True
        conversation.receive_steps = receive_steps
        if conversation.receive_steps is not receive_steps:
            return
        source.wrapper = receive_steps
        state.step_usage = source
        state.step_authority_lost = False
    except Exception:
        # An unsupported SDK shape cannot establish usage completeness.
        return


def _restore_step_source(state: _Call) -> None:
    source = state.step_usage
    if source is None:
        return
    try:
        if source.active:
            if source.conversation.receive_steps is source.wrapper:
                source.conversation.receive_steps = source.receive_steps
            else:
                source.incomplete = [True, True]
                state.step_authority_lost = True
            source.active = False
    except Exception:
        # Never overwrite a successor or replace the provider's failure.
        source.incomplete = [True, True]
        state.step_authority_lost = True
        source.active = False


def _capture_step_usage(source: _StepUsage, step: Any) -> None:
    from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import _usage_from_metadata

    try:
        usage = step.usage_metadata
        if usage is None:
            return
        counts = _usage_from_metadata(usage)
    except BaseException:
        source.count += 1
        source.incomplete = [True, True]
        return
    source.count += 1
    for index, value in enumerate(counts):
        if value is None:
            source.incomplete[index] = True
        else:
            source.seen[index] = True
            source.totals[index] += value


def _capture_available_usage(state: _Call) -> None:
    from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import _usage_from_metadata

    if state.native_response is None:
        return
    source = state.step_usage
    if source is not None and source.active:
        try:
            if source.conversation.receive_steps is not source.wrapper:
                source.incomplete = [True, True]
                state.step_authority_lost = True
        except Exception:
            source.incomplete = [True, True]
            state.step_authority_lost = True
    try:
        usage = getattr(state.native_response, 'usage_metadata', None)
        aggregate = _usage_from_metadata(usage)
    except BaseException:
        # Diagnostics must never replace an iterator or cancellation failure.
        usage = None
        aggregate = (None, None)
    if (usage is None and state.usage_counts is not None and source is not None
        and source.count == state.captured_steps and not any(source.incomplete)):
        return
    if usage is not None or (source is not None and source.count):
        state.response.usage = usage
        if source is None or not source.count:
            counts = (None, None)
            state.source_reports = [{"source": "unverified_sdk_aggregate", "input_tokens": aggregate[0],
                                     "output_tokens": aggregate[1]}]
        else:
            verified = [
                source.totals[index]
                if source.seen[index] and not source.incomplete[index] and aggregate[index] == source.totals[index]
                else None
                for index in range(2)
            ]
            counts = (verified[0], verified[1])
            state.source_reports = [{
                "source": "provider_step_subtotals",
                "input_tokens": source.totals[0] if source.seen[0] else None,
                "output_tokens": source.totals[1] if source.seen[1] else None,
                "input_incomplete": source.incomplete[0], "output_incomplete": source.incomplete[1],
            }]
            if usage is not None and any(value is None for value in counts):
                state.source_reports.append({"source": "unverified_sdk_aggregate", "input_tokens": aggregate[0],
                                             "output_tokens": aggregate[1]})
        state.usage_counts = counts
        state.captured_steps = source.count if source is not None else 0
        for index, value in enumerate(counts):
            if value is not None:
                state.last_observed[index] = counts
