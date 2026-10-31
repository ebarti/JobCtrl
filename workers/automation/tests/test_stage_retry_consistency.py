"""Equivalent retries share one transaction, attempt policy, and material reset."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3

import pytest
from typer.testing import CliRunner

from jobctrl.database import init_db
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.rpc import enrichment_retry
from jobctrl.pipeline.retry import reset_retry_stages
from jobctrl.state import OptimisticLockError, reset_job_stage, set_stage_state
from tests.rpc_contract_probe import build_server

JOB = "00000000-0000-4000-8000-000000001008"
PEER = "00000000-0000-4000-8000-000000001009"
URL = "https://example.test/retry"
SQL = Path(__file__).with_name("fixtures") / "enrichment_retry.sql"


@pytest.fixture
def conn(tmp_path):
    connection = init_db(tmp_path / "jobctrl.db")
    connection.executescript(SQL.read_text())
    accepted_file = tmp_path / "accepted.txt"
    accepted_file.write_text("Accepted synthetic bytes", encoding="utf8")
    connection.execute(
        "UPDATE job_materials_artifacts SET path=? WHERE tenant_id='local' AND job_id=? AND artifact_id='synthetic-accepted'",
        (str(accepted_file), JOB),
    )
    connection.execute(
        "INSERT INTO artifact_line_anchors VALUES ('local','resume','synthetic-accepted',1,'line-1',"
        "'[]','[]','retain','synthetic provenance',NULL)"
    )
    connection.commit()
    yield connection
    connection.close()


def _seed_stage(conn, stage: str, state: str):
    count = 5 if state == "exhausted" else 2
    conn.execute(
        "INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,"
        "started_at,finished_at,duration_ms,error_code,error_message,retryable,blocked_by_json,next_action,metadata_json,version) "
        "VALUES ('local',?,?,?, ?,5,'2026-01-01','start','finish',1,'FAILED','synthetic',1,'[\"score\"]','retry',?,7)",
        (JOB, stage, state, count, '{"activityOwner":"old-owner"}'),
    )
    if stage == "tailor":
        conn.execute(
            "INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) "
            "VALUES ('local',?,2,'resume_in_progress','2026-01-01','2026-01-01')", (JOB,),
        )
        generation, artifact = 2, "tailored_resume"
    else:
        generation, artifact = 1, "cover_letter"
    conn.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
        "VALUES ('local',?,?,?,?, 'rejected','synthetic-rejected.txt','text','2026-01-01')",
        (JOB, generation, artifact, f"rejected-{stage}"),
    )
    conn.commit()


def _rows(conn, table):
    return [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]


@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.parametrize("entry", ["direct", "cli", "service", "rpc"])
@pytest.mark.parametrize("state,reset_attempts,expected", [("failed", False, 2), ("failed", True, 0), ("exhausted", False, 0)])
def test_reset_aliases_preserve_budget_materials_and_fences(conn, monkeypatch, stage, entry, state, reset_attempts, expected):
    _seed_stage(conn, stage, state)
    accepted = conn.execute("SELECT * FROM job_materials_artifacts WHERE artifact_id='synthetic-accepted'").fetchone()
    provenance = _rows(conn, "artifact_line_anchors")
    review = _rows(conn, "application_review_decisions")
    accepted_file = Path(accepted["path"])

    if entry == "direct":
        reset = reset_job_stage(conn, URL, stage, reset_attempts=reset_attempts)
        assert reset == URL
        assert reset.retailor_required is (stage == "tailor")
    elif entry == "cli":
        from jobctrl import cli, database

        monkeypatch.setattr(cli, "_bootstrap", lambda: None)
        monkeypatch.setattr(database, "get_connection", lambda: conn)
        args = ["retry", stage, URL] + (["--reset-attempts"] if reset_attempts else [])
        result = CliRunner().invoke(cli.app, args)
        assert result.exit_code == 0, result.output
        assert ("Use explicit re-tailor" in result.output) is (stage == "tailor")
    elif entry == "service":
        reset = reset_retry_stages(conn, [(JOB, stage)], reset_attempts=reset_attempts)
        assert reset[0].get("retailorRequired", False) is (stage == "tailor")
    else:
        from jobctrl.domain.rpc.messages import JsonRpcRequest
        from jobctrl.pipeline.retry import retry_selection_fingerprint

        monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
        monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
        result = build_server().dispatch(JsonRpcRequest(method="reset_stages", id=1, params={
            "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
            "targets": [{"jobId": JOB, "stage": stage,
                         "expectedFingerprint": retry_selection_fingerprint(
                             conn, "local", JOB, stage, include_job_lifecycle=True,
                         )}], "resetAttempts": reset_attempts,
        }))
        assert result.error is None
        assert result.result["resets"][0].get("retailorRequired", False) is (stage == "tailor")

    row = conn.execute("SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage=?", (JOB, stage)).fetchone()
    assert (row["state"], row["attempt_count"], row["version"], row["retryable"]) == ("pending", expected, 8, 1)
    for column in ("started_at", "finished_at", "duration_ms", "error_code", "error_message", "next_action", "metadata_json"):
        assert row[column] is None
    assert json.loads(row["blocked_by_json"]) == []
    event = conn.execute("SELECT payload_json,message FROM job_events WHERE job_id=? AND stage=? AND event_type='StageReset'", (JOB, stage)).fetchone()
    assert json.loads(event[0])["reset_attempts"] is (reset_attempts or state == "exhausted")
    assert ("Use explicit re-tailor" in event[1]) is (stage == "tailor")
    assert tuple(conn.execute("SELECT * FROM job_materials_artifacts WHERE artifact_id='synthetic-accepted'").fetchone()) == tuple(accepted)
    assert _rows(conn, "artifact_line_anchors") == provenance
    assert _rows(conn, "application_review_decisions") == review
    assert accepted_file.read_text(encoding="utf8") == "Accepted synthetic bytes"
    assert conn.execute("SELECT 1 FROM job_materials_artifacts WHERE artifact_id=?", (f"rejected-{stage}",)).fetchone() is None
    with pytest.raises(OptimisticLockError):
        set_stage_state(conn, JOB, stage, "running", tenant_id=LOCAL_TENANT, expected_version=7)
    conn.rollback()


def test_cli_does_not_dispatch_a_plain_retry_when_retailor_is_required(conn, monkeypatch):
    from jobctrl import cli, database

    _seed_stage(conn, "tailor", "failed")
    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(cli, "_run_stage_command", lambda *_args, **_kwargs: pytest.fail("unexpected dispatch"))
    result = CliRunner().invoke(cli.app, ["retry", "tailor", URL, "--run"])
    assert result.exit_code == 0, result.output
    assert "Use explicit re-tailor" in result.output


@pytest.mark.parametrize("invalid", [None, 1, "false"])
def test_python_retry_rejects_non_boolean_options_without_writes(conn, invalid):
    _seed_stage(conn, "tailor", "failed")
    tables = ("job_materials", "job_materials_artifacts", "job_stage_states", "job_events")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(ValueError, match="retry options must be boolean"):
        reset_retry_stages(conn, [(JOB, "tailor")], reset_attempts=invalid)
    assert {table: _rows(conn, table) for table in tables} == before


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_reset_never_rewinds_older_generation_if_current_one_is_approved(conn, stage):
    _seed_stage(conn, stage, "failed")
    if stage == "tailor":
        conn.execute(
            "INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) "
            "VALUES ('local',?,3,'resume_approved','2026-01-01','2026-01-01')", (JOB,),
        )
        conn.execute(
            "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
            "VALUES ('local',?,3,'tailored_resume','resume-3','approved','synthetic.txt','text','2026-01-01')", (JOB,),
        )
    else:
        conn.execute(
            "INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) "
            "VALUES ('local',?,2,'complete','2026-01-01','2026-01-01')", (JOB,),
        )
        conn.execute(
            "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
            "VALUES ('local',?,2,'tailored_resume','resume-2','approved','synthetic.txt','text','2026-01-01'),"
            "('local',?,2,'cover_letter','cover-2','approved','synthetic.txt','text','2026-01-01')", (JOB, JOB),
        )
    conn.commit()
    before = _rows(conn, "job_materials"), _rows(conn, "job_materials_artifacts")
    reset = reset_job_stage(conn, URL, stage)
    assert reset.retailor_required
    assert (_rows(conn, "job_materials"), _rows(conn, "job_materials_artifacts")) == before


@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.parametrize("status", ["superseded", "suppressed"])
def test_reset_preserves_historical_material_records(conn, stage, status):
    _seed_stage(conn, stage, "failed")
    conn.execute("UPDATE job_materials_artifacts SET status=? WHERE artifact_id=?", (status, f"rejected-{stage}"))
    conn.commit()
    before = _rows(conn, "job_materials"), _rows(conn, "job_materials_artifacts")
    reset_job_stage(conn, URL, stage)
    assert (_rows(conn, "job_materials"), _rows(conn, "job_materials_artifacts")) == before


def test_cover_retry_targets_latest_approved_resume_and_retains_older_cover(conn):
    _seed_stage(conn, "cover", "failed")
    conn.execute("UPDATE job_materials_artifacts SET status='approved' WHERE artifact_id='rejected-cover'")
    conn.execute(
        "INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) "
        "VALUES ('local',?,2,'resume_approved','2026-01-01','2026-01-01')", (JOB,),
    )
    conn.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
        "VALUES ('local',?,2,'tailored_resume','resume-2','approved','synthetic.txt','text','2026-01-01'),"
        "('local',?,2,'cover_letter','rejected-cover-2','rejected','synthetic.txt','text','2026-01-01')", (JOB, JOB),
    )
    conn.commit()
    reset = reset_job_stage(conn, URL, "cover")
    assert not reset.retailor_required
    assert conn.execute("SELECT status FROM job_materials_artifacts WHERE artifact_id='rejected-cover'").fetchone()[0] == "approved"
    assert conn.execute("SELECT 1 FROM job_materials_artifacts WHERE artifact_id='rejected-cover-2'").fetchone() is None


def test_failed_non_enrichment_cohort_rolls_back_all_rows(conn):
    _seed_stage(conn, "tailor", "failed")
    conn.execute("CREATE TEMP TRIGGER fail_peer_reset BEFORE INSERT ON job_events "
                 "WHEN NEW.job_id='" + PEER + "' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    tables = ("job_materials", "job_materials_artifacts", "job_stage_states", "job_events", "artifact_line_anchors")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
        reset_retry_stages(conn, [(JOB, "tailor"), (PEER, "score")], only_failed=True)
    assert {table: _rows(conn, table) for table in tables} == before
    assert not conn.in_transaction


def test_deferred_caller_holds_writer_before_material_reset_reads(conn, monkeypatch):
    from jobctrl.pipeline import retry

    _seed_stage(conn, "tailor", "failed")
    peer = sqlite3.connect(conn.execute("PRAGMA database_list").fetchone()[2], timeout=0.01)
    original = retry.resolve_job_locator
    observations = []

    def resolve_under_lock(*args):
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            peer.execute("BEGIN IMMEDIATE")
        observations.append(True)
        return original(*args)

    monkeypatch.setattr(retry, "resolve_job_locator", resolve_under_lock)
    conn.execute("BEGIN")
    try:
        reset_retry_stages(conn, [(JOB, "tailor")])
        assert observations == [True] and conn.in_transaction
        conn.rollback()
    finally:
        if conn.in_transaction:
            conn.rollback()
        if peer.in_transaction:
            peer.rollback()
        peer.close()


@pytest.mark.parametrize("fingerprint", [None, "", "G" * 64, "0" * 63])
def test_bulk_rpc_requires_a_well_formed_observed_stage_identity(conn, monkeypatch, fingerprint):
    from jobctrl.domain.rpc.messages import JsonRpcRequest

    _seed_stage(conn, "tailor", "failed")
    monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
    monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
    tables = ("job_materials", "job_materials_artifacts", "job_stage_states", "job_events")
    before = {table: _rows(conn, table) for table in tables}
    target = {"jobId": JOB, "stage": "tailor"}
    if fingerprint is not None:
        target["expectedFingerprint"] = fingerprint
    response = build_server().dispatch(JsonRpcRequest(method="reset_stages", id=1, params={
        "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
        "targets": [target], "onlyFailed": True,
    }))
    assert response.error is not None
    assert response.error.data is None
    assert {table: _rows(conn, table) for table in tables} == before


def test_legacy_bulk_rpc_refuses_unbound_selection_without_mutating_cohort(conn, monkeypatch):
    from jobctrl.domain.rpc.messages import JsonRpcRequest

    _seed_stage(conn, "tailor", "failed")
    monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
    monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
    tables = ("job_materials", "job_materials_artifacts", "job_stage_states", "job_events")
    before = {table: _rows(conn, table) for table in tables}
    response = build_server().dispatch(JsonRpcRequest(method="reset_enrichment", id=1, params={
        "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
        "targets": [{"jobId": JOB, "stage": "enrich"}, {"jobId": JOB, "stage": "tailor"}],
        "onlyFailed": True,
    }))
    assert response.error is not None
    assert "lacks an ownership snapshot" in response.error.message
    assert {table: _rows(conn, table) for table in tables} == before


def test_current_single_rpc_requires_an_observed_identity(conn, monkeypatch):
    from jobctrl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest

    monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
    monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
    tables = ("job_materials", "job_materials_artifacts", "job_stage_states", "job_events")
    before = {table: _rows(conn, table) for table in tables}
    response = build_server().dispatch(JsonRpcRequest(method="reset_stages", id=1, params={
        "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
        "targets": [{"jobId": JOB, "stage": "enrich"}],
    }))
    assert response.error is not None and response.error.code == INVALID_PARAMS
    assert "lacks an ownership snapshot" in response.error.message
    assert {table: _rows(conn, table) for table in tables} == before


@pytest.mark.parametrize("method", ["reset_stages", "reset_enrichment"])
@pytest.mark.parametrize("change", ["owner", "removed"])
def test_stale_bulk_selection_has_structured_reason_only_on_current_rpc(conn, monkeypatch, method, change):
    from jobctrl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest
    from jobctrl.pipeline.retry import retry_selection_fingerprint

    monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
    monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
    targets = [
        {"jobId": job_id, "stage": stage,
         "expectedFingerprint": retry_selection_fingerprint(
             conn, "local", job_id, stage, include_job_lifecycle=method == "reset_stages",
         )}
        for job_id, stage in [(PEER, "score"), (JOB, "enrich")]
    ]
    if change == "owner":
        conn.execute("UPDATE job_stage_states SET metadata_json=? WHERE job_id=? AND stage='enrich'",
                     ('{\"activityOwner\":\"successor\"}', JOB))
    else:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?", (JOB,))
    conn.commit()
    tables = ("job_enrichments", "job_materials", "job_materials_artifacts", "job_stage_states", "job_events")
    before = {table: _rows(conn, table) for table in tables}
    response = build_server().dispatch(JsonRpcRequest(method=method, id=1, params={
        "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
        "targets": targets, "onlyFailed": True,
    }))
    assert response.error is not None
    assert response.error.code == INVALID_PARAMS
    assert response.error.message == "retry target changed; refresh and retry"
    assert response.error.data == ({"reason": "retry_selection_changed"} if method == "reset_stages" else None)
    assert {table: _rows(conn, table) for table in tables} == before


def test_retry_rejects_producer_reopen_with_unchanged_lifecycle_fields(conn, monkeypatch):
    from jobctrl.domain.enrichment import snapshot_use_case
    from jobctrl.domain.enrichment.snapshot_services import ContentAcquisitionResult
    from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
    from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState, QuarantineReason, SnapshotConfidence
    from jobctrl.domain.identifiers import canonical_job_id
    from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
    from jobctrl.pipeline.retry import RetrySelectionChanged, retry_selection_fingerprint

    now = "2026-01-01T00:00:00+00:00"
    monkeypatch.setattr(snapshot_use_case, "_utc_now", lambda: now)
    conn.execute("UPDATE job_stage_states SET retryable=1 WHERE job_id=? AND stage='enrich'", (JOB,))
    repo = SqlitePostingSnapshotSetRepository(conn)
    initial = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=canonical_job_id(JOB), updated_at=now)
    initial, _ = initial.mark_active_state(active_state=ActiveState.ACTIVE, verified_at=now)
    repo.save(initial)
    targets = [(PEER, "score"), (JOB, "enrich")]
    fingerprints = {
        (job_id, stage): retry_selection_fingerprint(conn, "local", job_id, stage, include_job_lifecycle=True)
        for job_id, stage in targets
    }
    lifecycle_sql = (
        "SELECT latest_active_state,latest_snapshot_version,updated_at FROM posting_snapshot_sets "
        "WHERE tenant_id='local' AND job_id=?"
    )
    lifecycle_before = tuple(conn.execute(lifecycle_sql, (JOB,)).fetchone())
    snapshot_before = conn.execute("SELECT snapshot_set_json FROM posting_snapshot_sets WHERE job_id=?", (JOB,)).fetchone()[0]

    class Acquisition:
        states = iter((ActiveState.CLOSED, ActiveState.ACTIVE))

        def acquire(self, **_kwargs):
            return ContentAcquisitionResult(
                ok=False, extraction_tier="synthetic", confidence=SnapshotConfidence.LOW,
                quarantine_reason=QuarantineReason.POSTING_INACTIVE, active_state=next(self.states),
                verification_method="synthetic", error_class="SYNTHETIC", error_message="synthetic failure",
            )

    use_case = snapshot_use_case.CapturePostingSnapshotUseCase(snapshot_repository=repo, acquisition_service=Acquisition())
    for state in (ActiveState.CLOSED, ActiveState.ACTIVE):
        outcome = use_case.execute(
            tenant_id=LOCAL_TENANT, job_id=canonical_job_id(JOB), url=URL, source_id="synthetic",
            promote_to_job_enrichment=False,
        )
        assert not outcome.ok and outcome.active_state_changed
        assert outcome.snapshot_set.latest_active_state is state
    assert tuple(conn.execute(lifecycle_sql, (JOB,)).fetchone()) == lifecycle_before
    assert conn.execute("SELECT snapshot_set_json FROM posting_snapshot_sets WHERE job_id=?", (JOB,)).fetchone()[0] != snapshot_before
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id=? AND event_type='JobActiveStateChanged'", (JOB,)).fetchone()[0] == 0

    tables = ("job_enrichments", "job_materials", "job_materials_artifacts", "job_stage_states", "job_events", "posting_snapshot_sets")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(RetrySelectionChanged):
        reset_retry_stages(
            conn, targets, only_failed=True, expected_fingerprints=fingerprints, require_selected_failed_stage=True,
        )
    assert {table: _rows(conn, table) for table in tables} == before
    assert not conn.in_transaction


def test_posting_state_receipt_shares_the_snapshot_transaction(conn):
    from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
    from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState
    from jobctrl.domain.identifiers import canonical_job_id
    from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository

    repo = SqlitePostingSnapshotSetRepository(conn)
    initial = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=canonical_job_id(JOB), updated_at="2026-01-01")
    repo.save(initial)
    before = _rows(conn, "posting_snapshot_sets"), _rows(conn, "job_events")
    repo.save(initial)
    assert (_rows(conn, "posting_snapshot_sets"), _rows(conn, "job_events")) == before

    closed, _ = initial.mark_active_state(active_state=ActiveState.CLOSED, verified_at="2026-01-01")
    conn.execute("BEGIN")
    repo.save(closed, commit=False)
    assert conn.in_transaction
    assert conn.execute("SELECT latest_active_state FROM posting_snapshot_sets WHERE job_id=?", (JOB,)).fetchone()[0] == "closed"
    assert len(_rows(conn, "job_events")) == len(before[1]) + 1
    conn.rollback()
    assert (_rows(conn, "posting_snapshot_sets"), _rows(conn, "job_events")) == before

    conn.execute(
        "CREATE TEMP TRIGGER reject_posting_receipt BEFORE INSERT ON job_events "
        "WHEN NEW.event_type='PostingSnapshotStatePersisted' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="synthetic receipt failure"):
        repo.save(closed)
    assert (_rows(conn, "posting_snapshot_sets"), _rows(conn, "job_events")) == before
    assert not conn.in_transaction


def test_discovery_tombstone_reversal_fences_retry_without_event_delivery(conn):
    from jobctrl.domain.identifiers import canonical_job_id
    from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
    from jobctrl.pipeline.retry import RetrySelectionChanged, retry_selection_fingerprint

    deleted_at, restored_at = "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"
    conn.execute(
        "INSERT INTO job_locators (tenant_id,job_id,locator_kind,locator_value,is_current,first_seen_at,last_seen_at) "
        "VALUES ('local',?,'posting_url',?,1,?,?)", (JOB, URL, deleted_at, deleted_at),
    )
    conn.execute(
        "INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at) VALUES ('local',?,?,?,?)",
        (JOB, deleted_at, "synthetic", restored_at),
    )
    conn.commit()
    targets = [(PEER, "score"), (JOB, "enrich")]
    fingerprints = {
        (job_id, stage): retry_selection_fingerprint(conn, "local", job_id, stage, include_job_lifecycle=True)
        for job_id, stage in targets
    }
    tombstone = tuple(conn.execute("SELECT * FROM jobctrl_deleted_jobs WHERE job_id=?", (JOB,)).fetchone())
    events = _rows(conn, "job_events")
    repo = SqliteJobRepository(conn)
    job = repo.load(LOCAL_TENANT, canonical_job_id(JOB))
    assert job is not None and not job.is_deleted
    # The discovery repository can save a stale Job aggregate and later
    # restore its tombstone before the best-effort publisher records events.
    repo.save(job.soft_delete(reason="synthetic", deleted_at=deleted_at))
    restored = repo.restore(LOCAL_TENANT, canonical_job_id(JOB), restored_at=restored_at)
    assert restored is not None and not restored.is_deleted
    assert tuple(conn.execute("SELECT * FROM jobctrl_deleted_jobs WHERE job_id=?", (JOB,)).fetchone()) == tombstone
    assert _rows(conn, "job_events") == events
    tables = ("job_enrichments", "job_stage_states", "job_events", "jobctrl_deleted_jobs", "job_lifecycle_revisions")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(RetrySelectionChanged):
        reset_retry_stages(
            conn, targets, only_failed=True, expected_fingerprints=fingerprints, require_selected_failed_stage=True,
        )
    assert {table: _rows(conn, table) for table in tables} == before


def test_deleted_and_reinserted_job_cannot_reuse_an_old_retry_identity(conn):
    from jobctrl.pipeline.retry import RetrySelectionChanged, retry_selection_fingerprint

    target = (PEER, "score")
    fingerprint = retry_selection_fingerprint(conn, "local", *target, include_job_lifecycle=True)
    job = tuple(conn.execute("SELECT tenant_id,job_id,url,title,discovered_at FROM jobs WHERE job_id=?", (PEER,)).fetchone())
    stage = tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='score'", (PEER,)).fetchone())
    events = _rows(conn, "job_events")
    conn.execute("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?", (PEER,))
    conn.execute("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES (?,?,?,?,?)", job)
    conn.execute("INSERT INTO job_stage_states VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", stage)
    conn.commit()
    assert tuple(conn.execute("SELECT * FROM job_stage_states WHERE job_id=? AND stage='score'", (PEER,)).fetchone()) == stage
    assert _rows(conn, "job_events") == events
    assert retry_selection_fingerprint(conn, "local", *target, include_job_lifecycle=True) != fingerprint
    tables = ("job_stage_states", "job_events", "job_lifecycle_revisions")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(RetrySelectionChanged):
        reset_retry_stages(conn, [target], expected_fingerprints={target: fingerprint}, require_selected_failed_stage=True)
    assert {table: _rows(conn, table) for table in tables} == before


def test_missing_job_lifecycle_revision_cannot_authorize_retry(conn):
    from jobctrl.pipeline.retry import RetrySelectionChanged, retry_selection_fingerprint

    target = (PEER, "score")
    fingerprint = retry_selection_fingerprint(conn, "local", *target, include_job_lifecycle=True)
    conn.execute("DELETE FROM job_lifecycle_revisions WHERE tenant_id='local' AND job_id=?", (PEER,))
    conn.commit()
    assert retry_selection_fingerprint(conn, "local", *target, include_job_lifecycle=True) is None
    with pytest.raises(RetrySelectionChanged):
        reset_retry_stages(conn, [target], expected_fingerprints={target: fingerprint}, require_selected_failed_stage=True)


def test_legacy_bulk_rpc_accepts_bound_selection_and_preserves_response_shape(conn, monkeypatch):
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from jobctrl.pipeline.retry import retry_selection_fingerprint

    _seed_stage(conn, "tailor", "failed")
    monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
    monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
    targets = [{"jobId": JOB, "stage": stage,
                "expectedFingerprint": retry_selection_fingerprint(conn, "local", JOB, stage)}
               for stage in ("enrich", "tailor")]
    response = build_server().dispatch(JsonRpcRequest(method="reset_enrichment", id=1, params={
        "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
        "targets": targets, "onlyFailed": True,
    }))
    assert response.error is None
    assert response.result["resets"] == [
        {"jobId": JOB, "jobUrl": URL, "stage": "enrich"},
        {"jobId": JOB, "jobUrl": URL, "stage": "tailor"},
    ]


@pytest.mark.parametrize("change", ["row", "event"])
def test_bulk_rechecks_retryability_and_rolls_back_the_cohort(conn, change):
    _seed_stage(conn, "tailor", "failed")
    if change == "row":
        conn.execute("UPDATE job_stage_states SET retryable=0 WHERE tenant_id='local' AND job_id=? AND stage='tailor'", (JOB,))
    else:
        from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
        from jobctrl.state import record_job_event

        record_job_event(conn, JOB, "tailor", "StageFailed", payload={"retryable": False}, publisher=InProcessEventBus())
    conn.commit()
    tables = ("job_materials", "job_materials_artifacts", "job_stage_states", "job_events")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(ValueError, match="target changed"):
        reset_retry_stages(conn, [(PEER, "score"), (JOB, "tailor")], only_failed=True)
    assert {table: _rows(conn, table) for table in tables} == before
    assert not conn.in_transaction


def test_legacy_enrichment_rpc_keeps_its_strict_mixed_cohort_response(conn, monkeypatch):
    from jobctrl.domain.rpc.messages import JsonRpcRequest

    _seed_stage(conn, "tailor", "failed")
    monkeypatch.setattr(enrichment_retry, "get_connection", lambda: conn)
    monkeypatch.setattr(enrichment_retry, "assert_expected_runtime", lambda **_: None)
    response = build_server().dispatch(JsonRpcRequest(method="reset_enrichment", id=1, params={
        "tenantId": "local", "expectedAppDir": "/synthetic", "expectedDbPath": "/synthetic/jobctrl.db",
        "targets": [{"jobId": JOB, "stage": "enrich"}, {"jobId": JOB, "stage": "tailor"}],
    }))
    assert response.error is None
    assert response.result["resets"] == [
        {"jobId": JOB, "jobUrl": URL, "stage": "enrich"},
        {"jobId": JOB, "jobUrl": URL, "stage": "tailor"},
    ]
    message = conn.execute("SELECT message FROM job_events WHERE job_id=? AND stage='tailor' AND event_type='StageReset'", (JOB,)).fetchone()
    assert "explicit re-tailor" in message[0]


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_reset_fences_old_material_owner_and_allows_successor(conn, stage):
    from jobctrl.infrastructure.preparation_recovery import assert_material_activity_commit_allowed

    _seed_stage(conn, stage, "failed")
    conn.execute("UPDATE job_stage_states SET state='running' WHERE tenant_id='local' AND job_id=? AND stage=?", (JOB, stage))
    conn.commit()
    reset_job_stage(conn, URL, stage)
    with pytest.raises(RuntimeError, match="no longer owns"):
        assert_material_activity_commit_allowed(conn, tenant_id="local", job_id=JOB, stage=stage, workflow_id="old-owner")
    conn.execute(
        "UPDATE job_stage_states SET state='running',metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage=?",
        ('{"activityOwner":"new-owner"}', JOB, stage),
    )
    conn.commit()
    with pytest.raises(RuntimeError, match="no longer owns"):
        assert_material_activity_commit_allowed(conn, tenant_id="local", job_id=JOB, stage=stage, workflow_id="old-owner")
    assert_material_activity_commit_allowed(conn, tenant_id="local", job_id=JOB, stage=stage, workflow_id="new-owner")


def test_plain_retry_recovers_approved_resume_and_explains_retailor(conn):
    from jobctrl.scoring.tailor import _reconcile_existing_approved_resume

    _seed_stage(conn, "tailor", "failed")
    reset = reset_job_stage(conn, URL, "tailor")
    assert reset.retailor_required
    materials = _reconcile_existing_approved_resume(
        conn, tenant_id=LOCAL_TENANT, job_id=JOB, retailor=False, workflow_id=None,
    )
    assert materials is not None and materials.generation == 1 and materials.is_resume_approved
    recovery = conn.execute("SELECT message FROM job_events WHERE job_id=? AND event_type='StageCompleted' ORDER BY event_id DESC", (JOB,)).fetchone()
    assert "explicit re-tailor" in recovery[0]
    assert conn.execute("SELECT status FROM job_materials_artifacts WHERE artifact_id='synthetic-accepted'").fetchone()[0] == "approved"


def test_material_reset_and_unsafe_apply_cohort_roll_back_together(conn):
    from jobctrl.pipeline.retry import ApplyResetRefused

    _seed_stage(conn, 'tailor', 'failed')
    conn.execute(
        "INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) "
        "VALUES('local',?,'apply','failed',2,3,'2026-01-01',1)", (PEER,),
    )
    conn.execute(
        "INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) "
        "VALUES('local',?,1,'apply','ApplySubmitIntended','{\"run_id\":\"synthetic-original\"}','2026-01-01')",
        (PEER,),
    )
    conn.commit()
    tables = ('job_materials', 'job_materials_artifacts', 'artifact_line_anchors',
              'application_review_decisions', 'job_stage_states', 'job_events')
    before = {table: _rows(conn, table) for table in tables}
    path = Path(conn.execute("SELECT path FROM job_materials_artifacts WHERE artifact_id='synthetic-accepted'").fetchone()[0])
    accepted = path.read_bytes()
    with pytest.raises(ApplyResetRefused, match='intent'):
        reset_retry_stages(conn, [(JOB, 'tailor'), (PEER, 'apply')])
    assert {table: _rows(conn, table) for table in tables} == before
    assert path.read_bytes() == accepted


def test_unified_apply_reset_releases_only_the_reviewed_skip_frontier(conn):
    from jobctrl.infrastructure.apply_controls import apply_dispatch_allows, capture_apply_dispatch_frontier
    from jobctrl.state import record_job_event

    conn.execute(
        "INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) "
        "VALUES('local',?,'apply','skipped',2,3,'2026-01-01',0)", (PEER,),
    )
    conn.commit()
    before_skip, _ = capture_apply_dispatch_frontier(conn, tenant_id=LOCAL_TENANT, job_id=PEER)
    record_job_event(conn, PEER, 'apply', 'StageSkipped', tenant_id=LOCAL_TENANT,
                     payload={'manualDisposition': 'skip'})
    conn.commit()
    between, _ = capture_apply_dispatch_frontier(conn, tenant_id=LOCAL_TENANT, job_id=PEER)
    reset_job_stage(conn, PEER, 'apply')
    event = conn.execute(
        "SELECT event_id,payload_json FROM job_events WHERE job_id=? AND event_type='StageReset'", (PEER,),
    ).fetchone()
    assert json.loads(event[1]) == {'reset_attempts': False, 'resetAuthority': 'explicit_safe_apply_reset',
                                  'manualSkipReleasedThroughEventId': between}
    for frontier in (before_skip, between):
        assert not apply_dispatch_allows(conn, tenant_id=LOCAL_TENANT, job_id=PEER, frontier=frontier)
    fresh, _ = capture_apply_dispatch_frontier(conn, tenant_id=LOCAL_TENANT, job_id=PEER)
    assert fresh == event[0]
    assert apply_dispatch_allows(conn, tenant_id=LOCAL_TENANT, job_id=PEER, frontier=fresh)
    record_job_event(conn, PEER, 'apply', 'StageSkipped', tenant_id=LOCAL_TENANT,
                     payload={'manualDisposition': 'skip'})
    conn.commit()
    assert not apply_dispatch_allows(conn, tenant_id=LOCAL_TENANT, job_id=PEER, frontier=fresh)
