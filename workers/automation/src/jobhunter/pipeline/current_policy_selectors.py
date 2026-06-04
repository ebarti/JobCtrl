"""Selectors for current-policy maintenance workflows."""

from __future__ import annotations

import sqlite3
from typing import Any

from jobhunter.database import (
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
    active_sql = _active_job_filter(conn, "j.url")
    limit_sql, limit_params = _limit_filter(limit)

    rows = conn.execute(
        f"""
        SELECT j.url
        FROM jobs j
        LEFT JOIN job_enrichments je ON je.job_url = j.url
        LEFT JOIN (
            SELECT s.job_url, s.trace_json, s.correction_json
            FROM job_scores s
            INNER JOIN (
                SELECT job_url, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY job_url
            ) latest
              ON latest.job_url = s.job_url AND latest.max_version = s.version
            WHERE s.tenant_id = ?
        ) latest_score ON latest_score.job_url = j.url
        WHERE COALESCE(je.full_description, j.full_description) IS NOT NULL
          {active_sql}
          {requested_sql}
          AND (
            latest_score.job_url IS NULL
            OR (
              (latest_score.correction_json IS NULL OR TRIM(latest_score.correction_json) = '')
              AND {_score_policy_version_expr("latest_score.trace_json")} != ?
            )
          )
        ORDER BY j.discovered_at DESC
        {limit_sql}
        """,
        (tenant_id, tenant_id, *requested_params, current_version, *limit_params),
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
    active_sql = _active_job_filter(conn, "j.url")
    limit_sql, limit_params = _limit_filter(limit)
    effective_tailor_path = (
        "((lm.materials_job_url IS NOT NULL AND lm.tailored_resume_path IS NOT NULL "
        "AND lm.tailored_resume_path != '') "
        "OR (lm.materials_job_url IS NULL AND j.tailored_resume_path IS NOT NULL "
        "AND j.tailored_resume_path != ''))"
    )

    rows = conn.execute(
        f"""
        SELECT j.url
        FROM jobs j
        LEFT JOIN job_enrichments je ON je.job_url = j.url
        LEFT JOIN (
            SELECT s.job_url, s.fit_score, s.breakdown_json
            FROM job_scores s
            INNER JOIN (
                SELECT job_url, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY job_url
            ) latest
              ON latest.job_url = s.job_url AND latest.max_version = s.version
            WHERE s.tenant_id = ?
        ) latest_score ON latest_score.job_url = j.url
        LEFT JOIN (
            SELECT job_url AS stale_job_url
            FROM job_score_staleness
            WHERE tenant_id = ? AND resolved = 0
            GROUP BY job_url
        ) stale_score ON stale_score.stale_job_url = j.url
        LEFT JOIN job_stage_states score_state
          ON score_state.job_url = j.url AND score_state.stage = 'score'
        LEFT JOIN job_stage_states tailor_state
          ON tailor_state.job_url = j.url AND tailor_state.stage = 'tailor'
        LEFT JOIN (
            SELECT m.job_url AS materials_job_url, tr.path AS tailored_resume_path,
                   tr.metadata_json AS tailored_resume_metadata
            FROM job_materials m
            INNER JOIN (
                SELECT job_url, MAX(generation) AS max_generation
                FROM job_materials
                WHERE tenant_id = ?
                GROUP BY job_url
            ) latest
              ON latest.job_url = m.job_url AND latest.max_generation = m.generation
            LEFT JOIN job_materials_artifacts tr
              ON tr.job_url = m.job_url
             AND tr.generation = m.generation
             AND tr.artifact_type = 'tailored_resume'
             AND tr.status = 'approved'
             AND tr.superseded_at IS NULL
            WHERE m.tenant_id = ?
        ) lm ON lm.materials_job_url = j.url
        WHERE COALESCE(je.full_description, j.full_description) IS NOT NULL
          {active_sql}
          {requested_sql}
          AND COALESCE(latest_score.fit_score, j.fit_score) >= ?
          AND {_score_eligible_expr("latest_score.breakdown_json")}
          AND stale_score.stale_job_url IS NULL
          AND (
            score_state.state IS NULL
            OR score_state.state = 'succeeded'
            OR (latest_score.fit_score IS NULL AND score_state.state != 'stale')
          )
          AND (tailor_state.state IS NULL OR tailor_state.state != 'exhausted')
          AND (
            {effective_tailor_path}
            OR COALESCE(tailor_state.attempt_count, j.tailor_attempts, 0) < 5
          )
          AND (
            NOT {effective_tailor_path}
            OR {_tailoring_policy_version_expr("lm.tailored_resume_metadata")} != ?
          )
        ORDER BY COALESCE(latest_score.fit_score, j.fit_score) DESC, j.discovered_at DESC
        {limit_sql}
        """,
        (
            tenant_id,
            tenant_id,
            tenant_id,
            tenant_id,
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


def _active_job_filter(conn: sqlite3.Connection, job_url_expr: str) -> str:
    clauses: list[str] = []
    if _table_exists(conn, "jobhunter_deleted_jobs"):
        clauses.append(
            "NOT EXISTS ("
            "SELECT 1 FROM jobhunter_deleted_jobs d "
            f"WHERE d.job_url = {job_url_expr} "
            "AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
            ")"
        )
    if _table_exists(conn, "jobhunter_hidden_jobs"):
        clauses.append(
            "NOT EXISTS ("
            "SELECT 1 FROM jobhunter_hidden_jobs h "
            f"WHERE h.job_url = {job_url_expr} AND h.unhidden_at IS NULL"
            ")"
        )
    if _table_exists(conn, "posting_snapshot_sets"):
        clauses.append(
            "NOT EXISTS ("
            "SELECT 1 FROM posting_snapshot_sets pss "
            f"WHERE pss.tenant_id = 'local' AND pss.job_url = {job_url_expr} "
            "AND pss.latest_active_state IN "
            "('closed', 'expired', 'removed', 'location_incompatible')"
            ")"
        )
    return "".join(f" AND {clause}" for clause in clauses)


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


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


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
