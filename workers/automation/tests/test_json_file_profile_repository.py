"""Tests for ``JsonFileProfileRepository`` (Phase 4 / S-14)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.profile.json_file import JsonFileProfileRepository
from jobhunter.infrastructure.profile.pdf_parser import PyPdfProfileParser


def _valid_profile() -> dict:
    return {
        "personal": {"full_name": "Jordan", "email": "jordan@example.com"},
        "compensation": {"salary_expectation": "100000"},
        "resume": {
            "executive_profile": {"baseline_text": "Engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Software Engineer",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "bullets": ["Shipped APIs."],
                }
            ],
            "education_entries": [
                {
                    "id": "edu_1",
                    "degree": "BS",
                    "institution": "State U",
                    "location": "",
                    "date": "2019",
                }
            ],
            "skill_categories": [
                {"id": "lang", "label": "Languages", "items": ["Python"]}
            ],
        },
    }


def _new_repo(tmp_path: Path) -> tuple[JsonFileProfileRepository, list[DomainEvent], InProcessEventBus]:
    bus = InProcessEventBus()
    received: list[DomainEvent] = []
    bus.subscribe(None, received.append)
    repo = JsonFileProfileRepository(
        profile_path=tmp_path / "profile.json",
        publisher=bus,
        pdf_parser=PyPdfProfileParser(),
    )
    return repo, received, bus


def test_load_returns_none_when_profile_file_missing(tmp_path):
    repo, _, _ = _new_repo(tmp_path)
    assert repo.load(LOCAL_TENANT) is None


def test_load_snapshot_raises_when_profile_file_missing(tmp_path):
    repo, _, _ = _new_repo(tmp_path)
    with pytest.raises(FileNotFoundError):
        repo.load_snapshot(LOCAL_TENANT)


def test_save_writes_canonical_json_and_publishes_profile_updated(tmp_path):
    repo, events, _ = _new_repo(tmp_path)

    profile = Profile.from_dict(LOCAL_TENANT, _valid_profile())
    snapshot = repo.save(LOCAL_TENANT, profile)

    saved = json.loads((tmp_path / "profile.json").read_text(encoding="utf-8"))
    assert saved["personal"]["full_name"] == "Jordan"
    # Augmented fields must NEVER be persisted.
    assert "skills_boundary" not in saved
    assert "resume_facts" not in saved

    # Snapshot returned reflects what was persisted.
    assert snapshot.personal["full_name"] == "Jordan"

    # ProfileUpdated event was published exactly once.
    types = [e.event_type for e in events]
    assert types.count("ProfileUpdated") == 1
    payload = next(e.payload for e in events if e.event_type == "ProfileUpdated")
    assert "personal" in payload["changed_sections"]


def test_load_round_trips_save(tmp_path):
    repo, _, _ = _new_repo(tmp_path)
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))

    loaded = repo.load(LOCAL_TENANT)
    assert loaded is not None
    assert loaded.personal.full_name == "Jordan"
    assert loaded.experience_entries[0].id == "role_1"


def test_save_changed_sections_reports_only_real_diffs(tmp_path):
    """``ProfileUpdated.changed_sections`` must reflect the actual diff against
    the previous on-disk profile, not the entire set of present keys."""
    repo, events, _ = _new_repo(tmp_path)

    # First save — every section is "added" because nothing existed before.
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))
    first = next(e for e in events if e.event_type == "ProfileUpdated")
    assert "personal" in first.payload["changed_sections"]
    events.clear()

    # Second save with an unchanged profile — diff is empty.
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))
    unchanged = next(e for e in events if e.event_type == "ProfileUpdated")
    assert unchanged.payload["changed_sections"] == ()
    events.clear()

    # Third save mutating ONLY personal.full_name — only "personal" is reported.
    bumped = _valid_profile()
    bumped["personal"]["full_name"] = "Jordan Updated"
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, bumped))
    diff_event = next(e for e in events if e.event_type == "ProfileUpdated")
    assert diff_event.payload["changed_sections"] == ("personal",)


def test_save_increments_snapshot_version(tmp_path):
    repo, _, _ = _new_repo(tmp_path)
    profile = Profile.from_dict(LOCAL_TENANT, _valid_profile())

    first = repo.save(LOCAL_TENANT, profile)
    second = repo.save(LOCAL_TENANT, profile)

    assert second.version == first.version + 1


def test_import_from_pdf_publishes_profile_imported_event_with_fake_parser(tmp_path):
    bus = InProcessEventBus()
    received: list[DomainEvent] = []
    bus.subscribe(None, received.append)

    class FakeParser:
        def parse(self, pdf_bytes, *, filename, base_profile, base_style):
            assert pdf_bytes == b"%PDF"
            assert filename == "resume.pdf"
            return {
                "profile": {"personal": {"full_name": "Imported"}},
                "style": {"font_family": "imported"},
                "source": {"filename": filename, "pages": 1},
            }

    repo = JsonFileProfileRepository(
        profile_path=tmp_path / "profile.json",
        publisher=bus,
        pdf_parser=FakeParser(),
    )

    result = repo.import_from_pdf(LOCAL_TENANT, b"%PDF", filename="resume.pdf")

    assert result.profile == {"personal": {"full_name": "Imported"}}
    assert result.style == {"font_family": "imported"}
    assert result.source["pages"] == 1

    types = [e.event_type for e in received]
    assert types == ["ProfileImported"]
    assert received[0].payload["source"] == "resume.pdf"


def test_import_from_pdf_passes_existing_profile_as_base(tmp_path):
    captured: dict[str, object] = {}

    class CapturingParser:
        def parse(self, pdf_bytes, *, filename, base_profile, base_style):
            captured["base_profile"] = base_profile
            return {"profile": {}, "style": {}, "source": {}}

    bus = InProcessEventBus()
    repo = JsonFileProfileRepository(
        profile_path=tmp_path / "profile.json",
        publisher=bus,
        pdf_parser=CapturingParser(),
    )

    # No existing profile — base_profile should be None.
    repo.import_from_pdf(LOCAL_TENANT, b"%PDF")
    assert captured["base_profile"] is None

    # Save a profile, then re-import — base_profile is the canonical dict.
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _valid_profile()))
    repo.import_from_pdf(LOCAL_TENANT, b"%PDF")
    base = captured["base_profile"]
    assert isinstance(base, dict)
    assert base["personal"]["full_name"] == "Jordan"
