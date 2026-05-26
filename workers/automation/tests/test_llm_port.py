"""Phase 5 / S-17: LlmPort protocol + LlmAdapter wiring.

Verifies that:
  * The adapter satisfies the ``LlmPort`` protocol structurally.
  * Calling ``chat`` translates ``LlmMessage`` value objects into the
    underlying client's expected dict format.
  * ``temperature`` and ``max_tokens`` are forwarded as kwargs only when
    set (the protocol allows ``None`` to mean "use provider default").
  * ``ask`` collapses a single prompt string into a one-message chat call.
"""

from __future__ import annotations

from typing import Any

import pytest

import jobhunter.infrastructure.llm.llm_client as adapter_module
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.infrastructure.llm.llm_client import LlmAdapter


class _FakeClient:
    """Stand-in for ``jobhunter.llm.LLMClient``.

    Records every ``chat`` call so the adapter's translation layer is
    observable. ``model`` is exposed so the adapter's model-mismatch guard
    can fire.
    """

    def __init__(self, *, response: str = "ok", model: str = "test-model") -> None:
        self.response = response
        self.model = model
        self.calls: list[dict[str, Any]] = []

    def chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        self.calls.append({"messages": messages, "kwargs": kwargs})
        return self.response

    def chat_json(self, messages: list[dict[str, Any]], **kwargs: Any) -> dict:
        self.calls.append({"messages": messages, "kwargs": kwargs})
        return {"ok": True}


def test_llm_adapter_satisfies_port_protocol() -> None:
    adapter: LlmPort = LlmAdapter(client=_FakeClient())  # type: ignore[arg-type]
    assert callable(adapter.chat)
    assert callable(adapter.ask)


def test_llm_adapter_translates_messages_to_dict_format() -> None:
    fake = _FakeClient(response="42")
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]

    response = adapter.chat(
        [
            LlmMessage(role="system", content="be brief"),
            LlmMessage(role="user", content="hello"),
        ],
    )
    assert response == "42"
    assert len(fake.calls) == 1
    assert fake.calls[0]["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
    ]


def test_llm_adapter_omits_unset_kwargs() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.chat([LlmMessage(role="user", content="hi")])
    assert fake.calls[0]["kwargs"] == {}


def test_llm_adapter_forwards_set_kwargs() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.chat(
        [LlmMessage(role="user", content="hi")],
        temperature=0.5,
        max_tokens=128,
    )
    assert fake.calls[0]["kwargs"] == {"temperature": 0.5, "max_tokens": 128}


def test_llm_adapter_routes_default_model_without_mismatch_error() -> None:
    fake = _FakeClient(model="real-model")
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    response = adapter.chat([LlmMessage(role="user", content="hi")], model="default")
    assert response == "ok"


def test_llm_adapter_can_pin_its_default_model(monkeypatch: pytest.MonkeyPatch) -> None:
    routed = _FakeClient(response="routed", model="gemini-3.5-flash")
    created: list[tuple[str | None, str | None]] = []

    def fake_create_client(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        return routed

    monkeypatch.setattr(adapter_module, "create_client", fake_create_client)
    adapter = LlmAdapter(default_model="gemini:gemini-3.5-flash")

    response = adapter.chat([LlmMessage(role="user", content="hi")])

    assert response == "routed"
    assert adapter.model == "gemini-3.5-flash"
    assert created == [("gemini", "gemini-3.5-flash")]


def test_llm_adapter_routes_explicit_provider_model(monkeypatch: pytest.MonkeyPatch) -> None:
    default = _FakeClient(model="default-model")
    routed = _FakeClient(response="routed", model="judge-model")
    created: list[tuple[str | None, str | None]] = []

    def fake_create_client(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        return routed

    monkeypatch.setattr(adapter_module, "create_client", fake_create_client)
    adapter = LlmAdapter(client=default)  # type: ignore[arg-type]

    response = adapter.chat([LlmMessage(role="user", content="hi")], model="gemini:judge-model")

    assert response == "routed"
    assert created == [("gemini", "judge-model")]
    assert len(default.calls) == 0
    assert len(routed.calls) == 1


def test_llm_adapter_routes_explicit_openai_model(monkeypatch: pytest.MonkeyPatch) -> None:
    default = _FakeClient(model="default-model")
    routed = _FakeClient(response="routed", model="gpt-test")
    created: list[tuple[str | None, str | None]] = []

    def fake_create_client(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        return routed

    monkeypatch.setattr(adapter_module, "create_client", fake_create_client)
    adapter = LlmAdapter(client=default)  # type: ignore[arg-type]

    response = adapter.chat([LlmMessage(role="user", content="hi")], model="openai:gpt-test")

    assert response == "routed"
    assert created == [("openai", "gpt-test")]
    assert len(default.calls) == 0
    assert len(routed.calls) == 1


def test_llm_adapter_rejects_raw_provider_config_in_model_spec() -> None:
    adapter = LlmAdapter(client=_FakeClient())  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="URLs"):
        adapter.chat([LlmMessage(role="user", content="hi")], model="local:http://127.0.0.1:11434")


def test_llm_adapter_ask_collapses_to_single_message_chat() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.ask("ping")
    assert fake.calls[0]["messages"] == [{"role": "user", "content": "ping"}]
