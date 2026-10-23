"""Shared adapter for the canonical employer-analysis sub-step.

Scoring and tailoring both need the same front-half analysis before they can
reason about requirements. The domain use cases stay decoupled; this module is
the local-mode application adapter that wires the analysis ports.
"""

from __future__ import annotations

import sqlite3
import hashlib
import json

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobctrl.infrastructure.setup_probes import analysis_sdk_set_version, enabled_analysis_legs
from jobctrl.state import record_job_event


class EmployerAnalyzedEventRecorder:
    """Persist ``EmployerAnalyzed`` domain events into ``job_events``."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        stage: str,
        record_cached_hits: bool = True,
    ) -> None:
        self._conn = conn
        self._stage = stage
        self._record_cached_hits = record_cached_hits

    def publish(self, event) -> None:  # noqa: ANN001 -- DomainEvent (duck-typed)
        if getattr(event, "event_type", None) != "EmployerAnalyzed":
            return
        payload = dict(getattr(event, "payload", {}) or {})
        if not self._record_cached_hits and bool(payload.get("cached")):
            # A cache hit re-confirms an already-recorded generation; recording
            # it again would append a duplicate timeline row on every pass that
            # resolves the analysis (score retries, rescore batches, ...).
            return
        raw_job_id = str(payload.get("job_id") or "")
        if not raw_job_id:
            return
        job_id = canonical_job_id(raw_job_id)
        tenant_id = TenantId(str(getattr(event, "tenant_id", "")))
        completeness = f"{payload.get('legs_succeeded')}/{payload.get('legs_attempted')}"
        record_job_event(
            self._conn,
            job_id,
            self._stage,
            "EmployerAnalyzed",
            tenant_id=tenant_id,
            message=f"Employer analysis generation {payload.get('generation')} ({completeness} legs)",
            payload=payload,
        )
        self._conn.commit()

    def subscribe(self, event_type, handler):  # noqa: ANN001 -- protocol completeness
        raise NotImplementedError("EmployerAnalyzedEventRecorder is publish-only")


def build_analyze_use_case(
    *,
    conn: sqlite3.Connection,
    tenant_id: TenantId = TenantId("local"),
    publisher: EventPublisher | None = None,
    event_stage: str,
    record_cached_hits: bool = True,
):
    """Construct the canonical employer-analysis use case for local mode.

    ``record_cached_hits=False`` keeps the default ``job_events`` recorder from
    appending a timeline row for cache hits — callers that resolve the analysis
    on every pass (the score stage) opt out so retries and rescore batches do
    not duplicate the "Employer analysis generation N" row.
    """

    from jobctrl.domain.materials.analyze_use_case import AnalyzeJobUseCase
    from jobctrl.infrastructure.analysis import (
        AntigravityAnalysisAdapter,
        ClaudeAnalysisAdapter,
        CodexAnalysisAdapter,
        LlmAnalysisSynthesizer,
    )
    from jobctrl.infrastructure.llm import LlmAdapter
    from jobctrl.infrastructure.setup_probes import ready_llm_providers
    from jobctrl.infrastructure.scoring.criteria_provider import read_preferred_model

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
    active_legs = [leg for leg in enabled_legs if leg_provider[leg] in ready]
    selected_leg = next(leg for leg, provider in leg_provider.items() if provider == selected_provider)
    if selected_leg not in active_legs:
        active_legs.append(selected_leg)
    factories = {
        "claude": ClaudeAnalysisAdapter,
        "codex": CodexAnalysisAdapter,
        "antigravity": AntigravityAnalysisAdapter,
    }
    adapters = []
    for leg in active_legs:
        model = read_preferred_model(leg_provider[leg])
        adapter = factories[leg](**({"model": model} if model else {}))
        adapter.default_model_selection = model is None
        adapters.append(adapter)
    synthesizer = LlmAnalysisSynthesizer(
        llm=llm,
        provider_id=llm.provider_id,
        model=llm.model,
    )
    model_set = {
        "drafts": [(leg, adapter.model_id) for leg, adapter in zip(active_legs, adapters, strict=True)],
        "synthesizer": [llm.provider_id, llm.model],
    }
    efforts = {leg: adapter.reasoning_effort for leg, adapter in zip(active_legs, adapters, strict=True) if getattr(adapter, "reasoning_effort", None)}
    if effort := getattr(llm, "reasoning_effort", None):
        efforts["synthesizer"] = effort
    if efforts:
        model_set["reasoning_efforts"] = efforts
    model_set_fingerprint = hashlib.sha256(json.dumps(model_set, sort_keys=True).encode()).hexdigest()[:16]
    sdk_set_version = analysis_sdk_set_version(
        tuple(active_legs), synthesizer_provider=llm.provider_id,
    ) + "-models-" + model_set_fingerprint

    from jobctrl.infrastructure.determinations import determination_dependencies
    from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
    from jobctrl.domain.materials.analysis_agreement import ModelAnalysisAgreementJudge
    from jobctrl.infrastructure.enrichment.interpretation import PersistedJobInterpreter

    deps = determination_dependencies(conn, tenant_id=tenant_id, lane="enrichment", adapter=llm)
    return AnalyzeJobUseCase(
        repository=SqliteEmployerAnalysisRepository(conn),
        adapters=tuple(adapters),
        synthesizer=synthesizer,
        claim_verifier=ModelClaimVerifier(**deps),
        agreement_judge=ModelAnalysisAgreementJudge(**deps),
        job_interpreter=PersistedJobInterpreter(conn, tenant_id=tenant_id, dependencies=deps),
        publisher=publisher
        or EmployerAnalyzedEventRecorder(conn, stage=event_stage, record_cached_hits=record_cached_hits),
        sdk_set_version=sdk_set_version,
    )


__all__ = [
    "EmployerAnalyzedEventRecorder",
    "build_analyze_use_case",
]
