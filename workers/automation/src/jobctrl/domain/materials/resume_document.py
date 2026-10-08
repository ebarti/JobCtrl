"""Canonical resume document and mechanical field formatting shared by verification and rendering."""

from __future__ import annotations
import re
from typing import Any
from jobctrl.domain.materials.services import sanitize_text
from jobctrl.resume_profile import (
    experience_updates_by_id,
    get_education_entries,
    get_required_education_entry_ids,
    get_required_skill_category_ids,
    get_resume_master,
    get_selected_experience_entries,
    get_skill_categories,
    get_tailoring_policy,
    tailored_experience_bullets,
    tailored_experience_title,
    tailored_skill_items,
)

ResumeDocument = dict[str, Any]
ContactItem = dict[str, str]
CONTACT_KIND_ORDER = {"phone": 0, "email": 1, "website": 2, "linkedin": 3, "github": 4}
DATE_RANGE_SEPARATOR_RE = re.compile(r"\s*(?:--|–|—)\s*")


def _normalize_url(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ""
    lower = raw.lower()
    if lower.startswith(("javascript:", "data:", "file:")):
        return ""
    if lower.startswith(("http://", "https://")):
        return raw
    if "://" in raw:
        return ""
    return f"https://{raw}"


def _link_label(value: str) -> str:
    return re.sub(r"^https?://", "", value.strip(), flags=re.IGNORECASE).rstrip("/")


def _tel_href(value: str) -> str:
    normalized = re.sub(r"[^\d+]", "", value.strip())
    if normalized.count("+") > 1:
        normalized = normalized.replace("+", "")
    if "+" in normalized and not normalized.startswith("+"):
        normalized = normalized.replace("+", "")
    return f"tel:{normalized}" if normalized else ""


def _contact_item(kind: str, label: str, href: str = "") -> ContactItem | None:
    clean_label = sanitize_text(label)
    if not clean_label:
        return None
    return {"kind": kind, "label": clean_label, "href": href}


def _contact_url_item(kind: str, value: str, *, label: str | None = None) -> ContactItem | None:
    href = _normalize_url(value)
    if not href:
        return None
    return _contact_item(kind, label or _link_label(value), href)


def order_contact_items(items: list[ContactItem]) -> list[ContactItem]:
    return sorted(
        items,
        key=lambda item: (
            CONTACT_KIND_ORDER.get(item.get("kind", ""), len(CONTACT_KIND_ORDER)),
            item.get("label", ""),
        ),
    )


def contact_items_from_personal(personal: dict[str, Any]) -> list[ContactItem]:
    """Build moderncv-style contact fields with safe hyperlink targets."""

    items: list[ContactItem] = []
    phone = str(personal.get("phone", "")).strip()
    if phone:
        item = _contact_item("phone", phone, _tel_href(phone))
        if item:
            items.append(item)
    email = str(personal.get("email", "")).strip()
    if email:
        item = _contact_item("email", email, f"mailto:{email}")
        if item:
            items.append(item)
    website = str(personal.get("website_url") or personal.get("portfolio_url") or "").strip()
    if website:
        item = _contact_url_item("website", website)
        if item:
            items.append(item)
    linkedin = str(personal.get("linkedin_url", "")).strip()
    if linkedin:
        label = _link_label(linkedin).rsplit("/", 1)[-1] or _link_label(linkedin)
        item = _contact_url_item("linkedin", linkedin, label=label)
        if item:
            items.append(item)
    github = str(personal.get("github_url", "")).strip()
    if github:
        label = _link_label(github).rsplit("/", 1)[-1] or _link_label(github)
        item = _contact_url_item("github", github, label=label)
        if item:
            items.append(item)
    return order_contact_items(items)


def address_line_from_personal(personal: dict[str, Any]) -> str:
    address = sanitize_text(str(personal.get("address", "")))
    city = sanitize_text(str(personal.get("city", "")))
    postal_code = sanitize_text(str(personal.get("postal_code", "")))
    country = sanitize_text(str(personal.get("country", "")))
    first_line = ", ".join(part for part in [address, city] if part)
    second_line = " ".join(part for part in [postal_code, country] if part)
    return " - ".join(part for part in [first_line, second_line] if part)


def contact_items_from_text(contact_text: str) -> list[ContactItem]:
    """Best-effort link/icon reconstruction for legacy text-only resumes."""

    items: list[ContactItem] = []
    for raw_part in re.split(r"\s+\|\s+|\s+•\s+", contact_text):
        part = raw_part.strip()
        if not part:
            continue
        lower = part.lower()
        if "@" in part and not lower.startswith(("http://", "https://")):
            item = _contact_item("email", part, f"mailto:{part}")
        elif "linkedin.com" in lower:
            label = _link_label(part).rsplit("/", 1)[-1] or _link_label(part)
            item = _contact_url_item("linkedin", part, label=label)
        elif "github.com" in lower:
            label = _link_label(part).rsplit("/", 1)[-1] or _link_label(part)
            item = _contact_url_item("github", part, label=label)
        elif lower.startswith(("http://", "https://")) or "." in part:
            item = _contact_url_item("website", part)
        elif re.search(r"\d", part):
            item = _contact_item("phone", part, _tel_href(part))
        else:
            item = _contact_item("website", part)
        if item:
            items.append(item)
    return order_contact_items(items)


def contact_items_text(items: list[ContactItem]) -> str:
    return " • ".join(item["label"] for item in items if item.get("label"))


def normalize_resume_date_range(value: str) -> str:
    """Normalize resume date ranges to the app's single-dash display convention."""

    return DATE_RANGE_SEPARATOR_RE.sub(" - ", value.strip()).strip()


def build_resume_document(tailored_payload: dict, profile: dict) -> ResumeDocument:
    """Build the semantic resume document consumed by the HTML renderer."""

    personal = profile.get("personal", {})
    tailoring_policy = get_tailoring_policy(profile)
    resume = get_resume_master(profile)
    required_education_ids = get_required_education_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    all_education_entries = get_education_entries(profile)
    all_skill_categories = get_skill_categories(profile)

    experience_entries = get_selected_experience_entries(profile, tailored_payload)
    education_entries = [
        entry
        for entry in all_education_entries
        if not required_education_ids or entry.get("id") in required_education_ids
    ] or all_education_entries
    skill_categories = [
        category
        for category in all_skill_categories
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories

    experience_updates = experience_updates_by_id(tailored_payload)
    skill_updates = {
        entry.get("id"): entry
        for entry in tailored_payload.get("skill_category_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }

    contact_items = contact_items_from_personal(personal)
    summary_source = (
        tailored_payload.get("executive_profile", "")
        if tailoring_policy["allow_summary_rewrite"]
        else resume.get("executive_profile", {}).get("baseline_text", "")
    )

    experiences: list[dict[str, Any]] = []
    for entry in experience_entries:
        entry_id = str(entry.get("id", "")).strip() or f"experience-{len(experiences) + 1}"
        update = experience_updates.get(entry.get("id"), {})
        location = sanitize_text(str(entry.get("location", "")))
        date_range = normalize_resume_date_range(sanitize_text(str(entry.get("date_range", ""))))
        subtitle_parts = [location, date_range]
        experiences.append(
            {
                "id": entry_id,
                "title": sanitize_text(tailored_experience_title(entry, update, profile)),
                "company": sanitize_text(str(entry.get("company", ""))),
                "location": location,
                "date_range": date_range,
                "subtitle": sanitize_text(" | ".join(part for part in subtitle_parts if part)),
                "summary": sanitize_text(str(entry.get("summary", ""))),
                "bullets": [
                    {
                        "id": f"experience:{entry_id}#{index}",
                        "text": sanitize_text(str(bullet)),
                    }
                    for index, bullet in enumerate(tailored_experience_bullets(entry, update, profile))
                ],
            }
        )

    education: list[dict[str, Any]] = []
    for index, entry in enumerate(education_entries):
        entry_id = str(entry.get("id", "")).strip() or f"education-{index + 1}"
        subtitle_parts = [entry.get("institution", ""), entry.get("location", ""), entry.get("date", "")]
        education.append(
            {
                "id": entry_id,
                "degree": sanitize_text(str(entry.get("degree", ""))),
                "institution": sanitize_text(str(entry.get("institution", ""))),
                "location": sanitize_text(str(entry.get("location", ""))),
                "date": sanitize_text(str(entry.get("date", ""))),
                "subtitle": sanitize_text(" | ".join(part for part in subtitle_parts if part)),
                "details": sanitize_text(str(entry.get("details", ""))),
            }
        )

    skills: list[dict[str, Any]] = []
    for category in skill_categories:
        category_id = str(category.get("id", "")).strip() or f"skills-{len(skills) + 1}"
        update = skill_updates.get(category.get("id"), {})
        skills.append(
            {
                "id": category_id,
                "label": sanitize_text(str(category.get("label", "Skills"))),
                "items": [
                    sanitize_text(str(item))
                    for item in tailored_skill_items(category, update, profile)
                    if str(item).strip()
                ],
            }
        )

    return {
        "personal": {
            "full_name": sanitize_text(str(personal.get("full_name", ""))),
            "address": address_line_from_personal(personal),
            "contact": [item["label"] for item in contact_items],
            "contact_items": contact_items,
        },
        "summary": sanitize_text(str(summary_source)),
        "experience": experiences,
        "education": education,
        "skills": skills,
    }
