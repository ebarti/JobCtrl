"""Exact-v7 regression coverage for MaterialsRepository queue selectors."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.materials import SqliteMaterialsRepository

_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl-v7.db")


def _job_id(value: str) -> JobId:
    return canonical_job_id(value)


def _seed_job(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    url: str,
    fit_score: int = 9,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, discovered_at
        ) VALUES (?, ?, ?, 'Engineer', 'Acme', 'example', ?)
        """,
        (str(tenant_id), str(job_id), url, "2026-07-31T10:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, updated_at
        ) VALUES (?, ?, 'succeeded', 'Role description', ?)
        """,
        (str(tenant_id), str(job_id), "2026-07-31T10:01:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (str(tenant_id), str(job_id), fit_score, "2026-07-31T10:02:00+00:00"),
    )
    conn.commit()


def _artifact(artifact_type: ArtifactType, path: str, render_format: RenderFormat) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path=path,
        created_at="2026-07-31T10:03:00+00:00",
        render_format=render_format,
    )


def _approved_resume(tenant_id: TenantId, job_id: JobId):
    return MaterialsSetFactory.initial(
        tenant_id=tenant_id,
        job_id=job_id,
        created_at="2026-07-31T10:03:00+00:00",
    ).with_resume_attempt(
        _artifact(ArtifactType.TAILORED_RESUME, "/tmp/resume.txt", RenderFormat.TEXT),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2026-07-31T10:04:00+00:00",
    )


def _rejected_resume(tenant_id: TenantId, job_id: JobId, generation: int) -> MaterialsSet:
    return MaterialsSet(
        tenant_id=tenant_id,
        job_id=job_id,
        generation=generation,
        created_at="2026-07-31T10:08:00+00:00",
        updated_at="2026-07-31T10:08:00+00:00",
    ).with_resume_attempt(
        _artifact(ArtifactType.TAILORED_RESUME, "/tmp/rejected-resume.txt", RenderFormat.TEXT),
        validation=ValidationResult.failure(("unsupported claim",)),
        verdict=JudgeVerdict.passed(),
        updated_at="2026-07-31T10:09:00+00:00",
    )


def test_v7_tailor_selector_returns_job_ids_and_isolates_same_url_tenants(
    conn: sqlite3.Connection,
) -> None:
    """A locator collision cannot hide another tenant's pending JobId."""
    alpha_job_id = _job_id("11111111-1111-4111-8111-111111111111")
    beta_job_id = alpha_job_id
    shared_url = "https://jobs.example.test/role/locator-only"
    _seed_job(
        conn,
        tenant_id=_TENANT_A,
        job_id=alpha_job_id,
        url=shared_url,
    )
    _seed_job(
        conn,
        tenant_id=_TENANT_B,
        job_id=beta_job_id,
        url=shared_url,
    )
    SqliteMaterialsRepository(conn).save(_approved_resume(_TENANT_B, beta_job_id))

    assert SqliteMaterialsRepository(conn).list_pending_tailor(_TENANT_A) == [alpha_job_id]
    assert SqliteMaterialsRepository(conn).list_pending_tailor(_TENANT_B) == []


def test_v7_material_selectors_use_current_approved_job_id_generation(
    conn: sqlite3.Connection,
) -> None:
    cover_job_id = _job_id("33333333-3333-4333-8333-333333333333")
    pdf_job_id = _job_id("44444444-4444-4444-8444-444444444444")
    complete_job_id = _job_id("55555555-5555-4555-8555-555555555555")
    for job_id in (cover_job_id, pdf_job_id, complete_job_id):
        _seed_job(
            conn,
            tenant_id=_TENANT_A,
            job_id=job_id,
            url=f"https://jobs.example.test/role/{job_id}",
        )
    for job_id in (cover_job_id, pdf_job_id):
        _seed_job(
            conn,
            tenant_id=_TENANT_B,
            job_id=job_id,
            url=f"https://jobs.example.test/other/{job_id}",
        )

    repo = SqliteMaterialsRepository(conn)
    cover_materials = _approved_resume(_TENANT_A, cover_job_id).with_resume_pdf(
        _artifact(ArtifactType.RESUME_PDF, "/tmp/cover-resume.pdf", RenderFormat.LATEX_PDF),
        updated_at="2026-07-31T10:05:00+00:00",
    )
    repo.save(cover_materials)
    repo.save(_approved_resume(_TENANT_A, pdf_job_id))
    repo.save(_rejected_resume(_TENANT_A, pdf_job_id, generation=2))
    repo.save(
        _approved_resume(_TENANT_B, cover_job_id)
        .with_resume_pdf(
            _artifact(ArtifactType.RESUME_PDF, "/tmp/other-cover-resume.pdf", RenderFormat.LATEX_PDF),
            updated_at="2026-07-31T10:05:00+00:00",
        )
        .with_cover_letter(
            _artifact(ArtifactType.COVER_LETTER, "/tmp/other-cover.txt", RenderFormat.TEXT),
            validation=ValidationResult.success(),
            updated_at="2026-07-31T10:06:00+00:00",
        )
    )
    repo.save(
        _approved_resume(_TENANT_B, pdf_job_id).with_resume_pdf(
            _artifact(ArtifactType.RESUME_PDF, "/tmp/other-resume.pdf", RenderFormat.LATEX_PDF),
            updated_at="2026-07-31T10:05:00+00:00",
        )
    )
    repo.save(
        _approved_resume(_TENANT_A, complete_job_id)
        .with_resume_pdf(
            _artifact(ArtifactType.RESUME_PDF, "/tmp/complete-resume.pdf", RenderFormat.LATEX_PDF),
            updated_at="2026-07-31T10:05:00+00:00",
        )
        .with_cover_letter(
            _artifact(ArtifactType.COVER_LETTER, "/tmp/complete-cover.txt", RenderFormat.TEXT),
            validation=ValidationResult.success(),
            updated_at="2026-07-31T10:06:00+00:00",
        )
        .with_cover_letter_pdf(
            _artifact(
                ArtifactType.COVER_LETTER_PDF,
                "/tmp/complete-cover.pdf",
                RenderFormat.HTML_PDF,
            ),
            updated_at="2026-07-31T10:07:00+00:00",
        )
    )

    assert repo.list_pending_cover(_TENANT_A) == [cover_job_id]
    assert repo.list_pending_pdf(_TENANT_A) == [pdf_job_id]
    assert repo.list_pending_cover(_TENANT_B) == [pdf_job_id]
    assert repo.list_pending_pdf(_TENANT_B) == [cover_job_id]
    assert {materials.job_id for materials in repo.list_by_status(_TENANT_A, ArtifactStatus.APPROVED)} == {
        cover_job_id,
        complete_job_id,
    }


def test_v7_status_selector_isolates_latest_generations_by_tenant_and_job_id(
    conn: sqlite3.Connection,
) -> None:
    alpha_job_id = _job_id("66666666-6666-4666-8666-666666666666")
    beta_job_id = alpha_job_id
    shared_url = "https://jobs.example.test/role/status-locator-only"
    _seed_job(conn, tenant_id=_TENANT_A, job_id=alpha_job_id, url=shared_url)
    _seed_job(conn, tenant_id=_TENANT_B, job_id=beta_job_id, url=shared_url)

    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved_resume(_TENANT_A, alpha_job_id))
    repo.save(_approved_resume(_TENANT_B, beta_job_id))
    repo.save(_rejected_resume(_TENANT_B, beta_job_id, generation=2))

    assert [materials.job_id for materials in repo.list_by_status(_TENANT_A, ArtifactStatus.APPROVED)] == [
        alpha_job_id
    ]
