"""HtmlResumePdfAdapter — structured resume HTML/CSS + Playwright PDF renderer.

This adapter implements the default resume half of ``PdfRendererPort`` without
LaTeX. It produces ``resume_pdf`` artifacts with ``RenderFormat.HTML_PDF`` and
records DOM-derived layout boxes for Apply Review line highlighting.
"""

from __future__ import annotations

import html
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any

from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.services import sanitize_text
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)
from jobhunter.resume_profile import (
    get_education_entries,
    get_experience_entries,
    get_required_education_entry_ids,
    get_required_experience_entry_ids,
    get_required_skill_category_ids,
    get_resume_master,
    get_skill_categories,
    get_tailoring_policy,
    tailored_experience_bullets,
    tailored_experience_title,
    tailored_skill_items,
)

log = logging.getLogger(__name__)

LayoutBox = dict[str, Any]
ResumeDocument = dict[str, Any]
ContactItem = dict[str, str]
RESUME_PAGE_VIEWPORT = {"width": 794, "height": 1123}
CONTACT_KIND_ORDER = {"phone": 0, "email": 1, "website": 2, "linkedin": 3, "github": 4}
DATE_RANGE_SEPARATOR_RE = re.compile(r"\s*(?:--|–|—)\s*")

RESUME_HTML_STYLE = """
@page {
  size: A4;
  margin: 0;
}
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  padding: 0;
}
body {
  background: #ffffff;
  color: #111111;
  font-family: "Avenir Next", "Aptos", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 10.35pt;
  line-height: 1.32;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.resume-page {
  inline-size: 210mm;
  min-block-size: 297mm;
  padding: 16.5mm 17.5mm 18mm;
  background: #ffffff;
}
.resume-header {
  margin-block-end: 4.5mm;
  text-align: center;
}
.resume-name {
  color: #111111;
  font-size: 22pt;
  font-weight: 400;
  line-height: 1.08;
  margin: 0 0 1.8mm;
}
.resume-contact {
  display: flex;
  justify-content: center;
  margin: 0;
  color: #111111;
  font-size: 8.8pt;
  line-height: 1.25;
}
.resume-address {
  margin: 0 0 0.65mm;
  color: #111111;
  font-size: 8.8pt;
  line-height: 1.22;
}
.resume-contact-items {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0 2mm;
}
.resume-contact-item {
  display: inline-flex;
  align-items: center;
  gap: 1mm;
  white-space: nowrap;
}
.resume-contact-item::before {
  display: inline-block;
  min-inline-size: 3mm;
  color: #111111;
  font-size: 0.95em;
  font-weight: 700;
  line-height: 1;
  text-align: center;
}
.resume-contact-phone::before {
  content: "\\260E";
}
.resume-contact-email::before {
  content: "\\2709";
}
.resume-contact-website::before {
  content: "\\25C9";
}
.resume-contact-linkedin::before {
  content: "in";
  font-size: 0.92em;
  font-weight: 800;
}
.resume-contact-github::before {
  content: "gh";
  font-size: 0.82em;
  font-weight: 800;
}
.resume-contact-separator {
  color: #111111;
  font-weight: 700;
}
.resume-contact a {
  color: #111111;
  text-decoration: none;
}
.resume-section {
  margin-block-start: 4.1mm;
}
.resume-section:first-of-type {
  margin-block-start: 0;
}
.resume-section-title {
  display: flex;
  align-items: center;
  gap: 2.5mm;
  color: #111111;
  font-size: 9.5pt;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.15;
  margin: 0 0 2.2mm;
  text-transform: uppercase;
}
.resume-section-title::after {
  flex: 1 1 auto;
  border-block-start: 0.45pt solid #111111;
  content: "";
}
.resume-summary {
  margin: 0;
  text-align: justify;
}
.resume-entry {
  margin-block-end: 3.2mm;
  break-inside: avoid;
}
.resume-entry.compact {
  margin-block-end: 2.2mm;
}
.resume-entry-heading {
  display: grid;
  gap: 0.2mm;
  margin: 0 0 0.9mm;
}
.resume-entry-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: baseline;
  column-gap: 5mm;
}
.resume-entry-main,
.resume-entry-company-row {
  min-inline-size: 0;
}
.resume-entry-company,
.resume-entry-location {
  color: #111111;
  font-weight: 700;
}
.resume-entry-title {
  color: #111111;
  font-style: italic;
  font-weight: 400;
}
.resume-entry-date {
  color: #111111;
  font-size: 8.9pt;
  font-style: italic;
  text-align: end;
  white-space: nowrap;
}
.resume-entry-location {
  text-align: end;
  white-space: nowrap;
}
.resume-entry-subtitle,
.resume-meta {
  color: #111111;
  font-size: 8.9pt;
  line-height: 1.22;
  margin: 0 0 1mm;
}
.resume-bullets {
  list-style: disc outside;
  margin: 1.1mm 0 0 4.2mm;
  padding: 0;
}
.resume-skills-list {
  list-style: none;
  margin: 1.1mm 0 0 0;
  padding: 0;
}
.resume-bullets li {
  display: list-item;
  list-style: disc outside;
  margin-block-end: 0.75mm;
  padding-inline-start: 0.8mm;
  text-align: justify;
  break-inside: avoid;
}
.resume-skills-list li {
  margin-block-end: 0.75mm;
  padding-inline-start: 0;
  text-align: justify;
  break-inside: avoid;
}
.resume-skills-list b {
  color: #111111;
}
p {
  margin: 0 0 1.2mm;
}
[data-resume-layout-target] {
  overflow-wrap: anywhere;
}
"""

FONT_STACKS = {
    "avenir": '"Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif',
    "aptos": '"Aptos", "Helvetica Neue", Helvetica, Arial, sans-serif',
    "calibri": '"Calibri", "Aptos", Arial, sans-serif',
    "cambria": '"Cambria", Georgia, "Times New Roman", serif',
    "charter": '"Charter", "Bitstream Charter", Georgia, serif',
    "garamond": '"EB Garamond", "Garamond", Georgia, serif',
    "georgia": 'Georgia, "Times New Roman", Times, serif',
    "helvetica": '"Helvetica Neue", Helvetica, Arial, sans-serif',
    "inter": '"Inter", "Aptos", Arial, sans-serif',
    "sans": '"Avenir Next", "Aptos", "Helvetica Neue", Helvetica, Arial, sans-serif',
    "serif": 'Georgia, "Times New Roman", Times, serif',
    "source_sans": '"Source Sans 3", "Source Sans Pro", "Aptos", Arial, sans-serif',
    "source_serif": '"Source Serif 4", "Source Serif Pro", Georgia, serif',
    "system": 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    "times": '"Times New Roman", Times, serif',
}

DENSITY_SCALE = {
    "compact": {"section": 2.2, "entry": 1.4, "list": 0.35, "line": 1.2, "meta_line": 1.12},
    "balanced": {"section": 4.1, "entry": 3.2, "list": 1.1, "line": 1.32, "meta_line": 1.22},
    "spacious": {"section": 7.2, "entry": 5.8, "list": 2.4, "line": 1.48, "meta_line": 1.34},
}

BULLET_SPACING = {
    "tight": 0.05,
    "normal": 0.8,
    "loose": 2.4,
}


def resume_theme_css(theme: dict[str, Any] | None) -> str:
    """Convert normalized template tokens into safe print CSS overrides."""

    if not isinstance(theme, dict):
        return ""
    font_family = FONT_STACKS.get(str(theme.get("fontFamily", "sans")), FONT_STACKS["sans"])
    density = DENSITY_SCALE.get(str(theme.get("density", "balanced")), DENSITY_SCALE["balanced"])
    bullet_spacing = BULLET_SPACING.get(str(theme.get("bulletSpacing", "normal")), BULLET_SPACING["normal"])
    font_scale = _bounded_float(theme.get("fontScale"), 0.85, 1.2, 1.0)
    margins = theme.get("marginMm") if isinstance(theme.get("marginMm"), dict) else {}
    margin_top = _bounded_float(margins.get("top"), 8, 28, 16.5)
    margin_right = _bounded_float(margins.get("right"), 8, 28, 17.5)
    margin_bottom = _bounded_float(margins.get("bottom"), 8, 28, 18)
    margin_left = _bounded_float(margins.get("left"), 8, 28, 17.5)
    alignment = "left" if theme.get("alignment") == "left" else "justify"
    header_align = {
        "left": "left",
        "split": "left",
        "centered": "center",
    }.get(str(theme.get("headerLayout", "centered")), "center")
    accent = str(theme.get("accentColor", "#111111"))
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        accent = "#111111"
    heading_style = str(theme.get("sectionHeadingStyle", "rule"))
    heading_after = "none" if heading_style in {"plain", "boxed"} else f"0.45pt solid {accent}"
    heading_border = f"0.45pt solid {accent}" if heading_style == "boxed" else "0"

    return f"""
body {{
  color: {accent};
  font-family: {font_family};
  font-size: {10.35 * font_scale:.3f}pt;
  line-height: {density["line"]:.3f};
}}
.resume-page {{
  padding: {margin_top:.2f}mm {margin_right:.2f}mm {margin_bottom:.2f}mm {margin_left:.2f}mm;
}}
.resume-header {{
  text-align: {header_align};
}}
.resume-summary,
.resume-bullets li,
.resume-skills-list li {{
  text-align: {alignment};
}}
.resume-section {{
  margin-block-start: {density["section"]:.2f}mm;
}}
.resume-entry {{
  margin-block-end: {density["entry"]:.2f}mm;
}}
.resume-entry-subtitle,
.resume-meta {{
  line-height: {density["meta_line"]:.3f};
}}
.resume-bullets,
.resume-skills-list {{
  margin-block-start: {density["list"]:.2f}mm;
}}
.resume-bullets li,
.resume-skills-list li {{
  margin-block-end: {bullet_spacing:.2f}mm;
}}
.resume-section-title {{
  color: {accent};
  border: {heading_border};
  padding: {"0.8mm 1.2mm" if heading_style == "boxed" else "0"};
}}
.resume-section-title::after {{
  border-block-start: {heading_after};
}}
"""


def _bounded_float(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if parsed < minimum:
        return minimum
    if parsed > maximum:
        return maximum
    return parsed


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


def contact_items_html(items: list[ContactItem]) -> str:
    segments: list[str] = []
    for index, item in enumerate(items):
        label = html.escape(item.get("label", ""))
        if not label:
            continue
        kind = re.sub(r"[^a-z0-9_-]+", "", item.get("kind", "contact").lower()) or "contact"
        href = item.get("href", "").strip()
        content = f'<a href="{html.escape(href, quote=True)}">{label}</a>' if href else label
        if index > 0:
            segments.append('<span class="resume-contact-separator" aria-hidden="true">•</span>')
        segments.append(f'<span class="resume-contact-item resume-contact-{kind}">{content}</span>')
    return f'<span class="resume-contact-items">{"".join(segments)}</span>' if segments else ""


def build_resume_html_document(body: str, resume_theme: dict[str, Any] | None = None) -> str:
    """Wrap trusted resume body markup in the print stylesheet."""

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>{RESUME_HTML_STYLE}{resume_theme_css(resume_theme)}</style>
</head>
<body>
{body}
</body>
</html>"""


def build_resume_document(tailored_payload: dict, profile: dict) -> ResumeDocument:
    """Build the semantic resume document consumed by the HTML renderer."""

    personal = profile.get("personal", {})
    tailoring_policy = get_tailoring_policy(profile)
    resume = get_resume_master(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_education_ids = get_required_education_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    all_experience_entries = get_experience_entries(profile)
    all_education_entries = get_education_entries(profile)
    all_skill_categories = get_skill_categories(profile)

    experience_entries = [
        entry
        for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
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

    experience_updates = {
        entry.get("id"): entry
        for entry in tailored_payload.get("experience_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }
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
                "bullets": [
                    {
                        "id": f"experience:{entry_id}:bullet:{index + 1}",
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


def build_resume_html(
    document: ResumeDocument,
    resume_theme: dict[str, Any] | None = None,
) -> str:
    """Render a trusted resume document to print-oriented HTML."""

    line_number = 0

    def target(
        semantic_id: str,
        text: str,
        *,
        tag: str = "div",
        class_name: str = "resume-line",
        inner_html: str | None = None,
    ) -> str:
        nonlocal line_number
        if not text.strip():
            return ""
        line_number += 1
        escaped = html.escape(text)
        escaped_id = html.escape(semantic_id, quote=True)
        content = inner_html if inner_html is not None else escaped
        return (
            f'<{tag} class="{class_name}" data-resume-layout-target="{escaped_id}" '
            f'data-resume-line-number="{line_number}">{content}</{tag}>'
        )

    def section_title(section_id: str, label: str) -> str:
        return target(f"section:{section_id}", label, tag="h2", class_name="resume-section-title")

    personal = document.get("personal", {})
    body: list[str] = [
        '<main class="resume-page" data-resume-page="1">',
        '<header class="resume-header">',
        target("personal:full_name", str(personal.get("full_name", "")), tag="h1", class_name="resume-name"),
    ]
    address = str(personal.get("address", "")).strip()
    if address:
        body.append(target("personal:address", address, tag="p", class_name="resume-address"))
    contact_items = [
        item
        for item in personal.get("contact_items", [])
        if isinstance(item, dict) and str(item.get("label", "")).strip()
    ]
    if not contact_items:
        contact_items = [
            {"kind": "contact", "label": str(part).strip(), "href": ""}
            for part in personal.get("contact", [])
            if str(part).strip()
        ]
    contact = contact_items_text(contact_items)
    if contact:
        body.append(target("personal:contact", contact, tag="p", class_name="resume-contact", inner_html=contact_items_html(contact_items)))
    body.extend(["</header>", '<section class="resume-section">', section_title("executive_profile", "Executive Profile")])
    body.append(target("summary", str(document.get("summary", "")), tag="p", class_name="resume-summary"))
    body.append("</section>")

    body.extend(['<section class="resume-section">', section_title("experience", "Experience")])
    for entry in document.get("experience", []):
        entry_id = str(entry.get("id", "experience"))
        title = html.escape(str(entry.get("title", "")))
        company = html.escape(str(entry.get("company", "")))
        date_range = normalize_resume_date_range(str(entry.get("date_range", "")))
        date_range_html = html.escape(date_range)
        location = str(entry.get("location", "")).strip()
        location_html = html.escape(location)
        heading_html = (
            '<span class="resume-entry-row resume-entry-company-row">'
            f'<span class="resume-entry-company">{company}</span>'
            + (f'<span class="resume-entry-location">{location_html}</span>' if location_html else "")
            + "</span>"
            + '<span class="resume-entry-row resume-entry-role-row">'
            f'<span class="resume-entry-title">{title}</span>'
            + (f'<span class="resume-entry-date">{date_range_html}</span>' if date_range else "")
            + "</span>"
        )
        body.append('<article class="resume-entry">')
        body.append(
            target(
                f"experience:{entry_id}:heading",
                " | ".join(part for part in [entry.get("company", ""), location, entry.get("title", ""), date_range] if part),
                class_name="resume-entry-heading",
                inner_html=heading_html,
            )
        )
        body.append('<ul class="resume-bullets">')
        for bullet in entry.get("bullets", []):
            body.append(target(str(bullet.get("id", "")), str(bullet.get("text", "")), tag="li"))
        body.append("</ul>")
        body.append("</article>")
    body.append("</section>")

    body.extend(['<section class="resume-section">', section_title("education", "Education")])
    for entry in document.get("education", []):
        entry_id = str(entry.get("id", "education"))
        degree = html.escape(str(entry.get("degree", "")))
        date = html.escape(str(entry.get("date", "")))
        institution = str(entry.get("institution", "")).strip()
        location = str(entry.get("location", "")).strip()
        subtitle = " | ".join(part for part in [institution, location] if part)
        heading_html = (
            f'<span class="resume-entry-main"><span class="resume-entry-title">{degree}</span></span>'
            + (f'<span class="resume-entry-date">{date}</span>' if date else "")
        )
        body.append('<article class="resume-entry compact">')
        body.append(
            target(
                f"education:{entry_id}:degree",
                " | ".join(part for part in [entry.get("degree", ""), entry.get("date", "")] if part),
                class_name="resume-entry-heading",
                inner_html=heading_html,
            )
        )
        body.append(target(f"education:{entry_id}:subtitle", subtitle, class_name="resume-meta"))
        body.append(target(f"education:{entry_id}:details", str(entry.get("details", "")), class_name="resume-meta"))
        body.append("</article>")
    body.append("</section>")

    body.extend(['<section class="resume-section">', section_title("skills", "Skills"), '<ul class="resume-skills-list">'])
    for category in document.get("skills", []):
        category_id = str(category.get("id", "skills"))
        items = ", ".join(str(item) for item in category.get("items", []) if str(item).strip())
        label = str(category.get("label", "Skills")).strip() or "Skills"
        skill_html = f"<b>{html.escape(label)}:</b> {html.escape(items)}"
        body.append(target(f"skills:{category_id}", f"{label}: {items}", tag="li", inner_html=skill_html))
    body.extend(["</ul>", "</section>", "</main>"])

    return build_resume_html_document("".join(body), resume_theme=resume_theme)


def _render_resume_pdf_playwright(html_content: str, output_path: str) -> list[LayoutBox]:
    """Render resume HTML to PDF and return layout boxes from the printed DOM."""

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport=RESUME_PAGE_VIEWPORT)
        try:
            page.set_content(html_content, wait_until="load")
            page.emulate_media(media="print")
            layout_boxes = page.evaluate(
                """() => Array.from(document.querySelectorAll('[data-resume-layout-target]')).map((node) => {
  const pageNode = node.closest('[data-resume-page]');
  const pageRect = pageNode.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const pageWidth = pageRect.width || 794;
  const pageHeight = pageRect.height || 1123;
  const relativeTop = rect.top - pageRect.top;
  const pageNumber = Math.max(1, Math.floor(relativeTop / pageHeight) + 1);
  const topOnPage = relativeTop - ((pageNumber - 1) * pageHeight);
  const visibleHeight = Math.max(0, Math.min(rect.height, pageHeight - topOnPage));
  const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
  const lineNumber = Number.parseInt(node.getAttribute('data-resume-line-number') || '', 10);
  return {
    semantic_id: node.getAttribute('data-resume-layout-target') || '',
    page_number: pageNumber,
    line_number: Number.isFinite(lineNumber) ? lineNumber : null,
    text_excerpt: text,
    left_pct: ((rect.left - pageRect.left) / pageWidth) * 100,
    top_pct: (Math.max(0, topOnPage) / pageHeight) * 100,
    width_pct: (rect.width / pageWidth) * 100,
    height_pct: (visibleHeight / pageHeight) * 100,
  };
})"""
            )
            page.pdf(
                path=output_path,
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                prefer_css_page_size=True,
                print_background=True,
            )
            return list(layout_boxes)
        finally:
            browser.close()


def render_resume_html_to_pdf(html_content: str, output_path: str) -> list[LayoutBox]:
    """Render pre-built resume HTML to a paginated PDF via the shared Playwright path.

    The TypeScript resume-review render and template-refresh flows build the resume
    HTML themselves and need it rendered to a full multi-page PDF, not the truncated
    single-page fallback they previously hand-rolled.
    """

    return _render_resume_pdf_playwright(html_content, output_path)


class HtmlResumePdfAdapter:
    """Concrete ``PdfRendererPort`` that renders tailored resumes via HTML/CSS."""

    def render_resume_to_pdf(
        self,
        *,
        tailored_payload: dict,
        profile_dict: dict,
        output_path: str,
        created_at: str,
        resume_theme: dict | None = None,
        resume_template: dict | None = None,
    ) -> Artifact:
        document = build_resume_document(tailored_payload, profile_dict)
        html_content = build_resume_html(document, resume_theme=resume_theme)
        html_path = Path(output_path).with_suffix(".html")
        html_path.write_text(html_content, encoding="utf-8")

        layout_boxes = _render_resume_pdf_playwright(html_content, output_path)
        log.info("HTML resume PDF generated: %s", output_path)

        size = None
        try:
            size = os.path.getsize(output_path)
        except OSError:
            pass

        return Artifact(
            artifact_id=uuid.uuid4().hex,
            type=ArtifactType.RESUME_PDF,
            status=ArtifactStatus.CANDIDATE,
            path=str(output_path),
            render_format=RenderFormat.HTML_PDF,
            created_at=created_at,
            size_bytes=size,
            metadata={
                "html_path": str(html_path),
                "layout_boxes": layout_boxes,
                "layout_source": "html_resume_dom",
                **({"resume_template": resume_template} if resume_template else {}),
            },
            superseded_at=None,
        )

    def render_cover_letter_to_pdf(
        self,
        *,
        cover_letter_text: str,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        raise NotImplementedError(
            "HtmlResumePdfAdapter does not render cover letters; use PlaywrightHtmlPdfAdapter."
        )


__all__ = [
    "RESUME_HTML_STYLE",
    "RESUME_PAGE_VIEWPORT",
    "HtmlResumePdfAdapter",
    "resume_theme_css",
    "build_resume_html_document",
    "build_resume_document",
    "build_resume_html",
    "normalize_resume_date_range",
    "render_resume_html_to_pdf",
]
