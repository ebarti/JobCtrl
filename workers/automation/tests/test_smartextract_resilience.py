from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor as RealThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl import config
from jobctrl.database import close_connection, init_db
from jobctrl.discovery import smartextract


def test_smart_extract_counts_site_timeouts_without_aborting_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobctrl.db")

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


def test_limited_smart_extract_uses_requested_workers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(smartextract, "init_db", lambda: init_db(db_path))
    init_db(db_path)
    close_connection(db_path)

    observed_max_workers: list[int | None] = []

    def recording_executor(*args, **kwargs):
        observed_max_workers.append(kwargs.get("max_workers") if "max_workers" in kwargs else args[0])
        return RealThreadPoolExecutor(*args, **kwargs)

    def fake_run_one_site(name: str, url: str) -> dict:
        return {
            "name": name,
            "status": "PASS",
            "strategy": "api_response",
            "total": 2,
            "titles": 2,
            "jobs": [
                {
                    "url": f"{url}/one",
                    "title": "Head of Engineering",
                    "location": "Barcelona, Spain",
                    "description": "Lead engineering teams.",
                },
                {
                    "url": f"{url}/two",
                    "title": "Director of Engineering",
                    "location": "Barcelona, Spain",
                    "description": "Own engineering delivery.",
                },
            ],
        }

    monkeypatch.setattr(smartextract, "ThreadPoolExecutor", recording_executor)
    monkeypatch.setattr(smartextract, "_run_one_site", fake_run_one_site)

    result = smartextract._run_all(
        [
            {"name": "Board A", "url": "https://a.example/jobs", "queries": ["Head of Engineering"]},
            {"name": "Board B", "url": "https://b.example/jobs", "queries": ["Director of Engineering"]},
            {"name": "Board C", "url": "https://c.example/jobs", "queries": ["VP of Engineering"]},
        ],
        accept_locs=["Barcelona, Spain"],
        reject_locs=[],
        workers=4,
        limit=2,
    )

    conn = init_db(db_path)
    try:
        stored_count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    finally:
        close_connection(db_path)

    assert observed_max_workers == [3]
    assert result["total_new"] == 2
    assert result["total"] == 3
    assert stored_count == 2
