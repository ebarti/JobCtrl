"""Candidate Profile domain — aggregate, value objects, snapshot, ports.

See ddd-target.md §4.3 + §5.3.
"""

from jobctl.domain.profile.aggregate import (
    DEFAULT_PROFILE_ID,
    InvalidProfileError,
    Profile,
)
from jobctl.domain.profile.snapshot import ProfileSnapshot
from jobctl.domain.profile.ports import (
    PdfParserPort,
    ProfileImportResult,
    ProfileRepository,
)
from jobctl.domain.profile.value_objects import (
    Availability,
    ApplicationAttestations,
    ApplicationDefaults,
    ApplicationPreferences,
    Compensation,
    EducationEntry,
    EeoVoluntary,
    ExperienceEntry,
    ExperienceMetadata,
    PersonalInfo,
    ResumeBaseline,
    ResumeConstraints,
    SkillCategory,
    TailoringPolicy,
    TailoringRules,
    WorkAuthorization,
    WritingStyle,
)

__all__ = [
    "DEFAULT_PROFILE_ID",
    "InvalidProfileError",
    "Profile",
    "ProfileSnapshot",
    "ProfileRepository",
    "ProfileImportResult",
    "PdfParserPort",
    # Value objects
    "Availability",
    "ApplicationDefaults",
    "ApplicationAttestations",
    "ApplicationPreferences",
    "Compensation",
    "EducationEntry",
    "EeoVoluntary",
    "ExperienceEntry",
    "ExperienceMetadata",
    "PersonalInfo",
    "ResumeBaseline",
    "ResumeConstraints",
    "SkillCategory",
    "TailoringPolicy",
    "TailoringRules",
    "WorkAuthorization",
    "WritingStyle",
]
