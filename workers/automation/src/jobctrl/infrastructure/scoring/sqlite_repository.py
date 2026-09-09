"""SqliteScoreRepository — local-mode adapter for the Scoring context.

Persists ``JobScore`` aggregates to the exact-v7 ``job_scores`` table.
Versioning is enforced at save time:
every ``save`` call must hand in an aggregate whose ``version`` is exactly
``current_max + 1`` (or ``1`` when there is no row yet) — otherwise the
adapter raises ``ScoreVersionConflict`` so callers cannot accidentally
overwrite history.

The exact-v7 schema owns initialization and accepts only canonical UUID
``JobId`` values scoped by ``tenant_id``. Posting URLs remain job locators.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Final

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.scoring.aggregate import JobScore, ScoreStaleMarker
from jobctrl.domain.scoring.policy import CorrectionSignal, ScoringPolicy
from jobctrl.domain.scoring.value_objects import (
    FitScore,
    MatchedKeywords,
    RequirementArtifactCoverage,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
    ScoreBreakdown,
    ScoreCorrection,
    ScoreTrace,
    ScoringCriteria,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.scoring.keyword_normalization import canonicalize_keywords
from jobctrl.state import record_job_event, set_stage_state


_SCORE_SAVEPOINT: Final = "score_with_keywords"


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
            SELECT s.job_id, s.trace_json
            FROM job_scores s
            INNER JOIN (
                SELECT tenant_id, job_id, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY tenant_id, job_id
            ) latest
              ON latest.tenant_id = s.tenant_id
             AND latest.job_id = s.job_id
             AND latest.max_version = s.version
            WHERE s.tenant_id = ?
              AND (s.correction_json IS NULL OR TRIM(s.correction_json) = '')
            """,
            (str(tenant_id), str(tenant_id)),
        ).fetchall()
        for row in rows:
            job_id = canonical_job_id(str(row["job_id"]))
            trace = _json_object(row["trace_json"])
            old_policy_version = _int_or_default(trace.get("scoring_policy_version"), 0)
            if old_policy_version >= new_policy_version:
                continue

            marker = ScoreStaleMarker(
                tenant_id=tenant_id,
                job_id=job_id,
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
                    tenant_id, job_id, stale_reason,
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

    def resolve_for_score(self, score: JobScore, *, commit: bool = True) -> int:
        """Resolve markers satisfied by a fresh, non-corrected score version."""
        if score.correction is not None or score.trace.scoring_policy_version <= 0:
            return 0
        job_id = canonical_job_id(str(score.job_id))
        now = _utc_now()
        result = self._conn.execute(
            """
            UPDATE job_score_staleness
               SET resolved = 1,
                   resolved_at = ?,
                   resolved_by_score_version = ?
             WHERE tenant_id = ?
               AND job_id = ?
               AND resolved = 0
               AND new_policy_version <= ?
            """,
            (
                now,
                score.version,
                str(score.tenant_id),
                str(job_id),
                score.trace.scoring_policy_version,
            ),
        )
        if result.rowcount > 0:
            self._record_score_event(
                score.tenant_id,
                job_id,
                "ScoreStalenessResolved",
                "Score stale marker resolved by a fresh score.",
                {
                    "tenantId": str(score.tenant_id),
                    "jobId": str(job_id),
                    "scoreVersion": score.version,
                    "scoringPolicyVersion": score.trace.scoring_policy_version,
                },
            )
        if commit:
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
            "SELECT tenant_id, job_id, stale_reason, old_policy_id, "
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
            set_stage_state(
                self._conn,
                marker.job_id,
                "score",
                "pending",
                tenant_id=marker.tenant_id,
                attempt_count=0,
                next_action="jobctrl run score --rescore",
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
                   AND job_id = ?
                   AND stale_reason = ?
                   AND old_policy_version = ?
                   AND new_policy_version = ?
                """,
                (
                    now,
                    str(marker.tenant_id),
                    str(marker.job_id),
                    marker.stale_reason,
                    marker.old_policy_version,
                    marker.new_policy_version,
                ),
            )
            self._record_score_event(
                marker.tenant_id,
                marker.job_id,
                "ScoreRescoreRequested",
                "Stale score reset for explicit rescore.",
                {
                    "tenantId": str(marker.tenant_id),
                    "jobId": str(marker.job_id),
                    "staleReason": marker.stale_reason,
                    "oldPolicyVersion": marker.old_policy_version,
                    "newPolicyVersion": marker.new_policy_version,
                    "nextAction": "jobctrl run score --rescore",
                },
            )
        self._conn.commit()
        return markers

    def _mark_score_stage_stale(self, marker: ScoreStaleMarker) -> None:
        row = self._conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
            (str(marker.tenant_id), str(marker.job_id)),
        ).fetchone()
        state = row["state"] if row is not None else None
        if state in (None, "succeeded"):
            set_stage_state(
                self._conn,
                marker.job_id,
                "score",
                "stale",
                tenant_id=marker.tenant_id,
                metadata={
                    "stale_reason": marker.stale_reason,
                    "old_policy_version": marker.old_policy_version,
                    "new_policy_version": marker.new_policy_version,
                },
            )
        self._record_score_event(
            marker.tenant_id,
            marker.job_id,
            "ScoreMarkedStale",
            "Score marked stale after scoring policy changed.",
            {
                "tenantId": str(marker.tenant_id),
                "jobId": str(marker.job_id),
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
        tenant_id: TenantId,
        job_id: JobId,
        event_type: str,
        message: str,
        payload: dict[str, Any],
    ) -> None:
        record_job_event(
            self._conn,
            job_id,
            "score",
            event_type,
            tenant_id=tenant_id,
            message=message,
            payload=payload,
        )

    @staticmethod
    def _row_to_marker(row: sqlite3.Row) -> ScoreStaleMarker:
        return ScoreStaleMarker(
            tenant_id=TenantId(str(row["tenant_id"])),
            job_id=canonical_job_id(str(row["job_id"])),
            stale_reason=str(row["stale_reason"]),
            old_policy_id=str(row["old_policy_id"] or ""),
            old_policy_version=int(row["old_policy_version"] or 0),
            new_policy_id=str(row["new_policy_id"] or ""),
            new_policy_version=int(row["new_policy_version"] or 0),
            marked_at=str(row["marked_at"]),
            resolved=bool(row["resolved"]),
            resolved_at=row["resolved_at"],
            resolved_by_score_version=row["resolved_by_score_version"],
        )


class SqliteRequirementFitReportRepository:
    """SQLite-backed requirement fit report adapter."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        score_version: int | None = None,
    ) -> RequirementFitReport | None:
        stable_job_id = canonical_job_id(str(job_id))
        if score_version is None:
            row = self._conn.execute(
                """
                SELECT job_id, score_version, tenant_id,
                       employer_analysis_generation, profile_snapshot_version,
                       scoring_policy_version, formula_version,
                       resolved_fit_score, fit_band, confidence, summary_json
                 FROM job_requirement_fit_reports
                 WHERE tenant_id = ?
                   AND job_id = ?
                 ORDER BY score_version DESC
                 LIMIT 1
                """,
                (str(tenant_id), str(stable_job_id)),
            ).fetchone()
        else:
            row = self._conn.execute(
                """
                SELECT job_id, score_version, tenant_id,
                       employer_analysis_generation, profile_snapshot_version,
                       scoring_policy_version, formula_version,
                       resolved_fit_score, fit_band, confidence, summary_json
                  FROM job_requirement_fit_reports
                 WHERE tenant_id = ?
                   AND job_id = ?
                   AND score_version = ?
                 LIMIT 1
                """,
                (str(tenant_id), str(stable_job_id), score_version),
            ).fetchone()
        if row is None:
            return None

        stored_job_id = canonical_job_id(str(row["job_id"]))
        version = _int_or_default(row["score_version"], 0)
        item_rows = self._conn.execute(
            """
            SELECT requirement_id, requirement_text, tier, weight,
                   job_evidence_span, fit_json, contribution_json,
                   tailoring_json, artifact_coverage_json
             FROM job_requirement_fit_items
             WHERE tenant_id = ?
               AND job_id = ?
               AND score_version = ?
             ORDER BY position ASC, requirement_id ASC
            """,
            (str(tenant_id), str(stored_job_id), version),
        ).fetchall()
        assessments = tuple(self._row_to_assessment(item) for item in item_rows)
        return RequirementFitReport(
            job_id=stored_job_id,
            score_version=version,
            employer_analysis_generation=_int_or_default(
                row["employer_analysis_generation"],
                0,
            ),
            profile_snapshot_version=_int_or_default(
                row["profile_snapshot_version"],
                0,
            ),
            scoring_policy_version=_int_or_default(
                row["scoring_policy_version"],
                0,
            ),
            formula_version=str(row["formula_version"] or ""),
            resolved_fit_score=FitScore.from_optional(row["resolved_fit_score"]),
            fit_band=str(row["fit_band"] or "plausible"),
            confidence=str(row["confidence"] or "medium"),
            summary=RequirementFitSummary.from_dict(_json_object(row["summary_json"])),
            assessments=assessments,
        )

    def save(self, tenant_id: TenantId, report: RequirementFitReport) -> None:
        job_id = canonical_job_id(str(report.job_id))
        now = _utc_now()
        self._conn.execute(
            """
            INSERT INTO job_requirement_fit_reports (
                tenant_id, job_id, score_version,
                employer_analysis_generation, profile_snapshot_version,
                scoring_policy_version, formula_version, resolved_fit_score,
                fit_band, confidence, summary_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id, score_version) DO UPDATE SET
                employer_analysis_generation = excluded.employer_analysis_generation,
                profile_snapshot_version = excluded.profile_snapshot_version,
                scoring_policy_version = excluded.scoring_policy_version,
                formula_version = excluded.formula_version,
                resolved_fit_score = excluded.resolved_fit_score,
                fit_band = excluded.fit_band,
                confidence = excluded.confidence,
                summary_json = excluded.summary_json,
                created_at = excluded.created_at
            """,
            (
                str(tenant_id),
                str(job_id),
                report.score_version,
                report.employer_analysis_generation,
                report.profile_snapshot_version,
                report.scoring_policy_version,
                report.formula_version,
                report.resolved_fit_score.value
                if report.resolved_fit_score is not None
                else None,
                report.fit_band,
                report.confidence,
                json.dumps(report.summary.to_dict(), sort_keys=True),
                now,
            ),
        )
        self._conn.execute(
            """
            DELETE FROM job_requirement_fit_items
             WHERE tenant_id = ?
               AND job_id = ?
               AND score_version = ?
            """,
            (str(tenant_id), str(job_id), report.score_version),
        )
        for position, assessment in enumerate(report.assessments):
            self._conn.execute(
                """
                INSERT INTO job_requirement_fit_items (
                    tenant_id, job_id, score_version, requirement_id,
                    requirement_text, tier, weight, job_evidence_span,
                    fit_json, contribution_json, tailoring_json,
                    artifact_coverage_json, position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(tenant_id),
                    str(job_id),
                    report.score_version,
                    assessment.requirement_id,
                    assessment.requirement_text,
                    assessment.tier,
                    assessment.weight,
                    assessment.job_evidence_span,
                    json.dumps(assessment.fit.to_dict(), sort_keys=True),
                    json.dumps(assessment.contribution.to_dict(), sort_keys=True),
                    json.dumps(assessment.tailoring.to_dict(), sort_keys=True),
                    (
                        json.dumps(assessment.artifact_coverage.to_dict(), sort_keys=True)
                        if assessment.artifact_coverage is not None
                        else None
                    ),
                    position,
                ),
            )
        self._conn.commit()

    @staticmethod
    def _row_to_assessment(row: sqlite3.Row) -> RequirementFitAssessment:
        coverage = row["artifact_coverage_json"]
        return RequirementFitAssessment(
            requirement_id=str(row["requirement_id"]),
            requirement_text=str(row["requirement_text"]),
            tier=str(row["tier"]),
            weight=float(row["weight"] or 0.0),
            job_evidence_span=str(row["job_evidence_span"] or ""),
            fit=RequirementFitStatus.from_dict(_json_object(row["fit_json"])),
            contribution=RequirementScoreContribution.from_dict(
                _json_object(row["contribution_json"])
            ),
            tailoring=RequirementTailoringDirective.from_dict(
                _json_object(row["tailoring_json"])
            ),
            artifact_coverage=(
                RequirementArtifactCoverage.from_dict(_json_object(coverage))
                if coverage
                else None
            ),
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
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT tenant_id, job_id, version, fit_score, breakdown_json,
                   keywords_json, scored_at, correction_json, criteria_json, trace_json
            FROM job_scores
            WHERE tenant_id = ? AND job_id = ?
            ORDER BY version DESC
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_score(row)

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return enriched canonical JobIds that have no score row yet."""
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT j.job_id FROM jobs j "
            "INNER JOIN job_enrichments e "
            "  ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id "
            "LEFT JOIN job_scores s ON s.tenant_id = j.tenant_id AND s.job_id = j.job_id "
            "WHERE j.tenant_id = ? AND e.current_status = 'enriched' "
            "  AND TRIM(e.full_description) <> '' AND s.job_id IS NULL "
            "ORDER BY j.discovered_at DESC NULLS LAST"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [canonical_job_id(str(row[0])) for row in rows if row[0]]

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
            SELECT s.tenant_id, s.job_id, s.version, s.fit_score,
                   s.breakdown_json, s.keywords_json, s.scored_at,
                   s.correction_json, s.criteria_json, s.trace_json
            FROM job_scores s
            INNER JOIN (
                SELECT tenant_id, job_id, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY tenant_id, job_id
            ) latest
              ON latest.tenant_id = s.tenant_id
             AND latest.job_id = s.job_id
             AND latest.max_version = s.version
            WHERE s.tenant_id = ?
              AND s.fit_score BETWEEN ? AND ?
            ORDER BY s.fit_score DESC, s.scored_at DESC
            """,
            (str(tenant_id), str(tenant_id), min_score, max_score),
        ).fetchall()
        return [self._row_to_score(row) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, score: JobScore) -> None:
        job_id = canonical_job_id(str(score.job_id))
        self._conn.execute(f"SAVEPOINT {_SCORE_SAVEPOINT}")
        try:
            latest = self._conn.execute(
                "SELECT COALESCE(MAX(version), 0) AS v FROM job_scores "
                "WHERE tenant_id = ? AND job_id = ?",
                (str(score.tenant_id), str(job_id)),
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
                    tenant_id, job_id, version, fit_score, breakdown_json,
                    keywords_json, scored_at, correction_json, criteria_json, trace_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(score.tenant_id),
                    str(job_id),
                    score.version,
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
            self._conn.executemany(
                """
                INSERT INTO job_score_keywords (
                    tenant_id, job_id, score_version, normalized_keyword,
                    display_keyword, position
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    (
                        str(score.tenant_id),
                        str(job_id),
                        score.version,
                        normalized_keyword,
                        display_keyword,
                        position,
                    )
                    for normalized_keyword, display_keyword, position in canonicalize_keywords(
                        score.matched_keywords.values
                    )
                ),
            )
            self._staleness.resolve_for_score(score, commit=False)
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {_SCORE_SAVEPOINT}")
            self._conn.execute(f"RELEASE SAVEPOINT {_SCORE_SAVEPOINT}")
            raise
        self._conn.execute(f"RELEASE SAVEPOINT {_SCORE_SAVEPOINT}")
        self._conn.commit()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_score(row: sqlite3.Row) -> JobScore:
        breakdown_data = json.loads(row["breakdown_json"]) if row["breakdown_json"] else {}
        keywords_data = json.loads(row["keywords_json"]) if row["keywords_json"] else []
        correction_data = json.loads(row["correction_json"]) if row["correction_json"] else None
        criteria_data = json.loads(row["criteria_json"]) if row["criteria_json"] else None
        trace_data = json.loads(row["trace_json"]) if row["trace_json"] else None

        return JobScore(
            tenant_id=TenantId(str(row["tenant_id"])),
            job_id=canonical_job_id(str(row["job_id"])),
            version=int(row["version"]),
            fit_score=FitScore(value=int(row["fit_score"])),
            breakdown=ScoreBreakdown.from_dict(breakdown_data),
            matched_keywords=MatchedKeywords.from_iterable(keywords_data),
            scored_at=str(row["scored_at"]),
            criteria=ScoringCriteria.from_dict(criteria_data),
            trace=ScoreTrace.from_dict(trace_data),
            correction=ScoreCorrection.from_dict(correction_data) if correction_data else None,
        )


class SqliteScoringPolicyRepository:
    """SQLite-backed current policy adapter for the Scoring context."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

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
