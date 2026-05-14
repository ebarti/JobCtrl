from __future__ import annotations

from pathlib import Path

from jobhunter.scoring.eval import (
    ScoringEvalPrediction,
    evaluate_predictions,
    load_cases,
    prediction_from_payload,
)


FIXTURE = Path(__file__).parent / "fixtures" / "scoring_eval_cases.json"


def test_scoring_eval_metrics_cover_parse_band_blockers_ranking_and_corrections() -> None:
    cases = load_cases(FIXTURE)
    predictions = [
        ScoringEvalPrediction("synthetic-platform-lead", 9, "excellent"),
        ScoringEvalPrediction(
            "synthetic-onsite-sponsorship-blocker",
            3,
            "stretch",
            hard_blockers=("candidate requires sponsorship but posting says sponsorship is unavailable",),
        ),
        ScoringEvalPrediction("synthetic-adjacent-infra-role", 8, "strong"),
    ]

    report = evaluate_predictions(cases, predictions, k=3)

    assert report.to_dict() == {
        "parse_validity": 1.0,
        "band_accuracy": 1.0,
        "blocker_precision": 1.0,
        "blocker_recall": 1.0,
        "ndcg_at_k": 1.0,
        "correction_agreement": 1.0,
    }


def test_prediction_from_payload_marks_invalid_parse_without_user_data() -> None:
    valid = prediction_from_payload(
        "job-1",
        {
            "score": 8,
            "fit_band": "strong",
            "eligibility": {"hard_blockers": ["below minimum salary"]},
        },
    )
    invalid = prediction_from_payload("job-2", {"score": 0, "fit_band": "poor"})

    assert valid.score == 8
    assert valid.hard_blockers == ("below minimum salary",)
    assert invalid.score is None
