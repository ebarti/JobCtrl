from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobhunter import config
from jobhunter.database import close_connection, init_db
from jobhunter.discovery.workday import store_results


@pytest.fixture
def conn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    connection = init_db(db_path)
    yield connection
    close_connection(db_path)


def test_workday_store_results_publishes_discovery_events(
    conn: sqlite3.Connection,
) -> None:
    jobs = [
        {
            "title": "Director of Engineering",
            "location": "Barcelona, Spain",
            "external_path": "/External/job/Barcelona/Director-of-Engineering_JR-123",
            "apply_url": "https://acme.wd1.myworkdayjobs.com/External/job/Barcelona/Director-of-Engineering_JR-123",
            "job_req_id": "JR-123",
            "employer_key": "acme",
            "employer_name": "Acme",
            "full_description": "Lead engineering teams building local-first products.",
        }
    ]
    employers = {
        "acme": {
            "name": "Acme",
            "base_url": "https://acme.wd1.myworkdayjobs.com",
            "site_id": "External",
            "_source_id": "workday:acme",
        }
    }

    new, existing = store_results(
        conn,
        jobs,
        employers,
        run_id="discovery:workday:test",
    )

    assert (new, existing) == (1, 0)
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert (
        conn.execute("SELECT COUNT(*) FROM job_source_observations").fetchone()[0]
        == 1
    )
    event_types = [
        row["event_type"]
        for row in conn.execute(
            "SELECT event_type FROM job_events ORDER BY event_id"
        ).fetchall()
    ]
    assert "JobDiscovered" in event_types
    observed = conn.execute(
        "SELECT payload_json FROM job_events WHERE event_type = 'JobSourceObserved'"
    ).fetchone()
    assert json.loads(observed["payload_json"])["source_id"] == "workday:acme"
