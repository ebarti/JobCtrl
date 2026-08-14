from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.state import (
    ensure_job_stage_rows,
    reconcile_all_score_threshold_skips,
    reconcile_score_eligibility_blockers,
    reconcile_score_threshold_skips,
    set_stage_state,
)

_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_ID = canonical_job_id("00000000-0000-4000-8000-000000000001")


@pytest.fixture()
def conn() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return candidate


def _seed_scored_job(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    url: str,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, full_description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            url,
            "Engineer",
            "Acme",
            "Need Python.",
            "2024-01-01T00:00:00+00:00",
        ),
    )
    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at="2024-01-01T00:00:00+00:00",
    )
    set_stage_state(
        conn,
        job_id,
        "enrich",
        "succeeded",
        tenant_id=tenant_id,
        validate_transition=False,
    )
    set_stage_state(
        conn,
        job_id,
        "score",
        "succeeded",
        tenant_id=tenant_id,
        validate_transition=False,
    )
    conn.commit()


def _stage_rows(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> dict[str, sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT stage, state, error_code, error_message, retryable, blocked_by_json,
               next_action, metadata_json
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(tenant_id), str(job_id)),
    ).fetchall()
    return {str(row["stage"]): row for row in rows}


def test_salary_preference_never_blocks_actionable_downstream_stages(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/blocked"
    _seed_scored_job(conn, tenant_id=_TENANT_A, job_id=_JOB_ID, url=url)

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["posted compensation appears below profile minimum"],
        now="2024-01-02T00:00:00+00:00",
    )

    assert changed == 0
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    for stage in ("tailor", "cover", "apply"):
        assert rows[stage]["state"] == "pending"
        assert rows[stage]["error_code"] is None


def test_salary_reason_is_demoted_but_other_hard_blockers_still_block(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/mixed-blockers",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=[
            "posted compensation appears below profile minimum",
            "candidate requires sponsorship",
        ],
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "blocked"
    assert "candidate requires sponsorship" in rows["tailor"]["error_message"]
    assert "compensation" not in rows["tailor"]["error_message"]


def test_combined_salary_and_sponsorship_reason_remains_blocking(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/combined-blocker",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["Compensation is below range and visa sponsorship is unavailable."],
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "blocked"
    assert "visa sponsorship" in rows["tailor"]["error_message"]


@pytest.mark.parametrize(
    ("reason", "expected_actionable"),
    (
        (
            "Salary is below target and German proficiency is required.",
            "German proficiency is required",
        ),
        (
            "Salary is below target and posting matches excluded criterion: gambling.",
            "posting matches excluded criterion: gambling",
        ),
        (
            "Salary is below target / German proficiency is required.",
            "German proficiency is required",
        ),
        (
            "Salary is below target: posting matches excluded criterion: gambling.",
            "posting matches excluded criterion: gambling",
        ),
        (
            "Salary is below target — German proficiency is required.",
            "German proficiency is required",
        ),
        (
            "Salary is below target\nGerman proficiency is required.",
            "German proficiency is required",
        ),
    ),
)
def test_combined_salary_reason_preserves_non_compensation_clause(
    conn: sqlite3.Connection,
    reason: str,
    expected_actionable: str,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/combined-clause",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=[reason],
    )

    assert changed == 3
    row = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)["tailor"]
    assert row["state"] == "blocked"
    assert expected_actionable in row["error_message"]


def test_score_eligibility_clear_restores_dependency_states(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job/cleared"
    _seed_scored_job(conn, tenant_id=_TENANT_A, job_id=_JOB_ID, url=url)
    reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["candidate requires sponsorship"],
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="eligible",
        hard_blockers=[],
        now="2024-01-03T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "pending"
    assert rows["tailor"]["error_code"] is None
    assert rows["cover"]["state"] == "blocked"
    assert rows["cover"]["error_message"] == "tailor has not completed."
    assert rows["apply"]["state"] == "blocked"
    assert rows["apply"]["error_message"] == "Materials are not ready."


def test_score_threshold_skip_is_explicit_idempotent_and_reversible(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/below-threshold",
    )

    changed = reconcile_score_threshold_skips(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        fit_score=6,
        min_score=7,
        now="2024-01-02T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    for stage in ("tailor", "cover", "apply"):
        assert rows[stage]["state"] == "skipped"
        assert rows[stage]["error_code"] == "MIN_SCORE"
        assert rows[stage]["error_message"] == (
            "Fit score 6/10 is below the materials threshold 7/10."
        )
        assert rows[stage]["retryable"] == 0
        assert rows[stage]["next_action"] == (
            "Lower the materials threshold or record a higher current score."
        )
        assert '"reason": "score_below_threshold"' in rows[stage]["metadata_json"]

    assert (
        reconcile_score_threshold_skips(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=6,
            min_score=7,
            now="2024-01-02T00:00:00+00:00",
        )
        == 0
    )
    event_count = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageSkipped'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    assert event_count == 3

    assert (
        reconcile_score_eligibility_blockers(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            eligibility_status="blocked",
            hard_blockers=["required work authorization is missing"],
            now="2024-01-02T12:00:00+00:00",
        )
        == 3
    )
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert {rows[stage]["state"] for stage in ("tailor", "cover", "apply")} == {
        "blocked"
    }
    assert {
        rows[stage]["error_code"] for stage in ("tailor", "cover", "apply")
    } == {"SCORE_ELIGIBILITY_BLOCKED"}

    assert (
        reconcile_score_eligibility_blockers(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            eligibility_status="eligible",
            hard_blockers=[],
            now="2024-01-02T18:00:00+00:00",
        )
        == 3
    )
    assert (
        reconcile_score_threshold_skips(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=6,
            min_score=7,
            now="2024-01-02T18:00:00+00:00",
        )
        == 3
    )

    assert (
        reconcile_score_threshold_skips(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=6,
            min_score=6,
            now="2024-01-03T00:00:00+00:00",
        )
        == 3
    )
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "pending"
    assert rows["tailor"]["error_code"] is None
    assert rows["cover"]["state"] == "blocked"
    assert rows["cover"]["error_message"] == "tailor has not completed."
    assert rows["apply"]["state"] == "blocked"
    assert rows["apply"]["error_message"] == "Materials are not ready."


def test_batch_score_threshold_reconciliation_uses_latest_current_score(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/current-below-threshold",
    )
    conn.executemany(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, ?, ?, ?, '[]', ?)
        """,
        [
            (
                str(_TENANT_A),
                str(_JOB_ID),
                1,
                9,
                '{"eligibility":{"status":"eligible","hard_blockers":[]}}',
                "2024-01-01T00:00:00+00:00",
            ),
            (
                str(_TENANT_A),
                str(_JOB_ID),
                2,
                5,
                '{"eligibility":{"status":"warning","hard_blockers":[]}}',
                "2024-01-02T00:00:00+00:00",
            ),
        ],
    )
    conn.commit()

    changed = reconcile_all_score_threshold_skips(
        conn,
        tenant_id=_TENANT_A,
        min_score=7,
        now="2024-01-03T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert {rows[stage]["state"] for stage in ("tailor", "cover", "apply")} == {
        "skipped"
    }
    assert {
        rows[stage]["error_code"] for stage in ("tailor", "cover", "apply")
    } == {"MIN_SCORE"}


def test_score_threshold_skip_preserves_owned_work_and_unrelated_failures(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/preserved-stage-owners",
    )
    set_stage_state(
        conn,
        _JOB_ID,
        "tailor",
        "blocked",
        tenant_id=_TENANT_A,
        error_code="REQUIREMENT_FIT_STALE",
        error_message="Scoring must refresh requirement-fit evidence.",
        validate_transition=False,
    )
    set_stage_state(
        conn,
        _JOB_ID,
        "cover",
        "queued",
        tenant_id=_TENANT_A,
        validate_transition=False,
    )

    assert (
        reconcile_score_threshold_skips(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=5,
            min_score=7,
            now="2024-01-04T00:00:00+00:00",
        )
        == 1
    )
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert (rows["tailor"]["state"], rows["tailor"]["error_code"]) == (
        "blocked",
        "REQUIREMENT_FIT_STALE",
    )
    assert rows["cover"]["state"] == "queued"
    assert (rows["apply"]["state"], rows["apply"]["error_code"]) == (
        "skipped",
        "MIN_SCORE",
    )


def test_score_threshold_skip_replaces_stale_tailor_dependency_blocks(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/old-tailor-failure-now-below-threshold",
    )
    for stage, code in (
        ("cover", "UPSTREAM_TAILOR_FAILED"),
        ("apply", "UPSTREAM_TAILOR_EXHAUSTED"),
    ):
        set_stage_state(
            conn,
            _JOB_ID,
            stage,
            "blocked",
            tenant_id=_TENANT_A,
            error_code=code,
            error_message="Tailor previously failed.",
            blocked_by=["tailor"],
            validate_transition=False,
        )

    changed = reconcile_score_threshold_skips(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        fit_score=5,
        min_score=7,
        now="2024-01-04T00:00:00+00:00",
    )

    assert changed == 3
    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    for stage in ("tailor", "cover", "apply"):
        assert rows[stage]["state"] == "skipped"
        assert rows[stage]["error_code"] == "MIN_SCORE"
        assert rows[stage]["blocked_by_json"] is None


def test_score_threshold_skip_does_not_overwrite_a_concurrent_claim(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/concurrent-tailor-claim",
    )

    class ClaimBeforeThresholdUpdate:
        def __init__(self, wrapped: sqlite3.Connection) -> None:
            self.wrapped = wrapped
            self.injected = False

        def execute(self, sql: str, parameters=()):
            if "score_threshold_skip" in sql and not self.injected:
                self.injected = True
                self.wrapped.execute(
                    """
                    UPDATE job_stage_states
                       SET state = 'running', error_code = NULL,
                           error_message = NULL, retryable = 1
                     WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
                    """,
                    (str(_TENANT_A), str(_JOB_ID)),
                )
            return self.wrapped.execute(sql, parameters)

    interleaved = ClaimBeforeThresholdUpdate(conn)
    assert (
        reconcile_score_threshold_skips(
            interleaved,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=5,
            min_score=7,
            now="2024-01-05T00:00:00+00:00",
        )
        == 2
    )

    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "running"
    assert rows["tailor"]["error_code"] is None
    assert {rows[stage]["state"] for stage in ("cover", "apply")} == {"skipped"}
    tailor_skip_events = conn.execute(
        """
        SELECT COUNT(*)
          FROM job_events
         WHERE tenant_id = ? AND job_id = ?
           AND stage = 'tailor' AND event_type = 'StageSkipped'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    assert tailor_skip_events == 0


def test_score_threshold_clear_does_not_overwrite_a_concurrent_claim(
    conn: sqlite3.Connection,
) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/concurrent-tailor-claim-on-clear",
    )
    assert (
        reconcile_score_threshold_skips(
            conn,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=5,
            min_score=7,
            now="2024-01-05T00:00:00+00:00",
        )
        == 3
    )

    class ClaimBeforeThresholdClear:
        def __init__(self, wrapped: sqlite3.Connection) -> None:
            self.wrapped = wrapped
            self.injected = False

        def execute(self, sql: str, parameters=()):
            if "score_threshold_clear" in sql and not self.injected:
                self.injected = True
                self.wrapped.execute(
                    """
                    UPDATE job_stage_states
                       SET state = 'running', attempt_count = 1,
                           error_code = NULL, error_message = NULL,
                           retryable = 1, metadata_json = '{"claim":"manual"}'
                     WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
                    """,
                    (str(_TENANT_A), str(_JOB_ID)),
                )
            return self.wrapped.execute(sql, parameters)

    interleaved = ClaimBeforeThresholdClear(conn)
    assert (
        reconcile_score_threshold_skips(
            interleaved,
            tenant_id=_TENANT_A,
            job_id=_JOB_ID,
            fit_score=7,
            min_score=7,
            now="2024-01-06T00:00:00+00:00",
        )
        == 2
    )

    rows = _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)
    assert rows["tailor"]["state"] == "running"
    assert rows["tailor"]["error_code"] is None
    assert rows["tailor"]["metadata_json"] == '{"claim":"manual"}'
    assert rows["cover"]["state"] == "blocked"
    assert rows["apply"]["state"] == "blocked"
    tailor_reset_events = conn.execute(
        """
        SELECT COUNT(*)
          FROM job_events
         WHERE tenant_id = ? AND job_id = ?
           AND stage = 'tailor' AND event_type = 'StageReset'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    assert tailor_reset_events == 0


def test_score_eligibility_blockers_are_tenant_scoped(conn: sqlite3.Connection) -> None:
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        url="https://example.com/job/tenant-a",
    )
    _seed_scored_job(
        conn,
        tenant_id=_TENANT_B,
        job_id=_JOB_ID,
        url="https://example.com/job/tenant-b",
    )

    changed = reconcile_score_eligibility_blockers(
        conn,
        tenant_id=_TENANT_A,
        job_id=_JOB_ID,
        eligibility_status="blocked",
        hard_blockers=["candidate requires sponsorship"],
    )

    assert changed == 3
    assert _stage_rows(conn, tenant_id=_TENANT_A, job_id=_JOB_ID)["tailor"]["state"] == "blocked"
    assert _stage_rows(conn, tenant_id=_TENANT_B, job_id=_JOB_ID)["tailor"]["state"] == "pending"
