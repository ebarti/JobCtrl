"""SQLite adapter for the privacy-safe Operations feedback-signal read union."""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from typing import Any, cast

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.operations.feedback import (
    DiscoveryFeedbackKind,
    DiscoveryFeedbackSignal,
    FeedbackSignal,
    RoleMatchApprovalFeedbackSignal,
    ScoreCorrectionFeedbackSignal,
    TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION,
    TailoringFeedbackRuleKey,
    TailoringFeedbackRuleValue,
    TailoringFeedbackSignal,
    TailoringFeedbackSignalKind,
)
from jobctrl.domain.tenant import TenantId


_DISCOVERY_FEEDBACK_KINDS = frozenset(
    {
        "saved",
        "applied",
        "dismissed",
        "stale",
        "duplicate",
        "wrong_company",
        "wrong_location",
        "bad_source",
        "useful",
        "irrelevant",
    }
)


class SqliteFeedbackSignalReader:
    """Read exact-v7 canonical source rows through an allowlisted projection."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def list_accepted(self, tenant_id: TenantId) -> tuple[FeedbackSignal, ...]:
        signals: list[FeedbackSignal] = []
        signals.extend(self._score_corrections(tenant_id))
        signals.extend(self._discovery_feedback(tenant_id))
        signals.extend(self._approved_role_matches(tenant_id))
        signals.extend(self._accepted_tailoring_feedback(tenant_id))
        return tuple(sorted(signals, key=lambda signal: (signal.recorded_at, signal.signal_id)))

    def _score_corrections(
        self, tenant_id: TenantId
    ) -> tuple[ScoreCorrectionFeedbackSignal, ...]:
        rows = self._conn.execute(
            """
            WITH versioned_scores AS (
                SELECT tenant_id, job_id, version, fit_score, scored_at,
                       correction_json,
                       LAG(fit_score) OVER (
                           PARTITION BY tenant_id, job_id ORDER BY version
                       ) AS original_fit_score
                FROM job_scores
                WHERE tenant_id = ?
            )
            SELECT score.job_id, score.version, score.fit_score,
                   score.original_fit_score, score.scored_at
            FROM versioned_scores AS score
            JOIN jobs AS job
              ON job.tenant_id = score.tenant_id
             AND job.job_id = score.job_id
            WHERE score.correction_json IS NOT NULL
              AND trim(score.correction_json) != ''
              AND score.original_fit_score IS NOT NULL
            ORDER BY score.job_id, score.version
            """,
            (str(tenant_id),),
        ).fetchall()
        return tuple(
            ScoreCorrectionFeedbackSignal(
                signal_id=f"score-correction:{row['job_id']}:{int(row['version'])}",
                tenant_id=tenant_id,
                job_id=canonical_job_id(str(row["job_id"])),
                source_id=f"{row['job_id']}:{int(row['version'])}",
                source_revision=int(row["version"]),
                recorded_at=str(row["scored_at"]),
                original_fit_score=int(row["original_fit_score"]),
                corrected_fit_score=int(row["fit_score"]),
            )
            for row in rows
        )

    def _discovery_feedback(
        self, tenant_id: TenantId
    ) -> tuple[DiscoveryFeedbackSignal, ...]:
        rows = self._conn.execute(
            """
            SELECT feedback.feedback_id, feedback.job_id, feedback.source_id,
                   feedback.kind, feedback.recorded_at
            FROM discovery_feedback AS feedback
            JOIN jobs AS job
              ON job.tenant_id = feedback.tenant_id
             AND job.job_id = feedback.job_id
            WHERE feedback.tenant_id = ?
            ORDER BY feedback.feedback_id
            """,
            (str(tenant_id),),
        ).fetchall()
        signals: list[DiscoveryFeedbackSignal] = []
        for row in rows:
            kind = str(row["kind"])
            if kind not in _DISCOVERY_FEEDBACK_KINDS:
                raise ValueError(f"unsupported discovery feedback kind: {kind}")
            feedback_id = str(row["feedback_id"])
            signals.append(
                DiscoveryFeedbackSignal(
                    signal_id=f"discovery-feedback:{feedback_id}",
                    tenant_id=tenant_id,
                    job_id=canonical_job_id(str(row["job_id"])),
                    source_id=feedback_id,
                    discovery_source_id=_optional_text(row["source_id"]),
                    feedback_kind=cast(DiscoveryFeedbackKind, kind),
                    recorded_at=str(row["recorded_at"]),
                )
            )
        return tuple(signals)

    def _approved_role_matches(
        self, tenant_id: TenantId
    ) -> tuple[RoleMatchApprovalFeedbackSignal, ...]:
        rows = self._conn.execute(
            """
            SELECT suggestion_id, title_pattern, decided_at
            FROM role_match_feedback_suggestions
            WHERE tenant_id = ?
              AND status = 'approved'
              AND rule_kind = 'exact_title_exclusion'
              AND decided_at IS NOT NULL
            ORDER BY suggestion_id
            """,
            (str(tenant_id),),
        ).fetchall()
        job_ids = self._approved_role_job_ids(tenant_id)
        source_ids = self._approved_role_source_ids(tenant_id)
        signals: list[RoleMatchApprovalFeedbackSignal] = []
        for row in rows:
            suggestion_id = str(row["suggestion_id"])
            referenced_jobs = job_ids.get(suggestion_id, ())
            if not referenced_jobs:
                continue
            signals.append(
                RoleMatchApprovalFeedbackSignal(
                    signal_id=f"role-match-approval:{suggestion_id}",
                    tenant_id=tenant_id,
                    source_id=suggestion_id,
                    job_ids=referenced_jobs,
                    rule_value=str(row["title_pattern"]),
                    source_ids=source_ids.get(suggestion_id, ()),
                    recorded_at=str(row["decided_at"]),
                )
            )
        return tuple(signals)

    def _approved_role_job_ids(
        self, tenant_id: TenantId
    ) -> dict[str, tuple[JobId, ...]]:
        rows = self._conn.execute(
            """
            SELECT suggestion.suggestion_id,
                   json_extract(evidence.value, '$.jobKey') AS job_id
            FROM role_match_feedback_suggestions AS suggestion,
                 json_each(suggestion.evidence_json) AS evidence
            WHERE suggestion.tenant_id = ?
              AND suggestion.status = 'approved'
              AND suggestion.rule_kind = 'exact_title_exclusion'
              AND json_type(evidence.value, '$.jobKey') = 'text'
              AND EXISTS (
                  SELECT 1
                  FROM jobs AS job
                  WHERE job.tenant_id = suggestion.tenant_id
                    AND job.job_id = json_extract(evidence.value, '$.jobKey')
              )
            ORDER BY suggestion.suggestion_id, job_id
            """,
            (str(tenant_id),),
        ).fetchall()
        grouped: dict[str, list[JobId]] = defaultdict(list)
        for row in rows:
            job_id = canonical_job_id(str(row["job_id"] if isinstance(row, sqlite3.Row) else row[1]))
            suggestion_id = str(
                row["suggestion_id"] if isinstance(row, sqlite3.Row) else row[0]
            )
            if job_id not in grouped[suggestion_id]:
                grouped[suggestion_id].append(job_id)
        return {key: tuple(values) for key, values in grouped.items()}

    def _approved_role_source_ids(
        self, tenant_id: TenantId
    ) -> dict[str, tuple[str, ...]]:
        rows = self._conn.execute(
            """
            SELECT suggestion_id, value AS source_id
            FROM role_match_feedback_suggestions, json_each(source_ids_json)
            WHERE tenant_id = ?
              AND status = 'approved'
              AND rule_kind = 'exact_title_exclusion'
              AND type = 'text'
            ORDER BY suggestion_id, source_id
            """,
            (str(tenant_id),),
        ).fetchall()
        grouped: dict[str, list[str]] = defaultdict(list)
        for row in rows:
            suggestion_id = str(
                row["suggestion_id"] if isinstance(row, sqlite3.Row) else row[0]
            )
            source_id = str(row["source_id"] if isinstance(row, sqlite3.Row) else row[1]).strip()
            if source_id and source_id not in grouped[suggestion_id]:
                grouped[suggestion_id].append(source_id)
        return {key: tuple(values) for key, values in grouped.items()}

    def _accepted_tailoring_feedback(self, tenant_id: TenantId) -> tuple[TailoringFeedbackSignal, ...]:
        rows = self._conn.execute(
            """
            WITH latest_reviews AS (
                SELECT review.signal_id, review.revision, review.decision,
                       review.signal_kind, review.rule_key, review.rule_value,
                       review.allowlist_version, review.reviewed_at,
                       ROW_NUMBER() OVER (
                           PARTITION BY review.tenant_id, review.signal_id
                           ORDER BY review.revision DESC
                       ) AS latest_rank
                FROM tailoring_feedback_signal_reviews AS review
                WHERE review.tenant_id = ?
            )
            SELECT source.signal_id, source.job_id, review.revision,
                   review.signal_kind, review.rule_key, review.rule_value,
                   review.allowlist_version, review.reviewed_at
            FROM latest_reviews AS review
            JOIN tailoring_feedback_signals AS source
              ON source.tenant_id = ?
             AND source.signal_id = review.signal_id
             AND source.signal_kind = review.signal_kind
            JOIN jobs AS job
              ON job.tenant_id = ?
             AND job.job_id = source.job_id
            WHERE review.latest_rank = 1
              AND review.decision = 'accepted'
              AND review.allowlist_version = ?
              AND (
                (review.signal_kind = 'style_preference'
                  AND review.rule_key = 'style_guidance'
                  AND review.rule_value = 'preserve_user_edit_pattern')
                OR (review.signal_kind = 'factual_correction'
                  AND review.rule_key = 'fact_handling'
                  AND review.rule_value = 'require_source_match')
                OR (review.signal_kind = 'claim_policy_correction'
                  AND review.rule_key = 'claim_policy'
                  AND review.rule_value = 'omit_unsupported_claims')
                OR (review.signal_kind = 'keyword_strategy'
                  AND review.rule_key = 'keyword_strategy'
                  AND review.rule_value = 'use_supported_terms_only')
                OR (review.signal_kind = 'provenance_dispute'
                  AND review.rule_key = 'provenance_policy'
                  AND review.rule_value = 'require_direct_evidence')
              )
            ORDER BY source.signal_id
            """,
            (
                str(tenant_id),
                str(tenant_id),
                str(tenant_id),
                TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION,
            ),
        ).fetchall()
        return tuple(
            TailoringFeedbackSignal(
                signal_id=(f"tailoring-feedback:{row['signal_id']}:{int(row['revision'])}"),
                tenant_id=tenant_id,
                job_id=canonical_job_id(str(row["job_id"])),
                source_id=str(row["signal_id"]),
                source_revision=int(row["revision"]),
                recorded_at=str(row["reviewed_at"]),
                signal_kind=cast(TailoringFeedbackSignalKind, str(row["signal_kind"])),
                rule_key=cast(TailoringFeedbackRuleKey, str(row["rule_key"])),
                rule_value=cast(TailoringFeedbackRuleValue, str(row["rule_value"])),
                allowlist_version=int(row["allowlist_version"]),
            )
            for row in rows
        )


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


__all__ = ["SqliteFeedbackSignalReader"]
