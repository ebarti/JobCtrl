from __future__ import annotations

import json

from jobctrl import config
from jobctrl.infrastructure import setup_probes
from jobctrl.scoring.tailor import _build_llm_policy


def _dashboard(tmp_path, monkeypatch, values: dict) -> None:
    path = tmp_path / "dashboard.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    monkeypatch.setenv("JOBCTRL_DASHBOARD_CONFIG_PATH", str(path))


def test_saved_execution_policy_is_used_when_environment_is_absent(tmp_path, monkeypatch) -> None:
    for key in (
        "JOBCTRL_ANALYSIS_LEGS",
        "TAILORING_GENERATOR_MODELS",
        "TAILORING_GENERATOR_MODEL",
        "TAILOR_LLM_MODELS",
        "TAILORING_JUDGE_MODEL",
        "TAILOR_JUDGE_MODEL",
        "TAILORING_JUDGE_MIN_SCORE",
        "TAILOR_JUDGE_MIN_SCORE",
        "JOBCTRL_APPLY_MAX_BUDGET_USD",
        "JOBCTRL_APPLY_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(key, raising=False)
    _dashboard(tmp_path, monkeypatch, {
        "analysis_legs": ["claude", "google"],
        "tailoring_generator_models": ["claude:sonnet", "codex:gpt-5.5"],
        "tailoring_judge_model": "claude:opus",
        "tailoring_judge_min_score": 0.9,
        "apply_max_budget_usd": 0,
        "apply_timeout_seconds": 1200,
    })

    assert setup_probes.enabled_analysis_legs() == ("claude", "antigravity")
    assert config.get_tailoring_generator_models() == ("claude:sonnet", "codex:gpt-5.5")
    assert config.get_tailoring_judge_model() == "claude:opus"
    assert config.get_tailoring_judge_min_score() == 0.9
    assert config.get_apply_max_budget_usd() == 0
    assert config.get_apply_timeout_seconds() == 1200


def test_explicit_tailoring_request_stays_ahead_of_environment_and_saved_policy(tmp_path, monkeypatch) -> None:
    _dashboard(tmp_path, monkeypatch, {"tailoring_generator_models": ["saved:model"]})
    monkeypatch.setenv("TAILORING_GENERATOR_MODELS", "env:model")

    policy = _build_llm_policy(tailor_models=("request:model",), tailor_judge_min_score=0.7)

    assert policy.candidate_models == ("request:model",)
    assert policy.judge_min_score == 0.7
