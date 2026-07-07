from __future__ import annotations

from pathlib import Path

from jobctrl.database import init_db
from jobctrl.domain.scoring import ScoringPolicy
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.scoring.eval import (
    ScoringEvalPrediction,
    ScoringPolicyEvalCase,
    build_scoring_governance_report,
    evaluate_predictions,
    evaluate_policy_resolution,
    load_cases,
    prediction_from_payload,
    resolve_policy_predictions,
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


def test_policy_resolution_eval_is_independent_from_raw_llm_score() -> None:
    policy = ScoringPolicy.default(LOCAL_TENANT)
    cases = [
        ScoringPolicyEvalCase(
            job_id="similar-raw-low",
            dimensions={"technical_fit": 8, "experience_fit": 7, "role_fit": 8},
            expected_fit_score=8,
            expected_fit_band="strong",
            raw_llm_score=6,
            ideal_rank=2,
            consistency_group="platform-leadership",
        ),
        ScoringPolicyEvalCase(
            job_id="similar-raw-high",
            dimensions={"technical_fit": 8, "experience_fit": 7, "role_fit": 8},
            expected_fit_score=8,
            expected_fit_band="strong",
            raw_llm_score=9,
            ideal_rank=3,
            consistency_group="platform-leadership",
        ),
        ScoringPolicyEvalCase(
            job_id="materially-stronger",
            dimensions={"technical_fit": 9, "experience_fit": 9, "role_fit": 8},
            expected_fit_score=9,
            expected_fit_band="excellent",
            raw_llm_score=7,
            ideal_rank=1,
        ),
        ScoringPolicyEvalCase(
            job_id="materially-weaker",
            dimensions={"technical_fit": 4, "experience_fit": 4, "role_fit": 4},
            expected_fit_score=4,
            expected_fit_band="stretch",
            raw_llm_score=8,
            ideal_rank=4,
        ),
    ]

    predictions = resolve_policy_predictions(cases, policy)
    report = evaluate_policy_resolution(cases, policy, k=4)

    assert [(item.job_id, item.policy_score, item.policy_fit_band) for item in predictions] == [
        ("similar-raw-low", 8, "strong"),
        ("similar-raw-high", 8, "strong"),
        ("materially-stronger", 9, "excellent"),
        ("materially-weaker", 4, "stretch"),
    ]
    assert report.to_dict() == {
        "policy_score_accuracy": 1.0,
        "policy_band_accuracy": 1.0,
        "raw_llm_band_accuracy": 0.0,
        "consistency_group_agreement": 1.0,
        "ndcg_at_k": 1.0,
    }


def test_governance_report_does_not_initialize_policy_rows(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    before = conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0]

    report = build_scoring_governance_report(conn)
    after = conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0]

    assert before == 0
    assert after == 0
    assert report.to_dict() == {
        "policy_version": 1,
        "rubric_version": "default-scoring-rubric-v1",
        "anchor_count": 0,
        "stale_unresolved_count": 0,
        "stale_resolved_count": 0,
        "correction_signal_count": 0,
        "correction_agreement": None,
    }
