from __future__ import annotations

import sqlite3

from jobctrl import config
from jobctrl.infrastructure.scoring.criteria_provider import (
    read_apply_approval_required,
    read_apply_concurrency,
    read_daily_budget_usd,
    read_min_fit_score,
    read_preferred_model,
)


def test_config_and_discovery_settings_are_read_by_their_own_worker_readers(
    monkeypatch,
    tmp_path,
) -> None:
    settings_path = tmp_path / "custom-config.json"
    settings_path.write_text(
        """{
          "apply_concurrency": 5,
          "daily_budget_usd": 13.5,
          "preferred_models": {"claude": "  opus  ", "codex": null}
        }""",
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))

    db_path = tmp_path / "jobctrl.db"
    sqlite3.connect(db_path).close()
    monkeypatch.setattr(config, "DB_PATH", db_path)
    discovery = config._default_discovery_search_config()
    discovery["automation"] = {
        "min_fit_score": 8,
        "apply_approval_required": False,
    }
    config._save_discovery_search_config_to_db(discovery)

    assert read_apply_approval_required() is False
    assert read_apply_concurrency() == 5
    assert read_daily_budget_usd() == 13.5
    assert read_min_fit_score() == 8
    assert read_preferred_model("claude") == "opus"
    assert read_preferred_model("codex") is None
    assert read_preferred_model("local") is None


def test_config_path_environment_expands_home(monkeypatch, tmp_path) -> None:
    settings_path = tmp_path / "config" / "config.json"
    settings_path.parent.mkdir()
    settings_path.write_text('{"apply_concurrency": 5}', encoding="utf-8")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", "~/config/config.json")

    assert read_apply_concurrency() == 5
