"""LlmAdapter — wraps the existing ``jobhunter.llm.LLMClient`` behind the
``LlmPort`` protocol.

See ddd-target.md §5.4 (``LlmPort``) and Phase-5 / S-17 for context.

The wrapper does two jobs:

  1. Translates ``LlmMessage`` value objects into the dict format the
     underlying client expects.
  2. Maps the port's ``temperature/max_tokens`` overrides into the client's
     keyword arguments while still allowing ``None`` (use provider default
     ⇒ omit the keyword).

A module-level singleton (``get_llm_adapter``) is provided for callers that
do not want to manage lifetime. Tests should construct a fresh adapter (or
implement the protocol directly with a fake) so the underlying HTTP client
is not shared.
"""

from __future__ import annotations

import threading
from typing import Any

from jobhunter.domain.ports.llm import LlmMessage
from jobhunter.llm import LLMClient, get_client


class LlmAdapter:
    """Local-mode adapter implementing :class:`LlmPort`.

    Wraps a single :class:`jobhunter.llm.LLMClient` instance. The ``model``
    keyword on :meth:`chat` is currently advisory — the underlying client
    binds the model at construction time (one model per process). When a
    ``model`` argument is supplied that does not match the bound model we
    raise ``ValueError`` so callers cannot silently get the wrong
    deployment; this becomes a real selector when the cloud LLM gateway
    lands.
    """

    def __init__(self, client: LLMClient | None = None) -> None:
        self._client = client or get_client()

    @property
    def client(self) -> LLMClient:
        """Underlying unified client — exposed for diagnostics, not for use."""
        return self._client

    def chat(
        self,
        messages: list[LlmMessage],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        thinking_budget: int | None = None,
    ) -> str:
        if model is not None and model != self._client.model:
            raise ValueError(
                f"LlmAdapter is bound to model={self._client.model!r}; "
                f"cannot satisfy request for model={model!r}. "
                "Construct a new adapter with the desired model or wait for "
                "the cloud LLM gateway (see ddd-target.md §5.4)."
            )

        payload = [{"role": message.role, "content": message.content} for message in messages]

        kwargs: dict[str, Any] = {}
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_schema is not None:
            kwargs["response_schema"] = response_schema
        if thinking_budget is not None:
            kwargs["thinking_budget"] = thinking_budget
        return self._client.chat(payload, **kwargs)

    def chat_json(
        self,
        messages: list[LlmMessage],
        *,
        response_schema: dict,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        thinking_budget: int | None = None,
    ) -> dict:
        if model is not None and model != self._client.model:
            raise ValueError(
                f"LlmAdapter is bound to model={self._client.model!r}; "
                f"cannot satisfy request for model={model!r}."
            )
        payload = [{"role": message.role, "content": message.content} for message in messages]
        kwargs: dict[str, Any] = {"response_schema": response_schema}
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if thinking_budget is not None:
            kwargs["thinking_budget"] = thinking_budget
        return self._client.chat_json(payload, **kwargs)

    def ask(self, prompt: str, **kwargs: Any) -> str:
        message = LlmMessage(role="user", content=prompt)
        return self.chat([message], **kwargs)


# ---------------------------------------------------------------------------
# Module-level singleton (mirrors ``infrastructure.profile.factory``).
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_singleton: LlmAdapter | None = None


def get_llm_adapter() -> LlmAdapter:
    """Return the process-wide singleton :class:`LlmAdapter`."""
    global _singleton
    with _lock:
        if _singleton is None:
            _singleton = LlmAdapter()
        return _singleton


def reset_llm_adapter() -> None:
    """Drop the cached singleton — used by tests for isolation."""
    global _singleton
    with _lock:
        _singleton = None
