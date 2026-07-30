"""Focused contracts for direct/scalar v6-to-v7 candidate copying."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    copy_direct_and_scalar_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    V6MigrationPreflightError,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


def _connections(
    tmp_path: Path,
    *,
    history: bool = False,
    hydrate_jobs: bool = True,
) -> tuple[sqlite3.Connection, sqlite3.Connection]:
    source_path = tmp_path / "source.db"
    create = (
        create_supported_upgrade_history_v6_database
        if history
        else create_shipped_v6_database
    )
    create(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")

    candidate = sqlite3.connect(tmp_path / "candidate.db")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    if hydrate_jobs:
        _hydrate_candidate_jobs(source, candidate)
    return source, candidate


def _hydrate_candidate_jobs(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> None:
    source_columns = tuple(
        str(row[1]) for row in source.execute("PRAGMA table_info(jobs)")
    )
    target_columns = tuple(
        str(row[1]) for row in candidate.execute("PRAGMA table_info(jobs)")
    )
    source_rows = source.execute(
        f"SELECT {', '.join(source_columns)} FROM jobs ORDER BY rowid"
    ).fetchall()
    values = []
    for index, row in enumerate(source_rows, start=1):
        source_row = dict(zip(source_columns, row, strict=True))
        values.append(
            tuple(
                (
                    "local"
                    if column == "tenant_id"
                    else f"00000000-0000-4000-8000-{index:012d}"
                    if column == "job_id"
                    else source_row[column]
                )
                for column in target_columns
            )
        )
    quoted = ", ".join(f'"{column}"' for column in target_columns)
    candidate.executemany(
        f"INSERT INTO jobs ({quoted}) "
        f"VALUES ({', '.join('?' for _ in target_columns)})",
        values,
    )


def test_manifest_copy_rewrites_job_ids_and_preserves_locator_urls(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    try:
        job_url = "https://jobs.example/shipped-v6"
        job_id = str(candidate.execute("SELECT job_id FROM jobs").fetchone()[0])
        source.execute(
            """
            INSERT INTO job_canonical_identities (
                tenant_id, job_url, canonical_url, ats_kind, source_native_id,
                confidence, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "local",
                job_url,
                "https://canonical.example/role",
                "generic",
                "source-role-1",
                0.9,
                "2026-07-30T10:00:00+00:00",
            ),
        )
        source.execute(
            """
            INSERT INTO job_enrichments (
                job_url, tenant_id, current_status, full_description,
                application_url, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                job_url,
                "local",
                "ready",
                "The full source description.",
                "https://apply.example/role",
                "2026-07-30T10:01:00+00:00",
            ),
        )
        source.execute(
            """
            INSERT INTO job_artifacts (
                job_url, stage, artifact_type, path, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                job_url,
                "tailor",
                "resume",
                "/tmp/resume.pdf",
                "2026-07-30T10:02:00+00:00",
            ),
        )
        source.execute(
            """
            INSERT INTO source_registry_entries (
                tenant_id, source_id, kind, display_name, policy_id, seed_url,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "local",
                "manual",
                "manual",
                "Manual source",
                "allow",
                "https://source.example/seed",
                "2026-07-30T10:03:00+00:00",
                "2026-07-30T10:03:00+00:00",
            ),
        )

        copied = copy_direct_and_scalar_tables(source, candidate)

        assert "job_events" not in copied
        assert candidate.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
        assert candidate.execute(
            "SELECT tenant_id, job_id, canonical_url FROM job_canonical_identities"
        ).fetchone() == ("local", job_id, "https://canonical.example/role")
        assert candidate.execute(
            "SELECT job_id, application_url FROM job_enrichments"
        ).fetchone() == (job_id, "https://apply.example/role")
        assert candidate.execute(
            "SELECT artifact_id, tenant_id, job_id FROM job_artifacts"
        ).fetchone() == (1, "local", job_id)
        assert candidate.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'job_artifacts'"
        ).fetchone() == (1,)
        assert candidate.execute(
            "SELECT seed_url FROM source_registry_entries"
        ).fetchone() == ("https://source.example/seed",)
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_candidate_copy_rejects_unclassified_source_data_and_rolls_back(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path)
    try:
        source.execute("ALTER TABLE job_enrichments ADD COLUMN drift TEXT")
        with pytest.raises(V6MigrationPreflightError, match="shipped v6"):
            copy_direct_and_scalar_tables(source, candidate)
        assert candidate.execute(
            "SELECT COUNT(*) FROM job_enrichments"
        ).fetchone() == (0,)

        source.execute("CREATE TABLE unclassified_data (value TEXT)")
        with pytest.raises(V6MigrationPreflightError, match="shipped v6"):
            copy_direct_and_scalar_tables(source, candidate)
    finally:
        source.close()
        candidate.close()


def test_candidate_copy_rejects_nonempty_retired_upgrade_history_table(
    tmp_path: Path,
) -> None:
    source, candidate = _connections(tmp_path, history=True)
    try:
        source.execute(
            "INSERT INTO discovery_run_projections (run_id) VALUES ('retired-run')"
        )
        with pytest.raises(CandidateCopyError, match="nonempty retired table"):
            copy_direct_and_scalar_tables(source, candidate)
    finally:
        source.close()
        candidate.close()


def test_candidate_copy_requires_the_same_persisted_job_ids(tmp_path: Path) -> None:
    source, candidate = _connections(tmp_path, hydrate_jobs=False)
    try:
        with pytest.raises(CandidateCopyError, match="hydrated canonical jobs"):
            copy_direct_and_scalar_tables(source, candidate)
    finally:
        source.close()
        candidate.close()
