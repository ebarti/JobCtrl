"""Phase 6 / S-21: ContentValidator pure-function behaviour tests.

These tests pin the validation rules that previously lived in
``scoring/validator.py`` and now live in
``jobhunter.domain.materials.services.ContentValidator``. Coverage matches
the legacy module: banned words / fabrication / structural checks for
both the JSON-side and the rendered-text side, plus cover letters.
"""

from __future__ import annotations

from jobhunter.domain.materials import ValidationResult
from jobhunter.domain.materials.services import (
    BANNED_WORDS,
    ContentValidator,
    LLM_LEAK_PHRASES,
    ResumeAssembler,
    sanitize_text,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


_VALIDATOR = ContentValidator()
_ASSEMBLER = ResumeAssembler()


def _profile() -> dict:
    return {
        "personal": {"full_name": "Jane Doe", "email": "jane@example.com"},
        "resume": {
            "executive_profile": {"baseline_text": "Senior engineer."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": ["Built a distributed system."],
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
            },
        },
    }


def _good_payload() -> dict:
    return {
        "executive_profile": "Engineer focused on systems work.",
        "experience_updates": [
            {"id": "acme_swe", "bullets": ["Designed services at scale.", "Cut latency."]}
        ],
        "skill_category_updates": [
            {"id": "languages", "items": ["Python", "Go"]},
        ],
    }


# ---------------------------------------------------------------------------
# JSON validation
# ---------------------------------------------------------------------------


def test_validate_json_fields_passes_for_compliant_payload() -> None:
    result = _VALIDATOR.validate_json_fields(_good_payload(), _profile())
    assert isinstance(result, ValidationResult)
    assert result.passed is True


def test_validate_json_fields_rejects_missing_executive_profile() -> None:
    payload = _good_payload()
    payload["executive_profile"] = ""
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("executive_profile" in err for err in result.errors)


def test_validate_json_fields_rejects_missing_required_experience_id() -> None:
    payload = _good_payload()
    payload["experience_updates"] = [
        {"id": "wrong_id", "bullets": ["b"]},
    ]
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("Missing experience updates" in err for err in result.errors)


def test_validate_json_fields_rejects_too_many_bullets() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = ["b"] * 99
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("exceeds 4 bullets" in err for err in result.errors)


def test_validate_json_fields_allows_mandatory_requirement_coverage_overflow() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = [
        "Pinned bullet.",
        "Covered requirement one.",
        "Covered requirement two.",
        "Covered requirement three.",
        "Covered requirement four.",
    ]
    payload["generated_claim_mappings"] = [
        {
            "claim_id": f"claim-{index}",
            "location": f"experience.acme_swe.bullets[{index}]",
            "text": bullet,
            "claim_label": "evidence_reframed",
            "coverage_edge_ids": [f"edge-{index}"] if index else [],
            "requirement_ids": [f"req-{index}"] if index else [],
            "evidence_ids": [f"ev-{index}"] if index else [],
            "non_requirement_reason": "pinned" if index == 0 else "",
            "review_required": False,
        }
        for index, bullet in enumerate(payload["experience_updates"][0]["bullets"])
    ]

    result = _VALIDATOR.validate_json_fields(payload, _profile())

    assert result.passed is True


def test_resume_assembler_preserves_mandatory_requirement_coverage_overflow() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = [
        "Pinned bullet.",
        "Covered requirement one.",
        "Covered requirement two.",
        "Covered requirement three.",
        "Covered requirement four.",
    ]
    payload["generated_claim_mappings"] = [
        {
            "claim_id": f"claim-{index}",
            "location": f"experience.acme_swe.bullets[{index}]",
            "text": bullet,
            "claim_label": "evidence_reframed",
            "coverage_edge_ids": [f"edge-{index}"] if index else [],
            "requirement_ids": [f"req-{index}"] if index else [],
            "evidence_ids": [f"ev-{index}"] if index else [],
            "non_requirement_reason": "pinned" if index == 0 else "",
            "review_required": False,
        }
        for index, bullet in enumerate(payload["experience_updates"][0]["bullets"])
    ]

    assert _VALIDATOR.validate_json_fields(payload, _profile()).passed is True

    rendered = _ASSEMBLER.assemble_resume_text(payload, _profile())

    assert "- Covered requirement four." in rendered


def test_validate_json_fields_rejects_rewritten_experience_title() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["title"] = "Senior SWE - Platform Infrastructure"
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("Unsupported title rewrite" in err for err in result.errors)


def test_validate_json_fields_accepts_empty_or_exact_source_title() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["title"] = ""
    assert _VALIDATOR.validate_json_fields(payload, _profile()).passed is True

    payload["experience_updates"][0]["title"] = "Senior SWE"
    assert _VALIDATOR.validate_json_fields(payload, _profile()).passed is True


def test_validate_json_fields_rejects_job_only_skill_items() -> None:
    payload = _good_payload()
    payload["skill_category_updates"][0]["items"] = ["Python", "Kubernetes Operators"]
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("Fabricated skill: 'Kubernetes Operators'" in err for err in result.errors)


def test_validate_json_fields_normal_mode_warns_about_banned_words() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = ["passionate about robust solutions"]
    result = _VALIDATOR.validate_json_fields(payload, _profile(), mode="normal")
    # Banned words are warnings in normal mode — but other errors may exist.
    assert any("Banned words" in w for w in result.warnings)


def test_validate_json_fields_strict_mode_fails_on_banned_words() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = ["passionate"]
    result = _VALIDATOR.validate_json_fields(payload, _profile(), mode="strict")
    assert result.passed is False
    assert any("Banned words" in err for err in result.errors)


def test_validate_json_fields_lenient_mode_ignores_banned_words() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = ["passionate"]
    result = _VALIDATOR.validate_json_fields(payload, _profile(), mode="lenient")
    assert all("Banned words" not in w for w in result.warnings)


def test_validate_json_fields_detects_fabrication_watch_terms() -> None:
    payload = _good_payload()
    payload["experience_updates"][0]["bullets"] = ["led django microservices"]
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("Fabricated skill" in err for err in result.errors)


def test_validate_json_fields_detects_llm_self_talk() -> None:
    payload = _good_payload()
    payload["executive_profile"] = "I am sorry, here is the corrected version."
    result = _VALIDATOR.validate_json_fields(payload, _profile())
    assert result.passed is False
    assert any("LLM self-talk" in err for err in result.errors)


# ---------------------------------------------------------------------------
# Rendered tailored resume validation
# ---------------------------------------------------------------------------


def test_validate_tailored_resume_passes_when_all_required_sections_present() -> None:
    text = (
        "EXECUTIVE PROFILE\nbody.\n\n"
        "EXPERIENCE\nAcme Corp\n\n"
        "EDUCATION\nState University\n\n"
        "SKILLS\nLanguages: Python\n"
    )
    result = _VALIDATOR.validate_tailored_resume(text, _profile())
    assert result.passed is True


def test_validate_tailored_resume_flags_missing_section() -> None:
    text = "EXECUTIVE PROFILE\nbody."  # missing EXPERIENCE/EDUCATION/SKILLS
    result = _VALIDATOR.validate_tailored_resume(text, _profile())
    assert result.passed is False
    assert any("Missing required section" in err for err in result.errors)


def test_validate_tailored_resume_flags_missing_required_company() -> None:
    text = (
        "EXECUTIVE PROFILE\nbody.\n\n"
        "EXPERIENCE\n(no companies here)\n\n"
        "EDUCATION\nState University\n\n"
        "SKILLS\nLanguages: Python\n"
    )
    result = _VALIDATOR.validate_tailored_resume(text, _profile())
    assert result.passed is False
    assert any("Acme Corp" in err for err in result.errors)


# ---------------------------------------------------------------------------
# Cover letter validation
# ---------------------------------------------------------------------------


def test_validate_cover_letter_passes_for_clean_letter() -> None:
    text = "Dear Hiring Manager,\n\nI built distributed systems at Acme.\n\nJane"
    result = _VALIDATOR.validate_cover_letter(text)
    assert result.passed is True


def test_validate_cover_letter_rejects_incomplete_mid_sentence_draft() -> None:
    text = (
        "Dear Hiring Manager,\n\n"
        "At Welltech, I built an AI-assisted developer workflow that accelerated content production 3x "
        "and decreased code review turnaround by 40%. This platform integrated LLM-based"
    )
    result = _VALIDATOR.validate_cover_letter(text)
    assert result.passed is False
    assert any("closing" in err.lower() for err in result.errors)


def test_validate_cover_letter_rejects_em_dash() -> None:
    text = "Dear Hiring Manager — I built systems."
    result = _VALIDATOR.validate_cover_letter(text)
    assert result.passed is False
    assert any("em dash" in err.lower() for err in result.errors)


def test_validate_cover_letter_rejects_when_not_starting_with_dear() -> None:
    text = "Hello, my name is Jane."
    result = _VALIDATOR.validate_cover_letter(text)
    assert result.passed is False
    assert any("Dear" in err for err in result.errors)


def test_validate_cover_letter_strict_mode_word_limit() -> None:
    text = "Dear Hiring Manager, " + ("word " * 300)
    result = _VALIDATOR.validate_cover_letter(text, mode="strict")
    assert result.passed is False
    assert any("Too long" in err for err in result.errors)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def test_banned_words_constant_includes_known_offenders() -> None:
    for word in ("passionate", "robust", "synergy"):
        assert word in BANNED_WORDS


def test_llm_leak_phrases_includes_known_apologies() -> None:
    assert "i am sorry" in LLM_LEAK_PHRASES


def test_sanitize_text_normalises_em_dash() -> None:
    assert "—" not in sanitize_text("foo — bar")
