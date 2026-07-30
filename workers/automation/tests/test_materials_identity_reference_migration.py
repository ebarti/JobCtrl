"""Schema-v15 generated-material identity migration contracts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    _reassign_materials_references_v15,
    close_connection,
    ensure_materials_references_v15,
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
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository


PREVIOUS_SCHEMA_VERSION = 14


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


def _downgrade_material_references_to_v14(
    conn: sqlite3.Connection,
) -> None:
    for table in (
        "job_bullet_provenance",
        "job_material_layout_boxes",
        "job_materials_artifacts",
        "job_materials",
    ):
        conn.execute(f'DROP TABLE "{table}"')
    conn.executescript(
        """
        CREATE TABLE job_materials (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            status              TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            last_validation_json TEXT,
            last_verdict_json    TEXT,
            metadata_json       TEXT,
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE TABLE job_materials_artifacts (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            artifact_type       TEXT NOT NULL,
            artifact_id         TEXT NOT NULL,
            status              TEXT NOT NULL,
            path                TEXT NOT NULL,
            render_format       TEXT NOT NULL,
            size_bytes          INTEGER,
            metadata_json       TEXT,
            created_at          TEXT NOT NULL,
            superseded_at       TEXT,
            PRIMARY KEY (job_url, generation, artifact_type),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_materials(job_url, generation) ON DELETE CASCADE
        );
        CREATE TABLE job_material_layout_boxes (
            job_url             TEXT NOT NULL,
            generation          INTEGER NOT NULL,
            artifact_id         TEXT NOT NULL,
            box_index           INTEGER NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            semantic_id         TEXT NOT NULL,
            page_number         INTEGER NOT NULL,
            line_number         INTEGER,
            text_excerpt        TEXT NOT NULL,
            left_pct            REAL NOT NULL,
            top_pct             REAL NOT NULL,
            width_pct           REAL NOT NULL,
            height_pct          REAL NOT NULL,
            audit_target_json   TEXT NOT NULL DEFAULT '{}',
            created_at          TEXT NOT NULL,
            PRIMARY KEY (job_url, generation, artifact_id, box_index),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_materials(job_url, generation) ON DELETE CASCADE
        );
        CREATE TABLE job_bullet_provenance (
            job_url                 TEXT NOT NULL,
            generation              INTEGER NOT NULL,
            bullet_id               TEXT NOT NULL,
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            artifact_id             TEXT NOT NULL,
            section                 TEXT NOT NULL,
            source_id               TEXT,
            evidence_ids_json       TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json    TEXT NOT NULL DEFAULT '[]',
            matched_keywords_json   TEXT NOT NULL DEFAULT '[]',
            transform_type          TEXT NOT NULL,
            control                 TEXT NOT NULL,
            rationale               TEXT NOT NULL DEFAULT '',
            generated_text          TEXT NOT NULL,
            position                INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL,
            coverage_json           TEXT,
            voice_json              TEXT,
            PRIMARY KEY (job_url, generation, bullet_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_materials(job_url, generation) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_materials_tenant_job_gen
            ON job_materials(tenant_id, job_url, generation DESC);
        CREATE INDEX idx_job_materials_artifacts_status
            ON job_materials_artifacts(artifact_type, status, created_at DESC);
        CREATE INDEX idx_job_material_layout_boxes_artifact
            ON job_material_layout_boxes(
                tenant_id, artifact_id, page_number, box_index
            );
        CREATE INDEX idx_job_bullet_provenance_tenant_job_gen
            ON job_bullet_provenance(
                tenant_id, job_url, generation DESC
            );
        CREATE INDEX idx_job_bullet_provenance_artifact
            ON job_bullet_provenance(tenant_id, artifact_id);
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_legacy_generation(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    generation: int,
    artifact_id: str,
    created_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at,
            last_validation_json, last_verdict_json, metadata_json
        ) VALUES (?, ?, 'local', 'resume_approved', ?, ?, '{}', '{}', ?)
        """,
        (
            job_url,
            generation,
            created_at,
            created_at,
            json.dumps({"source_artifact": artifact_id}, sort_keys=True),
        ),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at, superseded_at
        ) VALUES (?, ?, 'tailored_resume', ?, 'approved', ?, 'text', 10,
                  '{}', ?, NULL)
        """,
        (
            job_url,
            generation,
            artifact_id,
            f"/tmp/{artifact_id}.txt",
            created_at,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_material_layout_boxes (
            job_url, generation, artifact_id, box_index, tenant_id,
            semantic_id, page_number, line_number, text_excerpt,
            left_pct, top_pct, width_pct, height_pct, audit_target_json,
            created_at
        ) VALUES (?, ?, ?, 0, 'local', ?, 1, 1, ?, 1, 2, 3, 4, '{}', ?)
        """,
        (
            job_url,
            generation,
            artifact_id,
            f"box:{artifact_id}",
            artifact_id,
            created_at,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_bullet_provenance (
            job_url, generation, bullet_id, tenant_id, artifact_id, section,
            source_id, evidence_ids_json, requirement_ids_json,
            matched_keywords_json, transform_type, control, rationale,
            generated_text, position, created_at, coverage_json, voice_json
        ) VALUES (?, ?, ?, 'local', ?, 'experience', NULL, '[]', '[]', '[]',
                  'unchanged', 'preserve', '', ?, 0, ?, '{}', '{}')
        """,
        (
            job_url,
            generation,
            f"bullet:{artifact_id}",
            artifact_id,
            artifact_id,
            created_at,
        ),
    )


def _columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }


def test_v14_materials_migrate_alias_histories_and_uuid_shaped_urls(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)

    stable_job_id = JobId(str(uuid.uuid4()))
    original_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform-engineer"
    jobs.save(_discovered_job(original_url, stable_job_id))
    jobs.save(_discovered_job(current_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-collision",
            JobId(uuid_shaped_url),
        )
    )

    _downgrade_material_references_to_v14(conn)
    _insert_legacy_generation(
        conn,
        job_url=original_url,
        generation=1,
        artifact_id="original-1",
        created_at="2026-07-29T10:00:00+00:00",
    )
    _insert_legacy_generation(
        conn,
        job_url=current_url,
        generation=1,
        artifact_id="current-1",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_generation(
        conn,
        job_url=original_url,
        generation=2,
        artifact_id="original-2",
        created_at="2026-07-29T10:02:00+00:00",
    )
    _insert_legacy_generation(
        conn,
        job_url=uuid_shaped_url,
        generation=1,
        artifact_id="uuid-url-owner",
        created_at="2026-07-29T10:03:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert reopened.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 26
    for table in database_module._MATERIALS_REFERENCE_TABLES:
        assert "job_id" in _columns(reopened, table)
        assert "job_url" not in _columns(reopened, table)
        assert reopened.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 4

    merged = reopened.execute(
        """
        SELECT generation, artifact_id
        FROM job_materials_artifacts
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY generation
        """,
        (str(stable_job_id),),
    ).fetchall()
    assert [tuple(row) for row in merged] == [
        (1, "original-1"),
        (2, "current-1"),
        (3, "original-2"),
    ]
    assert reopened.execute(
        """
        SELECT job_id
        FROM job_materials_artifacts
        WHERE artifact_id = 'uuid-url-owner'
        """
    ).fetchone()[0] == str(uuid_url_owner)
    assert reopened.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM job_materials_artifacts"
    ).fetchone()[0] == 4
    close_connection(db_path)


def test_v15_materials_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_material_references_to_v14(conn)
    _insert_legacy_generation(
        conn,
        job_url=job_url,
        generation=1,
        artifact_id="retry",
        created_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()

    original_verify = database_module._verify_materials_references_v15

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected materials verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_materials_references_v15",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected materials verification failure",
    ):
        ensure_materials_references_v15(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 14
    assert "job_url" in _columns(conn, "job_materials")
    assert conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_materials_references_v15",
        original_verify,
    )
    assert ensure_materials_references_v15(conn) == list(
        database_module._MATERIALS_REFERENCE_TABLES
    )
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 15
    assert "job_id" in _columns(conn, "job_materials")
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_runtime_material_identity_merge_preserves_all_histories(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/losing",
            losing_id,
        )
    )
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/surviving",
            surviving_id,
        )
    )

    def _insert_stable(
        *,
        job_id: JobId,
        generation: int,
        artifact_id: str,
        created_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status, created_at, updated_at
            ) VALUES ('local', ?, ?, 'resume_approved', ?, ?)
            """,
            (str(job_id), generation, created_at, created_at),
        )
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES ('local', ?, ?, 'tailored_resume', ?, 'approved', ?,
                      'text', ?)
            """,
            (
                str(job_id),
                generation,
                artifact_id,
                f"/tmp/{artifact_id}.txt",
                created_at,
            ),
        )
        conn.execute(
            """
            INSERT INTO job_material_layout_boxes (
                tenant_id, job_id, generation, artifact_id, box_index,
                semantic_id, page_number, text_excerpt, left_pct, top_pct,
                width_pct, height_pct, created_at
            ) VALUES ('local', ?, ?, ?, 0, ?, 1, ?, 1, 2, 3, 4, ?)
            """,
            (
                str(job_id),
                generation,
                artifact_id,
                artifact_id,
                artifact_id,
                created_at,
            ),
        )
        conn.execute(
            """
            INSERT INTO job_bullet_provenance (
                tenant_id, job_id, generation, bullet_id, artifact_id,
                section, transform_type, control, generated_text, created_at
            ) VALUES ('local', ?, ?, ?, ?, 'experience', 'unchanged',
                      'preserve', ?, ?)
            """,
            (
                str(job_id),
                generation,
                f"bullet:{artifact_id}",
                artifact_id,
                artifact_id,
                created_at,
            ),
        )

    _insert_stable(
        job_id=losing_id,
        generation=1,
        artifact_id="losing-1",
        created_at="2026-07-29T10:00:00+00:00",
    )
    _insert_stable(
        job_id=surviving_id,
        generation=1,
        artifact_id="surviving-1",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_stable(
        job_id=losing_id,
        generation=2,
        artifact_id="losing-2",
        created_at="2026-07-29T10:02:00+00:00",
    )
    conn.commit()

    _reassign_materials_references_v15(
        conn,
        tenant_id="local",
        losing_job_id=str(losing_id),
        surviving_job_id=str(surviving_id),
    )
    for table in database_module._MATERIALS_REFERENCE_TABLES:
        assert conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 3
        assert {
            row[0]
            for row in conn.execute(
                f'SELECT DISTINCT job_id FROM "{table}"'
            ).fetchall()
        } == {str(surviving_id)}
    artifacts = conn.execute(
        """
        SELECT generation, artifact_id
        FROM job_materials_artifacts
        ORDER BY generation
        """
    ).fetchall()
    assert [tuple(row) for row in artifacts] == [
        (1, "losing-1"),
        (2, "surviving-1"),
        (3, "losing-2"),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)
