"""Materials Generation use cases — application-layer orchestration.

See ddd-target.md §3.5 (use cases own transaction boundaries) and §4.5.

Three use cases live here:

  ``TailorResumeUseCase``        — given a profile snapshot + job dict,
                                    builds the prompt, calls the LLM,
                                    validates, judges, persists a new
                                    or updated MaterialsSet, and publishes
                                    ``ResumeApproved`` / ``ResumeFailed``.
  ``GenerateCoverLetterUseCase`` — given an approved MaterialsSet's
                                    tailored resume text + a job dict,
                                    generates the cover letter, validates,
                                    persists it onto the existing
                                    aggregate, and publishes
                                    ``CoverLetterGenerated``.
  ``RenderPdfUseCase``           — given a MaterialsSet with text
                                    artifacts, renders the appropriate
                                    PDFs via the ``PdfRendererPort``,
                                    appends them to the aggregate, and
                                    publishes ``PdfRendered``.

All three accept their dependencies as constructor arguments so tests
can swap fakes without monkey-patching.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Callable, Iterable, Mapping as MappingABC
from contextlib import nullcontext
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — type-only import, avoids any import cycle
    from jobctrl.domain.materials.analyze_use_case import AnalyzeJobUseCase
    from jobctrl.domain.ports.scoring import RequirementFitReportRepository
    from jobctrl.domain.scoring.value_objects import RequirementFitReport

from jobctrl.domain.events import (
    BulletProvenanceRecordedPayload,
    CoverLetterGeneratedPayload,
    PdfRenderedPayload,
    ResumeApprovedPayload,
    ResumeFailedPayload,
    create_bullet_provenance_recorded,
    create_cover_letter_generated,
    create_pdf_rendered,
    create_resume_approved,
    create_resume_failed,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.aggregate import (
    MaterialsLifecycle,
    MaterialsSet,
    MaterialsSetFactory,
)
from jobctrl.domain.materials.analysis import EmployerAnalysis
from jobctrl.domain.materials.adversarial import (
    ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
    ADVERSARIAL_REVIEW_THRESHOLD,
    AdversarialReviewResult,
    build_adversarial_review_prompt,
    normalized_job_fit_score,
    should_run_adversarial_review,
)
from jobctrl.domain.materials.coverage_audit import (
    KeywordCoverage,
    compute_keyword_coverage,
)
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.fabrication_detector import (
    EvidenceCorpus,
    FabricationError,
    FabricationFinding,
    build_evidence_corpus,
    build_skill_evidence_corpus,
    build_skill_vocabulary,
    employer_name_set,
    scan_cover_letter,
    scan_prose_skill_fabrications,
    scan_resume_bullets,
)
from jobctrl.domain.materials.policy import (
    LearnedTailoringRules,
    TailoringPolicy,
    fingerprint_profile_snapshot,
    fingerprint_value,
)
from jobctrl.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobctrl.domain.materials.provenance_builder import (
    ProvenanceBindingError,
    build_bullet_provenance,
)
from jobctrl.domain.materials.voice import (
    VoicePassRecord,
    VoiceResult,
    apply_voice_to_payload,
    build_voice_request,
    summary_voice_rejection_reason,
)
from jobctrl.domain.materials.voice_metrics import measure_voice_delta
from jobctrl.domain.materials.claim_grounding import (
    ClaimGrounding,
    enrich_provenance_requirements,
    ground_claim_mappings,
)
from jobctrl.domain.materials.quality import (
    TailoringPlan,
    TailoringPrerequisiteError,
    build_tailoring_change_annotations,
    build_tailoring_plan,
    evaluate_tailoring_quality,
)
from jobctrl.domain.materials.requirement_coverage import (
    GeneratedClaimMapping,
    bullet_limit_overflows,
    decide_score_gated_revision,
    score_generated_resume_against_target,
    validate_generated_claim_mappings,
    validate_mandatory_covered_achievements,
)
from jobctrl.domain.materials.services import (
    BANNED_WORDS,
    ContentValidator,
    LLM_LEAK_PHRASES,
    ResumeAssembler,
    normalize_profile_list,
    sanitize_text,
)
from jobctrl.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    ControlRule,
    JudgeVerdict,
    LlmModelSpec,
    RenderFormat,
    TransformType,
    ValidationResult,
)
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.domain.ports.materials import (
    BulletProvenanceRepository,
    EmployerAnalysisRepository,
    MaterialsRepository,
    PdfRendererPort,
    TailoringPolicyRepository,
    UnitOfWork,
    VoicePort,
)
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.resume_profile import (
    get_custom_tailoring_prompt,
    get_education_entries,
    get_experience_entries,
    get_max_experience_bullets,
    get_required_bullets_by_experience_id,
    get_required_experience_entry_ids,
    get_required_skill_category_ids,
    get_resume_constraints,
    get_resume_master,
    get_skill_categories,
    get_tailoring_policy,
    get_writing_style,
    require_resume_master,
)

log = logging.getLogger(__name__)

TAILORING_PROMPT_VERSION = "tailor.v5.explicit-summary-sentences"
TAILORING_SCHEMA_VERSION = "tailored-resume.v3"
TAILORING_JUDGE_SCHEMA_VERSION = "tailor-judge.v1"
TAILORING_JUDGE_CRITERIA: tuple[str, ...] = (
    "relevance_to_job",
    "evidence_support",
    "fabrication_safety",
    "required_content_preserved",
    "ats_readability",
    "specificity_and_metrics",
)
COVER_LETTER_COMPLETION_MARKER = "END_OF_COVER_LETTER"


def _score_schema() -> dict[str, Any]:
    return {"type": "number", "minimum": 0, "maximum": 1}


def _criterion_scores_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(TAILORING_JUDGE_CRITERIA),
        "properties": {criterion: _score_schema() for criterion in TAILORING_JUDGE_CRITERIA},
    }

TAILORED_RESUME_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "TailoredResumePayload",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "executive_profile",
        "executive_profile_sentences",
        "experience_updates",
        "skill_category_updates",
        "generated_claim_mappings",
    ],
    "properties": {
        "executive_profile": {"type": "string"},
        "executive_profile_sentences": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "description": (
                "The ordered grammatical sentences that form executive_profile. Joining these "
                "items with one space must reproduce executive_profile exactly."
            ),
            "items": {"type": "string"},
        },
        "experience_updates": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "title", "bullets"],
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "bullets": {
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "string"},
                    },
                },
            },
        },
        "skill_category_updates": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "items"],
                "properties": {
                    "id": {"type": "string"},
                    "items": {
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "string"},
                    },
                },
            },
        },
        "generated_claim_mappings": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "claim_id",
                    "location",
                    "text",
                    "claim_label",
                    "coverage_edge_ids",
                    "requirement_ids",
                    "evidence_ids",
                    "non_requirement_reason",
                    "review_required",
                ],
                "properties": {
                    "claim_id": {"type": "string"},
                    "location": {
                        "type": "string",
                        "description": (
                            "Use executive_profile only when executive_profile_sentences has one "
                            "item; otherwise use executive_profile.sentence[N] for each explicit "
                            "sentence. Use experience.<id>.bullets[N] for bullets and skills.<id> "
                            "for one complete rendered skill group."
                        ),
                    },
                    "text": {
                        "type": "string",
                        "description": (
                            "Exact text at location. For skills.<id>, join every selected item "
                            "in rendered order with comma-space separators."
                        ),
                    },
                    "claim_label": {
                        "type": "string",
                        "enum": [
                            "verified",
                            "evidence_reframed",
                            "adjacent_translation",
                            "draft_requires_confirmation",
                            "pinned",
                            "positioning",
                            "structure",
                        ],
                    },
                    "coverage_edge_ids": {"type": "array", "items": {"type": "string"}},
                    "requirement_ids": {"type": "array", "items": {"type": "string"}},
                    "evidence_ids": {"type": "array", "items": {"type": "string"}},
                    "non_requirement_reason": {
                        "type": "string",
                        "enum": ["pinned", "positioning", "structure"],
                        "description": (
                            "Required fallback classification. It is ignored when coverage_edge_ids "
                            "is non-empty; when no edge is used it must describe the claim."
                        ),
                    },
                    "review_required": {"type": "boolean"},
                },
            },
        },
    },
}

TAILORING_JUDGE_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "TailoringJudgeResult",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "verdict",
        "score",
        "criterion_scores",
        "issues",
        "unsupported_claims",
        "fabrications",
        "missing_required_evidence",
        "repair_instructions",
    ],
    "properties": {
        "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
        "score": {"type": "number", "minimum": 0, "maximum": 1},
        "criterion_scores": _criterion_scores_schema(),
        "issues": {"type": "array", "items": {"type": "string"}},
        "unsupported_claims": {"type": "array", "items": {"type": "string"}},
        "fabrications": {"type": "array", "items": {"type": "string"}},
        "missing_required_evidence": {"type": "array", "items": {"type": "string"}},
        "repair_instructions": {"type": "array", "items": {"type": "string"}},
    },
}

LOW_QUALITY_LABEL_ONLY_WARNING_PREFIXES = ("Stock phrase markers:",)


@dataclass(frozen=True)
class TailoringLlmPolicy:
    """Model and quality policy for one tailor invocation."""

    candidate_models: tuple[str, ...] = ()
    judge_model: str | None = None
    judge_min_score: float = 0.82
    candidate_temperature: float = 0.35
    judge_temperature: float = 0.0
    candidate_max_tokens: int = 65536
    judge_max_tokens: int = 8192
    thinking_budget: int | None = 0

    def __post_init__(self) -> None:
        normalized = tuple(_safe_model_arg(model) for model in self.candidate_models)
        normalized = tuple(model for model in normalized if model)
        object.__setattr__(self, "candidate_models", normalized)
        if self.judge_model is not None:
            object.__setattr__(self, "judge_model", _safe_model_arg(self.judge_model))
        score = float(self.judge_min_score)
        if score < 0.0 or score > 1.0:
            raise ValueError("judge_min_score must be in [0.0, 1.0]")
        object.__setattr__(self, "judge_min_score", score)

    @classmethod
    def from_env(cls) -> "TailoringLlmPolicy":
        from jobctrl import config

        return cls(
            candidate_models=config.get_tailoring_generator_models(),
            judge_model=config.get_tailoring_judge_model(),
            judge_min_score=config.get_tailoring_judge_min_score(),
        )

    @property
    def effective_candidate_models(self) -> tuple[str, ...]:
        return self.candidate_models or (DEFAULT_PIPELINE_LLM_MODEL_SPEC,)

    @property
    def effective_judge_model(self) -> str:
        return self.judge_model or self.effective_candidate_models[0]


def _split_model_specs(value: str | tuple[str, ...] | list[str] | None) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        items = value.split(",")
    else:
        items = []
        for item in value:
            items.extend(str(item).split(","))
    return tuple(item.strip() for item in items if item and item.strip())


def _safe_model_arg(value: str | None) -> str:
    spec = LlmModelSpec.parse(value)
    return spec.model_arg or "default"


@dataclass(frozen=True)
class _TailorCandidate:
    payload: dict
    validation: ValidationResult
    verdict: JudgeVerdict | None
    tailored_text: str
    model: str
    record: dict[str, Any]

    @property
    def judge_score(self) -> float:
        return self.verdict.score if self.verdict is not None else 1.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_filename_prefix(job: dict) -> str:
    safe_title = re.sub(r"[^\w\s-]", "", job.get("title", ""))[:50].strip().replace(" ", "_")
    safe_site = re.sub(r"[^\w\s-]", "", _job_company(job))[:20].strip().replace(" ", "_")
    digest = sha1(str(job.get("url", "")).encode("utf-8")).hexdigest()[:10]
    return f"{safe_site}_{safe_title}_{digest}"


def _job_company(job: dict) -> str:
    return str(job.get("company") or job.get("employer") or job.get("site") or "").strip()


def _build_job_blob(job: dict) -> str:
    return (
        f"TITLE: {job.get('title', '')}\n"
        f"COMPANY: {_job_company(job)}\n"
        f"SOURCE: {job.get('site', '')}\n"
        f"LOCATION: {job.get('location') or 'N/A'}\n\n"
        f"DESCRIPTION:\n{(job.get('full_description') or '')[:6000]}"
    )


def _strip_preamble(text: str) -> str:
    """Remove LLM preamble before 'Dear Hiring Manager,' if present."""
    dear_idx = text.lower().find("dear")
    if dear_idx > 0:
        return text[dear_idx:]
    return text


def _strip_cover_letter_completion_marker(text: str) -> tuple[str, bool]:
    """Remove the internal cover-letter completion marker from model output."""
    marker_line = re.compile(
        rf"(?im)^\s*{re.escape(COVER_LETTER_COMPLETION_MARKER)}\s*$"
    )
    match = marker_line.search(text)
    if match is None:
        return text.rstrip(), False
    return text[: match.start()].rstrip(), True


def _extract_json(raw: str) -> dict:
    """Robustly extract JSON from LLM response (handles fences, preamble)."""
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    if "```" in raw:
        for part in raw.split("```")[1::2]:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                return json.loads(part)
            except json.JSONDecodeError:
                continue
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError("No valid JSON found in LLM response")


def _candidate_payload_summary(payload: dict) -> dict[str, Any]:
    executive_profile = str(payload.get("executive_profile") or "")
    experience_updates = payload.get("experience_updates") or []
    skill_updates = payload.get("skill_category_updates") or []
    return {
        "executive_profile_chars": len(executive_profile),
        "experience_updates": len(experience_updates) if isinstance(experience_updates, list) else 0,
        "skill_category_updates": len(skill_updates) if isinstance(skill_updates, list) else 0,
    }


def _as_string_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _claim_mappings_from_payload(
    payload: dict,
) -> tuple[tuple[GeneratedClaimMapping, ...], tuple[str, ...]]:
    raw_items = payload.get("generated_claim_mappings", ())
    if not isinstance(raw_items, list):
        return (), ("generated_claim_mappings must be an array",)
    mappings: list[GeneratedClaimMapping] = []
    errors: list[str] = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            errors.append(f"generated_claim_mappings[{index}] must be an object")
            continue
        try:
            coverage_edge_ids = tuple(
                str(item) for item in raw.get("coverage_edge_ids", ()) or ()
            )
            non_requirement_reason = str(raw.get("non_requirement_reason") or "")
            if coverage_edge_ids and non_requirement_reason:
                non_requirement_reason = ""
            mappings.append(
                GeneratedClaimMapping(
                    claim_id=str(raw.get("claim_id") or ""),
                    location=str(raw.get("location") or ""),
                    text=str(raw.get("text") or ""),
                    claim_label=str(raw.get("claim_label") or ""),
                    coverage_edge_ids=coverage_edge_ids,
                    requirement_ids=tuple(str(item) for item in raw.get("requirement_ids", ()) or ()),
                    evidence_ids=tuple(str(item) for item in raw.get("evidence_ids", ()) or ()),
                    non_requirement_reason=non_requirement_reason,
                    review_required=bool(raw.get("review_required", False)),
                )
            )
        except ValueError as exc:
            errors.append(f"generated_claim_mappings[{index}]: {exc}")
    return tuple(mappings), tuple(errors)


def _claim_mapping_binding_errors(
    *,
    payload: dict,
    mappings: Iterable[GeneratedClaimMapping],
    tailoring_plan: TailoringPlan | None = None,
) -> tuple[str, ...]:
    surfaces = _generated_claim_surfaces(payload, tailoring_plan=tailoring_plan)
    mappings = tuple(mappings)
    _summary_sentences, summary_contract_errors = _generated_summary_sentence_contract(payload)
    errors = list(summary_contract_errors)
    bound_locations: list[str] = []
    for mapping in mappings:
        location = _canonical_claim_location(mapping.location)
        actual_text = surfaces.get(location)
        if actual_text is None:
            errors.append(
                f"Generated claim {mapping.claim_id} location {mapping.location!r} "
                "does not exist in the generated payload."
            )
            continue
        if _claim_location_requires_exact_text(location):
            text_is_bound = actual_text == mapping.text
        else:
            text_is_bound = _claim_text_is_bound(actual_text, mapping.text)
        if not text_is_bound:
            relationship = (
                "does not exactly match"
                if _claim_location_requires_exact_text(location)
                else "is not present at"
            )
            errors.append(
                f"Generated claim {mapping.claim_id} text {relationship} "
                f"generated payload location {mapping.location!r}."
            )
            continue
        bound_locations.append(location)
    for label, locations in _required_claim_surface_groups(payload):
        count = sum(location in locations for location in bound_locations)
        if count == 0:
            errors.append(f"Generated claim mapping is missing for {label}.")
        elif count > 1:
            errors.append(
                f"Generated claim surface {label} has {count} mappings; expected exactly one."
            )
    return tuple(errors)


def _generated_claim_surfaces(
    payload: dict,
    *,
    tailoring_plan: TailoringPlan | None = None,
) -> dict[str, str]:
    surfaces: dict[str, str] = {}
    executive_profile = str(payload.get("executive_profile") or "")
    if executive_profile:
        summary_sentences, _errors = _generated_summary_sentence_contract(payload)
        if len(summary_sentences) == 1:
            for location in ("executive_profile", "summary", "resume.executive_profile"):
                surfaces[location] = executive_profile
        for index, sentence in enumerate(summary_sentences):
            surfaces[f"executive_profile.sentence[{index}]"] = sentence
    updates = payload.get("experience_updates")
    for update_index, update in enumerate(updates if isinstance(updates, list) else ()):
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "").strip()
        if not entry_id:
            continue
        title = str(update.get("title") or "").strip()
        if title:
            for location in (
                f"experience.{entry_id}.title",
                f"experience_updates.{entry_id}.title",
                f"experience_updates[{update_index}].title",
            ):
                surfaces[location] = title
        bullets = update.get("bullets")
        if not isinstance(bullets, list):
            continue
        for index, bullet in enumerate(bullets):
            text = str(bullet or "").strip()
            if not text:
                continue
            for location in (
                f"experience.{entry_id}.bullets[{index}]",
                f"experience_updates.{entry_id}.bullets[{index}]",
                f"experience_updates[{update_index}].bullets[{index}]",
            ):
                surfaces[location] = text
    skill_updates = payload.get("skill_category_updates")
    for update_index, update in enumerate(skill_updates if isinstance(skill_updates, list) else ()):
        if not isinstance(update, dict):
            continue
        category_id = str(update.get("id") or "").strip()
        if not category_id:
            continue
        items = [str(item or "").strip() for item in update.get("items") or [] if str(item or "").strip()]
        if not items:
            continue
        joined = ", ".join(items)
        for location in (
            f"skills.{category_id}",
            f"skill_categories.{category_id}",
            f"skill_category_updates.{category_id}",
            f"skill_category_updates[{update_index}]",
        ):
            surfaces[location] = joined
        for index, item in enumerate(items):
            for location in (
                f"skills.{category_id}.items[{index}]",
                f"skill_categories.{category_id}.items[{index}]",
                f"skill_category_updates.{category_id}.items[{index}]",
                f"skill_category_updates[{update_index}].items[{index}]",
            ):
                surfaces[location] = item
    if tailoring_plan is not None:
        education_items = [
            item
            for item in tailoring_plan.evidence_items
            if str(item.evidence_id).startswith("education:")
        ]
        education_section_text = " ".join(
            str(item.source_text or "").strip()
            for item in education_items
            if str(item.source_text or "").strip()
        )
        if education_section_text:
            surfaces["education"] = education_section_text
        for index, item in enumerate(education_items):
            entry_id = item.evidence_id.split(":", 1)[1]
            text = str(item.source_text or "").strip()
            if not entry_id or not text:
                continue
            for location in (
                f"education.{entry_id}",
                f"education:{entry_id}",
                f"education[{index}]",
                f"education_updates[{index}]",
            ):
                surfaces[location] = text
    return surfaces


def _canonical_claim_location(location: str) -> str:
    normalized = str(location or "").strip()
    sentence_match = re.fullmatch(
        r"(?:(?:profile\.)?(?:executive_profile|summary))(?:\.sentences?)?\[(\d+)\]",
        normalized,
    )
    if sentence_match:
        return f"executive_profile.sentence[{sentence_match.group(1)}]"
    return re.sub(r"\.bullet\[(\d+)\]$", r".bullets[\1]", normalized)


def _skill_group_claim_location(location: str) -> bool:
    """Return whether a mapping targets one complete rendered skill group.

    Ids may contain dots ("node.js"): any bracket-free remainder after the
    section prefix is the category id, while item locations always carry an
    ``.items[N]`` bracket suffix and therefore never match.
    """
    return bool(
        re.fullmatch(
            r"(?:skills|skill_categories|skill_category_updates)\.[^\[\]]+",
            location,
        )
        or re.fullmatch(r"skill_category_updates\[\d+\]", location)
    )


def _claim_location_requires_exact_text(location: str) -> bool:
    # Entry ids may contain dots ("acme.co"); the trailing ".bullets[N]"
    # component is unambiguous, so backtracking splits the id correctly.
    return bool(
        location in {"executive_profile", "summary", "resume.executive_profile"}
        or re.fullmatch(r"executive_profile\.sentence\[\d+\]", location)
        or re.fullmatch(
            r"(?:experience|experience_updates)(?:\.[^\[\]]+|\[\d+\])\.bullets\[\d+\]",
            location,
        )
        or _skill_group_claim_location(location)
    )


def _generated_summary_sentence_contract(
    payload: dict,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    raw_sentences = payload.get("executive_profile_sentences")
    if not isinstance(raw_sentences, list):
        return (), ("executive_profile_sentences must be an ordered array.",)
    errors: list[str] = []
    if not 1 <= len(raw_sentences) <= 4:
        errors.append("executive_profile_sentences must contain between 1 and 4 items.")
    sentences: list[str] = []
    for index, value in enumerate(raw_sentences):
        if not isinstance(value, str) or not value.strip():
            errors.append(
                f"executive_profile_sentences[{index}] must be a non-empty string."
            )
            continue
        if value != value.strip():
            errors.append(
                f"executive_profile_sentences[{index}] must not contain outer whitespace."
            )
        sentences.append(value.strip())
    executive_profile = str(payload.get("executive_profile") or "")
    if sentences and " ".join(sentences) != executive_profile:
        errors.append(
            "Joining executive_profile_sentences with one space must reproduce "
            "executive_profile exactly."
        )
    return tuple(sentences), tuple(errors)


def _required_claim_surface_groups(
    payload: dict,
) -> tuple[tuple[str, frozenset[str]], ...]:
    """Return every generated surface that must have exactly one bound mapping."""

    groups: list[tuple[str, frozenset[str]]] = []
    summary_sentences, _errors = _generated_summary_sentence_contract(payload)
    for index, _sentence in enumerate(summary_sentences):
        locations = {f"executive_profile.sentence[{index}]"}
        if len(summary_sentences) == 1:
            locations.update(
                {
                    "executive_profile",
                    "summary",
                    "resume.executive_profile",
                }
            )
        groups.append(
            (
                f"executive profile sentence {index}",
                frozenset(locations),
            )
        )

    updates = payload.get("experience_updates")
    for update_index, update in enumerate(updates if isinstance(updates, list) else ()):
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "").strip()
        if not entry_id:
            continue
        bullets = update.get("bullets")
        for bullet_index, bullet in enumerate(bullets if isinstance(bullets, list) else ()):
            if not str(bullet or "").strip():
                continue
            groups.append(
                (
                    f"experience {entry_id} bullet {bullet_index}",
                    frozenset(
                        {
                            f"experience.{entry_id}.bullets[{bullet_index}]",
                            f"experience_updates.{entry_id}.bullets[{bullet_index}]",
                            f"experience_updates[{update_index}].bullets[{bullet_index}]",
                        }
                    ),
                )
            )

    skill_updates = payload.get("skill_category_updates")
    for update_index, update in enumerate(
        skill_updates if isinstance(skill_updates, list) else ()
    ):
        if not isinstance(update, dict):
            continue
        category_id = str(update.get("id") or "").strip()
        items = [
            str(item or "").strip()
            for item in update.get("items") or []
            if str(item or "").strip()
        ]
        if not category_id or not items:
            continue
        groups.append(
            (
                f"skill group {category_id}",
                frozenset(
                    {
                        f"skills.{category_id}",
                        f"skill_categories.{category_id}",
                        f"skill_category_updates.{category_id}",
                        f"skill_category_updates[{update_index}]",
                    }
                ),
            )
        )
    return tuple(groups)


def _claim_text_is_bound(actual_text: str, mapped_text: str) -> bool:
    actual = _normalize_generated_claim_text(actual_text)
    mapped = _normalize_generated_claim_text(mapped_text)
    if not actual or not mapped:
        return False
    return mapped in actual or actual in mapped


def _normalize_generated_claim_text(value: str) -> str:
    return " ".join(str(value or "").lower().split())


def _claim_mapping_validation_errors(
    *,
    payload: dict,
    tailoring_plan: TailoringPlan,
) -> tuple[str, ...]:
    mappings, parse_errors = _claim_mappings_from_payload(payload)
    errors = list(parse_errors)
    if not parse_errors:
        errors.extend(
            _claim_mapping_binding_errors(
                payload=payload,
                mappings=mappings,
                tailoring_plan=tailoring_plan,
            )
        )
    graph = tailoring_plan.coverage_graph
    if graph is not None:
        errors.extend(
            validate_generated_claim_mappings(
                mappings,
                graph,
                controls=tailoring_plan.requirement_led_controls,
            )
        )
        errors.extend(
            "Missing mandatory covered achievement in generated claims: " + evidence_id
            for evidence_id in validate_mandatory_covered_achievements(graph, mappings)
        )
    return tuple(errors)


def _post_generation_fit_gate(
    *,
    payload: dict,
    tailoring_plan: TailoringPlan,
    attempt: int,
    shipped_rows: tuple[BulletProvenance, ...],
) -> tuple[dict[str, Any] | None, tuple[str, ...], tuple[str, ...]]:
    target_profile = tailoring_plan.target_profile
    if target_profile is None:
        return None, (), ()
    mappings, parse_errors = _claim_mappings_from_payload(payload)
    if parse_errors or _claim_mapping_binding_errors(
        payload=payload,
        mappings=mappings,
        tailoring_plan=tailoring_plan,
    ):
        return None, (), ()
    # Ground every coverage-bearing claim against the lines the resume actually
    # ships (the assembler-mirroring provenance rows), so must-have coverage is
    # measured, never self-reported. An ungrounded claim's requirements count as
    # uncovered and drive the revision loop via prioritized fixes.
    grounding = ground_claim_mappings(
        mappings,
        tuple((row.bullet_id, row.generated_text) for row in shipped_rows),
    )
    fit_score = score_generated_resume_against_target(
        target_profile=target_profile,
        mappings=mappings,
        grounding=grounding,
    )
    decision = decide_score_gated_revision(
        fit_score=fit_score,
        controls=tailoring_plan.requirement_led_controls,
        attempt=attempt,
    )
    record = {
        "fit_score": fit_score.to_dict(),
        "revision_decision": decision.to_dict(),
        "grounding": grounding.to_metadata(),
        "residual_warnings": [],
    }
    errors: list[str] = []
    review_blockers = tuple(decision.review_blockers) if decision.review_blocked else ()
    if decision.disposition == "revise":
        errors.append(
            "Post-generation fit score below revision gate; revise using prioritized fixes: "
            + "; ".join(decision.prioritized_fixes[:5])
        )
    elif decision.disposition == "accept_with_residual_gap":
        if decision.enhancement_allowed:
            reason = "the bounded revision budget was exhausted"
        else:
            reason = "the missing experience cannot be added from canonical profile evidence"
        record["residual_warnings"] = [
            "Residual job-fit gap: "
            + reason
            + "; the truthful candidate was preserved for review: "
            + "; ".join(decision.prioritized_fixes[:5])
        ]
    return record, tuple(errors), review_blockers


def _candidate_requires_review(record: MappingABC[str, Any]) -> bool:
    fit = record.get("post_generation_fit")
    if not isinstance(fit, MappingABC):
        return False
    decision = fit.get("revision_decision")
    if not isinstance(decision, MappingABC):
        return False
    return bool(decision.get("review_blocked"))


def _bullet_limit_overflow_metadata(
    *,
    payload: dict,
    profile_snapshot: ProfileSnapshot,
) -> tuple[dict[str, Any], ...]:
    profile = profile_snapshot.as_dict()
    max_bullets = get_max_experience_bullets(profile)
    if max_bullets <= 0:
        return ()
    mappings, parse_errors = _claim_mappings_from_payload(payload)
    if parse_errors or _claim_mapping_binding_errors(payload=payload, mappings=mappings):
        mappings = ()
    required_bullets = get_required_bullets_by_experience_id(profile)
    records: list[dict[str, Any]] = []
    updates = payload.get("experience_updates")
    if not isinstance(updates, list):
        return ()
    for update_index, update in enumerate(updates):
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "").strip()
        bullets = [str(item).strip() for item in update.get("bullets") or [] if str(item).strip()]
        if not entry_id or len(bullets) <= max_bullets:
            continue
        matching_mappings = tuple(
            mapping
            for mapping in mappings
            if _mapping_targets_experience_update(
                mapping.location,
                entry_id=entry_id,
                update_index=update_index,
            )
        )
        covered_evidence_ids = tuple(
            dict.fromkeys(
                evidence_id
                for mapping in matching_mappings
                if mapping.coverage_edge_ids
                for evidence_id in mapping.evidence_ids
            )
        )
        enhancement_evidence_ids = tuple(
            dict.fromkeys(
                evidence_id
                for mapping in matching_mappings
                if mapping.coverage_edge_ids
                and mapping.claim_label in {"adjacent_translation", "draft_requires_confirmation"}
                for evidence_id in mapping.evidence_ids
            )
        )
        records.extend(
            overflow.to_dict()
            for overflow in bullet_limit_overflows(
                experience_entry_id=entry_id,
                max_bullets=max_bullets,
                actual_bullets=len(bullets),
                pinned_required_bullet_count=len(required_bullets.get(entry_id, ())),
                requirement_covered_evidence_ids=covered_evidence_ids,
                enhancement_covered_evidence_ids=enhancement_evidence_ids,
            )
        )
    return tuple(records)


def _mapping_targets_experience_update(
    location: str,
    *,
    entry_id: str,
    update_index: int,
) -> bool:
    return (
        f".{entry_id}." in location
        or f"experience.{entry_id}" in location
        or location.startswith(f"experience_updates[{update_index}].")
    )


def _audit_prompt_messages(messages: list[LlmMessage]) -> tuple[dict[str, str], ...]:
    return tuple(
        {"role": message.role, "content": _audit_prompt_text(message.content)}
        for message in messages
    )


def _audit_prompt_text(value: object, *, max_chars: int = 2400) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(
        r"(?i)(api[_-]?key|password|secret|token|bearer)\s*[:=]\s*\S+",
        r"\1: [redacted]",
        text,
    )
    return text if len(text) <= max_chars else f"{text[:max_chars - 1]}…"


_RETRY_GUIDANCE: dict[str, str] = {
    "adversarial_rejected": (
        "Regenerate using only canonical profile evidence and preserve every "
        "claim-to-evidence binding."
    ),
    "cover_letter_validation_failed": (
        "Regenerate the cover letter in the required shape using only canonical "
        "resume evidence and the required completion marker."
    ),
    "cover_letter_numeric_grounding_failed": (
        "Remove every number and date that comes only from the target job. Use "
        "numeric or date facts only when they already appear in the provided "
        "resume; describe target-job timelines, team sizes, goals, and requirements "
        "qualitatively."
    ),
    "cover_letter_skill_grounding_failed": (
        "Remove every named skill or tool that appears only in the target job. Use "
        "a named skill or tool only when it appears in the provided resume; otherwise "
        "describe grounded work without naming that target-only technology."
    ),
    "cover_letter_title_grounding_failed": (
        "Remove every role title that does not appear in the provided resume, including "
        "titles of target-company stakeholders. Refer to them generically as company "
        "leadership instead of naming a title such as CEO or CTO."
    ),
    "fabrication_detected": (
        "Remove unsupported claims and use only metrics, tools, roles, employers, "
        "and dates present in canonical profile evidence."
    ),
    "invalid_json": "Return exactly one JSON object matching the required schema.",
    "judge_rejected": (
        "Regenerate conservatively from canonical profile evidence and satisfy "
        "every code-defined quality criterion."
    ),
    "residual_quality_warning": (
        "Prefer concise, specific, evidence-bound wording without changing facts."
    ),
    "validation_failed": (
        "Correct the schema and deterministic validation failures without adding "
        "facts beyond canonical profile evidence."
    ),
}


def _retry_system_prompt(base_prompt: str, reason_codes: list[str]) -> str:
    """Append only code-owned retry guidance to a generator system prompt.

    Validator, judge, adversarial-review, and prior model output text is retained
    in the audit trail but must never be promoted into a later system message.
    """
    ordered_codes = tuple(dict.fromkeys(reason_codes[-5:]))
    if not ordered_codes:
        return base_prompt
    unknown = [code for code in ordered_codes if code not in _RETRY_GUIDANCE]
    if unknown:
        raise ValueError(f"unknown retry reason code: {unknown[0]}")
    guidance = "\n".join(
        f"- {code}: {_RETRY_GUIDANCE[code]}" for code in ordered_codes
    )
    return f"{base_prompt}\n\n## CODE-OWNED RETRY REQUIREMENTS\n{guidance}"


def _candidate_warning_notes(record: dict[str, Any]) -> tuple[str, ...]:
    notes: list[str] = []
    validator = record.get("validator") if isinstance(record.get("validator"), dict) else {}
    quality = (
        record.get("quality_checks")
        if isinstance(record.get("quality_checks"), dict)
        else {}
    )
    judge = record.get("judge") if isinstance(record.get("judge"), dict) else {}
    review = (
        record.get("adversarial_review")
        if isinstance(record.get("adversarial_review"), dict)
        else {}
    )

    notes.extend(
        warning
        for warning in _as_string_list(validator.get("warnings"))
        if not _is_label_only_quality_warning(warning)
    )
    notes.extend(
        warning
        for warning in _as_string_list(quality.get("warnings"))
        if not _is_label_only_quality_warning(warning)
    )
    notes.extend(_as_string_list(judge.get("repair_instructions")))
    if review.get("ran"):
        notes.extend(_as_string_list(review.get("warnings")))
        notes.extend(_as_string_list(review.get("repair_instructions")))
    return tuple(dict.fromkeys(notes))


def _candidate_retry_warning_notes(record: dict[str, Any]) -> tuple[str, ...]:
    """Return only warnings a later generator attempt can truthfully repair."""

    return tuple(
        note
        for note in _candidate_warning_notes(record)
        if not note.startswith("Residual job-fit gap:")
    )


def _clean_approved_candidate_rank(
    item: tuple[_TailorCandidate, tuple[str, ...]],
) -> tuple[bool, float]:
    """Prefer a genuinely warning-free candidate before comparing judge scores."""

    candidate, warning_notes = item
    return not warning_notes, candidate.judge_score


def _is_label_only_quality_warning(warning: str) -> bool:
    return warning.startswith(LOW_QUALITY_LABEL_ONLY_WARNING_PREFIXES)


_FABRICATION_KIND_LABELS: dict[str, str] = {
    "numeric": "metric",
    "date": "date",
    "title": "seniority title",
    "employer": "employer",
    "skill": "skill or technology",
}


def _render_fabrication_avoid_notes(findings: tuple[FabricationFinding, ...]) -> list[str]:
    """Render deterministic never-fabricate findings as auditable avoid notes.

    These retain one concise item per fabricated token in attempt history. They
    never enter a later generator message; the retry path uses only the fixed
    ``fabrication_detected`` guidance. De-duplicated so a token repeated across
    bullets yields a single audit item.
    """
    notes: list[str] = []
    seen: set[str] = set()
    for finding in findings:
        label = _FABRICATION_KIND_LABELS.get(finding.kind, finding.kind)
        note = (
            f"Do not claim the {label} {finding.token!r}: it is not supported by the "
            f"candidate's profile. Remove it or use only {label} values the profile evidences."
        )
        if note not in seen:
            seen.add(note)
            notes.append(note)
    return notes


def _safe_candidate_summary(record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("parsed_json") if isinstance(record.get("parsed_json"), dict) else {}
    return {
        "candidate_id": record.get("candidate_id"),
        "generator": record.get("model"),
        "status": record.get("status"),
        "schema_version": record.get("schema_version"),
        "prompt_fingerprint": record.get("prompt_fingerprint"),
        "validation": record.get("validator"),
        "judge": record.get("judge"),
        "fabrication_gate": record.get("fabrication_gate"),
        "parse_error": record.get("parse_error"),
        "post_generation_fit": record.get("post_generation_fit"),
        "bullet_limit_overflows": record.get("bullet_limit_overflows") or [],
        "summary": _candidate_payload_summary(payload),
    }


def _with_tailoring_attempt_audit(
    materials: MaterialsSet,
    *,
    report: dict[str, Any],
    recorded_at: str,
    execution_id: str | None,
    durable_attempt: int | None,
) -> MaterialsSet:
    """Append one durable execution's complete inner-attempt audit idempotently."""

    metadata = dict(materials.metadata)
    history: list[dict[str, Any]] = []
    raw_history = metadata.get("tailoring_attempt_audits")
    if isinstance(raw_history, list):
        history = [dict(entry) for entry in raw_history if isinstance(entry, MappingABC)]
    elif isinstance(metadata.get("tailoring_attempt_audit"), MappingABC):
        # Preserve the singular pre-R25 record when an existing generation is
        # first saved by the append-only writer.
        history.append(
            {
                "audit_key": f"legacy:{materials.updated_at}",
                "execution_id": None,
                "durable_attempt": None,
                "recorded_at": materials.updated_at,
                "report": dict(metadata["tailoring_attempt_audit"]),
            }
        )

    normalized_execution_id = str(execution_id or "local")
    # The key is unique per recorded execution: a rerun of the same durable
    # attempt (a post-``--reset-attempts`` CLI execution, or an activity retry
    # after a crash between the materials save and the stage-count increment)
    # must append its own report rather than silently dropping the newer one.
    # Re-merging already persisted metadata stays idempotent because an
    # identical ``recorded_at`` can only come from the same recorded execution.
    if durable_attempt is not None:
        audit_key = f"{normalized_execution_id}:{durable_attempt}:{recorded_at}"
    else:
        audit_key = f"{normalized_execution_id}:{recorded_at}"
    if not any(str(entry.get("audit_key") or "") == audit_key for entry in history):
        history.append(
            {
                "audit_key": audit_key,
                "execution_id": execution_id,
                "durable_attempt": durable_attempt,
                "recorded_at": recorded_at,
                "report": report,
            }
        )

    return materials.with_metadata(
        {
            **metadata,
            # Singular latest-record compatibility plus append-only history.
            "tailoring_attempt_audit": report,
            "tailoring_attempt_audits": history,
        },
        updated_at=recorded_at,
    )


def _voice_system_prompt() -> str:
    """Resolve the voice system prompt lazily (domain stays import-clean of infra).

    Mirrors ``AnalyzeJobUseCase._resolve_prompts``: the prompt text lives in the
    infrastructure layer, so it is imported inside the call path rather than at
    module import time, keeping the domain use case importable without infra.
    """
    from jobctrl.infrastructure.materials.voice_prompts import VOICE_SYSTEM_PROMPT

    return VOICE_SYSTEM_PROMPT


def _mark_voiced_rows(
    base_rows: tuple[BulletProvenance, ...],
    voiced_rows: tuple[BulletProvenance, ...],
) -> tuple[BulletProvenance, ...]:
    """Re-mark every bullet the voice pass reworded as ``transform_type == voice``.

    Compares the voiced rows against the pre-voice rows by ``bullet_id``: a voiced
    row whose ``generated_text`` differs from its pre-voice counterpart had its
    wording changed by the voice pass, so its transform becomes ``VOICE`` (the
    outermost transform — the shipped wording is the voiced wording, VOICE-02). A
    row whose text is unchanged keeps its original transform (the voice pass left
    it alone). Rows with no pre-voice counterpart keep their computed transform.
    """
    base_text_by_id = {row.bullet_id: row.generated_text for row in base_rows}
    marked: list[BulletProvenance] = []
    for row in voiced_rows:
        previous = base_text_by_id.get(row.bullet_id)
        if previous is not None and previous != row.generated_text:
            marked.append(replace(row, transform_type=TransformType.VOICE))
        else:
            marked.append(row)
    return tuple(marked)


def _requirement_report_with_artifact_coverage(
    report: "RequirementFitReport",
    bullets: tuple[BulletProvenance, ...],
) -> "RequirementFitReport":
    """Return ``report`` with coverage derived from accepted artifact provenance."""
    from jobctrl.domain.scoring.value_objects import RequirementArtifactCoverage

    covered: dict[str, list[str]] = {}
    for row in bullets:
        example = _coverage_example(row.generated_text)
        for requirement_id in row.requirement_ids:
            if not requirement_id:
                continue
            examples = covered.setdefault(requirement_id, [])
            if example and example not in examples:
                examples.append(example)

    assessments = []
    for assessment in report.assessments:
        examples = tuple(covered.get(assessment.requirement_id, ())[:3])
        if examples:
            coverage = RequirementArtifactCoverage(
                state="covered",
                bullet_count=len(covered.get(assessment.requirement_id, ())),
                examples=examples,
            )
        elif assessment.fit.kind in {"missing", "blocked"}:
            coverage = RequirementArtifactCoverage(
                state="missing_from_profile",
                bullet_count=0,
                examples=(),
            )
        elif assessment.fit.kind in {"matched", "transferable"}:
            coverage = RequirementArtifactCoverage(
                state="missing_from_resume",
                bullet_count=0,
                examples=(),
            )
        else:
            coverage = RequirementArtifactCoverage(
                state="not_recorded",
                bullet_count=0,
                examples=(),
            )
        assessments.append(replace(assessment, artifact_coverage=coverage))
    return replace(report, assessments=tuple(assessments))


def _coverage_example(value: str) -> str:
    return " ".join(str(value or "").split())[:320]


# ---------------------------------------------------------------------------
# Prompt builders (snapshot-driven)
# ---------------------------------------------------------------------------


def build_master_tailor_prompt(
    snapshot: ProfileSnapshot,
    *,
    tailoring_plan: TailoringPlan | None = None,
    learned_tailoring_rules: LearnedTailoringRules | None = None,
) -> str:
    """Build the master-resume tailoring prompt from the snapshot."""
    profile = snapshot.as_dict()
    require_resume_master(profile)
    resume = get_resume_master(profile)
    constraints = get_resume_constraints(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    all_experience_entries = get_experience_entries(profile)
    all_skill_categories = get_skill_categories(profile)
    experience_entries = [
        entry for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    skill_categories = [
        category for category in all_skill_categories
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories
    education_entries = get_education_entries(profile)

    experience_payload = [
        {
            "id": entry.get("id"),
            "date_range": entry.get("date_range"),
            "title": entry.get("title"),
            "company": entry.get("company"),
            "location": entry.get("location"),
            "bullets": entry.get("bullets", []),
        }
        for entry in experience_entries
    ]
    skills_payload = [
        {
            "id": category.get("id"),
            "label": category.get("label"),
            "items": category.get("items", []),
        }
        for category in skill_categories
    ]
    education_payload = [
        {
            "id": entry.get("id"),
            "date": entry.get("date"),
            "degree": entry.get("degree"),
            "institution": entry.get("institution"),
            "location": entry.get("location"),
        }
        for entry in education_entries
    ]

    required_bullets = get_required_bullets_by_experience_id(profile)
    tailoring_policy = get_tailoring_policy(profile)
    writing_style = get_writing_style(profile)
    custom_tailoring_prompt = get_custom_tailoring_prompt(profile)
    max_bullets = get_max_experience_bullets(profile)
    real_metrics = normalize_profile_list(constraints.get("real_metrics", []))
    metrics_str = ", ".join(real_metrics) if real_metrics else "N/A"
    banned_str = ", ".join(BANNED_WORDS)
    policy_lines = [
        f"- Rewrite executive profile: {'yes' if tailoring_policy['allow_summary_rewrite'] else 'no, preserve the baseline summary'}",
        "- Reframe experience titles: no, historical titles are source-controlled for safety",
        f"- Rewrite achievement bullets: {'yes' if tailoring_policy['allow_achievement_rewriting'] else 'no, preserve the original bullets'}",
        f"- Reorder or trim skills: {'yes' if tailoring_policy['allow_skill_reordering'] else 'no, preserve original skill order and wording'}",
    ]
    style_lines = [
        f"- Tone: {writing_style['tone']}",
        f"- Bullet standards: {', '.join(writing_style['bullet_styles'])}",
        f"- Verbosity: {writing_style['verbosity']}",
        f"- Keyword density: {writing_style['keyword_density']}",
        f"- Avoid first person: {'yes' if writing_style['avoid_first_person'] else 'no'}",
    ]
    custom_prompt_block = (
        f"\nUSER ADDITIONAL TAILORING PROMPT:\n{custom_tailoring_prompt}\n"
        if custom_tailoring_prompt
        else ""
    )
    quality_plan_block = (
        "\n" + tailoring_plan.to_prompt_context() + "\n"
        if tailoring_plan is not None
        else ""
    )
    learned_rule_lines = (learned_tailoring_rules or LearnedTailoringRules()).prompt_lines()
    learned_rule_block = (
        "\nACCEPTED LEARNING RULES FOR FUTURE MATERIALS:\n"
        + "\n".join(learned_rule_lines)
        + "\n"
        if learned_rule_lines
        else ""
    )

    return f"""You are tailoring a resume that is backed by a canonical structured resume source.

You are ONLY allowed to rewrite the mutable content:
- the executive profile, if policy allows it
- the bullets for each existing experience entry, if policy allows it
- the title field for each existing experience entry, only if policy allows it
- the ordering/content of items inside each existing skill category, if policy allows it

The code will inject all fixed structure from the master resume:
- experience metadata (date_range, title, company, location)
- all education entries
- section order

SOURCE OF TRUTH:
- MASTER EXECUTIVE PROFILE, MASTER EXPERIENCE ENTRIES, MASTER EDUCATION
  ENTRIES, MASTER SKILL CATEGORIES, REQUIRED BULLETS, and REAL METRICS are the
  only evidence for candidate claims.
- TARGET JOB text is context only. Do NOT copy target-job technologies,
  systems, responsibilities, business claims, or phrases into the candidate's
  executive profile or bullets unless the same fact appears in the master
  evidence above.
- If the target job asks for a tool, system, domain, or responsibility that is
  not present in the master evidence, omit that term and emphasize adjacent
  grounded experience instead.

HARD RULES:
- Return EVERY required experience entry id exactly once
- Return a title field for EVERY experience update; set it to "" to preserve the source title
- Return EVERY required skill category id exactly once
- Preserve every required bullet listed below in the matching experience entry
- Do NOT add or remove experience entries
- Do NOT add or remove education entries
- Do NOT add or remove skill categories
- Do NOT rewrite historical experience titles or append job keywords to titles
- Skill items must be exact strings from MASTER SKILL CATEGORIES; do NOT add job-only skills
- Do NOT change real numbers ({metrics_str})
- Do NOT invent companies, roles, degrees, or certifications
- Max {max_bullets} bullets per experience entry
- No em dashes
- BANNED WORDS: {banned_str}
- Use TARGET_PROFILE, COVERAGE_GRAPH, claim policy, generation permissions,
  required content pins, writing style, and revision gates from TAILORING
  QUALITY PLAN as the runtime authority for what may be claimed
- For every generated summary sentence, experience bullet, and selected skill
  group, emit a generated_claim_mappings entry that references valid
  coverage_edge_ids, requirement_ids, and evidence_ids; use non_requirement_reason
  only for pinned, positioning, or structure claims
- Return executive_profile_sentences as the ordered 1-4 grammatical sentences
  that form executive_profile; joining them with one space must reproduce
  executive_profile exactly
- Use executive_profile only when executive_profile_sentences has exactly one item;
  otherwise map every explicit item with executive_profile.sentence[N], where N is zero-based
- For a skills.<category-id> mapping, text must be the exact selected items in
  rendered order joined with ", " (comma plus one space), not the category label
- Every achievement_evidence_id present on any COVERAGE_GRAPH edge must appear
  in at least one bound mapping that cites that edge and its requirement_id
- non_requirement_reason is a required fallback classification. Choose pinned,
  positioning, or structure. When coverage_edge_ids is non-empty it is ignored;
  when coverage_edge_ids is empty it must truthfully classify the claim
- Adjacent or draft claims must be labeled adjacent_translation or
  draft_requires_confirmation and marked review_required unless the advanced
  auto-approval policy explicitly allows the claim label

WRITING METHOD:
- Treat required evidence and required bullets as pinned must-include achievements:
  keep the fact, metric, and meaning visible in the matching experience entry
- For each experience row, order bullets strongest-to-weakest for this job.
  Lead with bullets that map to requirement directives, required evidence, and
  grounded job keywords; demote generic duties
- Write bullets as result-first CAR/PAR achievements: strong past-tense verb,
  outcome or scope or metric, then the action/context. If no verified metric
  exists, use only supported scale, scope, frequency, or time from master evidence
- Every bullet should prove a requirement, surface required evidence, or preserve
  a profile fact. Do not write duty-only filler
- For skills, select and order exact existing skill strings by truthful target
  overlap first; never add unsupported skills
- Executive profile should be a concise 2-4 sentence target-role summary using
  grounded proof and 3-6 truthful job terms, not a generic objective

MASTER EXECUTIVE PROFILE:
{resume.get("executive_profile", {}).get("baseline_text", "")}

MASTER EXPERIENCE ENTRIES:
{json.dumps(experience_payload, indent=2, ensure_ascii=False)}

MASTER EDUCATION ENTRIES (fixed, injected by code):
{json.dumps(education_payload, indent=2, ensure_ascii=False)}

MASTER SKILL CATEGORIES:
{json.dumps(skills_payload, indent=2, ensure_ascii=False)}

TAILORING POLICY:
{chr(10).join(policy_lines)}
{learned_rule_block}

WRITING STYLE:
{chr(10).join(style_lines)}
{custom_prompt_block}
{quality_plan_block}
REQUIRED EXPERIENCE IDS:
{json.dumps(required_experience_ids, ensure_ascii=False)}

REQUIRED SKILL CATEGORY IDS:
{json.dumps(required_skill_ids, ensure_ascii=False)}

REQUIRED BULLETS BY EXPERIENCE ID:
{json.dumps(required_bullets, indent=2, ensure_ascii=False)}

OUTPUT ONLY VALID JSON:
{{
  "executive_profile": "2-4 sentences tailored to the target role.",
  "executive_profile_sentences": ["Sentence 1.", "Sentence 2."],
  "experience_updates": [
    {{"id": "{required_experience_ids[0] if required_experience_ids else 'experience_entry_id'}", "title": "", "bullets": ["bullet 1", "bullet 2"]}}
  ],
  "skill_category_updates": [
    {{"id": "{required_skill_ids[0] if required_skill_ids else 'skill_category_id'}", "items": ["item 1", "item 2"]}}
  ],
  "generated_claim_mappings": [
    {{
      "claim_id": "claim-1",
      "location": "experience.{required_experience_ids[0] if required_experience_ids else 'experience_entry_id'}.bullets[0]",
      "text": "bullet 1",
      "claim_label": "evidence_reframed",
      "coverage_edge_ids": ["edge id from COVERAGE_GRAPH"],
      "requirement_ids": ["requirement id from TARGET_PROFILE"],
      "evidence_ids": ["achievement evidence id from TARGET_PROFILE"],
      "non_requirement_reason": "positioning",
      "review_required": false
    }}
  ]
}}"""


def build_judge_prompt(
    snapshot: ProfileSnapshot,
    *,
    tailoring_plan: TailoringPlan | None = None,
) -> str:
    """Build the LLM judge prompt from the snapshot."""
    profile = snapshot.as_dict()
    boundary = profile.get("skills_boundary", {})
    resume_facts = profile.get("resume_facts", {})
    resume = get_resume_master(profile)
    experience_entries = get_experience_entries(profile)
    skill_categories = get_skill_categories(profile)
    required_bullets = get_required_bullets_by_experience_id(profile)

    all_skills: list[str] = []
    for items in boundary.values():
        all_skills.extend(normalize_profile_list(items))
    for category in skill_categories:
        all_skills.extend(normalize_profile_list(category.get("items", [])))
    all_skills = sorted(set(all_skills), key=str.lower)
    skills_str = ", ".join(all_skills) if all_skills else "N/A"

    real_metrics = normalize_profile_list(resume_facts.get("real_metrics", []))
    metrics_str = ", ".join(real_metrics) if real_metrics else "N/A"
    quality_plan_block = (
        "\n" + tailoring_plan.to_prompt_context() + "\n"
        if tailoring_plan is not None
        else ""
    )

    return f"""You are the final resume quality judge for JobCtrl.

Return ONLY JSON matching the provided schema. Do not include markdown.

Your job is to decide whether the tailored resume is safe to show the user as
the final resume for this job. Be evidence-grounded and strict about facts.

PASS only when all of these are true:
- The tailored resume is relevant to the target job.
- Every company, role, degree, metric, tool, and achievement is supported by
  the canonical resume evidence below.
- Required experience, skill, education, and required bullets are preserved.
- The resume does not add unsupported skills, certifications, employers,
  locations, degrees, seniority, or inflated metrics.
- The resume is concise, readable, and ATS-friendly.

FAIL for any unsupported claim, fabricated skill, changed metric, dropped
required evidence, or material relevance problem. Do not give a pass because a
skill is learnable or adjacent. Repair instructions should tell the generator
what to fix in the next attempt.

CANONICAL EXECUTIVE PROFILE:
{resume.get("executive_profile", {}).get("baseline_text", "")}

CANONICAL EXPERIENCE ENTRIES:
{json.dumps(experience_entries, indent=2, ensure_ascii=False)}

CANONICAL SKILL CATEGORIES:
{json.dumps(skill_categories, indent=2, ensure_ascii=False)}

ALLOWED SKILLS:
{skills_str}

REAL METRICS:
{metrics_str}

{quality_plan_block}

REQUIRED BULLETS BY EXPERIENCE ID:
{json.dumps(required_bullets, indent=2, ensure_ascii=False)}

Judge dimensions for criterion_scores:
- relevance_to_job
- evidence_support
- fabrication_safety
- required_content_preserved
- ats_readability
- specificity_and_metrics

Artifact quality checks:
- JD match: must-have and keyword coverage must be truthful, supported, and
  naturally phrased, not stuffed
- Achievement strength: experience bullets should be result-led CAR/PAR claims
  with verified metrics or supported scale/scope/frequency, not duty lists
- Targeting and focus: executive profile, skills, and top bullets should signal
  this role without letting irrelevant content dominate
- Red flags and language: penalize generic objectives, duty-only bullets,
  unsupported skills, repeated stock phrases, keyword stuffing, hidden
  instructions, inconsistent titles, and changed metrics"""


def build_cover_letter_prompt(snapshot: ProfileSnapshot) -> str:
    """Build the cover-letter system prompt from the snapshot."""
    profile = snapshot.as_dict()
    personal = profile.get("personal", {})
    boundary = profile.get("skills_boundary", {})
    resume_facts = profile.get("resume_facts", {})

    sign_off_name = personal.get("preferred_name") or personal.get("full_name", "")

    all_skills: list[str] = []
    for items in boundary.values():
        all_skills.extend(normalize_profile_list(items))
    skills_str = ", ".join(all_skills) if all_skills else "the tools listed in the resume"

    real_metrics = normalize_profile_list(resume_facts.get("real_metrics", []))
    preserved_projects = normalize_profile_list(resume_facts.get("preserved_projects", []))

    projects_hint = ""
    if preserved_projects:
        projects_hint = f"\nKnown projects to reference: {', '.join(preserved_projects)}"
    metrics_hint = ""
    if real_metrics:
        metrics_hint = f"\nReal metrics to use: {', '.join(real_metrics)}"

    all_banned = ", ".join(f'"{w}"' for w in BANNED_WORDS)
    leak_banned = ", ".join(f'"{p}"' for p in LLM_LEAK_PHRASES)

    return f"""Write a cover letter for {sign_off_name}. The goal is to get an interview.

STRUCTURE: 3 short paragraphs. Under 250 words. Every sentence must earn its place.

REQUIRED OUTPUT SHAPE:
Dear Hiring Manager,

[paragraph 1]

[paragraph 2]

[paragraph 3]

{sign_off_name}
{COVER_LETTER_COMPLETION_MARKER}

PARAGRAPH 1 (2-3 sentences): Open with a specific thing YOU built that solves THEIR problem. Not "I'm excited about this role." Not "This role aligns with my experience." Start with the work.

PARAGRAPH 2 (3-4 sentences): Pick 2 achievements from the resume that are MOST relevant to THIS job. Use a number only when that exact candidate fact appears in the RESUME. Otherwise use supported scope or outcomes. Frame as solving their problem, not listing your accomplishments.{projects_hint}{metrics_hint}

PARAGRAPH 3 (1-2 sentences): One specific thing about the company from the job description (a product or technical challenge). Describe it qualitatively. NEVER repeat a number, date, percentage, money amount, team size, goal period, or timeline from the TARGET JOB. Then close. "Happy to walk through any of this in more detail." or "Let's discuss." Nothing else.

BANNED WORDS AND PHRASES (automated validator rejects ANY of these — do not use even once):
{all_banned}

ALSO BANNED (meta-commentary the validator catches):
{leak_banned}

BANNED PUNCTUATION: No em dashes (—) or en dashes (–). Use commas or periods.

VOICE:
- Write like a real engineer emailing someone they respect. Not formal, not casual. Just direct.
- NEVER narrate or explain what you're doing. BAD: "This demonstrates my commitment to X." GOOD: Just state the fact and move on.
- NEVER hedge. BAD: "might address some of your challenges." GOOD: "solves the same problem your team is facing."
- Every sentence should contain either a profile-grounded number, a profile-grounded tool name, or a specific outcome. If it doesn't, cut it.
- Read it out loud. If it sounds like a robot wrote it, rewrite it.

FABRICATION = INSTANT REJECTION:
The candidate's real tools are ONLY: {skills_str}.
Do NOT mention ANY tool not in this list. If the job asks for tools not listed, talk about the work you did, not the tools.
Do NOT mention any role title that is absent from the RESUME, even when the TARGET JOB uses it for a stakeholder. Refer to target-company stakeholders generically as "company leadership" instead of naming titles such as CEO or CTO.
The TARGET JOB is context, never evidence about the candidate. Do NOT copy any number or date from it into the letter. If a target-job fact is numeric, express only its qualitative meaning.

Sign off: just "{sign_off_name}"

The final line must be exactly {COVER_LETTER_COMPLETION_MARKER}. This internal completion marker proves the response was not cut off; it is stripped before saving.
Never stop after a partial sentence. If you are running long, use fewer words, but always include the sign-off name and the completion marker.

Output ONLY the letter text plus the required completion marker. No subject lines. No "Here is the cover letter:" preamble. No notes after the marker.
Start DIRECTLY with "Dear Hiring Manager," and end with the completion marker."""


# ---------------------------------------------------------------------------
# TailorResumeUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TailorOutcome:
    """Result of a single :meth:`TailorResumeUseCase.execute` call.

    ``status`` mirrors the legacy report.status vocabulary so callers
    that rely on it for telemetry don't need to be touched:

      * ``approved``                    — validator + judge passed.
      * ``review_required``             — validator + judge passed, but claim
                                          policy requires human review before
                                          this candidate can be approved.
      * ``failed_judge``                — validator passed but the structured
                                          judge did not approve a candidate.
      * ``failed_validation``           — validator never passed.
      * ``exhausted_retries``           — no parseable JSON in any attempt.
      * ``error``                       — unhandled exception during the
                                          run; ``error`` is populated.
    """

    materials: MaterialsSet | None
    status: str
    attempts: int
    text_path: str | None = None
    pdf_path: str | None = None
    report: dict = field(default_factory=dict)
    error: str = ""
    # Phase 3: the FINAL payload that actually ships — the voiced payload when the
    # voice pass was accepted, else the selected pre-voice candidate. The PDF
    # renderer MUST consume this (not the raw selected candidate) so the HTML
    # PDF, the plain-text resume, the provenance ``generated_text``, and the
    # coverage audit are all computed against the SAME final canonical text
    # (GROUND-06 / Pitfall 4 — render paths must not diverge).
    final_payload: dict | None = None


class TailorResumeUseCase:
    """Tailor one job's resume — full LLM ⇒ validate ⇒ judge ⇒ persist flow.

    Owns the transaction boundary: the use case loads the previous
    aggregate (if any), constructs the next generation when re-tailoring,
    persists the result, and publishes ``ResumeApproved`` / ``ResumeFailed``.
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        llm: LlmPort,
        validator: ContentValidator,
        assembler: ResumeAssembler,
        publisher: EventPublisher | None = None,
        max_retries: int = 3,
        llm_policy: TailoringLlmPolicy | None = None,
        policy_repository: TailoringPolicyRepository | None = None,
        provenance_repository: BulletProvenanceRepository | None = None,
        requirement_fit_repository: "RequirementFitReportRepository | None" = None,
        analyze_use_case: "AnalyzeJobUseCase | None" = None,
        voice: VoicePort | None = None,
        pdf_renderer: PdfRendererPort | None = None,
        unit_of_work: UnitOfWork | None = None,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._validator = validator
        self._assembler = assembler
        self._publisher = publisher
        self._max_retries = max_retries
        self._llm_policy = llm_policy or TailoringLlmPolicy.from_env()
        self._policy_repository = policy_repository
        # Phase 2: the canonical per-bullet provenance repository. When injected,
        # an accepted generation emits one ``BulletProvenance`` row per rendered
        # bullet (computed vs the generated text), gated by the deterministic
        # never-fabricate detector, and publishes ``BulletProvenanceRecorded``.
        self._provenance_repository = provenance_repository
        self._requirement_fit_repository = requirement_fit_repository
        # D-20: the canonical employer analysis is the front-half sub-step of
        # tailor. When an ``analyze_use_case`` is injected, ``execute`` runs
        # ``_run_analyze`` to produce/reuse it before tailoring; otherwise the
        # caller must pass ``employer_analysis`` into ``execute`` directly.
        self._analyze_use_case = analyze_use_case
        # Phase 3: the explicit voice pass (VOICE-01/02/03). When injected, the
        # SELECTED candidate's prose is de-buzzworded/varied BEFORE the final audit
        # so the audited + coverage text equals the rendered text; provenance + the
        # never-fabricate detector are re-run against the voiced text, and the
        # voiced payload is kept only when the deterministic voice proxies improve
        # AND grounding re-validates — otherwise the clean pre-voice candidate
        # ships. When absent, the use case is exactly the Phase-2 flow (coverage is
        # still computed canonically, just over the un-voiced candidate).
        self._voice = voice
        # Preservation invariant (architecture.md §5.5 / CLAUDE.md): when a PDF
        # renderer is injected, an approved resume's PDF is rendered INSIDE the
        # tailor transaction — BEFORE the prior approved generation is superseded
        # and BEFORE ResumeApproved is published — so a transient render failure
        # never strips the job of its last accepted resume. When absent (narrow
        # unit tests that only exercise validate/judge), no PDF is produced and
        # the flow is exactly the pre-render persist path.
        self._pdf_renderer = pdf_renderer
        # Atomicity boundary (A9). When injected, the generation flip — supersede
        # the prior approved generation, save the new generation, and record its
        # provenance/coverage — commits inside ONE transaction, so a crash or a
        # provenance write failure mid-flip rolls the whole block back: the prior
        # approved generation stays current and no new artifact is committed
        # without its provenance. When absent, each repository commits per call
        # exactly as before (the flow's pre-A9 behaviour).
        self._unit_of_work = unit_of_work

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        job: dict,
        job_id: JobId | None = None,
        profile_snapshot: ProfileSnapshot,
        tailored_dir: Path,
        validation_mode: str = "normal",
        tenant_id: TenantId = LOCAL_TENANT,
        retailor: bool = False,
        suppress_existing_artifacts: bool = False,
        employer_analysis: EmployerAnalysis | None = None,
        requirement_fit_report: "RequirementFitReport | None" = None,
        commit_guard: Callable[[], None] | None = None,
        audit_execution_id: str | None = None,
        durable_attempt: int | None = None,
    ) -> TailorOutcome:
        if commit_guard is not None:
            commit_guard()
        stable_job_id = job_id if job_id is not None else job.get("job_id")
        job_id = canonical_job_id(str(stable_job_id))
        # D-20: run/reuse the canonical employer analysis as the front-half
        # sub-step of tailor (cache-backed, so a re-tailor reuses it). The
        # analysis drives keyword selection in ``build_tailoring_plan``.
        employer_analysis = self._run_analyze(
            job=job, tenant_id=tenant_id, employer_analysis=employer_analysis
        )
        if requirement_fit_report is None and self._requirement_fit_repository is not None:
            requirement_fit_report = self._requirement_fit_repository.load(
                tenant_id,
                job_id,
            )
        if self._requirement_fit_repository is not None and requirement_fit_report is None:
            raise TailoringPrerequisiteError(
                reason="requirement_fit_missing",
                job_id=str(job_id),
                analysis_generation=employer_analysis.generation,
            )
        previous = self._repository.load(tenant_id, job_id)
        created_at = _utc_now()

        # Decide which generation we're writing.
        if previous is None:
            materials = MaterialsSetFactory.initial(
                tenant_id=tenant_id,
                job_id=job_id,
                created_at=created_at,
            )
            prior_generation = None
        elif retailor:
            if suppress_existing_artifacts:
                prior_generation = previous.suppress_active_artifacts(
                    at=created_at,
                    reason="retailor_current_policy",
                )
                materials = MaterialsSet(
                    tenant_id=previous.tenant_id,
                    job_id=previous.job_id,
                    generation=previous.generation + 1,
                    status=MaterialsLifecycle.RESUME_IN_PROGRESS,
                    created_at=created_at,
                    updated_at=created_at,
                )
            else:
                prior_generation, materials = MaterialsSetFactory.next_generation(
                    previous,
                    created_at=created_at,
                )
        else:
            # Re-saving the same generation (typical when a previous run
            # crashed mid-flight and left the aggregate in
            # ``resume_in_progress``).
            prior_generation = None
            materials = previous

        current_policy = (
            self._policy_repository.get_current(tenant_id)
            if self._policy_repository is not None
            else None
        )
        learned_tailoring_rules = (
            current_policy.learned_tailoring_rules
            if current_policy is not None
            else LearnedTailoringRules()
        )
        tailoring_plan = build_tailoring_plan(
            profile_snapshot.as_dict(),
            job,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
        )
        tailor_prompt_base = build_master_tailor_prompt(
            profile_snapshot,
            tailoring_plan=tailoring_plan,
            learned_tailoring_rules=learned_tailoring_rules,
        )
        tailoring_policy_prompt = build_master_tailor_prompt(
            profile_snapshot,
            learned_tailoring_rules=learned_tailoring_rules,
        )
        report, parsed_payload, validation, verdict = self._run_attempts(
            job=job,
            profile_snapshot=profile_snapshot,
            validation_mode=validation_mode,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
            tailoring_plan=tailoring_plan,
            tailor_prompt_base=tailor_prompt_base,
            execution_guard=commit_guard,
        )
        if commit_guard is not None:
            commit_guard()
        attempts = report["attempts"]

        if not parsed_payload:
            # Nothing to persist beyond the empty aggregate; surface the
            # failure to the caller and emit ``ResumeFailed`` so downstream
            # observers see the attempt counter advance.
            materials = _with_tailoring_attempt_audit(
                materials,
                report=report,
                recorded_at=created_at,
                execution_id=audit_execution_id,
                durable_attempt=durable_attempt,
            )
            with self._unit_of_work if self._unit_of_work is not None else nullcontext():
                if commit_guard is not None:
                    commit_guard()
                self._repository.save(materials)
            self._publish_failed(materials, validation_errors=("exhausted_retries",), attempt=attempts)
            return TailorOutcome(
                materials=materials,
                status="exhausted_retries",
                attempts=attempts,
                report=report,
                error="No parseable JSON in any attempt",
            )

        # Phase 3: run the explicit voice pass on the SELECTED candidate BEFORE the
        # final audit (VOICE-03), then compute provenance + coverage against the
        # text that actually ships. ``final_payload`` is the voiced payload when the
        # voice pass improved the deterministic proxies AND grounding re-validated;
        # otherwise it is the clean pre-voice candidate (a voice that introduced a
        # fabrication, regressed the proxies, or errored never reaches the user).
        # ``provenance_rows`` are computed against ``final_payload`` so their
        # ``generated_text`` is byte-identical to the rendered/PDF text, and
        # ``coverage`` is the honest generation-time keyword coverage over that same
        # grounded text (GROUND-06 / success criterion 4).
        if commit_guard is not None:
            commit_guard()
        (
            final_payload,
            provenance_rows,
            coverage,
            voice_record,
            fabrication_error,
            final_grounding,
        ) = self._voice_and_audit(
            profile_snapshot=profile_snapshot,
            job=job,
            tailored_payload=parsed_payload,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
        )
        if commit_guard is not None:
            commit_guard()
        if fabrication_error is not None:
            validation = ValidationResult.failure(
                (*validation.errors, fabrication_error),
                warnings=validation.warnings,
            )

        tailoring_policy = self._resolve_tailoring_policy(
            profile_snapshot=profile_snapshot,
            prompt_text=tailoring_policy_prompt,
            validation_mode=validation_mode,
            tenant_id=tenant_id,
            learned_tailoring_rules=learned_tailoring_rules,
            expected_current_version=0 if current_policy is None else current_policy.version,
        )

        # Assemble the rendered resume text from the FINAL (voiced) payload so the
        # shipped text == the audited text == the provenance ``generated_text``.
        tailored_text = self._assembler.assemble_resume_text(final_payload, profile_snapshot)
        prefix = f"{_safe_filename_prefix(job)}_g{materials.generation}"
        tailored_dir.mkdir(parents=True, exist_ok=True)
        text_path = tailored_dir / f"{prefix}.txt"

        # Always write the raw text so callers can inspect it (mirrors
        # legacy behaviour that wrote even rejected attempts so the user
        # can compare).
        text_path.write_text(tailored_text, encoding="utf-8")

        try:
            size_bytes = text_path.stat().st_size
        except OSError:
            size_bytes = None

        judge_record = self._judge_record(verdict)
        resume_template = _resolve_effective_resume_template(
            self._repository,
            tenant_id,
            job_id,
        )
        policy_metadata = tailoring_policy.as_artifact_metadata()
        tailoring_metadata = {
            "validation_mode": validation_mode,
            "attempts": attempts,
            "tailoring_policy_id": tailoring_policy.policy_id,
            "tailoring_policy_version": tailoring_policy.version,
            "tailoring_policy": policy_metadata,
            "job_prompt_fingerprint": str(
                report.get("selected_prompt_fingerprint") or ""
            ),
            "prompt_version": report.get("prompt_version"),
            "schema_version": report.get("schema_version"),
            "candidate_models": report.get("candidate_models") or [],
            "selected_model": report.get("selected_model"),
            "selected_candidate": report.get("selected_candidate"),
            "judge_model": report.get("judge_model"),
            "judge_min_score": report.get("judge_min_score"),
            "quality_plan": report.get("quality_plan") or {},
            "quality_checks": report.get("quality_checks") or {},
            "post_generation_fit": report.get("post_generation_fit"),
            "post_generation_fit_final": self._final_fit_record(
                profile_snapshot=profile_snapshot,
                job=job,
                employer_analysis=employer_analysis,
                requirement_fit_report=requirement_fit_report,
                final_payload=final_payload,
                grounding=final_grounding,
            ),
            "review_required": bool(report.get("review_required")),
            "review_blockers": report.get("review_blockers") or [],
            "bullet_limit_overflows": report.get("bullet_limit_overflows") or [],
            "adversarial_review": report.get("adversarial_review") or {},
            "review_feedback": report.get("review_feedback") or {},
            "change_annotations": report.get("change_annotations") or [],
            "candidate_summaries": report.get("candidate_summaries") or [],
            "judge": judge_record,
            # Phase 3 audit signals (canonical home is the provenance set; mirrored
            # here so the artifact report is self-contained for inspection).
            "voice_pass": voice_record.to_dict(),
            "keyword_coverage_v2": coverage.to_read_model() if coverage is not None else None,
            **(
                {"resume_template": resume_template["metadata"]}
                if resume_template and isinstance(resume_template.get("metadata"), dict)
                else {}
            ),
        }
        report["tailoring_quality"] = tailoring_metadata

        artifact = Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(text_path),
            created_at=_utc_now(),
            render_format=RenderFormat.TEXT,
            size_bytes=size_bytes,
            metadata=tailoring_metadata,
        )
        review_required = str(report.get("status") or "") == "review_required"
        materials = materials.with_resume_attempt(
            artifact,
            validation=validation,
            verdict=verdict,
            review_required=review_required,
            updated_at=_utc_now(),
        )
        materials = _with_tailoring_attempt_audit(
            materials,
            report=report,
            recorded_at=materials.updated_at,
            execution_id=audit_execution_id,
            durable_attempt=durable_attempt,
        )
        materials = materials.with_metadata(
            {
                **dict(materials.metadata),
                "tailoring_policy_id": tailoring_policy.policy_id,
                "tailoring_policy_version": tailoring_policy.version,
                "tailoring_policy": policy_metadata,
                **(
                    {"resume_template": resume_template["metadata"]}
                    if resume_template and isinstance(resume_template.get("metadata"), dict)
                    else {}
                ),
            },
            updated_at=materials.updated_at,
        )
        # Render the replacement resume PDF BEFORE superseding the prior approved
        # generation (preservation invariant — architecture.md §5.5 / CLAUDE.md).
        # A transient render failure must leave the last accepted generation
        # untouched, so on failure we neither supersede the prior nor publish
        # ResumeApproved: the new generation is demoted to a rejected attempt
        # (audit history) and the prior stays current for downstream stages.
        pdf_path: str | None = None
        if materials.is_resume_approved and self._pdf_renderer is not None:
            render = self._render_resume_pdf(
                materials=materials,
                final_payload=final_payload,
                profile_snapshot=profile_snapshot,
                resume_template=resume_template,
            )
            if isinstance(render, str):
                rejected = materials.with_resume_attempt(
                    artifact,
                    validation=ValidationResult.failure((render,)),
                    verdict=verdict,
                    updated_at=_utc_now(),
                )
                with self._unit_of_work if self._unit_of_work is not None else nullcontext():
                    self._assert_generation_persistable(
                        policy=tailoring_policy,
                        profile_snapshot=profile_snapshot,
                        commit_guard=commit_guard,
                    )
                    self._repository.save(rejected)
                self._publish_failed(
                    rejected,
                    validation_errors=(render,),
                    attempt=attempts,
                )
                return TailorOutcome(
                    materials=rejected,
                    status="error",
                    attempts=attempts,
                    text_path=str(text_path),
                    report=report,
                    error=render,
                    final_payload=final_payload,
                )
            pdf_artifact, pdf_path = render
            materials = materials.with_resume_pdf(pdf_artifact, updated_at=_utc_now())

        # Atomic generation flip (A9): supersede the prior approved generation,
        # save the new generation, and persist its provenance/coverage inside ONE
        # transaction. A crash or a provenance write failure mid-flip rolls the
        # whole block back, so the prior approved generation stays current and no
        # new artifact is ever committed without its provenance (the audit
        # invariant: every approved generation has its provenance). A failed
        # re-tailor still writes no provenance rows, so the prior generation's
        # rows survive untouched (Anti-Pattern 4 / success criterion 5). The
        # Phase-3 generation-time coverage (GROUND-06) + voice audit (VOICE-02)
        # ride on the same set. Event publication + best-effort requirement-fit
        # coverage enrichment run only AFTER the flip commits so they never
        # announce or enrich a rolled-back state.
        record_provenance = materials.is_resume_approved and bool(provenance_rows)
        # INVARIANT: everything inside this block is ONE SQLite transaction on the
        # shared thread-local connection. SqliteUnitOfWork opens it with BEGIN
        # IMMEDIATE and commits (or rolls back) on exit, so no code reachable from
        # here may commit, roll back, or open its own transaction on that
        # connection — doing so silently splits the flip back into non-atomic
        # writes and reopens the crash window A9 closed. Event publication and
        # projection refresh (which do commit) stay OUTSIDE the block, below.
        with self._unit_of_work if self._unit_of_work is not None else nullcontext():
            self._assert_generation_persistable(
                policy=tailoring_policy,
                profile_snapshot=profile_snapshot,
                commit_guard=commit_guard,
            )
            if materials.is_resume_approved and prior_generation is not None:
                self._repository.save(prior_generation)
            self._repository.save(materials)
            if record_provenance:
                self._persist_provenance_set(
                    materials=materials,
                    artifact_id=artifact.artifact_id,
                    bullets=provenance_rows,
                    coverage=coverage,
                    voice=voice_record,
                )

        if record_provenance and self._provenance_repository is not None:
            self._record_requirement_artifact_coverage(
                materials=materials, bullets=provenance_rows
            )
            self._publish_provenance(
                materials,
                artifact_id=artifact.artifact_id,
                bullet_count=len(provenance_rows),
            )

        status = self._derive_status(report, validation, verdict)
        if materials.is_resume_approved:
            self._publish_approved(materials)
        elif not review_required:
            self._publish_failed(
                materials,
                validation_errors=tuple(validation.errors),
                attempt=attempts,
            )

        # Write a JOB.txt + REPORT.json next to the tailored resume so
        # the legacy file layout downstream consumers know stays intact.
        try:
            job_path = tailored_dir / f"{prefix}_JOB.txt"
            job_path.write_text(
                "\n".join(
                    [
                        f"Title: {job.get('title', '')}",
                        f"Company: {_job_company(job)}",
                        f"Source: {job.get('site', '')}",
                        f"Location: {job.get('location', 'N/A')}",
                        f"Score: {job.get('fit_score', 'N/A')}",
                        f"URL: {job.get('url', '')}",
                        "",
                        str(job.get("full_description", "")),
                    ]
                ),
                encoding="utf-8",
            )
            (tailored_dir / f"{prefix}_REPORT.json").write_text(
                json.dumps(report, indent=2, default=str),
                encoding="utf-8",
            )
        except OSError as exc:
            log.debug("Failed to write tailor side files for %s: %s", prefix, exc)

        return TailorOutcome(
            materials=materials,
            status=status,
            attempts=attempts,
            text_path=str(text_path),
            pdf_path=pdf_path,
            report=report,
            final_payload=final_payload,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _render_resume_pdf(
        self,
        *,
        materials: MaterialsSet,
        final_payload: dict,
        profile_snapshot: ProfileSnapshot,
        resume_template: dict[str, Any] | None,
    ) -> tuple[Artifact, str] | str:
        """Render the approved resume to PDF next to its text artifact.

        Returns ``(pdf_artifact, pdf_path)`` on success or a
        ``"PDF render failed: …"`` message on failure. Rendering happens before
        the prior approved generation is superseded, so a failure here is
        recoverable — the caller keeps the last accepted resume intact.
        """
        assert self._pdf_renderer is not None
        assert materials.tailored_resume is not None
        pdf_out = Path(materials.tailored_resume.path).with_suffix(".pdf")
        try:
            pdf_artifact = self._pdf_renderer.render_resume_to_pdf(
                tailored_payload=final_payload,
                profile_dict=profile_snapshot.as_dict(),
                output_path=str(pdf_out),
                created_at=_utc_now(),
                resume_theme=(
                    resume_template.get("theme")
                    if isinstance(resume_template, dict)
                    else None
                ),
                resume_template=(
                    resume_template.get("metadata")
                    if isinstance(resume_template, dict)
                    else None
                ),
            )
        except Exception as exc:  # noqa: BLE001 — a render failure must not destroy the prior resume
            log.error(
                "Resume PDF generation failed for %s",
                materials.tailored_resume.path,
                exc_info=True,
            )
            return f"PDF render failed: {exc}"
        return pdf_artifact, str(pdf_out)

    def _run_analyze(
        self,
        *,
        job: dict,
        tenant_id: TenantId,
        employer_analysis: EmployerAnalysis | None,
    ) -> EmployerAnalysis:
        """The ``_run_analyze`` front-half sub-step of tailor (D-20).

        Resolution order:
          1. an explicit ``employer_analysis`` passed by the caller wins;
          2. otherwise the injected ``AnalyzeJobUseCase`` produces/reuses it
             (cache-backed — a re-tailor on the same snapshot reuses it);
          3. if neither is available the use case cannot tailor (the analysis
             is the single source of truth for keyword selection — D-21), so we
             fail loudly rather than silently fall back to a heuristic.
        """
        if employer_analysis is not None:
            return employer_analysis
        if self._analyze_use_case is None:
            raise ValueError(
                "TailorResumeUseCase requires either an employer_analysis argument or an "
                "injected analyze_use_case (the canonical employer analysis is the single "
                "source of truth for tailoring keywords — D-20/D-21)."
            )
        return self._analyze_use_case.execute(job=job, tenant_id=tenant_id).analysis

    def _run_attempts(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        validation_mode: str,
        employer_analysis: EmployerAnalysis,
        requirement_fit_report: "RequirementFitReport | None" = None,
        tailoring_plan: TailoringPlan,
        tailor_prompt_base: str,
        execution_guard: Callable[[], None] | None = None,
    ) -> tuple[dict, dict | None, ValidationResult, JudgeVerdict | None]:
        """Run the LLM ⇒ validate ⇒ judge attempt loop.

        Returns the legacy-shaped ``report`` dict + the last successful
        payload (or ``None`` if every attempt failed to parse) + the last
        :class:`ValidationResult` and :class:`JudgeVerdict`.
        """
        model_policy = self._llm_policy
        report: dict = {
            "attempts": 0,
            "validator": None,
            "judge": None,
            "status": "pending",
            "validation_mode": validation_mode,
            "prompt_version": TAILORING_PROMPT_VERSION,
            "schema_version": TAILORING_SCHEMA_VERSION,
            "judge_schema_version": TAILORING_JUDGE_SCHEMA_VERSION,
            "candidate_models": list(model_policy.effective_candidate_models),
            "judge_model": model_policy.effective_judge_model,
            "judge_min_score": model_policy.judge_min_score,
            "system_prompt": tailor_prompt_base,
            "job_text": _build_job_blob(job),
            "quality_plan": tailoring_plan.to_metadata(),
            "quality_checks": None,
            "post_generation_fit": None,
            "bullet_limit_overflows": [],
            "adversarial_review": None,
            "review_feedback": {
                "warning_retry_attempted": False,
                "accepted_with_residual_warnings": False,
                "accepted_warning_notes": [],
            },
            "change_annotations": [],
            "attempt_history": [],
            "candidate_summaries": [],
        }
        avoid_notes: list[str] = []
        retry_reasons: list[str] = []
        last_payload: dict | None = None
        last_validation: ValidationResult = ValidationResult.failure(("no attempt yet",))
        last_verdict: JudgeVerdict | None = None
        best_rejected: _TailorCandidate | None = None
        best_warned_approved: (
            tuple[_TailorCandidate, tuple[str, ...], tuple[str, ...]] | None
        ) = None
        best_review_required: _TailorCandidate | None = None

        def accept_candidate(
            selected: _TailorCandidate,
            attempt_record: dict[str, Any] | None,
            *,
            warning_notes: tuple[str, ...] = (),
            review_required: bool = False,
        ) -> tuple[dict, dict | None, ValidationResult, JudgeVerdict | None]:
            report["status"] = "review_required" if review_required else "approved"
            report["validator"] = selected.validation.to_dict()
            report["judge"] = selected.record.get("judge")
            report["quality_checks"] = selected.record.get("quality_checks")
            report["adversarial_review"] = selected.record.get("adversarial_review")
            report["selected_candidate"] = selected.record.get("candidate_id")
            report["selected_model"] = selected.model
            report["selected_prompt_fingerprint"] = selected.record.get(
                "prompt_fingerprint"
            )
            report["post_generation_fit"] = selected.record.get("post_generation_fit")
            report["review_required"] = review_required
            report["review_blockers"] = selected.record.get("review_blockers") or []
            report["bullet_limit_overflows"] = selected.record.get("bullet_limit_overflows") or []
            report["change_annotations"] = list(
                build_tailoring_change_annotations(
                    profile_snapshot.as_dict(),
                    job,
                    selected.payload,
                    tailoring_plan,
                )
            )
            feedback = report["review_feedback"]
            feedback["accepted_with_residual_warnings"] = bool(warning_notes)
            feedback["accepted_warning_notes"] = list(warning_notes[:8])
            if attempt_record is not None:
                if review_required:
                    attempt_record["status"] = "review_required"
                elif warning_notes:
                    attempt_record["status"] = "approved_with_residual_warnings"
                else:
                    attempt_record["status"] = "approved"
                attempt_record["selected_candidate"] = selected.record.get("candidate_id")
                if warning_notes:
                    attempt_record["accepted_warning_notes"] = list(warning_notes[:8])
                report["attempt_history"].append(attempt_record)
            return report, selected.payload, selected.validation, selected.verdict

        for attempt in range(self._max_retries + 1):
            if execution_guard is not None:
                execution_guard()
            report["attempts"] = attempt + 1

            prompt = _retry_system_prompt(tailor_prompt_base, retry_reasons)
            attempt_record: dict[str, Any] = {
                "attempt": attempt + 1,
                "avoid_notes": list(avoid_notes[-5:]),
                "retry_reasons": list(dict.fromkeys(retry_reasons[-5:])),
                "system_prompt": prompt,
                "candidates": [],
            }

            messages = [
                LlmMessage(role="system", content=prompt),
                LlmMessage(
                    role="user",
                    content=(
                        "ORIGINAL RESUME:\n"
                        + (profile_snapshot.as_dict().get("resume", {}).get("executive_profile", {}).get("baseline_text", "") or "")
                        + "\n\n---\n\nTARGET JOB:\n"
                        + report["job_text"]
                        + "\n\nReturn the JSON:"
                    ),
                ),
            ]

            approved_candidates: list[_TailorCandidate] = []
            for model in model_policy.effective_candidate_models:
                if execution_guard is not None:
                    execution_guard()
                candidate = self._run_candidate(
                    messages=messages,
                    model=model,
                    profile_snapshot=profile_snapshot,
                    tailoring_plan=tailoring_plan,
                    validation_mode=validation_mode,
                    job=job,
                    attempt=attempt + 1,
                    employer_analysis=employer_analysis,
                )
                attempt_record["candidates"].append(candidate.record)
                last_payload = candidate.payload or last_payload
                last_validation = candidate.validation
                last_verdict = candidate.verdict
                report["selected_prompt_fingerprint"] = candidate.record.get(
                    "prompt_fingerprint"
                )

                if candidate.validation.passed and (
                    candidate.verdict is None or candidate.verdict.approved
                ):
                    # Deterministic never-fabricate gate on a validation- and
                    # judge-approved candidate BEFORE it can be selected (A6d): a hard
                    # finding rejects THIS candidate, records its details for audit,
                    # and triggers fixed code-owned retry guidance instead of promoting
                    # finding text into the next prompt. This runs the same gate
                    # ``_voice_and_audit`` re-confirms on the shipped text.
                    if not self._apply_fabrication_gate(
                        candidate,
                        profile_snapshot=profile_snapshot,
                        job=job,
                        employer_analysis=employer_analysis,
                        requirement_fit_report=requirement_fit_report,
                        plan=tailoring_plan,
                    ):
                        if _candidate_requires_review(candidate.record):
                            if (
                                best_review_required is None
                                or candidate.judge_score > best_review_required.judge_score
                            ):
                                best_review_required = candidate
                        else:
                            approved_candidates.append(candidate)
                elif candidate.validation.passed and candidate.verdict is not None:
                    if best_rejected is None or candidate.judge_score > best_rejected.judge_score:
                        best_rejected = candidate

                report["candidate_summaries"].append(_safe_candidate_summary(candidate.record))

            if approved_candidates:
                approved_with_notes = [
                    (
                        candidate,
                        _candidate_warning_notes(candidate.record),
                        _candidate_retry_warning_notes(candidate.record),
                    )
                    for candidate in approved_candidates
                ]
                clean_approved = [
                    (candidate, notes)
                    for candidate, notes, retry_notes in approved_with_notes
                    if not retry_notes
                ]
                if clean_approved:
                    selected, warning_notes = max(
                        clean_approved,
                        key=_clean_approved_candidate_rank,
                    )
                    return accept_candidate(
                        selected,
                        attempt_record,
                        warning_notes=warning_notes,
                    )

                selected, warning_notes, retry_notes = max(
                    approved_with_notes,
                    key=lambda item: (-len(item[2]), item[0].judge_score),
                )
                if (
                    best_warned_approved is None
                    or (-len(retry_notes), selected.judge_score)
                    > (
                        -len(best_warned_approved[2]),
                        best_warned_approved[0].judge_score,
                    )
                ):
                    best_warned_approved = (selected, warning_notes, retry_notes)
                if attempt < self._max_retries:
                    avoid_notes.extend(retry_notes)
                    retry_reasons.append("residual_quality_warning")
                    report["review_feedback"]["warning_retry_attempted"] = True
                    attempt_record["status"] = "approved_with_warnings_retry"
                    attempt_record["warning_retry_notes"] = list(retry_notes[:8])
                    report["attempt_history"].append(attempt_record)
                    continue
                best_selected, best_warning_notes, _best_retry_notes = (
                    best_warned_approved
                    or (
                        selected,
                        warning_notes,
                        retry_notes,
                    )
                )
                if best_selected is selected:
                    return accept_candidate(
                        selected,
                        attempt_record,
                        warning_notes=warning_notes,
                    )
                attempt_record["status"] = "approved_with_warnings_not_selected"
                attempt_record["warning_retry_notes"] = list(warning_notes[:8])
                report["attempt_history"].append(attempt_record)
                return accept_candidate(
                    best_selected,
                    None,
                    warning_notes=best_warning_notes,
                )

            for candidate_record in attempt_record["candidates"]:
                status = str(candidate_record.get("status", ""))
                if status == "parse_error":
                    avoid_notes.append("Output was not valid JSON. Return ONLY a JSON object.")
                    retry_reasons.append("invalid_json")
                elif status == "failed_validation":
                    validator = candidate_record.get("validator") or {}
                    avoid_notes.extend(str(error) for error in validator.get("errors", []))
                    retry_reasons.append("validation_failed")
                elif status == "judge_rejected":
                    judge = candidate_record.get("judge") or {}
                    avoid_notes.append(f"Judge rejected: {judge.get('issues') or 'quality gate failed'}")
                    retry_reasons.append("judge_rejected")
                elif status == "adversarial_rejected":
                    review = candidate_record.get("adversarial_review") or {}
                    blockers = review.get("blockers") or []
                    repairs = review.get("repair_instructions") or []
                    avoid_notes.extend(str(item) for item in [*blockers, *repairs] if str(item))
                    retry_reasons.append("adversarial_rejected")
                elif status == "failed_fabrication_gate":
                    gate = candidate_record.get("fabrication_gate") or {}
                    avoid_notes.extend(
                        note for note in gate.get("avoid_notes") or [] if str(note).strip()
                    )
                    retry_reasons.append("fabrication_detected")

            attempt_record["status"] = "failed_quality_gate"
            report["attempt_history"].append(attempt_record)

        report["status"] = "exhausted_retries"
        if best_warned_approved is not None:
            selected, warning_notes, _retry_notes = best_warned_approved
            return accept_candidate(selected, None, warning_notes=warning_notes)
        if best_review_required is not None:
            return accept_candidate(best_review_required, None, review_required=True)
        if best_rejected is not None:
            report["status"] = (
                "failed_adversarial_review"
                if best_rejected.record.get("status") == "adversarial_rejected"
                else "failed_judge"
            )
            report["validator"] = best_rejected.validation.to_dict()
            report["judge"] = best_rejected.record.get("judge")
            report["quality_checks"] = best_rejected.record.get("quality_checks")
            report["adversarial_review"] = best_rejected.record.get("adversarial_review")
            report["selected_candidate"] = best_rejected.record.get("candidate_id")
            report["selected_model"] = best_rejected.model
            report["selected_prompt_fingerprint"] = best_rejected.record.get(
                "prompt_fingerprint"
            )
            return report, best_rejected.payload, best_rejected.validation, best_rejected.verdict
        if last_payload is not None and not last_validation.passed:
            report["status"] = "failed_validation"
        return report, last_payload, last_validation, last_verdict

    def _resolve_tailoring_policy(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        prompt_text: str,
        validation_mode: str,
        tenant_id: TenantId,
        learned_tailoring_rules: LearnedTailoringRules,
        expected_current_version: int,
    ) -> TailoringPolicy:
        profile = profile_snapshot.as_dict()
        runtime_settings: dict[str, Any] = {
            "validation_mode": validation_mode,
            "profile_snapshot_fingerprint": fingerprint_profile_snapshot(
                profile_snapshot
            ),
        }
        if learned_tailoring_rules.rules:
            runtime_settings["learned_tailoring_rules"] = learned_tailoring_rules.to_dict()
        candidate = TailoringPolicy.from_runtime(
            tenant_id=tenant_id,
            version=1,
            prompt_version=TAILORING_PROMPT_VERSION,
            schema_version=TAILORING_SCHEMA_VERSION,
            judge_schema_version=TAILORING_JUDGE_SCHEMA_VERSION,
            prompt_text=prompt_text,
            profile_policy=get_tailoring_policy(profile),
            custom_prompt=get_custom_tailoring_prompt(profile),
            generator_settings={
                "candidate_models": list(self._llm_policy.effective_candidate_models),
                "temperature": self._llm_policy.candidate_temperature,
                "max_tokens": self._llm_policy.candidate_max_tokens,
                "thinking_budget": self._llm_policy.thinking_budget,
            },
            judge_settings={
                "judge_model": self._llm_policy.effective_judge_model,
                "temperature": self._llm_policy.judge_temperature,
                "max_tokens": self._llm_policy.judge_max_tokens,
                "min_score": self._llm_policy.judge_min_score,
            },
            runtime_settings=runtime_settings,
            created_at=_utc_now(),
        )
        if self._policy_repository is None:
            return candidate
        return self._policy_repository.resolve_current(
            candidate,
            expected_current_version=expected_current_version,
        )

    def _assert_generation_persistable(
        self,
        *,
        policy: TailoringPolicy,
        profile_snapshot: ProfileSnapshot,
        commit_guard: Callable[[], None] | None,
    ) -> None:
        """Fence the final artifact write inside its transaction."""

        if commit_guard is not None:
            commit_guard()
        if self._unit_of_work is not None and self._policy_repository is not None:
            self._policy_repository.assert_generation_current(
                policy,
                profile_snapshot,
            )

    def _run_candidate(
        self,
        *,
        messages: list[LlmMessage],
        model: str,
        profile_snapshot: ProfileSnapshot,
        tailoring_plan: TailoringPlan,
        validation_mode: str,
        job: dict,
        attempt: int,
        employer_analysis: EmployerAnalysis,
    ) -> _TailorCandidate:
        candidate_id = f"candidate-{abs(hash((model, len(messages), messages[-1].content[:80]))) % 10_000_000}"
        record: dict[str, Any] = {
            "candidate_id": candidate_id,
            "model": model,
            "schema_version": TAILORING_SCHEMA_VERSION,
            "prompt_fingerprint": fingerprint_value(
                [
                    {"role": message.role, "content": message.content}
                    for message in messages
                ]
            ),
        }
        empty_validation = ValidationResult.failure(("no candidate generated",))
        try:
            payload = self._chat_json_payload(
                messages,
                schema=TAILORED_RESUME_RESPONSE_SCHEMA,
                model=model,
                temperature=self._llm_policy.candidate_temperature,
                max_tokens=self._llm_policy.candidate_max_tokens,
                thinking_budget=self._llm_policy.thinking_budget,
            )
        except Exception as exc:  # noqa: BLE001
            record["status"] = "parse_error"
            record["parse_error"] = str(exc)
            return _TailorCandidate(
                payload={},
                validation=empty_validation,
                verdict=None,
                tailored_text="",
                model=model,
                record=record,
            )

        record["parsed_json"] = payload
        validation = self._validator.validate_json_fields(
            payload, profile_snapshot, mode=validation_mode
        )
        tailored_text = ""
        if validation.passed:
            tailored_text = self._assembler.assemble_resume_text(payload, profile_snapshot)
            rendered_validation = self._validator.validate_tailored_resume(
                tailored_text, profile_snapshot
            )
            if not rendered_validation.passed:
                validation = ValidationResult.failure(
                    tuple(validation.errors) + tuple(rendered_validation.errors),
                    warnings=tuple(validation.warnings) + tuple(rendered_validation.warnings),
                )
            elif rendered_validation.warnings:
                validation = ValidationResult.success(
                    warnings=tuple(validation.warnings) + tuple(rendered_validation.warnings)
                )
            quality_result = evaluate_tailoring_quality(
                payload,
                tailored_text,
                tailoring_plan,
            )
            record["quality_checks"] = quality_result.to_dict()
            claim_mapping_errors = _claim_mapping_validation_errors(
                payload=payload,
                tailoring_plan=tailoring_plan,
            )
            if claim_mapping_errors:
                record["claim_mapping_validation"] = {
                    "passed": False,
                    "errors": list(claim_mapping_errors),
                }
                validation = ValidationResult.failure(
                    tuple(validation.errors) + claim_mapping_errors,
                    warnings=tuple(validation.warnings),
                )
            else:
                record["claim_mapping_validation"] = {"passed": True, "errors": []}
            # Render this candidate's shipped lines (pure, assembler-mirroring) so
            # the fit gate measures coverage against what would actually ship.
            shipped_rows: tuple[BulletProvenance, ...] = ()
            if not claim_mapping_errors:
                try:
                    shipped_rows = build_bullet_provenance(
                        profile_snapshot.as_dict(),
                        job,
                        payload,
                        tailoring_plan,
                        employer_analysis,
                    )
                except ProvenanceBindingError as exc:
                    validation = ValidationResult.failure(
                        (*validation.errors, f"Provenance grounding failed: {exc}"),
                        warnings=tuple(validation.warnings),
                    )
            # No shipped rows means the candidate already failed upstream (claim
            # mapping or provenance binding errors); grounding against an empty
            # resume would record a misleading 0% on a candidate that is already
            # rejected, so the gate is skipped rather than fabricating a score.
            fit_gate: dict[str, Any] | None = None
            fit_gate_errors: tuple[str, ...] = ()
            review_blockers: tuple[str, ...] = ()
            if shipped_rows:
                fit_gate, fit_gate_errors, review_blockers = _post_generation_fit_gate(
                    payload=payload,
                    tailoring_plan=tailoring_plan,
                    attempt=attempt,
                    shipped_rows=shipped_rows,
                )
            if fit_gate is not None:
                record["post_generation_fit"] = fit_gate
                residual_warnings = _as_string_list(fit_gate.get("residual_warnings"))
                if residual_warnings and validation.passed:
                    validation = ValidationResult.success(
                        warnings=tuple(validation.warnings) + tuple(residual_warnings)
                    )
            if review_blockers:
                record["review_required"] = True
                record["review_blockers"] = list(review_blockers)
                if validation.passed:
                    validation = ValidationResult.success(
                        warnings=tuple(validation.warnings)
                        + tuple(f"Review required: {item}" for item in review_blockers)
                    )
            record["bullet_limit_overflows"] = list(
                _bullet_limit_overflow_metadata(
                    payload=payload,
                    profile_snapshot=profile_snapshot,
                )
            )
            if fit_gate_errors:
                validation = ValidationResult.failure(
                    tuple(validation.errors) + fit_gate_errors,
                    warnings=tuple(validation.warnings),
                )
            if quality_result.errors:
                validation = ValidationResult.failure(
                    tuple(validation.errors) + tuple(quality_result.errors),
                    warnings=tuple(validation.warnings) + tuple(quality_result.warnings),
                )
            elif quality_result.warnings and validation.passed:
                validation = ValidationResult.success(
                    warnings=tuple(validation.warnings) + tuple(quality_result.warnings)
                )
        record["validator"] = validation.to_dict()

        if not validation.passed:
            record["status"] = "failed_validation"
            return _TailorCandidate(
                payload=payload,
                validation=validation,
                verdict=None,
                tailored_text=tailored_text,
                model=model,
                record=record,
            )

        if validation_mode == "lenient":
            verdict = JudgeVerdict.passed(score=1.0, notes="judge skipped (lenient)")
            record["judge"] = {"verdict": "SKIPPED", "passed": True, "issues": [], "score": 1.0}
            record["status"] = "approved"
            return _TailorCandidate(payload, validation, verdict, tailored_text, model, record)

        verdict = self._judge_resume(
            profile_snapshot=profile_snapshot,
            tailoring_plan=tailoring_plan,
            tailored_payload=payload,
            tailored_text=tailored_text,
            job=job,
        )
        if verdict.approved:
            adversarial_review = self._adversarial_review(
                profile_snapshot=profile_snapshot,
                tailoring_plan=tailoring_plan,
                tailored_payload=payload,
                tailored_text=tailored_text,
                job=job,
                validation_mode=validation_mode,
            )
            record["adversarial_review"] = adversarial_review.to_dict()
            if not adversarial_review.passed:
                verdict = self._adversarial_failed_verdict(verdict, adversarial_review)
        record["judge"] = self._judge_record(verdict)
        if verdict.approved:
            record["status"] = "approved"
        elif record.get("adversarial_review", {}).get("ran"):
            record["status"] = "adversarial_rejected"
        else:
            record["status"] = "judge_rejected"
        return _TailorCandidate(payload, validation, verdict, tailored_text, model, record)

    def _chat_json_payload(
        self,
        messages: list[LlmMessage],
        *,
        schema: dict[str, Any],
        model: str | None,
        temperature: float,
        max_tokens: int,
        thinking_budget: int | None,
    ) -> dict:
        try:
            return self._llm.chat_json(
                messages,
                response_schema=schema,
                model=None if model in {"", "default"} else model,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking_budget=thinking_budget,
            )
        except AttributeError:
            raw = self._llm.chat(
                messages,
                model=None if model in {"", "default"} else model,
                temperature=temperature,
                max_tokens=max_tokens,
                response_schema=schema,
                thinking_budget=thinking_budget,
            )
            return _extract_json(raw)

    def _judge_resume(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        tailoring_plan: TailoringPlan,
        tailored_payload: dict,
        tailored_text: str,
        job: dict,
    ) -> JudgeVerdict:
        judge_prompt = build_judge_prompt(
            profile_snapshot,
            tailoring_plan=tailoring_plan,
        )
        messages = [
            LlmMessage(role="system", content=judge_prompt),
            LlmMessage(
                role="user",
                content=(
                    f"TARGET JOB:\n{_build_job_blob(job)}\n\n"
                    f"TAILORED JSON:\n{json.dumps(tailored_payload, indent=2, ensure_ascii=False)}\n\n"
                    f"TAILORED RESUME:\n{tailored_text}\n\n"
                    "Judge this tailored resume and return the JSON:"
                ),
            ),
        ]
        try:
            response = self._chat_json_payload(
                messages,
                schema=TAILORING_JUDGE_RESPONSE_SCHEMA,
                model=self._llm_policy.effective_judge_model,
                temperature=self._llm_policy.judge_temperature,
                max_tokens=self._llm_policy.judge_max_tokens,
                thinking_budget=self._llm_policy.thinking_budget,
            )
        except Exception as exc:  # noqa: BLE001
            log.error("Judge LLM error: %s", exc)
            return JudgeVerdict.failed(notes=f"judge error: {exc}")

        verdict = str(response.get("verdict") or "FAIL").upper()
        try:
            score = float(response.get("score") or 0.0)
        except (TypeError, ValueError):
            score = 0.0
        score = max(0.0, min(1.0, score))
        issues = _as_string_list(response.get("issues"))
        unsupported = _as_string_list(response.get("unsupported_claims"))
        fabrications = _as_string_list(response.get("fabrications"))
        missing = _as_string_list(response.get("missing_required_evidence"))
        repairs = _as_string_list(response.get("repair_instructions"))
        blockers = unsupported + fabrications + missing
        try:
            criterion_scores = {
                str(key): float(value)
                for key, value in dict(response.get("criterion_scores") or {}).items()
            }
        except (TypeError, ValueError):
            return JudgeVerdict.failed(notes="judge error: invalid criterion_scores")
        if not criterion_scores:
            return JudgeVerdict.failed(notes="judge error: missing criterion_scores")
        approved = (
            verdict == "PASS"
            and score >= self._llm_policy.judge_min_score
            and not blockers
        )
        notes_payload = {
            "verdict": verdict,
            "score": score,
            "issues": issues,
            "unsupported_claims": unsupported,
            "fabrications": fabrications,
            "missing_required_evidence": missing,
            "repair_instructions": repairs,
            "criterion_scores": criterion_scores,
            "judge_model": self._llm_policy.effective_judge_model,
            "judge_schema_version": TAILORING_JUDGE_SCHEMA_VERSION,
        }
        return JudgeVerdict(
            approved=approved,
            score=score,
            notes=json.dumps(notes_payload, ensure_ascii=False, sort_keys=True),
            criterion_scores=criterion_scores,
            issues=tuple(issues + blockers),
        )

    def _adversarial_review(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        tailoring_plan: TailoringPlan,
        tailored_payload: dict,
        tailored_text: str,
        job: dict,
        validation_mode: str,
    ) -> AdversarialReviewResult:
        normalized_fit = normalized_job_fit_score(job)
        if validation_mode == "lenient":
            return AdversarialReviewResult.skipped(
                threshold=ADVERSARIAL_REVIEW_THRESHOLD,
                normalized_fit_score=normalized_fit,
                reason="lenient_validation_mode",
            )
        if not should_run_adversarial_review(job):
            return AdversarialReviewResult.skipped(
                threshold=ADVERSARIAL_REVIEW_THRESHOLD,
                normalized_fit_score=normalized_fit,
                reason="below_high_fit_threshold",
            )

        messages = [
            LlmMessage(
                role="system",
                content=build_adversarial_review_prompt(
                    profile_snapshot=profile_snapshot,
                    tailoring_plan=tailoring_plan,
                ),
            ),
            LlmMessage(
                role="user",
                content=(
                    f"TARGET JOB:\n{_build_job_blob(job)}\n\n"
                    f"TAILORED JSON:\n{json.dumps(tailored_payload, indent=2, ensure_ascii=False)}\n\n"
                    f"TAILORED RESUME:\n{tailored_text}\n\n"
                    "Run the adversarial review and return JSON:"
                ),
            ),
        ]
        prompt_messages = _audit_prompt_messages(messages)
        judge_model = self._llm_policy.effective_judge_model
        try:
            response = self._chat_json_payload(
                messages,
                schema=ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
                model=judge_model,
                temperature=self._llm_policy.judge_temperature,
                max_tokens=self._llm_policy.judge_max_tokens,
                thinking_budget=self._llm_policy.thinking_budget,
            )
        except Exception as exc:  # noqa: BLE001
            log.error("Adversarial review LLM error: %s", exc)
            return AdversarialReviewResult.failed_error(
                threshold=ADVERSARIAL_REVIEW_THRESHOLD,
                normalized_fit_score=normalized_fit,
                error=str(exc),
                model=judge_model,
                prompt_messages=prompt_messages,
            )
        return AdversarialReviewResult.from_response(
            response,
            threshold=ADVERSARIAL_REVIEW_THRESHOLD,
            normalized_fit_score=normalized_fit,
            model=judge_model,
            prompt_messages=prompt_messages,
        )

    def _adversarial_failed_verdict(
        self,
        base: JudgeVerdict,
        review: AdversarialReviewResult,
    ) -> JudgeVerdict:
        try:
            notes_payload = json.loads(base.notes) if base.notes else {}
        except json.JSONDecodeError:
            notes_payload = {"issues": [base.notes] if base.notes else []}
        notes_payload["adversarial_review"] = review.to_dict()
        criterion_scores = dict(base.criterion_scores)
        criterion_scores["adversarial_review"] = review.score
        issues = tuple(dict.fromkeys([*base.issues, *review.blockers]))
        return JudgeVerdict(
            approved=False,
            score=min(base.score, review.score),
            notes=json.dumps(notes_payload, ensure_ascii=False, sort_keys=True),
            criterion_scores=criterion_scores,
            issues=issues,
        )

    def _judge_record(self, verdict: JudgeVerdict | None) -> dict[str, Any] | None:
        if verdict is None:
            return None
        try:
            notes = json.loads(verdict.notes) if verdict.notes else {}
        except json.JSONDecodeError:
            notes = {"issues": [verdict.notes] if verdict.notes else []}
        return {
            "passed": verdict.approved,
            "verdict": "PASS" if verdict.approved else "FAIL",
            "score": verdict.score,
            "issues": list(verdict.issues) or notes.get("issues") or [],
            "unsupported_claims": notes.get("unsupported_claims") or [],
            "fabrications": notes.get("fabrications") or [],
            "missing_required_evidence": notes.get("missing_required_evidence") or [],
            "repair_instructions": notes.get("repair_instructions") or [],
            "criterion_scores": dict(verdict.criterion_scores) or notes.get("criterion_scores") or {},
            "judge_model": notes.get("judge_model") or self._llm_policy.effective_judge_model,
            "judge_schema_version": TAILORING_JUDGE_SCHEMA_VERSION,
        }

    def _derive_status(
        self,
        report: dict,
        validation: ValidationResult,
        verdict: JudgeVerdict | None,
    ) -> str:
        status = report.get("status", "pending")
        if not validation.passed:
            return "failed_validation"
        if status == "approved":
            return "approved" if verdict is None or verdict.approved else "failed_judge"
        if status == "failed_adversarial_review":
            return status
        if validation.passed and verdict is not None and not verdict.approved:
            return "failed_judge"
        if validation.passed and verdict is None and status == "approved":
            return "approved"
        return status

    def _publish_approved(self, materials: MaterialsSet) -> None:
        if self._publisher is None or materials.tailored_resume is None:
            return
        try:
            event = create_resume_approved(
                materials.tenant_id,
                ResumeApprovedPayload(
                    job_id=str(materials.job_id),
                    artifact_id=materials.tailored_resume.artifact_id,
                    generation=materials.generation,
                    approved_at=materials.updated_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish ResumeApproved for %s", materials.job_id)

    def _publish_failed(
        self,
        materials: MaterialsSet,
        *,
        validation_errors: tuple[str, ...],
        attempt: int,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_resume_failed(
                materials.tenant_id,
                ResumeFailedPayload(
                    job_id=str(materials.job_id),
                    validation_errors=tuple(validation_errors),
                    attempt_number=attempt,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("Failed to publish ResumeFailed for %s", materials.job_id)

    # ------------------------------------------------------------------
    # Phase 2 — per-bullet provenance + deterministic never-fabricate gate
    # ------------------------------------------------------------------

    def _compute_provenance(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        job: dict,
        tailored_payload: dict,
        employer_analysis: EmployerAnalysis,
        requirement_fit_report: "RequirementFitReport | None" = None,
        plan: TailoringPlan | None = None,
    ) -> tuple[tuple[BulletProvenance, ...], str | None, tuple[FabricationFinding, ...]]:
        """Compute per-bullet provenance + run the deterministic fabrication gate.

        Returns ``(provenance_rows, fabrication_error, findings)``.
        ``fabrication_error`` is a non-empty message when the candidate must be
        HARD-REJECTED — either it fabricated a numeric/date/title/employer/skill
        token (CONTROL-03 / GROUND-05) or a provenance binding referenced a
        non-existent evidence/requirement id (GROUND-05: FK bindings, not free
        text). ``findings`` carries the structured never-fabricate findings (empty
        for an FK binding error or a clean candidate) so the caller can render
        per-token audit notes and record an inspectable trail. On reject
        the rows are dropped so no provenance is persisted for an unaccepted
        candidate.

        ``plan`` may be passed pre-built (the attempt loop already has it) to avoid
        rebuilding it per candidate; when omitted it is built from the analysis.

        The detector runs INDEPENDENTLY of the tailoring prompt — it checks the
        actual generated bullet text against the canonical profile evidence corpus,
        never the model's self-reported provenance.
        """
        profile = profile_snapshot.as_dict()
        if plan is None:
            plan = build_tailoring_plan(
                profile,
                job,
                employer_analysis=employer_analysis,
                requirement_fit_report=requirement_fit_report,
            )
        try:
            rows = build_bullet_provenance(
                profile, job, tailored_payload, plan, employer_analysis
            )
        except ProvenanceBindingError as exc:
            log.warning("Provenance binding rejected for %s: %s", job.get("url"), exc)
            return (), f"Provenance grounding failed: {exc}", ()

        corpus = build_evidence_corpus(profile)
        employers = employer_name_set(profile)
        # The whole-resume corpus EXCLUDES skill categories (so a skills-line
        # version numeric never cross-grounds an experience metric). Ground the
        # SKILLS rows against the declared skill items instead, so a canonical
        # "Java 17" / "OAuth 2.0" is not a false fabrication while a skills numeric
        # that traces to no declared item (a renderer bug / injected item) is still
        # caught (A6c).
        skill_corpus = build_skill_evidence_corpus(profile)
        findings = scan_resume_bullets(
            [(row.bullet_id, row.generated_text) for row in rows if row.section != "skills"],
            corpus,
            employers=employers,
        )
        findings.extend(
            scan_resume_bullets(
                [(row.bullet_id, row.generated_text) for row in rows if row.section == "skills"],
                skill_corpus,
                employers=employers,
            )
        )
        # Sibling gate: a job-target NAMED TECHNOLOGY woven into an experience
        # bullet or the executive summary that traces to neither the profile skill
        # vocabulary nor the evidence corpus is a fabrication (the numeric detector
        # has no concept of a tool). The gate scopes itself to named technologies
        # and grounds word-form variants, so concept/qualification keywords are
        # never hard-rejected; passing the full canonical keyword set is safe. The
        # skills SECTION is excluded — it is governed by the skills-section
        # allowlist, not this prose gate.
        prose_rows = [
            (row.bullet_id, row.generated_text)
            for row in rows
            if row.section in ("executive_profile", "experience")
        ]
        findings.extend(
            scan_prose_skill_fabrications(
                prose_rows,
                target_skill_terms=[
                    keyword.keyword
                    for keyword in employer_analysis.canonical.keywords
                    if keyword.keyword.strip()
                ],
                allowed_skill_terms=build_skill_vocabulary(profile),
                corpus=corpus,
            )
        )
        if findings:
            error = FabricationError(findings)
            log.warning("Never-fabricate detector rejected %s: %s", job.get("url"), error)
            return (), f"Never-fabricate detector failed: {error}", tuple(findings)
        return rows, None, ()

    def _apply_fabrication_gate(
        self,
        candidate: _TailorCandidate,
        *,
        profile_snapshot: ProfileSnapshot,
        job: dict,
        employer_analysis: EmployerAnalysis,
        requirement_fit_report: "RequirementFitReport | None",
        plan: TailoringPlan,
    ) -> bool:
        """Reject a would-be-approved candidate that trips the deterministic gate.

        Runs the never-fabricate + FK gate on the candidate's rendered text. On a
        hard finding it stamps ``status = "failed_fabrication_gate"`` plus an
        inspectable ``fabrication_gate`` record (the audit trail for a rejected
        candidate — the findings that did NOT ship, distinct from residual warnings
        accepted on the shipped candidate). The attempt loop retains those notes for
        audit and uses only the fixed ``fabrication_detected`` retry reason. Returns
        ``True`` so the caller drops the candidate from selection; returns ``False``
        when the candidate is grounded.
        """
        _rows, error, findings = self._compute_provenance(
            profile_snapshot=profile_snapshot,
            job=job,
            tailored_payload=candidate.payload,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
            plan=plan,
        )
        if error is None:
            return False
        avoid_notes = _render_fabrication_avoid_notes(findings) if findings else [error]
        candidate.record["status"] = "failed_fabrication_gate"
        candidate.record["fabrication_gate"] = {
            "passed": False,
            "error": error,
            "controls": sorted({finding.control.value for finding in findings}),
            "findings": [finding.describe() for finding in findings],
            "avoid_notes": avoid_notes,
        }
        return True

    # ------------------------------------------------------------------
    # Phase 3 — voice pass → re-validate → final audit (coverage vs rendered text)
    # ------------------------------------------------------------------

    def _final_fit_record(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        job: dict,
        employer_analysis: EmployerAnalysis,
        requirement_fit_report: "RequirementFitReport | None",
        final_payload: dict,
        grounding: ClaimGrounding,
    ) -> dict[str, Any] | None:
        """Grounded fit of the SHIPPED artifact — the audit's source of truth.

        Lifecycle-labeled ``post_voice_shipped``: computed on the final voiced
        payload against the lines that actually ship, AFTER the attempt-scoped
        revision gate ran. It never mutates the gate record — a shipped artifact
        whose grounded must-have coverage fell below the gate (e.g. voice
        unshipped a mapped claim) carries explicit residual warnings here
        instead, so the review surface can label both truthfully.
        """
        plan = build_tailoring_plan(
            profile_snapshot.as_dict(),
            job,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
        )
        target_profile = plan.target_profile
        if target_profile is None:
            return None
        mappings, parse_errors = _claim_mappings_from_payload(final_payload)
        if parse_errors:
            mappings = ()
        fit = score_generated_resume_against_target(
            target_profile=target_profile,
            mappings=mappings,
            grounding=grounding,
        )
        gates = plan.requirement_led_controls.revision_gates
        passed = (
            fit.score >= gates.min_fit_score
            and fit.must_have_coverage >= gates.must_have_coverage
        )
        warnings: list[str] = []
        if not passed:
            warnings.append(
                "Shipped grounded must-have coverage "
                f"{round(fit.must_have_coverage * 100)}% (fit {fit.score}/10) is below "
                f"the revision gate ({round(gates.must_have_coverage * 100)}% / "
                f"{gates.min_fit_score}/10)."
            )
        return {
            "lifecycle": "post_voice_shipped",
            "fit_score": fit.to_dict(),
            "grounding": grounding.to_metadata(),
            "gate_thresholds": {
                "min_fit_score": gates.min_fit_score,
                "must_have_coverage": gates.must_have_coverage,
            },
            "passed": passed,
            "warnings": warnings,
        }

    @staticmethod
    def _grounded_rows(
        payload: dict,
        rows: tuple[BulletProvenance, ...],
        prior_rows: tuple[BulletProvenance, ...] = (),
    ) -> tuple[tuple[BulletProvenance, ...], ClaimGrounding]:
        """Ground the payload's claim mappings against ``rows`` and enrich them.

        ``prior_rows`` carry the pre-voice text of the same bullets so a claim
        validated against the pre-voice wording stays grounded to the reworded
        shipped line (voice keeps bullet identity 1:1). Unparseable mappings
        ground nothing — rows then keep their keyword-served links only.
        """
        mappings, parse_errors = _claim_mappings_from_payload(payload)
        if parse_errors:
            mappings = ()
        grounding = ground_claim_mappings(
            mappings,
            tuple((row.bullet_id, row.generated_text) for row in rows),
            prior_lines=tuple((row.bullet_id, row.generated_text) for row in prior_rows),
        )
        return enrich_provenance_requirements(rows, grounding), grounding

    def _voice_and_audit(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        job: dict,
        tailored_payload: dict,
        employer_analysis: EmployerAnalysis,
        requirement_fit_report: "RequirementFitReport | None" = None,
    ) -> tuple[
        dict,
        tuple[BulletProvenance, ...],
        KeywordCoverage | None,
        VoicePassRecord,
        str | None,
        ClaimGrounding,
    ]:
        """Run the voice pass before the final audit (VOICE-01/02/03 + GROUND-06).

        Returns ``(final_payload, provenance_rows, coverage, voice_record,
        fabrication_error)``:

          * ``final_payload`` — the payload that actually ships: the voiced payload
            when the voice pass improved the deterministic proxies AND grounding
            re-validated against the voiced text, else the clean pre-voice candidate.
          * ``provenance_rows`` — provenance computed against ``final_payload`` (so
            ``generated_text`` is byte-identical to the rendered/PDF text), with any
            bullet the voice pass reworded re-marked ``transform_type == voice``.
          * ``coverage`` — honest generation-time keyword coverage over the grounded
            rows (GROUND-06 / success criterion 4), or ``None`` only when provenance
            could not be built.
          * ``voice_record`` — the inspectable audit of the voice pass (VOICE-02).
          * ``fabrication_error`` — set when the SHIPPED payload still fails the
            deterministic detector / FK gate (the pre-voice candidate itself was
            ungrounded), so ``execute`` hard-rejects it exactly as in Phase 2.

        The pre-voice candidate is always audited first; the voiced payload is only
        adopted when it both improves voice AND survives the SAME grounding gate, so
        a voice edit that injects an unsourced metric/title/date/employer (VOICE-03)
        or regresses voice never reaches the user.
        """
        base_rows, base_error, _base_findings = self._compute_provenance(
            profile_snapshot=profile_snapshot,
            job=job,
            tailored_payload=tailored_payload,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
        )
        corpus = build_evidence_corpus(profile_snapshot.as_dict())

        # No voice port, or the pre-voice candidate is already ungrounded: keep the
        # pre-voice payload (the fabrication gate will reject it upstream if needed).
        # Coverage is still computed canonically over whatever grounded rows exist.
        if self._voice is None or base_error is not None:
            base_rows, base_grounding = self._grounded_rows(tailored_payload, base_rows)
            coverage = self._coverage_for(base_rows, employer_analysis, base_error, corpus)
            record = (
                VoicePassRecord.skipped("no_voice_port")
                if self._voice is None
                else VoicePassRecord.skipped("pre_voice_candidate_rejected")
            )
            return tailored_payload, base_rows, coverage, record, base_error, base_grounding

        base_rows, base_grounding = self._grounded_rows(tailored_payload, base_rows)
        voiced_payload, voice_record = self._run_voice(
            tailored_payload=tailored_payload, base_rows=base_rows
        )
        if voiced_payload is None:
            # Voice did not run / errored / no-op — ship the pre-voice candidate.
            coverage = self._coverage_for(base_rows, employer_analysis, None, corpus)
            return tailored_payload, base_rows, coverage, voice_record, None, base_grounding

        voiced_rows, voiced_error, _voiced_findings = self._compute_provenance(
            profile_snapshot=profile_snapshot,
            job=job,
            tailored_payload=voiced_payload,
            employer_analysis=employer_analysis,
            requirement_fit_report=requirement_fit_report,
        )
        if voiced_error is not None:
            # VOICE-03: the voice pass introduced a fabrication / broke a binding.
            # Discard the voiced payload and ship the clean pre-voice candidate; the
            # failed voice stays as audit history (never destroys the good material).
            log.warning("Voice pass rejected for %s (re-validation failed): %s", job.get("url"), voiced_error)
            rejected = VoicePassRecord(
                ran=True,
                accepted=False,
                model=voice_record.model,
                proxy_delta=voice_record.proxy_delta,
                reason=f"voice_introduced_fabrication: {voiced_error}",
                summary_rejection_reason=voice_record.summary_rejection_reason,
            )
            coverage = self._coverage_for(base_rows, employer_analysis, None, corpus)
            return tailored_payload, base_rows, coverage, rejected, None, base_grounding

        # The voiced payload is grounded AND improved the proxies — adopt it. Mark
        # every reworded bullet ``transform_type == voice`` so the inspector shows
        # the shipped wording is the voiced wording (VOICE-02), then re-ground the
        # claims against the voiced lines (pre-voice text of the same bullets keeps
        # meaning-preserved claims bound) and compute coverage over the shipped rows.
        marked_rows = _mark_voiced_rows(base_rows, voiced_rows)
        marked_rows, final_grounding = self._grounded_rows(
            voiced_payload, marked_rows, prior_rows=base_rows
        )
        coverage = self._coverage_for(marked_rows, employer_analysis, None, corpus)
        return voiced_payload, marked_rows, coverage, voice_record, None, final_grounding

    def _run_voice(
        self,
        *,
        tailored_payload: dict,
        base_rows: tuple[BulletProvenance, ...],
    ) -> tuple[dict | None, VoicePassRecord]:
        """Call the voice SDK + gate the result on the deterministic proxies.

        Returns ``(voiced_payload, record)``. ``voiced_payload`` is ``None`` when
        the voice pass should be skipped (errored, returned nothing usable, or did
        not measurably improve the voice proxies) — in which case the caller keeps
        the pre-voice candidate. The record always captures what happened so the
        voice decision is inspectable, even on the fallback paths.
        """
        assert self._voice is not None
        request = build_voice_request(tailored_payload, banned_terms=tuple(BANNED_WORDS))
        try:
            result = self._run_voice_sdk(request)
        except Exception as exc:  # noqa: BLE001 — a voice failure must not sink the resume
            log.warning("Voice pass SDK failed: %s", exc)
            return None, VoicePassRecord(
                ran=True, accepted=False, model=self._voice.model_id, reason=f"voice_error: {exc}"
            )

        voiced_payload = apply_voice_to_payload(tailored_payload, result)
        # Sentence-identity gate audit: when the voiced summary broke identity the
        # last accepted summary shipped instead — record why, never drop silently.
        summary_rejection = summary_voice_rejection_reason(tailored_payload, result)
        if summary_rejection:
            log.warning(
                "Voice pass summary rejected (%s); keeping the pre-voice summary.",
                summary_rejection,
            )
        # Deterministic acceptance gate (VOICE-01): voice must MEASURABLY reduce
        # buzzword density OR raise structural variety over the bullets that ship.
        before_bullets = [row.generated_text for row in base_rows if row.section == "experience"]
        after_request = build_voice_request(voiced_payload)
        after_bullets = [
            bullet for _entry_id, bullets in after_request.experience_bullets for bullet in bullets
        ]
        delta = measure_voice_delta(before_bullets, after_bullets)
        record = VoicePassRecord(
            ran=True,
            accepted=delta.improved,
            model=self._voice.model_id,
            proxy_delta=delta.to_dict(),
            reason="" if delta.improved else "voice_did_not_improve_proxies",
            summary_rejection_reason=summary_rejection,
        )
        if not delta.improved:
            return None, record
        return voiced_payload, record

    def _run_voice_sdk(self, request: Any) -> VoiceResult:
        """Bridge the async ``VoicePort.rewrite`` to the synchronous tailor flow.

        The voice adapter is an agent-SDK call (async). The tailor path is
        synchronous (thread-pool), so this is a true top-level sync bridge via
        ``asyncio.run`` — there is NO wall-clock timeout on the voice call (the SDK
        runs to completion; only cooperative cancellation stops it).
        """
        import asyncio

        assert self._voice is not None
        system_prompt = _voice_system_prompt()
        return asyncio.run(self._voice.rewrite(system_prompt, request))

    def _coverage_for(
        self,
        rows: tuple[BulletProvenance, ...],
        employer_analysis: EmployerAnalysis,
        error: str | None,
        corpus: EvidenceCorpus,
    ) -> KeywordCoverage | None:
        """Compute generation-time coverage over the rows, or None when ungrounded.

        Coverage is meaningful only when there is grounded text to compute it
        against; a rejected candidate (``error`` set) has no shippable rows, so
        coverage is ``None`` rather than a misleading zero. ``corpus`` is the
        profile evidence corpus a keyword must trace to when its bullet carries no
        evidence FK, so a stuffed keyword is never credited off a requirement FK the
        provenance builder bound purely because the keyword appears in the line.
        """
        if error is not None or not rows:
            return None
        return compute_keyword_coverage(employer_analysis, rows, corpus)

    def _persist_provenance_set(
        self,
        *,
        materials: MaterialsSet,
        artifact_id: str,
        bullets: tuple[BulletProvenance, ...],
        coverage: KeywordCoverage | None = None,
        voice: VoicePassRecord | None = None,
    ) -> None:
        """Persist the accepted generation's provenance rows (write only).

        Generation-versioned and bound to the artifact it explains; the Phase-3
        generation-time coverage (GROUND-06) + voice audit (VOICE-02) ride on the
        same set. Called INSIDE the generation-flip unit of work, so a write
        failure is deliberately NOT swallowed — it propagates to roll the whole
        flip back (A9), keeping the audit invariant that every committed approved
        generation has its provenance. Requirement-fit coverage enrichment and
        the ``BulletProvenanceRecorded`` event fire from the caller only after
        the flip commits.
        """
        if self._provenance_repository is None:
            return
        provenance_set = BulletProvenanceSet(
            tenant_id=materials.tenant_id,
            job_id=materials.job_id,
            generation=materials.generation,
            artifact_id=artifact_id,
            bullets=tuple(bullets),
            coverage=coverage,
            voice=voice,
            created_at=materials.updated_at,
        )
        self._provenance_repository.save(provenance_set)

    def _record_requirement_artifact_coverage(
        self,
        *,
        materials: MaterialsSet,
        bullets: tuple[BulletProvenance, ...],
    ) -> None:
        """Map accepted artifact provenance back onto the latest requirement fit report."""
        if self._requirement_fit_repository is None:
            return
        try:
            report = self._requirement_fit_repository.load(
                materials.tenant_id,
                materials.job_id,
            )
            if report is None:
                return
            self._requirement_fit_repository.save(
                materials.tenant_id,
                _requirement_report_with_artifact_coverage(report, bullets),
            )
        except Exception:  # noqa: BLE001 -- audit update must not break accepted materials
            log.exception("Failed to update requirement artifact coverage for %s", materials.job_id)

    def _publish_provenance(
        self,
        materials: MaterialsSet,
        *,
        artifact_id: str,
        bullet_count: int,
    ) -> None:
        if self._publisher is None:
            return
        try:
            event = create_bullet_provenance_recorded(
                materials.tenant_id,
                BulletProvenanceRecordedPayload(
                    job_id=str(materials.job_id),
                    artifact_id=artifact_id,
                    generation=materials.generation,
                    bullet_count=bullet_count,
                    recorded_at=materials.updated_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — publishing must not break the use case
            log.exception("Failed to publish BulletProvenanceRecorded for %s", materials.job_id)


# ---------------------------------------------------------------------------
# SuppressTailoredArtifactsUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SuppressTailoredArtifactsOutcome:
    materials: MaterialsSet | None
    suppressed: bool


class SuppressTailoredArtifactsUseCase:
    """Soft-suppress latest active tailored artifacts for a job."""

    def __init__(self, *, repository: MaterialsRepository) -> None:
        self._repository = repository

    def execute(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        reason: str,
        suppressed_at: str | None = None,
    ) -> SuppressTailoredArtifactsOutcome:
        materials = self._repository.suppress_active_artifacts(
            tenant_id,
            job_id,
            reason=reason,
            suppressed_at=suppressed_at or _utc_now(),
        )
        return SuppressTailoredArtifactsOutcome(
            materials=materials,
            suppressed=materials is not None,
        )


# ---------------------------------------------------------------------------
# GenerateCoverLetterUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoverLetterOutcome:
    materials: MaterialsSet | None
    status: str
    text_path: str | None = None
    pdf_path: str | None = None
    error: str = ""


def _load_current_approved_materials(
    repository: MaterialsRepository,
    tenant_id: TenantId,
    job_id: JobId,
) -> MaterialsSet | None:
    loader = getattr(repository, "load_current_approved", None)
    if callable(loader):
        return loader(tenant_id, job_id)
    return repository.load(tenant_id, job_id)


def _resolve_effective_resume_template(
    repository: MaterialsRepository,
    tenant_id: TenantId,
    job_id: JobId,
) -> dict[str, Any] | None:
    resolver = getattr(repository, "resolve_effective_resume_template", None)
    if not callable(resolver):
        return None
    try:
        resolved = resolver(tenant_id, job_id)
    except Exception:  # noqa: BLE001 -- template metadata must not block tailoring
        log.exception("Failed to resolve effective resume template for %s", job_id)
        return None
    return resolved if isinstance(resolved, dict) else None


# The deterministic grounding controls the cover-letter body is checked against —
# recorded on the audit trail so an inspector sees which gates ran, not just their
# result. Mirrors the resume's never-fabricate controls (CONTROL-03).
_COVER_LETTER_GROUNDING_CONTROLS: tuple[str, ...] = (
    ControlRule.NEVER_FABRICATE_METRICS.value,
    ControlRule.NEVER_FABRICATE_DATES.value,
    ControlRule.NEVER_FABRICATE_TITLES.value,
    ControlRule.NEVER_FABRICATE_EMPLOYERS.value,
    ControlRule.NEVER_FABRICATE_SKILLS.value,
)


def _cover_letter_fabrication_audit(
    findings: list[FabricationFinding],
    *,
    target_skill_terms: list[str],
) -> dict[str, Any]:
    """The cover letter's truthfulness trail, persisted on its artifact metadata.

    Mirrors the resume's per-artifact audit signals: it records that the
    deterministic grounding gates ran over the shipped body, the job-target
    skill/tool keywords the skill gate was scoped to, and every fabrication finding
    (empty when grounded). A rejected letter's failure therefore survives as
    inspectable audit history rather than being silently dropped, and an accepted
    letter carries proof it was checked and grounded.
    """
    return {
        "checked": True,
        "grounded": not findings,
        "controls": list(_COVER_LETTER_GROUNDING_CONTROLS),
        "target_keyword_count": len(target_skill_terms),
        "findings": [
            {
                "bullet_id": finding.bullet_id,
                "kind": finding.kind,
                "token": finding.token,
                "control": finding.control.value,
            }
            for finding in findings
        ],
    }


class GenerateCoverLetterUseCase:
    """Generate a cover letter for an approved resume's MaterialsSet.

    Loads the latest aggregate, requires the tailored resume to be
    approved (per §4.5), generates the cover letter (with retries),
    runs the same deterministic grounding gates the resume uses over the
    generated body, and persists the result back through the repository.

    The cover letter ships to the employer as a first-person claims document, so
    it carries the SAME truthfulness gate as the resume (CONTROL-03): the
    never-fabricate detector plus the prose skill/tool gate run over the shipped
    body before acceptance. A detected fabrication downgrades the letter to
    REJECTED (never shipped as approved) and is persisted as inspectable audit
    history. ``analysis_repository`` supplies the canonical job-target skill/tool
    keywords the skill gate is scoped to (the same persisted employer analysis the
    tailor step produced); without it the never-fabricate detector still runs, but
    the skill/tool gate has no target vocabulary and is a no-op.
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        llm: LlmPort,
        validator: ContentValidator,
        publisher: EventPublisher | None = None,
        analysis_repository: EmployerAnalysisRepository | None = None,
        max_retries: int = 3,
        unit_of_work: UnitOfWork | None = None,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._validator = validator
        self._publisher = publisher
        self._analysis_repository = analysis_repository
        self._max_retries = max_retries
        self._unit_of_work = unit_of_work

    def execute(
        self,
        *,
        job: dict,
        job_id: JobId,
        profile_snapshot: ProfileSnapshot,
        cover_letter_dir: Path,
        validation_mode: str = "normal",
        tenant_id: TenantId = LOCAL_TENANT,
        commit_guard: Callable[[], None] | None = None,
    ) -> CoverLetterOutcome:
        if commit_guard is not None:
            commit_guard()
        stable_job_id = canonical_job_id(str(job_id))
        materials = _load_current_approved_materials(self._repository, tenant_id, stable_job_id)
        if materials is None:
            return CoverLetterOutcome(
                materials=None,
                status="error",
                error="No MaterialsSet exists for this job — tailor first",
            )
        if not materials.is_resume_approved:
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error="Cover letter requires an approved tailored resume",
            )
        if materials.resume_pdf is None or materials.resume_pdf.status is not ArtifactStatus.APPROVED:
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error="Cover letter requires an approved tailored resume PDF",
            )

        # Read the resume text (the cover-letter prompt benefits from
        # seeing the tailored content). The §4.5 invariant guarantees
        # ``tailored_resume`` is not None at this point.
        assert materials.tailored_resume is not None
        resume_path = Path(materials.tailored_resume.path)
        if not resume_path.exists():
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error=f"Tailored resume missing on disk: {resume_path}",
            )
        try:
            resume_text = resume_path.read_text(encoding="utf-8")
        except OSError as exc:
            return CoverLetterOutcome(
                materials=materials,
                status="error",
                error=f"Could not read tailored resume {resume_path}: {exc}",
            )

        target_skill_terms = self._load_target_skill_terms(tenant_id, stable_job_id)
        letter, validation, findings = self._run_attempts(
            job=job,
            resume_text=resume_text,
            profile_snapshot=profile_snapshot,
            validation_mode=validation_mode,
            target_skill_terms=target_skill_terms,
            execution_guard=commit_guard,
        )
        if commit_guard is not None:
            commit_guard()

        generated_at = _utc_now()
        prefix = _safe_filename_prefix(job)
        cover_letter_dir.mkdir(parents=True, exist_ok=True)
        artifact_id = uuid.uuid4().hex
        path_role = "CL" if validation.passed else "CL_rejected"
        cl_path = cover_letter_dir / f"{prefix}_{path_role}_{artifact_id}.txt"
        cl_path.write_text(letter, encoding="utf-8")

        try:
            size_bytes = cl_path.stat().st_size
        except OSError:
            size_bytes = None

        artifact = Artifact.create(
            type=ArtifactType.COVER_LETTER,
            path=str(cl_path),
            created_at=generated_at,
            render_format=RenderFormat.TEXT,
            size_bytes=size_bytes,
            metadata={
                "validation_mode": validation_mode,
                "passed": validation.passed,
                "fabrication_audit": _cover_letter_fabrication_audit(
                    findings, target_skill_terms=target_skill_terms
                ),
            },
            artifact_id=artifact_id,
        )
        if validation.passed:
            materials = materials.with_cover_letter(
                artifact,
                validation=validation,
                updated_at=generated_at,
            )
        else:
            rejected_artifact = artifact.with_status(ArtifactStatus.REJECTED)
            attempt_history = list(materials.metadata.get("cover_letter_attempts") or ())
            attempt_history.append(
                {
                    "artifact": rejected_artifact.to_dict(),
                    "validation": validation.to_dict(),
                    "recorded_at": generated_at,
                }
            )
            if (
                materials.cover_letter is not None
                and materials.cover_letter.status is ArtifactStatus.APPROVED
            ):
                materials = materials.with_metadata(
                    {
                        **dict(materials.metadata),
                        "cover_letter_attempts": attempt_history,
                    },
                    updated_at=generated_at,
                )
            else:
                materials = materials.with_cover_letter(
                    artifact,
                    validation=validation,
                    updated_at=generated_at,
                ).with_metadata(
                    {
                        **dict(materials.metadata),
                        "cover_letter_attempts": attempt_history,
                    }
                )
        with self._unit_of_work if self._unit_of_work is not None else nullcontext():
            if commit_guard is not None:
                commit_guard()
            self._repository.save(materials)

        if validation.passed:
            self._publish_generated(materials)
            return CoverLetterOutcome(
                materials=materials, status="ok", text_path=str(cl_path)
            )
        return CoverLetterOutcome(
            materials=materials,
            status="failed_validation",
            text_path=str(cl_path),
            error="; ".join(validation.errors),
        )

    def _load_target_skill_terms(self, tenant_id: TenantId, job_id: JobId) -> list[str]:
        """The canonical job-target skill/tool keywords the skill gate is scoped to.

        Reuses the persisted employer analysis the tailor step already produced
        (no re-reasoning, no LLM call) as the single source of truth for target
        keywords — the same source :class:`TailorResumeUseCase` uses (D-21). Absent
        an analysis repository or a persisted record the list is empty: the
        never-fabricate detector still runs, the skill/tool gate simply has no
        target vocabulary.
        """
        if self._analysis_repository is None:
            return []
        analysis = self._analysis_repository.load(tenant_id, job_id)
        if analysis is None:
            return []
        return [
            keyword.keyword
            for keyword in analysis.canonical.keywords
            if keyword.keyword.strip()
        ]

    def _run_attempts(
        self,
        *,
        job: dict,
        resume_text: str,
        profile_snapshot: ProfileSnapshot,
        validation_mode: str,
        target_skill_terms: list[str],
        execution_guard: Callable[[], None] | None = None,
    ) -> tuple[str, ValidationResult, list[FabricationFinding]]:
        cl_prompt_base = build_cover_letter_prompt(profile_snapshot)
        # The deterministic grounding context is fixed across attempts — build it
        # once from canonical profile data (never the job description, so a number
        # lifted from the posting stays ungrounded).
        profile = profile_snapshot.as_dict()
        corpus = build_evidence_corpus(profile)
        employers = employer_name_set(profile)
        allowed_skill_terms = build_skill_vocabulary(profile)
        target_company = _job_company(job)
        job_title = str(job.get("title") or "")

        retry_reasons: list[str] = []
        letter = ""
        findings: list[FabricationFinding] = []
        last_validation: ValidationResult = ValidationResult.failure(("no attempt yet",))
        for attempt in range(self._max_retries + 1):
            if execution_guard is not None:
                execution_guard()
            prompt = _retry_system_prompt(cl_prompt_base, retry_reasons)
            messages = [
                LlmMessage(role="system", content=prompt),
                LlmMessage(
                    role="user",
                    content=(
                        f"RESUME:\n{resume_text}\n\n---\n\n"
                        f"TARGET JOB:\n{_build_job_blob(job)}\n\n"
                        "Write the cover letter:"
                    ),
                ),
            ]
            raw = self._llm.chat(
                messages,
                max_tokens=8192,
                temperature=0.4,
            )
            letter = sanitize_text(raw)
            letter = _strip_preamble(letter)
            letter, has_completion_marker = _strip_cover_letter_completion_marker(letter)

            validation = self._validator.validate_cover_letter(letter, mode=validation_mode)
            findings = scan_cover_letter(
                letter,
                corpus,
                employers=employers,
                target_company=target_company,
                job_title=job_title,
                target_skill_terms=target_skill_terms,
                allowed_skill_terms=allowed_skill_terms,
            )
            errors = list(validation.errors)
            if not has_completion_marker:
                errors.append(f"Missing {COVER_LETTER_COMPLETION_MARKER} completion marker.")
            # Deterministic grounding gate: a fabricated metric/date/title/employer
            # or an unbacked job-target tool downgrades the letter to REJECTED, never
            # shipped as approved (CONTROL-03) — the findings guide the retry.
            errors.extend(finding.describe() for finding in findings)
            if errors:
                validation = ValidationResult.failure(tuple(errors), warnings=validation.warnings)
            last_validation = validation
            if validation.passed:
                return letter, validation, findings
            if any(finding.kind in {"numeric", "date"} for finding in findings):
                retry_reasons.append("cover_letter_numeric_grounding_failed")
            if any(finding.kind == "skill" for finding in findings):
                retry_reasons.append("cover_letter_skill_grounding_failed")
            if any(finding.kind == "title" for finding in findings):
                retry_reasons.append("cover_letter_title_grounding_failed")
            if any(
                finding.kind not in {"numeric", "date", "skill"}
                for finding in findings
            ):
                retry_reasons.append("fabrication_detected")
            retry_reasons.append("cover_letter_validation_failed")
            log.debug(
                "Cover letter attempt %d/%d failed: %s",
                attempt + 1, self._max_retries + 1, validation.errors,
            )

        return letter, last_validation, findings

    def _publish_generated(self, materials: MaterialsSet) -> None:
        if self._publisher is None or materials.cover_letter is None:
            return
        try:
            event = create_cover_letter_generated(
                materials.tenant_id,
                CoverLetterGeneratedPayload(
                    job_id=str(materials.job_id),
                    artifact_id=materials.cover_letter.artifact_id,
                    generated_at=materials.updated_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception(
                "Failed to publish CoverLetterGenerated for %s", materials.job_id
            )


# ---------------------------------------------------------------------------
# RenderPdfUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderPdfOutcome:
    materials: MaterialsSet | None
    rendered: tuple[ArtifactType, ...]
    status: str
    error: str = ""


class RenderPdfUseCase:
    """Render the missing PDF artifacts for a MaterialsSet.

    Two PDFs are eligible:

      * resume PDF — rendered from the tailored payload via the configured
        resume renderer when the tailored resume is approved.
      * cover-letter PDF — rendered from the cover-letter text via
        :class:`PlaywrightHtmlPdfAdapter` when the cover letter is
        approved.

    The use case skips any PDF that is already present, so re-runs are
    safe (each pass adds the missing PDFs without re-rendering).
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        resume_renderer: PdfRendererPort,
        cover_letter_renderer: PdfRendererPort,
        publisher: EventPublisher | None = None,
    ) -> None:
        self._repository = repository
        self._resume_renderer = resume_renderer
        self._cover_letter_renderer = cover_letter_renderer
        self._publisher = publisher

    def execute(
        self,
        *,
        job_id: JobId,
        tailored_payload: dict | None = None,
        profile_dict: dict | None = None,
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> RenderPdfOutcome:
        materials = _load_current_approved_materials(self._repository, tenant_id, job_id)
        if materials is None:
            return RenderPdfOutcome(
                materials=None,
                rendered=(),
                status="error",
                error=f"No MaterialsSet for {job_id}",
            )

        rendered: list[ArtifactType] = []
        # Render resume PDF if missing and we have a payload to compile.
        if (
            materials.tailored_resume is not None
            and materials.tailored_resume.status is ArtifactStatus.APPROVED
            and (
                materials.resume_pdf is None
                or materials.resume_pdf.status is not ArtifactStatus.APPROVED
            )
            and tailored_payload is not None
            and profile_dict is not None
        ):
            text_path = Path(materials.tailored_resume.path)
            pdf_path = text_path.with_suffix(".pdf")
            resume_template = _resolve_effective_resume_template(
                self._repository,
                tenant_id,
                job_id,
            )
            try:
                pdf_artifact = self._resume_renderer.render_resume_to_pdf(
                    tailored_payload=tailored_payload,
                    profile_dict=profile_dict,
                    output_path=str(pdf_path),
                    created_at=_utc_now(),
                    resume_theme=resume_template.get("theme") if resume_template else None,
                    resume_template=resume_template.get("metadata") if resume_template else None,
                )
                materials = materials.with_resume_pdf(pdf_artifact, updated_at=_utc_now())
                rendered.append(ArtifactType.RESUME_PDF)
            except Exception as exc:  # noqa: BLE001
                log.error("Resume PDF render failed for %s: %s", job_id, exc)

        # Render cover-letter PDF if missing.
        if (
            materials.cover_letter is not None
            and materials.cover_letter.status is ArtifactStatus.APPROVED
            and (
                materials.cover_letter_pdf is None
                or materials.cover_letter_pdf.status is not ArtifactStatus.APPROVED
            )
        ):
            text_path = Path(materials.cover_letter.path)
            pdf_path = text_path.with_suffix(".pdf")
            try:
                cover_text = text_path.read_text(encoding="utf-8")
                pdf_artifact = self._cover_letter_renderer.render_cover_letter_to_pdf(
                    cover_letter_text=cover_text,
                    output_path=str(pdf_path),
                    created_at=_utc_now(),
                )
                materials = materials.with_cover_letter_pdf(pdf_artifact, updated_at=_utc_now())
                rendered.append(ArtifactType.COVER_LETTER_PDF)
            except Exception as exc:  # noqa: BLE001
                log.error("Cover letter PDF render failed for %s: %s", job_id, exc)

        if rendered:
            self._repository.save(materials)
            for artifact_type in rendered:
                self._publish_rendered(materials, artifact_type)
            return RenderPdfOutcome(
                materials=materials, rendered=tuple(rendered), status="ok"
            )

        return RenderPdfOutcome(
            materials=materials,
            rendered=(),
            status="noop",
        )

    def _publish_rendered(
        self, materials: MaterialsSet, artifact_type: ArtifactType
    ) -> None:
        if self._publisher is None:
            return
        artifact = materials.artifact_for(artifact_type)
        if artifact is None:
            return
        try:
            event = create_pdf_rendered(
                materials.tenant_id,
                PdfRenderedPayload(
                    job_id=str(materials.job_id),
                    artifact_type=artifact_type.value,
                    artifact_id=artifact.artifact_id,
                    rendered_at=artifact.created_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception(
                "Failed to publish PdfRendered for %s/%s", materials.job_id, artifact_type.value
            )


# ---------------------------------------------------------------------------
# Re-exports
# ---------------------------------------------------------------------------


__all__ = [
    "CoverLetterOutcome",
    "GenerateCoverLetterUseCase",
    "MaterialsLifecycle",
    "RenderPdfOutcome",
    "RenderPdfUseCase",
    "SuppressTailoredArtifactsOutcome",
    "SuppressTailoredArtifactsUseCase",
    "TailorOutcome",
    "TailoringPrerequisiteError",
    "TailorResumeUseCase",
    "build_cover_letter_prompt",
    "build_judge_prompt",
    "build_master_tailor_prompt",
]
