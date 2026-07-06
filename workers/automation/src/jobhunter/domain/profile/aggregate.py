"""Profile aggregate root.

See ddd-target.md §4.3. The Profile aggregate is the canonical representation
of the candidate; ``ProfileSnapshot`` (sibling module) is the published
read-only view exposed to other contexts. Identity is ``(TenantId,
ProfileId)`` — only one ``"default"`` profile exists per tenant in local mode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Mapping

from jobhunter.domain.tenant import TenantId
from jobhunter.domain.profile.value_objects import (
    ApplicationDefaults,
    ApplicationAttestations,
    ApplicationPreferences,
    Compensation,
    EducationEntry,
    ExperienceEntry,
    ExperienceMetadata,
    PersonalInfo,
    ResumeBaseline,
    ResumeConstraints,
    SkillCategory,
    TailoringRules,
    WorkAuthorization,
)


_EMPTY_EXTRA: Mapping[str, Any] = MappingProxyType({})


DEFAULT_PROFILE_ID = "default"


class InvalidProfileError(ValueError):
    """Raised when a profile dict cannot be parsed into a valid Profile.

    Carries a list of human-readable reasons so that the wizard / API can
    surface every missing field at once instead of forcing the user through
    one error at a time.
    """

    def __init__(self, reasons: list[str]):
        self.reasons = list(reasons)
        super().__init__("; ".join(self.reasons))


# ---------------------------------------------------------------------------
# Aggregate root
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Profile:
    """Profile aggregate root — owns the candidate's resume master data,
    application defaults, and tailoring policy. Frozen so that mutation flows
    through ``with_*`` factory methods (added later as use cases expand)."""

    tenant_id: TenantId
    profile_id: str
    personal: PersonalInfo
    work_authorization: WorkAuthorization
    compensation: Compensation
    experience_metadata: ExperienceMetadata
    application_defaults: ApplicationDefaults
    application_attestations: ApplicationAttestations
    application_preferences: ApplicationPreferences
    resume_baseline: ResumeBaseline
    experience_entries: tuple[ExperienceEntry, ...]
    education_entries: tuple[EducationEntry, ...]
    skill_categories: tuple[SkillCategory, ...]
    tailoring_rules: TailoringRules
    resume_constraints: ResumeConstraints
    # Forward-compatibility — extra top-level keys preserved on save so
    # newer profile schemas survive a round-trip through an older worker.
    # Exposed as a ``Mapping`` and wrapped in ``MappingProxyType`` at
    # construction so callers cannot mutate the aggregate's extras in place.
    extra: Mapping[str, Any] = field(default_factory=lambda: _EMPTY_EXTRA)

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    @classmethod
    def from_dict(
        cls,
        tenant_id: TenantId,
        data: dict[str, Any] | None,
        *,
        profile_id: str = DEFAULT_PROFILE_ID,
    ) -> "Profile":
        """Parse a profile dict into a validated aggregate.

        Raises ``InvalidProfileError`` collecting every structural invariant
        violation reachable given the input — missing ``resume`` block stops
        the per-entry checks (the rest of the structure is unparseable
        without it), but any time the ``resume`` block IS present every
        per-entry validation runs and its failures are reported together so
        the wizard / API can surface them in one shot.

        Extra top-level keys are preserved verbatim so we never silently drop
        data on round-trip.
        """
        if not isinstance(data, dict):
            raise InvalidProfileError(["profile must be a JSON object"])

        reasons: list[str] = []

        resume = data.get("resume")
        if not isinstance(resume, dict):
            # No resume block means we cannot evaluate any per-entry invariants —
            # raise immediately with the single actionable reason. Other invariants
            # can only be assessed against parseable structure.
            reasons.append(
                "profile data must include a top-level 'resume' block with executive_profile, "
                "experience_entries, education_entries, skill_categories, and tailoring_rules. "
                "Run `jobhunter init` or use profile.example.json as a template."
            )
            raise InvalidProfileError(reasons)

        raw_experience = resume.get("experience_entries") or []
        if not isinstance(raw_experience, list) or not raw_experience:
            reasons.append("profile.resume.experience_entries must contain at least one entry.")

        experience_entries: list[ExperienceEntry] = []
        if isinstance(raw_experience, list):
            for index, item in enumerate(raw_experience):
                if not isinstance(item, dict):
                    reasons.append(f"profile.resume.experience_entries[{index}] must be an object.")
                    continue
                entry = ExperienceEntry.from_dict(item)
                if not entry.id:
                    reasons.append(f"profile.resume.experience_entries[{index}] is missing 'id'.")
                if not entry.title:
                    reasons.append(f"profile.resume.experience_entries[{index}] is missing 'title'.")
                if not entry.company:
                    reasons.append(f"profile.resume.experience_entries[{index}] is missing 'company'.")
                experience_entries.append(entry)

        raw_education = resume.get("education_entries") or []
        education_entries: list[EducationEntry] = []
        if isinstance(raw_education, list):
            for index, item in enumerate(raw_education):
                if not isinstance(item, dict):
                    reasons.append(f"profile.resume.education_entries[{index}] must be an object.")
                    continue
                education_entries.append(EducationEntry.from_dict(item))

        raw_skills = resume.get("skill_categories") or []
        skill_categories: list[SkillCategory] = []
        if isinstance(raw_skills, list):
            for index, item in enumerate(raw_skills):
                if not isinstance(item, dict):
                    reasons.append(f"profile.resume.skill_categories[{index}] must be an object.")
                    continue
                category = SkillCategory.from_dict(item)
                if not category.id:
                    reasons.append(f"profile.resume.skill_categories[{index}] is missing 'id'.")
                if not category.label:
                    reasons.append(f"profile.resume.skill_categories[{index}] is missing 'label'.")
                skill_categories.append(category)

        if reasons:
            raise InvalidProfileError(reasons)

        # Capture top-level keys we don't model so save() can re-emit them.
        modeled_keys = {
            "personal",
            "work_authorization",
            "compensation",
            "experience",
            "availability",
            "eeo_voluntary",
            "resume",
            "resume_constraints",
            "application_attestations",
            "application_preferences",
            # Augmented legacy fields are computed from the canonical schema
            # at snapshot time — never persisted.
            "skills_boundary",
            "resume_facts",
        }
        extra = MappingProxyType(
            {key: value for key, value in data.items() if key not in modeled_keys}
        )

        return cls(
            tenant_id=tenant_id,
            profile_id=profile_id or DEFAULT_PROFILE_ID,
            personal=PersonalInfo.from_dict(data.get("personal")),
            work_authorization=WorkAuthorization.from_dict(data.get("work_authorization")),
            compensation=Compensation.from_dict(data.get("compensation")),
            experience_metadata=ExperienceMetadata.from_dict(data.get("experience")),
            application_defaults=ApplicationDefaults.from_dict(
                {
                    "availability": data.get("availability"),
                    "eeo_voluntary": data.get("eeo_voluntary"),
                }
            ),
            application_attestations=ApplicationAttestations.from_dict(
                data.get("application_attestations")
            ),
            application_preferences=ApplicationPreferences.from_dict(
                data.get("application_preferences") or data.get("preferences")
            ),
            resume_baseline=ResumeBaseline.from_dict(resume.get("executive_profile")),
            experience_entries=tuple(experience_entries),
            education_entries=tuple(education_entries),
            skill_categories=tuple(skill_categories),
            tailoring_rules=TailoringRules.from_dict(resume.get("tailoring_rules")),
            resume_constraints=ResumeConstraints.from_dict(data.get("resume_constraints")),
            extra=extra,
        )

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Serialize the aggregate back into the canonical profile shape.

        Extra fields preserved at parse time are re-emitted unchanged so the
        on-disk file remains a superset of what the aggregate models. The
        derived ``skills_boundary`` / ``resume_facts`` are NOT written —
        they live only on ``ProfileSnapshot``.
        """
        data: dict[str, Any] = {
            "personal": self.personal.to_dict(),
            "work_authorization": self.work_authorization.to_dict(),
            "availability": self.application_defaults.availability.to_dict(),
            "compensation": self.compensation.to_dict(),
            "experience": self.experience_metadata.to_dict(),
            "resume": {
                "executive_profile": self.resume_baseline.to_dict(),
                "experience_entries": [entry.to_dict() for entry in self.experience_entries],
                "education_entries": [entry.to_dict() for entry in self.education_entries],
                "skill_categories": [category.to_dict() for category in self.skill_categories],
                "tailoring_rules": self.tailoring_rules.to_dict(),
            },
            "resume_constraints": self.resume_constraints.to_dict(),
            "eeo_voluntary": self.application_defaults.eeo_voluntary.to_dict(),
            "application_attestations": self.application_attestations.to_dict(),
            "application_preferences": self.application_preferences.to_dict(),
        }
        # Forward-compat: re-emit unknown keys verbatim so migrations don't lose data.
        for key, value in self.extra.items():
            data.setdefault(key, value)
        return data

    # ------------------------------------------------------------------
    # Convenience accessors
    # ------------------------------------------------------------------

    def required_experience_ids(self) -> tuple[str, ...]:
        """Return the explicit required IDs, or the full set when unspecified."""
        ids = self.tailoring_rules.required_experience_entry_ids
        if ids:
            return ids
        return tuple(entry.id for entry in self.experience_entries if entry.id)

    def required_education_ids(self) -> tuple[str, ...]:
        ids = self.tailoring_rules.required_education_entry_ids
        if ids:
            return ids
        return tuple(entry.id for entry in self.education_entries if entry.id)

    def required_skill_category_ids(self) -> tuple[str, ...]:
        ids = self.tailoring_rules.required_skill_category_ids
        if ids:
            return ids
        return tuple(category.id for category in self.skill_categories if category.id)
