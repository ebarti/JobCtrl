"""Selectors for current-policy maintenance workflows."""

from __future__ import annotations

import sqlite3
from typing import Any

from jobctrl.database import (
    effective_tailoring_min_score,
    ensure_scoring_policy_tables,
    ensure_tailoring_policy_tables,
)


def scoring_current_policy_job_urls(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    limit: int = 0,
    job_urls: tuple[str, ...] = (),
) -> tuple[str, ...]:
    """Return active enriched jobs missing a current-policy score."""

    current_version = _current_scoring_policy_version(conn, tenant_id)
    requested = _clean_job_urls(job_urls)
    requested_sql, requested_params = _requested_filter("j.url", requested)
    active_sql = _active_job_filter("j.tenant_id", "j.job_id")
    limit_sql, limit_params = _limit_filter(limit)

    rows = conn.execute(
        f"""
        SELECT j.url
        FROM jobs j
        JOIN job_enrichments je
          ON je.tenant_id = j.tenant_id AND je.job_id = j.job_id
        LEFT JOIN job_scores latest_score
          ON latest_score.tenant_id = j.tenant_id
         AND latest_score.job_id = j.job_id
         AND latest_score.version = (
            SELECT MAX(candidate.version)
            FROM job_scores candidate
            WHERE candidate.tenant_id = j.tenant_id
              AND candidate.job_id = j.job_id
         )
        WHERE j.tenant_id = ?
          AND je.full_description IS NOT NULL
          {active_sql}
          {requested_sql}
          AND (
            latest_score.job_id IS NULL
            OR (
              (latest_score.correction_json IS NULL OR TRIM(latest_score.correction_json) = '')
              AND {_score_policy_version_expr("latest_score.trace_json")} != ?
            )
          )
        ORDER BY j.discovered_at DESC
        {limit_sql}
        """,
        (tenant_id, *requested_params, current_version, *limit_params),
    ).fetchall()
    return tuple(str(row[0]) for row in rows if row[0])


def tailoring_current_policy_job_urls(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    min_score: int = 7,
    limit: int = 0,
    job_urls: tuple[str, ...] = (),
) -> tuple[str, ...]:
    """Return active eligible jobs missing a current-policy tailored artifact."""

    min_score = effective_tailoring_min_score(min_score)
    current_version = _current_tailoring_policy_version(conn, tenant_id)
    requested = _clean_job_urls(job_urls)
    requested_sql, requested_params = _requested_filter("j.url", requested)
    active_sql = _active_job_filter("j.tenant_id", "j.job_id")
    limit_sql, limit_params = _limit_filter(limit)
    effective_tailor_path = (
        "(tailored_resume.job_id IS NOT NULL "
        "AND tailored_resume.path IS NOT NULL "
        "AND tailored_resume.path != '')"
    )

    rows = conn.execute(
        f"""
        SELECT j.url
        FROM jobs j
        JOIN job_enrichments je
          ON je.tenant_id = j.tenant_id AND je.job_id = j.job_id
        LEFT JOIN job_scores latest_score
          ON latest_score.tenant_id = j.tenant_id
         AND latest_score.job_id = j.job_id
         AND latest_score.version = (
            SELECT MAX(candidate.version)
            FROM job_scores candidate
            WHERE candidate.tenant_id = j.tenant_id
              AND candidate.job_id = j.job_id
         )
        LEFT JOIN job_stage_states score_state
          ON score_state.tenant_id = j.tenant_id
         AND score_state.job_id = j.job_id
         AND score_state.stage = 'score'
        LEFT JOIN job_stage_states tailor_state
          ON tailor_state.tenant_id = j.tenant_id
         AND tailor_state.job_id = j.job_id
         AND tailor_state.stage = 'tailor'
        LEFT JOIN job_materials_artifacts tailored_resume
          ON tailored_resume.tenant_id = j.tenant_id
         AND tailored_resume.job_id = j.job_id
         AND tailored_resume.generation = (
            SELECT MAX(candidate.generation)
            FROM job_materials_artifacts candidate
            WHERE candidate.tenant_id = j.tenant_id
              AND candidate.job_id = j.job_id
              AND candidate.artifact_type = 'tailored_resume'
              AND candidate.status = 'approved'
              AND candidate.superseded_at IS NULL
         )
         AND tailored_resume.artifact_type = 'tailored_resume'
         AND tailored_resume.status = 'approved'
         AND tailored_resume.superseded_at IS NULL
        WHERE j.tenant_id = ?
          AND je.full_description IS NOT NULL
          {active_sql}
          {requested_sql}
          AND latest_score.fit_score >= ?
          AND {_score_eligible_expr("latest_score.breakdown_json")}
          AND NOT EXISTS (
            SELECT 1
            FROM job_score_staleness stale_score
            WHERE stale_score.tenant_id = j.tenant_id
              AND stale_score.job_id = j.job_id
              AND stale_score.resolved = 0
          )
          AND (score_state.state IS NULL OR score_state.state = 'succeeded')
          AND (tailor_state.state IS NULL OR tailor_state.state != 'exhausted')
          AND COALESCE(tailor_state.attempt_count, 0) < 5
          AND (
            NOT {effective_tailor_path}
            OR {_tailoring_policy_version_expr("tailored_resume.metadata_json")} != ?
          )
        ORDER BY latest_score.fit_score DESC, j.discovered_at DESC
        {limit_sql}
        """,
        (
            tenant_id,
            *requested_params,
            min_score,
            current_version,
            *limit_params,
        ),
    ).fetchall()
    return tuple(str(row[0]) for row in rows if row[0])


def _current_scoring_policy_version(conn: sqlite3.Connection, tenant_id: str) -> int:
    ensure_scoring_policy_tables(conn)
    row = conn.execute(
        "SELECT MAX(version) FROM scoring_policies WHERE tenant_id = ?",
        (tenant_id,),
    ).fetchone()
    return _positive_int(row[0] if row else None, default=1)


def _current_tailoring_policy_version(conn: sqlite3.Connection, tenant_id: str) -> int:
    ensure_tailoring_policy_tables(conn)
    row = conn.execute(
        "SELECT MAX(version) FROM tailoring_policies WHERE tenant_id = ?",
        (tenant_id,),
    ).fetchone()
    return _positive_int(row[0] if row else None, default=1)


def _active_job_filter(tenant_id_expr: str, job_id_expr: str) -> str:
    return f"""
        AND NOT EXISTS (
            SELECT 1 FROM jobctrl_deleted_jobs deleted
            WHERE deleted.tenant_id = {tenant_id_expr}
              AND deleted.job_id = {job_id_expr}
              AND (
                deleted.restored_at IS NULL
                OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
              )
        )
        AND NOT EXISTS (
            SELECT 1 FROM jobctrl_hidden_jobs hidden
            WHERE hidden.tenant_id = {tenant_id_expr}
              AND hidden.job_id = {job_id_expr}
              AND hidden.unhidden_at IS NULL
        )
        AND NOT EXISTS (
            SELECT 1 FROM posting_snapshot_sets snapshots
            WHERE snapshots.tenant_id = {tenant_id_expr}
              AND snapshots.job_id = {job_id_expr}
              AND snapshots.latest_active_state IN (
                'closed', 'expired', 'removed', 'location_incompatible'
              )
        )
    """


def _requested_filter(column: str, job_urls: tuple[str, ...]) -> tuple[str, tuple[str, ...]]:
    if not job_urls:
        return "", ()
    placeholders = ", ".join("?" for _ in job_urls)
    return f" AND {column} IN ({placeholders})", job_urls


def _limit_filter(limit: int) -> tuple[str, tuple[int, ...]]:
    if limit > 0:
        return "LIMIT ?", (limit,)
    return "", ()


def _clean_job_urls(job_urls: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(url.strip() for url in job_urls if url and url.strip()))


def _score_policy_version_expr(json_expr: str) -> str:
    return (
        f"CASE WHEN json_valid({json_expr}) THEN COALESCE("
        f"CAST(json_extract({json_expr}, '$.scoring_policy_version') AS INTEGER), "
        f"CAST(json_extract({json_expr}, '$.scoringPolicyVersion') AS INTEGER), "
        f"CAST(json_extract({json_expr}, '$.policy_version') AS INTEGER), "
        f"CAST(json_extract({json_expr}, '$.policyVersion') AS INTEGER), "
        "0) ELSE 0 END"
    )


def _tailoring_policy_version_expr(json_expr: str) -> str:
    return (
        f"CASE WHEN json_valid({json_expr}) THEN COALESCE("
        f"CAST(json_extract({json_expr}, '$.tailoring_policy_version') AS INTEGER), "
        f"CAST(json_extract({json_expr}, '$.tailoringPolicyVersion') AS INTEGER), "
        f"CAST(json_extract({json_expr}, '$.policy_version') AS INTEGER), "
        f"CAST(json_extract({json_expr}, '$.policyVersion') AS INTEGER), "
        "0) ELSE 0 END"
    )


def _score_eligible_expr(json_expr: str) -> str:
    status_expr = (
        f"CASE WHEN json_valid({json_expr}) "
        f"THEN LOWER(COALESCE(CAST(json_extract({json_expr}, '$.eligibility.status') AS TEXT), '')) "
        "ELSE '' END"
    )
    blockers_expr = (
        f"CASE WHEN json_valid({json_expr}) THEN COALESCE("
        f"json_array_length({json_expr}, '$.eligibility.hard_blockers'), "
        f"json_array_length({json_expr}, '$.eligibility.hardBlockers'), "
        f"json_array_length({json_expr}, '$.eligibility.blockers'), "
        "0) ELSE 0 END"
    )
    return f"{status_expr} != 'blocked' AND {blockers_expr} = 0"


def _positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default
