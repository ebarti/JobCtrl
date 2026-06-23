"""HtmlResumePdfAdapter — structured resume HTML/CSS + Playwright PDF renderer.

This adapter implements the default resume half of ``PdfRendererPort`` without
LaTeX. It produces ``resume_pdf`` artifacts with ``RenderFormat.HTML_PDF`` and
records DOM-derived layout boxes for Apply Review line highlighting.
"""

from __future__ import annotations

import html
import logging
import os
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
RESUME_PAGE_VIEWPORT = {"width": 794, "height": 1123}

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
  color: #111111;
  font-size: 8.8pt;
  line-height: 1.25;
  margin: 0;
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
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: baseline;
  gap: 5mm;
  margin: 0 0 0.6mm;
}
.resume-entry-main {
  min-inline-size: 0;
  font-weight: 700;
}
.resume-entry-title {
  color: #111111;
}
.resume-entry-company {
  color: #111111;
}
.resume-entry-date {
  color: #111111;
  font-size: 8.9pt;
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


def build_resume_html_document(body: str) -> str:
    """Wrap trusted resume body markup in the print stylesheet."""

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>{RESUME_HTML_STYLE}</style>
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

    contact_parts = [
        str(personal.get(key, "")).strip()
        for key in ("email", "phone", "website_url", "linkedin_url")
        if str(personal.get(key, "")).strip()
    ]
    summary_source = (
        tailored_payload.get("executive_profile", "")
        if tailoring_policy["allow_summary_rewrite"]
        else resume.get("executive_profile", {}).get("baseline_text", "")
    )

    experiences: list[dict[str, Any]] = []
    for entry in experience_entries:
        entry_id = str(entry.get("id", "")).strip() or f"experience-{len(experiences) + 1}"
        update = experience_updates.get(entry.get("id"), {})
        subtitle_parts = [entry.get("location", ""), entry.get("date_range", "")]
        experiences.append(
            {
                "id": entry_id,
                "title": sanitize_text(tailored_experience_title(entry, update, profile)),
                "company": sanitize_text(str(entry.get("company", ""))),
                "location": sanitize_text(str(entry.get("location", ""))),
                "date_range": sanitize_text(str(entry.get("date_range", ""))),
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
            "contact": [sanitize_text(part) for part in contact_parts],
        },
        "summary": sanitize_text(str(summary_source)),
        "experience": experiences,
        "education": education,
        "skills": skills,
    }


def build_resume_html(document: ResumeDocument) -> str:
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
    contact = " | ".join(str(part) for part in personal.get("contact", []) if str(part).strip())
    if contact:
        body.append(target("personal:contact", contact, class_name="resume-contact"))
    body.extend(["</header>", '<section class="resume-section">', section_title("executive_profile", "Executive Profile")])
    body.append(target("summary", str(document.get("summary", "")), tag="p", class_name="resume-summary"))
    body.append("</section>")

    body.extend(['<section class="resume-section">', section_title("experience", "Experience")])
    for entry in document.get("experience", []):
        entry_id = str(entry.get("id", "experience"))
        heading = " | ".join(part for part in [entry.get("title", ""), entry.get("company", "")] if part)
        title = html.escape(str(entry.get("title", "")))
        company = html.escape(str(entry.get("company", "")))
        date_range = html.escape(str(entry.get("date_range", "")))
        location = str(entry.get("location", "")).strip()
        heading_html = (
            '<span class="resume-entry-main">'
            f'<span class="resume-entry-title">{title}</span>'
            + (f' <span class="resume-entry-company">| {company}</span>' if company else "")
            + "</span>"
            + (f'<span class="resume-entry-date">{date_range}</span>' if date_range else "")
        )
        body.append('<article class="resume-entry">')
        body.append(
            target(
                f"experience:{entry_id}:heading",
                " | ".join(part for part in [heading, entry.get("date_range", "")] if part),
                class_name="resume-entry-heading",
                inner_html=heading_html,
            )
        )
        body.append(target(f"experience:{entry_id}:location", location, tag="p", class_name="resume-entry-subtitle"))
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

    return build_resume_html_document("".join(body))


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


class HtmlResumePdfAdapter:
    """Concrete ``PdfRendererPort`` that renders tailored resumes via HTML/CSS."""

    def render_resume_to_pdf(
        self,
        *,
        tailored_payload: dict,
        profile_dict: dict,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        document = build_resume_document(tailored_payload, profile_dict)
        html_content = build_resume_html(document)
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
    "build_resume_html_document",
    "build_resume_document",
    "build_resume_html",
]
