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
    ) -> str:
        nonlocal line_number
        if not text.strip():
            return ""
        line_number += 1
        escaped = html.escape(text)
        escaped_id = html.escape(semantic_id, quote=True)
        return (
            f'<{tag} class="{class_name}" data-resume-layout-target="{escaped_id}" '
            f'data-resume-line-number="{line_number}">{escaped}</{tag}>'
        )

    personal = document.get("personal", {})
    body: list[str] = [
        '<main class="resume-page" data-resume-page="1">',
        '<header class="resume-header">',
        target("personal:full_name", str(personal.get("full_name", "")), tag="h1", class_name="resume-name"),
    ]
    contact = " | ".join(str(part) for part in personal.get("contact", []) if str(part).strip())
    if contact:
        body.append(target("personal:contact", contact, class_name="resume-contact"))
    body.extend(["</header>", '<section class="resume-section">', "<h2>Executive Profile</h2>"])
    body.append(target("summary", str(document.get("summary", "")), tag="p", class_name="resume-summary"))
    body.append("</section>")

    body.extend(['<section class="resume-section">', "<h2>Experience</h2>"])
    for entry in document.get("experience", []):
        entry_id = str(entry.get("id", "experience"))
        heading = " | ".join(part for part in [entry.get("title", ""), entry.get("company", "")] if part)
        body.append('<article class="resume-entry">')
        body.append(target(f"experience:{entry_id}:heading", heading, tag="h3", class_name="resume-entry-title"))
        body.append(target(f"experience:{entry_id}:subtitle", str(entry.get("subtitle", "")), class_name="resume-meta"))
        body.append("<ul>")
        for bullet in entry.get("bullets", []):
            body.append(target(str(bullet.get("id", "")), str(bullet.get("text", "")), tag="li"))
        body.append("</ul>")
        body.append("</article>")
    body.append("</section>")

    body.extend(['<section class="resume-section">', "<h2>Education</h2>"])
    for entry in document.get("education", []):
        entry_id = str(entry.get("id", "education"))
        body.append('<article class="resume-entry compact">')
        body.append(target(f"education:{entry_id}:degree", str(entry.get("degree", "")), tag="h3"))
        body.append(target(f"education:{entry_id}:subtitle", str(entry.get("subtitle", "")), class_name="resume-meta"))
        body.append(target(f"education:{entry_id}:details", str(entry.get("details", "")), class_name="resume-meta"))
        body.append("</article>")
    body.append("</section>")

    body.extend(['<section class="resume-section">', "<h2>Skills</h2>"])
    for category in document.get("skills", []):
        category_id = str(category.get("id", "skills"))
        items = ", ".join(str(item) for item in category.get("items", []) if str(item).strip())
        label = str(category.get("label", "Skills")).strip() or "Skills"
        body.append(target(f"skills:{category_id}", f"{label}: {items}", tag="p"))
    body.extend(["</section>", "</main>"])

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page {{
  size: letter;
  margin: 0;
}}
* {{
  box-sizing: border-box;
}}
html,
body {{
  margin: 0;
  padding: 0;
}}
body {{
  background: #ffffff;
  color: #202124;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10.5pt;
  line-height: 1.34;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}
.resume-page {{
  inline-size: 8.5in;
  min-block-size: 11in;
  padding: 0.58in 0.65in;
}}
.resume-header {{
  border-block-end: 1px solid #2f5597;
  margin-block-end: 0.16in;
  padding-block-end: 0.09in;
}}
.resume-name {{
  color: #1f3f73;
  font-size: 20pt;
  line-height: 1.05;
  margin: 0;
}}
.resume-contact,
.resume-meta {{
  color: #4f5661;
  font-size: 9pt;
}}
.resume-section {{
  margin-block-start: 0.13in;
  break-inside: avoid;
}}
.resume-section h2 {{
  color: #1f3f73;
  font-size: 10pt;
  letter-spacing: 0;
  margin: 0 0 0.055in;
  text-transform: uppercase;
}}
.resume-entry {{
  margin-block-end: 0.09in;
  break-inside: avoid;
}}
.resume-entry.compact {{
  margin-block-end: 0.05in;
}}
.resume-entry-title,
.resume-entry h3 {{
  font-size: 10.5pt;
  margin: 0;
}}
.resume-summary {{
  margin: 0;
}}
ul {{
  margin: 0.04in 0 0.02in 0.18in;
  padding: 0;
}}
li {{
  margin-block-end: 0.028in;
  break-inside: avoid;
}}
p {{
  margin: 0 0 0.045in;
}}
.resume-line,
.resume-name {{
  overflow-wrap: break-word;
}}
</style>
</head>
<body>
{''.join(body)}
</body>
</html>"""


def _render_resume_pdf_playwright(html_content: str, output_path: str) -> list[LayoutBox]:
    """Render resume HTML to PDF and return layout boxes from the printed DOM."""

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 816, "height": 1056})
        try:
            page.set_content(html_content, wait_until="load")
            page.emulate_media(media="print")
            layout_boxes = page.evaluate(
                """() => Array.from(document.querySelectorAll('[data-resume-layout-target]')).map((node) => {
  const pageNode = node.closest('[data-resume-page]');
  const pageRect = pageNode.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const pageWidth = pageRect.width || 816;
  const pageHeight = pageRect.height || 1056;
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
    "HtmlResumePdfAdapter",
    "build_resume_document",
    "build_resume_html",
]
