"""Regression coverage for PDF stage/material-state reconciliation."""

from __future__ import annotations

from pathlib import Path

from jobhunter import database as db_module
from jobhunter.database import close_connection, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import SqliteMaterialsRepository
from jobhunter.pipeline.runner import _run_pdf
from jobhunter.state import ensure_job_stage_rows, set_stage_state


def _artifact(artifact_type: ArtifactType, path: str) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path=path,
        created_at="2026-05-22T10:00:00+00:00",
        render_format=(
            RenderFormat.LATEX_PDF
            if artifact_type is ArtifactType.RESUME_PDF
            else RenderFormat.HTML_PDF
            if artifact_type is ArtifactType.COVER_LETTER_PDF
            else RenderFormat.TEXT
        ),
        size_bytes=128,
    )


def test_pdf_stage_marks_complete_material_rows_succeeded(
    tmp_path: Path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(db_module, "DB_PATH", db_path)
    conn = init_db(db_path)
    try:
        url = "https://example.com/complete-materials"
        conn.execute(
            "INSERT INTO jobs (url, title, site, full_description, fit_score, discovered_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (url, "Engineer", "Acme", "Description", 9, "2026-05-22T09:00:00+00:00"),
        )
        ensure_job_stage_rows(conn, url, discovered_at="2026-05-22T09:00:00+00:00")
        set_stage_state(conn, url, "pdf", "pending", validate_transition=False)

        materials = MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            created_at="2026-05-22T10:00:00+00:00",
        ).with_resume_attempt(
            _artifact(ArtifactType.TAILORED_RESUME, str(tmp_path / "resume.txt")),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2026-05-22T10:01:00+00:00",
        ).with_resume_pdf(
            _artifact(ArtifactType.RESUME_PDF, str(tmp_path / "resume.pdf")),
            updated_at="2026-05-22T10:02:00+00:00",
        ).with_cover_letter(
            _artifact(ArtifactType.COVER_LETTER, str(tmp_path / "cover.txt")),
            validation=ValidationResult.success(),
            updated_at="2026-05-22T10:03:00+00:00",
        ).with_cover_letter_pdf(
            _artifact(ArtifactType.COVER_LETTER_PDF, str(tmp_path / "cover.pdf")),
            updated_at="2026-05-22T10:04:00+00:00",
        )
        SqliteMaterialsRepository(conn).save(materials)

        result = _run_pdf()

        assert result["status"] == "ok"
        assert result["remaining"] == 0
        assert result["reconciled"] == 1
        row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'pdf'",
            (url,),
        ).fetchone()
        assert row["state"] == "succeeded"
    finally:
        close_connection(db_path)
