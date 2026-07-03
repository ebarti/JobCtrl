from __future__ import annotations

import json

import pytest
from temporalio.exceptions import ApplicationError

from jobhunter.database import init_db
from jobhunter.llm import (
    check_spend_budget,
    read_llm_spend,
    read_spend_budget_status,
    record_llm_spend,
)


def _isolate_db(monkeypatch: pytest.MonkeyPatch, tmp_path):
    import jobhunter.database as database

    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(database, "DB_PATH", db_path)
    init_db(db_path)
    return db_path


def test_record_llm_spend_accumulates_once_per_usage_observation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    _isolate_db(monkeypatch, tmp_path)

    record_llm_spend(input_tokens=100, output_tokens=20, estimated_usd=0.5, day="2026-07-03")
    record_llm_spend(input_tokens=25, output_tokens=5, estimated_usd=0.125, day="2026-07-03")

    assert read_llm_spend("2026-07-03") == {
        "day": "2026-07-03",
        "input_tokens": 125,
        "output_tokens": 25,
        "estimated_usd": 0.625,
    }


def test_llm_spend_day_rollover_reads_zero_for_new_day(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    _isolate_db(monkeypatch, tmp_path)

    record_llm_spend(input_tokens=100, output_tokens=20, estimated_usd=0.5, day="2026-07-03")

    assert read_llm_spend("2026-07-04") == {
        "day": "2026-07-04",
        "input_tokens": 0,
        "output_tokens": 0,
        "estimated_usd": 0.0,
    }


def test_spend_budget_status_treats_zero_as_unlimited(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    _isolate_db(monkeypatch, tmp_path)
    record_llm_spend(input_tokens=1, output_tokens=1, estimated_usd=99.0)

    status = read_spend_budget_status(daily_budget_usd=0)

    assert status.daily_budget_usd == 0
    assert status.estimated_usd == 99.0
    assert status.exceeded is False


@pytest.mark.asyncio
async def test_check_spend_budget_raises_non_retryable_budget_exceeded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    _isolate_db(monkeypatch, tmp_path)
    settings_path = tmp_path / "dashboard.json"
    settings_path.write_text(json.dumps({"daily_budget_usd": 1.0}), encoding="utf-8")
    monkeypatch.setattr(
        "jobhunter.infrastructure.scoring.criteria_provider.DEFAULT_SETTINGS_PATH",
        settings_path,
    )
    record_llm_spend(input_tokens=1, output_tokens=1, estimated_usd=1.0)

    with pytest.raises(ApplicationError) as exc_info:
        await check_spend_budget(None)

    assert exc_info.value.type == "budget_exceeded"
    assert exc_info.value.non_retryable is True
