"""Contract tests for deterministic v7 dashboard row serialization."""

from __future__ import annotations

import json
import sqlite3

import pytest

from jobctrl.infrastructure.migrations import (
    v6_to_v7_job_detail_projections as job_details,
)
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v7_dashboard_projection_rows import (
    DASHBOARD_PROJECTIONS_COLUMNS,
    CandidateDashboardProjectionsError,
    _projection_rows,
)
from jobctrl.infrastructure.migrations.v7_job_list_projection_rows import (
    JOB_LIST_PROJECTIONS_COLUMNS,
    _projection_rows as job_list_projection_rows,
)

_MIGRATION_AT = "2026-07-31T09:00:00+00:00"
_INERT_CONTEXT = '{"userContext":"Attack vectors:\\nPrompt injection"}'
_JOB_IDS = tuple(
    f"00000000-0000-4000-8000-{index:012d}" for index in range(1, 7)
)


def _candidate() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    _seed_job(
        candidate,
        _JOB_IDS[0],
        source="greenhouse",
        score=9,
        fit_band="excellent",
        stage="apply",
        state="succeeded",
        has_resume=1,
        apply_status="applied",
        applied_at="2026-07-30T12:00:00+00:00",
        apply_mode="automated_live",
        template_id="template-modern",
        template_name="Modern compact",
        policy_version=3,
        stages=[
            {"stage": "discover", "state": "succeeded"},
            {"stage": "enrich", "state": "queued"},
            {"stage": "score", "state": "exhausted"},
            {"stage": "tailor", "state": "skipped"},
            {"stage": "cover", "state": "blocked"},
            {"stage": "apply", "state": "succeeded", "unsafe": _INERT_CONTEXT},
        ],
    )
    _seed_job(
        candidate,
        _JOB_IDS[1],
        source="linkedin",
        score=7,
        fit_band="strong",
        stage="apply",
        state="pending",
        has_resume=1,
        stages=[
            {"stage": "discover", "state": "succeeded"},
            {"stage": "enrich", "state": "succeeded"},
            {"stage": "score", "state": "succeeded"},
            {"stage": "tailor", "state": "succeeded"},
            {"stage": "cover", "state": "succeeded"},
            {"stage": "apply", "state": "pending"},
        ],
    )
    _seed_job(
        candidate,
        _JOB_IDS[2],
        source="greenhouse",
        score=8,
        stage="apply",
        state="succeeded",
        apply_status="applied",
        applied_at="2026-07-30T12:00:00+00:00",
    )
    candidate.execute(
        """
        INSERT INTO jobctrl_hidden_jobs (
            tenant_id, job_id, hidden_at, reason, unhidden_at
        ) VALUES ('local', ?, ?, 'not relevant', NULL)
        """,
        (_JOB_IDS[2], _MIGRATION_AT),
    )
    _seed_job(
        candidate,
        _JOB_IDS[3],
        source="lever",
        score=6,
        stage="apply",
        state="succeeded",
    )
    candidate.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_active_state, updated_at
        ) VALUES ('local', ?, '{}', 'closed', ?)
        """,
        (_JOB_IDS[3], _MIGRATION_AT),
    )
    _seed_job(
        candidate,
        _JOB_IDS[4],
        source="ashby",
        score=5,
        stage="apply",
        state="succeeded",
        deleted_at="2026-07-30T08:00:00+00:00",
    )
    candidate.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason, restored_at
        ) VALUES ('local', ?, '2026-07-30T08:00:00+00:00', 'duplicate', NULL)
        """,
        (_JOB_IDS[4],),
    )
    _seed_job(
        candidate,
        _JOB_IDS[5],
        source="greenhouse",
        score=None,
        stage="enrich",
        state="exhausted",
        stages=[
            {"stage": "discover", "state": "succeeded"},
            {"stage": "enrich", "state": "succeeded"},
            {"stage": "score", "state": "exhausted"},
        ],
    )
    candidate.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (
            tenant_id, job_id, deleted_at, reason, restored_at
        ) VALUES ('local', ?, '2026-07-30T07:00:00+00:00', 'mistake',
                  '2026-07-30T07:01:00+00:00')
        """,
        (_JOB_IDS[5],),
    )
    for index, job_id in enumerate(_JOB_IDS, start=1):
        candidate.execute(
            """
            INSERT INTO apply_run_projections (
                run_id, tenant_id, job_id, dry_run, events_json
            ) VALUES (?, 'local', ?, 1, '[]')
            """,
            (f"run-{index}", job_id),
        )
    candidate.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source, note, occurred_at,
            recorded_at, created_by
        ) VALUES ('local', 'outcome-1', ?, 'interview', 'manual', ?,
                  '2026-07-30T13:00:00+00:00', ?, 'user')
        """,
        (_JOB_IDS[0], _INERT_CONTEXT, _MIGRATION_AT),
    )
    candidate.execute(
        """
        INSERT INTO application_outcome_suggestions (
            tenant_id, suggestion_id, job_id, suggested_kind, confidence,
            rationale, status, created_at
        ) VALUES ('local', 'suggestion-1', ?, 'interview', 0.9, ?,
                  'accepted', ?)
        """,
        (_JOB_IDS[0], _INERT_CONTEXT, _MIGRATION_AT),
    )
    _canonicalize_upstream_projections(candidate)
    candidate.commit()
    return candidate


def _canonicalize_upstream_projections(candidate: sqlite3.Connection) -> None:
    rows = candidate.execute(
        """
        SELECT job_id, source, fit_score, fit_band, apply_status, applied_at,
               has_resume, resume_template_id, resume_template_name,
               tailoring_policy_version
        FROM job_list_projections
        ORDER BY job_id
        """
    ).fetchall()
    for (
        job_id,
        source,
        fit_score,
        fit_band,
        apply_status,
        applied_at,
        has_resume,
        template_id,
        template_name,
        policy_version,
    ) in rows:
        locator = candidate.execute(
            "SELECT url FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
            (job_id,),
        ).fetchone()[0]
        candidate.execute(
            """
            UPDATE jobs
            SET site = ?, apply_status = ?, applied_at = ?
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (source, apply_status, applied_at, job_id),
        )
        candidate.execute(
            """
            INSERT INTO job_locators (
                tenant_id, job_id, locator_kind, locator_value, is_current,
                first_seen_at, last_seen_at, retired_at
            ) VALUES ('local', ?, 'posting_url', ?, 1, ?, ?, NULL)
            """,
            (job_id, locator, _MIGRATION_AT, _MIGRATION_AT),
        )
        if fit_score is not None:
            candidate.execute(
                """
                INSERT INTO job_scores (
                    tenant_id, job_id, version, fit_score, breakdown_json,
                    keywords_json, scored_at
                ) VALUES ('local', ?, 1, ?, '{}', '[]', ?)
                """,
                (job_id, fit_score, _MIGRATION_AT),
            )
        if fit_band is not None:
            candidate.execute(
                """
                INSERT INTO job_requirement_fit_reports (
                    tenant_id, job_id, score_version,
                    employer_analysis_generation, profile_snapshot_version,
                    scoring_policy_version, formula_version,
                    resolved_fit_score, fit_band, confidence, summary_json,
                    created_at
                ) VALUES ('local', ?, 1, 1, 1, 1, 'test', ?, ?, 'medium',
                          '{}', ?)
                """,
                (job_id, fit_score, fit_band, _MIGRATION_AT),
            )
        stages_json = candidate.execute(
            """
            SELECT stages_json FROM job_detail_projections
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (job_id,),
        ).fetchone()[0]
        for stage in json.loads(stages_json):
            candidate.execute(
                """
                INSERT INTO job_stage_states (
                    tenant_id, job_id, stage, state, attempt_count,
                    max_attempts, updated_at, retryable, blocked_by_json,
                    version
                ) VALUES ('local', ?, ?, ?, 1, 3, ?, 1, '[]', 1)
                """,
                (job_id, stage["stage"], stage["state"], _MIGRATION_AT),
            )
        if has_resume:
            metadata = json.dumps(
                {
                    "resume_template": {
                        "templateId": template_id,
                        "templateName": template_name,
                    },
                    "tailoringPolicyVersion": policy_version,
                }
            )
            candidate.execute(
                """
                INSERT INTO job_materials (
                    tenant_id, job_id, generation, status, created_at,
                    updated_at, metadata_json
                ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, ?)
                """,
                (job_id, _MIGRATION_AT, _MIGRATION_AT, metadata),
            )
            candidate.execute(
                """
                INSERT INTO job_materials_artifacts (
                    tenant_id, job_id, generation, artifact_type, artifact_id,
                    status, path, render_format, size_bytes, metadata_json,
                    created_at
                ) VALUES ('local', ?, 1, 'tailored_resume', ?, 'approved', ?,
                          'text', 100, ?, ?)
                """,
                (
                    job_id,
                    f"resume-{job_id}",
                    f"/tmp/{job_id}.txt",
                    metadata,
                    _MIGRATION_AT,
                ),
            )
        if applied_at:
            candidate.execute(
                """
                UPDATE apply_run_projections
                SET status = 'succeeded', result = 'applied', dry_run = 0,
                    finished_at = ?
                WHERE tenant_id = 'local' AND job_id = ?
                """,
                (applied_at, job_id),
            )

    candidate.execute("DELETE FROM job_detail_projections")
    candidate.executemany(
        f"""
        INSERT INTO job_detail_projections ({", ".join(job_details._COLUMNS)})
        VALUES ({", ".join("?" for _ in job_details._COLUMNS)})
        """,
        job_details._projection_rows(candidate, migration_at=_MIGRATION_AT),
    )
    candidate.execute("DELETE FROM job_list_projections")
    candidate.executemany(
        f"""
        INSERT INTO job_list_projections ({", ".join(JOB_LIST_PROJECTIONS_COLUMNS)})
        VALUES ({", ".join("?" for _ in JOB_LIST_PROJECTIONS_COLUMNS)})
        """,
        job_list_projection_rows(candidate, _MIGRATION_AT),
    )


def _refresh_upstream_projections(candidate: sqlite3.Connection) -> None:
    candidate.execute("DELETE FROM job_detail_projections")
    candidate.executemany(
        f"""
        INSERT INTO job_detail_projections ({", ".join(job_details._COLUMNS)})
        VALUES ({", ".join("?" for _ in job_details._COLUMNS)})
        """,
        job_details._projection_rows(candidate, migration_at=_MIGRATION_AT),
    )
    candidate.execute("DELETE FROM job_list_projections")
    candidate.executemany(
        f"""
        INSERT INTO job_list_projections ({", ".join(JOB_LIST_PROJECTIONS_COLUMNS)})
        VALUES ({", ".join("?" for _ in JOB_LIST_PROJECTIONS_COLUMNS)})
        """,
        job_list_projection_rows(candidate, _MIGRATION_AT),
    )


def _seed_job(
    candidate: sqlite3.Connection,
    job_id: str,
    *,
    source: str,
    score: int | None,
    fit_band: str | None = None,
    stage: str,
    state: str,
    has_resume: int = 0,
    apply_status: str | None = None,
    applied_at: str | None = None,
    apply_mode: str | None = None,
    template_id: str | None = None,
    template_name: str | None = None,
    policy_version: int | None = None,
    deleted_at: str | None = None,
    stages: list[dict[str, object]] | None = None,
) -> None:
    locator = f"https://jobs.example/{job_id}"
    candidate.execute(
        """
        INSERT INTO jobs (url, title, company, tenant_id, job_id)
        VALUES (?, 'Role', 'Example', 'local', ?)
        """,
        (locator, job_id),
    )
    candidate.execute(
        """
        INSERT INTO job_list_projections (
            tenant_id, job_id, title, employer, source, fit_score, fit_band,
            current_stage, current_substage, current_state, has_resume,
            apply_status, applied_at, apply_mode, resume_template_id,
            resume_template_name, tailoring_policy_version, deleted_at,
            last_updated_at
        ) VALUES ('local', ?, 'Role', 'Example', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            source,
            score,
            fit_band,
            stage,
            stage,
            state,
            has_resume,
            apply_status,
            applied_at,
            apply_mode,
            template_id,
            template_name,
            policy_version,
            deleted_at,
            _MIGRATION_AT,
        ),
    )
    candidate.execute(
        """
        INSERT INTO job_detail_projections (
            tenant_id, job_id, stages_json, last_updated_at
        ) VALUES ('local', ?, ?, ?)
        """,
        (job_id, json.dumps(stages or []), _MIGRATION_AT),
    )


def _row() -> dict[str, object]:
    rows = _projection_rows(_candidate(), _MIGRATION_AT)
    assert len(rows) == 1
    return dict(zip(DASHBOARD_PROJECTIONS_COLUMNS, rows[0], strict=True))


def test_projection_row_rebuilds_complete_privacy_safe_dashboard() -> None:
    row = _row()

    assert row["tenant_id"] == "local"
    assert row["total_jobs"] == 3
    assert row["failures"] == 1
    assert row["blocked"] == 0
    assert row["ready"] == 1
    assert row["applied"] == 1
    assert row["dry_runs"] == 2
    assert row["generated_at"] == _MIGRATION_AT

    assert json.loads(str(row["by_source_json"])) == [
        ["greenhouse", 2],
        ["linkedin", 1],
    ]
    assert json.loads(str(row["score_distribution_json"])) == [[9, 1], [7, 1]]
    funnel = {
        stage["stage"]: stage for stage in json.loads(str(row["funnel_json"]))
    }
    assert tuple(funnel) == ("discover", "enrich", "score", "tailor", "cover", "apply")
    assert funnel["discover"] == {
        "stage": "discover",
        "total": 3,
        "succeeded": 3,
        "running": 0,
        "pending": 0,
        "blocked": 0,
        "failed": 0,
    }
    assert funnel["enrich"]["running"] == 1
    assert funnel["score"]["failed"] == 2
    assert funnel["tailor"]["total"] == 2
    assert funnel["cover"]["blocked"] == 1
    assert funnel["apply"]["succeeded"] == 1
    assert funnel["apply"]["pending"] == 2

    conversion = json.loads(str(row["outcome_conversion_json"]))
    assert conversion["version"] == 2
    assert conversion["totals"] == {
        "applied": 1,
        "reply": 1,
        "interview": 1,
        "offer": 0,
        "rejection": 0,
    }
    assert conversion["bySource"] == [
        {
            "source": "greenhouse",
            "applied": 1,
            "reply": 1,
            "interview": 1,
            "offer": 0,
            "rejection": 0,
        }
    ]
    assert conversion["byBand"][0]["band"] == "perfect"
    assert conversion["byFitBand"][0]["fitBand"] == "excellent"
    assert conversion["byApplyMode"][0]["applyMode"] == "automated_live"
    assert conversion["byTemplate"][0]["templateId"] == "template-modern"
    assert conversion["byPolicy"][0]["tailoringPolicyVersion"] == 3
    assert conversion["timeToResponseMinutes"] == [60]
    assert conversion["suggestionAccuracy"] == {
        "decided": 1,
        "accepted": 1,
        "corrected": 0,
        "ignored": 0,
    }

    serialized = json.dumps(row, sort_keys=True)
    assert "Attack vectors" not in serialized
    assert "Prompt injection" not in serialized
    assert "rationale" not in serialized
    assert "note" not in serialized


def test_projection_row_is_deterministic_and_ignores_stale_dashboard_cache() -> None:
    candidate = _candidate()
    candidate.execute(
        """
        INSERT INTO dashboard_projections (
            tenant_id, total_jobs, failures, outcome_conversion_json, generated_at
        ) VALUES ('local', 999, 999, ?, 'stale')
        """,
        (_INERT_CONTEXT,),
    )

    first = _projection_rows(candidate, _MIGRATION_AT)
    second = _projection_rows(candidate, _MIGRATION_AT)

    assert first == second
    row = dict(zip(DASHBOARD_PROJECTIONS_COLUMNS, first[0], strict=True))
    assert row["total_jobs"] == 3
    assert _INERT_CONTEXT not in str(row)


def test_projection_row_materializes_empty_local_workspace() -> None:
    candidate = sqlite3.connect(":memory:")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)

    rows = _projection_rows(candidate, _MIGRATION_AT)

    assert len(rows) == 1
    row = dict(zip(DASHBOARD_PROJECTIONS_COLUMNS, rows[0], strict=True))
    assert row["tenant_id"] == "local"
    assert row["total_jobs"] == 0
    assert row["failures"] == 0
    assert row["blocked"] == 0
    assert row["ready"] == 0
    assert row["applied"] == 0
    assert row["dry_runs"] == 0
    assert json.loads(str(row["by_source_json"])) == []
    assert json.loads(str(row["score_distribution_json"])) == []
    assert json.loads(str(row["outcome_conversion_json"]))["totals"]["applied"] == 0
    assert row["generated_at"] == _MIGRATION_AT


@pytest.mark.parametrize(
    "mutation",
    [
        "DELETE FROM job_detail_projections WHERE job_id = '00000000-0000-4000-8000-000000000001'",
        "UPDATE job_detail_projections SET stages_json = 'not-json' "
        "WHERE job_id = '00000000-0000-4000-8000-000000000001'",
        "UPDATE job_list_projections SET deleted_at = NULL "
        "WHERE job_id = '00000000-0000-4000-8000-000000000005'",
    ],
)
def test_projection_row_rejects_incomplete_or_divergent_inputs(
    mutation: str,
) -> None:
    candidate = _candidate()
    candidate.execute(mutation)

    with pytest.raises(CandidateDashboardProjectionsError):
        _projection_rows(candidate, _MIGRATION_AT)


def test_projection_row_rejects_url_shaped_job_identity() -> None:
    candidate = _candidate()
    candidate.execute("PRAGMA foreign_keys = OFF")
    candidate.execute(
        """
        UPDATE job_list_projections
        SET job_id = 'https://jobs.example/legacy'
        WHERE job_id = ?
        """,
        (_JOB_IDS[0],),
    )

    with pytest.raises(CandidateDashboardProjectionsError):
        _projection_rows(candidate, _MIGRATION_AT)


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE job_list_projections SET has_resume = 2 "
        "WHERE job_id = '00000000-0000-4000-8000-000000000001'",
        "UPDATE job_list_projections SET fit_score = 7.5 "
        "WHERE job_id = '00000000-0000-4000-8000-000000000001'",
        "UPDATE job_detail_projections "
        """SET stages_json = '[{"stage":"discover","state":42}]' """
        "WHERE job_id = '00000000-0000-4000-8000-000000000001'",
        "UPDATE apply_run_projections SET dry_run = 2 "
        "WHERE job_id = '00000000-0000-4000-8000-000000000002'",
        "UPDATE application_outcome_suggestions "
        "SET job_id = 'https://jobs.example/legacy' "
        "WHERE suggestion_id = 'suggestion-1'",
    ],
)
def test_projection_row_rejects_malformed_upstream_values(mutation: str) -> None:
    candidate = _candidate()
    candidate.execute("PRAGMA foreign_keys = OFF")
    candidate.execute(mutation)

    with pytest.raises(CandidateDashboardProjectionsError):
        _projection_rows(candidate, _MIGRATION_AT)


def test_projection_row_rejects_canonical_fractional_score() -> None:
    candidate = _candidate()
    candidate.execute(
        """
        UPDATE job_scores SET fit_score = 7.5
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (_JOB_IDS[0],),
    )
    _refresh_upstream_projections(candidate)

    with pytest.raises(
        CandidateDashboardProjectionsError, match="fit_score must be an integer"
    ):
        _projection_rows(candidate, _MIGRATION_AT)


def test_projection_row_rejects_canonical_non_text_stage_state() -> None:
    candidate = _candidate()
    candidate.execute(
        """
        UPDATE job_stage_states SET state = X'6661696C6564'
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'
        """,
        (_JOB_IDS[0],),
    )
    _refresh_upstream_projections(candidate)

    with pytest.raises(
        CandidateDashboardProjectionsError, match="canonical stage state"
    ):
        _projection_rows(candidate, _MIGRATION_AT)


@pytest.mark.parametrize("state", ["needs_verification", "stale", "canceled"])
def test_projection_row_accepts_supported_nonterminal_stage_states(
    state: str,
) -> None:
    candidate = _candidate()
    candidate.execute(
        """
        UPDATE job_stage_states SET state = ?
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'
        """,
        (state, _JOB_IDS[0]),
    )
    _refresh_upstream_projections(candidate)

    row = dict(
        zip(
            DASHBOARD_PROJECTIONS_COLUMNS,
            _projection_rows(candidate, _MIGRATION_AT)[0],
            strict=True,
        )
    )
    funnel = {
        item["stage"]: item for item in json.loads(str(row["funnel_json"]))
    }
    assert funnel["score"]["pending"] >= 1
