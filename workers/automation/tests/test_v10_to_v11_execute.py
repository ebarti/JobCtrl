from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V10_MANIFEST,
    EXACT_V11_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v10 import create_exact_v10_schema
from jobctrl.infrastructure.migrations.v10_to_v11_execute import (
    CandidateExecutionError,
    execute_v10_to_v11_candidate,
    main,
)


def _source(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        create_exact_v10_schema(conn)
        conn.executemany(
            "INSERT INTO llm_spend(day,input_tokens,output_tokens,estimated_usd) VALUES(?,?,?,?)",
            [
                ("2026-09-20", 10, 3, 0.5),
                ("2026-09-21", 20, 7, 1.25),
            ],
        )


def test_candidate_preserves_v10_global_totals_in_legacy_lane(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()

    result = execute_v10_to_v11_candidate(source, candidate)

    assert source.read_bytes() == before
    assert result.user_version == 11 and result.status == "ready"
    assert result.candidate_sha256 == hashlib.sha256(candidate.read_bytes()).hexdigest()
    with sqlite3.connect(source) as old, sqlite3.connect(candidate) as new:
        assert_exact_manifest(old, EXACT_V10_MANIFEST)
        assert_exact_manifest(new, EXACT_V11_MANIFEST)
        assert new.execute(
            "SELECT day,lane,input_tokens,output_tokens,estimated_usd "
            "FROM llm_spend ORDER BY day"
        ).fetchall() == [
            ("2026-09-20", "legacy", 10, 3, 0.5),
            ("2026-09-21", "legacy", 20, 7, 1.25),
        ]
        assert new.execute(
            "SELECT SUM(input_tokens),SUM(output_tokens),SUM(estimated_usd) FROM llm_spend"
        ).fetchone() == (30, 10, 1.75)


def test_failed_candidate_is_removed_and_source_is_unchanged(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()

    def corrupt() -> None:
        with sqlite3.connect(candidate) as conn:
            conn.execute("UPDATE llm_spend SET input_tokens=999")

    with pytest.raises(CandidateExecutionError, match="v10-to-v11 candidate migration failed"):
        execute_v10_to_v11_candidate(source, candidate, _after_stamp=corrupt)

    assert source.read_bytes() == before
    assert not candidate.exists()


def test_wrong_frozen_source_manifest_is_rejected_without_candidate(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    with sqlite3.connect(source) as conn:
        conn.execute("CREATE TABLE unexpected(value TEXT)")
    before = source.read_bytes()

    with pytest.raises(CandidateExecutionError, match="v10-to-v11 candidate migration failed"):
        execute_v10_to_v11_candidate(source, candidate)

    assert source.read_bytes() == before
    assert not candidate.exists()


def test_private_cli_returns_bounded_receipt(tmp_path: Path, capsys) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)

    assert main(["--source", str(source), "--candidate", str(candidate)]) == 0
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["user_version"] == 11
    assert receipt["table_count"] == EXACT_V11_MANIFEST.table_count
