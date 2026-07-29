"""Stable JobId foundation and previous-release recovery contracts."""

from __future__ import annotations

import shutil
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    IncompatibleSchemaVersionError,
    SCHEMA_VERSION,
    _assert_schema_version_supported,
    close_connection,
    init_db,
)


LEGACY_SCHEMA_VERSION = 6
REFERENCE_TABLES = (
    "job_stage_states",
    "job_events",
    "job_scores",
    "job_artifacts",
    "discovery_execution_jobs",
    "workflow_run_projections",
    "application_outcomes",
)


def _create_legacy_database(
    db_path: Path,
    *,
    jobs: tuple[tuple[str, str, str], ...] = (),
) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE jobs (
                url           TEXT PRIMARY KEY,
                title         TEXT,
                discovered_at TEXT
            )
            """
        )
        conn.executemany(
            "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
            jobs,
        )
        conn.execute(f"PRAGMA user_version = {LEGACY_SCHEMA_VERSION}")
        conn.commit()
    finally:
        conn.close()


def _identity_rows(db_path: Path) -> list[tuple[str, str, str]]:
    conn = sqlite3.connect(db_path)
    try:
        return [
            (str(row[0]), str(row[1]), str(row[2]))
            for row in conn.execute(
                "SELECT tenant_id, job_id, url FROM jobs ORDER BY url"
            ).fetchall()
        ]
    finally:
        conn.close()


def _create_representative_v6_pair(
    db_path: Path,
    temporal_path: Path,
) -> str:
    """Create real v6-shaped authorities plus a synthetic Temporal pair."""
    job_url = "https://example.com/jobs/reference"
    conn = init_db(db_path)
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, company, site, discovered_at, fit_score,
            score_reasoning, scored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            "Reference Engineer",
            "Example Corp",
            "Synthetic",
            "2026-07-01T10:00:00+00:00",
            8,
            "Synthetic reference score",
            "2026-07-01T10:05:00+00:00",
        ),
    )
    job_id = str(
        conn.execute(
            "SELECT job_id FROM jobs WHERE url = ?",
            (job_url,),
        ).fetchone()[0]
    )
    database_module.ensure_source_observation_tables(conn)
    conn.execute(
        """
        INSERT INTO job_stage_states (
            job_url, stage, state, attempt_count, updated_at,
            metadata_json, version
        ) VALUES (?, 'score', 'succeeded', 1, ?, '{"fixture":true}', 3)
        """,
        (job_url, "2026-07-01T10:06:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            job_url, stage, event_type, level, message, occurred_at,
            payload_json, idempotency_key
        ) VALUES (?, 'score', 'ScoreCompleted', 'info', ?, ?, ?, ?)
        """,
        (
            job_url,
            "Synthetic score completed",
            "2026-07-01T10:06:00+00:00",
            '{"score":8}',
            "fixture-score-completed",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at, criteria_json, trace_json
        ) VALUES (?, 1, 'local', 8, ?, ?, ?, ?, ?)
        """,
        (
            job_url,
            '{"technical_fit":8}',
            '["python","sqlite"]',
            "2026-07-01T10:05:00+00:00",
            '{"policy":"fixture"}',
            '{"trace_id":"synthetic"}',
        ),
    )
    conn.execute(
        """
        INSERT INTO job_artifacts (
            job_url, stage, artifact_type, status, path, created_at,
            size_bytes, metadata_json
        ) VALUES (?, 'tailor', 'resume_pdf', 'accepted', ?, ?, 1024, ?)
        """,
        (
            job_url,
            "artifacts/synthetic-resume.pdf",
            "2026-07-01T10:10:00+00:00",
            '{"fixture":true}',
        ),
    )
    conn.execute(
        """
        INSERT INTO discovery_execution_jobs (
            tenant_id, discover_workflow_id, discover_run_id, job_id,
            cohort_kind, source_family, preparation_workflow_id,
            work_plan_state, required_steps_json, linked_at
        ) VALUES (
            'local', 'discover-fixture', 'run-fixture', ?,
            'observed_this_run', 'synthetic', 'prepare-fixture',
            'planned', '["enrich","score"]', ?
        )
        """,
        (job_id, "2026-07-01T10:01:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO workflow_run_projections (
            workflow_id, tenant_id, workflow_type, status,
            input_summary_json, started_at, temporal_run_id, events_json
        ) VALUES (
            'prepare-fixture', 'local', 'JobPreparation', 'completed',
            ?, ?, 'temporal-run-fixture', ?
        )
        """,
        (
            f'{{"jobUrl":"{job_url}"}}',
            "2026-07-01T10:02:00+00:00",
            '[{"eventType":"WorkflowCompleted"}]',
        ),
    )
    from jobctrl.infrastructure.gmail.feedback import (
        ensure_application_feedback_tables,
    )

    ensure_application_feedback_tables(conn)
    conn.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_key, kind, source, note,
            occurred_at, recorded_at, created_by
        ) VALUES (
            'local', 'outcome-fixture', ?, 'interview', 'user',
            'Synthetic outcome', ?, ?, 'user'
        )
        """,
        (
            job_url,
            "2026-07-02T10:00:00+00:00",
            "2026-07-02T10:01:00+00:00",
        ),
    )
    conn.commit()
    close_connection(db_path)

    raw = sqlite3.connect(db_path)
    try:
        source_rows = raw.execute(
            """
            SELECT
                o.tenant_id, o.source_observation_id, j.url,
                o.source_id, o.source_native_id, o.observed_url,
                o.normalized_observed_url, o.run_id, o.observed_at
            FROM job_source_observations o
            JOIN jobs j
              ON j.tenant_id = o.tenant_id
             AND j.job_id = o.job_id
            """
        ).fetchall()
        execution_rows = raw.execute(
            """
            SELECT
                execution.tenant_id,
                execution.discover_workflow_id,
                execution.discover_run_id,
                jobs.url,
                execution.cohort_kind,
                execution.source_family,
                execution.source_run_id,
                execution.preparation_workflow_id,
                execution.work_plan_state,
                execution.required_steps_json,
                execution.work_plan_reason,
                execution.linked_at
            FROM discovery_execution_jobs AS execution
            JOIN jobs
              ON jobs.tenant_id = execution.tenant_id
             AND jobs.job_id = execution.job_id
            """
        ).fetchall()
        raw.execute("DROP TABLE discovery_execution_jobs")
        raw.execute("DROP TABLE discovery_search_unit_jobs")
        raw.executescript(
            """
            CREATE TABLE discovery_execution_jobs (
                tenant_id                TEXT NOT NULL,
                discover_workflow_id     TEXT NOT NULL,
                discover_run_id          TEXT NOT NULL,
                job_url                  TEXT NOT NULL,
                cohort_kind              TEXT NOT NULL,
                source_family            TEXT,
                source_run_id            TEXT,
                preparation_workflow_id  TEXT,
                work_plan_state          TEXT NOT NULL DEFAULT 'pending',
                required_steps_json      TEXT,
                work_plan_reason         TEXT,
                linked_at                TEXT NOT NULL,
                PRIMARY KEY (
                    tenant_id, discover_workflow_id, discover_run_id, job_url
                ),
                FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
            );
            CREATE TABLE discovery_search_unit_jobs (
                tenant_id              TEXT NOT NULL,
                discover_workflow_id   TEXT NOT NULL,
                discover_run_id        TEXT NOT NULL,
                unit_id                TEXT NOT NULL,
                job_url                TEXT NOT NULL,
                was_new                INTEGER NOT NULL,
                accepted_at            TEXT NOT NULL,
                PRIMARY KEY (
                    tenant_id, discover_workflow_id, discover_run_id,
                    unit_id, job_url
                ),
                FOREIGN KEY (
                    tenant_id, discover_workflow_id, discover_run_id, unit_id
                ) REFERENCES discovery_search_units(
                    tenant_id, discover_workflow_id, discover_run_id, unit_id
                ) ON DELETE CASCADE,
                FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
            );
            """
        )
        raw.executemany(
            """
            INSERT INTO discovery_execution_jobs (
                tenant_id, discover_workflow_id, discover_run_id, job_url,
                cohort_kind, source_family, source_run_id,
                preparation_workflow_id, work_plan_state,
                required_steps_json, work_plan_reason, linked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            execution_rows,
        )
        for table in (
            "job_rejected_duplicate_links",
            "job_duplicate_links",
            "job_canonical_identities",
            "job_source_observations",
        ):
            raw.execute(f'DROP TABLE "{table}"')
        raw.executescript(
            """
            CREATE TABLE job_source_observations (
                tenant_id                TEXT NOT NULL DEFAULT 'local',
                source_observation_id    TEXT NOT NULL,
                job_url                  TEXT NOT NULL,
                source_id                TEXT NOT NULL,
                source_native_id         TEXT NOT NULL,
                observed_url             TEXT NOT NULL,
                normalized_observed_url  TEXT NOT NULL,
                run_id                   TEXT NOT NULL DEFAULT '',
                observed_at              TEXT NOT NULL,
                PRIMARY KEY (tenant_id, source_observation_id),
                FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
            );
            CREATE TABLE job_canonical_identities (
                tenant_id          TEXT NOT NULL DEFAULT 'local',
                job_url            TEXT NOT NULL,
                canonical_url      TEXT NOT NULL,
                ats_kind           TEXT NOT NULL,
                source_native_id   TEXT NOT NULL,
                confidence         REAL NOT NULL,
                resolved_at        TEXT NOT NULL,
                PRIMARY KEY (tenant_id, job_url),
                FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
            );
            CREATE TABLE job_duplicate_links (
                tenant_id                        TEXT NOT NULL DEFAULT 'local',
                duplicate_link_id                TEXT NOT NULL,
                surviving_job_id                 TEXT NOT NULL,
                superseded_job_or_observation_id TEXT NOT NULL,
                reason                           TEXT NOT NULL,
                confidence                       REAL NOT NULL,
                linked_at                        TEXT NOT NULL,
                PRIMARY KEY (tenant_id, duplicate_link_id)
            );
            CREATE TABLE job_rejected_duplicate_links (
                tenant_id     TEXT NOT NULL DEFAULT 'local',
                owner_job_url TEXT NOT NULL,
                candidate_url TEXT NOT NULL,
                reason        TEXT NOT NULL,
                rejected_at   TEXT NOT NULL,
                PRIMARY KEY (tenant_id, owner_job_url, candidate_url)
            );
            """
        )
        raw.executemany(
            """
            INSERT INTO job_source_observations (
                tenant_id, source_observation_id, job_url, source_id,
                source_native_id, observed_url, normalized_observed_url,
                run_id, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            source_rows,
        )
        for trigger_name in database_module._STABLE_JOB_IDENTITY_TRIGGER_NAMES:
            raw.execute(f'DROP TRIGGER IF EXISTS "{trigger_name}"')
        raw.execute("DROP INDEX IF EXISTS idx_jobs_tenant_job_id")
        raw.execute("DROP TABLE job_identity_aliases")
        raw.execute("ALTER TABLE jobs DROP COLUMN job_id")
        raw.execute("ALTER TABLE jobs DROP COLUMN tenant_id")
        raw.execute(f"PRAGMA user_version = {LEGACY_SCHEMA_VERSION}")
        raw.commit()
    finally:
        raw.close()

    temporal = sqlite3.connect(temporal_path)
    try:
        temporal.execute(
            """
            CREATE TABLE workflow_history_marker (
                workflow_id TEXT PRIMARY KEY,
                job_url TEXT NOT NULL,
                status TEXT NOT NULL
            )
            """
        )
        temporal.execute(
            """
            INSERT INTO workflow_history_marker (workflow_id, job_url, status)
            VALUES ('prepare-fixture', ?, 'completed')
            """,
            (job_url,),
        )
        temporal.commit()
    finally:
        temporal.close()
    return job_url


def _reference_snapshot(db_path: Path) -> dict[str, list[tuple[object, ...]]]:
    conn = sqlite3.connect(db_path)
    try:
        snapshot = {
            table: [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()]
            for table in REFERENCE_TABLES
        }
        execution_columns = {
            str(row[1]) for row in conn.execute("PRAGMA table_info(discovery_execution_jobs)").fetchall()
        }
        if "job_id" in execution_columns:
            snapshot["discovery_execution_jobs"] = [
                tuple(row)
                for row in conn.execute(
                    """
                    SELECT
                        execution.tenant_id,
                        execution.discover_workflow_id,
                        execution.discover_run_id,
                        jobs.url,
                        execution.cohort_kind,
                        execution.source_family,
                        execution.source_run_id,
                        execution.preparation_workflow_id,
                        execution.work_plan_state,
                        execution.required_steps_json,
                        execution.work_plan_reason,
                        execution.linked_at
                    FROM discovery_execution_jobs AS execution
                    JOIN jobs
                      ON jobs.tenant_id = execution.tenant_id
                     AND jobs.job_id = execution.job_id
                    ORDER BY execution.rowid
                    """
                ).fetchall()
            ]
        snapshot["jobs"] = [
            tuple(row)
            for row in conn.execute(
                """
                SELECT
                    url, title, company, site, discovered_at,
                    fit_score, score_reasoning, scored_at
                FROM jobs
                ORDER BY url
                """
            ).fetchall()
        ]
        return snapshot
    finally:
        conn.close()


def test_v6_jobs_gain_stable_uuid_and_posting_url_alias_once(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    _create_legacy_database(
        db_path,
        jobs=(
            (
                "https://example.com/jobs/alpha",
                "Platform Engineer",
                "2026-07-01T10:00:00+00:00",
            ),
            (
                "https://example.com/jobs/beta",
                "Staff Engineer",
                "2026-07-02T10:00:00+00:00",
            ),
        ),
    )

    init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == SCHEMA_VERSION == 9
    first_ids = _identity_rows(db_path)
    assert [row[0] for row in first_ids] == ["local", "local"]
    for _tenant_id, job_id, _url in first_ids:
        parsed = uuid.UUID(job_id)
        assert str(parsed) == job_id
        assert parsed.version == 4

    check = sqlite3.connect(db_path)
    try:
        aliases = check.execute(
            """
            SELECT tenant_id, alias_kind, alias_value, job_id
            FROM job_identity_aliases
            ORDER BY alias_value
            """
        ).fetchall()
    finally:
        check.close()
    assert aliases == [
        ("local", "posting_url", first_ids[0][2], first_ids[0][1]),
        ("local", "posting_url", first_ids[1][2], first_ids[1][1]),
    ]

    init_db(db_path)
    close_connection(db_path)
    assert _identity_rows(db_path) == first_ids


def test_missing_versioned_migration_fails_before_schema_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    _create_legacy_database(db_path)
    monkeypatch.setattr(database_module, "_schema_migrations", lambda: ())

    with pytest.raises(RuntimeError, match="no schema migration path"):
        init_db(db_path)
    close_connection(db_path)

    check = sqlite3.connect(db_path)
    try:
        assert _user_version(db_path) == LEGACY_SCHEMA_VERSION
        columns = {
            str(row[1])
            for row in check.execute("PRAGMA table_info(jobs)").fetchall()
        }
        assert "tenant_id" not in columns
        assert "job_id" not in columns
    finally:
        check.close()


def test_legacy_insert_gets_uuid_and_alias_without_changing_insert_shape(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    url = "https://example.com/jobs/legacy-insert"

    conn.execute(
        "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
        (url, "Legacy writer", "2026-07-03T10:00:00+00:00"),
    )
    conn.commit()

    row = conn.execute(
        "SELECT tenant_id, job_id FROM jobs WHERE url = ?",
        (url,),
    ).fetchone()
    assert row is not None
    assert row["tenant_id"] == "local"
    parsed = uuid.UUID(row["job_id"])
    assert str(parsed) == row["job_id"]
    assert parsed.version == 4
    alias = conn.execute(
        """
        SELECT job_id
        FROM job_identity_aliases
        WHERE tenant_id = 'local'
          AND alias_kind = 'posting_url'
          AND alias_value = ?
        """,
        (url,),
    ).fetchone()
    assert alias is not None and alias["job_id"] == row["job_id"]


def test_explicit_malformed_job_id_is_rejected(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)

    with pytest.raises(sqlite3.IntegrityError, match="canonical UUID"):
        conn.execute(
            "INSERT INTO jobs (url, job_id) VALUES (?, ?)",
            (
                "https://example.com/jobs/invalid-id",
                "12345678-1234-1234-1234-123456789ab-",
            ),
        )

    assert (
        conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE url = ?",
            ("https://example.com/jobs/invalid-id",),
        ).fetchone()[0]
        == 0
    )


def test_assigned_job_identity_is_immutable_and_url_history_is_retained(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    old_url = "https://example.com/jobs/original"
    new_url = "https://careers.example.com/jobs/canonical"
    conn.execute("INSERT INTO jobs (url, title) VALUES (?, ?)", (old_url, "Engineer"))
    conn.commit()
    job_id = str(
        conn.execute(
            "SELECT job_id FROM jobs WHERE url = ?",
            (old_url,),
        ).fetchone()[0]
    )

    with pytest.raises(sqlite3.IntegrityError, match="job_id is immutable"):
        conn.execute(
            "UPDATE jobs SET job_id = ? WHERE url = ?",
            (str(uuid.uuid4()), old_url),
        )
    with pytest.raises(sqlite3.IntegrityError, match="job_id is immutable"):
        conn.execute(
            "UPDATE jobs SET job_id = upper(job_id) WHERE url = ?",
            (old_url,),
        )
    with pytest.raises(sqlite3.IntegrityError, match="tenant_id is immutable"):
        conn.execute(
            "UPDATE jobs SET tenant_id = ' local ' WHERE url = ?",
            (old_url,),
        )

    conn.execute("UPDATE jobs SET url = ? WHERE url = ?", (new_url, old_url))
    conn.commit()
    aliases = conn.execute(
        """
        SELECT alias_value
        FROM job_identity_aliases
        WHERE tenant_id = 'local' AND job_id = ?
        ORDER BY alias_value
        """,
        (job_id,),
    ).fetchall()
    assert [str(row[0]) for row in aliases] == sorted([old_url, new_url])
    active_aliases = conn.execute(
        """
        SELECT COUNT(*)
        FROM job_identity_aliases a
        JOIN jobs j
          ON j.tenant_id = a.tenant_id
         AND j.job_id = a.job_id
        WHERE a.retired_at IS NULL
        """
    ).fetchone()[0]
    assert active_aliases == 2


def test_production_url_collision_cleans_aliases_and_allows_rediscovery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.enrichment import detail

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    canonical_url = "https://example.com/jobs/collision"
    relative_url = "/jobs/collision"
    conn.executemany(
        "INSERT INTO jobs (url, title, site) VALUES (?, ?, ?)",
        (
            (canonical_url, "Canonical", "Synthetic"),
            (relative_url, "Relative duplicate", "Synthetic"),
        ),
    )
    job_ids = {
        str(row["url"]): str(row["job_id"])
        for row in conn.execute(
            "SELECT url, job_id FROM jobs WHERE url IN (?, ?)",
            (canonical_url, relative_url),
        ).fetchall()
    }
    surviving_job_id = job_ids[canonical_url]
    losing_job_id = job_ids[relative_url]
    conn.execute(
        """
        INSERT INTO job_source_observations (
            tenant_id, source_observation_id, job_id, source_id,
            source_native_id, observed_url, normalized_observed_url,
            run_id, observed_at
        ) VALUES (
            'local', 'obs-relative', ?, 'synthetic', 'relative',
            ?, ?, 'discover-run', '2026-07-29T10:00:00+00:00'
        )
        """,
        (losing_job_id, relative_url, relative_url),
    )
    conn.executemany(
        """
        INSERT INTO job_canonical_identities (
            tenant_id, job_id, canonical_url, ats_kind, source_native_id,
            confidence, resolved_at
        ) VALUES ('local', ?, ?, 'synthetic', ?, ?, ?)
        """,
        (
            (
                surviving_job_id,
                canonical_url,
                "canonical",
                1.0,
                "2026-07-29T10:00:00+00:00",
            ),
            (
                losing_job_id,
                relative_url,
                "relative",
                0.5,
                "2026-07-29T09:00:00+00:00",
            ),
        ),
    )
    conn.execute(
        """
        INSERT INTO job_duplicate_links (
            tenant_id, duplicate_link_id, surviving_job_id,
            superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES (
            'local', 'dup-relative', ?, 'obs-superseded',
            'canonical_url_match', 0.9, '2026-07-29T10:00:00+00:00'
        )
        """,
        (losing_job_id,),
    )
    conn.executemany(
        """
        INSERT INTO job_rejected_duplicate_links (
            tenant_id, owner_job_id, candidate_url, reason, rejected_at
        ) VALUES (
            'local', ?, 'https://example.com/jobs/candidate',
            'employer_mismatch', '2026-07-29T10:00:00+00:00'
        )
        """,
        ((surviving_job_id,), (losing_job_id,)),
    )
    conn.execute(
        """
        INSERT INTO discovery_search_units (
            tenant_id, discover_workflow_id, discover_run_id, unit_id,
            ordinal, request_json, request_fingerprint, state,
            created_at, updated_at
        ) VALUES (
            'local', 'discover-local', 'discover-run', 'unit-1',
            0, '{}', 'collision-fixture', 'completed',
            '2026-07-29T09:00:00+00:00',
            '2026-07-29T10:00:00+00:00'
        )
        """
    )
    conn.executemany(
        """
        INSERT INTO discovery_execution_jobs (
            tenant_id, discover_workflow_id, discover_run_id, job_id,
            cohort_kind, source_family, source_run_id,
            preparation_workflow_id, work_plan_state,
            required_steps_json, work_plan_reason, linked_at
        ) VALUES (
            'local', 'discover-local', 'discover-run', ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        (
            (
                surviving_job_id,
                "existing_backlog",
                None,
                None,
                None,
                "pending",
                None,
                None,
                "2026-07-29T10:05:00+00:00",
            ),
            (
                losing_job_id,
                "observed_this_run",
                "synthetic",
                "source-run-relative",
                "prepare-relative",
                "planned",
                '["score","tailor"]',
                "selected_for_preparation",
                "2026-07-29T10:00:00+00:00",
            ),
        ),
    )
    conn.executemany(
        """
        INSERT INTO discovery_search_unit_jobs (
            tenant_id, discover_workflow_id, discover_run_id,
            unit_id, job_id, was_new, accepted_at
        ) VALUES (
            'local', 'discover-local', 'discover-run', 'unit-1', ?, ?, ?
        )
        """,
        (
            (surviving_job_id, 0, "2026-07-29T10:04:00+00:00"),
            (losing_job_id, 1, "2026-07-29T10:01:00+00:00"),
        ),
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
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute(
        """
        SELECT job_id
        FROM job_source_observations
        WHERE source_observation_id = 'obs-relative'
        """
    ).fetchone()[0] == surviving_job_id
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT job_id, canonical_url
            FROM job_canonical_identities
            """
        ).fetchall()
    ] == [(surviving_job_id, canonical_url)]
    assert conn.execute(
        """
        SELECT surviving_job_id
        FROM job_duplicate_links
        WHERE duplicate_link_id = 'dup-relative'
        """
    ).fetchone()[0] == surviving_job_id
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT owner_job_id
            FROM job_rejected_duplicate_links
            """
        ).fetchall()
    ] == [(surviving_job_id,)]
    assert tuple(
        conn.execute(
            """
            SELECT job_id, cohort_kind, source_family, source_run_id,
                   preparation_workflow_id, work_plan_state,
                   required_steps_json, work_plan_reason, linked_at
            FROM discovery_execution_jobs
            """
        ).fetchone()
    ) == (
        surviving_job_id,
        "observed_this_run",
        "synthetic",
        "source-run-relative",
        "prepare-relative",
        "planned",
        '["score","tailor"]',
        "selected_for_preparation",
        "2026-07-29T10:00:00+00:00",
    )
    assert tuple(
        conn.execute(
            """
            SELECT job_id, was_new, accepted_at
            FROM discovery_search_unit_jobs
            """
        ).fetchone()
    ) == (
        surviving_job_id,
        1,
        "2026-07-29T10:01:00+00:00",
    )
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    active_orphans = conn.execute(
        """
        SELECT COUNT(*)
        FROM job_identity_aliases a
        LEFT JOIN jobs j
          ON j.tenant_id = a.tenant_id
         AND j.job_id = a.job_id
        WHERE a.retired_at IS NULL
          AND j.job_id IS NULL
        """
    ).fetchone()[0]
    assert active_orphans == 0
    removed = conn.execute(
        """
        SELECT job_id
        FROM job_identity_aliases
        WHERE alias_value = ?
        """,
        (relative_url,),
    ).fetchone()
    assert removed is None

    conn.execute(
        "INSERT INTO jobs (url, title, site) VALUES (?, ?, ?)",
        (relative_url, "Rediscovered duplicate", "Synthetic"),
    )
    conn.commit()
    rediscovered = conn.execute(
        """
        SELECT j.job_id, a.job_id
        FROM jobs j
        JOIN job_identity_aliases a
          ON a.tenant_id = j.tenant_id
         AND a.job_id = j.job_id
         AND a.alias_kind = 'posting_url'
         AND a.alias_value = j.url
        WHERE j.url = ?
        """,
        (relative_url,),
    ).fetchone()
    assert rediscovered is not None
    assert rediscovered[0] == rediscovered[1]


def test_failed_alias_backfill_keeps_v6_retryable(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    url = "https://example.com/jobs/conflict"
    _create_legacy_database(
        db_path,
        jobs=((url, "Engineer", "2026-07-01T10:00:00+00:00"),),
    )
    raw = sqlite3.connect(db_path)
    try:
        raw.execute(
            """
            CREATE TABLE job_identity_aliases (
                tenant_id   TEXT NOT NULL,
                alias_kind  TEXT NOT NULL,
                alias_value TEXT NOT NULL,
                job_id      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                retired_at  TEXT,
                PRIMARY KEY (tenant_id, alias_kind, alias_value)
            )
            """
        )
        raw.execute(
            """
            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at
            ) VALUES ('local', 'posting_url', ?, ?, ?)
            """,
            (
                url,
                str(uuid.uuid4()),
                "2026-07-01T10:00:00+00:00",
            ),
        )
        raw.commit()
    finally:
        raw.close()

    with pytest.raises(RuntimeError, match="alias owned by a different job"):
        init_db(db_path)
    close_connection(db_path)

    assert _user_version(db_path) == LEGACY_SCHEMA_VERSION
    check = sqlite3.connect(db_path)
    try:
        columns = {
            str(row[1])
            for row in check.execute("PRAGMA table_info(jobs)").fetchall()
        }
        assert "tenant_id" not in columns
        assert "job_id" not in columns
        check.execute("DELETE FROM job_identity_aliases")
        check.commit()
    finally:
        check.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    assert str(uuid.UUID(_identity_rows(db_path)[0][1])) == _identity_rows(db_path)[0][1]


def test_foreign_key_failure_does_not_stamp_or_leave_identity_columns(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    _create_legacy_database(
        db_path,
        jobs=(
            (
                "https://example.com/jobs/valid",
                "Engineer",
                "2026-07-01T10:00:00+00:00",
            ),
        ),
    )
    raw = sqlite3.connect(db_path)
    try:
        raw.execute(
            """
            CREATE TABLE migration_probe (
                job_url TEXT NOT NULL REFERENCES jobs(url)
            )
            """
        )
        raw.execute(
            "INSERT INTO migration_probe (job_url) VALUES (?)",
            ("https://example.com/jobs/orphan",),
        )
        raw.commit()
    finally:
        raw.close()

    with pytest.raises(RuntimeError, match="foreign-key violation"):
        init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == LEGACY_SCHEMA_VERSION

    check = sqlite3.connect(db_path)
    try:
        columns = {
            str(row[1])
            for row in check.execute("PRAGMA table_info(jobs)").fetchall()
        }
        assert "tenant_id" not in columns
        assert "job_id" not in columns
        check.execute("DELETE FROM migration_probe")
        check.commit()
    finally:
        check.close()

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION


def test_forward_reopen_retains_ids_and_previous_release_uses_snapshot(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    pre_upgrade = tmp_path / "jobctrl-v6.db"
    _create_legacy_database(
        db_path,
        jobs=(
            (
                "https://example.com/jobs/rollback",
                "Engineer",
                "2026-07-01T10:00:00+00:00",
            ),
        ),
    )
    shutil.copy2(db_path, pre_upgrade)

    init_db(db_path)
    close_connection(db_path)
    migrated_ids = _identity_rows(db_path)
    init_db(db_path)
    close_connection(db_path)
    assert _identity_rows(db_path) == migrated_ids

    migrated = sqlite3.connect(db_path)
    try:
        with pytest.raises(IncompatibleSchemaVersionError):
            _assert_schema_version_supported(
                migrated,
                supported_version=LEGACY_SCHEMA_VERSION,
            )
    finally:
        migrated.close()

    snapshot = sqlite3.connect(pre_upgrade)
    try:
        assert (
            _assert_schema_version_supported(
                snapshot,
                supported_version=LEGACY_SCHEMA_VERSION,
            )
            == LEGACY_SCHEMA_VERSION
        )
        columns = {
            str(row[1])
            for row in snapshot.execute("PRAGMA table_info(jobs)").fetchall()
        }
        assert "job_id" not in columns
    finally:
        snapshot.close()


def test_representative_v6_references_and_paired_snapshot_restore(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    temporal_path = tmp_path / "temporal.db"
    job_url = _create_representative_v6_pair(db_path, temporal_path)
    before = _reference_snapshot(db_path)
    assert all(before[table] for table in (*REFERENCE_TABLES, "jobs"))

    pre_upgrade = tmp_path / "pre-upgrade"
    pre_upgrade.mkdir()
    db_snapshot = pre_upgrade / "jobctrl.db"
    temporal_snapshot = pre_upgrade / "temporal.db"
    shutil.copy2(db_path, db_snapshot)
    shutil.copy2(temporal_path, temporal_snapshot)

    init_db(db_path)
    close_connection(db_path)
    assert _user_version(db_path) == SCHEMA_VERSION
    assert _reference_snapshot(db_path) == before
    identities = _identity_rows(db_path)
    assert len(identities) == 1
    assert identities[0][0] == "local"
    assert identities[0][2] == job_url
    assert uuid.UUID(identities[0][1]).version == 4

    temporal = sqlite3.connect(temporal_path)
    try:
        temporal.execute(
            """
            UPDATE workflow_history_marker
            SET status = 'post-upgrade-write'
            WHERE workflow_id = 'prepare-fixture'
            """
        )
        temporal.commit()
    finally:
        temporal.close()

    restored = tmp_path / "restored-pair"
    restored.mkdir()
    restored_db = restored / "jobctrl.db"
    restored_temporal = restored / "temporal.db"
    shutil.copy2(db_snapshot, restored_db)
    shutil.copy2(temporal_snapshot, restored_temporal)

    previous = sqlite3.connect(restored_db)
    try:
        assert (
            _assert_schema_version_supported(
                previous,
                supported_version=LEGACY_SCHEMA_VERSION,
            )
            == LEGACY_SCHEMA_VERSION
        )
        columns = {
            str(row[1])
            for row in previous.execute("PRAGMA table_info(jobs)").fetchall()
        }
        assert "job_id" not in columns
        assert "tenant_id" not in columns
    finally:
        previous.close()
    assert _reference_snapshot(restored_db) == before

    restored_history = sqlite3.connect(restored_temporal)
    try:
        marker = restored_history.execute(
            """
            SELECT workflow_id, job_url, status
            FROM workflow_history_marker
            """
        ).fetchone()
    finally:
        restored_history.close()
    assert marker == ("prepare-fixture", job_url, "completed")


def _user_version(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()
