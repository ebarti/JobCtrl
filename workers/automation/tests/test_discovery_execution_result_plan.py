"""Plan fingerprints fence the exact execution at independent SQLite writers."""

import json
import sqlite3

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.errors import ConfigurationError
from jobctrl.infrastructure.discovery.execution_result_plan import (
    check_result_plan, freeze_result_plan, load_result_plan,
)
from jobctrl.infrastructure.discovery.result_budget import DiscoveryResultBudget
from tests.test_discovery_result_budget import EXECUTION, SOURCE, claim, prepared


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "owned-plan.db"
    connection = init_db(path)
    yield connection
    close_connection(path)


def test_retry_keeps_first_operational_plan_fingerprint(conn):
    first = freeze_result_plan(conn, EXECUTION, limit=3, source_limits={SOURCE: 1})
    again = freeze_result_plan(conn, EXECUTION, limit=3, source_limits={SOURCE: 3, "workday:new": 3})
    assert again == first
    assert again["source_result_limits"] == {SOURCE: 1}
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 1
    assert set(first) == {"decoder_version", "evidence_kind", "discovery_workflow_id", "discovery_run_id",
                          "tenant_id", "bounded", "limit", "source_result_limits", "fingerprint"}
    assert not conn.in_transaction


@pytest.mark.parametrize("limit,sources", [(2, {SOURCE: 1}), (1, {SOURCE: 2}), (1, {"workday:foreign": 1})])
def test_independent_canonical_writer_cannot_change_recorded_cap_or_sources(conn, limit, sources):
    freeze_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1})
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    with sqlite3.connect(path, timeout=5) as independent:
        independent.row_factory = sqlite3.Row
        independent.execute("PRAGMA foreign_keys=ON")
        allowance = DiscoveryResultBudget(independent, EXECUTION, limit=limit, start_count=0, source_limits=sources)
        # Keep the repository's source valid for this forged caller; the marker
        # must reject the different complete plan under the canonical writer lock.
        parts = list(prepared(independent, allowance)) if SOURCE in sources else None
        if parts is None:
            from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
            from dataclasses import replace
            valid = DiscoveryResultBudget(independent, EXECUTION, limit=1, start_count=0, source_limits={SOURCE: 1})
            parts = list(prepared(independent, valid))
            parts[0] = SqliteJobRepository(
                independent, discovery_execution=EXECUTION, source_family="workday", result_budget=allowance,
                result_budget_source_id="workday:foreign",
            )
            parts[-1] = replace(parts[-1], source_id="workday:foreign")
        with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
            claim(parts)
        assert not independent.in_transaction
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 1
    valid = DiscoveryResultBudget(conn, EXECUTION, limit=1, start_count=0, source_limits={SOURCE: 1})
    assert claim(prepared(conn, valid)) is None


@pytest.mark.parametrize("bounded,limit,sources", [(False, 0, {}), (True, 2, {SOURCE: 1})])
def test_recorded_bounded_plan_cannot_be_rebound(conn, bounded, limit, sources):
    original = freeze_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1})
    with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
        freeze_result_plan(conn, EXECUTION, limit=limit, source_limits=sources, bounded=bounded)
    assert load_result_plan(conn, EXECUTION) == original


def test_new_unbounded_plan_is_deliberate_and_cannot_become_bounded(conn):
    freeze_result_plan(conn, EXECUTION, limit=0, source_limits={}, bounded=False)
    check_result_plan(conn, EXECUTION, limit=0, source_limits={}, bounded=False)
    with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
        freeze_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1})


@pytest.mark.parametrize("damage", ["fingerprint", "decoder_version", "scope"])
def test_damaged_plan_fails_closed_without_canonical_effects(conn, damage):
    freeze_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1})
    raw = json.loads(conn.execute("SELECT payload_json FROM job_events").fetchone()[0])
    if damage == "decoder_version":
        raw[damage] = True
    elif damage == "scope":
        raw["discovery_run_id"] = "foreign-run"
    else:
        raw[damage] = "damaged"
    conn.execute("UPDATE job_events SET payload_json=?", (json.dumps(raw),))
    conn.commit()
    allowance = DiscoveryResultBudget(conn, EXECUTION, limit=1, start_count=0, source_limits={SOURCE: 1})
    with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
        claim(prepared(conn, allowance))
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_plan_append_failure_preserves_caller_transaction(conn, monkeypatch):
    conn.execute("CREATE TABLE owned_pending(value TEXT)")
    conn.commit()
    conn.execute("INSERT INTO owned_pending VALUES ('keep pending')")
    monkeypatch.setattr("jobctrl.state.record_job_event", lambda *a, **k: None)
    with pytest.raises(RuntimeError, match="not persisted exactly once"):
        freeze_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1})
    assert conn.in_transaction
    assert conn.execute("SELECT * FROM owned_pending").fetchone()[0] == "keep pending"
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    conn.rollback()


def test_marker_disappearance_after_preflight_is_rechecked_by_independent_writer(conn):
    freeze_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1})
    allowance = DiscoveryResultBudget(conn, EXECUTION, limit=1, start_count=0, source_limits={SOURCE: 1})
    check_result_plan(conn, EXECUTION, limit=1, source_limits={SOURCE: 1}, bounded=True)
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    with sqlite3.connect(path) as independent:
        independent.execute("DELETE FROM job_events WHERE event_type='DiscoveryResultPlanFrozen'")
    with pytest.raises(ConfigurationError, match="Restart Discovery after upgrading"):
        claim(prepared(conn, allowance))
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert not conn.in_transaction
