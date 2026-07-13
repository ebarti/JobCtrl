"""Employer-analysis leg configuration wiring."""

from __future__ import annotations

import sqlite3

import jobctrl.infrastructure.llm
import jobctrl.infrastructure.llm.llm_client
import jobctrl.infrastructure.setup_probes
from jobctrl.scoring.employer_analysis import build_analyze_use_case


class _FakeLlm:
    def __init__(
        self,
        *,
        default_model: str | None = None,
        default_provider: str | None = None,
    ) -> None:
        self.provider_id = default_provider or str(default_model).split(":", 1)[0]
        self.model = "test-model"


def test_enabled_analysis_legs_control_adapters_and_cache_key(monkeypatch) -> None:
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "claude,antigravity")
    monkeypatch.setattr(jobctrl.infrastructure.setup_probes, "ready_llm_providers", lambda: ("google",))
    monkeypatch.setattr(jobctrl.infrastructure.llm, "LlmAdapter", _FakeLlm)
    conn = sqlite3.connect(":memory:")

    use_case = build_analyze_use_case(conn=conn, event_stage="score")

    adapter_names = {type(adapter).__name__ for adapter in use_case._adapters}
    assert adapter_names == {"ClaudeAnalysisAdapter", "AntigravityAnalysisAdapter"}
    assert use_case._sdk_set_version == "claude+antigravity-v2-synth-google"


def test_ready_provider_excluded_from_stale_leg_list_is_added_as_draft(monkeypatch) -> None:
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "claude")
    monkeypatch.setattr(jobctrl.infrastructure.setup_probes, "ready_llm_providers", lambda: ("codex",))
    monkeypatch.setattr(jobctrl.infrastructure.llm, "LlmAdapter", _FakeLlm)

    use_case = build_analyze_use_case(conn=sqlite3.connect(":memory:"), event_stage="score")

    assert {type(adapter).__name__ for adapter in use_case._adapters} == {
        "ClaudeAnalysisAdapter",
        "CodexAnalysisAdapter",
    }
    assert use_case._sdk_set_version == "claude-v2-synth-codex"


def test_synthesizer_uses_saved_model_for_selected_analysis_provider(
    monkeypatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "dashboard.json"
    settings_path.write_text(
        '{"preferred_models":{"codex":"gpt-saved","google":"gemini-saved"}}',
        encoding="utf-8",
    )

    def fake_make_backend(provider=None, model=None):
        backend = type("Backend", (), {})()
        backend.provider_id = provider
        backend.model = model or "provider-default"
        return backend

    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "codex")
    monkeypatch.setenv("JOBCTRL_DASHBOARD_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(
        jobctrl.infrastructure.setup_probes,
        "ready_llm_providers",
        lambda: ("codex", "google"),
    )
    monkeypatch.setattr(
        jobctrl.infrastructure.llm.llm_client,
        "_make_backend",
        fake_make_backend,
    )

    use_case = build_analyze_use_case(conn=sqlite3.connect(":memory:"), event_stage="score")

    assert use_case._synthesizer._provider_id == "codex"
    assert use_case._synthesizer._model == "gpt-saved"


def test_synthesizer_environment_route_overrides_fallback_and_adds_its_analysis_leg(
    monkeypatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "dashboard.json"
    settings_path.write_text(
        '{"preferred_models":{"codex":"gpt-saved","google":"gemini-saved"}}',
        encoding="utf-8",
    )

    def fake_make_backend(provider=None, model=None):
        backend = type("Backend", (), {})()
        backend.provider_id = provider
        backend.model = model or "provider-default"
        return backend

    monkeypatch.setenv("LLM_MODEL", "google:gemini-env")
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "codex")
    monkeypatch.setenv("JOBCTRL_DASHBOARD_CONFIG_PATH", str(settings_path))
    monkeypatch.setattr(
        jobctrl.infrastructure.setup_probes,
        "ready_llm_providers",
        lambda: ("codex", "google"),
    )
    monkeypatch.setattr(
        jobctrl.infrastructure.llm.llm_client,
        "_make_backend",
        fake_make_backend,
    )

    use_case = build_analyze_use_case(conn=sqlite3.connect(":memory:"), event_stage="score")

    assert use_case._synthesizer._provider_id == "google"
    assert use_case._synthesizer._model == "gemini-env"
    assert {type(adapter).__name__ for adapter in use_case._adapters} == {
        "CodexAnalysisAdapter",
        "AntigravityAnalysisAdapter",
    }
