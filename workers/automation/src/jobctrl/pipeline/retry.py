"""Application service for explicit stage retries and atomic bulk cohorts."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
import hashlib
import json
import sqlite3

from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.job_locators import resolve_job_locator
from jobctrl.state import MAX_ATTEMPTS, STAGE_ORDER, _reset_materials_artifacts, record_job_event, utc_now


@dataclass
class _DeferredEvents:
    events: list[DomainEvent] = field(default_factory=list)

    def publish(self, event: DomainEvent) -> None:
        self.events.append(event)


class RetrySelectionChanged(ValueError):
    """An observed bulk retry target no longer has the selected identity."""

    def __init__(self) -> None:
        super().__init__("retry target changed; refresh and retry")


class ApplyResetRefused(ValueError):
    """The writer found retained Apply authority that an explicit retry cannot release."""


def reset_retry_stages(
    conn: sqlite3.Connection,
    targets: list[tuple[str, str]],
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    reset_attempts: bool = False,
    only_failed: bool = False,
    expected_fingerprints: Mapping[tuple[str, str], str] | None = None,
    require_selected_failed_stage: bool = False,
) -> list[dict[str, str | bool]]:
    """Reset one or more stages and their owned aggregates atomically.

    Acquire the writer before reading to avoid restoring stale aggregate data.
    Inherited transactions retain commit/rollback ownership: a savepoint isolates
    our changes, and their durable events are consumed after the caller commits.
    """
    if not all(isinstance(option, bool) for option in (reset_attempts, only_failed, require_selected_failed_stage)):
        raise ValueError("retry options must be boolean")
    if not targets:
        return []
    if any(stage not in STAGE_ORDER for _, stage in targets):
        raise ValueError("unknown retry stage")
    owned = not conn.in_transaction
    if owned:
        conn.execute("BEGIN IMMEDIATE")
    else:
        conn.execute("SAVEPOINT enrichment_retry")
    events = _DeferredEvents()
    results: list[dict[str, str | bool]] = []
    try:
        if not owned:
            # A caller's deferred transaction must become a writer before any
            # owner or aggregate is read. Preserve the caller's commit scope.
            conn.execute("UPDATE job_stage_states SET version=version WHERE 0")
        seen: set[tuple[str, str]] = set()
        for locator, stage in targets:
            identity = resolve_job_locator(conn, str(tenant_id), locator)
            if identity is None:
                if expected_fingerprints is not None:
                    raise RetrySelectionChanged()
                raise ValueError("no unique matching job found")
            job_id = canonical_job_id(identity[0])
            if (str(job_id), stage) in seen:
                continue
            seen.add((str(job_id), stage))
            if expected_fingerprints is not None:
                expected = expected_fingerprints.get((str(job_id), stage))
                actual = retry_selection_fingerprint(
                    conn, str(tenant_id), str(job_id), stage,
                    include_job_lifecycle=require_selected_failed_stage,
                )
                if not expected or actual != expected:
                    raise RetrySelectionChanged()
            if only_failed and require_selected_failed_stage and (
                not _is_active_retry_job(conn, str(tenant_id), str(job_id))
                or _selected_failed_stage(conn, str(tenant_id), str(job_id)) != stage
            ):
                raise RetrySelectionChanged()
            row = conn.execute(
                "SELECT state, attempt_count, retryable FROM job_stage_states "
                "WHERE tenant_id = ? AND job_id = ? AND stage = ?",
                (str(tenant_id), str(job_id), stage),
            ).fetchone()
            if only_failed and (
                row is None or row[0] not in {"failed", "exhausted"}
                or not _retryable_failure(conn, str(tenant_id), str(job_id), stage, row)
            ):
                raise RetrySelectionChanged()
            release_payload = {}
            if stage == "apply":
                from jobctrl.infrastructure.apply_controls import explicit_apply_reset_payload

                try:
                    release_payload = explicit_apply_reset_payload(conn, tenant_id=tenant_id, job_id=job_id)
                except ValueError as error:
                    raise ApplyResetRefused(str(error)) from error
            clear_attempts = reset_attempts or (row is not None and row[0] == "exhausted")
            now = utc_now()
            if stage == "enrich":
                repo = SqliteEnrichmentRepository(conn)
                aggregate = repo.load(tenant_id, job_id)
                if aggregate is not None:
                    repo.save(aggregate.reset(reset_at=now), commit=False)
            elif stage in {"tailor", "cover"}:
                _reset_materials_artifacts(conn, tenant_id=tenant_id, job_id=job_id, stage=stage)
            retailor_required = _replacement_requires_retailor(conn, str(tenant_id), str(job_id), stage)
            conn.execute(
                """
                INSERT INTO job_stage_states (
                    tenant_id, job_id, stage, state, attempt_count, max_attempts,
                    updated_at, retryable, blocked_by_json, version
                ) VALUES (?, ?, ?, 'pending', ?, ?, ?, 1, '[]', 1)
                ON CONFLICT(tenant_id, job_id, stage) DO UPDATE SET
                    state = 'pending', attempt_count = excluded.attempt_count,
                    updated_at = excluded.updated_at, started_at = NULL,
                    finished_at = NULL, duration_ms = NULL, error_code = NULL,
                    error_message = NULL, retryable = 1, blocked_by_json = '[]',
                    next_action = NULL, metadata_json = NULL,
                    version = job_stage_states.version + 1
                """,
                (str(tenant_id), str(job_id), stage,
                 0 if clear_attempts or row is None else row[1], MAX_ATTEMPTS[stage], now),
            )
            record_job_event(
                conn, job_id, stage, "StageReset", tenant_id=tenant_id,
                message=(
                    f"Retry reset requested for {stage}; approved materials remain available. "
                    "Use explicit re-tailor to create a replacement."
                    if retailor_required else f"Retry reset requested for {stage}"
                ),
                payload={"reset_attempts": clear_attempts, **release_payload}, occurred_at=now,
                publisher=events,
            )
            result: dict[str, str | bool] = {"jobId": str(job_id), "jobUrl": identity[1], "stage": stage}
            if retailor_required:
                result["retailorRequired"] = True
            results.append(result)
        if owned:
            conn.commit()
        else:
            conn.execute("RELEASE SAVEPOINT enrichment_retry")
    except BaseException:
        if owned:
            conn.rollback()
        else:
            conn.execute("ROLLBACK TO SAVEPOINT enrichment_retry")
            conn.execute("RELEASE SAVEPOINT enrichment_retry")
        raise
    if owned:
        publisher = get_default_publisher()
        for event in events.events:
            publisher.publish(event)
    return results


def retry_selection_fingerprint(
    conn: sqlite3.Connection, tenant_id: str, job_id: str, stage: str, *, include_job_lifecycle: bool = False,
) -> str | None:
    """Fingerprint selected identity, and optionally its job lifecycle, under the writer."""
    stage_columns = (
        "s.state,CAST(s.attempt_count AS INTEGER),CAST(s.max_attempts AS INTEGER),"
        "s.started_at,s.updated_at,s.finished_at,CAST(s.duration_ms AS INTEGER),s.error_code,s.error_message,"
        "CAST(s.retryable AS INTEGER),s.blocked_by_json,s.next_action,s.metadata_json,CAST(s.version AS INTEGER),"
    )
    if include_job_lifecycle:
        # Start from the job so absence of a stage is itself a bound identity.
        sql = (
            "SELECT CASE WHEN s.job_id IS NULL THEN 0 ELSE 1 END," + stage_columns
            + "COALESCE((SELECT MAX(e.event_id) FROM job_events e WHERE e.tenant_id=j.tenant_id "
            "AND e.job_id=j.job_id AND e.stage=?),0)"
            ",(SELECT h.hidden_at FROM jobctrl_hidden_jobs h WHERE h.tenant_id=j.tenant_id AND h.job_id=j.job_id)"
            ",(SELECT h.unhidden_at FROM jobctrl_hidden_jobs h WHERE h.tenant_id=j.tenant_id AND h.job_id=j.job_id)"
            ",(SELECT d.deleted_at FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id)"
            ",(SELECT d.restored_at FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id)"
            ",(SELECT p.latest_active_state FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id)"
            ",(SELECT CAST(p.latest_snapshot_version AS INTEGER) FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id)"
            ",(SELECT p.updated_at FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id)"
            ",COALESCE((SELECT MAX(e.event_id) FROM job_events e WHERE e.tenant_id=j.tenant_id AND e.job_id=j.job_id "
            "AND e.event_type IN ('JobHidden','JobUnhidden','JobDeleted','JobRestored','JobActiveStateChanged',"
            "'PostingSnapshotStatePersisted')),0)"
            ",(SELECT CAST(r.revision AS TEXT) FROM job_lifecycle_revisions r WHERE r.tenant_id=j.tenant_id AND r.job_id=j.job_id) "
            "FROM jobs j LEFT JOIN job_stage_states s ON s.tenant_id=j.tenant_id AND s.job_id=j.job_id AND s.stage=? "
            "WHERE j.tenant_id=? AND j.job_id=?"
        )
        params = (stage, stage, tenant_id, job_id)
    else:
        # Preserve the old enrichment RPC's bound fingerprint format.
        sql = (
            "SELECT " + stage_columns
            + "COALESCE((SELECT MAX(e.event_id) FROM job_events e "
            "WHERE e.tenant_id=s.tenant_id AND e.job_id=s.job_id AND e.stage=s.stage),0) "
            "FROM job_stage_states s WHERE s.tenant_id=? AND s.job_id=? AND s.stage=?"
        )
        params = (tenant_id, job_id, stage)
    row = conn.execute(sql, params).fetchone()
    if row is None or (include_job_lifecycle and row[-1] is None):
        return None
    encoded = json.dumps(list(row), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _is_active_retry_job(conn: sqlite3.Connection, tenant_id: str, job_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM jobs j WHERE j.tenant_id=? AND j.job_id=? "
        "AND NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.tenant_id=j.tenant_id "
        "AND h.job_id=j.job_id AND h.unhidden_at IS NULL) "
        "AND NOT EXISTS (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id "
        "AND d.job_id=j.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at)<=julianday(d.deleted_at))) "
        "AND NOT EXISTS (SELECT 1 FROM posting_snapshot_sets p WHERE p.tenant_id=j.tenant_id AND p.job_id=j.job_id "
        "AND p.latest_active_state IN ('closed','expired','removed','location_incompatible'))",
        (tenant_id, job_id),
    ).fetchone() is not None


def _replacement_requires_retailor(conn: sqlite3.Connection, tenant_id: str, job_id: str, stage: str) -> bool:
    if stage not in {"tailor", "cover"}:
        return False
    approved_resume = conn.execute(
        "SELECT MAX(generation) FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? "
        "AND artifact_type='tailored_resume' AND status='approved'",
        (tenant_id, job_id),
    ).fetchone()[0]
    if approved_resume is None:
        return False
    if stage == "tailor":
        return True
    return conn.execute(
        "SELECT 1 FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND generation=? "
        "AND artifact_type='cover_letter' AND status='approved'",
        (tenant_id, job_id, approved_resume),
    ).fetchone() is not None


def _retryable_failure(conn: sqlite3.Connection, tenant_id: str, job_id: str, stage: str, row) -> bool:
    """Recheck the same bulk-selection policy while holding the writer."""
    if row[0] == "exhausted" or stage == "enrich":
        return True
    if row[2] == 0:
        return False
    events = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage=? "
        "AND payload_json IS NOT NULL ORDER BY event_id DESC", (tenant_id, job_id, stage),
    )
    for event in events:
        try:
            payload = json.loads(event[0])
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get("retryable"), bool):
            return payload["retryable"]
    return True


def _selected_failed_stage(conn: sqlite3.Connection, tenant_id: str, job_id: str) -> str | None:
    """Recompute the API's first retryable failed stage inside the writer."""
    rows = conn.execute(
        "SELECT stage,state,attempt_count,retryable FROM job_stage_states WHERE tenant_id=? AND job_id=?",
        (tenant_id, job_id),
    )
    stages = {row[0]: row[1:] for row in rows}
    for stage in STAGE_ORDER:
        row = stages.get(stage)
        if row is not None and row[0] in {"failed", "exhausted"} and _retryable_failure(
            conn, tenant_id, job_id, stage, row,
        ):
            return stage
    return None
