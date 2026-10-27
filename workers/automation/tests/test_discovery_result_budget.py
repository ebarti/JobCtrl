"""Atomic new-job allowances through canonical intake and archived recovery."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import sqlite3
import threading

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery import AtsKind, CanonicalJobIdentity, JobSourceObservation
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.ports.discovery import CanonicalOwnerMatch
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.capture_recovery import recover_captured_postings
from jobctrl.infrastructure.discovery.result_budget import DiscoveryResultBudget, DiscoveryResultLimitReached
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from tests.test_captured_posting_recovery import capture
from tests.test_discovery_identity import _job

SOURCE = "jobspy:indeed"
EXECUTION = DiscoveryExecutionRef("local", "owned-discovery-budget", "owned-budget-run")


@pytest.fixture
def owned(tmp_path):
    path = tmp_path / "budget.db"
    conn = init_db(path)
    yield conn
    close_connection(path)


def budget(conn, *, limit=1, start_count=0):
    return DiscoveryResultBudget(conn, EXECUTION, limit=limit, start_count=start_count, source_limits={SOURCE: limit})


def prepared(conn, allowance, key="candidate"):
    repo = SqliteJobRepository(
        conn,
        discovery_execution=EXECUTION,
        source_family="jobspy",
        result_budget=allowance,
        result_budget_source_id=SOURCE,
    )
    job = _job(f"https://example.test/jobs/{key}")
    identity = CanonicalJobIdentity(job.posting_url.value, AtsKind.OTHER, key, 1.0)
    observation = JobSourceObservation(
        f"obs-{key}", SOURCE, key, job.posting_url.value, "owned-source-run", "2026-01-01T00:00:00Z"
    )
    return repo, job, identity, observation


def claim(parts):
    repo, job, identity, observation = parts
    return repo.claim_new_job(job, identity, observation)


def totals(conn):
    return tuple(
        conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in ("jobs", "job_locators", "job_events")
    )


@pytest.mark.parametrize("failure", [DiscoveryResultLimitReached, sqlite3.IntegrityError])
def test_receipt_failure_rolls_back_job_locator_and_receipt(owned, monkeypatch, failure):
    parts = prepared(owned, budget(owned))

    def fail(*args, **kwargs):
        raise failure("owned receipt refusal")

    monkeypatch.setattr("jobctrl.state.record_job_event", fail)
    with pytest.raises(failure, match="owned receipt refusal"):
        claim(parts)
    assert totals(owned) == (0, 0, 0)
    assert not owned.in_transaction


@pytest.mark.parametrize("suppression", ["missing", "conflict"])
def test_suppressed_or_conflicting_receipt_cannot_publish_a_job(owned, monkeypatch, suppression):
    from jobctrl import state

    real = state.record_job_event
    parts = prepared(owned, budget(owned))

    def suppressed(*args, **kwargs):
        if suppression == "conflict":
            kwargs["payload"] = {"discovery_workflow_id": "foreign", "discovery_run_id": "foreign"}
            real(*args, **kwargs)

    monkeypatch.setattr(state, "record_job_event", suppressed)
    with pytest.raises(RuntimeError, match="not persisted exactly once"):
        claim(parts)
    assert totals(owned) == (0, 0, 0)


@pytest.mark.parametrize("caller_transaction", [False, True])
def test_later_attachment_failure_rolls_back_receipt_and_preserves_caller(owned, monkeypatch, caller_transaction):
    allowance = budget(owned)
    parts = prepared(owned, allowance)
    owned.execute("CREATE TABLE owned_marker(value TEXT)")
    owned.commit()
    if caller_transaction:
        owned.execute("INSERT INTO owned_marker VALUES ('pending owner write')")

    def fail(*args, **kwargs):
        assert allowance.counts() == {SOURCE: 1}
        raise RuntimeError("owned late identity failure")

    monkeypatch.setattr(parts[0], "_attach_source_observation", fail)
    with pytest.raises(RuntimeError, match="owned late identity failure"):
        claim(parts)
    assert totals(owned) == (0, 0, 0)
    assert owned.in_transaction is caller_transaction
    assert owned.execute("SELECT COUNT(*) FROM owned_marker").fetchone()[0] == int(caller_transaction)
    owned.rollback()


@pytest.mark.parametrize("caller_transaction", [False, True])
def test_late_canonical_winner_consumes_zero_allowance(owned, monkeypatch, caller_transaction):
    winner = _job("https://example.test/jobs/winner")
    SqliteJobRepository(owned).save(winner)
    allowance = budget(owned, start_count=1)
    parts = prepared(owned, allowance)
    if caller_transaction:
        owned.execute("BEGIN")
    monkeypatch.setattr(
        parts[0], "_attach_source_observation", lambda *a: CanonicalOwnerMatch(winner.job_id, "source_native_id_match")
    )
    result = claim(parts)
    assert result.job_id == winner.job_id
    assert totals(owned) == (1, 1, 0)
    assert allowance.counts() == {SOURCE: 0}
    assert owned.in_transaction is caller_transaction
    owned.rollback()


def test_existing_canonical_owner_does_not_consume_more_allowance(owned):
    allowance = budget(owned)
    parts = prepared(owned, allowance)
    assert claim(parts) is None
    assert claim(parts).job_id == parts[1].job_id
    assert totals(owned) == (1, 1, 1)
    assert allowance.counts() == {SOURCE: 1}


def test_foreign_tenant_cannot_use_local_budget(owned):
    parts = list(prepared(owned, budget(owned)))
    parts[1] = replace(parts[1], tenant_id=TenantId("foreign"))
    with pytest.raises(ValueError, match="tenant does not match"):
        claim(parts)
    assert totals(owned) == (0, 0, 0)


def test_unrelated_insert_does_not_consume_execution_allowance(owned):
    allowance = budget(owned)
    SqliteJobRepository(owned).save(_job("https://example.test/jobs/unrelated"))
    assert not allowance.run_exhausted()
    assert claim(prepared(owned, allowance)) is None
    assert allowance.counts() == {SOURCE: 1}


def test_literal_zero_budget_refuses_new_canonical_job(owned):
    allowance = budget(owned, limit=0)
    assert allowance.run_exhausted()
    with pytest.raises(DiscoveryResultLimitReached):
        claim(prepared(owned, allowance))
    assert totals(owned) == (0, 0, 0)


def test_malformed_owned_receipt_fails_closed_and_foreign_run_does_not_consume(owned):
    allowance = budget(owned)
    assert claim(prepared(owned, allowance)) is None
    row = owned.execute("SELECT payload_json FROM job_events").fetchone()
    payload = json.loads(row[0])
    payload["decoder_version"] = True
    owned.execute("UPDATE job_events SET payload_json=?", (json.dumps(payload),))
    owned.commit()
    with pytest.raises(ValueError, match="invalid recorded"):
        allowance.counts()
    other = DiscoveryResultBudget(
        owned,
        DiscoveryExecutionRef("local", EXECUTION.workflow_id, "different-run"),
        limit=1,
        start_count=1,
        source_limits={SOURCE: 1},
    )
    assert other.counts() == {SOURCE: 0} and not other.run_exhausted()


@pytest.mark.parametrize("recovered_first", [False, True])
def test_independent_writers_share_the_last_allowance(owned, recovered_first):
    path = owned.execute("PRAGMA database_list").fetchone()[2]
    if recovered_first:
        capture(owned, "archived", source=SOURCE)
    barrier = threading.Barrier(2)

    def compete(index):
        conn = sqlite3.connect(path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            allowance = budget(conn)
            parts = prepared(conn, allowance, f"concurrent-{index}")
            barrier.wait(timeout=5)
            try:
                if recovered_first and index == 0:
                    return recover_captured_postings(
                        conn,
                        tenant_id="local",
                        source_ids=(SOURCE,),
                        source_family="jobspy",
                        search_cfg={},
                        run_id="owned-recovery",
                        discovery_execution=EXECUTION,
                        result_budget=allowance,
                    )["new"]
                return int(claim(parts) is None)
            except DiscoveryResultLimitReached:
                return 0
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(compete, index) for index in range(2)]
        assert sum(future.result(timeout=15) for future in futures) == 1
    assert totals(owned)[:2] == (1, 1)
    assert budget(owned).counts() == {SOURCE: 1}
    assert owned.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("phase", ["after_unit_receipt", "after_membership"])
@pytest.mark.parametrize("caller_transaction", [False, True])
def test_lineage_failure_cannot_commit_any_admission(owned, monkeypatch, phase, caller_transaction):
    from jobctrl.infrastructure.discovery.sqlite_execution_repository import SqliteDiscoveryExecutionRepository
    from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import SqliteDiscoverySearchUnitRepository
    from tests.test_discovery_search_unit_identity import _spec

    search = SqliteDiscoverySearchUnitRepository(owned)
    search.plan_units(EXECUTION, [_spec()])
    lease = search.claim_next(EXECUTION, "owned-current-attempt", 1)
    allowance = budget(owned)
    parts = list(prepared(owned, allowance))
    parts[0] = SqliteJobRepository(
        owned,
        discovery_execution=EXECUTION,
        source_family="jobspy",
        search_unit_lease=lease,
        result_budget=allowance,
        result_budget_source_id=SOURCE,
    )
    owned.execute("CREATE TABLE owned_pending(value TEXT)")
    owned.commit()
    if caller_transaction:
        owned.execute("INSERT INTO owned_pending VALUES ('keep pending')")
    if phase == "after_unit_receipt":
        original = SqliteDiscoverySearchUnitRepository.record_accepted_job

        def fail(repo, *args, **kwargs):
            original(repo, *args, **kwargs)
            assert owned.in_transaction
            assert search.execution_counts(EXECUTION)["new"] == 1
            raise RuntimeError("owned lineage failure")

        monkeypatch.setattr(SqliteDiscoverySearchUnitRepository, "record_accepted_job", fail)
    else:
        original = SqliteDiscoveryExecutionRepository.link_job

        def fail(repo, *args, **kwargs):
            original(repo, *args, **kwargs)
            assert owned.in_transaction
            assert owned.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 1
            raise RuntimeError("owned lineage failure")

        monkeypatch.setattr(SqliteDiscoveryExecutionRepository, "link_job", fail)
    with pytest.raises(RuntimeError, match="owned lineage failure"):
        claim(parts)
    assert totals(owned) == (0, 0, 0)
    assert search.execution_counts(EXECUTION) == {"accepted": 0, "new": 0, "existing": 0}
    assert owned.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 0
    assert owned.in_transaction is caller_transaction
    assert owned.execute("SELECT COUNT(*) FROM owned_pending").fetchone()[0] == int(caller_transaction)
    owned.rollback()
