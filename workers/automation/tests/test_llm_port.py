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

import jobctrl.infrastructure.llm.llm_client as adapter_module
from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.infrastructure.llm.llm_client import LlmAdapter


class _FakeClient:
    """Stand-in for ``jobctrl.llm.LLMClient``.

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

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        routed.provider_id = provider or "google"
        return routed

    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)
    adapter = LlmAdapter(default_model="gemini:gemini-3.5-flash")

    response = adapter.chat([LlmMessage(role="user", content="hi")])

    assert response == "routed"
    assert adapter.model == "gemini-3.5-flash"
    assert created == [("google", "gemini-3.5-flash")]


@pytest.mark.parametrize(
    ("provider", "saved_model"),
    [
        ("claude", "claude-opus-4-8"),
        ("codex", "gpt-5.5"),
        ("google", "gemini-3.5-flash"),
    ],
)
def test_llm_adapter_resolves_saved_model_for_default_calls(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    provider: str,
    saved_model: str,
) -> None:
    created: list[tuple[str | None, str | None]] = []

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "google"
        return client

    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        f'{{"preferred_models":{{"{provider}":"{saved_model}"}}}}',
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(adapter_module, "_default_provider", lambda: provider)
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)

    LlmAdapter(default_model="default")

    assert created == [(provider, saved_model)]


def test_llm_adapter_keeps_explicit_model_over_legacy_environment_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: list[tuple[str | None, str | None]] = []

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "google"
        return client

    monkeypatch.setenv("LLM_MODEL", "claude:claude-opus-4-8")
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)

    LlmAdapter(default_model="codex:gpt-5.5")

    assert created == [("codex", "gpt-5.5")]


def test_llm_adapter_uses_selected_ready_providers_saved_model(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        '{"preferred_models":{"claude":"opus","codex":"gpt-saved","google":"gemini-saved"}}',
        encoding="utf-8",
    )
    created: list[tuple[str | None, str | None]] = []

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "claude"
        return client

    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(adapter_module, "_default_provider", lambda: "claude")
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)

    LlmAdapter(default_model="default")

    assert created == [("claude", "opus")]


def test_llm_adapter_ignores_legacy_environment_default_and_keeps_saved_model(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"preferred_models":{"claude":"opus"}}', encoding="utf-8")
    created: list[tuple[str | None, str | None]] = []

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "claude"
        return client

    monkeypatch.setenv("LLM_MODEL", "default")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(adapter_module, "_default_provider", lambda: "claude")
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)

    LlmAdapter(default_model="default")

    assert created == [("claude", "opus")]


def test_get_llm_adapter_refreshes_changed_saved_model_without_mutating_warm_adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"preferred_models":{"claude":"model-a"}}', encoding="utf-8")

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "claude"
        return client

    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(adapter_module, "_default_provider", lambda: "claude")
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)
    adapter_module.reset_llm_adapter()
    try:
        warm = adapter_module.get_llm_adapter()
        assert warm.model == "model-a"
        assert adapter_module.get_llm_adapter() is warm

        settings_path.write_text('{"preferred_models":{"claude":"model-b"}}', encoding="utf-8")
        refreshed = adapter_module.get_llm_adapter()

        assert refreshed is not warm
        assert refreshed.model == "model-b"
        assert warm.model == "model-a"
    finally:
        adapter_module.reset_llm_adapter()


def test_get_llm_adapter_ignores_temporary_legacy_environment_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "config.json"
    settings_path.write_text('{"preferred_models":{"claude":"model-a"}}', encoding="utf-8")
    provider_selections = 0

    def fake_default_provider() -> str:
        nonlocal provider_selections
        provider_selections += 1
        return "claude"

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "claude"
        return client

    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(adapter_module, "_default_provider", fake_default_provider)
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)
    adapter_module.reset_llm_adapter()
    try:
        warm = adapter_module.get_llm_adapter()
        assert adapter_module.get_llm_adapter() is warm
        assert adapter_module.get_llm_adapter() is warm
        assert provider_selections == 1

        monkeypatch.setenv("LLM_MODEL", "google:legacy-ignored")
        unchanged = adapter_module.get_llm_adapter()

        assert unchanged is warm
        assert unchanged.provider_id == "claude"
        assert unchanged.model == "model-a"
        assert provider_selections == 1

        monkeypatch.delenv("LLM_MODEL")
        assert adapter_module.get_llm_adapter() is warm
        assert provider_selections == 1
    finally:
        adapter_module.reset_llm_adapter()


def test_get_llm_adapter_does_not_replace_injected_singleton(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    injected = LlmAdapter(client=_FakeClient(model="injected-model"))  # type: ignore[arg-type]
    monkeypatch.setattr(adapter_module, "_singleton", injected)

    assert adapter_module.get_llm_adapter() is injected


def test_llm_adapter_ignores_unsupported_legacy_environment_model_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_MODEL", "local:http://127.0.0.1:11434")
    created: list[tuple[str | None, str | None]] = []

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        client = _FakeClient(model=model or "provider-default")
        client.provider_id = provider or "claude"
        return client

    monkeypatch.setattr(adapter_module, "_default_provider", lambda: "claude")
    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)

    LlmAdapter(default_model="default")

    assert created == [("claude", None)]


def test_llm_adapter_routes_explicit_provider_model(monkeypatch: pytest.MonkeyPatch) -> None:
    default = _FakeClient(model="default-model")
    routed = _FakeClient(response="routed", model="judge-model")
    created: list[tuple[str | None, str | None]] = []

    def fake_make_backend(provider: str | None = None, model: str | None = None) -> _FakeClient:
        created.append((provider, model))
        routed.provider_id = provider or "google"
        return routed

    monkeypatch.setattr(adapter_module, "_make_backend", fake_make_backend)
    adapter = LlmAdapter(client=default)  # type: ignore[arg-type]

    response = adapter.chat([LlmMessage(role="user", content="hi")], model="gemini:judge-model")

    assert response == "routed"
    assert created == [("google", "judge-model")]
    assert len(default.calls) == 0
    assert len(routed.calls) == 1


def test_llm_adapter_rejects_direct_openai_provider() -> None:
    adapter = LlmAdapter(client=_FakeClient())  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="unsupported LLM provider"):
        adapter.chat([LlmMessage(role="user", content="hi")], model="openai:gpt-test")


def test_llm_adapter_rejects_raw_provider_config_in_model_spec() -> None:
    adapter = LlmAdapter(client=_FakeClient())  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="URLs"):
        adapter.chat([LlmMessage(role="user", content="hi")], model="local:http://127.0.0.1:11434")


def test_llm_adapter_ask_collapses_to_single_message_chat() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.ask("ping")
    assert fake.calls[0]["messages"] == [{"role": "user", "content": "ping"}]
