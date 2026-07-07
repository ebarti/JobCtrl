"""Phase 5 / S-15: JobScore aggregate + value object invariants.

These tests pin the constructor invariants so the aggregate and its value
objects refuse to accept invalid data. Behaviour exercised here is pure
data — no I/O, no fakes — so failures point straight at the type
definitions.
"""

from __future__ import annotations

import pytest

from jobctl.domain.identifiers import JobId
from jobctl.domain.scoring import (
    EligibilityAssessment,
    FitScore,
    JobScore,
    MatchedKeywords,
    RequirementArtifactCoverage,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
    ScoreBreakdown,
    ScoreCorrection,
    ScoringCriteria,
)
from jobctl.domain.scoring.services import EligibilityChecker, ScoreParser
from jobctl.domain.tenant import LOCAL_TENANT


# ---------------------------------------------------------------------------
# FitScore
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", [1, 5, 10])
def test_fit_score_accepts_in_range(value: int) -> None:
    assert FitScore.create(value).value == value


@pytest.mark.parametrize("value", [0, 11, -3, 100])
def test_fit_score_rejects_out_of_range(value: int) -> None:
    with pytest.raises(ValueError):
        FitScore.create(value)


def test_fit_score_from_optional_returns_none_for_invalid() -> None:
    assert FitScore.from_optional(None) is None
    assert FitScore.from_optional(0) is None
    assert FitScore.from_optional(11) is None
    assert FitScore.from_optional("not-a-number") is None


def test_fit_score_from_optional_passes_through_existing_instance() -> None:
    existing = FitScore.create(7)
    assert FitScore.from_optional(existing) is existing


# ---------------------------------------------------------------------------
# ScoreBreakdown
# ---------------------------------------------------------------------------


def test_score_breakdown_defaults_to_zero_components() -> None:
    bd = ScoreBreakdown()
    assert (bd.technical_fit, bd.experience_fit, bd.role_fit) == (0, 0, 0)
    assert bd.reasoning == ""


def test_score_breakdown_round_trips_through_dict() -> None:
    original = ScoreBreakdown(
        technical_fit=8, experience_fit=7, role_fit=9, reasoning="Strong match"
    )
    restored = ScoreBreakdown.from_dict(original.to_dict())
    assert restored == original


@pytest.mark.parametrize("name", ["technical_fit", "experience_fit", "role_fit"])
def test_score_breakdown_rejects_out_of_range_components(name: str) -> None:
    with pytest.raises(ValueError):
        ScoreBreakdown(**{name: 11})


# ---------------------------------------------------------------------------
# Requirement fit report
# ---------------------------------------------------------------------------


def test_requirement_fit_report_round_trips_through_dict() -> None:
    assessment = RequirementFitAssessment(
        requirement_id="r1",
        requirement_text="Operate as a senior technical engineering leader",
        tier="must_have",
        weight=0.95,
        job_evidence_span="Operate as a senior technical engineering leader",
        fit=RequirementFitStatus(
            kind="matched",
            evidence_ids=("ev-platform-leadership",),
            strength="direct",
        ),
        contribution=RequirementScoreContribution(
            max_points=9.5,
            awarded_points=9.5,
            weighted_impact=0.41,
            rationale="Direct platform leadership evidence covers this requirement.",
        ),
        tailoring=RequirementTailoringDirective(
            action="double_down",
            priority=0.95,
            allowed_evidence_ids=("ev-platform-leadership",),
            target_keywords=("platform leadership",),
            instruction="Make the existing leadership evidence prominent.",
        ),
        artifact_coverage=RequirementArtifactCoverage(
            state="covered",
            bullet_count=1,
            examples=("Led platform engineering across reliability and tooling.",),
        ),
    )
    original = RequirementFitReport(
        job_id="https://example.com/job/1",
        score_version=3,
        employer_analysis_generation=2,
        profile_snapshot_version=7,
        scoring_policy_version=4,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(8),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(
            weighted_fit=0.78,
            must_have_coverage=0.9,
            blocker_count=0,
            missing_high_weight_count=1,
        ),
        assessments=(assessment,),
    )

    restored = RequirementFitReport.from_dict(original.to_dict())

    assert restored == original
    assert restored.assessments[0].fit.evidence_ids == ("ev-platform-leadership",)
    assert restored.assessments[0].tailoring.action == "double_down"
    assert original.to_read_model() == {
        "jobKey": "https://example.com/job/1",
        "scoreVersion": 3,
        "employerAnalysisGeneration": 2,
        "profileSnapshotVersion": 7,
        "scoringPolicyVersion": 4,
        "formulaVersion": "requirement-fit-v1",
        "resolvedFitScore": 8,
        "fitBand": "strong",
        "confidence": "high",
        "summary": {
            "weightedFit": 0.78,
            "mustHaveCoverage": 0.9,
            "blockerCount": 0,
            "missingHighWeightCount": 1,
        },
        "assessments": [
            {
                "requirementId": "r1",
                "requirementText": "Operate as a senior technical engineering leader",
                "tier": "must_have",
                "weight": 0.95,
                "jobEvidenceSpan": "Operate as a senior technical engineering leader",
                "fit": {
                    "kind": "matched",
                    "evidenceIds": ["ev-platform-leadership"],
                    "strength": "direct",
                },
                "contribution": {
                    "maxPoints": 9.5,
                    "awardedPoints": 9.5,
                    "weightedImpact": 0.41,
                    "rationale": "Direct platform leadership evidence covers this requirement.",
                },
                "tailoring": {
                    "action": "double_down",
                    "priority": 0.95,
                    "allowedEvidenceIds": ["ev-platform-leadership"],
                    "targetKeywords": ["platform leadership"],
                    "prohibitedClaims": [],
                    "instruction": "Make the existing leadership evidence prominent.",
                },
                "artifactCoverage": {
                    "state": "covered",
                    "source": "tailored_resume_bullet_provenance",
                    "bulletCount": 1,
                    "examples": ["Led platform engineering across reliability and tooling."],
                },
            }
        ],
    }


def test_requirement_fit_status_requires_evidence_for_matched() -> None:
    with pytest.raises(ValueError, match="matched requirement fit requires"):
        RequirementFitStatus(kind="matched", strength="direct")


def test_requirement_fit_status_requires_reason_for_missing() -> None:
    with pytest.raises(ValueError, match="missing requirement fit requires"):
        RequirementFitStatus(kind="missing")


def test_requirement_score_contribution_rejects_awarded_over_max() -> None:
    with pytest.raises(ValueError, match="cannot exceed"):
        RequirementScoreContribution(max_points=1, awarded_points=2, weighted_impact=1)


# ---------------------------------------------------------------------------
# MatchedKeywords
# ---------------------------------------------------------------------------


def test_matched_keywords_dedupes_case_insensitive() -> None:
    keywords = MatchedKeywords.from_iterable(["Python", "python", "FastAPI", "fastapi"])
    assert keywords.values == ("Python", "FastAPI")


def test_matched_keywords_rejects_empty_strings_after_trim() -> None:
    keywords = MatchedKeywords.from_iterable(["python", "  ", None, "go"])
    assert keywords.values == ("python", "go")


def test_matched_keywords_constructor_rejects_blank_entries() -> None:
    with pytest.raises(ValueError):
        MatchedKeywords(values=("ok", " "))


def test_matched_keywords_must_be_non_empty() -> None:
    """Round-1 review M1: §4.4 invariant — at least one keyword required."""
    with pytest.raises(ValueError, match="at least one keyword"):
        MatchedKeywords(values=())


def test_matched_keywords_default_constructor_uses_legacy_sentinel() -> None:
    """Default constructor falls back to the ``["legacy"]`` sentinel so
    backfill / failure-path code that doesn't carry real keywords stays
    valid without violating the §4.4 non-empty invariant."""
    assert MatchedKeywords().values == ("legacy",)


def test_matched_keywords_from_iterable_collapses_empty_to_sentinel() -> None:
    assert MatchedKeywords.from_iterable([]).values == ("legacy",)
    assert MatchedKeywords.from_iterable(["", "  ", None]).values == ("legacy",)


def test_matched_keywords_csv_round_trip() -> None:
    keywords = MatchedKeywords.from_csv("python, fastapi,  postgres ")
    assert keywords.values == ("python", "fastapi", "postgres")
    assert keywords.to_csv() == "python, fastapi, postgres"


# ---------------------------------------------------------------------------
# ScoreCorrection
# ---------------------------------------------------------------------------


def test_score_correction_requires_non_empty_rationale() -> None:
    with pytest.raises(ValueError):
        ScoreCorrection(
            corrected_fit_score=FitScore.create(8),
            rationale=" ",
            corrected_by=LOCAL_TENANT,
            corrected_at="2024-01-01T00:00:00+00:00",
        )


# ---------------------------------------------------------------------------
# JobScore aggregate
# ---------------------------------------------------------------------------


def _sample_score(version: int = 1, fit: int = 7) -> JobScore:
    return JobScore(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/1"),
        version=version,
        fit_score=FitScore.create(fit),
        breakdown=ScoreBreakdown(reasoning="ok"),
        matched_keywords=MatchedKeywords.from_iterable(["python"]),
        scored_at="2024-01-01T00:00:00+00:00",
    )


def test_job_score_initial_starts_at_version_one() -> None:
    score = JobScore.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("u"),
        fit_score=FitScore.create(7),
        breakdown=ScoreBreakdown(),
        matched_keywords=MatchedKeywords(),
        scored_at="2024-01-01T00:00:00+00:00",
    )
    assert score.version == 1
    assert score.correction is None


def test_job_score_next_version_bumps_and_replaces_fields() -> None:
    base = _sample_score()
    new = base.next_version(
        fit_score=FitScore.create(9),
        breakdown=ScoreBreakdown(reasoning="rescored"),
        matched_keywords=MatchedKeywords.from_iterable(["fastapi"]),
        scored_at="2024-02-01T00:00:00+00:00",
    )
    assert new.version == 2
    assert new.fit_score.value == 9
    assert new.breakdown.reasoning == "rescored"
    # base is unchanged (frozen)
    assert base.version == 1


def test_job_score_with_correction_preserves_breakdown_uses_corrected_score() -> None:
    base = _sample_score(fit=7)
    correction = ScoreCorrection(
        corrected_fit_score=FitScore.create(9),
        rationale="False negative",
        corrected_by=LOCAL_TENANT,
        corrected_at="2024-03-01T00:00:00+00:00",
    )
    corrected = base.with_correction(correction)
    assert corrected.version == base.version + 1
    assert corrected.fit_score.value == 9
    assert corrected.scored_at == correction.corrected_at
    assert corrected.correction is correction
    assert corrected.breakdown == base.breakdown


def test_job_score_rejects_zero_version() -> None:
    with pytest.raises(ValueError):
        JobScore(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            version=0,
            fit_score=FitScore.create(5),
            breakdown=ScoreBreakdown(),
            matched_keywords=MatchedKeywords(),
            scored_at="2024-01-01T00:00:00+00:00",
        )


# ---------------------------------------------------------------------------
# Domain services
# ---------------------------------------------------------------------------


def test_score_parser_happy_path() -> None:
    payload = {
        "score": 8,
        "technical_fit": 8,
        "experience_fit": 7,
        "role_fit": 9,
        "keywords": ["python", "fastapi", "postgres"],
        "reasoning": "Strong technical overlap with the role.",
    }
    result = ScoreParser().parse_json(payload)
    assert result.ok is True
    assert result.fit_score is not None and result.fit_score.value == 8
    assert result.keywords.values == ("python", "fastapi", "postgres")
    assert "Strong technical overlap" in result.breakdown.reasoning
    # Structured-output cutover populates the dimension breakdown.
    assert result.breakdown.technical_fit == 8
    assert result.breakdown.experience_fit == 7
    assert result.breakdown.role_fit == 9


def test_score_parser_rejects_missing_score_field() -> None:
    result = ScoreParser().parse_json({"keywords": ["a"], "reasoning": "nope"})
    assert result.ok is False
    assert result.fit_score is None
    assert "score" in result.error.lower()


def test_score_parser_rejects_out_of_range_score() -> None:
    result = ScoreParser().parse_json(
        {"score": 11, "keywords": [], "reasoning": "too high"}
    )
    assert result.ok is False
    assert result.fit_score is None
    assert "outside" in result.error.lower()


def test_score_parser_rejects_successful_score_with_no_keywords() -> None:
    """Round-1 review M1: a score with no keywords is not a valid scoring
    per §4.4 — the parser surfaces it as ``ok=False`` so the caller
    doesn't accidentally persist a sentinel-keyword score."""
    result = ScoreParser().parse_json(
        {"score": 7, "keywords": [], "reasoning": "missing the keywords"}
    )
    assert result.ok is False
    assert result.fit_score is None
    assert "keywords" in result.error.lower()


def test_score_parser_rejects_non_dict_payload() -> None:
    result = ScoreParser().parse_json("just a string, not a JSON object")
    assert result.ok is False
    assert "expected dict" in result.error.lower()


def test_score_parser_clamps_out_of_range_dimensions() -> None:
    """Per the SCORE_SCHEMA dimensions are 0..10 — providers occasionally
    return values outside that range. Clamp silently rather than rejecting
    the row over a single bad dimension; ``ok`` remains True."""
    payload = {
        "score": 7,
        "technical_fit": 99,
        "experience_fit": -3,
        "role_fit": "not a number",
        "keywords": ["python"],
        "reasoning": "ok",
    }
    result = ScoreParser().parse_json(payload)
    assert result.ok is True
    assert result.breakdown.technical_fit == 10
    assert result.breakdown.experience_fit == 0
    assert result.breakdown.role_fit == 0


def test_eligibility_checker_threshold() -> None:
    checker = EligibilityChecker()
    criteria = ScoringCriteria(min_fit_score=7)
    assert checker.is_eligible(FitScore.create(7), criteria) is True
    assert checker.is_eligible(FitScore.create(6), criteria) is False


def test_eligibility_checker_rejects_hard_blockers_despite_high_score() -> None:
    checker = EligibilityChecker()
    criteria = ScoringCriteria(min_fit_score=7)

    assert (
        checker.is_eligible(
            FitScore.create(9),
            criteria,
            EligibilityAssessment(status="blocked", hard_blockers=("Requires sponsorship.",)),
        )
        is False
    )
