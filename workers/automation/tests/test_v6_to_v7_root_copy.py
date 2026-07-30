"""Focused contracts for isolated v6-to-v7 root Job copying."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_root import (
    CandidateRootCopyError,
    copy_root_jobs,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)


def _databases(
    tmp_path: Path,
    *,
    history: bool = False,
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
    return source, candidate


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


@pytest.mark.parametrize("history", [False, True])
def test_root_copy_preserves_v6_jobs_and_derives_current_locator(
    tmp_path: Path,
    history: bool,
) -> None:
    source, candidate = _databases(tmp_path, history=history)
    try:
        source_schema = source.execute("PRAGMA schema_version").fetchone()[0]
        source_changes = source.total_changes
        source_dump = tuple(source.iterdump())

        result = copy_root_jobs(
            source,
            candidate,
            job_id_factory=_allocator(
                "00000000-0000-4000-8000-000000000001",
            ),
            migration_at="2026-07-30T10:00:00+00:00",
        )

        assert result.copied_jobs == 1
        assert dict(result.job_ids.by_locator) == {
            (
                "local",
                "https://jobs.example/shipped-v6",
            ): "00000000-0000-4000-8000-000000000001"
        }
        assert candidate.execute(
            "SELECT tenant_id, job_id, url, title FROM jobs"
        ).fetchone() == (
            "local",
            "00000000-0000-4000-8000-000000000001",
            "https://jobs.example/shipped-v6",
            "Shipped V6 fixture",
        )
        assert candidate.execute(
            """
            SELECT tenant_id, job_id, locator_kind, locator_value, is_current,
                   first_seen_at, last_seen_at, retired_at
            FROM job_locators
            """
        ).fetchone() == (
            "local",
            "00000000-0000-4000-8000-000000000001",
            "posting_url",
            "https://jobs.example/shipped-v6",
            1,
            "2026-07-30T09:00:00+00:00",
            "2026-07-30T09:00:00+00:00",
            None,
        )
        assert source.execute("PRAGMA schema_version").fetchone()[0] == source_schema
        assert source.total_changes == source_changes
        assert tuple(source.iterdump()) == source_dump
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_root_copy_rolls_back_duplicate_allocated_ids(tmp_path: Path) -> None:
    source, candidate = _databases(tmp_path)
    try:
        source.execute(
            "INSERT INTO jobs (url, title) VALUES (?, ?)",
            ("https://jobs.example/second", "Second fixture"),
        )
        source.commit()

        with pytest.raises(CandidateRootCopyError, match="duplicate value"):
            copy_root_jobs(
                source,
                candidate,
                job_id_factory=_allocator(
                    "00000000-0000-4000-8000-000000000001",
                    "00000000-0000-4000-8000-000000000001",
                ),
            )

        assert candidate.execute("SELECT COUNT(*) FROM jobs").fetchone() == (0,)
        assert candidate.execute(
            "SELECT COUNT(*) FROM job_locators"
        ).fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


def test_root_copy_rejects_prepopulated_candidate(tmp_path: Path) -> None:
    source, candidate = _databases(tmp_path)
    try:
        candidate.execute(
            """
            INSERT INTO jobs (tenant_id, job_id, url, title)
            VALUES ('local', ?, ?, 'Existing candidate row')
            """,
            (
                "00000000-0000-4000-8000-000000000001",
                "https://jobs.example/existing",
            ),
        )
        candidate.commit()

        with pytest.raises(CandidateRootCopyError, match="must both be empty"):
            copy_root_jobs(source, candidate)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "allocated",
    [
        " 00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001 ",
        "00000000-0000-4000-8000-00000000000A",
    ],
)
def test_root_copy_rejects_noncanonical_allocator_output(
    tmp_path: Path,
    allocated: str,
) -> None:
    source, candidate = _databases(tmp_path)
    try:
        with pytest.raises(CandidateRootCopyError, match="non-canonical UUID"):
            copy_root_jobs(
                source,
                candidate,
                job_id_factory=_allocator(allocated),
            )
        assert candidate.execute("SELECT COUNT(*) FROM jobs").fetchone() == (0,)
    finally:
        source.close()
        candidate.close()
