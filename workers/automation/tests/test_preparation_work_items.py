"""Preparation idempotency-key persistence tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.preparation import SqlitePreparationWorkItemRepository

_IDEMPOTENT_JOB_ID = canonical_job_id("1e7c4a99-8a1a-4969-85fe-402ad88bd372")
_VERSIONED_JOB_ID = canonical_job_id("7b6d6d88-8f7b-4d63-b9dd-a644bfdfaeef")
_TENANT_SCOPED_JOB_ID = canonical_job_id("3e6f909e-bb61-4ca6-a827-2b7bbfba57f5")
_NORMALIZED_EVENT_JOB_ID = canonical_job_id("17e78790-276c-4f51-93f1-4a8e1e95f995")
_MISSING_JOB_ID = canonical_job_id("e1f0c42f-4a31-43a1-97d8-6964171e1f62")


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    connection = init_db(tmp_path / "jobctrl.db")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executemany(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        (
            (str(LOCAL_TENANT), str(_IDEMPOTENT_JOB_ID), "https://example.com/job/1"),
            (str(LOCAL_TENANT), str(_VERSIONED_JOB_ID), "https://example.com/job/2"),
            (str(LOCAL_TENANT), str(_TENANT_SCOPED_JOB_ID), "https://example.com/job/3"),
            ("other", str(_TENANT_SCOPED_JOB_ID), "https://example.com/other/job/3"),
            (str(LOCAL_TENANT), str(_NORMALIZED_EVENT_JOB_ID), "https://example.com/job/4"),
        ),
    )
    connection.commit()
    return connection


def test_enqueue_is_idempotent_for_work_item_key(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)

    first = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=_IDEMPOTENT_JOB_ID,
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=3,
        source_event_id="event-1",
        now="2026-05-26T00:00:00+00:00",
    )
    second = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=_IDEMPOTENT_JOB_ID,
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=3,
        source_event_id="event-1",
        now="2026-05-26T00:01:00+00:00",
    )

    assert second.item_id == first.item_id
    assert second.idempotency_key == first.idempotency_key
    count = conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0]
    assert count == 1


def test_enqueue_distinguishes_target_version_and_source_event(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    kwargs = {
        "tenant_id": LOCAL_TENANT,
        "job_id": _VERSIONED_JOB_ID,
        "kind": PreparationWorkItemKind.TAILOR_RESUME,
    }

    first = repo.enqueue(
        **kwargs,
        target_version=1,
        source_event_id="event-a",
        now="2026-05-26T00:00:00+00:00",
    )
    second = repo.enqueue(
        **kwargs,
        target_version=2,
        source_event_id="event-a",
        now="2026-05-26T00:01:00+00:00",
    )
    third = repo.enqueue(
        **kwargs,
        target_version=1,
        source_event_id="event-b",
        now="2026-05-26T00:02:00+00:00",
    )

    assert len({first.item_id, second.item_id, third.item_id}) == 3
    assert len({first.idempotency_key, second.idempotency_key, third.idempotency_key}) == 3


def test_enqueue_rejects_url_shaped_job_id(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)

    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        repo.enqueue(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("https://example.com/job/3"),
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=1,
        )

    assert conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0] == 0


def test_enqueue_normalizes_source_event_id_for_idempotency(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    kwargs = {
        "tenant_id": LOCAL_TENANT,
        "job_id": _NORMALIZED_EVENT_JOB_ID,
        "kind": PreparationWorkItemKind.SCORE_JOB,
        "target_version": 1,
    }

    first = repo.enqueue(
        **kwargs,
        source_event_id="event-a ",
        now="2026-05-26T00:00:00+00:00",
    )
    second = repo.enqueue(
        **kwargs,
        source_event_id="event-a",
        now="2026-05-26T00:01:00+00:00",
    )

    assert second.item_id == first.item_id
    assert second.idempotency_key == first.idempotency_key
    assert second.source_event_id == "event-a"
    assert conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0] == 1


def test_enqueue_scopes_canonical_job_id_by_tenant(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    kwargs = {
        "job_id": _TENANT_SCOPED_JOB_ID,
        "kind": PreparationWorkItemKind.SCORE_JOB,
        "target_version": 1,
        "source_event_id": "event-1",
        "now": "2026-05-26T00:00:00+00:00",
    }

    local_item = repo.enqueue(tenant_id=LOCAL_TENANT, **kwargs)
    other_tenant_item = repo.enqueue(tenant_id=TenantId("other"), **kwargs)

    assert local_item.tenant_id == LOCAL_TENANT
    assert other_tenant_item.tenant_id == TenantId("other")
    assert local_item.item_id != other_tenant_item.item_id
    assert conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0] == 2


def test_enqueue_rejects_nonexistent_and_cross_tenant_job_roots(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    kwargs = {
        "kind": PreparationWorkItemKind.SCORE_JOB,
        "target_version": 1,
    }

    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY constraint failed"):
        repo.enqueue(tenant_id=LOCAL_TENANT, job_id=_MISSING_JOB_ID, **kwargs)
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY constraint failed"):
        repo.enqueue(tenant_id=TenantId("other"), job_id=_IDEMPOTENT_JOB_ID, **kwargs)

    assert conn.execute("SELECT COUNT(*) FROM preparation_work_items").fetchone()[0] == 0


def test_repository_does_not_create_preparation_tables_at_runtime() -> None:
    conn = sqlite3.connect(":memory:")

    SqlitePreparationWorkItemRepository(conn)

    assert (
        conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preparation_work_items'").fetchone()
        is None
    )
