"""Schema-v16 employer-analysis identity migration contracts."""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_employer_analysis_references_v16,
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


PREVIOUS_SCHEMA_VERSION = 15


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


def _downgrade_employer_analysis_references_to_v15(
    conn: sqlite3.Connection,
) -> None:
    for table in (
        "job_employer_analysis_sub_analyses",
        "job_employer_analysis_failures",
        "job_employer_analysis",
    ):
        conn.execute(f'DROP TABLE "{table}"')
    conn.executescript(
        """
        CREATE TABLE job_employer_analysis (
            job_url                   TEXT NOT NULL,
            generation                INTEGER NOT NULL,
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            snapshot_hash             TEXT NOT NULL,
            prompt_version            TEXT NOT NULL,
            sdk_set_version           TEXT NOT NULL,
            cache_key                 TEXT NOT NULL,
            role_framing              TEXT NOT NULL DEFAULT '',
            inferred_seniority        TEXT NOT NULL DEFAULT '',
            ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
            requirements_json         TEXT NOT NULL DEFAULT '[]',
            keywords_json             TEXT NOT NULL DEFAULT '[]',
            agreement_json            TEXT NOT NULL DEFAULT '{}',
            eeo_screen_json           TEXT NOT NULL DEFAULT '[]',
            legs_attempted            INTEGER NOT NULL,
            legs_succeeded            INTEGER NOT NULL,
            created_at                TEXT NOT NULL,
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE TABLE job_employer_analysis_sub_analyses (
            job_url       TEXT NOT NULL,
            generation    INTEGER NOT NULL,
            model_id      TEXT NOT NULL,
            tenant_id     TEXT NOT NULL DEFAULT 'local',
            analysis_json TEXT NOT NULL,
            PRIMARY KEY (job_url, generation, model_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_employer_analysis(job_url, generation)
                ON DELETE CASCADE
        );
        CREATE TABLE job_employer_analysis_failures (
            job_url    TEXT NOT NULL,
            generation INTEGER NOT NULL,
            model_id   TEXT NOT NULL,
            tenant_id  TEXT NOT NULL DEFAULT 'local',
            error      TEXT NOT NULL,
            raw_output TEXT,
            PRIMARY KEY (job_url, generation, model_id),
            FOREIGN KEY (job_url, generation)
                REFERENCES job_employer_analysis(job_url, generation)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_job_employer_analysis_cache_key
            ON job_employer_analysis(tenant_id, job_url, cache_key);
        CREATE INDEX idx_job_employer_analysis_tenant_job_gen
            ON job_employer_analysis(
                tenant_id, job_url, generation DESC
            );
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_legacy_analysis(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    generation: int,
    marker: str,
    created_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_employer_analysis (
            job_url, generation, tenant_id, snapshot_hash,
            prompt_version, sdk_set_version, cache_key, role_framing,
            inferred_seniority, ideal_candidate_narrative,
            requirements_json, keywords_json, agreement_json,
            eeo_screen_json, legs_attempted, legs_succeeded, created_at
        ) VALUES (
            ?, ?, 'local', ?, 'prompt-v1', 'sdk-v1', ?, ?, 'staff', ?,
            '[]', '[]', '{}', '[]', 2, 1, ?
        )
        """,
        (
            job_url,
            generation,
            marker,
            f"cache:{marker}",
            f"role:{marker}",
            f"narrative:{marker}",
            created_at,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_employer_analysis_sub_analyses (
            job_url, generation, model_id, tenant_id, analysis_json
        ) VALUES (?, ?, ?, 'local', ?)
        """,
        (
            job_url,
            generation,
            f"draft:{marker}",
            f'{{"marker":"{marker}"}}',
        ),
    )
    conn.execute(
        """
        INSERT INTO job_employer_analysis_failures (
            job_url, generation, model_id, tenant_id, error, raw_output
        ) VALUES (?, ?, ?, 'local', ?, NULL)
        """,
        (
            job_url,
            generation,
            f"failure:{marker}",
            f"error:{marker}",
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


def test_v15_employer_analysis_migrates_alias_histories_and_uuid_urls(
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

    _downgrade_employer_analysis_references_to_v15(conn)
    _insert_legacy_analysis(
        conn,
        job_url=original_url,
        generation=1,
        marker="original-1",
        created_at="2026-07-29T10:00:00+00:00",
    )
    _insert_legacy_analysis(
        conn,
        job_url=current_url,
        generation=1,
        marker="current-1",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_legacy_analysis(
        conn,
        job_url=original_url,
        generation=2,
        marker="original-2",
        created_at="2026-07-29T10:02:00+00:00",
    )
    _insert_legacy_analysis(
        conn,
        job_url=uuid_shaped_url,
        generation=1,
        marker="uuid-url-owner",
        created_at="2026-07-29T10:03:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 16
    )
    for table in database_module._EMPLOYER_ANALYSIS_REFERENCE_TABLES:
        assert "job_id" in _columns(reopened, table)
        assert "job_url" not in _columns(reopened, table)
        assert reopened.execute(
            f'SELECT COUNT(*) FROM "{table}"'
        ).fetchone()[0] == 4

    merged = reopened.execute(
        """
        SELECT generation, snapshot_hash
        FROM job_employer_analysis
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
        FROM job_employer_analysis
        WHERE snapshot_hash = 'uuid-url-owner'
        """
    ).fetchone()[0] == str(uuid_url_owner)
    assert reopened.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert (
        reopened_again.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
    )
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM job_employer_analysis"
    ).fetchone()[0] == 4
    close_connection(db_path)


def test_v16_employer_analysis_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_employer_analysis_references_to_v15(conn)
    _insert_legacy_analysis(
        conn,
        job_url=job_url,
        generation=1,
        marker="retry",
        created_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()

    original_verify = (
        database_module._verify_employer_analysis_references_v16
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected employer-analysis verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_employer_analysis_references_v16",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected employer-analysis verification failure",
    ):
        ensure_employer_analysis_references_v16(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 15
    assert "job_url" in _columns(conn, "job_employer_analysis")
    assert conn.execute(
        "SELECT COUNT(*) FROM job_employer_analysis"
    ).fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_employer_analysis_references_v16",
        original_verify,
    )
    assert ensure_employer_analysis_references_v16(conn) == list(
        database_module._EMPLOYER_ANALYSIS_REFERENCE_TABLES
    )
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 16
    assert "job_id" in _columns(conn, "job_employer_analysis")
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_runtime_employer_analysis_merge_preserves_all_histories(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/losing"
    surviving_url = "https://example.com/jobs/surviving"
    jobs.save(
        _discovered_job(
            losing_url,
            losing_id,
        )
    )
    jobs.save(
        _discovered_job(
            surviving_url,
            surviving_id,
        )
    )

    def _insert_stable(
        *,
        job_id: JobId,
        generation: int,
        marker: str,
        created_at: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO job_employer_analysis (
                tenant_id, job_id, generation, snapshot_hash,
                prompt_version, sdk_set_version, cache_key,
                role_framing, inferred_seniority,
                ideal_candidate_narrative, requirements_json,
                keywords_json, agreement_json, eeo_screen_json,
                legs_attempted, legs_succeeded, created_at
            ) VALUES (
                'local', ?, ?, ?, 'prompt-v1', 'sdk-v1', ?, ?, 'staff',
                ?, '[]', '[]', '{}', '[]', 2, 1, ?
            )
            """,
            (
                str(job_id),
                generation,
                marker,
                f"cache:{marker}",
                f"role:{marker}",
                f"narrative:{marker}",
                created_at,
            ),
        )
        conn.execute(
            """
            INSERT INTO job_employer_analysis_sub_analyses (
                tenant_id, job_id, generation, model_id, analysis_json
            ) VALUES ('local', ?, ?, ?, '{}')
            """,
            (str(job_id), generation, f"draft:{marker}"),
        )
        conn.execute(
            """
            INSERT INTO job_employer_analysis_failures (
                tenant_id, job_id, generation, model_id, error, raw_output
            ) VALUES ('local', ?, ?, ?, ?, NULL)
            """,
            (
                str(job_id),
                generation,
                f"failure:{marker}",
                f"error:{marker}",
            ),
        )

    _insert_stable(
        job_id=losing_id,
        generation=1,
        marker="losing-1",
        created_at="2026-07-29T10:00:00+00:00",
    )
    _insert_stable(
        job_id=surviving_id,
        generation=1,
        marker="surviving-1",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_stable(
        job_id=losing_id,
        generation=2,
        marker="losing-2",
        created_at="2026-07-29T10:02:00+00:00",
    )
    conn.executemany(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json,
            criteria_json, trace_json
        ) VALUES ('local', ?, 1, ?, '{}', '[]', ?, NULL, '{}', '{}')
        """,
        (
            (
                str(losing_id),
                7,
                "2026-07-29T10:10:00+00:00",
            ),
            (
                str(surviving_id),
                8,
                "2026-07-29T10:11:00+00:00",
            ),
        ),
    )
    conn.executemany(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version,
            employer_analysis_generation, profile_snapshot_version,
            scoring_policy_version, formula_version, resolved_fit_score,
            fit_band, confidence, summary_json, created_at
        ) VALUES (
            'local', ?, 1, 1, 1, 1, 'v1', ?, 'strong', 'high', ?, ?
        )
        """,
        (
            (
                str(losing_id),
                7,
                '{"source":"losing"}',
                "2026-07-29T10:10:00+00:00",
            ),
            (
                str(surviving_id),
                8,
                '{"source":"surviving"}',
                "2026-07-29T10:11:00+00:00",
            ),
        ),
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )
    for table in database_module._EMPLOYER_ANALYSIS_REFERENCE_TABLES:
        assert conn.execute(
            f'SELECT COUNT(*) FROM "{table}"'
        ).fetchone()[0] == 3
        assert {
            row[0]
            for row in conn.execute(
                f'SELECT DISTINCT job_id FROM "{table}"'
            ).fetchall()
        } == {str(surviving_id)}
    analyses = conn.execute(
        """
        SELECT generation, snapshot_hash
        FROM job_employer_analysis
        ORDER BY generation
        """
    ).fetchall()
    assert [tuple(row) for row in analyses] == [
        (1, "losing-1"),
        (2, "surviving-1"),
        (3, "losing-2"),
    ]
    report_bindings = conn.execute(
        """
        SELECT score_version, employer_analysis_generation, summary_json
        FROM job_requirement_fit_reports
        ORDER BY score_version
        """
    ).fetchall()
    assert [tuple(row) for row in report_bindings] == [
        (1, 1, '{"source":"losing"}'),
        (2, 2, '{"source":"surviving"}'),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)
