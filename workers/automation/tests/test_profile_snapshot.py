"""Tests for ``ProfileSnapshot`` — the published Profile read view (S-13)."""

from __future__ import annotations

from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT


def _profile() -> Profile:
    return Profile.from_dict(
        LOCAL_TENANT,
        {
            "personal": {"full_name": "Jordan", "email": "jordan@example.com"},
            "compensation": {"salary_expectation": "100000"},
            "resume": {
                "executive_profile": {"baseline_text": "Engineer."},
                "experience_entries": [
                    {
                        "id": "role_1",
                        "title": "SWE",
                        "company": "Acme",
                        "date_range": "2022 -- Present",
                        "location": "Remote",
                        "bullets": ["Maintained 99% uptime."],
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
            },
            "resume_constraints": {"real_metrics": ["99%"]},
        },
    )


def test_from_profile_sets_metadata_and_default_version():
    snapshot = ProfileSnapshot.from_profile(_profile())

    assert snapshot.tenant_id == LOCAL_TENANT
    assert snapshot.profile_id == "default"
    assert snapshot.version == 1


def test_from_profile_explicit_version():
    snapshot = ProfileSnapshot.from_profile(_profile(), version=42)
    assert snapshot.version == 42


def test_as_dict_returns_canonical_plus_legacy_augmentation():
    snapshot = ProfileSnapshot.from_profile(_profile())
    data = snapshot.as_dict()

    assert data["personal"]["full_name"] == "Jordan"
    # Augmented legacy fields are present on the snapshot view ...
    assert data["skills_boundary"] == {"lang": ["Python", "Go"]}
    assert data["resume_facts"]["preserved_companies"] == ["Acme"]
    assert data["resume_facts"]["real_metrics"] == ["99%"]
    assert "BS CS" in data["resume_facts"]["preserved_school"]


def test_as_dict_returns_deep_copy_so_consumers_cannot_mutate_source():
    snapshot = ProfileSnapshot.from_profile(_profile())

    first = snapshot.as_dict()
    first["personal"]["full_name"] = "Mutated"
    first["skills_boundary"]["lang"].append("MUTATION")
    first["resume"]["experience_entries"][0]["bullets"].append("MUTATION")

    second = snapshot.as_dict()
    assert second["personal"]["full_name"] == "Jordan"
    assert second["skills_boundary"]["lang"] == ["Python", "Go"]
    assert second["resume"]["experience_entries"][0]["bullets"] == [
        "Maintained 99% uptime."
    ]


def test_property_accessors_also_deep_copy():
    snapshot = ProfileSnapshot.from_profile(_profile())

    personal = snapshot.personal
    personal["full_name"] = "Mutated"

    # Source is unchanged.
    assert snapshot.personal["full_name"] == "Jordan"
