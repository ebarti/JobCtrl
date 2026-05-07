"""Pure dict accessors for the canonical resume schema.

These helpers operate on a profile dict in the canonical ``profile.json``
shape. Modern call sites obtain that dict via ``ProfileSnapshot.as_dict()``
from ``jobhunter.domain.profile``; the helpers themselves stay schema-only
so legacy modules under ``scoring/{pdf,validator}.py`` keep working without
needing to know about the aggregate.

Historic ``augment_profile`` (which deep-copied + injected legacy
``skills_boundary`` / ``resume_facts`` keys) has been removed in Phase 4 —
``ProfileSnapshot.from_profile`` derives those fields directly from the
aggregate now.
"""

from __future__ import annotations


def has_resume_master(profile: dict) -> bool:
    """Return True when the profile uses the structured resume master schema."""
    return isinstance(profile.get("resume"), dict)


def require_resume_master(profile: dict) -> dict:
    """Return the profile when the canonical resume schema is present, else fail fast."""
    if not has_resume_master(profile):
        raise ValueError(
            "profile.json must include a top-level 'resume' block with executive_profile, "
            "experience_entries, education_entries, skill_categories, and tailoring_rules. "
            "Run `jobhunter init` or use profile.example.json as a template."
        )
    return profile


def get_resume_master(profile: dict) -> dict:
    """Return the structured resume section from the profile."""
    return profile.get("resume", {})


def get_resume_constraints(profile: dict) -> dict:
    """Return tailoring constraints for the structured resume schema."""
    return profile.get("resume_constraints", {})


def get_experience_entries(profile: dict) -> list[dict]:
    """Return canonical experience entries from the structured resume schema."""
    return list(get_resume_master(profile).get("experience_entries", []))


def get_education_entries(profile: dict) -> list[dict]:
    """Return canonical education entries from the structured resume schema."""
    return list(get_resume_master(profile).get("education_entries", []))


def get_skill_categories(profile: dict) -> list[dict]:
    """Return canonical skill categories from the structured resume schema."""
    return list(get_resume_master(profile).get("skill_categories", []))


def get_required_experience_entry_ids(profile: dict) -> list[str]:
    """Return the required experience entry IDs."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    ids = rules.get("required_experience_entry_ids")
    if isinstance(ids, list) and ids:
        return ids
    return [entry.get("id", "") for entry in get_experience_entries(profile) if entry.get("id")]


def get_required_education_entry_ids(profile: dict) -> list[str]:
    """Return the required education entry IDs."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    ids = rules.get("required_education_entry_ids")
    if isinstance(ids, list) and ids:
        return ids
    return [entry.get("id", "") for entry in get_education_entries(profile) if entry.get("id")]


def get_required_skill_category_ids(profile: dict) -> list[str]:
    """Return the required skill category IDs."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    ids = rules.get("required_skill_category_ids")
    if isinstance(ids, list) and ids:
        return ids
    return [entry.get("id", "") for entry in get_skill_categories(profile) if entry.get("id")]


def get_required_bullets_by_experience_id(profile: dict) -> dict[str, list[str]]:
    """Return required baseline bullets keyed by experience entry ID."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    raw = rules.get("required_bullets_by_experience_id", {})
    if not isinstance(raw, dict):
        return {}
    required: dict[str, list[str]] = {}
    for entry_id, bullets in raw.items():
        if not isinstance(entry_id, str) or not isinstance(bullets, list):
            continue
        cleaned = [str(bullet).strip() for bullet in bullets if str(bullet).strip()]
        if cleaned:
            required[entry_id] = cleaned
    return required


def get_required_skills_by_category_id(profile: dict) -> dict[str, list[str]]:
    """Return required baseline skill names keyed by skill category ID."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    raw = rules.get("required_skills_by_category_id", {})
    if not isinstance(raw, dict):
        return {}
    required: dict[str, list[str]] = {}
    for category_id, skills in raw.items():
        if not isinstance(category_id, str) or not isinstance(skills, list):
            continue
        cleaned = [str(skill).strip() for skill in skills if str(skill).strip()]
        if cleaned:
            required[category_id] = cleaned
    return required


DEFAULT_TAILORING_POLICY = {
    "mode": "balanced",
    "allow_title_reframing": False,
    "allow_achievement_rewriting": True,
    "allow_skill_reordering": True,
    "allow_summary_rewrite": True,
    "allow_minor_inference": False,
}

DEFAULT_WRITING_STYLE = {
    "tone": "direct",
    "bullet_style": "balanced",
    "verbosity": "balanced",
    "keyword_density": "natural",
    "avoid_first_person": True,
}


def get_tailoring_policy(profile: dict) -> dict:
    """Return normalized controls for how much the AI may tailor the resume."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    raw = rules.get("tailoring_policy", {})
    if not isinstance(raw, dict):
        raw = {}
    policy = {**DEFAULT_TAILORING_POLICY, **raw}
    if policy["mode"] not in {"strict", "balanced", "aggressive"}:
        policy["mode"] = DEFAULT_TAILORING_POLICY["mode"]
    for key, default in DEFAULT_TAILORING_POLICY.items():
        if isinstance(default, bool):
            policy[key] = bool(policy.get(key, default))
    if policy["mode"] == "strict":
        policy.update(
            {
                "allow_title_reframing": False,
                "allow_achievement_rewriting": False,
                "allow_skill_reordering": False,
                "allow_summary_rewrite": False,
                "allow_minor_inference": False,
            }
        )
    elif policy["mode"] == "aggressive":
        policy.setdefault("allow_achievement_rewriting", True)
        policy.setdefault("allow_skill_reordering", True)
        policy.setdefault("allow_summary_rewrite", True)
    return policy


def get_writing_style(profile: dict) -> dict:
    """Return normalized writing-style guidance for resume tailoring."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    raw = rules.get("writing_style", {})
    if not isinstance(raw, dict):
        raw = {}
    style = {**DEFAULT_WRITING_STYLE, **raw}
    allowed = {
        "tone": {"direct", "executive", "technical", "confident", "warm"},
        "bullet_style": {"balanced", "impact", "technical_depth", "leadership"},
        "verbosity": {"concise", "balanced", "detailed"},
        "keyword_density": {"natural", "moderate", "high"},
    }
    for key, options in allowed.items():
        if style.get(key) not in options:
            style[key] = DEFAULT_WRITING_STYLE[key]
    style["avoid_first_person"] = bool(style.get("avoid_first_person", DEFAULT_WRITING_STYLE["avoid_first_person"]))
    return style


def get_custom_tailoring_prompt(profile: dict) -> str:
    """Return optional user-authored guidance injected into every tailoring prompt."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    value = rules.get("custom_tailoring_prompt", "")
    return str(value).strip()


def get_max_experience_bullets(profile: dict, default: int = 4) -> int:
    """Return the configured maximum bullet count for each experience entry."""
    rules = get_resume_master(profile).get("tailoring_rules", {})
    value = rules.get("max_experience_bullets")
    if isinstance(value, int) and value > 0:
        return value
    return default


def _normalize_text(value: object) -> str:
    return " ".join(str(value or "").lower().split())


def tailored_experience_title(entry: dict, update: dict, profile: dict) -> str:
    """Return the title allowed by the user's tailoring policy."""
    policy = get_tailoring_policy(profile)
    if policy["allow_title_reframing"] and isinstance(update, dict) and str(update.get("title", "")).strip():
        return str(update["title"]).strip()
    return str(entry.get("title", ""))


def tailored_experience_bullets(entry: dict, update: dict, profile: dict) -> list[str]:
    """Return bullets allowed by policy, with required baseline bullets preserved."""
    policy = get_tailoring_policy(profile)
    source = update.get("bullets") if policy["allow_achievement_rewriting"] and isinstance(update, dict) else None
    if not isinstance(source, list) or not source:
        source = entry.get("bullets", [])

    bullets = [str(bullet).strip() for bullet in source if str(bullet).strip()]
    required = get_required_bullets_by_experience_id(profile).get(str(entry.get("id", "")), [])
    seen = {_normalize_text(bullet) for bullet in bullets}
    for bullet in required:
        normalized = _normalize_text(bullet)
        if normalized and normalized not in seen:
            bullets.append(bullet)
            seen.add(normalized)

    max_bullets = get_max_experience_bullets(profile)
    if len(bullets) <= max_bullets:
        return bullets

    required_norm = {_normalize_text(bullet) for bullet in required}
    kept_required = [bullet for bullet in bullets if _normalize_text(bullet) in required_norm]
    kept_other = [bullet for bullet in bullets if _normalize_text(bullet) not in required_norm]
    return (kept_required + kept_other)[:max_bullets]


def tailored_skill_items(category: dict, update: dict, profile: dict) -> list[str]:
    """Return skills allowed by policy, with required baseline skills preserved."""
    policy = get_tailoring_policy(profile)
    source = update.get("items") if policy["allow_skill_reordering"] and isinstance(update, dict) else None
    if not isinstance(source, list) or not source:
        source = category.get("items", [])

    items = [str(item).strip() for item in source if str(item).strip()]
    required = get_required_skills_by_category_id(profile).get(str(category.get("id", "")), [])
    seen = {_normalize_text(item) for item in items}
    for item in required:
        normalized = _normalize_text(item)
        if normalized and normalized not in seen:
            items.append(item)
            seen.add(normalized)
    return items

