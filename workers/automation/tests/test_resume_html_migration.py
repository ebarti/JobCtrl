from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from jobctrl.database import ensure_materials_tables, init_db
from jobctrl.infrastructure.materials.resume_html_migration import (
    build_legacy_resume_html,
    migrate_legacy_resume_pdfs,
)


def test_build_legacy_resume_html_uses_real_list_items_without_double_bullets() -> None:
    html = build_legacy_resume_html(
        "\n".join(
            [
                "Jordan Candidate",
                "jordan@example.com | (+1) 555-0100 | https://www.linkedin.com/in/jordan | https://example.com",
                "",
                "EXPERIENCE",
                "Director of Engineering | Acme",
                "Remote | Mar 2024 -- Present",
                "- Built a platform team.",
            ]
        )
    )

    assert '<h1 class="resume-name" data-resume-layout-target="personal:full_name"' in html
    assert '<span class="resume-contact-item resume-contact-phone"><a href="tel:+15550100">(+1) 555-0100</a></span>' in html
    assert '<span class="resume-contact-item resume-contact-email"><a href="mailto:jordan@example.com">jordan@example.com</a></span>' in html
    assert '<span class="resume-contact-item resume-contact-website"><a href="https://example.com">example.com</a></span>' in html
    assert '<span class="resume-contact-item resume-contact-linkedin"><a href="https://www.linkedin.com/in/jordan">jordan</a></span>' in html
    assert html.index("resume-contact-phone") < html.index("resume-contact-email") < html.index("resume-contact-website") < html.index("resume-contact-linkedin")
    assert '<span class="resume-entry-row resume-entry-company-row"><span class="resume-entry-company">Acme</span><span class="resume-entry-location">Remote</span></span>' in html
    assert '<span class="resume-entry-row resume-entry-role-row"><span class="resume-entry-title">Director of Engineering</span><span class="resume-entry-date">Mar 2024 - Present</span></span>' in html
    assert "Mar 2024 -- Present" not in html
    assert '<ul class="resume-bullets">' in html
    assert ">Built a platform team.</li>" in html
    assert ">- Built a platform team.</li>" not in html
    assert 'data-resume-line-number="5"' in html


def test_migrate_legacy_resume_pdfs_updates_artifact_and_layout_boxes(tmp_path: Path) -> None:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tailored_resume_path TEXT,
            tailored_at TEXT,
            cover_letter_path TEXT,
            cover_letter_at TEXT
        )
        """
    )
    ensure_materials_tables(db)
    pdf_path = tmp_path / "resume.pdf"
    text_path = tmp_path / "resume.txt"
    pdf_path.write_bytes(b"%PDF legacy")
    text_path.write_text("Jordan Candidate\njordan@example.com\n\nEXPERIENCE\n- Built a platform team.", encoding="utf-8")
    now = "2026-06-20T10:00:00+00:00"
    db.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES ('job-1', 1, 'local', 'resume_approved', ?, ?)
        """,
        (now, now),
    )
    db.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES ('job-1', 1, 'resume_pdf', 'artifact-1', 'approved', ?, 'latex_pdf', ?, ?, ?)
        """,
        (
            str(pdf_path),
            pdf_path.stat().st_size,
            json.dumps({"latex_path": str(tmp_path / "resume.tex")}),
            now,
        ),
    )

    def fake_renderer(html: str, output_path: str) -> list[dict[str, object]]:
        Path(output_path).write_bytes(b"%PDF html")
        assert "Built a platform team." in html
        return [
            {
                "semantic_id": "line:5",
                "page_number": 1,
                "line_number": 5,
                "text_excerpt": "Built a platform team.",
                "left_pct": 10,
                "top_pct": 20,
                "width_pct": 30,
                "height_pct": 2,
            }
        ]

    results = migrate_legacy_resume_pdfs(db, renderer=fake_renderer)

    assert [result.status for result in results] == ["migrated"]
    artifact = db.execute(
        "SELECT render_format, size_bytes, metadata_json FROM job_materials_artifacts WHERE artifact_id = 'artifact-1'"
    ).fetchone()
    assert artifact["render_format"] == "html_pdf"
    assert artifact["size_bytes"] == len(b"%PDF html")
    metadata = json.loads(artifact["metadata_json"])
    assert metadata["html_path"] == str(tmp_path / "resume.html")
    assert metadata["legacy_render_format"] == "latex_pdf"
    assert metadata["legacy_pdf_backup_path"] == str(tmp_path / "resume.legacy-latex.pdf")
    assert (tmp_path / "resume.html").exists()
    assert (tmp_path / "resume.legacy-latex.pdf").read_bytes() == b"%PDF legacy"
    layout_count = db.execute("SELECT COUNT(*) FROM job_material_layout_boxes WHERE artifact_id = 'artifact-1'").fetchone()[0]
    assert layout_count == 1


def test_migrate_resume_pdfs_selects_stable_material_by_posting_url_alias(
    tmp_path: Path,
) -> None:
    db = init_db(tmp_path / "jobctrl.db")
    db.row_factory = sqlite3.Row
    job_id = str(uuid.uuid4())
    storage_url = "https://storage.example/jobs/original"
    posting_url = "https://posting.example/jobs/current"
    now = "2026-07-29T10:00:00+00:00"
    pdf_path = tmp_path / "resume.pdf"
    pdf_path.write_bytes(b"%PDF legacy")
    pdf_path.with_suffix(".txt").write_text(
        "Jordan Candidate\njordan@example.com\n",
        encoding="utf-8",
    )
    db.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'local', ?, 'Platform Engineer', 'Example', ?)
        """,
        (storage_url, job_id, now),
    )
    db.execute(
        """
        INSERT INTO job_identity_aliases (
            tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
        ) VALUES ('local', 'posting_url', ?, ?, ?, NULL)
        """,
        (posting_url, job_id, now),
    )
    db.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES ('local', ?, 1, 'resume_approved', ?, ?)
        """,
        (job_id, now, now),
    )
    db.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status,
            path, render_format, size_bytes, metadata_json, created_at
        ) VALUES (
            'local', ?, 1, 'resume_pdf', 'artifact-1', 'approved', ?,
            'latex_pdf', ?, '{}', ?
        )
        """,
        (job_id, str(pdf_path), pdf_path.stat().st_size, now),
    )
    db.commit()

    results = migrate_legacy_resume_pdfs(
        db,
        dry_run=True,
        job_url=posting_url,
    )

    assert [(result.artifact_id, result.status) for result in results] == [
        ("artifact-1", "would_migrate")
    ]


def test_force_refresh_reprints_existing_html_resume_without_replacing_legacy_backup(tmp_path: Path) -> None:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tailored_resume_path TEXT,
            tailored_at TEXT,
            cover_letter_path TEXT,
            cover_letter_at TEXT
        )
        """
    )
    ensure_materials_tables(db)
    pdf_path = tmp_path / "resume.pdf"
    text_path = tmp_path / "resume.txt"
    backup_path = tmp_path / "resume.legacy-latex.pdf"
    pdf_path.write_bytes(b"%PDF old html")
    text_path.write_text("Jordan Candidate\njordan@example.com\n\nEXPERIENCE\n- Built a platform team.", encoding="utf-8")
    backup_path.write_bytes(b"%PDF legacy")
    now = "2026-06-20T10:00:00+00:00"
    db.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES ('job-1', 1, 'local', 'resume_approved', ?, ?)
        """,
        (now, now),
    )
    db.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES ('job-1', 1, 'resume_pdf', 'artifact-1', 'approved', ?, 'html_pdf', ?, ?, ?)
        """,
        (
            str(pdf_path),
            pdf_path.stat().st_size,
            json.dumps({"html_path": str(tmp_path / "resume.html"), "legacy_pdf_backup_path": str(backup_path)}),
            now,
        ),
    )
    db.execute(
        """
        INSERT INTO job_material_layout_boxes (
            job_url, generation, artifact_id, box_index, tenant_id,
            semantic_id, page_number, line_number, text_excerpt,
            left_pct, top_pct, width_pct, height_pct,
            audit_target_json, created_at
        ) VALUES ('job-1', 1, 'artifact-1', 0, 'local', 'old', 1, 1, 'old', 1, 1, 1, 1, '{}', ?)
        """,
        (now,),
    )

    def fake_renderer(html: str, output_path: str) -> list[dict[str, object]]:
        Path(output_path).write_bytes(b"%PDF refreshed html")
        assert "Built a platform team." in html
        return [
            {
                "semantic_id": "line:5",
                "page_number": 1,
                "line_number": 5,
                "text_excerpt": "Built a platform team.",
                "left_pct": 10,
                "top_pct": 20,
                "width_pct": 30,
                "height_pct": 2,
            }
        ]

    assert migrate_legacy_resume_pdfs(db, renderer=fake_renderer) == []
    results = migrate_legacy_resume_pdfs(db, force=True, renderer=fake_renderer)

    assert [result.status for result in results] == ["refreshed"]
    assert pdf_path.read_bytes() == b"%PDF refreshed html"
    assert backup_path.read_bytes() == b"%PDF legacy"
    artifact = db.execute(
        "SELECT render_format, size_bytes, metadata_json FROM job_materials_artifacts WHERE artifact_id = 'artifact-1'"
    ).fetchone()
    assert artifact["render_format"] == "html_pdf"
    assert artifact["size_bytes"] == len(b"%PDF refreshed html")
    metadata = json.loads(artifact["metadata_json"])
    assert metadata["layout_source"] == "html_resume_text_refresh"
    assert metadata["legacy_pdf_backup_path"] == str(backup_path)
    assert Path(str(metadata["previous_pdf_backup_path"])).read_bytes() == b"%PDF old html"
    assert "refreshed_at" in metadata
    boxes = db.execute(
        "SELECT semantic_id, text_excerpt FROM job_material_layout_boxes WHERE artifact_id = 'artifact-1'"
    ).fetchall()
    assert [(box["semantic_id"], box["text_excerpt"]) for box in boxes] == [("line:5", "Built a platform team.")]


def test_force_refresh_preserves_accepted_artifact_when_renderer_outputs_invalid_pdf(tmp_path: Path) -> None:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tailored_resume_path TEXT,
            tailored_at TEXT,
            cover_letter_path TEXT,
            cover_letter_at TEXT
        )
        """
    )
    ensure_materials_tables(db)
    pdf_path = tmp_path / "resume.pdf"
    text_path = tmp_path / "resume.txt"
    html_path = tmp_path / "resume.html"
    backup_path = tmp_path / "resume.legacy-latex.pdf"
    old_html = "<!doctype html><html><body>old accepted resume</body></html>"
    old_metadata = {
        "html_path": str(html_path),
        "layout_source": "html_resume_text_refresh",
        "legacy_pdf_backup_path": str(backup_path),
    }
    pdf_path.write_bytes(b"%PDF old html")
    text_path.write_text("Jordan Candidate\njordan@example.com\n\nEXPERIENCE\n- Built a platform team.", encoding="utf-8")
    html_path.write_text(old_html, encoding="utf-8")
    backup_path.write_bytes(b"%PDF legacy")
    now = "2026-06-20T10:00:00+00:00"
    db.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES ('job-1', 1, 'local', 'resume_approved', ?, ?)
        """,
        (now, now),
    )
    db.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES ('job-1', 1, 'resume_pdf', 'artifact-1', 'approved', ?, 'html_pdf', ?, ?, ?)
        """,
        (
            str(pdf_path),
            pdf_path.stat().st_size,
            json.dumps(old_metadata),
            now,
        ),
    )
    db.execute(
        """
        INSERT INTO job_material_layout_boxes (
            job_url, generation, artifact_id, box_index, tenant_id,
            semantic_id, page_number, line_number, text_excerpt,
            left_pct, top_pct, width_pct, height_pct,
            audit_target_json, created_at
        ) VALUES ('job-1', 1, 'artifact-1', 0, 'local', 'old', 1, 1, 'old', 1, 1, 1, 1, '{}', ?)
        """,
        (now,),
    )
    db.commit()

    def broken_renderer(_html: str, output_path: str) -> list[dict[str, object]]:
        Path(output_path).write_bytes(b"not a pdf")
        return []

    with pytest.raises(RuntimeError, match="invalid PDF"):
        migrate_legacy_resume_pdfs(db, force=True, renderer=broken_renderer)

    assert pdf_path.read_bytes() == b"%PDF old html"
    assert html_path.read_text(encoding="utf-8") == old_html
    assert backup_path.read_bytes() == b"%PDF legacy"
    artifact = db.execute(
        "SELECT render_format, size_bytes, metadata_json FROM job_materials_artifacts WHERE artifact_id = 'artifact-1'"
    ).fetchone()
    assert artifact["render_format"] == "html_pdf"
    assert artifact["size_bytes"] == len(b"%PDF old html")
    assert json.loads(artifact["metadata_json"]) == old_metadata
    boxes = db.execute(
        "SELECT semantic_id, text_excerpt FROM job_material_layout_boxes WHERE artifact_id = 'artifact-1'"
    ).fetchall()
    assert [(box["semantic_id"], box["text_excerpt"]) for box in boxes] == [("old", "old")]
