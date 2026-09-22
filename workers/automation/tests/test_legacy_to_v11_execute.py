from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import legacy_to_v11_execute as migration
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V11_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.migrations.schema_v8 import create_exact_v8_schema
from jobctrl.infrastructure.migrations.schema_v9 import create_exact_v9_schema
from jobctrl.infrastructure.migrations.schema_v10 import create_exact_v10_schema


def _source(path: Path, version: int) -> None:
    with sqlite3.connect(path) as conn:
        (create_exact_v8_schema if version == 8 else create_exact_v9_schema)(conn)
        conn.execute(
            "INSERT INTO jobs(tenant_id,job_id,url,title,application_url) "
            "VALUES('local','j','https://post','Retained','https://apply')"
        )


@pytest.mark.parametrize("version", [8, 9])
def test_legacy_chain_produces_exact_v11_without_intermediates(
    tmp_path: Path,
    version: int,
) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, version)
    before = source.read_bytes()

    result = migration.execute_legacy_to_v11_candidate(
        source,
        candidate,
        source_version=version,
    )

    assert result.user_version == 11
    assert source.read_bytes() == before
    assert sorted(path.name for path in tmp_path.iterdir()) == ["candidate.db", "source.db"]
    with sqlite3.connect(candidate) as conn:
        assert_exact_manifest(conn, EXACT_V11_MANIFEST)
        assert conn.execute("SELECT title FROM jobs").fetchone() == ("Retained",)


def test_downstream_failure_removes_intermediate_and_preserves_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source, 8)
    before = source.read_bytes()

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("synthetic downstream failure")

    monkeypatch.setattr(migration, "execute_v10_to_v11_candidate", fail)
    with pytest.raises(migration.CandidateExecutionError):
        migration.execute_legacy_to_v11_candidate(source, candidate, source_version=8)

    assert source.read_bytes() == before
    assert sorted(path.name for path in tmp_path.iterdir()) == ["source.db"]


def test_private_cli_admits_exact_v10_source(tmp_path: Path, capsys) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    with sqlite3.connect(source) as conn:
        create_exact_v10_schema(conn)

    assert migration.main(
        [
            "--source",
            str(source),
            "--candidate",
            str(candidate),
            "--source-version",
            "10",
        ]
    ) == 0
    assert '"user_version":11' in capsys.readouterr().out
    with sqlite3.connect(candidate) as conn:
        assert_exact_manifest(conn, EXACT_V11_MANIFEST)
