"""Materials Generation domain services — pure functions.

See ddd-target.md §4.5. Two services live here:

  :class:`ContentValidator` — banned-word / fabrication / structural
                              validation rules for tailored resumes and
                              cover letters. Replaces the legacy
                              ``scoring/validator.py`` module wholesale
                              (no-strangler directive: the old module is
                              deleted in the same PR).
  :class:`ResumeAssembler`  — assembles plain-text resume output from the
                              tailored JSON payload + ProfileSnapshot.
                              Replaces ``tailor.assemble_resume_text``.

Both services are pure: zero I/O, zero side effects. They consume
``ProfileSnapshot.as_dict()`` (or any equivalent profile-shaped dict)
and return value objects (:class:`ValidationResult`) or strings. Use
cases are responsible for plumbing the snapshot in and the artifact
out.

Module-level helpers exposed for callers that previously imported them
from ``scoring/validator.py`` (constants ``BANNED_WORDS`` /
``LLM_LEAK_PHRASES`` / ``FABRICATION_WATCHLIST``, the
``sanitize_text`` and ``normalize_profile_list`` functions). The legacy
module is deleted; importers must update to this canonical home.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from jobctl.domain.materials.value_objects import ValidationResult
from jobctl.domain.profile.snapshot import ProfileSnapshot
from jobctl.resume_profile import (
    experience_updates_by_id,
    get_education_entries,
    get_experience_entries,
    get_max_experience_bullets,
    get_required_education_entry_ids,
    get_required_experience_entry_ids,
    get_required_skill_category_ids,
    get_resume_master,
    get_skill_categories,
    get_tailoring_policy,
    require_resume_master,
    tailored_experience_bullets,
    tailored_experience_title,
    tailored_skill_items,
)

log = logging.getLogger(__name__)
_OUTPUT_WHITESPACE_RE = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# Universal constants (not personal data — moved verbatim from validator.py)
# ---------------------------------------------------------------------------


BANNED_WORDS: list[str] = [
    "passionate", "dedicated", "committed to",
    "utilizing", "utilize", "harnessing",
    "spearheaded", "spearhead", "orchestrated", "championed", "pioneered",
    "robust", "scalable solutions", "cutting-edge", "state-of-the-art", "best-in-class",
    "proven track record", "track record of success", "demonstrated ability",
    "strong communicator", "team player", "fast learner", "self-starter", "go-getter",
    "synergy", "cross-functional collaboration", "holistic",
    "transformative", "innovative solutions", "paradigm", "ecosystem",
    "proactive", "detail-oriented", "highly motivated",
    "seamless", "full lifecycle",
    "deep understanding", "extensive experience", "comprehensive knowledge",
    "thrives in", "excels at", "adept at", "well-versed in",
    "i am confident", "i believe", "i am excited",
    "plays a critical role", "instrumental in", "integral part of",
    "strong track record", "eager to", "eager",
    # Cover-letter-specific additions
    "this demonstrates", "this reflects", "i have experience with",
    "furthermore", "additionally", "moreover",
]

LLM_LEAK_PHRASES: list[str] = [
    "i am sorry", "i apologize", "i will try", "let me try",
    "i am at a loss", "i am truly sorry", "apologies for",
    "i keep fabricating", "i will have to admit", "one final attempt",
    "one last time", "if it fails again", "persistent errors",
    "i am having difficulty", "i made an error", "my mistake",
    "here is the corrected", "here is the revised", "here is the updated",
    "here is my", "below is the", "as requested",
    "note:", "disclaimer:", "important:",
    "i have rewritten", "i have removed", "i have fixed",
    "i have replaced", "i have updated", "i have corrected",
    "per your feedback", "based on your feedback", "as per the instructions",
    "the following resume", "the resume below",
    "the following cover letter", "the letter below",
]

FABRICATION_WATCHLIST: set[str] = {
    "c#", "c++", "golang", "rust", "ruby",
    "kotlin", "swift", "scala", "matlab",
    "spring", "django", "rails", "angular", "vue", "svelte",
    "certified", "pmp", "scrum master", "aws certified",
}

_COVER_LETTER_CLOSING_RE = re.compile(
    r"^(?:(?:best|sincerely|regards|kind regards|warm regards|thanks|thank you),?\s+)?"
    r"[A-Z][A-Za-z .'-]{1,60}$",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Pure helpers (formerly module-private in scoring/validator.py)
# ---------------------------------------------------------------------------


def _stringify_profile_item(item: object) -> str:
    """Convert a profile list item to a stable string representation."""
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        for key in ("name", "label", "value", "language", "skill", "tool", "title"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        parts = [str(value).strip() for value in item.values() if str(value).strip()]
        return " ".join(parts).strip()
    if item is None:
        return ""
    return str(item).strip()


def normalize_profile_list(items: object) -> list[str]:
    """Normalize profile list fields so prompt builders can safely join them."""
    if not isinstance(items, (list, tuple, set)):
        return []
    normalized: list[str] = []
    for item in items:
        value = _stringify_profile_item(item)
        if value:
            normalized.append(value)
    return normalized


def _build_allowed_skill_terms(profile: dict) -> set[str]:
    """Build the lowercase set of real skills from the canonical profile."""
    allowed: set[str] = set()
    for category in get_skill_categories(profile):
        allowed.update(item.lower().strip() for item in normalize_profile_list(category.get("items", [])))
    return allowed


def _normalize_output_term(value: object) -> str:
    return _OUTPUT_WHITESPACE_RE.sub(" ", str(value or "")).strip().lower()


def _contains_watch_term(text: str, term: str) -> bool:
    """Return True when a fabrication-watch term appears as a real term match."""
    if re.fullmatch(r"[a-z0-9 ]+", term):
        return re.search(r"\b" + re.escape(term) + r"\b", text) is not None
    return term in text


def sanitize_text(text: str) -> str:
    """Auto-fix common LLM output issues instead of rejecting."""
    text = text.replace(" — ", ", ").replace("—", ", ")
    text = text.replace("–", "-")
    text = text.replace("“", '"').replace("”", '"')
    text = text.replace("‘", "'").replace("’", "'")
    return text.strip()


# ---------------------------------------------------------------------------
# JSON-side validation (formerly _validate_master_json_fields)
# ---------------------------------------------------------------------------


def _validate_master_json_fields(
    data: dict, profile: dict, mode: str = "normal"
) -> ValidationResult:
    """Validate tailoring output against the canonical resume master schema."""
    errors: list[str] = []
    warnings: list[str] = []

    executive_profile = data.get("executive_profile", "")
    if not isinstance(executive_profile, str) or not executive_profile.strip():
        errors.append("Missing required field: executive_profile")

    experience_updates = data.get("experience_updates")
    if not isinstance(experience_updates, list) or not experience_updates:
        errors.append("Missing required field: experience_updates")

    skill_updates = data.get("skill_category_updates")
    if not isinstance(skill_updates, list) or not skill_updates:
        errors.append("Missing required field: skill_category_updates")

    if errors:
        return ValidationResult.failure(tuple(errors), warnings=tuple(warnings))

    # ``errors`` was empty so the isinstance/non-empty guards above already
    # established that experience_updates and skill_updates are real lists.
    # Narrow the types explicitly so static analysers don't flag the
    # iteration sites below as "object of type None is not iterable".
    assert isinstance(experience_updates, list)
    assert isinstance(skill_updates, list)

    experience_entries = get_experience_entries(profile)
    entry_by_id = {str(entry.get("id") or ""): entry for entry in experience_entries}
    all_experience_ids = {entry.get("id") for entry in experience_entries}
    required_experience_ids = set(get_required_experience_entry_ids(profile)) & all_experience_ids
    required_skill_ids = set(get_required_skill_category_ids(profile))
    max_bullets = get_max_experience_bullets(profile)

    all_text_parts: list[str] = [executive_profile]
    seen_experience_ids: set[str] = set()
    for update_index, update in enumerate(experience_updates):
        if not isinstance(update, dict):
            errors.append("Experience update must be an object")
            continue
        entry_id = str(update.get("id", "")).strip()
        bullets = update.get("bullets")
        if not entry_id:
            errors.append("Experience update missing id")
            continue
        if entry_id in seen_experience_ids:
            errors.append(f"Duplicate experience update: {entry_id}")
            continue
        seen_experience_ids.add(entry_id)
        if not isinstance(bullets, list) or not bullets:
            errors.append(f"Experience update '{entry_id}' must include bullets")
            continue
        if len(bullets) > max_bullets and not _bullet_overflow_is_mandatory(
            data,
            entry_id=entry_id,
            update_index=update_index,
            bullet_count=len(bullets),
        ):
            errors.append(f"Experience update '{entry_id}' exceeds {max_bullets} bullets")
        title = str(update.get("title") or "").strip()
        source_title = str(entry_by_id.get(entry_id, {}).get("title") or "").strip()
        if title and title != source_title:
            errors.append(
                f"Unsupported title rewrite for '{entry_id}': use an empty title or the exact source title"
            )
        all_text_parts.extend(str(bullet) for bullet in bullets)

    missing_experience_ids = required_experience_ids - seen_experience_ids
    extra_experience_ids = seen_experience_ids - required_experience_ids
    if missing_experience_ids:
        errors.append(
            "Missing experience updates: " + ", ".join(sorted(missing_experience_ids))
        )
    if extra_experience_ids:
        errors.append(
            "Unknown experience updates: " + ", ".join(sorted(extra_experience_ids))
        )

    seen_skill_ids: set[str] = set()
    for update in skill_updates:
        if not isinstance(update, dict):
            errors.append("Skill category update must be an object")
            continue
        category_id = str(update.get("id", "")).strip()
        items = update.get("items")
        if not category_id:
            errors.append("Skill category update missing id")
            continue
        if category_id in seen_skill_ids:
            errors.append(f"Duplicate skill category update: {category_id}")
            continue
        seen_skill_ids.add(category_id)
        if not isinstance(items, list) or not items:
            errors.append(f"Skill category update '{category_id}' must include items")
            continue
        allowed_for_category = {
            _normalize_output_term(item)
            for category in get_skill_categories(profile)
            if str(category.get("id") or "").strip() == category_id
            for item in normalize_profile_list(category.get("items", []))
        }
        for item in items:
            normalized_item = _normalize_output_term(item)
            if normalized_item and normalized_item not in allowed_for_category:
                errors.append(f"Fabricated skill: '{item}'")
        all_text_parts.extend(str(item) for item in items)

    missing_skill_ids = required_skill_ids - seen_skill_ids
    extra_skill_ids = seen_skill_ids - required_skill_ids
    if missing_skill_ids:
        errors.append("Missing skill category updates: " + ", ".join(sorted(missing_skill_ids)))
    if extra_skill_ids:
        errors.append("Unknown skill category updates: " + ", ".join(sorted(extra_skill_ids)))

    all_text = " ".join(all_text_parts).lower()

    found_leaks = [p for p in LLM_LEAK_PHRASES if p in all_text]
    if found_leaks:
        errors.append(f"LLM self-talk: '{found_leaks[0]}'")

    allowed_skills = _build_allowed_skill_terms(profile)
    for fake in FABRICATION_WATCHLIST:
        if len(fake) <= 2:
            continue
        if _contains_watch_term(all_text, fake) and fake not in allowed_skills:
            errors.append(f"Fabricated skill: '{fake}'")

    if mode != "lenient":
        found_banned = [w for w in BANNED_WORDS if re.search(r"\b" + re.escape(w) + r"\b", all_text)]
        if found_banned:
            msg = f"Banned words: {', '.join(found_banned[:5])}"
            if mode == "strict":
                errors.append(msg)
            else:
                warnings.append(msg)

    if errors:
        return ValidationResult.failure(tuple(errors), warnings=tuple(warnings))
    return ValidationResult.success(warnings=tuple(warnings))


def _bullet_overflow_is_mandatory(
    data: dict,
    *,
    entry_id: str,
    update_index: int,
    bullet_count: int,
) -> bool:
    mappings = data.get("generated_claim_mappings")
    if not isinstance(mappings, list):
        return False
    mandatory_indexes: set[int] = set()
    prefixes = (
        f"experience.{entry_id}.bullets[",
        f"experience_updates.{entry_id}.bullets[",
        f"experience_updates[{update_index}].bullets[",
    )
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        location = str(mapping.get("location") or "")
        index = _claim_bullet_index(location, prefixes)
        if index is None:
            continue
        coverage_edges = mapping.get("coverage_edge_ids")
        non_requirement_reason = str(mapping.get("non_requirement_reason") or "")
        if (
            isinstance(coverage_edges, (list, tuple))
            and any(str(edge).strip() for edge in coverage_edges)
        ) or non_requirement_reason == "pinned":
            mandatory_indexes.add(index)
    return len(mandatory_indexes) >= bullet_count


def _claim_bullet_index(location: str, prefixes: tuple[str, ...]) -> int | None:
    for prefix in prefixes:
        if not location.startswith(prefix):
            continue
        try:
            return int(location.removeprefix(prefix).split("]", 1)[0])
        except (TypeError, ValueError):
            return None
    return None


# ---------------------------------------------------------------------------
# Rendered resume text validation
# ---------------------------------------------------------------------------


def _validate_master_tailored_resume(text: str, profile: dict) -> ValidationResult:
    """Validate rendered tailored resume text against the canonical master schema."""
    errors: list[str] = []
    warnings: list[str] = []
    text_lower = text.lower()

    required_sections = {
        "EXECUTIVE PROFILE": ["executive profile"],
        "EXPERIENCE": ["experience"],
        "EDUCATION": ["education"],
        "SKILLS": ["skills"],
    }
    for section, variants in required_sections.items():
        if not any(variant in text_lower for variant in variants):
            errors.append(f"Missing required section: {section}")

    required_experience_ids = set(get_required_experience_entry_ids(profile))
    for entry in get_experience_entries(profile):
        if required_experience_ids and entry.get("id") not in required_experience_ids:
            continue
        company = str(entry.get("company", "")).strip()
        if company and company.lower() not in text_lower:
            errors.append(f"Company '{company}' missing -- cannot remove real experience")

    all_education_ids = {entry.get("id") for entry in get_education_entries(profile)}
    required_education_ids = set(get_required_education_entry_ids(profile)) & all_education_ids
    for entry in get_education_entries(profile):
        if required_education_ids and entry.get("id") not in required_education_ids:
            continue
        institution = str(entry.get("institution", "")).strip()
        if institution and institution.lower() not in text_lower:
            errors.append(f"Education '{institution}' missing")

    all_skill_ids = {category.get("id") for category in get_skill_categories(profile)}
    required_skill_ids = set(get_required_skill_category_ids(profile)) & all_skill_ids
    for category in get_skill_categories(profile):
        if required_skill_ids and category.get("id") not in required_skill_ids:
            continue
        label = str(category.get("label", "")).strip()
        if label and label.lower() not in text_lower:
            errors.append(f"Skill category '{label}' missing")

    if errors:
        return ValidationResult.failure(tuple(errors), warnings=tuple(warnings))
    return ValidationResult.success(warnings=tuple(warnings))


# ---------------------------------------------------------------------------
# Cover letter validation
# ---------------------------------------------------------------------------


def _validate_cover_letter(text: str, mode: str = "normal") -> ValidationResult:
    """Programmatic validation of a cover letter."""
    errors: list[str] = []
    warnings: list[str] = []
    text_lower = text.lower()

    # 1. Em / en dashes — always an error (sanitize_text should have caught these).
    if "—" in text or "–" in text:
        errors.append("Contains em dash or en dash.")

    # 2. Banned words — severity depends on mode.
    if mode != "lenient":
        found = [w for w in BANNED_WORDS if re.search(r"\b" + re.escape(w) + r"\b", text_lower)]
        if found:
            msg = f"Banned words: {', '.join(found[:5])}"
            if mode == "strict":
                errors.append(msg)
            else:
                warnings.append(msg)

    # 3. Word count.
    words = len(text.split())
    if mode == "strict" and words > 250:
        errors.append(f"Too long ({words} words). Max 250.")
    elif mode == "normal" and words > 275:
        warnings.append(f"Long ({words} words). Target 250.")

    # 4. LLM self-talk — always an error regardless of mode.
    found_leaks = [p for p in LLM_LEAK_PHRASES if p in text_lower]
    if found_leaks:
        errors.append(f"LLM self-talk: '{found_leaks[0]}'")

    # 5. Must start with "Dear" — always checked.
    stripped = text.strip()
    if not stripped.lower().startswith("dear"):
        errors.append("Must start with 'Dear Hiring Manager,'")
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    closing_line = lines[-1] if lines else ""
    if (
        len(lines) < 3
        or len(closing_line.split()) > 6
        or closing_line.endswith((".", "!", "?"))
        or not _COVER_LETTER_CLOSING_RE.fullmatch(closing_line)
    ):
        errors.append("Must end with a short closing/sign-off line.")

    if errors:
        return ValidationResult.failure(tuple(errors), warnings=tuple(warnings))
    return ValidationResult.success(warnings=tuple(warnings))


# ---------------------------------------------------------------------------
# ContentValidator — pure, port-shaped facade
# ---------------------------------------------------------------------------


def _profile_dict(profile_or_snapshot: ProfileSnapshot | dict) -> dict:
    """Accept both a snapshot and a raw dict; return the canonical dict."""
    if isinstance(profile_or_snapshot, ProfileSnapshot):
        return profile_or_snapshot.as_dict()
    return profile_or_snapshot


@dataclass(frozen=True)
class ContentValidator:
    """Pure, profile-driven validation facade for the Materials context.

    All methods accept either a :class:`ProfileSnapshot` or a raw dict so
    legacy callers can be ported incrementally. Returns
    :class:`ValidationResult` value objects — never raises for validation
    failures (those go on the result).
    """

    def validate_json_fields(
        self,
        data: dict,
        profile: ProfileSnapshot | dict,
        *,
        mode: str = "normal",
    ) -> ValidationResult:
        """Validate the canonical tailoring JSON for the master resume schema."""
        return _validate_master_json_fields(data, _profile_dict(profile), mode=mode)

    def validate_tailored_resume(
        self,
        text: str,
        profile: ProfileSnapshot | dict,
    ) -> ValidationResult:
        """Validate rendered tailored resume text against the master schema."""
        return _validate_master_tailored_resume(text, _profile_dict(profile))

    def validate_cover_letter(
        self,
        text: str,
        *,
        mode: str = "normal",
    ) -> ValidationResult:
        """Programmatic validation of a cover letter."""
        return _validate_cover_letter(text, mode)


# ---------------------------------------------------------------------------
# ResumeAssembler — pure text assembler
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResumeAssembler:
    """Assemble plain-text resume output from the tailored JSON payload.

    Pure function — takes the canonical profile dict + LLM JSON,
    returns the final resume text. The header (name, contact) is always
    code-injected, never LLM-generated.
    """

    def assemble_resume_text(
        self,
        data: dict,
        profile: ProfileSnapshot | dict,
    ) -> str:
        return _assemble_resume_text(data, _profile_dict(profile))


def _assemble_resume_text(data: dict, profile: dict) -> str:
    """Pure resume text assembler — mirror of the legacy
    ``tailor.assemble_resume_text``."""
    require_resume_master(profile)
    personal = profile.get("personal", {})
    tailoring_policy = get_tailoring_policy(profile)
    resume = get_resume_master(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    required_education_ids = set(
        get_resume_master(profile).get("tailoring_rules", {}).get("required_education_entry_ids", [])
    )
    all_experience_entries = get_experience_entries(profile)
    all_education_entries = get_education_entries(profile)
    all_skill_categories = get_skill_categories(profile)
    experience_entries = [
        entry for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    education_entries = [
        entry for entry in all_education_entries
        if not required_education_ids or entry.get("id") in required_education_ids
    ] or all_education_entries
    skill_categories = [
        category for category in all_skill_categories
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories

    experience_updates = experience_updates_by_id(data)
    skill_updates = {
        entry.get("id"): entry
        for entry in data.get("skill_category_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }

    lines: list[str] = []
    lines.append(personal.get("full_name", ""))

    contact_parts: list[str] = []
    if personal.get("email"):
        contact_parts.append(personal["email"])
    if personal.get("phone"):
        contact_parts.append(personal["phone"])
    if personal.get("website_url"):
        contact_parts.append(personal["website_url"])
    if personal.get("linkedin_url"):
        contact_parts.append(personal["linkedin_url"])
    if contact_parts:
        lines.append(" | ".join(contact_parts))
    lines.append("")

    lines.append("EXECUTIVE PROFILE")
    if tailoring_policy["allow_summary_rewrite"]:
        executive_profile = data.get("executive_profile", "")
    else:
        executive_profile = resume.get("executive_profile", {}).get("baseline_text", "")
    lines.append(sanitize_text(executive_profile))
    lines.append("")

    lines.append("EXPERIENCE")
    for entry in experience_entries:
        update = experience_updates.get(entry.get("id"), {})
        title = tailored_experience_title(entry, update, profile)
        lines.append(sanitize_text(f"{title} | {entry.get('company', '')}"))
        subtitle_parts = [entry.get("location", ""), entry.get("date_range", "")]
        subtitle = " | ".join(part for part in subtitle_parts if part)
        if subtitle:
            lines.append(sanitize_text(subtitle))

        bullets = tailored_experience_bullets(entry, update, profile)
        for bullet in bullets:
            lines.append(f"- {sanitize_text(str(bullet))}")
        lines.append("")

    lines.append("EDUCATION")
    for entry in education_entries:
        lines.append(sanitize_text(str(entry.get("degree", ""))))
        subtitle_parts = [entry.get("institution", ""), entry.get("location", ""), entry.get("date", "")]
        subtitle = " | ".join(part for part in subtitle_parts if part)
        if subtitle:
            lines.append(sanitize_text(subtitle))
        if entry.get("details"):
            lines.append(sanitize_text(str(entry["details"])))
        lines.append("")

    lines.append("SKILLS")
    for category in skill_categories:
        update = skill_updates.get(category.get("id"), {})
        items = tailored_skill_items(category, update, profile)
        sanitized_items = [sanitize_text(str(item)) for item in items if str(item).strip()]
        lines.append(f"{category.get('label', 'Skills')}: {', '.join(sanitized_items)}")

    return "\n".join(lines)


__all__ = [
    "BANNED_WORDS",
    "ContentValidator",
    "FABRICATION_WATCHLIST",
    "LLM_LEAK_PHRASES",
    "ResumeAssembler",
    "normalize_profile_list",
    "sanitize_text",
]


# Suppress unused-import warning for ``Any``.
_ = Any
