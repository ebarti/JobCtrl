"""Recorded failures recover through DNS checks, never through a guard bypass."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
import socket

import pytest

from jobctrl.database import init_db
from jobctrl.domain.enrichment.aggregate import JobEnrichment
from jobctrl.domain.enrichment.value_objects import EnrichmentError, ExtractionTier
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment.sqlite_repository import SqliteEnrichmentRepository
from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind as Kind
from jobctrl.infrastructure.network.url_safety import PublicUrlDecision, validate_public_http_url
from jobctrl.pipeline import automatic_preparation
from jobctrl.pipeline import public_fetch_recovery as recovery
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

_OLD = "2026-09-01T10:00:00+00:00"
_NOW = datetime(2026, 9, 7, 17, tzinfo=timezone.utc)
_DNS_MESSAGE = "URL host resolves to a non-public address: 192.0.0.88"
_REQUEST = "https://signin.example.test/button?private=value"


@pytest.fixture
def conn(tmp_path):
    connection = init_db(tmp_path / "fetch-recovery.db")
    yield connection
    connection.close()


def _seed(conn, *, number=1, attempts=1, message=_DNS_MESSAGE, request_url=_REQUEST, typed=False):
    job_id = canonical_job_id(f"f0000000-0000-4000-8000-{number:012d}")
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('local', ?, ?, 'Role', 'fixture', ?)",
        (str(job_id), f"https://jobs.example.test/{number}", _OLD),
    )
    ensure_job_stage_rows(conn, job_id, discovered_at=_OLD)
    aggregate = JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=job_id, updated_at=_OLD)
    for _ in range(attempts):
        aggregate = aggregate.start_attempt(extraction_tier=ExtractionTier.CSS_SELECTORS, started_at=_OLD)
        aggregate = aggregate.fail_attempt(
            error=EnrichmentError(code="DETAIL_UNSAFE_URL", message=message, retryable=False), finished_at=_OLD,
        )
    SqliteEnrichmentRepository(conn).save(aggregate)
    failure = {"kind": "dns_non_public", "requestUrl": request_url, "requestHost": "signin.example.test", "observedAt": _OLD}
    set_stage_state(
        conn, job_id, "enrich", "failed", attempt_count=attempts, finished_at=_OLD,
        error_code="DETAIL_UNSAFE_URL", error_message=message, retryable=False,
        metadata={"fetchFailure": failure} if typed else None, validate_transition=False,
    )
    record_job_event(
        conn, job_id, "enrich", "StageFailed", occurred_at=_OLD, message=message,
        payload={"errorCode": "DETAIL_UNSAFE_URL", "errorMessage": message, "retryable": False,
                 "attemptNumber": attempts, "securityOutcome": "unsafe_url", "blockedUrl": request_url,
                 **({"fetchFailure": failure} if typed else {})},
    )
    conn.commit()
    return job_id


def _stage(conn, job_id):
    return dict(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='enrich'", (str(job_id),)).fetchone())


async def _public(_urls):
    return PublicUrlDecision(True), PublicUrlDecision(True)


@pytest.mark.parametrize("typed", [False, True])
def test_resolved_failure_becomes_eligible_and_keeps_immutable_attempt_and_failure_history(conn, typed):
    job_id = _seed(conn, typed=typed)
    before = conn.execute("SELECT * FROM job_enrichments WHERE job_id=?", (str(job_id),)).fetchone()
    old_event = conn.execute("SELECT * FROM job_events WHERE job_id=? AND event_type='StageFailed'", (str(job_id),)).fetchone()

    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=_public)) == 1
    stage = _stage(conn, job_id)
    assert stage["state"] == "pending" and stage["retryable"] == 1 and stage["attempt_count"] == 1
    assert tuple(conn.execute("SELECT * FROM job_enrichments WHERE job_id=?", (str(job_id),)).fetchone()) == tuple(before)
    assert tuple(conn.execute("SELECT * FROM job_events WHERE job_id=? AND event_type='StageFailed'", (str(job_id),)).fetchone()) == tuple(old_event)
    report = json.loads(stage["metadata_json"])
    assert report["fetchFailure"]["kind"] == "dns_non_public"
    assert report["fetchRecovery"]["status"] == "retry_ready"
    candidates = automatic_preparation._candidates(conn, min_score=7)["enrich"]
    assert len(candidates) == 1 and automatic_preparation._retry_due(candidates[0], _NOW)
    audits = [json.loads(row[0]) for row in conn.execute("SELECT payload_json FROM job_events WHERE event_type='EnrichmentFetchRechecked'")]
    assert len(audits) == 1 and audits[0]["requestHost"] == "signin.example.test"
    assert "private=value" not in json.dumps(audits)


def test_legacy_native_timeout_is_reclassified_and_still_needs_two_public_destinations(conn):
    job_id = _seed(conn, attempts=4, message="<urlopen error [Errno 60] Operation timed out>")
    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=_public)) == 1
    stage = _stage(conn, job_id)
    assert stage["attempt_count"] == 4
    assert json.loads(stage["metadata_json"])["fetchFailure"]["kind"] == "timeout"


@pytest.mark.parametrize("blocked_index", [0, 1])
def test_both_current_destinations_must_be_public(conn, blocked_index):
    job_id = _seed(conn)

    async def check(_urls):
        values = [PublicUrlDecision(True), PublicUrlDecision(True)]
        values[blocked_index] = PublicUrlDecision(False, "non-public DNS", Kind.DNS_NON_PUBLIC)
        return tuple(values)

    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=check)) == 0
    stage = _stage(conn, job_id)
    assert stage["state"] == "failed" and stage["retryable"] == 0
    assert json.loads(stage["metadata_json"])["fetchRecovery"]["status"] == "waiting"


def test_dns_rechecks_have_a_durable_backoff_and_limit_without_consuming_attempts(conn):
    job_id = _seed(conn)
    calls = []

    async def blocked(urls):
        calls.append(urls)
        return PublicUrlDecision(True), PublicUrlDecision(False, "non-public DNS", Kind.DNS_NON_PUBLIC)

    now = _NOW
    for number in range(1, 6):
        assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=now, checker=blocked)) == 0
        assert len(calls) == number
        report = json.loads(_stage(conn, job_id)["metadata_json"])["fetchRecovery"]
        assert report["checkCount"] == number
        assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=now, checker=blocked)) == 0
        assert len(calls) == number
        if number < 5:
            now = datetime.fromisoformat(report["nextCheckAt"])
    assert report["status"] == "checks_exhausted" and report["nextCheckAt"] is None
    assert _stage(conn, job_id)["attempt_count"] == 1
    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=now + timedelta(days=2), checker=_public)) == 0


@pytest.mark.parametrize("state", ["canceled", "blocked", "exhausted", "running", "queued", "succeeded"])
def test_stopped_or_owned_stage_is_not_rechecked(conn, state):
    job_id = _seed(conn)
    conn.execute("UPDATE job_stage_states SET state=? WHERE job_id=? AND stage='enrich'", (state, str(job_id)))
    conn.commit()

    async def unexpected(_urls):
        pytest.fail("stopped or owned work must not even perform DNS checks")

    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=unexpected)) == 0
    assert _stage(conn, job_id)["state"] == state


@pytest.mark.parametrize("mutation", ["budget", "deleted", "closed", "other_tenant", "missing_event", "newer_stop", "unknown_error", "mismatched_attempt"])
def test_recovery_requires_current_positive_evidence_and_eligibility(conn, mutation):
    job_id = _seed(conn)
    if mutation == "budget":
        conn.execute("UPDATE job_stage_states SET max_attempts=1 WHERE job_id=? AND stage='enrich'", (str(job_id),))
    elif mutation == "deleted":
        conn.execute("INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES ('local', ?, ?)", (str(job_id), _OLD))
    elif mutation == "closed":
        # Use the existing canonical snapshot fixture shape from the database contract.
        conn.execute("INSERT INTO posting_snapshot_sets (tenant_id, job_id, latest_active_state, snapshot_set_json, updated_at) VALUES ('local', ?, 'closed', '{}', ?)", (str(job_id), _OLD))
    elif mutation == "other_tenant":
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) "
            "SELECT 'other', job_id, url, title, site, discovered_at FROM jobs WHERE job_id=?",
            (str(job_id),),
        )
        conn.execute("UPDATE job_stage_states SET tenant_id='other' WHERE job_id=? AND stage='enrich'", (str(job_id),))
    elif mutation == "missing_event":
        conn.execute("DELETE FROM job_events WHERE job_id=?", (str(job_id),))
    elif mutation == "newer_stop":
        record_job_event(conn, job_id, "enrich", "StageCanceled", message="Canceled by user")
    elif mutation == "unknown_error":
        conn.execute("UPDATE job_stage_states SET error_message='unknown unsafe request' WHERE job_id=? AND stage='enrich'", (str(job_id),))
    elif mutation == "mismatched_attempt":
        conn.execute("UPDATE job_stage_states SET attempt_count=2 WHERE job_id=? AND stage='enrich'", (str(job_id),))
    conn.commit()
    before = _stage(conn, job_id)

    async def unexpected(_urls):
        pytest.fail("ineligible failure must not perform DNS checks")

    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=unexpected)) == 0
    assert _stage(conn, job_id) == before


@pytest.mark.parametrize("target", ["http://127.0.0.1/private", "http://0177.0.0.1/private", "file:///etc/passwd", "https://user:password@jobs.example.test/role"])
def test_a_legacy_error_string_cannot_admit_an_unsafe_target(conn, target):
    _seed(conn, request_url=target)

    async def unexpected(_urls):
        pytest.fail("unsafe target must be rejected before DNS")

    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=unexpected)) == 0


@pytest.mark.parametrize("change", ["cancel", "delete", "new_attempt", "new_url", "unversioned_metadata"])
def test_recheck_cannot_overwrite_a_change_that_happens_while_dns_is_running(conn, change):
    job_id = _seed(conn)

    async def race(_urls):
        if change == "cancel":
            set_stage_state(conn, job_id, "enrich", "canceled", validate_transition=False)
        elif change == "delete":
            conn.execute("INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES ('local', ?, ?)", (str(job_id), _OLD))
        elif change == "new_attempt":
            conn.execute("UPDATE job_stage_states SET attempt_count=2 WHERE job_id=? AND stage='enrich'", (str(job_id),))
        elif change == "new_url":
            conn.execute("UPDATE jobs SET url='https://replacement.example.test/role' WHERE job_id=?", (str(job_id),))
        else:
            conn.execute("UPDATE job_stage_states SET metadata_json='{\"newOwner\":true}' WHERE job_id=? AND stage='enrich'", (str(job_id),))
        conn.commit()
        return PublicUrlDecision(True), PublicUrlDecision(True)

    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=race)) == 0
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='StageReset'").fetchone()[0] == 0


def test_two_reconcilers_release_one_failure_once(conn):
    _seed(conn)

    async def run():
        barrier = asyncio.Event()
        arrived = 0

        async def overlap(_urls):
            nonlocal arrived
            arrived += 1
            if arrived == 2:
                barrier.set()
            await barrier.wait()
            return PublicUrlDecision(True), PublicUrlDecision(True)

        return await asyncio.gather(*(recovery.reconcile_public_fetch_failures(conn, now=_NOW, checker=overlap) for _ in range(2)))

    assert sorted(asyncio.run(run())) == [0, 1]
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='StageReset'").fetchone()[0] == 1


def test_default_recheck_performs_dns_only_and_actual_fetch_revalidates_after_rebinding(conn, monkeypatch):
    _seed(conn)
    lookups = []

    def resolver(host, port, **_kwargs):
        lookups.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", port))]

    monkeypatch.setattr(socket, "getaddrinfo", resolver)
    assert asyncio.run(recovery.reconcile_public_fetch_failures(conn, now=_NOW)) == 1
    assert lookups == ["jobs.example.test", "signin.example.test"]
    # The DNS-only result is never cached as permission to contact the target.
    monkeypatch.setattr(socket, "getaddrinfo", lambda _host, port, **_: [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", port))])
    assert not validate_public_http_url(_REQUEST).allowed
