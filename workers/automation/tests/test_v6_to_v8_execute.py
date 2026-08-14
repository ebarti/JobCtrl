from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V8_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v8_execute import (
    CandidateExecutionError,
    execute_v6_to_v8_candidate,
    main,
)
from tests.v6_migration_fixture import create_shipped_v6_database

_MIGRATION_AT = "2026-08-11T12:00:00+00:00"
_JOB_ID = "00000000-0000-4000-8000-000000000061"


def _allocator(*values: str) -> Callable[[], str]:
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_executor_builds_exact_v8_from_v6_without_leaking_intermediate(
    tmp_path: Path,
) -> None:
    source = tmp_path / "paired-backup-jobctrl.db"
    candidate = tmp_path / "jobctrl.db.v8-candidate"
    create_shipped_v6_database(source)
    source_before = source.read_bytes()

    result = execute_v6_to_v8_candidate(
        source,
        candidate,
        migration_at=_MIGRATION_AT,
        job_id_factory=_allocator(_JOB_ID),
    )

    assert source.read_bytes() == source_before
    assert candidate.stat().st_mode & 0o777 == 0o600
    assert result.schema_version == 1
    assert result.status == "ready"
    assert result.user_version == 8
    assert result.source_data_digest == result.candidate_data_digest
    assert result.candidate_sha256 == _sha256(candidate)
    assert result.job_count == 1
    assert result.table_count == EXACT_V8_MANIFEST.table_count
    assert not Path(f"{candidate}.exact-v7-intermediate").exists()

    conn = sqlite3.connect(candidate)
    try:
        assert_exact_manifest(conn, EXACT_V8_MANIFEST)
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT job_id FROM jobs").fetchone() == (_JOB_ID,)
    finally:
        conn.close()


def test_late_failure_preserves_v6_source_and_removes_all_candidates(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    create_shipped_v6_database(source)
    source_before = source.read_bytes()

    with pytest.raises(CandidateExecutionError, match="candidate migration failed"):
        execute_v6_to_v8_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(_JOB_ID),
            _after_v8_stamp=lambda: (_ for _ in ()).throw(
                RuntimeError("private fixture text")
            ),
        )

    assert source.read_bytes() == source_before
    assert not candidate.exists()
    assert not Path(f"{candidate}-wal").exists()
    assert not Path(f"{candidate}-shm").exists()
    assert not Path(f"{candidate}.exact-v7-intermediate").exists()


def test_existing_candidate_is_not_modified(tmp_path: Path) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    create_shipped_v6_database(source)
    candidate.write_bytes(b"owned fixture")

    with pytest.raises(CandidateExecutionError, match="candidate migration failed"):
        execute_v6_to_v8_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(_JOB_ID),
        )

    assert candidate.read_bytes() == b"owned fixture"
    assert not Path(f"{candidate}.exact-v7-intermediate").exists()


def test_private_cli_returns_bounded_receipt_and_sanitized_failure(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    create_shipped_v6_database(source)

    assert main(
        [
            "--source",
            str(source),
            "--candidate",
            str(candidate),
            "--migration-at",
            _MIGRATION_AT,
        ]
    ) == 0
    captured = capsys.readouterr()
    receipt = json.loads(captured.out)
    assert captured.err == ""
    assert set(receipt) == {
        "candidate_data_digest",
        "candidate_sha256",
        "job_count",
        "schema_version",
        "source_data_digest",
        "status",
        "table_count",
        "user_version",
    }
    assert receipt["user_version"] == 8
    assert str(source) not in captured.out
    assert str(candidate) not in captured.out

    missing = tmp_path / "private-missing.db"
    assert main(
        [
            "--source",
            str(missing),
            "--candidate",
            str(tmp_path / "failed.db"),
            "--migration-at",
            _MIGRATION_AT,
        ]
    ) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "v6-to-v8 candidate migration failed\n"
    assert str(missing) not in captured.err
