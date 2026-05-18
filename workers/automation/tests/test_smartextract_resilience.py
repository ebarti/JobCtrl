from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter import config
from jobhunter.discovery import smartextract


def test_smart_extract_counts_site_timeouts_without_aborting_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobhunter.db")

    def fake_run_one_site(name: str, url: str) -> dict:
        if name == "Slow Board":
            raise TimeoutError("Timeout 30000ms exceeded.")
        return {
            "name": name,
            "status": "FAIL",
            "strategy": "css_selectors",
            "total": 0,
            "titles": 0,
            "jobs": [],
        }

    monkeypatch.setattr(smartextract, "_run_one_site", fake_run_one_site)

    result = smartextract._run_all(
        [
            {"name": "Slow Board", "url": "https://slow.example/jobs"},
            {"name": "Empty Board", "url": "https://empty.example/jobs"},
        ],
        accept_locs=[],
        reject_locs=[],
        workers=1,
    )

    assert result == {
        "total_new": 0,
        "total_existing": 0,
        "passed": 0,
        "errors": 1,
        "total": 2,
    }
