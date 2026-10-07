"""HtmlResumePdfAdapter — structured resume HTML/CSS + Playwright PDF renderer.

This adapter implements the default resume half of ``PdfRendererPort`` without
LaTeX. It produces ``resume_pdf`` artifacts with ``RenderFormat.HTML_PDF`` and
records DOM-derived layout boxes for Apply Review line highlighting.
"""

from __future__ import annotations

import base64
import html
import logging
import os
import re
import uuid
from functools import lru_cache
from importlib.resources import files
from pathlib import Path
from typing import Any

from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.ports.artifact_review import ArtifactStatus
from jobctrl.domain.materials.value_objects import ArtifactType, RenderFormat
from jobctrl.domain.materials.resume_document import (
    ResumeDocument,
    ContactItem,
    build_resume_document,
    contact_items_text,
    normalize_resume_date_range,
)

log = logging.getLogger(__name__)

LayoutBox = dict[str, Any]
RESUME_PAGE_VIEWPORT = {"width": 794, "height": 1123}
RESUME_SECTIONS = ("summary", "experience", "education", "skills")
GEIST_FONT_RESOURCES = (
    (
        "geist-latin-ext-wght-normal.woff2",
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,"
        "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    ),
    (
        "geist-latin-wght-normal.woff2",
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
        "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    ),
)


@lru_cache(maxsize=1)
def geist_font_face_css() -> str:
    """Return self-contained Geist faces for offline HTML and PDF rendering."""

    font_root = files("jobctrl").joinpath("assets", "fonts")
    faces: list[str] = []
    for filename, unicode_range in GEIST_FONT_RESOURCES:
        encoded = base64.b64encode(font_root.joinpath(filename).read_bytes()).decode("ascii")
        faces.append(
            "@font-face {\n"
            '  font-family: "Geist Variable";\n'
            "  font-style: normal;\n"
            "  font-display: block;\n"
            "  font-weight: 100 900;\n"
            f"  src: url(data:font/woff2;base64,{encoded}) format('woff2-variations');\n"
            f"  unicode-range: {unicode_range};\n"
            "}\n"
        )
    return "".join(faces)


def resume_font_assets_css(theme: dict[str, Any] | None) -> str:
    """Embed the bundled default font only when the selected theme uses it."""

    font_family = str(theme.get("fontFamily", "sans")) if isinstance(theme, dict) else "sans"
    return geist_font_face_css() if font_family == "sans" else ""


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
  font-family: "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
.resume-entry.resume-entry--no-bullets {
  margin-block-end: 1.6mm;
}
.resume-entry--no-bullets .resume-entry-heading:last-child,
.resume-entry--no-bullets .resume-entry-summary:last-child {
  margin-block-end: 0;
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
.resume-entry-institution,
.resume-entry-location {
  color: #111111;
  font-weight: 700;
}
.resume-entry-title {
  color: #111111;
  font-style: italic;
  font-weight: 400;
}
.resume-education-degree {
  margin: 0 0 1mm;
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
.resume-entry-summary {
  color: #111111;
  line-height: 1.22;
  margin: 0 0 1.1mm;
  text-align: justify;
  break-inside: avoid;
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
    "sans": '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
    header_justify = "center" if header_align == "center" else "flex-start"
    page_size = "Letter" if theme.get("pageSize") == "letter" else "A4"
    page_width = "8.5in" if page_size == "Letter" else "210mm"
    page_height = "11in" if page_size == "Letter" else "297mm"
    accent = str(theme.get("accentColor", "#111111"))
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        accent = "#111111"
    heading_style = str(theme.get("sectionHeadingStyle", "rule"))
    heading_after = "none" if heading_style in {"plain", "boxed"} else f"0.45pt solid {accent}"
    heading_border = f"0.45pt solid {accent}" if heading_style == "boxed" else "0"

    return f"""
@page {{
  size: {page_size};
}}
body {{
  color: {accent};
  font-family: {font_family};
  font-size: {10.35 * font_scale:.3f}pt;
  line-height: {density["line"]:.3f};
}}
.resume-page {{
  width: {page_width};
  min-height: {page_height};
  padding: {margin_top:.2f}mm {margin_right:.2f}mm {margin_bottom:.2f}mm {margin_left:.2f}mm;
}}
.resume-header {{
  text-align: {header_align};
}}
.resume-contact,
.resume-contact-items {{
  justify-content: {header_justify};
}}
.resume-name,
.resume-contact,
.resume-address,
.resume-contact-item::before,
.resume-contact-separator,
.resume-contact a,
.resume-section-title,
.resume-entry-company,
.resume-entry-institution,
.resume-entry-title,
.resume-entry-date,
.resume-entry-location,
.resume-entry-subtitle,
.resume-entry-summary,
.resume-meta {{
  color: {accent};
}}
.resume-summary,
.resume-entry-summary,
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
.resume-entry-summary,
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
<style>{resume_font_assets_css(resume_theme)}{RESUME_HTML_STYLE}{resume_theme_css(resume_theme)}</style>
</head>
<body>
{body}
</body>
</html>"""


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

    def resolved_section_order() -> list[str]:
        if not isinstance(resume_theme, dict):
            return list(RESUME_SECTIONS)
        raw_order = resume_theme.get("sectionOrder")
        requested = raw_order if isinstance(raw_order, list) else list(RESUME_SECTIONS)
        hidden_raw = resume_theme.get("hiddenSections")
        hidden = set(hidden_raw) if isinstance(hidden_raw, list) else set()
        order: list[str] = []
        for section in requested:
            if section in RESUME_SECTIONS and section not in hidden and section not in order:
                order.append(section)
        return order or [section for section in RESUME_SECTIONS if section not in hidden]

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
        body.append(
            target(
                "personal:contact",
                contact,
                tag="p",
                class_name="resume-contact",
                inner_html=contact_items_html(contact_items),
            )
        )
    body.append("</header>")

    def render_summary() -> list[str]:
        return [
            '<section class="resume-section">',
            section_title("executive_profile", "Executive Profile"),
            target("executive_profile#0", str(document.get("summary", "")), tag="p", class_name="resume-summary"),
            "</section>",
        ]

    def render_experience() -> list[str]:
        section = ['<section class="resume-section">', section_title("experience", "Experience")]
        for entry in document.get("experience", []):
            entry_id = str(entry.get("id", "experience"))
            html.escape(str(entry.get("title", "")))
            html.escape(str(entry.get("company", "")))
            date_range = normalize_resume_date_range(str(entry.get("date_range", "")))
            html.escape(date_range)
            location = str(entry.get("location", "")).strip()
            html.escape(location)
            company_html = target(
                f"experience:{entry_id}:company",
                str(entry.get("company", "")),
                tag="span",
                class_name="resume-entry-company",
            )
            location_field = target(
                f"experience:{entry_id}:location", location, tag="span", class_name="resume-entry-location"
            )
            title_html = target(
                f"experience:{entry_id}:title", str(entry.get("title", "")), tag="span", class_name="resume-entry-title"
            )
            date_html = target(
                f"experience:{entry_id}:date_range", date_range, tag="span", class_name="resume-entry-date"
            )
            heading_html = (
                f'<span class="resume-entry-row resume-entry-company-row">{company_html}{location_field}</span>'
                f'<span class="resume-entry-row resume-entry-role-row">{title_html}{date_html}</span>'
            )
            bullets = list(entry.get("bullets", []))
            entry_class = "resume-entry" if bullets else "resume-entry resume-entry--no-bullets"
            section.append(f'<article class="{entry_class}">')
            section.append(
                f'<div class="resume-entry-heading" data-resume-layout-target="experience:{html.escape(entry_id, quote=True)}:heading">{heading_html}</div>'
            )
            summary = str(entry.get("summary", "")).strip()
            if summary:
                section.append(
                    target(
                        f"experience:{entry_id}:summary",
                        summary,
                        tag="p",
                        class_name="resume-entry-summary",
                    )
                )
            if bullets:
                section.append('<ul class="resume-bullets">')
                for bullet in bullets:
                    section.append(target(str(bullet.get("id", "")), str(bullet.get("text", "")), tag="li"))
                section.append("</ul>")
            section.append("</article>")
        section.append("</section>")
        return section

    def render_education() -> list[str]:
        section = ['<section class="resume-section">', section_title("education", "Education")]
        for entry in document.get("education", []):
            entry_id = str(entry.get("id", "education"))
            degree = html.escape(str(entry.get("degree", "")))
            html.escape(str(entry.get("date", "")))
            institution = str(entry.get("institution", "")).strip()
            location = str(entry.get("location", "")).strip()
            " | ".join(part for part in [institution, location] if part)
            institution_html = target(
                f"education:{entry_id}:institution", institution, tag="span", class_name="resume-entry-institution"
            )
            location_html = target(
                f"education:{entry_id}:location", location, tag="span", class_name="resume-entry-location"
            )
            date_html = target(
                f"education:{entry_id}:date", str(entry.get("date", "")), tag="span", class_name="resume-entry-date"
            )
            heading_html = f'<span class="resume-entry-row resume-entry-education-row"><span class="resume-entry-main">{institution_html}{(" | " + location_html) if location_html else ""}</span>{date_html}</span>'
            section.append('<article class="resume-entry compact">')
            section.append(
                f'<div class="resume-entry-heading" data-resume-layout-target="education:{html.escape(entry_id, quote=True)}:subtitle">{heading_html}</div>'
            )
            section.append(
                target(
                    f"education:{entry_id}:degree",
                    str(entry.get("degree", "")),
                    tag="p",
                    class_name="resume-entry-title resume-education-degree",
                    inner_html=degree,
                )
            )
            section.append(
                target(f"education:{entry_id}:details", str(entry.get("details", "")), class_name="resume-meta")
            )
            section.append("</article>")
        section.append("</section>")
        return section

    def render_skills() -> list[str]:
        section = [
            '<section class="resume-section">',
            section_title("skills", "Skills"),
            '<ul class="resume-skills-list">',
        ]
        for category in document.get("skills", []):
            category_id = str(category.get("id", "skills"))
            items = ", ".join(str(item) for item in category.get("items", []) if str(item).strip())
            label = str(category.get("label", "Skills")).strip() or "Skills"
            skill_html = f"<b>{html.escape(label)}:</b> {html.escape(items)}"
            section.append(target(f"skills:{category_id}#0", f"{label}: {items}", tag="li", inner_html=skill_html))
        section.extend(["</ul>", "</section>"])
        return section

    section_renderers = {
        "summary": render_summary,
        "experience": render_experience,
        "education": render_education,
        "skills": render_skills,
    }
    for section_name in resolved_section_order():
        body.extend(section_renderers[section_name]())
    body.append("</main>")

    return build_resume_html_document("".join(body), resume_theme=resume_theme)


def _render_resume_pdf_playwright(html_content: str, output_path: str) -> list[LayoutBox]:
    """Render resume HTML to PDF and return layout boxes from the printed DOM."""

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport=RESUME_PAGE_VIEWPORT)
        try:
            page.set_content(html_content, wait_until="load")
            page.evaluate("() => document.fonts.ready")
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
        raise NotImplementedError("HtmlResumePdfAdapter does not render cover letters; use PlaywrightHtmlPdfAdapter.")


__all__ = [
    "RESUME_HTML_STYLE",
    "RESUME_PAGE_VIEWPORT",
    "HtmlResumePdfAdapter",
    "geist_font_face_css",
    "resume_font_assets_css",
    "resume_theme_css",
    "build_resume_html_document",
    "build_resume_document",
    "build_resume_html",
    "normalize_resume_date_range",
    "render_resume_html_to_pdf",
]
