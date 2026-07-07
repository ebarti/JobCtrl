"""LlmAdapter — wraps the existing ``jobctrl.llm.LLMClient`` behind the
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

from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.llm import LLMClient, create_client, get_client


_DEFAULT_MODEL_SENTINELS = {"", "default", "local-default"}


def _parse_model_spec(model: str | None) -> tuple[str | None, str | None, str]:
    """Parse an opaque model spec into provider/model plus safe display label."""
    if model is None:
        return None, None, "default"
    stripped = model.strip()
    if stripped.lower() in _DEFAULT_MODEL_SENTINELS:
        return None, None, "default"
    if "://" in stripped:
        raise ValueError("LLM model specs must not include URLs or raw provider config")
    if ":" in stripped:
        provider, selected_model = stripped.split(":", 1)
        provider = provider.strip().lower()
        selected_model = selected_model.strip()
        if selected_model.lower() in _DEFAULT_MODEL_SENTINELS:
            selected_model = ""
        if provider in {"gemini", "openai", "local"} and selected_model:
            return provider, selected_model, f"{provider}:{selected_model}"
        if provider in {"gemini", "openai", "local"}:
            return provider, None, f"{provider}:default"
    return None, stripped, stripped


class LlmAdapter:
    """Local-mode adapter implementing :class:`LlmPort`.

    Wraps :class:`jobctrl.llm.LLMClient` instances. The ``model`` keyword on
    :meth:`chat` is an opaque local model spec:

    * ``None`` / ``default`` uses the process default provider and model.
    * ``some-model`` uses the default provider with that model name.
    * ``gemini:...``, ``openai:...`` and ``local:...`` select a provider
      explicitly while resolving credentials from environment variables.

    Clients are cached per safe provider/model label. Secrets never appear in
    the label or in caller-visible metadata.
    """

    def __init__(self, client: LLMClient | None = None, *, default_model: str | None = None) -> None:
        if client is not None:
            self._client = client
            self._clients: dict[str, LLMClient] = {"default": self._client}
            return

        provider, selected_model, label = _parse_model_spec(default_model)
        if label == "default":
            self._client = get_client()
        else:
            self._client = create_client(provider, selected_model)
        self._clients = {"default": self._client, label: self._client}

    @property
    def client(self) -> LLMClient:
        """Underlying unified client — exposed for diagnostics, not for use."""
        return self._client

    @property
    def model(self) -> str:
        """Default model name for diagnostics."""
        return self._client.model

    def _client_for_model(self, model: str | None) -> LLMClient:
        provider, selected_model, label = _parse_model_spec(model)
        if label == "default":
            return self._client
        cached = self._clients.get(label)
        if cached is not None:
            return cached
        client = create_client(provider, selected_model)
        self._clients[label] = client
        return client

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
        client = self._client_for_model(model)
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
        return client.chat(payload, **kwargs)

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
        client = self._client_for_model(model)
        payload = [{"role": message.role, "content": message.content} for message in messages]
        kwargs: dict[str, Any] = {"response_schema": response_schema}
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if thinking_budget is not None:
            kwargs["thinking_budget"] = thinking_budget
        return client.chat_json(payload, **kwargs)

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
