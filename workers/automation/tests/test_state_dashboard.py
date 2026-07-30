from pathlib import Path

from typer.testing import CliRunner

from jobctrl.cli import app
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.state import (
    ensure_job_stage_rows,
    get_job_stage_states,
    get_stage_state_row,
    reconcile_dependency_blockers,
    set_stage_state,
)


def _insert_job(conn, **overrides):
    data = {
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
            url, title, site, strategy, discovered_at, full_description,
            application_url, detail_error, fit_score, tailored_resume_path,
            tailor_attempts, cover_letter_path, cover_attempts, apply_status,
            applied_at
        ) VALUES (
            :url, :title, :site, :strategy, :discovered_at, :full_description,
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        conn.commit()

        # Transition score through proper path: pending -> running -> failed
        set_stage_state(conn, job["url"], "score", "running", started_at="2026-04-29T10:01:00+00:00")
        set_stage_state(
            conn,
            job["url"],
            "score",
            "failed",
            error_code="LLM_ERROR",
            error_message="score failed",
            next_action=f"jobctrl retry score {job['url']}",
        )
        conn.commit()

        states = get_job_stage_states(conn, job)
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        conn.commit()

        states = get_job_stage_states(conn, job)
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
        states = get_job_stage_states(conn, job)
        assert len(states) == 6
        for item in states:
            assert item["state"] == "pending"
            assert item["attempt_count"] == 0
    finally:
        close_connection(db_path)


def test_retry_command_resets_stage_state(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, detail_error="timeout")

    try:
        monkeypatch.setattr("jobctrl.cli.get_connection", lambda: get_connection(db_path), raising=False)
        monkeypatch.setattr("jobctrl.database.DB_PATH", db_path)
        monkeypatch.setattr("jobctrl.config.DB_PATH", db_path)

        result = CliRunner().invoke(app, ["retry", "enrich", "https://example.com/job"])

        row = conn.execute(
            "SELECT detail_error, detail_scraped_at FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = get_stage_state_row(
            conn,
            "https://example.com/job",
            "enrich",
        )
        assert result.exit_code == 0
        assert row["detail_error"] is None
        assert row["detail_scraped_at"] is None
        assert state["state"] == "pending"
    finally:
        close_connection(db_path)


def test_queued_and_canceled_are_valid_states(tmp_path):
    """Verify the new 'queued' and 'canceled' states are accepted by set_stage_state."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(conn, job["url"])
        conn.commit()

        # Set stage to queued (Pending -> Queued is valid)
        set_stage_state(conn, job["url"], "enrich", "queued")
        conn.commit()
        states = get_job_stage_states(conn, job)
        enrich = next(item for item in states if item["stage"] == "enrich")
        assert enrich["state"] == "queued"

        # Set stage to canceled (Queued -> Canceled is valid)
        set_stage_state(conn, job["url"], "enrich", "canceled")
        conn.commit()
        states = get_job_stage_states(conn, job)
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
        ensure_job_stage_rows(conn, job["url"])
        conn.commit()

        import pytest

        # Pending -> Succeeded is NOT a valid transition (must go through Running)
        with pytest.raises(ValueError, match="not allowed"):
            set_stage_state(conn, job["url"], "enrich", "succeeded")

    finally:
        close_connection(db_path)


def test_transition_validation_can_be_bypassed(tmp_path):
    """validate_transition=False allows any state change."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(conn, job["url"])
        conn.commit()

        # Pending -> Succeeded would normally be rejected, but bypass works
        set_stage_state(conn, job["url"], "enrich", "succeeded", validate_transition=False)
        conn.commit()
        states = get_job_stage_states(conn, job)
        enrich = next(item for item in states if item["stage"] == "enrich")
        assert enrich["state"] == "succeeded"
    finally:
        close_connection(db_path)


def test_score_success_unblocks_tailor_waiting_on_score(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    try:
        job = _insert_job(conn)
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        set_stage_state(
            conn,
            job["url"],
            "tailor",
            "blocked",
            error_code="BLOCKED",
            error_message="score has not completed.",
        )

        set_stage_state(conn, job["url"], "score", "running", started_at="2026-04-29T10:01:00+00:00")
        set_stage_state(conn, job["url"], "score", "succeeded", finished_at="2026-04-29T10:02:00+00:00")
        conn.commit()

        row = get_stage_state_row(conn, job["url"], "tailor")
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        set_stage_state(
            conn,
            job["url"],
            "cover",
            "blocked",
            error_code="BLOCKED",
            error_message="tailor has not completed.",
        )

        set_stage_state(conn, job["url"], "tailor", "running", started_at="2026-04-29T10:03:00+00:00")
        set_stage_state(conn, job["url"], "tailor", "succeeded", finished_at="2026-04-29T10:04:00+00:00")
        conn.commit()

        rows = [get_stage_state_row(conn, job["url"], "cover")]
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        set_stage_state(
            conn,
            job["url"],
            "apply",
            "blocked",
            error_code="BLOCKED",
            error_message="Materials are not ready.",
        )

        set_stage_state(conn, job["url"], "tailor", "running", started_at="2026-04-29T10:03:00+00:00")
        set_stage_state(conn, job["url"], "tailor", "succeeded", finished_at="2026-04-29T10:04:00+00:00")
        conn.commit()

        row = get_stage_state_row(conn, job["url"], "apply")
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        set_stage_state(
            conn,
            job["url"],
            "tailor",
            "blocked",
            error_code="MIN_SCORE",
            error_message="Fit score is below the tailoring threshold.",
            validate_transition=False,
        )
        set_stage_state(conn, job["url"], "score", "running", started_at="2026-04-29T10:01:00+00:00")
        set_stage_state(conn, job["url"], "score", "succeeded", finished_at="2026-04-29T10:02:00+00:00")
        conn.commit()

        row = get_stage_state_row(conn, job["url"], "tailor")
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        set_stage_state(
            conn,
            job["url"],
            "score",
            "succeeded",
            finished_at="2026-04-29T10:02:00+00:00",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["url"],
            "tailor",
            "blocked",
            error_code="BLOCKED",
            error_message="score has not completed.",
        )

        repaired = reconcile_dependency_blockers(conn)
        conn.commit()

        row = get_stage_state_row(conn, job["url"], "tailor")
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
        ensure_job_stage_rows(conn, job["url"], discovered_at=job["discovered_at"])
        set_stage_state(
            conn,
            job["url"],
            "tailor",
            "succeeded",
            finished_at="2026-04-29T10:04:00+00:00",
            validate_transition=False,
        )
        set_stage_state(
            conn,
            job["url"],
            "apply",
            "blocked",
            error_code="BLOCKED",
            error_message="Materials are not ready.",
        )

        repaired = reconcile_dependency_blockers(conn)
        conn.commit()

        row = get_stage_state_row(conn, job["url"], "apply")
        assert repaired == 1
        assert row["state"] == "pending"
        assert row["error_message"] is None
    finally:
        close_connection(db_path)
