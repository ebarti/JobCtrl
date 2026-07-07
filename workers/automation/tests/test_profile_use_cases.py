"""Tests for the Profile context use cases (Phase 4 / S-14)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.ports import ProfileImportResult
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.profile.use_cases import (
    GetProfileUseCase,
    ImportProfileUseCase,
    UpdateProfileUseCase,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository


def _valid_profile() -> dict:
    return {
        "personal": {"full_name": "Jordan"},
        "resume": {
            "executive_profile": {"baseline_text": "Engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "SWE",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "bullets": ["Shipped APIs."],
                }
            ],
            "education_entries": [],
            "skill_categories": [
                {"id": "lang", "label": "Languages", "items": ["Python"]}
            ],
        },
    }


def _repo(tmp_path: Path) -> SqliteProfileRepository:
    conn = sqlite3.connect(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    return SqliteProfileRepository(
        conn,
        publisher=InProcessEventBus(),
    )


def test_get_profile_use_case_returns_snapshot_after_save(tmp_path):
    repo = _repo(tmp_path)
    UpdateProfileUseCase(repository=repo)(_valid_profile())

    snapshot = GetProfileUseCase(repository=repo)()

    assert isinstance(snapshot, ProfileSnapshot)
    assert snapshot.personal["full_name"] == "Jordan"
    assert snapshot.tenant_id == LOCAL_TENANT


def test_get_profile_use_case_raises_when_no_profile_saved(tmp_path):
    use_case = GetProfileUseCase(repository=_repo(tmp_path))
    with pytest.raises(FileNotFoundError):
        use_case()


def test_update_profile_use_case_validates_dict_via_aggregate(tmp_path):
    use_case = UpdateProfileUseCase(repository=_repo(tmp_path))
    snapshot = use_case(_valid_profile())

    assert isinstance(snapshot, ProfileSnapshot)
    assert snapshot.personal["full_name"] == "Jordan"


def test_update_profile_use_case_rejects_invalid_input(tmp_path):
    use_case = UpdateProfileUseCase(repository=_repo(tmp_path))
    bad = _valid_profile()
    bad["resume"]["experience_entries"] = []

    from jobctrl.domain.profile.aggregate import InvalidProfileError

    with pytest.raises(InvalidProfileError):
        use_case(bad)


def test_import_profile_use_case_returns_repository_result(tmp_path):
    captured: dict[str, object] = {}

    class FakeRepo:
        def import_from_pdf(self, tenant_id, pdf_bytes, *, filename):
            captured["tenant_id"] = tenant_id
            captured["filename"] = filename
            return ProfileImportResult(
                profile={"personal": {"full_name": "Imported"}},
                style={"font_family": "imported"},
                source={"pages": 1},
            )

    use_case = ImportProfileUseCase(repository=FakeRepo())  # type: ignore[arg-type]
    result = use_case(b"%PDF", filename="resume.pdf")

    assert result.profile == {"personal": {"full_name": "Imported"}}
    assert captured["tenant_id"] == LOCAL_TENANT
    assert captured["filename"] == "resume.pdf"


def test_save_then_load_via_aggregate_round_trip(tmp_path):
    repo = _repo(tmp_path)
    profile = Profile.from_dict(LOCAL_TENANT, _valid_profile())

    repo.save(LOCAL_TENANT, profile)
    loaded = repo.load(LOCAL_TENANT)

    assert loaded is not None
    assert loaded.personal.full_name == "Jordan"
    assert loaded.experience_entries[0].id == "role_1"
