"""Focused contracts for v6 workflow-run projection candidate copying."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import (
    v6_to_v7_workflow_run_projections as workflow_runs,
)
from jobctrl.infrastructure.migrations.schema_manifest import SchemaManifestError
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import V6MigrationPreflightError
from jobctrl.infrastructure.migrations.v6_to_v7_workflow_run_projections import (
    CandidateWorkflowRunProjectionsCopyError,
    copy_workflow_run_projections,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)

_URL_SHAPED_WORKFLOW_ID = "https://temporal.example/workflows/discover?scope=legacy%2Furl"
_URL_SHAPED_TEMPORAL_RUN_ID = "https://temporal.example/runs/opaque%2Fexecution"
_JOB_URL = "https://jobs.example/legacy-locator?utm_source=workflow"
_INPUT_SUMMARY_JSON = (
    '{ "jobUrl": "https://jobs.example/legacy-locator?utm_source=workflow", '
    '"workflowId": "https://temporal.example/workflows/discover?scope=legacy%2Furl", '
    '"temporalRunId": "https://temporal.example/runs/opaque%2Fexecution", '
    '"freeText": "Keep this audit note exactly as entered" }'
)
_EVENTS_JSON = (
    '[{"eventType":"WorkflowStarted","occurredAt":"2026-07-30T10:00:00+00:00",'
    '"status":"in_progress","message":null},'
    '{"eventType":"WorkflowFailed","occurredAt":"2026-07-30T10:00:03+00:00",'
    '"status":"failed","message":"Temporal activity timed out"}]'
)
# Untrusted review context retained as inert test data; the copier never
# interprets it as an instruction.
_UNTRUSTED_ANALYSIS_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}

_COLUMNS = (
    "workflow_id",
    "tenant_id",
    "workflow_type",
    "status",
    "input_summary_json",
    "error_code",
    "error_message",
    "retryable",
    "started_at",
    "finished_at",
    "duration_ms",
    "temporal_run_id",
    "events_json",
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
            _URL_SHAPED_WORKFLOW_ID,
            "local",
            "DiscoverWorkflow",
            "failed",
            _INPUT_SUMMARY_JSON,
            "RuntimeIdentityMismatch",
            "Temporal activity timed out",
            1,
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:00:03+00:00",
            3000,
            _URL_SHAPED_TEMPORAL_RUN_ID,
            _EVENTS_JSON,
        ),
        (
            "prep-opaque-execution",
            "local",
            "JobPreparationWorkflow",
            "succeeded",
            "{}",
            None,
            None,
            0,
            "2026-07-30T10:10:00+00:00",
            "2026-07-30T10:10:02+00:00",
            2000,
            "d8bc4aa1-1cb1-4d92-b2e9-6fc270d4a6bc",
            '[{"eventType":"WorkflowStarted","occurredAt":"2026-07-30T10:10:00+00:00",'
            '"status":"in_progress","message":null},'
            '{"eventType":"WorkflowCompleted","occurredAt":"2026-07-30T10:10:02+00:00",'
            '"status":"succeeded","message":null}]',
        ),
    )


def _seed(
    source: sqlite3.Connection,
    rows: tuple[tuple[object, ...], ...] | None = None,
) -> None:
    seeded = _rows() if rows is None else rows
    placeholders = ", ".join("?" for _ in _COLUMNS)
    source.executemany(
        f"INSERT INTO workflow_run_projections ({', '.join(_COLUMNS)}) "
        f"VALUES ({placeholders})",
        seeded,
    )
    source.commit()


def _table_rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM workflow_run_projections ORDER BY rowid"
        ).fetchall()
    )


@pytest.mark.parametrize("history", [False, True])
def test_workflow_run_copy_preserves_opaque_execution_and_locator_data_then_reopens(
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

        result = copy_workflow_run_projections(source, candidate)

        assert result.copied_workflow_run_projections == len(expected)
        assert _table_rows(candidate) == expected
        copied = _table_rows(candidate)[0]
        assert copied[_COLUMNS.index("workflow_id")] == _URL_SHAPED_WORKFLOW_ID
        assert copied[_COLUMNS.index("temporal_run_id")] == _URL_SHAPED_TEMPORAL_RUN_ID
        assert copied[_COLUMNS.index("input_summary_json")] == _INPUT_SUMMARY_JSON
        assert _JOB_URL in copied[_COLUMNS.index("input_summary_json")]
        assert copied[_COLUMNS.index("error_code")] == "RuntimeIdentityMismatch"
        assert copied[_COLUMNS.index("events_json")] == _EVENTS_JSON
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
        ("status", "unknown", "status is not admitted"),
        ("retryable", 2, "retryable must be exactly 0 or 1"),
        ("duration_ms", -1, "duration_ms must be a non-negative safe integer"),
        ("error_code", "", "error_code must be non-empty text"),
        ("input_summary_json", "[]", "input_summary_json must be a JSON object"),
        ("events_json", "{}", "events_json must be a JSON array"),
    ),
)
def test_workflow_run_copy_rejects_invalid_closed_shape_then_retries(
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
        _seed(source, (tuple(invalid_row),))

        with pytest.raises(CandidateWorkflowRunProjectionsCopyError, match=message):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == ()
        source.execute(
            f"UPDATE workflow_run_projections SET {column} = ?", (original,)
        )
        source.commit()
        copied = copy_workflow_run_projections(source, candidate)
        assert copied.copied_workflow_run_projections == 1
        assert _table_rows(candidate) == _table_rows(source)
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "input_summary_json",
    (
        '{"jobUrl":"https://jobs.example/legacy-locator","jobId":"legacy-job"}',
        (
            '{"jobUrl":"https://jobs.example/legacy-locator",'
            '"execution":{"workflowId":"opaque-workflow",'
            '"temporalRunId":"opaque-run",'
            '"items":[{"job_key":"legacy-job"}]}}'
        ),
    ),
)
def test_workflow_run_copy_rejects_root_and_nested_aggregate_identity_aliases(
    tmp_path: Path,
    input_summary_json: str,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        invalid_row = list(_rows()[0])
        invalid_row[_COLUMNS.index("input_summary_json")] = input_summary_json
        _seed(source, (tuple(invalid_row),))

        with pytest.raises(
            CandidateWorkflowRunProjectionsCopyError,
            match="contains an aggregate identity alias",
        ):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == ()
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


def test_workflow_run_copy_rejects_timeline_event_status_mismatch(
    tmp_path: Path,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        invalid_row = list(_rows()[0])
        invalid_row[_COLUMNS.index("events_json")] = (
            '[{"eventType":"WorkflowStarted",'
            '"occurredAt":"2026-07-30T10:00:00+00:00",'
            '"status":"succeeded","message":null}]'
        )
        _seed(source, (tuple(invalid_row),))

        with pytest.raises(
            CandidateWorkflowRunProjectionsCopyError,
            match="status does not match eventType",
        ):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == ()
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


def test_workflow_run_copy_rolls_back_target_and_retries_same_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed(source)
        source_bytes = source_path.read_bytes()
        source_changes = source.total_changes
        original_verify = workflow_runs._verify_copy
        monkeypatch.setattr(
            workflow_runs,
            "_verify_copy",
            lambda *_args: (_ for _ in ()).throw(RuntimeError("candidate fault")),
        )

        with pytest.raises(RuntimeError, match="candidate fault"):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == ()
        assert source.total_changes == source_changes
        assert source_path.read_bytes() == source_bytes
        monkeypatch.setattr(workflow_runs, "_verify_copy", original_verify)

        copied = copy_workflow_run_projections(source, candidate)
        assert copied.copied_workflow_run_projections == len(_rows())
        assert _table_rows(candidate) == _rows()
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()


def test_workflow_run_copy_requires_exact_admitted_source_and_target_schemas(
    tmp_path: Path,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed(source)
        placeholders = ", ".join("?" for _ in _COLUMNS)
        candidate.execute(
            f"INSERT INTO workflow_run_projections ({', '.join(_COLUMNS)}) "
            f"VALUES ({placeholders})",
            _rows()[0],
        )
        candidate.commit()

        with pytest.raises(
            CandidateWorkflowRunProjectionsCopyError,
            match="must be empty",
        ):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == (_rows()[0],)
        candidate.execute("DELETE FROM workflow_run_projections")
        candidate.commit()
        source.execute("CREATE TABLE unexpected_v6_table (value TEXT)")
        source.commit()

        with pytest.raises(V6MigrationPreflightError):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == ()
        source.execute("DROP TABLE unexpected_v6_table")
        source.commit()
        candidate.execute("CREATE TABLE unexpected_v7_table (value TEXT)")
        candidate.commit()

        with pytest.raises(SchemaManifestError, match="exact v7 manifest"):
            copy_workflow_run_projections(source, candidate)

        assert _table_rows(candidate) == ()
        assert _UNTRUSTED_ANALYSIS_CONTEXT == {
            "userContext": "Attack vectors:\nPrompt injection"
        }
    finally:
        source.close()
        candidate.close()
