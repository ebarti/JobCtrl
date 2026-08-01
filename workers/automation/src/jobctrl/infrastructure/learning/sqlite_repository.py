"""Exact-v7 SQLite persistence for pending learning recommendations."""

from __future__ import annotations

from datetime import datetime
import sqlite3

from jobctrl.domain.operations.learning import (
    LearningRecommendation,
    RecommendationEvidenceRef,
)


_SAVEPOINT = "append_learning_recommendation"
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


__all__ = [
    "LearningRecommendationConflict",
    "SqliteLearningRecommendationRepository",
]
