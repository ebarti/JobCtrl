"""SqliteApplyRunRepository — local-mode adapter for the Apply context.

Persists ``ApplyRun`` aggregates to the existing ``apply_runs`` +
``apply_run_events`` tables (created by
``database.ensure_observability_tables``). The aggregate identity is
``(tenant_id, run_id)`` and the table primary key is ``run_id``;
local mode collapses ``TenantId`` onto the legacy single-tenant
schema (``tenant_id`` is stored in the ``extra_json`` column for
forward-compat with the multi-tenant migration).

The repository is an upsert on every save — versioning is per-event
inside the ``apply_run_events`` table, not per-row.

Design choice: the repository OWNS the round-trip (it does NOT
delegate to ``apply/telemetry.py``). The legacy telemetry helpers
remain in place as a free-form telemetry sink for the legacy
launcher, but new code goes through this repository so the aggregate
boundary is clean. Both paths write to the same tables, so the
existing ``read-model.ts`` queries continue to see new rows.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Mapping

from jobhunter.database import ensure_observability_tables, get_connection
from jobhunter.domain.apply.aggregate import (
    ApplyRun,
    ApplyRunStatus,
    submission_result_from_dict,
)
from jobhunter.domain.apply.entities import ApplyRunEvent
from jobhunter.domain.apply.value_objects import (
    ApplyRunId,
    SUBMISSION_RESULT_TYPES,
    TokenUsage,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId

log = logging.getLogger(__name__)


_ACTIVE_STATUSES: tuple[str, ...] = (
    ApplyRunStatus.STARTING,
    ApplyRunStatus.IN_PROGRESS,
)


class SqliteApplyRunRepository:
    """SQLite-backed implementation of ``ApplyRunRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly so consumers (including the TS
    read-model) see the row immediately. Tests inject their own
    connection via the constructor for isolation.
    """

    def __init__(self, conn: sqlite3.Connection | None = None) -> None:
        self._conn = conn if conn is not None else get_connection()
        ensure_observability_tables(self._conn)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, run_id: ApplyRunId) -> ApplyRun | None:
        row = self._conn.execute(
            """
            SELECT run_id, job_url, site, title, application_url,
                   worker_id, worker_name, model, pid, chrome_pid,
                   status, result, error, dry_run, headless, attempts,
                   started_at, updated_at, finished_at, duration_ms,
                   prompt_path, mcp_config_path, log_path, output_path,
                   resume_path, cover_letter_path, task_id,
                   input_tokens, output_tokens, cache_read_tokens,
                   cache_create_tokens, cost_usd, extra_json
            FROM apply_runs
            WHERE run_id = ?
            LIMIT 1
            """,
            (str(run_id),),
        ).fetchone()
        if row is None:
            return None
        events = self._load_events(str(run_id))
        return _row_to_apply_run(row, tenant_id, events)

    def list_recent(
        self, tenant_id: TenantId, *, limit: int = 50
    ) -> list[ApplyRun]:
        rows = self._conn.execute(
            """
            SELECT run_id, job_url, site, title, application_url,
                   worker_id, worker_name, model, pid, chrome_pid,
                   status, result, error, dry_run, headless, attempts,
                   started_at, updated_at, finished_at, duration_ms,
                   prompt_path, mcp_config_path, log_path, output_path,
                   resume_path, cover_letter_path, task_id,
                   input_tokens, output_tokens, cache_read_tokens,
                   cache_create_tokens, cost_usd, extra_json
            FROM apply_runs
            ORDER BY started_at DESC, run_id DESC
            LIMIT ?
            """,
            (max(int(limit), 0),),
        ).fetchall()
        out: list[ApplyRun] = []
        for row in rows:
            events = self._load_events(str(row["run_id"]))
            out.append(_row_to_apply_run(row, tenant_id, events))
        return out

    def list_active(self, tenant_id: TenantId) -> list[ApplyRun]:
        placeholders = ",".join("?" for _ in _ACTIVE_STATUSES)
        rows = self._conn.execute(
            f"""
            SELECT run_id, job_url, site, title, application_url,
                   worker_id, worker_name, model, pid, chrome_pid,
                   status, result, error, dry_run, headless, attempts,
                   started_at, updated_at, finished_at, duration_ms,
                   prompt_path, mcp_config_path, log_path, output_path,
                   resume_path, cover_letter_path, task_id,
                   input_tokens, output_tokens, cache_read_tokens,
                   cache_create_tokens, cost_usd, extra_json
            FROM apply_runs
            WHERE status IN ({placeholders})
            ORDER BY started_at DESC, run_id DESC
            """,
            _ACTIVE_STATUSES,
        ).fetchall()
        out: list[ApplyRun] = []
        for row in rows:
            events = self._load_events(str(row["run_id"]))
            out.append(_row_to_apply_run(row, tenant_id, events))
        return out

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, run: ApplyRun) -> None:
        record = self._aggregate_to_row(run, conn=self._conn)
        columns = list(record.keys())
        placeholders = ", ".join("?" for _ in columns)
        update_cols = ", ".join(
            f"{col} = excluded.{col}"
            for col in columns
            if col not in {"run_id", "started_at"}
        )
        self._conn.execute(
            f"""
            INSERT INTO apply_runs ({", ".join(columns)})
            VALUES ({placeholders})
            ON CONFLICT(run_id) DO UPDATE SET
                {update_cols}
            """,
            [record[col] for col in columns],
        )
        # Replace the event timeline. The aggregate's ``events`` tuple
        # is the source of truth; we delete then re-insert so the
        # round-trip is exact (event_id collisions otherwise would
        # leave stale rows behind).
        self._conn.execute(
            "DELETE FROM apply_run_events WHERE run_id = ?",
            (str(run.run_id),),
        )
        for event in run.events:
            self._conn.execute(
                """
                INSERT INTO apply_run_events (
                    run_id, occurred_at, worker_id, event_type,
                    level, message, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(run.run_id),
                    event.occurred_at,
                    run.worker_id,
                    event.event_type,
                    event.level,
                    event.message,
                    json.dumps(dict(event.payload), sort_keys=True),
                ),
            )
        self._conn.commit()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_events(self, run_id: str) -> tuple[ApplyRunEvent, ...]:
        rows = self._conn.execute(
            """
            SELECT event_type, level, message, payload_json, occurred_at
            FROM apply_run_events
            WHERE run_id = ?
            ORDER BY event_id ASC
            """,
            (run_id,),
        ).fetchall()
        events: list[ApplyRunEvent] = []
        for index, row in enumerate(rows, start=1):
            payload_json = row["payload_json"]
            try:
                payload = json.loads(payload_json) if payload_json else {}
            except json.JSONDecodeError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {"raw": payload}
            events.append(
                ApplyRunEvent(
                    event_id=index,
                    event_type=str(row["event_type"]),
                    level=str(row["level"] or "info"),
                    message=row["message"],
                    payload=payload,
                    occurred_at=str(row["occurred_at"] or ""),
                )
            )
        return tuple(events)

    @staticmethod
    def _aggregate_to_row(
        run: ApplyRun,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        # The legacy ``apply_runs`` schema is wide. Map every column
        # the aggregate has a fact for; surface aggregate-only fields
        # (tenant_id, submission_result variant) through the
        # ``extra_json`` blob so the schema migration to a tenant-aware
        # table can drop the JSON later without rewriting the
        # aggregate.
        #
        # Round-1 review H1: hydrate the denormalised ``site`` /
        # ``title`` / ``application_url`` columns from the parent
        # ``jobs`` row so the read-side consumers (web "Apply runs"
        # widget via ``read-model.recentApplyRuns`` and the CLI
        # ``jobhunter runs`` table via ``cli._normalize_run``) display
        # real values instead of "Untitled" / "Unknown company".
        # The aggregate itself doesn't carry these fields by design
        # (they belong to the Job aggregate); we read them at write
        # time from the SQLite row that's about to be linked. If the
        # parent ``jobs`` row is missing (e.g. a unit-test seeded the
        # apply_runs table without seeding ``jobs``) we leave the
        # columns NULL — same behaviour as before.
        site_value: str | None = None
        title_value: str | None = None
        application_url_value: str | None = None
        if conn is not None:
            try:
                meta = conn.execute(
                    "SELECT title, site, application_url FROM jobs WHERE url = ? LIMIT 1",
                    (str(run.job_id),),
                ).fetchone()
            except sqlite3.OperationalError:
                meta = None
            if meta is not None:
                title_value = meta["title"] if meta["title"] is not None else None
                site_value = meta["site"] if meta["site"] is not None else None
                application_url_value = (
                    meta["application_url"]
                    if meta["application_url"] is not None
                    else None
                )

        extra: dict[str, Any] = {
            "tenant_id": str(run.tenant_id),
        }
        if run.submission_result is not None:
            extra["submission_result"] = _submission_result_to_dict(
                run.submission_result
            )
        token_usage = run.token_usage
        return {
            "run_id": str(run.run_id),
            "job_url": str(run.job_id),
            "site": site_value,
            "title": title_value,
            "application_url": application_url_value,
            "worker_id": run.worker_id,
            "worker_name": None,
            "model": run.model,
            "pid": None,
            "chrome_pid": None,
            "status": run.status,
            "result": (
                run.submission_result.kind
                if run.submission_result is not None
                else None
            ),
            "error": _result_error(run.submission_result),
            "dry_run": int(bool(run.dry_run)),
            "headless": int(bool(run.headless)),
            "attempts": int(run.attempts),
            "started_at": run.started_at,
            "updated_at": (run.finished_at or run.started_at),
            "finished_at": run.finished_at,
            "duration_ms": run.duration_ms,
            "prompt_path": None,
            "mcp_config_path": None,
            "log_path": None,
            "output_path": None,
            "resume_path": None,
            "cover_letter_path": None,
            "task_id": None,
            "input_tokens": token_usage.input if token_usage else None,
            "output_tokens": token_usage.output if token_usage else None,
            "cache_read_tokens": token_usage.cache_read if token_usage else None,
            "cache_create_tokens": token_usage.cache_create if token_usage else None,
            "cost_usd": token_usage.cost_usd if token_usage else None,
            "extra_json": json.dumps(extra, sort_keys=True, default=str),
        }


def _submission_result_to_dict(result: Any) -> dict[str, Any]:
    """Mirror ``aggregate._result_to_dict`` (kept here to avoid a circular import)."""
    payload: dict[str, Any] = {"kind": result.kind}
    for attr in (
        "applied_at",
        "verification_confidence",
        "error",
        "retryable",
        "details",
        "reason",
        "navigated_to",
    ):
        if hasattr(result, attr):
            payload[attr] = getattr(result, attr)
    return payload


def _result_error(result: Any) -> str | None:
    if result is None:
        return None
    if hasattr(result, "error"):
        return getattr(result, "error")
    if hasattr(result, "reason"):
        return getattr(result, "reason")
    if hasattr(result, "details"):
        return getattr(result, "details")
    return None


def _row_to_apply_run(
    row: Any,
    tenant_id: TenantId | None,
    events: tuple[ApplyRunEvent, ...],
) -> ApplyRun:
    # The schema may have legacy rows where ``tenant_id`` lives in
    # ``extra_json`` (forward-compat) or rows where ``submission_result``
    # is missing because the legacy launcher wrote the row. We
    # round-trip whatever's there and fall back to LOCAL_TENANT.
    extra_blob = row["extra_json"] if isinstance(row, sqlite3.Row) else None
    extra: Mapping[str, Any]
    try:
        extra = json.loads(extra_blob) if extra_blob else {}
    except (json.JSONDecodeError, TypeError):
        extra = {}
    if not isinstance(extra, Mapping):
        extra = {}

    resolved_tenant: TenantId
    if tenant_id is not None:
        resolved_tenant = tenant_id
    elif extra.get("tenant_id"):
        resolved_tenant = TenantId(str(extra["tenant_id"]))
    else:
        resolved_tenant = LOCAL_TENANT

    submission = None
    raw_result_blob = extra.get("submission_result") if isinstance(extra, Mapping) else None
    if isinstance(raw_result_blob, Mapping):
        try:
            submission = submission_result_from_dict(raw_result_blob)
        except ValueError:
            submission = None

    # If the row carries a terminal status but no submission_result
    # in extra_json, synthesise a Failed variant from the legacy
    # ``error`` column so the aggregate's invariants stay green.
    status = str(row["status"] or ApplyRunStatus.STARTING)
    if submission is None and status not in (
        ApplyRunStatus.STARTING,
        ApplyRunStatus.IN_PROGRESS,
    ):
        from jobhunter.domain.apply.value_objects import Failed

        submission = Failed(
            error=str(row["error"] or row["result"] or "unknown"),
            retryable=True,
        )

    token_usage: TokenUsage | None = None
    if (
        row["input_tokens"] is not None
        or row["output_tokens"] is not None
        or row["cost_usd"] is not None
    ):
        token_usage = TokenUsage(
            input=int(row["input_tokens"] or 0),
            output=int(row["output_tokens"] or 0),
            cache_read=int(row["cache_read_tokens"] or 0),
            cache_create=int(row["cache_create_tokens"] or 0),
            cost_usd=float(row["cost_usd"] or 0.0),
        )

    # Finish_at is required for terminal states by the aggregate; if
    # the row is terminal but finished_at is NULL (legacy rows), use
    # updated_at as a best-effort fallback.
    finished_at = row["finished_at"]
    if (
        finished_at is None
        and status not in (ApplyRunStatus.STARTING, ApplyRunStatus.IN_PROGRESS)
    ):
        finished_at = row["updated_at"] or row["started_at"]

    # Coerce dry_run / headless: stored as INTEGER 0/1 historically.
    dry_run = bool(row["dry_run"]) if row["dry_run"] is not None else False
    headless = bool(row["headless"]) if row["headless"] is not None else False

    # Defensive: a dry-run aggregate cannot end with Applied — if a
    # legacy row violates this, downgrade to DryRunComplete so the
    # invariant holds and load() doesn't raise.
    if (
        dry_run
        and submission is not None
        and submission.kind == "applied"
    ):
        from jobhunter.domain.apply.value_objects import DryRunComplete

        submission = DryRunComplete(navigated_to="")
        status = ApplyRunStatus.DRY_RUN_COMPLETE

    if submission is not None and not isinstance(submission, SUBMISSION_RESULT_TYPES):
        submission = None

    return ApplyRun(
        tenant_id=resolved_tenant,
        run_id=ApplyRunId(str(row["run_id"])),
        job_id=JobId(str(row["job_url"])),
        status=status,
        started_at=str(row["started_at"] or ""),
        finished_at=(str(finished_at) if finished_at is not None else None),
        submission_result=submission,
        events=events,
        token_usage=token_usage,
        dry_run=dry_run,
        headless=headless,
        attempts=int(row["attempts"] or 1),
        model=(str(row["model"]) if row["model"] else None),
        worker_id=(int(row["worker_id"]) if row["worker_id"] is not None else None),
        duration_ms=(
            int(row["duration_ms"]) if row["duration_ms"] is not None else None
        ),
    )


__all__ = ["SqliteApplyRunRepository"]
