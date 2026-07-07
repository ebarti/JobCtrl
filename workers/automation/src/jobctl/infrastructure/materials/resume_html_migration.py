"""Migrate legacy resume PDFs to HTML/CSS-rendered resume artifacts."""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from jobctl.infrastructure.materials.html_resume_pdf import (
    RESUME_PAGE_VIEWPORT,
    build_resume_html_document,
    contact_items_from_text,
    contact_items_html,
    contact_items_text,
    normalize_resume_date_range,
)

LayoutBox = dict[str, object]
RenderHtmlToPdf = Callable[[str, str], list[LayoutBox]]
SECTION_ALIASES = {
    "career history": "experience",
    "core skills": "skills",
    "education": "education",
    "executive profile": "executive_profile",
    "experience": "experience",
    "languages": "skills",
    "professional profile": "executive_profile",
    "profile": "executive_profile",
    "projects": "experience",
    "skills": "skills",
    "summary": "executive_profile",
    "technical skills": "skills",
}


@dataclass(frozen=True)
class ResumeHtmlMigrationResult:
    artifact_id: str
    job_url: str
    path: str
    status: str
    reason: str


def build_legacy_resume_html(resume_text: str) -> str:
    """Build print-oriented HTML from an accepted legacy resume text artifact.

    The legacy ``.txt`` file is the canonical tailored resume text used by the
    old PDF renderer. Preserve its resume structure (header, section headings,
    entry chunks, subtitles, bullets, and skills) and render it through the same
    A4 HTML/CSS source that now prints the final PDF.
    """

    line_number = 0
    current_section: str | None = None
    current_label: str | None = None
    section_buffer: list[str] = []
    body: list[str] = [
        '<main class="resume-page" data-resume-page="1">',
        '<header class="resume-header">',
    ]

    def line(
        semantic_id: str,
        text: str,
        *,
        tag: str = "div",
        class_name: str = "resume-line",
        inner_html: str | None = None,
    ) -> None:
        nonlocal line_number
        clean = text.strip()
        if not clean:
            return
        line_number += 1
        content = inner_html if inner_html is not None else html.escape(clean)
        body.append(
            f'<{tag} class="{class_name}" data-resume-layout-target="{html.escape(semantic_id, quote=True)}" '
            f'data-resume-line-number="{line_number}">{content}</{tag}>'
        )

    def section_key(text: str) -> str | None:
        normalized = re.sub(r"\s+", " ", text.strip().lower())
        if normalized in SECTION_ALIASES:
            return SECTION_ALIASES[normalized]
        is_heading = text.strip().upper() == text.strip() and any(character.isalpha() for character in text)
        return re.sub(r"[^a-z0-9]+", "_", normalized).strip("_") if is_heading and len(text.strip()) <= 48 else None

    def section_id(label: str) -> str:
        return re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_") or "section"

    def strip_bullet(text: str) -> str:
        return re.sub(r"^[-•○]\s+", "", text.strip()).strip()

    def split_parts(text: str) -> list[str]:
        return [part.strip() for part in re.split(r"\s+\|\s+|\s+--\s+", text.strip()) if part.strip()]

    def split_subtitle_parts(text: str) -> list[str]:
        return [part.strip() for part in re.split(r"\s+\|\s+", text.strip()) if part.strip()]

    def render_section_title(label: str) -> None:
        body.append('<section class="resume-section">')
        line(f"section:{section_id(label)}", label.title(), tag="h2", class_name="resume-section-title")

    def render_entry_chunk(section: str, chunk: list[str], chunk_index: int) -> None:
        non_bullets = [item for item in chunk if not item.startswith(("- ", "• ", "○ "))]
        bullets = [strip_bullet(item) for item in chunk if item.startswith(("- ", "• ", "○ "))]
        if not non_bullets and not bullets:
            return
        body.append('<article class="resume-entry">')
        heading = non_bullets[0] if non_bullets else ""
        subtitle = non_bullets[1] if len(non_bullets) > 1 else ""
        extra_lines = non_bullets[2:] if len(non_bullets) > 2 else []
        heading_parts = split_parts(heading)
        title = heading_parts[0] if heading_parts else heading
        company = " | ".join(heading_parts[1:])
        subtitle_parts = split_subtitle_parts(subtitle)
        location = subtitle_parts[0] if subtitle_parts else subtitle
        date_range = normalize_resume_date_range(" | ".join(subtitle_parts[1:]))
        heading_html = (
            '<span class="resume-entry-row resume-entry-company-row">'
            f'<span class="resume-entry-company">{html.escape(company)}</span>'
            + (f'<span class="resume-entry-location">{html.escape(location)}</span>' if location else "")
            + "</span>"
            + '<span class="resume-entry-row resume-entry-role-row">'
            f'<span class="resume-entry-title">{html.escape(title)}</span>'
            + (f'<span class="resume-entry-date">{html.escape(date_range)}</span>' if date_range else "")
            + "</span>"
        )
        line(
            f"{section}:entry:{chunk_index}:heading",
            " | ".join(part for part in [company, location, title, date_range] if part),
            class_name="resume-entry-heading",
            inner_html=heading_html,
        )
        for extra_index, extra in enumerate(extra_lines, start=1):
            line(f"{section}:entry:{chunk_index}:detail:{extra_index}", extra, tag="p", class_name="resume-meta")
        if bullets:
            body.append('<ul class="resume-bullets">')
            for bullet_index, bullet in enumerate(bullets, start=1):
                line(f"{section}:entry:{chunk_index}:bullet:{bullet_index}", bullet, tag="li")
            body.append("</ul>")
        body.append("</article>")

    def flush_section() -> None:
        nonlocal section_buffer
        if not current_section or not current_label:
            section_buffer = []
            return
        chunks: list[list[str]] = []
        chunk: list[str] = []
        for item in section_buffer:
            if item:
                chunk.append(item)
            elif chunk:
                chunks.append(chunk)
                chunk = []
        if chunk:
            chunks.append(chunk)

        render_section_title(current_label)
        if current_section in {"experience", "education"}:
            for index, section_chunk in enumerate(chunks, start=1):
                render_entry_chunk(current_section, section_chunk, index)
        elif current_section == "skills":
            body.append('<ul class="resume-skills-list">')
            skill_lines = [item for item in section_buffer if item.strip()]
            for index, item in enumerate(skill_lines, start=1):
                parts = item.split(":", 1)
                if len(parts) == 2:
                    label = parts[0].strip()
                    values = parts[1].strip()
                    content = f"<b>{html.escape(label)}:</b> {html.escape(values)}"
                else:
                    content = html.escape(strip_bullet(item))
                line(f"skills:{index}", strip_bullet(item), tag="li", inner_html=content)
            body.append("</ul>")
        else:
            for index, section_chunk in enumerate(chunks, start=1):
                if len(section_chunk) == 1 and not section_chunk[0].startswith(("- ", "• ", "○ ")):
                    line(f"{current_section}:paragraph:{index}", section_chunk[0], tag="p", class_name="resume-summary")
                else:
                    body.append('<ul class="resume-bullets">')
                    for bullet_index, item in enumerate(section_chunk, start=1):
                        line(f"{current_section}:line:{index}:{bullet_index}", strip_bullet(item), tag="li")
                    body.append("</ul>")
        body.append("</section>")
        section_buffer = []

    raw_lines = [raw_line.rstrip() for raw_line in resume_text.splitlines()]
    content_indexes = [index for index, raw_line in enumerate(raw_lines) if raw_line.strip()]
    if content_indexes:
        first = content_indexes[0]
        line("personal:full_name", raw_lines[first], tag="h1", class_name="resume-name")
        second = content_indexes[1] if len(content_indexes) > 1 and section_key(raw_lines[content_indexes[1]].strip()) is None else None
        start_index = first + 1
        if second is not None:
            contact_items = contact_items_from_text(raw_lines[second])
            line(
                "personal:contact",
                contact_items_text(contact_items) or raw_lines[second],
                tag="p",
                class_name="resume-contact",
                inner_html=contact_items_html(contact_items) or None,
            )
            start_index = second + 1
        body.append("</header>")
        for raw_line in raw_lines[start_index:]:
            text = raw_line.strip()
            key = section_key(text) if text else None
            if text and key is not None:
                flush_section()
                current_section = key
                current_label = text
                section_buffer = []
                continue
            if current_section is None:
                continue
            section_buffer.append(text)
        flush_section()
    else:
        body.append("</header>")
    body.append("</main>")

    return build_resume_html_document("".join(body))


def render_html_resume_pdf(html_content: str, output_path: str) -> list[LayoutBox]:
    """Render resume HTML to PDF and return line layout boxes."""

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


def migrate_legacy_resume_pdfs(
    conn: sqlite3.Connection,
    *,
    dry_run: bool = False,
    force: bool = False,
    job_url: str | None = None,
    limit: int | None = None,
    renderer: RenderHtmlToPdf = render_html_resume_pdf,
) -> list[ResumeHtmlMigrationResult]:
    """Migrate or refresh approved resume PDFs as HTML/CSS artifacts."""

    conn.row_factory = sqlite3.Row
    params: list[object] = []
    where = [
        "artifact_type = 'resume_pdf'",
        "status = 'approved'",
    ]
    if not force:
        where.append("COALESCE(render_format, '') != 'html_pdf'")
    if job_url:
        where.append("job_url = ?")
        params.append(job_url)
    sql = f"""
        SELECT job_url, generation, artifact_id, path, render_format, metadata_json
        FROM job_materials_artifacts
        WHERE {' AND '.join(where)}
        ORDER BY created_at DESC
    """
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)

    results: list[ResumeHtmlMigrationResult] = []
    for row in conn.execute(sql, params).fetchall():
        results.append(_migrate_one(conn, row, dry_run=dry_run, renderer=renderer))
        if not dry_run:
            conn.commit()
    return results


def _migrate_one(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    *,
    dry_run: bool,
    renderer: RenderHtmlToPdf,
) -> ResumeHtmlMigrationResult:
    artifact_id = str(row["artifact_id"])
    job_url = str(row["job_url"])
    pdf_path = Path(str(row["path"]))
    text_path = pdf_path.with_suffix(".txt")
    html_path = pdf_path.with_suffix(".html")
    metadata = _json_object(row["metadata_json"])
    metadata_backup_path = metadata.get("legacy_pdf_backup_path")
    backup_path = Path(str(metadata_backup_path)) if isinstance(metadata_backup_path, str) else pdf_path.with_suffix(".legacy-latex.pdf")
    is_html_pdf = str(row["render_format"] or "") == "html_pdf"

    if not pdf_path.exists():
        return ResumeHtmlMigrationResult(artifact_id, job_url, str(pdf_path), "skipped", "PDF file is missing.")
    if not text_path.exists():
        return ResumeHtmlMigrationResult(
            artifact_id,
            job_url,
            str(pdf_path),
            "skipped",
            "Sibling tailored resume text file is missing.",
        )
    if dry_run:
        status = "would_refresh" if is_html_pdf else "would_migrate"
        reason = "Ready to refresh." if is_html_pdf else "Ready to migrate."
        return ResumeHtmlMigrationResult(artifact_id, job_url, str(pdf_path), status, reason)

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    backup_for_rollback = backup_path if not is_html_pdf else pdf_path.with_name(
        f"{pdf_path.stem}.pre-refresh-{now_dt.strftime('%Y%m%dT%H%M%S%fZ')}{pdf_path.suffix}"
    )
    tmp_html_path = _temporary_sibling(html_path)
    tmp_pdf_path = _temporary_sibling(pdf_path)
    html_rollback_path = _temporary_sibling(html_path) if html_path.exists() else None
    html_replaced = False
    pdf_replaced = False
    resume_text = text_path.read_text(encoding="utf-8")
    html_content = build_legacy_resume_html(resume_text)
    try:
        tmp_html_path.write_text(html_content, encoding="utf-8")
        if html_rollback_path is not None:
            shutil.copy2(html_path, html_rollback_path)
        if is_html_pdf or not backup_path.exists():
            _copy_file_atomically(pdf_path, backup_for_rollback)
        layout_boxes = renderer(html_content, str(tmp_pdf_path))
        _validate_pdf_output(tmp_pdf_path)
        os.replace(tmp_html_path, html_path)
        html_replaced = True
        os.replace(tmp_pdf_path, pdf_path)
        pdf_replaced = True

        metadata.update(
            {
                "html_path": str(html_path),
                "layout_boxes": layout_boxes,
                "layout_source": "html_resume_text_refresh" if is_html_pdf else "legacy_resume_text_migration",
                "refreshed_at": now,
            }
        )
        if not is_html_pdf:
            metadata["legacy_pdf_backup_path"] = str(backup_for_rollback)
            metadata["legacy_render_format"] = row["render_format"]
            metadata["migrated_at"] = now
        else:
            metadata["previous_pdf_backup_path"] = str(backup_for_rollback)
            if backup_path.exists():
                metadata["legacy_pdf_backup_path"] = str(backup_path)
        size_bytes = os.path.getsize(pdf_path)
        conn.execute(
            """
            UPDATE job_materials_artifacts
            SET render_format = 'html_pdf',
                size_bytes = ?,
                metadata_json = ?
            WHERE job_url = ?
              AND generation = ?
              AND artifact_type = 'resume_pdf'
            """,
            (
                size_bytes,
                json.dumps(metadata, sort_keys=True),
                row["job_url"],
                row["generation"],
            ),
        )
        conn.execute(
            """
            DELETE FROM job_material_layout_boxes
            WHERE job_url = ? AND generation = ? AND artifact_id = ?
            """,
            (row["job_url"], row["generation"], artifact_id),
        )
        _insert_layout_boxes(
            conn,
            job_url=str(row["job_url"]),
            generation=int(row["generation"]),
            artifact_id=artifact_id,
            layout_boxes=layout_boxes,
            created_at=now,
        )
    except Exception:
        if pdf_replaced:
            _copy_file_atomically(backup_for_rollback, pdf_path)
        if html_replaced:
            if html_rollback_path is not None and html_rollback_path.exists():
                os.replace(html_rollback_path, html_path)
            else:
                html_path.unlink(missing_ok=True)
        conn.rollback()
        raise
    finally:
        tmp_html_path.unlink(missing_ok=True)
        tmp_pdf_path.unlink(missing_ok=True)
        if html_rollback_path is not None:
            html_rollback_path.unlink(missing_ok=True)
    status = "refreshed" if is_html_pdf else "migrated"
    reason = "Refreshed html_pdf." if is_html_pdf else "Migrated to html_pdf."
    return ResumeHtmlMigrationResult(artifact_id, job_url, str(pdf_path), status, reason)


def _temporary_sibling(path: Path) -> Path:
    return path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")


def _copy_file_atomically(source: Path, target: Path) -> None:
    tmp_path = _temporary_sibling(target)
    try:
        shutil.copy2(source, tmp_path)
        os.replace(tmp_path, target)
    finally:
        tmp_path.unlink(missing_ok=True)


def _validate_pdf_output(path: Path) -> None:
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError("HTML resume renderer did not produce a PDF.")
    with path.open("rb") as file:
        if file.read(4) != b"%PDF":
            raise RuntimeError("HTML resume renderer produced an invalid PDF.")


def _insert_layout_boxes(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    generation: int,
    artifact_id: str,
    layout_boxes: Iterable[LayoutBox],
    created_at: str,
) -> None:
    for index, box in enumerate(layout_boxes):
        conn.execute(
            """
            INSERT INTO job_material_layout_boxes (
                job_url, generation, artifact_id, box_index, tenant_id,
                semantic_id, page_number, line_number, text_excerpt,
                left_pct, top_pct, width_pct, height_pct,
                audit_target_json, created_at
            ) VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
            """,
            (
                job_url,
                generation,
                artifact_id,
                index,
                str(box.get("semantic_id") or ""),
                int(box.get("page_number") or 1),
                box.get("line_number"),
                str(box.get("text_excerpt") or ""),
                float(box.get("left_pct") or 0),
                float(box.get("top_pct") or 0),
                float(box.get("width_pct") or 0),
                float(box.get("height_pct") or 0),
                created_at,
            ),
        )


def _json_object(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


__all__ = [
    "ResumeHtmlMigrationResult",
    "build_legacy_resume_html",
    "migrate_legacy_resume_pdfs",
    "render_html_resume_pdf",
]
