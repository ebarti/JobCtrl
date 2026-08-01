"""Deterministic, non-executable learning recommendation derivation."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
import hashlib
import json
from typing import Literal

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.operations.feedback import (
    FeedbackSignal,
    TAILORING_FEEDBACK_RULE_ALLOWLIST,
    TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION,
    TailoringFeedbackRuleKey,
    TailoringFeedbackRuleValue,
    TailoringFeedbackSignal,
    TailoringFeedbackSignalKind,
)
from jobctrl.domain.tenant import TenantId


TAILORING_RECOMMENDATION_DERIVATION_VERSION = 1
TAILORING_RECOMMENDATION_EVALUATION_FIXTURE_VERSION = 1
TAILORING_RECOMMENDATION_MIN_SIGNAL_COUNT = 3
TAILORING_RECOMMENDATION_MIN_JOB_COUNT = 2


@dataclass(frozen=True, kw_only=True)
class LearningSourceChange:
    """Explicit accepted-signal correction or deletion requiring re-derivation."""

    tenant_id: TenantId
    previous_signal_id: str
    source_id: str
    source_revision: int
    reason_code: Literal["source_corrected", "source_deleted"]
    changed_at: str
    source_kind: Literal["tailoring_feedback_signal"] = field(
        default="tailoring_feedback_signal", init=False
    )

    def __post_init__(self) -> None:
        if not str(self.tenant_id).strip():
            raise ValueError("tenant_id must not be empty")
        for name, value in (
            ("previous_signal_id", self.previous_signal_id),
            ("source_id", self.source_id),
            ("changed_at", self.changed_at),
        ):
            if not value.strip():
                raise ValueError(f"{name} must not be empty")
        if self.source_revision < 1:
            raise ValueError("source_revision must be positive")
        if self.reason_code not in {"source_corrected", "source_deleted"}:
            raise ValueError("unsupported learning source change reason")


@dataclass(frozen=True, kw_only=True)
class TailoringRuleEffect:
    """Closed, allowlisted Materials policy effect proposed by learning."""

    signal_kind: TailoringFeedbackSignalKind
    rule_key: TailoringFeedbackRuleKey
    rule_value: TailoringFeedbackRuleValue
    allowlist_version: int

    def __post_init__(self) -> None:
        if self.allowlist_version != TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION:
            raise ValueError("unsupported tailoring feedback rule allowlist version")
        if TAILORING_FEEDBACK_RULE_ALLOWLIST[self.signal_kind] != (
            self.rule_key,
            self.rule_value,
        ):
            raise ValueError("tailoring recommendation effect is not allowlisted")


@dataclass(frozen=True, kw_only=True)
class TailoringRecommendationScope:
    """Tenant-owned Materials scope used for grouping and contradiction lookup."""

    tenant_id: TenantId
    proposed_effect: TailoringRuleEffect
    context: Literal["materials"] = field(default="materials", init=False)
    policy_kind: Literal["tailoring_rule"] = field(
        default="tailoring_rule", init=False
    )

    def __post_init__(self) -> None:
        if not str(self.tenant_id).strip():
            raise ValueError("tenant_id must not be empty")


@dataclass(frozen=True, kw_only=True)
class RecommendationEvidenceRef:
    """Non-sensitive provenance copied from an accepted signal value."""

    tenant_id: TenantId
    signal_id: str
    source_kind: Literal["tailoring_feedback_signal"]
    source_id: str
    source_revision: int
    job_ids: tuple[JobId, ...]
    recorded_at: str

    def __post_init__(self) -> None:
        if not str(self.tenant_id).strip():
            raise ValueError("tenant_id must not be empty")
        for name, value in (
            ("signal_id", self.signal_id),
            ("source_id", self.source_id),
            ("recorded_at", self.recorded_at),
        ):
            if not value.strip():
                raise ValueError(f"{name} must not be empty")
        if self.source_revision < 1:
            raise ValueError("source_revision must be positive")
        if not self.job_ids or len(set(self.job_ids)) != len(self.job_ids):
            raise ValueError("evidence requires unique canonical job IDs")


@dataclass(frozen=True, kw_only=True)
class TailoringContradictionEvidence:
    """Canonical contradiction IDs and the unresolved subset for one scope."""

    signal_ids: tuple[str, ...]
    unresolved_signal_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if any(not signal_id.strip() for signal_id in self.signal_ids):
            raise ValueError("contradiction signal IDs must not be empty")
        if len(set(self.signal_ids)) != len(self.signal_ids):
            raise ValueError("contradiction signal IDs must be unique")
        if len(set(self.unresolved_signal_ids)) != len(
            self.unresolved_signal_ids
        ):
            raise ValueError("unresolved contradiction signal IDs must be unique")
        if not set(self.unresolved_signal_ids).issubset(self.signal_ids):
            raise ValueError("unresolved contradiction IDs must be recorded")


@dataclass(frozen=True, kw_only=True)
class LearningRecommendation:
    """Pending proposal that cannot change behavior before explicit acceptance."""

    recommendation_id: str
    scope: TailoringRecommendationScope
    proposed_effect: TailoringRuleEffect
    derivation_version: int
    evaluation_fixture_version: int
    supporting_signal_ids: tuple[str, ...]
    contradicting_signal_ids: tuple[str, ...]
    evidence: tuple[RecommendationEvidenceRef, ...]
    job_ids: tuple[JobId, ...]
    observed_signal_count: int
    observed_job_count: int
    minimum_signal_count: int = field(
        default=TAILORING_RECOMMENDATION_MIN_SIGNAL_COUNT, init=False
    )
    minimum_job_count: int = field(
        default=TAILORING_RECOMMENDATION_MIN_JOB_COUNT, init=False
    )
    confidence_limit: Literal["sample_gated_no_population_inference"] = field(
        default="sample_gated_no_population_inference", init=False
    )
    status: Literal["pending"] = field(default="pending", init=False)

    def __post_init__(self) -> None:
        if not self.recommendation_id.strip():
            raise ValueError("recommendation_id must not be empty")
        if self.scope.proposed_effect != self.proposed_effect:
            raise ValueError("recommendation scope and proposed effect must match")
        if self.derivation_version != TAILORING_RECOMMENDATION_DERIVATION_VERSION:
            raise ValueError("recommendation derivation version is not gated")
        if (
            self.evaluation_fixture_version
            != TAILORING_RECOMMENDATION_EVALUATION_FIXTURE_VERSION
        ):
            raise ValueError("recommendation evaluation fixture version is not gated")
        if len(set(self.supporting_signal_ids)) != len(self.supporting_signal_ids):
            raise ValueError("supporting signal IDs must be unique")
        if len(set(self.contradicting_signal_ids)) != len(
            self.contradicting_signal_ids
        ):
            raise ValueError("contradicting signal IDs must be unique")
        if self.observed_signal_count != len(self.supporting_signal_ids):
            raise ValueError("observed signal count must match supporting signal IDs")
        if tuple(evidence.signal_id for evidence in self.evidence) != (
            self.supporting_signal_ids
        ):
            raise ValueError("recommendation evidence must match supporting signal IDs")
        if any(
            evidence.tenant_id != self.scope.tenant_id for evidence in self.evidence
        ):
            raise ValueError("recommendation evidence must belong to its tenant")
        if len(set(self.job_ids)) != len(self.job_ids):
            raise ValueError("recommendation job IDs must be unique")
        if self.observed_job_count != len(self.job_ids):
            raise ValueError("observed job count must match canonical job IDs")
        if self.observed_signal_count < self.minimum_signal_count:
            raise ValueError("recommendation does not meet the signal threshold")
        if self.observed_job_count < self.minimum_job_count:
            raise ValueError("recommendation does not meet the cross-job threshold")
        if set(self.supporting_signal_ids) & set(self.contradicting_signal_ids):
            raise ValueError("one signal cannot support and contradict a recommendation")


def derive_tailoring_recommendations(
    signals: Iterable[FeedbackSignal],
    *,
    contradictions: Mapping[
        TailoringRecommendationScope, TailoringContradictionEvidence
    ],
    derivation_version: int = TAILORING_RECOMMENDATION_DERIVATION_VERSION,
) -> tuple[LearningRecommendation, ...]:
    """Derive stable pending proposals from explicit accepted tailoring facts.

    Contradiction inputs contain non-sensitive signal IDs resolved by the
    owning ledger. Any unresolved ID suppresses the candidate entirely.
    """

    if derivation_version != TAILORING_RECOMMENDATION_DERIVATION_VERSION:
        raise ValueError("derivation version has no passing evaluation fixture")

    unique_signals: dict[tuple[TenantId, str], TailoringFeedbackSignal] = {}
    for signal in signals:
        if not isinstance(signal, TailoringFeedbackSignal):
            continue
        identity = (signal.tenant_id, signal.signal_id)
        existing = unique_signals.get(identity)
        if existing is not None and existing != signal:
            raise ValueError("one tailoring signal ID has conflicting accepted facts")
        unique_signals[identity] = signal

    grouped: dict[TailoringRecommendationScope, list[TailoringFeedbackSignal]] = {}
    for signal in unique_signals.values():
        effect = TailoringRuleEffect(
            signal_kind=signal.signal_kind,
            rule_key=signal.rule_key,
            rule_value=signal.rule_value,
            allowlist_version=signal.allowlist_version,
        )
        scope = TailoringRecommendationScope(
            tenant_id=signal.tenant_id,
            proposed_effect=effect,
        )
        grouped.setdefault(scope, []).append(signal)

    recommendations: list[LearningRecommendation] = []
    for scope, scoped_signals in grouped.items():
        support = tuple(sorted(scoped_signals, key=lambda signal: signal.signal_id))
        job_ids = tuple(sorted({job_id for signal in support for job_id in signal.job_ids}))
        if len(support) < TAILORING_RECOMMENDATION_MIN_SIGNAL_COUNT:
            continue
        if len(job_ids) < TAILORING_RECOMMENDATION_MIN_JOB_COUNT:
            continue

        contradiction_evidence = contradictions.get(scope)
        contradiction_ids = (
            tuple(sorted(contradiction_evidence.signal_ids))
            if contradiction_evidence
            else ()
        )
        unresolved_ids = (
            contradiction_evidence.unresolved_signal_ids
            if contradiction_evidence
            else ()
        )
        support_ids = tuple(signal.signal_id for signal in support)
        if unresolved_ids:
            continue
        if set(support_ids) & set(contradiction_ids):
            raise ValueError("one signal cannot support and contradict a recommendation")

        evidence = tuple(
            RecommendationEvidenceRef(
                tenant_id=signal.tenant_id,
                signal_id=signal.signal_id,
                source_kind=signal.source_kind,
                source_id=signal.source_id,
                source_revision=signal.source_revision,
                job_ids=signal.job_ids,
                recorded_at=signal.recorded_at,
            )
            for signal in support
        )
        recommendations.append(
            LearningRecommendation(
                recommendation_id=_recommendation_id(
                    scope,
                    derivation_version,
                    support,
                    contradiction_ids,
                ),
                scope=scope,
                proposed_effect=scope.proposed_effect,
                derivation_version=derivation_version,
                evaluation_fixture_version=(
                    TAILORING_RECOMMENDATION_EVALUATION_FIXTURE_VERSION
                ),
                supporting_signal_ids=support_ids,
                contradicting_signal_ids=contradiction_ids,
                evidence=evidence,
                job_ids=job_ids,
                observed_signal_count=len(support_ids),
                observed_job_count=len(job_ids),
            )
        )

    return tuple(
        sorted(
            recommendations,
            key=lambda recommendation: recommendation.recommendation_id,
        )
    )


def _recommendation_id(
    scope: TailoringRecommendationScope,
    derivation_version: int,
    supporting_signals: tuple[TailoringFeedbackSignal, ...],
    contradicting_signal_ids: tuple[str, ...],
) -> str:
    payload = json.dumps(
        {
            "allowlistVersion": scope.proposed_effect.allowlist_version,
            "contradictingSignalIds": contradicting_signal_ids,
            "derivationVersion": derivation_version,
            "ruleKey": scope.proposed_effect.rule_key,
            "ruleValue": scope.proposed_effect.rule_value,
            "signalKind": scope.proposed_effect.signal_kind,
            "supportingEvidence": [
                {
                    "jobIds": signal.job_ids,
                    "signalId": signal.signal_id,
                    "sourceId": signal.source_id,
                    "sourceRevision": signal.source_revision,
                }
                for signal in supporting_signals
            ],
            "tenantId": str(scope.tenant_id),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return f"learning-recommendation:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


__all__ = [
    "LearningRecommendation",
    "LearningSourceChange",
    "RecommendationEvidenceRef",
    "TAILORING_RECOMMENDATION_DERIVATION_VERSION",
    "TAILORING_RECOMMENDATION_EVALUATION_FIXTURE_VERSION",
    "TAILORING_RECOMMENDATION_MIN_JOB_COUNT",
    "TAILORING_RECOMMENDATION_MIN_SIGNAL_COUNT",
    "TailoringContradictionEvidence",
    "TailoringRecommendationScope",
    "TailoringRuleEffect",
    "derive_tailoring_recommendations",
]
