"""Deterministic resume tailoring plan and quality checks.

The Materials use case owns I/O and LLM calls. This module stays pure: profile
dict + job dict + generated payload/text in, value objects out.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from jobhunter.domain.materials.analysis import EmployerAnalysis
from jobhunter.domain.materials.value_objects import ValidationResult
from jobhunter.resume_profile import (
    get_achievement_evidence,
    get_claim_mode,
    get_experience_entries,
    get_resume_master,
    get_resume_constraints,
    get_skill_categories,
    get_tailoring_quality_controls,
    get_writing_style,
    tailored_experience_bullets,
    tailored_experience_title,
    tailored_skill_items,
)

if TYPE_CHECKING:  # pragma: no cover -- type-only to avoid cross-context import cycles
    from jobhunter.domain.scoring.value_objects import RequirementFitReport


SENIORITY_LEVELS = {"junior", "mid", "senior", "staff", "executive"}
SENIORITY_REQUIRED_LEVELS = {"senior", "staff", "executive"}

SENIORITY_SIGNAL_TERMS: tuple[str, ...] = (
    "own",
    "owned",
    "ownership",
    "scope",
    "influence",
    "influenced",
    "cross-team",
    "stakeholder",
    "stakeholders",
    "led",
    "lead",
    "mentor",
    "mentored",
    "architect",
    "architected",
    "strategy",
    "technical leadership",
)

EXECUTIVE_OVERREACH_MARKERS: tuple[str, ...] = (
    "company-wide strategy",
    "enterprise-wide strategy",
    "executive stakeholders",
    "board-level",
    "c-suite",
    "org-wide strategy",
    "multi-year strategy",
)

STOCK_PHRASE_MARKERS: tuple[str, ...] = (
    "results-driven",
    "leveraged",
    "dynamic professional",
    "impactful solutions",
    "drive value",
    "deliver value",
    "pivotal role",
    "strategic initiatives",
    "foster collaboration",
    "fostering collaboration",
    "fast-paced environment",
    "passion for",
    "unwavering commitment",
)

STANDARD_SECTION_HEADINGS: tuple[str, ...] = (
    "executive profile",
    "experience",
    "education",
    "skills",
)

KEYWORD_REPETITION_WARNING_COUNT = 5
KEYWORD_STUFFING_MIN_COUNT = 9
KEYWORD_STUFFING_DENSITY_THRESHOLD = 0.08
KEYWORD_STUFFING_ABSOLUTE_COUNT = 20

_STOPWORDS: set[str] = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "build",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "or",
    "our",
    "the",
    "their",
    "this",
    "to",
    "with",
    "work",
    "working",
    "role",
    "engineer",
    "engineering",
    "developer",
    "candidate",
    "team",
    "teams",
    "service",
    "services",
    "system",
    "systems",
}
_LOW_SIGNAL_JOB_KEYWORDS: set[str] = {
    "about",
    "across",
    "barcelona",
    "believe",
    "care",
    "chain",
    "clinic",
    "clinics",
    "combine",
    "company",
    "cool",
    "cutting",
    "deserves",
    "edge",
    "europe",
    "everyone",
    "expert",
    "fast",
    "growth",
    "head",
    "health",
    "impress",
    "innovator",
    "international",
    "join",
    "largest",
    "leading",
    "love",
    "office",
    "ortho",
    "orthodontics",
    "onsite",
    "rapid",
    "remote",
    "revolutionizing",
    "salary",
    "since",
    "smile",
    "tech",
    "they",
    "worldwide",
}

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+#./-]*")
_METRIC_RE = re.compile(
    r"(?ix)"
    r"(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?\s?(?:k|m|b|million|billion)?)"
    r"|(?:\b\d+(?:\.\d+)?\s?%)"
    r"|(?:\b\d+(?:\.\d+)?\s?x\b)"
    r"|(?:\b\d+(?:\.\d+)?\s?"
    r"(?:ms|milliseconds?|s|sec|seconds?|minutes?|hours?|days?|weeks?|months?|years?|"
    r"users?|customers?|engineers?|teams?|services?|systems?|pipelines?|applications?|"
    r"requests?|req/s|qps|revenue|cost|latency|uptime)\b)"
)


@dataclass(frozen=True)
class EvidencePlanItem:
    evidence_id: str
    experience_entry_id: str
    source_text: str
    scope: str
    action: str
    tools: tuple[str, ...] = ()
    metrics: tuple[str, ...] = ()
    outcome: str = ""
    seniority_signal: str = ""
    evidence_strength: str = ""
    claim_confidence: float = 0.0
    user_confirmed: bool = False
    tags: tuple[str, ...] = ()

    @property
    def prompt_dict(self) -> dict[str, Any]:
        return {
            "id": self.evidence_id,
            "experience_entry_id": self.experience_entry_id,
            "source_text": self.source_text,
            "scope": self.scope,
            "action": self.action,
            "tools": list(self.tools),
            "metrics": list(self.metrics),
            "outcome": self.outcome,
            "seniority_signal": self.seniority_signal,
            "evidence_strength": self.evidence_strength,
            "claim_confidence": self.claim_confidence,
            "user_confirmed": self.user_confirmed,
            "tags": list(self.tags),
        }

    @property
    def metadata_dict(self) -> dict[str, Any]:
        return {
            "id": self.evidence_id,
            "experience_entry_id": self.experience_entry_id,
            "metrics": list(self.metrics),
            "tools": list(self.tools),
            "seniority_signal": self.seniority_signal,
            "evidence_strength": self.evidence_strength,
            "user_confirmed": self.user_confirmed,
            "tags": list(self.tags),
        }


@dataclass(frozen=True)
class RequirementDirectivePlanItem:
    requirement_id: str
    requirement_text: str
    tier: str
    weight: float
    fit_kind: str
    action: str
    priority: float = 0.0
    allowed_evidence_ids: tuple[str, ...] = ()
    target_keywords: tuple[str, ...] = ()
    prohibited_claims: tuple[str, ...] = ()
    instruction: str = ""

    @property
    def prompt_dict(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "requirement_text": self.requirement_text,
            "tier": self.tier,
            "weight": self.weight,
            "pre_tailor_fit": self.fit_kind,
            "action": self.action,
            "priority": self.priority,
            "allowed_evidence_ids": list(self.allowed_evidence_ids),
            "target_keywords": list(self.target_keywords),
            "prohibited_claims": list(self.prohibited_claims),
            "instruction": self.instruction,
        }

    @property
    def metadata_dict(self) -> dict[str, Any]:
        return {
            "requirement_id": self.requirement_id,
            "requirement_text": self.requirement_text,
            "fit": self.fit_kind,
            "action": self.action,
            "priority": self.priority,
            "allowed_evidence_ids": list(self.allowed_evidence_ids),
            "target_keywords": list(self.target_keywords),
            "prohibited_claims": list(self.prohibited_claims),
        }


@dataclass(frozen=True)
class TailoringPlan:
    claim_mode: str
    auto_approvable_claim_modes: tuple[str, ...]
    allow_adjacent_achievement_drafts: bool
    writing_style: dict[str, Any]
    target_seniority: str
    job_keywords: tuple[str, ...] = ()
    required_evidence_ids: tuple[str, ...] = ()
    seniority_evidence_ids: tuple[str, ...] = ()
    verified_metrics: tuple[str, ...] = ()
    evidence_items: tuple[EvidencePlanItem, ...] = ()
    requirement_directives: tuple[RequirementDirectivePlanItem, ...] = ()
    prohibited_claims: tuple[str, ...] = ()

    @property
    def evidence_by_id(self) -> dict[str, EvidencePlanItem]:
        return {item.evidence_id: item for item in self.evidence_items}

    def to_prompt_dict(self) -> dict[str, Any]:
        required = self.evidence_by_id
        return {
            "claim_mode": self.claim_mode,
            "auto_approvable_claim_modes": list(self.auto_approvable_claim_modes),
            "allow_adjacent_achievement_drafts": self.allow_adjacent_achievement_drafts,
            "writing_style": dict(self.writing_style),
            "target_seniority": self.target_seniority,
            "job_keywords": list(self.job_keywords),
            "requirement_directives": [
                directive.prompt_dict for directive in self.requirement_directives
            ],
            "required_evidence": [
                required[evidence_id].prompt_dict
                for evidence_id in self.required_evidence_ids
                if evidence_id in required
            ],
            "seniority_evidence_ids": list(self.seniority_evidence_ids),
            "verified_metrics": list(self.verified_metrics),
            "prohibited_claims": list(self.prohibited_claims),
            "deterministic_checks": [
                "Use standard sections: EXECUTIVE PROFILE, EXPERIENCE, EDUCATION, SKILLS.",
                "Use only verified profile metrics or evidence metrics.",
                "Use requirement directives to decide which evidence to emphasize or bridge.",
                "Do not claim prohibited missing requirements unless grounded evidence exists.",
                "Cover relevant job keywords naturally; do not stuff repeated keywords.",
                "Match seniority to the job title and responsibilities.",
                "Avoid stock phrases and inflated claims; they are low-quality warnings.",
            ],
        }

    def to_prompt_context(self) -> str:
        return (
            "TAILORING QUALITY PLAN:\n"
            + json.dumps(self.to_prompt_dict(), indent=2, ensure_ascii=False)
        )

    def to_metadata(self) -> dict[str, Any]:
        return {
            "claim_mode": self.claim_mode,
            "auto_approvable_claim_modes": list(self.auto_approvable_claim_modes),
            "allow_adjacent_achievement_drafts": self.allow_adjacent_achievement_drafts,
            "writing_style": {
                key: self.writing_style.get(key)
                for key in ("tone", "bullet_style", "verbosity", "keyword_density")
                if key in self.writing_style
            },
            "target_seniority": self.target_seniority,
            "job_keywords": list(self.job_keywords),
            "required_evidence_ids": list(self.required_evidence_ids),
            "seniority_evidence_ids": list(self.seniority_evidence_ids),
            "verified_metric_count": len(self.verified_metrics),
            "requirement_directives": [
                directive.metadata_dict for directive in self.requirement_directives
            ],
            "prohibited_claims": list(self.prohibited_claims),
        }


@dataclass(frozen=True)
class TailoringQualityResult:
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    covered_keywords: tuple[str, ...] = ()
    missing_keywords: tuple[str, ...] = ()
    represented_evidence_ids: tuple[str, ...] = ()
    missing_evidence_ids: tuple[str, ...] = ()
    metric_claims: tuple[str, ...] = ()
    repeated_keywords: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    @property
    def passed(self) -> bool:
        return not self.errors

    def to_validation_result(self) -> ValidationResult:
        if self.errors:
            return ValidationResult.failure(self.errors, warnings=self.warnings)
        return ValidationResult.success(warnings=self.warnings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "notes": list(self.notes),
            "keyword_coverage": {
                "covered": list(self.covered_keywords),
                "missing": list(self.missing_keywords),
            },
            "evidence_support": {
                "represented_ids": list(self.represented_evidence_ids),
                "missing_ids": list(self.missing_evidence_ids),
            },
            "metric_claims": list(self.metric_claims),
            "repeated_keywords": list(self.repeated_keywords),
        }


@dataclass(frozen=True)
class TailoringChangeAnnotation:
    section: str
    label: str
    change_type: str
    source_id: str
    source_text: tuple[str, ...]
    tailored_text: tuple[str, ...]
    rationale: str
    job_signals: tuple[str, ...] = ()
    controls: tuple[str, ...] = ()
    evidence_ids: tuple[str, ...] = ()
    evidence_notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "section": self.section,
            "label": self.label,
            "change_type": self.change_type,
            "source_id": self.source_id,
            "source_text": list(self.source_text),
            "tailored_text": list(self.tailored_text),
            "rationale": self.rationale,
            "job_signals": list(self.job_signals),
            "controls": list(self.controls),
            "evidence_ids": list(self.evidence_ids),
            "evidence_notes": list(self.evidence_notes),
        }


def build_tailoring_plan(
    profile: dict,
    job: dict,
    *,
    employer_analysis: EmployerAnalysis,
    requirement_fit_report: "RequirementFitReport | None" = None,
) -> TailoringPlan:
    """Build the deterministic tailoring plan from the profile + canonical analysis.

    Phase 1 (D-21): job keywords come from the persisted, evidence-grounded
    :class:`EmployerAnalysis` (the 3-SDK ensemble's reconciled, reasoned
    keywords) — the flakey ``_extract_job_keywords`` stopword heuristic has been
    ripped out outright (no shim). The rest of the plan (evidence selection,
    seniority, verified metrics) is unchanged.
    """
    controls = get_tailoring_quality_controls(profile)
    writing_style = get_writing_style(profile)
    evidence_items = tuple(_evidence_item(item) for item in get_achievement_evidence(profile))
    requirement_directives = _requirement_directive_items(
        requirement_fit_report=requirement_fit_report,
        job=job,
        employer_analysis=employer_analysis,
    )
    directive_keywords = tuple(
        keyword
        for directive in requirement_directives
        for keyword in directive.target_keywords
    )
    job_keywords = _merge_keywords(directive_keywords, _analysis_job_keywords(employer_analysis))
    target_seniority = _target_seniority(job)
    seniority_evidence_ids = tuple(
        item.evidence_id for item in evidence_items if _has_seniority_signal(item)
    )
    required_evidence_ids = _select_required_evidence_ids(
        evidence_items=evidence_items,
        job_keywords=job_keywords,
        directive_evidence_ids=_directive_evidence_ids(requirement_directives),
        target_seniority=target_seniority,
        seniority_evidence_ids=seniority_evidence_ids,
    )
    verified_metrics = tuple(
        dict.fromkeys(
            _text_list(get_resume_constraints(profile).get("real_metrics"))
            + [metric for item in evidence_items for metric in item.metrics]
            + _baseline_experience_metrics(profile)
        )
    )

    return TailoringPlan(
        claim_mode=get_claim_mode(profile),
        auto_approvable_claim_modes=tuple(
            str(mode) for mode in controls.get("auto_approvable_claim_modes", [])
        ),
        allow_adjacent_achievement_drafts=bool(
            controls.get("allow_adjacent_achievement_drafts", False)
        ),
        writing_style=writing_style,
        target_seniority=target_seniority,
        job_keywords=job_keywords,
        required_evidence_ids=required_evidence_ids,
        seniority_evidence_ids=seniority_evidence_ids,
        verified_metrics=verified_metrics,
        evidence_items=evidence_items,
        requirement_directives=requirement_directives,
        prohibited_claims=_directive_prohibited_claims(requirement_directives),
    )


def build_tailoring_change_annotations(
    profile: dict,
    job: dict,
    tailored_payload: dict,
    plan: TailoringPlan,
) -> tuple[dict[str, Any], ...]:
    """Explain the selected tailored payload as an auditable change log."""
    resume = get_resume_master(profile)
    annotations: list[TailoringChangeAnnotation] = []
    controls = _annotation_controls(plan)

    baseline_summary = _normalize_space(
        str(resume.get("executive_profile", {}).get("baseline_text", ""))
    )
    tailored_summary = _normalize_space(str(tailored_payload.get("executive_profile") or ""))
    if tailored_summary:
        annotations.append(
            TailoringChangeAnnotation(
                section="executive_profile",
                label="Executive profile",
                change_type=(
                    "summary_reframed"
                    if _normalize_phrase(baseline_summary) != _normalize_phrase(tailored_summary)
                    else "summary_preserved"
                ),
                source_id="executive_profile",
                source_text=_annotation_lines([baseline_summary]),
                tailored_text=_annotation_lines([tailored_summary]),
                rationale=_summary_rationale(plan, job, tailored_summary),
                job_signals=_annotation_job_signals(tailored_summary, plan, job),
                controls=controls,
                evidence_ids=tuple(plan.seniority_evidence_ids[:6]),
                evidence_notes=_annotation_evidence_notes(
                    plan,
                    plan.seniority_evidence_ids,
                    tailored_summary,
                ),
            )
        )

    updates = {
        str(update.get("id")): update
        for update in tailored_payload.get("experience_updates") or []
        if isinstance(update, dict) and update.get("id")
    }
    for entry in get_experience_entries(profile):
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "")
        update = updates.get(entry_id, {})
        if not update:
            continue
        source_bullets = _text_list(entry.get("bullets"))
        tailored_title = tailored_experience_title(entry, update, profile)
        tailored_bullets = tailored_experience_bullets(entry, update, profile)
        tailored_lines = [
            line for line in [tailored_title, *tailored_bullets] if str(line).strip()
        ]
        if not tailored_lines:
            continue
        source_title = str(entry.get("title") or "").strip()
        evidence_ids = tuple(
            item.evidence_id
            for item in plan.evidence_items
            if item.experience_entry_id == entry_id
            and (
                item.evidence_id in plan.required_evidence_ids
                or item.evidence_id in plan.seniority_evidence_ids
                or _evidence_represented(_normalize_space("\n".join(tailored_lines)).lower(), item)
            )
        )
        annotations.append(
            TailoringChangeAnnotation(
                section="experience",
                label=_experience_label(entry),
                change_type=_experience_change_type(entry, update, profile),
                source_id=entry_id,
                source_text=_annotation_lines([source_title, *source_bullets], limit=5),
                tailored_text=_annotation_lines(tailored_lines, limit=5),
                rationale=_experience_rationale(plan, job, entry, tailored_lines),
                job_signals=_annotation_job_signals("\n".join(tailored_lines), plan, job),
                controls=controls,
                evidence_ids=evidence_ids[:6],
                evidence_notes=_annotation_evidence_notes(
                    plan,
                    evidence_ids,
                    "\n".join(tailored_lines),
                ),
            )
        )

    skill_updates = {
        str(update.get("id")): update
        for update in tailored_payload.get("skill_category_updates") or []
        if isinstance(update, dict) and update.get("id")
    }
    for category in get_skill_categories(profile):
        if not isinstance(category, dict):
            continue
        category_id = str(category.get("id") or "")
        update = skill_updates.get(category_id, {})
        if not update:
            continue
        source_items = _text_list(category.get("items"))
        tailored_items = tailored_skill_items(category, update, profile)
        if not tailored_items:
            continue
        annotations.append(
            TailoringChangeAnnotation(
                section="skills",
                label=f"{category.get('label') or 'Skills'} skills",
                change_type=(
                    "skills_reordered"
                    if [_normalize_phrase(item) for item in tailored_items]
                    != [_normalize_phrase(item) for item in source_items]
                    else "skills_preserved"
                ),
                source_id=category_id,
                source_text=_annotation_lines(source_items, limit=10),
                tailored_text=_annotation_lines(tailored_items, limit=10),
                rationale=_skills_rationale(plan, job, tailored_items),
                job_signals=_annotation_job_signals(", ".join(tailored_items), plan, job),
                controls=controls,
            )
        )

    return tuple(item.to_dict() for item in annotations[:12])


def evaluate_tailoring_quality(
    tailored_payload: dict,
    tailored_text: str,
    plan: TailoringPlan,
) -> TailoringQualityResult:
    payload_text = _payload_text(tailored_payload)
    text_lower = _normalize_space(tailored_text).lower()
    generated_lower = _normalize_space(payload_text).lower()

    errors: list[str] = []
    warnings: list[str] = []
    notes: list[str] = []

    missing_sections = [
        heading for heading in STANDARD_SECTION_HEADINGS if heading not in text_lower
    ]
    if missing_sections:
        errors.append("Missing standard resume sections: " + ", ".join(missing_sections))

    represented_evidence_ids, missing_evidence_ids = _check_required_evidence(
        generated_lower, plan
    )
    if missing_evidence_ids:
        errors.append(
            "Missing required evidence support: " + ", ".join(missing_evidence_ids)
        )

    metric_claims, unknown_metrics = _check_metrics(generated_lower, plan)
    for metric in unknown_metrics:
        errors.append(f"Unknown metric not found in verified profile evidence: {metric}")

    found_prohibited_claims = _prohibited_claims_found(generated_lower, plan.prohibited_claims)
    for claim in found_prohibited_claims:
        errors.append(f"Unsupported prohibited claim appeared: {claim}")

    covered_keywords, missing_keywords = _keyword_coverage(generated_lower, plan.job_keywords)
    if plan.job_keywords:
        coverage_ratio = len(covered_keywords) / len(plan.job_keywords)
        if len(plan.job_keywords) >= 4 and not covered_keywords:
            errors.append("Keyword coverage extremely empty: no target job keywords covered")
        elif len(plan.job_keywords) >= 4 and coverage_ratio < 0.25:
            warnings.append(
                "Low keyword coverage: covered "
                f"{len(covered_keywords)}/{len(plan.job_keywords)} target keywords"
            )

    repeated_keywords = _keyword_repetition(generated_lower, plan.job_keywords)
    for item in repeated_keywords:
        term = str(item["keyword"])
        count = int(item["count"])
        density = float(item.get("density", 0.0))
        if _is_keyword_stuffing(count=count, density=density):
            errors.append(f"Keyword stuffing: '{term}' repeated {count} times")
        elif count >= KEYWORD_REPETITION_WARNING_COUNT:
            warnings.append(f"Keyword repetition: '{term}' repeated {count} times")

    repeated_word = _consecutive_repeated_word(generated_lower)
    if repeated_word:
        warnings.append(f"Unusual repetition: '{repeated_word}' repeated consecutively")

    if (
        plan.target_seniority in SENIORITY_REQUIRED_LEVELS
        and plan.seniority_evidence_ids
        and not _has_seniority_output_signal(generated_lower)
    ):
        errors.append(
            "Seniority mismatch: senior/staff role needs ownership, scope, or "
            "influence language supported by profile evidence"
        )
    if plan.target_seniority in {"junior", "mid"}:
        found_overreach = [
            marker for marker in EXECUTIVE_OVERREACH_MARKERS if marker in generated_lower
        ]
        if found_overreach:
            warnings.append(
                "Executive phrasing for non-senior job: "
                + ", ".join(found_overreach[:3])
            )

    found_voice = [marker for marker in STOCK_PHRASE_MARKERS if marker in generated_lower]
    if found_voice:
        warnings.append("Stock phrase markers: " + ", ".join(found_voice[:5]))

    if covered_keywords:
        notes.append(
            f"Keyword coverage: {len(covered_keywords)}/{len(plan.job_keywords)}"
        )
    if represented_evidence_ids:
        notes.append("Represented evidence: " + ", ".join(represented_evidence_ids))

    return TailoringQualityResult(
        errors=tuple(errors),
        warnings=tuple(warnings),
        notes=tuple(notes),
        covered_keywords=covered_keywords,
        missing_keywords=missing_keywords,
        represented_evidence_ids=represented_evidence_ids,
        missing_evidence_ids=missing_evidence_ids,
        metric_claims=metric_claims,
        repeated_keywords=tuple(repeated_keywords),
    )


def _evidence_item(item: dict) -> EvidencePlanItem:
    return EvidencePlanItem(
        evidence_id=str(item.get("id", "")).strip(),
        experience_entry_id=str(item.get("experience_entry_id", "")).strip(),
        source_text=str(item.get("source_text", "")).strip(),
        scope=str(item.get("scope", "")).strip(),
        action=str(item.get("action", "")).strip(),
        tools=tuple(_text_list(item.get("tools"))),
        metrics=tuple(_text_list(item.get("metrics"))),
        outcome=str(item.get("outcome", "")).strip(),
        seniority_signal=str(item.get("seniority_signal", "")).strip(),
        evidence_strength=str(item.get("evidence_strength", "")).strip(),
        claim_confidence=float(item.get("claim_confidence") or 0.0),
        user_confirmed=bool(item.get("user_confirmed", False)),
        tags=tuple(_text_list(item.get("tags"))),
    )


def _select_required_evidence_ids(
    *,
    evidence_items: tuple[EvidencePlanItem, ...],
    job_keywords: tuple[str, ...],
    directive_evidence_ids: tuple[str, ...],
    target_seniority: str,
    seniority_evidence_ids: tuple[str, ...],
) -> tuple[str, ...]:
    if not evidence_items:
        return ()

    valid_evidence_ids = {item.evidence_id for item in evidence_items if item.evidence_id}
    selected = [
        evidence_id
        for evidence_id in directive_evidence_ids
        if evidence_id in valid_evidence_ids
    ]
    selected = list(dict.fromkeys(selected))[:6]

    scored: list[tuple[int, str]] = []
    keyword_set = set(job_keywords)
    for item in evidence_items:
        evidence_terms = _evidence_terms(item)
        overlap = len(keyword_set & evidence_terms)
        if overlap:
            scored.append((overlap, item.evidence_id))

    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    for _, evidence_id in scored:
        if evidence_id not in selected:
            selected.append(evidence_id)
        if len(selected) >= 6:
            break
    if target_seniority in SENIORITY_REQUIRED_LEVELS:
        for evidence_id in seniority_evidence_ids:
            if evidence_id not in selected:
                selected.append(evidence_id)
                break
    return tuple(selected)


def _requirement_directive_items(
    *,
    requirement_fit_report: "RequirementFitReport | None",
    job: dict,
    employer_analysis: EmployerAnalysis,
) -> tuple[RequirementDirectivePlanItem, ...]:
    if not _requirement_fit_report_matches(requirement_fit_report, job, employer_analysis):
        return ()
    items: list[RequirementDirectivePlanItem] = []
    for assessment in getattr(requirement_fit_report, "assessments", ()) or ():
        fit = getattr(assessment, "fit", None)
        directive = getattr(assessment, "tailoring", None)
        requirement_id = str(getattr(assessment, "requirement_id", "") or "").strip()
        requirement_text = str(getattr(assessment, "requirement_text", "") or "").strip()
        if not requirement_id or not requirement_text:
            continue
        fit_kind = str(getattr(fit, "kind", "not_assessed") or "not_assessed")
        action = str(getattr(directive, "action", "low_priority") or "low_priority")
        allowed_evidence_ids = _merge_strings(
            tuple(getattr(fit, "evidence_ids", ()) or ()),
            tuple(getattr(directive, "allowed_evidence_ids", ()) or ()),
        )
        target_keywords = _merge_keywords(
            tuple(getattr(directive, "target_keywords", ()) or ()),
            _requirement_keywords(employer_analysis, requirement_id),
        )
        prohibited_claims = tuple(getattr(directive, "prohibited_claims", ()) or ())
        if fit_kind in {"missing", "blocked"} and not prohibited_claims:
            prohibited_claims = (requirement_text,)
        instruction = str(getattr(directive, "instruction", "") or "").strip()
        items.append(
            RequirementDirectivePlanItem(
                requirement_id=requirement_id,
                requirement_text=requirement_text,
                tier=str(getattr(assessment, "tier", "nice_to_have") or "nice_to_have"),
                weight=float(getattr(assessment, "weight", 0.0) or 0.0),
                fit_kind=fit_kind,
                action=action,
                priority=float(getattr(directive, "priority", 0.0) or 0.0),
                allowed_evidence_ids=allowed_evidence_ids,
                target_keywords=target_keywords,
                prohibited_claims=tuple(_text_list(prohibited_claims)),
                instruction=instruction,
            )
        )
    items.sort(key=lambda item: (-item.priority, -item.weight, item.requirement_id))
    return tuple(items)


def _requirement_fit_report_matches(
    requirement_fit_report: "RequirementFitReport | None",
    job: dict,
    employer_analysis: EmployerAnalysis,
) -> bool:
    if requirement_fit_report is None:
        return False
    job_url = str(job.get("url") or "").strip()
    if job_url and str(getattr(requirement_fit_report, "job_id", "") or "") != job_url:
        return False
    generation = int(getattr(requirement_fit_report, "employer_analysis_generation", 0) or 0)
    return generation == employer_analysis.generation


def _requirement_keywords(
    employer_analysis: EmployerAnalysis,
    requirement_id: str,
) -> tuple[str, ...]:
    keywords: list[str] = []
    for keyword in employer_analysis.canonical.keywords:
        if str(keyword.requirement_ref or "") != requirement_id:
            continue
        normalized = _normalize_phrase(keyword.keyword)
        if normalized:
            keywords.append(normalized)
    return tuple(dict.fromkeys(keywords))


def _directive_evidence_ids(
    directives: tuple[RequirementDirectivePlanItem, ...],
) -> tuple[str, ...]:
    ids: list[str] = []
    for directive in directives:
        if directive.action not in {"double_down", "bridge_gap"}:
            continue
        ids.extend(directive.allowed_evidence_ids)
    return tuple(dict.fromkeys(ids))


def _directive_prohibited_claims(
    directives: tuple[RequirementDirectivePlanItem, ...],
) -> tuple[str, ...]:
    claims: list[str] = []
    for directive in directives:
        if directive.action != "avoid_claim":
            continue
        claims.extend(directive.prohibited_claims)
    return tuple(dict.fromkeys(_normalize_space(claim) for claim in claims if claim))


def _merge_keywords(
    preferred: tuple[str, ...],
    fallback: tuple[str, ...],
) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            normalized
            for keyword in [*preferred, *fallback]
            if (normalized := _normalize_phrase(keyword))
        )
    )[:32]


def _merge_strings(*groups: tuple[str, ...]) -> tuple[str, ...]:
    values: list[str] = []
    for group in groups:
        values.extend(_text_list(group))
    return tuple(dict.fromkeys(values))


def _analysis_job_keywords(employer_analysis: EmployerAnalysis) -> tuple[str, ...]:
    """Derive the tailoring plan's job keywords from the canonical analysis (D-21).

    The keywords are the 3-SDK ensemble's reconciled, evidence-grounded
    ``ReasonedKeyword`` terms — each already tied to a literal JD evidence span.
    Deduplicated case-insensitively while preserving the analysis order (which
    reflects the reconciled importance ranking), capped to keep the prompt /
    coverage check bounded.
    """
    ordered: list[str] = []
    seen: set[str] = set()
    for keyword in employer_analysis.canonical.keywords:
        normalized = _normalize_phrase(keyword.keyword)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return tuple(ordered[:32])


def _target_seniority(job: dict) -> str:
    text = _normalize_space(
        " ".join(
            str(job.get(key) or "")
            for key in ("title", "role_title", "full_description", "description")
        )
    ).lower()
    if re.search(r"\b(intern|internship|junior|entry[- ]level|graduate|associate)\b", text):
        return "junior"
    if re.search(r"\b(vp|vice president|director|head of|executive)\b", text):
        return "executive"
    if re.search(r"\b(staff|principal|lead|architect)\b", text):
        return "staff"
    if re.search(r"\b(senior|sr\.)\b", text):
        return "senior"
    return "mid"


def _annotation_controls(plan: TailoringPlan) -> tuple[str, ...]:
    controls = [
        f"target seniority: {plan.target_seniority}",
        f"claim mode: {plan.claim_mode}",
        "adjacent drafts allowed" if plan.allow_adjacent_achievement_drafts else "adjacent drafts blocked",
    ]
    for key in ("tone", "bullet_style", "verbosity", "keyword_density"):
        value = plan.writing_style.get(key)
        if value:
            controls.append(f"{key.replace('_', ' ')}: {value}")
    if plan.auto_approvable_claim_modes:
        controls.append(
            "auto-approvable claims: "
            + ", ".join(plan.auto_approvable_claim_modes[:4])
        )
    return tuple(controls)


def _annotation_lines(values: list[str] | tuple[str, ...], *, limit: int = 4) -> tuple[str, ...]:
    lines = []
    for value in values:
        line = _normalize_space(str(value))
        if line:
            lines.append(line[:320])
    return tuple(list(dict.fromkeys(lines))[:limit])


def _annotation_job_signals(text: str, plan: TailoringPlan, job: dict) -> tuple[str, ...]:
    normalized = _normalize_space(text).lower()
    signals = [
        keyword for keyword in plan.job_keywords if _contains_term(normalized, keyword)
    ]
    if not signals:
        title = str(job.get("title") or job.get("role_title") or "").strip()
        if title:
            signals.append(title)
    return tuple(list(dict.fromkeys(signals))[:8])


def _summary_rationale(plan: TailoringPlan, job: dict, tailored_summary: str) -> str:
    signals = ", ".join(_annotation_job_signals(tailored_summary, plan, job))
    if signals:
        return (
            f"Summary was framed for a {plan.target_seniority} target and the "
            f"job signals {signals}, using {plan.claim_mode} rather than new claims."
        )
    return (
        f"Summary was framed for a {plan.target_seniority} target using "
        f"{plan.claim_mode} and the selected writing controls."
    )


def _experience_rationale(
    plan: TailoringPlan,
    job: dict,
    entry: dict,
    tailored_lines: list[str],
) -> str:
    signals = ", ".join(_annotation_job_signals("\n".join(tailored_lines), plan, job))
    company = str(entry.get("company") or "this experience").strip()
    if signals:
        return (
            f"{company} was emphasized because it supports the target role through "
            f"{signals}; wording is constrained by {plan.claim_mode} evidence controls."
        )
    return (
        f"{company} was carried into the tailored resume because it is selected "
        f"profile experience and fits the {plan.target_seniority} target."
    )


def _skills_rationale(plan: TailoringPlan, job: dict, tailored_items: list[str]) -> str:
    signals = ", ".join(_annotation_job_signals(", ".join(tailored_items), plan, job))
    if signals:
        return (
            f"Skill ordering highlights job-matching signals ({signals}) while "
            "preserving the selected profile skill category."
        )
    return "Skill category is preserved from the profile under the selected tailoring controls."


def _experience_label(entry: dict) -> str:
    title = str(entry.get("title") or "Experience").strip()
    company = str(entry.get("company") or "").strip()
    return f"{title} at {company}" if company else title


def _experience_change_type(entry: dict, update: dict, profile: dict) -> str:
    source_title = _normalize_phrase(str(entry.get("title") or ""))
    tailored_title = _normalize_phrase(tailored_experience_title(entry, update, profile))
    source_bullets = [_normalize_phrase(item) for item in _text_list(entry.get("bullets"))]
    tailored_bullets = [
        _normalize_phrase(item) for item in tailored_experience_bullets(entry, update, profile)
    ]
    title_changed = tailored_title and tailored_title != source_title
    bullets_changed = tailored_bullets != source_bullets
    if title_changed and bullets_changed:
        return "title_and_achievement_reframed"
    if title_changed:
        return "title_reframed"
    if bullets_changed:
        return "achievement_reframed"
    return "experience_preserved"


def _annotation_evidence_notes(
    plan: TailoringPlan,
    evidence_ids: tuple[str, ...],
    tailored_text: str,
) -> tuple[str, ...]:
    notes: list[str] = []
    normalized = _normalize_space(tailored_text).lower()
    for evidence_id in evidence_ids[:6]:
        item = plan.evidence_by_id.get(evidence_id)
        if item is None:
            continue
        parts = []
        if item.metrics:
            parts.append(", ".join(item.metrics[:3]))
        if item.tools:
            tools = [tool for tool in item.tools if _contains_term(normalized, tool.lower())]
            parts.append(", ".join((tools or list(item.tools))[:3]))
        if item.seniority_signal:
            parts.append(item.seniority_signal)
        if not parts and item.source_text:
            parts.append(item.source_text[:160])
        notes.append(f"{item.evidence_id}: " + "; ".join(part for part in parts if part))
    return tuple(dict.fromkeys(note for note in notes if note))


def _flatten_text(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return [stripped]
        return _flatten_text(parsed)
    if isinstance(value, dict):
        items: list[str] = []
        for child in value.values():
            items.extend(_flatten_text(child))
        return items
    if isinstance(value, (list, tuple, set)):
        items = []
        for child in value:
            items.extend(_flatten_text(child))
        return items
    return [str(value).strip()] if str(value).strip() else []


def _payload_text(payload: dict) -> str:
    parts: list[str] = []
    executive = payload.get("executive_profile")
    if isinstance(executive, str):
        parts.append(executive)
    for update in payload.get("experience_updates") or []:
        if not isinstance(update, dict):
            continue
        for key in ("title", "bullets"):
            parts.extend(_flatten_text(update.get(key)))
    for update in payload.get("skill_category_updates") or []:
        if isinstance(update, dict):
            parts.extend(_flatten_text(update.get("items")))
    return "\n".join(parts)


def _check_required_evidence(
    generated_lower: str,
    plan: TailoringPlan,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    represented: list[str] = []
    missing: list[str] = []
    evidence_by_id = plan.evidence_by_id
    for evidence_id in plan.required_evidence_ids:
        item = evidence_by_id.get(evidence_id)
        if item is None:
            continue
        if _evidence_represented(generated_lower, item):
            represented.append(evidence_id)
        else:
            missing.append(evidence_id)
    return tuple(represented), tuple(missing)


def _evidence_represented(generated_lower: str, item: EvidencePlanItem) -> bool:
    if item.evidence_id and item.evidence_id.lower() in generated_lower:
        return True
    if any(_contains_metric_text(generated_lower, metric) for metric in item.metrics):
        return True
    terms = _evidence_terms(item)
    hits = [term for term in terms if _contains_term(generated_lower, term)]
    return len(hits) >= 2


def _check_metrics(
    generated_lower: str,
    plan: TailoringPlan,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    metric_claims = tuple(dict.fromkeys(_display_metric(match.group(0)) for match in _METRIC_RE.finditer(generated_lower)))
    allowed_text = " ".join(plan.verified_metrics).lower()
    unknown = tuple(
        metric for metric in metric_claims if metric and not _contains_metric_text(allowed_text, metric)
    )
    return metric_claims, unknown


def _prohibited_claims_found(
    generated_lower: str,
    prohibited_claims: tuple[str, ...],
) -> tuple[str, ...]:
    found: list[str] = []
    normalized_text = _normalize_claim_phrase(generated_lower)
    for claim in prohibited_claims:
        normalized = _normalize_claim_phrase(claim)
        if len(normalized) < 3:
            continue
        if normalized in normalized_text:
            found.append(claim)
    return tuple(dict.fromkeys(found))


def _normalize_claim_phrase(value: str) -> str:
    return " ".join(token.strip(".,;:") for token in _normalize_phrase(value).split()).strip()


def _baseline_experience_metrics(profile: dict) -> list[str]:
    metrics: list[str] = []
    for entry in get_experience_entries(profile):
        if not isinstance(entry, dict):
            continue
        for bullet in _text_list(entry.get("bullets")):
            metrics.extend(_normalize_metric(match.group(0)) for match in _METRIC_RE.finditer(bullet))
    return [metric for metric in metrics if metric]


def _keyword_coverage(
    generated_lower: str,
    job_keywords: tuple[str, ...],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    covered = tuple(keyword for keyword in job_keywords if _contains_term(generated_lower, keyword))
    missing = tuple(keyword for keyword in job_keywords if keyword not in covered)
    return covered, missing


def _keyword_repetition(
    generated_lower: str,
    job_keywords: tuple[str, ...],
) -> list[dict[str, Any]]:
    repeated: list[dict[str, Any]] = []
    total_words = len(_WORD_RE.findall(generated_lower))
    for keyword in job_keywords:
        count = _term_count(generated_lower, keyword)
        if count >= KEYWORD_REPETITION_WARNING_COUNT:
            density = _keyword_occurrence_density(
                keyword=keyword,
                count=count,
                total_words=total_words,
            )
            repeated.append({"keyword": keyword, "count": count, "density": density})
    repeated.sort(key=lambda item: (-int(item["count"]), str(item["keyword"])))
    return repeated


def _keyword_occurrence_density(*, keyword: str, count: int, total_words: int) -> float:
    if total_words <= 0:
        return 0.0
    keyword_words = max(1, len(_WORD_RE.findall(_normalize_phrase(keyword))))
    return (count * keyword_words) / total_words


def _is_keyword_stuffing(*, count: int, density: float) -> bool:
    return count >= KEYWORD_STUFFING_ABSOLUTE_COUNT or (
        count >= KEYWORD_STUFFING_MIN_COUNT
        and density >= KEYWORD_STUFFING_DENSITY_THRESHOLD
    )


def _consecutive_repeated_word(generated_lower: str) -> str:
    tokens = [token for token in _WORD_RE.findall(generated_lower) if token]
    if not tokens:
        return ""
    run_word = tokens[0]
    run_length = 1
    for token in tokens[1:]:
        if token == run_word:
            run_length += 1
            if run_length >= 4 and token not in {"and", "or"}:
                return token
        else:
            run_word = token
            run_length = 1
    return ""


def _has_seniority_signal(item: EvidencePlanItem) -> bool:
    text = _normalize_space(
        " ".join(
            [
                item.scope,
                item.action,
                item.outcome,
                item.seniority_signal,
                item.source_text,
            ]
        )
    ).lower()
    return any(term in text for term in SENIORITY_SIGNAL_TERMS)


def _has_seniority_output_signal(generated_lower: str) -> bool:
    return any(term in generated_lower for term in SENIORITY_SIGNAL_TERMS)


def _evidence_terms(item: EvidencePlanItem) -> set[str]:
    values = [
        item.source_text,
        item.scope,
        item.action,
        item.outcome,
        item.seniority_signal,
        *item.tools,
        *item.metrics,
        *item.tags,
    ]
    terms: set[str] = set()
    for value in values:
        terms.update(_significant_tokens(value))
    return terms


def _significant_tokens(text: str) -> list[str]:
    tokens = []
    for token in _WORD_RE.findall(str(text).lower()):
        token = token.strip("./-")
        if len(token) < 3 or token in _STOPWORDS or token in _LOW_SIGNAL_JOB_KEYWORDS:
            continue
        tokens.append(token)
    counts = Counter(tokens)
    return list(dict.fromkeys(token for token in tokens if counts[token] >= 1))


def _contains_term(text: str, term: str) -> bool:
    term = _normalize_phrase(term)
    if not term:
        return False
    if " " in term:
        return term in text
    return re.search(r"(?<![a-z0-9+#./-])" + re.escape(term) + r"(?![a-z0-9+#./-])", text) is not None


def _term_count(text: str, term: str) -> int:
    term = _normalize_phrase(term)
    if not term:
        return 0
    if " " in term:
        return text.count(term)
    return len(
        re.findall(
            r"(?<![a-z0-9+#./-])" + re.escape(term) + r"(?![a-z0-9+#./-])",
            text,
        )
    )


def _contains_metric_text(text: str, metric: str) -> bool:
    normalized_metric = _normalize_metric(metric)
    if not normalized_metric:
        return False
    return normalized_metric in _normalize_metric(text)


def _normalize_metric(value: str) -> str:
    return re.sub(r"\s+", "", str(value).lower().replace(",", "")).strip(".")


def _display_metric(value: str) -> str:
    return re.sub(r"\s+", " ", str(value).strip().replace(",", "")).strip(".")


def _normalize_phrase(value: str) -> str:
    return " ".join(_WORD_RE.findall(str(value).lower())).strip()


def _normalize_space(value: str) -> str:
    return " ".join(str(value or "").split())


def _text_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


__all__ = [
    "STOCK_PHRASE_MARKERS",
    "EvidencePlanItem",
    "TailoringPlan",
    "TailoringQualityResult",
    "TailoringChangeAnnotation",
    "build_tailoring_change_annotations",
    "build_tailoring_plan",
    "evaluate_tailoring_quality",
]
