"""Local scoring evaluation harness.

The harness is intentionally fixture-driven and pure Python: tests feed
synthetic/redacted labels and predicted score payloads, then compute metrics
without opening the user's local database or profile files.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from jobhunter.domain.scoring.value_objects import fit_band_for_score


@dataclass(frozen=True)
class ScoringEvalCase:
    job_id: str
    expected_fit_band: str
    known_blockers: tuple[str, ...] = ()
    corrected_score: int | None = None
    ideal_rank: int | None = None


@dataclass(frozen=True)
class ScoringEvalPrediction:
    job_id: str
    score: int | None
    fit_band: str | None
    hard_blockers: tuple[str, ...] = ()


@dataclass(frozen=True)
class ScoringEvalReport:
    parse_validity: float
    band_accuracy: float
    blocker_precision: float
    blocker_recall: float
    ndcg_at_k: float
    correction_agreement: float | None

    def to_dict(self) -> dict[str, float | None]:
        return {
            "parse_validity": self.parse_validity,
            "band_accuracy": self.band_accuracy,
            "blocker_precision": self.blocker_precision,
            "blocker_recall": self.blocker_recall,
            "ndcg_at_k": self.ndcg_at_k,
            "correction_agreement": self.correction_agreement,
        }


def load_cases(path: Path | str) -> tuple[ScoringEvalCase, ...]:
    parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(parsed, list):
        raise ValueError("scoring eval fixture must be a JSON array")
    return tuple(
        ScoringEvalCase(
            job_id=str(item["job_id"]),
            expected_fit_band=str(item["expected_fit_band"]),
            known_blockers=tuple(str(value) for value in item.get("known_blockers", [])),
            corrected_score=(
                int(item["corrected_score"])
                if item.get("corrected_score") is not None
                else None
            ),
            ideal_rank=int(item["ideal_rank"]) if item.get("ideal_rank") is not None else None,
        )
        for item in parsed
    )


def evaluate_predictions(
    cases: Iterable[ScoringEvalCase],
    predictions: Iterable[ScoringEvalPrediction],
    *,
    k: int = 10,
) -> ScoringEvalReport:
    case_list = list(cases)
    by_job = {prediction.job_id: prediction for prediction in predictions}
    predicted = [by_job.get(case.job_id) for case in case_list]

    parse_validity = _ratio(sum(1 for item in predicted if item and item.score is not None), len(case_list))
    band_accuracy = _ratio(
        sum(
            1
            for case, prediction in zip(case_list, predicted, strict=True)
            if prediction and _prediction_band(prediction) == case.expected_fit_band
        ),
        len(case_list),
    )
    blocker_precision, blocker_recall = _blocker_metrics(case_list, by_job)
    ndcg = _ndcg_at_k(case_list, by_job, k)
    correction_agreement = _correction_agreement(case_list, by_job)
    return ScoringEvalReport(
        parse_validity=parse_validity,
        band_accuracy=band_accuracy,
        blocker_precision=blocker_precision,
        blocker_recall=blocker_recall,
        ndcg_at_k=ndcg,
        correction_agreement=correction_agreement,
    )


def prediction_from_payload(job_id: str, payload: dict[str, Any] | None) -> ScoringEvalPrediction:
    if not isinstance(payload, dict):
        return ScoringEvalPrediction(job_id=job_id, score=None, fit_band=None)
    score = _optional_int(payload.get("score"))
    eligibility = payload.get("eligibility") if isinstance(payload.get("eligibility"), dict) else {}
    blockers = tuple(str(item) for item in eligibility.get("hard_blockers", []) if str(item).strip())
    return ScoringEvalPrediction(
        job_id=job_id,
        score=score if score is not None and 1 <= score <= 10 else None,
        fit_band=str(payload.get("fit_band") or "") or None,
        hard_blockers=blockers,
    )


def _prediction_band(prediction: ScoringEvalPrediction) -> str | None:
    if prediction.fit_band:
        return prediction.fit_band
    if prediction.score is not None:
        return fit_band_for_score(prediction.score)
    return None


def _blocker_metrics(
    cases: list[ScoringEvalCase],
    by_job: dict[str, ScoringEvalPrediction],
) -> tuple[float, float]:
    true_positive = false_positive = false_negative = 0
    for case in cases:
        expected = bool(case.known_blockers)
        predicted = bool(by_job.get(case.job_id, ScoringEvalPrediction(case.job_id, None, None)).hard_blockers)
        if expected and predicted:
            true_positive += 1
        elif not expected and predicted:
            false_positive += 1
        elif expected and not predicted:
            false_negative += 1
    precision = _ratio(true_positive, true_positive + false_positive)
    recall = _ratio(true_positive, true_positive + false_negative)
    return precision, recall


def _ndcg_at_k(
    cases: list[ScoringEvalCase],
    by_job: dict[str, ScoringEvalPrediction],
    k: int,
) -> float:
    rankable = [case for case in cases if case.ideal_rank is not None]
    if not rankable:
        return 0.0
    predicted_order = sorted(
        rankable,
        key=lambda case: by_job.get(case.job_id, ScoringEvalPrediction(case.job_id, None, None)).score or 0,
        reverse=True,
    )[:k]
    ideal_order = sorted(rankable, key=lambda case: case.ideal_rank or 999)[:k]
    return _dcg(predicted_order) / max(_dcg(ideal_order), 1e-9)


def _dcg(cases: list[ScoringEvalCase]) -> float:
    total = 0.0
    for index, case in enumerate(cases, start=1):
        relevance = 1.0 / max(case.ideal_rank or index, 1)
        total += relevance / math.log2(index + 1)
    return total


def _correction_agreement(
    cases: list[ScoringEvalCase],
    by_job: dict[str, ScoringEvalPrediction],
) -> float | None:
    labeled = [case for case in cases if case.corrected_score is not None]
    if not labeled:
        return None
    agreed = 0
    for case in labeled:
        predicted = by_job.get(case.job_id)
        if predicted and predicted.score is not None and abs(predicted.score - int(case.corrected_score or 0)) <= 1:
            agreed += 1
    return _ratio(agreed, len(labeled))


def _optional_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator
