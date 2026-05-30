from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.enrichment import detail
from jobhunter.enrichment.detail import (
    _record_posting_snapshot_from_cascade,
    scrape_detail_page,
)


class _FakeResponse:
    status = 200


class _FakePage:
    url = "https://example.com/jobs/closed"

    def goto(self, *_args, **_kwargs):
        return _FakeResponse()

    def wait_for_load_state(self, *_args, **_kwargs) -> None:
        return None

    def title(self) -> str:
        return "Closed engineering role"


def _long_description() -> str:
    return "Build reliable distributed systems with Python, TypeScript, and Postgres. " * 8


def test_scrape_detail_page_reports_expired_json_ld_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        detail,
        "_collect_json_ld",
        lambda _page: [
            {
                "@type": "JobPosting",
                "description": _long_description(),
                "directApply": True,
                "url": "https://example.com/jobs/closed/apply",
                "validThrough": "2000-01-01T00:00:00+00:00",
            }
        ],
    )
    monkeypatch.setattr(detail, "_collect_main_content", lambda _page: "<main>Expired role</main>")

    result = scrape_detail_page(_FakePage(), "https://example.com/jobs/closed")

    assert result["status"] == "inactive"
    assert result["active_state"] == "expired"
    assert result["verification_method"] == "json_ld_valid_through"
    assert result["full_description"]


def test_scrape_detail_page_reports_closed_marker_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detail, "_collect_json_ld", lambda _page: [])
    monkeypatch.setattr(
        detail,
        "_collect_main_content",
        lambda _page: (
            "<main><p>This position is no longer accepting applications.</p>"
            f"<div id='job-description'>{_long_description()}</div></main>"
        ),
    )

    result = scrape_detail_page(_FakePage(), "https://example.com/jobs/closed")

    assert result["status"] == "inactive"
    assert result["active_state"] == "closed"
    assert result["verification_method"] == "closed_marker"
    assert result["full_description"]


def test_inactive_cascade_snapshot_persists_closed_state(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        _record_posting_snapshot_from_cascade(
            conn,
            url="https://example.com/jobs/closed",
            source_id="jobspy",
            title="Closed engineering role",
            cascade_result={
                "status": "inactive",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": "https://example.com/jobs/closed/apply",
                "active_state": "closed",
                "verification_method": "closed_marker",
            },
            captured_at="2026-05-29T12:00:00+00:00",
        )

        snapshot_set = conn.execute(
            """
            SELECT latest_active_state
            FROM posting_snapshot_sets
            WHERE tenant_id = 'local' AND job_url = ?
            """,
            ("https://example.com/jobs/closed",),
        ).fetchone()
        event = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE event_type = 'JobActiveStateChanged'
            ORDER BY event_id DESC
            LIMIT 1
            """
        ).fetchone()

        assert snapshot_set["latest_active_state"] == "closed"
        assert json.loads(event["payload_json"])["active_state"] == "closed"
    finally:
        close_connection(db_path)
