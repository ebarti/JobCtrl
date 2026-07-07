"""Preparation idempotency-key persistence tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation import SqlitePreparationWorkItemRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def test_enqueue_is_idempotent_for_work_item_key(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)

    first = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/1"),
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=3,
        source_event_id="event-1",
        now="2026-05-26T00:00:00+00:00",
    )
    second = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/1"),
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
        "job_id": JobId("https://example.com/job/2"),
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
