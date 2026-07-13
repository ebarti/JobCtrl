"""Secret-free model discovery for the three sanctioned LLM providers."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable, Mapping
from typing import Any

PROVIDER_ORDER = ("codex", "claude", "google")
_LIVE_FAILURE_MESSAGE = "Live model catalog is temporarily unavailable."


def provider_model_catalog(
    *,
    status_loader: Callable[[str], Mapping[str, object]] | None = None,
    codex_factory: Callable[[], Any] | None = None,
    claude_factory: Callable[[], Any] | None = None,
    google_client_factory: Callable[[], Any] | None = None,
) -> dict[str, list[dict[str, object]]]:
    """Return stable, sanitized catalogs without auth or account metadata."""

    if status_loader is None:
        from jobctrl.infrastructure.setup_probes import provider_status_snapshot

        status_loader = provider_status_snapshot

    providers: list[dict[str, object]] = []
    for provider in PROVIDER_ORDER:
        status = status_loader(provider)
        configured = bool(status.get("configured"))
        ready = bool(status.get("ready"))
        item: dict[str, object] = {
            "provider": provider,
            "configured": configured,
            "ready": ready,
            "source": "live",
            "models": [],
        }
        if not ready:
            item["message"] = (
                "Provider configuration is not ready."
                if configured
                else "Provider is not configured."
            )
        elif provider == "codex":
            try:
                item["models"] = _codex_models(codex_factory)
            except Exception:  # noqa: BLE001 - boundary must never leak SDK/auth details
                item["message"] = _LIVE_FAILURE_MESSAGE
        elif provider == "claude":
            try:
                item["models"] = _claude_models(claude_factory)
            except Exception:  # noqa: BLE001 - boundary must never leak SDK/auth details
                item["message"] = _LIVE_FAILURE_MESSAGE
        else:
            try:
                item["models"] = _google_models(google_client_factory)
            except Exception:  # noqa: BLE001 - boundary must never leak SDK/auth details
                item["message"] = _LIVE_FAILURE_MESSAGE
        providers.append(item)
    return {"providers": providers}


def _codex_models(factory: Callable[[], Any] | None) -> list[dict[str, object]]:
    if factory is None:
        from jobctrl.infrastructure.analysis.codex_analysis_adapter import (
            _load_catalog_async_codex_factory,
        )

        factory = _load_catalog_async_codex_factory()

    async def load() -> Any:
        async with factory() as codex:
            return await codex.models(include_hidden=False)

    response = asyncio.run(load())
    return _normalize_codex_models(getattr(response, "data", ()))


def _normalize_codex_models(items: Iterable[Any]) -> list[dict[str, object]]:
    models: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in items:
        if bool(_field(item, "hidden")):
            continue
        model_id = _safe_text(_field(item, "model"))
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        model: dict[str, object] = {
            "id": model_id,
            "displayName": _safe_text(_field(item, "display_name")) or model_id,
        }
        if bool(_field(item, "is_default")):
            model["isDefault"] = True
        models.append(model)
        if len(models) == 512:
            break
    return models


def _claude_models(factory: Callable[[], Any] | None) -> list[dict[str, object]]:
    client_factory = factory or _default_claude_client_factory

    async def load() -> Any:
        async with client_factory() as client:
            return await client.get_server_info()

    server_info = asyncio.run(load())
    if not isinstance(server_info, Mapping):
        raise RuntimeError("Claude runtime returned no initialization metadata")
    items = server_info.get("models")
    if not isinstance(items, list):
        raise RuntimeError("Claude runtime returned no model catalog")
    return _normalize_claude_models(items)


def _default_claude_client_factory() -> Any:
    from jobctrl.infrastructure.setup_probes import bundled_claude_sdk_options
    from jobctrl.runtime import activate_provider_pack, is_bundled_runtime

    if is_bundled_runtime():
        from jobctrl.config import APP_DIR

        activate_provider_pack("claude-agent-sdk", app_dir=APP_DIR)
    from claude_agent_sdk import (  # type: ignore[import-untyped]
        ClaudeAgentOptions,
        ClaudeSDKClient,
    )

    options = ClaudeAgentOptions(
        tools=[],
        allowed_tools=[],
        **bundled_claude_sdk_options(),
    )
    return ClaudeSDKClient(options)


def _normalize_claude_models(items: Iterable[Any]) -> list[dict[str, object]]:
    models: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in items:
        model_id = _safe_text(
            _field(item, "value") or _field(item, "model") or _field(item, "id")
        )
        if not model_id or model_id == "default" or model_id in seen:
            continue
        seen.add(model_id)
        models.append(
            {
                "id": model_id,
                "displayName": _safe_text(_field(item, "display_name")) or model_id,
            }
        )
        if len(models) == 512:
            break
    return models


def _google_models(factory: Callable[[], Any] | None) -> list[dict[str, object]]:
    client = (factory or _default_google_client_factory)()
    try:
        return _normalize_google_models(client.models.list(config={"query_base": True}))
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()


def _default_google_client_factory() -> Any:
    from jobctrl.infrastructure.setup_probes import antigravity_auth_kwargs
    from jobctrl.runtime import activate_provider_pack, is_bundled_runtime

    if is_bundled_runtime():
        from jobctrl.config import APP_DIR

        activate_provider_pack("antigravity-provider-runtime", app_dir=APP_DIR)
    from google import genai  # type: ignore[import-untyped]

    provider_auth = dict(antigravity_auth_kwargs())
    if "vertex" in provider_auth:
        provider_auth["vertexai"] = provider_auth.pop("vertex")
    return genai.Client(**provider_auth)


def _normalize_google_models(items: Iterable[Any]) -> list[dict[str, object]]:
    from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import (
        ANTIGRAVITY_ANALYSIS_MODEL,
    )

    models: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in items:
        if bool(_field(item, "hidden")):
            continue
        actions = _field(item, "supported_actions")
        if actions is None:
            actions = _field(item, "supported_generation_methods")
        if actions is not None and not any(
            "generatecontent"
            in "".join(
                character
                for character in str(action).lower()
                if character.isalnum()
            )
            for action in actions
        ):
            continue
        model_id = _google_model_id(_safe_text(_field(item, "name")))
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        model: dict[str, object] = {
            "id": model_id,
            "displayName": _safe_text(_field(item, "display_name")) or model_id,
        }
        if model_id == ANTIGRAVITY_ANALYSIS_MODEL:
            model["isDefault"] = True
        models.append(model)
        if len(models) == 512:
            break
    return models


def _google_model_id(name: str) -> str:
    if not name:
        return ""
    if name.startswith("models/"):
        return _safe_text(name.removeprefix("models/"))
    marker = "/models/"
    if marker in name:
        return _safe_text(name.rsplit(marker, 1)[1])
    return name


def _field(item: Any, name: str) -> Any:
    if isinstance(item, Mapping):
        if name in item:
            return item[name]
        camel = name.split("_")[0] + "".join(part.title() for part in name.split("_")[1:])
        return item.get(camel)
    return getattr(item, name, None)


def _safe_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not 0 < len(text) <= 160 or any(
        ord(character) < 32 or ord(character) == 127 for character in text
    ):
        return ""
    return text


__all__ = ["PROVIDER_ORDER", "provider_model_catalog"]
