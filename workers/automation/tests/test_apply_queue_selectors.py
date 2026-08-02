"""PR 4 of the Temporal stack: ``database.get_jobs_by_stage``
``pending_apply`` / ``applied`` selectors and ``get_stats`` see new
apply lifecycle writes (sourced from ``job_events`` →
``apply_run_projections``). The bespoke ``apply_runs`` table is gone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobctrl.database import (
    close_connection,
    count_ready_to_apply,
    get_connection,
    get_jobs_by_stage,
    get_stats,
    init_db,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials import SqliteMaterialsRepository
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state, utc_now


@pytest.fixture()
def conn(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    yield get_connection(db_path)
    close_connection(db_path)


def _insert_apply_ready_job(
    conn,
    *,
    url: str = "https://example.com/job",
    application_url: str | None = "https://example.com/apply",
) -> JobId:
    job_id = canonical_job_id("90000000-0000-4000-8000-000000000999")
    _insert_canonical_apply_job(
        conn,
        job_id=job_id,
        posting_url=url,
        application_url=application_url,
        with_pdf=True,
    )
    return job_id


def _selector_job_id(number: int) -> JobId:
    return canonical_job_id(f"90000000-0000-4000-8000-{number:012d}")


def _insert_selector_apply_ready_job(
    conn,
    *,
    job_id: JobId,
    posting_url: str = "https://example.com/job",
    application_url: str | None = "https://example.com/apply",
) -> None:
    _insert_canonical_apply_job(
        conn,
        job_id=job_id,
        posting_url=posting_url,
        application_url=application_url,
        with_pdf=True,
    )


def _mark_selector_closed(conn, job_id: JobId, state: str = "removed") -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES (?, ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (str(LOCAL_TENANT), str(job_id), state, utc_now()),
    )
    conn.commit()


def _make_resume_artifact(path: str = "/tmp/resume.txt") -> Artifact:
    return Artifact.create(
        type=ArtifactType.TAILORED_RESUME,
        path=path,
        created_at="2024-01-02T00:00:00+00:00",
        render_format=RenderFormat.TEXT,
    )


def _make_resume_pdf_artifact(path: str = "/tmp/resume.pdf") -> Artifact:
    return Artifact.create(
        type=ArtifactType.RESUME_PDF,
        path=path,
        created_at="2024-01-02T01:00:00+00:00",
        render_format=RenderFormat.LATEX_PDF,
    )


def _insert_canonical_apply_job(
    conn,
    *,
    job_id: JobId,
    posting_url: str = "https://example.com/canonical-job",
    application_url: str | None = "https://example.com/apply",
    with_pdf: bool,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, site
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            posting_url,
            "Eng",
            "ExampleCo",
        ),
    )
    now = "2024-01-01T00:00:00+00:00"
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier,
            attempts_json, updated_at
        ) VALUES (?, ?, 'enriched', ?, ?, ?, 'fixture', '[]', ?)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            "Build distributed systems.",
            application_url,
            now,
            now,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, ?, 1, 9, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            json.dumps(
                {
                    "reasoning": "Strong canonical fixture match.",
                    "eligibility": {
                        "status": "eligible",
                        "hard_blockers": [],
                        "warnings": [],
                    },
                },
                sort_keys=True,
            ),
            now,
        ),
    )
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        _make_resume_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    if with_pdf:
        materials = materials.with_resume_pdf(
            _make_resume_pdf_artifact(),
            updated_at="2024-01-02T01:00:00+00:00",
        )
    SqliteMaterialsRepository(conn).save(materials)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "score",
        "succeeded",
        finished_at=now,
        validate_transition=False,
    )
    conn.commit()


def _insert_blocked_score(conn, job_id: JobId, *, fit_score: int = 9) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, ?, 2, ?, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            fit_score,
            json.dumps(
                {
                    "reasoning": "Strong match with a hard blocker.",
                    "eligibility": {
                        "status": "blocked",
                        "hard_blockers": ["Requires sponsorship."],
                        "warnings": [],
                    },
                },
                sort_keys=True,
            ),
            "2026-05-14T00:00:00+00:00",
        ),
    )
    conn.commit()


def _insert_active_score_staleness_marker(conn, job_id: JobId) -> None:
    conn.execute(
        """
        INSERT INTO job_score_staleness (
            tenant_id, job_id, stale_reason,
            old_policy_id, old_policy_version,
            new_policy_id, new_policy_version,
            marked_at, resolved, resolved_at, resolved_by_score_version
        ) VALUES (?, ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
                  'local:scoring-policy-v2', 2, '2026-05-19T00:00:00+00:00', 0, NULL, NULL)
        """,
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()


def _emit_started(conn, job_id: JobId, run_id: str, *, when: str = "t0") -> None:
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        payload={"run_id": run_id, "started_at": when},
    )


def _emit_succeeded(conn, job_id: JobId, run_id: str, *, when: str = "t9") -> None:
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationSubmitted",
        payload={"run_id": run_id, "finished_at": when, "result": "applied"},
    )


def _emit_failed(conn, job_id: JobId, run_id: str, *, when: str = "t9") -> None:
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationFailed",
        payload={"run_id": run_id, "finished_at": when, "result": "failed"},
    )


def test_pending_apply_includes_jobs_with_no_apply_run(conn):
    job_id = _selector_job_id(1)
    _insert_selector_apply_ready_job(conn, job_id=job_id)

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)

    assert [
        (row["tenant_id"], row["job_id"], row["url"])
        for row in rows
    ] == [(str(LOCAL_TENANT), str(job_id), "https://example.com/job")]


def test_pending_apply_can_start_from_posting_url_when_direct_apply_url_missing(conn):
    job_id = _selector_job_id(2)
    posting_url = "https://example.com/posting-only"
    _insert_selector_apply_ready_job(
        conn,
        job_id=job_id,
        posting_url=posting_url,
        application_url=None,
    )

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)

    assert [
        (row["tenant_id"], row["job_id"], row["url"])
        for row in rows
    ] == [(str(LOCAL_TENANT), str(job_id), posting_url)]
    assert count_ready_to_apply(conn, min_score=7) == 1
    assert (
        count_ready_to_apply(
            conn,
            min_score=7,
            target_url=posting_url,
        )
        == 1
    )


def test_pending_apply_excludes_canonical_text_only_resume(conn):
    job_id = _selector_job_id(3)
    posting_url = "https://example.com/canonical-text-only"
    _insert_canonical_apply_job(
        conn,
        job_id=job_id,
        posting_url=posting_url,
        with_pdf=False,
    )

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)

    assert {row["url"] for row in rows} == set()
    assert count_ready_to_apply(conn, min_score=7) == 0
    assert count_ready_to_apply(conn, min_score=7, target_url=posting_url) == 0
    assert get_stats(conn)["ready_to_apply"] == 0


def test_pending_apply_includes_canonical_resume_with_pdf(conn):
    job_id = _selector_job_id(4)
    posting_url = "https://example.com/canonical-with-pdf"
    _insert_canonical_apply_job(
        conn,
        job_id=job_id,
        posting_url=posting_url,
        with_pdf=True,
    )

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)

    assert [
        (row["tenant_id"], row["job_id"], row["url"])
        for row in rows
    ] == [(str(LOCAL_TENANT), str(job_id), posting_url)]
    assert rows[0]["tailored_resume_path"] == "/tmp/resume.txt"
    assert rows[0]["jm_resume_pdf_path"] == "/tmp/resume.pdf"
    assert count_ready_to_apply(conn, min_score=7) == 1
    assert count_ready_to_apply(conn, min_score=7, target_url=posting_url) == 1
    assert get_stats(conn)["ready_to_apply"] == 1


def test_pending_apply_excludes_high_score_blocked_jobs(conn):
    allowed_job_id = _selector_job_id(5)
    blocked_job_id = _selector_job_id(6)
    _insert_selector_apply_ready_job(
        conn,
        job_id=allowed_job_id,
        posting_url="https://example.com/allowed",
    )
    _insert_selector_apply_ready_job(
        conn,
        job_id=blocked_job_id,
        posting_url="https://example.com/blocked",
    )
    _insert_blocked_score(conn, blocked_job_id, fit_score=10)

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    identities = {(row["tenant_id"], row["job_id"]) for row in rows}
    assert (str(LOCAL_TENANT), str(allowed_job_id)) in identities
    assert (str(LOCAL_TENANT), str(blocked_job_id)) not in identities


@pytest.mark.parametrize(
    ("score_state", "active_marker"),
    [
        ("stale", True),
        ("pending", False),
        ("succeeded", True),
    ],
)
def test_pending_apply_excludes_non_current_scores(conn, score_state: str, active_marker: bool):
    job_id = _selector_job_id(7)
    posting_url = f"https://example.com/non-current-apply-{score_state}-{active_marker}"
    _insert_selector_apply_ready_job(conn, job_id=job_id, posting_url=posting_url)
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    set_stage_state(
        conn,
        job_id,
        "score",
        score_state,
        tenant_id=LOCAL_TENANT,
        validate_transition=False,
    )
    if active_marker:
        _insert_active_score_staleness_marker(conn, job_id)

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    identities = {(row["tenant_id"], row["job_id"]) for row in rows}
    assert (str(LOCAL_TENANT), str(job_id)) not in identities


def test_pending_apply_excludes_closed_postings(conn):
    job_id = _selector_job_id(8)
    posting_url = "https://example.com/closed-apply"
    _insert_selector_apply_ready_job(conn, job_id=job_id, posting_url=posting_url)
    _mark_selector_closed(conn, job_id)

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    identities = {(row["tenant_id"], row["job_id"]) for row in rows}
    assert (str(LOCAL_TENANT), str(job_id)) not in identities
    assert count_ready_to_apply(conn, min_score=7) == 0
    assert count_ready_to_apply(conn, min_score=7, target_url=posting_url) == 0
    assert get_stats(conn)["ready_to_apply"] == 0


def test_pending_apply_excludes_jobs_with_succeeded_apply_run(conn):
    job_id = _insert_apply_ready_job(conn)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "succeeded",
        finished_at="t9",
        validate_transition=False,
    )
    _emit_started(conn, job_id, "run-1")
    _emit_succeeded(conn, job_id, "run-1")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    pending = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    applied = get_jobs_by_stage(conn, "applied")
    assert pending == []
    assert len(applied) == 1
    assert applied[0]["url"] == "https://example.com/job"


def test_applied_selector_excludes_closed_postings(conn):
    url = "https://example.com/closed-applied"
    job_id = _insert_apply_ready_job(conn, url=url)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "succeeded",
        finished_at="t9",
        validate_transition=False,
    )
    _emit_started(conn, job_id, "closed-run")
    _emit_succeeded(conn, job_id, "closed-run")
    _mark_selector_closed(conn, job_id)
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    assert get_jobs_by_stage(conn, "pending_apply", min_score=7) == []
    assert get_jobs_by_stage(conn, "applied") == []
    assert get_stats(conn)["applied"] == 0


def test_closed_apply_failures_are_excluded_from_stats(conn):
    url = "https://example.com/closed-apply-error"
    job_id = _insert_apply_ready_job(conn, url=url)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "failed",
        finished_at="t9",
        validate_transition=False,
    )
    _emit_started(conn, job_id, "closed-failed-run")
    _emit_failed(conn, job_id, "closed-failed-run")
    _mark_selector_closed(conn, job_id)
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    assert get_stats(conn)["apply_errors"] == 0


def test_pending_apply_excludes_jobs_with_in_progress_apply_run(conn):
    job_id = _insert_apply_ready_job(conn)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(conn, job_id, "apply", "running", started_at="t0")
    _emit_started(conn, job_id, "run-2")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    pending = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    assert pending == []


def test_pending_apply_includes_jobs_with_failed_apply_run(conn):
    """A failed run leaves the job re-queued (the eligibility checker
    enforces the per-attempt cap; the SQL selector only checks for an
    ACTIVE lock and the canonical attempts counter)."""
    job_id = _insert_apply_ready_job(conn)
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "failed",
        finished_at="t9",
        attempt_count=1,
        validate_transition=False,
    )
    _emit_started(conn, job_id, "run-3")
    _emit_failed(conn, job_id, "run-3")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    pending = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    assert len(pending) == 1


def test_get_stats_reflects_apply_run_projections(conn):
    job_id = _insert_apply_ready_job(conn)
    stats = get_stats(conn)
    assert stats["applied"] == 0
    assert stats["ready_to_apply"] == 1

    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "succeeded",
        finished_at="t9",
        validate_transition=False,
    )
    _emit_started(conn, job_id, "run-stats")
    _emit_succeeded(conn, job_id, "run-stats")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    stats_after = get_stats(conn)
    assert stats_after["applied"] == 1
    assert stats_after["ready_to_apply"] == 0


def test_apply_join_tie_breaks_by_run_id_on_same_started_at(conn):
    """When two ``apply_run_projections`` rows share an identical
    ``started_at`` (same-second collisions), the join must
    deterministically return ONE parent ``jobs`` row — the previous
    MAX(started_at) GROUP BY pattern duplicated the parent."""
    job_id = _insert_apply_ready_job(conn, url="https://example.com/job-tied")
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "failed",
        finished_at="2026-05-01T00:00:02+00:00",
        attempt_count=2,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        payload={"run_id": "run-aaaa", "started_at": "2026-05-01T00:00:00+00:00"},
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationFailed",
        payload={
            "run_id": "run-aaaa",
            "finished_at": "2026-05-01T00:00:01+00:00",
            "result": "failed",
        },
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        payload={"run_id": "run-bbbb", "started_at": "2026-05-01T00:00:00+00:00"},
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationFailed",
        payload={
            "run_id": "run-bbbb",
            "finished_at": "2026-05-01T00:00:02+00:00",
            "result": "failed",
        },
    )
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    matching = [r for r in rows if r["url"] == "https://example.com/job-tied"]
    assert len(matching) == 1
    assert matching[0]["apply_status"] == "failed"
    assert matching[0]["apply_task_id"] == "run-bbbb"


def test_pending_apply_promotes_apply_status_into_row_dict(conn):
    """``get_jobs_by_stage`` promotes the projection's status into the
    legacy ``apply_status`` slot so consumers that still read
    ``row["apply_status"]`` see canonical values."""
    job_id = _insert_apply_ready_job(conn, url="https://example.com/job-with-fail")
    ensure_job_stage_rows(conn, job_id)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "failed",
        finished_at="t9",
        attempt_count=1,
        validate_transition=False,
    )
    _emit_started(conn, job_id, "run-fail")
    _emit_failed(conn, job_id, "run-fail")
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = get_jobs_by_stage(conn, "pending_apply", min_score=7)
    matching = [r for r in rows if r["url"] == "https://example.com/job-with-fail"]
    assert len(matching) == 1
    assert matching[0]["apply_status"] == "failed"
