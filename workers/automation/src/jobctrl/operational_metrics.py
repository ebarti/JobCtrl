"""Structured operational attempt metrics for pipeline boundaries.

The rows written here are append-only operational facts.  They deliberately
avoid deriving critical dashboard metrics from free-form event messages while
still keeping the existing ``job_events`` stream available for activity feeds
and SSE invalidation.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT


SCRAPE_STAGES = {"discover", "enrich", "apply"}


@dataclass(frozen=True)
class FailureClassification:
    failure_category: str
    is_operational_failure: bool
    is_scrape_failure: bool
    is_retryable: bool


def ensure_operational_metric_tables(conn: sqlite3.Connection) -> list[str]:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS operational_attempt_metrics (
            metric_id               INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            occurred_at             TEXT NOT NULL,
            stage                   TEXT NOT NULL,
            source_id               TEXT,
            source_kind             TEXT,
            source_priority         TEXT,
            source_role             TEXT,
            adapter                 TEXT,
            attempt_kind            TEXT NOT NULL,
            outcome                 TEXT NOT NULL,
            failure_category        TEXT,
            is_operational_failure  INTEGER NOT NULL DEFAULT 0,
            is_scrape_failure       INTEGER NOT NULL DEFAULT 0,
            is_retryable            INTEGER NOT NULL DEFAULT 1,
            run_id                  TEXT,
            job_id                  TEXT,
            duration_ms             INTEGER,
            total_count             INTEGER,
            new_count               INTEGER,
            existing_count          INTEGER,
            observed_count          INTEGER,
            duplicate_count         INTEGER,
            error_class             TEXT,
            error_message           TEXT,
            metadata_json           TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_operational_attempt_metrics_stage_time
        ON operational_attempt_metrics(tenant_id, stage, occurred_at DESC, metric_id DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_operational_attempt_metrics_source_time
        ON operational_attempt_metrics(tenant_id, source_id, occurred_at DESC, metric_id DESC)
        """
    )
    return ["operational_attempt_metrics"]


def classify_failure(
    *,
    stage: str,
    adapter: str | None = None,
    error_class: str | None = None,
    error_message: str | None = None,
) -> FailureClassification:
    normalized_class = (error_class or "").strip()
    normalized_message = (error_message or "").strip()
    message_lower = normalized_message.lower()
    class_lower = normalized_class.lower()
    stage_lower = stage.lower()
    adapter_lower = (adapter or "").lower()

    if normalized_class == "TypeError" and (
        "lambda" in message_lower or "<lambda>" in normalized_message or "unexpected keyword argument" in message_lower
    ):
        return FailureClassification("test_harness", False, False, False)
    if "aborted_for_code_reload" in message_lower or class_lower == "aborted_for_code_reload":
        return FailureClassification("code_reload", False, False, False)
    if message_lower.startswith("manual_abort") or class_lower.startswith("manual_abort"):
        return FailureClassification("manual_abort", False, False, False)
    if "no live process found" in message_lower and "verification cleanup" in message_lower:
        return FailureClassification("process_cleanup_runtime", True, False, True)
    if normalized_class == "TimeoutError" or class_lower.endswith("timeouterror"):
        return FailureClassification(
            "timeout",
            True,
            stage_lower in SCRAPE_STAGES
            or adapter_lower in {"browser", "jobspy", "workday", "smartextract", "ats_api"},
            True,
        )
    if not normalized_class and not normalized_message:
        return FailureClassification("unknown", True, False, True)
    return FailureClassification(
        _snake_case(normalized_class or normalized_message or "unknown"),
        True,
        stage_lower in SCRAPE_STAGES,
        True,
    )


def record_operational_attempt_metric(
    conn: sqlite3.Connection,
    *,
    stage: str,
    attempt_kind: str,
    outcome: str,
    source_id: str | None = None,
    source_kind: str | None = None,
    source_priority: str | None = None,
    source_role: str | None = None,
    adapter: str | None = None,
    run_id: str | None = None,
    tenant_id: str | None = None,
    job_id: str | None = None,
    # Accepted for legacy callers at an explicit locator boundary, but never
    # persisted in the broad operational read model.
    job_url: str | None = None,
    duration_ms: int | None = None,
    counts: dict[str, Any] | None = None,
    error_class: str | None = None,
    error_message: str | None = None,
    failure_category: str | None = None,
    is_operational_failure: bool | None = None,
    is_scrape_failure: bool | None = None,
    is_retryable: bool | None = None,
    metadata: dict[str, Any] | None = None,
    occurred_at: str | None = None,
) -> None:
    ensure_operational_metric_tables(conn)
    counts = counts or {}
    stable_job_id = canonical_job_id(str(job_id)) if job_id is not None else None
    terminal_failure = outcome in {"failed", "partial_failed"}
    classification = (
        classify_failure(
            stage=stage,
            adapter=adapter,
            error_class=error_class,
            error_message=error_message,
        )
        if terminal_failure
        else None
    )
    conn.execute(
        """
        INSERT INTO operational_attempt_metrics (
            tenant_id, occurred_at, stage, source_id, source_kind,
            source_priority, source_role, adapter, attempt_kind, outcome,
            failure_category, is_operational_failure, is_scrape_failure,
            is_retryable, run_id, job_id, duration_ms, total_count,
            new_count, existing_count, observed_count, duplicate_count,
            error_class, error_message, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id or LOCAL_TENANT),
            occurred_at or utc_now(),
            stage,
            source_id,
            source_kind,
            source_priority,
            source_role,
            adapter,
            attempt_kind,
            outcome,
            failure_category
            if failure_category is not None
            else (classification.failure_category if classification else None),
            _bool_int(
                is_operational_failure
                if is_operational_failure is not None
                else (classification.is_operational_failure if classification else False)
            ),
            _bool_int(
                is_scrape_failure
                if is_scrape_failure is not None
                else (classification.is_scrape_failure if classification else False)
            ),
            _bool_int(
                is_retryable if is_retryable is not None else (classification.is_retryable if classification else True)
            ),
            run_id,
            str(stable_job_id) if stable_job_id is not None else None,
            duration_ms,
            _count(counts, "total"),
            _count(counts, "new_jobs", "newJobs", "new"),
            _count(counts, "existing_jobs", "existingJobs", "existing"),
            _count(counts, "observed_jobs", "observedJobs", "observed"),
            _count(counts, "duplicate_jobs", "duplicateJobs", "duplicates"),
            error_class,
            error_message,
            json.dumps(metadata or {}),
        ),
    )


def _bool_int(value: bool) -> int:
    return 1 if value else 0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _count(counts: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        if key in counts and counts[key] is not None:
            try:
                return int(counts[key])
            except (TypeError, ValueError):
                return None
    return None


def _snake_case(value: str) -> str:
    raw = value.strip()
    if raw.upper() == raw:
        return "_".join(part.lower() for part in re.split(r"[^A-Za-z0-9]+", raw) if part) or "unknown"
    normalized = "".join(
        f"_{char.lower()}" if char.isupper() else (char.lower() if char.isalnum() else "_") for char in raw
    )
    return "_".join(part for part in normalized.split("_") if part) or "unknown"
