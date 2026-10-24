"""Temporary provider failures preserve independently bound retry attempts."""

from concurrent.futures import ThreadPoolExecutor
import json
import threading

import pytest

from jobctrl.domain.determinations import DeterminationFailure, call_model
from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.infrastructure.llm import llm_client
from jobctrl.infrastructure.llm.provider_availability import provider_route_available, record_provider_failure
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, ProviderFailureEnvelope

_ROUTED_CHAT_JSON = llm_client.LlmAdapter.chat_json


def provider_failure(code, status=None, *, retryable=True):
    return ProviderCallError(ProviderFailureEnvelope(
        provider="codex", model="synthetic-model", operation="chat_json", category="provider_turn",
        error_type="synthetic_provider_failure", code=code, retryable=retryable, http_status=status,
    ))


@pytest.mark.parametrize("code,status", [
    ("server_overloaded", None), ("internal_server_error", None),
    ("transport_error", None), ("http_connection_failed", None),
    ("response_stream_connection_failed", None), ("response_stream_disconnected", None),
    ("response_too_many_failed_attempts", 429), ("provider_unavailable", 503),
    ("other", 429), ("other", 500), ("other", 502), ("other", 504),
])
def test_temporary_typed_failure_does_not_exclude_later_attempts(code, status):
    assert not record_provider_failure("codex", "synthetic-model", provider_failure(code, status), default_model=True)
    assert provider_route_available("codex", "synthetic-model")
    assert provider_route_available("codex", "other-model")


@pytest.mark.parametrize("name", [
    "APIConnectionError", "APITimeoutError", "TimeoutError", "ConnectionError",
    "CLIConnectionError", "ServiceUnavailableError", "RateLimitError", "AntigravityConnectionError",
])
def test_temporary_sdk_exception_does_not_exclude_later_attempts(name):
    error = type(name, (Exception,), {})("private provider detail")
    assert not record_provider_failure("codex", "synthetic-model", error)
    assert provider_route_available("codex", "synthetic-model")


@pytest.mark.parametrize("code,status,retryable,provider_wide", [
    ("unauthorized", 401, False, True), ("other", 403, True, True),
    ("server_overloaded", 401, True, True),
    ("usage_limit_exceeded", 429, True, False),
    ("provider_unavailable", None, True, False),
])
def test_real_unavailability_still_excludes_its_exact_scope(code, status, retryable, provider_wide):
    assert record_provider_failure("codex", "synthetic-model", provider_failure(code, status, retryable=retryable))
    assert not provider_route_available("codex", "synthetic-model")
    assert provider_route_available("codex", "other-model") is not provider_wide


@pytest.mark.parametrize("pinned", [False, True])
def test_overload_then_overlapping_requests_reach_the_same_provider(monkeypatch, tmp_path, pinned):
    config = {"preferred_models": {"codex": "synthetic-model"}}
    if pinned:
        config["default_llm_model"] = "codex:synthetic-model"
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.ready_llm_providers", lambda: ("codex",))
    calls = []
    lock = threading.Lock()
    overlap = threading.Barrier(2)

    class Backend:
        provider_id, model = "codex", "synthetic-model"

        def chat_json(self, messages, **kwargs):
            with lock:
                calls.append((self.provider_id, self.model))
                ordinal = len(calls)
            if ordinal == 1:
                raise provider_failure("server_overloaded")
            overlap.wait(timeout=5)
            return {"accepted": True}

    monkeypatch.setattr(llm_client, "_make_backend", lambda *_: Backend())
    monkeypatch.setattr(llm_client.LlmAdapter, "chat_json", _ROUTED_CHAT_JSON)
    llm_client.reset_llm_adapter()
    first = llm_client.get_llm_adapter()

    def request(adapter):
        return call_model(llm=adapter, messages=[LlmMessage(role="user", content="Synthetic routing probe")],
                          response_schema={"type": "object"}, lane="scoring", preflight=lambda: None)

    with pytest.raises(DeterminationFailure, match="provider_error"):
        request(first)
    next_attempt = llm_client.get_llm_adapter()
    assert (next_attempt.provider_id, next_attempt.model) == (first.provider_id, first.model)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = pool.submit(request, first), pool.submit(request, next_attempt)
        assert a.result(timeout=10) == b.result(timeout=10) == {"accepted": True}
    assert calls == [("codex", "synthetic-model")] * 3
