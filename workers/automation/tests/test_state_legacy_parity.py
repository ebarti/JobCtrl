"""Legacy parity tests — verify the new canonical ``get_job_stage_states``
returns the expected output for representative job scenarios.

These five fixtures cover the main pipeline states that the old legacy
derivation used to produce.  They serve as a safety net confirming that
the explicit ``job_stage_states`` table produces equivalent results when
populated with ``ensure_job_stage_rows`` + ``set_stage_state``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.state import (
    STAGE_ORDER,
    ensure_job_stage_rows,
    get_job_stage_states,
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


@pytest.fixture()
def db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


# ── Scenario 1: Fresh discovery — all downstream pending ───────────────────


def test_freshly_discovered_job(db):
    """A freshly discovered job: discover=succeeded, all others=pending."""
    job = _insert_job(db)
    ensure_job_stage_rows(db, job["url"], discovered_at=job["discovered_at"])
    db.commit()

    states = get_job_stage_states(db, job)
    by_stage = {s["stage"]: s for s in states}

    assert len(states) == 6
    assert by_stage["discover"]["state"] == "succeeded"
    assert by_stage["discover"]["attempt_count"] == 1
    for stage in ("enrich", "score", "tailor", "cover", "apply"):
        assert by_stage[stage]["state"] == "pending"


# ── Scenario 2: Enrichment failed ─────────────────────────────────────────


def test_enrichment_failed(db):
    """After enrichment failure, enrich=failed, score and later stay pending."""
    job = _insert_job(db, detail_error="timeout")
    ensure_job_stage_rows(db, job["url"], discovered_at=job["discovered_at"])
    set_stage_state(
        db,
        job["url"],
        "enrich",
        "failed",
        attempt_count=1,
        error_code="DETAIL_ERROR",
        error_message="timeout",
        retryable=True,
        validate_transition=False,  # fixture setup — skip intermediate states
    )
    db.commit()

    states = get_job_stage_states(db, job)
    by_stage = {s["stage"]: s for s in states}

    assert by_stage["enrich"]["state"] == "failed"
    assert by_stage["enrich"]["error_code"] == "DETAIL_ERROR"
    assert by_stage["enrich"]["retryable"] is True
    assert by_stage["score"]["state"] == "pending"


# ── Scenario 3: Scored but below threshold — tailor/cover/apply skipped


def test_scored_below_threshold(db):
    """Score below threshold: tailor/cover/apply should be set to skipped."""
    job = _insert_job(
        db,
        full_description="Build things.",
        fit_score=3,
    )
    ensure_job_stage_rows(db, job["url"], discovered_at=job["discovered_at"])
    set_stage_state(db, job["url"], "enrich", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "score", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "tailor", "skipped", validate_transition=False)
    set_stage_state(db, job["url"], "cover", "skipped", validate_transition=False)
    set_stage_state(db, job["url"], "apply", "skipped", validate_transition=False)
    db.commit()

    states = get_job_stage_states(db, job)
    by_stage = {s["stage"]: s for s in states}

    assert by_stage["score"]["state"] == "succeeded"
    assert by_stage["tailor"]["state"] == "skipped"
    assert by_stage["cover"]["state"] == "skipped"
    assert by_stage["apply"]["state"] == "skipped"


# ── Scenario 4: Tailored and cover letter done, apply pending ──────────────


def test_tailored_with_cover_apply_pending(db, tmp_path):
    """Full pipeline through cover letter, apply still pending."""
    resume = tmp_path / "resume.txt"
    cover = tmp_path / "cover.txt"
    resume.write_text("tailored", encoding="utf-8")
    cover.write_text("cover", encoding="utf-8")

    job = _insert_job(
        db,
        full_description="Build distributed systems.",
        application_url="https://example.com/apply",
        fit_score=9,
        tailored_resume_path=str(resume),
        cover_letter_path=str(cover),
    )
    ensure_job_stage_rows(db, job["url"], discovered_at=job["discovered_at"])
    set_stage_state(db, job["url"], "enrich", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "score", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "tailor", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "cover", "succeeded", attempt_count=1, validate_transition=False)
    db.commit()

    states = get_job_stage_states(db, job)
    by_stage = {s["stage"]: s for s in states}

    assert by_stage["discover"]["state"] == "succeeded"
    assert by_stage["enrich"]["state"] == "succeeded"
    assert by_stage["score"]["state"] == "succeeded"
    assert by_stage["tailor"]["state"] == "succeeded"
    assert by_stage["cover"]["state"] == "succeeded"
    assert by_stage["apply"]["state"] == "pending"


# ── Scenario 5: Applied successfully ──────────────────────────────────────


def test_applied_successfully(db, tmp_path):
    """All stages succeeded including apply."""
    resume = tmp_path / "resume.txt"
    cover = tmp_path / "cover.txt"
    resume.write_text("tailored", encoding="utf-8")
    cover.write_text("cover", encoding="utf-8")

    job = _insert_job(
        db,
        full_description="Build distributed systems.",
        application_url="https://example.com/apply",
        fit_score=9,
        tailored_resume_path=str(resume),
        cover_letter_path=str(cover),
        apply_status="applied",
        applied_at="2026-05-01T00:10:00+00:00",
    )
    ensure_job_stage_rows(db, job["url"], discovered_at=job["discovered_at"])
    set_stage_state(db, job["url"], "enrich", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "score", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "tailor", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "cover", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job["url"], "apply", "succeeded", attempt_count=1,
                    finished_at="2026-05-01T00:10:00+00:00", validate_transition=False)
    db.commit()

    states = get_job_stage_states(db, job)
    by_stage = {s["stage"]: s for s in states}

    assert all(by_stage[stage]["state"] == "succeeded" for stage in STAGE_ORDER)
    assert by_stage["apply"]["attempt_count"] == 1
