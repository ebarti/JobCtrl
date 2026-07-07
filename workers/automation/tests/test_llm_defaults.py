from __future__ import annotations

from jobctrl.llm import DEFAULT_GEMINI_MODEL, _detect_provider


def test_gemini_provider_defaults_to_stable_gemini_35(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_URL", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)

    base_url, model, api_key = _detect_provider()

    assert base_url == "https://generativelanguage.googleapis.com/v1beta/openai"
    assert model == DEFAULT_GEMINI_MODEL
    assert model == "gemini-3.5-flash"
    assert api_key == "test-gemini-key"


def test_llm_model_override_still_wins_for_gemini(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("LLM_MODEL", "custom-gemini-model")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_URL", raising=False)

    _base_url, model, _api_key = _detect_provider()

    assert model == "custom-gemini-model"
