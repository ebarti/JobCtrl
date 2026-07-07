"""Employer-analysis leg configuration wiring."""

from __future__ import annotations

import sqlite3

from jobctrl.scoring.employer_analysis import build_analyze_use_case


def test_enabled_analysis_legs_control_adapters_and_cache_key(monkeypatch) -> None:
    monkeypatch.setenv("JOBCTRL_ANALYSIS_LEGS", "claude,antigravity")
    conn = sqlite3.connect(":memory:")

    use_case = build_analyze_use_case(conn=conn, event_stage="score")

    adapter_names = {type(adapter).__name__ for adapter in use_case._adapters}
    assert adapter_names == {"ClaudeAnalysisAdapter", "AntigravityAnalysisAdapter"}
    assert use_case._sdk_set_version == "claude+antigravity-v1"
