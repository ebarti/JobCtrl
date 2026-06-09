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

from jobhunter.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EnsembleError,
    EnsembleOutcome,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobhunter.domain.materials.analysis_grounding import (
    GroundingError,
    find_grounding_violations,
    validate_evidence_spans,
)
from jobhunter.domain.ports.materials import (
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
) -> JobAnalysisDraft:
    """Run one leg, retrying on schema/grounding failure (AI-SPEC §4b).

    Returns the validated, grounded draft or raises the last error (which the
    caller records as a per-leg failure). The grounding check runs HERE so a
    leg that keeps fabricating spans is retried, then recorded as a failure
    rather than poisoning the synthesizer input.
    """
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            draft = await adapter.draft(system_prompt, jd_snapshot)
            validate_evidence_spans(draft, jd_snapshot)
            return draft
        except (ValidationError, GroundingError) as exc:
            last_error = exc
            log.warning(
                "Analysis leg %s failed (attempt %d/%d): %s",
                adapter.model_id,
                attempt + 1,
                max_retries + 1,
                exc,
            )
        except Exception as exc:  # noqa: BLE001 — SDK/transport errors are per-leg failures
            last_error = exc
            log.warning(
                "Analysis leg %s raised (attempt %d/%d): %s",
                adapter.model_id,
                attempt + 1,
                max_retries + 1,
                exc,
            )
    assert last_error is not None
    raise last_error


def compute_agreement(drafts: tuple[JobAnalysisDraft, ...]) -> AnalysisAgreement:
    """Cross-model agreement over the surviving drafts (D-06/D-08).

    Deterministic, free, instant code (no extra LLM call). With a single
    surviving draft there is nothing to compare, so agreement is 1.0 by
    definition. With multiple drafts the score is the mean Jaccard overlap of
    the lowercased requirement-text sets and keyword sets; items that do not
    appear in every draft are flagged for review (divergence is audit data,
    never silently resolved).
    """
    if not drafts:
        return AnalysisAgreement(score=0.0)
    if len(drafts) == 1:
        return AnalysisAgreement(score=1.0)

    requirement_sets = [
        {req.text.strip().lower() for req in draft.requirements} for draft in drafts
    ]
    keyword_sets = [
        {kw.keyword.strip().lower() for kw in draft.keywords} for draft in drafts
    ]

    req_overlap = _mean_pairwise_jaccard(requirement_sets)
    kw_overlap = _mean_pairwise_jaccard(keyword_sets)
    score = round((req_overlap + kw_overlap) / 2, 4)

    flagged_requirements = _flag_non_unanimous(requirement_sets)
    flagged_keywords = _flag_non_unanimous(keyword_sets)
    return AnalysisAgreement(
        score=score,
        flagged_requirements=flagged_requirements,
        flagged_keywords=flagged_keywords,
    )


def _mean_pairwise_jaccard(sets: list[set[str]]) -> float:
    pairs = [
        _jaccard(sets[i], sets[j])
        for i in range(len(sets))
        for j in range(i + 1, len(sets))
    ]
    if not pairs:
        return 1.0
    return sum(pairs) / len(pairs)


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    union = a | b
    if not union:
        return 1.0
    return len(a & b) / len(union)


def _flag_non_unanimous(sets: list[set[str]]) -> tuple[str, ...]:
    """Flag items that are NOT present in every draft (low-agreement items).

    Symmetric for requirements and keywords — it operates purely on the
    lowercased-text sets the caller already computed.
    """
    if len(sets) < 2:
        return ()
    everywhere = set.intersection(*sets) if sets else set()
    anywhere: set[str] = set().union(*sets) if sets else set()
    diverged = sorted(anywhere - everywhere)
    return tuple(diverged)


async def run_ensemble(
    system_prompt: str,
    jd_snapshot: str,
    *,
    adapters: tuple[AnalysisDraftPort, ...],
    synthesizer: AnalysisSynthesizerPort,
    synthesizer_system_prompt: str,
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
                    error=f"{type(result).__name__}: {result}",
                    raw_output=_raw_output_from_error(result),
                )
            )
        else:
            drafts.append(result)

    if not drafts:
        # Hard fail ONLY when zero legs survived (failure mode #2 boundary).
        raise EnsembleError("all ensemble legs failed", tuple(failures))

    agreement = compute_agreement(tuple(drafts))
    canonical = await _synthesize_with_retry(
        synthesizer,
        system_prompt=synthesizer_system_prompt,
        drafts=tuple(drafts),
        jd_snapshot=jd_snapshot,
        max_retries=max_leg_retries,
    )

    return EnsembleOutcome(
        canonical=canonical,
        drafts=tuple(drafts),
        failures=tuple(failures),
        agreement=agreement,
        legs_attempted=len(adapters),
    )


async def _synthesize_with_retry(
    synthesizer: AnalysisSynthesizerPort,
    *,
    system_prompt: str,
    drafts: tuple[JobAnalysisDraft, ...],
    jd_snapshot: str,
    max_retries: int,
) -> JobAnalysis:
    """Reconcile drafts into the canonical analysis, re-asking on grounding fail.

    A grounding failure on the synthesized canonical blocks persistence and
    triggers a synthesizer re-ask (AI-SPEC §6 online guardrail). After
    exhaustion the error propagates (the use case surfaces it).
    """
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            canonical = await synthesizer.reconcile(
                system_prompt, drafts=drafts, jd_snapshot=jd_snapshot
            )
            validate_evidence_spans(canonical, jd_snapshot)
            return canonical
        except (ValidationError, GroundingError) as exc:
            last_error = exc
            log.warning(
                "Synthesizer failed (attempt %d/%d): %s",
                attempt + 1,
                max_retries + 1,
                exc,
            )
    assert last_error is not None
    raise last_error


def _raw_output_from_error(error: BaseException) -> str | None:
    """Best-effort raw model output from a grounding rejection, for the audit row."""
    if isinstance(error, GroundingError):
        return "; ".join(v.describe() for v in error.violations)
    return None


# Keep ``find_grounding_violations`` reachable from this module for callers that
# want the structured violations without raising.
_ = (find_grounding_violations,)


__all__ = [
    "DEFAULT_MAX_LEG_RETRIES",
    "compute_agreement",
    "run_ensemble",
]
