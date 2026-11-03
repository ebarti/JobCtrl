"""Claude kit dispatch preserving tool-free options and native failure receipts."""
from __future__ import annotations

import asyncio
import contextvars
import logging
from collections.abc import Callable
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
    post_terminal_failure: bool = False


_call: contextvars.ContextVar[_Call] = contextvars.ContextVar('jobctrl_claude_kit_call')


class _ClaudeMessages(list[Any]):
    """Native receipts plus the kit's status, without retaining its error text."""

    def __init__(self, messages: list[Any], *, succeeded: bool | None, structured: bool,
                 post_terminal_failure: bool = False) -> None:
        super().__init__(messages)
        self.kit_succeeded = succeeded
        self.kit_structured = structured
        self.post_terminal_failure = post_terminal_failure or getattr(messages, 'post_terminal_failure', False)


class _ClaudeRuntime(ClaudeAgentRuntime):
    async def aclose(self) -> None:
        try:
            await super().aclose()
        except Exception:
            try:
                state = _call.get()
            except LookupError:
                state = None
            if state is not None and any(type(message).__name__ == 'ResultMessage' for message in state.messages):
                state.post_terminal_failure = True
            raise


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
        messages=state.messages,
    )
    for message in state.messages:
        yield message


async def call_claude_runtime(*, query: Any, options: Any, prompt: str, model: str, operation: str,
                              record_cancelled_usage: Callable[..., None] | None = None) -> list[Any]:
    state = _Call(query, options, model, operation)
    output_format = _field(options, 'output_format')
    schema = output_format.get('schema') if isinstance(output_format, dict) else None
    token = _call.set(state)
    try:
        task = AgentTask(
            goal=prompt, system=_field(options, 'system_prompt'), model=model, output_schema=schema,
            permissions=PermissionProfile(mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY),
        )
        try:
            result = await agent_runtime_service().run_async(
                ('claude', model),
                # The native query API starts a fresh conversation for each call.
                # Do not reuse a conversational SDK client across independent judges.
                lambda: _ClaudeRuntime(query_func=_query, options_cls=_options, reuse_process=False),
                task,
            )
        except asyncio.CancelledError as error:
            # The service has joined the SDK task and cleanup at this point.
            # Account on the caller's span/lane, never from the SDK thread.
            if state.post_terminal_failure or getattr(state.messages, 'post_terminal_failure', False):
                logging.getLogger(__name__).warning("Claude cleanup failed after a terminal receipt during cancellation.")
            if record_cancelled_usage is not None:
                from jobctrl.infrastructure.analysis.claude_analysis_adapter import _record_available_usage

                try:
                    _record_available_usage(state.messages, record_cancelled_usage)
                except BaseException:
                    try:
                        record_cancelled_usage("", unresolved_usage=[{"reason": "usage_collection_failed"}])
                    except BaseException:
                        pass
                    error.add_note("Persisting observed Claude usage also failed.")
                    logging.getLogger(__name__).warning("Could not record observed Claude usage after cancellation.")
            raise
        except Exception as error:
            if record_cancelled_usage is not None:
                from jobctrl.infrastructure.analysis.claude_analysis_adapter import _record_available_usage

                try:
                    _record_available_usage(state.messages, record_cancelled_usage)
                except BaseException:
                    try:
                        record_cancelled_usage("", unresolved_usage=[{"reason": "usage_collection_failed"}])
                    except BaseException:
                        pass
                    error.add_note("Persisting observed Claude usage also failed.")
            if not any(type(message).__name__ == 'ResultMessage' for message in state.messages):
                raise
            # A failure after the kit received the terminal can occur during
            # runtime cleanup. Keep that receipt, but never accept its output.
            return _ClaudeMessages(state.messages, succeeded=None, structured=schema is not None,
                                   post_terminal_failure=True)
        # Existing owners account for terminal usage before classifying the
        # native failure and parsing the response. Kit dispatch never substitutes
        # text for a missing native structured result.
        if record_cancelled_usage is not None:
            from jobctrl.infrastructure.analysis.claude_analysis_adapter import _record_available_usage

            try:
                _record_available_usage(state.messages, record_cancelled_usage)
            except BaseException:
                try:
                    record_cancelled_usage("", unresolved_usage=[{"reason": "usage_collection_failed"}])
                except BaseException:
                    pass
                raise
        return _ClaudeMessages(state.messages, succeeded=result.is_success, structured=schema is not None)
    finally:
        _call.reset(token)
