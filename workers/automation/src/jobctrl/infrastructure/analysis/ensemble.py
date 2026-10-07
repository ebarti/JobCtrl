"""Ensemble orchestration — run the legs in parallel, merge, synthesize.

Implements the D-06 merge+synthesize flow for the 3-SDK ensemble (Claude +
Codex + Antigravity/Gemini; the orchestrator is N-leg, partial-failure safe):

  1. Run every ``AnalysisDraftPort`` leg concurrently with
     ``asyncio.gather(..., return_exceptions=True)`` — the key lever that stops
     one SDK failure/timeout from cancelling the healthy legs and gives the
     orchestrator BOTH the wins and the losses to persist (failure mode #2).
  2. Per-leg retry (AI-SPEC §4b): a leg is retried up to ``max_retries`` times
     on a Pydantic ``ValidationError`` or a grounding rejection (an evidence
     span that is not a literal JD substring). After exhaustion the leg is
     recorded as an :class:`AnalysisFailure` and the ensemble proceeds on the
     survivors — never masked.
  3. Validate every surviving draft's evidence spans (the deterministic
     grounding gate, the cardinal failure mode #1).
  4. Compute the cross-model agreement signal (D-06/D-08).
  5. The synthesizer (Claude Agent SDK, D-07) reconciles the typed drafts into
     the canonical analysis, which is re-validated for grounding before return.

Hard-fail (``EnsembleError``) ONLY when zero drafts survive — a degraded
ensemble (some legs failed) is returned, clearly marked degraded.

No wall-clock timeout anywhere on this path (D-19): each leg is awaited to
completion; the only stop is cooperative cancellation of the wrapping task.
"""

from __future__ import annotations

import asyncio
import logging

from pydantic import ValidationError
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.ports.analysis_agreement import AnalysisAgreementJudge

from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EnsembleError,
    EnsembleOutcome,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.domain.materials.analysis_grounding import (
    GroundingError,
    find_grounding_violations,
    ground_and_snap,
)
from jobctrl.domain.ports.materials import (
    AnalysisDraftPort,
    AnalysisSynthesizerPort,
)

log = logging.getLogger(__name__)

DEFAULT_MAX_LEG_RETRIES = 2


async def _draft_with_retry(
    adapter: AnalysisDraftPort,
    *,
    system_prompt: str,
    jd_snapshot: str,
    max_retries: int,
    verify_prose,
) -> JobAnalysisDraft:
    """Run one leg, retrying on schema/grounding/content failure (AI-SPEC §4b).

    Returns the validated draft with its evidence spans SNAPPED to verbatim JD
    text (formatting-tolerant grounding gate), or raises the last error (which
    the caller records as a per-leg failure). The grounding check runs HERE so a
    leg that keeps fabricating spans is retried, then recorded as a failure
    rather than poisoning the synthesizer input — and the snapped spans flow
    into the synthesizer + persistence verbatim-from-the-posting (D-15). A
    candidate-prose rejection is fed back into the retry prompt, exactly as the
    synthesizer re-ask does, so a leg can correct process commentary instead of
    repeating it until the leg is exhausted.
    """
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            draft = await adapter.draft(_with_rejection_feedback(system_prompt, last_error), jd_snapshot)
            snapped = ground_and_snap(draft, jd_snapshot)
            verify_prose(snapped)
            assert isinstance(snapped, JobAnalysisDraft)  # snap preserves the leg type
            return snapped
        except (ValidationError, GroundingError, DeterminationFailure) as exc:
            last_error = exc
            log.warning(
                "Analysis leg %s failed (attempt %d/%d): %s",
                adapter.model_id,
                attempt + 1,
                max_retries + 1,
                type(exc).__name__,
            )
        except Exception as exc:  # noqa: BLE001 — SDK/transport errors are per-leg failures
            last_error = exc
            log.warning(
                "Analysis leg %s raised (attempt %d/%d): %s",
                adapter.model_id,
                attempt + 1,
                max_retries + 1,
                type(exc).__name__,
            )
    assert last_error is not None
    raise last_error


async def run_ensemble(
    system_prompt: str,
    jd_snapshot: str,
    *,
    adapters: tuple[AnalysisDraftPort, ...],
    synthesizer: AnalysisSynthesizerPort,
    synthesizer_system_prompt: str,
    verify_prose,
    agreement_judge: AnalysisAgreementJudge,
    entity_id: str,
    max_leg_retries: int = DEFAULT_MAX_LEG_RETRIES,
) -> EnsembleOutcome:
    """Run the full merge+synthesize ensemble. See module docstring."""
    if not adapters:
        raise ValueError("run_ensemble requires at least one adapter")

    results = await asyncio.gather(
        *(
            _draft_with_retry(
                adapter,
                system_prompt=system_prompt,
                jd_snapshot=jd_snapshot,
                max_retries=max_leg_retries,
                verify_prose=verify_prose,
            )
            for adapter in adapters
        ),
        return_exceptions=True,  # NEVER let one failure cancel the others
    )

    drafts: list[JobAnalysisDraft] = []
    failures: list[AnalysisFailure] = []
    for adapter, result in zip(adapters, results, strict=True):
        if isinstance(result, BaseException):
            failures.append(
                AnalysisFailure(
                    model_id=adapter.model_id,
                    error=result.code if isinstance(result, DeterminationFailure) else type(result).__name__,
                    raw_output=None,
                )
            )
        else:
            drafts.append(result)

    if not drafts:
        # Hard fail ONLY when zero legs survived (failure mode #2 boundary).
        raise EnsembleError("all ensemble legs failed", tuple(failures))

    agreement_result, agreement_envelope = agreement_judge.judge(entity_id=entity_id, drafts=tuple(drafts))
    agreement = AnalysisAgreement(
        score=agreement_result.score,
        flagged_requirements=tuple(
            ident for row in agreement_result.findings if row.kind == "requirement" for ident in row.source_ids
        ),
        flagged_keywords=tuple(
            ident for row in agreement_result.findings if row.kind == "keyword" for ident in row.source_ids
        ),
    )
    canonical = await _synthesize_with_retry(
        synthesizer,
        system_prompt=synthesizer_system_prompt,
        drafts=tuple(drafts),
        jd_snapshot=jd_snapshot,
        max_retries=max_leg_retries,
        verify_prose=verify_prose,
    )

    return EnsembleOutcome(
        canonical=canonical,
        drafts=tuple(drafts),
        failures=tuple(failures),
        agreement=agreement,
        legs_attempted=len(adapters),
        agreement_determination_id=agreement_envelope.determination_id,
    )


async def _synthesize_with_retry(
    synthesizer: AnalysisSynthesizerPort,
    *,
    system_prompt: str,
    drafts: tuple[JobAnalysisDraft, ...],
    jd_snapshot: str,
    max_retries: int,
    verify_prose,
) -> JobAnalysis:
    """Reconcile drafts into the canonical analysis, re-asking on grounding fail.

    A grounding failure on the synthesized canonical blocks persistence and
    triggers a synthesizer re-ask (AI-SPEC §6 online guardrail). After
    exhaustion the error propagates (the use case surfaces it). The returned
    canonical carries its evidence spans SNAPPED to verbatim JD text so the
    persisted record is content-exact and copy-paste-findable in the posting
    (D-15).
    """
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            canonical = await synthesizer.reconcile(
                _with_rejection_feedback(system_prompt, last_error),
                drafts=drafts,
                jd_snapshot=jd_snapshot,
            )
            canonical = ground_and_snap(canonical, jd_snapshot)
            verify_prose(canonical)
            return canonical
        except (ValidationError, GroundingError, DeterminationFailure) as exc:
            last_error = exc
            log.warning(
                "Synthesizer failed (attempt %d/%d): %s",
                attempt + 1,
                max_retries + 1,
                type(exc).__name__,
            )
    assert last_error is not None
    raise last_error


def _with_rejection_feedback(system_prompt: str, last_error: Exception | None) -> str:
    feedback = getattr(last_error, "repair_feedback", None)
    if feedback:
        return system_prompt + "\nPrevious verification findings (data for repair):\n" + feedback
    return system_prompt


# Keep ``find_grounding_violations`` reachable from this module for callers that
# want the structured violations without raising.
_ = (find_grounding_violations,)


__all__ = [
    "DEFAULT_MAX_LEG_RETRIES",
    "run_ensemble",
]
