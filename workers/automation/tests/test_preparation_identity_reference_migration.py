"""Schema-v10 preparation work-item identity migration contracts."""

from __future__ import annotations

import shutil
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    _assert_schema_version_supported,
    close_connection,
    init_db,
)
from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.preparation import PreparationWorkItemKind
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.preparation import (
    SqlitePreparationWorkItemRepository,
)


PREVIOUS_SCHEMA_VERSION = 9


def _downgrade_preparation_references_to_v9(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE preparation_work_items")
    conn.executescript(
        """
        CREATE TABLE preparation_work_items (
            item_id          TEXT NOT NULL PRIMARY KEY,
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id           TEXT NOT NULL,
            kind             TEXT NOT NULL,
            target_version   INTEGER NOT NULL,
            source_event_id  TEXT NOT NULL DEFAULT '',
            state            TEXT NOT NULL,
            idempotency_key  TEXT NOT NULL,
            attempts         INTEGER NOT NULL DEFAULT 0,
            last_error       TEXT NOT NULL DEFAULT '',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            available_at     TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_preparation_work_items_idempotency
            ON preparation_work_items(tenant_id, idempotency_key);
        CREATE INDEX idx_preparation_work_items_claim
            ON preparation_work_items(
                tenant_id, state, kind, available_at
            );
        CREATE INDEX idx_preparation_work_items_job_target
            ON preparation_work_items(
                tenant_id, job_id, kind, target_version
            );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="Example"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-29T10:00:00+00:00",
    )


def _user_version(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def _insert_legacy_work_item(
    conn: sqlite3.Connection,
    *,
    item_id: str,
    job_url: str,
    state: str,
    idempotency_key: str,
    source_event_id: str,
    created_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO preparation_work_items (
            item_id, tenant_id, job_id, kind, target_version,
            source_event_id, state, idempotency_key, attempts,
            last_error, created_at, updated_at, available_at
        ) VALUES (
            ?, 'local', ?, 'score_job', 3, ?, ?, ?, 1,
            'synthetic-error', ?, ?, ?
        )
        """,
        (
            item_id,
            job_url,
            source_event_id,
            state,
            idempotency_key,
            created_at,
            created_at,
            created_at,
        ),
    )


def test_v9_preparation_references_migrate_to_stable_job_ids_and_reopen(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    pre_upgrade = tmp_path / "jobctrl-v9.db"
    conn = init_db(db_path)
    repository = SqliteJobRepository(conn)

    stable_job_id = JobId(str(uuid.uuid4()))
    storage_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform-engineer"
    repository.save(_discovered_job(storage_url, stable_job_id))
    repository.save(_discovered_job(current_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner_job_id = JobId(str(uuid.uuid4()))
    repository.save(_discovered_job(uuid_shaped_url, uuid_url_owner_job_id))
    repository.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )
    _downgrade_preparation_references_to_v9(conn)
    _insert_legacy_work_item(
        conn,
        item_id="prep-current-alias",
        job_url=current_url,
        state="queued",
        idempotency_key="legacy-key-current-alias",
        source_event_id="event-current",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_work_item(
        conn,
        item_id="prep-uuid-url",
        job_url=uuid_shaped_url,
        state="failed",
        idempotency_key="legacy-key-uuid-url",
        source_event_id="event-uuid-url",
        created_at="2026-07-29T10:02:00+00:00",
    )
    conn.commit()
    close_connection(db_path)
    shutil.copy2(db_path, pre_upgrade)

    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION == 28
    check = sqlite3.connect(db_path)
    try:
        rows = check.execute(
            """
            SELECT item_id, job_id, state, idempotency_key, attempts,
                   last_error, source_event_id
            FROM preparation_work_items
            ORDER BY item_id
            """
        ).fetchall()
        assert rows == [
            (
                "prep-current-alias",
                str(stable_job_id),
                "queued",
                "legacy-key-current-alias",
                1,
                "synthetic-error",
                "event-current",
            ),
            (
                "prep-uuid-url",
                str(uuid_url_owner_job_id),
                "failed",
                "legacy-key-uuid-url",
                1,
                "synthetic-error",
                "event-uuid-url",
            ),
        ]
        foreign_keys = check.execute("PRAGMA foreign_key_list(preparation_work_items)").fetchall()
        job_reference = {
            (str(row[3]), str(row[4]), str(row[6]).upper()) for row in foreign_keys if str(row[2]) == "jobs"
        }
        assert job_reference == {
            ("tenant_id", "tenant_id", "CASCADE"),
            ("job_id", "job_id", "CASCADE"),
        }
        assert check.execute("PRAGMA foreign_key_check").fetchone() is None
    finally:
        check.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION

    previous = sqlite3.connect(pre_upgrade)
    try:
        assert (
            _assert_schema_version_supported(
                previous,
                supported_version=PREVIOUS_SCHEMA_VERSION,
            )
            == PREVIOUS_SCHEMA_VERSION
        )
        assert previous.execute(
            """
            SELECT job_id, idempotency_key
            FROM preparation_work_items
            ORDER BY item_id
            """
        ).fetchall() == [
            (current_url, "legacy-key-current-alias"),
            (uuid_shaped_url, "legacy-key-uuid-url"),
        ]
    finally:
        previous.close()


def test_unresolved_v9_preparation_reference_rolls_back_and_retries(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = str(uuid.uuid4())
    job_url = "https://example.com/jobs/valid"
    conn.execute(
        """
        INSERT INTO jobs (url, tenant_id, job_id, title)
        VALUES (?, 'local', ?, 'Engineer')
        """,
        (job_url, job_id),
    )
    conn.commit()
    _downgrade_preparation_references_to_v9(conn)
    _insert_legacy_work_item(
        conn,
        item_id="prep-unresolved",
        job_url="https://example.com/jobs/missing",
        state="queued",
        idempotency_key="legacy-key-unresolved",
        source_event_id="event-unresolved",
        created_at="2026-07-29T10:01:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    with pytest.raises(
        RuntimeError,
        match="could not resolve preparation_work_items.job_id",
    ):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == PREVIOUS_SCHEMA_VERSION
    check = sqlite3.connect(db_path)
    try:
        assert check.execute("SELECT job_id FROM preparation_work_items").fetchone() == (
            "https://example.com/jobs/missing",
        )
        assert not check.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name = 'preparation_work_items_v10'
            """
        ).fetchall()
        check.execute(
            "UPDATE preparation_work_items SET job_id = ?",
            (job_url,),
        )
        check.commit()
    finally:
        check.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    migrated = sqlite3.connect(db_path)
    try:
        assert migrated.execute("SELECT job_id FROM preparation_work_items").fetchone() == (job_id,)
    finally:
        migrated.close()


def test_v10_verification_failure_rolls_back_rebuild_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = str(uuid.uuid4())
    job_url = "https://example.com/jobs/retry-after-verification"
    conn.execute(
        """
        INSERT INTO jobs (url, tenant_id, job_id, title)
        VALUES (?, 'local', ?, 'Engineer')
        """,
        (job_url, job_id),
    )
    conn.commit()
    _downgrade_preparation_references_to_v9(conn)
    _insert_legacy_work_item(
        conn,
        item_id="prep-verification-retry",
        job_url=job_url,
        state="completed",
        idempotency_key="legacy-key-verification-retry",
        source_event_id="event-verification-retry",
        created_at="2026-07-29T10:01:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    original_verify = database_module._verify_preparation_references_v10

    def fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_count: int,
    ) -> None:
        del expected_count
        raise RuntimeError("synthetic preparation verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_preparation_references_v10",
        fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="synthetic preparation verification failure",
    ):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == PREVIOUS_SCHEMA_VERSION
    rolled_back = sqlite3.connect(db_path)
    try:
        assert rolled_back.execute("SELECT job_id, idempotency_key FROM preparation_work_items").fetchone() == (
            job_url,
            "legacy-key-verification-retry",
        )
        assert rolled_back.execute("PRAGMA foreign_key_list(preparation_work_items)").fetchall() == []
        assert not rolled_back.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name = 'preparation_work_items_v10'
            """
        ).fetchall()
    finally:
        rolled_back.close()

    monkeypatch.setattr(
        database_module,
        "_verify_preparation_references_v10",
        original_verify,
    )
    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    migrated = sqlite3.connect(db_path)
    try:
        assert migrated.execute("SELECT job_id, idempotency_key FROM preparation_work_items").fetchone() == (
            job_id,
            "legacy-key-verification-retry",
        )
    finally:
        migrated.close()


def test_repository_uses_stable_ids_and_explicit_url_compatibility(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    stable_job_url = "https://example.com/jobs/stable"
    jobs.save(_discovered_job(stable_job_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner_job_id = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner_job_id))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )
    repository = SqlitePreparationWorkItemRepository(conn)

    stable_item = repository.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=stable_job_id,
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=3,
        source_event_id="event-stable",
        now="2026-07-29T11:00:00+00:00",
    )
    legacy_url_item = repository.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(stable_job_url),
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=4,
        source_event_id="event-url",
        now="2026-07-29T11:01:00+00:00",
    )
    explicit_uuid_url_item = repository.enqueue_by_posting_url(
        tenant_id=LOCAL_TENANT,
        posting_url=PostingUrl(uuid_shaped_url),
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=5,
        source_event_id="event-uuid-url",
        now="2026-07-29T11:02:00+00:00",
    )

    assert stable_item.job_id == stable_job_id
    assert legacy_url_item.job_id == stable_job_id
    assert explicit_uuid_url_item.job_id == uuid_url_owner_job_id
    assert conn.execute(
        """
        SELECT job_id
        FROM preparation_work_items
        WHERE item_id = ?
        """,
        (explicit_uuid_url_item.item_id,),
    ).fetchone()[0] == str(uuid_url_owner_job_id)

    conn.execute(
        """
        INSERT INTO preparation_work_items (
            item_id, tenant_id, job_id, kind, target_version,
            source_event_id, state, idempotency_key, attempts,
            last_error, created_at, updated_at, available_at
        ) VALUES (
            'migrated-item', 'local', ?, 'score_job', 8,
            'event-migrated', 'completed', 'legacy-opaque-key', 1,
            '', '2026-07-29T09:00:00+00:00',
            '2026-07-29T09:05:00+00:00',
            '2026-07-29T09:00:00+00:00'
        )
        """,
        (str(stable_job_id),),
    )
    conn.commit()
    replay = repository.enqueue(
        tenant_id=LOCAL_TENANT,
        job_id=stable_job_id,
        kind=PreparationWorkItemKind.SCORE_JOB,
        target_version=8,
        source_event_id="event-migrated",
        now="2026-07-29T12:00:00+00:00",
    )
    assert replay.item_id == "migrated-item"
    assert replay.idempotency_key == "legacy-opaque-key"
