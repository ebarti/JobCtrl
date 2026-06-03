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
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from typing import Any

from jobhunter.domain.events import (
    CoverLetterGeneratedPayload,
    PdfRenderedPayload,
    ResumeApprovedPayload,
    ResumeFailedPayload,
    create_cover_letter_generated,
    create_pdf_rendered,
    create_resume_approved,
    create_resume_failed,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.aggregate import (
    MaterialsLifecycle,
    MaterialsSet,
    MaterialsSetFactory,
)
from jobhunter.domain.materials.adversarial import (
    ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
    ADVERSARIAL_REVIEW_THRESHOLD,
    AdversarialReviewResult,
    build_adversarial_review_prompt,
    normalized_job_fit_score,
    should_run_adversarial_review,
)
from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.policy import TailoringPolicy
from jobhunter.domain.materials.quality import (
    TailoringPlan,
    build_tailoring_plan,
    evaluate_tailoring_quality,
)
from jobhunter.domain.materials.services import (
    BANNED_WORDS,
    ContentValidator,
    LLM_LEAK_PHRASES,
    ResumeAssembler,
    normalize_profile_list,
    sanitize_text,
)
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    LlmModelSpec,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.domain.ports.materials import (
    MaterialsRepository,
    PdfRendererPort,
    TailoringPolicyRepository,
)
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.resume_profile import (
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

TAILORING_PROMPT_VERSION = "tailor.v2.quality-gated"
TAILORING_SCHEMA_VERSION = "tailored-resume.v1"
TAILORING_JUDGE_SCHEMA_VERSION = "tailor-judge.v1"
TAILORING_JUDGE_CRITERIA: tuple[str, ...] = (
    "relevance_to_job",
    "evidence_support",
    "fabrication_safety",
    "required_content_preserved",
    "ats_readability",
    "specificity_and_metrics",
)


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
    "required": ["executive_profile", "experience_updates", "skill_category_updates"],
    "properties": {
        "executive_profile": {"type": "string"},
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
        return cls(
            candidate_models=_split_model_specs(
                os.environ.get("TAILORING_GENERATOR_MODELS")
                or os.environ.get("TAILORING_GENERATOR_MODEL")
            ),
            judge_model=os.environ.get("TAILORING_JUDGE_MODEL"),
            judge_min_score=float(os.environ.get("TAILORING_JUDGE_MIN_SCORE", "0.82")),
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


def _safe_candidate_summary(record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("parsed_json") if isinstance(record.get("parsed_json"), dict) else {}
    return {
        "candidate_id": record.get("candidate_id"),
        "generator": record.get("model"),
        "status": record.get("status"),
        "schema_version": record.get("schema_version"),
        "validation": record.get("validator"),
        "judge": record.get("judge"),
        "parse_error": record.get("parse_error"),
        "summary": _candidate_payload_summary(payload),
    }


# ---------------------------------------------------------------------------
# Prompt builders (snapshot-driven)
# ---------------------------------------------------------------------------


def build_master_tailor_prompt(
    snapshot: ProfileSnapshot,
    *,
    tailoring_plan: TailoringPlan | None = None,
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
        f"- Tailoring mode: {tailoring_policy['mode']}",
        f"- Rewrite executive profile: {'yes' if tailoring_policy['allow_summary_rewrite'] else 'no, preserve the baseline summary'}",
        f"- Reframe experience titles: {'yes' if tailoring_policy['allow_title_reframing'] else 'no, titles are fixed by the master resume'}",
        f"- Rewrite achievement bullets: {'yes' if tailoring_policy['allow_achievement_rewriting'] else 'no, preserve the original bullets'}",
        f"- Reorder or trim skills: {'yes' if tailoring_policy['allow_skill_reordering'] else 'no, preserve original skill order and wording'}",
        f"- Minor inferred phrasing: {'allowed' if tailoring_policy['allow_minor_inference'] else 'not allowed'}",
    ]
    style_lines = [
        f"- Tone: {writing_style['tone']}",
        f"- Bullet style: {writing_style['bullet_style']}",
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

    return f"""You are tailoring a resume that is backed by a canonical LaTeX master file.

You are ONLY allowed to rewrite the mutable content:
- the executive profile, if policy allows it
- the bullets for each existing experience entry, if policy allows it
- the title field for each existing experience entry, only if policy allows it
- the ordering/content of items inside each existing skill category, if policy allows it

The code will inject all fixed structure from the master resume:
- experience metadata (date_range, title, company, location)
- all education entries
- section order

HARD RULES:
- Return EVERY required experience entry id exactly once
- Return a title field for EVERY experience update; set it to "" unless policy allows and needs a rewritten title
- Return EVERY required skill category id exactly once
- Preserve every required bullet listed below in the matching experience entry
- Do NOT add or remove experience entries
- Do NOT add or remove education entries
- Do NOT add or remove skill categories
- Do NOT change real numbers ({metrics_str})
- Do NOT invent companies, roles, degrees, or certifications
- Max {max_bullets} bullets per experience entry
- No em dashes
- BANNED WORDS: {banned_str}

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
  "experience_updates": [
    {{"id": "{required_experience_ids[0] if required_experience_ids else 'experience_entry_id'}", "title": "", "bullets": ["bullet 1", "bullet 2"]}}
  ],
  "skill_category_updates": [
    {{"id": "{required_skill_ids[0] if required_skill_ids else 'skill_category_id'}", "items": ["item 1", "item 2"]}}
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

    return f"""You are the final resume quality judge for JobHunter.

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
- specificity_and_metrics"""


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

PARAGRAPH 1 (2-3 sentences): Open with a specific thing YOU built that solves THEIR problem. Not "I'm excited about this role." Not "This role aligns with my experience." Start with the work.

PARAGRAPH 2 (3-4 sentences): Pick 2 achievements from the resume that are MOST relevant to THIS job. Use numbers. Frame as solving their problem, not listing your accomplishments.{projects_hint}{metrics_hint}

PARAGRAPH 3 (1-2 sentences): One specific thing about the company from the job description (a product, a technical challenge, a team structure). Then close. "Happy to walk through any of this in more detail." or "Let's discuss." Nothing else.

BANNED WORDS AND PHRASES (automated validator rejects ANY of these — do not use even once):
{all_banned}

ALSO BANNED (meta-commentary the validator catches):
{leak_banned}

BANNED PUNCTUATION: No em dashes (—) or en dashes (–). Use commas or periods.

VOICE:
- Write like a real engineer emailing someone they respect. Not formal, not casual. Just direct.
- NEVER narrate or explain what you're doing. BAD: "This demonstrates my commitment to X." GOOD: Just state the fact and move on.
- NEVER hedge. BAD: "might address some of your challenges." GOOD: "solves the same problem your team is facing."
- Every sentence should contain either a number, a tool name, or a specific outcome. If it doesn't, cut it.
- Read it out loud. If it sounds like a robot wrote it, rewrite it.

FABRICATION = INSTANT REJECTION:
The candidate's real tools are ONLY: {skills_str}.
Do NOT mention ANY tool not in this list. If the job asks for tools not listed, talk about the work you did, not the tools.

Sign off: just "{sign_off_name}"

Output ONLY the letter text. No subject lines. No "Here is the cover letter:" preamble. No notes after the sign-off.
Start DIRECTLY with "Dear Hiring Manager," and end with the name."""


# ---------------------------------------------------------------------------
# TailorResumeUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TailorOutcome:
    """Result of a single :meth:`TailorResumeUseCase.execute` call.

    ``status`` mirrors the legacy report.status vocabulary so callers
    that rely on it for telemetry don't need to be touched:

      * ``approved``                    — validator + judge passed.
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
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._validator = validator
        self._assembler = assembler
        self._publisher = publisher
        self._max_retries = max_retries
        self._llm_policy = llm_policy or TailoringLlmPolicy.from_env()
        self._policy_repository = policy_repository

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        tailored_dir: Path,
        validation_mode: str = "normal",
        tenant_id: TenantId = LOCAL_TENANT,
        retailor: bool = False,
        suppress_existing_artifacts: bool = False,
    ) -> TailorOutcome:
        job_id = JobId(str(job["url"]))
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

        # Persist the predecessor first so existing artifacts stop being
        # active before the new generation is written.
        if prior_generation is not None:
            self._repository.save(prior_generation)

        report, parsed_payload, validation, verdict = self._run_attempts(
            job=job,
            profile_snapshot=profile_snapshot,
            validation_mode=validation_mode,
        )
        attempts = report["attempts"]

        if not parsed_payload:
            # Nothing to persist beyond the empty aggregate; surface the
            # failure to the caller and emit ``ResumeFailed`` so downstream
            # observers see the attempt counter advance.
            self._repository.save(materials)
            self._publish_failed(materials, validation_errors=("exhausted_retries",), attempt=attempts)
            return TailorOutcome(
                materials=materials,
                status="exhausted_retries",
                attempts=attempts,
                report=report,
                error="No parseable JSON in any attempt",
            )

        # Assemble the rendered resume text from the last successful payload.
        tailored_text = self._assembler.assemble_resume_text(parsed_payload, profile_snapshot)
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
        tailoring_policy = self._resolve_tailoring_policy(
            profile_snapshot=profile_snapshot,
            report=report,
            validation_mode=validation_mode,
            tenant_id=tenant_id,
        )
        policy_metadata = tailoring_policy.as_artifact_metadata()
        tailoring_metadata = {
            "validation_mode": validation_mode,
            "attempts": attempts,
            "tailoring_policy_id": tailoring_policy.policy_id,
            "tailoring_policy_version": tailoring_policy.version,
            "tailoring_policy": policy_metadata,
            "prompt_version": report.get("prompt_version"),
            "schema_version": report.get("schema_version"),
            "candidate_models": report.get("candidate_models") or [],
            "selected_model": report.get("selected_model"),
            "selected_candidate": report.get("selected_candidate"),
            "judge_model": report.get("judge_model"),
            "judge_min_score": report.get("judge_min_score"),
            "quality_plan": report.get("quality_plan") or {},
            "quality_checks": report.get("quality_checks") or {},
            "adversarial_review": report.get("adversarial_review") or {},
            "candidate_summaries": report.get("candidate_summaries") or [],
            "judge": judge_record,
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
        materials = materials.with_resume_attempt(
            artifact,
            validation=validation,
            verdict=verdict,
            updated_at=_utc_now(),
        )
        materials = materials.with_metadata(
            {
                **dict(materials.metadata),
                "tailoring_policy_id": tailoring_policy.policy_id,
                "tailoring_policy_version": tailoring_policy.version,
                "tailoring_policy": policy_metadata,
            },
            updated_at=materials.updated_at,
        )
        self._repository.save(materials)

        status = self._derive_status(report, validation, verdict)
        if materials.is_resume_approved:
            self._publish_approved(materials)
        else:
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
            report=report,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_attempts(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        validation_mode: str,
    ) -> tuple[dict, dict | None, ValidationResult, JudgeVerdict | None]:
        """Run the LLM ⇒ validate ⇒ judge attempt loop.

        Returns the legacy-shaped ``report`` dict + the last successful
        payload (or ``None`` if every attempt failed to parse) + the last
        :class:`ValidationResult` and :class:`JudgeVerdict`.
        """
        tailoring_plan = build_tailoring_plan(profile_snapshot.as_dict(), job)
        tailor_prompt_base = build_master_tailor_prompt(
            profile_snapshot,
            tailoring_plan=tailoring_plan,
        )
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
            "adversarial_review": None,
            "attempt_history": [],
            "candidate_summaries": [],
        }
        avoid_notes: list[str] = []
        last_payload: dict | None = None
        last_validation: ValidationResult = ValidationResult.failure(("no attempt yet",))
        last_verdict: JudgeVerdict | None = None
        best_rejected: _TailorCandidate | None = None

        for attempt in range(self._max_retries + 1):
            report["attempts"] = attempt + 1

            prompt = tailor_prompt_base
            if avoid_notes:
                prompt += "\n\n## AVOID THESE ISSUES (from previous attempt):\n" + "\n".join(
                    f"- {n}" for n in avoid_notes[-5:]
                )
            attempt_record: dict[str, Any] = {
                "attempt": attempt + 1,
                "avoid_notes": list(avoid_notes[-5:]),
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
                candidate = self._run_candidate(
                    messages=messages,
                    model=model,
                    profile_snapshot=profile_snapshot,
                    tailoring_plan=tailoring_plan,
                    validation_mode=validation_mode,
                    job=job,
                )
                attempt_record["candidates"].append(candidate.record)
                report["candidate_summaries"].append(_safe_candidate_summary(candidate.record))
                last_payload = candidate.payload or last_payload
                last_validation = candidate.validation
                last_verdict = candidate.verdict

                if candidate.validation.passed and (
                    candidate.verdict is None or candidate.verdict.approved
                ):
                    approved_candidates.append(candidate)
                elif candidate.validation.passed and candidate.verdict is not None:
                    if best_rejected is None or candidate.judge_score > best_rejected.judge_score:
                        best_rejected = candidate

            if approved_candidates:
                selected = max(approved_candidates, key=lambda item: item.judge_score)
                report["status"] = "approved"
                report["validator"] = selected.validation.to_dict()
                report["judge"] = selected.record.get("judge")
                report["quality_checks"] = selected.record.get("quality_checks")
                report["adversarial_review"] = selected.record.get("adversarial_review")
                report["selected_candidate"] = selected.record.get("candidate_id")
                report["selected_model"] = selected.model
                attempt_record["status"] = "approved"
                attempt_record["selected_candidate"] = selected.record.get("candidate_id")
                report["attempt_history"].append(attempt_record)
                return report, selected.payload, selected.validation, selected.verdict

            for candidate_record in attempt_record["candidates"]:
                status = str(candidate_record.get("status", ""))
                if status == "parse_error":
                    avoid_notes.append("Output was not valid JSON. Return ONLY a JSON object.")
                elif status == "failed_validation":
                    validator = candidate_record.get("validator") or {}
                    avoid_notes.extend(str(error) for error in validator.get("errors", []))
                elif status == "judge_rejected":
                    judge = candidate_record.get("judge") or {}
                    avoid_notes.append(f"Judge rejected: {judge.get('issues') or 'quality gate failed'}")
                elif status == "adversarial_rejected":
                    review = candidate_record.get("adversarial_review") or {}
                    blockers = review.get("blockers") or []
                    repairs = review.get("repair_instructions") or []
                    avoid_notes.extend(str(item) for item in [*blockers, *repairs] if str(item))

            attempt_record["status"] = "failed_quality_gate"
            report["attempt_history"].append(attempt_record)

        report["status"] = "exhausted_retries"
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
            return report, best_rejected.payload, best_rejected.validation, best_rejected.verdict
        if last_payload is not None and not last_validation.passed:
            report["status"] = "failed_validation"
        return report, last_payload, last_validation, last_verdict

    def _resolve_tailoring_policy(
        self,
        *,
        profile_snapshot: ProfileSnapshot,
        report: dict,
        validation_mode: str,
        tenant_id: TenantId,
    ) -> TailoringPolicy:
        profile = profile_snapshot.as_dict()
        candidate = TailoringPolicy.from_runtime(
            tenant_id=tenant_id,
            version=1,
            prompt_version=TAILORING_PROMPT_VERSION,
            schema_version=TAILORING_SCHEMA_VERSION,
            judge_schema_version=TAILORING_JUDGE_SCHEMA_VERSION,
            prompt_text=str(report.get("system_prompt") or ""),
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
            runtime_settings={"validation_mode": validation_mode},
            created_at=_utc_now(),
        )
        if self._policy_repository is None:
            return candidate
        return self._policy_repository.resolve_current(candidate)

    def _run_candidate(
        self,
        *,
        messages: list[LlmMessage],
        model: str,
        profile_snapshot: ProfileSnapshot,
        tailoring_plan: TailoringPlan,
        validation_mode: str,
        job: dict,
    ) -> _TailorCandidate:
        candidate_id = f"candidate-{abs(hash((model, len(messages), messages[-1].content[:80]))) % 10_000_000}"
        record: dict[str, Any] = {
            "candidate_id": candidate_id,
            "model": model,
            "schema_version": TAILORING_SCHEMA_VERSION,
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
            if quality_result.errors:
                validation = ValidationResult.failure(
                    tuple(validation.errors) + tuple(quality_result.errors),
                    warnings=tuple(validation.warnings) + tuple(quality_result.warnings),
                )
            elif quality_result.warnings:
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
        try:
            response = self._chat_json_payload(
                messages,
                schema=ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
                model=self._llm_policy.effective_judge_model,
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
            )
        return AdversarialReviewResult.from_response(
            response,
            threshold=ADVERSARIAL_REVIEW_THRESHOLD,
            normalized_fit_score=normalized_fit,
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
        if status == "approved":
            return status
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


class GenerateCoverLetterUseCase:
    """Generate a cover letter for an approved resume's MaterialsSet.

    Loads the latest aggregate, requires the tailored resume to be
    approved (per §4.5), generates the cover letter (with retries),
    validates it, and persists the result back through the repository.
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        llm: LlmPort,
        validator: ContentValidator,
        publisher: EventPublisher | None = None,
        max_retries: int = 3,
    ) -> None:
        self._repository = repository
        self._llm = llm
        self._validator = validator
        self._publisher = publisher
        self._max_retries = max_retries

    def execute(
        self,
        *,
        job: dict,
        profile_snapshot: ProfileSnapshot,
        cover_letter_dir: Path,
        validation_mode: str = "normal",
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> CoverLetterOutcome:
        job_id = JobId(str(job["url"]))
        materials = self._repository.load(tenant_id, job_id)
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

        letter, validation = self._run_attempts(
            job=job,
            resume_text=resume_text,
            profile_snapshot=profile_snapshot,
            validation_mode=validation_mode,
        )

        prefix = _safe_filename_prefix(job)
        cover_letter_dir.mkdir(parents=True, exist_ok=True)
        cl_path = cover_letter_dir / f"{prefix}_CL.txt"
        cl_path.write_text(letter, encoding="utf-8")

        try:
            size_bytes = cl_path.stat().st_size
        except OSError:
            size_bytes = None

        artifact = Artifact.create(
            type=ArtifactType.COVER_LETTER,
            path=str(cl_path),
            created_at=_utc_now(),
            render_format=RenderFormat.TEXT,
            size_bytes=size_bytes,
            metadata={
                "validation_mode": validation_mode,
                "passed": validation.passed,
            },
        )
        materials = materials.with_cover_letter(
            artifact, validation=validation, updated_at=_utc_now()
        )
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

    def _run_attempts(
        self,
        *,
        job: dict,
        resume_text: str,
        profile_snapshot: ProfileSnapshot,
        validation_mode: str,
    ) -> tuple[str, ValidationResult]:
        cl_prompt_base = build_cover_letter_prompt(profile_snapshot)
        avoid_notes: list[str] = []
        letter = ""
        last_validation: ValidationResult = ValidationResult.failure(("no attempt yet",))
        for attempt in range(self._max_retries + 1):
            prompt = cl_prompt_base
            if avoid_notes:
                prompt += "\n\n## AVOID THESE ISSUES:\n" + "\n".join(
                    f"- {n}" for n in avoid_notes[-5:]
                )
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
            raw = self._llm.chat(messages, max_tokens=1024, temperature=0.7)
            letter = sanitize_text(raw)
            letter = _strip_preamble(letter)

            validation = self._validator.validate_cover_letter(letter, mode=validation_mode)
            last_validation = validation
            if validation.passed:
                return letter, validation
            avoid_notes.extend(validation.errors)
            log.debug(
                "Cover letter attempt %d/%d failed: %s",
                attempt + 1, self._max_retries + 1, validation.errors,
            )

        return letter, last_validation

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

      * resume PDF — rendered from the tailored payload via
        :class:`LatexPdfAdapter` when the tailored resume is approved.
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
        materials = self._repository.load(tenant_id, job_id)
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
            try:
                pdf_artifact = self._resume_renderer.render_resume_to_pdf(
                    tailored_payload=tailored_payload,
                    profile_dict=profile_dict,
                    output_path=str(pdf_path),
                    created_at=_utc_now(),
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
    "TailorResumeUseCase",
    "build_cover_letter_prompt",
    "build_judge_prompt",
    "build_master_tailor_prompt",
]
