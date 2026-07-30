"""Cross-runtime contract for the historical event JobId upcast."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from jobctrl.infrastructure.events.identity_upcast import (
    EventIdentityUpcastError,
    upcast_event_identity,
)

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/event_identity_upcast_v1.json"
)
_FIXTURE: dict[str, Any] = json.loads(_FIXTURE_PATH.read_text())


@pytest.fixture
def seeded_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE jobs (
            tenant_id TEXT NOT NULL,
            job_id TEXT NOT NULL,
            url TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            UNIQUE (tenant_id, url)
        );
        CREATE TABLE job_identity_aliases (
            tenant_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            job_id TEXT NOT NULL,
            PRIMARY KEY (tenant_id, alias_kind, alias_value)
        );
        """
    )
    for job in _FIXTURE["jobs"]:
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
            (job["tenantId"], job["jobId"], job["postingUrl"]),
        )
        for alias in job.get("aliases", []):
            conn.execute(
                """
                INSERT INTO job_identity_aliases (
                    tenant_id, alias_kind, alias_value, job_id
                ) VALUES (?, 'posting_url', ?, ?)
                """,
                (job["tenantId"], alias, job["jobId"]),
            )
    try:
        yield conn
    finally:
        conn.close()


@pytest.mark.parametrize("case", _FIXTURE["cases"], ids=lambda case: case["name"])
def test_event_identity_upcast_shared_contract(
    seeded_conn: sqlite3.Connection,
    case: dict[str, Any],
) -> None:
    expected_error = case.get("expectedError")
    if expected_error:
        with pytest.raises(EventIdentityUpcastError) as exc_info:
            upcast_event_identity(
                seeded_conn,
                tenant_id=case["tenantId"],
                event_job_reference=case["eventJobReference"],
                payload=case["payload"],
            )
        assert exc_info.value.code == expected_error
        assert str(exc_info.value) == expected_error
        if case["eventJobReference"]:
            assert case["eventJobReference"] not in str(exc_info.value)
        return

    result = upcast_event_identity(
        seeded_conn,
        tenant_id=case["tenantId"],
        event_job_reference=case["eventJobReference"],
        payload=case["payload"],
    )
    assert {
        "jobId": result.job_id,
        "referencedJobIds": list(result.referenced_job_ids),
        "payload": result.payload,
    } == case["expected"]
    assert result.version == _FIXTURE["version"]
