"""Employer-analysis leg configuration wiring."""

from __future__ import annotations

import sqlite3

import jobctrl.infrastructure.llm
import jobctrl.infrastructure.setup_probes
from jobctrl.scoring.employer_analysis import build_analyze_use_case


class _FakeLlm:
    def __init__(self, *, default_model: str) -> None:
        self.provider_id = default_model.split(":", 1)[0]
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
