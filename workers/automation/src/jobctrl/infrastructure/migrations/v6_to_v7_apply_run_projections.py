"""Rebuild v7 apply-run projections from copied canonical job events."""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.identity_upcast import EVENT_IDENTITY_VERSION
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    JobIdMap,
    build_job_id_map,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_PROJECTION_COLUMNS = (
    "run_id",
    "tenant_id",
    "job_id",
    "job_title",
    "job_employer",
    "status",
    "result",
    "dry_run",
    "worker_id",
    "model",
    "started_at",
    "finished_at",
    "duration_ms",
    "events_json",
)
_EVENT_COLUMNS = (
    "event_id",
    "tenant_id",
    "job_id",
    "identity_version",
    "stage",
    "event_type",
    "level",
    "message",
    "occurred_at",
    "payload_json",
    "entity_kind",
    "entity_ref",
    "idempotency_key",
)

_TERMINAL_EVENT_STATUS: Mapping[str, tuple[str, str | None]] = {
    "ApplicationSubmitted": ("succeeded", "applied"),
    "DryRunCompleted": ("dry_run_complete", "dry_run_complete"),
    "ApplyManualSkip": ("manual", "manual"),
    # ``LockReleased`` remains a fallback only. A preceding terminal verdict
    # is more specific and must not be overwritten by lock cleanup.
    "LockReleased": ("failed", "failed"),
}
_STATUS_FROM_RESULT: Mapping[str, str] = {
    "applied": "succeeded",
    "failed": "failed",
    "captcha": "captcha",
    "login_issue": "login_issue",
    "expired": "expired",
    "manual": "manual",
    "email_only": "manual",
    "dry_run_complete": "dry_run_complete",
}


class CandidateApplyRunProjectionsError(RuntimeError):
    """Raised when v7 apply-run projections cannot be rebuilt safely."""


@dataclass(frozen=True)
class CandidateApplyRunProjectionsResult:
    """Verified candidate apply-run projection rebuild result."""

    rebuilt_apply_runs: int


@dataclass(frozen=True)
class _ApplyEvent:
    event_id: int
    tenant_id: str
    job_id: str
    event_type: str
    level: str
    message: str | None
    occurred_at: str | None
    payload: dict[str, Any]


@dataclass(frozen=True)
class _JobMetadata:
    title: str
    employer: str


def rebuild_apply_run_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> CandidateApplyRunProjectionsResult:
    """Rebuild apply-run read rows from the copied v7 event history.

    v6 ``apply_run_projections`` is a URL-keyed materialized cache. It is
    deliberately not a source for this candidate transform: each v7 row is
    folded from the already-upcast ``job_events`` history instead.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_columns(source, "apply_run_projections", _PROJECTION_COLUMNS)
    _assert_columns(candidate, "apply_run_projections", _PROJECTION_COLUMNS)
    _assert_columns(candidate, "job_events", _EVENT_COLUMNS)
    _assert_empty_target(candidate)

    source_rows = _rows(source, "apply_run_projections", _PROJECTION_COLUMNS)
    jobs = _candidate_job_metadata(candidate)
    events_by_run = _candidate_events_by_run(candidate, jobs)
    projections = tuple(
        _project_run(run_id, events, jobs)
        for run_id, events in sorted(events_by_run.items())
    )

    candidate.execute("SAVEPOINT v6_apply_run_projection_rebuild")
    try:
        _insert_projections(candidate, projections)
        _verify_candidate(
            source=source,
            candidate=candidate,
            expected_source_rows=source_rows,
            expected_projections=projections,
        )
        candidate.execute("RELEASE SAVEPOINT v6_apply_run_projection_rebuild")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_apply_run_projection_rebuild")
        candidate.execute("RELEASE SAVEPOINT v6_apply_run_projection_rebuild")
        raise

    return CandidateApplyRunProjectionsResult(
        rebuilt_apply_runs=len(projections),
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        candidate_job_ids = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateApplyRunProjectionsError(
            "apply-run projection rebuild requires hydrated candidate roots"
        ) from error
    if dict(candidate_job_ids.by_locator) != dict(job_ids.by_locator):
        raise CandidateApplyRunProjectionsError(
            "supplied JobIdMap does not match hydrated candidate roots"
        )
    current_locators = {
        (str(tenant_id), str(locator)): str(job_id)
        for tenant_id, locator, job_id in candidate.execute(
            """
            SELECT tenant_id, locator_value, job_id
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if (
        current_locators != dict(job_ids.by_locator)
        or _row_count(candidate, "job_locators") != len(current_locators)
    ):
        raise CandidateApplyRunProjectionsError(
            "apply-run projection rebuild requires hydrated candidate root locators"
        )


def _assert_empty_target(candidate: sqlite3.Connection) -> None:
    if _row_count(candidate, "apply_run_projections"):
        raise CandidateApplyRunProjectionsError(
            "candidate apply_run_projections must be empty"
        )


def _candidate_job_metadata(
    candidate: sqlite3.Connection,
) -> dict[tuple[str, str], _JobMetadata]:
    jobs: dict[tuple[str, str], _JobMetadata] = {}
    for tenant_id, job_id, title, company in candidate.execute(
        "SELECT tenant_id, job_id, title, company FROM jobs"
    ).fetchall():
        tenant = _required_text(tenant_id, "candidate job tenant_id")
        stable_job_id = _required_text(job_id, "candidate job job_id")
        key = (tenant, stable_job_id)
        if key in jobs:
            raise CandidateApplyRunProjectionsError(
                "candidate jobs contains duplicate stable identity"
            )
        jobs[key] = _JobMetadata(
            title=_text_or_default(title, "Untitled"),
            employer=_text_or_default(company, "Unknown company"),
        )
    return jobs


def _candidate_events_by_run(
    candidate: sqlite3.Connection,
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> dict[str, list[_ApplyEvent]]:
    events_by_run: dict[str, list[_ApplyEvent]] = defaultdict(list)
    run_identities: dict[str, tuple[str, str]] = {}
    rows = candidate.execute(
        """
        SELECT event_id, tenant_id, job_id, event_type, level, message,
               occurred_at, payload_json, identity_version
        FROM job_events
        WHERE stage = 'apply'
        ORDER BY event_id ASC
        """
    ).fetchall()
    for row in rows:
        event = _parse_apply_event(row, jobs)
        if event is None:
            continue
        run_id = _run_id_for_projection(event.payload)
        if run_id is None:
            continue
        identity = (event.tenant_id, event.job_id)
        previous = run_identities.setdefault(run_id, identity)
        if previous != identity:
            raise CandidateApplyRunProjectionsError(
                "apply run contains conflicting candidate job identities"
            )
        events_by_run[run_id].append(event)
    return dict(events_by_run)


def _parse_apply_event(
    row: tuple[object, ...],
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> _ApplyEvent | None:
    (
        event_id,
        tenant_id,
        job_id,
        event_type,
        level,
        message,
        occurred_at,
        payload_json,
        identity_version,
    ) = row
    if identity_version != EVENT_IDENTITY_VERSION:
        raise CandidateApplyRunProjectionsError(
            "candidate apply event does not have the v7 event identity version"
        )
    parsed_event_id = _required_event_id(event_id)
    tenant = _required_text(tenant_id, "candidate apply event tenant_id")
    stable_job_id = _required_text(job_id, "candidate apply event job_id")
    if (tenant, stable_job_id) not in jobs:
        raise CandidateApplyRunProjectionsError(
            "candidate apply event does not reference a hydrated job root"
        )
    parsed_event_type = _required_text(event_type, "candidate apply event event_type")
    parsed_level = _text_or_default(level, "info")
    parsed_message = _optional_text(message)
    parsed_occurred_at = _optional_text(occurred_at)
    if payload_json is None:
        return None
    try:
        payload = json.loads(str(payload_json))
    except json.JSONDecodeError as error:
        # The event upcast rejects this before a candidate exists. Keep this
        # guard for an externally corrupted candidate rather than guessing.
        raise CandidateApplyRunProjectionsError(
            "candidate apply event payload_json is invalid"
        ) from error
    if not isinstance(payload, dict):
        return None
    if _run_id_for_projection(payload) is None:
        return None
    return _ApplyEvent(
        event_id=parsed_event_id,
        tenant_id=tenant,
        job_id=stable_job_id,
        event_type=parsed_event_type,
        level=parsed_level,
        message=parsed_message,
        occurred_at=parsed_occurred_at,
        payload=payload,
    )


def _project_run(
    run_id: str,
    events: list[_ApplyEvent],
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> tuple[object, ...]:
    if not events:
        raise CandidateApplyRunProjectionsError("apply run has no events")
    first_event = events[0]
    metadata = jobs[(first_event.tenant_id, first_event.job_id)]
    status = "starting"
    result: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    worker_id: int | None = None
    model: str | None = None
    dry_run = False

    timeline: list[dict[str, Any]] = []
    for event in events:
        payload = event.payload
        if event.event_type == "ApplyRunStarted":
            payload_started_at = _payload_text(payload, "started_at")
            started_at = (
                payload_started_at
                if payload_started_at is not None
                else event.occurred_at
            )
            if isinstance(payload.get("model"), str) and payload["model"]:
                model = payload["model"]
            worker_id = _payload_worker_id(payload.get("worker_id"), worker_id)
            if "dry_run" in payload:
                dry_run = bool(payload["dry_run"])
            status = "starting"
        elif event.event_type == "ApplyRunInProgress":
            if status == "starting":
                status = "in_progress"
        elif event.event_type in _TERMINAL_EVENT_STATUS:
            if event.event_type == "LockReleased" and result is not None:
                timeline.append(_timeline_entry(event))
                continue
            status, default_result = _TERMINAL_EVENT_STATUS[event.event_type]
            payload_result = _payload_string(payload, "result")
            result = payload_result if payload_result is not None else default_result
            payload_finished_at = _payload_text(payload, "finished_at")
            finished_at = (
                payload_finished_at
                if payload_finished_at is not None
                else event.occurred_at
            )
            duration_ms = _payload_duration(payload, duration_ms)
            if event.event_type == "DryRunCompleted":
                dry_run = True
        elif event.event_type == "ApplicationFailed":
            result_kind = _failed_result_kind(payload)
            status = _STATUS_FROM_RESULT.get(str(result_kind), "failed") if result_kind else "failed"
            result = str(result_kind) if result_kind else "failed"
            payload_finished_at = _payload_text(payload, "finished_at")
            finished_at = (
                payload_finished_at
                if payload_finished_at is not None
                else event.occurred_at
            )
            duration_ms = _payload_duration(payload, duration_ms)
        timeline.append(_timeline_entry(event))

    return (
        run_id,
        first_event.tenant_id,
        first_event.job_id,
        metadata.title,
        metadata.employer,
        status,
        result,
        1 if dry_run else 0,
        worker_id,
        model,
        started_at,
        finished_at,
        duration_ms,
        json.dumps(timeline),
    )


def _timeline_entry(event: _ApplyEvent) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "event_type": event.event_type,
        "level": event.level,
        "occurred_at": event.occurred_at,
    }
    if event.message:
        entry["message"] = event.message
    if event.payload:
        entry["payload"] = event.payload
    return entry


def _insert_projections(
    candidate: sqlite3.Connection,
    projections: tuple[tuple[object, ...], ...],
) -> None:
    if not projections:
        return
    placeholders = ", ".join("?" for _ in _PROJECTION_COLUMNS)
    candidate.executemany(
        f"INSERT INTO apply_run_projections ({_identifiers(_PROJECTION_COLUMNS)}) "
        f"VALUES ({placeholders})",
        projections,
    )


def _verify_candidate(
    *,
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    expected_source_rows: tuple[tuple[object, ...], ...],
    expected_projections: tuple[tuple[object, ...], ...],
) -> None:
    candidate_rows = _rows(candidate, "apply_run_projections", _PROJECTION_COLUMNS)
    if candidate_rows != expected_projections:
        raise CandidateApplyRunProjectionsError(
            "candidate apply-run projection rebuild changed projection rows"
        )
    if _row_count(candidate, "apply_run_projections") != len(expected_projections):
        raise CandidateApplyRunProjectionsError(
            "candidate apply-run projection rebuild changed run count"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateApplyRunProjectionsError(
            "candidate apply-run projection rebuild left a foreign-key violation"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    if _rows(source, "apply_run_projections", _PROJECTION_COLUMNS) != expected_source_rows:
        raise CandidateApplyRunProjectionsError(
            "candidate apply-run projection rebuild mutated the v6 source"
        )


def _run_id_for_projection(payload: Mapping[str, Any]) -> str | None:
    """Return an apply-run identity, preserving job-level audit events.

    The event stream also records apply-stage audit facts such as manual user
    marks. They have no ``run_id`` key and remain canonical event history, but
    are not members of an apply-run projection. Once a payload claims a run
    identity, it must have the exact supported shape.
    """
    if "run_id" not in payload:
        return None
    return _required_text(payload["run_id"], "candidate apply event run_id")


def _payload_text(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return str(value) if value is not None else None


def _payload_string(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) else None


def _payload_worker_id(value: object, current: int | None) -> int | None:
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return current


def _payload_duration(payload: Mapping[str, Any], current: int | None) -> int | None:
    if "duration_ms" not in payload:
        return current
    try:
        return int(payload["duration_ms"])
    except (TypeError, ValueError):
        return current


def _failed_result_kind(payload: Mapping[str, Any]) -> object | None:
    result = payload.get("result")
    if isinstance(result, dict):
        return result.get("kind")
    return result if isinstance(result, str) else None


def _rows(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {_identifiers(columns)} FROM {_identifier(table)} ORDER BY rowid"
        ).fetchall()
    )


def _assert_columns(
    conn: sqlite3.Connection,
    table: str,
    expected: tuple[str, ...],
) -> None:
    columns = tuple(
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_identifier(table)})").fetchall()
    )
    if columns != expected:
        raise CandidateApplyRunProjectionsError(
            f"{table} columns do not match the admitted schema"
        )


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise CandidateApplyRunProjectionsError(f"malformed {label}")
    return value


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _text_or_default(value: object, default: str) -> str:
    return value if isinstance(value, str) and value else default


def _required_event_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise CandidateApplyRunProjectionsError("malformed candidate apply event event_id")
    return value


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0])


def _identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_identifier(value) for value in values)


__all__ = [
    "CandidateApplyRunProjectionsError",
    "CandidateApplyRunProjectionsResult",
    "rebuild_apply_run_projections",
]
