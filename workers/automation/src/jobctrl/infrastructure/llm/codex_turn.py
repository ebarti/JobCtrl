"""Application-owned Codex turn collection that retains safe failure fields."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from jobctrl.infrastructure.llm.provider_errors import (
    codex_protocol_error,
    codex_turn_error,
)


@dataclass(frozen=True)
class CodexTurnOutcome:
    final_response: str
    input_tokens: int | None
    output_tokens: int | None


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _usage_from(value: object) -> tuple[int | None, int | None]:
    total = getattr(value, "total", value)
    return _optional_int(getattr(total, "input_tokens", None)), _optional_int(
        getattr(total, "output_tokens", None)
    )


def _status_value(turn: object) -> str:
    status = getattr(turn, "status", None)
    return str(getattr(status, "value", status) or "")


def _final_response(items: list[object]) -> str | None:
    fallback: str | None = None
    for item in reversed(items):
        value = getattr(item, "root", item)
        text = getattr(value, "text", None)
        if not isinstance(text, str) or not text:
            continue
        phase = getattr(value, "phase", None)
        phase_value = str(getattr(phase, "value", phase) or "")
        if phase_value == "final_answer":
            return text
        if not phase_value and fallback is None:
            fallback = text
    return fallback


def _outcome_from_result(*, result: object, model: str, operation: str) -> CodexTurnOutcome:
    if _status_value(result) != "completed":
        raise codex_turn_error(model=model, operation=operation, error=getattr(result, "error", None))
    final_response = getattr(result, "final_response", None)
    if not isinstance(final_response, str) or not final_response:
        raise codex_protocol_error(
            model=model,
            operation=operation,
            code="final_response_missing",
            retryable=True,
        )
    input_tokens, output_tokens = _usage_from(getattr(result, "usage", None))
    return CodexTurnOutcome(final_response, input_tokens, output_tokens)


async def run_codex_turn(
    thread: Any,
    prompt: str,
    *,
    model: str,
    operation: str,
    run_kwargs: dict[str, Any],
) -> CodexTurnOutcome:
    """Collect a Codex turn without the SDK's lossy ``thread.run()`` wrapper.

    ``openai_codex`` raises a ``RuntimeError`` from ``thread.run()`` for a
    failed turn, which loses the structured ``TurnError`` object.  Consuming the
    public turn stream preserves that object while keeping provider internals
    outside persistence and telemetry.  The ``run`` fallback supports existing
    lightweight test doubles and older SDK shims.
    """

    turn_method = getattr(thread, "turn", None)
    if not callable(turn_method):
        result = await thread.run(prompt, **run_kwargs)
        return _outcome_from_result(result=result, model=model, operation=operation)

    handle = await turn_method(prompt, **run_kwargs)
    stream = handle.stream()
    completed_turn: object | None = None
    items: list[object] = []
    usage: object | None = None
    try:
        async for event in stream:
            payload = getattr(event, "payload", None)
            event_turn_id = getattr(payload, "turn_id", None)
            if event_turn_id == getattr(handle, "id", None):
                item = getattr(payload, "item", None)
                if item is not None:
                    items.append(item)
                token_usage = getattr(payload, "token_usage", None)
                if token_usage is not None:
                    usage = token_usage
            turn = getattr(payload, "turn", None)
            if turn is not None and getattr(turn, "id", None) == getattr(handle, "id", None):
                completed_turn = turn
    finally:
        await stream.aclose()

    if completed_turn is None:
        raise codex_protocol_error(
            model=model,
            operation=operation,
            code="turn_completed_missing",
            retryable=True,
        )
    if _status_value(completed_turn) != "completed":
        raise codex_turn_error(
            model=model,
            operation=operation,
            error=getattr(completed_turn, "error", None),
        )
    final_response = _final_response(items)
    if not final_response:
        raise codex_protocol_error(
            model=model,
            operation=operation,
            code="final_response_missing",
            retryable=True,
        )
    input_tokens, output_tokens = _usage_from(usage)
    return CodexTurnOutcome(final_response, input_tokens, output_tokens)


__all__ = ["CodexTurnOutcome", "run_codex_turn"]
