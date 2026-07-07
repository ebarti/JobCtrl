"""Versioned tailoring policy model for Materials Generation."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, field
from typing import Any

from jobctl.domain.tenant import LOCAL_TENANT, TenantId

DEFAULT_TAILORING_POLICY_VERSION = 1
REQUIREMENT_LED_TAILORING_POLICY_VERSION = 2

DEFAULT_REQUIREMENT_LED_MIN_FIT_SCORE = 8
DEFAULT_REQUIREMENT_LED_MUST_HAVE_COVERAGE = 0.85
DEFAULT_REQUIREMENT_LED_MAX_REVISION_ATTEMPTS = 1


@dataclass(frozen=True)
class RevisionGatePolicy:
    """Versioned defaults for score-gated requirement-led tailoring."""

    min_fit_score: int = DEFAULT_REQUIREMENT_LED_MIN_FIT_SCORE
    must_have_coverage: float = DEFAULT_REQUIREMENT_LED_MUST_HAVE_COVERAGE
    max_revision_attempts: int = DEFAULT_REQUIREMENT_LED_MAX_REVISION_ATTEMPTS

    def __post_init__(self) -> None:
        min_score = _int_or_default(self.min_fit_score, DEFAULT_REQUIREMENT_LED_MIN_FIT_SCORE)
        if min_score < 1 or min_score > 10:
            raise ValueError("RevisionGatePolicy.min_fit_score must be in [1, 10]")
        object.__setattr__(self, "min_fit_score", min_score)

        try:
            coverage = float(self.must_have_coverage)
        except (TypeError, ValueError):
            coverage = DEFAULT_REQUIREMENT_LED_MUST_HAVE_COVERAGE
        if coverage < 0.0 or coverage > 1.0:
            raise ValueError("RevisionGatePolicy.must_have_coverage must be in [0.0, 1.0]")
        object.__setattr__(self, "must_have_coverage", coverage)

        attempts = _int_or_default(
            self.max_revision_attempts,
            DEFAULT_REQUIREMENT_LED_MAX_REVISION_ATTEMPTS,
        )
        if attempts < 0:
            raise ValueError("RevisionGatePolicy.max_revision_attempts must be >= 0")
        object.__setattr__(self, "max_revision_attempts", attempts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "min_fit_score": self.min_fit_score,
            "must_have_coverage": self.must_have_coverage,
            "max_revision_attempts": self.max_revision_attempts,
        }


@dataclass(frozen=True)
class GenerationPermissions:
    rewrite_summary: bool = True
    rewrite_achievement_bullets: bool = True
    select_existing_skills: bool = True
    preserve_titles: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "rewrite_summary": self.rewrite_summary,
            "rewrite_achievement_bullets": self.rewrite_achievement_bullets,
            "select_existing_skills": self.select_existing_skills,
            "preserve_titles": self.preserve_titles,
        }


@dataclass(frozen=True)
class AutoApprovalPolicy:
    auto_approvable_claim_labels: tuple[str, ...] = ("verified", "evidence_reframed")
    adjacent_translation_auto_approvable: bool = False
    draft_claims_require_confirmation: bool = True

    def __post_init__(self) -> None:
        allowed = {"verified", "evidence_reframed", "adjacent_translation"}
        labels = tuple(
            dict.fromkeys(
                label
                for raw in self.auto_approvable_claim_labels
                if (label := str(raw or "").strip()) in allowed
            )
        )
        if "adjacent_translation" in labels and not self.adjacent_translation_auto_approvable:
            labels = tuple(label for label in labels if label != "adjacent_translation")
        object.__setattr__(self, "auto_approvable_claim_labels", labels)
        object.__setattr__(
            self,
            "adjacent_translation_auto_approvable",
            bool(self.adjacent_translation_auto_approvable),
        )
        object.__setattr__(
            self,
            "draft_claims_require_confirmation",
            bool(self.draft_claims_require_confirmation),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "auto_approvable_claim_labels": list(self.auto_approvable_claim_labels),
            "adjacent_translation_auto_approvable": self.adjacent_translation_auto_approvable,
            "draft_claims_require_confirmation": self.draft_claims_require_confirmation,
        }


@dataclass(frozen=True)
class RequiredContentPins:
    experience_entry_ids: tuple[str, ...] = ()
    bullets_by_experience_id: dict[str, tuple[str, ...]] = field(default_factory=dict)
    skills_by_category_id: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "experience_entry_ids", _clean_string_tuple(self.experience_entry_ids))
        object.__setattr__(
            self,
            "bullets_by_experience_id",
            {
                str(entry_id).strip(): _clean_string_tuple(bullets)
                for entry_id, bullets in dict(self.bullets_by_experience_id or {}).items()
                if str(entry_id).strip() and _clean_string_tuple(bullets)
            },
        )
        object.__setattr__(
            self,
            "skills_by_category_id",
            {
                str(category_id).strip(): _clean_string_tuple(skills)
                for category_id, skills in dict(self.skills_by_category_id or {}).items()
                if str(category_id).strip() and _clean_string_tuple(skills)
            },
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "experience_entry_ids": list(self.experience_entry_ids),
            "bullets_by_experience_id": {
                entry_id: list(bullets)
                for entry_id, bullets in self.bullets_by_experience_id.items()
            },
            "skills_by_category_id": {
                category_id: list(skills)
                for category_id, skills in self.skills_by_category_id.items()
            },
        }


@dataclass(frozen=True)
class WritingStylePolicy:
    tone: str = "direct"
    bullet_style: str = "balanced"
    bullet_styles: tuple[str, ...] = ("impact", "technical_depth", "leadership")
    verbosity: str = "balanced"
    keyword_emphasis: str = "natural"
    avoid_first_person: bool = True

    def __post_init__(self) -> None:
        for name in ("tone", "bullet_style", "verbosity", "keyword_emphasis"):
            object.__setattr__(self, name, str(getattr(self, name) or "").strip() or "natural")
        object.__setattr__(self, "bullet_styles", _clean_string_tuple(self.bullet_styles))
        object.__setattr__(self, "avoid_first_person", bool(self.avoid_first_person))

    def to_dict(self) -> dict[str, Any]:
        return {
            "tone": self.tone,
            "bullet_style": self.bullet_style,
            "bullet_styles": list(self.bullet_styles),
            "verbosity": self.verbosity,
            "keyword_emphasis": self.keyword_emphasis,
            "avoid_first_person": self.avoid_first_person,
        }


@dataclass(frozen=True)
class RequirementLedTailoringControls:
    """Behavioral control model used by requirement-led tailoring.

    Legacy Tailoring mode may influence construction, but it is intentionally
    absent from this runtime model so it cannot act as a second policy authority.
    """

    policy_version: int = REQUIREMENT_LED_TAILORING_POLICY_VERSION
    claim_policy: str = "evidence_reframing"
    generation_permissions: GenerationPermissions = field(default_factory=GenerationPermissions)
    auto_approval_policy: AutoApprovalPolicy = field(default_factory=AutoApprovalPolicy)
    required_content_pins: RequiredContentPins = field(default_factory=RequiredContentPins)
    writing_style: WritingStylePolicy = field(default_factory=WritingStylePolicy)
    revision_gates: RevisionGatePolicy = field(default_factory=lambda: DEFAULT_REQUIREMENT_LED_REVISION_GATES)
    additional_guidance: str = ""

    def __post_init__(self) -> None:
        version = _int_or_default(self.policy_version, REQUIREMENT_LED_TAILORING_POLICY_VERSION)
        if version < REQUIREMENT_LED_TAILORING_POLICY_VERSION:
            version = REQUIREMENT_LED_TAILORING_POLICY_VERSION
        object.__setattr__(self, "policy_version", version)

        claim_policy = str(self.claim_policy or "evidence_reframing").strip()
        allowed = {
            "verified_only",
            "evidence_reframing",
            "adjacent_translation",
            "draft_requires_confirmation",
        }
        if claim_policy not in allowed:
            claim_policy = "evidence_reframing"
        object.__setattr__(self, "claim_policy", claim_policy)

        if not isinstance(self.generation_permissions, GenerationPermissions):
            object.__setattr__(self, "generation_permissions", GenerationPermissions())
        if not isinstance(self.auto_approval_policy, AutoApprovalPolicy):
            object.__setattr__(self, "auto_approval_policy", AutoApprovalPolicy())
        if not isinstance(self.required_content_pins, RequiredContentPins):
            object.__setattr__(self, "required_content_pins", RequiredContentPins())
        if not isinstance(self.writing_style, WritingStylePolicy):
            object.__setattr__(self, "writing_style", WritingStylePolicy())
        if not isinstance(self.revision_gates, RevisionGatePolicy):
            object.__setattr__(self, "revision_gates", DEFAULT_REQUIREMENT_LED_REVISION_GATES)
        object.__setattr__(self, "additional_guidance", str(self.additional_guidance or "").strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy_version": self.policy_version,
            "claim_policy": self.claim_policy,
            "generation_permissions": self.generation_permissions.to_dict(),
            "auto_approval_policy": self.auto_approval_policy.to_dict(),
            "required_content_pins": self.required_content_pins.to_dict(),
            "writing_style": self.writing_style.to_dict(),
            "revision_gates": self.revision_gates.to_dict(),
            "additional_guidance_present": bool(self.additional_guidance),
        }


def adapt_requirement_led_controls(
    *,
    tailoring_policy: MappingABC[str, Any] | None,
    writing_style: MappingABC[str, Any] | None,
    revision_gates: MappingABC[str, Any] | None = None,
    required_experience_entry_ids: tuple[str, ...] = (),
    required_bullets_by_experience_id: MappingABC[str, Any] | None = None,
    required_skills_by_category_id: MappingABC[str, Any] | None = None,
    additional_guidance: str = "",
) -> RequirementLedTailoringControls:
    """Map legacy profile tailoring controls into the runtime control model."""

    policy = _clean_mapping(tailoring_policy or {})
    style = _clean_mapping(writing_style or {})
    legacy_mode = str(policy.get("mode") or "balanced").strip()

    has_explicit_claim_policy = "claim_mode" in policy
    claim_policy = str(policy.get("claim_mode") or "evidence_reframing").strip()
    if not has_explicit_claim_policy and legacy_mode == "strict":
        claim_policy = "verified_only"
    elif not has_explicit_claim_policy and bool(policy.get("allow_adjacent_achievement_drafts", False)):
        claim_policy = "draft_requires_confirmation"
    elif (
        not has_explicit_claim_policy
        and bool(policy.get("allow_minor_inference", False))
        and claim_policy == "evidence_reframing"
    ):
        claim_policy = "adjacent_translation"

    def generation_permission(name: str, default: bool) -> bool:
        if name in policy:
            return bool(policy.get(name, default))
        if legacy_mode == "strict":
            return False
        return bool(policy.get(name, default))

    permissions = GenerationPermissions(
        rewrite_summary=generation_permission("allow_summary_rewrite", True),
        rewrite_achievement_bullets=generation_permission("allow_achievement_rewriting", True),
        select_existing_skills=generation_permission("allow_skill_reordering", True),
        preserve_titles=True,
    )

    auto_labels: list[str] = []
    for mode in _clean_string_tuple(policy.get("auto_approvable_claim_modes", ())):
        if mode == "verified_only":
            auto_labels.append("verified")
        elif mode == "evidence_reframing":
            auto_labels.append("evidence_reframed")
        elif mode == "adjacent_translation":
            auto_labels.append("adjacent_translation")
    adjacent_auto = bool(policy.get("advanced_adjacent_auto_approval", False)) or (
        "adjacent_translation" in auto_labels
    )

    pins = RequiredContentPins(
        experience_entry_ids=required_experience_entry_ids,
        bullets_by_experience_id={
            str(entry_id): _clean_string_tuple(bullets)
            for entry_id, bullets in dict(required_bullets_by_experience_id or {}).items()
        },
        skills_by_category_id={
            str(category_id): _clean_string_tuple(skills)
            for category_id, skills in dict(required_skills_by_category_id or {}).items()
        },
    )

    return RequirementLedTailoringControls(
        claim_policy=claim_policy,
        generation_permissions=permissions,
        auto_approval_policy=AutoApprovalPolicy(
            auto_approvable_claim_labels=tuple(auto_labels) or ("verified", "evidence_reframed"),
            adjacent_translation_auto_approvable=adjacent_auto,
            draft_claims_require_confirmation=True,
        ),
        required_content_pins=pins,
        writing_style=WritingStylePolicy(
            tone=str(style.get("tone") or "direct"),
            bullet_style=str(style.get("bullet_style") or "balanced"),
            bullet_styles=_clean_string_tuple(style.get("bullet_styles", ("impact", "technical_depth", "leadership"))),
            verbosity=str(style.get("verbosity") or "balanced"),
            keyword_emphasis=str(style.get("keyword_emphasis", style.get("keyword_density", "natural"))),
            avoid_first_person=bool(style.get("avoid_first_person", True)),
        ),
        revision_gates=RevisionGatePolicy(**_clean_mapping(revision_gates or {})),
        additional_guidance=additional_guidance,
    )


@dataclass(frozen=True)
class TailoringPolicy:
    """Safe, versioned metadata describing one tailoring configuration.

    The policy stores fingerprints and non-sensitive settings only. Raw
    profile, resume, custom prompt, and generated material content stays out of
    this model and out of repository events.
    """

    tenant_id: TenantId = LOCAL_TENANT
    version: int = DEFAULT_TAILORING_POLICY_VERSION
    prompt_version: str = ""
    schema_version: str = ""
    judge_schema_version: str = ""
    prompt_fingerprint: str = ""
    config_fingerprint: str = ""
    profile_policy_fingerprint: str = ""
    custom_prompt_fingerprint: str = ""
    generator_settings: dict[str, Any] = field(default_factory=dict)
    judge_settings: dict[str, Any] = field(default_factory=dict)
    runtime_settings: dict[str, Any] = field(default_factory=dict)
    rollback_of_version: int | None = None
    rollback_reason: str = ""
    created_at: str = ""
    created_from_event_id: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", TenantId(str(self.tenant_id)))
        version = _int_or_default(self.version, 0)
        if version < 0:
            raise ValueError("TailoringPolicy.version must be >= 0")
        object.__setattr__(self, "version", version)
        for name in (
            "prompt_version",
            "schema_version",
            "judge_schema_version",
            "prompt_fingerprint",
            "config_fingerprint",
            "profile_policy_fingerprint",
            "custom_prompt_fingerprint",
            "created_at",
            "rollback_reason",
        ):
            object.__setattr__(self, name, str(getattr(self, name) or "").strip())
        object.__setattr__(self, "generator_settings", _clean_mapping(self.generator_settings))
        object.__setattr__(self, "judge_settings", _clean_mapping(self.judge_settings))
        object.__setattr__(self, "runtime_settings", _clean_mapping(self.runtime_settings))
        if self.rollback_of_version is not None:
            rollback = _int_or_default(self.rollback_of_version, 0)
            if rollback < 1:
                raise ValueError("TailoringPolicy.rollback_of_version must be >= 1")
            object.__setattr__(self, "rollback_of_version", rollback)
        if self.created_from_event_id is not None:
            object.__setattr__(
                self,
                "created_from_event_id",
                _int_or_default(self.created_from_event_id, 0),
            )

    @property
    def policy_id(self) -> str:
        return f"{self.tenant_id}:tailoring-policy-v{self.version}"

    @classmethod
    def from_runtime(
        cls,
        *,
        tenant_id: TenantId,
        version: int,
        prompt_version: str,
        schema_version: str,
        judge_schema_version: str,
        prompt_text: str,
        profile_policy: MappingABC[str, Any] | None,
        custom_prompt: str,
        generator_settings: MappingABC[str, Any] | None,
        judge_settings: MappingABC[str, Any] | None,
        runtime_settings: MappingABC[str, Any] | None,
        created_at: str,
        created_from_event_id: int | None = None,
    ) -> "TailoringPolicy":
        profile_fingerprint = fingerprint_value(profile_policy or {})
        custom_fingerprint = fingerprint_value(custom_prompt or "")
        prompt_fingerprint = fingerprint_value(prompt_text or "")
        generator = _clean_mapping(generator_settings or {})
        judge = _clean_mapping(judge_settings or {})
        runtime = _clean_mapping(runtime_settings or {})
        config_fingerprint = fingerprint_value(
            {
                "prompt_version": prompt_version,
                "schema_version": schema_version,
                "judge_schema_version": judge_schema_version,
                "prompt_fingerprint": prompt_fingerprint,
                "profile_policy_fingerprint": profile_fingerprint,
                "custom_prompt_fingerprint": custom_fingerprint,
                "generator_settings": generator,
                "judge_settings": judge,
                "runtime_settings": runtime,
            }
        )
        return cls(
            tenant_id=tenant_id,
            version=version,
            prompt_version=prompt_version,
            schema_version=schema_version,
            judge_schema_version=judge_schema_version,
            prompt_fingerprint=prompt_fingerprint,
            config_fingerprint=config_fingerprint,
            profile_policy_fingerprint=profile_fingerprint,
            custom_prompt_fingerprint=custom_fingerprint,
            generator_settings=generator,
            judge_settings=judge,
            runtime_settings=runtime,
            created_at=created_at,
            created_from_event_id=created_from_event_id,
        )

    @classmethod
    def from_persistence(
        cls,
        *,
        tenant_id: TenantId,
        version: int,
        prompt_version: str,
        schema_version: str,
        judge_schema_version: str,
        prompt_fingerprint: str,
        config_fingerprint: str,
        profile_policy_fingerprint: str,
        custom_prompt_fingerprint: str,
        generator_settings: MappingABC[str, Any] | None,
        judge_settings: MappingABC[str, Any] | None,
        runtime_settings: MappingABC[str, Any] | None,
        rollback_of_version: int | None,
        rollback_reason: str,
        created_at: str,
        created_from_event_id: int | None,
    ) -> "TailoringPolicy":
        return cls(
            tenant_id=tenant_id,
            version=version,
            prompt_version=prompt_version,
            schema_version=schema_version,
            judge_schema_version=judge_schema_version,
            prompt_fingerprint=prompt_fingerprint,
            config_fingerprint=config_fingerprint,
            profile_policy_fingerprint=profile_policy_fingerprint,
            custom_prompt_fingerprint=custom_prompt_fingerprint,
            generator_settings=dict(generator_settings or {}),
            judge_settings=dict(judge_settings or {}),
            runtime_settings=dict(runtime_settings or {}),
            rollback_of_version=rollback_of_version,
            rollback_reason=rollback_reason,
            created_at=created_at,
            created_from_event_id=created_from_event_id,
        )

    def same_config_as(self, other: "TailoringPolicy") -> bool:
        return self.config_fingerprint == other.config_fingerprint

    def as_artifact_metadata(self) -> dict[str, Any]:
        return {
            "policy_id": self.policy_id,
            "version": self.version,
            "prompt_version": self.prompt_version,
            "schema_version": self.schema_version,
            "judge_schema_version": self.judge_schema_version,
            "prompt_fingerprint": self.prompt_fingerprint,
            "config_fingerprint": self.config_fingerprint,
            "profile_policy_fingerprint": self.profile_policy_fingerprint,
            "custom_prompt_fingerprint": self.custom_prompt_fingerprint,
        }


def fingerprint_value(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _clean_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, MappingABC):
        return {}
    return json.loads(json.dumps(dict(value), sort_keys=True, default=str))


def _clean_string_tuple(value: Any) -> tuple[str, ...]:
    if value is None or isinstance(value, (str, bytes)):
        values = [value] if value else []
    else:
        try:
            values = list(value)
        except TypeError:
            values = []
    return tuple(dict.fromkeys(text for item in values if (text := str(item or "").strip())))


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


DEFAULT_REQUIREMENT_LED_REVISION_GATES = RevisionGatePolicy()


__all__ = [
    "DEFAULT_TAILORING_POLICY_VERSION",
    "REQUIREMENT_LED_TAILORING_POLICY_VERSION",
    "DEFAULT_REQUIREMENT_LED_REVISION_GATES",
    "AutoApprovalPolicy",
    "GenerationPermissions",
    "RequiredContentPins",
    "RequirementLedTailoringControls",
    "RevisionGatePolicy",
    "TailoringPolicy",
    "WritingStylePolicy",
    "adapt_requirement_led_controls",
    "fingerprint_value",
]
