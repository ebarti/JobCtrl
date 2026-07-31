"""Deterministic resume-tailoring quality checks."""

from __future__ import annotations

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.quality import (
    build_tailoring_change_annotations,
    build_tailoring_plan,
    evaluate_tailoring_quality,
)
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

_JOB_ID = canonical_job_id("50000000-0000-4000-8000-000000000001")
_OTHER_JOB_ID = canonical_job_id("50000000-0000-4000-8000-000000000002")


def _employer_analysis(
    *keywords: str, job_id: JobId = _JOB_ID
) -> EmployerAnalysis:
    """Minimal canonical analysis supplying the given job keywords (Phase 1, D-21).

    ``build_tailoring_plan`` now sources its keywords from the persisted
    employer analysis instead of the removed ``_extract_job_keywords`` heuristic,
    so quality tests pass a small analysis whose keyword terms drive the plan.
    """
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[],
        keywords=[ReasonedKeyword(keyword=term, evidence_span=term) for term in keywords],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        generation=1,
        snapshot_hash=compute_snapshot_hash(" ".join(keywords) or "jd"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _requirement_analysis(job_id: JobId = _JOB_ID) -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Backend ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=[
            Requirement(
                id="req_latency",
                text="Own Python API reliability.",
                tier="must_have",
                weight=0.9,
                evidence_span="Own Python API reliability.",
            ),
            Requirement(
                id="req_salesforce",
                text="Direct Salesforce administration.",
                tier="must_have",
                weight=0.85,
                evidence_span="Direct Salesforce administration.",
            ),
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Python API reliability",
                evidence_span="Python API reliability",
                requirement_ref="req_latency",
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
        job_id=job_id,
        generation=1,
        snapshot_hash=compute_snapshot_hash("Python API Salesforce"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _requirement_fit_report(job_id: JobId = _JOB_ID) -> RequirementFitReport:
    return RequirementFitReport(
        job_id=job_id,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(7),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=0.7, must_have_coverage=0.6),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_latency",
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
                    max_points=1.125,
                    awarded_points=1.125,
                    weighted_impact=1.125,
                ),
                tailoring=RequirementTailoringDirective(
                    action="double_down",
                    priority=0.9,
                    allowed_evidence_ids=("ev_latency",),
                    target_keywords=("Python API reliability",),
                    instruction="Emphasize the verified latency evidence.",
                ),
            ),
            RequirementFitAssessment(
                requirement_id="req_salesforce",
                requirement_text="Direct Salesforce administration.",
                tier="must_have",
                weight=0.85,
                job_evidence_span="Direct Salesforce administration.",
                fit=RequirementFitStatus(
                    kind="missing",
                    reason="No grounded Salesforce evidence.",
                ),
                contribution=RequirementScoreContribution(
                    max_points=1.0625,
                    awarded_points=0.0,
                    weighted_impact=0.0,
                ),
                tailoring=RequirementTailoringDirective(
                    action="avoid_claim",
                    priority=0.85,
                    prohibited_claims=("Direct Salesforce administration.",),
                    instruction="Do not claim Salesforce administration.",
                ),
            ),
        ),
    )


def _profile() -> dict:
    return {
        "personal": {"full_name": "Jane Doe", "email": "jane@example.com"},
        "resume_constraints": {
            "real_metrics": ["35% latency reduction"],
        },
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
                            "source_text": (
                                "Reduced API latency 35% by replacing synchronous "
                                "enrichment calls."
                            ),
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
        "full_description": (
            "Own Python backend services, improve API latency, and influence "
            "service reliability."
        ),
    }


def _payload(*, bullet: str) -> dict:
    return {
        "executive_profile": "Senior backend engineer focused on Python API reliability.",
        "experience_updates": [
            {"id": "acme_swe", "title": "", "bullets": [bullet]},
        ],
        "skill_category_updates": [
            {"id": "languages", "items": ["Python", "Go"]},
        ],
    }


def _resume_text(*, bullet: str) -> str:
    return (
        "Jane Doe\n\n"
        "EXECUTIVE PROFILE\nSenior backend engineer focused on Python API reliability.\n\n"
        "EXPERIENCE\nSenior SWE | Acme Corp\nRemote | 2020-Present\n"
        f"- {bullet}\n\n"
        "EDUCATION\nBSc CS\nState University | City | 2015\n\n"
        "SKILLS\nLanguages: Python, Go"
    )


def test_build_tailoring_plan_selects_evidence_controls_keywords_and_seniority() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_employer_analysis("python", "latency", "postgresql"),
    )

    assert plan.claim_mode == "evidence_reframing"
    assert plan.writing_style["bullet_style"] == "leadership"
    assert plan.writing_style["bullet_styles"] == ["impact", "technical_depth", "leadership"]
    assert plan.target_seniority == "senior"


def test_build_tailoring_plan_maps_legacy_resume_bullets_to_evidence_ids() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0].pop("achievement_evidence")

    plan = build_tailoring_plan(
        profile,
        _senior_job(),
        employer_analysis=_employer_analysis("latency"),
    )

    assert plan.evidence_items[0].evidence_id == "acme_swe_bullet_1"
    assert plan.evidence_items[0].source_text == "Reduced API latency 35% by replacing synchronous calls."
    assert "acme_swe_bullet_1" in plan.required_evidence_ids


def test_quality_counts_fixed_education_in_final_resume_evidence() -> None:
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

    result = evaluate_tailoring_quality(
        _payload(bullet="Reduced API latency 35% by replacing synchronous calls."),
        _resume_text(bullet="Reduced API latency 35% by replacing synchronous calls."),
        plan,
    )

    assert "education:edu_state" in plan.required_evidence_ids
    assert "education:edu_state" in result.represented_evidence_ids
    assert "education:edu_state" not in result.missing_evidence_ids
    assert not any("Missing required evidence support" in error for error in result.errors)


def test_build_tailoring_change_annotations_explain_reframed_resume_sections() -> None:
    profile = _profile()
    job = _senior_job()
    plan = build_tailoring_plan(
        profile,
        job,
        employer_analysis=_employer_analysis("python", "latency", "api", "postgresql"),
    )
    payload = _payload(
        bullet=(
            "Owned Python API reliability and reduced latency 35% using PostgreSQL."
        )
    )

    annotations = build_tailoring_change_annotations(profile, job, payload, plan)

    summary = next(item for item in annotations if item["section"] == "executive_profile")
    assert summary["change_type"] == "summary_reframed"
    assert summary["source_text"] == ["Senior backend engineer."]
    assert summary["tailored_text"] == [
        "Senior backend engineer focused on Python API reliability."
    ]
    assert summary["controls"][:3] == [
        "target seniority: senior",
        "claim policy: evidence_reframing",
        "tone: direct",
    ]
    assert "adjacent drafts blocked" not in summary["controls"]

    experience = next(item for item in annotations if item["section"] == "experience")
    assert experience["source_id"] == "acme_swe"
    assert experience["change_type"] == "achievement_reframed"
    assert "Senior SWE" in experience["source_text"]
    assert experience["tailored_text"] == [
        "Senior SWE",
        "Owned Python API reliability and reduced latency 35% using PostgreSQL.",
    ]
    assert "api" in experience["job_signals"]
    assert experience["evidence_ids"] == ["ev_latency"]
    assert any("35% latency reduction" in note for note in experience["evidence_notes"])
    assert "ev_latency" in plan.required_evidence_ids
    assert "ev_latency" in plan.seniority_evidence_ids
    assert "python" in plan.job_keywords
    assert "latency" in plan.job_keywords


def test_change_annotations_include_generated_claim_audit_fields() -> None:
    profile = _profile()
    job = _senior_job()
    plan = build_tailoring_plan(
        profile,
        job,
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    payload = _payload(
        bullet="Owned Python API reliability and reduced latency 35% using PostgreSQL."
    )
    payload["generated_claim_mappings"] = [
        {
            "claim_id": "claim-python",
            "location": "experience.acme_swe.bullets[0]",
            "text": "Owned Python API reliability and reduced latency 35% using PostgreSQL.",
            "claim_label": "evidence_reframed",
            "coverage_edge_ids": ["edge_req_latency_ev_latency_direct"],
            "requirement_ids": ["req_latency"],
            "evidence_ids": ["ev_latency"],
            "non_requirement_reason": "",
            "review_required": False,
        }
    ]

    annotations = build_tailoring_change_annotations(profile, job, payload, plan)

    experience = next(item for item in annotations if item["section"] == "experience")
    assert experience["coverage_edge_ids"] == ["edge_req_latency_ev_latency_direct"]
    assert experience["requirement_ids"] == ["req_latency"]
    assert experience["claim_labels"] == ["evidence_reframed"]
    assert experience["review_required"] is False


def test_build_tailoring_plan_sources_keywords_from_canonical_analysis() -> None:
    # D-21: keywords come from the persisted, evidence-grounded employer
    # analysis — the old _extract_job_keywords stopword heuristic is gone.
    job = {
        "job_id": str(_JOB_ID),
        "url": "https://example.com/platform",
        "title": "Head of Platform Engineering",
        # Marketing copy in the JD must NOT leak into keywords; only the
        # analysis's reasoned terms drive the plan.
        "full_description": "Join Impress, Europe's leading innovator. Own platform engineering.",
    }
    analysis = _employer_analysis(
        "platform",
        "kubernetes",
        "ci/cd",
        "observability",
        job_id=_JOB_ID,
    )

    plan = build_tailoring_plan(_profile(), job, employer_analysis=analysis)

    assert plan.job_keywords == ("platform", "kubernetes", "ci/cd", "observability")
    # Marketing copy is absent because keywords no longer come from the JD text.
    assert "join" not in plan.job_keywords
    assert "impress" not in plan.job_keywords
    assert "innovator" not in plan.job_keywords


def test_build_tailoring_plan_uses_requirement_fit_directives() -> None:
    analysis = _requirement_analysis()
    report = _requirement_fit_report()

    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=report,
    )

    assert plan.required_evidence_ids[0] == "ev_latency"
    assert plan.job_keywords[0] == "python api reliability"
    assert plan.prohibited_claims == ("Direct Salesforce administration.",)
    assert [item.action for item in plan.requirement_directives] == [
        "double_down",
        "avoid_claim",
    ]
    prompt = plan.to_prompt_dict()
    assert prompt["requirement_directives"][0]["allowed_evidence_ids"] == ["ev_latency"]
    assert prompt["requirement_directives"][1]["prohibited_claims"] == [
        "Direct Salesforce administration."
    ]


def test_build_tailoring_plan_ignores_stale_requirement_fit_report_for_coverage() -> None:
    analysis = _requirement_analysis()
    stale_report = _requirement_fit_report(_OTHER_JOB_ID)

    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=analysis,
        requirement_fit_report=stale_report,
    )

    assert plan.requirement_directives == ()
    assert plan.target_profile is not None
    assert [requirement.requirement_id for requirement in plan.target_profile.requirements] == [
        "req_latency",
        "req_salesforce",
    ]
    assert plan.coverage_graph is not None
    assert plan.coverage_graph.coverage_edges == ()


def test_quality_rejects_prohibited_missing_requirement_claim() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    bullet = (
        "Owned Python API reliability and direct Salesforce administration "
        "while reducing latency 35%."
    )

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert result.passed is False
    assert any(
        "Unsupported prohibited claim appeared" in error
        and "Direct Salesforce administration" in error
        for error in result.errors
    )


def test_tailoring_plan_metadata_preserves_full_keyword_audit_set() -> None:
    analysis = _employer_analysis(*[f"skill-{index}" for index in range(20)])

    plan = build_tailoring_plan(_profile(), _senior_job(), employer_analysis=analysis)

    assert len(plan.job_keywords) > 16
    assert plan.to_metadata()["job_keywords"] == list(plan.job_keywords)


def test_quality_rejects_unknown_metric_not_in_verified_profile_or_evidence() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_employer_analysis("python", "latency"),
    )
    bullet = "Owned API latency work and reduced latency by 80% with Python."

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert result.passed is False
    assert any("Unknown metric" in error and "80%" in error for error in result.errors)


def test_quality_metric_claims_keep_readable_spacing() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_employer_analysis("python", "latency"),
    )
    bullet = "Owned 5 teams and reduced latency 35% across 2 services."

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert "5 teams" in result.metric_claims
    assert "2 services" in result.metric_claims
    assert "5teams" not in result.metric_claims
    assert "2services" not in result.metric_claims


def test_quality_warns_or_fails_keyword_stuffing_by_severity() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_employer_analysis("python", "latency"),
    )
    warning_bullet = "Owned Python Python Python Python Python services with 35% latency gains."
    failing_bullet = (
        "Owned Python Python Python Python Python Python Python Python Python "
        "Python services with 35% latency gains."
    )

    warning_result = evaluate_tailoring_quality(
        _payload(bullet=warning_bullet),
        _resume_text(bullet=warning_bullet),
        plan,
    )
    failing_result = evaluate_tailoring_quality(
        _payload(bullet=failing_bullet),
        _resume_text(bullet=failing_bullet),
        plan,
    )

    assert any("Keyword repetition" in warning for warning in warning_result.warnings)
    assert any("Keyword stuffing" in error for error in failing_result.errors)


def test_quality_allows_domain_keyword_repetition_when_density_is_natural() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_employer_analysis("security", "latency"),
    )
    domain_context = " ".join(
        [
            "platform",
            "delivery",
            "ownership",
            "stakeholder",
            "planning",
            "mentoring",
            "operational",
            "review",
            "architecture",
            "governance",
        ]
        * 18
    )
    bullet = (
        "Owned API reliability and reduced latency 35% while coordinating "
        f"{domain_context} "
        "security reviews, security incidents, security risk triage, security "
        "policy rollout, security architecture reviews, security partner alignment, "
        "security training, security backlog cleanup, security release checks, "
        "security documentation, security governance, and security design feedback."
    )

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert result.passed is True
    assert not any("Keyword stuffing" in error for error in result.errors)
    assert any("Keyword repetition" in warning for warning in result.warnings)


def test_quality_requires_seniority_signal_for_senior_roles_when_evidence_exists() -> None:
    plan = build_tailoring_plan(
        _profile(),
        _senior_job(),
        employer_analysis=_employer_analysis("python", "latency"),
    )
    weak_bullet = "Improved API behavior with Python and reduced latency 35%."
    strong_bullet = "Owned API latency improvements and reduced latency 35% with Python."

    weak_result = evaluate_tailoring_quality(
        _payload(bullet=weak_bullet),
        _resume_text(bullet=weak_bullet),
        plan,
    )
    strong_result = evaluate_tailoring_quality(
        _payload(bullet=strong_bullet),
        _resume_text(bullet=strong_bullet),
        plan,
    )

    assert any("Seniority mismatch" in error for error in weak_result.errors)
    assert strong_result.passed is True


def test_mid_level_jobs_do_not_require_executive_framing() -> None:
    job = {
        "job_id": str(_JOB_ID),
        "url": "https://example.com/backend",
        "title": "Backend Engineer",
        "skills": ["Python"],
        "full_description": "Build Python backend services.",
    }
    plan = build_tailoring_plan(
        _profile(), job, employer_analysis=_employer_analysis("python")
    )
    bullet = "Improved Python API reliability and reduced latency 35%."

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert plan.target_seniority == "mid"
    assert all("Seniority mismatch" not in error for error in result.errors)


def test_mid_level_jobs_warn_on_executive_style_overreach() -> None:
    job = {
        "job_id": str(_JOB_ID),
        "url": "https://example.com/backend",
        "title": "Backend Engineer",
        "skills": ["Python"],
        "full_description": "Build Python backend services.",
    }
    plan = build_tailoring_plan(
        _profile(), job, employer_analysis=_employer_analysis("python")
    )
    bullet = "Defined company-wide strategy for executive stakeholders."

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert any("Executive phrasing" in warning for warning in result.warnings)
