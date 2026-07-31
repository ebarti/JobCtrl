"""Exact-v7 aggregate persistence tests for SqliteMaterialsRepository."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.materials import (
    MaterialsGenerationConflict,
    SqliteMaterialsRepository,
    SqliteUnitOfWork,
)

JOB_ID = JobId("00000000-0000-4000-8000-000000000051")
JOB_URL = "https://example.test/jobs/materials"
OTHER_TENANT = TenantId("other")
CREATED_AT = "2026-07-30T10:00:00+00:00"


@pytest.fixture()
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    connection = init_db(tmp_path / "jobctrl.db")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(JOB_ID),
            JOB_URL,
            "Materials Engineer",
            "Example",
        ),
    )
    connection.commit()
    yield connection
    connection.close()


def _resume(
    path: str,
    *,
    status: ArtifactStatus = ArtifactStatus.CANDIDATE,
    layout_boxes: list[dict[str, object]] | None = None,
) -> Artifact:
    artifact = Artifact.create(
        type=ArtifactType.TAILORED_RESUME,
        path=path,
        created_at=CREATED_AT,
        render_format=RenderFormat.TEXT,
        size_bytes=128,
        metadata={"layout_boxes": layout_boxes or []},
    )
    return artifact.with_status(status)


def _approved(
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    job_id: JobId = JOB_ID,
    generation: int = 1,
    path: str = "/tmp/resume.txt",
    created_at: str = CREATED_AT,
    lineage_id: str | None = None,
    layout_boxes: list[dict[str, object]] | None = None,
) -> MaterialsSet:
    materials_kwargs: dict[str, object] = {}
    if lineage_id is not None:
        materials_kwargs["lineage_id"] = lineage_id
    return MaterialsSet(
        tenant_id=tenant_id,
        job_id=job_id,
        generation=generation,
        created_at=created_at,
        updated_at=created_at,
        **materials_kwargs,
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=path,
            created_at=created_at,
            render_format=RenderFormat.TEXT,
            size_bytes=128,
            metadata={"layout_boxes": layout_boxes or []},
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at=created_at,
    )


def _rejected(generation: int) -> MaterialsSet:
    return MaterialsSet(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=generation,
        created_at=CREATED_AT,
        updated_at=CREATED_AT,
    ).with_resume_attempt(
        _resume(
            f"/tmp/rejected-{generation}.txt",
            status=ArtifactStatus.REJECTED,
        ),
        validation=ValidationResult.failure(("unsupported claim",)),
        verdict=JudgeVerdict.passed(),
        updated_at=CREATED_AT,
    )


def _seed_resume_template(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    template_id: str,
    version_id: str,
    name: str,
) -> None:
    conn.execute(
        """
        INSERT INTO resume_templates (
            tenant_id, template_id, display_name, status, built_in, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?)
        """,
        (
            str(tenant_id),
            template_id,
            name,
            int(template_id.startswith("built_in:")),
            CREATED_AT,
            CREATED_AT,
        ),
    )
    conn.execute(
        """
        INSERT INTO resume_template_versions (
            tenant_id, version_id, template_id, version_number, display_name,
            status, theme_json, layout_json, content_hash, created_at
        ) VALUES (?, ?, ?, 1, ?, 'active', ?, '{}', ?, ?)
        """,
        (
            str(tenant_id),
            version_id,
            template_id,
            name,
            '{"template": "' + template_id + '"}',
            f"hash:{template_id}",
            CREATED_AT,
        ),
    )


def test_fresh_v7_resolves_the_builtin_template_without_runtime_setup(
    conn: sqlite3.Connection,
) -> None:
    resolved = SqliteMaterialsRepository(conn).resolve_effective_resume_template(
        LOCAL_TENANT,
        JOB_ID,
    )

    assert resolved["metadata"]["templateId"] == "built_in:modern-html"
    assert resolved["metadata"]["assignmentSource"] == "built_in"


def test_effective_template_resolution_uses_v7_identity_and_precedence(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteMaterialsRepository(conn)
    _seed_resume_template(
        conn,
        tenant_id=LOCAL_TENANT,
        template_id="profile-template",
        version_id="profile-version",
        name="Profile default",
    )
    _seed_resume_template(
        conn,
        tenant_id=LOCAL_TENANT,
        template_id="job-template",
        version_id="job-version",
        name="Job override",
    )
    conn.execute(
        """
        INSERT INTO resume_template_defaults (
            tenant_id, profile_id, template_id, version_id, updated_at
        ) VALUES (?, 'default', 'profile-template', 'profile-version', ?)
        """,
        (str(LOCAL_TENANT), CREATED_AT),
    )
    conn.execute(
        """
        INSERT INTO job_resume_template_assignments (
            tenant_id, job_id, template_id, version_id, updated_at
        ) VALUES (?, ?, 'job-template', 'job-version', ?)
        """,
        (str(LOCAL_TENANT), str(JOB_ID), CREATED_AT),
    )
    conn.commit()

    override = repo.resolve_effective_resume_template(LOCAL_TENANT, JOB_ID)
    assert override["metadata"]["templateId"] == "job-template"
    assert override["metadata"]["assignmentSource"] == "job_override"

    conn.execute("DELETE FROM job_resume_template_assignments")
    default = repo.resolve_effective_resume_template(LOCAL_TENANT, JOB_ID)
    assert default["metadata"]["templateId"] == "profile-template"
    assert default["metadata"]["assignmentSource"] == "profile_default"

    conn.execute("DELETE FROM resume_template_defaults")
    built_in = repo.resolve_effective_resume_template(LOCAL_TENANT, JOB_ID)
    assert built_in["metadata"]["templateId"] == "built_in:modern-html"
    assert built_in["metadata"]["assignmentSource"] == "built_in"

    with pytest.raises(ValueError, match="canonical UUID"):
        repo.resolve_effective_resume_template(LOCAL_TENANT, JobId(JOB_URL))


def test_effective_template_resolution_is_tenant_scoped(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (str(OTHER_TENANT), str(JOB_ID), JOB_URL, "Materials Engineer", "Example"),
    )
    _seed_resume_template(
        conn,
        tenant_id=LOCAL_TENANT,
        template_id="local-template",
        version_id="local-version",
        name="Local default",
    )
    _seed_resume_template(
        conn,
        tenant_id=OTHER_TENANT,
        template_id="other-template",
        version_id="other-version",
        name="Other default",
    )
    conn.executemany(
        """
        INSERT INTO resume_template_defaults (
            tenant_id, profile_id, template_id, version_id, updated_at
        ) VALUES (?, 'default', ?, ?, ?)
        """,
        (
            (str(LOCAL_TENANT), "local-template", "local-version", CREATED_AT),
            (str(OTHER_TENANT), "other-template", "other-version", CREATED_AT),
        ),
    )
    conn.executemany(
        """
        INSERT INTO job_resume_template_assignments (
            tenant_id, job_id, template_id, version_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            (str(LOCAL_TENANT), str(JOB_ID), "local-template", "local-version", CREATED_AT),
            (str(OTHER_TENANT), str(JOB_ID), "other-template", "other-version", CREATED_AT),
        ),
    )
    conn.commit()

    resolved = SqliteMaterialsRepository(conn).resolve_effective_resume_template(
        OTHER_TENANT,
        JOB_ID,
    )

    assert resolved["metadata"]["templateId"] == "other-template"
    assert resolved["metadata"]["assignmentSource"] == "job_override"
    assert resolved["theme"] == {"template": "other-template"}


def test_exact_v7_round_trip_persists_artifact_and_layout_identity(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteMaterialsRepository(conn)
    box = {
        "semantic_id": "experience:acme",
        "page_number": 1,
        "line_number": 12,
        "text_excerpt": "Reduced latency.",
        "left_pct": 10.0,
        "top_pct": 20.0,
        "width_pct": 30.0,
        "height_pct": 4.0,
        "audit_target": {"kind": "bullet"},
    }

    repo.save(_approved(layout_boxes=[box]))

    loaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert loaded is not None
    assert loaded.job_id == JOB_ID
    assert loaded.tailored_resume is not None
    assert loaded.tailored_resume.status is ArtifactStatus.APPROVED
    artifact_identity = conn.execute("SELECT tenant_id, job_id, generation FROM job_materials_artifacts").fetchone()
    layout_identity = conn.execute(
        "SELECT tenant_id, job_id, generation, semantic_id FROM job_material_layout_boxes"
    ).fetchone()
    assert tuple(artifact_identity) == (str(LOCAL_TENANT), str(JOB_ID), 1)
    assert tuple(layout_identity) == (
        str(LOCAL_TENANT),
        str(JOB_ID),
        1,
        "experience:acme",
    )


def test_same_generation_artifact_replacement_removes_prior_layout_boxes(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteMaterialsRepository(conn)
    prior = _approved(
        path="/tmp/prior.txt",
        layout_boxes=[
            {
                "semantic_id": "prior",
                "page_number": 1,
                "text_excerpt": "Prior text.",
                "left_pct": 1,
                "top_pct": 2,
                "width_pct": 3,
                "height_pct": 4,
            }
        ],
    )
    replacement = _approved(
        path="/tmp/replacement.txt",
        lineage_id=prior.lineage_id,
        layout_boxes=[
            {
                "semantic_id": "replacement",
                "page_number": 1,
                "text_excerpt": "Replacement text.",
                "left_pct": 5,
                "top_pct": 6,
                "width_pct": 7,
                "height_pct": 8,
            }
        ],
    )
    assert prior.tailored_resume is not None
    assert replacement.tailored_resume is not None
    assert prior.tailored_resume.artifact_id != replacement.tailored_resume.artifact_id

    repo.save(prior)
    repo.save(replacement)

    artifact_ids = tuple(
        str(row["artifact_id"])
        for row in conn.execute(
            "SELECT artifact_id FROM job_material_layout_boxes WHERE tenant_id = ? AND job_id = ? AND generation = 1",
            (str(LOCAL_TENANT), str(JOB_ID)),
        ).fetchall()
    )
    assert artifact_ids == (replacement.tailored_resume.artifact_id,)


def test_current_approved_ignores_newer_rejected_generation(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved())
    repo.save(_rejected(2))

    latest = repo.load(LOCAL_TENANT, JOB_ID)
    current = repo.load_current_approved(LOCAL_TENANT, JOB_ID)
    assert latest is not None and latest.generation == 2
    assert current is not None and current.generation == 1


def test_generation_allocation_is_monotonic(conn: sqlite3.Connection) -> None:
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved())

    with pytest.raises(MaterialsGenerationConflict) as error:
        repo.save(_approved(generation=3))

    assert error.value.job_id == JOB_ID
    assert error.value.expected == 2


def test_stale_next_generation_writer_cannot_replace_winning_aggregate(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteMaterialsRepository(conn)
    repo.save(_approved())
    first_snapshot = _approved(
        generation=2,
        path="/tmp/g2-first.txt",
    )
    stale_snapshot = _approved(
        generation=2,
        path="/tmp/g2-stale.txt",
    )

    with SqliteUnitOfWork(conn):
        repo.save(first_snapshot)
    with pytest.raises(MaterialsGenerationConflict) as error:
        with SqliteUnitOfWork(conn):
            repo.save(stale_snapshot)

    persisted = repo.load(LOCAL_TENANT, JOB_ID, generation=2)
    assert persisted is not None and persisted.tailored_resume is not None
    assert persisted.created_at == stale_snapshot.created_at
    assert persisted.lineage_id == first_snapshot.lineage_id
    assert persisted.tailored_resume.path == "/tmp/g2-first.txt"
    assert error.value.job_id == JOB_ID
    assert error.value.expected == 3


def test_repository_rejects_url_shaped_job_identity(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteMaterialsRepository(conn)

    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(JOB_URL))
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.save(_approved(job_id=JobId(JOB_URL)))
    assert conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0] == 0


def test_same_job_id_is_isolated_by_tenant(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(OTHER_TENANT),
            str(JOB_ID),
            JOB_URL,
            "Materials Engineer",
            "Example",
        ),
    )
    conn.commit()
    repo = SqliteMaterialsRepository(conn)

    repo.save(_approved(path="/tmp/local.txt"))
    repo.save(
        _approved(
            tenant_id=OTHER_TENANT,
            path="/tmp/other.txt",
        )
    )

    local = repo.load(LOCAL_TENANT, JOB_ID)
    other = repo.load(OTHER_TENANT, JOB_ID)
    assert local is not None and local.tailored_resume is not None
    assert other is not None and other.tailored_resume is not None
    assert local.tailored_resume.path == "/tmp/local.txt"
    assert other.tailored_resume.path == "/tmp/other.txt"
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_materials WHERE job_id = ?",
            (str(JOB_ID),),
        ).fetchone()[0]
        == 2
    )


def test_failed_artifact_write_rolls_back_parent_row(
    conn: sqlite3.Connection,
) -> None:
    conn.execute(
        """
        CREATE TEMP TRIGGER reject_material_artifact
        BEFORE INSERT ON job_materials_artifacts
        BEGIN
            SELECT RAISE(ABORT, 'forced artifact failure');
        END
        """
    )
    repo = SqliteMaterialsRepository(conn)

    with pytest.raises(sqlite3.IntegrityError, match="forced artifact failure"):
        repo.save(_approved())

    assert conn.in_transaction is False
    assert conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts").fetchone()[0] == 0


def test_savepoint_does_not_commit_enclosing_unit_of_work(
    conn: sqlite3.Connection,
) -> None:
    unit_of_work = SqliteUnitOfWork(conn)
    repo = SqliteMaterialsRepository(conn, unit_of_work=unit_of_work)

    with pytest.raises(RuntimeError, match="rollback outer transaction"):
        with unit_of_work:
            repo.save(_approved())
            assert conn.in_transaction is True
            raise RuntimeError("rollback outer transaction")

    assert repo.load(LOCAL_TENANT, JOB_ID) is None
