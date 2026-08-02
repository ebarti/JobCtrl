"""Auditable local scoring feedback signals.

The collector reads existing local facts only: score corrections from
``job_scores`` and user/job actions from ``job_events``. It does not hide or
overwrite score evidence or turn those facts into ranking adjustments. Policy
changes are derived and accepted through the versioned learning flow.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ScoringFeedbackSignal:
    tenant_id: str
    job_id: str
    kind: str
    evidence: str


def collect_feedback_signals(conn: sqlite3.Connection) -> tuple[ScoringFeedbackSignal, ...]:
    """Collect auditable feedback facts from local scoring/action tables."""

    signals: list[ScoringFeedbackSignal] = []
    signals.extend(_correction_signals(conn))
    signals.extend(_action_signals(conn))
    return tuple(signals)


def _correction_signals(conn: sqlite3.Connection) -> list[ScoringFeedbackSignal]:
    if not _table_exists(conn, "job_scores"):
        return []
    rows = conn.execute(
        """SELECT tenant_id, job_id, fit_score, correction_json, trace_json
           FROM job_scores
           WHERE correction_json IS NOT NULL AND correction_json != ''
           ORDER BY tenant_id, job_id, version"""
    ).fetchall()
    signals: list[ScoringFeedbackSignal] = []
    for row in rows:
        tenant_id = str(row["tenant_id"] if isinstance(row, sqlite3.Row) else row[0])
        job_id = str(row["job_id"] if isinstance(row, sqlite3.Row) else row[1])
        fit_score = float(row["fit_score"] if isinstance(row, sqlite3.Row) else row[2])
        correction = _json_object(row["correction_json"] if isinstance(row, sqlite3.Row) else row[3])
        trace = _json_object(row["trace_json"] if isinstance(row, sqlite3.Row) else row[4])
        history = trace.get("correction_history")
        latest_history = history[-1] if isinstance(history, list) and history else {}
        original_score = _float(
            latest_history.get("original_score") if isinstance(latest_history, dict) else None,
            fit_score,
        )
        rationale = str(correction.get("rationale") or "score corrected").strip()
        signals.append(
            ScoringFeedbackSignal(
                tenant_id=tenant_id,
                job_id=job_id,
                kind="score_correction",
                evidence=f"score correction {original_score:g}->{fit_score:g}: {rationale}",
            )
        )
    return signals


def _action_signals(conn: sqlite3.Connection) -> list[ScoringFeedbackSignal]:
    if not _table_exists(conn, "job_events"):
        return []
    rows = conn.execute(
        """SELECT tenant_id, job_id, event_type, message
           FROM job_events
           WHERE job_id IS NOT NULL AND event_type IN (
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
        tenant_id = str(row["tenant_id"] if isinstance(row, sqlite3.Row) else row[0])
        job_id = str(row["job_id"] if isinstance(row, sqlite3.Row) else row[1])
        event_type = str(row["event_type"] if isinstance(row, sqlite3.Row) else row[2])
        message = str((row["message"] if isinstance(row, sqlite3.Row) else row[3]) or event_type)
        signals.append(
            ScoringFeedbackSignal(
                tenant_id=tenant_id,
                job_id=job_id,
                kind=event_type,
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
