"""Shared adapter for the canonical employer-analysis sub-step.

Scoring and tailoring both need the same front-half analysis before they can
reason about requirements. The domain use cases stay decoupled; this module is
the local-mode application adapter that wires the analysis ports.
"""

from __future__ import annotations

import sqlite3

from jobctrl.domain.ports.events import EventPublisher
from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobctrl.infrastructure.setup_probes import analysis_sdk_set_version, enabled_analysis_legs
from jobctrl.state import record_job_event


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

    from jobctrl.domain.materials.analyze_use_case import AnalyzeJobUseCase
    from jobctrl.infrastructure.analysis import (
        AntigravityAnalysisAdapter,
        ClaudeAnalysisAdapter,
        CodexAnalysisAdapter,
        LlmAnalysisSynthesizer,
    )
    from jobctrl.infrastructure.llm import LlmAdapter
    from jobctrl.infrastructure.setup_probes import ready_llm_providers

    enabled_legs = enabled_analysis_legs()
    ready = ready_llm_providers()
    if not ready:
        raise RuntimeError("No core LLM provider is ready for employer analysis")
    leg_provider = {"claude": "claude", "codex": "codex", "antigravity": "google"}
    selected_provider = next(
        (leg_provider[leg] for leg in enabled_legs if leg_provider[leg] in ready),
        ready[0],
    )
    llm = LlmAdapter(default_provider=selected_provider)
    selected_provider = llm.provider_id
    adapters = []
    if "claude" in enabled_legs:
        adapters.append(ClaudeAnalysisAdapter())
    if "codex" in enabled_legs:
        adapters.append(CodexAnalysisAdapter())
    if "antigravity" in enabled_legs:
        adapters.append(AntigravityAnalysisAdapter())
    adapter_providers = {
        "claude" if isinstance(adapter, ClaudeAnalysisAdapter) else
        "codex" if isinstance(adapter, CodexAnalysisAdapter) else
        "google" if isinstance(adapter, AntigravityAnalysisAdapter) else
        "local"
        for adapter in adapters
    }
    if selected_provider == "claude" and "claude" not in adapter_providers:
        adapters.append(ClaudeAnalysisAdapter())
    elif selected_provider == "codex" and "codex" not in adapter_providers:
        adapters.append(CodexAnalysisAdapter())
    elif selected_provider == "google" and "google" not in adapter_providers:
        adapters.append(AntigravityAnalysisAdapter())
    synthesizer = LlmAnalysisSynthesizer(
        llm=llm,
        provider_id=llm.provider_id,
        model=llm.model,
    )

    return AnalyzeJobUseCase(
        repository=SqliteEmployerAnalysisRepository(conn),
        adapters=tuple(adapters),
        synthesizer=synthesizer,
        publisher=publisher or EmployerAnalyzedEventRecorder(conn, stage=event_stage),
        sdk_set_version=analysis_sdk_set_version(
            enabled_legs,
            synthesizer_provider=llm.provider_id,
        ),
    )


__all__ = [
    "EmployerAnalyzedEventRecorder",
    "build_analyze_use_case",
]
