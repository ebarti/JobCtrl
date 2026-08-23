"""Phase 6 / S-21: ResumeAssembler pure-function behaviour tests.

The assembler builds the plain-text resume output from the LLM JSON
payload + canonical profile dict. Tests pin the section order, the
header injection (name + contact), and the master-bullet fallback when
the LLM omits an experience update.
"""

from __future__ import annotations

from jobctrl.domain.materials.services import ResumeAssembler


_ASSEMBLER = ResumeAssembler()


def _profile() -> dict:
    return {
        "personal": {
            "full_name": "Jane Doe",
            "email": "jane@example.com",
            "phone": "+1-555-0100",
            "website_url": "https://janedoe.com",
            "linkedin_url": "https://www.linkedin.com/in/janedoe",
        },
        "resume": {
            "executive_profile": {"baseline_text": "Master baseline summary."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "summary": "Owned the platform mandate — across regions.",
                    "bullets": ["Built a distributed system."],
                }
            ],
            "education_entries": [
                {
                    "id": "edu_state",
                    "degree": "BSc Computer Science",
                    "institution": "State University",
                    "location": "Anytown",
                    "date": "2015",
                }
            ],
            "skill_categories": [
                {"id": "languages", "label": "Languages", "items": ["Python", "Go"]},
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
            },
        },
    }


def _payload() -> dict:
    return {
        "executive_profile": "Tailored summary for the role.",
        "experience_updates": [
            {"id": "acme_swe", "bullets": ["Tailored bullet about latency."]},
        ],
        "skill_category_updates": [
            {"id": "languages", "items": ["Python", "Go", "Rust"]},
        ],
    }


# ---------------------------------------------------------------------------
# Header injection
# ---------------------------------------------------------------------------


def test_assembler_injects_personal_header() -> None:
    text = _ASSEMBLER.assemble_resume_text(_payload(), _profile())
    lines = text.splitlines()
    assert lines[0] == "Jane Doe"
    assert "jane@example.com" in lines[1]
    assert "+1-555-0100" in lines[1]


def test_assembler_emits_required_section_headings_in_order() -> None:
    text = _ASSEMBLER.assemble_resume_text(_payload(), _profile())
    indexes = [
        text.find("EXECUTIVE PROFILE"),
        text.find("EXPERIENCE"),
        text.find("EDUCATION"),
        text.find("SKILLS"),
    ]
    assert all(idx != -1 for idx in indexes)
    assert indexes == sorted(indexes)


# ---------------------------------------------------------------------------
# Tailoring policy + content
# ---------------------------------------------------------------------------


def test_assembler_uses_tailored_executive_profile_when_policy_allows() -> None:
    text = _ASSEMBLER.assemble_resume_text(_payload(), _profile())
    assert "Tailored summary for the role." in text
    assert "Master baseline summary." not in text


def test_assembler_falls_back_to_baseline_executive_profile_when_policy_disallows() -> None:
    profile = _profile()
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {"mode": "strict"}
    text = _ASSEMBLER.assemble_resume_text(_payload(), profile)
    assert "Master baseline summary." in text
    assert "Tailored summary for the role." not in text


def test_assembler_includes_master_bullets_when_llm_omits_update() -> None:
    payload = _payload()
    payload["experience_updates"] = []
    text = _ASSEMBLER.assemble_resume_text(payload, _profile())
    assert "Built a distributed system." in text


def test_assembler_emits_sanitized_position_summary_between_heading_and_bullets() -> None:
    text = _ASSEMBLER.assemble_resume_text(_payload(), _profile())

    heading_index = text.index("Senior SWE | Acme Corp")
    subtitle_index = text.index("Remote | 2020-Present")
    summary_index = text.index("Owned the platform mandate, across regions.")
    bullet_index = text.index("- Tailored bullet about latency.")

    assert heading_index < subtitle_index < summary_index < bullet_index
    assert "Owned the platform mandate — across regions." not in text


def test_assembler_preserves_required_skills_when_llm_omits_them() -> None:
    profile = _profile()
    profile["resume"]["tailoring_rules"]["required_skills_by_category_id"] = {
        "languages": ["Go"]
    }
    payload = _payload()
    payload["skill_category_updates"] = [
        {"id": "languages", "items": ["Python", "Rust"]},
    ]

    text = _ASSEMBLER.assemble_resume_text(payload, profile)

    assert "Languages: Python, Rust, Go" in text


def test_assembler_normalises_em_dashes_via_sanitize() -> None:
    payload = _payload()
    payload["experience_updates"][0]["bullets"] = ["Reduced latency — a lot."]
    text = _ASSEMBLER.assemble_resume_text(payload, _profile())
    assert "—" not in text


def test_assembler_handles_snapshot_input() -> None:
    """ResumeAssembler accepts ProfileSnapshot directly via its facade."""
    from jobctrl.domain.profile.aggregate import Profile
    from jobctrl.domain.profile.snapshot import ProfileSnapshot
    from jobctrl.domain.tenant import LOCAL_TENANT

    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, _profile()))
    text = _ASSEMBLER.assemble_resume_text(_payload(), snapshot)
    assert "Jane Doe" in text
