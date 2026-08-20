"""High-fit adversarial resume review helper tests."""

from __future__ import annotations

from jobctrl.domain.materials.adversarial import (
    AdversarialReviewResult,
    normalized_job_fit_score,
    should_run_adversarial_review,
)


def test_normalized_job_fit_score_uses_current_ten_point_score() -> None:
    assert normalized_job_fit_score({"fit_score": 8}) == 0.8
    assert normalized_job_fit_score({"fitScore": "9"}) == 0.9
    assert normalized_job_fit_score({"fit_score": 0}) is None


def test_normalized_job_fit_score_accepts_explicit_normalized_fields() -> None:
    assert normalized_job_fit_score({"normalized_fit_score": 0.83}) == 0.83
    assert normalized_job_fit_score({"normalizedFitScore": "0.81"}) == 0.81
    assert normalized_job_fit_score({"normalized_fit_score": 1.4}) is None


def test_should_run_adversarial_review_threshold() -> None:
    assert should_run_adversarial_review({"fit_score": 8}) is True
    assert should_run_adversarial_review({"fit_score": 7}) is False
    assert should_run_adversarial_review({"normalized_fit_score": 0.8}) is True


def test_adversarial_review_result_merges_persona_blockers() -> None:
    result = AdversarialReviewResult.from_response(
        {
            "verdict": "PASS",
            "score": 0.9,
            "score_rationale": "Overall pass despite a persona blocker in the fixture.",
            "blockers": [],
            "warnings": ["General warning."],
            "repair_instructions": [],
            "personas": [
                {
                    "persona": "evidence_auditor",
                    "verdict": "FAIL",
                    "score": 0.2,
                    "score_rationale": "Metric support is missing from profile evidence.",
                    "blockers": ["Metric is unsupported."],
                    "warnings": ["Metric wording is vague."],
                    "repair_instructions": ["Remove the metric."],
                }
            ],
        },
        threshold=0.8,
        normalized_fit_score=0.9,
    )

    assert result.passed is False
    assert result.blockers == ("Metric is unsupported.",)
    assert result.warnings == ("General warning.", "Metric wording is vague.")
    assert result.repair_instructions == ("Remove the metric.",)
    assert result.personas[0].score_rationale == "Metric support is missing from profile evidence."
    assert result.to_dict()["personas"][0]["prompt_rubric"]
    assert any("Metric support is missing" in item for item in result.to_dict()["personas"][0]["score_basis"])


def test_voice_pass_adversarial_record_omits_llm_prompt_audit() -> None:
    result = AdversarialReviewResult.from_response(
        {
            "verdict": "PASS",
            "score": 0.9,
            "score_rationale": "All bounded review facts passed.",
            "blockers": [],
            "warnings": [],
            "repair_instructions": [],
            "personas": [],
        },
        threshold=0.8,
        normalized_fit_score=0.9,
        model="judge-a",
        prompt_messages=(
            {"role": "user", "content": "FULL PROFILE SECRET and full resume"},
        ),
    )

    assert "llm_audit" in result.to_dict()
    voice_record = result.to_voice_pass_dict()
    assert "llm_audit" not in voice_record
    assert "FULL PROFILE SECRET" not in str(voice_record)
