"""Requirement-led tailoring domain model and policy tests."""

from __future__ import annotations

import pytest

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.policy import (
    DEFAULT_REQUIREMENT_LED_REVISION_GATES,
    REQUIREMENT_LED_TAILORING_POLICY_VERSION,
    RevisionGatePolicy,
    adapt_requirement_led_controls,
)
from jobctrl.domain.materials.provenance import BulletProvenance
from jobctrl.domain.materials.claim_grounding import (
    GROUNDED_COVERAGE_BASIS,
    ground_claim_mappings,
)
from jobctrl.domain.materials.quality import build_tailoring_plan
from jobctrl.domain.materials.requirement_coverage import (
    AchievementNode,
    CoverageEdge,
    CoverageGraph,
    GeneratedClaimMapping,
    RequirementNode,
    TargetProfile,
    TargetRequirement,
    UncoveredRequirement,
    UnusedAchievement,
    apply_coverage_planner_response,
    append_enhancement_claim_mappings,
    bullet_limit_overflows,
    build_coverage_planner_prompt,
    classify_requirement_coverage_scope,
    decide_score_gated_revision,
    resolve_requirement_coverage_scope,
    score_generated_resume_against_target,
    validate_coverage_graph,
    validate_generated_claim_mappings,
    validate_mandatory_covered_achievements,
    validate_metric_support,
    validate_pinned_content_preserved,
    validate_prohibited_claims,
)
from jobctrl.domain.materials.use_cases import (
    _claim_mapping_validation_errors,
    _post_generation_fit_gate,
)
from jobctrl.domain.materials.value_objects import ControlRule, TransformType
from jobctrl.domain.scoring import (
    FitScore,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
)
from jobctrl.domain.tenant import LOCAL_TENANT

_JOB_ID = canonical_job_id("40000000-0000-4000-8000-000000000001")


def _employer_analysis(*keywords: str) -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[],
        keywords=[ReasonedKeyword(keyword=term, evidence_span=term) for term in keywords],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(" ".join(keywords) or "jd"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _requirement_analysis() -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[
            Requirement(
                id="req_python",
                text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                evidence_span="Own Python API reliability.",
            ),
            Requirement(
                id="req_salesforce",
                text="Administer Salesforce.",
                tier="must_have",
                weight=0.8,
                evidence_span="Administer Salesforce.",
            ),
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Python API reliability",
                evidence_span="Python API reliability",
                requirement_ref="req_python",
            ),
            ReasonedKeyword(
                keyword="Salesforce administration",
                evidence_span="Salesforce administration",
                requirement_ref="req_salesforce",
            ),
        ],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash("Python API Salesforce"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _requirement_fit_report(
    *,
    python_fit: RequirementFitStatus | None = None,
    salesforce_fit: RequirementFitStatus | None = None,
) -> RequirementFitReport:
    python_fit = python_fit or RequirementFitStatus(
        kind="matched",
        evidence_ids=("ev_latency",),
        strength="direct",
    )
    salesforce_fit = salesforce_fit or RequirementFitStatus(
        kind="missing",
        reason="No grounded Salesforce evidence.",
    )
    return RequirementFitReport(
        job_id=_JOB_ID,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(7),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=0.7, must_have_coverage=0.5),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_python",
                requirement_text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                job_evidence_span="Own Python API reliability.",
                fit=python_fit,
                contribution=RequirementScoreContribution(
                    max_points=1.125,
                    awarded_points=1.125 if python_fit.kind == "matched" else 0.6,
                    weighted_impact=1.125,
                ),
                tailoring=RequirementTailoringDirective(
                    action="double_down",
                    priority=0.9,
                    allowed_evidence_ids=python_fit.evidence_ids,
                    target_keywords=("Python API reliability",),
                ),
            ),
            RequirementFitAssessment(
                requirement_id="req_salesforce",
                requirement_text="Administer Salesforce.",
                tier="must_have",
                weight=0.8,
                job_evidence_span="Administer Salesforce.",
                fit=salesforce_fit,
                contribution=RequirementScoreContribution(
                    max_points=1.0,
                    awarded_points=0.0,
                    weighted_impact=0.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="avoid_claim",
                    priority=0.8,
                    prohibited_claims=("Administer Salesforce.",),
                ),
            ),
        ),
    )


def _profile() -> dict:
    return {
        "personal": {"full_name": "Jane Doe", "email": "jane@example.com"},
        "resume_constraints": {"real_metrics": ["35% latency reduction"]},
        "resume": {
            "executive_profile": {"baseline_text": "Senior backend engineer."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": ["Reduced API latency 35% by replacing synchronous calls."],
                    "achievement_evidence": [
                        {
                            "id": "ev_latency",
                            "source_text": "Reduced API latency 35% by replacing synchronous enrichment calls.",
                            "scope": "owned service",
                            "action": "replaced synchronous enrichment calls",
                            "tools": ["Python", "PostgreSQL"],
                            "metrics": ["35% latency reduction"],
                            "outcome": "faster API responses",
                            "seniority_signal": "technical ownership",
                            "evidence_strength": "verified",
                            "claim_confidence": 0.95,
                            "user_confirmed": True,
                            "tags": ["latency", "backend", "performance"],
                        }
                    ],
                }
            ],
            "education_entries": [
                {
                    "id": "edu_state",
                    "degree": "BSc CS",
                    "institution": "State University",
                    "location": "City",
                    "date": "2015",
                }
            ],
            "skill_categories": [
                {"id": "languages", "label": "Languages", "items": ["Python", "Go"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
                "tailoring_policy": {
                    "claim_mode": "evidence_reframing",
                    "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
                },
                "writing_style": {
                    "tone": "direct",
                    "bullet_style": "leadership",
                    "verbosity": "concise",
                    "keyword_density": "natural",
                },
            },
        },
    }


def _senior_job() -> dict:
    return {
        "job_id": str(_JOB_ID),
        "url": "https://example.com/senior-backend",
        "title": "Senior Backend Engineer",
        "skills": ["Python", "PostgreSQL", "API performance"],
        "responsibilities": ["Own latency improvements for backend services"],
        "full_description": "Own Python backend services and improve API latency.",
    }


def test_revision_gate_policy_defaults_are_versioned_and_bounded() -> None:
    assert DEFAULT_REQUIREMENT_LED_REVISION_GATES.min_fit_score == 8
    assert DEFAULT_REQUIREMENT_LED_REVISION_GATES.must_have_coverage == 0.85
    assert DEFAULT_REQUIREMENT_LED_REVISION_GATES.max_revision_attempts == 1
    assert RevisionGatePolicy(min_fit_score="9", must_have_coverage="0.9").to_dict() == {
        "min_fit_score": 9,
        "must_have_coverage": 0.9,
        "max_revision_attempts": 1,
    }

    with pytest.raises(ValueError):
        RevisionGatePolicy(min_fit_score=11)
    with pytest.raises(ValueError):
        RevisionGatePolicy(must_have_coverage=1.1)
    with pytest.raises(ValueError):
        RevisionGatePolicy(max_revision_attempts=-1)


def test_legacy_tailoring_mode_migrates_missing_controls_without_runtime_mode_authority() -> None:
    migrated = adapt_requirement_led_controls(
        tailoring_policy={"mode": "strict"},
        writing_style={"keyword_density": "high"},
    )

    assert migrated.claim_policy == "verified_only"
    assert migrated.generation_permissions.preserve_titles is True
    assert migrated.generation_permissions.rewrite_summary is False
    assert "mode" not in migrated.to_dict()
    assert "tailoring_mode" not in migrated.to_dict()


def test_explicit_claim_policy_wins_over_legacy_tailoring_mode() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={
            "mode": "strict",
            "allow_title_reframing": True,
            "allow_summary_rewrite": True,
            "allow_achievement_rewriting": True,
            "allow_skill_reordering": True,
            "allow_minor_inference": True,
            "claim_mode": "draft_requires_confirmation",
            "auto_approvable_claim_modes": ["verified_only", "draft_requires_confirmation"],
            "allow_adjacent_achievement_drafts": True,
        },
        writing_style={"keyword_density": "high"},
        required_experience_entry_ids=("role_1",),
        required_bullets_by_experience_id={"role_1": ("Pinned bullet.",)},
        required_skills_by_category_id={"skills": ("Python",)},
        revision_gates={
            "min_fit_score": 9,
            "must_have_coverage": 0.9,
            "max_revision_attempts": 2,
        },
        additional_guidance="Use backend positioning.",
    )

    serialized = controls.to_dict()
    assert controls.policy_version == REQUIREMENT_LED_TAILORING_POLICY_VERSION
    assert controls.claim_policy == "draft_requires_confirmation"
    assert controls.generation_permissions.preserve_titles is True
    assert controls.generation_permissions.rewrite_summary is True
    assert controls.required_content_pins.experience_entry_ids == ("role_1",)
    assert controls.writing_style.keyword_emphasis == "high"
    assert controls.revision_gates.min_fit_score == 9
    assert controls.revision_gates.must_have_coverage == 0.9
    assert controls.revision_gates.max_revision_attempts == 2
    assert controls.additional_guidance == "Use backend positioning."
    assert "mode" not in serialized
    assert "tailoring_mode" not in serialized


def test_minor_inference_and_adjacent_drafts_migrate_to_claim_policy() -> None:
    adjacent = adapt_requirement_led_controls(
        tailoring_policy={"allow_minor_inference": True},
        writing_style={},
    )
    draft = adapt_requirement_led_controls(
        tailoring_policy={"allow_adjacent_achievement_drafts": True},
        writing_style={},
    )

    assert adjacent.claim_policy == "adjacent_translation"
    assert draft.claim_policy == "draft_requires_confirmation"
    assert draft.auto_approval_policy.draft_claims_require_confirmation is True


def test_tailoring_plan_carries_requirement_led_control_model() -> None:
    profile = _profile()
    profile["resume"]["tailoring_rules"]["custom_tailoring_prompt"] = "Prefer reliability impact."
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {
        "claim_mode": "evidence_reframing",
        "allow_title_reframing": True,
    }

    plan = build_tailoring_plan(
        profile,
        _senior_job(),
        employer_analysis=_employer_analysis("python", "latency"),
    )

    controls = plan.requirement_led_controls
    assert controls.claim_policy == "evidence_reframing"
    assert controls.generation_permissions.preserve_titles is True
    assert controls.additional_guidance == "Prefer reliability impact."
    prompt_dict = plan.to_prompt_dict()
    metadata = plan.to_metadata()
    assert prompt_dict["requirement_led_controls"]["policy_version"] == 2
    assert "mode" not in prompt_dict["requirement_led_controls"]
    assert "claim_mode" not in prompt_dict
    assert "auto_approvable_claim_modes" not in prompt_dict
    assert "allow_adjacent_achievement_drafts" not in prompt_dict
    assert "allow_adjacent_achievement_drafts" not in metadata


def test_target_profile_adapter_uses_analysis_fit_and_profile_evidence() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    target_profile = plan.target_profile

    assert target_profile is not None
    assert target_profile.job_id == str(_JOB_ID)
    assert target_profile.target_role == "Senior Backend Engineer"
    assert target_profile.seniority == "senior"
    assert [item.requirement_id for item in target_profile.must_have_requirements] == [
        "req_python",
        "req_salesforce",
    ]
    assert target_profile.must_have_requirements[0].keywords == (
        "python api reliability",
    )
    assert target_profile.must_have_requirements[0].fit_kind == "matched"
    assert target_profile.must_have_requirements[1].prohibited_claims == (
        "Administer Salesforce.",
    )
    assert target_profile.profile_achievements[0].achievement_evidence_id == "ev_latency"
    assert target_profile.profile_achievements[0].pinned is True
    assert "python api reliability" in target_profile.ats_keywords


@pytest.mark.parametrize(
    ("requirement_text", "expected_scope"),
    (
        (
            "Able to work a hybrid setup from the assigned city (3 days a week in the office).",
            "logistics",
        ),
        ("This role is remote within Spain.", "logistics"),
        ("Must be willing to travel up to 25%.", "logistics"),
        ("This position requires on-site presence three days weekly.", "logistics"),
        ("Hybrid, three days in our office.", "logistics"),
        ("Attend the office 3 days each week.", "logistics"),
        ("The role includes 25% travel.", "logistics"),
        ("Must be authorized to work in Spain without visa sponsorship.", "eligibility"),
        ("Offer includes a salary range from EUR 100k to EUR 120k.", "employer_condition"),
        ("5+ years building distributed systems in Python.", "resume"),
        ("Experience leading remote engineering teams.", "resume"),
        ("Experience designing hybrid cloud infrastructure.", "resume"),
        ("Build executive sponsorship for strategic transformation initiatives.", "resume"),
        ("Secure senior stakeholder sponsorship for the platform migration.", "resume"),
    ),
)
def test_requirement_coverage_scope_separates_context_from_resume_evidence(
    requirement_text: str,
    expected_scope: str,
) -> None:
    assert classify_requirement_coverage_scope(requirement_text) == expected_scope


def test_requirement_coverage_scope_combines_ensemble_semantics_with_safety_override() -> None:
    assert (
        resolve_requirement_coverage_scope(
            "Join quarterly team gatherings in the assigned region.",
            "logistics",
        )
        == "logistics"
    )
    assert (
        resolve_requirement_coverage_scope(
            "Hybrid work arrangement with three office days per week.",
            "resume",
        )
        == "logistics"
    )
    assert (
        resolve_requirement_coverage_scope(
            "Experience designing hybrid cloud infrastructure.",
            "resume",
        )
        == "resume"
    )
    assert (
        resolve_requirement_coverage_scope(
            "Secure senior stakeholder sponsorship for the platform migration.",
            "eligibility",
        )
        == "resume"
    )


@pytest.mark.parametrize(
    ("requirement_text", "undeclared_scope"),
    (
        (
            "Deep experience with Visa and Mastercard payment network integrations.",
            "eligibility",
        ),
        ("Experience with card scheme rules (Visa, Mastercard).", "eligibility"),
        (
            "Experience running a healthy on-call rotation and incident response program.",
            "logistics",
        ),
        ("Experience with high-throughput drug screening assays.", "eligibility"),
        (
            "Manage employee relocation programs for our global mobility team.",
            "logistics",
        ),
        ("Own background check vendor integrations for our HR platform.", "eligibility"),
    ),
)
def test_declared_resume_scope_survives_ambiguous_keyword_patterns(
    requirement_text: str,
    undeclared_scope: str,
) -> None:
    """A bare keyword match must not override the ensemble's resume judgment."""

    assert resolve_requirement_coverage_scope(requirement_text, "resume") == "resume"
    # Without an ensemble declaration the conservative keyword reading stands
    # (compatibility path for historical analyses).
    assert resolve_requirement_coverage_scope(requirement_text, None) == undeclared_scope
    assert classify_requirement_coverage_scope(requirement_text) == undeclared_scope


@pytest.mark.parametrize(
    ("requirement_text", "expected_scope"),
    (
        ("Must pass a background check before starting.", "eligibility"),
        ("Employment is contingent on completing a background check.", "eligibility"),
        ("This role requires a drug screening.", "eligibility"),
        ("Candidates need a valid work visa; visa sponsorship is not available.", "eligibility"),
        ("Participate in the on-call rotation, including weekends.", "logistics"),
        ("Must be willing to relocate to Berlin.", "logistics"),
    ),
)
def test_unmistakable_conditions_override_erroneous_resume_declaration(
    requirement_text: str,
    expected_scope: str,
) -> None:
    """Condition-context phrasing stays non-resume even against a bad declaration."""

    assert resolve_requirement_coverage_scope(requirement_text, "resume") == expected_scope
    assert resolve_requirement_coverage_scope(requirement_text, None) == expected_scope
    assert classify_requirement_coverage_scope(requirement_text) == expected_scope


def test_logistics_requirement_stays_auditable_but_cannot_fail_resume_coverage() -> None:
    logistics_text = "This position requires on-site presence three days weekly."
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[
            Requirement(
                id="req_python",
                text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                evidence_span="Own Python API reliability.",
            ),
            Requirement(
                id="req_hybrid",
                text=logistics_text,
                tier="must_have",
                weight=1.0,
                evidence_span=logistics_text,
                coverage_scope="resume",
            ),
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Python API reliability",
                evidence_span="Python API reliability",
                requirement_ref="req_python",
            )
        ],
    )
    analysis = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(logistics_text),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    report = RequirementFitReport(
        job_id=_JOB_ID,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(7),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=0.5, must_have_coverage=0.5),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_python",
                requirement_text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                job_evidence_span="Own Python API reliability.",
                fit=RequirementFitStatus(
                    kind="matched",
                    evidence_ids=("ev_latency",),
                    strength="direct",
                ),
                contribution=RequirementScoreContribution(
                    max_points=1.0,
                    awarded_points=1.0,
                    weighted_impact=1.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="double_down",
                    priority=0.9,
                    allowed_evidence_ids=("ev_latency",),
                    target_keywords=("Python API reliability",),
                ),
            ),
            RequirementFitAssessment(
                requirement_id="req_hybrid",
                requirement_text=logistics_text,
                tier="must_have",
                weight=1.0,
                job_evidence_span=logistics_text,
                fit=RequirementFitStatus(
                    kind="missing",
                    reason="No grounded profile evidence for office attendance.",
                ),
                contribution=RequirementScoreContribution(
                    max_points=1.0,
                    awarded_points=0.0,
                    weighted_impact=0.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="avoid_claim",
                    priority=1.0,
                    prohibited_claims=("hybrid",),
                ),
            ),
        ),
    )

    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=report,
    )
    target_profile = plan.target_profile
    graph = plan.coverage_graph
    assert target_profile is not None
    assert graph is not None
    assert [item.requirement_id for item in target_profile.requirements] == [
        "req_python",
        "req_hybrid",
    ]
    assert [item.requirement_id for item in target_profile.resume_requirements] == [
        "req_python"
    ]
    assert [item.requirement_id for item in target_profile.context_only_requirements] == [
        "req_hybrid"
    ]
    assert target_profile.context_only_requirements[0].coverage_scope == "logistics"
    assert graph.requirement_ids == {"req_python"}
    assert all(item.requirement_id != "req_hybrid" for item in graph.uncovered_requirements)

    hybrid_directive = next(
        item for item in plan.requirement_directives if item.requirement_id == "req_hybrid"
    )
    assert hybrid_directive.coverage_scope == "logistics"
    assert hybrid_directive.action == "context_only"
    assert hybrid_directive.allowed_evidence_ids == ()
    assert hybrid_directive.target_keywords == ()
    # The canonical sentence is always prohibited; the model fragment "hybrid"
    # survives because this profile carries no hybrid evidence it could reject.
    assert hybrid_directive.prohibited_claims == (logistics_text, "hybrid")
    assert plan.prohibited_claims == (logistics_text, "hybrid")

    prompt_target = target_profile.to_prompt_dict()
    assert [item["requirement_id"] for item in prompt_target["must_have_requirements"]] == [
        "req_python"
    ]
    assert [item["requirement_id"] for item in prompt_target["context_only_requirements"]] == [
        "req_hybrid"
    ]

    edge = graph.coverage_edges[0]
    generated_bullet = "Reduced API latency 35% by replacing synchronous calls."
    mapping = GeneratedClaimMapping(
        claim_id="python_claim",
        location="experience.acme_swe.bullets[0]",
        text=generated_bullet,
        claim_label="verified",
        coverage_edge_ids=(edge.edge_id,),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
    )
    grounding = ground_claim_mappings(
        (mapping,),
        (("bullet-1", "Reduced API latency 35% by replacing synchronous calls."),),
    )
    fit = score_generated_resume_against_target(
        target_profile=target_profile,
        mappings=(mapping,),
        grounding=grounding,
    )
    assert fit.must_have_coverage == 1.0
    assert fit.score == 10
    assert all("hybrid" not in fix.lower() for fix in fit.prioritized_fixes)

    summary_mapping = GeneratedClaimMapping(
        claim_id="summary_claim",
        location="executive_profile",
        text="Senior backend engineer.",
        claim_label="positioning",
        non_requirement_reason="positioning",
    )
    fit_gate, fit_gate_errors, review_blockers = _post_generation_fit_gate(
        payload={
            "executive_profile": "Senior backend engineer.",
            "executive_profile_sentences": ["Senior backend engineer."],
            "experience_updates": [
                {"id": "acme_swe", "title": "", "bullets": [generated_bullet]}
            ],
            "skill_category_updates": [],
            "generated_claim_mappings": [
                summary_mapping.to_dict(),
                mapping.to_dict(),
            ],
        },
        tailoring_plan=plan,
        attempt=1,
        shipped_rows=(
            BulletProvenance(
                bullet_id="bullet-1",
                section="experience",
                source_id="acme_swe",
                evidence_ids=("ev_latency",),
                requirement_ids=("req_python",),
                matched_keywords=("Python API reliability",),
                transform_type=TransformType.REPHRASE,
                control=ControlRule.REPHRASE_ALLOWED,
                rationale="Grounded rephrasing of the recorded achievement.",
                generated_text=generated_bullet,
            ),
        ),
    )
    assert fit_gate is not None
    assert fit_gate_errors == ()
    assert review_blockers == ()
    assert fit_gate["fit_score"]["score"] == 10
    assert fit_gate["revision_decision"]["threshold_failed"] is False
    assert fit_gate["revision_decision"]["should_revise"] is False


def _logistics_analysis_and_report(
    logistics_text: str,
    *,
    model_prohibited_claims: tuple[str, ...],
) -> tuple[EmployerAnalysis, RequirementFitReport]:
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[
            Requirement(
                id="req_python",
                text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                evidence_span="Own Python API reliability.",
            ),
            Requirement(
                id="req_hybrid",
                text=logistics_text,
                tier="must_have",
                weight=1.0,
                evidence_span=logistics_text,
            ),
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Python API reliability",
                evidence_span="Python API reliability",
                requirement_ref="req_python",
            )
        ],
    )
    analysis = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(logistics_text),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    report = RequirementFitReport(
        job_id=_JOB_ID,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(7),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=0.5, must_have_coverage=0.5),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_python",
                requirement_text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                job_evidence_span="Own Python API reliability.",
                fit=RequirementFitStatus(
                    kind="matched",
                    evidence_ids=("ev_latency",),
                    strength="direct",
                ),
                contribution=RequirementScoreContribution(
                    max_points=1.0,
                    awarded_points=1.0,
                    weighted_impact=1.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="double_down",
                    priority=0.9,
                    allowed_evidence_ids=("ev_latency",),
                    target_keywords=("Python API reliability",),
                ),
            ),
            RequirementFitAssessment(
                requirement_id="req_hybrid",
                requirement_text=logistics_text,
                tier="must_have",
                weight=1.0,
                job_evidence_span=logistics_text,
                fit=RequirementFitStatus(
                    kind="missing",
                    reason="No grounded profile evidence for office attendance.",
                ),
                contribution=RequirementScoreContribution(
                    max_points=1.0,
                    awarded_points=0.0,
                    weighted_impact=0.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="avoid_claim",
                    priority=1.0,
                    prohibited_claims=model_prohibited_claims,
                ),
            ),
        ),
    )
    return analysis, report


def test_context_only_directive_keeps_fragment_that_catches_ungrounded_onsite_claim() -> None:
    logistics_text = "Able to work a hybrid setup with on-site presence three days a week."
    analysis, report = _logistics_analysis_and_report(
        logistics_text,
        model_prohibited_claims=("hybrid", "on-site three days a week"),
    )

    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=report,
    )

    hybrid_directive = next(
        item for item in plan.requirement_directives if item.requirement_id == "req_hybrid"
    )
    assert hybrid_directive.action == "context_only"
    assert hybrid_directive.prohibited_claims == (
        logistics_text,
        "hybrid",
        "on-site three days a week",
    )
    # The deterministic net still fires on an ungrounded work-arrangement claim.
    caught = validate_prohibited_claims(
        "Senior engineer available on-site three days a week for the platform team.",
        plan.prohibited_claims,
    )
    assert caught == ("on-site three days a week",)


def test_context_only_directive_drops_fragment_colliding_with_hybrid_cloud_evidence() -> None:
    logistics_text = "Able to work a hybrid setup with on-site presence three days a week."
    analysis, report = _logistics_analysis_and_report(
        logistics_text,
        model_prohibited_claims=("hybrid", "on-site three days a week"),
    )
    profile = _profile()
    profile["resume"]["experience_entries"][0]["achievement_evidence"].append(
        {
            "id": "ev_hybrid_cloud",
            "source_text": "Designed hybrid cloud infrastructure spanning AWS and on-prem clusters.",
            "scope": "platform team",
            "action": "designed hybrid cloud infrastructure",
            "tools": ["AWS", "Kubernetes"],
            "metrics": [],
            "outcome": "portable workloads",
            "seniority_signal": "",
            "evidence_strength": "verified",
            "claim_confidence": 0.9,
            "user_confirmed": True,
            "tags": ["hybrid cloud", "infrastructure"],
        }
    )

    plan = build_tailoring_plan(
        profile,
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=report,
    )

    hybrid_directive = next(
        item for item in plan.requirement_directives if item.requirement_id == "req_hybrid"
    )
    # The bare token collides with grounded hybrid-cloud evidence and is dropped;
    # the canonical sentence and the arrangement-specific fragment stay armed.
    assert hybrid_directive.prohibited_claims == (
        logistics_text,
        "on-site three days a week",
    )
    assert (
        validate_prohibited_claims(
            "Designed hybrid cloud infrastructure spanning AWS and on-prem clusters.",
            plan.prohibited_claims,
        )
        == ()
    )
    assert validate_prohibited_claims(
        "Available on-site three days a week.",
        plan.prohibited_claims,
    ) == ("on-site three days a week",)


def test_stakeholder_sponsorship_remains_resume_scoped_end_to_end() -> None:
    requirement_text = "Secure senior stakeholder sponsorship for the platform migration."
    canonical = JobAnalysis(
        role_framing="Transformation leadership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A transformation leader.",
        requirements=[
            Requirement(
                id="req_stakeholder_sponsorship",
                text=requirement_text,
                tier="must_have",
                weight=1.0,
                evidence_span=requirement_text,
                coverage_scope="resume",
            )
        ],
        keywords=[],
    )
    analysis = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(requirement_text),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    assert analysis.prompt_version == "employer-analysis-v2"
    report = RequirementFitReport(
        job_id=_JOB_ID,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(7),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=0.0, must_have_coverage=0.0),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_stakeholder_sponsorship",
                requirement_text=requirement_text,
                tier="must_have",
                weight=1.0,
                job_evidence_span=requirement_text,
                fit=RequirementFitStatus(
                    kind="missing",
                    reason="No grounded stakeholder-sponsorship evidence.",
                ),
                contribution=RequirementScoreContribution(
                    max_points=1.0,
                    awarded_points=0.0,
                    weighted_impact=0.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="avoid_claim",
                    priority=1.0,
                    prohibited_claims=(requirement_text,),
                ),
            ),
        ),
    )

    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=report,
    )
    target_profile = plan.target_profile
    graph = plan.coverage_graph
    assert target_profile is not None
    assert graph is not None
    assert [item.requirement_id for item in target_profile.resume_requirements] == [
        "req_stakeholder_sponsorship"
    ]
    assert target_profile.context_only_requirements == ()
    assert graph.requirement_ids == {"req_stakeholder_sponsorship"}
    assert [item.requirement_id for item in graph.uncovered_requirements] == [
        "req_stakeholder_sponsorship"
    ]
    prompt_target = target_profile.to_prompt_dict()
    assert [item["requirement_id"] for item in prompt_target["must_have_requirements"]] == [
        "req_stakeholder_sponsorship"
    ]
    assert prompt_target["context_only_requirements"] == []

    fit = score_generated_resume_against_target(
        target_profile=target_profile,
        mappings=(),
        grounding=ground_claim_mappings((), ()),
    )
    assert fit.must_have_coverage == 0.0
    assert fit.score == 1
    assert any("stakeholder sponsorship" in fix.lower() for fix in fit.prioritized_fixes)


def test_seed_coverage_graph_builds_direct_and_transferable_edges() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(
            python_fit=RequirementFitStatus(
                kind="transferable",
                evidence_ids=("ev_latency",),
                bridge="Latency ownership transfers to API reliability.",
            )
        ),
    )

    graph = plan.coverage_graph
    assert graph is not None
    assert graph.coverage_edges[0].coverage_kind == "transferable"
    assert graph.coverage_edges[0].required_claim_policy == "evidence_reframing"
    assert graph.uncovered_requirements[0].requirement_id == "req_salesforce"
    assert graph.to_safe_metadata()["coverage_edge_count"] == 1


def test_education_requirement_fit_evidence_is_claimable_in_coverage_graph() -> None:
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[
            Requirement(
                id="req_degree",
                text="Bachelor's degree in Computer Science.",
                tier="nice_to_have",
                weight=0.3,
                evidence_span="Bachelor's degree in Computer Science.",
            )
        ],
        keywords=[],
    )
    analysis = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash("degree"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    report = RequirementFitReport(
        job_id=_JOB_ID,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(8),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=1.0, must_have_coverage=1.0),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_degree",
                requirement_text="Bachelor's degree in Computer Science.",
                tier="nice_to_have",
                weight=0.3,
                job_evidence_span="Bachelor's degree in Computer Science.",
                fit=RequirementFitStatus(
                    kind="matched",
                    evidence_ids=("education:edu_state",),
                    strength="direct",
                ),
                contribution=RequirementScoreContribution(
                    max_points=0.375,
                    awarded_points=0.375,
                    weighted_impact=0.375,
                ),
                tailoring=RequirementTailoringDirective(
                    action="double_down",
                    priority=0.3,
                    allowed_evidence_ids=("education:edu_state",),
                ),
            ),
        ),
    )

    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=report,
    )

    graph = plan.coverage_graph
    assert graph is not None
    assert "education:edu_state" in graph.achievement_ids
    assert validate_coverage_graph(graph, controls=plan.requirement_led_controls) == ()
    assert validate_generated_claim_mappings(
        (
            GeneratedClaimMapping(
                claim_id="degree_claim",
                location="executive_profile",
                text="Bachelor's degree in Computer Science.",
                claim_label="verified",
                coverage_edge_ids=("edge_req_degree_education_edu_state_direct",),
                requirement_ids=("req_degree",),
                evidence_ids=("education:edu_state",),
            ),
        ),
        graph,
        controls=plan.requirement_led_controls,
    ) == ()
    assert (
        _claim_mapping_validation_errors(
            payload={
                "executive_profile": "Engineering leader.",
                "executive_profile_sentences": ["Engineering leader."],
                "generated_claim_mappings": [
                    {
                        "claim_id": "summary_claim",
                        "location": "executive_profile",
                        "text": "Engineering leader.",
                        "claim_label": "positioning",
                        "coverage_edge_ids": (),
                        "requirement_ids": (),
                        "evidence_ids": (),
                        "non_requirement_reason": "positioning",
                        "review_required": False,
                    },
                    {
                        "claim_id": "degree_claim",
                        "location": "education_updates[0]",
                        "text": "BSc CS",
                        "claim_label": "verified",
                        "coverage_edge_ids": ("edge_req_degree_education_edu_state_direct",),
                        "requirement_ids": ("req_degree",),
                        "evidence_ids": ("education:edu_state",),
                        "non_requirement_reason": "",
                        "review_required": False,
                    }
                ]
            },
            tailoring_plan=plan,
        )
        == ()
    )
    assert (
        _claim_mapping_validation_errors(
            payload={
                "executive_profile": "Engineering leader.",
                "executive_profile_sentences": ["Engineering leader."],
                "generated_claim_mappings": [
                    {
                        "claim_id": "summary_claim",
                        "location": "executive_profile",
                        "text": "Engineering leader.",
                        "claim_label": "positioning",
                        "coverage_edge_ids": (),
                        "requirement_ids": (),
                        "evidence_ids": (),
                        "non_requirement_reason": "positioning",
                        "review_required": False,
                    },
                    {
                        "claim_id": "degree_section_claim",
                        "location": "education",
                        "text": "BSc CS",
                        "claim_label": "verified",
                        "coverage_edge_ids": ("edge_req_degree_education_edu_state_direct",),
                        "requirement_ids": ("req_degree",),
                        "evidence_ids": ("education:edu_state",),
                        "non_requirement_reason": "",
                        "review_required": False,
                    }
                ]
            },
            tailoring_plan=plan,
        )
        == ()
    )


def test_build_coverage_planner_prompt_constrains_ids_and_output() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )

    prompt = build_coverage_planner_prompt(
        target_profile=plan.target_profile,
        seeded_graph=plan.coverage_graph,
    )

    assert "Return ONLY JSON" in prompt
    # The planner's id universe is scoped to the resume-coverable lists so a
    # compliant response never references context-only ids absent from the
    # seeded graph.
    assert (
        "Use only requirement_id values from must_have_requirements or "
        "nice_to_have_requirements in TARGET_PROFILE" in prompt
    )
    assert (
        "never propose edges for them and never list them in "
        "uncovered_requirements" in prompt
    )
    assert (
        "If a must_have or nice_to_have requirement has no safe edge, list it in "
        "uncovered_requirements" in prompt
    )
    assert "Use only achievement_evidence_id values present in TARGET_PROFILE" in prompt
    assert "Do not invent tools, metrics, titles" in prompt
    assert "req_python" in prompt
    assert "ev_latency" in prompt


def test_apply_coverage_planner_response_parses_direct_adjacent_missing_and_unused() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "adjacent_translation"},
        writing_style={},
    )
    seeded = _graph()
    response = {
        "coverage_edges": [
            {
                "requirement_id": "req_salesforce",
                "achievement_evidence_id": "ev_unused",
                "coverage_kind": "adjacent",
                "strength": "weak",
                "required_claim_policy": "adjacent_translation",
                "target_terms": ["Salesforce administration"],
                "rationale": "Planning rituals are adjacent but not direct Salesforce administration.",
            }
        ],
        "uncovered_requirements": [],
        "unused_achievements": [],
    }

    graph, errors = apply_coverage_planner_response(
        seeded_graph=seeded,
        response=response,
        controls=controls,
    )

    assert errors == ()
    assert [edge.coverage_kind for edge in graph.coverage_edges] == ["direct", "adjacent"]
    assert graph.uncovered_requirements == ()
    assert graph.unused_achievements == ()


def test_apply_coverage_planner_response_reports_invalid_edges() -> None:
    controls = adapt_requirement_led_controls(tailoring_policy={}, writing_style={})
    response = {
        "coverage_edges": [
            {
                "requirement_id": "req_missing",
                "achievement_evidence_id": "ev_missing",
                "coverage_kind": "adjacent",
                "strength": "weak",
                "required_claim_policy": "adjacent_translation",
                "target_terms": ["unknown"],
                "rationale": "Invalid IDs.",
            },
            {
                "requirement_id": "req_python",
                "achievement_evidence_id": "ev_latency",
                "coverage_kind": "unsupported_kind",
                "strength": "weak",
                "required_claim_policy": "verified_only",
                "target_terms": [],
                "rationale": "Invalid kind.",
            },
        ],
        "uncovered_requirements": [
            {
                "requirement_id": "req_salesforce",
                "reason": "Still uncovered.",
                "prohibited_claims": ["Administer Salesforce."],
            }
        ],
        "unused_achievements": [
            {"achievement_evidence_id": "ev_unused", "reason": "Not relevant."}
        ],
    }

    graph, errors = apply_coverage_planner_response(
        seeded_graph=_graph(),
        response=response,
        controls=controls,
    )

    assert any("coverage_kind must be one of" in error for error in errors)
    assert any("unknown requirement req_missing" in error for error in errors)
    assert any("unknown achievement evidence ev_missing" in error for error in errors)
    assert any("requires adjacent_translation, but claim policy is evidence_reframing" in error for error in errors)
    assert graph.uncovered_requirements[0].requirement_id == "req_salesforce"


def test_post_generation_fit_score_counts_only_claims_grounded_in_shipped_text() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    mapping = GeneratedClaimMapping(
        claim_id="claim_python",
        location="experience.acme_swe.bullets[0]",
        text="Owned Python API reliability and reduced latency 35%.",
        claim_label="evidence_reframed",
        coverage_edge_ids=("edge_req_python_ev_latency_direct",),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
    )
    grounding = ground_claim_mappings(
        (mapping,),
        (("experience:acme_swe#0", "Owned Python API reliability and reduced latency 35%."),),
    )

    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(mapping,),
        grounding=grounding,
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=plan.requirement_led_controls,
        attempt=1,
    )

    assert fit.covered_requirement_ids == ("req_python",)
    assert fit.claimed_only_requirement_ids == ()
    assert fit.coverage_basis == GROUNDED_COVERAGE_BASIS
    assert fit.score == 5
    assert fit.must_have_coverage == 0.5
    assert decision.threshold_failed is True
    assert decision.should_revise is False
    assert decision.reason == "fit_score_and_must_have_coverage_below_threshold"


def test_post_generation_fit_score_rejects_claims_absent_from_shipped_text() -> None:
    """A claim asserting coverage that ships nowhere must NOT count as covered.

    Regression for the apply-review contradiction (Digital Hub Director gen 32):
    the judge-claimed record said must-have coverage 100% while the shipped
    resume carried the claim in no rendered line. Grounded scoring marks the
    requirement claimed-only, fails the gate, and names the real fix.
    """
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    mapping = GeneratedClaimMapping(
        claim_id="claim_python",
        location="experience.acme_swe.bullets[0]",
        text="Owned Python API reliability and reduced latency 35%.",
        claim_label="evidence_reframed",
        coverage_edge_ids=("edge_req_python_ev_latency_direct",),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
    )
    grounding = ground_claim_mappings(
        (mapping,),
        (("experience:acme_swe#0", "Shipped a completely different bullet."),),
    )

    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(mapping,),
        grounding=grounding,
    )

    assert fit.covered_requirement_ids == ()
    assert fit.claimed_only_requirement_ids == ("req_python",)
    assert "req_python" in fit.uncovered_requirement_ids
    assert fit.must_have_coverage == 0.0
    assert any(
        "does not appear in the shipped resume" in fix for fix in fit.prioritized_fixes
    )


def test_post_generation_fit_score_passes_on_first_draft_when_all_must_haves_are_covered() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    mappings = (
        GeneratedClaimMapping(
            claim_id="claim_python",
            location="experience.acme_swe.bullets[0]",
            text="Owned Python API reliability and reduced latency 35%.",
            claim_label="evidence_reframed",
            coverage_edge_ids=("edge_req_python_ev_latency_direct",),
            requirement_ids=("req_python",),
            evidence_ids=("ev_latency",),
        ),
        GeneratedClaimMapping(
            claim_id="claim_salesforce",
            location="experience.acme_swe.bullets[1]",
            text="Covered the Salesforce administration requirement with approved adjacent evidence.",
            claim_label="adjacent_translation",
            coverage_edge_ids=("edge_req_salesforce_ev_latency_adjacent",),
            requirement_ids=("req_salesforce",),
            evidence_ids=("ev_latency",),
            review_required=False,
        ),
    )
    controls = adapt_requirement_led_controls(
        tailoring_policy={
            "claim_mode": "adjacent_translation",
            "advanced_adjacent_auto_approval": True,
            "auto_approvable_claim_modes": [
                "verified_only",
                "evidence_reframing",
                "adjacent_translation",
            ],
        },
        writing_style={},
    )

    grounding = ground_claim_mappings(
        mappings,
        (
            ("experience:acme_swe#0", "Owned Python API reliability and reduced latency 35%."),
            (
                "experience:acme_swe#1",
                "Covered the Salesforce administration requirement with approved adjacent evidence.",
            ),
        ),
    )
    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=mappings,
        grounding=grounding,
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=controls,
        attempt=1,
    )

    assert fit.score == 10
    assert fit.must_have_coverage == 1.0
    assert decision.threshold_failed is False
    assert decision.should_revise is False
    assert decision.reason == "passed"


def test_adjacent_auto_approval_can_come_from_auto_approvable_claim_modes() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={
            "claim_mode": "adjacent_translation",
            "auto_approvable_claim_modes": [
                "verified_only",
                "evidence_reframing",
                "adjacent_translation",
            ],
        },
        writing_style={},
    )

    assert controls.auto_approval_policy.adjacent_translation_auto_approvable is True
    assert "adjacent_translation" in controls.auto_approval_policy.auto_approvable_claim_labels


def test_score_gated_revision_routes_low_score_when_enhancement_is_allowed() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "adjacent_translation"},
        writing_style={},
    )
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(),
        grounding=ground_claim_mappings((), ()),
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=controls,
        attempt=1,
    )

    assert fit.score == 1
    assert fit.must_have_coverage == 0.0
    assert decision.should_revise is True
    assert decision.enhancement_allowed is True
    assert decision.disposition == "revise"
    assert decision.prioritized_fixes[0].startswith("req_python:")


def test_score_gated_revision_accepts_truthful_residual_gap_without_enhancement() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "verified_only"},
        writing_style={},
    )
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(),
        grounding=ground_claim_mappings((), ()),
    )

    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=controls,
        attempt=1,
    )

    assert decision.threshold_failed is True
    assert decision.should_revise is False
    assert decision.enhancement_allowed is False
    assert decision.disposition == "accept_with_residual_gap"


def test_score_gated_revision_accepts_residual_gap_after_revision_budget() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "adjacent_translation"},
        writing_style={},
    )
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(),
        grounding=ground_claim_mappings((), ()),
    )

    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=controls,
        attempt=2,
    )

    assert decision.threshold_failed is True
    assert decision.should_revise is False
    assert decision.enhancement_allowed is True
    assert decision.disposition == "accept_with_residual_gap"


def test_score_gated_revision_blocks_draft_claims_for_review() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "draft_requires_confirmation"},
        writing_style={},
    )
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    draft = GeneratedClaimMapping(
        claim_id="claim_draft",
        location="experience.acme_swe.bullets[1]",
        text="Draft adjacent Salesforce administration claim.",
        claim_label="draft_requires_confirmation",
        coverage_edge_ids=("edge_req_salesforce_ev_latency_adjacent",),
        requirement_ids=("req_salesforce",),
        evidence_ids=("ev_latency",),
        review_required=True,
    )

    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(draft,),
        grounding=ground_claim_mappings(
            (draft,),
            (("experience:acme_swe#1", "Draft adjacent Salesforce administration claim."),),
        ),
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=controls,
        attempt=1,
    )

    assert fit.review_blockers == ("claim_draft: draft_requires_confirmation",)
    assert decision.review_blocked is True
    assert decision.reason == "review_blocked_claims"


def test_grounded_gate_reproduces_apply_review_contradiction_shape() -> None:
    """Digital Hub Director gen-32 shape: claims assert 9/9; one shipped line carries 4.

    The revision gate must report grounded coverage (must-have 4/8 = 50%), fail,
    and route a revision — never echo the model's 100% self-assessment. This is
    the regression fixture for the apply-review surface showing "4/9 requirements
    covered" beside "Must-have coverage: 100% · passed".
    """
    requirements = tuple(
        TargetRequirement(
            requirement_id=f"r{index}",
            text=f"Requirement {index}",
            tier="must_have" if index <= 8 else "nice_to_have",
            weight=0.9 if index <= 8 else 0.2,
        )
        for index in range(1, 10)
    )
    target = TargetProfile(
        job_id=str(_JOB_ID),
        target_role="Digital Hub Director",
        seniority="director",
        must_have_requirements=requirements[:8],
        nice_to_have_requirements=requirements[8:],
    )
    summary = "Engineering Director with 12+ years leading platform organizations."
    mappings = tuple(
        GeneratedClaimMapping(
            claim_id=f"claim_r{index}",
            location=(
                "executive_profile"
                if index in {3, 4, 5, 6}
                else f"experience.dropped_entry.bullets[{index}]"
            ),
            text=(
                summary
                if index in {3, 4, 5, 6}
                else f"Claim text for requirement {index} that never ships."
            ),
            claim_label="evidence_reframed",
            coverage_edge_ids=(f"edge_r{index}",),
            requirement_ids=(f"r{index}",),
            evidence_ids=(f"ev_{index}",),
        )
        for index in range(1, 10)
    )
    grounding = ground_claim_mappings(mappings, (("executive_profile#0", summary),))

    fit = score_generated_resume_against_target(
        target_profile=target,
        mappings=mappings,
        grounding=grounding,
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=adapt_requirement_led_controls(
            tailoring_policy={"claim_mode": "adjacent_translation"},
            writing_style={},
        ),
        attempt=1,
    )

    assert fit.covered_requirement_ids == ("r3", "r4", "r5", "r6")
    assert set(fit.claimed_only_requirement_ids) == {"r1", "r2", "r7", "r8", "r9"}
    assert fit.must_have_coverage == 0.5
    assert fit.coverage_basis == GROUNDED_COVERAGE_BASIS
    assert decision.threshold_failed is True
    assert decision.should_revise is True
    assert any("does not appear in the shipped resume" in fix for fix in decision.prioritized_fixes)


def test_enhancement_claims_append_without_evicting_selected_covered_claims() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "draft_requires_confirmation"},
        writing_style={},
    )
    selected = GeneratedClaimMapping(
        claim_id="claim_python",
        location="experience.acme_swe.bullets[0]",
        text="Owned Python API reliability and reduced latency 35%.",
        claim_label="evidence_reframed",
        coverage_edge_ids=("edge_req_python_ev_latency_direct",),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
    )
    enhancement = GeneratedClaimMapping(
        claim_id="claim_salesforce_draft",
        location="experience.acme_swe.bullets[1]",
        text="Draft adjacent Salesforce administration claim.",
        claim_label="draft_requires_confirmation",
        coverage_edge_ids=("edge_req_salesforce_ev_latency_adjacent",),
        requirement_ids=("req_salesforce",),
        evidence_ids=("ev_latency",),
        review_required=True,
    )

    combined, errors = append_enhancement_claim_mappings(
        selected_mappings=(selected,),
        enhancement_mappings=(enhancement,),
        controls=controls,
    )

    assert errors == ()
    assert [mapping.claim_id for mapping in combined] == [
        "claim_python",
        "claim_salesforce_draft",
    ]


def _graph() -> CoverageGraph:
    return CoverageGraph(
        requirements=(
            RequirementNode(
                requirement_id="req_python",
                text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                source_span="Own Python API reliability.",
                keywords=("python", "api reliability"),
            ),
            RequirementNode(
                requirement_id="req_salesforce",
                text="Administer Salesforce.",
                tier="must_have",
                weight=0.8,
            ),
        ),
        achievements=(
            AchievementNode(
                achievement_evidence_id="ev_latency",
                experience_entry_id="role_1",
                source_text="Reduced latency 35% with Python services.",
                metrics=("35% latency reduction",),
                tools=("Python",),
                evidence_strength="verified",
                user_confirmed=True,
            ),
            AchievementNode(
                achievement_evidence_id="ev_unused",
                experience_entry_id="role_2",
                source_text="Improved planning rituals.",
            ),
        ),
        coverage_edges=(
            CoverageEdge(
                edge_id="edge_req_python_ev_latency",
                requirement_id="req_python",
                achievement_evidence_id="ev_latency",
                coverage_kind="direct",
                strength="direct",
                required_claim_policy="verified_only",
                target_terms=("Python API reliability",),
                rationale="Verified latency evidence supports the API reliability requirement.",
            ),
        ),
        uncovered_requirements=(
            UncoveredRequirement(
                requirement_id="req_salesforce",
                reason="No grounded Salesforce evidence.",
                prohibited_claims=("Administer Salesforce.",),
            ),
        ),
        unused_achievements=(UnusedAchievement(achievement_evidence_id="ev_unused"),),
    )


def test_validate_coverage_graph_accepts_known_ids_and_rejects_unknown_ids() -> None:
    controls = adapt_requirement_led_controls(tailoring_policy={}, writing_style={})
    assert validate_coverage_graph(_graph(), controls=controls) == ()

    invalid = CoverageGraph(
        requirements=_graph().requirements,
        achievements=_graph().achievements,
        coverage_edges=(
            CoverageEdge(
                edge_id="edge_invalid",
                requirement_id="req_missing",
                achievement_evidence_id="ev_missing",
                coverage_kind="direct",
                strength="direct",
                required_claim_policy="verified_only",
            ),
        ),
    )

    errors = validate_coverage_graph(invalid, controls=controls)
    assert any("unknown requirement req_missing" in error for error in errors)
    assert any("unknown achievement evidence ev_missing" in error for error in errors)


def test_validate_coverage_graph_rejects_claim_policy_incompatible_edges() -> None:
    strict_controls = adapt_requirement_led_controls(
        tailoring_policy={"mode": "strict"},
        writing_style={},
    )
    graph = CoverageGraph(
        requirements=_graph().requirements,
        achievements=_graph().achievements,
        coverage_edges=(
            CoverageEdge(
                edge_id="edge_adjacent",
                requirement_id="req_python",
                achievement_evidence_id="ev_latency",
                coverage_kind="adjacent",
                strength="weak",
                required_claim_policy="adjacent_translation",
            ),
        ),
    )

    errors = validate_coverage_graph(graph, controls=strict_controls)
    assert errors == (
        "Coverage edge edge_adjacent requires adjacent_translation, but claim policy is verified_only.",
    )


def test_validate_generated_claim_mapping_checks_edges_labels_and_review_policy() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "evidence_reframing"},
        writing_style={},
    )
    valid = GeneratedClaimMapping(
        claim_id="claim_1",
        location="experience.role_1.bullets[0]",
        text="Owned Python API reliability and reduced latency 35%.",
        claim_label="evidence_reframed",
        coverage_edge_ids=("edge_req_python_ev_latency",),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
    )
    invalid = GeneratedClaimMapping(
        claim_id="claim_2",
        location="experience.role_1.bullets[1]",
        text="Adjacent platform translation.",
        claim_label="adjacent_translation",
        coverage_edge_ids=("edge_req_python_ev_latency",),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
        review_required=False,
    )

    assert validate_generated_claim_mappings((valid,), _graph(), controls=controls) == ()
    errors = validate_generated_claim_mappings((invalid,), _graph(), controls=controls)
    assert any("label adjacent_translation is not allowed" in error for error in errors)
    assert any("Adjacent claim claim_2 must require review" in error for error in errors)


def test_validate_generated_claim_mapping_requires_draft_review() -> None:
    controls = adapt_requirement_led_controls(
        tailoring_policy={"claim_mode": "draft_requires_confirmation"},
        writing_style={},
    )
    draft = GeneratedClaimMapping(
        claim_id="claim_draft",
        location="summary",
        text="Draft adjacent claim.",
        claim_label="draft_requires_confirmation",
        coverage_edge_ids=("edge_req_python_ev_latency",),
        requirement_ids=("req_python",),
        evidence_ids=("ev_latency",),
    )

    assert validate_generated_claim_mappings((draft,), _graph(), controls=controls) == (
        "Generated draft claim claim_draft must require review.",
    )


def test_validators_cover_metrics_prohibited_claims_pins_and_mandatory_edges() -> None:
    assert validate_metric_support(
        "Reduced latency 35% and served 10,000 users.",
        verified_metrics=("35% latency reduction",),
    ) == ("10,000 users",)
    assert validate_prohibited_claims(
        "Owned Python and administered Salesforce.",
        ("administered Salesforce",),
    ) == ("administered Salesforce",)
    assert validate_pinned_content_preserved(
        "Owned Python API reliability.",
        {"role_1": ("Pinned bullet that must remain.",)},
    ) == ("role_1: Pinned bullet that must remain.",)

    unmapped = GeneratedClaimMapping(
        claim_id="claim_positioning",
        location="summary",
        text="Backend owner.",
        claim_label="positioning",
        non_requirement_reason="positioning",
    )
    assert validate_mandatory_covered_achievements(_graph(), (unmapped,)) == ("ev_latency",)


def test_bullet_limit_overflow_records_mandatory_reason() -> None:
    assert bullet_limit_overflows(
        experience_entry_id="role_1",
        max_bullets=2,
        actual_bullets=3,
        requirement_covered_evidence_ids=("ev_latency",),
    )[0].to_dict() == {
        "experience_entry_id": "role_1",
        "max_bullets": 2,
        "actual_bullets": 3,
        "reason": "requirement_coverage",
        "evidence_ids": ["ev_latency"],
    }
    assert bullet_limit_overflows(
        experience_entry_id="role_1",
        max_bullets=2,
        actual_bullets=3,
        enhancement_covered_evidence_ids=("ev_new",),
    )[0].reason == "enhancement_coverage"
    assert bullet_limit_overflows(
        experience_entry_id="role_1",
        max_bullets=2,
        actual_bullets=2,
        pinned_required_bullet_count=2,
    ) == ()
