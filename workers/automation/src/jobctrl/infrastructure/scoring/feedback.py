"""Transparent local scoring feedback signals.

The collector reads existing local facts only: score corrections from
``job_scores`` and user/job actions from ``job_events``. It does not hide or
overwrite score evidence; callers receive the evidence strings that produced
each adjustment.
"""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class ScoringFeedbackSignal:
    job_id: str
    kind: str
    weight: float
    evidence: str


@dataclass(frozen=True)
class FeedbackRankedJob:
    job_id: str
    base_score: float
    feedback_adjustment: float
    final_score: float
    evidence: tuple[str, ...]


ACTION_WEIGHTS = {
    "ApplicationManuallyMarked": 0.75,
    "StageSkipped": -0.75,
    "JobDeleted": -1.0,
    "ResumeApproved": 0.35,
    "CoverLetterApproved": 0.35,
}


def collect_feedback_signals(conn: sqlite3.Connection) -> tuple[ScoringFeedbackSignal, ...]:
    """Collect transparent feedback signals from local scoring/action tables."""

    signals: list[ScoringFeedbackSignal] = []
    signals.extend(_correction_signals(conn))
    signals.extend(_action_signals(conn))
    return tuple(signals)


def rank_jobs_with_feedback(
    base_scores: dict[str, float],
    signals: Iterable[ScoringFeedbackSignal],
) -> tuple[FeedbackRankedJob, ...]:
    """Apply bounded, evidence-backed feedback adjustments to base scores."""

    by_job: dict[str, list[ScoringFeedbackSignal]] = defaultdict(list)
    for signal in signals:
        by_job[signal.job_id].append(signal)

    ranked: list[FeedbackRankedJob] = []
    for job_id, base_score in base_scores.items():
        job_signals = by_job.get(job_id, [])
        adjustment = max(-1.5, min(1.5, sum(signal.weight for signal in job_signals)))
        ranked.append(
            FeedbackRankedJob(
                job_id=job_id,
                base_score=base_score,
                feedback_adjustment=adjustment,
                final_score=base_score + adjustment,
                evidence=tuple(signal.evidence for signal in job_signals),
            )
        )
    return tuple(sorted(ranked, key=lambda item: (item.final_score, item.base_score), reverse=True))


def _correction_signals(conn: sqlite3.Connection) -> list[ScoringFeedbackSignal]:
    if not _table_exists(conn, "job_scores"):
        return []
    columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(job_scores)").fetchall()
    }
    stable_references = "job_id" in columns
    identity_select = "jobs.url" if stable_references else "score.job_url"
    identity_join = (
        """
        JOIN jobs
          ON jobs.tenant_id = score.tenant_id
         AND jobs.job_id = score.job_id
        """
        if stable_references
        else ""
    )
    rows = conn.execute(
        f"""SELECT {identity_select} AS job_url, score.fit_score,
                  score.correction_json, score.trace_json
           FROM job_scores score
           {identity_join}
           WHERE score.correction_json IS NOT NULL
             AND score.correction_json != ''
           ORDER BY {identity_select}, score.version"""
    ).fetchall()
    signals: list[ScoringFeedbackSignal] = []
    for row in rows:
        job_id = str(row["job_url"] if isinstance(row, sqlite3.Row) else row[0])
        fit_score = float(row["fit_score"] if isinstance(row, sqlite3.Row) else row[1])
        correction = _json_object(row["correction_json"] if isinstance(row, sqlite3.Row) else row[2])
        trace = _json_object(row["trace_json"] if isinstance(row, sqlite3.Row) else row[3])
        history = trace.get("correction_history")
        latest_history = history[-1] if isinstance(history, list) and history else {}
        original_score = _float(
            latest_history.get("original_score") if isinstance(latest_history, dict) else None,
            fit_score,
        )
        delta = max(-1.5, min(1.5, (fit_score - original_score) / 2.0))
        rationale = str(correction.get("rationale") or "score corrected").strip()
        signals.append(
            ScoringFeedbackSignal(
                job_id=job_id,
                kind="score_correction",
                weight=delta,
                evidence=f"score correction {original_score:g}->{fit_score:g}: {rationale}",
            )
        )
    return signals


def _action_signals(conn: sqlite3.Connection) -> list[ScoringFeedbackSignal]:
    if not _table_exists(conn, "job_events"):
        return []
    rows = conn.execute(
        """SELECT job_url, event_type, message
           FROM job_events
           WHERE job_url IS NOT NULL AND event_type IN (
             'ApplicationManuallyMarked',
             'StageSkipped',
             'JobDeleted',
             'ResumeApproved',
             'CoverLetterApproved'
           )
           ORDER BY event_id"""
    ).fetchall()
    signals: list[ScoringFeedbackSignal] = []
    for row in rows:
        job_id = str(row["job_url"] if isinstance(row, sqlite3.Row) else row[0])
        event_type = str(row["event_type"] if isinstance(row, sqlite3.Row) else row[1])
        message = str((row["message"] if isinstance(row, sqlite3.Row) else row[2]) or event_type)
        signals.append(
            ScoringFeedbackSignal(
                job_id=job_id,
                kind=event_type,
                weight=ACTION_WEIGHTS[event_type],
                evidence=f"{event_type}: {message}",
            )
        )
    return signals


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


def _json_object(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
