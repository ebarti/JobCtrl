"""Candidate Profile value objects.

See ddd-target.md §4.3. Pure data, no I/O. All value objects are frozen
dataclasses with explicit defaults. Each carries a ``from_dict`` factory and
``to_dict`` serializer so the aggregate can round-trip through JSON without
losing structure. Validation enforced here is structural (types, allowed enum
values); semantic invariants (e.g. "at least one experience entry") live on
the ``Profile`` aggregate root.
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from types import MappingProxyType
from typing import Any, Mapping


# Shared empty read-only mapping — saves one allocation per default field.
_EMPTY_MAPPING: Mapping[str, Any] = MappingProxyType({})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "y", "1", "on"}
    return bool(value)


def _str_tuple(values: Any) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)):
        return ()
    return tuple(str(v).strip() for v in values if str(v).strip())


# ---------------------------------------------------------------------------
# Personal / Work Authorization / Compensation / Application Defaults
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PersonalInfo:
    full_name: str = ""
    preferred_name: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    city: str = ""
    province_state: str = ""
    country: str = ""
    postal_code: str = ""
    linkedin_url: str = ""
    github_url: str = ""
    portfolio_url: str = ""
    website_url: str = ""
    password: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "PersonalInfo":
        data = data or {}
        return cls(**{f.name: _str(data.get(f.name, ""), "") for f in fields(cls)})

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class WorkAuthorization:
    legally_authorized_to_work: str = ""
    require_sponsorship: str = ""
    work_permit_type: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "WorkAuthorization":
        data = data or {}
        return cls(**{f.name: _str(data.get(f.name, ""), "") for f in fields(cls)})

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class Compensation:
    salary_expectation: str = ""
    salary_currency: str = "USD"
    salary_range_min: str = ""
    salary_range_max: str = ""
    currency_conversion_note: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Compensation":
        data = data or {}
        return cls(**{f.name: _str(data.get(f.name, ""), "") for f in fields(cls)})

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class Availability:
    earliest_start_date: str = ""
    available_for_full_time: str = ""
    available_for_contract: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Availability":
        data = data or {}
        return cls(**{f.name: _str(data.get(f.name, ""), "") for f in fields(cls)})

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class ExperienceMetadata:
    """Top-level ``experience`` block — applicant-summary metadata, distinct
    from the structured ``ExperienceEntry`` records inside the resume master."""

    years_of_experience_total: str = ""
    education_level: str = ""
    current_job_title: str = ""
    current_company: str = ""
    target_role: str = ""
    target_locations: str = ""
    target_work_models: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ExperienceMetadata":
        data = data or {}
        return cls(**{f.name: _str(data.get(f.name, ""), "") for f in fields(cls)})

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class EeoVoluntary:
    gender: str = "Decline to self-identify"
    race_ethnicity: str = "Decline to self-identify"
    veteran_status: str = "Decline to self-identify"
    disability_status: str = "Decline to self-identify"

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "EeoVoluntary":
        data = data or {}
        return cls(
            gender=_str(data.get("gender"), "Decline to self-identify"),
            race_ethnicity=_str(data.get("race_ethnicity"), "Decline to self-identify"),
            veteran_status=_str(data.get("veteran_status"), "Decline to self-identify"),
            disability_status=_str(data.get("disability_status"), "Decline to self-identify"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class ApplicationDefaults:
    """Default form-field values consumed by Apply Automation when the agent
    encounters generic screening prompts. See §4.3 — value object that bundles
    the EEO + availability defaults the prompt builder injects today."""

    availability: Availability = field(default_factory=Availability)
    eeo_voluntary: EeoVoluntary = field(default_factory=EeoVoluntary)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ApplicationDefaults":
        data = data or {}
        return cls(
            availability=Availability.from_dict(data.get("availability")),
            eeo_voluntary=EeoVoluntary.from_dict(data.get("eeo_voluntary")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "availability": self.availability.to_dict(),
            "eeo_voluntary": self.eeo_voluntary.to_dict(),
        }


# ---------------------------------------------------------------------------
# Resume baseline + structured entries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResumeBaseline:
    """Executive-profile baseline text used as the seed for tailored summaries."""

    baseline_text: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ResumeBaseline":
        data = data or {}
        return cls(baseline_text=_str(data.get("baseline_text"), ""))

    def to_dict(self) -> dict[str, Any]:
        return {"baseline_text": self.baseline_text}


@dataclass(frozen=True)
class ExperienceEntry:
    id: str
    title: str = ""
    company: str = ""
    date_range: str = ""
    location: str = ""
    bullets: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExperienceEntry":
        return cls(
            id=_str(data.get("id"), ""),
            title=_str(data.get("title"), ""),
            company=_str(data.get("company"), ""),
            date_range=_str(data.get("date_range"), ""),
            location=_str(data.get("location"), ""),
            bullets=_str_tuple(data.get("bullets")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date_range": self.date_range,
            "title": self.title,
            "company": self.company,
            "location": self.location,
            "bullets": list(self.bullets),
        }


@dataclass(frozen=True)
class EducationEntry:
    id: str
    degree: str = ""
    institution: str = ""
    location: str = ""
    date: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EducationEntry":
        return cls(
            id=_str(data.get("id"), ""),
            degree=_str(data.get("degree"), ""),
            institution=_str(data.get("institution"), ""),
            location=_str(data.get("location"), ""),
            date=_str(data.get("date"), ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date": self.date,
            "degree": self.degree,
            "institution": self.institution,
            "location": self.location,
        }


@dataclass(frozen=True)
class SkillCategory:
    id: str
    label: str = ""
    items: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SkillCategory":
        return cls(
            id=_str(data.get("id"), ""),
            label=_str(data.get("label"), ""),
            items=_str_tuple(data.get("items")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "items": list(self.items),
        }


# ---------------------------------------------------------------------------
# Tailoring policy / writing style / resume constraints
# ---------------------------------------------------------------------------


TAILORING_MODES = ("strict", "balanced", "aggressive")
WRITING_TONES = ("direct", "executive", "technical", "confident", "warm")
BULLET_STYLES = ("balanced", "impact", "technical_depth", "leadership")
VERBOSITY_LEVELS = ("concise", "balanced", "detailed")
KEYWORD_DENSITIES = ("natural", "moderate", "high")


@dataclass(frozen=True)
class TailoringPolicy:
    mode: str = "balanced"
    allow_title_reframing: bool = False
    allow_achievement_rewriting: bool = True
    allow_skill_reordering: bool = True
    allow_summary_rewrite: bool = True
    allow_minor_inference: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "TailoringPolicy":
        data = data or {}
        mode = _str(data.get("mode"), "balanced")
        if mode not in TAILORING_MODES:
            mode = "balanced"

        policy = cls(
            mode=mode,
            allow_title_reframing=_bool(data.get("allow_title_reframing"), False),
            allow_achievement_rewriting=_bool(data.get("allow_achievement_rewriting"), True),
            allow_skill_reordering=_bool(data.get("allow_skill_reordering"), True),
            allow_summary_rewrite=_bool(data.get("allow_summary_rewrite"), True),
            allow_minor_inference=_bool(data.get("allow_minor_inference"), False),
        )
        # Strict mode forces every flag to False — the policy makes the
        # forbidden options unrepresentable rather than relying on consumers
        # to remember the rule.
        if policy.mode == "strict":
            return cls(
                mode="strict",
                allow_title_reframing=False,
                allow_achievement_rewriting=False,
                allow_skill_reordering=False,
                allow_summary_rewrite=False,
                allow_minor_inference=False,
            )
        return policy

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class WritingStyle:
    tone: str = "direct"
    bullet_style: str = "balanced"
    verbosity: str = "balanced"
    keyword_density: str = "natural"
    avoid_first_person: bool = True

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "WritingStyle":
        data = data or {}

        def pick(key: str, allowed: tuple[str, ...], default: str) -> str:
            value = _str(data.get(key), default)
            return value if value in allowed else default

        return cls(
            tone=pick("tone", WRITING_TONES, "direct"),
            bullet_style=pick("bullet_style", BULLET_STYLES, "balanced"),
            verbosity=pick("verbosity", VERBOSITY_LEVELS, "balanced"),
            keyword_density=pick("keyword_density", KEYWORD_DENSITIES, "natural"),
            avoid_first_person=_bool(data.get("avoid_first_person"), True),
        )

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class ResumeConstraints:
    """Hard truths the tailor must preserve verbatim — real metrics, etc."""

    real_metrics: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ResumeConstraints":
        data = data or {}
        return cls(real_metrics=_str_tuple(data.get("real_metrics")))

    def to_dict(self) -> dict[str, Any]:
        return {"real_metrics": list(self.real_metrics)}


@dataclass(frozen=True)
class TailoringRules:
    """Tailoring guardrails. ``required_bullets_by_experience_id`` is exposed
    as a ``Mapping`` and wrapped in ``MappingProxyType`` so mutation through
    the public attribute is rejected at runtime — ``frozen=True`` only
    forbids attribute reassignment, not in-place dict mutation."""

    required_experience_entry_ids: tuple[str, ...] = ()
    required_education_entry_ids: tuple[str, ...] = ()
    required_skill_category_ids: tuple[str, ...] = ()
    required_bullets_by_experience_id: Mapping[str, tuple[str, ...]] = field(
        default_factory=lambda: _EMPTY_MAPPING
    )
    required_skills_by_category_id: Mapping[str, tuple[str, ...]] = field(
        default_factory=lambda: _EMPTY_MAPPING
    )
    max_experience_bullets: int = 4
    custom_tailoring_prompt: str = ""
    tailoring_policy: TailoringPolicy = field(default_factory=TailoringPolicy)
    writing_style: WritingStyle = field(default_factory=WritingStyle)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "TailoringRules":
        data = data or {}
        raw_required_bullets = data.get("required_bullets_by_experience_id") or {}
        cleaned_bullets: dict[str, tuple[str, ...]] = {}
        if isinstance(raw_required_bullets, dict):
            for entry_id, bullets in raw_required_bullets.items():
                if isinstance(entry_id, str) and entry_id:
                    cleaned = _str_tuple(bullets)
                    if cleaned:
                        cleaned_bullets[entry_id] = cleaned

        raw_required_skills = data.get("required_skills_by_category_id") or {}
        cleaned_skills: dict[str, tuple[str, ...]] = {}
        if isinstance(raw_required_skills, dict):
            for category_id, skills in raw_required_skills.items():
                if isinstance(category_id, str) and category_id:
                    cleaned = _str_tuple(skills)
                    if cleaned:
                        cleaned_skills[category_id] = cleaned

        max_bullets_raw = data.get("max_experience_bullets")
        if max_bullets_raw is None:
            max_bullets = 4
        else:
            try:
                max_bullets = int(max_bullets_raw)
                if max_bullets <= 0:
                    max_bullets = 4
            except (TypeError, ValueError):
                max_bullets = 4

        return cls(
            required_experience_entry_ids=_str_tuple(data.get("required_experience_entry_ids")),
            required_education_entry_ids=_str_tuple(data.get("required_education_entry_ids")),
            required_skill_category_ids=_str_tuple(data.get("required_skill_category_ids")),
            required_bullets_by_experience_id=MappingProxyType(cleaned_bullets),
            required_skills_by_category_id=MappingProxyType(cleaned_skills),
            max_experience_bullets=max_bullets,
            custom_tailoring_prompt=_str(data.get("custom_tailoring_prompt"), "").strip(),
            tailoring_policy=TailoringPolicy.from_dict(data.get("tailoring_policy")),
            writing_style=WritingStyle.from_dict(data.get("writing_style")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "required_experience_entry_ids": list(self.required_experience_entry_ids),
            "required_education_entry_ids": list(self.required_education_entry_ids),
            "required_skill_category_ids": list(self.required_skill_category_ids),
            "required_bullets_by_experience_id": {
                entry_id: list(bullets)
                for entry_id, bullets in self.required_bullets_by_experience_id.items()
            },
            "required_skills_by_category_id": {
                category_id: list(skills)
                for category_id, skills in self.required_skills_by_category_id.items()
            },
            "max_experience_bullets": self.max_experience_bullets,
            "tailoring_policy": self.tailoring_policy.to_dict(),
            "writing_style": self.writing_style.to_dict(),
            "custom_tailoring_prompt": self.custom_tailoring_prompt,
        }
