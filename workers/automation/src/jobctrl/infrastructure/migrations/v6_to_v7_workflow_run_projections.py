"""Copy v6 workflow-run read projections into the exact-v7 candidate."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_TABLE = "workflow_run_projections"
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
_WORKFLOW_TYPES = frozenset(
    {
        "ApplyWorkflow",
        "CompensationRefreshWorkflow",
        "ContactResearchWorkflow",
        "DiscoverWorkflow",
        "DurabilityProbeWorkflow",
        "InterviewPrepWorkflow",
        "JobPipelineWorkflow",
        "JobPreparationWorkflow",
        "ManualCaptureImportWorkflow",
        "ProfileImportWorkflow",
    }
)
_WORKFLOW_RUN_STATUSES = frozenset(
    {
        "starting",
        "in_progress",
        "succeeded",
        "failed",
        "canceled",
        "terminated",
        "timed_out",
        "dry_run_complete",
        "captcha",
        "login_issue",
        "expired",
        "manual",
    }
)
_TIMELINE_EVENT_STATUSES = {
    "WorkflowStarted": "in_progress",
    "WorkflowCompleted": "succeeded",
    "WorkflowFailed": "failed",
    "WorkflowCanceled": "canceled",
    "WorkflowTimedOut": "timed_out",
    "WorkflowTerminated": "terminated",
}
_TIMELINE_KEYS = frozenset({"eventType", "occurredAt", "status", "message"})
_AGGREGATE_ID_ALIASES = frozenset({"jobId", "job_id", "jobKey", "job_key"})
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class CandidateWorkflowRunProjectionsCopyError(RuntimeError):
    """Raised when v6 workflow-run projections cannot enter v7 unchanged."""


@dataclass(frozen=True)
class CandidateWorkflowRunProjectionsCopyResult:
    """Verified count of workflow-run projection rows copied into v7."""

    copied_workflow_run_projections: int


def copy_workflow_run_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> CandidateWorkflowRunProjectionsCopyResult:
    """Copy closed-shape workflow-run rows without interpreting job references.

    ``workflow_id`` and ``temporal_run_id`` are opaque Temporal execution
    identifiers.  They can contain legacy URL-shaped values, but are not JobId
    references.  ``input_summary_json.jobUrl`` is likewise an audit locator,
    while ``events_json`` is the projection builder's generated lifecycle
    timeline.  Every admitted value is therefore copied byte-for-byte; this
    transform only validates the known row and JSON shapes.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(source)
    _assert_columns(candidate)
    if _row_count(candidate):
        raise CandidateWorkflowRunProjectionsCopyError(
            "candidate workflow_run_projections must be empty"
        )

    source_rows = _rows(source)
    _validate_rows(source_rows)

    candidate.execute("SAVEPOINT v6_workflow_run_projections_copy")
    try:
        _insert_rows(candidate, source_rows)
        _verify_copy(source, candidate, source_rows)
        candidate.execute("RELEASE SAVEPOINT v6_workflow_run_projections_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_workflow_run_projections_copy")
        candidate.execute("RELEASE SAVEPOINT v6_workflow_run_projections_copy")
        raise

    return CandidateWorkflowRunProjectionsCopyResult(
        copied_workflow_run_projections=len(source_rows)
    )


def _assert_columns(conn: sqlite3.Connection) -> None:
    columns = tuple(
        str(row[1]) for row in conn.execute(f"PRAGMA table_info({_quote(_TABLE)})")
    )
    if not columns:
        raise CandidateWorkflowRunProjectionsCopyError(
            "missing required table: workflow_run_projections"
        )
    if columns != _COLUMNS:
        raise CandidateWorkflowRunProjectionsCopyError(
            "workflow_run_projections columns do not match the admitted schema"
        )


def _rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {_identifiers(_COLUMNS)} FROM {_quote(_TABLE)} ORDER BY rowid"
        ).fetchall()
    )


def _validate_rows(rows: tuple[tuple[object, ...], ...]) -> None:
    seen_workflow_ids: set[str] = set()
    for row in rows:
        values = dict(zip(_COLUMNS, row, strict=True))
        workflow_id = _required_text(values["workflow_id"], "workflow_id")
        _required_text(values["tenant_id"], "tenant_id")
        workflow_type = _required_text(values["workflow_type"], "workflow_type")
        if workflow_type not in _WORKFLOW_TYPES:
            raise CandidateWorkflowRunProjectionsCopyError(
                "workflow_type is not admitted"
            )
        status = _required_text(values["status"], "status")
        if status not in _WORKFLOW_RUN_STATUSES:
            raise CandidateWorkflowRunProjectionsCopyError("status is not admitted")
        _validate_input_summary(values["input_summary_json"])
        _optional_text(values["error_code"], "error_code")
        _optional_text(values["error_message"], "error_message")
        retryable = values["retryable"]
        if isinstance(retryable, bool) or not isinstance(retryable, int) or retryable not in {0, 1}:
            raise CandidateWorkflowRunProjectionsCopyError(
                "retryable must be exactly 0 or 1"
            )
        for field in ("started_at", "finished_at", "temporal_run_id"):
            _optional_text(values[field], field)
        _optional_nonnegative_safe_integer(values["duration_ms"], "duration_ms")
        _validate_timeline(values["events_json"])

        if workflow_id in seen_workflow_ids:
            raise CandidateWorkflowRunProjectionsCopyError(
                "workflow_run_projections source has duplicate primary keys"
            )
        seen_workflow_ids.add(workflow_id)


def _validate_input_summary(value: object) -> None:
    parsed = _json_value(value, "input_summary_json")
    if not isinstance(parsed, dict):
        raise CandidateWorkflowRunProjectionsCopyError(
            "input_summary_json must be a JSON object"
        )
    _reject_aggregate_identity_aliases(parsed)


def _reject_aggregate_identity_aliases(value: Any) -> None:
    if isinstance(value, dict):
        if _AGGREGATE_ID_ALIASES.intersection(value):
            raise CandidateWorkflowRunProjectionsCopyError(
                "input_summary_json contains an aggregate identity alias"
            )
        for nested in value.values():
            _reject_aggregate_identity_aliases(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_aggregate_identity_aliases(nested)


def _validate_timeline(value: object) -> None:
    parsed = _json_value(value, "events_json")
    if not isinstance(parsed, list):
        raise CandidateWorkflowRunProjectionsCopyError("events_json must be a JSON array")
    for event in parsed:
        if not isinstance(event, dict) or frozenset(event) != _TIMELINE_KEYS:
            raise CandidateWorkflowRunProjectionsCopyError(
                "events_json must contain generated workflow timeline entries"
            )
        event_type = _required_text(event["eventType"], "events_json.eventType")
        expected_status = _TIMELINE_EVENT_STATUSES.get(event_type)
        if expected_status is None:
            raise CandidateWorkflowRunProjectionsCopyError(
                "events_json eventType is not admitted"
            )
        _optional_text(event["occurredAt"], "events_json.occurredAt")
        status = _required_text(event["status"], "events_json.status")
        if status != expected_status:
            raise CandidateWorkflowRunProjectionsCopyError(
                "events_json status does not match eventType"
            )
        _optional_text(event["message"], "events_json.message")


def _json_value(value: object, field: str) -> Any:
    raw = _required_text(value, field)
    try:
        return json.loads(raw, parse_constant=_reject_non_json_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise CandidateWorkflowRunProjectionsCopyError(
            f"{field} must be valid JSON"
        ) from error


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant: {value}")


def _insert_rows(
    candidate: sqlite3.Connection,
    rows: tuple[tuple[object, ...], ...],
) -> None:
    if not rows:
        return
    placeholders = ", ".join("?" for _ in _COLUMNS)
    candidate.executemany(
        f"INSERT INTO {_quote(_TABLE)} ({_identifiers(_COLUMNS)}) "
        f"VALUES ({placeholders})",
        rows,
    )


def _verify_copy(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    expected_rows: tuple[tuple[object, ...], ...],
) -> None:
    candidate_rows = _rows(candidate)
    if candidate_rows != expected_rows:
        raise CandidateWorkflowRunProjectionsCopyError(
            "candidate copy changed workflow-run scalar values or ordering"
        )
    if _row_count(candidate) != len(expected_rows):
        raise CandidateWorkflowRunProjectionsCopyError(
            "candidate copy changed workflow-run row count"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateWorkflowRunProjectionsCopyError(
            "candidate workflow-run copy left a foreign-key violation"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    if _rows(source) != expected_rows:
        raise CandidateWorkflowRunProjectionsCopyError(
            "candidate copy mutated the v6 workflow-run source"
        )


def _row_count(conn: sqlite3.Connection) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_quote(_TABLE)}").fetchone()[0])


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CandidateWorkflowRunProjectionsCopyError(
            f"workflow run {field} must be non-empty text"
        )
    return value


def _optional_text(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _required_text(value, field)


def _optional_nonnegative_safe_integer(value: object, field: str) -> int | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _MAX_SAFE_INTEGER
    ):
        raise CandidateWorkflowRunProjectionsCopyError(
            f"workflow run {field} must be a non-negative safe integer or None"
        )
    return value


def _quote(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_quote(value) for value in values)


__all__ = [
    "CandidateWorkflowRunProjectionsCopyError",
    "CandidateWorkflowRunProjectionsCopyResult",
    "copy_workflow_run_projections",
]
