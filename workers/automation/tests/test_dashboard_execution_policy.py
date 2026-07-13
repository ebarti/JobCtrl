from __future__ import annotations

import json
import sqlite3

from jobctrl import config
from jobctrl.infrastructure import setup_probes
from jobctrl.scoring.tailor import _build_llm_policy


def _dashboard(tmp_path, monkeypatch, values: dict) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(values), encoding="utf-8")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))


def test_saved_execution_policy_ignores_legacy_environment_values(tmp_path, monkeypatch) -> None:
    for key, value in {
        "JOBCTRL_ANALYSIS_LEGS": "codex",
        "TAILORING_GENERATOR_MODELS": "google:legacy",
        "TAILORING_GENERATOR_MODEL": "google:legacy",
        "TAILOR_LLM_MODELS": "google:legacy",
        "TAILORING_JUDGE_MODEL": "google:legacy",
        "TAILOR_JUDGE_MODEL": "google:legacy",
        "TAILORING_JUDGE_MIN_SCORE": "0.1",
        "TAILOR_JUDGE_MIN_SCORE": "0.1",
        "JOBCTRL_APPLY_MAX_BUDGET_USD": "999",
        "JOBCTRL_APPLY_TIMEOUT_SECONDS": "60",
    }.items():
        monkeypatch.setenv(key, value)
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


def test_explicit_tailoring_request_stays_ahead_of_legacy_environment_and_saved_policy(tmp_path, monkeypatch) -> None:
    _dashboard(tmp_path, monkeypatch, {"tailoring_generator_models": ["claude:sonnet"]})
    monkeypatch.setenv("TAILORING_GENERATOR_MODELS", "codex:gpt-5.5")

    policy = _build_llm_policy(tailor_models=("google:gemini-2.5-pro",), tailor_judge_min_score=0.7)

    assert policy.candidate_models == ("google:gemini-2.5-pro",)
    assert policy.judge_min_score == 0.7


def test_discovery_automation_save_preserves_existing_search_settings(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobctrl.db"
    sqlite3.connect(db_path).close()
    monkeypatch.setattr(config, "DB_PATH", db_path)

    existing = config._default_discovery_search_config()
    existing["boards"] = ["greenhouse"]
    existing["automation"] = {"min_fit_score": 9}
    config._save_discovery_search_config_to_db(existing)

    config.save_discovery_automation_settings(
        auto_apply=True,
        apply_approval_required=False,
    )

    assert config.load_discovery_automation_settings() == {
        "min_fit_score": 9,
        "auto_apply": True,
        "apply_approval_required": False,
    }
    assert config._load_discovery_search_config_from_db()["boards"] == ["greenhouse"]


def test_disabling_discovery_automation_keeps_approval_fail_closed(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobctrl.db"
    sqlite3.connect(db_path).close()
    monkeypatch.setattr(config, "DB_PATH", db_path)

    config.save_discovery_automation_settings(
        auto_apply=False,
        apply_approval_required=True,
    )

    settings = config.load_discovery_automation_settings()
    assert settings["auto_apply"] is False
    assert settings["apply_approval_required"] is True
