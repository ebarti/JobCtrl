"""Local scoring evaluation harness.

The core harness is intentionally fixture-driven and pure Python: tests feed
synthetic/redacted labels and predicted score payloads, then compute metrics
without opening the user's local database or profile files. The governance
report helper accepts an explicit SQLite connection and returns only aggregate
counts/version metadata so operator review does not expose job URLs,
rationales, anchors, or local paths.
"""

from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from jobctrl.domain.scoring import ScoreBreakdown, ScoringPolicy
from jobctrl.domain.scoring.value_objects import fit_band_for_score
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId


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


@dataclass(frozen=True)
class ScoringPolicyEvalCase:
    job_id: str
    dimensions: Mapping[str, int]
    expected_fit_score: int
    expected_fit_band: str
    raw_llm_score: int | None = None
    ideal_rank: int | None = None
    consistency_group: str = ""


@dataclass(frozen=True)
class ScoringPolicyEvalPrediction:
    job_id: str
    raw_llm_score: int | None
    policy_score: int
    policy_fit_band: str
    raw_weighted_score: float
    consistency_group: str = ""


@dataclass(frozen=True)
class ScoringPolicyEvalReport:
    policy_score_accuracy: float
    policy_band_accuracy: float
    raw_llm_band_accuracy: float | None
    consistency_group_agreement: float | None
    ndcg_at_k: float

    def to_dict(self) -> dict[str, float | None]:
        return {
            "policy_score_accuracy": self.policy_score_accuracy,
            "policy_band_accuracy": self.policy_band_accuracy,
            "raw_llm_band_accuracy": self.raw_llm_band_accuracy,
            "consistency_group_agreement": self.consistency_group_agreement,
            "ndcg_at_k": self.ndcg_at_k,
        }


@dataclass(frozen=True)
class ScoringGovernanceReport:
    policy_version: int
    rubric_version: str
    anchor_count: int
    stale_unresolved_count: int
    stale_resolved_count: int
    correction_signal_count: int
    correction_agreement: float | None = None

    def to_dict(self) -> dict[str, int | float | str | None]:
        return {
            "policy_version": self.policy_version,
            "rubric_version": self.rubric_version,
            "anchor_count": self.anchor_count,
            "stale_unresolved_count": self.stale_unresolved_count,
            "stale_resolved_count": self.stale_resolved_count,
            "correction_signal_count": self.correction_signal_count,
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


def resolve_policy_predictions(
    cases: Iterable[ScoringPolicyEvalCase],
    policy: ScoringPolicy,
) -> tuple[ScoringPolicyEvalPrediction, ...]:
    predictions: list[ScoringPolicyEvalPrediction] = []
    for case in cases:
        resolved = policy.resolve(_breakdown_from_dimensions(case.dimensions))
        predictions.append(
            ScoringPolicyEvalPrediction(
                job_id=case.job_id,
                raw_llm_score=case.raw_llm_score,
                policy_score=resolved.fit_score.value,
                policy_fit_band=resolved.fit_band,
                raw_weighted_score=resolved.raw_weighted_score,
                consistency_group=case.consistency_group,
            )
        )
    return tuple(predictions)


def evaluate_policy_resolution(
    cases: Iterable[ScoringPolicyEvalCase],
    policy: ScoringPolicy,
    *,
    k: int = 10,
) -> ScoringPolicyEvalReport:
    case_list = list(cases)
    predictions = resolve_policy_predictions(case_list, policy)
    by_job = {prediction.job_id: prediction for prediction in predictions}

    policy_score_accuracy = _ratio(
        sum(
            1
            for case in case_list
            if by_job[case.job_id].policy_score == case.expected_fit_score
        ),
        len(case_list),
    )
    policy_band_accuracy = _ratio(
        sum(
            1
            for case in case_list
            if by_job[case.job_id].policy_fit_band == case.expected_fit_band
        ),
        len(case_list),
    )
    raw_labeled = [case for case in case_list if case.raw_llm_score is not None]
    raw_llm_band_accuracy = (
        _ratio(
            sum(
                1
                for case in raw_labeled
                if policy.fit_band_for_score(int(case.raw_llm_score or 0))
                == case.expected_fit_band
            ),
            len(raw_labeled),
        )
        if raw_labeled
        else None
    )
    return ScoringPolicyEvalReport(
        policy_score_accuracy=policy_score_accuracy,
        policy_band_accuracy=policy_band_accuracy,
        raw_llm_band_accuracy=raw_llm_band_accuracy,
        consistency_group_agreement=_consistency_group_agreement(predictions),
        ndcg_at_k=_policy_ndcg_at_k(case_list, by_job, k),
    )


def build_scoring_governance_report(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    correction_agreement: float | None = None,
) -> ScoringGovernanceReport:
    """Return non-sensitive policy/eval governance counters for local QA."""
    policy_version, rubric_version, anchor_count = _current_policy_report_fields(
        conn,
        tenant_id,
    )
    unresolved, resolved = _stale_marker_counts(conn, tenant_id)
    return ScoringGovernanceReport(
        policy_version=policy_version,
        rubric_version=rubric_version,
        anchor_count=anchor_count,
        stale_unresolved_count=unresolved,
        stale_resolved_count=resolved,
        correction_signal_count=_correction_signal_count(conn, tenant_id),
        correction_agreement=correction_agreement,
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


def _breakdown_from_dimensions(dimensions: Mapping[str, int]) -> ScoreBreakdown:
    return ScoreBreakdown(
        technical_fit=int(dimensions.get("technical_fit", 0)),
        experience_fit=int(dimensions.get("experience_fit", 0)),
        role_fit=int(dimensions.get("role_fit", 0)),
        reasoning="synthetic policy eval fixture",
    )


def _consistency_group_agreement(
    predictions: tuple[ScoringPolicyEvalPrediction, ...],
) -> float | None:
    groups: dict[str, list[ScoringPolicyEvalPrediction]] = {}
    for prediction in predictions:
        if prediction.consistency_group:
            groups.setdefault(prediction.consistency_group, []).append(prediction)
    comparable_groups = [items for items in groups.values() if len(items) > 1]
    if not comparable_groups:
        return None
    agreed = 0
    for items in comparable_groups:
        first = items[0]
        if all(
            item.policy_score == first.policy_score
            and item.policy_fit_band == first.policy_fit_band
            for item in items[1:]
        ):
            agreed += 1
    return _ratio(agreed, len(comparable_groups))


def _policy_ndcg_at_k(
    cases: list[ScoringPolicyEvalCase],
    by_job: dict[str, ScoringPolicyEvalPrediction],
    k: int,
) -> float:
    rankable = [case for case in cases if case.ideal_rank is not None]
    if not rankable:
        return 0.0
    predicted_order = sorted(
        rankable,
        key=lambda case: by_job[case.job_id].policy_score,
        reverse=True,
    )[:k]
    ideal_order = sorted(rankable, key=lambda case: case.ideal_rank or 999)[:k]
    return _policy_dcg(predicted_order) / max(_policy_dcg(ideal_order), 1e-9)


def _policy_dcg(cases: list[ScoringPolicyEvalCase]) -> float:
    total = 0.0
    for index, case in enumerate(cases, start=1):
        relevance = 1.0 / max(case.ideal_rank or index, 1)
        total += relevance / math.log2(index + 1)
    return total


def _stale_marker_counts(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
) -> tuple[int, int]:
    if not _table_exists(conn, "job_score_staleness"):
        return 0, 0
    rows = conn.execute(
        """
        SELECT resolved, COUNT(*) AS count
        FROM job_score_staleness
        WHERE tenant_id = ?
        GROUP BY resolved
        """,
        (str(tenant_id),),
    ).fetchall()
    counts = {int(_row_value(row, "resolved", 0)): int(_row_value(row, "count", 1)) for row in rows}
    return counts.get(0, 0), counts.get(1, 0)


def _current_policy_report_fields(
    conn: sqlite3.Connection,
    tenant_id: TenantId,
) -> tuple[int, str, int]:
    default_policy = ScoringPolicy.default(tenant_id)
    if not _table_exists(conn, "scoring_policies"):
        return default_policy.version, default_policy.rubric_version, 0
    row = conn.execute(
        """
        SELECT version, rubric_json, anchors_json
        FROM scoring_policies
        WHERE tenant_id = ?
        ORDER BY version DESC
        LIMIT 1
        """,
        (str(tenant_id),),
    ).fetchone()
    if row is None:
        return default_policy.version, default_policy.rubric_version, 0
    rubric = _json_object(_row_value(row, "rubric_json", 1))
    anchors = _json_list(_row_value(row, "anchors_json", 2))
    return (
        int(_row_value(row, "version", 0)),
        str(
            rubric.get(
                "rubric_version",
                rubric.get("rubricVersion", default_policy.rubric_version),
            )
            or default_policy.rubric_version
        ),
        len(anchors),
    )


def _correction_signal_count(conn: sqlite3.Connection, tenant_id: TenantId) -> int:
    if not _table_exists(conn, "job_scores"):
        return 0
    row = conn.execute(
        """
        SELECT COUNT(*) AS count
        FROM job_scores
        WHERE tenant_id = ?
          AND correction_json IS NOT NULL
          AND TRIM(correction_json) != ''
        """,
        (str(tenant_id),),
    ).fetchone()
    if row is None:
        return 0
    return int(_row_value(row, "count", 0))


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


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _row_value(row: Any, name: str, index: int) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[name]
    return row[index]


def _json_object(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _json_list(raw: Any) -> list[Any]:
    try:
        value = json.loads(str(raw or "[]"))
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []
