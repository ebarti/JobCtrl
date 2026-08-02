"""Copy v6 pipeline-step read projections into the exact-v7 candidate."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass

from jobctrl.domain.events.operations import (
    PIPELINE_STEP_DETAIL_CODES,
    PIPELINE_STEP_KINDS,
    PIPELINE_STEP_STATES,
)
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_TABLE = "pipeline_step_projections"
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
_SAFE_ITEM_KEY = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,159}$")
_SAFE_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class CandidatePipelineStepProjectionsCopyError(RuntimeError):
    """Raised when v6 pipeline-step projections cannot enter v7 unchanged."""


@dataclass(frozen=True)
class CandidatePipelineStepProjectionsCopyResult:
    """Verified count of pipeline-step projection rows copied into v7."""

    copied_pipeline_step_projections: int


def copy_pipeline_step_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> CandidatePipelineStepProjectionsCopyResult:
    """Copy closed-shape pipeline-step rows without interpreting their scopes.

    ``discover_workflow_id`` and ``discover_run_id`` are opaque Temporal
    execution identifiers, and ``item_key`` is a bounded orchestration scope
    key.  None are JobId references, so every admitted scalar is written
    byte-for-byte rather than resolved, normalized, or derived.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(source)
    _assert_columns(candidate)
    if _row_count(candidate):
        raise CandidatePipelineStepProjectionsCopyError(
            "candidate pipeline_step_projections must be empty"
        )

    source_rows = _rows(source)
    _validate_rows(source_rows)

    candidate.execute("SAVEPOINT v6_pipeline_step_projections_copy")
    try:
        _insert_rows(candidate, source_rows)
        _verify_copy(source, candidate, source_rows)
        candidate.execute("RELEASE SAVEPOINT v6_pipeline_step_projections_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_pipeline_step_projections_copy")
        candidate.execute("RELEASE SAVEPOINT v6_pipeline_step_projections_copy")
        raise

    return CandidatePipelineStepProjectionsCopyResult(
        copied_pipeline_step_projections=len(source_rows)
    )


def _assert_columns(conn: sqlite3.Connection) -> None:
    columns = tuple(
        str(row[1]) for row in conn.execute(f"PRAGMA table_info({_quote(_TABLE)})")
    )
    if not columns:
        raise CandidatePipelineStepProjectionsCopyError(
            "missing required table: pipeline_step_projections"
        )
    if columns != _COLUMNS:
        raise CandidatePipelineStepProjectionsCopyError(
            "pipeline_step_projections columns do not match the admitted schema"
        )


def _rows(conn: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {_identifiers(_COLUMNS)} FROM {_quote(_TABLE)} ORDER BY rowid"
        ).fetchall()
    )


def _validate_rows(rows: tuple[tuple[object, ...], ...]) -> None:
    seen_keys: set[tuple[str, str, str, str, str]] = set()
    for row in rows:
        values = dict(zip(_COLUMNS, row, strict=True))
        tenant_id = _required_text(values["tenant_id"], "tenant_id")
        workflow_id = _required_text(
            values["discover_workflow_id"], "discover_workflow_id"
        )
        run_id = _required_text(values["discover_run_id"], "discover_run_id")
        step_kind = _enum(values["step_kind"], "step_kind", PIPELINE_STEP_KINDS)
        item_key = _required_text(values["item_key"], "item_key")
        if not _SAFE_ITEM_KEY.fullmatch(item_key):
            raise CandidatePipelineStepProjectionsCopyError(
                "pipeline step item_key must be a bounded safe scope key"
            )
        _enum(values["state"], "state", PIPELINE_STEP_STATES)
        _positive_safe_integer(values["attempt"], "attempt")
        for field in ("queued_at", "started_at", "finished_at"):
            _optional_text(values[field], field)
        _optional_nonnegative_safe_integer(values["duration_ms"], "duration_ms")
        error_code = _optional_text(values["error_code"], "error_code")
        if error_code is not None and not _SAFE_ERROR_CODE.fullmatch(error_code):
            raise CandidatePipelineStepProjectionsCopyError(
                "pipeline step error_code must be a bounded safe code"
            )
        retryable = values["retryable"]
        if isinstance(retryable, bool) or not isinstance(retryable, int) or retryable not in {0, 1}:
            raise CandidatePipelineStepProjectionsCopyError(
                "pipeline step retryable must be exactly 0 or 1"
            )
        detail_code = _optional_text(values["detail_code"], "detail_code")
        if detail_code is not None and detail_code not in PIPELINE_STEP_DETAIL_CODES:
            raise CandidatePipelineStepProjectionsCopyError(
                "pipeline step detail_code is not admitted"
            )
        _optional_nonnegative_safe_integer(values["detail_count"], "detail_count")
        _positive_safe_integer(values["last_event_id"], "last_event_id")
        _required_text(values["last_updated_at"], "last_updated_at")

        key = (tenant_id, workflow_id, run_id, step_kind, item_key)
        if key in seen_keys:
            raise CandidatePipelineStepProjectionsCopyError(
                "pipeline_step_projections source has duplicate primary keys"
            )
        seen_keys.add(key)


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
        raise CandidatePipelineStepProjectionsCopyError(
            "candidate copy changed pipeline-step scalar values or ordering"
        )
    if _row_count(candidate) != len(expected_rows):
        raise CandidatePipelineStepProjectionsCopyError(
            "candidate copy changed pipeline-step row count"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidatePipelineStepProjectionsCopyError(
            "candidate pipeline-step copy left a foreign-key violation"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    if _rows(source) != expected_rows:
        raise CandidatePipelineStepProjectionsCopyError(
            "candidate copy mutated the v6 pipeline-step source"
        )


def _row_count(conn: sqlite3.Connection) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_quote(_TABLE)}").fetchone()[0])


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CandidatePipelineStepProjectionsCopyError(
            f"pipeline step {field} must be non-empty text"
        )
    return value


def _optional_text(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _required_text(value, field)


def _enum(value: object, field: str, allowed: tuple[str, ...]) -> str:
    text = _required_text(value, field)
    if text not in allowed:
        raise CandidatePipelineStepProjectionsCopyError(
            f"pipeline step {field} is not admitted"
        )
    return text


def _positive_safe_integer(value: object, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > _MAX_SAFE_INTEGER
    ):
        raise CandidatePipelineStepProjectionsCopyError(
            f"pipeline step {field} must be a positive safe integer"
        )
    return value


def _optional_nonnegative_safe_integer(value: object, field: str) -> int | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _MAX_SAFE_INTEGER
    ):
        raise CandidatePipelineStepProjectionsCopyError(
            f"pipeline step {field} must be a non-negative safe integer or None"
        )
    return value


def _quote(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_quote(value) for value in values)


__all__ = [
    "CandidatePipelineStepProjectionsCopyError",
    "CandidatePipelineStepProjectionsCopyResult",
    "copy_pipeline_step_projections",
]
