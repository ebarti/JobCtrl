"""Resume and cover letter validation: banned words, fabrication detection, structural checks.

All validation is profile-driven -- no hardcoded personal data. The validator receives
a profile dict (from jobhunter.config.load_profile()) and validates against the user's
actual skills, companies, projects, and school.

Validation modes
----------------
strict  -- banned words = hard errors that trigger retries (original behavior)
normal  -- banned words = warnings only; fabrication/structure = errors (default)
lenient -- banned words ignored; only fabrication and required structure checked
"""

import re
import logging

from jobhunter.resume_profile import (
    get_education_entries,
    get_experience_entries,
    get_max_experience_bullets,
    get_required_education_entry_ids,
    get_required_experience_entry_ids,
    get_required_skill_category_ids,
    get_skill_categories,
)

log = logging.getLogger(__name__)


# ── Universal Constants (not personal data) ───────────────────────────────

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

# Known fabrication markers: completely unrelated tools/languages.
# Reasonable stretches (K8s, Terraform, Redis, Kafka etc.) are ALLOWED.
FABRICATION_WATCHLIST: set[str] = {
    # Languages with zero relation to the candidate's stack
    "c#", "c++", "golang", "rust", "ruby",
    "kotlin", "swift", "scala", "matlab",
    # Frameworks for wrong languages
    "spring", "django", "rails", "angular", "vue", "svelte",
    # Hard lies: certifications can't be stretched
    "certified", "pmp", "scrum master", "aws certified",
}

# ── Helpers ───────────────────────────────────────────────────────────────

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


def _contains_watch_term(text: str, term: str) -> bool:
    """Return True when a fabrication-watch term appears as a real term match."""
    if re.fullmatch(r"[a-z0-9 ]+", term):
        return re.search(r"\b" + re.escape(term) + r"\b", text) is not None
    return term in text


def sanitize_text(text: str) -> str:
    """Auto-fix common LLM output issues instead of rejecting."""
    text = text.replace(" \u2014 ", ", ").replace("\u2014", ", ")   # em dash -> comma
    text = text.replace("\u2013", "-")    # en dash -> hyphen
    text = text.replace("\u201c", '"').replace("\u201d", '"')   # smart double quotes
    text = text.replace("\u2018", "'").replace("\u2019", "'")   # smart single quotes
    return text.strip()


def _validate_master_json_fields(data: dict, profile: dict, mode: str = "normal") -> dict:
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
        return {"passed": False, "errors": errors, "warnings": warnings}

    all_experience_ids = {entry.get("id") for entry in get_experience_entries(profile)}
    required_experience_ids = set(get_required_experience_entry_ids(profile)) & all_experience_ids
    required_skill_ids = set(get_required_skill_category_ids(profile))
    max_bullets = get_max_experience_bullets(profile)

    all_text_parts: list[str] = [executive_profile]
    seen_experience_ids: set[str] = set()
    for update in experience_updates:
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
        if len(bullets) > max_bullets:
            errors.append(f"Experience update '{entry_id}' exceeds {max_bullets} bullets")
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

    return {"passed": len(errors) == 0, "errors": errors, "warnings": warnings}


def _validate_master_tailored_resume(text: str, profile: dict) -> dict:
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

    return {"passed": len(errors) == 0, "errors": errors, "warnings": warnings}


# ── JSON Field Validation ─────────────────────────────────────────────────

def validate_json_fields(data: dict, profile: dict, mode: str = "normal") -> dict:
    """Validate the canonical tailoring JSON for the master resume schema."""
    return _validate_master_json_fields(data, profile, mode=mode)


# ── Full Resume Text Validation ───────────────────────────────────────────

def validate_tailored_resume(text: str, profile: dict, original_text: str = "") -> dict:
    """Validate the rendered tailored resume against the canonical master schema."""
    return _validate_master_tailored_resume(text, profile)


# ── Cover Letter Validation ──────────────────────────────────────────────

def validate_cover_letter(text: str, mode: str = "normal") -> dict:
    """Programmatic validation of a cover letter.

    Args:
        text: The cover letter text to validate.
        mode: Validation strictness — "strict", "normal", or "lenient".
              strict  → banned words are errors (trigger retries); word limit enforced
              normal  → banned words are warnings; word limit is soft (+25 words)
              lenient → banned words ignored; word count not checked

    Returns:
        {"passed": bool, "errors": list[str], "warnings": list[str]}
    """
    errors: list[str] = []
    warnings: list[str] = []
    text_lower = text.lower()

    # 1. Em dashes — always an error (sanitize_text should have caught these)
    if "\u2014" in text or "\u2013" in text:
        errors.append("Contains em dash or en dash.")

    # 2. Banned words — severity depends on mode
    if mode != "lenient":
        found = [w for w in BANNED_WORDS if re.search(r"\b" + re.escape(w) + r"\b", text_lower)]
        if found:
            msg = f"Banned words: {', '.join(found[:5])}"
            if mode == "strict":
                errors.append(msg)
            else:  # normal
                warnings.append(msg)

    # 3. Word count
    words = len(text.split())
    if mode == "strict" and words > 250:
        errors.append(f"Too long ({words} words). Max 250.")
    elif mode == "normal" and words > 275:
        warnings.append(f"Long ({words} words). Target 250.")
    # lenient: no word count check

    # 4. LLM self-talk — always an error regardless of mode
    found_leaks = [p for p in LLM_LEAK_PHRASES if p in text_lower]
    if found_leaks:
        errors.append(f"LLM self-talk: '{found_leaks[0]}'")

    # 5. Must start with "Dear" — always checked (preamble should have been stripped)
    stripped = text.strip()
    if not stripped.lower().startswith("dear"):
        errors.append("Must start with 'Dear Hiring Manager,'")

    return {"passed": len(errors) == 0, "errors": errors, "warnings": warnings}
