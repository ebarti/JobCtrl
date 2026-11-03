"""Unlimited admission must not turn unknown accounting into a usage total."""

from __future__ import annotations

import sqlite3

import pytest
from temporalio.testing import ActivityEnvironment

import jobctrl.database as database
from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved, SpendObservation
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.infrastructure.scoring import criteria_provider
from jobctrl.llm import SpendBudgetInput, check_spend_budget, read_llm_spend, read_spend_budget_status
from jobctrl.llm_lanes import bind_llm_lane


@pytest.fixture
def interrupted_usage(monkeypatch, tmp_path):
    path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", path)
    database.init_db(path)
    settings = {"daily_budget_usd": 0, "lane_token_limits": {"tailoring": 0}}
    monkeypatch.setattr(criteria_provider, "read_config_settings", lambda _path=None: settings)
    observation = SpendObservation(day="2026-01-01", lane="enrichment", provider="openai", model="synthetic")
    observation.close(unresolved=True)
    receipt = next((tmp_path / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    yield path, receipt, settings
    database.close_connection(path)


@pytest.mark.asyncio
async def test_unlimited_temporal_preflight_and_provider_admit_with_retained_receipt(interrupted_usage):
    path, receipt, _settings = interrupted_usage
    retained = receipt.read_bytes()
    status = await ActivityEnvironment().run(check_spend_budget, SpendBudgetInput(lane="tailoring"))
    assert not status.exceeded
    assert status.input_tokens is None and status.estimated_usd is None
    assert not status.accounting_complete

    with bind_llm_lane("tailoring"):
        with llm_generation_span(model="synthetic", messages=[], params={}) as record:
            record("synthetic response", input_tokens=9, output_tokens=4)

    assert receipt.read_bytes() == retained
    assert list(receipt.parent.glob("*.jsonl")) == [receipt]
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT lane, input_tokens, output_tokens FROM llm_spend").fetchall() == [
            ("tailoring", 9, 4),
        ]
    with pytest.raises(SpendAccountingUnresolved):
        read_llm_spend()
    with pytest.raises(SpendAccountingUnresolved):
        read_spend_budget_status(lane="tailoring", require_complete=True)


@pytest.mark.parametrize("daily,lane_limit", [(25, 0), (0, 100), (25, 100)])
@pytest.mark.asyncio
async def test_configured_limit_still_refuses_unresolved_usage(interrupted_usage, daily, lane_limit):
    _path, receipt, settings = interrupted_usage
    retained = receipt.read_bytes()
    settings.update(daily_budget_usd=daily, lane_token_limits={"tailoring": lane_limit})
    with pytest.raises(SpendAccountingUnresolved):
        await ActivityEnvironment().run(check_spend_budget, SpendBudgetInput(lane="tailoring"))
    with bind_llm_lane("tailoring"), pytest.raises(SpendAccountingUnresolved):
        with llm_generation_span(model="synthetic", messages=[], params={}):
            pytest.fail("Provider dispatch must remain blocked when a limit needs unknown usage")
    assert receipt.read_bytes() == retained


def test_unlimited_other_lane_does_not_disable_this_lanes_limit(interrupted_usage):
    _path, _receipt, settings = interrupted_usage
    settings["lane_token_limits"] = {"scoring": 100, "tailoring": 0}
    with bind_llm_lane("tailoring"):
        with llm_generation_span(model="synthetic", messages=[], params={}):
            pass
    with bind_llm_lane("scoring"), pytest.raises(SpendAccountingUnresolved):
        with llm_generation_span(model="synthetic", messages=[], params={}):
            pytest.fail("A different unlimited lane must not authorize this limited lane")


def test_receipt_boundary_rechecks_limit_after_unlimited_preflight(interrupted_usage):
    _path, receipt, settings = interrupted_usage
    retained = receipt.read_bytes()
    assert not read_spend_budget_status(lane="tailoring").exceeded
    settings["daily_budget_usd"] = 25
    with pytest.raises(SpendAccountingUnresolved):
        SpendObservation(day="2026-01-01", lane="tailoring", provider="openai", model="synthetic")
    assert receipt.read_bytes() == retained


def test_doctor_reports_incomplete_accounting_even_when_admission_is_unlimited(interrupted_usage):
    from jobctrl.cli import llm_budget_doctor_notices

    with pytest.raises(SpendAccountingUnresolved):
        llm_budget_doctor_notices()
