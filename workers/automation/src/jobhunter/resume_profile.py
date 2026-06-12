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

import re

_LEGACY_BULLET_METRIC_RE = re.compile(
    r"(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?\s?(?:k|m|b|million|billion)?"
    r"|\d+(?:\.\d+)?%"
    r"|\d+(?:\.\d+)?x"
    r"|\d+(?:\.\d+)?\s?(?:ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|qps|req/s))",
    re.IGNORECASE,
)
_LEGACY_BULLET_SENIORITY_TERMS = (
    "own",
    "owned",
    "ownership",
    "scope",
    "influence",
    "influenced",
    "cross-team",
    "stakeholder",
    "stakeholders",
    "led",
    "lead",
    "mentor",
    "mentored",
    "architect",
    "architected",
    "strategy",
    "technical leadership",
)


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
    "claim_mode": "evidence_reframing",
    "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
    "allow_adjacent_achievement_drafts": False,
}

DEFAULT_WRITING_STYLE = {
    "tone": "direct",
    "bullet_style": "balanced",
    "verbosity": "balanced",
    "keyword_density": "natural",
    "avoid_first_person": True,
}

CLAIM_MODES = {"verified_only", "evidence_reframing", "adjacent_translation", "draft_requires_confirmation"}
AUTO_APPROVABLE_CLAIM_MODES = {"verified_only", "evidence_reframing"}
EVIDENCE_STRENGTHS = {"verified", "supported", "inferred", "draft"}


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
    if policy.get("claim_mode") not in CLAIM_MODES:
        policy["claim_mode"] = DEFAULT_TAILORING_POLICY["claim_mode"]
    raw_auto = policy.get("auto_approvable_claim_modes")
    if isinstance(raw_auto, list):
        policy["auto_approvable_claim_modes"] = [
            str(mode)
            for mode in raw_auto
            if str(mode) in AUTO_APPROVABLE_CLAIM_MODES
        ] or list(DEFAULT_TAILORING_POLICY["auto_approvable_claim_modes"])
    else:
        policy["auto_approvable_claim_modes"] = list(DEFAULT_TAILORING_POLICY["auto_approvable_claim_modes"])
    if policy["mode"] == "strict":
        policy.update(
            {
                "allow_title_reframing": False,
                "allow_achievement_rewriting": False,
                "allow_skill_reordering": False,
                "allow_summary_rewrite": False,
                "allow_minor_inference": False,
                "claim_mode": "verified_only",
                "auto_approvable_claim_modes": ["verified_only"],
                "allow_adjacent_achievement_drafts": False,
            }
        )
    elif policy["mode"] == "aggressive":
        policy.setdefault("allow_achievement_rewriting", True)
        policy.setdefault("allow_skill_reordering", True)
        policy.setdefault("allow_summary_rewrite", True)
        policy["allow_adjacent_achievement_drafts"] = bool(
            policy.get("allow_adjacent_achievement_drafts", False)
        )
    else:
        policy["allow_adjacent_achievement_drafts"] = False
    return policy


def get_claim_mode(profile: dict) -> str:
    """Return the normalized claim mode used for resume tailoring."""
    return str(get_tailoring_policy(profile)["claim_mode"])


def get_auto_approvable_claim_modes(profile: dict) -> list[str]:
    """Return claim modes that can be approved without extra user confirmation."""
    return list(get_tailoring_policy(profile)["auto_approvable_claim_modes"])


def get_tailoring_quality_controls(profile: dict) -> dict:
    """Return normalized evidence/claim controls used by quality checks."""
    policy = get_tailoring_policy(profile)
    return {
        "claim_mode": policy["claim_mode"],
        "auto_approvable_claim_modes": list(policy["auto_approvable_claim_modes"]),
        "allow_adjacent_achievement_drafts": policy["allow_adjacent_achievement_drafts"],
    }


def get_achievement_evidence(profile: dict) -> list[dict]:
    """Return normalized achievement evidence flattened across experience entries."""
    evidence: list[dict] = []
    for entry in get_experience_entries(profile):
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id", "")).strip()
        raw_items = entry.get("achievement_evidence")
        normalized_items: list[dict] = []
        if isinstance(raw_items, list):
            for item in raw_items:
                if not isinstance(item, dict):
                    continue
                normalized = _normalize_achievement_evidence(item)
                normalized["experience_entry_id"] = entry_id
                normalized_items.append(normalized)
        if normalized_items:
            evidence.extend(normalized_items)
            continue
        if not entry_id:
            continue
        for bullet_index, bullet in enumerate(_text_list(entry.get("bullets")), start=1):
            normalized = _legacy_bullet_achievement_evidence(
                entry=entry,
                entry_id=entry_id,
                bullet=bullet,
                bullet_index=bullet_index,
            )
            normalized["experience_entry_id"] = entry_id
            evidence.append(normalized)
    return evidence


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


def _normalize_achievement_evidence(item: dict) -> dict:
    strength = str(item.get("evidence_strength") or "supported").strip()
    if strength not in EVIDENCE_STRENGTHS:
        strength = "supported"
    try:
        confidence = float(item.get("claim_confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    return {
        "id": str(item.get("id", "")).strip(),
        "source_text": str(item.get("source_text", "")).strip(),
        "scope": str(item.get("scope", "")).strip(),
        "action": str(item.get("action", "")).strip(),
        "tools": _text_list(item.get("tools")),
        "metrics": _text_list(item.get("metrics")),
        "outcome": str(item.get("outcome", "")).strip(),
        "seniority_signal": str(item.get("seniority_signal", "")).strip(),
        "evidence_strength": strength,
        "claim_confidence": confidence,
        "user_confirmed": bool(item.get("user_confirmed", False)),
        "tags": _text_list(item.get("tags")),
    }


def legacy_bullet_evidence_id(entry_id: str, bullet_index: int) -> str:
    """Return the stable evidence id used for legacy resume bullets."""
    safe_entry_id = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(entry_id).strip()).strip("_")
    safe_entry_id = safe_entry_id or "experience"
    return f"{safe_entry_id}_bullet_{max(1, int(bullet_index))}"


def _legacy_bullet_achievement_evidence(
    *,
    entry: dict,
    entry_id: str,
    bullet: str,
    bullet_index: int,
) -> dict:
    source_text = str(bullet).strip()
    title = str(entry.get("title", "")).strip()
    company = str(entry.get("company", "")).strip()
    normalized = _normalize_text(" ".join([title, company, source_text]))
    seniority_signal = (
        "resume bullet contains seniority signal"
        if any(term in normalized for term in _LEGACY_BULLET_SENIORITY_TERMS)
        else ""
    )
    return {
        "id": legacy_bullet_evidence_id(entry_id, bullet_index),
        "source_text": source_text,
        "scope": " ".join(part for part in [title, company] if part),
        "action": source_text,
        "tools": [],
        "metrics": [
            re.sub(r"\s+", " ", match.group(0).strip())
            for match in _LEGACY_BULLET_METRIC_RE.finditer(source_text)
        ],
        "outcome": source_text,
        "seniority_signal": seniority_signal,
        "evidence_strength": "supported",
        "claim_confidence": 0.8,
        "user_confirmed": True,
        "tags": [],
    }


def _text_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


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
