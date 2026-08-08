from pathlib import Path

from typer.testing import CliRunner

from jobctrl.cli import app
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.state import (
    ensure_job_stage_rows,
    get_job_stage_states,
    reconcile_dependency_blockers,
    reconcile_tailor_terminal_dependents,
    set_stage_state,
)

JOB_ID = JobId("498fe0a9-6615-4b4d-b8fd-6cbb978f6ec6")


def _insert_job(conn, **overrides):
    data = {
        "tenant_id": LOCAL_TENANT,
        "job_id": JOB_ID,
        "url": "https://example.com/job",
        "title": "Platform Engineer",
        "site": "ExampleCo",
        "strategy": "test",
        "discovered_at": "2026-04-29T10:00:00+00:00",
        "full_description": None,
        "application_url": None,
        "detail_error": None,
        "fit_score": None,
        "tailored_resume_path": None,
        "tailor_attempts": 0,
        "cover_letter_path": None,
        "cover_attempts": 0,
        "apply_status": None,
        "applied_at": None,
    }
    data.update(overrides)
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, strategy, discovered_at, full_description,
            application_url, detail_error, fit_score, tailored_resume_path,
            tailor_attempts, cover_letter_path, cover_attempts, apply_status,
            applied_at
        ) VALUES (
            :tenant_id, :job_id, :url, :title, :site, :strategy, :discovered_at, :full_description,
            :application_url, :detail_error, :fit_score, :tailored_resume_path,
            :tailor_attempts, :cover_letter_path, :cover_attempts, :apply_status,
            :applied_at
        )
        """,
        data,
    )
    conn.commit()
    return data


def test_explicit_stage_state_read_from_db(tmp_path):
    """Verify that set_stage_state writes and get_job_stage_states reads correctly."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        conn.commit()

        # Transition score through proper path: pending -> running -> failed
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "running",
            tenant_id=job["tenant_id"],
            started_at="2026-04-29T10:01:00+00:00",
        )
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "failed",
            error_code="LLM_ERROR",
            error_message="score failed",
            next_action=f"jobctrl retry score {job['url']}",
            tenant_id=job["tenant_id"],
        )
        conn.commit()

        states = get_job_stage_states(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        score = next(item for item in states if item["stage"] == "score")

        assert score["state"] == "failed"
        assert score["error_code"] == "LLM_ERROR"
        assert score["error_message"] == "score failed"
    finally:
        close_connection(db_path)


def test_ensure_job_stage_rows_creates_all_stages(tmp_path):
    """Verify that ensure_job_stage_rows creates a row for every stage."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        conn.commit()

        states = get_job_stage_states(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        assert len(states) == 6

        discover = next(item for item in states if item["stage"] == "discover")
        assert discover["state"] == "succeeded"
        assert discover["attempt_count"] == 1

        enrich = next(item for item in states if item["stage"] == "enrich")
        assert enrich["state"] == "pending"
    finally:
        close_connection(db_path)


def test_get_job_stage_states_returns_defaults_for_missing_rows(tmp_path):
    """When no rows exist, get_job_stage_states returns pending defaults."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        # Do NOT call ensure_job_stage_rows — no rows at all
        states = get_job_stage_states(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        assert len(states) == 6
        for item in states:
            assert item["state"] == "pending"
            assert item["attempt_count"] == 0
    finally:
        close_connection(db_path)


def test_retry_command_resets_stage_state_by_canonical_job_id(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    job = _insert_job(conn)

    try:
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "running",
            tenant_id=job["tenant_id"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "failed",
            tenant_id=job["tenant_id"],
        )
        conn.commit()
        monkeypatch.setattr("jobctrl.cli.get_connection", lambda: get_connection(db_path), raising=False)
        monkeypatch.setattr("jobctrl.database.DB_PATH", db_path)
        monkeypatch.setattr("jobctrl.config.DB_PATH", db_path)

        result = CliRunner().invoke(app, ["retry", "score", job["url"]])

        state = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()
        assert result.exit_code == 0
        assert state["state"] == "pending"
    finally:
        close_connection(db_path)


def test_queued_and_canceled_are_valid_states(tmp_path):
    """Verify the new 'queued' and 'canceled' states are accepted by set_stage_state."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        conn.commit()

        # Set stage to queued (Pending -> Queued is valid)
        set_stage_state(
            conn,
            job["job_id"],
            "enrich",
            "queued",
            tenant_id=job["tenant_id"],
        )
        conn.commit()
        states = get_job_stage_states(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        enrich = next(item for item in states if item["stage"] == "enrich")
        assert enrich["state"] == "queued"

        # Set stage to canceled (Queued -> Canceled is valid)
        set_stage_state(
            conn,
            job["job_id"],
            "enrich",
            "canceled",
            tenant_id=job["tenant_id"],
        )
        conn.commit()
        states = get_job_stage_states(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        enrich = next(item for item in states if item["stage"] == "enrich")
        assert enrich["state"] == "canceled"
    finally:
        close_connection(db_path)


def test_transition_validation_rejects_invalid(tmp_path):
    """Verify that set_stage_state rejects invalid transitions."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        conn.commit()

        import pytest

        # Pending -> Succeeded is NOT a valid transition (must go through Running)
        with pytest.raises(ValueError, match="not allowed"):
            set_stage_state(
                conn,
                job["job_id"],
                "enrich",
                "succeeded",
                tenant_id=job["tenant_id"],
            )

    finally:
        close_connection(db_path)


def test_transition_validation_can_be_bypassed(tmp_path):
    """validate_transition=False allows any state change."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        conn.commit()

        # Pending -> Succeeded would normally be rejected, but bypass works
        set_stage_state(
            conn,
            job["job_id"],
            "enrich",
            "succeeded",
            tenant_id=job["tenant_id"],
            validate_transition=False,
        )
        conn.commit()
        states = get_job_stage_states(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
        )
        enrich = next(item for item in states if item["stage"] == "enrich")
        assert enrich["state"] == "succeeded"
    finally:
        close_connection(db_path)


def test_score_success_unblocks_tailor_waiting_on_score(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "blocked",
            tenant_id=job["tenant_id"],
            error_code="BLOCKED",
            error_message="score has not completed.",
        )

        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "running",
            tenant_id=job["tenant_id"],
            started_at="2026-04-29T10:01:00+00:00",
        )
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "succeeded",
            tenant_id=job["tenant_id"],
            finished_at="2026-04-29T10:02:00+00:00",
        )
        conn.commit()

        row = conn.execute(
            "SELECT state, error_code, error_message, retryable "
            "FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()
        assert row["state"] == "pending"
        assert row["error_code"] is None
        assert row["error_message"] is None
        assert row["retryable"] == 1
    finally:
        close_connection(db_path)


def test_tailor_success_unblocks_cover_waiting_on_tailor(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "cover",
            "blocked",
            tenant_id=job["tenant_id"],
            error_code="BLOCKED",
            error_message="tailor has not completed.",
        )

        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "running",
            tenant_id=job["tenant_id"],
            started_at="2026-04-29T10:03:00+00:00",
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "succeeded",
            tenant_id=job["tenant_id"],
            finished_at="2026-04-29T10:04:00+00:00",
        )
        conn.commit()

        rows = conn.execute(
            "SELECT stage, state, error_message FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'cover' ORDER BY stage",
            (job["tenant_id"], job["job_id"]),
        ).fetchall()
        assert [(row["stage"], row["state"], row["error_message"]) for row in rows] == [
            ("cover", "pending", None),
        ]
    finally:
        close_connection(db_path)


def test_tailor_success_unblocks_apply_waiting_on_materials(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "apply",
            "blocked",
            tenant_id=job["tenant_id"],
            error_code="BLOCKED",
            error_message="Materials are not ready.",
        )

        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "running",
            tenant_id=job["tenant_id"],
            started_at="2026-04-29T10:03:00+00:00",
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "succeeded",
            tenant_id=job["tenant_id"],
            finished_at="2026-04-29T10:04:00+00:00",
        )
        conn.commit()

        row = conn.execute(
            "SELECT state, error_code, error_message FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()
        assert row["state"] == "pending"
        assert row["error_code"] is None
        assert row["error_message"] is None
    finally:
        close_connection(db_path)


def test_dependency_reconciliation_preserves_unrelated_blockers(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "blocked",
            tenant_id=job["tenant_id"],
            error_code="MIN_SCORE",
            error_message="Fit score is below the tailoring threshold.",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "running",
            tenant_id=job["tenant_id"],
            started_at="2026-04-29T10:01:00+00:00",
        )
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "succeeded",
            tenant_id=job["tenant_id"],
            finished_at="2026-04-29T10:02:00+00:00",
        )
        conn.commit()

        row = conn.execute(
            "SELECT state, error_code, error_message FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()
        assert row["state"] == "blocked"
        assert row["error_code"] == "MIN_SCORE"
        assert row["error_message"] == "Fit score is below the tailoring threshold."
    finally:
        close_connection(db_path)


def test_dependency_reconciliation_repairs_existing_stale_rows(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "score",
            "succeeded",
            tenant_id=job["tenant_id"],
            finished_at="2026-04-29T10:02:00+00:00",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "blocked",
            tenant_id=job["tenant_id"],
            error_code="BLOCKED",
            error_message="score has not completed.",
        )

        repaired = reconcile_dependency_blockers(
            conn,
            tenant_id=job["tenant_id"],
            job_id=job["job_id"],
        )
        conn.commit()

        row = conn.execute(
            "SELECT state, error_message FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()
        assert repaired == 1
        assert row["state"] == "pending"
        assert row["error_message"] is None
    finally:
        close_connection(db_path)


def test_dependency_reconciliation_repairs_existing_apply_material_blocker(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "succeeded",
            tenant_id=job["tenant_id"],
            finished_at="2026-04-29T10:04:00+00:00",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["job_id"],
            "apply",
            "blocked",
            tenant_id=job["tenant_id"],
            error_code="BLOCKED",
            error_message="Materials are not ready.",
        )

        repaired = reconcile_dependency_blockers(
            conn,
            tenant_id=job["tenant_id"],
            job_id=job["job_id"],
        )
        conn.commit()

        row = conn.execute(
            "SELECT state, error_message FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()
        assert repaired == 1
        assert row["state"] == "pending"
        assert row["error_message"] is None
    finally:
        close_connection(db_path)


def test_tailor_exhaustion_blocks_unstarted_dependents_with_exact_reason(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )

        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "exhausted",
            tenant_id=job["tenant_id"],
            attempt_count=5,
            error_code="FAILED_VALIDATION",
            error_message="Tailoring ended with status failed_validation",
            retryable=False,
            validate_transition=False,
        )
        conn.commit()

        rows = conn.execute(
            "SELECT stage, state, error_code, error_message, retryable, "
            "blocked_by_json, next_action FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage IN ('cover', 'apply') "
            "ORDER BY stage",
            (job["tenant_id"], job["job_id"]),
        ).fetchall()
        assert [(row["stage"], row["state"]) for row in rows] == [
            ("apply", "blocked"),
            ("cover", "blocked"),
        ]
        assert {row["error_code"] for row in rows} == {
            "UPSTREAM_TAILOR_EXHAUSTED"
        }
        assert {row["retryable"] for row in rows} == {0}
        assert {row["blocked_by_json"] for row in rows} == {'["tailor"]'}
        assert all("Tailor is exhausted" in row["error_message"] for row in rows)
        assert {row["next_action"] for row in rows} == {
            "Reset Tailor's attempt budget and retry Tailor."
        }
        events = conn.execute(
            "SELECT stage, event_type FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageBlocked' "
            "ORDER BY stage",
            (job["tenant_id"], job["job_id"]),
        ).fetchall()
        assert [(row["stage"], row["event_type"]) for row in events] == [
            ("apply", "StageBlocked"),
            ("cover", "StageBlocked"),
        ]
    finally:
        close_connection(db_path)


def test_tailor_success_clears_only_tailor_owned_terminal_blocks(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "failed",
            tenant_id=job["tenant_id"],
            error_code="FAILED_VALIDATION",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["job_id"],
            "tailor",
            "succeeded",
            tenant_id=job["tenant_id"],
            validate_transition=False,
        )
        conn.commit()

        rows = conn.execute(
            "SELECT stage, state, error_code FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage IN ('cover', 'apply') "
            "ORDER BY stage",
            (job["tenant_id"], job["job_id"]),
        ).fetchall()
        assert [(row["stage"], row["state"], row["error_code"]) for row in rows] == [
            ("apply", "pending", None),
            ("cover", "pending", None),
        ]
    finally:
        close_connection(db_path)


def test_terminal_dependency_reconciliation_preserves_claimed_and_terminal_rows(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        conn.execute(
            "UPDATE job_stage_states SET state = 'exhausted', "
            "error_code = 'FAILED_VALIDATION' "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (job["tenant_id"], job["job_id"]),
        )
        set_stage_state(
            conn,
            job["job_id"],
            "cover",
            "running",
            tenant_id=job["tenant_id"],
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["job_id"],
            "apply",
            "canceled",
            tenant_id=job["tenant_id"],
            validate_transition=False,
        )

        assert (
            reconcile_tailor_terminal_dependents(
                conn,
                tenant_id=job["tenant_id"],
                job_id=job["job_id"],
            )
            == 0
        )
        rows = conn.execute(
            "SELECT stage, state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage IN ('cover', 'apply') "
            "ORDER BY stage",
            (job["tenant_id"], job["job_id"]),
        ).fetchall()
        assert [(row["stage"], row["state"]) for row in rows] == [
            ("apply", "canceled"),
            ("cover", "running"),
        ]
    finally:
        close_connection(db_path)


def test_terminal_dependency_reconciliation_does_not_overwrite_concurrent_claim(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(
            conn,
            job["job_id"],
            tenant_id=job["tenant_id"],
            discovered_at=job["discovered_at"],
        )
        conn.execute(
            "UPDATE job_stage_states SET state = 'exhausted', "
            "error_code = 'FAILED_VALIDATION' "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (job["tenant_id"], job["job_id"]),
        )

        class ClaimBeforeDependentBlock:
            def __init__(self, wrapped):
                self.wrapped = wrapped
                self.injected = False

            def execute(self, sql, parameters=()):
                if "tailor_terminal_dependent_block" in sql and not self.injected:
                    self.injected = True
                    self.wrapped.execute(
                        "UPDATE job_stage_states SET state = 'running', "
                        "metadata_json = '{\"claim\":\"cover-worker\"}' "
                        "WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'",
                        (job["tenant_id"], job["job_id"]),
                    )
                return self.wrapped.execute(sql, parameters)

        interleaved = ClaimBeforeDependentBlock(conn)
        assert (
            reconcile_tailor_terminal_dependents(
                interleaved,
                tenant_id=job["tenant_id"],
                job_id=job["job_id"],
            )
            == 1
        )
        rows = conn.execute(
            "SELECT stage, state, metadata_json FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage IN ('cover', 'apply') "
            "ORDER BY stage",
            (job["tenant_id"], job["job_id"]),
        ).fetchall()
        assert [(row["stage"], row["state"]) for row in rows] == [
            ("apply", "blocked"),
            ("cover", "running"),
        ]
        assert rows[1]["metadata_json"] == '{"claim":"cover-worker"}'
        cover_events = conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? "
            "AND stage = 'cover' AND event_type = 'StageBlocked'",
            (job["tenant_id"], job["job_id"]),
        ).fetchone()[0]
        assert cover_events == 0
    finally:
        close_connection(db_path)
