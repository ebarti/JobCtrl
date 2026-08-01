"""Privacy-safe read values for explicit, reviewed feedback facts.

Operations exposes a read-only union over facts owned by Scoring and Discovery.
The source aggregates remain authoritative; these immutable values never mutate
policy or copy private rationale, notes, job text, or model output.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal, Mapping, TypeAlias

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import TenantId


DiscoveryFeedbackKind: TypeAlias = Literal[
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
]
ScoreCorrectionDirection: TypeAlias = Literal["increase", "decrease", "unchanged"]
TailoringFeedbackSignalKind: TypeAlias = Literal[
    "style_preference",
    "factual_correction",
    "claim_policy_correction",
    "keyword_strategy",
    "provenance_dispute",
]
TailoringFeedbackRuleKey: TypeAlias = Literal[
    "style_guidance",
    "fact_handling",
    "claim_policy",
    "keyword_strategy",
    "provenance_policy",
]
TailoringFeedbackRuleValue: TypeAlias = Literal[
    "preserve_user_edit_pattern",
    "require_source_match",
    "omit_unsupported_claims",
    "use_supported_terms_only",
    "require_direct_evidence",
]

TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION = 1
TAILORING_FEEDBACK_RULE_ALLOWLIST: Mapping[
    TailoringFeedbackSignalKind,
    tuple[TailoringFeedbackRuleKey, TailoringFeedbackRuleValue],
] = MappingProxyType({
    "style_preference": ("style_guidance", "preserve_user_edit_pattern"),
    "factual_correction": ("fact_handling", "require_source_match"),
    "claim_policy_correction": ("claim_policy", "omit_unsupported_claims"),
    "keyword_strategy": ("keyword_strategy", "use_supported_terms_only"),
    "provenance_dispute": ("provenance_policy", "require_direct_evidence"),
})


@dataclass(frozen=True, kw_only=True)
class ScoreCorrectionFeedbackSignal:
    """One explicit score correction projected without its free-text rationale."""

    signal_id: str
    tenant_id: TenantId
    job_id: JobId
    source_id: str
    source_revision: int
    recorded_at: str
    original_fit_score: int
    corrected_fit_score: int
    context: Literal["scoring"] = field(default="scoring", init=False)
    kind: Literal["score_correction"] = field(default="score_correction", init=False)
    source_kind: Literal["job_score_correction"] = field(
        default="job_score_correction", init=False
    )
    source_action: Literal["corrected"] = field(default="corrected", init=False)

    def __post_init__(self) -> None:
        _require_nonempty("signal_id", self.signal_id)
        _require_nonempty("source_id", self.source_id)
        _require_nonempty("recorded_at", self.recorded_at)
        if self.source_revision < 1:
            raise ValueError("source_revision must be positive")
        for name, score in (
            ("original_fit_score", self.original_fit_score),
            ("corrected_fit_score", self.corrected_fit_score),
        ):
            if not 1 <= score <= 10:
                raise ValueError(f"{name} must be between 1 and 10")

    @property
    def job_ids(self) -> tuple[JobId, ...]:
        return (self.job_id,)

    @property
    def direction(self) -> ScoreCorrectionDirection:
        if self.corrected_fit_score > self.original_fit_score:
            return "increase"
        if self.corrected_fit_score < self.original_fit_score:
            return "decrease"
        return "unchanged"


@dataclass(frozen=True, kw_only=True)
class DiscoveryFeedbackSignal:
    """One explicit discovery judgment projected without its optional note."""

    signal_id: str
    tenant_id: TenantId
    job_id: JobId
    source_id: str
    discovery_source_id: str | None
    feedback_kind: DiscoveryFeedbackKind
    recorded_at: str
    context: Literal["discovery"] = field(default="discovery", init=False)
    kind: Literal["discovery_feedback"] = field(default="discovery_feedback", init=False)
    source_kind: Literal["discovery_feedback"] = field(
        default="discovery_feedback", init=False
    )
    source_action: Literal["recorded"] = field(default="recorded", init=False)
    source_revision: Literal[1] = field(default=1, init=False)

    def __post_init__(self) -> None:
        _require_nonempty("signal_id", self.signal_id)
        _require_nonempty("source_id", self.source_id)
        _require_nonempty("recorded_at", self.recorded_at)
        if self.discovery_source_id is not None:
            _require_nonempty("discovery_source_id", self.discovery_source_id)

    @property
    def job_ids(self) -> tuple[JobId, ...]:
        return (self.job_id,)


@dataclass(frozen=True, kw_only=True)
class RoleMatchApprovalFeedbackSignal:
    """One approved exact-title exclusion with bounded source references."""

    signal_id: str
    tenant_id: TenantId
    source_id: str
    job_ids: tuple[JobId, ...]
    rule_value: str
    source_ids: tuple[str, ...]
    recorded_at: str
    context: Literal["discovery"] = field(default="discovery", init=False)
    kind: Literal["role_match_approval"] = field(default="role_match_approval", init=False)
    source_kind: Literal["role_match_feedback_suggestion"] = field(
        default="role_match_feedback_suggestion", init=False
    )
    source_action: Literal["approved"] = field(default="approved", init=False)
    source_revision: Literal[1] = field(default=1, init=False)
    rule_kind: Literal["exact_title_exclusion"] = field(
        default="exact_title_exclusion", init=False
    )

    def __post_init__(self) -> None:
        _require_nonempty("signal_id", self.signal_id)
        _require_nonempty("source_id", self.source_id)
        _require_nonempty("rule_value", self.rule_value)
        _require_nonempty("recorded_at", self.recorded_at)
        if not self.job_ids:
            raise ValueError("an approved role-match signal requires a canonical job reference")
        if len(set(self.job_ids)) != len(self.job_ids):
            raise ValueError("job_ids must be unique")
        if len(set(self.source_ids)) != len(self.source_ids):
            raise ValueError("source_ids must be unique")
        for source_id in self.source_ids:
            _require_nonempty("source_id", source_id)


@dataclass(frozen=True, kw_only=True)
class TailoringFeedbackSignal:
    """One explicitly accepted tailoring rule without its private source text."""

    signal_id: str
    tenant_id: TenantId
    job_id: JobId
    source_id: str
    source_revision: int
    recorded_at: str
    signal_kind: TailoringFeedbackSignalKind
    rule_key: TailoringFeedbackRuleKey
    rule_value: TailoringFeedbackRuleValue
    allowlist_version: int
    context: Literal["materials"] = field(default="materials", init=False)
    kind: Literal["tailoring_feedback"] = field(
        default="tailoring_feedback", init=False
    )
    source_kind: Literal["tailoring_feedback_signal"] = field(
        default="tailoring_feedback_signal", init=False
    )
    source_action: Literal["accepted"] = field(default="accepted", init=False)

    def __post_init__(self) -> None:
        _require_nonempty("signal_id", self.signal_id)
        _require_nonempty("source_id", self.source_id)
        _require_nonempty("recorded_at", self.recorded_at)
        if self.source_revision < 1:
            raise ValueError("source_revision must be positive")
        if self.allowlist_version != TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION:
            raise ValueError("unsupported tailoring feedback rule allowlist version")
        if TAILORING_FEEDBACK_RULE_ALLOWLIST[self.signal_kind] != (
            self.rule_key,
            self.rule_value,
        ):
            raise ValueError("tailoring feedback rule is not allowlisted for its kind")

    @property
    def job_ids(self) -> tuple[JobId, ...]:
        return (self.job_id,)


FeedbackSignal: TypeAlias = (
    ScoreCorrectionFeedbackSignal
    | DiscoveryFeedbackSignal
    | RoleMatchApprovalFeedbackSignal
    | TailoringFeedbackSignal
)


def _require_nonempty(name: str, value: str) -> None:
    if not value.strip():
        raise ValueError(f"{name} must not be empty")


__all__ = [
    "DiscoveryFeedbackKind",
    "DiscoveryFeedbackSignal",
    "FeedbackSignal",
    "RoleMatchApprovalFeedbackSignal",
    "ScoreCorrectionDirection",
    "ScoreCorrectionFeedbackSignal",
    "TAILORING_FEEDBACK_RULE_ALLOWLIST",
    "TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION",
    "TailoringFeedbackRuleKey",
    "TailoringFeedbackRuleValue",
    "TailoringFeedbackSignal",
    "TailoringFeedbackSignalKind",
]
