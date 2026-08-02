"""Value objects for the Contact & Outreach bounded context (ninth context).

Every stored contact fact carries a non-null :class:`ContactFactProvenance`
(INV-2, outreach planner plan §6). Construction of a :class:`ContactAttribute`
without provenance is impossible — the guard mirrors the ``__post_init__``
invariants in ``jobctrl.domain.apply.aggregate``. The provenance shape is
modelled on ``AchievementEvidence``
(``jobctrl.domain.profile.value_objects``).

Sensitivity: an attribute *value* (a name, email, note) lives on
:class:`ContactAttribute.value` and is persisted only in
``contact_attributes.value_json``. It never appears in a domain-event payload,
projection, log, or telemetry span (plan §6; CLAUDE.md sensitive-data rule).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from jobctrl.domain.identifiers import JobId, canonical_job_id


class ContactRole(str, Enum):
    """The role a contact plays for a company/application."""

    RECRUITER = "recruiter"
    HIRING_MANAGER = "hiring_manager"
    REFERRER = "referrer"
    WARM_INTRO = "warm_intro"
    OTHER = "other"


CONTACT_SOURCE_KINDS: frozenset[str] = frozenset(
    {"user_entered", "public_web_page", "user_imported_list", "derived"}
)

# Capture methods reuse the enrichment ``ExtractionTier`` vocabulary plus the
# manual entry/import methods this phase adds (plan §6).
CONTACT_CAPTURE_METHODS: frozenset[str] = frozenset(
    {"manual", "json_ld", "css_selectors", "llm_assisted"}
)


@dataclass(frozen=True)
class ContactFactProvenance:
    """Where one contact fact came from (INV-2).

    Modelled on ``AchievementEvidence``: a source category, a *safe* reference
    (URL / import filename / user note id — never a raw dumped body), the
    capture method, a timestamp, a confidence, and whether the user confirmed
    it. Carried by every :class:`ContactAttribute`.
    """

    source_kind: str
    source_ref: str
    capture_method: str = "manual"
    captured_at: str = ""
    confidence: float = 0.0
    user_confirmed: bool = False

    def __post_init__(self) -> None:
        if self.source_kind not in CONTACT_SOURCE_KINDS:
            raise ValueError(
                "ContactFactProvenance.source_kind must be one of "
                f"{sorted(CONTACT_SOURCE_KINDS)!r}, got {self.source_kind!r}"
            )
        if not isinstance(self.source_ref, str) or not self.source_ref.strip():
            raise ValueError(
                "ContactFactProvenance.source_ref must be a non-empty safe reference"
            )
        if self.capture_method not in CONTACT_CAPTURE_METHODS:
            raise ValueError(
                "ContactFactProvenance.capture_method must be one of "
                f"{sorted(CONTACT_CAPTURE_METHODS)!r}, got {self.capture_method!r}"
            )
        if not isinstance(self.confidence, (int, float)):
            raise ValueError("ContactFactProvenance.confidence must be a number")

    def to_dict(self) -> dict[str, object]:
        return {
            "source_kind": self.source_kind,
            "source_ref": self.source_ref,
            "capture_method": self.capture_method,
            "captured_at": self.captured_at,
            "confidence": float(self.confidence),
            "user_confirmed": bool(self.user_confirmed),
        }


@dataclass(frozen=True)
class ContactAttribute:
    """One fact about a contact — name, title, email, phone, profile URL, note.

    Immutable value object. Its ``value`` is sensitive and stays on the
    canonical write side; its :class:`ContactFactProvenance` is mandatory
    (INV-2) — constructing one without provenance raises.
    """

    attribute_id: str
    kind: str
    value: str
    provenance: ContactFactProvenance

    def __post_init__(self) -> None:
        if not isinstance(self.attribute_id, str) or not self.attribute_id.strip():
            raise ValueError("ContactAttribute.attribute_id must be a non-empty string")
        if not isinstance(self.kind, str) or not self.kind.strip():
            raise ValueError("ContactAttribute.kind must be a non-empty string")
        if not isinstance(self.provenance, ContactFactProvenance):
            raise ValueError(
                "ContactAttribute.provenance is required and must be a "
                "ContactFactProvenance (INV-2: every stored fact carries "
                "inspectable provenance)"
            )


@dataclass(frozen=True)
class ContactLink:
    """A contact's link to an employer and/or a specific application.

    A contact must link to at least one of ``{employer, job_id}`` — a contact
    that belongs to nothing is not a valid record (plan §4.1).
    """

    employer: str | None = None
    job_id: JobId | None = None

    def __post_init__(self) -> None:
        employer = (self.employer or "").strip()
        raw_job_id = self.job_id
        job_id = canonical_job_id(str(raw_job_id)) if raw_job_id else None
        if not employer and not job_id:
            raise ValueError(
                "ContactLink must reference at least one of {employer, job_id}"
            )
        if raw_job_id is not None:
            object.__setattr__(self, "job_id", job_id)


@dataclass(frozen=True)
class WarmIntroSignal:
    """A computed link between a contact and a user-owned relationship record.

    Value-object shape only in this phase. Warm-intro *identification* comes
    exclusively from a user-owned relationship dataset (INV-6) and is not
    implemented here — see outreach planner plan §4.4. No relationship is ever
    inferred from a scraped network graph.
    """

    contact_id: str
    relationship_id: str
    match_basis: str = ""
    confidence: float = 0.0
    signals: tuple[str, ...] = field(default_factory=tuple)
