"""Exact-v7 regression coverage for canonical per-job stage state."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.state import (
    STAGE_ORDER,
    ensure_job_stage_rows,
    get_job_stage_states,
    set_stage_state,
)

JOB_ID = JobId("10000000-0000-4000-8000-000000000001")
OTHER_TENANT = TenantId("other")
DISCOVERED_AT = "2026-04-29T10:00:00+00:00"


def _insert_job(
    conn,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    job_id: JobId = JOB_ID,
) -> JobId:
    data = {
        "tenant_id": str(tenant_id),
        "job_id": str(job_id),
        "url": f"https://example.com/{tenant_id}/job",
        "title": "Platform Engineer",
        "site": "ExampleCo",
        "strategy": "test",
        "discovered_at": DISCOVERED_AT,
    }
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site, strategy, discovered_at
        ) VALUES (
            :tenant_id, :job_id, :url, :title, :site, :strategy, :discovered_at
        )
        """,
        data,
    )
    conn.commit()
    return job_id


@pytest.fixture()
def db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


# ── Scenario 1: Fresh discovery — all downstream pending ───────────────────


def test_freshly_discovered_job(db):
    """A freshly discovered job: discover=succeeded, all others=pending."""
    job_id = _insert_job(db)
    ensure_job_stage_rows(db, job_id, discovered_at=DISCOVERED_AT)
    db.commit()

    states = get_job_stage_states(db, job_id)
    by_stage = {s["stage"]: s for s in states}

    assert len(states) == 6
    assert by_stage["discover"]["state"] == "succeeded"
    assert by_stage["discover"]["attempt_count"] == 1
    for stage in ("enrich", "score", "tailor", "cover", "apply"):
        assert by_stage[stage]["state"] == "pending"


# ── Scenario 2: Enrichment failed ─────────────────────────────────────────


def test_enrichment_failed(db):
    """After enrichment failure, enrich=failed, score and later stay pending."""
    job_id = _insert_job(db)
    ensure_job_stage_rows(db, job_id, discovered_at=DISCOVERED_AT)
    set_stage_state(
        db,
        job_id,
        "enrich",
        "failed",
        attempt_count=1,
        error_code="DETAIL_ERROR",
        error_message="timeout",
        retryable=True,
        validate_transition=False,  # fixture setup — skip intermediate states
    )
    db.commit()

    states = get_job_stage_states(db, job_id)
    by_stage = {s["stage"]: s for s in states}

    assert by_stage["enrich"]["state"] == "failed"
    assert by_stage["enrich"]["error_code"] == "DETAIL_ERROR"
    assert by_stage["enrich"]["retryable"] is True
    assert by_stage["score"]["state"] == "pending"


# ── Scenario 3: Scored but below threshold — tailor/cover/apply skipped


def test_scored_below_threshold(db):
    """Score below threshold: tailor/cover/apply should be set to skipped."""
    job_id = _insert_job(db)
    ensure_job_stage_rows(db, job_id, discovered_at=DISCOVERED_AT)
    set_stage_state(db, job_id, "enrich", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "score", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "tailor", "skipped", validate_transition=False)
    set_stage_state(db, job_id, "cover", "skipped", validate_transition=False)
    set_stage_state(db, job_id, "apply", "skipped", validate_transition=False)
    db.commit()

    states = get_job_stage_states(db, job_id)
    by_stage = {s["stage"]: s for s in states}

    assert by_stage["score"]["state"] == "succeeded"
    assert by_stage["tailor"]["state"] == "skipped"
    assert by_stage["cover"]["state"] == "skipped"
    assert by_stage["apply"]["state"] == "skipped"


# ── Scenario 4: Tailored and cover letter done, apply pending ──────────────


def test_tailored_with_cover_apply_pending(db):
    """Full pipeline through cover letter, apply still pending."""
    job_id = _insert_job(db)
    ensure_job_stage_rows(db, job_id, discovered_at=DISCOVERED_AT)
    set_stage_state(db, job_id, "enrich", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "score", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "tailor", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "cover", "succeeded", attempt_count=1, validate_transition=False)
    db.commit()

    states = get_job_stage_states(db, job_id)
    by_stage = {s["stage"]: s for s in states}

    assert by_stage["discover"]["state"] == "succeeded"
    assert by_stage["enrich"]["state"] == "succeeded"
    assert by_stage["score"]["state"] == "succeeded"
    assert by_stage["tailor"]["state"] == "succeeded"
    assert by_stage["cover"]["state"] == "succeeded"
    assert by_stage["apply"]["state"] == "pending"


# ── Scenario 5: Applied successfully ──────────────────────────────────────


def test_applied_successfully(db):
    """All stages succeeded including apply."""
    job_id = _insert_job(db)
    ensure_job_stage_rows(db, job_id, discovered_at=DISCOVERED_AT)
    set_stage_state(db, job_id, "enrich", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "score", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "tailor", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(db, job_id, "cover", "succeeded", attempt_count=1, validate_transition=False)
    set_stage_state(
        db,
        job_id,
        "apply",
        "succeeded",
        attempt_count=1,
        finished_at="2026-05-01T00:10:00+00:00",
        validate_transition=False,
    )
    db.commit()

    states = get_job_stage_states(db, job_id)
    by_stage = {s["stage"]: s for s in states}

    assert all(by_stage[stage]["state"] == "succeeded" for stage in STAGE_ORDER)
    assert by_stage["apply"]["attempt_count"] == 1


def test_stage_reads_are_tenant_scoped(db):
    """The same JobId in another tenant must not leak into local state."""
    local_job_id = _insert_job(db)
    _insert_job(db, tenant_id=OTHER_TENANT)
    ensure_job_stage_rows(db, local_job_id, discovered_at=DISCOVERED_AT)
    ensure_job_stage_rows(
        db,
        local_job_id,
        tenant_id=OTHER_TENANT,
        discovered_at=DISCOVERED_AT,
    )
    set_stage_state(
        db,
        local_job_id,
        "score",
        "failed",
        tenant_id=OTHER_TENANT,
        validate_transition=False,
    )
    db.commit()

    local_states = get_job_stage_states(db, local_job_id)
    other_states = get_job_stage_states(db, local_job_id, tenant_id=OTHER_TENANT)

    assert {state["state"] for state in local_states if state["stage"] == "score"} == {"pending"}
    assert {state["state"] for state in other_states if state["stage"] == "score"} == {"failed"}
