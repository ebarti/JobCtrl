"""Schema-v12 scoring identity and score-history migration contracts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    _reassign_scoring_references_v12,
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
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.scoring import SqliteScoreRepository


PREVIOUS_SCHEMA_VERSION = 11


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


def _downgrade_scoring_references_to_v11(
    conn: sqlite3.Connection,
) -> None:
    for table in (
        "job_requirement_fit_items",
        "job_requirement_fit_reports",
        "job_score_staleness",
        "job_scores",
    ):
        conn.execute(f'DROP TABLE "{table}"')
    conn.executescript(
        """
        CREATE TABLE job_scores (
            job_url             TEXT NOT NULL,
            version             INTEGER NOT NULL,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            fit_score           INTEGER NOT NULL CHECK(fit_score BETWEEN 1 AND 10),
            breakdown_json      TEXT NOT NULL,
            keywords_json       TEXT NOT NULL,
            scored_at           TEXT NOT NULL,
            correction_json     TEXT,
            criteria_json       TEXT NOT NULL DEFAULT '{}',
            trace_json          TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (job_url, version),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_scores_tenant_score
            ON job_scores(tenant_id, fit_score DESC, scored_at DESC);
        CREATE INDEX idx_job_scores_job_version
            ON job_scores(job_url, version DESC);

        CREATE TABLE job_requirement_fit_reports (
            job_url                       TEXT NOT NULL,
            score_version                 INTEGER NOT NULL,
            tenant_id                     TEXT NOT NULL DEFAULT 'local',
            employer_analysis_generation  INTEGER NOT NULL,
            profile_snapshot_version      INTEGER NOT NULL,
            scoring_policy_version        INTEGER NOT NULL,
            formula_version               TEXT NOT NULL,
            resolved_fit_score            INTEGER,
            fit_band                      TEXT NOT NULL,
            confidence                    TEXT NOT NULL,
            summary_json                  TEXT NOT NULL DEFAULT '{}',
            created_at                    TEXT NOT NULL,
            PRIMARY KEY (job_url, score_version, tenant_id),
            FOREIGN KEY (job_url, score_version)
                REFERENCES job_scores(job_url, version) ON DELETE CASCADE
        );
        CREATE TABLE job_requirement_fit_items (
            job_url                 TEXT NOT NULL,
            score_version           INTEGER NOT NULL,
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            requirement_id          TEXT NOT NULL,
            requirement_text        TEXT NOT NULL,
            tier                    TEXT NOT NULL,
            weight                  REAL NOT NULL,
            job_evidence_span       TEXT NOT NULL,
            fit_json                TEXT NOT NULL,
            contribution_json       TEXT NOT NULL,
            tailoring_json          TEXT NOT NULL,
            artifact_coverage_json  TEXT,
            position                INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (
                job_url, score_version, tenant_id, requirement_id
            ),
            FOREIGN KEY (job_url, score_version, tenant_id)
                REFERENCES job_requirement_fit_reports(
                    job_url, score_version, tenant_id
                ) ON DELETE CASCADE
        );
        CREATE INDEX idx_requirement_fit_reports_tenant_job
            ON job_requirement_fit_reports(
                tenant_id, job_url, score_version DESC
            );
        CREATE INDEX idx_requirement_fit_items_requirement
            ON job_requirement_fit_items(tenant_id, requirement_id);

        CREATE TABLE job_score_staleness (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            job_url                   TEXT NOT NULL,
            stale_reason              TEXT NOT NULL,
            old_policy_id             TEXT NOT NULL DEFAULT '',
            old_policy_version        INTEGER NOT NULL,
            new_policy_id             TEXT NOT NULL DEFAULT '',
            new_policy_version        INTEGER NOT NULL,
            marked_at                 TEXT NOT NULL,
            resolved                  INTEGER NOT NULL DEFAULT 0,
            resolved_at               TEXT,
            resolved_by_score_version INTEGER,
            PRIMARY KEY (
                tenant_id, job_url, stale_reason,
                old_policy_version, new_policy_version
            ),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        );
        CREATE INDEX idx_job_score_staleness_unresolved
            ON job_score_staleness(tenant_id, resolved, marked_at DESC);
        CREATE INDEX idx_job_score_staleness_job
            ON job_score_staleness(tenant_id, job_url, resolved);
        """
    )
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()


def _insert_score(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    version: int = 1,
    fit_score: int,
    scored_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json,
            criteria_json, trace_json
        ) VALUES (?, ?, 'local', ?, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            job_url,
            version,
            fit_score,
            json.dumps(
                {
                    "technical_fit": fit_score,
                    "experience_fit": fit_score,
                    "role_fit": fit_score,
                    "reasoning": job_url,
                },
                sort_keys=True,
            ),
            scored_at,
        ),
    )


def _insert_requirement_fit(
    conn: sqlite3.Connection,
    job_url: str,
    requirement_id: str,
    *,
    score_version: int = 1,
    created_at: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            job_url, score_version, tenant_id,
            employer_analysis_generation, profile_snapshot_version,
            scoring_policy_version, formula_version, resolved_fit_score,
            fit_band, confidence, summary_json, created_at
        ) VALUES (?, ?, 'local', 1, 1, 1, 'v1', 8,
                  'strong', 'high', '{}', ?)
        """,
        (job_url, score_version, created_at),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_items (
            job_url, score_version, tenant_id, requirement_id,
            requirement_text, tier, weight, job_evidence_span,
            fit_json, contribution_json, tailoring_json,
            artifact_coverage_json, position
        ) VALUES (?, ?, 'local', ?, 'Python', 'must_have', 1,
                  'Python', '{}', '{}', '{}', NULL, 0)
        """,
        (job_url, score_version, requirement_id),
    )


def _insert_staleness(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    stale_reason: str,
    resolved: bool,
    marked_at: str,
    resolved_by_score_version: int = 1,
) -> None:
    conn.execute(
        """
        INSERT INTO job_score_staleness (
            tenant_id, job_url, stale_reason, old_policy_id,
            old_policy_version, new_policy_id, new_policy_version,
            marked_at, resolved, resolved_at,
            resolved_by_score_version
        ) VALUES ('local', ?, ?, 'policy-v1', 1, 'policy-v2', 2,
                  ?, ?, ?, ?)
        """,
        (
            job_url,
            stale_reason,
            marked_at,
            int(resolved),
            marked_at if resolved else None,
            resolved_by_score_version if resolved else None,
        ),
    )


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    }


def test_v11_scoring_references_migrate_alias_histories_and_reopen(
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

    _downgrade_scoring_references_to_v11(conn)
    _insert_score(
        conn,
        original_url,
        fit_score=6,
        scored_at="2026-07-29T10:00:00+00:00",
    )
    _insert_score(
        conn,
        current_url,
        fit_score=8,
        scored_at="2026-07-29T10:01:00+00:00",
    )
    _insert_score(
        conn,
        uuid_shaped_url,
        fit_score=7,
        scored_at="2026-07-29T10:02:00+00:00",
    )
    _insert_requirement_fit(
        conn,
        original_url,
        "original",
        created_at="2026-07-29T10:00:00+00:00",
    )
    _insert_requirement_fit(
        conn,
        current_url,
        "current",
        created_at="2026-07-29T10:01:00+00:00",
    )
    _insert_staleness(
        conn,
        original_url,
        stale_reason="scoring_policy_changed",
        resolved=True,
        marked_at="2026-07-29T10:02:00+00:00",
    )
    _insert_staleness(
        conn,
        current_url,
        stale_reason="scoring_policy_changed",
        resolved=False,
        marked_at="2026-07-29T10:03:00+00:00",
    )
    _insert_staleness(
        conn,
        current_url,
        stale_reason="manual_review",
        resolved=True,
        marked_at="2026-07-29T10:04:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    migrated = init_db(db_path)
    assert (
        int(migrated.execute("PRAGMA user_version").fetchone()[0])
        == SCHEMA_VERSION
        == 16
    )
    assert _columns(migrated, "job_scores") >= {"tenant_id", "job_id"}
    assert "job_url" not in _columns(migrated, "job_scores")
    assert [
        tuple(row)
        for row in migrated.execute(
        """
        SELECT version, fit_score
        FROM job_scores
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY version
        """,
        (str(stable_job_id),),
        ).fetchall()
    ] == [(1, 6), (2, 8)]
    assert [
        tuple(row)
        for row in migrated.execute(
        """
        SELECT score_version, requirement_id
        FROM job_requirement_fit_items
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY score_version
        """,
        (str(stable_job_id),),
        ).fetchall()
    ] == [(1, "original"), (2, "current")]
    assert [
        tuple(row)
        for row in migrated.execute(
        """
        SELECT stale_reason, resolved, resolved_by_score_version
        FROM job_score_staleness
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY stale_reason
        """,
        (str(stable_job_id),),
        ).fetchall()
    ] == [
        ("manual_review", 1, 2),
        ("scoring_policy_changed", 0, None),
    ]
    assert migrated.execute(
        """
        SELECT job_id
        FROM job_scores
        WHERE fit_score = 7
        """
    ).fetchone()[0] == str(uuid_url_owner)
    assert migrated.execute("PRAGMA foreign_key_check").fetchone() is None

    repository = SqliteScoreRepository(migrated)
    assert repository.load(LOCAL_TENANT, stable_job_id).version == 2
    uuid_url_score = repository.load_by_posting_url(
        LOCAL_TENANT,
        PostingUrl(uuid_shaped_url),
    )
    assert uuid_url_score is not None
    assert uuid_url_score.job_id == uuid_url_owner

    close_connection(db_path)
    reopened = init_db(db_path)
    assert (
        int(reopened.execute("PRAGMA user_version").fetchone()[0])
        == SCHEMA_VERSION
        == 16
    )


def test_v11_scoring_migration_preserves_each_alias_version_order(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    original_url = "https://boards.example/jobs/version-order"
    alias_url = "https://careers.example/jobs/version-order"
    jobs.save(_discovered_job(original_url, stable_job_id))
    jobs.save(_discovered_job(alias_url, stable_job_id))
    _downgrade_scoring_references_to_v11(conn)

    _insert_score(
        conn,
        original_url,
        version=1,
        fit_score=9,
        scored_at="2026-07-29T11:00:00+00:00",
    )
    _insert_score(
        conn,
        original_url,
        version=2,
        fit_score=3,
        scored_at="2026-07-29T10:00:00+00:00",
    )
    _insert_score(
        conn,
        alias_url,
        version=1,
        fit_score=7,
        scored_at="2026-07-29T10:30:00+00:00",
    )
    _insert_requirement_fit(
        conn,
        original_url,
        "latest-original",
        score_version=2,
        created_at="2026-07-29T11:05:00+00:00",
    )
    _insert_staleness(
        conn,
        original_url,
        stale_reason="manual_review",
        resolved=True,
        marked_at="2026-07-29T11:10:00+00:00",
        resolved_by_score_version=2,
    )
    conn.commit()
    close_connection(db_path)

    migrated = init_db(db_path)
    assert [
        tuple(row)
        for row in migrated.execute(
            """
            SELECT version, fit_score
            FROM job_scores
            WHERE tenant_id = 'local' AND job_id = ?
            ORDER BY version
            """,
            (str(stable_job_id),),
        ).fetchall()
    ] == [(1, 7), (2, 9), (3, 3)]
    assert migrated.execute(
        """
        SELECT score_version
        FROM job_requirement_fit_reports
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (str(stable_job_id),),
    ).fetchone()[0] == 3
    assert migrated.execute(
        """
        SELECT resolved_by_score_version
        FROM job_score_staleness
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (str(stable_job_id),),
    ).fetchone()[0] == 3
    latest = SqliteScoreRepository(migrated).load(
        LOCAL_TENANT,
        stable_job_id,
    )
    assert latest is not None
    assert latest.version == 3
    assert latest.fit_score.value == 3


def test_scoring_migration_rolls_back_and_retries_after_verification_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_scoring_references_to_v11(conn)
    _insert_score(
        conn,
        job_url,
        fit_score=8,
        scored_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    original_verify = database_module._verify_scoring_references_v12

    def fail_verification(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("forced scoring verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_scoring_references_v12",
        fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="forced scoring verification failure",
    ):
        init_db(db_path)
    close_connection(db_path)

    rolled_back = sqlite3.connect(db_path)
    try:
        assert int(
            rolled_back.execute("PRAGMA user_version").fetchone()[0]
        ) == PREVIOUS_SCHEMA_VERSION
        assert "job_url" in _columns(rolled_back, "job_scores")
        assert "job_id" not in _columns(rolled_back, "job_scores")
    finally:
        rolled_back.close()

    monkeypatch.setattr(
        database_module,
        "_verify_scoring_references_v12",
        original_verify,
    )
    retried = init_db(db_path)
    assert (
        int(retried.execute("PRAGMA user_version").fetchone()[0])
        == SCHEMA_VERSION
        == 16
    )
    assert [
        tuple(row)
        for row in retried.execute(
            "SELECT job_id, version FROM job_scores"
        ).fetchall()
    ] == [(str(job_id), 1)]


def test_runtime_scoring_collision_merge_preserves_both_histories(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    jobs = SqliteJobRepository(conn)
    losing_job_id = JobId(str(uuid.uuid4()))
    surviving_job_id = JobId(str(uuid.uuid4()))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/losing",
            losing_job_id,
        )
    )
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/surviving",
            surviving_job_id,
        )
    )
    for job_id, version, fit_score, scored_at in (
        (losing_job_id, 1, 6, "2026-07-29T11:00:00+00:00"),
        (losing_job_id, 2, 5, "2026-07-29T10:00:00+00:00"),
        (surviving_job_id, 1, 8, "2026-07-29T10:30:00+00:00"),
    ):
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at, correction_json,
                criteria_json, trace_json
            ) VALUES ('local', ?, ?, ?, '{}', '["python"]', ?,
                      NULL, '{}', '{}')
            """,
            (str(job_id), version, fit_score, scored_at),
        )
    conn.commit()

    _reassign_scoring_references_v12(
        conn,
        tenant_id="local",
        losing_job_id=str(losing_job_id),
        surviving_job_id=str(surviving_job_id),
    )

    assert [
        tuple(row)
        for row in conn.execute(
        """
        SELECT job_id, version, fit_score
        FROM job_scores
        ORDER BY version
        """
        ).fetchall()
    ] == [
        (str(surviving_job_id), 1, 8),
        (str(surviving_job_id), 2, 6),
        (str(surviving_job_id), 3, 5),
    ]
