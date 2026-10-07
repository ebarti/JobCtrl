"""AnalyzeJobUseCase — produce + persist the canonical employer analysis.

The application-layer orchestrator for Phase 1 (sits beside
``TailorResumeUseCase``). It owns the transaction:

  1. Build the deterministic JD snapshot from the job dict (the source of truth
     every evidence span validates against).
  2. Cache short-circuit (D-11/D-12): if an analysis already exists for the same
     ``(snapshot_hash, PROMPT_VERSION, SDK_SET_VERSION)`` cache key and
     ``force`` is False, return it — never re-reason on re-tailor.
  3. Run the 3-SDK merge+synthesize ensemble (grounding-gated + synthesized
     inside the runner), surfacing partial failures (D-08).
  4. Re-validate the synthesized canonical's grounding (defense in depth) and
     persist a new generation, superseding prior ones (D-13).
  5. Publish ``EmployerAnalyzed`` (Python factory + ``job_events`` row so the
     read-side projection rebuilds and the SSE router fans out).

The ensemble runner is injected (defaulting to the infrastructure helper) so
the domain use case depends on the ports, not on a concrete SDK. There is NO
wall-clock timeout on the analysis path (D-19) — the only stop is cooperative
cancellation of the wrapping task.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from jobctrl.domain.events import (
    EmployerAnalyzedPayload,
    create_employer_analyzed,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    PROMPT_VERSION,
    SDK_SET_VERSION,
    EmployerAnalysis,
    EnsembleOutcome,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.analysis_grounding import ground_and_snap
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.ports.materials import (
    AnalysisDraftPort,
    AnalysisSynthesizerPort,
    EmployerAnalysisRepository,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.domain.job_snapshot import build_jd_snapshot
from jobctrl.domain.determinations import Source, DeterminationFailure
from jobctrl.domain.ports.claim_verification import ArtifactLine, ClaimVerifier
from jobctrl.domain.ports.analysis_agreement import AnalysisAgreementJudge
from jobctrl.domain.ports.job_interpretation import JobInterpreter
from jobctrl.domain.materials.analysis import EeoScreenHit
import json

log = logging.getLogger(__name__)

# Signature of the injected ensemble runner (defaults to the infra helper).
EnsembleRunner = Callable[..., Awaitable[EnsembleOutcome]]


@dataclass(frozen=True)
class AnalyzeJobOutcome:
    """Result of an analyze call (the persisted record + whether it was cached)."""

    analysis: EmployerAnalysis
    cached: bool


class AnalyzeJobUseCase:
    """Produce + persist + publish the canonical employer analysis for a job."""

    def __init__(
        self,
        *,
        repository: EmployerAnalysisRepository,
        adapters: tuple[AnalysisDraftPort, ...],
        synthesizer: AnalysisSynthesizerPort,
        claim_verifier: ClaimVerifier,
        agreement_judge: AnalysisAgreementJudge,
        job_interpreter: JobInterpreter,
        publisher: EventPublisher | None = None,
        system_prompt: str | None = None,
        synthesizer_system_prompt: str | None = None,
        ensemble_runner: EnsembleRunner | None = None,
        prompt_version: str = PROMPT_VERSION,
        sdk_set_version: str = SDK_SET_VERSION,
    ) -> None:
        if not adapters:
            raise ValueError("AnalyzeJobUseCase requires at least one draft adapter")
        self._repository = repository
        self._adapters = adapters
        self._synthesizer = synthesizer
        self._claim_verifier = claim_verifier
        self._agreement_judge = agreement_judge
        self._job_interpreter = job_interpreter
        self._publisher = publisher
        self._system_prompt = system_prompt
        self._synthesizer_system_prompt = synthesizer_system_prompt
        self._ensemble_runner = ensemble_runner
        self._prompt_version = prompt_version
        self._sdk_set_version = sdk_set_version

    # ------------------------------------------------------------------ sync

    def execute(
        self,
        *,
        job: dict,
        tenant_id: TenantId = LOCAL_TENANT,
        force: bool = False,
    ) -> AnalyzeJobOutcome:
        """Synchronous entry point (the tailor sub-step + RPC both call this).

        Bridges to the async ensemble via ``asyncio.run`` — the worker/tailor
        path is synchronous (thread-pool), so this is a true top-level sync
        entry point (never call this from inside a running event loop —
        AI-SPEC §4b).
        """
        return asyncio.run(self.execute_async(job=job, tenant_id=tenant_id, force=force))

    # ----------------------------------------------------------------- async

    async def execute_async(
        self,
        *,
        job: dict,
        tenant_id: TenantId = LOCAL_TENANT,
        force: bool = False,
    ) -> AnalyzeJobOutcome:
        job_id = canonical_job_id(str(job["job_id"]))
        jd_snapshot = build_jd_snapshot(job)
        snapshot_hash = compute_snapshot_hash(jd_snapshot)
        from jobctrl.domain.materials.analysis import cache_key as _cache_key

        key = _cache_key(
            snapshot_hash,
            prompt_version=self._prompt_version,
            sdk_set_version=self._sdk_set_version,
        )

        # Cache short-circuit (D-11/D-12): reuse, never re-reason.
        if not force:
            cached = self._repository.get_by_cache_key(tenant_id, job_id, key)
            if cached is not None:
                self._job_interpreter.interpret(job=job, employer_analysis=cached)
                self._publish(cached, cached=True)
                return AnalyzeJobOutcome(analysis=cached, cached=True)

        verification_ids = {}

        def verify_prose(analysis):
            lines = self._analysis_lines(analysis)
            result, envelope = self._claim_verifier.verify(
                artifact_kind="employer_analysis",
                entity_id=str(job_id),
                lines=lines,
                evidence=[],
                requirements=[Source(source_id="posting", text=jd_snapshot)],
                rubric={
                    "process_narration": "Describe only employer needs and ideal candidate capabilities. No narration about models, drafts, experts, reconciliation or the analysis process.",
                    "support": "Employer statements and target-role requirements must rest on the posting. Candidate fact claims have no personal evidence.",
                },
            )
            if result.verdict == "fail":
                error = DeterminationFailure("claim_verification_failed")
                error.repair_feedback = json.dumps(result.model_dump(), ensure_ascii=False)
                raise error
            verification_ids[getattr(analysis, "model_id", "canonical")] = envelope.determination_id
            return envelope.determination_id

        outcome = await self._run_ensemble(jd_snapshot, verify_prose=verify_prose, entity_id=str(job_id))
        verify_prose(outcome.canonical)

        # Defense in depth: re-validate the synthesized canonical's grounding AND
        # snap its evidence spans to verbatim JD text before persistence (the
        # runner already grounds+snaps, but persistence is the hard boundary —
        # never persist a fabricated span, and the persisted spans must be
        # content-exact / copy-paste-findable in the posting per D-15). Idempotent
        # on an already-snapped canonical; raises GroundingError on any absent span.
        grounded_canonical = ground_and_snap(outcome.canonical, jd_snapshot)

        canonical = grounded_canonical
        generation = self._next_generation(tenant_id, job_id)
        record = EmployerAnalysis.build(
            tenant_id=tenant_id,
            job_id=job_id,
            generation=generation,
            snapshot_hash=snapshot_hash,
            canonical=canonical,
            sub_analyses=outcome.drafts,
            failures=outcome.failures,
            agreement=outcome.agreement,
            legs_attempted=outcome.legs_attempted,
            determination_ids={**verification_ids, "analysis_agreement": outcome.agreement_determination_id},
            line_anchors=tuple(
                {
                    "line_id": row.line_id,
                    "evidence_ids": [],
                    "requirement_ids": [],
                    "transform_type": "synthesize_from_related",
                    "reason": "Model-grounded employer analysis",
                }
                for row in self._analysis_lines(canonical)
            ),
            prompt_version=self._prompt_version,
            sdk_set_version=self._sdk_set_version,
        )
        interpretation = self._job_interpreter.interpret(job=job, employer_analysis=record)
        interpreted = {row.requirement_id: row for row in interpretation.requirements}
        canonical = canonical.model_copy(
            update={
                "inferred_seniority": interpretation.seniority.value,
                "requirements": [
                    row.model_copy(update={"coverage_scope": interpreted[row.id].scope})
                    for row in canonical.requirements
                ],
            }
        )
        from dataclasses import replace

        record = replace(
            record,
            canonical=canonical,
            determination_ids={**record.determination_ids, "job_interpretation": interpretation._determination_id},
            eeo_screen_hits=tuple(
                EeoScreenHit(
                    kind="requirement",
                    ref_id=row.requirement_id,
                    category="protected_class",
                    matched_text=row.citations[0].quote,
                )
                for row in interpretation.requirements
                if row.protected_class
            ),
        )
        self._repository.save(record)  # supersede, never destroy (D-13)
        if record.is_degraded:
            log.warning(
                "Employer analysis for %s is DEGRADED (%s legs) — failures: %s",
                job_id,
                record.ensemble_completeness,
                [f.model_id for f in record.failures],
            )
        self._publish(record, cached=False)
        return AnalyzeJobOutcome(analysis=record, cached=False)

    # --------------------------------------------------------------- helpers

    @staticmethod
    def _analysis_lines(analysis):
        fields = [
            ("role_framing", analysis.role_framing),
            ("ideal_candidate_narrative", analysis.ideal_candidate_narrative),
        ]
        fields += [("requirement:" + row.id, row.text) for row in analysis.requirements]
        return [
            ArtifactLine(line_id=ident, text=text, allowed_evidence_ids=[], allowed_requirement_ids=["posting"])
            for ident, text in fields
        ]

    async def _run_ensemble(self, jd_snapshot: str, *, verify_prose, entity_id) -> EnsembleOutcome:
        runner = self._ensemble_runner or _default_ensemble_runner
        system_prompt, synth_prompt = self._resolve_prompts()
        return await runner(
            system_prompt,
            jd_snapshot,
            adapters=self._adapters,
            synthesizer=self._synthesizer,
            synthesizer_system_prompt=synth_prompt,
            verify_prose=verify_prose,
            agreement_judge=self._agreement_judge,
            entity_id=entity_id,
        )

    def _resolve_prompts(self) -> tuple[str, str]:
        if self._system_prompt is not None and self._synthesizer_system_prompt is not None:
            return self._system_prompt, self._synthesizer_system_prompt
        # Lazy import so the domain use case stays importable without infra.
        from jobctrl.infrastructure.analysis.prompts import (
            ANALYSIS_SYSTEM_PROMPT,
            SYNTHESIZER_SYSTEM_PROMPT,
        )

        return (
            self._system_prompt or ANALYSIS_SYSTEM_PROMPT,
            self._synthesizer_system_prompt or SYNTHESIZER_SYSTEM_PROMPT,
        )

    def _next_generation(self, tenant_id: TenantId, job_id: JobId) -> int:
        # Prefer the repository's helper when present; otherwise derive from the
        # latest persisted generation.
        next_gen = getattr(self._repository, "next_generation", None)
        if callable(next_gen):
            return int(next_gen(tenant_id, job_id))
        latest = self._repository.load(tenant_id, job_id)
        return (latest.generation + 1) if latest is not None else 1

    def _publish(self, record: EmployerAnalysis, *, cached: bool) -> None:
        if self._publisher is None:
            return
        try:
            event = create_employer_analyzed(
                record.tenant_id,
                EmployerAnalyzedPayload(
                    job_id=str(record.job_id),
                    generation=record.generation,
                    snapshot_hash=record.snapshot_hash,
                    cache_key=record.cache_key,
                    legs_attempted=record.legs_attempted,
                    legs_succeeded=record.legs_succeeded,
                    analyzed_at=datetime.now(timezone.utc).isoformat(),
                    cached=cached,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — publishing must not break the use case
            log.exception("Failed to publish EmployerAnalyzed for %s", record.job_id)


async def _default_ensemble_runner(*args, **kwargs) -> EnsembleOutcome:
    """Default runner — lazy-imports the infrastructure ensemble helper."""
    from jobctrl.infrastructure.analysis.ensemble import run_ensemble

    return await run_ensemble(*args, **kwargs)


__all__ = [
    "AnalyzeJobUseCase",
    "AnalyzeJobOutcome",
]
