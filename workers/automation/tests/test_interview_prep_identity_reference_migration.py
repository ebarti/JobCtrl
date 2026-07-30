"""Schema-v18 Interview Preparation JobId reference contracts."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_interview_prep_references_v18,
    init_db,
    reassign_discovery_identity_references,
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
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository


PREVIOUS_SCHEMA_VERSION = 17


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


def _downgrade_interview_prep_references_to_v17(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE application_outcomes")
    conn.execute("DROP TABLE job_interview_prep_items")
    conn.execute("DROP TABLE job_interview_prep")
    conn.executescript(
        """
        CREATE TABLE job_interview_prep (
            job_url                    TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            status                     TEXT NOT NULL,
            model                      TEXT,
            generated_at               TEXT NOT NULL,
            gate_status                TEXT NOT NULL,
            fabrication_findings_json  TEXT NOT NULL DEFAULT '[]',
            grounding_findings_json    TEXT NOT NULL DEFAULT '[]',
            judge_verdict              TEXT,
            warnings_json              TEXT NOT NULL DEFAULT '[]',
            failure_reason             TEXT NOT NULL DEFAULT '',
            origin_run_id              TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url)
                REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE TABLE job_interview_prep_items (
            job_url                    TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            item_id                    TEXT NOT NULL,
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            kind                       TEXT NOT NULL,
            title                      TEXT NOT NULL,
            generated_text             TEXT NOT NULL,
            evidence_ids_json          TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json       TEXT NOT NULL DEFAULT '[]',
            source_text_json           TEXT NOT NULL DEFAULT '[]',
            transform_type             TEXT NOT NULL DEFAULT 'grounded_prep',
            control                    TEXT NOT NULL DEFAULT 'never_fabricate',
            grounding_audit_json       TEXT NOT NULL DEFAULT '[]',
            warnings_json              TEXT NOT NULL DEFAULT '[]',
            position                   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_url, generation, item_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_interview_prep(job_url, generation)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_job_interview_prep_tenant_job_gen
            ON job_interview_prep(
                tenant_id, job_url, generation DESC
            );
        CREATE INDEX idx_job_interview_prep_tenant_status
            ON job_interview_prep(
                tenant_id, status, generated_at DESC
            );
        CREATE INDEX idx_job_interview_prep_origin_run
            ON job_interview_prep(
                tenant_id, job_url, origin_run_id
            );
        CREATE INDEX idx_job_interview_prep_items_tenant_kind
            ON job_interview_prep_items(
                tenant_id, kind, position
            );
        CREATE TABLE application_outcomes (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            outcome_id                TEXT NOT NULL,
            job_key                   TEXT NOT NULL,
            kind                      TEXT NOT NULL,
            source                    TEXT NOT NULL,
            occurred_at               TEXT NOT NULL,
            recorded_at               TEXT NOT NULL,
            interview_prep_generation INTEGER,
            PRIMARY KEY (tenant_id, outcome_id)
        );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_legacy_prep(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    generation: int,
    status: str,
    marker: str,
    generated_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_interview_prep (
            job_url, generation, tenant_id, status, model, generated_at,
            gate_status, fabrication_findings_json,
            grounding_findings_json, judge_verdict, warnings_json,
            failure_reason, origin_run_id
        ) VALUES (
            ?, ?, 'local', ?, 'test-model', ?, 'passed', '[]', '[]',
            'pass:1.00', '[]', '', ?
        )
        """,
        (
            job_url,
            generation,
            status,
            generated_at,
            f"run:{marker}",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_interview_prep_items (
            job_url, generation, item_id, tenant_id, kind, title,
            generated_text, evidence_ids_json, requirement_ids_json,
            source_text_json, transform_type, control,
            grounding_audit_json, warnings_json, position
        ) VALUES (
            ?, ?, ?, 'local', 'theme', ?, ?, '[]', '[]', '[]',
            'grounded_interview_prep', 'never_fabricate', '[]', '[]', 0
        )
        """,
        (
            job_url,
            generation,
            f"item:{marker}",
            f"Title {marker}",
            f"Text {marker}",
        ),
    )


def _insert_outcome_link(
    conn: sqlite3.Connection,
    *,
    outcome_id: str,
    job_key: str,
    generation: int,
    tenant_id: str = "local",
) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS application_outcomes (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            outcome_id               TEXT NOT NULL,
            job_key                  TEXT NOT NULL,
            kind                     TEXT NOT NULL,
            source                   TEXT NOT NULL,
            occurred_at              TEXT NOT NULL,
            recorded_at              TEXT NOT NULL,
            interview_prep_generation INTEGER,
            PRIMARY KEY (tenant_id, outcome_id)
        )
        """
    )
    columns = _columns(conn, "application_outcomes")
    reference_column = "job_id" if "job_id" in columns else "job_key"
    reference = job_key
    if reference_column == "job_id":
        row = conn.execute(
            """
            SELECT job_id
            FROM jobs
            WHERE tenant_id = ? AND url = ?
            """,
            (tenant_id, job_key),
        ).fetchone()
        assert row is not None
        reference = str(row[0])
    conn.execute(
        f"""
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, {reference_column}, kind, source, occurred_at,
            recorded_at, interview_prep_generation
        ) VALUES (?, ?, ?, 'interview', 'manual', ?, ?, ?)
        """,
        (
            tenant_id,
            outcome_id,
            reference,
            "2026-07-29T11:00:00+00:00",
            "2026-07-29T11:00:00+00:00",
            generation,
        ),
    )


def _columns(
    conn: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }


def test_v17_interview_prep_migrates_alias_histories_and_uuid_urls(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    original_url = "https://boards.example/jobs/123"
    current_url = "https://careers.example/jobs/platform"
    jobs.save(_discovered_job(original_url, stable_job_id))
    jobs.save(_discovered_job(current_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-owner",
            JobId(uuid_shaped_url),
        )
    )
    _downgrade_interview_prep_references_to_v17(conn)
    _insert_legacy_prep(
        conn,
        job_url=original_url,
        generation=1,
        status="accepted",
        marker="original-1",
        generated_at="2026-07-29T10:00:00+00:00",
    )
    _insert_legacy_prep(
        conn,
        job_url=current_url,
        generation=1,
        status="accepted",
        marker="current-1",
        generated_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_prep(
        conn,
        job_url=original_url,
        generation=2,
        status="failed",
        marker="original-2",
        generated_at="2026-07-29T10:02:00+00:00",
    )
    _insert_legacy_prep(
        conn,
        job_url=uuid_shaped_url,
        generation=1,
        status="accepted",
        marker="uuid-url-owner",
        generated_at="2026-07-29T10:03:00+00:00",
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-original",
        job_key=original_url,
        generation=1,
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-current",
        job_key=current_url,
        generation=1,
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-uuid-url",
        job_key=uuid_shaped_url,
        generation=1,
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 23
    )
    for table in database_module._INTERVIEW_PREP_REFERENCE_TABLES:
        assert "job_id" in _columns(reopened, table)
        assert "job_url" not in _columns(reopened, table)
        assert (
            reopened.execute(
                f'SELECT COUNT(*) FROM "{table}"'
            ).fetchone()[0]
            == 4
        )
    histories = reopened.execute(
        """
        SELECT generation, status, origin_run_id
        FROM job_interview_prep
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY generation
        """,
        (str(stable_job_id),),
    ).fetchall()
    assert [tuple(row) for row in histories] == [
        (1, "superseded", "run:original-1"),
        (2, "accepted", "run:current-1"),
        (3, "failed", "run:original-2"),
    ]
    items = reopened.execute(
        """
        SELECT generation, item_id
        FROM job_interview_prep_items
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY generation
        """,
        (str(stable_job_id),),
    ).fetchall()
    assert [tuple(row) for row in items] == [
        (1, "item:original-1"),
        (2, "item:current-1"),
        (3, "item:original-2"),
    ]
    assert reopened.execute(
        """
        SELECT job_id
        FROM job_interview_prep
        WHERE origin_run_id = 'run:uuid-url-owner'
        """
    ).fetchone()[0] == str(uuid_url_owner)
    assert [
        tuple(row)
        for row in reopened.execute(
            """
            SELECT outcome_id, job_id, interview_prep_generation
            FROM application_outcomes
            ORDER BY outcome_id
            """
        ).fetchall()
    ] == [
        ("outcome-current", str(stable_job_id), 2),
        ("outcome-original", str(stable_job_id), 1),
        ("outcome-uuid-url", str(uuid_url_owner), 1),
    ]
    repository = SqliteInterviewPrepRepository(reopened)
    latest = repository.load_latest(
        LOCAL_TENANT,
        JobId(current_url),
    )
    assert latest is not None
    assert latest.job_key == current_url
    assert latest.generation == 2
    uuid_owner_latest = repository.load_latest(
        LOCAL_TENANT,
        JobId(uuid_shaped_url),
    )
    assert uuid_owner_latest is not None
    assert uuid_owner_latest.job_key == uuid_shaped_url
    assert uuid_owner_latest.items[0].item_id == "item:uuid-url-owner"
    assert reopened.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM job_interview_prep_items"
    ).fetchone()[0] == 4
    close_connection(db_path)


def test_v18_interview_prep_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_interview_prep_references_to_v17(conn)
    _insert_legacy_prep(
        conn,
        job_url=job_url,
        generation=1,
        status="accepted",
        marker="retry",
        generated_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()
    original_verify = (
        database_module._verify_interview_prep_references_v18
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected interview-prep verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_interview_prep_references_v18",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected interview-prep verification failure",
    ):
        ensure_interview_prep_references_v18(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 17
    assert "job_url" in _columns(conn, "job_interview_prep")
    assert conn.execute(
        "SELECT COUNT(*) FROM job_interview_prep_items"
    ).fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_interview_prep_references_v18",
        original_verify,
    )
    assert ensure_interview_prep_references_v18(conn) == list(
        database_module._INTERVIEW_PREP_REFERENCE_TABLES
    )
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 18
    assert "job_id" in _columns(conn, "job_interview_prep")
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_runtime_interview_prep_merge_preserves_histories_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    other_tenant_job_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/losing"
    surviving_url = "https://example.com/jobs/surviving"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example', ?)
        """,
        (
            "https://tenant-b.example/jobs/stable",
            str(other_tenant_job_id),
            "2026-07-29T10:00:00+00:00",
        ),
    )

    def _insert_stable(
        *,
        tenant_id: str,
        job_id: JobId,
        generation: int,
        status: str,
        marker: str,
        generated_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO job_interview_prep (
                tenant_id, job_id, generation, status, model,
                generated_at, gate_status, fabrication_findings_json,
                grounding_findings_json, judge_verdict, warnings_json,
                failure_reason, origin_run_id
            ) VALUES (
                ?, ?, ?, ?, 'test-model', ?, 'passed', '[]', '[]',
                'pass:1.00', '[]', '', ?
            )
            """,
            (
                tenant_id,
                str(job_id),
                generation,
                status,
                generated_at,
                f"run:{marker}",
            ),
        )
        conn.execute(
            """
            INSERT INTO job_interview_prep_items (
                tenant_id, job_id, generation, item_id, kind, title,
                generated_text, evidence_ids_json,
                requirement_ids_json, source_text_json, transform_type,
                control, grounding_audit_json, warnings_json, position
            ) VALUES (
                ?, ?, ?, ?, 'theme', ?, ?, '[]', '[]', '[]',
                'grounded_interview_prep', 'never_fabricate',
                '[]', '[]', 0
            )
            """,
            (
                tenant_id,
                str(job_id),
                generation,
                f"item:{marker}",
                f"Title {marker}",
                f"Text {marker}",
            ),
        )

    _insert_stable(
        tenant_id="local",
        job_id=surviving_id,
        generation=1,
        status="accepted",
        marker="surviving-1",
        generated_at="2026-07-29T10:01:00+00:00",
    )
    _insert_stable(
        tenant_id="local",
        job_id=losing_id,
        generation=1,
        status="accepted",
        marker="losing-1",
        generated_at="2026-07-29T10:00:00+00:00",
    )
    _insert_stable(
        tenant_id="local",
        job_id=surviving_id,
        generation=2,
        status="failed",
        marker="surviving-2",
        generated_at="2026-07-29T10:02:00+00:00",
    )
    _insert_stable(
        tenant_id="local",
        job_id=losing_id,
        generation=2,
        status="failed",
        marker="losing-2",
        generated_at="2026-07-29T10:03:00+00:00",
    )
    _insert_stable(
        tenant_id="tenant-b",
        job_id=other_tenant_job_id,
        generation=1,
        status="accepted",
        marker="other-tenant",
        generated_at="2026-07-29T10:04:00+00:00",
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-surviving",
        job_key=surviving_url,
        generation=1,
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-losing",
        job_key=losing_url,
        generation=1,
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-other-tenant",
        job_key="https://tenant-b.example/jobs/stable",
        generation=1,
        tenant_id="tenant-b",
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )
    conn.execute(
        "DELETE FROM jobs WHERE tenant_id = 'local' AND url = ?",
        (losing_url,),
    )

    histories = conn.execute(
        """
        SELECT generation, status, origin_run_id
        FROM job_interview_prep
        WHERE tenant_id = 'local'
        ORDER BY generation
        """
    ).fetchall()
    assert [tuple(row) for row in histories] == [
        (1, "superseded", "run:losing-1"),
        (2, "accepted", "run:surviving-1"),
        (3, "failed", "run:surviving-2"),
        (4, "failed", "run:losing-2"),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT generation, item_id
            FROM job_interview_prep_items
            WHERE tenant_id = 'local'
            ORDER BY generation
            """
        ).fetchall()
    ] == [
        (1, "item:losing-1"),
        (2, "item:surviving-1"),
        (3, "item:surviving-2"),
        (4, "item:losing-2"),
    ]
    assert {
        row[0]
        for row in conn.execute(
            """
            SELECT DISTINCT job_id
            FROM job_interview_prep
            WHERE tenant_id = 'local'
            """
        ).fetchall()
    } == {str(surviving_id)}
    assert tuple(
        conn.execute(
            """
            SELECT job_id, generation, origin_run_id
            FROM job_interview_prep
            WHERE tenant_id = 'tenant-b'
            """
        ).fetchone()
    ) == (str(other_tenant_job_id), 1, "run:other-tenant")
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, outcome_id, job_id,
                   interview_prep_generation
            FROM application_outcomes
            ORDER BY tenant_id, outcome_id
            """
        ).fetchall()
    ] == [
        ("local", "outcome-losing", str(surviving_id), 1),
        ("local", "outcome-surviving", str(surviving_id), 2),
        (
            "tenant-b",
            "outcome-other-tenant",
            str(other_tenant_job_id),
            1,
        ),
    ]
    assert conn.execute(
        """
        SELECT job_id
        FROM job_identity_aliases
        WHERE tenant_id = 'local'
          AND alias_kind = 'posting_url'
          AND alias_value = ?
        """,
        (losing_url,),
    ).fetchone() is None
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT outcome.outcome_id, prep.origin_run_id
            FROM application_outcomes AS outcome
            JOIN job_interview_prep AS prep
              ON prep.tenant_id = outcome.tenant_id
             AND prep.job_id = outcome.job_id
             AND prep.generation =
                 outcome.interview_prep_generation
            WHERE outcome.tenant_id = 'local'
            ORDER BY outcome.outcome_id
            """
        ).fetchall()
    ] == [
        ("outcome-losing", "run:losing-1"),
        ("outcome-surviving", "run:surviving-1"),
    ]
    latest = SqliteInterviewPrepRepository(conn).load_latest(
        LOCAL_TENANT,
        JobId(surviving_url),
    )
    assert latest is not None
    assert latest.job_key == surviving_url
    assert latest.generation == 2
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_real_url_collision_keeps_outcome_link_reachable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.enrichment import detail

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    canonical_url = "https://example.com/jobs/interview-collision"
    losing_url = "/jobs/interview-collision"
    conn.executemany(
        "INSERT INTO jobs (url, title, site) VALUES (?, ?, 'Synthetic')",
        (
            (canonical_url, "Canonical"),
            (losing_url, "Relative duplicate"),
        ),
    )
    job_ids = {
        str(row[0]): str(row[1])
        for row in conn.execute(
            "SELECT url, job_id FROM jobs WHERE url IN (?, ?)",
            (canonical_url, losing_url),
        ).fetchall()
    }
    conn.executemany(
        """
        INSERT INTO job_interview_prep (
            tenant_id, job_id, generation, status, model,
            generated_at, gate_status, fabrication_findings_json,
            grounding_findings_json, judge_verdict, warnings_json,
            failure_reason, origin_run_id
        ) VALUES (
            'local', ?, 1, 'accepted', 'test-model', ?, 'passed',
            '[]', '[]', 'pass:1.00', '[]', '', ?
        )
        """,
        (
            (
                job_ids[losing_url],
                "2026-07-29T10:00:00+00:00",
                "run:losing",
            ),
            (
                job_ids[canonical_url],
                "2026-07-29T10:01:00+00:00",
                "run:surviving",
            ),
        ),
    )
    _insert_outcome_link(
        conn,
        outcome_id="outcome-losing-url",
        job_key=losing_url,
        generation=1,
    )
    conn.commit()
    monkeypatch.setattr(
        detail,
        "_load_base_urls",
        lambda: {"Synthetic": "https://example.com"},
    )

    assert detail.resolve_all_urls(conn) == {
        "resolved": 1,
        "failed": 0,
        "already_absolute": 1,
        "app_resolved": 0,
    }
    outcome = conn.execute(
        """
        SELECT job_id, interview_prep_generation
        FROM application_outcomes
        WHERE outcome_id = 'outcome-losing-url'
        """
    ).fetchone()
    assert tuple(outcome) == (job_ids[canonical_url], 1)
    linked = conn.execute(
        """
        SELECT prep.origin_run_id
        FROM application_outcomes AS outcome
        JOIN job_interview_prep AS prep
          ON prep.tenant_id = outcome.tenant_id
         AND prep.job_id = outcome.job_id
         AND prep.generation = outcome.interview_prep_generation
        WHERE outcome.outcome_id = 'outcome-losing-url'
        """
    ).fetchone()
    assert linked is not None
    assert linked[0] == "run:losing"
    assert conn.execute(
        """
        SELECT 1
        FROM job_identity_aliases
        WHERE tenant_id = 'local'
          AND alias_kind = 'posting_url'
          AND alias_value = ?
        """,
        (losing_url,),
    ).fetchone() is None
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)
