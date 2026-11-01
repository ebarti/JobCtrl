"""Daily local digest read model.

The digest is local-only and on demand. Passive reads never advance the
``digest_state`` watermark; explicit acknowledge flows own that write.
"""

from __future__ import annotations

import json
import re
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
    row = _query(
        conn,
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
    budget_status = budget or read_spend_budget_status(lane="discovery")
    from jobctrl.infrastructure.materials.company_briefings import CompanyBriefingRepository
    briefings = CompanyBriefingRepository(conn).summaries(now=_utc_now(now))
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
        "companyBriefings": briefings,
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
    reviewed_at = _format_utc_timestamp(_utc_now(now))
    requested_acknowledged_at = acknowledged_at or reviewed_at
    bounded_acknowledged_at = _bounded_acknowledge_timestamp(requested_acknowledged_at, reviewed_at)

    # Keep the watermark and event in one transaction even when this function
    # starts with no caller-owned transaction; a top-level savepoint release
    # would otherwise commit before the explicit commit can fail.
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("SAVEPOINT digest_acknowledgement")
    except BaseException:
        if owns_transaction:
            conn.rollback()
        raise
    try:
        previous = read_digest_state(conn)["lastAcknowledgedAt"]
        if previous and _parse_utc_timestamp(previous) is None:
            raise ValueError("digest watermark is not a valid timestamp")
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
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT digest_acknowledgement")
        conn.execute("RELEASE SAVEPOINT digest_acknowledgement")
        if owns_transaction:
            conn.rollback()
        raise
    try:
        conn.execute("RELEASE SAVEPOINT digest_acknowledgement")
        if owns_transaction:
            conn.commit()
    except BaseException:
        if owns_transaction:
            conn.rollback()
        else:
            try:
                conn.execute("ROLLBACK TO SAVEPOINT digest_acknowledgement")
                conn.execute("RELEASE SAVEPOINT digest_acknowledgement")
            except sqlite3.Error:
                # Preserve the original error and leave the caller in control
                # if SQLite has already invalidated the savepoint.
                pass
        raise
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
    if _timestamp_after(candidate, now_iso):
        return now_iso
    return candidate


def _timestamp_after(left: str, right: str) -> bool:
    left_time = _parse_utc_timestamp(left)
    right_time = _parse_utc_timestamp(right)
    if left_time is None or right_time is None:
        return False
    if left_time != right_time:
        return left_time > right_time
    # fromisoformat keeps microseconds; preserve finer historical fractions
    # when comparing a stored watermark with a requested acknowledgement.
    def tail(value: str) -> str:
        match = re.search(r"[T ]\d{2}:\d{2}:\d{2}[.,](\d+)(?:Z|[+-]\d{2}:?\d{2})?$", value.strip(), re.IGNORECASE)
        return match.group(1)[6:] if match else ""

    left_tail, right_tail = tail(left), tail(right)
    width = max(len(left_tail), len(right_tail))
    return left_tail.ljust(width, "0") > right_tail.ljust(width, "0")


def _parse_utc_timestamp(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        raw = value.strip()
        if raw.endswith(("Z", "z")):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        # Date.parse treats a date-only ISO string as UTC.
        if len(raw) == 10:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def _digest_instant(value: str | None) -> datetime | None:
    parsed = _parse_utc_timestamp(value)
    if parsed is None:
        return None
    # The Jobs API compares Date.parse instants at millisecond precision.
    return parsed.replace(microsecond=(parsed.microsecond // 1000) * 1000)


def _record_digest_reviewed_event(
    conn: sqlite3.Connection,
    *,
    acknowledged_at: str,
    previous_acknowledged_at: str | None,
    reviewed_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, level,
            message, occurred_at, payload_json, entity_kind, entity_ref, idempotency_key
        ) VALUES (?, NULL, 1, NULL, 'DigestReviewed', 'info', ?, ?, ?, 'digest', 'daily', NULL)
        """,
        (
            TENANT_ID,
            "Digest reviewed.",
            reviewed_at,
            json.dumps(
                {
                    "tenantId": TENANT_ID,
                    "acknowledgedAt": acknowledged_at,
                    "previousAcknowledgedAt": previous_acknowledged_at,
                    "reviewedAt": reviewed_at,
                },
                separators=(",", ":"),
            ),
        ),
    )


def _budget_payload(status: SpendBudgetStatus) -> dict[str, Any]:
    unlimited = status.daily_budget_usd <= 0
    remaining = None if unlimited else max(0.0, status.daily_budget_usd - status.estimated_usd)
    return {
        "status": "over_budget" if status.global_exceeded else "ok",
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
    active_clauses, active_params = _active_job_clauses("job_list_projections")
    clauses = ["tenant_id = ?", "deleted_at IS NULL", *active_clauses]
    params: list[Any] = [TENANT_ID, *active_params]
    if since:
        watermark = _digest_instant(since)
        if watermark is None:
            raise ValueError("digest watermark is not a valid timestamp")
        rows = _query(
            conn,
            "SELECT discovered_at, scored_at, fit_score FROM job_list_projections WHERE " + " AND ".join(clauses),
            params,
        )
        count = high_fit = 0
        for row in rows:
            discovered = _digest_instant(_row_get(row, "discovered_at"))
            scored = _digest_instant(_row_get(row, "scored_at"))
            if not ((discovered is not None and discovered >= watermark) or (scored is not None and scored >= watermark)):
                continue
            count += 1
            score = _row_get(row, "fit_score")
            if score is not None and score >= high_fit_threshold:
                high_fit += 1
        return {"count": count, "highFitCount": high_fit}
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
    rows = _query(
        conn,
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
    names = {
        str(_row_get(row, "source_id")): str(_row_get(row, "display_name") or "")
        for row in _query(
            conn,
            "SELECT source_id, display_name FROM source_registry_entries WHERE tenant_id = ?",
            (TENANT_ID,),
        ).fetchall()
    }
    for source in sources:
        source_id = source["sourceId"]
        display_name = names.get(source_id) or source_id
        if source_id.startswith("jobspy:"):
            from jobctrl.config import _jobstreaming_source_display_name

            display_name = _jobstreaming_source_display_name(source_id.split(":", 1)[1].replace("-", "_"))
        if display_name != source_id:
            source["displayName"] = display_name
    return {"count": len(sources), "sources": sources}


def _blocked_source_predicate(source: dict[str, Any]) -> bool:
    return source["recommendedState"] in {"quarantined", "disabled"} or source["consecutiveFailures"] >= 3


def _operational_only_source_health(conn: sqlite3.Connection, seen: set[str]) -> list[dict[str, Any]]:
    rows = _query(
        conn,
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
    latest_decision_sql, latest_decision_params = _latest_decision_cte()
    latest_apply_run_sql = _latest_apply_run_cte()
    active_clauses, active_params = _active_job_clauses("jlp")
    active_sql = "".join(f"\n          AND {clause}" for clause in active_clauses)
    return _query(
        conn,
        latest_decision_sql
        + latest_apply_run_sql
        + f"""
        , latest_digest_apply_stage AS (
            SELECT tenant_id, job_id, state
            FROM job_stage_states
            WHERE stage = 'apply'
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
         AND apply_stage.job_id = jlp.job_id
        LEFT JOIN latest_digest_decision latest_decision
          ON latest_decision.tenant_id = jlp.tenant_id
         AND latest_decision.job_id = jlp.job_id
        LEFT JOIN latest_digest_apply_run latest_apply_run
          ON latest_apply_run.tenant_id = jlp.tenant_id
         AND latest_apply_run.job_id = jlp.job_id
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


def _active_job_clauses(alias: str) -> tuple[list[str], list[Any]]:
    placeholders = ", ".join("?" for _ in _CLOSED_ACTIVE_STATES)
    return [
        "EXISTS (SELECT 1 FROM jobs j "
        f"WHERE j.tenant_id = {alias}.tenant_id AND j.job_id = {alias}.job_id)",
        "NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h "
        f"WHERE h.tenant_id = {alias}.tenant_id AND h.job_id = {alias}.job_id "
        "AND h.unhidden_at IS NULL)",
        "NOT EXISTS ("
        "SELECT 1 FROM posting_snapshot_sets pss "
        f"WHERE pss.tenant_id = {alias}.tenant_id "
        f"AND pss.job_id = {alias}.job_id "
        f"AND pss.latest_active_state IN ({placeholders})"
        ")",
    ], list(_CLOSED_ACTIVE_STATES)


def _active_job_id_set(conn: sqlite3.Connection) -> set[str]:
    active_clauses, active_params = _active_job_clauses("jlp")
    clauses = ["jlp.tenant_id = ?", "jlp.deleted_at IS NULL", *active_clauses]
    rows = _query(
        conn,
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


def _latest_decision_cte() -> tuple[str, list[Any]]:
    return (
        """
        WITH latest_digest_decision AS (
            SELECT tenant_id, job_id, decision
            FROM (
                SELECT tenant_id, job_id, decision,
                       ROW_NUMBER() OVER (
                           PARTITION BY tenant_id, job_id
                           ORDER BY decided_at DESC, CASE WHEN decision = 'approve_submit' THEN 0 ELSE 1 END DESC, decision_id DESC
                       ) AS row_num
                FROM application_review_decisions
                WHERE tenant_id = ?
            )
            WHERE row_num = 1
        )
        """,
        [TENANT_ID],
    )


def _latest_apply_run_cte() -> str:
    return (
        """
        , latest_digest_apply_run AS (
            SELECT tenant_id, job_id, status, result
            FROM (
                SELECT tenant_id, job_id, status, result,
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
    active_jobs = _active_job_id_set(conn)
    rows = _query(
        conn,
        """
        SELECT DISTINCT stale.job_id
        FROM job_score_staleness stale
        JOIN (
            SELECT tenant_id, job_id, MAX(version) AS max_version
            FROM job_scores
            WHERE tenant_id = ?
            GROUP BY tenant_id, job_id
        ) latest ON latest.tenant_id = stale.tenant_id AND latest.job_id = stale.job_id
        JOIN job_scores scores
          ON scores.tenant_id = stale.tenant_id
         AND scores.job_id = stale.job_id
         AND scores.version = latest.max_version
        WHERE stale.tenant_id = ?
          AND stale.resolved = 0
        """,
        [TENANT_ID, TENANT_ID],
    ).fetchall()
    return sum(1 for row in rows if _row_get(row, "job_id") in active_jobs)


def _count_follow_ups_due(conn: sqlite3.Connection, *, now: datetime) -> int:
    cutoff = _digest_instant(_format_utc_timestamp(now - timedelta(days=FOLLOW_UP_THRESHOLD_DAYS)))
    assert cutoff is not None
    rows = _query(
        conn,
        """
        SELECT o.job_id, o.kind, o.occurred_at, o.recorded_at
        FROM application_outcomes o
        WHERE o.tenant_id = ?
          AND EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.tenant_id = o.tenant_id AND j.job_id = o.job_id
          )
        ORDER BY o.job_id ASC, o.occurred_at ASC, o.recorded_at ASC
        """,
        (TENANT_ID,),
    ).fetchall()
    events: list[tuple[str, datetime, datetime, str]] = []
    for row in rows:
        job_id = str(_row_get(row, "job_id") or "")
        occurred_at = _digest_instant(_row_get(row, "occurred_at") or _row_get(row, "recorded_at"))
        if not job_id or occurred_at is None:
            continue
        recorded_at = _digest_instant(_row_get(row, "recorded_at")) or occurred_at
        events.append((job_id, occurred_at, recorded_at, str(_row_get(row, "kind") or "")))
    by_job: dict[str, dict[str, Any]] = {}
    for job_id, occurred_at, _recorded_at, kind in sorted(events):
        current = by_job.setdefault(
            job_id,
            {"appliedAt": None, "lastActivityAt": None, "stopped": False},
        )
        if current["lastActivityAt"] is None or occurred_at > current["lastActivityAt"]:
            current["lastActivityAt"] = occurred_at
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
    row = _query(conn, sql, params).fetchone()
    return int(_row_get(row, "count") or 0) if row is not None else 0


def _query(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> sqlite3.Cursor:
    # Use named rows for digest reads without changing the caller's connection.
    cursor = conn.cursor()
    cursor.row_factory = sqlite3.Row
    return cursor.execute(sql, params)


def _row_get(row: Any, key: str) -> Any:
    try:
        return row[key]
    except (IndexError, KeyError, TypeError):
        return None
