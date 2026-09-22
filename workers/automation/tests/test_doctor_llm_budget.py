from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

from typer.testing import CliRunner

from jobctrl.cli import app
from jobctrl.database import close_connection, init_db
from jobctrl.llm import record_llm_spend


def test_doctor_reports_global_and_lane_budget_status(monkeypatch, tmp_path) -> None:
    import jobctrl.config as config
    import jobctrl.database as database

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    settings_path = tmp_path / "config.json"
    settings_path.write_text(
        json.dumps(
            {
                "daily_budget_usd": 5,
                "lane_token_limits": {"scoring": 10},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(settings_path))
    init_db(db_path)
    record_llm_spend(
        lane="scoring",
        input_tokens=7,
        output_tokens=3,
        estimated_usd=1.25,
    )
    close_connection(db_path)

    with patch(
        "jobctrl.infrastructure.temporal.client.Client.connect",
        new=AsyncMock(side_effect=RuntimeError("offline")),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    normalized = " ".join(result.output.split())
    assert "LLM daily spend" in normalized
    assert "$1.2500 / $5.00" in normalized
    assert "LLM lane scoring" in normalized
    assert "10 tokens / 10 tokens" in normalized
