from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.interview import InterviewPrep, InterviewPrepGateAudit, InterviewPrepItem
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.interview.sqlite_repository import InterviewNoteConflictError, SqliteInterviewPrepRepository

JOB = JobId("019ed290-3340-7000-8000-000000000891")
OTHER_JOB = JobId("019ed290-3340-7000-8000-000000000892")
TENANT = TenantId("local")


def _conn(path: Path) -> sqlite3.Connection:
    conn = init_db(path)
    conn.executemany(
        "INSERT INTO jobs(tenant_id,job_id,url,title) VALUES(?,?,?,?)",
        [
            ("local", str(JOB), "https://job/1", "Synthetic"),
            ("local", str(OTHER_JOB), "https://job/2", "Synthetic other"),
            ("other", str(JOB), "https://other/job/1", "Synthetic tenant"),
        ],
    )
    conn.commit()
    return conn


def _prep(generation: int = 1) -> InterviewPrep:
    return InterviewPrep(
        job_id=JOB,
        generation=generation,
        status="accepted",
        generated_at="2026-10-01",
        gate_audit=InterviewPrepGateAudit(status="passed"),
        items=(
            InterviewPrepItem(
                item_id="item",
                kind="theme",
                title="Theme",
                generated_text="Synthetic guide",
                evidence_ids=(),
                requirement_ids=(),
            ),
        ),
    )


def test_note_cas_and_history_are_independent_of_generation_replacement(tmp_path: Path) -> None:
    path = tmp_path / "notes.db"
    conn = _conn(path)
    repo = SqliteInterviewPrepRepository(conn)
    try:
        repo.save(_prep(), tenant_id=TENANT)
        first = repo.save_note(
            TENANT,
            JOB,
            "B01",
            expected_revision=0,
            note_text="Unverified recollection",
            source_generation=1,
            bindings={"cardRevision": "v1"},
        )
        assert first["revision"] == 1 and first["editStatus"] == "user_edited"
        assert first["factualSupport"] == "unverified_user_statement"
        repo.save(
            replace(_prep(2), status="failed", gate_audit=InterviewPrepGateAudit(status="failed"), items=()),
            tenant_id=TENANT,
        )
        assert repo.load_latest(TENANT, JOB).generation == 1
        repo.save(_prep(3), tenant_id=TENANT)
        assert repo.load_note(TENANT, JOB, "B01") == first
        with pytest.raises(InterviewNoteConflictError, match="interview_note_revision_conflict"):
            repo.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="stale overwrite")
        second = repo.save_note(
            TENANT, JOB, "B01", expected_revision=1, note_text="New recollection", factual_support="needs_clarification"
        )
        assert second["revision"] == 2
        assert [n["noteText"] for n in repo.load_note_history(TENANT, JOB, "B01")] == [
            "New recollection",
            "Unverified recollection",
        ]
        assert [p["generation"] for p in repo.load_history(TENANT, JOB)] == [3, 2, 1]
        assert [p["status"] for p in repo.load_history(TENANT, JOB)] == ["accepted", "failed", "superseded"]
    finally:
        close_connection(path)


def test_independent_connections_cannot_overwrite_newer_note(tmp_path: Path) -> None:
    path = tmp_path / "notes.db"
    conn = _conn(path)
    other = sqlite3.connect(path)
    other.row_factory = sqlite3.Row
    try:
        first = SqliteInterviewPrepRepository(conn)
        second = SqliteInterviewPrepRepository(other)
        first.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="first")
        assert second.load_note(TENANT, JOB, "B01")["revision"] == 1
        first.save_note(TENANT, JOB, "B01", expected_revision=1, note_text="newer")
        with pytest.raises(InterviewNoteConflictError):
            second.save_note(TENANT, JOB, "B01", expected_revision=1, note_text="late")
        assert second.load_note(TENANT, JOB, "B01")["noteText"] == "newer"
        assert len(second.load_note_history(TENANT, JOB, "B01")) == 2
    finally:
        other.close()
        close_connection(path)


def test_note_history_failure_rolls_back_current_and_preserves_caller_transaction(tmp_path: Path) -> None:
    path = tmp_path / "notes.db"
    conn = _conn(path)
    repo = SqliteInterviewPrepRepository(conn)
    try:
        repo.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="accepted edit")
        conn.execute(
            "CREATE TEMP TRIGGER fail_note_history BEFORE INSERT ON job_interview_note_revisions BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END"
        )
        conn.execute("UPDATE jobs SET title='caller edit' WHERE tenant_id='local' AND job_id=?", (str(JOB),))
        with pytest.raises(sqlite3.IntegrityError, match="synthetic history failure"):
            repo.save_note(TENANT, JOB, "B01", expected_revision=1, note_text="failed edit")
        assert conn.in_transaction
        assert repo.load_note(TENANT, JOB, "B01")["revision"] == 1
        assert repo.load_note(TENANT, JOB, "B01")["noteText"] == "accepted edit"
        conn.rollback()
        assert (
            conn.execute("SELECT title FROM jobs WHERE tenant_id='local' AND job_id=?", (str(JOB),)).fetchone()[0]
            == "Synthetic"
        )
    finally:
        close_connection(path)


def test_failed_prep_item_persistence_keeps_accepted_history_and_note(tmp_path: Path) -> None:
    path = tmp_path / "notes.db"
    conn = _conn(path)
    repo = SqliteInterviewPrepRepository(conn)
    try:
        repo.save(_prep(), tenant_id=TENANT)
        note = repo.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="preserved")
        conn.execute(
            "CREATE TEMP TRIGGER fail_prep_item BEFORE INSERT ON job_interview_prep_items BEGIN SELECT RAISE(ABORT,'synthetic item failure'); END"
        )
        with pytest.raises(sqlite3.IntegrityError):
            repo.save(_prep(2), tenant_id=TENANT)
        assert repo.load_latest(TENANT, JOB).generation == 1
        assert len(repo.load_history(TENANT, JOB)) == 1
        assert repo.load_note(TENANT, JOB, "B01") == note
        assert not conn.in_transaction
    finally:
        close_connection(path)


def test_tenant_job_isolation_and_purge_cascade(tmp_path: Path) -> None:
    path = tmp_path / "notes.db"
    conn = _conn(path)
    repo = SqliteInterviewPrepRepository(conn)
    try:
        repo.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="local")
        repo.save_note(TenantId("other"), JOB, "B01", expected_revision=0, note_text="other tenant")
        repo.save_note(TENANT, OTHER_JOB, "B01", expected_revision=0, note_text="other job")
        with pytest.raises(sqlite3.IntegrityError):
            repo.save_note(TenantId("missing"), JOB, "B01", expected_revision=0, note_text="cross tenant")
        conn.execute("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?", (str(JOB),))
        conn.commit()
        assert repo.load_note(TENANT, JOB, "B01") is None
        assert repo.load_note_history(TENANT, JOB, "B01") == []
        assert repo.load_note(TenantId("other"), JOB, "B01")["noteText"] == "other tenant"
        assert repo.load_note(TENANT, OTHER_JOB, "B01")["noteText"] == "other job"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        close_connection(path)


def test_user_note_cannot_assert_passed_support_or_exceed_limit(tmp_path: Path) -> None:
    path = tmp_path / "notes.db"
    conn = _conn(path)
    repo = SqliteInterviewPrepRepository(conn)
    try:
        with pytest.raises(ValueError, match="cannot assert verified"):
            repo.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="claim", factual_support="supported")
        with pytest.raises(ValueError, match="invalid interview note text"):
            repo.save_note(TENANT, JOB, "B01", expected_revision=0, note_text="x" * 20001)
        assert repo.list_notes(TENANT, JOB) == []
    finally:
        close_connection(path)


def test_late_or_colliding_prep_cannot_replace_newer_accepted_generation(tmp_path: Path) -> None:
    from jobctrl.infrastructure.interview.sqlite_repository import InterviewPrepGenerationConflictError

    path = tmp_path / "notes.db"
    conn = _conn(path)
    repo = SqliteInterviewPrepRepository(conn)
    try:
        repo.save(_prep(2), tenant_id=TENANT, origin_run_id="newer")
        before = repo.load_latest_read_model(TENANT, JOB)
        for generation in [1, 2]:
            with pytest.raises(InterviewPrepGenerationConflictError):
                repo.save(_prep(generation), tenant_id=TENANT, origin_run_id="late")
        assert repo.load_latest_read_model(TENANT, JOB) == before
        assert len(repo.load_history(TENANT, JOB)) == 1
        assert repo.find_completed_for_run(TENANT, JOB, "newer").generation == 2
    finally:
        close_connection(path)
