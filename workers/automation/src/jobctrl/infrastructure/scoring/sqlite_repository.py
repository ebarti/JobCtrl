"""SqliteScoreRepository — local-mode adapter for the Scoring context.

Persists ``JobScore`` aggregates to the ``job_scores`` table created by
``database.ensure_score_tables``. Versioning is enforced at save time:
every ``save`` call must hand in an aggregate whose ``version`` is exactly
``current_max + 1`` (or ``1`` when there is no row yet) — otherwise the
adapter raises ``ScoreVersionConflict`` so callers cannot accidentally
overwrite history.

The aggregate identity and table primary key are both
``(tenant_id, job_id, version)``. Posting URLs are resolved only through
explicit compatibility methods while legacy workflow inputs are cut over.

See ddd-target.md §7.1 / §7.2 (per-aggregate repository, schema decoupling).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobctrl.database import (
    ensure_requirement_fit_tables,
    ensure_score_staleness_tables,
    ensure_scoring_policy_tables,
)
from jobctrl.domain.discovery.value_objects import PostingUrl
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
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.state import get_stage_state_row, record_job_event, set_stage_state


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
        self._reference_column = _job_reference_column(
            conn,
            "job_score_staleness",
        )
        self._score_reference_column = _job_reference_column(
            conn,
            "job_scores",
        )

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
        score_reference = self._score_reference_column
        identity_select, identity_join = _stable_identity_select(
            score_reference,
            source_alias="s",
        )
        rows = self._conn.execute(
            f"""
            SELECT {identity_select} AS job_id, s.trace_json
            FROM job_scores s
            {identity_join}
            INNER JOIN (
                SELECT tenant_id, {score_reference},
                       MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY tenant_id, {score_reference}
            ) latest
              ON latest.tenant_id = s.tenant_id
             AND latest.{score_reference} = s.{score_reference}
             AND latest.max_version = s.version
            WHERE s.tenant_id = ?
              AND (s.correction_json IS NULL OR TRIM(s.correction_json) = '')
            """,
            (str(tenant_id), str(tenant_id)),
        ).fetchall()
        for row in rows:
            stable_job_id = _row_value(row, "job_id", 0)
            trace = _json_object(_row_value(row, "trace_json", 1))
            old_policy_version = _int_or_default(trace.get("scoring_policy_version"), 0)
            if old_policy_version >= new_policy_version:
                continue

            marker = ScoreStaleMarker(
                tenant_id=tenant_id,
                job_id=JobId(str(stable_job_id)),
                stale_reason=stale_reason,
                old_policy_id=str(trace.get("scoring_policy_id") or ""),
                old_policy_version=old_policy_version,
                new_policy_id=new_policy_id,
                new_policy_version=new_policy_version,
                marked_at=marked_at,
            )
            reference_value = _reference_value_for_job_id(
                self._conn,
                tenant_id,
                marker.job_id,
                self._reference_column,
            )
            inserted = self._conn.execute(
                f"""
                INSERT OR IGNORE INTO job_score_staleness (
                    tenant_id, {self._reference_column}, stale_reason,
                    old_policy_id, old_policy_version,
                    new_policy_id, new_policy_version,
                    marked_at, resolved, resolved_at, resolved_by_score_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
                """,
                (
                    str(marker.tenant_id),
                    reference_value,
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
        reference_value = _reference_value_for_job_id(
            self._conn,
            score.tenant_id,
            score.job_id,
            self._reference_column,
        )
        result = self._conn.execute(
            f"""
            UPDATE job_score_staleness
               SET resolved = 1,
                   resolved_at = ?,
                   resolved_by_score_version = ?
             WHERE tenant_id = ?
               AND {self._reference_column} = ?
               AND resolved = 0
               AND new_policy_version <= ?
            """,
            (
                now,
                score.version,
                str(score.tenant_id),
                reference_value,
                score.trace.scoring_policy_version,
            ),
        )
        if result.rowcount > 0:
            job_url = _storage_url_for_job_id(
                self._conn,
                score.tenant_id,
                score.job_id,
            )
            self._record_score_event(
                job_url,
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
        identity_select, identity_join = _stable_identity_select(
            self._reference_column,
            source_alias="stale",
        )
        sql = (
            f"SELECT stale.tenant_id, {identity_select} AS job_id, "
            "stale.stale_reason, stale.old_policy_id, "
            "old_policy_version, new_policy_id, new_policy_version, marked_at, "
            "resolved, resolved_at, resolved_by_score_version "
            "FROM job_score_staleness stale "
            f"{identity_join} "
            "WHERE stale.tenant_id = ? AND stale.resolved = 0 "
            "ORDER BY marked_at ASC"
        )
        params: list[Any] = [str(tenant_id)]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        markers = [self._row_to_marker(row) for row in rows]
        for marker in markers:
            job_url = _storage_url_for_job_id(
                self._conn,
                marker.tenant_id,
                marker.job_id,
            )
            reference_value = _reference_value_for_job_id(
                self._conn,
                marker.tenant_id,
                marker.job_id,
                self._reference_column,
            )
            set_stage_state(
                self._conn,
                job_url,
                "score",
                "pending",
                attempt_count=0,
                next_action="jobctrl run score --rescore",
                metadata={
                    "stale_reason": marker.stale_reason,
                    "new_policy_version": marker.new_policy_version,
                },
                validate_transition=False,
            )
            self._conn.execute(
                f"""
                UPDATE job_score_staleness
                   SET resolved = 1,
                       resolved_at = ?
                 WHERE tenant_id = ?
                   AND {self._reference_column} = ?
                   AND stale_reason = ?
                   AND old_policy_version = ?
                   AND new_policy_version = ?
                """,
                (
                    now,
                    str(marker.tenant_id),
                    reference_value,
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
        job_url = _storage_url_for_job_id(
            self._conn,
            marker.tenant_id,
            marker.job_id,
        )
        row = get_stage_state_row(self._conn, job_url, "score")
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
            job_id=JobId(str(_row_value(row, "job_id", 1))),
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


class SqliteRequirementFitReportRepository:
    """SQLite-backed requirement fit report adapter."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_requirement_fit_tables(conn)
        self._reference_column = _job_reference_column(
            conn,
            "job_requirement_fit_reports",
        )

    def load(
        self,
        tenant_id: TenantId,
        job_id: JobId,
        *,
        score_version: int | None = None,
    ) -> RequirementFitReport | None:
        resolved_job_id = _resolve_job_id(
            self._conn,
            tenant_id,
            job_id,
        )
        if resolved_job_id is None:
            return None
        reference_value = _reference_value_for_job_id(
            self._conn,
            tenant_id,
            resolved_job_id,
            self._reference_column,
        )
        if score_version is None:
            row = self._conn.execute(
                f"""
                SELECT {self._reference_column} AS job_reference,
                       score_version, tenant_id,
                       employer_analysis_generation, profile_snapshot_version,
                       scoring_policy_version, formula_version,
                       resolved_fit_score, fit_band, confidence, summary_json
                  FROM job_requirement_fit_reports
                 WHERE tenant_id = ?
                   AND {self._reference_column} = ?
                 ORDER BY score_version DESC
                 LIMIT 1
                """,
                (str(tenant_id), reference_value),
            ).fetchone()
        else:
            row = self._conn.execute(
                f"""
                SELECT {self._reference_column} AS job_reference,
                       score_version, tenant_id,
                       employer_analysis_generation, profile_snapshot_version,
                       scoring_policy_version, formula_version,
                       resolved_fit_score, fit_band, confidence, summary_json
                  FROM job_requirement_fit_reports
                 WHERE tenant_id = ?
                   AND {self._reference_column} = ?
                   AND score_version = ?
                 LIMIT 1
                """,
                (str(tenant_id), reference_value, score_version),
            ).fetchone()
        if row is None:
            return None

        version = _int_or_default(_row_value(row, "score_version", 1), 0)
        item_reference = _job_reference_column(
            self._conn,
            "job_requirement_fit_items",
        )
        item_rows = self._conn.execute(
            f"""
            SELECT requirement_id, requirement_text, tier, weight,
                   job_evidence_span, fit_json, contribution_json,
                   tailoring_json, artifact_coverage_json
              FROM job_requirement_fit_items
             WHERE tenant_id = ?
               AND {item_reference} = ?
               AND score_version = ?
             ORDER BY position ASC, requirement_id ASC
            """,
            (str(tenant_id), reference_value, version),
        ).fetchall()
        assessments = tuple(self._row_to_assessment(item) for item in item_rows)
        return RequirementFitReport(
            job_id=str(resolved_job_id),
            score_version=version,
            employer_analysis_generation=_int_or_default(
                _row_value(row, "employer_analysis_generation", 3),
                0,
            ),
            profile_snapshot_version=_int_or_default(
                _row_value(row, "profile_snapshot_version", 4),
                0,
            ),
            scoring_policy_version=_int_or_default(
                _row_value(row, "scoring_policy_version", 5),
                0,
            ),
            formula_version=str(_row_value(row, "formula_version", 6) or ""),
            resolved_fit_score=FitScore.from_optional(_row_value(row, "resolved_fit_score", 7)),
            fit_band=str(_row_value(row, "fit_band", 8) or "plausible"),
            confidence=str(_row_value(row, "confidence", 9) or "medium"),
            summary=RequirementFitSummary.from_dict(_json_object(_row_value(row, "summary_json", 10))),
            assessments=assessments,
        )

    def load_by_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
        *,
        score_version: int | None = None,
    ) -> RequirementFitReport | None:
        stable_job_id = self.job_id_for_posting_url(
            tenant_id,
            posting_url,
        )
        return self.load(
            tenant_id,
            stable_job_id,
            score_version=score_version,
        )

    def job_id_for_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
    ) -> JobId:
        stable_job_id = _job_id_for_posting_url(
            self._conn,
            tenant_id,
            posting_url,
        )
        if stable_job_id is None:
            raise KeyError(
                "No stable Job identity for requirement-fit report: "
                f"{posting_url.value}"
            )
        return stable_job_id

    def save(self, tenant_id: TenantId, report: RequirementFitReport) -> None:
        now = _utc_now()
        stable_job_id = _resolve_job_id(
            self._conn,
            tenant_id,
            JobId(str(report.job_id)),
        )
        if stable_job_id is None:
            raise KeyError(
                "No stable Job identity for requirement-fit report: "
                f"{report.job_id}"
            )
        reference_value = _reference_value_for_job_id(
            self._conn,
            tenant_id,
            stable_job_id,
            self._reference_column,
        )
        conflict_columns = (
            "tenant_id, job_id, score_version"
            if self._reference_column == "job_id"
            else "job_url, score_version, tenant_id"
        )
        self._conn.execute(
            f"""
            INSERT INTO job_requirement_fit_reports (
                {self._reference_column}, score_version, tenant_id,
                employer_analysis_generation, profile_snapshot_version,
                scoring_policy_version, formula_version, resolved_fit_score,
                fit_band, confidence, summary_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT({conflict_columns}) DO UPDATE SET
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
                reference_value,
                report.score_version,
                str(tenant_id),
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
        item_reference = _job_reference_column(
            self._conn,
            "job_requirement_fit_items",
        )
        self._conn.execute(
            f"""
            DELETE FROM job_requirement_fit_items
             WHERE {item_reference} = ?
               AND score_version = ?
               AND tenant_id = ?
            """,
            (reference_value, report.score_version, str(tenant_id)),
        )
        for position, assessment in enumerate(report.assessments):
            self._conn.execute(
                f"""
                INSERT INTO job_requirement_fit_items (
                    {item_reference}, score_version, tenant_id, requirement_id,
                    requirement_text, tier, weight, job_evidence_span,
                    fit_json, contribution_json, tailoring_json,
                    artifact_coverage_json, position
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    reference_value,
                    report.score_version,
                    str(tenant_id),
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
    def _row_to_assessment(row: Any) -> RequirementFitAssessment:
        coverage = _row_value(row, "artifact_coverage_json", 8)
        return RequirementFitAssessment(
            requirement_id=str(_row_value(row, "requirement_id", 0)),
            requirement_text=str(_row_value(row, "requirement_text", 1)),
            tier=str(_row_value(row, "tier", 2)),
            weight=float(_row_value(row, "weight", 3) or 0.0),
            job_evidence_span=str(_row_value(row, "job_evidence_span", 4) or ""),
            fit=RequirementFitStatus.from_dict(_json_object(_row_value(row, "fit_json", 5))),
            contribution=RequirementScoreContribution.from_dict(
                _json_object(_row_value(row, "contribution_json", 6))
            ),
            tailoring=RequirementTailoringDirective.from_dict(
                _json_object(_row_value(row, "tailoring_json", 7))
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
        self._reference_column = _job_reference_column(
            conn,
            "job_scores",
        )
        self._staleness = SqliteScoreStalenessRepository(conn)

    @property
    def connection(self) -> sqlite3.Connection:
        """SQLite connection backing this repository."""
        return self._conn

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, job_id: JobId) -> JobScore | None:
        resolved_job_id = _resolve_job_id(
            self._conn,
            tenant_id,
            job_id,
        )
        if resolved_job_id is None:
            return None
        return self._load_resolved(tenant_id, resolved_job_id)

    def load_by_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
    ) -> JobScore | None:
        """Resolve one bounded legacy URL input before stable lookup."""
        stable_job_id = _job_id_for_posting_url(
            self._conn,
            tenant_id,
            posting_url,
        )
        if stable_job_id is None:
            return None
        return self._load_resolved(tenant_id, stable_job_id)

    def job_id_for_posting_url(
        self,
        tenant_id: TenantId,
        posting_url: PostingUrl,
    ) -> JobId:
        """Return the stable identity owned by a legacy posting URL."""
        stable_job_id = _job_id_for_posting_url(
            self._conn,
            tenant_id,
            posting_url,
        )
        if stable_job_id is None:
            raise KeyError(
                f"No stable Job identity for scoring: {posting_url.value}"
            )
        return stable_job_id

    def _load_resolved(
        self,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> JobScore | None:
        reference_value = _reference_value_for_job_id(
            self._conn,
            tenant_id,
            job_id,
            self._reference_column,
        )
        row = self._conn.execute(
            f"""
            SELECT {self._reference_column} AS job_reference,
                   version, fit_score, breakdown_json, keywords_json,
                   scored_at, correction_json, criteria_json, trace_json
            FROM job_scores
            WHERE {self._reference_column} = ? AND tenant_id = ?
            ORDER BY version DESC
            LIMIT 1
            """,
            (reference_value, str(tenant_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_score(
            row,
            tenant_id,
            job_id=job_id,
        )

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return stable JobIds that have a description but no score."""
        params: list[Any] = [str(tenant_id)]
        if self._reference_column == "job_id":
            score_join = (
                "s.job_id = j.job_id AND s.tenant_id = j.tenant_id"
            )
            missing_score = "s.job_id IS NULL"
        else:
            score_join = (
                "s.job_url = j.url AND s.tenant_id = j.tenant_id"
            )
            missing_score = "s.job_url IS NULL"
        sql = (
            "SELECT j.job_id FROM jobs j "
            f"LEFT JOIN job_scores s ON {score_join} "
            "WHERE j.tenant_id = ? "
            "AND j.full_description IS NOT NULL "
            f"AND {missing_score} "
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

        reference = self._reference_column
        identity_select, identity_join = _stable_identity_select(
            reference,
            source_alias="s",
        )
        rows = self._conn.execute(
            f"""
            SELECT {identity_select} AS job_id,
                   s.version, s.fit_score, s.breakdown_json,
                   s.keywords_json, s.scored_at, s.correction_json,
                   s.criteria_json, s.trace_json
            FROM job_scores s
            {identity_join}
            INNER JOIN (
                SELECT tenant_id, {reference}, MAX(version) AS max_version
                FROM job_scores
                WHERE tenant_id = ?
                GROUP BY tenant_id, {reference}
            ) latest
              ON latest.tenant_id = s.tenant_id
             AND latest.{reference} = s.{reference}
             AND latest.max_version = s.version
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
        stable_job_id = _resolve_job_id(
            self._conn,
            score.tenant_id,
            score.job_id,
        )
        if stable_job_id is None:
            raise KeyError(
                f"No stable Job identity for scoring: {score.job_id}"
            )
        reference_value = _reference_value_for_job_id(
            self._conn,
            score.tenant_id,
            stable_job_id,
            self._reference_column,
        )
        latest = self._conn.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM job_scores "
            f"WHERE {self._reference_column} = ? AND tenant_id = ?",
            (reference_value, str(score.tenant_id)),
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
            f"""
            INSERT INTO job_scores (
                {self._reference_column}, version, tenant_id,
                fit_score, breakdown_json,
                keywords_json, scored_at, correction_json, criteria_json, trace_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                reference_value,
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
        if stable_job_id != score.job_id:
            score = JobScore(
                tenant_id=score.tenant_id,
                job_id=stable_job_id,
                version=score.version,
                fit_score=score.fit_score,
                breakdown=score.breakdown,
                matched_keywords=score.matched_keywords,
                scored_at=score.scored_at,
                criteria=score.criteria,
                trace=score.trace,
                correction=score.correction,
            )
        self._staleness.resolve_for_score(score)
        self._conn.commit()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_score(
        row: Any,
        tenant_id: TenantId | None = None,
        *,
        job_id: JobId | None = None,
    ) -> JobScore:
        if isinstance(row, sqlite3.Row):
            raw_job_reference = (
                row["job_id"]
                if "job_id" in row.keys()
                else row["job_reference"]
            )
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
                    raw_job_reference,
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
                raw_job_reference, version, fit_score, breakdown_json, keywords_json, scored_at, correction_json = row
                criteria_json = None
                trace_json = None

        breakdown_data = json.loads(breakdown_json) if breakdown_json else {}
        keywords_data = json.loads(keywords_json) if keywords_json else []
        correction_data = json.loads(correction_json) if correction_json else None
        criteria_data = json.loads(criteria_json) if criteria_json else None
        trace_data = json.loads(trace_json) if trace_json else None

        return JobScore(
            tenant_id=tenant_id or LOCAL_TENANT,
            job_id=job_id or JobId(str(raw_job_reference)),
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


def _job_reference_column(
    conn: sqlite3.Connection,
    table_name: str,
) -> str:
    columns = {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }
    if "job_id" in columns:
        return "job_id"
    if "job_url" in columns:
        return "job_url"
    raise RuntimeError(f"{table_name} has no Job identity column")


def _stable_identity_select(
    reference_column: str,
    *,
    source_alias: str,
) -> tuple[str, str]:
    if reference_column == "job_id":
        return f"{source_alias}.job_id", ""
    expression = f"""
        COALESCE(
            (
                SELECT j.job_id
                FROM jobs j
                WHERE j.tenant_id = {source_alias}.tenant_id
                  AND j.url = {source_alias}.job_url
                LIMIT 1
            ),
            (
                SELECT alias.job_id
                FROM job_identity_aliases alias
                JOIN jobs j
                  ON j.tenant_id = alias.tenant_id
                 AND j.job_id = alias.job_id
                WHERE alias.tenant_id = {source_alias}.tenant_id
                  AND alias.alias_kind = 'posting_url'
                  AND alias.alias_value = {source_alias}.job_url
                LIMIT 1
            )
        )
    """
    return expression, ""


def _resolve_job_id(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> JobId | None:
    raw_reference = str(job_id or "").strip()
    if not raw_reference:
        raise ValueError("job_id must be non-empty")
    try:
        stable_job_id = canonical_job_id(raw_reference)
    except ValueError:
        stable_job_id = None
    if stable_job_id is not None:
        row = conn.execute(
            """
            SELECT job_id
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id)),
        ).fetchone()
        if row is not None:
            return JobId(str(row[0]))
        # UUID-shaped posting URLs are intentionally not guessed here.
        return None
    return _job_id_for_posting_url(
        conn,
        tenant_id,
        PostingUrl(raw_reference),
    )


def _job_id_for_posting_url(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    posting_url: PostingUrl,
) -> JobId | None:
    row = conn.execute(
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND url = ?
        LIMIT 1
        """,
        (str(tenant_id), posting_url.value),
    ).fetchone()
    if row is None:
        row = conn.execute(
            """
            SELECT alias.job_id
            FROM job_identity_aliases alias
            JOIN jobs j
              ON j.tenant_id = alias.tenant_id
             AND j.job_id = alias.job_id
            WHERE alias.tenant_id = ?
              AND alias.alias_kind = 'posting_url'
              AND alias.alias_value = ?
            LIMIT 1
            """,
            (str(tenant_id), posting_url.value),
        ).fetchone()
    return JobId(str(row[0])) if row is not None else None


def _storage_url_for_job_id(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
) -> str:
    row = conn.execute(
        """
        SELECT url
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        LIMIT 1
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        raise KeyError(f"No storage URL for stable Job identity: {job_id}")
    return str(row[0])


def _reference_value_for_job_id(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
    job_id: JobId,
    reference_column: str,
) -> str:
    if reference_column == "job_id":
        return str(job_id)
    return _storage_url_for_job_id(conn, tenant_id, job_id)
