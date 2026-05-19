"""SqliteScoreRepository — local-mode adapter for the Scoring context.

Persists ``JobScore`` aggregates to the ``job_scores`` table created by
``database.ensure_score_tables``. Versioning is enforced at save time:
every ``save`` call must hand in an aggregate whose ``version`` is exactly
``current_max + 1`` (or ``1`` when there is no row yet) — otherwise the
adapter raises ``ScoreVersionConflict`` so callers cannot accidentally
overwrite history.

Local-mode treats ``job_id`` as the legacy ``jobs.url`` primary key. When
the cloud cutover (Phase 9) introduces stable system-generated ``JobId``
values, the adapter swaps the column without touching the port.

See ddd-target.md §7.1 / §7.2 (per-aggregate repository, schema decoupling).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobhunter.database import ensure_score_staleness_tables, ensure_scoring_policy_tables
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring.aggregate import JobScore, ScoreStaleMarker
from jobhunter.domain.scoring.policy import CorrectionSignal, ScoringPolicy
from jobhunter.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.state import record_job_event, set_stage_state


class ScoreVersionConflict(ValueError):
    """Raised when ``save`` is given a non-monotonic version.

    Carries the expected next version so the caller can rebuild the
    aggregate via ``loaded.next_version(...)`` instead of guessing.
    """

    def __init__(self, *, job_id: JobId, attempted: int, expected: int) -> None:
        self.job_id = job_id
        self.attempted = attempted
        self.expected = expected
        super().__init__(
            f"JobScore version conflict for job_id={job_id!r}: "
            f"got version={attempted}, expected {expected}"
        )


class SqliteScoreStalenessRepository:
    """SQLite-backed score-staleness marker adapter."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_score_staleness_tables(conn)

    def mark_comparable_scores_stale(
        self,
        *,
        tenant_id: TenantId,
        stale_reason: str,
        new_policy_id: str,
        new_policy_version: int,
        marked_at: str,
    ) -> list[ScoreStaleMarker]:
        """Mark latest uncorrected scores that were produced by older policies."""
        if new_policy_version <= 0:
            return []

        marked: list[ScoreStaleMarker] = []
        rows = self._conn.execute(
            """
            SELECT s.job_url, s.trace_json
            FROM job_scores s
            INNER JOIN (
                SELECT job_url, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY job_url
            ) latest
              ON latest.job_url = s.job_url AND latest.max_version = s.version
            WHERE s.tenant_id = ?
              AND (s.correction_json IS NULL OR TRIM(s.correction_json) = '')
            """,
            (str(tenant_id), str(tenant_id)),
        ).fetchall()
        for row in rows:
            job_url = _row_value(row, "job_url", 0)
            trace = _json_object(_row_value(row, "trace_json", 1))
            old_policy_version = _int_or_default(trace.get("scoring_policy_version"), 0)
            if old_policy_version >= new_policy_version:
                continue

            marker = ScoreStaleMarker(
                tenant_id=tenant_id,
                job_id=JobId(str(job_url)),
                stale_reason=stale_reason,
                old_policy_id=str(trace.get("scoring_policy_id") or ""),
                old_policy_version=old_policy_version,
                new_policy_id=new_policy_id,
                new_policy_version=new_policy_version,
                marked_at=marked_at,
            )
            inserted = self._conn.execute(
                """
                INSERT OR IGNORE INTO job_score_staleness (
                    tenant_id, job_url, stale_reason,
                    old_policy_id, old_policy_version,
                    new_policy_id, new_policy_version,
                    marked_at, resolved, resolved_at, resolved_by_score_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
                """,
                (
                    str(marker.tenant_id),
                    str(marker.job_id),
                    marker.stale_reason,
                    marker.old_policy_id,
                    marker.old_policy_version,
                    marker.new_policy_id,
                    marker.new_policy_version,
                    marker.marked_at,
                ),
            )
            if inserted.rowcount <= 0:
                continue
            marked.append(marker)
            self._mark_score_stage_stale(marker)

        self._conn.commit()
        return marked

    def resolve_for_score(self, score: JobScore) -> int:
        """Resolve markers satisfied by a fresh, non-corrected score version."""
        if score.correction is not None or score.trace.scoring_policy_version <= 0:
            return 0
        now = _utc_now()
        result = self._conn.execute(
            """
            UPDATE job_score_staleness
               SET resolved = 1,
                   resolved_at = ?,
                   resolved_by_score_version = ?
             WHERE tenant_id = ?
               AND job_url = ?
               AND resolved = 0
               AND new_policy_version <= ?
            """,
            (
                now,
                score.version,
                str(score.tenant_id),
                str(score.job_id),
                score.trace.scoring_policy_version,
            ),
        )
        if result.rowcount > 0:
            self._record_score_event(
                str(score.job_id),
                "ScoreStalenessResolved",
                "Score stale marker resolved by a fresh score.",
                {
                    "tenantId": str(score.tenant_id),
                    "jobId": str(score.job_id),
                    "scoreVersion": score.version,
                    "scoringPolicyVersion": score.trace.scoring_policy_version,
                },
            )
        self._conn.commit()
        return int(result.rowcount)

    def reset_for_rescore(
        self,
        tenant_id: TenantId,
        *,
        limit: int = 0,
        reset_at: str | None = None,
    ) -> list[ScoreStaleMarker]:
        """Clear active markers and reset their score stage for explicit rescore."""
        now = reset_at or _utc_now()
        sql = (
            "SELECT tenant_id, job_url, stale_reason, old_policy_id, "
            "old_policy_version, new_policy_id, new_policy_version, marked_at, "
            "resolved, resolved_at, resolved_by_score_version "
            "FROM job_score_staleness "
            "WHERE tenant_id = ? AND resolved = 0 "
            "ORDER BY marked_at ASC"
        )
        params: list[Any] = [str(tenant_id)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        markers = [self._row_to_marker(row) for row in rows]
        for marker in markers:
            job_url = str(marker.job_id)
            set_stage_state(
                self._conn,
                job_url,
                "score",
                "pending",
                attempt_count=0,
                next_action="jobhunter run score --rescore",
                metadata={
                    "stale_reason": marker.stale_reason,
                    "new_policy_version": marker.new_policy_version,
                },
                validate_transition=False,
            )
            self._conn.execute(
                """
                UPDATE job_score_staleness
                   SET resolved = 1,
                       resolved_at = ?
                 WHERE tenant_id = ?
                   AND job_url = ?
                   AND stale_reason = ?
                   AND old_policy_version = ?
                   AND new_policy_version = ?
                """,
                (
                    now,
                    str(marker.tenant_id),
                    job_url,
                    marker.stale_reason,
                    marker.old_policy_version,
                    marker.new_policy_version,
                ),
            )
            self._record_score_event(
                job_url,
                "ScoreRescoreRequested",
                "Stale score reset for explicit rescore.",
                {
                    "tenantId": str(marker.tenant_id),
                    "jobId": job_url,
                    "staleReason": marker.stale_reason,
                    "oldPolicyVersion": marker.old_policy_version,
                    "newPolicyVersion": marker.new_policy_version,
                    "nextAction": "jobhunter run score --rescore",
                },
            )
        self._conn.commit()
        return markers

    def _mark_score_stage_stale(self, marker: ScoreStaleMarker) -> None:
        job_url = str(marker.job_id)
        row = self._conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
            (job_url,),
        ).fetchone()
        state = _row_value(row, "state", 0) if row is not None else None
        if state in (None, "succeeded"):
            set_stage_state(
                self._conn,
                job_url,
                "score",
                "stale",
                metadata={
                    "stale_reason": marker.stale_reason,
                    "old_policy_version": marker.old_policy_version,
                    "new_policy_version": marker.new_policy_version,
                },
            )
        self._record_score_event(
            job_url,
            "ScoreMarkedStale",
            "Score marked stale after scoring policy changed.",
            {
                "tenantId": str(marker.tenant_id),
                "jobId": job_url,
                "staleReason": marker.stale_reason,
                "oldPolicyId": marker.old_policy_id,
                "oldPolicyVersion": marker.old_policy_version,
                "newPolicyId": marker.new_policy_id,
                "newPolicyVersion": marker.new_policy_version,
                "markedAt": marker.marked_at,
            },
        )

    def _record_score_event(
        self,
        job_url: str,
        event_type: str,
        message: str,
        payload: dict[str, Any],
    ) -> None:
        if not _table_exists(self._conn, "job_events"):
            return
        record_job_event(
            self._conn,
            job_url,
            "score",
            event_type,
            message=message,
            payload=payload,
        )

    @staticmethod
    def _row_to_marker(row: Any) -> ScoreStaleMarker:
        return ScoreStaleMarker(
            tenant_id=TenantId(str(_row_value(row, "tenant_id", 0))),
            job_id=JobId(str(_row_value(row, "job_url", 1))),
            stale_reason=str(_row_value(row, "stale_reason", 2)),
            old_policy_id=str(_row_value(row, "old_policy_id", 3) or ""),
            old_policy_version=int(_row_value(row, "old_policy_version", 4) or 0),
            new_policy_id=str(_row_value(row, "new_policy_id", 5) or ""),
            new_policy_version=int(_row_value(row, "new_policy_version", 6) or 0),
            marked_at=str(_row_value(row, "marked_at", 7)),
            resolved=bool(_row_value(row, "resolved", 8)),
            resolved_at=_row_value(row, "resolved_at", 9),
            resolved_by_score_version=_row_value(row, "resolved_by_score_version", 10),
        )


class SqliteScoreRepository:
    """SQLite-backed implementation of ``ScoreRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly so consumers hold the row immediately
    (the in-process bus only fires once committed in Phase 5; the cloud
    outbox cutover is Phase 9). Tests inject their own connection via the
    constructor for isolation.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._staleness = SqliteScoreStalenessRepository(conn)

    @property
    def connection(self) -> sqlite3.Connection:
        """SQLite connection backing this repository."""
        return self._conn

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, job_id: JobId) -> JobScore | None:
        row = self._conn.execute(
            """
            SELECT job_url, version, fit_score, breakdown_json, keywords_json,
                   scored_at, correction_json, criteria_json, trace_json
            FROM job_scores
            WHERE job_url = ? AND tenant_id = ?
            ORDER BY version DESC
            LIMIT 1
            """,
            (str(job_id), str(tenant_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_score(row, tenant_id)

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return job URLs that have a description but no score row yet."""
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT j.url FROM jobs j "
            "LEFT JOIN job_scores s ON s.job_url = j.url AND s.tenant_id = ? "
            "WHERE j.full_description IS NOT NULL AND s.job_url IS NULL "
            "ORDER BY j.discovered_at DESC NULLS LAST"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [JobId(row[0]) for row in rows if row[0]]

    def list_by_score_range(
        self,
        tenant_id: TenantId,
        *,
        min_score: int,
        max_score: int = 10,
    ) -> list[JobScore]:
        if min_score < 1 or min_score > 10:
            raise ValueError(f"min_score must be in [1, 10], got {min_score}")
        if max_score < min_score or max_score > 10:
            raise ValueError(
                f"max_score must satisfy min_score <= max_score <= 10, got {max_score}"
            )

        rows = self._conn.execute(
            """
            SELECT s.job_url, s.version, s.fit_score, s.breakdown_json,
                   s.keywords_json, s.scored_at, s.correction_json,
                   s.criteria_json, s.trace_json
            FROM job_scores s
            INNER JOIN (
                SELECT job_url, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY job_url
            ) latest
              ON latest.job_url = s.job_url AND latest.max_version = s.version
            WHERE s.tenant_id = ?
              AND s.fit_score BETWEEN ? AND ?
            ORDER BY s.fit_score DESC, s.scored_at DESC
            """,
            (str(tenant_id), str(tenant_id), min_score, max_score),
        ).fetchall()
        return [self._row_to_score(row, tenant_id) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, score: JobScore) -> None:
        latest = self._conn.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM job_scores "
            "WHERE job_url = ? AND tenant_id = ?",
            (str(score.job_id), str(score.tenant_id)),
        ).fetchone()
        current_max = int(latest[0] if latest else 0)
        expected = current_max + 1
        if score.version != expected:
            raise ScoreVersionConflict(
                job_id=score.job_id,
                attempted=score.version,
                expected=expected,
            )

        self._conn.execute(
            """
            INSERT INTO job_scores (
                job_url, version, tenant_id, fit_score, breakdown_json,
                keywords_json, scored_at, correction_json, criteria_json, trace_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(score.job_id),
                score.version,
                str(score.tenant_id),
                score.fit_score.value,
                json.dumps(score.breakdown.to_dict(), sort_keys=True),
                json.dumps(score.matched_keywords.to_list()),
                score.scored_at,
                (
                    json.dumps(score.correction.to_dict(), sort_keys=True)
                    if score.correction
                    else None
                ),
                json.dumps(score.criteria.to_dict(), sort_keys=True),
                json.dumps(score.trace.to_dict(), sort_keys=True),
            ),
        )
        self._staleness.resolve_for_score(score)
        self._conn.commit()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_score(row: Any, tenant_id: TenantId | None = None) -> JobScore:
        if isinstance(row, sqlite3.Row):
            job_url = row["job_url"]
            version = row["version"]
            fit_score = row["fit_score"]
            breakdown_json = row["breakdown_json"]
            keywords_json = row["keywords_json"]
            scored_at = row["scored_at"]
            correction_json = row["correction_json"]
            criteria_json = row["criteria_json"] if "criteria_json" in row.keys() else None
            trace_json = row["trace_json"] if "trace_json" in row.keys() else None
        else:
            if len(row) >= 9:
                (
                    job_url,
                    version,
                    fit_score,
                    breakdown_json,
                    keywords_json,
                    scored_at,
                    correction_json,
                    criteria_json,
                    trace_json,
                ) = row
            else:
                job_url, version, fit_score, breakdown_json, keywords_json, scored_at, correction_json = row
                criteria_json = None
                trace_json = None

        breakdown_data = json.loads(breakdown_json) if breakdown_json else {}
        keywords_data = json.loads(keywords_json) if keywords_json else []
        correction_data = json.loads(correction_json) if correction_json else None
        criteria_data = json.loads(criteria_json) if criteria_json else None
        trace_data = json.loads(trace_json) if trace_json else None

        return JobScore(
            tenant_id=tenant_id or LOCAL_TENANT,
            job_id=JobId(str(job_url)),
            version=int(version),
            fit_score=FitScore(value=int(fit_score)),
            breakdown=ScoreBreakdown.from_dict(breakdown_data),
            matched_keywords=MatchedKeywords.from_iterable(keywords_data),
            scored_at=str(scored_at),
            criteria=ScoringCriteria.from_dict(criteria_data),
            trace=ScoreTrace.from_dict(trace_data),
            correction=ScoreCorrection.from_dict(correction_data) if correction_data else None,
        )


class SqliteScoringPolicyRepository:
    """SQLite-backed current policy adapter for the Scoring context."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_scoring_policy_tables(conn)

    def get_current(self, tenant_id: TenantId) -> ScoringPolicy:
        row = self._conn.execute(
            """
            SELECT tenant_id, version, rubric_json, anchors_json, created_at,
                   created_from_event_id
            FROM scoring_policies
            WHERE tenant_id = ?
            ORDER BY version DESC
            LIMIT 1
            """,
            (str(tenant_id),),
        ).fetchone()
        if row is not None:
            return self._row_to_policy(row)

        policy = ScoringPolicy.default(tenant_id, created_at=_utc_now())
        self.save(policy)
        return policy

    def save(self, policy: ScoringPolicy) -> None:
        self._conn.execute(
            """
            INSERT INTO scoring_policies (
                tenant_id, version, rubric_json, anchors_json, created_at,
                created_from_event_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                str(policy.tenant_id),
                policy.version,
                json.dumps(policy.to_rubric_dict(), sort_keys=True),
                json.dumps(policy.to_anchors_list(), sort_keys=True),
                policy.created_at or _utc_now(),
                policy.created_from_event_id,
            ),
        )
        self._conn.commit()

    def save_correction_signal(self, signal: CorrectionSignal) -> ScoringPolicy:
        current = self.get_current(signal.tenant_id)
        next_policy = current.with_correction_signal(signal)
        self.save(next_policy)
        return next_policy

    @staticmethod
    def _row_to_policy(row: Any) -> ScoringPolicy:
        if isinstance(row, sqlite3.Row):
            tenant_id = row["tenant_id"]
            version = row["version"]
            rubric_json = row["rubric_json"]
            anchors_json = row["anchors_json"]
            created_at = row["created_at"]
            created_from_event_id = row["created_from_event_id"]
        else:
            (
                tenant_id,
                version,
                rubric_json,
                anchors_json,
                created_at,
                created_from_event_id,
            ) = row
        return ScoringPolicy.from_persistence(
            tenant_id=TenantId(str(tenant_id)),
            version=int(version),
            rubric=json.loads(rubric_json) if rubric_json else {},
            anchors=json.loads(anchors_json) if anchors_json else [],
            created_at=str(created_at),
            created_from_event_id=created_from_event_id,
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_value(row: Any, name: str, index: int) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[name]
    return row[index]


def _json_object(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _int_or_default(raw: Any, default: int) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None
