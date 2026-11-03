"""Synthetic ledger faults must not make observed model work look free."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path
from threading import Event

import pytest

import jobctrl.database as database
import jobctrl.llm as accounting
from jobctrl.infrastructure.llm.spend_observation import SpendAccountingUnresolved, SpendObservation
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.llm_lanes import LLM_LANES, bind_llm_lane


@pytest.fixture
def isolated_ledger(monkeypatch, tmp_path):
    path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(database, "DB_PATH", path)
    database.init_db(path)
    monkeypatch.setattr(accounting, "enforce_spend_budget", lambda _lane=None: accounting.read_llm_spend())
    yield path
    database.close_connection(path)


@pytest.mark.parametrize("fault", ["insert", "before_commit", "after_commit"])
def test_ambiguous_write_is_retained_once_across_restart(monkeypatch, isolated_ledger, fault):
    conn = database.get_connection()
    calls = []

    class Sink:
        def execute(self, sql, params):
            calls.append("insert")
            if fault == "insert":
                raise sqlite3.OperationalError("synthetic insert failure")
            return conn.execute(sql, params)

        def commit(self):
            if fault == "after_commit":
                conn.commit()
            raise sqlite3.OperationalError("synthetic commit failure")

    with monkeypatch.context() as patch:
        patch.setattr(accounting, "enforce_spend_budget", lambda _lane=None: None)
        patch.setattr(database, "init_db", lambda *args: None)
        patch.setattr(database, "get_connection", lambda *args, **kwargs: Sink())
        with bind_llm_lane("scoring"), pytest.raises(sqlite3.OperationalError):
            with llm_generation_span(model="claude-synthetic", messages=[], params={}) as record:
                record("", input_tokens=11, output_tokens=7)
                record("", input_tokens=11, output_tokens=7)
    assert calls == ["insert"]
    database.close_connection(isolated_ledger)

    with pytest.raises(SpendAccountingUnresolved, match="unresolved"):
        accounting.read_llm_spend()
    with pytest.raises(SpendAccountingUnresolved, match="unresolved"):
        accounting.read_llm_spend_by_lane()
    with sqlite3.connect(isolated_ledger) as raw:
        row = raw.execute("SELECT input_tokens, output_tokens FROM llm_spend WHERE lane = 'scoring'").fetchone()
    assert row == ((11, 7) if fault == "after_commit" else None)

    receipts = list((isolated_ledger.parent / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    assert len(receipts) == 1
    first, observed = [json.loads(line) for line in receipts[0].read_text().splitlines()]
    assert first["lane"] == "scoring" and first["provider"] == "anthropic"
    assert first["model"] == "claude-synthetic"
    assert (observed["input_tokens"], observed["output_tokens"]) == (11, 7)

    source = str(Path(__file__).resolve().parents[1] / "src")
    env = {"PATH": os.defpath, "HOME": str(isolated_ledger.parent), "JOBCTRL_DIR": str(isolated_ledger.parent),
           "PYTHONPATH": source + os.pathsep + os.environ.get("PYTHONPATH", ""), "LANGFUSE_DISABLE": "1"}
    check = subprocess.run(
        [sys.executable, "-c", "from jobctrl.llm import read_llm_spend; read_llm_spend()"],
        env=env, capture_output=True, text=True, check=False, timeout=15,
    )
    assert check.returncode != 0 and "SpendAccountingUnresolved" in check.stderr


def test_success_and_repeated_callback_commit_once(isolated_ledger):
    with bind_llm_lane("tailoring"):
        with llm_generation_span(model="claude-synthetic", messages=[], params={}) as record:
            record("", input_tokens=11, output_tokens=7)
            record("", input_tokens=11, output_tokens=7)
    assert accounting.read_llm_spend_by_lane()["tailoring"]["input_tokens"] == 11
    assert accounting.read_llm_spend()["output_tokens"] == 7


def test_active_receipt_does_not_serialize_other_provider_admission(isolated_ledger):
    receipt = SpendObservation(day="2026-01-01", lane="scoring", provider="anthropic", model="synthetic")
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            assert executor.submit(accounting.read_llm_spend).result(timeout=5)["input_tokens"] == 0
    finally:
        receipt.close(unresolved=False)


def test_complete_budget_snapshot_fences_new_receipt_until_ledger_read_finishes(monkeypatch, isolated_ledger):
    reading, release, attempted = Event(), Event(), Event()
    original_read = accounting._read_llm_spend

    def paused_read(day=None):
        reading.set()
        assert release.wait(5)
        return original_read(day)

    def create_receipt():
        attempted.set()
        return SpendObservation(day="2026-01-01", lane="scoring", provider="google", model="synthetic")

    monkeypatch.setattr(accounting, "_read_llm_spend", paused_read)
    with ThreadPoolExecutor(max_workers=2) as executor:
        snapshot = executor.submit(
            accounting.read_spend_budget_status, lane="scoring", daily_budget_usd=25,
            lane_token_limits={lane: 0 for lane in LLM_LANES}, require_complete=True,
        )
        receipt_future = None
        try:
            assert reading.wait(5)
            receipt_future = executor.submit(create_receipt)
            assert attempted.wait(5)
            with pytest.raises(FutureTimeoutError):
                receipt_future.result(timeout=0.1)
        finally:
            release.set()
        status = snapshot.result(timeout=5)
        assert (status.input_tokens, status.output_tokens, status.estimated_usd) == (0, 0, 0.0)
        assert receipt_future is not None
        receipt = receipt_future.result(timeout=5)
        try:
            with pytest.raises(SpendAccountingUnresolved):
                accounting.read_spend_budget_status(
                    lane="scoring", daily_budget_usd=25,
                    lane_token_limits={lane: 0 for lane in LLM_LANES}, require_complete=True,
                )
        finally:
            receipt.close(unresolved=False)


def test_provider_failure_remains_primary_when_accounting_fails(monkeypatch, isolated_ledger):
    primary = RuntimeError("synthetic provider failure")
    monkeypatch.setattr(accounting, "record_llm_spend", lambda **kwargs: (_ for _ in ()).throw(OSError("sink")))
    with bind_llm_lane("scoring"), pytest.raises(RuntimeError) as raised:
        with llm_generation_span(model="claude-synthetic", messages=[], params={}) as record:
            record("", input_tokens=11, output_tokens=7)
            raise primary
    assert raised.value is primary
    with pytest.raises(SpendAccountingUnresolved):
        accounting.read_llm_spend()


@pytest.mark.parametrize("counts", [(12, None), (None, 7), (0, None)])
@pytest.mark.parametrize("failure_kind", ["none", "provider", "cancel"])
def test_partial_usage_is_retained_without_writing_unknown_counts(isolated_ledger, counts, failure_kind):
    failure = None if failure_kind == "none" else (
        RuntimeError("provider") if failure_kind == "provider" else asyncio.CancelledError("cancel")
    )
    with bind_llm_lane("scoring"):
        if failure is None:
            with pytest.raises(SpendAccountingUnresolved):
                with llm_generation_span(model="gemini-synthetic", messages=[], params={}) as record:
                    record("", input_tokens=counts[0], output_tokens=counts[1])
                    record("", input_tokens=counts[0], output_tokens=counts[1])
        else:
            with pytest.raises(type(failure)) as raised:
                with llm_generation_span(model="gemini-synthetic", messages=[], params={}) as record:
                    record("", input_tokens=counts[0], output_tokens=counts[1])
                    record("", input_tokens=counts[0], output_tokens=counts[1])
                    raise failure
            assert raised.value is failure
    with sqlite3.connect(isolated_ledger) as raw:
        assert raw.execute("SELECT COUNT(*) FROM llm_spend").fetchone() == (0,)
    receipts = list((isolated_ledger.parent / ".jobctrl.db.llm-spend-pending").glob("*.jsonl"))
    assert len(receipts) == 1
    lines = receipts[0].read_text().splitlines()
    assert len(lines) == 2
    observed = json.loads(lines[1])
    assert (observed["input_tokens"], observed["output_tokens"]) == counts
    with pytest.raises(SpendAccountingUnresolved):
        accounting.read_llm_spend()


def test_abandoned_peer_between_preflight_and_receipt_blocks_dispatch(monkeypatch, isolated_ledger):
    peer = SpendObservation(day="2026-01-01", lane="tailoring", provider="anthropic", model="synthetic")
    checked, proceed, dispatched = Event(), Event(), Event()
    original_preflight = accounting.enforce_spend_budget

    def preflight(lane):
        original_preflight(lane)
        checked.set()
        assert proceed.wait(5)

    monkeypatch.setattr(accounting, "enforce_spend_budget", preflight)

    def call():
        with bind_llm_lane("scoring"):
            with llm_generation_span(model="claude-synthetic", messages=[], params={}):
                dispatched.set()

    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(call)
        try:
            assert checked.wait(5)
            peer.close(unresolved=True)
        finally:
            proceed.set()
        with pytest.raises(SpendAccountingUnresolved):
            pending.result(timeout=5)
    assert not dispatched.is_set()


def test_in_flight_peer_remains_admissible(isolated_ledger):
    peer = SpendObservation(day="2026-01-01", lane="tailoring", provider="anthropic", model="synthetic")
    try:
        with bind_llm_lane("scoring"):
            with llm_generation_span(model="claude-synthetic", messages=[], params={}):
                pass
    finally:
        peer.close(unresolved=False)


def test_peer_failure_unlock_is_published_before_gate_reopens(monkeypatch, isolated_ledger):
    from jobctrl.infrastructure.llm import spend_observation

    peer = SpendObservation(day="2026-01-01", lane="tailoring", provider="anthropic", model="synthetic")
    closing, release, started = Event(), Event(), Event()
    original_close = spend_observation.os.close

    def delayed_close(fd):
        if fd == peer._fd:
            closing.set()
            assert release.wait(5)
        return original_close(fd)

    monkeypatch.setattr(spend_observation.os, "close", delayed_close)

    def admit():
        started.set()
        try:
            observation = SpendObservation(day="2026-01-01", lane="scoring", provider="google", model="synthetic")
        except SpendAccountingUnresolved:
            return "blocked"
        observation.close(unresolved=False)
        return "admitted"

    with ThreadPoolExecutor(max_workers=2) as executor:
        closing_peer = executor.submit(peer.close, unresolved=True)
        try:
            assert closing.wait(5)
            contender = executor.submit(admit)
            assert started.wait(5)
            with pytest.raises(FutureTimeoutError):
                contender.result(timeout=0.2)
        finally:
            release.set()
        closing_peer.result(timeout=5)
        assert contender.result(timeout=5) == "blocked"
