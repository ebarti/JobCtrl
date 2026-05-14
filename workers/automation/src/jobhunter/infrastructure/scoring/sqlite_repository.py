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
from typing import Any

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring.aggregate import JobScore
from jobhunter.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId


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
