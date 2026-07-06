"""Shared adapter for the canonical employer-analysis sub-step.

Scoring and tailoring both need the same front-half analysis before they can
reason about requirements. The domain use cases stay decoupled; this module is
the local-mode application adapter that wires the analysis ports.
"""

from __future__ import annotations

import sqlite3

from jobhunter.domain.ports.events import EventPublisher
from jobhunter.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobhunter.infrastructure.setup_probes import analysis_sdk_set_version, enabled_analysis_legs
from jobhunter.state import record_job_event


class EmployerAnalyzedEventRecorder:
    """Persist ``EmployerAnalyzed`` domain events into ``job_events``."""

    def __init__(self, conn: sqlite3.Connection, *, stage: str) -> None:
        self._conn = conn
        self._stage = stage

    def publish(self, event) -> None:  # noqa: ANN001 -- DomainEvent (duck-typed)
        if getattr(event, "event_type", None) != "EmployerAnalyzed":
            return
        payload = dict(getattr(event, "payload", {}) or {})
        job_url = str(payload.get("job_id") or "")
        if not job_url:
            return
        completeness = f"{payload.get('legs_succeeded')}/{payload.get('legs_attempted')}"
        record_job_event(
            self._conn,
            job_url,
            self._stage,
            "EmployerAnalyzed",
            message=f"Employer analysis generation {payload.get('generation')} ({completeness} legs)",
            payload=payload,
        )
        self._conn.commit()

    def subscribe(self, event_type, handler):  # noqa: ANN001 -- protocol completeness
        raise NotImplementedError("EmployerAnalyzedEventRecorder is publish-only")


def build_analyze_use_case(
    *,
    conn: sqlite3.Connection,
    publisher: EventPublisher | None = None,
    event_stage: str,
):
    """Construct the canonical employer-analysis use case for local mode."""

    from jobhunter.domain.materials.analyze_use_case import AnalyzeJobUseCase
    from jobhunter.infrastructure.analysis import (
        AntigravityAnalysisAdapter,
        ClaudeAnalysisAdapter,
        ClaudeAnalysisSynthesizer,
        CodexAnalysisAdapter,
    )

    enabled_legs = enabled_analysis_legs()
    adapters = []
    if "claude" in enabled_legs:
        adapters.append(ClaudeAnalysisAdapter())
    if "codex" in enabled_legs:
        adapters.append(CodexAnalysisAdapter())
    if "antigravity" in enabled_legs:
        adapters.append(AntigravityAnalysisAdapter())

    return AnalyzeJobUseCase(
        repository=SqliteEmployerAnalysisRepository(conn),
        adapters=tuple(adapters),
        synthesizer=ClaudeAnalysisSynthesizer(),
        publisher=publisher or EmployerAnalyzedEventRecorder(conn, stage=event_stage),
        sdk_set_version=analysis_sdk_set_version(enabled_legs),
    )


__all__ = [
    "EmployerAnalyzedEventRecorder",
    "build_analyze_use_case",
]
