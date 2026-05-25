from __future__ import annotations

import json

import httpx

from jobhunter import llm
from jobhunter.llm import LLMClient


def test_gemini_provider_defaults_to_gemini_3_flash_preview(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_URL", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)

    _base_url, model, _api_key = llm._detect_provider()

    assert model == "gemini-3-flash-preview"


def test_native_gemini_3_minimal_thinking_uses_thinking_level() -> None:
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode()))
        return httpx.Response(
            status_code=200,
            json={
                "candidates": [{"content": {"parts": [{"text": "ok"}]}}],
                "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
            },
        )

    client = LLMClient(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-3-flash-preview",
        api_key="test-key",
    )
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    client._use_native_gemini = True
    try:
        client.chat([{"role": "user", "content": "hello"}], thinking_budget=0)
    finally:
        client.close()

    assert requests[0]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "minimal"}
    assert "thinkingBudget" not in requests[0]["generationConfig"]["thinkingConfig"]


def test_compat_gemini_3_minimal_thinking_uses_thinking_level() -> None:
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode()))
        return httpx.Response(
            status_code=200,
            json={
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    client = LLMClient(
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        model="gemini-3-flash-preview",
        api_key="test-key",
    )
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        client.chat([{"role": "user", "content": "hello"}], thinking_budget=0)
    finally:
        client.close()

    config = requests[0]["extra_body"]["google"]["thinking_config"]
    assert config == {"thinking_level": "minimal"}
    assert "thinking_budget" not in config


def test_gemini_25_keeps_thinking_budget() -> None:
    assert llm._gemini_thinking_config("gemini-2.5-flash", 0) == {"thinkingBudget": 0}
    assert llm._gemini_thinking_config("gemini-2.5-flash", 0, compat=True) == {"thinking_budget": 0}
