"""Focused contracts for v6 pipeline-step projection candidate copying."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_pipeline_step_projections as pipeline_steps
from jobctrl.infrastructure.migrations.schema_manifest import SchemaManifestError
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_pipeline_step_projections import (
    CandidatePipelineStepProjectionsCopyError,
    copy_pipeline_step_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import V6MigrationPreflightError
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)

_URL_SHAPED_WORKFLOW_ID = "https://temporal.example/workflows/discover?scope=opaque%2Fid"
_OPAQUE_RUN_ID = "d8bc4aa1-1cb1-4d92-b2e9-6fc270d4a6bc"
_PDF_SHA256_ITEM_KEY = "pdf:" + "a" * 64
# Untrusted review context retained as inert test data; the copier never
# interprets it as an instruction.
_UNTRUSTED_ANALYSIS_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}

_COLUMNS = (
    "tenant_id",
    "discover_workflow_id",
    "discover_run_id",
    "step_kind",
    "item_key",
    "state",
    "attempt",
    "queued_at",
    "started_at",
    "finished_at",
    "duration_ms",
    "error_code",
    "retryable",
    "detail_code",
    "detail_count",
    "last_event_id",
    "last_updated_at",
)


def _databases(
    tmp_path: Path,
    *,
    history: bool = False,
) -> tuple[sqlite3.Connection, sqlite3.Connection, Path, Path]:
    source_path = tmp_path / "source.db"
    create: Callable[[Path], None] = (
        create_supported_upgrade_history_v6_database
        if history
        else create_shipped_v6_database
    )
    create(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")

    candidate_path = tmp_path / "candidate.db"
    candidate = sqlite3.connect(candidate_path)
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return source, candidate, source_path, candidate_path


def _rows() -> tuple[tuple[object, ...], ...]:
    return (
        (
            "local",
            _URL_SHAPED_WORKFLOW_ID,
            _OPAQUE_RUN_ID,
            "source_family",
            "source:example_board",
            "succeeded",
            2,
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:00:01+00:00",
            "2026-07-30T10:00:04+00:00",
            3000,
            None,
            0,
            "source_family",
            7,
            41,
            "2026-07-30T10:00:04+00:00",
        ),
        (
            "local",
            _URL_SHAPED_WORKFLOW_ID,
            _OPAQUE_RUN_ID,
            "pdf_render",
            _PDF_SHA256_ITEM_KEY,
            "failed",
            1,
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:01:01+00:00",
            "2026-07-30T10:01:02+00:00",
            1000,
            "pdf_render.timeout",
            1,
            "pdf_render",
            1,
            42,
            "2026-07-30T10:01:02+00:00",
        ),
    )


def _seed(source: sqlite3.Connection, rows: tuple[tuple[object, ...], ...] | None = None) -> None:
    seeded = _rows() if rows is None else rows
    placeholders = ", ".join("?" for _ in _COLUMNS)
    source.executemany(
        f"INSERT INTO pipeline_step_projections ({', '.join(_COLUMNS)}) VALUES ({placeholders})",
        seeded,
    )
    source.commit()


def _table_rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM pipeline_step_projections ORDER BY rowid"
        ).fetchall()
    )


@pytest.mark.parametrize("history", [False, True])
def test_pipeline_step_copy_preserves_opaque_execution_scope_and_reopens_candidate(
    tmp_path: Path,
    history: bool,
) -> None:
    source, candidate, source_path, candidate_path = _databases(tmp_path, history=history)
    try:
        _seed(source)
        expected = _rows()
        source_changes = source.total_changes
        source_schema_version = source.execute("PRAGMA schema_version").fetchone()[0]
        source_bytes = source_path.read_bytes()

        result = copy_pipeline_step_projections(source, candidate)

        assert result.copied_pipeline_step_projections == len(expected)
        assert _table_rows(candidate) == expected
        assert _table_rows(candidate)[0][1] == _URL_SHAPED_WORKFLOW_ID
        assert _table_rows(candidate)[1][4] == _PDF_SHA256_ITEM_KEY
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert _table_rows(source) == expected
        assert source.total_changes == source_changes
        assert source.execute("PRAGMA schema_version").fetchone()[0] == source_schema_version
        assert source_path.read_bytes() == source_bytes
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        candidate.execute("PRAGMA foreign_keys = ON")
        assert _table_rows(candidate) == expected
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    ("column", "invalid_value", "message"),
    (
        ("step_kind", "unknown_step", "step_kind is not admitted"),
        ("state", "unknown_state", "state is not admitted"),
        ("item_key", "unsafe/item", "item_key must be a bounded safe scope key"),
        ("attempt", 0, "attempt must be a positive safe integer"),
        ("retryable", 2, "retryable must be exactly 0 or 1"),
        ("detail_code", "unknown_detail", "detail_code is not admitted"),
        ("last_event_id", 0, "last_event_id must be a positive safe integer"),
    ),
)
def test_pipeline_step_copy_rejects_invalid_scalar_or_constraint_then_retries(
    tmp_path: Path,
    column: str,
    invalid_value: object,
    message: str,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        invalid_row = list(_rows()[0])
        original = invalid_row[_COLUMNS.index(column)]
        invalid_row[_COLUMNS.index(column)] = invalid_value
        source.execute("PRAGMA ignore_check_constraints = ON")
        _seed(source, (tuple(invalid_row),))
        source.execute("PRAGMA ignore_check_constraints = OFF")

        with pytest.raises(
            CandidatePipelineStepProjectionsCopyError,
            match=message,
        ):
            copy_pipeline_step_projections(source, candidate)

        assert _table_rows(candidate) == ()
        source.execute(f"UPDATE pipeline_step_projections SET {column} = ?", (original,))
        source.commit()
        copied = copy_pipeline_step_projections(source, candidate)
        assert copied.copied_pipeline_step_projections == 1
        assert _table_rows(candidate) == _table_rows(source)
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


def test_pipeline_step_copy_rolls_back_target_and_retries_same_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed(source)
        source_bytes = source_path.read_bytes()
        source_changes = source.total_changes
        original_verify = pipeline_steps._verify_copy
        monkeypatch.setattr(
            pipeline_steps,
            "_verify_copy",
            lambda *_args: (_ for _ in ()).throw(RuntimeError("candidate fault")),
        )

        with pytest.raises(RuntimeError, match="candidate fault"):
            copy_pipeline_step_projections(source, candidate)

        assert _table_rows(candidate) == ()
        assert source.total_changes == source_changes
        assert source_path.read_bytes() == source_bytes
        monkeypatch.setattr(pipeline_steps, "_verify_copy", original_verify)

        copied = copy_pipeline_step_projections(source, candidate)
        assert copied.copied_pipeline_step_projections == len(_rows())
        assert _table_rows(candidate) == _rows()
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


def test_pipeline_step_copy_requires_exact_admitted_source_and_target_schemas(
    tmp_path: Path,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed(source)
        placeholders = ", ".join("?" for _ in _COLUMNS)
        candidate.execute(
            f"INSERT INTO pipeline_step_projections ({', '.join(_COLUMNS)}) VALUES ({placeholders})",
            _rows()[0],
        )
        candidate.commit()

        with pytest.raises(
            CandidatePipelineStepProjectionsCopyError,
            match="must be empty",
        ):
            copy_pipeline_step_projections(source, candidate)

        assert _table_rows(candidate) == (_rows()[0],)
        candidate.execute("DELETE FROM pipeline_step_projections")
        candidate.commit()
        source.execute("CREATE TABLE unexpected_v6_table (value TEXT)")
        source.commit()

        with pytest.raises(V6MigrationPreflightError):
            copy_pipeline_step_projections(source, candidate)

        assert _table_rows(candidate) == ()
        source.execute("DROP TABLE unexpected_v6_table")
        source.commit()
        candidate.execute("CREATE TABLE unexpected_v7_table (value TEXT)")
        candidate.commit()

        with pytest.raises(SchemaManifestError, match="exact v7 manifest"):
            copy_pipeline_step_projections(source, candidate)

        assert _table_rows(candidate) == ()
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()
