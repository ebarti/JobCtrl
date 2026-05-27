"""Preparation work-item repository tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.preparation import (
    PreparationWorkItemKind,
    PreparationWorkItemState,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.preparation import SqlitePreparationWorkItemRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _item_state(conn: sqlite3.Connection, item_id: str) -> str:
    return str(
        conn.execute(
            "SELECT state FROM preparation_work_items WHERE item_id = ?",
            (item_id,),
        ).fetchone()[0]
    )


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


def test_claim_complete_fail_and_retry_lifecycle(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/2"),
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=4,
        source_event_id="event-2",
        now="2026-05-26T00:00:00+00:00",
    )

    claimed = repo.claim_next(
        tenant_id=LOCAL_TENANT,
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        now="2026-05-26T00:01:00+00:00",
    )

    assert claimed is not None
    assert claimed.state is PreparationWorkItemState.RUNNING
    assert claimed.attempts == 1

    failed = repo.fail(
        tenant_id=LOCAL_TENANT,
        item_id=claimed.item_id,
        error="judge unavailable",
        failed_at="2026-05-26T00:02:00+00:00",
        retry_at="2026-05-26T00:05:00+00:00",
    )
    assert failed is not None
    assert failed.state is PreparationWorkItemState.FAILED
    assert failed.last_error == "judge unavailable"

    assert repo.claim_next(tenant_id=LOCAL_TENANT, now="2026-05-26T00:03:00+00:00") is None

    retried = repo.retry(
        tenant_id=LOCAL_TENANT,
        item_id=claimed.item_id,
        available_at="2026-05-26T00:04:00+00:00",
        retried_at="2026-05-26T00:03:30+00:00",
    )
    assert retried is not None
    assert retried.state is PreparationWorkItemState.QUEUED

    claimed_again = repo.claim_next(tenant_id=LOCAL_TENANT, now="2026-05-26T00:04:00+00:00")
    assert claimed_again is not None
    assert claimed_again.attempts == 2

    completed = repo.complete(
        tenant_id=LOCAL_TENANT,
        item_id=claimed_again.item_id,
        completed_at="2026-05-26T00:06:00+00:00",
    )
    assert completed is not None
    assert completed.state is PreparationWorkItemState.COMPLETED
    assert completed.last_error == ""


def test_complete_and_fail_require_running_item(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    queued = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/terminal-guards"),
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=1,
        source_event_id="event-terminal",
        now="2026-05-26T00:00:00+00:00",
    )

    assert (
        repo.complete(
            tenant_id=LOCAL_TENANT,
            item_id=queued.item_id,
            completed_at="2026-05-26T00:01:00+00:00",
        )
        is None
    )
    assert (
        repo.fail(
            tenant_id=LOCAL_TENANT,
            item_id=queued.item_id,
            error="stale failure",
            failed_at="2026-05-26T00:02:00+00:00",
        )
        is None
    )
    assert _item_state(conn, queued.item_id) == PreparationWorkItemState.QUEUED.value

    claimed = repo.claim_next(
        tenant_id=LOCAL_TENANT,
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        now="2026-05-26T00:03:00+00:00",
    )
    assert claimed is not None
    completed = repo.complete(
        tenant_id=LOCAL_TENANT,
        item_id=claimed.item_id,
        completed_at="2026-05-26T00:04:00+00:00",
    )
    assert completed is not None
    assert completed.state is PreparationWorkItemState.COMPLETED

    assert (
        repo.fail(
            tenant_id=LOCAL_TENANT,
            item_id=claimed.item_id,
            error="late failure",
            failed_at="2026-05-26T00:05:00+00:00",
        )
        is None
    )
    assert _item_state(conn, claimed.item_id) == PreparationWorkItemState.COMPLETED.value


def test_retry_requires_failed_item(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    queued = repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/retry-guards"),
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=1,
        now="2026-05-26T00:00:00+00:00",
    )

    assert (
        repo.retry(
            tenant_id=LOCAL_TENANT,
            item_id=queued.item_id,
            retried_at="2026-05-26T00:01:00+00:00",
        )
        is None
    )
    assert _item_state(conn, queued.item_id) == PreparationWorkItemState.QUEUED.value

    claimed = repo.claim_next(tenant_id=LOCAL_TENANT, now="2026-05-26T00:02:00+00:00")
    assert claimed is not None
    completed = repo.complete(
        tenant_id=LOCAL_TENANT,
        item_id=claimed.item_id,
        completed_at="2026-05-26T00:03:00+00:00",
    )
    assert completed is not None

    assert (
        repo.retry(
            tenant_id=LOCAL_TENANT,
            item_id=claimed.item_id,
            retried_at="2026-05-26T00:04:00+00:00",
        )
        is None
    )
    assert _item_state(conn, claimed.item_id) == PreparationWorkItemState.COMPLETED.value


def test_claim_respects_kind_and_available_time(conn: sqlite3.Connection) -> None:
    repo = SqlitePreparationWorkItemRepository(conn)
    repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/score"),
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=1,
        available_at="2026-05-26T00:10:00+00:00",
        now="2026-05-26T00:00:00+00:00",
    )
    repo.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/job/suppress"),
        kind=PreparationWorkItemKind.SUPPRESS_TAILORED_ARTIFACTS,
        target_version=1,
        available_at="2026-05-26T00:01:00+00:00",
        now="2026-05-26T00:00:00+00:00",
    )

    assert (
        repo.claim_next(
            tenant_id=LOCAL_TENANT,
            kind=PreparationWorkItemKind.SCORE_JOB,
            now="2026-05-26T00:02:00+00:00",
        )
        is None
    )
    claimed = repo.claim_next(tenant_id=LOCAL_TENANT, now="2026-05-26T00:02:00+00:00")
    assert claimed is not None
    assert claimed.kind is PreparationWorkItemKind.SUPPRESS_TAILORED_ARTIFACTS
