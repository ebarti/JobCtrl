from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from jobctrl.database import SCHEMA_VERSION, close_connection, init_db
from jobctrl.digest import acknowledge_digest, build_digest, read_digest_state
from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
from jobctrl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    QuarantineReason,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.llm import SpendBudgetStatus


_SOURCE = Path(__file__).resolve().parents[1] / "src"
_CHILD = r"""
import os, runpy, socket, sqlite3, subprocess, sys
sys.path.insert(0, sys.argv.pop(1))
from jobctrl.native_credentials import NativeCredentialStore
def blocked(*args, **kwargs):
    raise AssertionError("native credentials, external processes and network are forbidden")
NativeCredentialStore.read = blocked
NativeCredentialStore.inspect = blocked
subprocess.Popen = blocked
socket.socket.connect = blocked
socket.create_connection = blocked
if os.environ.get("DIGEST_TEST_FAIL_PROJECTION") == "1":
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
    def fail_refresh(*args, **kwargs):
        raise sqlite3.OperationalError("synthetic projection read failed")
    ProjectionBuilder.refresh = fail_refresh
loader = os.environ.get("DIGEST_TEST_FAIL_LOADER")
if loader:
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
    method_name = {
        "late_score": "_load_latest_score",
        "stage": "_load_stage_projections",
        "materials": "_load_latest_materials",
        "deleted": "_load_deleted_at",
        "apply": "_load_latest_apply_run",
        "outcome": "_load_explicit_application",
        "deleted_scan": "_stale_deleted_projection_jobs",
    }[loader]
    original_loader = getattr(ProjectionBuilder, method_name)
    class FailingReadConnection:
        def __init__(self, wrapped):
            self.wrapped = wrapped
        def __getattr__(self, name):
            return getattr(self.wrapped, name)
        def execute(self, sql, *args, **kwargs):
            raise sqlite3.OperationalError("synthetic " + loader + " read failed")
    calls = 0
    def fail_loader(self, *args, **kwargs):
        global calls
        calls += 1
        if loader == "late_score" and calls == 1:
            return original_loader(self, *args, **kwargs)
        original_conn = self._local.conn
        self._local.conn = FailingReadConnection(original_conn)
        try:
            return original_loader(self, *args, **kwargs)
        finally:
            self._local.conn = original_conn
    setattr(ProjectionBuilder, method_name, fail_loader)
if os.environ.get("DIGEST_TEST_DENY_READ") or os.environ.get("DIGEST_TEST_DENY_EVENT") == "1" or os.environ.get("DIGEST_TEST_MISSING_OUTCOMES") == "1" or os.environ.get("DIGEST_TEST_ORPHAN"):
    import jobctrl.cli as cli
    from jobctrl.database import get_connection
    original = cli._bootstrap
    def bootstrap_with_read_failure(*args, **kwargs):
        original(*args, **kwargs)
        if os.environ.get("DIGEST_TEST_MISSING_OUTCOMES") == "1":
            get_connection().execute("DROP TABLE application_outcomes")
        orphan = os.environ.get("DIGEST_TEST_ORPHAN")
        if orphan:
            conn = get_connection()
            conn.execute(
                "INSERT INTO job_list_projections (tenant_id,job_id,discovered_at,fit_score) VALUES ('local',?,?,9)",
                (orphan, '2099-01-01T00:00:00.000Z'),
            )
            conn.commit()
        denied = os.environ.get("DIGEST_TEST_DENY_READ")
        deny_event = os.environ.get("DIGEST_TEST_DENY_EVENT") == "1"
        if denied or deny_event:
            get_connection().set_authorizer(
                lambda action, table, column, database, trigger:
                    sqlite3.SQLITE_DENY if (action == sqlite3.SQLITE_READ and table == denied)
                    or (action == sqlite3.SQLITE_INSERT and table == "job_events" and deny_event)
                    else sqlite3.SQLITE_OK
            )
    cli._bootstrap = bootstrap_with_read_failure
sys.argv = ["jobctrl", "digest", "--json", "--min-fit-score", "7"]
if os.environ.get("DIGEST_TEST_ACKNOWLEDGE") == "1":
    sys.argv.append("--acknowledge")
runpy.run_module("jobctrl", run_name="__main__")
"""


def _run_digest(
    app_dir: Path,
    *,
    deny_read: str = "",
    missing_outcomes: bool = False,
    fail_projection: bool = False,
    fail_loader: str = "",
    deny_event: bool = False,
    orphan_projection: str = "",
    acknowledge: bool = False,
) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.defpath,
        "HOME": str(app_dir),
        "TMPDIR": str(app_dir),
        "XDG_CACHE_HOME": str(app_dir / "cache"),
        "XDG_CONFIG_HOME": str(app_dir / "config"),
        "JOBCTRL_DIR": str(app_dir),
        "OPENAI_API_KEY": "synthetic-not-a-credential",
        "ANTHROPIC_API_KEY": "synthetic-not-a-credential",
        "GEMINI_API_KEY": "synthetic-not-a-credential",
        "CAPSOLVER_API_KEY": "synthetic-not-a-credential",
        "DIGEST_TEST_DENY_READ": deny_read,
        "DIGEST_TEST_MISSING_OUTCOMES": "1" if missing_outcomes else "0",
        "DIGEST_TEST_FAIL_PROJECTION": "1" if fail_projection else "0",
        "DIGEST_TEST_FAIL_LOADER": fail_loader,
        "DIGEST_TEST_DENY_EVENT": "1" if deny_event else "0",
        "DIGEST_TEST_ORPHAN": orphan_projection,
        "DIGEST_TEST_ACKNOWLEDGE": "1" if acknowledge else "0",
    }
    return subprocess.run(
        [sys.executable, "-I", "-B", "-c", _CHILD, str(_SOURCE)],
        cwd=app_dir,
        env=env,
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )


@pytest.fixture
def workspace(tmp_path: Path) -> tuple[Path, Path]:
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    db_path = app_dir / "jobctrl.db"
    conn = init_db(db_path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 15
    close_connection(db_path)
    return app_dir, db_path


def _state(db_path: Path) -> tuple[tuple[object, ...], ...]:
    with sqlite3.connect(db_path) as conn:
        return tuple(
            conn.execute("SELECT tenant_id, last_acknowledged_at, updated_at FROM digest_state ORDER BY tenant_id")
        )


def _time(days_ago: int) -> str:
    return (
        (datetime.now(timezone.utc) - timedelta(days=days_ago))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _job_id(number: int) -> str:
    return f"91000000-0000-4000-8000-{number:012d}"


def _insert_job(
    conn: sqlite3.Connection, tenant: str, number: int, *, discovered: str, score: int | None = None
) -> str:
    job_id = _job_id(number)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, company, discovered_at) VALUES (?, ?, ?, ?, ?, ?)",
        (
            tenant,
            job_id,
            f"https://{tenant}.example.test/jobs/{number}",
            f"Synthetic role {number}",
            "Example",
            discovered,
        ),
    )
    if score is not None:
        conn.execute(
            "INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at) VALUES (?,?,1,?,'{}','[]',?)",
            (tenant, job_id, score, discovered),
        )
    return job_id


def _snapshot(conn: sqlite3.Connection, tenant: str, job_id: str, states: tuple[ActiveState, ...], when: str) -> None:
    aggregate = PostingSnapshotSet.empty(tenant_id=TenantId(tenant), job_id=canonical_job_id(job_id), updated_at=when)
    for index, state in enumerate(states):
        aggregate, _ = aggregate.record_snapshot(
            source_id="synthetic-source",
            extraction_tier="synthetic",
            description_hash=SnapshotDescriptionHash.from_text(f"Synthetic description {index}"),
            apply_url=None,
            active_state=state,
            confidence=SnapshotConfidence.HIGH,
            quarantine_reason=QuarantineReason.NONE,
            captured_at=when,
        )
    SqlitePostingSnapshotSetRepository(conn).save(aggregate, commit=False)


def _stage(conn: sqlite3.Connection, tenant: str, job_id: str, state: str, when: str) -> None:
    conn.execute(
        "INSERT INTO job_stage_states (tenant_id,job_id,stage,state,updated_at) VALUES (?,?,'apply',?,?)",
        (tenant, job_id, state, when),
    )


def _outcome(conn: sqlite3.Connection, tenant: str, job_id: str, outcome_id: str, kind: str, when: str) -> None:
    conn.execute(
        "INSERT INTO application_outcomes (tenant_id,outcome_id,job_id,kind,source,occurred_at,recorded_at) VALUES (?,?,?,?,'manual',?,?)",
        (tenant, outcome_id, job_id, kind, when, when),
    )


def test_digest_cli_on_empty_exact_schema_returns_real_zeros_without_acknowledging(
    workspace: tuple[Path, Path],
) -> None:
    app_dir, db_path = workspace
    before = _state(db_path)
    result = _run_digest(app_dir)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
    assert payload["newMatches"] == {"count": 0, "highFitCount": 0}
    assert payload["pendingApprovals"]["count"] == 0
    assert payload["staleScores"]["count"] == 0
    assert payload["followUpsDue"]["count"] == 0
    assert _state(db_path) == before


def test_digest_cli_counts_canonical_jobs_once_and_respects_tenant_and_state(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    now, recent, old, since = _time(0), _time(1), _time(20), _time(10)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        high = _insert_job(conn, "local", 1, discovered=recent, score=9)
        low = _insert_job(conn, "local", 2, discovered=recent, score=6)
        hidden = _insert_job(conn, "local", 3, discovered=recent, score=9)
        closed = _insert_job(conn, "local", 4, discovered=recent, score=9)
        deleted = _insert_job(conn, "local", 5, discovered=recent, score=9)
        corrected = _insert_job(conn, "local", 6, discovered=old, score=9)
        stopped = _insert_job(conn, "local", 7, discovered=old)
        _snapshot(conn, "local", high, (ActiveState.ACTIVE, ActiveState.ACTIVE), recent)
        _snapshot(conn, "local", closed, (ActiveState.ACTIVE, ActiveState.CLOSED), recent)
        conn.execute("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)", (hidden, now))
        conn.execute(
            "INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at) VALUES ('local',?,?)", (deleted, now)
        )
        for job_id in (high, low, hidden, closed, deleted):
            _stage(conn, "local", job_id, "pending", recent)
        conn.execute(
            "INSERT INTO application_review_decisions (tenant_id,decision_id,job_id,decision,decided_at) VALUES ('local','approved',?,'approve_submit',?)",
            (low, recent),
        )
        for index, job_id in enumerate((high, high, corrected, hidden, closed, deleted)):
            conn.execute(
                "INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('local',?,?,1,2,?,0)",
                (job_id, f"synthetic-{index}", recent),
            )
        conn.execute(
            "INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,correction_json) VALUES ('local',?,2,9,'{}','[]',?,'{}')",
            (corrected, old),
        )
        _outcome(conn, "local", corrected, "due", "applied_confirmation", old)
        _outcome(conn, "local", stopped, "stopped-apply", "applied_confirmation", old)
        _outcome(conn, "local", stopped, "stopped-reply", "recruiter_reply", _time(19))

        foreign_same = _insert_job(conn, "other", 1, discovered=recent, score=9)
        foreign_only = _insert_job(conn, "other", 8, discovered=recent, score=9)
        conn.execute(
            "INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,correction_json) VALUES ('other',?,2,9,'{}','[]',?,'{}')",
            (foreign_same, now),
        )
        conn.execute(
            "INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('other',?,?)", (foreign_same, now)
        )
        _snapshot(conn, "other", foreign_same, (ActiveState.CLOSED,), now)
        _stage(conn, "other", foreign_same, "succeeded", now)
        _stage(conn, "other", foreign_only, "pending", now)
        conn.execute(
            "INSERT INTO application_review_decisions (tenant_id,decision_id,job_id,decision,decided_at) VALUES ('other','foreign-defer',?,'defer',?)",
            (foreign_same, now),
        )
        _outcome(conn, "other", foreign_same, "foreign-same-due", "applied_confirmation", old)
        _outcome(conn, "other", foreign_only, "foreign-due", "applied_confirmation", old)
        conn.commit()

    before = _state(db_path)
    result = _run_digest(app_dir)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["newMatches"] == {"count": 2, "highFitCount": 1}
    assert payload["pendingApprovals"]["count"] == 1
    assert payload["staleScores"]["count"] == 1
    assert payload["followUpsDue"]["count"] == 1
    assert payload["highFitThreshold"] == 7
    assert payload["since"] == since
    assert "discoveredSince=" in payload["deepLinks"]["newMatches"]
    assert _state(db_path) == before


def test_digest_cli_compares_watermark_as_instants_at_millisecond_precision(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    since = "2020-05-01T10:00:00.500Z"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        _insert_job(conn, "local", 1, discovered="2020-05-01T09:30:00-02:00", score=9)
        _insert_job(conn, "local", 2, discovered="2020-05-01T11:00:00+02:00", score=6)
        _insert_job(conn, "local", 3, discovered="2020-05-01T10:00:00.5+00:00", score=7)
        _insert_job(conn, "local", 4, discovered="2020-05-01T10:00:00.4999Z", score=9)
    before = _state(db_path)
    result = _run_digest(app_dir)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["newMatches"] == {"count": 2, "highFitCount": 2}
    assert payload["since"] == since
    assert _state(db_path) == before


def test_digest_cli_orders_follow_up_outcomes_by_instant(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)

    def stamp(delta: timedelta, offset: int) -> str:
        return (cutoff + delta).astimezone(timezone(timedelta(hours=offset))).isoformat(timespec="milliseconds")

    with sqlite3.connect(db_path) as conn:
        due = _insert_job(conn, "local", 1, discovered="2020-01-01T00:00:00Z")
        not_due = _insert_job(conn, "local", 2, discovered="2020-01-01T00:00:00Z")
        prior_reply = _insert_job(conn, "local", 3, discovered="2020-01-01T00:00:00Z")
        _outcome(conn, "local", due, "due", "applied_confirmation", stamp(timedelta(hours=-1), 2))
        _outcome(conn, "local", not_due, "not-due", "applied_confirmation", stamp(timedelta(hours=1), -2))
        _outcome(conn, "local", prior_reply, "application", "applied_confirmation", stamp(timedelta(hours=-2), -2))
        _outcome(conn, "local", prior_reply, "prior-reply", "recruiter_reply", stamp(timedelta(hours=-3), 2))
    before = _state(db_path)
    result = _run_digest(app_dir)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["followUpsDue"]["count"] == 2
    assert _state(db_path) == before


@pytest.mark.parametrize(
    "denied_table",
    [
        "job_list_projections",
        "jobs",
        "job_events",
        "jobctrl_hidden_jobs",
        "jobctrl_deleted_jobs",
        "posting_snapshot_sets",
        "source_quality_stats",
        "operational_attempt_metrics",
        "source_registry_entries",
        "job_stage_states",
        "application_review_decisions",
        "apply_run_projections",
        "job_score_staleness",
        "job_scores",
        "application_outcomes",
    ],
)
def test_digest_cli_propagates_read_failure_without_acknowledging(
    workspace: tuple[Path, Path],
    denied_table: str,
) -> None:
    app_dir, db_path = workspace
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)",
            (_time(10), _time(10)),
        )
    before = _state(db_path)
    result = _run_digest(app_dir, deny_read=denied_table, acknowledge=True)
    assert result.returncode != 0
    assert "access to" in result.stderr or "prohibited" in result.stderr
    assert '"ok": true' not in result.stdout
    assert _state(db_path) == before


def test_digest_cli_ignores_projection_for_another_tenants_job(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    foreign_id = _job_id(8)
    with sqlite3.connect(db_path) as conn:
        _insert_job(conn, "other", 8, discovered=_time(1), score=9)
    before = _state(db_path)
    result = _run_digest(app_dir, orphan_projection=foreign_id)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["newMatches"] == {"count": 0, "highFitCount": 0}
    with sqlite3.connect(db_path) as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM job_list_projections WHERE tenant_id='local' AND job_id=?", (foreign_id,)
            ).fetchone()[0]
            == 1
        )
    assert _state(db_path) == before


def test_digest_cli_reports_missing_read_table_instead_of_zero(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    before = _state(db_path)
    result = _run_digest(app_dir, missing_outcomes=True, acknowledge=True)
    assert result.returncode != 0
    assert "no such table: application_outcomes" in result.stderr or "manifest" in result.stderr
    assert '"ok": true' not in result.stdout
    assert _state(db_path) == before


@pytest.mark.parametrize("acknowledge", [False, True])
def test_digest_cli_reports_projection_refresh_failure_without_acknowledging(
    workspace: tuple[Path, Path],
    acknowledge: bool,
) -> None:
    app_dir, db_path = workspace
    before = _state(db_path)
    result = _run_digest(app_dir, fail_projection=True, acknowledge=acknowledge)
    assert result.returncode != 0
    assert "synthetic projection read failed" in result.stderr
    assert '"ok": true' not in result.stdout
    assert _state(db_path) == before


@pytest.mark.parametrize(
    "failed_loader", ["late_score", "stage", "materials", "deleted", "apply", "outcome", "deleted_scan"]
)
def test_digest_cli_preserves_existing_projections_on_failed_refresh(
    workspace: tuple[Path, Path],
    failed_loader: str,
) -> None:
    app_dir, db_path = workspace
    recent = _time(1)
    with sqlite3.connect(db_path) as conn:
        for number in (1, 2):
            job_id = _insert_job(conn, "local", number, discovered=recent, score=9)
            conn.execute(
                "INSERT INTO job_list_projections (tenant_id,job_id,title,discovered_at,fit_score,scored_at,last_updated_at) VALUES ('local',?,'Accepted synthetic',?,9,?,?)",
                (job_id, recent, recent, recent),
            )
            conn.execute(
                "INSERT INTO job_events (tenant_id,job_id,identity_version,event_type,occurred_at) VALUES ('local',?,1,'SyntheticUpdated',?)",
                (job_id, recent),
            )
    tables = (
        "job_list_projections",
        "job_detail_projections",
        "artifact_list_projections",
        "dashboard_projections",
        "event_watermarks",
        "projection_backfills",
    )
    with sqlite3.connect(db_path) as conn:
        before_projection = {
            table: conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in tables
        }
    before_state = _state(db_path)
    result = _run_digest(app_dir, fail_loader=failed_loader)
    assert result.returncode != 0, result.stdout
    assert f"synthetic {failed_loader} read failed" in result.stderr
    with sqlite3.connect(db_path) as conn:
        assert {
            table: conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in tables
        } == before_projection
    assert _state(db_path) == before_state


def test_default_projection_builder_keeps_existing_score_read_fallback(workspace: tuple[Path, Path]) -> None:
    _, db_path = workspace

    class FailingReadConnection:
        def __init__(self, wrapped: sqlite3.Connection) -> None:
            self.wrapped = wrapped

        def execute(self, *_args: object, **_kwargs: object) -> None:
            raise sqlite3.OperationalError("synthetic score read failed")

    with sqlite3.connect(db_path) as conn:
        failing = FailingReadConnection(conn)
        builder = ProjectionBuilder(conn_factory=lambda: conn)
        with builder._bind(failing):
            assert builder._load_latest_score(_job_id(1)) == {}


def test_digest_cli_acknowledges_atomically_and_passive_read_preserves_it(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    since = _time(10)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
    result = _run_digest(app_dir, acknowledge=True)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["digest"]["since"] == since
    acknowledged = payload["digest"]["generatedAt"]
    assert payload["acknowledge"]["state"]["lastAcknowledgedAt"] == acknowledged
    with sqlite3.connect(db_path) as conn:
        event = conn.execute(
            "SELECT tenant_id,job_id,identity_version,entity_kind,entity_ref,payload_json FROM job_events WHERE event_type='DigestReviewed'"
        ).fetchone()
    assert event is not None
    assert event[:5] == ("local", None, 1, "digest", "daily")
    assert json.loads(event[5])["previousAcknowledgedAt"] == since
    assert json.loads(event[5])["acknowledgedAt"] == acknowledged
    before = _state(db_path)
    passive = _run_digest(app_dir)
    assert passive.returncode == 0, passive.stderr
    assert json.loads(passive.stdout)["since"] == acknowledged
    assert _state(db_path) == before
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 1


def test_digest_cli_event_failure_rolls_back_acknowledgement(workspace: tuple[Path, Path]) -> None:
    app_dir, db_path = workspace
    since = _time(10)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
    before = _state(db_path)
    result = _run_digest(app_dir, deny_event=True, acknowledge=True)
    assert result.returncode != 0
    assert "prohibited" in result.stderr or "not authorized" in result.stderr
    assert _state(db_path) == before
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 0


def test_acknowledgement_event_failure_rolls_back_on_live_connection(workspace: tuple[Path, Path]) -> None:
    _, db_path = workspace
    since = _time(10)
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        conn.commit()
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('other',?,?)", (since, since)
        )
        conn.set_authorizer(
            lambda action, table, *_args: (
                sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_INSERT and table == "job_events" else sqlite3.SQLITE_OK
            )
        )
        with pytest.raises(sqlite3.DatabaseError):
            acknowledge_digest(conn)
        conn.set_authorizer(None)
        assert (
            conn.execute("SELECT last_acknowledged_at FROM digest_state WHERE tenant_id='local'").fetchone()[0] == since
        )
        conn.commit()
    assert _state(db_path) == (("local", since, since), ("other", since, since))


def test_acknowledgement_commit_failure_rolls_back_state_and_event(workspace: tuple[Path, Path]) -> None:
    _, db_path = workspace
    since = _time(10)

    class FailingCommitConnection(sqlite3.Connection):
        fail_commit = False

        def commit(self) -> None:
            if self.fail_commit:
                raise sqlite3.OperationalError("synthetic commit failure")
            super().commit()

    conn = sqlite3.connect(db_path, factory=FailingCommitConnection)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        conn.commit()
        conn.fail_commit = True
        with pytest.raises(sqlite3.OperationalError, match="synthetic commit failure"):
            acknowledge_digest(conn)
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 0
    finally:
        conn.close()
    assert _state(db_path) == (("local", since, since),)


@pytest.mark.parametrize("commit_caller", [False, True])
@pytest.mark.parametrize("row_factory", [None, sqlite3.Row], ids=["tuple", "named"])
def test_acknowledgement_leaves_caller_transaction_under_caller_control(
    workspace: tuple[Path, Path],
    commit_caller: bool,
    row_factory: type[sqlite3.Row] | None,
) -> None:
    _, db_path = workspace
    since = _time(10)
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = row_factory
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        conn.commit()
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('other',?,?)", (since, since)
        )
        result = acknowledge_digest(conn)
        new_watermark = result["state"]["lastAcknowledgedAt"]
        assert new_watermark != since
        assert conn.in_transaction
        assert _state(db_path) == (("local", since, since),)
        with sqlite3.connect(db_path) as observer:
            assert (
                observer.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 0
            )
        if commit_caller:
            conn.commit()
        else:
            conn.rollback()
    finally:
        conn.close()
    with sqlite3.connect(db_path) as conn:
        if commit_caller:
            assert _state(db_path) == (("local", new_watermark, result["state"]["updatedAt"]), ("other", since, since))
            assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 1
        else:
            assert _state(db_path) == (("local", since, since),)
            assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 0


@pytest.mark.parametrize("row_factory", [None, sqlite3.Row], ids=["tuple", "named"])
def test_acknowledgement_release_failure_preserves_caller_transaction(
    workspace: tuple[Path, Path], row_factory: type[sqlite3.Row] | None
) -> None:
    _, db_path = workspace
    since = _time(10)

    class FailingReleaseConnection(sqlite3.Connection):
        fail_release = False

        def execute(self, sql: str, parameters: tuple = (), /) -> sqlite3.Cursor:
            if self.fail_release and sql == "RELEASE SAVEPOINT digest_acknowledgement":
                self.fail_release = False
                raise sqlite3.OperationalError("synthetic release failure")
            return super().execute(sql, parameters)

    conn = sqlite3.connect(db_path, factory=FailingReleaseConnection)
    try:
        conn.row_factory = row_factory
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        conn.commit()
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('other',?,?)", (since, since)
        )
        conn.fail_release = True
        with pytest.raises(sqlite3.OperationalError, match="synthetic release failure"):
            acknowledge_digest(conn)
        assert conn.in_transaction
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DigestReviewed'").fetchone()[0] == 0
        conn.commit()
    finally:
        conn.close()
    assert _state(db_path) == (("local", since, since), ("other", since, since))


def test_tuple_row_connection_reads_digest_and_cannot_regress_watermark(workspace: tuple[Path, Path]) -> None:
    _, db_path = workspace
    since, old, recent = "2020-05-10T00:00:00Z", "2020-04-01T00:00:00Z", "2020-05-11T00:00:00Z"
    with sqlite3.connect(db_path) as conn:
        assert conn.row_factory is None
        job_id = _insert_job(conn, "local", 1, discovered=recent, score=9)
        conn.execute(
            "INSERT INTO job_list_projections (tenant_id,job_id,discovered_at,scored_at,fit_score) VALUES ('local',?,?,?,9)",
            (job_id, recent, recent),
        )
        _stage(conn, "local", job_id, "pending", recent)
        conn.execute(
            "INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('local',?,'synthetic',1,2,?,0)",
            (job_id, recent),
        )
        _outcome(conn, "local", job_id, "due", "applied_confirmation", old)
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)", (since, since)
        )
        conn.commit()
        budget = SpendBudgetStatus(
            day="2020-05-20",
            input_tokens=0,
            output_tokens=0,
            estimated_usd=0,
            daily_budget_usd=0,
            lane="discovery",
            lane_input_tokens=0,
            lane_output_tokens=0,
            lane_token_limit=0,
            lane_exceeded=False,
            global_exceeded=False,
            exceeded=False,
        )
        result = build_digest(conn, budget=budget, now=datetime(2020, 5, 20, tzinfo=timezone.utc))
        assert result["newMatches"] == {"count": 1, "highFitCount": 1}
        assert result["staleScores"]["count"] == 1
        assert result["pendingApprovals"]["count"] == 1
        assert result["followUpsDue"]["count"] == 1
        assert result["since"] == since
        assert conn.row_factory is None
        acknowledgement = acknowledge_digest(
            conn, acknowledged_at="2020-05-01T00:00:00Z", now=datetime(2020, 5, 20, tzinfo=timezone.utc)
        )
        assert acknowledgement["state"]["lastAcknowledgedAt"] == since
        assert read_digest_state(conn)["lastAcknowledgedAt"] == since
        assert conn.row_factory is None


def test_independent_connections_serialize_acknowledgements_without_regression(workspace: tuple[Path, Path]) -> None:
    _, db_path = workspace
    older = "2020-05-01T00:00:00Z"
    newer = "2020-05-10T00:00:00Z"
    now = datetime(2020, 5, 20, tzinfo=timezone.utc)
    started, finished = threading.Event(), threading.Event()
    outcome: list[object] = []

    def acknowledge_older() -> None:
        with sqlite3.connect(db_path, timeout=5) as conn:
            started.set()
            try:
                outcome.append(acknowledge_digest(conn, acknowledged_at=older, now=now))
            except Exception as error:
                outcome.append(error)
            finally:
                finished.set()

    with sqlite3.connect(db_path, timeout=5) as newer_conn:
        newer_conn.execute("BEGIN IMMEDIATE")
        acknowledge_digest(newer_conn, acknowledged_at=newer, now=now)
        thread = threading.Thread(target=acknowledge_older)
        thread.start()
        assert started.wait(2)
        assert not finished.wait(0.1)
        newer_conn.commit()
        thread.join(5)
        assert not thread.is_alive()
    assert len(outcome) == 1 and isinstance(outcome[0], dict), outcome
    assert outcome[0]["state"]["lastAcknowledgedAt"] == newer
    with sqlite3.connect(db_path) as conn:
        retry = acknowledge_digest(conn, acknowledged_at=older, now=now)
        assert retry["state"]["lastAcknowledgedAt"] == newer
        assert (
            conn.execute("SELECT last_acknowledged_at FROM digest_state WHERE tenant_id='local'").fetchone()[0] == newer
        )
        events = [
            json.loads(row[0])
            for row in conn.execute(
                "SELECT payload_json FROM job_events WHERE event_type='DigestReviewed' ORDER BY event_id"
            )
        ]
        assert [event["acknowledgedAt"] for event in events] == [newer, newer, newer]


def test_acknowledgement_preserves_precise_prior_and_bounds_future(workspace: tuple[Path, Path]) -> None:
    _, db_path = workspace
    previous = "2020-05-10T00:00:00.500000123Z"
    now = datetime(2020, 5, 20, tzinfo=timezone.utc)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)",
            (previous, previous),
        )
        conn.commit()
        old = acknowledge_digest(conn, acknowledged_at="2020-05-10T01:00:00.500000122+01:00", now=now)
        assert old["state"]["lastAcknowledgedAt"] == previous
        future = acknowledge_digest(conn, acknowledged_at="2020-05-20T00:00:00.000000001Z", now=now)
        assert future["state"]["lastAcknowledgedAt"] == "2020-05-20T00:00:00.000Z"
        conn.execute("UPDATE digest_state SET last_acknowledged_at='invalid' WHERE tenant_id='local'")
        conn.commit()
        with pytest.raises(ValueError, match="watermark"):
            acknowledge_digest(conn, now=now)
        assert (
            conn.execute("SELECT last_acknowledged_at FROM digest_state WHERE tenant_id='local'").fetchone()[0]
            == "invalid"
        )
