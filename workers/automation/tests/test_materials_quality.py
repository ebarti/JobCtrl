"""Deterministic resume-tailoring quality checks."""

from __future__ import annotations

from jobhunter.domain.materials.quality import (
    build_tailoring_change_annotations,
    build_tailoring_plan,
    evaluate_tailoring_quality,
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
    plan = build_tailoring_plan(_profile(), _senior_job())

    assert plan.claim_mode == "evidence_reframing"
    assert plan.writing_style["bullet_style"] == "leadership"
    assert plan.target_seniority == "senior"


def test_build_tailoring_change_annotations_explain_reframed_resume_sections() -> None:
    profile = _profile()
    job = _senior_job()
    plan = build_tailoring_plan(profile, job)
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
        "claim mode: evidence_reframing",
        "adjacent drafts blocked",
    ]

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


def test_build_tailoring_plan_ignores_marketing_copy_when_extracting_keywords() -> None:
    job = {
        "url": "https://example.com/platform",
        "title": "Head of Platform Engineering",
        "full_description": (
            "Join Impress, Europe's leading health-tech innovator. Everyone deserves "
            "a smile they love. We are looking for an onsite leader in Barcelona. "
            "Own platform engineering, cloud infrastructure, Java, Node.js, "
            "Kubernetes, CI/CD, observability, incident management, developer "
            "productivity, cost optimization, security, resiliency, and disaster recovery."
        ),
    }

    plan = build_tailoring_plan(_profile(), job)

    assert "platform" in plan.job_keywords
    assert "kubernetes" in plan.job_keywords
    assert "ci/cd" in plan.job_keywords
    assert "observability" in plan.job_keywords
    assert "join" not in plan.job_keywords
    assert "impress" not in plan.job_keywords
    assert "innovator" not in plan.job_keywords
    assert "everyone" not in plan.job_keywords
    assert "smile" not in plan.job_keywords
    assert "barcelona" not in plan.job_keywords


def test_tailoring_plan_metadata_preserves_full_keyword_audit_set() -> None:
    job = {
        "url": "https://example.com/platform",
        "title": "Head of Platform Engineering",
        "skills": [f"Kubernetes capability {index}" for index in range(20)],
        "full_description": (
            "Own platform engineering, cloud infrastructure, Java, Node.js, "
            "Kubernetes, CI/CD, observability, incident management, developer "
            "productivity, cost optimization, security, resiliency, and disaster recovery."
        ),
    }

    plan = build_tailoring_plan(_profile(), job)

    assert len(plan.job_keywords) > 16
    assert plan.to_metadata()["job_keywords"] == list(plan.job_keywords)


def test_quality_rejects_unknown_metric_not_in_verified_profile_or_evidence() -> None:
    plan = build_tailoring_plan(_profile(), _senior_job())
    bullet = "Owned API latency work and reduced latency by 80% with Python."

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert result.passed is False
    assert any("Unknown metric" in error and "80%" in error for error in result.errors)


def test_quality_metric_claims_keep_readable_spacing() -> None:
    plan = build_tailoring_plan(_profile(), _senior_job())
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
    plan = build_tailoring_plan(_profile(), _senior_job())
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


def test_quality_requires_seniority_signal_for_senior_roles_when_evidence_exists() -> None:
    plan = build_tailoring_plan(_profile(), _senior_job())
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
        "url": "https://example.com/backend",
        "title": "Backend Engineer",
        "skills": ["Python"],
        "full_description": "Build Python backend services.",
    }
    plan = build_tailoring_plan(_profile(), job)
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
        "url": "https://example.com/backend",
        "title": "Backend Engineer",
        "skills": ["Python"],
        "full_description": "Build Python backend services.",
    }
    plan = build_tailoring_plan(_profile(), job)
    bullet = "Defined company-wide strategy for executive stakeholders."

    result = evaluate_tailoring_quality(
        _payload(bullet=bullet),
        _resume_text(bullet=bullet),
        plan,
    )

    assert any("Executive phrasing" in warning for warning in result.warnings)
