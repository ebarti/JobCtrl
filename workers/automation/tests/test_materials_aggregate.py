"""Phase 6 / S-19: MaterialsSet aggregate + Artifact + value-object invariants.

These tests pin the constructor invariants so the aggregate, its
artifact entity, and the supporting value objects refuse to accept
invalid data. Behaviour exercised here is pure data — no I/O — so a
failure points straight at the type definitions.
"""

from __future__ import annotations

import pytest

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
from jobhunter.domain.materials.aggregate import MaterialsLifecycle
from jobhunter.domain.tenant import LOCAL_TENANT


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------


def test_validation_result_success_has_no_errors() -> None:
    result = ValidationResult.success()
    assert result.passed is True
    assert result.errors == ()
    assert result.warnings == ()


def test_validation_result_failure_recomputes_passed() -> None:
    # Constructor should refuse to claim ``passed=True`` while errors exist.
    result = ValidationResult(passed=True, errors=("bad",))
    assert result.passed is False
    assert result.errors == ("bad",)


def test_validation_result_failure_requires_errors() -> None:
    with pytest.raises(ValueError):
        ValidationResult.failure(())


def test_validation_result_round_trips_through_dict() -> None:
    original = ValidationResult.failure(("err",), warnings=("warn",))
    restored = ValidationResult.from_dict(original.to_dict())
    assert restored == original


def test_judge_verdict_score_must_be_in_unit_range() -> None:
    with pytest.raises(ValueError):
        JudgeVerdict(approved=True, score=1.5)
    with pytest.raises(ValueError):
        JudgeVerdict(approved=True, score=-0.1)


def test_judge_verdict_factories() -> None:
    passed = JudgeVerdict.passed(score=0.9, notes="strong")
    failed = JudgeVerdict.failed(score=0.1, notes="weak")
    assert passed.approved is True and passed.score == 0.9
    assert failed.approved is False and failed.score == 0.1


# ---------------------------------------------------------------------------
# Artifact entity
# ---------------------------------------------------------------------------


def _sample_artifact(artifact_type: ArtifactType = ArtifactType.TAILORED_RESUME) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path="/tmp/resume.txt",
        created_at="2024-01-01T00:00:00+00:00",
        render_format=RenderFormat.TEXT,
        size_bytes=128,
    )


def test_artifact_create_assigns_artifact_id_and_defaults_to_candidate() -> None:
    artifact = _sample_artifact()
    assert artifact.artifact_id
    assert artifact.status is ArtifactStatus.CANDIDATE
    assert artifact.superseded_at is None


def test_artifact_supersede_requires_timestamp() -> None:
    artifact = _sample_artifact()
    with pytest.raises(ValueError):
        artifact.supersede(at="")
    superseded = artifact.supersede(at="2024-02-01T00:00:00+00:00")
    assert superseded.status is ArtifactStatus.SUPERSEDED
    assert superseded.superseded_at == "2024-02-01T00:00:00+00:00"


def test_artifact_with_status_supersede_requires_timestamp_via_helper() -> None:
    artifact = _sample_artifact()
    with pytest.raises(ValueError):
        artifact.with_status(ArtifactStatus.SUPERSEDED)


def test_artifact_rejects_negative_size_bytes() -> None:
    with pytest.raises(ValueError):
        Artifact(
            artifact_id="x",
            type=ArtifactType.TAILORED_RESUME,
            status=ArtifactStatus.CANDIDATE,
            path="/tmp/a",
            render_format=RenderFormat.TEXT,
            created_at="2024-01-01T00:00:00+00:00",
            size_bytes=-1,
        )


def test_artifact_round_trips_through_dict() -> None:
    artifact = _sample_artifact().approve()
    restored = Artifact.from_dict(artifact.to_dict())
    assert restored == artifact


# ---------------------------------------------------------------------------
# MaterialsSet aggregate
# ---------------------------------------------------------------------------


def _initial_materials() -> MaterialsSet:
    return MaterialsSet.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/1"),
        created_at="2024-01-01T00:00:00+00:00",
    )


def test_materials_set_initial_starts_at_generation_one() -> None:
    materials = _initial_materials()
    assert materials.generation == 1
    assert materials.status == MaterialsLifecycle.RESUME_IN_PROGRESS
    assert materials.tailored_resume is None


def test_materials_set_rejects_zero_generation() -> None:
    with pytest.raises(ValueError):
        MaterialsSet(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            generation=0,
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )


def test_materials_set_rejects_unknown_status() -> None:
    with pytest.raises(ValueError):
        MaterialsSet(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            generation=1,
            status="bogus",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )


def test_materials_set_invariant_cover_requires_resume() -> None:
    with pytest.raises(ValueError, match="cover letter present without tailored resume"):
        MaterialsSet(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            generation=1,
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
            cover_letter=_sample_artifact(ArtifactType.COVER_LETTER),
        )


def test_materials_set_invariant_resume_pdf_requires_resume() -> None:
    with pytest.raises(ValueError, match="resume PDF present without tailored resume"):
        MaterialsSet(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            generation=1,
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
            resume_pdf=_sample_artifact(ArtifactType.RESUME_PDF),
        )


def test_with_resume_attempt_passed_validation_and_judge_promotes_status() -> None:
    materials = _initial_materials()
    artifact = _sample_artifact()
    next_materials = materials.with_resume_attempt(
        artifact,
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    assert next_materials.is_resume_approved
    assert next_materials.status == MaterialsLifecycle.RESUME_APPROVED
    assert next_materials.tailored_resume is not None
    assert next_materials.tailored_resume.status is ArtifactStatus.APPROVED


def test_with_resume_attempt_failed_validation_keeps_in_progress_with_rejected_artifact() -> None:
    materials = _initial_materials()
    artifact = _sample_artifact()
    next_materials = materials.with_resume_attempt(
        artifact,
        validation=ValidationResult.failure(("bad",)),
        verdict=None,
        updated_at="2024-01-02T00:00:00+00:00",
    )
    assert next_materials.is_resume_approved is False
    assert next_materials.status == MaterialsLifecycle.RESUME_IN_PROGRESS
    assert next_materials.tailored_resume is not None
    assert next_materials.tailored_resume.status is ArtifactStatus.REJECTED


def test_with_resume_attempt_rejected_clears_downstream_artifacts() -> None:
    """Round-2 review L1: a rejected re-attempt within the same generation
    clears the prior cover_letter / resume_pdf / cover_letter_pdf so the
    aggregate cannot carry an APPROVED downstream paired with a REJECTED
    upstream."""
    materials = _initial_materials().with_resume_attempt(
        _sample_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_cover_letter(
        _sample_artifact(ArtifactType.COVER_LETTER),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    ).with_resume_pdf(
        _sample_artifact(ArtifactType.RESUME_PDF),
        updated_at="2024-01-03T00:00:00+00:00",
    ).with_cover_letter_pdf(
        _sample_artifact(ArtifactType.COVER_LETTER_PDF),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    # Confirm baseline.
    assert materials.cover_letter is not None
    assert materials.resume_pdf is not None
    assert materials.cover_letter_pdf is not None

    # New rejected attempt — downstream artifacts must be cleared.
    rejected = materials.with_resume_attempt(
        _sample_artifact(),
        validation=ValidationResult.failure(("validator hated it",)),
        verdict=None,
        updated_at="2024-01-04T00:00:00+00:00",
    )
    assert rejected.tailored_resume is not None
    assert rejected.tailored_resume.status is ArtifactStatus.REJECTED
    assert rejected.cover_letter is None
    assert rejected.resume_pdf is None
    assert rejected.cover_letter_pdf is None
    assert rejected.status == MaterialsLifecycle.RESUME_IN_PROGRESS


def test_with_cover_letter_requires_approved_resume() -> None:
    materials = _initial_materials()
    artifact = _sample_artifact(ArtifactType.COVER_LETTER)
    with pytest.raises(ValueError, match="resume is approved"):
        materials.with_cover_letter(
            artifact,
            validation=ValidationResult.success(),
            updated_at="2024-01-02T00:00:00+00:00",
        )


def test_with_cover_letter_passed_promotes_to_cover_letter_ready() -> None:
    materials = _initial_materials().with_resume_attempt(
        _sample_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    next_materials = materials.with_cover_letter(
        _sample_artifact(ArtifactType.COVER_LETTER),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    assert next_materials.status == MaterialsLifecycle.COVER_LETTER_READY


def test_pdf_attaches_only_after_text_present() -> None:
    materials = _initial_materials().with_resume_attempt(
        _sample_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    next_materials = materials.with_resume_pdf(
        _sample_artifact(ArtifactType.RESUME_PDF),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    assert next_materials.resume_pdf is not None
    assert next_materials.resume_pdf.status is ArtifactStatus.APPROVED


def test_supersede_all_marks_every_artifact_superseded() -> None:
    materials = _initial_materials().with_resume_attempt(
        _sample_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    superseded = materials.supersede_all(at="2024-01-04T00:00:00+00:00")
    assert superseded.tailored_resume is not None
    assert superseded.tailored_resume.status is ArtifactStatus.SUPERSEDED
    assert superseded.tailored_resume.superseded_at == "2024-01-04T00:00:00+00:00"


# ---------------------------------------------------------------------------
# MaterialsSetFactory.next_generation
# ---------------------------------------------------------------------------


def test_next_generation_returns_superseded_previous_and_fresh_next() -> None:
    materials = _initial_materials().with_resume_attempt(
        _sample_artifact(),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    superseded, fresh = MaterialsSetFactory.next_generation(
        materials, created_at="2024-01-05T00:00:00+00:00"
    )
    assert superseded.tailored_resume is not None
    assert superseded.tailored_resume.status is ArtifactStatus.SUPERSEDED
    assert fresh.generation == materials.generation + 1
    assert fresh.tailored_resume is None
    assert fresh.status == MaterialsLifecycle.RESUME_IN_PROGRESS
