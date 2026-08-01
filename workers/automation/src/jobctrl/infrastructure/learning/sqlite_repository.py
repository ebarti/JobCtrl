"""Exact-v7 SQLite persistence for pending learning recommendations."""

from __future__ import annotations

from collections import defaultdict
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
    TailoringRuleEffect,
    derive_tailoring_recommendations,
)
from jobctrl.domain.operations.feedback import TailoringFeedbackSignal
from jobctrl.domain.identifiers import canonical_job_id
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
        source_changes: tuple[LearningSourceChange, ...] | None,
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
        """Recompute pending proposals and tombstone changed source history.

        Passing ``None`` detects stale accepted evidence from the canonical
        review ledger in the same transaction. Explicit tuples remain
        available for deterministic replay and migration fixtures.
        """

        if not str(tenant_id).strip():
            raise ValueError("tenant_id must not be empty")
        rederived_at = _structured_timestamp(rederived_at, name="rederived_at")
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
            effective_source_changes = source_changes
            if effective_source_changes is None:
                effective_source_changes = self._detect_source_changes(
                    tenant_id,
                    current_signals=tailoring_signals,
                    rederived_at=rederived_at,
                )
            if contradictions is None:
                if contradicting_evidence is not None:
                    raise ValueError(
                        "explicit contradiction evidence requires an explicit ledger"
                    )
                contradiction_ledger, contradiction_refs = (
                    self._canonical_contradictions(
                        tenant_id,
                        current_signals=tailoring_signals,
                    )
                )
            else:
                contradiction_ledger = contradictions
                contradiction_refs = contradicting_evidence or {}
            self._validate_source_changes(
                tenant_id,
                source_changes=effective_source_changes,
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
            for change in effective_source_changes:
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

    def _canonical_contradictions(
        self,
        tenant_id: TenantId,
        *,
        current_signals: tuple[TailoringFeedbackSignal, ...],
    ) -> tuple[
        Mapping[TailoringRecommendationScope, TailoringContradictionEvidence],
        Mapping[
            TailoringRecommendationScope,
            tuple[RecommendationEvidenceRef, ...],
        ],
    ]:
        current_by_id = {signal.signal_id: signal for signal in current_signals}
        contradiction_ids: dict[TailoringRecommendationScope, set[str]] = defaultdict(set)
        unresolved_ids: dict[TailoringRecommendationScope, set[str]] = defaultdict(set)
        evidence_by_scope: dict[
            TailoringRecommendationScope,
            dict[str, RecommendationEvidenceRef],
        ] = defaultdict(dict)
        rows = self._conn.execute(
            """
            SELECT contradiction.signal_id AS left_signal_id,
                   contradiction.signal_revision AS left_revision,
                   contradiction.signal_job_id AS left_job_id,
                   left_review.signal_kind AS left_signal_kind,
                   left_review.rule_key AS left_rule_key,
                   left_review.rule_value AS left_rule_value,
                   left_review.allowlist_version AS left_allowlist_version,
                   left_review.reviewed_at AS left_recorded_at,
                   contradiction.contradicting_signal_id AS right_signal_id,
                   contradiction.contradicting_signal_revision AS right_revision,
                   contradiction.contradicting_signal_job_id AS right_job_id,
                   right_review.signal_kind AS right_signal_kind,
                   right_review.rule_key AS right_rule_key,
                   right_review.rule_value AS right_rule_value,
                   right_review.allowlist_version AS right_allowlist_version,
                   right_review.reviewed_at AS right_recorded_at
            FROM tailoring_feedback_signal_contradictions AS contradiction
            JOIN tailoring_feedback_signal_reviews AS left_review
              ON left_review.tenant_id = contradiction.tenant_id
             AND left_review.signal_id = contradiction.signal_id
             AND left_review.revision = contradiction.signal_revision
            JOIN tailoring_feedback_signal_reviews AS right_review
              ON right_review.tenant_id = contradiction.tenant_id
             AND right_review.signal_id = contradiction.contradicting_signal_id
             AND right_review.revision = contradiction.contradicting_signal_revision
            WHERE contradiction.tenant_id = ?
            ORDER BY contradiction.contradiction_id
            """,
            (str(tenant_id),),
        ).fetchall()
        for row in rows:
            left = _contradiction_endpoint(row, "left", tenant_id=tenant_id)
            right = _contradiction_endpoint(row, "right", tenant_id=tenant_id)
            for current_endpoint, other_endpoint in ((left, right), (right, left)):
                if current_endpoint[0] not in current_by_id:
                    continue
                scope = current_endpoint[1]
                other_signal_id = other_endpoint[0]
                contradiction_ids[scope].add(other_signal_id)
                evidence_by_scope[scope][other_signal_id] = other_endpoint[2]
                if other_signal_id in current_by_id:
                    unresolved_ids[scope].add(other_signal_id)
        ledger = {
            scope: TailoringContradictionEvidence(
                signal_ids=tuple(sorted(signal_ids)),
                unresolved_signal_ids=tuple(sorted(unresolved_ids[scope])),
            )
            for scope, signal_ids in contradiction_ids.items()
        }
        evidence = {
            scope: tuple(
                evidence_by_scope[scope][signal_id]
                for signal_id in sorted(evidence_by_scope[scope])
            )
            for scope in evidence_by_scope
        }
        return ledger, evidence

    def _detect_source_changes(
        self,
        tenant_id: TenantId,
        *,
        current_signals: tuple[TailoringFeedbackSignal, ...],
        rederived_at: str,
    ) -> tuple[LearningSourceChange, ...]:
        current_by_source = {signal.source_id: signal for signal in current_signals}
        rows = self._conn.execute(
            """
            SELECT DISTINCT evidence.signal_id, evidence.source_id,
                            evidence.source_revision
            FROM learning_recommendation_evidence AS evidence
            WHERE evidence.tenant_id = ?
              AND evidence.source_kind = 'tailoring_feedback_signal'
              AND evidence.evidence_role = 'supporting'
              AND NOT EXISTS (
                SELECT 1
                FROM learning_recommendation_tombstones AS tombstone
                WHERE tombstone.tenant_id = evidence.tenant_id
                  AND tombstone.recommendation_id = evidence.recommendation_id
                  AND tombstone.affected_signal_id = evidence.signal_id
                  AND tombstone.affected_source_revision = evidence.source_revision
              )
            ORDER BY evidence.source_id, evidence.source_revision,
                     evidence.signal_id
            """,
            (str(tenant_id),),
        ).fetchall()
        changes: list[LearningSourceChange] = []
        for row in rows:
            previous_signal_id = str(row[0])
            source_id = str(row[1])
            source_revision = int(row[2])
            current = current_by_source.get(source_id)
            if current is not None and current.source_revision == source_revision:
                continue
            if current is not None and current.source_revision < source_revision:
                raise LearningRecommendationConflict(
                    "current tailoring feedback revision predates recommendation evidence"
                )
            if current is not None:
                reason_code = "source_corrected"
                changed_at = current.recorded_at
            else:
                reason_code = "source_deleted"
                latest = self._conn.execute(
                    """
                    SELECT reviewed_at
                    FROM tailoring_feedback_signal_reviews
                    WHERE tenant_id = ? AND signal_id = ?
                    ORDER BY revision DESC
                    LIMIT 1
                    """,
                    (str(tenant_id), source_id),
                ).fetchone()
                changed_at = str(latest[0]) if latest is not None else rederived_at
            changes.append(
                LearningSourceChange(
                    tenant_id=tenant_id,
                    previous_signal_id=previous_signal_id,
                    source_id=source_id,
                    source_revision=source_revision,
                    reason_code=reason_code,
                    changed_at=changed_at,
                )
            )
        return tuple(changes)

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
              AND evidence.evidence_role = 'supporting'
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


def _contradiction_endpoint(
    row: sqlite3.Row,
    prefix: str,
    *,
    tenant_id: TenantId,
) -> tuple[
    str,
    TailoringRecommendationScope,
    RecommendationEvidenceRef,
]:
    source_id = str(row[f"{prefix}_signal_id"])
    source_revision = int(row[f"{prefix}_revision"])
    signal_id = f"tailoring-feedback:{source_id}:{source_revision}"
    effect = TailoringRuleEffect(
        signal_kind=str(row[f"{prefix}_signal_kind"]),
        rule_key=str(row[f"{prefix}_rule_key"]),
        rule_value=str(row[f"{prefix}_rule_value"]),
        allowlist_version=int(row[f"{prefix}_allowlist_version"]),
    )
    return (
        signal_id,
        TailoringRecommendationScope(
            tenant_id=tenant_id,
            proposed_effect=effect,
        ),
        RecommendationEvidenceRef(
            tenant_id=tenant_id,
            signal_id=signal_id,
            source_kind="tailoring_feedback_signal",
            source_id=source_id,
            source_revision=source_revision,
            job_ids=(canonical_job_id(str(row[f"{prefix}_job_id"])),),
            recorded_at=str(row[f"{prefix}_recorded_at"]),
        ),
    )


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
