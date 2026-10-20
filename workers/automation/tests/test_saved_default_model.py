"""An explicit saved model binds every default call without silent fallback."""

from types import SimpleNamespace

import pytest

from jobctrl.domain.ports.llm import LlmFailure, LlmMessage
from jobctrl.infrastructure.llm import llm_client
from jobctrl.infrastructure.llm.provider_availability import record_provider_failure
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, ProviderFailureEnvelope
from jobctrl.infrastructure.scoring import criteria_provider

_ROUTED_CHAT_JSON = llm_client.LlmAdapter.chat_json


@pytest.fixture
def configured_route(monkeypatch):
    settings = {"default_llm_model": "codex:gpt-6.1-sol"}
    monkeypatch.setattr(criteria_provider, "read_config_settings", lambda _path=None: settings)
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.ready_llm_providers", lambda: ("claude", "codex", "google"))
    monkeypatch.setattr(llm_client, "_make_backend", lambda provider, model: SimpleNamespace(provider_id=provider, model=model or "provider-default"))
    # Own the no-network backend and exercise real routing instead of the
    # workflow suite's default unavailable-model guard.
    monkeypatch.setattr(llm_client.LlmAdapter, "chat_json", _ROUTED_CHAT_JSON)
    llm_client.reset_llm_adapter()
    yield settings
    llm_client.reset_llm_adapter()


def test_saved_default_selects_codex_over_other_ready_providers(configured_route):
    llm = llm_client.get_llm_adapter()
    assert (llm.provider_id, llm.model) == ("codex", "gpt-6.1-sol")
    assert llm._pinned is True


def test_explicit_workflow_choice_takes_precedence(configured_route):
    llm = llm_client.LlmAdapter(default_model="google:explicit-model")
    assert (llm.provider_id, llm.model) == ("google", "explicit-model")


def test_warm_acquisition_rebinds_after_saved_default_edit(configured_route):
    before = llm_client.get_llm_adapter()
    configured_route["default_llm_model"] = "codex:changed-model"
    after = llm_client.get_llm_adapter()
    assert after is not before
    assert after.model == "changed-model"
    assert before.model == "gpt-6.1-sol"


def test_warm_acquisition_rebinds_after_effort_edit(configured_route, monkeypatch):
    monkeypatch.setattr(llm_client, "_make_backend", lambda provider, model: SimpleNamespace(provider_id=provider, model=model, reasoning_effort=criteria_provider.read_codex_reasoning_effort(model)))
    configured_route["codex_reasoning_efforts"] = {"gpt-6.1-sol": "high"}
    first = llm_client.get_llm_adapter()
    configured_route["codex_reasoning_efforts"]["gpt-6.1-sol"] = "max"
    second = llm_client.get_llm_adapter()
    assert first is not second
    assert first.reasoning_effort == "high"
    assert second.reasoning_effort == "max"


def test_saved_pin_does_not_fail_over_when_route_is_unavailable(configured_route):
    llm_client.get_llm_adapter()
    record_provider_failure("codex", "gpt-6.1-sol", ProviderCallError(ProviderFailureEnvelope(
        provider="openai", model="gpt-6.1-sol", operation="chat_json", category="provider_transport",
        error_type="service_unavailable", code="provider_unavailable", retryable=True,
    )))
    llm = llm_client.get_llm_adapter()
    assert (llm.provider_id, llm.model) == ("codex", "gpt-6.1-sol")
    with pytest.raises(LlmFailure, match="provider_unavailable"):
        llm.chat_json([LlmMessage(role="user", content="synthetic")], response_schema={"type": "object"})


def test_saved_default_voice_uses_same_route_without_claude_auth(configured_route, monkeypatch):
    from jobctrl.scoring.tailor import _build_voice_port

    def unexpected_claude_probe():
        raise AssertionError("A Codex writing pass must not read Claude auth")

    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.probe_claude_auth", unexpected_claude_probe)
    assert _build_voice_port().model_id == "codex:gpt-6.1-sol"


def test_cleared_default_preserves_automatic_provider_policy(configured_route):
    configured_route["default_llm_model"] = None
    assert llm_client.get_llm_adapter().provider_id == "claude"
