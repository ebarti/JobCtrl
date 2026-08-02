"""Fixture-driven resume tailoring quality evals."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.adversarial import (
    AdversarialReviewResult,
    normalized_job_fit_score,
    should_run_adversarial_review,
)
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.quality import (
    build_tailoring_plan,
    evaluate_tailoring_quality,
)
from jobctrl.domain.tenant import LOCAL_TENANT


FIXTURE = Path(__file__).parent / "fixtures" / "resume_tailoring_quality_eval.json"
JOB_ID = JobId("00000000-0000-4000-8000-000000000042")


def _employer_analysis(*keywords: str) -> EmployerAnalysis:
    """Minimal canonical analysis supplying the fixture's covered keywords (D-21)."""
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[],
        keywords=[ReasonedKeyword(keyword=term, evidence_span=term) for term in keywords],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(" ".join(keywords) or "jd"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_tailoring_quality_eval_fixture_is_synthetic(fixture: dict[str, Any]) -> None:
    assert fixture["scenario"] == "resume_tailoring_quality_regression"
    assert all("example.com" in job["url"] for job in fixture["jobs"].values())
    assert fixture["profile"]["personal"]["email"] == "jane@example.com"


def test_tailoring_quality_eval_preserves_claim_safety_controls(
    fixture: dict[str, Any],
) -> None:
    plan = build_tailoring_plan(
        fixture["profile"],
        _job_for_plan(fixture["jobs"]["high_fit_senior_backend"]),
        employer_analysis=_employer_analysis("python", "latency"),
    )

    assert plan.claim_mode == "adjacent_translation"
    assert plan.allow_adjacent_achievement_drafts is False
    assert plan.auto_approvable_claim_modes == ("verified_only", "evidence_reframing")
    assert "draft_requires_confirmation" not in plan.auto_approvable_claim_modes


def test_tailoring_quality_eval_covers_combined_failure_modes(
    fixture: dict[str, Any],
) -> None:
    assert {case["id"] for case in fixture["quality_cases"]} == {
        "supported_high_fit_resume_passes",
        "unsupported_metric_blocks",
        "seniority_mismatch_blocks_senior_role",
        "keyword_stuffing_blocks",
        "stock_phrase_signal_warns",
        "missing_evidence_blocks",
    }

    for case in fixture["quality_cases"]:
        job = _job_for_plan(fixture["jobs"][case["job"]])
        # The analysis reflects the job: its keywords are the job's skills (lower-
        # cased) plus the canonical backend terms, so required-evidence selection
        # mirrors what a real ensemble analysis of this posting would drive.
        job_keywords = [str(skill).lower() for skill in job.get("skills", [])]
        plan = build_tailoring_plan(
            fixture["profile"],
            job,
            employer_analysis=_employer_analysis("python", "latency", *job_keywords),
        )
        result = evaluate_tailoring_quality(
            _payload(case["bullet"]),
            _resume_text(case["bullet"]),
            plan,
        )
        expected = case["expected"]

        assert result.passed is expected["passed"], (case["id"], result.to_dict())
        for expected_error in expected.get("errors_contain", []):
            assert any(expected_error in error for error in result.errors), (
                case["id"],
                result.to_dict(),
            )
        for expected_warning in expected.get("warnings_contain", []):
            assert any(expected_warning in warning for warning in result.warnings), (
                case["id"],
                result.to_dict(),
            )
        for evidence_id in expected.get("represented_evidence_ids", []):
            assert evidence_id in result.represented_evidence_ids, (
                case["id"],
                result.to_dict(),
            )
        for keyword in expected.get("covered_keywords", []):
            assert keyword in result.covered_keywords, (case["id"], result.to_dict())


def test_high_fit_adversarial_eval_blocks_persona_findings(
    fixture: dict[str, Any],
) -> None:
    for case in fixture["adversarial_cases"]:
        job = fixture["jobs"][case["job"]]
        expected = case["expected"]

        assert should_run_adversarial_review(job) is expected["should_run"]
        if not expected["should_run"]:
            continue

        result = AdversarialReviewResult.from_response(
            case["response"],
            threshold=0.8,
            normalized_fit_score=normalized_job_fit_score(job),
        )

        assert result.passed is expected["passed"], (case["id"], result.to_dict())
        for blocker in expected.get("blockers_contain", []):
            assert any(blocker in value for value in result.blockers), (
                case["id"],
                result.to_dict(),
            )


def _payload(bullet: str) -> dict[str, Any]:
    return {
        "executive_profile": "Senior backend engineer focused on Python API reliability.",
        "experience_updates": [
            {"id": "acme_swe", "title": "", "bullets": [bullet]},
        ],
        "skill_category_updates": [
            {"id": "languages", "items": ["Python", "Go"]},
        ],
    }


def _job_for_plan(job: dict[str, Any]) -> dict[str, Any]:
    return {**job, "job_id": JOB_ID}


def _resume_text(bullet: str) -> str:
    return (
        "Jane Doe\n\n"
        "EXECUTIVE PROFILE\nSenior backend engineer focused on Python API reliability.\n\n"
        "EXPERIENCE\nSenior Software Engineer | Acme Corp\nRemote | 2020-Present\n"
        f"- {bullet}\n\n"
        "EDUCATION\nBSc Computer Science\nState University | City | 2015\n\n"
        "SKILLS\nLanguages: Python, Go"
    )
