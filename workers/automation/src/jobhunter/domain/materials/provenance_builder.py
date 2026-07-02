"""Compute canonical per-bullet provenance against the GENERATED resume text (Phase 2).

The Phase-2 write-side computation: given the SELECTED tailored payload, the
profile, the deterministic :class:`TailoringPlan`, and the persisted
:class:`EmployerAnalysis`, emit one :class:`BulletProvenance` row per rendered
bullet — computed against the **actual generated bullet text** the assembler
produces, never inferred from the job description (the auditability rule /
Anti-Pattern 2).

Design (Patterns 2 + 3 from the architecture research):

  * Reuse the existing ``resume_profile`` rendering helpers
    (``tailored_experience_*`` / ``tailored_skill_items``) so a row's
    ``generated_text`` is byte-identical to what ``ResumeAssembler`` renders —
    the row is a true coverage anchor.
  * Map the existing annotation ``change_type`` vocabulary to the closed
    :class:`TransformType` taxonomy (GROUND-04).
  * Bind ``requirement_ids`` as real foreign keys into the persisted analysis
    requirements by matching the bullet text against each requirement's keywords
    (verified against generated text, GROUND-02). ``matched_keywords`` are the
    analysis keywords actually present in the line.
  * Resolve the governing :class:`ControlRule` per bullet from the transform +
    the active claim mode (Pattern 3 / CONTROL-02).
  * Validate every ``evidence_id`` / ``requirement_id`` against the real profile
    + analysis BEFORE constructing a row — a fabricated id raises
    :class:`ProvenanceBindingError` (GROUND-05: FK bindings, not free text).

This module is pure (no I/O, no LLM). Persistence + the deterministic
never-fabricate token gate live in their own modules.
"""

from __future__ import annotations

from dataclasses import dataclass

from jobhunter.domain.materials.analysis import EmployerAnalysis
from jobhunter.domain.materials.provenance import BulletProvenance
from jobhunter.domain.materials.quality import (
    TailoringPlan,
    _contains_term,
    _normalize_phrase,
    _normalize_space,
)
from jobhunter.domain.materials.services import sanitize_text
from jobhunter.domain.materials.value_objects import ControlRule, TransformType
from jobhunter.resume_profile import (
    experience_updates_by_id,
    get_claim_mode,
    get_experience_entries,
    get_required_experience_entry_ids,
    get_required_skill_category_ids,
    get_resume_master,
    get_skill_categories,
    get_tailoring_policy,
    tailored_experience_bullets,
    tailored_experience_title,
    tailored_skill_items,
)

# Map the annotation/profile ``change_type`` vocabulary to the closed taxonomy.
# Anything reframed-for-the-job is a REFRAME; a pure reword is a REPHRASE; an
# unchanged line is VERBATIM. SYNTHESIZE_FROM_RELATED and QUANTIFY_FROM_EVIDENCE
# are decided contextually below (adjacent drafts / metric introduction).
_CHANGE_TYPE_TO_TRANSFORM: dict[str, TransformType] = {
    "summary_reframed": TransformType.REFRAME,
    "summary_preserved": TransformType.VERBATIM,
    "title_and_achievement_reframed": TransformType.REFRAME,
    "title_reframed": TransformType.REFRAME,
    "achievement_reframed": TransformType.REFRAME,
    "experience_preserved": TransformType.VERBATIM,
    "skills_reordered": TransformType.REPHRASE,
    "skills_preserved": TransformType.VERBATIM,
}


def _rendered_line(text: str) -> str:
    """Render one line EXACTLY as ``ResumeAssembler`` ships it (Pattern 2 / GROUND-06).

    The assembler applies :func:`sanitize_text` to every summary/bullet/skill line
    it renders (``services.py`` ``_assemble_resume_text``), which rewrites smart
    punctuation — curly quotes ``’“”`` to ASCII and em/en dashes to commas/hyphens.
    Provenance is a coverage anchor only when its ``generated_text`` is
    byte-identical to that shipped line, so the row — and the deterministic
    never-fabricate detector that scans it — sees the text the user actually
    received, not the model's pre-sanitised draft.

    Keyword/FK matching is unaffected: every match path runs through
    :func:`_normalize_phrase` (``_WORD_RE``), which already strips quote forms, so
    ``team’s`` and ``team's`` normalise identically.
    """
    return _normalize_space(sanitize_text(text))


class ProvenanceBindingError(ValueError):
    """Raised when a provenance row would reference a non-existent id (GROUND-05).

    Provenance is canonical FK bindings, not model-authored free text: an
    ``evidence_id`` that is not a real profile evidence item, or a
    ``requirement_id`` that is not in the persisted analysis, is rejected before
    any row is constructed — proving the binding could only ever name real data.
    """

    def __init__(self, kind: str, bad_ids: tuple[str, ...]) -> None:
        self.kind = kind
        self.bad_ids = bad_ids
        super().__init__(
            f"provenance referenced {len(bad_ids)} fabricated {kind} id(s): {', '.join(bad_ids)}"
        )


@dataclass(frozen=True)
class _Sources:
    """Pre-extracted lookup sets the builder validates bindings against."""

    valid_evidence_ids: frozenset[str]
    valid_requirement_ids: frozenset[str]


def _sources(plan: TailoringPlan, analysis: EmployerAnalysis) -> _Sources:
    return _Sources(
        valid_evidence_ids=frozenset(item.evidence_id for item in plan.evidence_items if item.evidence_id),
        valid_requirement_ids=frozenset(req.id for req in analysis.canonical.requirements if req.id),
    )


def _validated_evidence_ids(candidate: tuple[str, ...], sources: _Sources) -> tuple[str, ...]:
    bad = tuple(eid for eid in candidate if eid not in sources.valid_evidence_ids)
    if bad:
        raise ProvenanceBindingError("evidence", bad)
    return candidate


def _validated_requirement_ids(candidate: tuple[str, ...], sources: _Sources) -> tuple[str, ...]:
    bad = tuple(rid for rid in candidate if rid not in sources.valid_requirement_ids)
    if bad:
        raise ProvenanceBindingError("requirement", bad)
    return candidate


def _served_requirements(
    generated_lower: str,
    analysis: EmployerAnalysis,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return (requirement_ids, matched_keywords) the generated line actually serves.

    A requirement is served when one of its analysis keywords (or its own text
    terms) appears verbatim in the rendered bullet — verified against generated
    text (GROUND-02), never assumed from the job description. ``matched_keywords``
    are the reasoned analysis keywords present in the line.
    """
    keywords_by_requirement: dict[str, list[str]] = {}
    for keyword in analysis.canonical.keywords:
        ref = keyword.requirement_ref
        if ref:
            keywords_by_requirement.setdefault(ref, []).append(keyword.keyword)

    served: list[str] = []
    matched: list[str] = []
    for requirement in analysis.canonical.requirements:
        req_keywords = keywords_by_requirement.get(requirement.id, [])
        hit_keywords = [kw for kw in req_keywords if _contains_term(generated_lower, kw)]
        text_hit = _contains_term(generated_lower, requirement.text) if not hit_keywords else False
        if hit_keywords or text_hit:
            served.append(requirement.id)
            matched.extend(hit_keywords)

    # Also surface keywords whose requirement_ref is unset/orphan but appear in
    # the line — useful audit signal even without a requirement to bind.
    for keyword in analysis.canonical.keywords:
        if not keyword.requirement_ref and _contains_term(generated_lower, keyword.keyword):
            matched.append(keyword.keyword)

    return (
        tuple(dict.fromkeys(served)),
        tuple(dict.fromkeys(_normalize_phrase(kw) for kw in matched if _normalize_phrase(kw))),
    )


def _resolve_control(transform: TransformType, *, claim_mode: str) -> ControlRule:
    """Resolve the governing control rule for a bullet (Pattern 3 / CONTROL-02).

    The control answers "which rule produced THIS line":
      * a metric surfaced from evidence is governed by never-fabricate-metrics;
      * a draft from closely-related experience is governed by
        invent-closely-related;
      * everything else (verbatim/rephrase/reframe of a real fact) is governed by
        the always-allowed rephrase rule.
    """
    if transform is TransformType.QUANTIFY_FROM_EVIDENCE:
        return ControlRule.NEVER_FABRICATE_METRICS
    if transform is TransformType.SYNTHESIZE_FROM_RELATED:
        return ControlRule.INVENT_CLOSELY_RELATED
    return ControlRule.REPHRASE_ALLOWED


def _bullet_transform(
    source_text: str,
    generated_text: str,
    *,
    base: TransformType,
    plan: TailoringPlan,
) -> TransformType:
    """Refine the section-level transform for one concrete bullet.

    A bullet that introduces a metric (a metric appears in the generated line but
    not the source line) is a QUANTIFY_FROM_EVIDENCE; a brand-new bullet with no
    source counterpart, permitted only under adjacent-draft policy, is a
    SYNTHESIZE_FROM_RELATED; otherwise the section-level base transform stands.
    """
    generated_lower = _normalize_space(generated_text).lower()
    source_lower = _normalize_space(source_text).lower()

    if (
        not source_lower
        and plan.requirement_led_controls.claim_policy == "draft_requires_confirmation"
    ):
        return TransformType.SYNTHESIZE_FROM_RELATED

    introduced_metrics = [
        metric
        for metric in plan.verified_metrics
        if metric and metric.lower() in generated_lower and metric.lower() not in source_lower
    ]
    if introduced_metrics:
        return TransformType.QUANTIFY_FROM_EVIDENCE
    return base


def _evidence_ids_for_entry(plan: TailoringPlan, entry_id: str, generated_lower: str) -> tuple[str, ...]:
    """Profile evidence ids that belong to an experience entry and are represented."""
    ids: list[str] = []
    for item in plan.evidence_items:
        if item.experience_entry_id != entry_id:
            continue
        represented = (
            item.evidence_id in plan.required_evidence_ids
            or item.evidence_id in plan.seniority_evidence_ids
            or (item.evidence_id and item.evidence_id.lower() in generated_lower)
        )
        if represented:
            ids.append(item.evidence_id)
    return tuple(dict.fromkeys(eid for eid in ids if eid))


def build_bullet_provenance(
    profile: dict,
    job: dict,
    tailored_payload: dict,
    plan: TailoringPlan,
    analysis: EmployerAnalysis,
) -> tuple[BulletProvenance, ...]:
    """Compute one :class:`BulletProvenance` per rendered resume line.

    The bullets are rendered with the same helpers ``ResumeAssembler`` uses, so
    each ``generated_text`` is exactly the line the user sees. ``bullet_id`` is
    stable within ``(section, source, index)``. All evidence/requirement bindings
    are validated against the real profile + analysis (GROUND-05) before a row is
    built.
    """
    sources = _sources(plan, analysis)
    claim_mode = get_claim_mode(profile)
    resume = get_resume_master(profile)
    rows: list[BulletProvenance] = []

    # ---- Executive profile (single line) --------------------------------
    # The shipped summary is policy-gated EXACTLY as the assembler renders it
    # (``services.py`` ``assemble_resume_text``): when ``allow_summary_rewrite``
    # is off the resume ships the profile baseline, not the model's proposed
    # rewrite. Provenance must anchor to the SHIPPED line — computing it against
    # the never-rendered rewrite would break the "generated_text is byte-identical
    # to what ResumeAssembler renders" invariant (Pattern 2 / GROUND-06) and feed
    # the deterministic detector text that never reaches the user.
    baseline_summary = _rendered_line(
        str(resume.get("executive_profile", {}).get("baseline_text", ""))
    )
    allow_summary_rewrite = bool(get_tailoring_policy(profile)["allow_summary_rewrite"])
    proposed_summary = _rendered_line(str(tailored_payload.get("executive_profile") or ""))
    shipped_summary = proposed_summary if allow_summary_rewrite else baseline_summary
    if shipped_summary:
        base = (
            TransformType.REFRAME
            if _normalize_phrase(baseline_summary) != _normalize_phrase(shipped_summary)
            else TransformType.VERBATIM
        )
        transform = _bullet_transform(baseline_summary, shipped_summary, base=base, plan=plan)
        served, matched = _served_requirements(shipped_summary.lower(), analysis)
        evidence_ids = _validated_evidence_ids(
            tuple(plan.seniority_evidence_ids[:6]), sources
        )
        rows.append(
            BulletProvenance(
                bullet_id="executive_profile#0",
                section="executive_profile",
                source_id="executive_profile",
                evidence_ids=evidence_ids,
                requirement_ids=_validated_requirement_ids(served, sources),
                matched_keywords=matched,
                transform_type=transform,
                control=_resolve_control(transform, claim_mode=claim_mode),
                rationale=_summary_rationale(plan, transform, matched),
                generated_text=shipped_summary,
            )
        )

    # ---- Experience bullets (one row per rendered bullet) ----------------
    # Audit only the entries the resume ships: mirror the assembler + both PDF
    # renderers, which drop entries outside a pinned strict subset. Auditing an
    # omitted entry would inflate the provenance-backed coverage with content the
    # employer never receives.
    experience_updates = experience_updates_by_id(tailored_payload)
    required_experience_ids = get_required_experience_entry_ids(profile)
    all_experience_entries = get_experience_entries(profile)
    experience_entries = [
        entry
        for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    for entry in experience_entries:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "")
        update = experience_updates.get(entry_id, {})
        source_bullets = [str(b).strip() for b in (entry.get("bullets") or []) if str(b).strip()]
        tailored_bullets = tailored_experience_bullets(entry, update, profile)
        for index, bullet in enumerate(tailored_bullets):
            generated_text = _rendered_line(str(bullet))
            if not generated_text:
                continue
            source_text = source_bullets[index] if index < len(source_bullets) else ""
            base = (
                TransformType.VERBATIM
                if _normalize_phrase(source_text) == _normalize_phrase(generated_text)
                else TransformType.REPHRASE
                if source_text
                else TransformType.SYNTHESIZE_FROM_RELATED
            )
            # If the entry title was reframed for the job, mark a job-reframe.
            if base is TransformType.REPHRASE and _entry_title_reframed(entry, update, profile):
                base = TransformType.REFRAME
            transform = _bullet_transform(source_text, generated_text, base=base, plan=plan)
            generated_lower = generated_text.lower()
            served, matched = _served_requirements(generated_lower, analysis)
            evidence_ids = _validated_evidence_ids(
                _evidence_ids_for_entry(plan, entry_id, generated_lower), sources
            )
            rows.append(
                BulletProvenance(
                    bullet_id=f"experience:{entry_id}#{index}",
                    section="experience",
                    source_id=entry_id,
                    evidence_ids=evidence_ids,
                    requirement_ids=_validated_requirement_ids(served, sources),
                    matched_keywords=matched,
                    transform_type=transform,
                    control=_resolve_control(transform, claim_mode=claim_mode),
                    rationale=_experience_rationale(entry, transform, matched),
                    generated_text=generated_text,
                )
            )

    # ---- Skills (one row per rendered category line) ---------------------
    # Audit only the categories the resume ships: mirror the assembler + both PDF
    # renderers, which drop categories outside a pinned strict subset. Auditing an
    # omitted category would inflate the provenance-backed coverage with content the
    # employer never receives.
    skill_updates = {
        str(update.get("id")): update
        for update in tailored_payload.get("skill_category_updates") or []
        if isinstance(update, dict) and update.get("id")
    }
    required_skill_ids = get_required_skill_category_ids(profile)
    all_skill_categories = get_skill_categories(profile)
    skill_categories = [
        category
        for category in all_skill_categories
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories
    for category in skill_categories:
        if not isinstance(category, dict):
            continue
        category_id = str(category.get("id") or "")
        update = skill_updates.get(category_id, {})
        source_items = [str(i).strip() for i in (category.get("items") or []) if str(i).strip()]
        tailored_items = tailored_skill_items(category, update, profile)
        if not tailored_items:
            continue
        # Mirror the assembler's per-item ``sanitize_text`` + filter so the skills
        # line is byte-identical to what ``ResumeAssembler`` ships (the label is
        # code-injected profile data and is rendered raw there, so it stays raw).
        sanitized_items = [sanitize_text(str(i)) for i in tailored_items if str(i).strip()]
        generated_text = _normalize_space(
            f"{category.get('label', 'Skills')}: {', '.join(sanitized_items)}"
        )
        reordered = [_normalize_phrase(i) for i in tailored_items] != [
            _normalize_phrase(i) for i in source_items
        ]
        transform = TransformType.REPHRASE if reordered else TransformType.VERBATIM
        served, matched = _served_requirements(generated_text.lower(), analysis)
        rows.append(
            BulletProvenance(
                bullet_id=f"skills:{category_id}#0",
                section="skills",
                source_id=category_id,
                evidence_ids=(),
                requirement_ids=_validated_requirement_ids(served, sources),
                matched_keywords=matched,
                transform_type=transform,
                control=_resolve_control(transform, claim_mode=claim_mode),
                rationale=_skills_rationale(transform, matched),
                generated_text=generated_text,
            )
        )

    return tuple(rows)


def _entry_title_reframed(entry: dict, update: dict, profile: dict) -> bool:
    source_title = _normalize_phrase(str(entry.get("title") or ""))
    tailored_title = _normalize_phrase(tailored_experience_title(entry, update, profile))
    return bool(tailored_title) and tailored_title != source_title


def _matched_phrase(matched: tuple[str, ...]) -> str:
    return ", ".join(matched[:5])


def _summary_rationale(plan: TailoringPlan, transform: TransformType, matched: tuple[str, ...]) -> str:
    signals = _matched_phrase(matched)
    if transform is TransformType.VERBATIM:
        return "Executive profile is the profile baseline, unchanged under the selected controls."
    base = (
        f"Executive profile was {transform.value.replace('_', ' ')} for a "
        f"{plan.target_seniority} target using {plan.requirement_led_controls.claim_policy}"
    )
    return f"{base}; it serves the job signals {signals}." if signals else f"{base}."


def _experience_rationale(entry: dict, transform: TransformType, matched: tuple[str, ...]) -> str:
    company = str(entry.get("company") or "this experience").strip()
    signals = _matched_phrase(matched)
    verb = {
        TransformType.VERBATIM: "carried in verbatim from the profile",
        TransformType.REPHRASE: "reworded from a real profile bullet",
        TransformType.REFRAME: "re-angled toward the target role",
        TransformType.SYNTHESIZE_FROM_RELATED: "drafted from closely-related profile evidence",
        TransformType.QUANTIFY_FROM_EVIDENCE: "surfaced a metric recorded in profile evidence",
    }[transform]
    if signals:
        return f"{company} bullet was {verb}; it serves the job signals {signals}."
    return f"{company} bullet was {verb}."


def _skills_rationale(transform: TransformType, matched: tuple[str, ...]) -> str:
    signals = _matched_phrase(matched)
    if transform is TransformType.VERBATIM:
        return "Skill category is preserved from the profile under the selected controls."
    if signals:
        return f"Skill ordering highlights job-matching signals ({signals}) while preserving profile skills."
    return "Skill ordering was adjusted while preserving the profile skill category."


__all__ = [
    "ProvenanceBindingError",
    "build_bullet_provenance",
]
