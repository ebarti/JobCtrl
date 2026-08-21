"""Tests for the Profile aggregate root and value objects (Phase 4 / S-13).

Covers:
  - ``Profile.from_dict`` validates structural invariants and raises
    ``InvalidProfileError`` with all reasons gathered.
  - ``Profile.to_dict`` round-trips: ``from_dict(d).to_dict()`` is structurally
    equivalent to the input for canonical fields.
  - Value object normalisation: TailoringPolicy strict mode forces every
    flag to False; WritingStyle clamps unknown enum values to defaults.
  - ``required_*_ids`` helpers fall back to the full set when no explicit IDs
    are supplied.
"""

from __future__ import annotations

import pytest

from jobctrl.domain.profile.aggregate import (
    DEFAULT_PROFILE_ID,
    InvalidProfileError,
    Profile,
)
from jobctrl.domain.profile.value_objects import (
    TailoringPolicy,
    WritingStyle,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.resume_profile import (
    get_achievement_evidence,
    get_auto_approvable_claim_modes,
    get_claim_mode,
    get_tailoring_quality_controls,
)


def _valid_profile_dict() -> dict:
    return {
        "personal": {"full_name": "Jordan Candidate", "email": "jordan@example.com"},
        "work_authorization": {"legally_authorized_to_work": "Yes"},
        "compensation": {"salary_expectation": "120000", "salary_currency": "USD"},
        "experience": {"years_of_experience_total": "5", "education_level": "Bachelor's"},
        "availability": {"earliest_start_date": "Immediately"},
        "eeo_voluntary": {"gender": "Decline to self-identify"},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Software Engineer",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "summary": "Owned the backend platform mandate.",
                    "bullets": ["Built APIs.", "Reduced incidents 40%."],
                }
            ],
            "education_entries": [
                {
                    "id": "edu_1",
                    "degree": "BS CS",
                    "institution": "State U",
                    "location": "Springfield",
                    "date": "2019",
                }
            ],
            "skill_categories": [
                {"id": "lang", "label": "Languages", "items": ["Python", "Go"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["role_1"],
                "required_skill_category_ids": ["lang"],
                "max_experience_bullets": 3,
                "tailoring_policy": {"mode": "balanced"},
                "writing_style": {"tone": "technical"},
            },
        },
        "resume_constraints": {"real_metrics": ["40%"]},
    }


def test_from_dict_parses_valid_profile():
    profile = Profile.from_dict(LOCAL_TENANT, _valid_profile_dict())

    assert profile.tenant_id == LOCAL_TENANT
    assert profile.profile_id == DEFAULT_PROFILE_ID
    assert profile.personal.full_name == "Jordan Candidate"
    assert profile.compensation.salary_expectation == "120000"
    assert profile.experience_metadata.years_of_experience_total == "5"
    assert len(profile.experience_entries) == 1
    assert profile.experience_entries[0].summary == "Owned the backend platform mandate."
    assert profile.experience_entries[0].bullets == ("Built APIs.", "Reduced incidents 40%.")
    assert profile.experience_entries[0].achievement_evidence == ()
    assert profile.tailoring_rules.max_experience_bullets == 3
    assert profile.resume_constraints.real_metrics == ("40%",)


def test_from_dict_preserves_unassigned_legacy_metrics_in_compatibility_index():
    raw = _valid_profile_dict()
    raw["resume_constraints"] = {
        "real_metrics": ["Unassigned synthetic legacy metric: 99.9% uptime"]
    }

    profile = Profile.from_dict(LOCAL_TENANT, raw)

    assert profile.resume_constraints.real_metrics == (
        "40%",
        "Unassigned synthetic legacy metric: 99.9% uptime",
    )


def test_get_achievement_evidence_derives_legacy_bullets_when_explicit_evidence_missing():
    evidence = get_achievement_evidence(_valid_profile_dict())

    assert [item["id"] for item in evidence] == ["role_1_bullet_1", "role_1_bullet_2"]
    assert [item["source_text"] for item in evidence] == ["Built APIs.", "Reduced incidents 40%."]
    assert evidence[1]["metrics"] == ["40%"]
    assert all(item["experience_entry_id"] == "role_1" for item in evidence)
    assert all(item["evidence_strength"] == "supported" for item in evidence)
    assert all(item["user_confirmed"] is True for item in evidence)


def test_get_achievement_evidence_rederives_materialized_legacy_bullets():
    profile = _valid_profile_dict()
    entry = profile["resume"]["experience_entries"][0]
    entry["achievement_evidence"] = [
        {
            "id": "role_1_bullet_1",
            "source_text": "Reduced incidents 40%.",
            "scope": "Software Engineer Acme",
            "action": "Reduced incidents 40%.",
            "tools": [],
            "metrics": ["40%"],
            "outcome": "Reduced incidents 40%.",
            "seniority_signal": "",
            "evidence_strength": "supported",
            "claim_confidence": 0.8,
            "user_confirmed": True,
            "tags": [],
        }
    ]
    entry["bullets"] = ["Reduced incidents 55%."]

    evidence = get_achievement_evidence(profile)

    assert [item["id"] for item in evidence] == ["role_1_bullet_1"]
    assert evidence[0]["source_text"] == "Reduced incidents 55%."
    assert evidence[0]["metrics"] == ["55%"]


def test_from_dict_rejects_missing_resume_block():
    with pytest.raises(InvalidProfileError) as exc:
        Profile.from_dict(LOCAL_TENANT, {"personal": {"full_name": "X"}})

    assert any("'resume'" in reason for reason in exc.value.reasons)


def test_from_dict_requires_at_least_one_experience_entry():
    bad = _valid_profile_dict()
    bad["resume"]["experience_entries"] = []

    with pytest.raises(InvalidProfileError) as exc:
        Profile.from_dict(LOCAL_TENANT, bad)

    assert any("experience_entries" in reason for reason in exc.value.reasons)


def test_from_dict_collects_all_invariant_failures_at_once():
    bad = _valid_profile_dict()
    bad["resume"]["experience_entries"] = [{"id": ""}]
    bad["resume"]["skill_categories"] = [{"id": "", "label": ""}]

    with pytest.raises(InvalidProfileError) as exc:
        Profile.from_dict(LOCAL_TENANT, bad)

    reasons = exc.value.reasons
    # Multiple distinct invariant violations should be reported in one shot.
    assert any("missing 'id'" in reason for reason in reasons)
    assert any("missing 'title'" in reason for reason in reasons)
    assert any("missing 'company'" in reason for reason in reasons)
    assert any("skill_categories" in reason and "missing 'id'" in reason for reason in reasons)


def test_to_dict_round_trips_canonical_fields():
    original = _valid_profile_dict()
    parsed = Profile.from_dict(LOCAL_TENANT, original)
    out = parsed.to_dict()

    assert out["personal"]["full_name"] == original["personal"]["full_name"]
    assert out["resume"]["experience_entries"][0]["id"] == "role_1"
    assert out["resume"]["tailoring_rules"]["required_experience_entry_ids"] == ["role_1"]
    assert out["resume_constraints"]["real_metrics"] == ["40%"]
    # Augmented fields must NEVER appear on persisted output.
    assert "skills_boundary" not in out
    assert "resume_facts" not in out


def test_application_attestations_are_typed_and_round_trip():
    original = _valid_profile_dict()
    original["application_attestations"] = {
        "age_18_plus": True,
        "background_check_consent": None,
        "felony_conviction": "no",
        "previously_worked_at_employer": "unknown",
        "additional": {"requires_license": None, "can_travel": True},
    }
    original["application_preferences"] = {"how_heard": "Referral"}

    parsed = Profile.from_dict(LOCAL_TENANT, original)

    assert parsed.application_attestations.age_18_plus is True
    assert parsed.application_attestations.background_check_consent is None
    assert parsed.application_attestations.felony_conviction is False
    assert parsed.application_attestations.previously_worked_at_employer is None
    assert parsed.application_preferences.how_heard == "Referral"
    out = parsed.to_dict()
    assert out["application_attestations"] == {
        "age_18_plus": True,
        "background_check_consent": None,
        "felony_conviction": False,
        "previously_worked_at_employer": None,
        "additional": {"requires_license": None, "can_travel": True},
    }
    assert out["application_preferences"] == {"how_heard": "Referral"}


def test_to_dict_round_trips_achievement_evidence_and_claim_controls():
    original = _valid_profile_dict()
    original["resume"]["experience_entries"][0]["achievement_evidence"] = [
        {
            "id": "ev_role_1_latency",
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
    ]
    original["resume"]["tailoring_rules"]["tailoring_policy"] = {
        "mode": "aggressive",
        "claim_mode": "adjacent_translation",
        "auto_approvable_claim_modes": [
            "verified_only",
            "evidence_reframing",
            "adjacent_translation",
            "draft_requires_confirmation",
        ],
        "allow_adjacent_achievement_drafts": True,
    }

    out = Profile.from_dict(LOCAL_TENANT, original).to_dict()

    evidence = out["resume"]["experience_entries"][0]["achievement_evidence"][0]
    assert evidence == original["resume"]["experience_entries"][0]["achievement_evidence"][0]
    policy = out["resume"]["tailoring_rules"]["tailoring_policy"]
    assert policy["claim_mode"] == "adjacent_translation"
    assert policy["auto_approvable_claim_modes"] == [
        "verified_only",
        "evidence_reframing",
        "adjacent_translation",
    ]
    assert policy["allow_adjacent_achievement_drafts"] is False


def test_to_dict_preserves_unknown_top_level_keys_for_forward_compat():
    raw = _valid_profile_dict()
    raw["custom_section"] = {"future": "thing"}

    parsed = Profile.from_dict(LOCAL_TENANT, raw)
    assert parsed.extra == {"custom_section": {"future": "thing"}}

    out = parsed.to_dict()
    assert out["custom_section"] == {"future": "thing"}


def test_tailoring_policy_strict_mode_migrates_missing_controls_to_verified_only():
    policy = TailoringPolicy.from_dict({"mode": "strict"})

    assert policy.mode == "strict"
    assert not policy.allow_title_reframing
    assert not policy.allow_summary_rewrite
    assert not policy.allow_achievement_rewriting
    assert not policy.allow_skill_reordering
    assert not policy.allow_minor_inference
    assert policy.claim_mode == "verified_only"
    assert policy.auto_approvable_claim_modes == ("verified_only",)
    assert policy.allow_adjacent_achievement_drafts is False


def test_tailoring_policy_explicit_claim_policy_wins_over_legacy_mode():
    policy = TailoringPolicy.from_dict(
        {
            "mode": "strict",
            "allow_title_reframing": True,
            "allow_summary_rewrite": True,
            "allow_achievement_rewriting": True,
            "allow_skill_reordering": True,
            "allow_minor_inference": True,
            "claim_mode": "draft_requires_confirmation",
            "auto_approvable_claim_modes": ["verified_only", "draft_requires_confirmation"],
            "allow_adjacent_achievement_drafts": True,
        }
    )
    assert policy.mode == "strict"
    assert not policy.allow_title_reframing
    assert policy.allow_summary_rewrite
    assert policy.allow_achievement_rewriting
    assert policy.allow_skill_reordering
    assert policy.allow_minor_inference
    assert policy.claim_mode == "draft_requires_confirmation"
    assert policy.auto_approvable_claim_modes == ("verified_only",)
    assert policy.allow_adjacent_achievement_drafts is True


def test_tailoring_policy_filters_draft_claims_from_auto_approval():
    policy = TailoringPolicy.from_dict(
        {
            "mode": "aggressive",
            "claim_mode": "draft_requires_confirmation",
            "auto_approvable_claim_modes": ["draft_requires_confirmation"],
            "allow_adjacent_achievement_drafts": True,
        }
    )

    assert policy.claim_mode == "draft_requires_confirmation"
    assert policy.auto_approvable_claim_modes == ("verified_only", "evidence_reframing")
    assert policy.allow_adjacent_achievement_drafts is True


def test_resume_profile_helpers_return_normalized_evidence_controls():
    profile = _valid_profile_dict()
    profile["resume"]["experience_entries"][0]["achievement_evidence"] = [
        {
            "id": "ev_role_1_latency",
            "source_text": "Reduced latency.",
            "evidence_strength": "verified",
            "claim_confidence": 0.9,
            "user_confirmed": True,
        }
    ]
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {
        "mode": "strict",
        "claim_mode": "draft_requires_confirmation",
        "auto_approvable_claim_modes": ["verified_only", "draft_requires_confirmation"],
        "allow_adjacent_achievement_drafts": True,
    }

    assert get_claim_mode(profile) == "draft_requires_confirmation"
    assert get_auto_approvable_claim_modes(profile) == ["verified_only"]
    assert get_tailoring_quality_controls(profile) == {
        "claim_mode": "draft_requires_confirmation",
        "auto_approvable_claim_modes": ["verified_only"],
        "allow_adjacent_achievement_drafts": True,
    }
    assert get_achievement_evidence(profile) == [
        {
            "id": "ev_role_1_latency",
            "source_text": "Reduced latency.",
            "scope": "",
            "action": "",
            "tools": [],
            "metrics": [],
            "outcome": "",
            "seniority_signal": "",
            "evidence_strength": "verified",
            "claim_confidence": 0.9,
            "user_confirmed": True,
            "tags": [],
            "experience_entry_id": "role_1",
        }
    ]


def test_writing_style_clamps_unknown_enum_values():
    style = WritingStyle.from_dict(
        {
            "tone": "extra_super_pro_tone",
            "bullet_style": "wat",
            "verbosity": "yodel",
            "keyword_density": "max",
            "avoid_first_person": "yes",
        }
    )
    assert style.tone == "direct"
    assert style.bullet_style == "balanced"
    assert style.bullet_styles == ("impact", "technical_depth", "leadership")
    assert style.verbosity == "balanced"
    assert style.keyword_density == "natural"
    assert style.avoid_first_person is True


def test_extra_fields_are_immutable_after_parsing():
    """``frozen=True`` only blocks attribute reassignment — the ``extra`` field
    must also reject in-place mutation so the aggregate is genuinely immutable."""
    raw = _valid_profile_dict()
    raw["custom_section"] = {"future": "thing"}
    parsed = Profile.from_dict(LOCAL_TENANT, raw)

    with pytest.raises(TypeError):
        parsed.extra["bad"] = "should not write"  # type: ignore[index]


def test_required_bullets_mapping_is_immutable_after_parsing():
    raw = _valid_profile_dict()
    raw["resume"]["tailoring_rules"]["required_bullets_by_experience_id"] = {
        "role_1": ["bullet"]
    }
    parsed = Profile.from_dict(LOCAL_TENANT, raw)

    with pytest.raises(TypeError):
        parsed.tailoring_rules.required_bullets_by_experience_id["role_1"] = ()  # type: ignore[index]


def test_required_skills_mapping_is_immutable_after_parsing():
    raw = _valid_profile_dict()
    raw["resume"]["tailoring_rules"]["required_skills_by_category_id"] = {
        "lang": ["Python"]
    }
    parsed = Profile.from_dict(LOCAL_TENANT, raw)

    assert parsed.tailoring_rules.required_skills_by_category_id["lang"] == ("Python",)
    with pytest.raises(TypeError):
        parsed.tailoring_rules.required_skills_by_category_id["lang"] = ()  # type: ignore[index]


def test_required_helpers_fallback_to_all_when_unspecified():
    raw = _valid_profile_dict()
    raw["resume"]["tailoring_rules"]["required_experience_entry_ids"] = []
    raw["resume"]["tailoring_rules"]["required_education_entry_ids"] = []
    raw["resume"]["tailoring_rules"]["required_skill_category_ids"] = []

    parsed = Profile.from_dict(LOCAL_TENANT, raw)

    assert parsed.required_experience_ids() == ("role_1",)
    assert parsed.required_education_ids() == ("edu_1",)
    assert parsed.required_skill_category_ids() == ("lang",)
