"""LlmPort — driven port for chat-style LLM completion.

See ddd-target.md §5.4 (LlmPort), §2 (ports own protocol semantics) and
§5.3 (consumed by Scoring, Materials, Apply contexts).

The port is intentionally model-neutral: callers pass a sequence of
``LlmMessage`` value objects and a sampling envelope; the adapter resolves
the underlying model and provider. ``temperature`` and ``max_tokens`` are
optional so consumers can opt into provider defaults instead of repeating
prompt-specific knobs at every call site.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol


LlmRole = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class LlmMessage:
    """One turn in an LLM chat exchange.

    The adapter is responsible for translating to the underlying provider's
    expected dict format (OpenAI-compat, native Gemini, etc.). Keeping
    ``role`` a literal union means provider-specific rolesets ("model",
    "function", …) never leak into the domain layer.
    """

    role: LlmRole
    content: str


class LlmPort(Protocol):
    """Driven port for chat-style LLM completion.

    Implementations live under ``infrastructure/llm/``. The local adapter
    wraps the existing ``jobctl.llm.LLMClient``. A future cloud adapter
    will route through a tenant-aware gateway.
    """

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
        """Send a chat completion and return the assistant's text reply.

        ``model`` selects between configured deployments; ``None`` means
        "use the adapter's default for this tenant". Temperature/max_tokens
        are passed through to the provider; ``None`` means "use the
        provider default".

        ``response_schema`` enables structured outputs — providers that
        support it return a JSON document conforming to the schema.
        Use :meth:`chat_json` for the parsed-dict convenience.

        ``thinking_budget`` (Gemini-only) caps Gemini 2.5 internal reasoning
        tokens. On Gemini 3.x, ``0`` maps to ``thinkingLevel=minimal`` because
        Gemini 3 thinking cannot be fully disabled.
        """
        ...

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
        """Like :meth:`chat` but returns a parsed JSON dict.

        ``response_schema`` is required — without it the provider has no
        structured-output contract and the call MUST fail at the adapter
        boundary rather than silently returning free text.
        """
        ...

    def ask(self, prompt: str, **kwargs: object) -> str:
        """Convenience: single user prompt → assistant text."""
        ...
