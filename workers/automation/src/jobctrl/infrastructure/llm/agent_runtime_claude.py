"""Claude kit dispatch preserving tool-free options and native failure receipts."""
from __future__ import annotations

import contextvars
from copy import copy
from dataclasses import dataclass, field
from typing import Any

from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
from agent_runtime_kit.adapters.claude import ClaudeAgentRuntime

from jobctrl.infrastructure.llm.agent_runtime_pool import agent_runtime_service


@dataclass
class _Call:
    query: Any
    options: Any
    model: str
    operation: str
    messages: list[Any] = field(default_factory=list)


_call: contextvars.ContextVar[_Call] = contextvars.ContextVar('jobctrl_claude_kit_call')


def _field(value: Any, name: str, default: Any = None) -> Any:
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def _options(*, permission_mode: str, **values: Any) -> Any:
    # Retain JobCtrl's supported credential/bare-runtime options and thinking
    # budget. The kit supplies the verified permission and model constraints.
    options = copy(_call.get().options)
    values.update(permission_mode=permission_mode, tools=[], allowed_tools=[], max_turns=None)
    if isinstance(options, dict):
        options.update(values)
    else:
        for name, value in values.items():
            setattr(options, name, value)
    return options


async def _query(*, prompt: str, options: Any):
    from jobctrl.infrastructure.analysis.claude_analysis_adapter import _collect_raw_sdk_messages

    state = _call.get()
    state.messages = await _collect_raw_sdk_messages(
        state.query, prompt=prompt, options=options, model=state.model, operation=state.operation,
    )
    for message in state.messages:
        yield message


async def call_claude_runtime(*, query: Any, options: Any, prompt: str, model: str, operation: str) -> list[Any]:
    state = _Call(query, options, model, operation)
    output_format = _field(options, 'output_format')
    schema = output_format.get('schema') if isinstance(output_format, dict) else None
    token = _call.set(state)
    try:
        task = AgentTask(
            goal=prompt, system=_field(options, 'system_prompt'), model=model, output_schema=schema,
            permissions=PermissionProfile(mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY),
        )
        await agent_runtime_service().run_async(
            ('claude', model),
            # The native query API starts a fresh conversation for each call.
            # Do not reuse a conversational SDK client across independent judges.
            lambda: ClaudeAgentRuntime(query_func=_query, options_cls=_options, reuse_process=False),
            task,
        )
        # Existing owners account for terminal usage before classifying the
        # native failure and parsing the response. Kit dispatch never substitutes
        # text for a missing native structured result.
        return state.messages
    finally:
        _call.reset(token)
