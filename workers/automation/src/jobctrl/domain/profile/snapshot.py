"""ProfileSnapshot — published language for the Candidate Profile context.

See ddd-target.md §4.3 (Domain Services / Published Language) and §5.3
(``ProfileSnapshotPort``). The snapshot is a frozen, immutable copy of the
Profile aggregate that consuming contexts (Scoring, Materials, Apply) can
hold without risk of accidentally mutating the source. It is constructed via
``ProfileSnapshot.from_profile`` — never instantiated by hand outside the
Profile context.

The snapshot also carries ``version`` (per S-14) so consumers can detect
stale snapshots and refuse to mix data from two generations of the profile.

NO I/O imports — pure data + helpers.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from jobctrl.domain.tenant import TenantId
from jobctrl.domain.profile.aggregate import Profile


@dataclass(frozen=True)
class ProfileSnapshot:
    """Immutable, validated view of a Profile published to other contexts.

    Construction is restricted to ``from_profile``; consumers see only the
    public read-only accessors. ``as_dict`` returns a deep-copied augmented
    dict for legacy callers (validator, pdf builder) that still expect the
    canonical profile shape — mutating the returned dict cannot affect the
    snapshot.
    """

    tenant_id: TenantId
    profile_id: str
    version: int
    _data: dict[str, Any] = field(repr=False)

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    @classmethod
    def from_profile(
        cls,
        profile: Profile,
        *,
        version: int = 1,
    ) -> "ProfileSnapshot":
        """Build a snapshot from a Profile aggregate.

        ``version`` advances every time the underlying profile is saved by
        the repository. Local mode increments monotonically; in hosted mode
        the version is the row's ``updated_at`` epoch nanos.
        """
        if not isinstance(profile, Profile):
            raise TypeError(f"Expected Profile aggregate, got {type(profile).__name__}")

        data = profile.to_dict()
        # Augment with the legacy-compatibility derived sections that the
        # cover-letter and resume judge prompts read. These ARE part of the
        # published language (consumers depend on them); they ARE NOT persisted
        # directly (the repository regenerates them on every load).
        data.setdefault("skills_boundary", _build_skills_boundary(profile))
        data.setdefault("resume_facts", _build_resume_facts(profile))

        return cls(
            tenant_id=profile.tenant_id,
            profile_id=profile.profile_id,
            version=version,
            _data=deepcopy(data),
        )

    # ------------------------------------------------------------------
    # Read-only access for consumers
    # ------------------------------------------------------------------

    def as_dict(self) -> dict[str, Any]:
        """Return a deep copy of the augmented profile dict.

        Returned dict is safe to mutate — the snapshot is unaffected. Legacy
        consumers (``scoring/validator.py``, ``scoring/pdf.py``) expect the
        canonical profile shape and call this when wired through a snapshot
        parameter.
        """
        return deepcopy(self._data)

    @property
    def personal(self) -> dict[str, Any]:
        return deepcopy(self._data.get("personal", {}))

    @property
    def work_authorization(self) -> dict[str, Any]:
        return deepcopy(self._data.get("work_authorization", {}))

    @property
    def compensation(self) -> dict[str, Any]:
        return deepcopy(self._data.get("compensation", {}))

    @property
    def experience(self) -> dict[str, Any]:
        return deepcopy(self._data.get("experience", {}))

    @property
    def availability(self) -> dict[str, Any]:
        return deepcopy(self._data.get("availability", {}))

    @property
    def eeo_voluntary(self) -> dict[str, Any]:
        return deepcopy(self._data.get("eeo_voluntary", {}))


# ---------------------------------------------------------------------------
# Derivation helpers (private)
# ---------------------------------------------------------------------------


def _build_skills_boundary(profile: Profile) -> dict[str, list[str]]:
    """Flatten the canonical skill_categories into the legacy boundary dict."""
    return {
        category.id: list(category.items)
        for category in profile.skill_categories
        if category.id
    }


def _build_resume_facts(profile: Profile) -> dict[str, Any]:
    education_lines: list[str] = []
    for entry in profile.education_entries:
        parts = [entry.degree, entry.institution, entry.location, entry.date]
        line = " | ".join(part for part in parts if part)
        if line:
            education_lines.append(line)

    return {
        "preserved_companies": [
            entry.company for entry in profile.experience_entries if entry.company
        ],
        "preserved_projects": [],
        "preserved_school": " ; ".join(education_lines),
        "real_metrics": list(profile.resume_constraints.real_metrics),
    }
