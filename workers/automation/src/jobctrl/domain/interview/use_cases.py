"""Interview Preparation generation use case."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from jobctrl.domain.events import (
    InterviewPrepFailedPayload,
    InterviewPrepGeneratedPayload,
    create_interview_prep_failed,
    create_interview_prep_generated,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.interview.value_objects import (
    INTERVIEW_PREP_ITEM_KINDS,
    InterviewPrep,
    InterviewPrepGateAudit,
    InterviewPrepItem,
)
from jobctrl.domain.materials.adversarial import (
    ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
    ADVERSARIAL_REVIEW_THRESHOLD,
    AdversarialReviewResult,
)
from jobctrl.domain.materials.claim_grounding import ground_claim_mappings
from jobctrl.domain.materials.fabrication_detector import (
    build_evidence_corpus,
    build_skill_evidence_corpus,
    build_skill_vocabulary,
    employer_name_set,
    scan_prose_skill_fabrications,
    scan_resume_bullets,
)
from jobctrl.domain.materials.requirement_coverage import GeneratedClaimMapping
from jobctrl.domain.materials.services import sanitize_text
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import TenantId
from jobctrl.resume_profile import get_achievement_evidence

log = logging.getLogger(__name__)

INTERVIEW_PREP_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "InterviewPrepCandidate",
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 12,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "kind",
                    "title",
                    "generated_text",
                    "evidence_ids",
                    "requirement_ids",
                ],
                "properties": {
                    "kind": {"type": "string", "enum": list(INTERVIEW_PREP_ITEM_KINDS)},
                    "title": {"type": "string"},
                    "generated_text": {"type": "string"},
                    "evidence_ids": {"type": "array", "items": {"type": "string"}},
                    "requirement_ids": {"type": "array", "items": {"type": "string"}},
                    "warnings": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#./-]{1,}")
_FIRST_PERSON_EXPERIENCE_RE = re.compile(
    r"(?i)\b("
    r"i\s+(?:built|used|led|owned|managed|implemented|deployed|administered|"
    r"operated|designed|migrated)|"
    r"my\s+experience\s+(?:with|in)|"
    r"experience\s+(?:using|with)"
    r")\b"
)


class InterviewPrepRepository(Protocol):
    def next_generation(self, tenant_id: TenantId, job_id: JobId) -> int: ...

    def find_completed_for_run(
        self, tenant_id: TenantId, job_id: JobId, origin_run_id: str
    ) -> InterviewPrep | None: ...

    def save(
        self, prep: InterviewPrep, *, tenant_id: TenantId, origin_run_id: str = ""
    ) -> None: ...


@dataclass(frozen=True)
class InterviewPrepGenerationOutcome:
    prep: InterviewPrep
    status: str
    errors: tuple[str, ...] = ()


class GenerateInterviewPrepUseCase:
    """Generate grounded interview preparation for one application."""

    def __init__(
        self,
        *,
        repository: InterviewPrepRepository,
        llm: LlmPort,
        publisher: EventPublisher | None = None,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._publisher = publisher

    def execute(
        self,
        *,
        tenant_id: TenantId,
        job: Mapping[str, Any],
        profile_snapshot: ProfileSnapshot,
        evidence_entries: Sequence[Mapping[str, Any]],
        evidence_gaps: Sequence[Mapping[str, Any]],
        requirements: Sequence[Mapping[str, Any]],
        accepted_materials: Sequence[Mapping[str, Any]] = (),
        model: str | None = None,
        origin_run_id: str = "",
    ) -> InterviewPrepGenerationOutcome:
        job_id = JobId(str(job.get("url") or job.get("jobKey") or "").strip())
        if not str(job_id):
            raise ValueError("job must include url/jobKey for interview prep")
        if origin_run_id:
            existing = self._repository.find_completed_for_run(tenant_id, job_id, origin_run_id)
            if existing is not None:
                return _outcome_from_existing(existing)
        generation = self._repository.next_generation(tenant_id, job_id)
        generated_at = _utc_now()
        profile = profile_snapshot.as_dict()
        source_text_by_evidence = _source_text_by_evidence_id(profile)
        known_evidence_ids = frozenset(source_text_by_evidence)
        target_skill_terms = _target_skill_terms(requirements, evidence_gaps)
        model_label = model or str(getattr(self._llm, "model", "") or "default")

        try:
            candidate = self._generate_candidate(
                job=job,
                profile=profile,
                evidence_entries=evidence_entries,
                evidence_gaps=evidence_gaps,
                requirements=requirements,
                accepted_materials=accepted_materials,
                model=model,
            )
            items = _items_from_candidate(
                candidate,
                job_id=str(job_id),
                known_evidence_ids=known_evidence_ids,
                source_text_by_evidence=source_text_by_evidence,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("Interview prep candidate generation failed for %s", job_id)
            return self._fail(
                tenant_id=tenant_id,
                job_id=job_id,
                generation=generation,
                generated_at=generated_at,
                model=model_label,
                reasons=(f"generation_error: {exc}",),
                origin_run_id=origin_run_id,
            )

        gate = _run_truthfulness_gates(
            items=items,
            profile=profile,
            target_skill_terms=target_skill_terms,
            source_text_by_evidence=source_text_by_evidence,
            accepted_materials=accepted_materials,
        )
        if gate.status == "failed":
            return self._fail(
                tenant_id=tenant_id,
                job_id=job_id,
                generation=generation,
                generated_at=generated_at,
                model=model_label,
                reasons=(*gate.fabrication_findings, *gate.grounding_findings),
                origin_run_id=origin_run_id,
            )

        judge = self._judge_candidate(
            job=job,
            profile=profile,
            items=items,
            requirements=requirements,
            model=model,
        )
        if not judge.passed:
            reasons = (*judge.blockers, *judge.repair_instructions)
            return self._fail(
                tenant_id=tenant_id,
                job_id=job_id,
                generation=generation,
                generated_at=generated_at,
                model=model_label,
                reasons=reasons or ("judge rejected interview prep",),
                warnings=judge.warnings,
                judge_verdict=f"{judge.verdict}:{judge.score:.2f}",
                origin_run_id=origin_run_id,
            )

        accepted_gate = InterviewPrepGateAudit(
            status="passed",
            fabrication_findings=(),
            grounding_findings=gate.grounding_findings,
            judge_verdict=f"{judge.verdict}:{judge.score:.2f}",
            warnings=tuple(dict.fromkeys((*gate.warnings, *judge.warnings))),
        )
        prep = InterviewPrep(
            job_id=str(job_id),
            generation=generation,
            status="accepted",
            generated_at=generated_at,
            model=model_label,
            gate_audit=accepted_gate,
            items=items,
        )
        self._repository.save(prep, tenant_id=tenant_id, origin_run_id=origin_run_id)
        self._publish_generated(tenant_id, prep)
        return InterviewPrepGenerationOutcome(prep=prep, status="accepted")

    def _generate_candidate(
        self,
        *,
        job: Mapping[str, Any],
        profile: Mapping[str, Any],
        evidence_entries: Sequence[Mapping[str, Any]],
        evidence_gaps: Sequence[Mapping[str, Any]],
        requirements: Sequence[Mapping[str, Any]],
        accepted_materials: Sequence[Mapping[str, Any]],
        model: str | None,
    ) -> Mapping[str, Any]:
        messages = [
            LlmMessage(
                role="system",
                content=(
                    "You generate stored interview preparation only. "
                    "Never provide live, in-session, streaming, transcript, "
                    "or real-time interview assistance. Return JSON only."
                ),
            ),
            LlmMessage(
                role="user",
                content=_generation_prompt(
                    job=job,
                    profile=profile,
                    evidence_entries=evidence_entries,
                    evidence_gaps=evidence_gaps,
                    requirements=requirements,
                    accepted_materials=accepted_materials,
                ),
            ),
        ]
        return self._llm.chat_json(
            messages,
            response_schema=INTERVIEW_PREP_RESPONSE_SCHEMA,
            model=model,
            temperature=0.2,
            max_tokens=3500,
        )

    def _judge_candidate(
        self,
        *,
        job: Mapping[str, Any],
        profile: Mapping[str, Any],
        items: tuple[InterviewPrepItem, ...],
        requirements: Sequence[Mapping[str, Any]],
        model: str | None,
    ) -> AdversarialReviewResult:
        messages = [
            LlmMessage(
                role="system",
                content=(
                    "Run the existing JobCtrl adversarial review gate for "
                    "stored interview prep. Return JSON matching the schema."
                ),
            ),
            LlmMessage(
                role="user",
                content=_judge_prompt(job=job, profile=profile, items=items, requirements=requirements),
            ),
        ]
        response = self._llm.chat_json(
            messages,
            response_schema=ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
            model=model,
            temperature=0,
            max_tokens=2500,
        )
        return AdversarialReviewResult.from_response(
            response,
            threshold=ADVERSARIAL_REVIEW_THRESHOLD,
            normalized_fit_score=None,
            model=model or str(getattr(self._llm, "model", "") or "default"),
            prompt_messages=tuple(message.__dict__ for message in messages),
        )

    def _fail(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        generation: int,
        generated_at: str,
        model: str,
        reasons: tuple[str, ...],
        warnings: tuple[str, ...] = (),
        judge_verdict: str | None = None,
        origin_run_id: str = "",
    ) -> InterviewPrepGenerationOutcome:
        gate = InterviewPrepGateAudit(
            status="failed",
            fabrication_findings=tuple(reason for reason in reasons if "fabricat" in reason),
            grounding_findings=tuple(reason for reason in reasons if "fabricat" not in reason),
            judge_verdict=judge_verdict,
            warnings=warnings,
        )
        prep = InterviewPrep(
            job_id=str(job_id),
            generation=generation,
            status="failed",
            generated_at=generated_at,
            model=model,
            gate_audit=gate,
            items=(),
        )
        self._repository.save(prep, tenant_id=tenant_id, origin_run_id=origin_run_id)
        self._publish_failed(tenant_id, prep)
        return InterviewPrepGenerationOutcome(
            prep=prep,
            status="failed",
            errors=(*gate.fabrication_findings, *gate.grounding_findings),
        )

    def _publish_generated(self, tenant_id: TenantId, prep: InterviewPrep) -> None:
        if self._publisher is None:
            return
        try:
            self._publisher.publish(
                create_interview_prep_generated(
                    tenant_id,
                    InterviewPrepGeneratedPayload(
                        job_id=prep.job_id,
                        generation=prep.generation,
                        item_count=len(prep.items),
                        generated_at=prep.generated_at,
                    ),
                )
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish InterviewPrepGenerated for %s", prep.job_id)

    def _publish_failed(self, tenant_id: TenantId, prep: InterviewPrep) -> None:
        if self._publisher is None:
            return
        try:
            reason_count = len(prep.gate_audit.fabrication_findings) + len(
                prep.gate_audit.grounding_findings
            )
            self._publisher.publish(
                create_interview_prep_failed(
                    tenant_id,
                    InterviewPrepFailedPayload(
                        job_id=prep.job_id,
                        generation=prep.generation,
                        failed_at=prep.generated_at,
                        reason_count=reason_count,
                    ),
                )
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish InterviewPrepFailed for %s", prep.job_id)


def _outcome_from_existing(prep: InterviewPrep) -> InterviewPrepGenerationOutcome:
    """Rebuild the outcome a prior completed attempt already produced.

    Used when an activity retry finds this workflow run's generation already
    persisted, so the retry returns the prior result instead of re-spending.
    """
    if prep.status == "failed":
        return InterviewPrepGenerationOutcome(
            prep=prep,
            status="failed",
            errors=(
                *prep.gate_audit.fabrication_findings,
                *prep.gate_audit.grounding_findings,
            ),
        )
    return InterviewPrepGenerationOutcome(prep=prep, status="accepted")


def _items_from_candidate(
    candidate: Mapping[str, Any],
    *,
    job_id: str,
    known_evidence_ids: frozenset[str],
    source_text_by_evidence: Mapping[str, str],
) -> tuple[InterviewPrepItem, ...]:
    raw_items = candidate.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("interview prep candidate returned no items")
    items: list[InterviewPrepItem] = []
    for position, raw in enumerate(raw_items):
        if not isinstance(raw, Mapping):
            raise ValueError("interview prep item must be an object")
        evidence_ids = tuple(_dedupe_strings(raw.get("evidence_ids")))
        unknown = [evidence_id for evidence_id in evidence_ids if evidence_id not in known_evidence_ids]
        if unknown:
            raise ValueError(f"unknown evidence id(s): {', '.join(unknown)}")
        source_text = tuple(
            source_text_by_evidence[evidence_id]
            for evidence_id in evidence_ids
            if source_text_by_evidence.get(evidence_id)
        )
        items.append(
            InterviewPrepItem(
                item_id=f"prep-{position + 1}",
                kind=str(raw.get("kind") or ""),  # type: ignore[arg-type]
                title=sanitize_text(str(raw.get("title") or "")),
                generated_text=sanitize_text(str(raw.get("generated_text") or "")),
                evidence_ids=evidence_ids,
                requirement_ids=tuple(_dedupe_strings(raw.get("requirement_ids"))),
                source_text=source_text,
                transform_type="grounded_interview_prep",
                control="never_fabricate",
                grounding_audit=(),
                warnings=tuple(_dedupe_strings(raw.get("warnings"))),
                position=position,
            )
        )
    return tuple(items)


def _run_truthfulness_gates(
    *,
    items: tuple[InterviewPrepItem, ...],
    profile: Mapping[str, Any],
    target_skill_terms: tuple[str, ...],
    source_text_by_evidence: Mapping[str, str],
    accepted_materials: Sequence[Mapping[str, Any]],
) -> InterviewPrepGateAudit:
    profile_dict = dict(profile)
    corpus = build_evidence_corpus(profile_dict)
    bullets = [(item.item_id, item.generated_text) for item in items]
    fabrication_findings = [
        finding.describe()
        for finding in scan_resume_bullets(
            bullets,
            corpus,
            employers=employer_name_set(profile_dict),
        )
    ]
    claim_bearing = [
        (item.item_id, item.generated_text)
        for item in items
        if item.kind != "gap_drill"
    ]
    fabrication_findings.extend(
        finding.describe()
        for finding in scan_prose_skill_fabrications(
            claim_bearing,
            target_skill_terms=target_skill_terms,
            allowed_skill_terms=build_skill_vocabulary(profile_dict),
            corpus=build_skill_evidence_corpus(profile_dict),
        )
    )

    grounding_findings: list[str] = []
    for item in items:
        if item.kind == "star_draft" and not item.evidence_ids:
            grounding_findings.append(f"{item.item_id} star draft has no evidence ids")
        for evidence_id in item.evidence_ids:
            if evidence_id not in source_text_by_evidence:
                grounding_findings.append(f"{item.item_id} references unknown evidence {evidence_id}")
        if item.kind == "gap_drill" and _gap_drill_asserts_experience(
            item.generated_text,
            target_skill_terms,
        ):
            grounding_findings.append(
                f"{item.item_id} gap drill asserts experience instead of naming the gap"
            )

    mappings = [
        GeneratedClaimMapping(
            claim_id=f"claim-{item.item_id}",
            location=item.item_id,
            text=item.generated_text,
            claim_label="evidence_reframed" if item.evidence_ids else "positioning",
            coverage_edge_ids=item.requirement_ids,
            requirement_ids=item.requirement_ids,
            evidence_ids=item.evidence_ids,
            non_requirement_reason="" if item.requirement_ids else "positioning",
            review_required=False,
        )
        for item in items
        if item.kind == "star_draft" and item.requirement_ids
    ]
    grounding = ground_claim_mappings(
        mappings,
        _canonical_grounding_lines(items, accepted_materials),
    )
    grounding_findings.extend(
        f"{claim.claim_id} ungrounded: {claim.reason}"
        for claim in grounding.ungrounded
    )
    return InterviewPrepGateAudit(
        status="failed" if fabrication_findings or grounding_findings else "passed",
        fabrication_findings=tuple(fabrication_findings),
        grounding_findings=tuple(grounding_findings),
        judge_verdict=None,
        warnings=(),
    )


def _canonical_grounding_lines(
    items: tuple[InterviewPrepItem, ...],
    accepted_materials: Sequence[Mapping[str, Any]],
) -> tuple[tuple[str, str], ...]:
    lines: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(line_id: str, text: object) -> None:
        clean = sanitize_text(str(text or ""))
        if not clean:
            return
        key = (line_id, clean)
        if key in seen:
            return
        seen.add(key)
        lines.append(key)

    for item in items:
        for index, text in enumerate(item.source_text):
            add(f"{item.item_id}:evidence:{index}", text)

    for index, material in enumerate(accepted_materials):
        line_id = str(
            material.get("bulletId")
            or material.get("bullet_id")
            or material.get("artifactId")
            or material.get("artifact_id")
            or f"accepted-material-{index}"
        )
        add(line_id, material.get("generatedText") or material.get("generated_text"))

    return tuple(lines)


def _source_text_by_evidence_id(profile: Mapping[str, Any]) -> dict[str, str]:
    sources: dict[str, str] = {}
    for item in get_achievement_evidence(dict(profile)):
        if not isinstance(item, Mapping):
            continue
        evidence_id = str(item.get("id") or "").strip()
        if not evidence_id:
            continue
        fragments = [
            str(item.get("source_text") or "").strip(),
            str(item.get("scope") or "").strip(),
            str(item.get("action") or "").strip(),
            str(item.get("outcome") or "").strip(),
            " ".join(str(value) for value in item.get("metrics") or ()),
            " ".join(str(value) for value in item.get("tools") or ()),
        ]
        source = " | ".join(fragment for fragment in fragments if fragment)
        sources[evidence_id] = source or evidence_id
    return sources


def _target_skill_terms(
    requirements: Sequence[Mapping[str, Any]],
    gaps: Sequence[Mapping[str, Any]],
) -> tuple[str, ...]:
    terms: list[str] = []
    for requirement in requirements:
        for key in ("requirementText", "text", "keywords", "hardSkills"):
            value = requirement.get(key)
            if isinstance(value, str):
                terms.extend(_TOKEN_RE.findall(value))
            elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                for item in value:
                    terms.extend(_TOKEN_RE.findall(str(item)))
    for gap in gaps:
        for key in ("demandedSkill", "requirementText"):
            value = gap.get(key)
            if isinstance(value, str):
                terms.extend(_TOKEN_RE.findall(value))
    return tuple(dict.fromkeys(term for term in terms if len(term) > 2))


def _gap_drill_asserts_experience(text: str, target_skill_terms: tuple[str, ...]) -> bool:
    if not _FIRST_PERSON_EXPERIENCE_RE.search(text):
        return False
    lowered = text.lower()
    return any(term.lower() in lowered for term in target_skill_terms)


def _generation_prompt(
    *,
    job: Mapping[str, Any],
    profile: Mapping[str, Any],
    evidence_entries: Sequence[Mapping[str, Any]],
    evidence_gaps: Sequence[Mapping[str, Any]],
    requirements: Sequence[Mapping[str, Any]],
    accepted_materials: Sequence[Mapping[str, Any]],
) -> str:
    safe_profile = {
        "experience": profile.get("experience"),
        "resume_facts": profile.get("resume_facts"),
        "skills_boundary": profile.get("skills_boundary"),
    }
    context = {
        "job": _safe_job(job),
        "profile": safe_profile,
        "evidence_map_entries": list(evidence_entries)[:12],
        "evidence_gaps": list(evidence_gaps)[:12],
        "requirements": list(requirements)[:20],
        "accepted_materials": list(accepted_materials)[:20],
    }
    return f"""Generate stored pre-interview preparation for this one job.

Allowed item kinds:
- theme: likely interview theme from job requirements.
- star_draft: STAR story strictly from profile evidence; include evidence_ids.
- gap_drill: honest practice prompt for a missing/weak requirement; do not claim
  the candidate has the missing experience.
- company_note: per-posting note from employer analysis/job facts only.

Rules:
- Use only the provided profile evidence, accepted materials, employer analysis,
  requirement fit, and evidence map facts.
- Every star_draft must include at least one evidence_id.
- Every gap_drill must include at least one requirement_id and must label the gap
  honestly.
- No live or in-session assistance, no transcript/microphone/streaming wording,
  and no real-time answer suggestions.
- Return only JSON matching the schema.

CONTEXT:
{json.dumps(context, ensure_ascii=False, indent=2)}
"""


def _judge_prompt(
    *,
    job: Mapping[str, Any],
    profile: Mapping[str, Any],
    items: tuple[InterviewPrepItem, ...],
    requirements: Sequence[Mapping[str, Any]],
) -> str:
    context = {
        "job": _safe_job(job),
        "profile_evidence_ids": sorted(_source_text_by_evidence_id(profile)),
        "requirements": list(requirements)[:20],
        "prep_items": [item.to_read_model() for item in items],
    }
    return f"""Review the generated interview prep as the existing JobCtrl judge gate.

Fail on any unsupported metric, invented tool, inflated seniority, ungrounded
STAR story, dishonest gap drill, AI-sounding generic answer, or any live /
in-session / real-time interview assistance surface. Passing prep must be useful
before an interview and defensible during follow-up questions.

Return only JSON matching the adversarial review schema.

CONTEXT:
{json.dumps(context, ensure_ascii=False, indent=2)}
"""


def _safe_job(job: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "url": job.get("url") or job.get("jobKey"),
        "title": job.get("title"),
        "company": job.get("company") or job.get("employer"),
        "fit_score": job.get("fit_score") or job.get("fitScore"),
    }


def _dedupe_strings(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "INTERVIEW_PREP_RESPONSE_SCHEMA",
    "GenerateInterviewPrepUseCase",
    "InterviewPrepGenerationOutcome",
]
