"""Mechanical tailoring inventory, budgets and exact-value checks."""

from __future__ import annotations
from tests.determination_fakes import job_interpretation

from dataclasses import replace

import pytest

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
    ArtifactBudgetInfeasibleError,
    TailoringPrerequisiteError,
    build_tailoring_change_annotations,
    build_tailoring_plan as _build_tailoring_plan,
    require_artifact_budget_feasible,
)
from jobctrl.domain.materials.requirement_coverage import CoverageEdge, CoverageGraph
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


def _employer_analysis(*keywords: str, job_id: JobId = _JOB_ID) -> EmployerAnalysis:
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
                            "source_text": ("Reduced API latency 35% by replacing synchronous enrichment calls."),
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
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python", "Go"]}],
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
        "full_description": ("Own Python backend services, improve API latency, and influence service reliability."),
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


def test_artifact_budget_precheck_unions_pins_and_required_coverage_per_role() -> None:
    profile = _profile()
    entry = profile["resume"]["experience_entries"][0]
    evidence = []
    bullets = []
    for index in range(1, 6):
        bullet = f"Owned canonical achievement {index} for the platform."
        bullets.append(bullet)
        evidence.append(
            {
                "id": f"ev_{index}",
                "source_text": bullet,
                "scope": "platform",
                "action": bullet,
                "tools": [],
                "metrics": [],
                "outcome": bullet,
                "seniority_signal": "ownership",
                "evidence_strength": "verified",
                "claim_confidence": 0.95,
                "user_confirmed": True,
                "tags": [],
            }
        )
    entry["bullets"] = bullets
    entry["achievement_evidence"] = evidence
    profile["resume"]["tailoring_rules"]["required_bullets_by_experience_id"] = {"acme_swe": [bullets[0]]}
    plan = build_tailoring_plan(
        profile,
        _senior_job(),
        employer_analysis=_employer_analysis("platform"),
    )
    plan = replace(
        plan,
        coverage_graph=CoverageGraph(
            coverage_edges=tuple(
                CoverageEdge(
                    edge_id=f"edge_{index}",
                    requirement_id=f"req_{index}",
                    achievement_evidence_id=f"ev_{index}",
                    coverage_kind="direct",
                    strength="direct",
                    required_claim_policy="verified_only",
                )
                for index in range(1, 6)
            )
        ),
    )

    with pytest.raises(ArtifactBudgetInfeasibleError) as raised:
        require_artifact_budget_feasible(profile, plan)

    violation = raised.value.violations[0]
    # ev_1 is both pinned and requirement-covered, so it consumes one slot.
    assert violation.required_achievement_count == 5
    assert violation.ceiling == 4
    assert violation.experience_entry_id == "acme_swe"
    assert violation.role == "Acme Corp — Senior SWE"


def test_change_annotations_include_generated_claim_audit_fields() -> None:
    profile = _profile()
    job = _senior_job()
    plan = build_tailoring_plan(
        profile,
        job,
        employer_analysis=_requirement_analysis(),
        requirement_fit_report=_requirement_fit_report(),
    )
    payload = _payload(bullet="Owned Python API reliability and reduced latency 35% using PostgreSQL.")
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

    from tests.determination_fakes import draft_anchor_fields

    annotations = [
        item.to_dict() for item in build_tailoring_change_annotations(profile, job, draft_anchor_fields(payload), plan)
    ]

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

    assert plan.required_evidence_ids == ()
    assert plan.job_keywords[0] == "Python API reliability"
    assert plan.prohibited_claims == ("Direct Salesforce administration.",)
    assert [item.action for item in plan.requirement_directives] == [
        "double_down",
        "avoid_claim",
    ]
    prompt = plan.to_prompt_dict()
    assert prompt["requirement_directives"][0]["allowed_evidence_ids"] == ["ev_latency"]
    assert prompt["requirement_directives"][1]["prohibited_claims"] == ["Direct Salesforce administration."]


def test_build_tailoring_plan_rejects_cross_job_requirement_fit_report() -> None:
    analysis = _requirement_analysis()
    stale_report = _requirement_fit_report(_OTHER_JOB_ID)

    with pytest.raises(TailoringPrerequisiteError) as raised:
        build_tailoring_plan(
            _profile(),
            _senior_job(),
            employer_analysis=analysis,
            requirement_fit_report=stale_report,
        )

    assert raised.value.reason == "requirement_fit_job_mismatch"
    assert raised.value.error_code == "REQUIREMENT_FIT_STALE"


def test_build_tailoring_plan_rejects_stale_requirement_fit_generation() -> None:
    analysis = _requirement_analysis()
    stale_report = replace(
        _requirement_fit_report(),
        employer_analysis_generation=analysis.generation + 1,
    )

    with pytest.raises(TailoringPrerequisiteError) as raised:
        build_tailoring_plan(
            _profile(),
            _senior_job(),
            employer_analysis=analysis,
            requirement_fit_report=stale_report,
        )

    assert raised.value.reason == "requirement_fit_generation_mismatch"
    assert raised.value.report_generation == 2


def test_tailoring_plan_metadata_preserves_full_keyword_audit_set() -> None:
    analysis = _employer_analysis(*[f"skill-{index}" for index in range(20)])

    plan = build_tailoring_plan(_profile(), _senior_job(), employer_analysis=analysis)

    assert len(plan.job_keywords) > 16
    assert plan.to_metadata()["job_keywords"] == list(plan.job_keywords)


def build_tailoring_plan(profile, job, **kwargs):
    kwargs.setdefault("job_interpretation", job_interpretation(kwargs["employer_analysis"].canonical.requirements))
    return _build_tailoring_plan(profile, job, **kwargs)
