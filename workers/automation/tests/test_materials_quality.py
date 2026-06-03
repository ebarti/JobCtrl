"""Deterministic resume-tailoring quality checks."""

from __future__ import annotations

from jobhunter.domain.materials.quality import (
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
    assert "ev_latency" in plan.required_evidence_ids
    assert "ev_latency" in plan.seniority_evidence_ids
    assert "python" in plan.job_keywords
    assert "latency" in plan.job_keywords


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
