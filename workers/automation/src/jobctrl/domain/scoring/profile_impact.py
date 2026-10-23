"""Model-owned significance of a profile edit for one saved job assessment."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import Field, StrictStr, ValidationError

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, Source, determine
from jobctrl.domain.job_snapshot import build_jd_snapshot
from jobctrl.domain.profile.canonical_sources import profile_sources


class ScoreProfileInputs(DeterminationModel):
    profile_id: StrictStr = Field(min_length=1)
    profile_version: int = Field(ge=1)
    sources: list[Source] = Field(max_length=4096)
    posting_hash: StrictStr
    criteria_text: StrictStr
    target_criteria: StrictStr
    min_fit_score: int


def profile_inputs(snapshot, criteria, preferences, job):
    """Freeze exactly the candidate facts/preferences used by this score."""
    return ScoreProfileInputs(
        profile_id=snapshot.profile_id, profile_version=snapshot.version,
        sources=[*profile_sources(snapshot.as_dict()), *preferences, Source(
            source_id="authored_conditions", text=json.dumps({
                key: criteria.profile_preferences.get(key)
                for key in ("work_authorization", "compensation", "availability")
            }, sort_keys=True, ensure_ascii=False),
        )],
        posting_hash=hashlib.sha256(build_jd_snapshot(job).encode()).hexdigest(),
        criteria_text=criteria.criteria_text, target_criteria=criteria.target_criteria,
        min_fit_score=criteria.min_fit_score,
    )


class ProfileImpactDecision(DeterminationModel):
    job_id: StrictStr
    score_version: int = Field(ge=1)
    scoring_determination_id: StrictStr = Field(min_length=1)
    profile_id: StrictStr
    scored_profile_version: int = Field(ge=1)
    reviewed_profile_version: int = Field(ge=1)
    verdict: Literal["significant", "insignificant"]
    rationale: StrictStr = Field(min_length=1, max_length=2000)
    citations: list[Citation] = Field(min_length=1, max_length=30)


def review_profile_impact(*, score, current, job, dependencies):
    """No missing baseline or unavailable model may imply 'insignificant'."""
    try:
        previous = ScoreProfileInputs.model_validate(score.trace.profile_inputs)
    except ValidationError:
        raise DeterminationFailure("score_profile_baseline_unavailable") from None
    if (previous.profile_id != current.profile_id
            or previous.profile_version != score.trace.profile_snapshot_version
            or not score.trace.determination_id
            or score.tenant_id != job["tenant_id"] or str(score.job_id) != str(job["job_id"])):
        raise DeterminationFailure("score_profile_binding_invalid")
    binding = dict(job_id=str(score.job_id), score_version=score.version,
                   scoring_determination_id=score.trace.determination_id,
                   profile_id=current.profile_id, scored_profile_version=previous.profile_version,
                   reviewed_profile_version=current.profile_version)
    sources = [Source(source_id="posting", text=build_jd_snapshot(job))]
    catalog = {}
    for prefix, inputs in (("before", previous), ("after", current)):
        for index, source in enumerate(inputs.sources):
            ident = f"{prefix}:{index}"
            sources.append(Source(source_id=ident, text=source.text))
            catalog[ident] = source.source_id
    # Empty profiles still have authored_conditions as a concrete supplied source.
    def validate(result):
        if any(getattr(result, key) != value for key, value in binding.items()):
            raise DeterminationFailure("field_binding_invalid")
        if not any(cite.source_id in catalog for cite in result.citations):
            raise DeterminationFailure("missing_evidence_citation")
    return determine(
        kind="score_profile_impact", schema=ProfileImpactDecision,
        schema_version="1", prompt_version="score-profile-impact-v1",
        instruction=(
            "Decide whether the changes between the BEFORE and AFTER canonical candidate "
            "sources could materially affect this job's saved fit assessment: capability "
            "requirements, supporting evidence, gaps, eligibility, target-role preferences or "
            "warnings. Return significant if a full new assessment is warranted, including "
            "when the impact on the assessment is uncertain. Return insignificant only when "
            "the saved assessment remains applicable. Cosmetic or editorial changes need not "
            "trigger another score; decide their meaning yourself. Do not assign a score or "
            "change candidate facts. Cite the actual changed or equivalent profile sources "
            "and relevant posting evidence. Explain your decision. Copy all binding fields "
            "exactly from context.binding. Source catalog maps comparison IDs to canonical "
            "field IDs; missing fields represent removed data, not permission to invent it."
        ),
        sources=sources, context={"binding": binding, "source_catalog": catalog,
            "saved_assessment": score.breakdown.to_dict(),
            "saved_score": score.fit_score.value},
        entity_id=str(score.job_id), validate=validate, **dependencies,
    )
