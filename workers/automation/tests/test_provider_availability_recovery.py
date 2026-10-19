"""Durable retry selects a healthy route before binding model provenance."""

import json

import pytest

from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.infrastructure.llm import llm_client
from jobctrl.infrastructure.llm.provider_availability import provider_route_available, record_provider_failure
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, ProviderFailureEnvelope, raise_on_claude_execution_failure

_ROUTED_CHAT_JSON = llm_client.LlmAdapter.chat_json


@pytest.fixture(autouse=True)
def isolated_routes():
    llm_client.reset_llm_adapter()
    yield
    llm_client.reset_llm_adapter()


def failure(*, code="unauthorized", status=401):
    return ProviderCallError(ProviderFailureEnvelope(
        provider="claude", model="model-a", operation="chat_json", category="provider_turn",
        error_type="synthetic_sdk_error", code=code, retryable=status == 429, http_status=status,
    ))


def test_next_automatic_attempt_uses_a_new_provider_without_relabeling_the_failed_adapter(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"preferred_models": {"claude": "model-a", "codex": "model-b"}}))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.ready_llm_providers", lambda: ("claude", "codex"))
    calls = []

    class Backend:
        def __init__(self, provider, model):
            self.provider_id, self.model = provider, model

        def chat_json(self, messages, **kwargs):
            calls.append((self.provider_id, self.model))
            if self.provider_id == "claude":
                raise failure()
            return {"accepted": True}

    monkeypatch.setattr(llm_client, "_make_backend", Backend)
    # This adapter contract test owns its SDK factory; the global workflow-test
    # guard otherwise replaces chat_json before it can reach that fake SDK.
    monkeypatch.setattr(llm_client.LlmAdapter, "chat_json", _ROUTED_CHAT_JSON)
    first = llm_client.get_llm_adapter()
    with pytest.raises(ProviderCallError):
        first.chat_json([LlmMessage(role="user", content="synthetic")], response_schema={"type": "object"})
    second = llm_client.get_llm_adapter()
    assert (second.provider_id, second.model) == ("codex", "model-b")
    assert second is not first
    assert (first.provider_id, first.model) == ("claude", "model-a")
    assert second.chat_json([], response_schema={"type": "object"}) == {"accepted": True}
    assert llm_client.get_llm_adapter() is second
    assert calls == [("claude", "model-a"), ("codex", "model-b")]
    assert not provider_route_available("claude", "another-model")
    from jobctrl.domain.ports.llm import LlmFailure

    with pytest.raises(LlmFailure, match="provider_unavailable"):
        second.chat_json([], model="claude:model-a", response_schema={"type": "object"})
    assert calls == [("claude", "model-a"), ("codex", "model-b")]


def test_rate_failure_excludes_the_model_route_and_reset_retries_it(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"preferred_models":{"codex":"rate-limited"}}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))
    assert record_provider_failure("codex", "rate-limited", failure(code="response_too_many_failed_attempts", status=429))
    assert not provider_route_available("codex")
    assert provider_route_available("codex", "other-model")
    llm_client.reset_llm_adapter()
    assert provider_route_available("codex")


@pytest.mark.asyncio
async def test_analysis_leg_never_calls_a_previously_discarded_sdk_route():
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.analysis.ensemble import _draft_with_retry

    class UnavailableDraft:
        provider_id, model_id = "codex", "unavailable-model"

        async def draft(self, *args):
            raise AssertionError("Discarded SDK route must never be called")

    assert record_provider_failure(
        "codex", "unavailable-model", failure(code="response_too_many_failed_attempts", status=429),
    )
    with pytest.raises(DeterminationFailure, match="provider_error"):
        await _draft_with_retry(UnavailableDraft(), system_prompt="synthetic", jd_snapshot="synthetic",
                                max_retries=2, verify_prose=lambda _: None)


@pytest.mark.parametrize("error", [ValueError("schema"), RuntimeError("semantic result"), json.JSONDecodeError("invalid", "", 0)])
def test_response_failures_do_not_discard_a_provider(error):
    assert not record_provider_failure("codex", "model", error)
    assert provider_route_available("codex", "model")


@pytest.mark.parametrize("kind", ["AntigravityConnectionError", "AntigravityExecutionError"])
def test_google_sdk_operational_failures_discard_the_route(kind):
    from google.antigravity import types

    assert record_provider_failure("google", "model", getattr(types, kind)("private SDK detail"))
    assert not provider_route_available("google", "model")
    assert provider_route_available("google", "another-model")


def test_google_sdk_response_validation_does_not_discard_the_route():
    from google.antigravity.types import AntigravityValidationError

    assert not record_provider_failure("google", "model", AntigravityValidationError("invalid shape"))
    assert provider_route_available("google", "model")


def test_budget_failure_does_not_discard_a_provider():
    from jobctrl.domain.errors import BudgetExceededError

    assert not record_provider_failure("codex", "model", BudgetExceededError())
    assert provider_route_available("codex", "model")


def test_default_model_failure_excludes_the_implicit_route(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{}")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))
    assert record_provider_failure(
        "codex", "sdk-default", failure(code="server_overloaded", status=503), default_model=True,
    )
    assert not provider_route_available("codex")
    assert provider_route_available("codex", "another-model")


def test_claude_execution_error_is_not_generated_content_or_schema_failure():
    result_type = type("ResultMessage", (), {})
    message = result_type()
    message.is_error, message.subtype = True, "error_during_execution"
    with pytest.raises(ProviderCallError) as raised:
        raise_on_claude_execution_failure([message], model="model", operation="analysis")
    assert record_provider_failure("claude", "model", raised.value)
    assert not provider_route_available("claude", "model")
    llm_client.reset_llm_adapter()
    message.subtype = "error_max_structured_output_retries"
    raise_on_claude_execution_failure([message], model="model", operation="analysis")
    assert provider_route_available("claude", "model")


def test_optional_voice_skips_a_known_unavailable_provider(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from jobctrl.scoring.tailor import _build_voice_port

    path = tmp_path / "config.json"
    path.write_text('{"preferred_models":{"claude":"voice-model"}}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.probe_claude_auth", lambda: SimpleNamespace(ok=True))
    assert _build_voice_port().model_id == "voice-model"
    assert record_provider_failure("claude", "voice-model", failure())
    assert _build_voice_port() is None
