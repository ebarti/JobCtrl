"""A9: the tailor generation flip commits atomically via SqliteUnitOfWork.

The tailor persist path performs a three-write "generation flip": supersede the
prior approved generation, save the new generation, then record the new
generation's provenance/coverage. Before A9 each SQLite repository committed per
call, so the flip was three separate transactions:

  * a crash between the supersede and the new-generation save could leave the job
    with NO current approved resume (prior superseded, replacement never saved);
  * a provenance write failure after the artifact committed left an approved
    generation with no provenance, breaking the audit invariant that every
    committed approved generation has its provenance.

These tests drive the REAL SQLite repositories over one connection. They assert
that with a shared :class:`SqliteUnitOfWork` a failure anywhere in the flip rolls
the WHOLE block back, and — as a control — that WITHOUT the unit of work (the
pre-A9 per-call-commit behaviour) the same failure leaves the documented bad
state. The control is what proves the unit of work is load-bearing rather than
incidental.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobhunter.domain.materials.value_objects import ControlRule, TransformType
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.materials import (
    SqliteBulletProvenanceRepository,
    SqliteMaterialsRepository,
    SqliteUnitOfWork,
)

JOB_URL = "https://example.com/job/uow"


# ---------------------------------------------------------------------------
# Fixtures + builders
# ---------------------------------------------------------------------------


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    connection = init_db(tmp_path / "jobhunter.db")
    connection.execute(
        "INSERT INTO jobs (url, title, site, full_description, fit_score, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (JOB_URL, "Senior Backend Engineer", "Acme", "Own Python services.", 9, "2024-01-01T00:00:00+00:00"),
    )
    connection.commit()
    return connection


def _artifact(artifact_type: ArtifactType, *, path: str, render_format: RenderFormat) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path=path,
        created_at="2024-01-01T00:00:00+00:00",
        render_format=render_format,
        size_bytes=128,
    )


def _approve_with_pdf(base: MaterialsSet, *, resume_path: str, pdf_path: str, updated_at: str) -> MaterialsSet:
    approved = base.with_resume_attempt(
        _artifact(ArtifactType.TAILORED_RESUME, path=resume_path, render_format=RenderFormat.TEXT),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at=updated_at,
    )
    return approved.with_resume_pdf(
        _artifact(ArtifactType.RESUME_PDF, path=pdf_path, render_format=RenderFormat.HTML_PDF),
        updated_at=updated_at,
    )


def _gen1_approved() -> MaterialsSet:
    base = MaterialsSet.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(JOB_URL),
        created_at="2024-01-01T00:00:00+00:00",
    )
    return _approve_with_pdf(
        base,
        resume_path="/tmp/uow_g1.txt",
        pdf_path="/tmp/uow_g1.pdf",
        updated_at="2024-01-02T00:00:00+00:00",
    )


def _provenance_set(generation: int, *, artifact_id: str, text: str) -> BulletProvenanceSet:
    return BulletProvenanceSet(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(JOB_URL),
        generation=generation,
        artifact_id=artifact_id,
        bullets=(
            BulletProvenance(
                bullet_id="experience:acme_swe#0",
                section="experience",
                source_id="acme_swe",
                evidence_ids=("ev_latency",),
                requirement_ids=("req_latency",),
                matched_keywords=("latency",),
                transform_type=TransformType.REPHRASE,
                control=ControlRule.REPHRASE_ALLOWED,
                rationale="reworded a real profile bullet",
                generated_text=text,
            ),
        ),
    )


class _FailAfterNSaves:
    """Delegates to a real repository but raises on the Nth ``save`` call.

    Models a crash / disk error partway through the flip: earlier writes are
    already staged in the (deferred) transaction when the failure fires.
    """

    def __init__(self, inner: object, *, fail_on: int) -> None:
        self._inner = inner
        self._fail_on = fail_on
        self.calls = 0

    def save(self, arg: object) -> None:
        self.calls += 1
        if self.calls >= self._fail_on:
            raise RuntimeError("simulated crash mid-flip")
        self._inner.save(arg)

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)


def _next_generation_approved(materials_repo: SqliteMaterialsRepository) -> tuple[MaterialsSet, MaterialsSet]:
    """Return ``(superseded_gen1, approved_gen2)`` from the persisted gen 1."""
    superseded, fresh = MaterialsSetFactory.next_generation(
        materials_repo.load(LOCAL_TENANT, JobId(JOB_URL)),
        created_at="2024-01-03T00:00:00+00:00",
    )
    gen2 = _approve_with_pdf(
        fresh,
        resume_path="/tmp/uow_g2.txt",
        pdf_path="/tmp/uow_g2.pdf",
        updated_at="2024-01-03T00:00:00+00:00",
    )
    return superseded, gen2


# ---------------------------------------------------------------------------
# With the unit of work: the flip is atomic
# ---------------------------------------------------------------------------


def test_flip_rolls_back_when_new_generation_save_fails(conn: sqlite3.Connection) -> None:
    """A crash between the supersede and the new-generation save must leave the
    prior approved generation current (rollback), not ``None``."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    materials.save(_gen1_approved())

    superseded, gen2 = _next_generation_approved(materials)
    failing = _FailAfterNSaves(materials, fail_on=2)  # supersede stages, gen-2 save raises

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        with uow:
            failing.save(superseded)
            failing.save(gen2)

    current = materials.load_current_approved(LOCAL_TENANT, JobId(JOB_URL))
    assert current is not None
    assert current.generation == 1
    assert current.is_resume_approved
    assert current.tailored_resume is not None
    assert current.tailored_resume.status is ArtifactStatus.APPROVED
    # The rolled-back generation 2 left no row behind.
    assert materials.load(LOCAL_TENANT, JobId(JOB_URL), generation=2) is None


def test_flip_rolls_back_when_provenance_save_fails(conn: sqlite3.Connection) -> None:
    """A provenance write failure must roll the WHOLE flip back: the prior
    generation stays current with its provenance, and the new generation leaves
    neither an artifact row nor orphaned provenance behind."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    provenance = SqliteBulletProvenanceRepository(conn, unit_of_work=uow)

    materials.save(_gen1_approved())
    gen1_artifact_id = (
        materials.load(LOCAL_TENANT, JobId(JOB_URL)).tailored_resume.artifact_id  # type: ignore[union-attr]
    )
    provenance.save(_provenance_set(1, artifact_id=gen1_artifact_id, text="Gen 1 grounded bullet."))

    superseded, gen2 = _next_generation_approved(materials)
    gen2_artifact_id = gen2.tailored_resume.artifact_id  # type: ignore[union-attr]
    failing_provenance = _FailAfterNSaves(provenance, fail_on=1)

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        with uow:
            materials.save(superseded)
            materials.save(gen2)
            failing_provenance.save(
                _provenance_set(2, artifact_id=gen2_artifact_id, text="Gen 2 grounded bullet.")
            )

    # Preservation invariant: generation 1 is still the current approved resume.
    current = materials.load_current_approved(LOCAL_TENANT, JobId(JOB_URL))
    assert current is not None
    assert current.generation == 1
    assert current.is_resume_approved
    # Generation 1 provenance survived; generation 2 orphaned nothing.
    assert provenance.load(LOCAL_TENANT, JobId(JOB_URL), generation=1) is not None
    assert provenance.load(LOCAL_TENANT, JobId(JOB_URL), generation=2) is None
    assert materials.load(LOCAL_TENANT, JobId(JOB_URL), generation=2) is None


def test_flip_commits_once_on_success(conn: sqlite3.Connection) -> None:
    """The happy path is unchanged: a clean flip commits the supersede, the new
    generation, and its provenance together."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    provenance = SqliteBulletProvenanceRepository(conn, unit_of_work=uow)

    materials.save(_gen1_approved())
    superseded, gen2 = _next_generation_approved(materials)
    gen2_artifact_id = gen2.tailored_resume.artifact_id  # type: ignore[union-attr]

    with uow:
        materials.save(superseded)
        materials.save(gen2)
        provenance.save(
            _provenance_set(2, artifact_id=gen2_artifact_id, text="Gen 2 grounded bullet.")
        )

    current = materials.load_current_approved(LOCAL_TENANT, JobId(JOB_URL))
    assert current is not None and current.generation == 2 and current.is_resume_approved
    assert provenance.load(LOCAL_TENANT, JobId(JOB_URL), generation=2) is not None
    # Generation 1 was superseded, so it is no longer the current approved resume,
    # but its row is retained as audit history.
    assert materials.load(LOCAL_TENANT, JobId(JOB_URL), generation=1) is not None


# ---------------------------------------------------------------------------
# Control: without the unit of work the flip is NOT atomic (pre-A9 behaviour)
# ---------------------------------------------------------------------------


def test_without_unit_of_work_new_generation_failure_loses_current_resume(
    conn: sqlite3.Connection,
) -> None:
    """Documents the bug the unit of work fixes: with per-call commits, a crash
    between the supersede and the new-generation save commits the supersede on its
    own, leaving the job with NO current approved resume."""
    materials = SqliteMaterialsRepository(conn)  # no unit of work -> eager commits
    materials.save(_gen1_approved())

    superseded, gen2 = _next_generation_approved(materials)
    failing = _FailAfterNSaves(materials, fail_on=2)

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        failing.save(superseded)  # commits immediately
        failing.save(gen2)  # never runs

    assert materials.load_current_approved(LOCAL_TENANT, JobId(JOB_URL)) is None


def test_without_unit_of_work_provenance_failure_orphans_approved_generation(
    conn: sqlite3.Connection,
) -> None:
    """Documents the audit-invariant bug: with per-call commits, generation 2's
    artifact commits before the provenance write fails, leaving an approved
    generation with no provenance."""
    materials = SqliteMaterialsRepository(conn)
    provenance = SqliteBulletProvenanceRepository(conn)

    materials.save(_gen1_approved())
    superseded, gen2 = _next_generation_approved(materials)
    failing_provenance = _FailAfterNSaves(provenance, fail_on=1)

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        materials.save(superseded)  # commits
        materials.save(gen2)  # commits
        failing_provenance.save(_provenance_set(2, artifact_id="art-gen2", text="orphan"))

    current = materials.load_current_approved(LOCAL_TENANT, JobId(JOB_URL))
    assert current is not None and current.generation == 2
    assert provenance.load(LOCAL_TENANT, JobId(JOB_URL), generation=2) is None
