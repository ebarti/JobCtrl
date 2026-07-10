from __future__ import annotations

from jobctrl.infrastructure.scoring.criteria_provider import (
    read_apply_approval_required,
    read_apply_concurrency,
    read_daily_budget_usd,
    read_min_fit_score,
)


def test_dashboard_settings_env_override_is_shared_by_worker_readers(
    monkeypatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "custom-dashboard.json"
    settings_path.write_text(
        """{
          "applyApprovalRequired": false,
          "applyConcurrency": 5,
          "dailyBudgetUsd": 13.5,
          "minFitScore": 8
        }""",
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_DASHBOARD_CONFIG_PATH", str(settings_path))

    assert read_apply_approval_required() is False
    assert read_apply_concurrency() == 5
    assert read_daily_budget_usd() == 13.5
    assert read_min_fit_score() == 8


def test_dashboard_settings_env_override_expands_home(monkeypatch, tmp_path) -> None:
    settings_path = tmp_path / "config" / "dashboard.json"
    settings_path.parent.mkdir()
    settings_path.write_text('{"applyApprovalRequired": false}', encoding="utf-8")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("JOBCTRL_DASHBOARD_CONFIG_PATH", "~/config/dashboard.json")

    assert read_apply_approval_required() is False
