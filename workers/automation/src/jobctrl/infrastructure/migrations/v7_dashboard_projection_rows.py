"""Build deterministic v7 dashboard rows from canonical candidate data."""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Iterable, Mapping
from typing import Any

from jobctrl.infrastructure.migrations import (
    v6_to_v7_job_detail_projections as job_details,
)
from jobctrl.infrastructure.migrations.v7_dashboard_outcome_conversion import (
    build_dashboard_outcome_conversion,
)
from jobctrl.infrastructure.migrations.v7_job_list_projection_rows import (
    JOB_LIST_PROJECTIONS_COLUMNS,
    CandidateJobListProjectionsError,
    _projection_rows as job_list_projection_rows,
)
from jobctrl.infrastructure.projections import projection_builder

DASHBOARD_PROJECTIONS_TABLE = "dashboard_projections"
DASHBOARD_PROJECTIONS_COLUMNS = (
    "tenant_id",
    "total_jobs",
    "failures",
    "blocked",
    "ready",
    "applied",
    "dry_runs",
    "funnel_json",
    "by_source_json",
    "score_distribution_json",
    "outcome_conversion_json",
    "generated_at",
)

_CLOSED_STATES = frozenset(
    {"closed", "expired", "removed", "location_incompatible"}
)
_STAGE_STATES = frozenset(
    {
        "blocked",
        "canceled",
        "exhausted",
        "failed",
        "needs_verification",
        "pending",
        "queued",
        "running",
        "skipped",
        "stale",
        "succeeded",
    }
)


class CandidateDashboardProjectionsError(RuntimeError):
    """Raised when a complete dashboard row cannot be derived safely."""


def _projection_rows(
    candidate: sqlite3.Connection,
    migration_at: str,
) -> tuple[tuple[object, ...], ...]:
    """Serialize one complete v7 dashboard row per candidate tenant.

    The serializer consumes the already rebuilt job list, job detail, and apply
    projections plus canonical v7 lifecycle and outcome rows. It never reads the
    legacy dashboard cache or free-text outcome/suggestion fields.
    """
    timestamp = _required_text(migration_at, "migration_at")
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateDashboardProjectionsError(
            "dashboard serialization requires foreign-key-clean v7 inputs"
        )
    _assert_exact_upstream_projections(candidate, timestamp)
    roots = _root_keys(candidate)
    job_rows = _rows_by_key(
        candidate,
        """
        SELECT tenant_id, job_id, source, fit_score, fit_band, current_stage,
               current_state, has_resume, apply_status, applied_at, apply_mode,
               resume_template_id, resume_template_name,
               tailoring_policy_version, deleted_at
        FROM job_list_projections
        ORDER BY tenant_id, job_id
        """,
        "job-list",
    )
    detail_rows = _rows_by_key(
        candidate,
        """
        SELECT tenant_id, job_id, stages_json
        FROM job_detail_projections
        ORDER BY tenant_id, job_id
        """,
        "job-detail",
    )
    if set(job_rows) != roots or set(detail_rows) != roots:
        raise CandidateDashboardProjectionsError(
            "dashboard serialization requires complete v7 job-list and job-detail projections"
        )

    deleted = _active_deleted(candidate)
    hidden = _active_hidden(candidate)
    closed = _closed_jobs(candidate)
    for key, row in job_rows.items():
        projected_deleted_at = _optional_text(row["deleted_at"])
        canonical_deleted_at = deleted.get(key)
        if projected_deleted_at != canonical_deleted_at:
            raise CandidateDashboardProjectionsError(
                "job-list deletion state must match canonical v7 lifecycle state"
            )

    dry_run_jobs = _dry_run_jobs(candidate, roots)
    tenants = sorted({tenant_id for tenant_id, _ in roots} | {"local"})
    output: list[tuple[object, ...]] = []
    for tenant_id in tenants:
        active = [
            row
            for key, row in job_rows.items()
            if key[0] == tenant_id
            and key not in deleted
            and key not in hidden
            and key not in closed
        ]
        active_keys = {
            (tenant_id, _required_uuid(row["job_id"], "job-list job_id"))
            for row in active
        }
        funnel = _funnel(active_keys, detail_rows)
        by_source = _by_source(active)
        score_distribution = _score_distribution(active)
        output.append(
            (
                tenant_id,
                len(active),
                sum(
                    _text(row["current_state"]) in {"failed", "exhausted"}
                    for row in active
                ),
                sum(_text(row["current_state"]) == "blocked" for row in active),
                sum(
                    _text(row["current_stage"]) == "apply"
                    and _text(row["current_state"]) == "pending"
                    and _integer(row["has_resume"], "job-list has_resume") == 1
                    for row in active
                ),
                sum(_is_applied(row) for row in active),
                sum(key in active_keys for key in dry_run_jobs if key[0] == tenant_id),
                _json(funnel),
                _json(by_source),
                _json(score_distribution),
                _json(
                    build_dashboard_outcome_conversion(
                        candidate,
                        tenant_id=tenant_id,
                        active_rows=active,
                        root_job_ids={
                            job_id
                            for root_tenant_id, job_id in roots
                            if root_tenant_id == tenant_id
                        },
                    )
                ),
                timestamp,
            )
        )

    if any(len(row) != len(DASHBOARD_PROJECTIONS_COLUMNS) for row in output):
        raise CandidateDashboardProjectionsError(
            "dashboard serializer must emit every v7 column"
        )
    return tuple(output)


def _assert_exact_upstream_projections(
    candidate: sqlite3.Connection,
    migration_at: str,
) -> None:
    try:
        expected_details = job_details._projection_rows(
            candidate, migration_at=migration_at
        )
    except job_details.CandidateJobDetailProjectionsError as error:
        raise CandidateDashboardProjectionsError(
            "candidate job-detail projections cannot be verified"
        ) from error
    actual_details = _complete_rows(
        candidate,
        "job_detail_projections",
        job_details._COLUMNS,
        order="tenant_id, job_id",
    )
    if actual_details != expected_details:
        raise CandidateDashboardProjectionsError(
            "candidate job_detail_projections must match the canonical rebuild"
        )

    try:
        expected_list = job_list_projection_rows(candidate, migration_at)
    except CandidateJobListProjectionsError as error:
        raise CandidateDashboardProjectionsError(
            "candidate job-list projections cannot be verified"
        ) from error
    actual_list = _complete_rows(
        candidate,
        "job_list_projections",
        JOB_LIST_PROJECTIONS_COLUMNS,
        order="tenant_id, job_id",
    )
    if actual_list != expected_list:
        raise CandidateDashboardProjectionsError(
            "candidate job_list_projections must match the canonical rebuild"
        )


def _complete_rows(
    candidate: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
    *,
    order: str,
) -> tuple[tuple[object, ...], ...]:
    identifiers = ", ".join(f'"{column}"' for column in columns)
    return tuple(
        tuple(row)
        for row in candidate.execute(
            f'SELECT {identifiers} FROM "{table}" ORDER BY {order}'
        ).fetchall()
    )


def _root_keys(candidate: sqlite3.Connection) -> set[tuple[str, str]]:
    roots: set[tuple[str, str]] = set()
    for tenant_id, job_id in candidate.execute(
        "SELECT tenant_id, job_id FROM jobs ORDER BY tenant_id, job_id"
    ).fetchall():
        key = (
            _required_text(tenant_id, "job tenant_id"),
            _required_uuid(job_id, "job job_id"),
        )
        if key in roots:
            raise CandidateDashboardProjectionsError(
                "candidate job roots must be unique"
            )
        roots.add(key)
    return roots


def _rows_by_key(
    candidate: sqlite3.Connection,
    query: str,
    label: str,
) -> dict[tuple[str, str], dict[str, object]]:
    cursor = candidate.execute(query)
    columns = tuple(column[0] for column in cursor.description or ())
    rows: dict[tuple[str, str], dict[str, object]] = {}
    for values in cursor.fetchall():
        row = dict(zip(columns, values, strict=True))
        key = (
            _required_text(row.get("tenant_id"), f"{label} tenant_id"),
            _required_uuid(row.get("job_id"), f"{label} job_id"),
        )
        if key in rows:
            raise CandidateDashboardProjectionsError(
                f"candidate {label} rows must be unique per job"
            )
        rows[key] = row
    return rows


def _active_deleted(
    candidate: sqlite3.Connection,
) -> dict[tuple[str, str], str]:
    return {
        (
            _required_text(tenant_id, "deleted-job tenant_id"),
            _required_uuid(job_id, "deleted-job job_id"),
        ): _required_text(deleted_at, "deleted-job deleted_at")
        for tenant_id, job_id, deleted_at in candidate.execute(
            """
            SELECT tenant_id, job_id, deleted_at
            FROM jobctrl_deleted_jobs
            WHERE restored_at IS NULL
               OR julianday(restored_at) <= julianday(deleted_at)
            ORDER BY tenant_id, job_id
            """
        ).fetchall()
    }


def _active_hidden(candidate: sqlite3.Connection) -> set[tuple[str, str]]:
    return {
        (
            _required_text(tenant_id, "hidden-job tenant_id"),
            _required_uuid(job_id, "hidden-job job_id"),
        )
        for tenant_id, job_id in candidate.execute(
            """
            SELECT tenant_id, job_id
            FROM jobctrl_hidden_jobs
            WHERE unhidden_at IS NULL
            ORDER BY tenant_id, job_id
            """
        ).fetchall()
    }


def _closed_jobs(candidate: sqlite3.Connection) -> set[tuple[str, str]]:
    closed: set[tuple[str, str]] = set()
    for tenant_id, job_id, active_state in candidate.execute(
        """
        SELECT tenant_id, job_id, latest_active_state
        FROM posting_snapshot_sets
        ORDER BY tenant_id, job_id
        """
    ).fetchall():
        if _text(active_state).strip().lower() in _CLOSED_STATES:
            closed.add(
                (
                    _required_text(tenant_id, "posting snapshot tenant_id"),
                    _required_uuid(job_id, "posting snapshot job_id"),
                )
            )
    return closed


def _dry_run_jobs(
    candidate: sqlite3.Connection,
    roots: set[tuple[str, str]],
) -> tuple[tuple[str, str], ...]:
    jobs: list[tuple[str, str]] = []
    for tenant_id, job_id, dry_run in candidate.execute(
        """
        SELECT tenant_id, job_id, dry_run
        FROM apply_run_projections
        ORDER BY tenant_id, run_id
        """
    ).fetchall():
        key = (
            _required_text(tenant_id, "apply-run tenant_id"),
            _required_uuid(job_id, "apply-run job_id"),
        )
        if key not in roots:
            raise CandidateDashboardProjectionsError(
                "apply-run projection must reference a canonical v7 job"
            )
        parsed_dry_run = _integer(dry_run, "apply-run dry_run")
        if parsed_dry_run not in {0, 1}:
            raise CandidateDashboardProjectionsError(
                "apply-run dry_run must be 0 or 1"
            )
        if parsed_dry_run == 1:
            jobs.append(key)
    return tuple(jobs)


def _funnel(
    active_keys: set[tuple[str, str]],
    detail_rows: Mapping[tuple[str, str], Mapping[str, object]],
) -> list[dict[str, object]]:
    counts = {
        stage: {
            "total": 0,
            "succeeded": 0,
            "running": 0,
            "pending": 0,
            "blocked": 0,
            "failed": 0,
        }
        for stage in projection_builder.STAGE_ORDER
    }
    for key in sorted(active_keys):
        stages = _json_list_of_dicts(
            detail_rows[key]["stages_json"], "job-detail stages_json"
        )
        for stage_row in stages:
            stage = stage_row.get("stage")
            state = stage_row.get("state")
            if not isinstance(stage, str) or stage not in counts:
                raise CandidateDashboardProjectionsError(
                    "job-detail stage must be a canonical stage name"
                )
            if not isinstance(state, str) or state not in _STAGE_STATES:
                raise CandidateDashboardProjectionsError(
                    "job-detail state must be a canonical stage state"
                )
            if state == "skipped":
                continue
            counts[stage]["total"] += 1
            if state in {"failed", "exhausted"}:
                counts[stage]["failed"] += 1
            elif state in {"running", "queued"}:
                counts[stage]["running"] += 1
            elif state == "blocked":
                counts[stage]["blocked"] += 1
            elif state == "succeeded":
                counts[stage]["succeeded"] += 1
            else:
                counts[stage]["pending"] += 1
    return [
        {"stage": stage, **counts[stage]} for stage in projection_builder.STAGE_ORDER
    ]


def _by_source(rows: Iterable[Mapping[str, object]]) -> list[list[object]]:
    counts: dict[str, int] = {}
    for row in rows:
        source = _optional_text(row["source"]) or "unknown"
        counts[source] = counts.get(source, 0) + 1
    return [
        [source, count]
        for source, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def _score_distribution(
    rows: Iterable[Mapping[str, object]],
) -> list[list[int]]:
    counts: dict[int, int] = {}
    for row in rows:
        score = _optional_integer(row["fit_score"], "job-list fit_score")
        if score is not None:
            counts[score] = counts.get(score, 0) + 1
    return [[score, counts[score]] for score in sorted(counts, reverse=True)]


def _is_applied(row: Mapping[str, object]) -> bool:
    return bool(_optional_text(row["applied_at"])) or _text(
        row["apply_status"]
    ) == "applied"


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_list_of_dicts(value: object, label: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(_required_text(value, label))
    except json.JSONDecodeError as exc:
        raise CandidateDashboardProjectionsError(f"{label} must be valid JSON") from exc
    if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed):
        raise CandidateDashboardProjectionsError(
            f"{label} must be a JSON array of objects"
        )
    return parsed


def _required_uuid(value: object, label: str) -> str:
    text = _required_text(value, label)
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError) as exc:
        raise CandidateDashboardProjectionsError(
            f"{label} must be a canonical UUID"
        ) from exc
    if str(parsed) != text or parsed.version != 4:
        raise CandidateDashboardProjectionsError(
            f"{label} must be a canonical UUIDv4"
        )
    return text


def _required_text(value: object, label: str) -> str:
    text = _text(value).strip()
    if not text:
        raise CandidateDashboardProjectionsError(f"{label} must not be empty")
    return text


def _optional_text(value: object) -> str | None:
    text = _text(value).strip()
    return text or None


def _text(value: object) -> str:
    return "" if value is None else str(value)


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CandidateDashboardProjectionsError(f"{label} must be an integer")
    return value


def _optional_integer(value: object, label: str) -> int | None:
    if value is None or value == "":
        return None
    return _integer(value, label)
