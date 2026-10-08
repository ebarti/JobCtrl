"""Deterministic resume tailoring plan and quality checks.

The Materials use case owns I/O and LLM calls. This module stays pure: profile
dict + job dict + generated payload/text in, value objects out.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.analysis import EmployerAnalysis
from jobctrl.domain.materials.policy import (
    RequirementLedTailoringControls,
    adapt_requirement_led_controls,
)
from jobctrl.domain.materials.requirement_coverage import (
    CoverageGraph,
    TargetProfile,
    build_target_profile,
    seed_coverage_graph,
)
from jobctrl.domain.ports.artifact_review import ValidationResult
from jobctrl.resume_profile import (
    get_achievement_evidence,
    get_custom_tailoring_prompt,
    get_experience_entries,
    get_max_experience_bullets,
    get_required_bullets_by_experience_id,
    get_required_experience_entry_ids,
    get_required_skills_by_category_id,
    get_revision_gates,
    get_tailoring_policy,
    get_tailoring_quality_controls,
    get_writing_style,
)

if TYPE_CHECKING:  # pragma: no cover -- type-only to avoid cross-context import cycles
    from jobctrl.domain.scoring.value_objects import RequirementFitReport


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
    coverage_scope: str = "resume"
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
            "coverage_scope": self.coverage_scope,
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
            "coverage_scope": self.coverage_scope,
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
    verified_metrics: tuple[str, ...] = ()
    evidence_items: tuple[EvidencePlanItem, ...] = ()
    requirement_directives: tuple[RequirementDirectivePlanItem, ...] = ()
    prohibited_claims: tuple[str, ...] = ()
    requirement_led_controls: RequirementLedTailoringControls = field(default_factory=RequirementLedTailoringControls)
    target_profile: TargetProfile | None = None
    coverage_graph: CoverageGraph | None = None

    @property
    def evidence_by_id(self) -> dict[str, EvidencePlanItem]:
        return {item.evidence_id: item for item in self.evidence_items}

    def to_prompt_dict(self, *, include_alternatives: bool = False) -> dict[str, Any]:
        required = self.evidence_by_id
        return {
            "writing_style": dict(self.writing_style),
            "target_seniority": self.target_seniority,
            "job_keywords": list(self.job_keywords),
            "requirement_directives": [directive.prompt_dict for directive in self.requirement_directives],
            "required_evidence": [
                required[evidence_id].prompt_dict
                for evidence_id in self.required_evidence_ids
                if evidence_id in required
            ],
            "verified_metrics": list(self.verified_metrics),
            "prohibited_claims": list(self.prohibited_claims),
            "requirement_led_controls": self.requirement_led_controls.to_dict(),
            "target_profile": self.target_profile.to_prompt_dict() if self.target_profile is not None else None,
            "coverage_graph": (
                self.coverage_graph.to_dict() if include_alternatives else self.coverage_graph.to_prompt_dict()
            )
            if self.coverage_graph is not None
            else None,
            "verification_rubric": [
                "Use standard sections: EXECUTIVE PROFILE, EXPERIENCE, EDUCATION, SKILLS.",
                "Use only verified profile metrics or evidence metrics.",
                "Use requirement directives to decide which evidence to emphasize or bridge.",
                "Treat context-only requirements as eligibility/apply-review facts, never resume coverage.",
                "Do not claim prohibited missing requirements unless grounded evidence exists.",
                "Cover relevant job keywords naturally; do not stuff repeated keywords.",
                "Match seniority to the job title and responsibilities.",
                "Avoid stock phrases and inflated claims; they are low-quality warnings.",
            ],
        }

    def to_prompt_context(self, *, include_alternatives: bool = False) -> str:
        return "TAILORING QUALITY PLAN:\n" + json.dumps(
            self.to_prompt_dict(include_alternatives=include_alternatives),
            indent=2,
            ensure_ascii=False,
        )

    def to_metadata(self) -> dict[str, Any]:
        return {
            "claim_mode": self.claim_mode,
            "auto_approvable_claim_modes": list(self.auto_approvable_claim_modes),
            "writing_style": {
                key: self.writing_style.get(key)
                for key in ("tone", "bullet_style", "verbosity", "keyword_density")
                if key in self.writing_style
            },
            "target_seniority": self.target_seniority,
            "job_keywords": list(self.job_keywords),
            "required_evidence_ids": list(self.required_evidence_ids),
            "verified_metric_count": len(self.verified_metrics),
            "requirement_directives": [directive.metadata_dict for directive in self.requirement_directives],
            "prohibited_claims": list(self.prohibited_claims),
            "requirement_led_controls": self.requirement_led_controls.to_dict(),
            "target_profile": self.target_profile.to_safe_metadata() if self.target_profile is not None else None,
            "coverage_graph": self.coverage_graph.to_safe_metadata() if self.coverage_graph is not None else None,
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
    requirement_ids: tuple[str, ...] = ()
    coverage_edge_ids: tuple[str, ...] = ()
    claim_labels: tuple[str, ...] = ()
    positioning_reasons: tuple[str, ...] = ()
    review_required: bool = False
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
            "requirement_ids": list(self.requirement_ids),
            "coverage_edge_ids": list(self.coverage_edge_ids),
            "claim_labels": list(self.claim_labels),
            "positioning_reasons": list(self.positioning_reasons),
            "review_required": self.review_required,
            "evidence_notes": list(self.evidence_notes),
        }


class TailoringPrerequisiteError(ValueError):
    """Tailoring inputs are not bound to one coherent scoring generation."""

    def __init__(
        self,
        *,
        reason: str,
        job_id: str,
        analysis_generation: int,
        report_generation: int | None = None,
    ) -> None:
        self.reason = reason
        self.job_id = job_id
        self.analysis_generation = analysis_generation
        self.report_generation = report_generation
        if reason == "requirement_fit_missing":
            detail = "no requirement-fit report exists"
        elif reason == "requirement_fit_job_mismatch":
            detail = "the requirement-fit report belongs to a different job"
        else:
            detail = (
                "requirement-fit generation "
                f"{report_generation} does not match employer-analysis generation "
                f"{analysis_generation}"
            )
        super().__init__(f"Tailoring requires a fresh score for job {job_id}: {detail}.")

    @property
    def error_code(self) -> str:
        if self.reason == "requirement_fit_missing":
            return "REQUIREMENT_FIT_MISSING"
        return "REQUIREMENT_FIT_STALE"


@dataclass(frozen=True)
class ArtifactBudgetViolation:
    """One role whose mandatory achievement set cannot fit its bullet ceiling."""

    experience_entry_id: str
    role: str
    required_achievement_count: int
    ceiling: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "experience_entry_id": self.experience_entry_id,
            "role": self.role,
            "required_achievement_count": self.required_achievement_count,
            "ceiling": self.ceiling,
        }


class ArtifactBudgetInfeasibleError(ValueError):
    """Profile pins and required coverage cannot fit the configured artifact."""

    reason = "artifact_budget_infeasible"
    error_code = "ARTIFACT_BUDGET_INFEASIBLE"

    def __init__(self, violations: tuple[ArtifactBudgetViolation, ...]) -> None:
        if not violations:
            raise ValueError("ArtifactBudgetInfeasibleError requires a violation")
        self.violations = violations
        details = "; ".join(
            f"{item.role} ({item.experience_entry_id}) requires "
            f"{item.required_achievement_count} achievements but the ceiling is {item.ceiling}"
            for item in violations
        )
        super().__init__(f"Resume artifact budget is infeasible: {details}.")


def require_artifact_budget_feasible(profile: dict, plan: TailoringPlan) -> None:
    """Reject impossible per-role plans before any generator model is called.

    A single rendered bullet represents one canonical achievement. Explicit
    user pins and seeded requirement coverage are both mandatory, but an
    achievement that satisfies both consumes only one slot.
    """

    ceiling = get_max_experience_bullets(profile)
    experience_entries = {
        str(entry.get("id") or ""): entry for entry in get_experience_entries(profile) if str(entry.get("id") or "")
    }
    mandatory_by_entry: dict[str, set[str]] = {entry_id: set() for entry_id in experience_entries}
    evidence_by_id = plan.evidence_by_id

    for evidence_id in plan.required_evidence_ids:
        evidence = evidence_by_id.get(evidence_id)
        if evidence is not None and evidence.experience_entry_id in mandatory_by_entry:
            mandatory_by_entry[evidence.experience_entry_id].add(f"evidence:{evidence_id}")

    if plan.coverage_graph is not None:
        for edge in plan.coverage_graph.coverage_edges:
            evidence = evidence_by_id.get(edge.achievement_evidence_id)
            if evidence is not None and evidence.experience_entry_id in mandatory_by_entry:
                mandatory_by_entry[evidence.experience_entry_id].add(f"evidence:{edge.achievement_evidence_id}")

    pinned_bullets = plan.requirement_led_controls.required_content_pins.bullets_by_experience_id
    for entry_id, bullets in pinned_bullets.items():
        if entry_id not in mandatory_by_entry:
            continue
        for bullet in bullets:
            mapped = _select_required_evidence_ids(
                evidence_items=plan.evidence_items,
                required_bullets_by_experience_id={entry_id: [bullet]},
            )
            token = f"evidence:{mapped[0]}" if mapped else f"pinned:{_normalize_space(bullet).casefold()}"
            mandatory_by_entry[entry_id].add(token)

    required_roles = set(plan.requirement_led_controls.required_content_pins.experience_entry_ids)
    for entry_id in required_roles:
        if entry_id in mandatory_by_entry and not mandatory_by_entry[entry_id]:
            mandatory_by_entry[entry_id].add(f"positioning:{entry_id}")

    violations: list[ArtifactBudgetViolation] = []
    for entry_id, mandatory in mandatory_by_entry.items():
        if len(mandatory) <= ceiling:
            continue
        entry = experience_entries[entry_id]
        title = _normalize_space(str(entry.get("title") or ""))
        company = _normalize_space(str(entry.get("company") or ""))
        role = " — ".join(part for part in (company, title) if part) or entry_id
        violations.append(
            ArtifactBudgetViolation(
                experience_entry_id=entry_id,
                role=role,
                required_achievement_count=len(mandatory),
                ceiling=ceiling,
            )
        )
    if violations:
        raise ArtifactBudgetInfeasibleError(tuple(violations))


def build_tailoring_plan(
    profile: dict,
    job: dict,
    *,
    employer_analysis: EmployerAnalysis,
    requirement_fit_report: "RequirementFitReport | None" = None,
    job_interpretation,
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
    requirement_led_controls = adapt_requirement_led_controls(
        tailoring_policy=get_tailoring_policy(profile),
        writing_style=writing_style,
        revision_gates=get_revision_gates(profile),
        required_experience_entry_ids=tuple(get_required_experience_entry_ids(profile)),
        required_bullets_by_experience_id=get_required_bullets_by_experience_id(profile),
        required_skills_by_category_id=get_required_skills_by_category_id(profile),
        additional_guidance=get_custom_tailoring_prompt(profile),
    )
    evidence_items = (
        *tuple(_evidence_item(item) for item in get_achievement_evidence(profile) if item.get("user_confirmed")),
        *_canonical_fact_items(profile),
    )
    if requirement_fit_report is not None and not _requirement_fit_report_matches(
        requirement_fit_report,
        job,
        employer_analysis,
    ):
        job_id = canonical_job_id(str(job["job_id"]))
        report_job_id = getattr(requirement_fit_report, "job_id", None)
        report_generation = int(getattr(requirement_fit_report, "employer_analysis_generation", 0) or 0)
        raise TailoringPrerequisiteError(
            reason=(
                "requirement_fit_job_mismatch" if report_job_id != job_id else "requirement_fit_generation_mismatch"
            ),
            job_id=str(job_id),
            analysis_generation=employer_analysis.generation,
            report_generation=report_generation,
        )
    matched_requirement_fit_report = requirement_fit_report
    requirement_directives = _requirement_directive_items(
        requirement_fit_report=matched_requirement_fit_report,
        job=job,
        employer_analysis=employer_analysis,
        evidence_items=evidence_items,
        job_interpretation=job_interpretation,
    )
    directive_keywords = tuple(keyword for directive in requirement_directives for keyword in directive.target_keywords)
    job_keywords = _merge_keywords(directive_keywords, _analysis_job_keywords(employer_analysis))
    target_seniority = job_interpretation.seniority.value
    required_evidence_ids = _select_required_evidence_ids(
        evidence_items=evidence_items,
        required_bullets_by_experience_id=get_required_bullets_by_experience_id(profile),
    )
    verified_metrics = tuple(dict.fromkeys([metric for item in evidence_items for metric in item.metrics]))
    target_profile = build_target_profile(
        employer_analysis=employer_analysis,
        requirement_fit_report=matched_requirement_fit_report,
        job=job,
        evidence_items=evidence_items,
        pinned_evidence_ids=required_evidence_ids,
        job_interpretation=job_interpretation,
    )
    coverage_graph = seed_coverage_graph(
        target_profile=target_profile,
        requirement_fit_report=matched_requirement_fit_report,
    )

    return TailoringPlan(
        claim_mode=requirement_led_controls.claim_policy,
        auto_approvable_claim_modes=tuple(str(mode) for mode in controls.get("auto_approvable_claim_modes", [])),
        allow_adjacent_achievement_drafts=bool(controls.get("allow_adjacent_achievement_drafts", False)),
        writing_style=writing_style,
        target_seniority=target_seniority,
        job_keywords=job_keywords,
        required_evidence_ids=required_evidence_ids,
        verified_metrics=verified_metrics,
        evidence_items=evidence_items,
        requirement_directives=requirement_directives,
        prohibited_claims=_directive_prohibited_claims(requirement_directives),
        requirement_led_controls=requirement_led_controls,
        target_profile=target_profile,
        coverage_graph=coverage_graph,
    )


def build_tailoring_change_annotations(profile, job, tailored_payload, plan):
    return tuple(
        TailoringChangeAnnotation(
            section=str(item.get("location", "")).split(".")[0],
            label=str(item["line_id"]),
            change_type=str(item["transform_type"]),
            source_id=str(item["line_id"]),
            source_text=tuple(
                plan.evidence_by_id[ident].source_text
                for ident in item.get("evidence_ids", [])
                if ident in plan.evidence_by_id
            ),
            tailored_text=(str(item["text"]),),
            rationale=str(item["reason"]),
            evidence_ids=tuple(item.get("evidence_ids", [])),
            requirement_ids=tuple(item.get("requirement_ids", [])),
            coverage_edge_ids=tuple(item.get("coverage_edge_ids", [])),
            claim_labels=(str(item.get("claim_label", "")),),
            review_required=item.get("review_required") is True,
        )
        for item in tailored_payload.get("generated_claim_mappings", [])
    )


def evaluate_tailoring_quality(tailored_payload, tailored_text, plan):
    # Semantic quality belongs to the independent model judge and verifier.
    # This result contains only the exact declared inclusion bindings.
    mappings = tailored_payload.get("generated_claim_mappings") or []
    declared = {item for mapping in mappings for item in mapping.get("evidence_ids", [])}
    required = set(plan.required_evidence_ids)
    missing = required - declared
    return TailoringQualityResult(
        errors=("missing_required_evidence_binding",) if missing else (),
        represented_evidence_ids=tuple(sorted(required & declared)),
        missing_evidence_ids=tuple(sorted(missing)),
    )


def _evidence_item(item: dict) -> EvidencePlanItem:
    source_text = str(item.get("source_text", "")).strip()
    scope = str(item.get("scope", "")).strip()
    action = str(item.get("action", "")).strip()
    outcome = str(item.get("outcome", "")).strip()
    return EvidencePlanItem(
        evidence_id=str(item.get("id", "")).strip(),
        experience_entry_id=str(item.get("experience_entry_id", "")).strip(),
        source_text=source_text,
        scope=scope,
        action=action,
        tools=tuple(_text_list(item.get("tools"))),
        metrics=tuple(_text_list(item.get("metrics"))),
        outcome=outcome,
        evidence_strength=str(item.get("evidence_strength", "")).strip(),
        claim_confidence=float(item.get("claim_confidence") or 0.0),
        user_confirmed=bool(item.get("user_confirmed", False)),
        tags=tuple(_text_list(item.get("tags"))),
    )


def _canonical_fact_items(profile: dict) -> tuple[EvidencePlanItem, ...]:
    from jobctrl.domain.profile.canonical_sources import profile_sources

    canonical = {row.source_id: row.text for row in profile_sources(profile)}
    items = []
    for entry in get_experience_entries(profile):
        for index, bullet in enumerate(entry.get("bullets", [])):
            ident = f"experience:{entry['id']}:source:{index}"
            items.append(
                EvidencePlanItem(
                    evidence_id=ident,
                    experience_entry_id=entry["id"],
                    source_text=canonical[ident],
                    scope="",
                    action="",
                    user_confirmed=True,
                )
            )
    for ident, text in canonical.items():
        if (
            ident.startswith(("education:", "skills:", "experience:")) or ident == "executive_profile:baseline"
        ) and ":source:" not in ident:
            items.append(
                EvidencePlanItem(
                    evidence_id=ident,
                    experience_entry_id=ident,
                    source_text=text,
                    scope="",
                    action="",
                    user_confirmed=True,
                )
            )
    return tuple(items)


def _select_required_evidence_ids(*, evidence_items, required_bullets_by_experience_id):
    # A literal checkbox bullet binds only to its exact canonical source; code
    # does not guess an enriched evidence record by vocabulary overlap.
    selected = []
    for entry, bullets in required_bullets_by_experience_id.items():
        for bullet in bullets:
            matching = next(
                (
                    item.evidence_id
                    for item in evidence_items
                    if item.experience_entry_id == entry and item.source_text == bullet
                ),
                None,
            )
            if matching is not None and matching not in selected:
                selected.append(matching)
    return tuple(selected)


def _requirement_directive_items(
    *, requirement_fit_report, job, employer_analysis, job_interpretation, evidence_items=()
):
    if not _requirement_fit_report_matches(requirement_fit_report, job, employer_analysis):
        return ()
    requirements = {item.id: item for item in employer_analysis.canonical.requirements}
    interpretations = {item.requirement_id: item for item in job_interpretation.requirements}
    items = []
    for assessment in requirement_fit_report.assessments:
        ident = assessment.requirement_id
        if ident not in requirements or ident not in interpretations:
            from jobctrl.domain.determinations import DeterminationFailure

            raise DeterminationFailure("foreign_requirement_id")
        requirement, interpretation = requirements[ident], interpretations[ident]
        directive, fit = assessment.tailoring, assessment.fit
        coverable = interpretation.scope == "resume" and not interpretation.protected_class
        items.append(
            RequirementDirectivePlanItem(
                requirement_id=ident,
                requirement_text=requirement.text,
                tier=assessment.tier,
                weight=assessment.weight,
                fit_kind=fit.kind,
                action=directive.action if coverable else "context_only",
                coverage_scope=interpretation.scope,
                priority=directive.priority,
                allowed_evidence_ids=tuple(directive.allowed_evidence_ids) if coverable else (),
                target_keywords=tuple(directive.target_keywords) if coverable else (),
                prohibited_claims=tuple(directive.prohibited_claims),
                instruction=directive.instruction,
            )
        )
    return tuple(sorted(items, key=lambda item: (-item.priority, -item.weight, item.requirement_id)))


def _requirement_fit_report_matches(
    requirement_fit_report: "RequirementFitReport | None",
    job: dict,
    employer_analysis: EmployerAnalysis,
) -> bool:
    if requirement_fit_report is None:
        return False
    job_id = canonical_job_id(str(job["job_id"]))
    if getattr(requirement_fit_report, "job_id", None) != job_id:
        return False
    generation = int(getattr(requirement_fit_report, "employer_analysis_generation", 0) or 0)
    return generation == employer_analysis.generation


def _directive_prohibited_claims(
    directives: tuple[RequirementDirectivePlanItem, ...],
) -> tuple[str, ...]:
    claims: list[str] = []
    for directive in directives:
        if directive.action not in {"avoid_claim", "context_only"}:
            continue
        claims.extend(directive.prohibited_claims)
    return tuple(dict.fromkeys(_normalize_space(claim) for claim in claims if claim))


def _merge_keywords(
    preferred: tuple[str, ...],
    fallback: tuple[str, ...],
) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(normalized for keyword in [*preferred, *fallback] if (normalized := _normalize_phrase(keyword)))
    )[:32]


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


def _normalize_phrase(value: str) -> str:
    return str(value).strip()


def _normalize_space(value: str) -> str:
    return " ".join(str(value or "").split())


def _text_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]
