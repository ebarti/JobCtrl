"""LLM client regressions."""

from __future__ import annotations

import json
import math

import httpx
import pytest

from jobctrl import llm
from jobctrl.domain.materials.use_cases import TAILORED_RESUME_RESPONSE_SCHEMA
from jobctrl.llm import LLMClient


def test_gemini_provider_defaults_to_gemini_35_flash(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)

    _base_url, model, _api_key = llm._detect_provider()

    assert model == "gemini-3.5-flash"


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
        model="gemini-3.5-flash",
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
        model="gemini-3.5-flash",
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


def test_openai_compat_path_sends_strict_tailoring_schema() -> None:
    requests: list[dict] = []

    def _openai_response(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            status_code=200,
            json={
                "choices": [
                    {
                        "message": {"content": "{}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    client = LLMClient(
        base_url="https://api.openai.com/v1",
        model="gpt-test",
        api_key="test-key",
    )
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(_openai_response))

    try:
        response = client.chat(
            [{"role": "user", "content": "tailor"}],
            response_schema=TAILORED_RESUME_RESPONSE_SCHEMA,
        )
    finally:
        client.close()

    assert response == "{}"
    assert len(requests) == 1
    response_format = requests[0]["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["strict"] is True
    schema = response_format["json_schema"]["schema"]
    experience_item = schema["properties"]["experience_updates"]["items"]
    assert set(experience_item["required"]) == {"id", "title", "bullets"}


def test_chat_json_retries_malformed_structured_output_without_token_cap() -> None:
    requests: list[dict] = []

    def _openai_response(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        requests.append(payload)
        content = '{"score":' if len(requests) == 1 else '{"score": 8}'
        return httpx.Response(
            status_code=200,
            json={
                "choices": [
                    {
                        "message": {"content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    client = LLMClient(
        base_url="https://api.openai.com/v1",
        model="gpt-test",
        api_key="test-key",
    )
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(_openai_response))

    try:
        response = client.chat_json(
            [{"role": "user", "content": "score"}],
            response_schema={
                "title": "Score",
                "type": "object",
                "properties": {"score": {"type": "integer"}},
                "required": ["score"],
            },
        )
    finally:
        client.close()

    assert response == {"score": 8}
    assert len(requests) == 2
    assert all("max_tokens" not in request for request in requests)


# ---------------------------------------------------------------------------
# Retry hardening (P1a): transient failures retry with bounded, jittered,
# capped backoff; non-retryable client errors fail fast.
# ---------------------------------------------------------------------------


def _ok_response() -> httpx.Response:
    return httpx.Response(
        status_code=200,
        json={
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        },
    )


def _client_with_handler(handler) -> LLMClient:
    client = LLMClient(
        base_url="https://api.openai.com/v1",
        model="gpt-test",
        api_key="test-key",
    )
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    return client


@pytest.fixture
def llm_retry_sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    sleeps: list[float] = []
    real_time = llm.time

    class TimeProxy:
        def sleep(self, seconds: float) -> None:
            sleeps.append(seconds)

        def __getattr__(self, name: str):
            return getattr(real_time, name)

    monkeypatch.setattr(llm, "time", TimeProxy())
    return sleeps


def test_chat_retries_5xx_then_succeeds(llm_retry_sleeps: list[float]) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(status_code=500, json={"error": "server"})
        return _ok_response()

    client = _client_with_handler(handler)
    try:
        result = client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert result == "ok"
    assert calls["n"] == 2
    assert len(llm_retry_sleeps) == 1


def test_chat_retries_connection_error_then_succeeds(llm_retry_sleeps: list[float]) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return _ok_response()

    client = _client_with_handler(handler)
    try:
        result = client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert result == "ok"
    assert calls["n"] == 2
    assert len(llm_retry_sleeps) == 1


def test_chat_caps_hostile_retry_after_header(llm_retry_sleeps: list[float]) -> None:
    """A 429 with an absurd ``Retry-After`` must not park the call for
    hours — the honored wait is capped at the ceiling."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                status_code=429,
                headers={"Retry-After": "86400"},
                json={"error": "rate limited"},
            )
        return _ok_response()

    client = _client_with_handler(handler)
    try:
        result = client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert result == "ok"
    assert len(llm_retry_sleeps) == 1
    assert llm_retry_sleeps[0] <= llm._MAX_RETRY_WAIT


def test_chat_retries_on_negative_retry_after(llm_retry_sleeps: list[float]) -> None:
    """A negative ``Retry-After`` must not reach ``time.sleep`` (which rejects
    it with ValueError). The honored wait is floored to a finite, non-negative
    value and the request is retried."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                status_code=429,
                headers={"Retry-After": "-100"},
                json={"error": "rate limited"},
            )
        return _ok_response()

    client = _client_with_handler(handler)
    try:
        result = client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert result == "ok"
    assert calls["n"] == 2
    assert len(llm_retry_sleeps) == 1
    assert math.isfinite(llm_retry_sleeps[0])
    assert 0 <= llm_retry_sleeps[0] <= llm._MAX_RETRY_WAIT


def test_chat_retries_on_nan_retry_after(llm_retry_sleeps: list[float]) -> None:
    """A NaN ``Retry-After`` must not reach ``time.sleep`` (which rejects it
    with ValueError). It is treated as an absent header, so the call falls back
    to bounded backoff and retries."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                status_code=429,
                headers={"Retry-After": "nan"},
                json={"error": "rate limited"},
            )
        return _ok_response()

    client = _client_with_handler(handler)
    try:
        result = client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert result == "ok"
    assert calls["n"] == 2
    assert len(llm_retry_sleeps) == 1
    assert math.isfinite(llm_retry_sleeps[0])
    assert 0 <= llm_retry_sleeps[0] <= llm._MAX_RETRY_WAIT


def test_chat_does_not_retry_client_error(llm_retry_sleeps: list[float]) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(status_code=400, json={"error": "bad request"})

    client = _client_with_handler(handler)
    try:
        with pytest.raises(httpx.HTTPStatusError):
            client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert calls["n"] == 1
    assert llm_retry_sleeps == []


def test_chat_bounds_retries_on_persistent_transient_failure(llm_retry_sleeps: list[float]) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(status_code=503, json={"error": "unavailable"})

    client = _client_with_handler(handler)
    try:
        with pytest.raises(httpx.HTTPStatusError):
            client.chat([{"role": "user", "content": "hi"}])
    finally:
        client.close()

    assert calls["n"] == llm._MAX_RETRIES
    assert len(llm_retry_sleeps) == llm._MAX_RETRIES - 1
    assert all(wait <= llm._MAX_RETRY_WAIT for wait in llm_retry_sleeps)
