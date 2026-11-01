"""Antigravity kit lifecycle with JobCtrl's finish-only provider configuration."""
from __future__ import annotations

import contextvars
from copy import copy
from dataclasses import dataclass
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
class _Call:
    factory: Any
    config: Any
    structured: bool
    response: AntigravityGeneration
    record_usage: Any = None


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
        async for chunk in self._response.chunks:
            yield chunk
        self._state.response.usage = getattr(self._response, 'usage_metadata', None)
        if self._state.record_usage is not None:
            from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import _usage_from_metadata

            self._state.record_usage(*_usage_from_metadata(self._state.response.usage))
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
        return await self._context.__aexit__(*args)

    async def chat(self, prompt):
        return _Response(await self._agent.chat(prompt), _call.get())

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
        return state.response
    finally:
        _call.reset(token)
