from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    EXACT_V8_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v7_to_v8_execute import (
    CandidateExecutionError,
    execute_v7_to_v8_candidate,
    main,
)


def test_executor_builds_verified_v8_candidate_without_mutating_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    _create_v7_source(source)
    source_before = _sha256(source)

    result = execute_v7_to_v8_candidate(source, candidate)

    assert result.schema_version == 1
    assert result.status == "ready"
    assert result.user_version == 8
    assert result.source_data_digest == result.candidate_data_digest
    assert result.candidate_sha256 == _sha256(candidate)
    assert result.job_count == 1
    assert result.table_count == EXACT_V8_MANIFEST.table_count
    assert _sha256(source) == source_before

    source_conn = sqlite3.connect(source)
    candidate_conn = sqlite3.connect(candidate)
    try:
        assert source_conn.execute("PRAGMA user_version").fetchone() == (7,)
        assert_exact_manifest(source_conn, EXACT_V7_MANIFEST)
        assert candidate_conn.execute("PRAGMA user_version").fetchone() == (8,)
        assert_exact_manifest(candidate_conn, EXACT_V8_MANIFEST)
        assert candidate_conn.execute("SELECT title FROM jobs").fetchone() == (
            "Senior Platform Engineer",
        )
        assert candidate_conn.execute(
            "SELECT COUNT(*) FROM compensation_direct_benchmark_facts"
        ).fetchone() == (0,)
        assert candidate_conn.execute(
            "SELECT COUNT(*) FROM compensation_role_families"
        ).fetchone()[0] > 0
    finally:
        source_conn.close()
        candidate_conn.close()


def test_executor_failure_removes_only_created_candidate_and_preserves_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    _create_v7_source(source)
    before = _sha256(source)

    with pytest.raises(CandidateExecutionError, match="candidate migration failed"):
        execute_v7_to_v8_candidate(
            source,
            candidate,
            _after_stamp=lambda: (_ for _ in ()).throw(RuntimeError("synthetic")),
        )

    assert _sha256(source) == before
    assert not candidate.exists()
    assert not Path(f"{candidate}-wal").exists()
    assert not Path(f"{candidate}-shm").exists()


def test_executor_rejects_existing_candidate_without_changing_it(tmp_path: Path) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    _create_v7_source(source)
    candidate.write_bytes(b"owned fixture")

    with pytest.raises(CandidateExecutionError, match="candidate migration failed"):
        execute_v7_to_v8_candidate(source, candidate)

    assert candidate.read_bytes() == b"owned fixture"


def test_private_cli_returns_bounded_receipt_and_generic_failure(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    _create_v7_source(source)

    assert main(["--source", str(source), "--candidate", str(candidate)]) == 0
    receipt = json.loads(capsys.readouterr().out)
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

    missing = tmp_path / "missing.db"
    assert main(["--source", str(missing), "--candidate", str(tmp_path / "failed.db")]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "v7-to-v8 candidate migration failed\n"
    assert str(missing) not in captured.err


def _create_v7_source(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        create_exact_v7_schema(conn)
        conn.execute(
            """
            INSERT INTO jobs (tenant_id, job_id, url, title, company, location)
            VALUES ('local', '11111111-1111-4111-8111-111111111111',
                    'https://jobs.example/1', 'Senior Platform Engineer', 'Acme', 'Spain')
            """
        )
        conn.commit()
    finally:
        conn.close()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
