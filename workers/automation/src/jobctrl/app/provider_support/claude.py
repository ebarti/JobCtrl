"""Fresh tool-free Claude dispatch with native terminal and usage observations."""

from __future__ import annotations

import contextvars
import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from copy import copy
from dataclasses import dataclass, field as dataclass_field
from typing import Any

from agent_runtime_kit.adapters.claude import ClaudeAgentRuntime
from jobctrl.app.provider_support.errors import ProviderCallError, ProviderFailureEnvelope

QueryFn = Callable[..., AsyncIterator[Any] | Awaitable[AsyncIterator[Any]]]


@dataclass
class _Call:
    query: Any
    options: Any
    model: str
    operation: str
    messages: list[Any] = dataclass_field(default_factory=list)
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
    state = _call.get()
    state.messages = await _collect_raw_sdk_messages(
        state.query, prompt=prompt, options=options, model=state.model, operation=state.operation,
        messages=state.messages,
    )
    for message in state.messages:
        yield message


async def _aiter(result: AsyncIterator[Any] | Awaitable[AsyncIterator[Any]]) -> AsyncIterator[Any]:
    """Normalise sync/awaitable query return shapes into an async iterator."""
    if hasattr(result, "__aiter__"):
        return result  # type: ignore[return-value]
    awaited = await result  # type: ignore[misc]
    return awaited


async def _collect_raw_sdk_messages(
    query_fn: QueryFn,
    *,
    prompt: str,
    options: Any,
    model: str,
    operation: str,
    messages: list[Any] | None = None,
) -> list[Any]:
    """Type SDK execution failures before response parsing or semantic review."""
    if messages is None:
        messages = []
    try:
        iterator = await _aiter(query_fn(prompt=prompt, options=options))
        async for message in iterator:
            messages.append(message)
        return messages
    except Exception as error:
        if any(type(message).__name__ == "ResultMessage" for message in messages):
            # Keep the terminal receipt and its usage; the post-terminal error
            # is carried as a separate content-free diagnostic.
            return _ClaudeCollectedMessages(messages)
        if isinstance(error, ProviderCallError):
            raise
        # Preserve known authentication types for provider-wide exclusion.
        # Cancellation inherits BaseException and never enters this catch.
        if type(error).__name__ in {"AuthenticationError", "PermissionDeniedError"}:
            raise
        raise ProviderCallError(ProviderFailureEnvelope(
            provider="claude", model=model, operation=operation,
            category="provider_transport", error_type="claude_sdk_execution_error",
            code="provider_unavailable", retryable=True,
            http_status=getattr(error, "status_code", None),
        )) from error


class _ClaudeCollectedMessages(list[Any]):
    post_terminal_failure = True


def _optional_int(value: Any) -> int | None:
    """Parse a native nonnegative counter; absence is never a known zero."""
    if value is None or isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    try:
        parsed = int(value)
        return parsed if parsed >= 0 else None
    except (TypeError, ValueError):
        return None


def _native_usage(usage: Any) -> tuple[int | None, int | None]:
    """Normalize only Claude's raw native usage, never a kit aggregate.

    The three input counters are disjoint: uncached input, cache creation, and
    cache reads. Nested cache-duration details are already included in cache
    creation and must not be added again. Missing parts leave the total unknown.
    """
    if not isinstance(usage, Mapping):
        return None, None
    parts = [_optional_int(usage.get(name)) for name in (
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
    )]
    total = sum(parts) if all(part is not None for part in parts) else None
    return total, _optional_int(usage.get("output_tokens"))


def _terminal_counts_complete(message: Any) -> bool:
    # Crash receipts can zero every counter. Budget-exceeded usage excludes the
    # response that crossed the limit. Neither is a complete usage observation.
    return getattr(message, "subtype", None) in {
        "success", "error_max_turns", "error_max_structured_output_retries",
    }


def _terminal_cost_complete(message: Any) -> bool:
    # Unlike its token usage, a budget-exceeded result includes the crossing
    # response in its SDK dollar estimate. A crash estimate may be zeroed.
    return _terminal_counts_complete(message) or getattr(message, "subtype", None) == "error_max_budget_usd"


def _usage_from_messages(messages: list[Any]) -> tuple[int | None, int | None]:
    """Read a complete native terminal total, with provider-specific semantics."""
    terminal = next((message for message in reversed(messages) if type(message).__name__ == "ResultMessage"), None)
    return _native_usage(getattr(terminal, "usage", None)) if _terminal_counts_complete(terminal) else (None, None)


def _record_available_usage(messages: list[Any], record: Callable[..., None]) -> None:
    """Keep terminal totals or deduplicated observed input after interruption.

    Assistant output counts are message-start placeholders, not final usage.
    They never establish output-token accounting on failure or cancellation.
    """
    terminal = next((message for message in reversed(messages) if type(message).__name__ == "ResultMessage"), None)
    reports: list[dict[str, Any]] = []
    for message in messages:
        if type(message).__name__ != "AssistantMessage":
            continue
        usage = getattr(message, "usage", None)
        if usage is None:
            continue
        input_tokens, _placeholder_output = _native_usage(usage)
        message_id = getattr(message, "message_id", None)
        identity = (
            hashlib.sha256(message_id.encode("utf-8", "surrogatepass")).hexdigest()
            if isinstance(message_id, str) and message_id else None
        )
        reports.append({"message_id_hash": identity, "input_tokens": input_tokens,
                        "subagent": bool(getattr(message, "parent_tool_use_id", None))})
    unique: dict[str | None, dict[str, Any]] = {}
    unambiguous = bool(reports)
    for report in reports:
        identity = report["message_id_hash"]
        if identity is None or report["subagent"] or report["input_tokens"] is None or (
            identity in unique and unique[identity] != report
        ):
            unambiguous = False
        unique[identity] = report
    observed_input = sum(report["input_tokens"] for report in unique.values()) if unambiguous else None
    if _terminal_counts_complete(terminal):
        input_tokens, output_tokens = _usage_from_messages(messages)
        if input_tokens is not None and observed_input is not None and input_tokens < observed_input:
            record("", input_tokens=observed_input, output_tokens=None,
                   unresolved_usage=[{"reason": "terminal_usage_below_observed_input"}, *reports])
        else:
            record("", input_tokens=input_tokens, output_tokens=output_tokens,
                   unresolved_usage=reports if input_tokens is None or output_tokens is None else None)
    else:
        # This is an observed input subtotal after interruption, not a claim
        # that unobserved requests or output consumed no tokens.
        record("", input_tokens=observed_input, output_tokens=None,
               unresolved_usage=[{"reason": "complete_terminal_usage_unavailable"}, *reports])
