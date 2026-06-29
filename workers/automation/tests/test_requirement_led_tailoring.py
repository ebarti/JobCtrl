"""Requirement-led tailoring domain model and policy tests."""

from __future__ import annotations

import pytest

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobhunter.domain.materials.policy import (
    DEFAULT_REQUIREMENT_LED_REVISION_GATES,
    REQUIREMENT_LED_TAILORING_POLICY_VERSION,
    RevisionGatePolicy,
    adapt_requirement_led_controls,
)
from jobhunter.domain.materials.quality import build_tailoring_plan
from jobhunter.domain.materials.requirement_coverage import (
    AchievementNode,
    CoverageEdge,
    CoverageGraph,
    GeneratedClaimMapping,
    RequirementNode,
    UncoveredRequirement,
    UnusedAchievement,
    apply_coverage_planner_response,
    append_enhancement_claim_mappings,
    bullet_limit_overflows,
    build_coverage_planner_prompt,
    decide_score_gated_revision,
    score_generated_resume_against_target,
    validate_coverage_graph,
    validate_generated_claim_mappings,
    validate_mandatory_covered_achievements,
    validate_metric_support,
    validate_pinned_content_preserved,
    validate_prohibited_claims,
)
from jobhunter.domain.scoring import (
    FitScore,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
)
from jobhunter.domain.tenant import LOCAL_TENANT


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
        job_id=JobId("https://example.com/senior-backend"),
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
        job_id=JobId("https://example.com/senior-backend"),
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
        job_id="https://example.com/senior-backend",
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
        additional_guidance="Use backend positioning.",
    )

    serialized = controls.to_dict()
    assert controls.policy_version == REQUIREMENT_LED_TAILORING_POLICY_VERSION
    assert controls.claim_policy == "draft_requires_confirmation"
    assert controls.generation_permissions.preserve_titles is True
    assert controls.generation_permissions.rewrite_summary is True
    assert controls.required_content_pins.experience_entry_ids == ("role_1",)
    assert controls.writing_style.keyword_emphasis == "high"
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
    assert "Use only requirement_id values present in TARGET_PROFILE" in prompt
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


def test_post_generation_fit_score_passes_when_required_coverage_is_claimed() -> None:
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

    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=(mapping,),
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=plan.requirement_led_controls,
        attempt=1,
    )

    assert fit.covered_requirement_ids == ("req_python",)
    assert fit.score == 5
    assert fit.must_have_coverage == 0.5
    assert decision.threshold_failed is True
    assert decision.should_revise is False
    assert decision.reason == "fit_score_and_must_have_coverage_below_threshold"


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

    fit = score_generated_resume_against_target(
        target_profile=plan.target_profile,
        mappings=mappings,
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
    assert decision.prioritized_fixes[0].startswith("req_python:")


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
    )
    decision = decide_score_gated_revision(
        fit_score=fit,
        controls=controls,
        attempt=1,
    )

    assert fit.review_blockers == ("claim_draft: draft_requires_confirmation",)
    assert decision.review_blocked is True
    assert decision.reason == "review_blocked_claims"


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
