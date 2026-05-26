"""
Unified LLM client for JobHunter.

Auto-detects provider from environment:
  GEMINI_API_KEY  -> Google Gemini (default: gemini-3.5-flash)
  OPENAI_API_KEY  -> OpenAI (default: gpt-4o-mini)
  LLM_URL         -> Local llama.cpp / Ollama compatible endpoint

LLM_MODEL env var overrides the model name for any provider.
"""

import json
import logging
import os
import re
import time

import httpx

from jobhunter.infrastructure.observability.llm_spans import llm_generation_span
from jobhunter.model_defaults import DEFAULT_GEMINI_MODEL

log = logging.getLogger(__name__)

DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_LOCAL_MODEL = "local-model"

# ---------------------------------------------------------------------------
# Provider detection
# ---------------------------------------------------------------------------

def _provider_config(provider: str | None, model_override: str | None = None) -> tuple[str, str, str]:
    """Return (base_url, model, api_key) for a provider/model selection.

    Reads env at call time (not module import time) so that load_env() called
    in _bootstrap() is always visible here.
    """
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    local_url = os.environ.get("LLM_URL", "")
    env_model = os.environ.get("LLM_MODEL", "")
    selected_model = (model_override or "").strip()
    provider = (provider or "").strip().lower() or None

    if provider in {"default", "auto"}:
        provider = None

    if provider == "gemini":
        if not gemini_key:
            raise RuntimeError("Gemini model requested but GEMINI_API_KEY is not set.")
        return (
            "https://generativelanguage.googleapis.com/v1beta/openai",
            selected_model or env_model or DEFAULT_GEMINI_MODEL,
            gemini_key,
        )

    if provider == "openai":
        if not openai_key:
            raise RuntimeError("OpenAI model requested but OPENAI_API_KEY is not set.")
        return (
            "https://api.openai.com/v1",
            selected_model or env_model or DEFAULT_OPENAI_MODEL,
            openai_key,
        )

    if provider == "local":
        if not local_url:
            raise RuntimeError("Local model requested but LLM_URL is not set.")
        return (
            local_url.rstrip("/"),
            selected_model or env_model or DEFAULT_LOCAL_MODEL,
            os.environ.get("LLM_API_KEY", ""),
        )

    if gemini_key and not local_url:
        return (
            "https://generativelanguage.googleapis.com/v1beta/openai",
            selected_model or env_model or DEFAULT_GEMINI_MODEL,
            gemini_key,
        )

    if openai_key and not local_url:
        return (
            "https://api.openai.com/v1",
            selected_model or env_model or DEFAULT_OPENAI_MODEL,
            openai_key,
        )

    if local_url:
        return (
            local_url.rstrip("/"),
            selected_model or env_model or DEFAULT_LOCAL_MODEL,
            os.environ.get("LLM_API_KEY", ""),
        )

    raise RuntimeError(
        "No LLM provider configured. "
        "Set GEMINI_API_KEY, OPENAI_API_KEY, or LLM_URL in your environment."
    )


def _detect_provider() -> tuple[str, str, str]:
    """Return the default provider configuration from environment variables."""
    return _provider_config(None)


def create_client(provider: str | None = None, model: str | None = None) -> "LLMClient":
    """Create an uncached client for a specific provider/model selection."""
    base_url, resolved_model, api_key = _provider_config(provider, model)
    log.info("LLM provider: %s  model: %s", base_url, resolved_model)
    return LLMClient(base_url, resolved_model, api_key)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

_MAX_RETRIES = 5
_TIMEOUT = 180  # seconds — Gemini thinking models can take >120s on a single call.

# Base wait on first 429/503 (doubles each retry, caps at 60s).
# Gemini free tier is 15 RPM = 4s minimum between requests; 10s gives headroom.
_RATE_LIMIT_BASE_WAIT = 10


_GEMINI_COMPAT_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
_GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta"


class LlmEmptyResponseError(RuntimeError):
    """Raised when the provider returned a structurally valid response with
    no completion text. Carries the ``finish_reason`` so callers can decide
    whether to retry with a higher token budget or downgrade gracefully.
    """

    def __init__(self, *, finish_reason: str, model: str, hint: str = "") -> None:
        self.finish_reason = finish_reason
        self.model = model
        self.hint = hint
        msg = (
            f"LLM '{model}' returned no content (finish_reason={finish_reason!r})"
        )
        if hint:
            msg = f"{msg}. {hint}"
        super().__init__(msg)


class LLMClient:
    """Thin LLM client supporting OpenAI-compatible and native Gemini endpoints.

    For Gemini keys, starts on the OpenAI-compat layer. On a 403 (which
    happens with preview/experimental models not exposed via compat), it
    automatically switches to the native generateContent API and stays there
    for the lifetime of the process.

    Structured outputs are exposed via the ``response_schema`` kwarg on
    ``chat()`` / ``ask()`` / ``chat_json()``. Provider quirks:

      * OpenAI-compat (incl. Gemini compat): forwarded as
        ``response_format={"type": "json_schema", ...}``.
      * Native Gemini: forwarded as
        ``generationConfig.responseSchema`` + ``responseMimeType=application/json``.
    """

    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.base_url = base_url
        self.model = model
        self.api_key = api_key
        self._client = httpx.Client(timeout=_TIMEOUT)
        # True once we've confirmed the native Gemini API works for this model
        self._use_native_gemini: bool = False
        self._is_gemini: bool = base_url.startswith(_GEMINI_COMPAT_BASE)

    # -- Native Gemini API --------------------------------------------------

    def _chat_native_gemini(
        self,
        messages: list[dict],
        temperature: float,
        max_tokens: int,
        response_schema: dict | None,
        thinking_budget: int | None,
    ) -> str:
        """Call the native Gemini generateContent API.

        Used automatically when the OpenAI-compat endpoint returns 403,
        which happens for preview/experimental models not exposed via compat.

        Converts OpenAI-style messages to Gemini's contents/systemInstruction
        format transparently.
        """
        contents: list[dict] = []
        system_parts: list[dict] = []

        for msg in messages:
            role = msg["role"]
            text = msg.get("content", "")
            if role == "system":
                system_parts.append({"text": text})
            elif role == "user":
                contents.append({"role": "user", "parts": [{"text": text}]})
            elif role == "assistant":
                # Gemini uses "model" instead of "assistant"
                contents.append({"role": "model", "parts": [{"text": text}]})

        generation_config: dict = {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
        }
        if response_schema is not None:
            # Native Gemini wants JSON mode + the schema spelled inline.
            generation_config["responseMimeType"] = "application/json"
            generation_config["responseSchema"] = response_schema
        thinking_config = _gemini_thinking_config(self.model, thinking_budget)
        if thinking_config is not None:
            generation_config["thinkingConfig"] = thinking_config

        payload: dict = {
            "contents": contents,
            "generationConfig": generation_config,
        }
        if system_parts:
            payload["systemInstruction"] = {"parts": system_parts}

        url = f"{_GEMINI_NATIVE_BASE}/models/{self.model}:generateContent"
        params = {"temperature": temperature, "max_tokens": max_tokens}
        if response_schema is not None:
            params["response_schema"] = "<json_schema>"
        if thinking_budget is not None:
            params["thinking_budget"] = thinking_budget
        # Pass the key as a header (not a URL query param) so it never lands in
        # OTel's `http.url` span attribute and gets shipped to Langfuse.
        with llm_generation_span(model=self.model, messages=messages, params=params) as record:
            resp = self._client.post(
                url,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": self.api_key,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            text = _extract_native_gemini_text(data, model=self.model)
            usage = data.get("usageMetadata") or {}
            record(
                text,
                input_tokens=usage.get("promptTokenCount"),
                output_tokens=usage.get("candidatesTokenCount"),
            )
            return text

    # -- OpenAI-compat API --------------------------------------------------

    def _chat_compat(
        self,
        messages: list[dict],
        temperature: float,
        max_tokens: int,
        response_schema: dict | None,
        thinking_budget: int | None,
    ) -> str:
        """Call the OpenAI-compatible endpoint."""
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": response_schema.get("title", "response"),
                    "schema": response_schema,
                    "strict": True,
                },
            }
        if thinking_budget is not None and self._is_gemini:
            # Gemini-only knob exposed via OpenAI-compat's `extra_body`.
            thinking_config = _gemini_thinking_config(self.model, thinking_budget, compat=True)
            payload["extra_body"] = {
                "google": {"thinking_config": thinking_config}
            }

        params = {"temperature": temperature, "max_tokens": max_tokens}
        if response_schema is not None:
            params["response_schema"] = "<json_schema>"
        if thinking_budget is not None:
            params["thinking_budget"] = thinking_budget
        with llm_generation_span(model=self.model, messages=messages, params=params) as record:
            resp = self._client.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=headers,
            )

            # 403 on Gemini compat = model not available on compat layer.
            # Raise a specific sentinel so chat() can switch to native API.
            if resp.status_code == 403 and self._is_gemini:
                raise _GeminiCompatForbidden(resp)

            resp.raise_for_status()
            data = resp.json()
            text = _extract_compat_text(data, model=self.model)
            usage = data.get("usage") or {}
            record(
                text,
                input_tokens=usage.get("prompt_tokens"),
                output_tokens=usage.get("completion_tokens"),
            )
            return text

    # -- public API ---------------------------------------------------------

    def chat(
        self,
        messages: list[dict],
        temperature: float = 0.0,
        max_tokens: int = 4096,
        response_schema: dict | None = None,
        thinking_budget: int | None = None,
    ) -> str:
        """Send a chat completion request and return the assistant message text.

        ``response_schema`` enables structured outputs — the provider is
        instructed to return a JSON document conforming to the schema.
        Use :meth:`chat_json` for the parsed-dict convenience.

        ``thinking_budget`` (Gemini only): caps Gemini 2.5 internal reasoning
        tokens. For Gemini 3.x models, ``0`` maps to the closest low-latency
        setting, ``thinkingLevel=minimal``; Gemini 3 thinking cannot be fully
        disabled.
        """
        # Qwen3 optimization: prepend /no_think to skip chain-of-thought
        # reasoning, saving tokens on structured extraction tasks.
        if "qwen" in self.model.lower() and messages:
            first = messages[0]
            if first.get("role") == "user" and not first["content"].startswith("/no_think"):
                messages = [{"role": first["role"], "content": f"/no_think\n{first['content']}"}] + messages[1:]

        for attempt in range(_MAX_RETRIES):
            try:
                # Route to native Gemini if we've already confirmed it's needed
                if self._use_native_gemini:
                    return self._chat_native_gemini(
                        messages, temperature, max_tokens, response_schema, thinking_budget
                    )

                return self._chat_compat(
                    messages, temperature, max_tokens, response_schema, thinking_budget
                )

            except _GeminiCompatForbidden:
                # Model not available on OpenAI-compat layer — switch to native.
                log.warning(
                    "Gemini compat endpoint returned 403 for model '%s'. "
                    "Switching to native generateContent API. "
                    "(Preview/experimental models are often compat-only on native.)",
                    self.model,
                )
                self._use_native_gemini = True
                # Retry immediately with native — don't count as a rate-limit wait
                try:
                    return self._chat_native_gemini(
                        messages, temperature, max_tokens, response_schema, thinking_budget
                    )
                except httpx.HTTPStatusError as native_exc:
                    raise RuntimeError(
                        f"Both Gemini endpoints failed. Compat: 403 Forbidden. "
                        f"Native: {native_exc.response.status_code} — "
                        f"{native_exc.response.text[:200]}"
                    ) from native_exc

            except httpx.HTTPStatusError as exc:
                resp = exc.response
                if resp.status_code in (429, 503) and attempt < _MAX_RETRIES - 1:
                    # Respect Retry-After header if provided (Gemini sends this).
                    retry_after = (
                        resp.headers.get("Retry-After")
                        or resp.headers.get("X-RateLimit-Reset-Requests")
                    )
                    if retry_after:
                        try:
                            wait = float(retry_after)
                        except (ValueError, TypeError):
                            wait = _RATE_LIMIT_BASE_WAIT * (2 ** attempt)
                    else:
                        wait = min(_RATE_LIMIT_BASE_WAIT * (2 ** attempt), 60)

                    log.warning(
                        "LLM rate limited (HTTP %s). Waiting %ds before retry %d/%d. "
                        "Tip: Gemini free tier = 15 RPM. Consider a paid account "
                        "or switching to a local model.",
                        resp.status_code, wait, attempt + 1, _MAX_RETRIES,
                    )
                    time.sleep(wait)
                    continue
                raise

            except httpx.TimeoutException:
                if attempt < _MAX_RETRIES - 1:
                    wait = min(_RATE_LIMIT_BASE_WAIT * (2 ** attempt), 60)
                    log.warning(
                        "LLM request timed out, retrying in %ds (attempt %d/%d)",
                        wait, attempt + 1, _MAX_RETRIES,
                    )
                    time.sleep(wait)
                    continue
                raise

        raise RuntimeError("LLM request failed after all retries")

    def chat_json(
        self,
        messages: list[dict],
        *,
        response_schema: dict,
        temperature: float = 0.0,
        max_tokens: int = 4096,
        thinking_budget: int | None = None,
    ) -> dict:
        """Like :meth:`chat` but expects a JSON object back and parses it.

        Raises ``LlmEmptyResponseError`` if the provider returned no content.
        Raises ``json.JSONDecodeError`` if the content was not valid JSON
        (which should not happen when ``response_schema`` is honored, but
        the LLM gateway is the only writer that can guarantee that —
        fail loudly so the caller surfaces the schema/contract drift).
        """
        text = self.chat(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_schema=response_schema,
            thinking_budget=thinking_budget,
        )
        return json.loads(text)

    def ask(self, prompt: str, **kwargs) -> str:
        """Convenience: single user prompt -> assistant response."""
        return self.chat([{"role": "user", "content": prompt}], **kwargs)

    def close(self) -> None:
        self._client.close()


def _extract_compat_text(data: dict, *, model: str) -> str:
    """Pull assistant text out of an OpenAI-compat response.

    Some Gemini "thinking" preview models return a response where
    ``choices[0].message`` carries only ``role`` (no ``content``) when the
    entire ``max_tokens`` budget was spent on internal reasoning before any
    visible token landed. We surface that as :class:`LlmEmptyResponseError`
    instead of a confusing ``KeyError: 'content'``.
    """
    choices = data.get("choices") or []
    if not choices:
        finish_reason = "no_choices"
    else:
        message = choices[0].get("message") or {}
        text = message.get("content")
        finish_reason = choices[0].get("finish_reason", "unknown")
        if isinstance(text, str) and text:
            return text
        # Some providers return content as a list of {type: text, text: "..."}
        if isinstance(text, list):
            joined = "".join(part.get("text", "") for part in text if isinstance(part, dict))
            if joined:
                return joined
    hint = ""
    if finish_reason == "length":
        hint = (
            "max_tokens budget exhausted before any visible content was emitted "
            "(common with Gemini 3.x thinking models). Raise max_tokens, or pass "
            "thinking_budget=0 to request Gemini 3 minimal thinking."
        )
    raise LlmEmptyResponseError(finish_reason=finish_reason, model=model, hint=hint)


def _extract_native_gemini_text(data: dict, *, model: str) -> str:
    """Pull assistant text out of a native Gemini ``generateContent`` response.

    Native responses can also return an empty completion when the model
    spends all its tokens on reasoning. Surface that the same way the
    compat path does so the caller never has to special-case the provider.
    """
    candidates = data.get("candidates") or []
    if not candidates:
        finish_reason = "no_candidates"
    else:
        candidate = candidates[0]
        content = candidate.get("content") or {}
        parts = content.get("parts") or []
        text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
        finish_reason = candidate.get("finishReason", "unknown")
        if text:
            return text
    hint = ""
    if finish_reason in ("MAX_TOKENS", "length"):
        hint = (
            "max_tokens budget exhausted before any visible content was emitted "
            "(common with Gemini 3.x thinking models). Raise max_tokens, or pass "
            "thinking_budget=0 to request Gemini 3 minimal thinking."
        )
    raise LlmEmptyResponseError(finish_reason=finish_reason, model=model, hint=hint)


def _is_gemini_3_model(model: str) -> bool:
    return bool(re.match(r"gemini-3(?:[.-]|$)", str(model or "").casefold()))


def _thinking_level_from_budget(thinking_budget: int) -> str:
    if thinking_budget <= 0:
        return "minimal"
    if thinking_budget <= 1024:
        return "low"
    if thinking_budget <= 4096:
        return "medium"
    return "high"


def _gemini_thinking_config(model: str, thinking_budget: int | None, *, compat: bool = False) -> dict | None:
    if thinking_budget is None:
        return None
    if _is_gemini_3_model(model):
        key = "thinking_level" if compat else "thinkingLevel"
        return {key: _thinking_level_from_budget(thinking_budget)}
    key = "thinking_budget" if compat else "thinkingBudget"
    return {key: thinking_budget}


class _GeminiCompatForbidden(Exception):
    """Sentinel: Gemini OpenAI-compat returned 403. Switch to native API."""
    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        super().__init__(f"Gemini compat 403: {response.text[:200]}")


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: LLMClient | None = None


def get_client() -> LLMClient:
    """Return (or create) the module-level LLMClient singleton."""
    global _instance
    if _instance is None:
        base_url, model, api_key = _detect_provider()
        log.info("LLM provider: %s  model: %s", base_url, model)
        _instance = LLMClient(base_url, model, api_key)
    return _instance
