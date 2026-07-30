"""Daily local digest read model.

The digest is local-only and on demand. Passive reads never advance the
``digest_state`` watermark; explicit acknowledge flows own that write.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from jobctrl.database import get_connection
from jobctrl.llm import SpendBudgetStatus, read_spend_budget_status

TENANT_ID = "local"
FOLLOW_UP_THRESHOLD_DAYS = 7
DAY_BOUNDARY = "UTC"
FOLLOW_UP_STOP_OUTCOMES = {
    "recruiter_reply",
    "interview",
    "assessment",
    "offer",
    "rejection",
    "withdrawn",
    "bounced",
}
_CLOSED_ACTIVE_STATES = ("closed", "expired", "removed", "location_incompatible")
_REPAIR_STATES = {"failed", "blocked", "stale", "exhausted", "canceled", "skipped"}
_ACTIVE_STATES = {"queued", "running"}
_STAGES = {"discover", "enrich", "score", "tailor", "cover", "apply"}
_STAGE_STATES = {
    "pending",
    "queued",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "stale",
    "exhausted",
    "canceled",
    "skipped",
    "needs_verification",
}


def ensure_digest_state_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS digest_state (
            tenant_id              TEXT PRIMARY KEY DEFAULT 'local',
            last_acknowledged_at   TEXT,
            updated_at             TEXT NOT NULL
        )
        """
    )


def read_digest_state(conn: sqlite3.Connection | None = None) -> dict[str, str | None]:
    if conn is None:
        conn = get_connection()
    ensure_digest_state_table(conn)
    row = conn.execute(
        "SELECT last_acknowledged_at, updated_at FROM digest_state WHERE tenant_id = ?",
        (TENANT_ID,),
    ).fetchone()
    return {
        "lastAcknowledgedAt": _row_get(row, "last_acknowledged_at") if row is not None else None,
        "updatedAt": _row_get(row, "updated_at") if row is not None else None,
    }


def build_digest(
    conn: sqlite3.Connection | None = None,
    *,
    budget: SpendBudgetStatus | None = None,
    min_fit_score: int = 7,
    now: datetime | None = None,
) -> dict[str, Any]:
    if conn is None:
        conn = get_connection()
    ensure_digest_state_table(conn)
    generated_at = _format_utc_timestamp(_utc_now(now))
    since = read_digest_state(conn)["lastAcknowledgedAt"]
    threshold = _normalize_threshold(min_fit_score)
    budget_status = budget or read_spend_budget_status()
    return {
        "ok": True,
        "generatedAt": generated_at,
        "since": since,
        "highFitThreshold": threshold,
        "newMatches": _count_new_matches(conn, since=since, high_fit_threshold=threshold),
        "blockedSources": _blocked_sources(conn),
        "reviewNeededMaterials": {"count": _count_review_needed_materials(conn)},
        "staleScores": {"count": _count_stale_scores(conn)},
        "pendingApprovals": {"count": _count_pending_approvals(conn)},
        "followUpsDue": {
            "count": _count_follow_ups_due(conn, now=_utc_now(now)),
            "derived": True,
            "thresholdDays": FOLLOW_UP_THRESHOLD_DAYS,
            "dayBoundary": DAY_BOUNDARY,
        },
        "budget": _budget_payload(budget_status),
        "deepLinks": _deep_links(since=since),
    }


def acknowledge_digest(
    conn: sqlite3.Connection | None = None,
    *,
    acknowledged_at: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if conn is None:
        conn = get_connection()
    ensure_digest_state_table(conn)
    previous = read_digest_state(conn)["lastAcknowledgedAt"]
    reviewed_at = _format_utc_timestamp(_utc_now(now))
    requested_acknowledged_at = acknowledged_at or reviewed_at
    bounded_acknowledged_at = _bounded_acknowledge_timestamp(requested_acknowledged_at, reviewed_at)
    next_acknowledged_at = (
        previous
        if previous and _timestamp_after(previous, bounded_acknowledged_at)
        else bounded_acknowledged_at
    )

    conn.execute(
        """
        INSERT INTO digest_state (tenant_id, last_acknowledged_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            last_acknowledged_at = excluded.last_acknowledged_at,
            updated_at = excluded.updated_at
        """,
        (TENANT_ID, next_acknowledged_at, reviewed_at),
    )
    _record_digest_reviewed_event(
        conn,
        acknowledged_at=next_acknowledged_at,
        previous_acknowledged_at=previous,
        reviewed_at=reviewed_at,
    )
    conn.commit()
    return {"ok": True, "state": read_digest_state(conn)}


def _normalize_threshold(value: int | None) -> int:
    try:
        numeric = int(value if value is not None else 7)
    except (TypeError, ValueError):
        numeric = 7
    return min(10, max(1, numeric))


def _utc_now(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_utc_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _bounded_acknowledge_timestamp(candidate: str, now_iso: str) -> str:
    candidate_time = _parse_utc_timestamp(candidate)
    now_time = _parse_utc_timestamp(now_iso)
    if candidate_time is None or now_time is None:
        return now_iso
    if candidate_time > now_time:
        return now_iso
    return candidate


def _timestamp_after(left: str, right: str) -> bool:
    left_time = _parse_utc_timestamp(left)
    right_time = _parse_utc_timestamp(right)
    if left_time is None or right_time is None:
        return False
    return left_time > right_time


def _parse_utc_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _record_digest_reviewed_event(
    conn: sqlite3.Connection,
    *,
    acknowledged_at: str,
    previous_acknowledged_at: str | None,
    reviewed_at: str,
) -> None:
    if not _table_exists(conn, "job_events"):
        return
    columns = _table_columns(conn, "job_events")
    values: dict[str, Any] = {
        "job_url": None,
        "stage": None,
        "event_type": "DigestReviewed",
        "level": "info",
        "message": "Digest reviewed.",
        "occurred_at": reviewed_at,
        "payload_json": json.dumps(
            {
                "tenantId": TENANT_ID,
                "acknowledgedAt": acknowledged_at,
                "previousAcknowledgedAt": previous_acknowledged_at,
                "reviewedAt": reviewed_at,
            },
            separators=(",", ":"),
        ),
    }
    entries = [(name, value) for name, value in values.items() if name in columns]
    if not entries:
        return
    column_sql = ", ".join(name for name, _ in entries)
    placeholders = ", ".join("?" for _ in entries)
    conn.execute(
        f"INSERT INTO job_events ({column_sql}) VALUES ({placeholders})",
        [value for _, value in entries],
    )


def _budget_payload(status: SpendBudgetStatus) -> dict[str, Any]:
    unlimited = status.daily_budget_usd <= 0
    remaining = None if unlimited else max(0.0, status.daily_budget_usd - status.estimated_usd)
    return {
        "status": "over_budget" if status.exceeded else "ok",
        "estimatedUsd": float(status.estimated_usd),
        "dailyBudgetUsd": float(status.daily_budget_usd),
        "remainingUsd": remaining,
        "unlimited": unlimited,
    }


def _deep_links(*, since: str | None) -> dict[str, str]:
    new_matches_params = {
        "deleted": "active",
        "sort": "discovered_at",
        "dir": "desc",
    }
    if since:
        new_matches_params["discoveredSince"] = since
        new_matches_params["scoredSince"] = since
    stale_scores_params = {
        "deleted": "active",
        "state": "stale",
        "sort": "fit_score",
        "dir": "desc",
    }
    return {
        "newMatches": f"/jobs?{urlencode(new_matches_params)}",
        "blockedSources": "/discovery",
        "reviewNeededMaterials": "/apply-review",
        "staleScores": f"/jobs?{urlencode(stale_scores_params)}",
        "pendingApprovals": "/apply-review",
        "followUpsDue": "/jobs?applyStatus=applied",
        "budget": "/settings",
    }


def _count_new_matches(
    conn: sqlite3.Connection,
    *,
    since: str | None,
    high_fit_threshold: int,
) -> dict[str, int]:
    if not _table_exists(conn, "job_list_projections"):
        return {"count": 0, "highFitCount": 0}
    active_clauses, active_params = _active_job_clauses(conn, "job_list_projections")
    clauses = ["tenant_id = ?", "deleted_at IS NULL", *active_clauses]
    params: list[Any] = [TENANT_ID, *active_params]
    if since:
        clauses.append("(discovered_at >= ? OR scored_at >= ?)")
        params.extend([since, since])
    where = " WHERE " + " AND ".join(clauses)
    count = _count_rows(conn, f"SELECT COUNT(*) AS count FROM job_list_projections{where}", params)
    high_fit = _count_rows(
        conn,
        f"SELECT COUNT(*) AS count FROM job_list_projections{where} AND COALESCE(fit_score, -1) >= ?",
        [*params, high_fit_threshold],
    )
    return {"count": count, "highFitCount": high_fit}


def _blocked_sources(conn: sqlite3.Connection) -> dict[str, Any]:
    sources: list[dict[str, Any]] = []
    seen: set[str] = set()
    if _table_exists(conn, "source_quality_stats"):
        rows = conn.execute(
            """
            SELECT source_id, recommended_state, consecutive_failures, observed_jobs
            FROM source_quality_stats
            WHERE tenant_id = ?
            ORDER BY recommended_state DESC, observed_jobs DESC, source_id ASC
            """,
            (TENANT_ID,),
        ).fetchall()
        for row in rows:
            source_id = str(_row_get(row, "source_id") or "")
            if source_id:
                seen.add(source_id)
            source = {
                "sourceId": source_id,
                "recommendedState": str(_row_get(row, "recommended_state") or "normal"),
                "consecutiveFailures": int(_row_get(row, "consecutive_failures") or 0),
            }
            if _blocked_source_predicate(source):
                sources.append(source)
    for source in _operational_only_source_health(conn, seen):
        if _blocked_source_predicate(source):
            sources.append(source)
    return {"count": len(sources), "sources": sources}


def _blocked_source_predicate(source: dict[str, Any]) -> bool:
    return source["recommendedState"] in {"quarantined", "disabled"} or source["consecutiveFailures"] >= 3


def _operational_only_source_health(conn: sqlite3.Connection, seen: set[str]) -> list[dict[str, Any]]:
    if not _table_exists(conn, "operational_attempt_metrics"):
        return []
    rows = conn.execute(
        """
        SELECT source_id, outcome
        FROM operational_attempt_metrics
        WHERE tenant_id = ?
          AND outcome != 'started'
        ORDER BY occurred_at ASC, metric_id ASC
        """,
        (TENANT_ID,),
    ).fetchall()
    rollups: dict[str, dict[str, Any]] = {}
    for row in rows:
        source_id = str(_row_get(row, "source_id") or "")
        if not source_id or source_id in seen:
            continue
        rollup = rollups.setdefault(
            source_id,
            {"sourceId": source_id, "failures": 0, "lastOutcome": None},
        )
        outcome = str(_row_get(row, "outcome") or "")
        if outcome in {"failed", "partial_failed"}:
            rollup["failures"] += 1
        rollup["lastOutcome"] = outcome
    return [
        {
            "sourceId": str(rollup["sourceId"]),
            "recommendedState": "normal",
            "consecutiveFailures": int(rollup["failures"]) if rollup["lastOutcome"] == "failed" else 0,
        }
        for rollup in rollups.values()
    ]


def _count_review_needed_materials(conn: sqlite3.Connection) -> int:
    return sum(
        1
        for row in _apply_queue_rows(conn)
        if _has_review_material(row) and not _digest_materials_ready(row)
    )


def _count_pending_approvals(conn: sqlite3.Connection) -> int:
    return sum(
        1
        for row in _apply_queue_rows(conn)
        if str(_row_get(row, "decision") or "")
        not in {"approve_submit", "approve_dry_run"}
    )


def _apply_queue_rows(conn: sqlite3.Connection) -> list[Any]:
    if not _table_exists(conn, "job_list_projections") or not _table_exists(conn, "job_stage_states"):
        return []
    stable_stage_references = (
        "job_id" in _table_columns(conn, "job_stage_states")
        and _table_exists(conn, "jobs")
    )
    apply_stage_source_sql = (
        """
                SELECT s.tenant_id, j.url AS job_url, s.state,
                       ROW_NUMBER() OVER (
                           PARTITION BY s.tenant_id, s.job_id
                           ORDER BY COALESCE(s.updated_at, '') DESC, s.rowid DESC
                       ) AS row_num
                FROM job_stage_states s
                JOIN jobs j
                  ON j.tenant_id = s.tenant_id
                 AND j.job_id = s.job_id
                WHERE s.stage = 'apply'
        """
        if stable_stage_references
        else """
                SELECT 'local' AS tenant_id, s.job_url, s.state,
                       ROW_NUMBER() OVER (
                           PARTITION BY s.job_url
                           ORDER BY COALESCE(s.updated_at, '') DESC, s.rowid DESC
                       ) AS row_num
                FROM job_stage_states s
                WHERE s.stage = 'apply'
        """
    )
    latest_decision_sql, latest_decision_params = _latest_decision_cte(conn)
    latest_apply_run_sql = _latest_apply_run_cte(conn)
    active_clauses, active_params = _active_job_clauses(conn, "jlp")
    active_sql = "".join(f"\n          AND {clause}" for clause in active_clauses)
    return conn.execute(
        latest_decision_sql
        + latest_apply_run_sql
        + f"""
        , latest_digest_apply_stage AS (
            SELECT tenant_id, job_url, state
            FROM (
                {apply_stage_source_sql}
            )
            WHERE row_num = 1
        )
        SELECT jlp.job_id,
               jlp.application_url,
               jlp.has_resume,
               jlp.has_cover_letter,
               jlp.has_pdf,
               jlp.current_stage,
               jlp.current_substage,
               jlp.current_state,
               jlp.score_breakdown_json,
               latest_decision.decision,
               latest_apply_run.status AS apply_run_status,
               latest_apply_run.result AS apply_run_result
        FROM job_list_projections jlp
        INNER JOIN latest_digest_apply_stage apply_stage
          ON apply_stage.tenant_id = jlp.tenant_id
         AND apply_stage.job_url = jlp.job_id
        LEFT JOIN latest_digest_decision latest_decision
          ON latest_decision.job_key = jlp.job_id
        LEFT JOIN latest_digest_apply_run latest_apply_run
          ON latest_apply_run.job_id = jlp.job_id
        WHERE jlp.tenant_id = ?
          AND jlp.deleted_at IS NULL
          {active_sql}
          AND COALESCE(jlp.apply_status, '') != 'applied'
          AND apply_stage.state IN ('pending', 'blocked', 'failed', 'stale', 'needs_verification')
          AND (
            jlp.has_resume = 1
            OR jlp.application_url IS NOT NULL
            OR jlp.fit_score IS NOT NULL
          )
          AND COALESCE(latest_decision.decision, '') NOT IN (
            'defer',
            'decline'
          )
        """,
        [*latest_decision_params, TENANT_ID, *active_params],
    ).fetchall()


def _active_job_clauses(conn: sqlite3.Connection, alias: str) -> tuple[list[str], list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if _table_exists(conn, "jobctrl_hidden_jobs"):
        clauses.append(
            f"NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.job_url = {alias}.job_id AND h.unhidden_at IS NULL)"
        )
    if _table_exists(conn, "posting_snapshot_sets"):
        placeholders = ", ".join("?" for _ in _CLOSED_ACTIVE_STATES)
        stable_reference = (
            "job_id" in _table_columns(conn, "posting_snapshot_sets")
        )
        reference_predicate = (
            "pss.job_id = ("
            "SELECT j.job_id FROM jobs j "
            f"WHERE j.tenant_id = {alias}.tenant_id "
            f"AND j.url = {alias}.job_id LIMIT 1"
            ")"
            if stable_reference
            else f"pss.job_url = {alias}.job_id"
        )
        clauses.append(
            "NOT EXISTS ("
            "SELECT 1 FROM posting_snapshot_sets pss "
            f"WHERE pss.tenant_id = {alias}.tenant_id "
            f"AND {reference_predicate} "
            f"AND pss.latest_active_state IN ({placeholders})"
            ")"
        )
        params.extend(_CLOSED_ACTIVE_STATES)
    return clauses, params


def _active_job_url_set(conn: sqlite3.Connection) -> set[str]:
    if not _table_exists(conn, "job_list_projections"):
        return set()
    active_clauses, active_params = _active_job_clauses(conn, "jlp")
    clauses = ["jlp.tenant_id = ?", "jlp.deleted_at IS NULL", *active_clauses]
    rows = conn.execute(
        f"""
        SELECT jlp.job_id
        FROM job_list_projections jlp
        WHERE {" AND ".join(clauses)}
        """,
        [TENANT_ID, *active_params],
    ).fetchall()
    return {str(_row_get(row, "job_id")) for row in rows if _row_get(row, "job_id")}


def _has_review_material(row: Any) -> bool:
    return bool(
        _row_get(row, "has_resume")
        or _row_get(row, "has_cover_letter")
        or _row_get(row, "has_pdf")
    )


def _digest_materials_ready(row: Any) -> bool:
    application_target = str(_row_get(row, "application_url") or _row_get(row, "job_id") or "").strip()
    if not application_target:
        return False
    if not _row_get(row, "has_resume") or not _row_get(row, "has_pdf"):
        return False
    current_stage = _stage(_row_get(row, "current_substage") or _row_get(row, "current_stage"))
    current_state = _stage_state(_row_get(row, "current_state"))
    if current_stage != "apply" or current_state in _ACTIVE_STATES or current_state in _REPAIR_STATES:
        return False
    if _is_failed_apply_run(row):
        return False
    return not _score_eligibility_blocked(_row_get(row, "score_breakdown_json"))


def _stage(value: Any) -> str:
    text = str(value or "")
    return text if text in _STAGES else "apply"


def _stage_state(value: Any) -> str:
    text = str(value or "")
    return text if text in _STAGE_STATES else "pending"


def _is_failed_apply_run(row: Any) -> bool:
    combined = f"{_row_get(row, 'apply_run_status') or ''} {_row_get(row, 'apply_run_result') or ''}".lower()
    return any(
        marker in combined
        for marker in (
            "failed",
            "skipped",
            "canceled",
            "terminated",
            "timed_out",
            "captcha",
            "login_issue",
            "expired",
        )
    )


def _score_eligibility_blocked(value: Any) -> bool:
    parsed = _parse_json_record(value)
    eligibility = parsed.get("eligibility") if parsed else None
    if not isinstance(eligibility, dict):
        return False
    return eligibility.get("status") == "blocked"


def _parse_json_record(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _latest_decision_cte(conn: sqlite3.Connection) -> tuple[str, list[Any]]:
    if not _table_exists(conn, "application_review_decisions"):
        return (
            """
            WITH latest_digest_decision AS (
                SELECT NULL AS job_key, NULL AS decision
                WHERE 0
            )
            """,
            [],
        )
    stable_references = (
        "job_id"
        in _table_columns(conn, "application_review_decisions")
    )
    if stable_references:
        return (
            """
            WITH latest_digest_decision AS (
                SELECT job_key, decision
                FROM (
                    SELECT jobs.url AS job_key,
                           decisions.decision,
                           ROW_NUMBER() OVER (
                               PARTITION BY decisions.tenant_id,
                                            decisions.job_id
                               ORDER BY decisions.decided_at DESC,
                                        decisions.decision_id DESC
                           ) AS row_num
                    FROM application_review_decisions decisions
                    JOIN jobs
                      ON jobs.tenant_id = decisions.tenant_id
                     AND jobs.job_id = decisions.job_id
                    WHERE decisions.tenant_id = ?
                )
                WHERE row_num = 1
            )
            """,
            [TENANT_ID],
        )
    return (
        """
        WITH latest_digest_decision AS (
            SELECT job_key, decision
            FROM (
                SELECT job_key, decision,
                       ROW_NUMBER() OVER (
                           PARTITION BY tenant_id, job_key
                           ORDER BY decided_at DESC, decision_id DESC
                       ) AS row_num
                FROM application_review_decisions
                WHERE tenant_id = ?
            )
            WHERE row_num = 1
        )
        """,
        [TENANT_ID],
    )


def _latest_apply_run_cte(conn: sqlite3.Connection) -> str:
    if not _table_exists(conn, "apply_run_projections"):
        return (
            """
            , latest_digest_apply_run AS (
                SELECT NULL AS job_id, NULL AS status, NULL AS result
                WHERE 0
            )
            """
        )
    return (
        """
        , latest_digest_apply_run AS (
            SELECT job_id, status, result
            FROM (
                SELECT job_id, status, result,
                       ROW_NUMBER() OVER (
                           PARTITION BY tenant_id, job_id
                           ORDER BY COALESCE(started_at, finished_at, '') DESC, run_id DESC
                       ) AS row_num
                FROM apply_run_projections
                WHERE tenant_id = 'local'
            )
            WHERE row_num = 1
        )
        """
    )


def _count_stale_scores(conn: sqlite3.Connection) -> int:
    active_jobs = _active_job_url_set(conn)
    if not active_jobs:
        return 0
    if _table_exists(conn, "job_score_staleness"):
        stale_columns = {
            str(row[1])
            for row in conn.execute(
                "PRAGMA table_info(job_score_staleness)"
            ).fetchall()
        }
        stable_references = "job_id" in stale_columns
        if _table_exists(conn, "job_scores"):
            sql = (
                """
                SELECT DISTINCT jobs.url AS job_url
                FROM job_score_staleness stale
                JOIN jobs
                  ON jobs.tenant_id = stale.tenant_id
                 AND jobs.job_id = stale.job_id
                JOIN (
                    SELECT tenant_id, job_id, MAX(version) AS max_version
                    FROM job_scores
                    WHERE tenant_id = ?
                    GROUP BY tenant_id, job_id
                ) latest
                  ON latest.tenant_id = stale.tenant_id
                 AND latest.job_id = stale.job_id
                JOIN job_scores scores
                  ON scores.tenant_id = stale.tenant_id
                 AND scores.job_id = stale.job_id
                 AND scores.version = latest.max_version
                WHERE stale.tenant_id = ?
                  AND stale.resolved = 0
                  AND (
                    scores.correction_json IS NULL
                    OR TRIM(scores.correction_json) = ''
                  )
                """
                if stable_references
                else """
                SELECT DISTINCT stale.job_url
                FROM job_score_staleness stale
                JOIN (
                    SELECT job_url, MAX(version) AS max_version
                    FROM job_scores
                    WHERE tenant_id = ?
                    GROUP BY job_url
                ) latest ON latest.job_url = stale.job_url
                JOIN job_scores scores
                  ON scores.tenant_id = stale.tenant_id
                 AND scores.job_url = stale.job_url
                 AND scores.version = latest.max_version
                WHERE stale.tenant_id = ?
                  AND stale.resolved = 0
                  AND (
                    scores.correction_json IS NULL
                    OR TRIM(scores.correction_json) = ''
                  )
                """
            )
            rows = conn.execute(sql, [TENANT_ID, TENANT_ID]).fetchall()
            return sum(1 for row in rows if _row_get(row, "job_url") in active_jobs)
        sql = (
            """
            SELECT DISTINCT jobs.url AS job_url
            FROM job_score_staleness stale
            JOIN jobs
              ON jobs.tenant_id = stale.tenant_id
             AND jobs.job_id = stale.job_id
            WHERE stale.tenant_id = ?
              AND stale.resolved = 0
            """
            if stable_references
            else """
            SELECT DISTINCT job_url
            FROM job_score_staleness
            WHERE tenant_id = ?
              AND resolved = 0
            """
        )
        rows = conn.execute(sql, [TENANT_ID]).fetchall()
        return sum(1 for row in rows if _row_get(row, "job_url") in active_jobs)
    if _table_exists(conn, "job_list_projections"):
        rows = conn.execute(
            """
            SELECT job_id
            FROM job_list_projections
            WHERE tenant_id = ?
              AND current_stage = 'score'
              AND current_state = 'stale'
            """,
            [TENANT_ID],
        ).fetchall()
        return sum(1 for row in rows if _row_get(row, "job_id") in active_jobs)
    return 0


def _count_follow_ups_due(conn: sqlite3.Connection, *, now: datetime) -> int:
    if not _table_exists(conn, "application_outcomes"):
        return 0
    cutoff = _format_utc_timestamp(now - timedelta(days=FOLLOW_UP_THRESHOLD_DAYS))
    rows = conn.execute(
        """
        SELECT job_key, kind, occurred_at, recorded_at
        FROM application_outcomes
        WHERE tenant_id = ?
        ORDER BY job_key ASC, occurred_at ASC, recorded_at ASC
        """,
        (TENANT_ID,),
    ).fetchall()
    by_job: dict[str, dict[str, Any]] = {}
    for row in rows:
        job_key = str(_row_get(row, "job_key") or "")
        occurred_at = str(_row_get(row, "occurred_at") or _row_get(row, "recorded_at") or "")
        if not job_key or not occurred_at:
            continue
        current = by_job.setdefault(
            job_key,
            {"appliedAt": None, "lastActivityAt": None, "stopped": False},
        )
        if current["lastActivityAt"] is None or occurred_at > current["lastActivityAt"]:
            current["lastActivityAt"] = occurred_at
        kind = str(_row_get(row, "kind") or "")
        if kind == "applied_confirmation":
            if current["appliedAt"] is None or occurred_at > current["appliedAt"]:
                current["appliedAt"] = occurred_at
                current["stopped"] = False
        elif (
            current["appliedAt"] is not None
            and occurred_at > current["appliedAt"]
            and kind in FOLLOW_UP_STOP_OUTCOMES
        ):
            current["stopped"] = True
    return sum(
        1
        for item in by_job.values()
        if item["appliedAt"]
        and not item["stopped"]
        and item["lastActivityAt"]
        and item["lastActivityAt"] <= cutoff
    )


def _count_rows(conn: sqlite3.Connection, sql: str, params: list[Any]) -> int:
    row = conn.execute(sql, params).fetchone()
    return int(_row_get(row, "count") or 0) if row is not None else 0


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _row_get(row: Any, key: str) -> Any:
    try:
        return row[key]
    except (IndexError, KeyError, TypeError):
        return None
