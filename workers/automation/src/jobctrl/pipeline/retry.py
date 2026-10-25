"""Application service for explicit enrichment retries and their bulk cohort.

The transaction owns canonical reset decisions, stage fencing and durable events.
Other stages join only to retain the API's atomic mixed-stage bulk reset; their
aggregate-specific commands remain in their existing owners.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import sqlite3

from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.job_locators import resolve_job_locator
from jobctrl.state import MAX_ATTEMPTS, STAGE_ORDER, record_job_event, utc_now


@dataclass
class _DeferredEvents:
    events: list[DomainEvent] = field(default_factory=list)

    def publish(self, event: DomainEvent) -> None:
        self.events.append(event)


def reset_retry_stages(
    conn: sqlite3.Connection,
    targets: list[tuple[str, str]],
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    reset_attempts: bool = False,
    only_failed: bool = False,
    _allow_apply_only: bool = False,
) -> list[dict[str, str]]:
    """Reset one Enrich job or an API bulk cohort containing Enrich atomically.

    Acquire the writer before reading to avoid restoring stale aggregate data.
    Inherited transactions retain commit/rollback ownership: a savepoint isolates
    our changes, and their durable events are consumed after the caller commits.
    """
    if not targets:
        return []
    if any(stage not in STAGE_ORDER for _, stage in targets):
        raise ValueError("unknown retry stage")
    if not any(stage == "enrich" for _, stage in targets) and not (
        _allow_apply_only and all(stage == "apply" for _, stage in targets)
    ):
        raise ValueError("this reset service requires an enrichment target")

    owned = not conn.in_transaction
    if owned:
        conn.execute("BEGIN IMMEDIATE")
    else:
        conn.execute("SAVEPOINT enrichment_retry")
    events = _DeferredEvents()
    results: list[dict[str, str]] = []
    try:
        seen: set[tuple[str, str]] = set()
        for locator, stage in targets:
            identity = resolve_job_locator(conn, str(tenant_id), locator)
            if identity is None:
                raise ValueError("no unique matching job found")
            job_id = canonical_job_id(identity[0])
            if (str(job_id), stage) in seen:
                continue
            seen.add((str(job_id), stage))
            row = conn.execute(
                "SELECT state, attempt_count FROM job_stage_states "
                "WHERE tenant_id = ? AND job_id = ? AND stage = ?",
                (str(tenant_id), str(job_id), stage),
            ).fetchone()
            if only_failed and (row is None or row[0] not in {"failed", "exhausted"}):
                raise ValueError("retry target changed; refresh and retry")
            release_payload = {}
            if stage == "apply":
                from jobctrl.infrastructure.apply_controls import explicit_apply_reset_payload

                release_payload = explicit_apply_reset_payload(conn, tenant_id=tenant_id, job_id=job_id)
            clear_attempts = reset_attempts or (row is not None and row[0] == "exhausted")
            now = utc_now()
            if stage == "enrich":
                repo = SqliteEnrichmentRepository(conn)
                aggregate = repo.load(tenant_id, job_id)
                if aggregate is not None:
                    repo.save(aggregate.reset(reset_at=now), commit=False)
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
                message=f"Retry reset requested for {stage}",
                payload={"reset_attempts": clear_attempts, **release_payload}, occurred_at=now,
                publisher=events,
            )
            results.append({"jobId": str(job_id), "jobUrl": identity[1], "stage": stage})
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
