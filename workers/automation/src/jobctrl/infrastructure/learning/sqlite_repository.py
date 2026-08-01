"""Exact-v7 SQLite persistence for pending learning recommendations."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import hashlib
import json
import sqlite3

from jobctrl.domain.operations.learning import (
    LearningRecommendation,
    LearningSourceChange,
    RecommendationEvidenceRef,
    TailoringContradictionEvidence,
    TailoringRecommendationScope,
    derive_tailoring_recommendations,
)
from jobctrl.domain.operations.feedback import TailoringFeedbackSignal
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.projections.sqlite_feedback_signals import (
    SqliteFeedbackSignalReader,
)


_SAVEPOINT = "append_learning_recommendation"
_REDERIVE_SAVEPOINT = "rederive_learning_recommendations"
_RECOMMENDATION_PREFIX = "learning-recommendation:"


class LearningRecommendationConflict(RuntimeError):
    """Raised when persisted audit facts disagree with a deterministic identity."""


class SqliteLearningRecommendationRepository:
    """Append immutable pending recommendations to the exact-v7 ledger."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def append_pending(
        self,
        recommendation: LearningRecommendation,
        *,
        contradicting_evidence: tuple[RecommendationEvidenceRef, ...] = (),
        derived_at: str,
    ) -> bool:
        """Atomically append one proposal and its privacy-safe provenance.

        Repeating the same deterministic recommendation is a no-op. A reused
        identity with different facts fails closed instead of overwriting the
        append-only audit record. This method never writes effective policy.
        """

        derived_at = _structured_timestamp(derived_at, name="derived_at")
        contradiction_by_id = {
            evidence.signal_id: evidence for evidence in contradicting_evidence
        }
        if len(contradiction_by_id) != len(contradicting_evidence):
            raise ValueError("contradicting evidence signal IDs must be unique")
        if tuple(sorted(contradiction_by_id)) != tuple(
            sorted(recommendation.contradicting_signal_ids)
        ):
            raise ValueError(
                "contradicting evidence must match recommendation contradiction IDs"
            )
        if set(recommendation.supporting_signal_ids) & set(contradiction_by_id):
            raise ValueError("one signal cannot support and contradict a recommendation")
        for evidence in (*recommendation.evidence, *contradicting_evidence):
            if evidence.tenant_id != recommendation.scope.tenant_id:
                raise ValueError("recommendation evidence must belong to its tenant")
            _structured_identifier(evidence.signal_id, name="signal_id")
            _structured_identifier(evidence.source_id, name="source_id")
            _structured_timestamp(evidence.recorded_at, name="recorded_at")

        fingerprint = _input_fingerprint(recommendation.recommendation_id)
        expected_main = _main_row(recommendation, fingerprint)
        expected_evidence = _evidence_rows(
            recommendation,
            contradicting_evidence=contradicting_evidence,
        )
        expected_evidence_jobs = _evidence_job_rows(
            recommendation,
            contradicting_evidence=contradicting_evidence,
        )
        expected_jobs = tuple(sorted(str(job_id) for job_id in recommendation.job_ids))

        owns_transaction = not self._conn.in_transaction
        if owns_transaction:
            self._conn.execute("BEGIN IMMEDIATE")
        else:
            self._conn.execute(f"SAVEPOINT {_SAVEPOINT}")
        try:
            existing = self._existing_rows(recommendation)
            if existing is not None:
                if existing != (
                    expected_main,
                    expected_evidence,
                    expected_evidence_jobs,
                    expected_jobs,
                ):
                    raise LearningRecommendationConflict(
                        "persisted learning recommendation conflicts with deterministic facts"
                    )
                self._finish(owns_transaction)
                return False

            tenant_id = str(recommendation.scope.tenant_id)
            self._conn.executemany(
                """
                INSERT INTO learning_recommendation_evidence (
                    tenant_id, recommendation_id, signal_id, evidence_role,
                    source_kind, source_id, source_revision, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    (
                        tenant_id,
                        recommendation.recommendation_id,
                        signal_id,
                        role,
                        source_kind,
                        source_id,
                        source_revision,
                        recorded_at,
                    )
                    for (
                        signal_id,
                        role,
                        source_kind,
                        source_id,
                        source_revision,
                        recorded_at,
                    ) in expected_evidence
                ),
            )
            self._conn.executemany(
                """
                INSERT INTO learning_recommendation_evidence_jobs (
                    tenant_id, recommendation_id, signal_id, job_id
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    (
                        tenant_id,
                        recommendation.recommendation_id,
                        signal_id,
                        job_id,
                    )
                    for signal_id, job_id in expected_evidence_jobs
                ),
            )
            self._conn.executemany(
                """
                INSERT INTO learning_recommendation_jobs (
                    tenant_id, recommendation_id, job_id
                ) VALUES (?, ?, ?)
                """,
                (
                    (tenant_id, recommendation.recommendation_id, job_id)
                    for job_id in expected_jobs
                ),
            )
            self._conn.execute(
                """
                INSERT INTO learning_recommendations (
                    tenant_id, recommendation_id, derivation_version,
                    evaluation_fixture_version, context, policy_kind,
                    signal_kind, rule_key, rule_value, allowlist_version,
                    status, observed_signal_count, observed_job_count,
                    minimum_signal_count, minimum_job_count, confidence_limit,
                    input_fingerprint, derived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (*expected_main, derived_at),
            )
        except BaseException:
            self._rollback(owns_transaction)
            raise
        self._finish(owns_transaction)
        return True

    def rederive_tailoring(
        self,
        tenant_id: TenantId,
        *,
        source_changes: tuple[LearningSourceChange, ...],
        rederived_at: str,
        contradictions: Mapping[
            TailoringRecommendationScope, TailoringContradictionEvidence
        ]
        | None = None,
        contradicting_evidence: Mapping[
            TailoringRecommendationScope,
            tuple[RecommendationEvidenceRef, ...],
        ]
        | None = None,
    ) -> tuple[LearningRecommendation, ...]:
        """Recompute pending proposals and tombstone changed source history."""

        if not str(tenant_id).strip():
            raise ValueError("tenant_id must not be empty")
        rederived_at = _structured_timestamp(rederived_at, name="rederived_at")
        contradiction_ledger = contradictions or {}
        contradiction_refs = contradicting_evidence or {}
        owns_transaction = not self._conn.in_transaction
        if owns_transaction:
            self._conn.execute("BEGIN IMMEDIATE")
        else:
            self._conn.execute(f"SAVEPOINT {_REDERIVE_SAVEPOINT}")
        try:
            signals = SqliteFeedbackSignalReader(self._conn).list_accepted(tenant_id)
            tailoring_signals = tuple(
                signal
                for signal in signals
                if isinstance(signal, TailoringFeedbackSignal)
            )
            self._validate_source_changes(
                tenant_id,
                source_changes=source_changes,
                current_signals=tailoring_signals,
            )
            recommendations = derive_tailoring_recommendations(
                tailoring_signals,
                contradictions=contradiction_ledger,
            )
            for recommendation in recommendations:
                self.append_pending(
                    recommendation,
                    contradicting_evidence=contradiction_refs.get(
                        recommendation.scope, ()
                    ),
                    derived_at=rederived_at,
                )
            for change in source_changes:
                self._append_source_change_tombstones(
                    change,
                    recommendations=recommendations,
                    rederived_at=rederived_at,
                )
        except BaseException:
            if owns_transaction:
                self._conn.rollback()
            else:
                self._conn.execute(f"ROLLBACK TO SAVEPOINT {_REDERIVE_SAVEPOINT}")
                self._conn.execute(f"RELEASE SAVEPOINT {_REDERIVE_SAVEPOINT}")
            raise
        if owns_transaction:
            self._conn.commit()
        else:
            self._conn.execute(f"RELEASE SAVEPOINT {_REDERIVE_SAVEPOINT}")
        return recommendations

    def _validate_source_changes(
        self,
        tenant_id: TenantId,
        *,
        source_changes: tuple[LearningSourceChange, ...],
        current_signals: tuple[TailoringFeedbackSignal, ...],
    ) -> None:
        current_by_source: dict[str, TailoringFeedbackSignal] = {}
        for signal in current_signals:
            existing = current_by_source.get(signal.source_id)
            if existing is not None and existing != signal:
                raise ValueError("one tailoring source has conflicting current signals")
            current_by_source[signal.source_id] = signal
        identities: set[tuple[str, int, str]] = set()
        for change in source_changes:
            if change.tenant_id != tenant_id:
                raise ValueError("learning source change must belong to its tenant")
            _structured_identifier(change.previous_signal_id, name="previous_signal_id")
            _structured_identifier(change.source_id, name="source_id")
            _structured_timestamp(change.changed_at, name="changed_at")
            expected_signal_id = (
                f"tailoring-feedback:{change.source_id}:{change.source_revision}"
            )
            if change.previous_signal_id != expected_signal_id:
                raise ValueError("learning source change identity is not canonical")
            identity = (change.source_id, change.source_revision, change.reason_code)
            if identity in identities:
                raise ValueError("learning source changes must be unique")
            identities.add(identity)
            current = current_by_source.get(change.source_id)
            if change.reason_code == "source_corrected":
                if current is None or current.source_revision <= change.source_revision:
                    raise ValueError(
                        "source correction requires a newer accepted revision"
                    )
            elif current is not None:
                raise ValueError("source deletion requires no current accepted revision")

    def _append_source_change_tombstones(
        self,
        change: LearningSourceChange,
        *,
        recommendations: tuple[LearningRecommendation, ...],
        rederived_at: str,
    ) -> None:
        rows = self._conn.execute(
            """
            SELECT recommendation.recommendation_id,
                   recommendation.derivation_version,
                   recommendation.signal_kind,
                   recommendation.rule_key,
                   recommendation.rule_value,
                   recommendation.allowlist_version,
                   evidence.signal_id,
                   evidence.source_revision
            FROM learning_recommendations AS recommendation
            JOIN learning_recommendation_evidence AS evidence
              ON evidence.tenant_id = recommendation.tenant_id
             AND evidence.recommendation_id = recommendation.recommendation_id
            WHERE recommendation.tenant_id = ?
              AND evidence.source_kind = ?
              AND evidence.source_id = ?
              AND evidence.source_revision = ?
              AND evidence.signal_id = ?
            ORDER BY recommendation.recommendation_id
            """,
            (
                str(change.tenant_id),
                change.source_kind,
                change.source_id,
                change.source_revision,
                change.previous_signal_id,
            ),
        ).fetchall()
        for row in rows:
            recommendation_id = str(row[0])
            derivation_version = int(row[1])
            replacement_id = _replacement_recommendation_id(
                row,
                recommendations=recommendations,
                change=change,
            )
            business_key = (
                str(change.tenant_id),
                recommendation_id,
                change.previous_signal_id,
                change.source_revision,
                change.reason_code,
                derivation_version,
            )
            if self._conn.execute(
                """
                SELECT 1
                FROM learning_recommendation_tombstones
                WHERE tenant_id = ?
                  AND recommendation_id = ?
                  AND affected_signal_id = ?
                  AND affected_source_revision = ?
                  AND reason_code = ?
                  AND derivation_version = ?
                """,
                business_key,
            ).fetchone() is not None:
                continue
            self._conn.execute(
                """
                INSERT INTO learning_recommendation_tombstones (
                    tenant_id, tombstone_id, recommendation_id,
                    affected_signal_id, affected_source_revision, reason_code,
                    derivation_version, tombstoned_at, rederived_at,
                    replacement_recommendation_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(change.tenant_id),
                    _tombstone_id(business_key),
                    recommendation_id,
                    change.previous_signal_id,
                    change.source_revision,
                    change.reason_code,
                    derivation_version,
                    change.changed_at,
                    rederived_at,
                    replacement_id,
                ),
            )

    def _existing_rows(
        self,
        recommendation: LearningRecommendation,
    ) -> (
        tuple[
            tuple[object, ...],
            tuple[tuple[object, ...], ...],
            tuple[tuple[str, str], ...],
            tuple[str, ...],
        ]
        | None
    ):
        tenant_id = str(recommendation.scope.tenant_id)
        identity = (tenant_id, recommendation.recommendation_id)
        main = self._conn.execute(
            """
            SELECT tenant_id, recommendation_id, derivation_version,
                   evaluation_fixture_version, context, policy_kind,
                   signal_kind, rule_key, rule_value, allowlist_version,
                   status, observed_signal_count, observed_job_count,
                   minimum_signal_count, minimum_job_count, confidence_limit,
                   input_fingerprint
            FROM learning_recommendations
            WHERE tenant_id = ? AND recommendation_id = ?
            """,
            identity,
        ).fetchone()
        if main is None:
            return None
        evidence = self._conn.execute(
            """
            SELECT signal_id, evidence_role, source_kind, source_id,
                   source_revision, recorded_at
            FROM learning_recommendation_evidence
            WHERE tenant_id = ? AND recommendation_id = ?
            ORDER BY evidence_role, signal_id
            """,
            identity,
        ).fetchall()
        evidence_jobs = self._conn.execute(
            """
            SELECT signal_id, job_id
            FROM learning_recommendation_evidence_jobs
            WHERE tenant_id = ? AND recommendation_id = ?
            ORDER BY signal_id, job_id
            """,
            identity,
        ).fetchall()
        jobs = self._conn.execute(
            """
            SELECT job_id
            FROM learning_recommendation_jobs
            WHERE tenant_id = ? AND recommendation_id = ?
            ORDER BY job_id
            """,
            identity,
        ).fetchall()
        return (
            tuple(main),
            tuple(tuple(row) for row in evidence),
            tuple((str(row[0]), str(row[1])) for row in evidence_jobs),
            tuple(str(row[0]) for row in jobs),
        )

    def _finish(self, owns_transaction: bool) -> None:
        if owns_transaction:
            self._conn.commit()
        else:
            self._conn.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")

    def _rollback(self, owns_transaction: bool) -> None:
        if owns_transaction:
            self._conn.rollback()
        else:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {_SAVEPOINT}")
            self._conn.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")


def _input_fingerprint(recommendation_id: str) -> str:
    if not recommendation_id.startswith(_RECOMMENDATION_PREFIX):
        raise ValueError("recommendation_id must contain a deterministic fingerprint")
    fingerprint = recommendation_id.removeprefix(_RECOMMENDATION_PREFIX)
    if len(fingerprint) != 64 or any(character not in "0123456789abcdef" for character in fingerprint):
        raise ValueError("recommendation_id must contain a deterministic fingerprint")
    return fingerprint


def _structured_identifier(value: str, *, name: str) -> str:
    if not 1 <= len(value) <= 200 or any(
        not (character.isascii() and (character.isalnum() or character in "-_.:"))
        for character in value
    ):
        raise ValueError(f"{name} must be a bounded structured identifier")
    return value


def _structured_timestamp(value: str, *, name: str) -> str:
    text = value.strip()
    if not text or len(text) > 40:
        raise ValueError(f"{name} must be a bounded timezone-aware ISO timestamp")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(
            f"{name} must be a bounded timezone-aware ISO timestamp"
        ) from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{name} must be a bounded timezone-aware ISO timestamp")
    return text


def _main_row(
    recommendation: LearningRecommendation,
    fingerprint: str,
) -> tuple[object, ...]:
    effect = recommendation.proposed_effect
    return (
        str(recommendation.scope.tenant_id),
        recommendation.recommendation_id,
        recommendation.derivation_version,
        recommendation.evaluation_fixture_version,
        recommendation.scope.context,
        recommendation.scope.policy_kind,
        effect.signal_kind,
        effect.rule_key,
        effect.rule_value,
        effect.allowlist_version,
        recommendation.status,
        recommendation.observed_signal_count,
        recommendation.observed_job_count,
        recommendation.minimum_signal_count,
        recommendation.minimum_job_count,
        recommendation.confidence_limit,
        fingerprint,
    )


def _evidence_rows(
    recommendation: LearningRecommendation,
    *,
    contradicting_evidence: tuple[RecommendationEvidenceRef, ...],
) -> tuple[tuple[object, ...], ...]:
    rows = [
        (
            evidence.signal_id,
            "supporting",
            evidence.source_kind,
            evidence.source_id,
            evidence.source_revision,
            evidence.recorded_at,
        )
        for evidence in recommendation.evidence
    ]
    rows.extend(
        (
            evidence.signal_id,
            "contradicting",
            evidence.source_kind,
            evidence.source_id,
            evidence.source_revision,
            evidence.recorded_at,
        )
        for evidence in contradicting_evidence
    )
    return tuple(sorted(rows, key=lambda row: (str(row[1]), str(row[0]))))


def _evidence_job_rows(
    recommendation: LearningRecommendation,
    *,
    contradicting_evidence: tuple[RecommendationEvidenceRef, ...],
) -> tuple[tuple[str, str], ...]:
    return tuple(
        sorted(
            (
                (evidence.signal_id, str(job_id))
                for evidence in (
                    *recommendation.evidence,
                    *contradicting_evidence,
                )
                for job_id in evidence.job_ids
            )
        )
    )


def _replacement_recommendation_id(
    persisted_row: sqlite3.Row | tuple[object, ...],
    *,
    recommendations: tuple[LearningRecommendation, ...],
    change: LearningSourceChange,
) -> str | None:
    persisted_effect = (
        str(persisted_row[2]),
        str(persisted_row[3]),
        str(persisted_row[4]),
        int(persisted_row[5]),
    )
    for recommendation in recommendations:
        effect = recommendation.proposed_effect
        if (
            effect.signal_kind,
            effect.rule_key,
            effect.rule_value,
            effect.allowlist_version,
        ) != persisted_effect:
            continue
        if change.reason_code == "source_corrected" and not any(
            evidence.source_id == change.source_id
            and evidence.source_revision > change.source_revision
            for evidence in recommendation.evidence
        ):
            continue
        return recommendation.recommendation_id
    return None


def _tombstone_id(business_key: tuple[object, ...]) -> str:
    payload = json.dumps(business_key, separators=(",", ":"), ensure_ascii=True)
    fingerprint = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"learning-recommendation-tombstone:{fingerprint}"


__all__ = [
    "LearningRecommendationConflict",
    "SqliteLearningRecommendationRepository",
]
