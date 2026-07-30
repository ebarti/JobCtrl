"""Schema-v11 enrichment and snapshot identity migration contracts."""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    _assert_schema_version_supported,
    _reassign_enrichment_snapshot_references_v11,
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
from jobctrl.domain.enrichment import (
    ActiveState,
    ApplicationUrl,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
    PostingSnapshotSet,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.enrichment import (
    SqliteEnrichmentRepository,
    SqlitePostingSnapshotSetRepository,
)


PREVIOUS_SCHEMA_VERSION = 10


def _downgrade_enrichment_snapshot_references_to_v10(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE job_enrichments")
    conn.execute("DROP TABLE posting_snapshot_sets")
    conn.executescript(
        """
        CREATE TABLE job_enrichments (
            job_url             TEXT PRIMARY KEY,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            current_status      TEXT NOT NULL,
            full_description    TEXT,
            application_url     TEXT,
            enriched_at         TEXT,
            extraction_tier     TEXT,
            attempts_json       TEXT NOT NULL DEFAULT '[]',
            updated_at          TEXT NOT NULL,
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_enrichments_tenant_status
            ON job_enrichments(
                tenant_id, current_status, updated_at DESC
            );
        CREATE INDEX idx_job_enrichments_enriched_at
            ON job_enrichments(enriched_at DESC);

        CREATE TABLE posting_snapshot_sets (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            job_url                  TEXT NOT NULL,
            snapshot_set_json        TEXT NOT NULL,
            latest_snapshot_version  INTEGER NOT NULL DEFAULT 0,
            latest_active_state      TEXT NOT NULL DEFAULT 'unknown',
            latest_confidence        TEXT,
            latest_quarantine_reason TEXT,
            updated_at               TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_posting_snapshot_sets_updated
            ON posting_snapshot_sets(tenant_id, updated_at DESC);
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


def _snapshot_json(
    job_reference: str,
    *,
    captured_at: str,
    candidate_reference: str | None = None,
) -> str:
    candidates = []
    if candidate_reference is not None:
        candidates.append(
            {
                "candidate_job_id": candidate_reference,
                "evidence": [
                    {
                        "kind": "description_hash_match",
                        "matched_value": "shared-description",
                        "confidence": 0.93,
                    }
                ],
                "confidence": 0.93,
                "detected_at": captured_at,
            }
        )
    return json.dumps(
        {
            "tenant_id": "local",
            "job_id": job_reference,
            "snapshots": [
                {
                    "snapshot_version": 1,
                    "source_id": "example",
                    "extraction_tier": "css_selectors",
                    "description_hash": "a" * 64,
                    "apply_url": "https://apply.example/jobs/1",
                    "active_state": "active",
                    "confidence": "high",
                    "quarantine_reason": "none",
                    "captured_at": captured_at,
                    "raw_text_hash": "b" * 64,
                    "filter_override": None,
                    "evidence": ["fixture"],
                }
            ],
            "failures": [],
            "duplicate_candidates": candidates,
            "latest_active_state": "active",
            "updated_at": captured_at,
        },
        sort_keys=True,
    )


def _insert_legacy_enrichment(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    application_url: str = "https://apply.example/jobs/1",
    full_description: str = "Canonical description",
    updated_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_enrichments (
            job_url, tenant_id, current_status, full_description,
            application_url, enriched_at, extraction_tier,
            attempts_json, updated_at
        ) VALUES (
            ?, 'local', 'enriched', ?,
            ?, ?, 'css_selectors',
            ?, ?
        )
        """,
        (
            job_url,
            full_description,
            application_url,
            updated_at,
            json.dumps(
                [
                    {
                        "attempt_number": 1,
                        "extraction_tier": "css_selectors",
                        "status": "succeeded",
                        "started_at": updated_at,
                        "finished_at": updated_at,
                        "error": None,
                    }
                ],
                sort_keys=True,
            ),
            updated_at,
        ),
    )


def _insert_legacy_snapshot(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    candidate_reference: str | None,
    updated_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_url, snapshot_set_json,
            latest_snapshot_version, latest_active_state,
            latest_confidence, latest_quarantine_reason, updated_at
        ) VALUES ('local', ?, ?, 1, 'active', 'high', 'none', ?)
        """,
        (
            job_url,
            _snapshot_json(
                job_url,
                captured_at=updated_at,
                candidate_reference=candidate_reference,
            ),
            updated_at,
        ),
    )


def _user_version(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def _foreign_job_reference(
    conn: sqlite3.Connection,
    table: str,
) -> set[tuple[str, str, str]]:
    return {
        (str(row[3]), str(row[4]), str(row[6]).upper())
        for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
        if str(row[2]) == "jobs"
    }


def test_v10_enrichment_snapshot_references_migrate_and_reopen(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    pre_upgrade = tmp_path / "jobctrl-v10.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)

    stable_job_id = JobId(str(uuid.uuid4()))
    storage_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform-engineer"
    jobs.save(_discovered_job(storage_url, stable_job_id))
    jobs.save(_discovered_job(current_url, stable_job_id))

    duplicate_job_id = JobId(str(uuid.uuid4()))
    duplicate_url = "https://example.com/jobs/duplicate"
    jobs.save(_discovered_job(duplicate_url, duplicate_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner_job_id = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner_job_id))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )

    _downgrade_enrichment_snapshot_references_to_v10(conn)
    _insert_legacy_enrichment(
        conn,
        job_url=storage_url,
        application_url="https://apply.example/jobs/original",
        full_description="Original description",
        updated_at="2026-07-29T10:00:00+00:00",
    )
    _insert_legacy_enrichment(
        conn,
        job_url=current_url,
        application_url="https://apply.example/jobs/corrected",
        full_description="Corrected description",
        updated_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_enrichment(
        conn,
        job_url=uuid_shaped_url,
        updated_at="2026-07-29T10:02:00+00:00",
    )
    _insert_legacy_snapshot(
        conn,
        job_url=storage_url,
        candidate_reference=current_url,
        updated_at="2026-07-29T10:00:00+00:00",
    )
    _insert_legacy_snapshot(
        conn,
        job_url=current_url,
        candidate_reference=duplicate_url,
        updated_at="2026-07-29T10:03:00+00:00",
    )
    _insert_legacy_snapshot(
        conn,
        job_url=uuid_shaped_url,
        candidate_reference=current_url,
        updated_at="2026-07-29T10:04:00+00:00",
    )
    conn.commit()
    close_connection(db_path)
    shutil.copy2(db_path, pre_upgrade)

    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION == 15
    check = sqlite3.connect(db_path)
    try:
        enrichment_rows = check.execute(
            """
            SELECT job_id, current_status, full_description,
                   application_url, extraction_tier, attempts_json, updated_at
            FROM job_enrichments
            ORDER BY updated_at
            """
        ).fetchall()
        assert [str(row[0]) for row in enrichment_rows] == [
            str(stable_job_id),
            str(uuid_url_owner_job_id),
        ]
        assert all(str(row[1]) == "enriched" for row in enrichment_rows)
        assert enrichment_rows[0][2] == "Corrected description"
        assert enrichment_rows[1][2] == "Canonical description"
        assert enrichment_rows[0][3] == (
            "https://apply.example/jobs/corrected"
        )
        assert all(str(row[4]) == "css_selectors" for row in enrichment_rows)
        merged_attempts = json.loads(str(enrichment_rows[0][5]))
        assert [attempt["attempt_number"] for attempt in merged_attempts] == [1, 2]
        assert all(attempt["status"] == "succeeded" for attempt in merged_attempts)
        assert len(json.loads(str(enrichment_rows[1][5]))) == 1

        snapshot_rows = check.execute(
            """
            SELECT job_id, snapshot_set_json, latest_snapshot_version,
                   latest_active_state, latest_confidence,
                   latest_quarantine_reason
            FROM posting_snapshot_sets
            ORDER BY updated_at
            """
        ).fetchall()
        assert [str(row[0]) for row in snapshot_rows] == [
            str(stable_job_id),
            str(uuid_url_owner_job_id),
        ]
        first_snapshot = json.loads(str(snapshot_rows[0][1]))
        assert first_snapshot["job_id"] == str(stable_job_id)
        assert [item["snapshot_version"] for item in first_snapshot["snapshots"]] == [
            1,
            2,
        ]
        assert first_snapshot["duplicate_candidates"][0]["candidate_job_id"] == str(
            duplicate_job_id
        )
        assert len(first_snapshot["duplicate_candidates"]) == 1
        second_snapshot = json.loads(str(snapshot_rows[1][1]))
        assert second_snapshot["job_id"] == str(uuid_url_owner_job_id)
        assert second_snapshot["duplicate_candidates"][0]["candidate_job_id"] == str(
            stable_job_id
        )
        assert tuple(snapshot_rows[0][2:]) == (2, "active", "high", "none")
        assert tuple(snapshot_rows[1][2:]) == (1, "active", "high", "none")
        assert _foreign_job_reference(check, "job_enrichments") == {
            ("tenant_id", "tenant_id", "CASCADE"),
            ("job_id", "job_id", "CASCADE"),
        }
        assert _foreign_job_reference(check, "posting_snapshot_sets") == {
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
            "SELECT job_url FROM job_enrichments ORDER BY updated_at"
        ).fetchall() == [(storage_url,), (current_url,), (uuid_shaped_url,)]
        raw_snapshot = json.loads(
            str(
                previous.execute(
                    """
                    SELECT snapshot_set_json
                    FROM posting_snapshot_sets
                    WHERE job_url = ?
                    """,
                    (current_url,),
                ).fetchone()[0]
            )
        )
        assert raw_snapshot["job_id"] == current_url
        assert (
            raw_snapshot["duplicate_candidates"][0]["candidate_job_id"]
            == duplicate_url
        )
    finally:
        previous.close()


def test_unresolved_v10_reference_rolls_back_and_retries(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    stable_job_id = str(uuid.uuid4())
    job_url = "https://example.com/jobs/valid"
    conn.execute(
        """
        INSERT INTO jobs (url, tenant_id, job_id, title)
        VALUES (?, 'local', ?, 'Engineer')
        """,
        (job_url, stable_job_id),
    )
    conn.commit()
    _downgrade_enrichment_snapshot_references_to_v10(conn)
    _insert_legacy_enrichment(
        conn,
        job_url="https://example.com/jobs/missing",
        updated_at="2026-07-29T10:01:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    with pytest.raises(
        RuntimeError,
        match="could not resolve job_enrichments.job_url",
    ):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == PREVIOUS_SCHEMA_VERSION
    rolled_back = sqlite3.connect(db_path)
    try:
        assert rolled_back.execute(
            "SELECT job_url FROM job_enrichments"
        ).fetchone() == ("https://example.com/jobs/missing",)
        assert "job_id" not in {
            str(row[1])
            for row in rolled_back.execute(
                "PRAGMA table_info(job_enrichments)"
            ).fetchall()
        }
        assert not rolled_back.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name = 'job_enrichments_v11'
            """
        ).fetchall()
        rolled_back.execute(
            "UPDATE job_enrichments SET job_url = ?",
            (job_url,),
        )
        rolled_back.commit()
    finally:
        rolled_back.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    migrated = sqlite3.connect(db_path)
    try:
        assert migrated.execute(
            "SELECT job_id FROM job_enrichments"
        ).fetchone() == (stable_job_id,)
    finally:
        migrated.close()


def test_v11_verification_failure_rolls_back_rebuild_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    stable_job_id = str(uuid.uuid4())
    job_url = "https://example.com/jobs/retry-after-verification"
    conn.execute(
        """
        INSERT INTO jobs (url, tenant_id, job_id, title)
        VALUES (?, 'local', ?, 'Engineer')
        """,
        (job_url, stable_job_id),
    )
    conn.commit()
    _downgrade_enrichment_snapshot_references_to_v10(conn)
    _insert_legacy_enrichment(
        conn,
        job_url=job_url,
        updated_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_snapshot(
        conn,
        job_url=job_url,
        candidate_reference=None,
        updated_at="2026-07-29T10:02:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    original_verify = (
        database_module._verify_enrichment_snapshot_references_v11
    )

    def fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("synthetic enrichment verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_enrichment_snapshot_references_v11",
        fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="synthetic enrichment verification failure",
    ):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == PREVIOUS_SCHEMA_VERSION
    rolled_back = sqlite3.connect(db_path)
    try:
        assert rolled_back.execute(
            "SELECT job_url FROM job_enrichments"
        ).fetchone() == (job_url,)
        assert rolled_back.execute(
            "SELECT job_url FROM posting_snapshot_sets"
        ).fetchone() == (job_url,)
        assert not rolled_back.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%_v11'
            """
        ).fetchall()
    finally:
        rolled_back.close()

    monkeypatch.setattr(
        database_module,
        "_verify_enrichment_snapshot_references_v11",
        original_verify,
    )
    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    migrated = sqlite3.connect(db_path)
    try:
        assert migrated.execute(
            "SELECT job_id FROM job_enrichments"
        ).fetchone() == (stable_job_id,)
        snapshot = migrated.execute(
            "SELECT job_id, snapshot_set_json FROM posting_snapshot_sets"
        ).fetchone()
        assert snapshot[0] == stable_job_id
        assert json.loads(str(snapshot[1]))["job_id"] == stable_job_id
    finally:
        migrated.close()


def _enriched(reference: str, *, finished_at: str) -> JobEnrichment:
    enrichment = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(reference),
        updated_at=finished_at,
    )
    enrichment = enrichment.start_attempt(
        extraction_tier=ExtractionTier.CSS_SELECTORS,
        started_at=finished_at,
    )
    return enrichment.succeed_attempt(
        full_description=FullDescription(text="Canonical description"),
        application_url=ApplicationUrl(
            value="https://apply.example/jobs/1"
        ),
        extraction_tier=ExtractionTier.CSS_SELECTORS,
        finished_at=finished_at,
    )


def _snapshot_set(reference: str, *, captured_at: str) -> PostingSnapshotSet:
    snapshot_set = PostingSnapshotSet.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(reference),
        updated_at=captured_at,
    )
    snapshot_set, _ = snapshot_set.record_snapshot(
        source_id="example",
        extraction_tier="css_selectors",
        description_hash=SnapshotDescriptionHash.from_text(
            "Canonical description"
        ),
        apply_url=SnapshotApplyUrl(
            value="https://apply.example/jobs/1"
        ),
        active_state=ActiveState.ACTIVE,
        confidence=SnapshotConfidence.HIGH,
        quarantine_reason=QuarantineReason.NONE,
        captured_at=captured_at,
        evidence=("fixture",),
    )
    return snapshot_set


def test_repositories_use_stable_ids_and_explicit_uuid_url_compatibility(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    stable_url = "https://example.com/jobs/stable"
    jobs.save(_discovered_job(stable_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner_job_id = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner_job_id))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )

    enrichments = SqliteEnrichmentRepository(conn)
    snapshots = SqlitePostingSnapshotSetRepository(conn)
    enrichments.save(_enriched(stable_url, finished_at="2026-07-29T11:00:00+00:00"))
    snapshots.save(_snapshot_set(stable_url, captured_at="2026-07-29T11:01:00+00:00"))
    enrichments.save_by_posting_url(
        _enriched(uuid_shaped_url, finished_at="2026-07-29T11:02:00+00:00"),
        PostingUrl(uuid_shaped_url),
    )
    snapshots.save_by_posting_url(
        _snapshot_set(uuid_shaped_url, captured_at="2026-07-29T11:03:00+00:00"),
        PostingUrl(uuid_shaped_url),
    )

    assert enrichments.load(LOCAL_TENANT, stable_job_id).job_id == stable_job_id
    assert snapshots.load(LOCAL_TENANT, stable_job_id).job_id == stable_job_id
    assert (
        enrichments.load_by_posting_url(
            LOCAL_TENANT,
            PostingUrl(uuid_shaped_url),
        ).job_id
        == uuid_url_owner_job_id
    )
    assert (
        snapshots.load_by_posting_url(
            LOCAL_TENANT,
            PostingUrl(uuid_shaped_url),
        ).job_id
        == uuid_url_owner_job_id
    )
    assert conn.execute(
        """
        SELECT job_id
        FROM job_enrichments
        WHERE updated_at = '2026-07-29T11:02:00+00:00'
        """
    ).fetchone()[0] == str(uuid_url_owner_job_id)
    assert conn.execute(
        """
        SELECT job_id
        FROM posting_snapshot_sets
        WHERE updated_at = '2026-07-29T11:03:00+00:00'
        """
    ).fetchone()[0] == str(uuid_url_owner_job_id)


def test_collision_merge_preserves_histories_and_removes_self_candidates(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    jobs = SqliteJobRepository(conn)
    surviving_job_id = JobId(str(uuid.uuid4()))
    losing_job_id = JobId(str(uuid.uuid4()))
    external_job_id = JobId(str(uuid.uuid4()))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/surviving",
            surviving_job_id,
        )
    )
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/losing",
            losing_job_id,
        )
    )
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/external",
            external_job_id,
        )
    )

    conn.executemany(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier,
            attempts_json, updated_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                str(surviving_job_id),
                "enriched",
                "Canonical description",
                "https://apply.example/jobs/original",
                "2026-07-29T10:01:00+00:00",
                "css_selectors",
                json.dumps(
                    [
                        {
                            "attempt_number": 1,
                            "extraction_tier": "css_selectors",
                            "status": "succeeded",
                            "started_at": "2026-07-29T10:00:00+00:00",
                            "finished_at": "2026-07-29T10:01:00+00:00",
                            "error": None,
                        }
                    ]
                ),
                "2026-07-29T10:01:00+00:00",
            ),
            (
                str(losing_job_id),
                "enriched",
                "Canonical description",
                "https://apply.example/jobs/corrected",
                "2026-07-29T10:03:00+00:00",
                "json_ld",
                json.dumps(
                    [
                        {
                            "attempt_number": 1,
                            "extraction_tier": "json_ld",
                            "status": "succeeded",
                            "started_at": "2026-07-29T10:02:00+00:00",
                            "finished_at": "2026-07-29T10:03:00+00:00",
                            "error": None,
                        }
                    ]
                ),
                "2026-07-29T10:03:00+00:00",
            ),
        ),
    )
    conn.executemany(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json,
            latest_snapshot_version, latest_active_state,
            latest_confidence, latest_quarantine_reason, updated_at
        ) VALUES ('local', ?, ?, 1, 'active', 'high', 'none', ?)
        """,
        (
            (
                str(surviving_job_id),
                _snapshot_json(
                    str(surviving_job_id),
                    captured_at="2026-07-29T10:01:00+00:00",
                    candidate_reference=str(losing_job_id),
                ),
                "2026-07-29T10:01:00+00:00",
            ),
            (
                str(losing_job_id),
                _snapshot_json(
                    str(losing_job_id),
                    captured_at="2026-07-29T10:03:00+00:00",
                    candidate_reference=str(external_job_id),
                ),
                "2026-07-29T10:03:00+00:00",
            ),
        ),
    )
    conn.commit()

    _reassign_enrichment_snapshot_references_v11(
        conn,
        tenant_id="local",
        losing_job_id=str(losing_job_id),
        surviving_job_id=str(surviving_job_id),
    )
    conn.commit()

    enrichment = conn.execute(
        """
        SELECT job_id, current_status, full_description, application_url,
               enriched_at, extraction_tier, attempts_json
        FROM job_enrichments
        """
    ).fetchone()
    assert tuple(enrichment[:3]) == (
        str(surviving_job_id),
        "enriched",
        "Canonical description",
    )
    assert tuple(enrichment[3:6]) == (
        "https://apply.example/jobs/corrected",
        "2026-07-29T10:03:00+00:00",
        "json_ld",
    )
    attempts = json.loads(str(enrichment[6]))
    assert [attempt["attempt_number"] for attempt in attempts] == [1, 2]
    assert [attempt["status"] for attempt in attempts] == [
        "succeeded",
        "succeeded",
    ]

    snapshot_row = conn.execute(
        """
        SELECT job_id, snapshot_set_json, latest_snapshot_version
        FROM posting_snapshot_sets
        """
    ).fetchone()
    assert snapshot_row[0] == str(surviving_job_id)
    assert snapshot_row[2] == 2
    snapshot_data = json.loads(str(snapshot_row[1]))
    assert [item["snapshot_version"] for item in snapshot_data["snapshots"]] == [
        1,
        2,
    ]
    assert [
        item["candidate_job_id"]
        for item in snapshot_data["duplicate_candidates"]
    ] == [str(external_job_id)]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
