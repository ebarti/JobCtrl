"""Phase 8 (S-28): ApplyEligibilityChecker pure-function tests."""

import pytest

from jobctl.domain.apply.services import ApplyEligibilityChecker


@pytest.fixture()
def checker():
    return ApplyEligibilityChecker(max_attempts=3)


def _ready_job():
    return {
        "url": "https://example.com/job",
        "application_url": "https://example.com/apply",
        "tailored_resume_path": "/tmp/resume.txt",
        "applied_at": None,
        "apply_status": None,
    }


def test_ready_job_is_eligible(checker):
    assert checker.check(job=_ready_job()).is_eligible


def test_missing_resume_pdf_blocks_canonical_materials(checker):
    job = _ready_job()
    job["materials_generation"] = 1
    job["resume_pdf_path"] = None

    result = checker.check(job=job)

    assert not result.ok
    assert result.reason == "missing_resume_pdf"


def test_canonical_materials_with_resume_pdf_is_eligible(checker):
    job = _ready_job()
    job["materials_generation"] = 1
    job["resume_pdf_path"] = "/tmp/resume.pdf"

    assert checker.check(job=job).is_eligible


def test_missing_apply_target_url_blocks(checker):
    job = _ready_job()
    job["application_url"] = ""
    job["url"] = ""
    result = checker.check(job=job)
    assert not result.ok
    assert result.reason == "missing_apply_target_url"


def test_missing_tailored_resume_blocks(checker):
    job = _ready_job()
    job["tailored_resume_path"] = None
    result = checker.check(job=job)
    assert not result.ok
    assert result.reason == "missing_tailored_resume"


def test_already_applied_legacy_column_blocks(checker):
    job = _ready_job()
    job["applied_at"] = "2024-01-01T00:00:00Z"
    assert checker.check(job=job).reason == "already_applied"


def test_already_applied_canonical_status_blocks(checker):
    job = _ready_job()
    job["apply_status"] = "applied"
    assert checker.check(job=job).reason == "already_applied"


def test_max_attempts_blocks(checker):
    assert checker.check(job=_ready_job(), attempts=3).reason == "max_attempts_reached"


def test_max_attempts_must_be_positive():
    with pytest.raises(ValueError):
        ApplyEligibilityChecker(max_attempts=0)
