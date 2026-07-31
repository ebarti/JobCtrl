"""Exact-v7 outreach persistence identity and tenant-isolation regressions."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.contact.outreach import (
    FollowUpSchedule,
    FollowUpState,
    OutreachThread,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus

_JOB_ID = JobId("00000000-0000-4000-8000-000000000001")


def _repo(tmp_path: Path) -> tuple[SqliteOutreachThreadRepository, sqlite3.Connection]:
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    return SqliteOutreachThreadRepository(conn, publisher=InProcessEventBus()), conn


def _thread(tenant_id: TenantId, *, scheduled: bool = False) -> OutreachThread:
    return OutreachThread(
        tenant_id=tenant_id,
        thread_id="thread-1",
        contact_id="contact-1",
        job_id=_JOB_ID,
        created_at="2026-07-31T00:00:00Z",
        updated_at="2026-07-31T00:00:00Z",
        follow_up=(
            FollowUpSchedule(
                state=FollowUpState.SCHEDULED,
                due_at="2026-08-07T00:00:00Z",
                basis="test",
            )
            if scheduled
            else FollowUpSchedule()
        ),
    )


def test_repository_uses_exact_v7_job_id_column_without_schema_repair(tmp_path: Path) -> None:
    repo, conn = _repo(tmp_path)
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(outreach_threads)")
    }
    assert "job_id" in columns
    assert "job_url" not in columns

    tenant = TenantId("tenant-a")
    repo.save(tenant, _thread(tenant))
    row = conn.execute(
        "SELECT tenant_id, thread_id, contact_id, job_id FROM outreach_threads"
    ).fetchone()
    assert tuple(row) == ("tenant-a", "thread-1", "contact-1", str(_JOB_ID))
    assert repo.load_for_contact(tenant, "contact-1", _JOB_ID) is not None


def test_outreach_job_url_is_rejected_before_any_write_or_event(tmp_path: Path) -> None:
    repo, conn = _repo(tmp_path)
    tenant = TenantId("tenant-a")
    with pytest.raises(ValueError, match="canonical UUID"):
        OutreachThread(
            tenant_id=tenant,
            thread_id="thread-1",
            contact_id="contact-1",
            job_id="https://jobs.example/1",  # type: ignore[arg-type]
            created_at="now",
            updated_at="now",
        )
    assert conn.execute("SELECT COUNT(*) FROM outreach_threads").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load_for_contact(tenant, "contact-1", "https://jobs.example/1")  # type: ignore[arg-type]


def test_outreach_rows_and_events_are_tenant_scoped_for_same_job_id(tmp_path: Path) -> None:
    repo, conn = _repo(tmp_path)
    tenant_a = TenantId("tenant-a")
    tenant_b = TenantId("tenant-b")
    repo.save(tenant_a, _thread(tenant_a, scheduled=True))
    repo.save(tenant_b, _thread(tenant_b, scheduled=True))

    assert repo.load(tenant_a, "thread-1").tenant_id == tenant_a  # type: ignore[union-attr]
    assert repo.load(tenant_b, "thread-1").tenant_id == tenant_b  # type: ignore[union-attr]
    rows = conn.execute(
        "SELECT tenant_id, job_id FROM outreach_threads ORDER BY tenant_id"
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("tenant-a", str(_JOB_ID)),
        ("tenant-b", str(_JOB_ID)),
    ]
    events = conn.execute(
        "SELECT tenant_id, job_id FROM job_events WHERE event_type = 'FollowUpScheduled' ORDER BY tenant_id"
    ).fetchall()
    assert [tuple(row) for row in events] == [
        ("tenant-a", str(_JOB_ID)),
        ("tenant-b", str(_JOB_ID)),
    ]
