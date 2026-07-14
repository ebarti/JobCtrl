"""Provider-routed local implementation of the model-neutral ``LlmPort``.

Claude, Codex, and Google use their pinned agent SDKs so one authenticated
provider can service both plain chat and schema-constrained core pipeline calls.
Raw OpenAI keys are Codex CLI enrollment input, never a direct model route.
"""

from __future__ import annotations

import asyncio
import json
import threading
import warnings
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol

from jobctrl.domain.ports.llm import LlmMessage
_DEFAULT_MODEL_SENTINELS = {"", "default"}
_ROUTED_PROVIDERS = {"claude", "codex", "gemini", "google"}


class SdkControlNormalizationWarning(RuntimeWarning):
    """A model-neutral control was normalized to an SDK-owned default."""


def _validate_controls(
    *,
    temperature: float | None,
    max_tokens: int | None,
    thinking_budget: int | None,
) -> None:
    if temperature is not None and not 0.0 <= temperature <= 2.0:
        raise ValueError("temperature must be between 0.0 and 2.0")
    if max_tokens is not None and max_tokens <= 0:
        raise ValueError("max_tokens must be greater than zero")
    if thinking_budget is not None and thinking_budget < 0:
        raise ValueError("thinking_budget must be zero or greater")


def _normalize_unsupported_sdk_controls(
    provider: str,
    *,
    temperature: float | None,
    max_tokens: int | None,
) -> None:
    """Explicitly normalize controls absent from the pinned agent SDK.

    The three managed agent SDKs do not expose sampling temperature or a
    maximum output-token field.  Existing core calls supply those portable
    controls, so rejecting them would make provider routing unusable.  Warn
    callers and use the provider SDK defaults rather than silently discarding
    the request or smuggling unsupported flags through private interfaces.
    """

    controls = [
        name
        for name, value in (("temperature", temperature), ("max_tokens", max_tokens))
        if value is not None
    ]
    if controls:
        warnings.warn(
            f"{provider} agent SDK does not support {', '.join(controls)}; "
            "normalized to provider SDK defaults",
            SdkControlNormalizationWarning,
            stacklevel=3,
        )


def _reasoning_level_from_budget(thinking_budget: int) -> str:
    """Normalize a numeric budget to SDKs that expose ordinal reasoning."""

    if thinking_budget == 0:
        return "minimal"
    if thinking_budget <= 1024:
        return "low"
    if thinking_budget <= 4096:
        return "medium"
    return "high"


class _Backend(Protocol):
    model: str
    provider_id: str

    def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> str: ...

    def chat_json(self, messages: list[dict[str, str]], **kwargs: Any) -> dict: ...


def _parse_model_spec(model: str | None) -> tuple[str | None, str | None, str]:
    """Parse an opaque model spec into provider/model plus a safe cache label."""

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
        if provider in _ROUTED_PROVIDERS:
            canonical = "google" if provider == "gemini" else provider
            return canonical, selected_model or None, f"{canonical}:{selected_model or 'default'}"
        raise ValueError(f"unsupported LLM provider: {provider}")
    return None, stripped, stripped


def _resolve_default_model_spec(default_model: str | None) -> tuple[str | None, str | None, str]:
    """Resolve an explicit workflow model or the provider-neutral default."""

    return _parse_model_spec(default_model)


def _run_sync(awaitable: Awaitable[Any]) -> Any:
    """Run an SDK coroutine safely from both ordinary and event-loop threads."""

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(awaitable)

    result: list[Any] = []
    failure: list[BaseException] = []

    def runner() -> None:
        try:
            result.append(asyncio.run(awaitable))
        except BaseException as exc:  # noqa: BLE001 - re-raise on caller thread
            failure.append(exc)

    thread = threading.Thread(target=runner, name="jobctrl-llm-sdk", daemon=True)
    thread.start()
    thread.join()
    if failure:
        raise failure[0]
    return result[0]


def _prompt_parts(messages: list[dict[str, str]]) -> tuple[str, str]:
    systems = [item["content"] for item in messages if item["role"] == "system"]
    turns = [
        f"{item['role'].upper()}:\n{item['content']}"
        for item in messages
        if item["role"] != "system"
    ]
    return "\n\n".join(systems), "\n\n".join(turns)


def _claude_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if type(message).__name__ == "ResultMessage":
            result = getattr(message, "result", None)
            if isinstance(result, str) and result:
                return result
    raise RuntimeError("Claude Agent SDK returned no final text result")


class ClaudeSdkBackend:
    """Synchronous ``LlmPort`` backend over the async Claude Agent SDK."""

    provider_id = "claude"

    def __init__(
        self,
        *,
        model: str | None = None,
        query_fn: Callable[..., AsyncIterator[Any] | Awaitable[AsyncIterator[Any]]] | None = None,
        options_factory: Callable[..., Any] | None = None,
    ) -> None:
        from jobctrl.infrastructure.analysis.claude_analysis_adapter import CLAUDE_ANALYSIS_MODEL

        self.model = model or CLAUDE_ANALYSIS_MODEL
        self._query_fn = query_fn
        self._options_factory = options_factory

    async def _call(
        self,
        messages: list[dict[str, str]],
        *,
        response_schema: dict | None,
        temperature: float | None,
        max_tokens: int | None,
        thinking_budget: int | None,
    ) -> str | dict:
        from jobctrl.infrastructure.analysis.claude_analysis_adapter import (
            _aiter,
            _load_options_factory,
            _load_sdk_query,
            _structured_output_from_messages,
            _usage_from_messages,
        )
        from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
        from jobctrl.infrastructure.setup_probes import bundled_claude_sdk_options

        system_prompt, prompt = _prompt_parts(messages)
        query_fn = self._query_fn or _load_sdk_query()
        options_factory = self._options_factory or _load_options_factory()
        kwargs: dict[str, Any] = {
            "model": self.model,
            "system_prompt": system_prompt,
            "max_turns": None,
            "tools": [],
            "allowed_tools": [],
            **bundled_claude_sdk_options(),
        }
        _validate_controls(
            temperature=temperature,
            max_tokens=max_tokens,
            thinking_budget=thinking_budget,
        )
        _normalize_unsupported_sdk_controls(
            "Claude",
            temperature=temperature,
            max_tokens=max_tokens,
        )
        if thinking_budget is not None:
            kwargs["thinking"] = (
                {"type": "disabled"}
                if thinking_budget == 0
                else {"type": "enabled", "budget_tokens": thinking_budget}
            )
        if response_schema is not None:
            kwargs["output_format"] = {"type": "json_schema", "schema": response_schema}
        with llm_generation_span(
            model=self.model,
            messages=messages,
            params={
                "structured": response_schema is not None,
                "thinking_budget": thinking_budget,
            },
            scope_name="jobctrl.llm.claude",
        ) as record:
            iterator = await _aiter(query_fn(prompt=prompt, options=options_factory(**kwargs)))
            sdk_messages = [message async for message in iterator]
            value: str | dict
            if response_schema is not None:
                value = _structured_output_from_messages(sdk_messages)
            else:
                value = _claude_text(sdk_messages)
            input_tokens, output_tokens = _usage_from_messages(sdk_messages)
            record(
                json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            return value

    def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        response_schema = kwargs.get("response_schema")
        value = _run_sync(
            self._call(
                messages,
                response_schema=response_schema,
                temperature=kwargs.get("temperature"),
                max_tokens=kwargs.get("max_tokens"),
                thinking_budget=kwargs.get("thinking_budget"),
            )
        )
        return json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value

    def chat_json(self, messages: list[dict[str, str]], **kwargs: Any) -> dict:
        schema = kwargs.get("response_schema")
        if not isinstance(schema, dict):
            raise ValueError("response_schema is required for chat_json")
        value = _run_sync(
            self._call(
                messages,
                response_schema=schema,
                temperature=kwargs.get("temperature"),
                max_tokens=kwargs.get("max_tokens"),
                thinking_budget=kwargs.get("thinking_budget"),
            )
        )
        if not isinstance(value, dict):
            raise RuntimeError("Claude structured output was not a JSON object")
        return value


class CodexSdkBackend:
    """Synchronous ``LlmPort`` backend over the async Codex SDK."""

    provider_id = "codex"

    def __init__(
        self,
        *,
        model: str | None = None,
        async_codex_factory: Callable[[], Any] | None = None,
        approval_mode_factory: Callable[[], Any] | None = None,
    ) -> None:
        from jobctrl.infrastructure.analysis.codex_analysis_adapter import CODEX_ANALYSIS_MODEL

        self.model = model or CODEX_ANALYSIS_MODEL
        self._async_codex_factory = async_codex_factory
        self._approval_mode_factory = approval_mode_factory

    async def _call(
        self,
        messages: list[dict[str, str]],
        *,
        response_schema: dict | None,
        temperature: float | None,
        max_tokens: int | None,
        thinking_budget: int | None,
    ) -> str:
        from jobctrl.infrastructure.analysis.codex_analysis_adapter import (
            _deny_all_approval_mode,
            _load_async_codex_factory,
            _usage_from_result,
        )
        from jobctrl.infrastructure.analysis.strict_schema import strict_json_schema
        from jobctrl.infrastructure.observability.llm_spans import llm_generation_span

        system_prompt, prompt = _prompt_parts(messages)
        combined = f"{system_prompt}\n\n{prompt}" if system_prompt else prompt
        _validate_controls(
            temperature=temperature,
            max_tokens=max_tokens,
            thinking_budget=thinking_budget,
        )
        _normalize_unsupported_sdk_controls(
            "Codex",
            temperature=temperature,
            max_tokens=max_tokens,
        )
        effort = "high" if thinking_budget is None else _reasoning_level_from_budget(thinking_budget)
        if effort == "minimal":
            effort = "low"
        factory = self._async_codex_factory or _load_async_codex_factory()
        approval = self._approval_mode_factory or _deny_all_approval_mode
        with llm_generation_span(
            model=self.model,
            messages=messages,
            params={"structured": response_schema is not None, "effort": effort},
            scope_name="jobctrl.llm.codex",
        ) as record:
            async with factory() as codex:
                thread = await codex.thread_start(
                    approval_mode=approval(),
                    model=self.model,
                    config={"model_reasoning_effort": effort},
                )
                run_kwargs: dict[str, Any] = {"effort": effort}
                if response_schema is not None:
                    run_kwargs["output_schema"] = strict_json_schema(response_schema)
                result = await thread.run(combined, **run_kwargs)
            status_obj = getattr(result, "status", None)
            status = str(getattr(status_obj, "value", status_obj) or "")
            final_response = getattr(result, "final_response", None)
            if (status and status != "completed") or not isinstance(final_response, str) or not final_response:
                raise RuntimeError(f"Codex turn failed: status={status!r}")
            input_tokens, output_tokens = _usage_from_result(result)
            record(
                final_response,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            return final_response

    def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        return _run_sync(
            self._call(
                messages,
                response_schema=kwargs.get("response_schema"),
                temperature=kwargs.get("temperature"),
                max_tokens=kwargs.get("max_tokens"),
                thinking_budget=kwargs.get("thinking_budget"),
            )
        )

    def chat_json(self, messages: list[dict[str, str]], **kwargs: Any) -> dict:
        schema = kwargs.get("response_schema")
        if not isinstance(schema, dict):
            raise ValueError("response_schema is required for chat_json")
        parsed = json.loads(
            _run_sync(
                self._call(
                    messages,
                    response_schema=schema,
                    temperature=kwargs.get("temperature"),
                    max_tokens=kwargs.get("max_tokens"),
                    thinking_budget=kwargs.get("thinking_budget"),
                )
            )
        )
        if not isinstance(parsed, dict):
            raise RuntimeError("Codex structured output was not a JSON object")
        return parsed


class GoogleSdkBackend:
    """Synchronous ``LlmPort`` backend over the Google Antigravity SDK."""

    provider_id = "google"

    def __init__(
        self,
        *,
        model: str | None = None,
        agent_factory: Callable[[Any], Any] | None = None,
        config_factory: Callable[..., Any] | None = None,
        types_module: Any | None = None,
    ) -> None:
        from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import (
            ANTIGRAVITY_ANALYSIS_MODEL,
        )

        self.model = model or ANTIGRAVITY_ANALYSIS_MODEL
        self._agent_factory = agent_factory
        self._config_factory = config_factory
        self._types_module = types_module

    async def _call(
        self,
        messages: list[dict[str, str]],
        *,
        response_schema: dict | None,
        temperature: float | None,
        max_tokens: int | None,
        thinking_budget: int | None,
    ) -> str | dict:
        from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import (
            _load_agent_factory,
            _load_config_factory,
            _load_types_module,
            _runtime_subdir,
            _usage_from_metadata,
        )
        from jobctrl.infrastructure.analysis.gemini_schema import gemini_json_schema
        from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
        from jobctrl.infrastructure.setup_probes import antigravity_auth_kwargs

        system_prompt, prompt = _prompt_parts(messages)
        agent_factory = self._agent_factory or _load_agent_factory()
        config_factory = self._config_factory or _load_config_factory()
        types_module = self._types_module or _load_types_module()
        config_kwargs: dict[str, Any] = {
            "model": self.model,
            "system_instructions": system_prompt,
            "capabilities": types_module.CapabilitiesConfig(
                enabled_tools=[types_module.BuiltinTools.FINISH]
            ),
            "policies": [],
            "workspaces": [],
            "save_dir": _runtime_subdir("llm-sessions"),
            "app_data_dir": _runtime_subdir("llm-appdata"),
            **antigravity_auth_kwargs(),
        }
        _validate_controls(
            temperature=temperature,
            max_tokens=max_tokens,
            thinking_budget=thinking_budget,
        )
        _normalize_unsupported_sdk_controls(
            "Google",
            temperature=temperature,
            max_tokens=max_tokens,
        )
        if thinking_budget is not None:
            thinking_level = getattr(
                types_module.ThinkingLevel,
                _reasoning_level_from_budget(thinking_budget).upper(),
            )
            config_kwargs.pop("model")
            config_kwargs["gemini_config"] = types_module.GeminiConfig(
                models=types_module.ModelConfig(
                    default=types_module.ModelEntry(
                        name=self.model,
                        generation=types_module.GenerationConfig(
                            thinking_level=thinking_level,
                        ),
                    )
                )
            )
        if response_schema is not None:
            config_kwargs["response_schema"] = json.dumps(
                gemini_json_schema(response_schema),
                sort_keys=True,
            )
        with llm_generation_span(
            model=self.model,
            messages=messages,
            params={
                "structured": response_schema is not None,
                "thinking_budget": thinking_budget,
            },
            scope_name="jobctrl.llm.google",
        ) as record:
            async with agent_factory(config_factory(**config_kwargs)) as agent:
                response = await agent.chat(prompt)
                async for _chunk in response.chunks:
                    pass
                value: str | dict
                if response_schema is not None:
                    value = await response.structured_output()
                    if isinstance(value, str):
                        value = json.loads(value)
                    if not isinstance(value, dict):
                        raise RuntimeError("Google structured output was not a JSON object")
                else:
                    value = await response.text()
                    if not value:
                        raise RuntimeError("Google SDK returned no final text result")
                usage = getattr(response, "usage_metadata", None)
            input_tokens, output_tokens = _usage_from_metadata(usage)
            record(
                json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            return value

    def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        value = _run_sync(
            self._call(
                messages,
                response_schema=kwargs.get("response_schema"),
                temperature=kwargs.get("temperature"),
                max_tokens=kwargs.get("max_tokens"),
                thinking_budget=kwargs.get("thinking_budget"),
            )
        )
        return json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value

    def chat_json(self, messages: list[dict[str, str]], **kwargs: Any) -> dict:
        schema = kwargs.get("response_schema")
        if not isinstance(schema, dict):
            raise ValueError("response_schema is required for chat_json")
        value = _run_sync(
            self._call(
                messages,
                response_schema=schema,
                temperature=kwargs.get("temperature"),
                max_tokens=kwargs.get("max_tokens"),
                thinking_budget=kwargs.get("thinking_budget"),
            )
        )
        if not isinstance(value, dict):
            raise RuntimeError("Google structured output was not a JSON object")
        return value


def _default_provider() -> str:
    from jobctrl.infrastructure.setup_probes import ready_llm_providers

    ready = ready_llm_providers()
    if not ready:
        raise RuntimeError(
            "No core LLM provider is ready. Authenticate Claude, Codex, or Google."
        )
    return ready[0]


def _make_backend(provider: str | None, model: str | None) -> _Backend:
    selected = provider or _default_provider()
    if selected == "claude":
        return ClaudeSdkBackend(model=model)
    if selected == "codex":
        return CodexSdkBackend(model=model)
    if selected == "google":
        return GoogleSdkBackend(model=model)
    raise RuntimeError(f"Unsupported LLM provider: {selected}")


def _effective_default_selection(
    default_model: str | None = None,
    *,
    default_provider: str | None = None,
) -> tuple[str, str | None]:
    """Resolve the provider/model facts that determine a new adapter default."""

    provider, selected_model, label = _resolve_default_model_spec(default_model)
    selected_provider = provider or default_provider or _default_provider()
    if label == "default":
        from jobctrl.infrastructure.scoring.criteria_provider import read_preferred_model

        selected_model = read_preferred_model(selected_provider)
    return selected_provider, selected_model


class LlmAdapter:
    """Routes model-neutral calls to one authenticated provider backend."""

    def __init__(
        self,
        client: Any | None = None,
        *,
        default_model: str | None = None,
        default_provider: str | None = None,
        _resolved_default: tuple[str, str | None] | None = None,
    ) -> None:
        if client is not None:
            self._client: Any = client
            self._provider_id = str(getattr(client, "provider_id", "injected"))
            self._clients: dict[str, Any] = {"default": client}
            self._default_selection: tuple[str, str | None] | None = None
            self._injected = True
            return
        provider, selected_model = _resolved_default or _effective_default_selection(
            default_model,
            default_provider=default_provider,
        )
        backend = _make_backend(provider, selected_model)
        self._client = backend
        self._provider_id = backend.provider_id
        self._clients = {
            "default": backend,
            f"{provider}:default": backend,
        }
        if selected_model is not None:
            self._clients[selected_model] = backend
            self._clients[f"{provider}:{selected_model}"] = backend
        self._default_selection = (provider, selected_model)
        self._injected = False

    @property
    def client(self) -> Any:
        return self._client

    @property
    def model(self) -> str:
        return str(self._client.model)

    @property
    def provider_id(self) -> str:
        return self._provider_id

    def _client_for_model(self, model: str | None) -> Any:
        provider, selected_model, label = _parse_model_spec(model)
        if label == "default":
            return self._client
        cached = self._clients.get(label)
        if cached is not None:
            return cached
        if provider is None:
            provider = self._provider_id if self._provider_id != "injected" else None
        backend = _make_backend(provider, selected_model)
        self._clients[label] = backend
        return backend

    @staticmethod
    def _kwargs(
        *,
        temperature: float | None,
        max_tokens: int | None,
        response_schema: dict | None,
        thinking_budget: int | None,
    ) -> dict[str, Any]:
        values = {
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_schema": response_schema,
            "thinking_budget": thinking_budget,
        }
        return {key: value for key, value in values.items() if value is not None}

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
        return client.chat(
            payload,
            **self._kwargs(
                temperature=temperature,
                max_tokens=max_tokens,
                response_schema=response_schema,
                thinking_budget=thinking_budget,
            ),
        )

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
        return client.chat_json(
            payload,
            **self._kwargs(
                temperature=temperature,
                max_tokens=max_tokens,
                response_schema=response_schema,
                thinking_budget=thinking_budget,
            ),
        )

    def ask(self, prompt: str, **kwargs: Any) -> str:
        return self.chat([LlmMessage(role="user", content=prompt)], **kwargs)


_lock = threading.Lock()
_singleton: LlmAdapter | None = None
_singleton_default_provider: str | None = None


def get_llm_adapter() -> LlmAdapter:
    global _singleton, _singleton_default_provider
    with _lock:
        if _singleton is None:
            _singleton_default_provider = _default_provider()
            _singleton = LlmAdapter(default_provider=_singleton_default_provider)
        elif not getattr(_singleton, "_injected", True):
            selection = _effective_default_selection(
                default_provider=_singleton_default_provider,
            )
            if selection != _singleton._default_selection:
                _singleton = LlmAdapter(_resolved_default=selection)
        return _singleton


def reset_llm_adapter() -> None:
    global _singleton, _singleton_default_provider
    with _lock:
        _singleton = None
        _singleton_default_provider = None


__all__ = [
    "ClaudeSdkBackend",
    "CodexSdkBackend",
    "GoogleSdkBackend",
    "LlmAdapter",
    "SdkControlNormalizationWarning",
    "get_llm_adapter",
    "reset_llm_adapter",
]
