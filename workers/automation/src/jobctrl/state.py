"""Per-job pipeline state helpers.

This module provides the public API for pipeline state management.
``job_stage_states`` is the canonical source of truth for stage state —
the legacy ``jobs``-table derivation has been removed (no-strangler directive).

Stage runners write durable state/events here via ``set_stage_state``,
``record_job_event``, and ``record_job_artifact``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobctrl import config
from jobctrl.domain.events.base import create_domain_event
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.pipeline.aggregate import OptimisticLockError
from jobctrl.domain.pipeline.state_machine import is_valid_transition
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.domain.pipeline_types import deserialize_stage_state_kind

log = logging.getLogger(__name__)

STAGE_ORDER: tuple[str, ...] = ("discover", "enrich", "score", "tailor", "cover", "apply")
STATE_VALUES: tuple[str, ...] = (
    "pending",
    "queued",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "skipped",
    "exhausted",
    "needs_verification",
    "stale",
    "canceled",
)

MAX_ATTEMPTS: dict[str, int | None] = {
    "discover": None,
    "enrich": 5,
    "score": 3,
    "tailor": config.DEFAULTS["max_tailor_attempts"],
    "cover": 5,
    "apply": config.DEFAULTS["max_apply_attempts"],
}

DISCOVERY_SOURCE_PROGRESS: tuple[tuple[str, str], ...] = (
    ("jobspy", "Broad boards"),
    ("ats_api", "Canonical ATS APIs"),
    ("workday", "Workday scraper"),
    ("smartextract", "Smart extract"),
)
_DEPENDENCY_BLOCKER_MESSAGES: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "enrich": (("score", ("Enrichment has not completed.",)),),
    "score": (("tailor", ("score has not completed.",)),),
    "tailor": (
        ("cover", ("tailor has not completed.",)),
        ("apply", ("Materials are not ready.",)),
    ),
}
SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE = "SCORE_ELIGIBILITY_BLOCKED"
SCORE_ELIGIBILITY_BLOCKED_MESSAGE_PREFIX = "Score eligibility blocks tailoring"
_SCORE_ELIGIBILITY_DOWNSTREAM_STAGES: tuple[str, ...] = ("tailor", "cover", "apply")
_TERMINAL_DOWNSTREAM_STATES: frozenset[str] = frozenset({"succeeded", "skipped", "exhausted", "canceled"})


def utc_now() -> str:
    """Return the current UTC timestamp in ISO-8601 format."""
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str | None:
    if value in (None, "", [], {}):
        return None
    return json.dumps(value, sort_keys=True)


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _row_to_dict(row) -> dict[str, Any]:
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
    return {key: row[key] for key in row.keys()}


def _path_size(value: str | None) -> int | None:
    if not value:
        return None
    try:
        path = Path(value).expanduser()
        return path.stat().st_size if path.exists() else None
    except OSError:
        return None


def _duration_ms(started_at: str | None, finished_at: str | None) -> int | None:
    if not started_at or not finished_at:
        return None
    try:
        start = datetime.fromisoformat(started_at)
        finish = datetime.fromisoformat(finished_at)
    except ValueError:
        return None
    return max(0, int((finish - start).total_seconds() * 1000))


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _source_from_discovery_run_id(run_id: str) -> str:
    parts = run_id.split(":")
    if len(parts) >= 3 and parts[0] == "discovery":
        return parts[1]
    return ""


def _discovery_source_label(source: str) -> str:
    for source_id, label in DISCOVERY_SOURCE_PROGRESS:
        if source_id == source:
            return label
    return source.replace("_", " ").title() if source else "Discovery"


def _orphaned_discovery_run_internal_message(source: str) -> str:
    if source:
        return f"Discovery source {source} was left running by a prior worker and has been marked failed for retry."
    return "Discovery run was left running by a prior worker and has been marked failed for retry."


def _orphaned_discovery_run_message(source: str) -> str:
    if source:
        return f"{_discovery_source_label(source)} is ready to run again."
    return "Discover is ready to run again."


def _orphaned_pipeline_stage_message(source: str, detail: str) -> str:
    if source:
        return f"{_discovery_source_label(source)} is not running. {detail}"
    return f"Discover is not running. {detail}"


def _orphaned_discovery_progress_payload(source: str, message: str) -> dict[str, Any]:
    source_index = next(
        (index for index, (source_id, _label) in enumerate(DISCOVERY_SOURCE_PROGRESS) if source_id == source),
        -1,
    )
    if source_index < 0:
        return {}
    total = len(DISCOVERY_SOURCE_PROGRESS) + 1
    completed = max(0, min(source_index, total))
    percent = max(0, min(100, round((completed / total) * 100)))
    label = _discovery_source_label(source)
    return {
        "progress": {
            "completed": completed,
            "total": total,
            "percent": percent,
            "currentStep": label,
            "status": "failed",
            "message": message,
        }
    }


# ---------------------------------------------------------------------------
# Transition validation
# ---------------------------------------------------------------------------


def _validate_stage_transition(
    conn,
    tenant_id: TenantId,
    job_id: JobId,
    stage: str,
    target_state: str,
) -> None:
    """Check the §8.5 state machine allows the transition.

    Reads the current state from DB. If no row exists yet (INSERT path),
    the transition is always allowed. If a row exists and the state is
    already the target, the call is idempotent — also allowed.
    """
    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = ?",
        (str(tenant_id), str(job_id), stage),
    ).fetchone()
    if row is None:
        # No existing row — this is an INSERT, always valid.
        return

    current_state_str: str = row[0] if not isinstance(row, dict) else row["state"]
    if current_state_str == target_state:
        # Idempotent write — same state, always allowed.
        return

    try:
        from_kind = deserialize_stage_state_kind(current_state_str)
        to_kind = deserialize_stage_state_kind(target_state)
    except ValueError:
        # Unknown state strings — skip validation rather than crash.
        return

    if not is_valid_transition(from_kind, to_kind):
        raise ValueError(
            f"Invalid state transition for {stage}: "
            f"{current_state_str} -> {target_state} "
            f"(not allowed by the stage state machine)"
        )


# ---------------------------------------------------------------------------
# Public state API
# ---------------------------------------------------------------------------


def ensure_job_stage_rows(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    discovered_at: str | None = None,
) -> None:
    """Ensure a row exists for every stage for one job."""
    stable_job_id = canonical_job_id(str(job_id))
    now = utc_now()
    for stage in STAGE_ORDER:
        state = "succeeded" if stage == "discover" else "pending"
        attempt_count = 1 if stage == "discover" and discovered_at else 0
        started_at = discovered_at if stage == "discover" else None
        finished_at = discovered_at if stage == "discover" else None
        conn.execute(
            """
            INSERT OR IGNORE INTO job_stage_states (
                tenant_id, job_id, stage, state, attempt_count, max_attempts,
                started_at, updated_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(tenant_id),
                str(stable_job_id),
                stage,
                state,
                attempt_count,
                MAX_ATTEMPTS.get(stage),
                started_at,
                now,
                finished_at,
            ),
        )


def set_stage_state(
    conn,
    job_id: JobId,
    stage: str,
    state: str,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    attempt_count: int | None = None,
    max_attempts: int | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    duration_ms: int | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
    retryable: bool | None = None,
    blocked_by: list[str] | None = None,
    next_action: str | None = None,
    metadata: dict[str, Any] | None = None,
    validate_transition: bool = True,
    expected_version: int | None = None,
) -> None:
    """Upsert one job/stage state row.

    When *validate_transition* is True (the default), the function reads the
    current state from the DB and checks that the requested transition is valid
    per the §8.5 state machine table.  If the transition is invalid, a
    ``ValueError`` is raised.  Pass ``validate_transition=False`` to bypass
    (e.g. during initial row creation or legacy migration).

    When *expected_version* is supplied, the write is guarded by the row's
    current ``version`` column (optimistic locking) and the new row is written
    at ``version = expected_version + 1``.  If the existing row's version does
    not match, ``OptimisticLockError`` is raised.  If no row exists yet the
    INSERT is performed at the same bumped version.  Callers leave this as
    ``None`` (the default) for the unguarded UPSERT path used by stage
    runners.
    """
    if stage not in STAGE_ORDER:
        raise ValueError(f"unknown stage: {stage}")
    if state not in STATE_VALUES:
        raise ValueError(f"unknown state: {state}")
    stable_job_id = canonical_job_id(str(job_id))

    if validate_transition:
        _validate_stage_transition(conn, tenant_id, stable_job_id, stage, state)

    now = utc_now()
    max_attempts = MAX_ATTEMPTS.get(stage) if max_attempts is None else max_attempts
    retry_value = None if retryable is None else int(retryable)
    duration = duration_ms if duration_ms is not None else _duration_ms(started_at, finished_at)
    blocked_by_json = _json_dumps(blocked_by)
    metadata_json = _json_dumps(metadata)

    new_version = 0 if expected_version is None else expected_version + 1
    version_guard = " WHERE job_stage_states.version = :expected_version" if expected_version is not None else ""

    cur = conn.execute(
        f"""
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, max_attempts,
            started_at, updated_at, finished_at, duration_ms, error_code,
            error_message, retryable, blocked_by_json, next_action,
            metadata_json, version
        ) VALUES (
            :tenant_id, :job_id, :stage, :state, COALESCE(:attempt_count, 0),
            :max_attempts, :started_at, :now, :finished_at, :duration,
            :error_code, :error_message, COALESCE(:retry_value, 1),
            :blocked_by_json, :next_action, :metadata_json, :new_version
        )
        ON CONFLICT(tenant_id, job_id, stage) DO UPDATE SET
            state = excluded.state,
            attempt_count = COALESCE(excluded.attempt_count, job_stage_states.attempt_count),
            max_attempts = COALESCE(excluded.max_attempts, job_stage_states.max_attempts),
            started_at = COALESCE(excluded.started_at, job_stage_states.started_at),
            updated_at = excluded.updated_at,
            finished_at = COALESCE(excluded.finished_at, job_stage_states.finished_at),
            duration_ms = COALESCE(excluded.duration_ms, job_stage_states.duration_ms),
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            retryable = excluded.retryable,
            blocked_by_json = excluded.blocked_by_json,
            next_action = excluded.next_action,
            metadata_json = excluded.metadata_json,
            version = CASE
                WHEN :expected_version IS NULL THEN job_stage_states.version
                ELSE excluded.version
            END
        {version_guard}
        """,
        {
            "tenant_id": str(tenant_id),
            "job_id": str(stable_job_id),
            "stage": stage,
            "state": state,
            "attempt_count": attempt_count,
            "max_attempts": max_attempts,
            "started_at": started_at,
            "now": now,
            "finished_at": finished_at,
            "duration": duration,
            "error_code": error_code,
            "error_message": error_message,
            "retry_value": retry_value,
            "blocked_by_json": blocked_by_json,
            "next_action": next_action,
            "metadata_json": metadata_json,
            "new_version": new_version,
            "expected_version": expected_version,
        },
    )

    if expected_version is not None and cur.rowcount == 0:
        existing = conn.execute(
            "SELECT version FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = ?",
            (str(tenant_id), str(stable_job_id), stage),
        ).fetchone()
        actual = 0 if existing is None else (existing[0] if not isinstance(existing, dict) else existing["version"])
        raise OptimisticLockError(stable_job_id, expected_version, actual or 0)

    if state == "succeeded":
        reconcile_dependency_blockers(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
            completed_stage=stage,
            now=now,
        )


def reconcile_dependency_blockers(
    conn,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    job_id: JobId | None = None,
    completed_stage: str | None = None,
    now: str | None = None,
) -> int:
    """Unblock stale downstream stages after their upstream stage succeeds.

    Historical backfills and older runners could leave rows such as
    ``tailor = blocked / "score has not completed."`` in place after the
    score stage later succeeded.  The stage-state table is the canonical
    source of truth, so repair that source directly instead of special-casing
    the read model.
    """
    if completed_stage is not None and completed_stage not in _DEPENDENCY_BLOCKER_MESSAGES:
        return 0

    completed_stages = (completed_stage,) if completed_stage is not None else tuple(_DEPENDENCY_BLOCKER_MESSAGES)
    updated_at = now or utc_now()
    stable_job_id = canonical_job_id(str(job_id)) if job_id is not None else None
    repaired = 0
    for upstream in completed_stages:
        for downstream, messages in _DEPENDENCY_BLOCKER_MESSAGES[upstream]:
            message_placeholders = ", ".join("?" for _ in messages)
            params: list[Any] = [str(tenant_id), downstream, *messages]
            job_filter = ""
            if stable_job_id is not None:
                job_filter = "AND downstream.job_id = ?"
                params.append(str(stable_job_id))
            params.append(upstream)
            rows = conn.execute(
                f"""
                SELECT downstream.job_id, downstream.stage, downstream.attempt_count
                  FROM job_stage_states AS downstream
                 WHERE downstream.tenant_id = ?
                   AND downstream.stage = ?
                   AND downstream.state = 'blocked'
                   AND downstream.error_code = 'BLOCKED'
                   AND downstream.error_message IN ({message_placeholders})
                   {job_filter}
                   AND EXISTS (
                       SELECT 1
                         FROM job_stage_states AS upstream
                        WHERE upstream.tenant_id = downstream.tenant_id
                          AND upstream.job_id = downstream.job_id
                          AND upstream.stage = ?
                          AND upstream.state = 'succeeded'
                   )
                """,
                params,
            ).fetchall()
            for row in rows:
                blocked_job_id = canonical_job_id(str(row["job_id"]))
                set_stage_state(
                    conn,
                    blocked_job_id,
                    downstream,
                    "pending",
                    tenant_id=tenant_id,
                    attempt_count=int(row["attempt_count"] or 0),
                )
                record_job_event(
                    conn,
                    blocked_job_id,
                    downstream,
                    "StageReset",
                    tenant_id=tenant_id,
                    message=f"{downstream} unblocked after {upstream} completed.",
                    occurred_at=updated_at,
                    payload={
                        "reason": "upstream_completed",
                        "upstreamStage": upstream,
                        "downstreamStage": downstream,
                    },
                )
                repaired += 1
    return repaired


def reconcile_score_eligibility_blockers(
    conn,
    *,
    job_url: str,
    eligibility_status: str | None,
    hard_blockers: list[str] | tuple[str, ...] | None = None,
    now: str | None = None,
) -> int:
    """Keep downstream stage rows aligned with score hard-blocker eligibility."""
    blockers = _clean_blocker_reasons(hard_blockers)
    blocked = str(eligibility_status or "").strip().lower() == "blocked" or bool(blockers)
    updated_at = now or utc_now()

    if not blocked:
        return _clear_score_eligibility_blockers(conn, job_url=job_url, now=updated_at)

    reason = ", ".join(blockers) if blockers else str(eligibility_status or "blocked")
    message = f"{SCORE_ELIGIBILITY_BLOCKED_MESSAGE_PREFIX}: {reason}"
    changed = 0
    rows = conn.execute(
        f"""
        SELECT stage, state, attempt_count
          FROM job_stage_states
         WHERE job_url = ?
           AND stage IN ({", ".join("?" for _ in _SCORE_ELIGIBILITY_DOWNSTREAM_STAGES)})
        """,
        (job_url, *_SCORE_ELIGIBILITY_DOWNSTREAM_STAGES),
    ).fetchall()
    for row in rows:
        stage = str(row["stage"])
        state = str(row["state"])
        if state in _TERMINAL_DOWNSTREAM_STATES:
            continue
        attempt_count = int(row["attempt_count"] or 0)
        set_stage_state(
            conn,
            job_url,
            stage,
            "blocked",
            attempt_count=attempt_count,
            error_code=SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE,
            error_message=message,
            retryable=False,
            blocked_by=["score"],
            next_action="review score hard blockers",
            metadata={
                "reason": "score_eligibility_blocked",
                "hard_blockers": blockers,
            },
            validate_transition=False,
        )
        record_job_event(
            conn,
            job_url,
            stage,
            "StageBlocked",
            level="warning",
            message=message,
            occurred_at=updated_at,
            payload={
                "reason": "score_eligibility_blocked",
                "hard_blockers": blockers,
                "upstreamStage": "score",
                "downstreamStage": stage,
            },
        )
        changed += 1
    return changed


def _clear_score_eligibility_blockers(conn, *, job_url: str, now: str) -> int:
    rows = conn.execute(
        """
        SELECT stage, attempt_count
          FROM job_stage_states
         WHERE job_url = ?
           AND state = 'blocked'
           AND error_code = ?
        """,
        (job_url, SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE),
    ).fetchall()
    cleared = 0
    for row in rows:
        stage = str(row["stage"])
        attempt_count = int(row["attempt_count"] or 0)
        restored = _restored_state_after_score_eligibility_cleared(conn, job_url=job_url, stage=stage)
        set_stage_state(conn, job_url, stage, attempt_count=attempt_count, validate_transition=False, **restored)
        record_job_event(
            conn,
            job_url,
            stage,
            "StageReset",
            message=f"{stage} unblocked after score eligibility cleared.",
            occurred_at=now,
            payload={
                "reason": "score_eligibility_cleared",
                "upstreamStage": "score",
                "downstreamStage": stage,
            },
        )
        cleared += 1
    return cleared


def _restored_state_after_score_eligibility_cleared(conn, *, job_url: str, stage: str) -> dict[str, Any]:
    if stage == "tailor":
        return {"state": "pending"}
    if stage == "cover":
        return (
            {"state": "pending"}
            if _stage_is_succeeded(conn, job_url=job_url, stage="tailor")
            else {
                "state": "blocked",
                "error_code": "BLOCKED",
                "error_message": "tailor has not completed.",
            }
        )
    if stage == "apply":
        return (
            {"state": "pending"}
            if _stage_is_succeeded(conn, job_url=job_url, stage="tailor")
            else {
                "state": "blocked",
                "error_code": "BLOCKED",
                "error_message": "Materials are not ready.",
            }
        )
    return {"state": "pending"}


def _stage_is_succeeded(conn, *, job_url: str, stage: str) -> bool:
    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = ?",
        (job_url, stage),
    ).fetchone()
    return bool(row and str(row["state"]) == "succeeded")


def _clean_blocker_reasons(value: list[str] | tuple[str, ...] | None) -> list[str]:
    if not value:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in value:
        text = str(raw or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _material_generation_completed_stage(conn, job_url: str, stage: str) -> int | None:
    if stage == "tailor":
        required_artifacts = ("tailored_resume", "resume_pdf")
    elif stage == "cover":
        required_artifacts = ("cover_letter",)
    else:
        return None

    placeholders = ", ".join("?" for _ in required_artifacts)
    row = conn.execute(
        f"""
        SELECT generation
        FROM job_materials_artifacts
        WHERE job_url = ?
          AND status = 'approved'
          AND artifact_type IN ({placeholders})
        GROUP BY generation
        HAVING COUNT(DISTINCT artifact_type) = ?
        ORDER BY generation DESC
        LIMIT 1
        """,
        (job_url, *required_artifacts, len(required_artifacts)),
    ).fetchone()
    if row is None:
        return None
    return int(row["generation"] if hasattr(row, "keys") and "generation" in row.keys() else row[0])


def record_job_event(
    conn,
    job_id: JobId | None,
    stage: str | None,
    event_type: str,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    level: str = "info",
    message: str | None = None,
    payload: dict[str, Any] | None = None,
    occurred_at: str | None = None,
    publisher: EventPublisher | None = None,
    entity_kind: str | None = None,
    entity_ref: str | None = None,
    idempotency_key: str | None = None,
) -> None:
    """Append a durable per-job event and publish through the in-process bus.

    Every event fans out through the process-wide ``InProcessEventBus``
    so wildcard subscribers (notably ``ProjectionBuilder._on_event``)
    refresh the read-model after each write.  Callers may inject a
    custom ``publisher`` for tests; the production default is the
    process-wide singleton from
    :func:`jobctrl.infrastructure.events.get_default_publisher`.

    **Phase-3 deviation from §6.3** (round-1 review M2): the canonical §6.3
    pattern is "dispatch happens AFTER the producing transaction commits",
    implemented as a wildcard ``JobEventStoreHandler`` subscribed to the bus.
    Phase 3 ships the simpler shape — INSERT inline, then call
    ``publisher.publish`` as fan-out — because the bus is purely additive at
    this stage.  Consequences a cloud cutover (Phase 9+) must address:

    1. Dispatch fires *before* commit; subscribers reading via a fresh
       connection won't see the row yet.
    2. Swapping ``InProcessEventBus`` for an outbox publisher is *not* an
       adapter-only change — every ``record_job_event`` caller is a
       de-facto producer.

    Canonical envelope keys override caller payload data. Root-level legacy
    identity aliases are removed so untrusted content cannot spoof the
    persisted or published JobId.
    """
    stable_job_id = canonical_job_id(str(job_id)) if job_id is not None else None
    current_payload = dict(payload or {})
    for identity_alias in (
        "jobId",
        "job_id",
        "jobUrl",
        "job_url",
        "jobKey",
        "job_key",
    ):
        current_payload.pop(identity_alias, None)
    current_payload.update(
        {
            "stage": stage,
            "level": level,
            "message": message or "",
        }
    )
    if stable_job_id is not None:
        current_payload["jobId"] = str(stable_job_id)
    ts = occurred_at or utc_now()
    cursor = conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, level,
            message, occurred_at, payload_json, entity_kind, entity_ref,
            idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
        """,
        (
            str(tenant_id),
            str(stable_job_id) if stable_job_id is not None else None,
            1,
            stage,
            event_type,
            level,
            message,
            ts,
            _json_dumps(current_payload),
            entity_kind,
            entity_ref,
            idempotency_key,
        ),
    )
    if cursor.rowcount == 0:
        return
    if publisher is None:
        # Default to the process-wide ``InProcessEventBus`` so the
        # projection builder's wildcard subscriber refreshes after every
        # write.  Imported lazily so ``state`` stays importable from
        # bootstrap code that runs before the events package is wired.
        from jobctrl.infrastructure.events import get_default_publisher

        publisher = get_default_publisher()
    event = create_domain_event(
        event_type=event_type,
        tenant_id=tenant_id,
        payload=current_payload,
        occurred_at=ts,
    )
    publisher.publish(event)


def record_job_artifact(
    conn,
    job_url: str,
    stage: str,
    artifact_type: str,
    path: str | Path,
    *,
    status: str = "active",
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Record or update one artifact with provenance."""
    path_str = str(path)
    conn.execute(
        """
        INSERT INTO job_artifacts (
            job_url, stage, artifact_type, status, path, created_at, size_bytes, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_url, stage, artifact_type, path) DO UPDATE SET
            status = excluded.status,
            created_at = excluded.created_at,
            size_bytes = excluded.size_bytes,
            metadata_json = excluded.metadata_json
        """,
        (
            job_url,
            stage,
            artifact_type,
            status,
            path_str,
            created_at or utc_now(),
            _path_size(path_str),
            _json_dumps(metadata),
        ),
    )


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------


def _load_explicit_states(conn, job_url: str) -> dict[str, dict[str, Any]]:
    """Load all stage rows from ``job_stage_states`` for one job."""
    rows = conn.execute(
        "SELECT * FROM job_stage_states WHERE job_url = ?",
        (job_url,),
    ).fetchall()
    explicit: dict[str, dict[str, Any]] = {}
    for row in rows:
        data = _row_to_dict(row)
        data["blocked_by"] = _json_loads(data.pop("blocked_by_json", None), [])
        data["metadata"] = _json_loads(data.pop("metadata_json", None), {})
        data["retryable"] = bool(data.get("retryable", 1))
        explicit[data["stage"]] = data
    return explicit


def _default_state(stage: str) -> dict[str, Any]:
    """Return a default pending state dict for a stage with no DB row."""
    return {
        "stage": stage,
        "state": "pending",
        "attempt_count": 0,
        "max_attempts": MAX_ATTEMPTS.get(stage),
        "started_at": None,
        "finished_at": None,
        "duration_ms": None,
        "error_code": None,
        "error_message": None,
        "retryable": True,
        "blocked_by": [],
        "next_action": None,
    }


def get_job_stage_states(conn, job: dict[str, Any], *, min_score: int = 7) -> list[dict[str, Any]]:
    """Return canonical stage states for one job.

    Reads directly from ``job_stage_states``. If a stage has no row,
    a default ``pending`` state is returned.

    The ``job`` and ``min_score`` parameters are retained for backward
    compatibility but are no longer used for legacy derivation.
    """
    explicit = _load_explicit_states(conn, job["url"])

    states: list[dict[str, Any]] = []
    for stage in STAGE_ORDER:
        existing = explicit.get(stage)
        if existing:
            states.append(existing)
        else:
            states.append(_default_state(stage))
    return states


def _reset_enrichment_aggregate(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> None:
    """Reset the JobEnrichment aggregate for a job back to ``pending``.

    Phase 7 (S-26 round-1 review B1). The mirror of
    :func:`_reset_materials_artifacts` for the enrichment context. After
    a stage reset for "enrich":

      * the legacy ``jobs.detail_scraped_at`` / ``jobs.detail_error``
        columns are nulled by ``reset_job_stage``'s standard UPDATE so
        un-migrated rows reading the legacy fallback also reset;
      * AND the ``job_enrichments`` row's ``current_status`` is set
        back to ``pending`` and the terminal-state fields cleared,
        otherwise the new ``_ENRICHMENT_PENDING`` predicate would
        permanently exclude the row and retry would silently no-op.

    The repository is loaded inline so we don't hit a circular import
    (the enrichment package imports ``state``).
    """
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository

    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(tenant_id, job_id)
    if aggregate is None:
        # Nothing to reset — the next pipeline run will create the row
        # in the empty state when start_attempt fires.
        return
    if aggregate.is_pending and aggregate.full_description is None:
        return
    repo.save(aggregate.reset(reset_at=utc_now()))


def _resettable_material_generation(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    stage: str,
) -> int | None:
    if stage == "tailor":
        row = conn.execute(
            """
            SELECT m.generation
            FROM job_materials m
            WHERE m.tenant_id = ?
              AND m.job_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM job_materials_artifacts a
                WHERE a.tenant_id = m.tenant_id
                  AND a.job_id = m.job_id
                  AND a.generation = m.generation
                  AND a.artifact_type = 'tailored_resume'
                  AND a.status = 'approved'
              )
            ORDER BY m.generation DESC
            LIMIT 1
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
    elif stage == "cover":
        row = conn.execute(
            """
            SELECT m.generation
            FROM job_materials m
            WHERE m.tenant_id = ?
              AND m.job_id = ?
              AND EXISTS (
                SELECT 1
                FROM job_materials_artifacts a
                WHERE a.tenant_id = m.tenant_id
                  AND a.job_id = m.job_id
                  AND a.generation = m.generation
                  AND a.artifact_type = 'tailored_resume'
                  AND a.status = 'approved'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM job_materials_artifacts a
                WHERE a.tenant_id = m.tenant_id
                  AND a.job_id = m.job_id
                  AND a.generation = m.generation
                  AND a.artifact_type = 'cover_letter'
                  AND a.status = 'approved'
              )
            ORDER BY m.generation DESC
            LIMIT 1
            """,
            (str(tenant_id), str(job_id)),
        ).fetchone()
    else:
        return None
    if row is None:
        return None
    return int(row["generation"] if hasattr(row, "keys") and "generation" in row.keys() else row[0])


def _reset_materials_artifacts(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    stage: str,
) -> None:
    """Clear failed/in-progress material artifacts after a stage reset.

    Round-2 review B3. Maps stage → artifact_type subset:

      * ``tailor`` resets only the newest generation that does not already
        have an approved tailored resume.
      * ``cover`` resets only a generation with an approved resume but no
        approved cover letter.

    Approved materials remain reviewable until an approved replacement exists.

    Status is rolled back to the appropriate lifecycle state so the
    aggregate's invariants stay consistent.
    """
    generation = _resettable_material_generation(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        stage=stage,
    )
    if generation is None:
        return

    if stage == "tailor":
        targets = ("tailored_resume", "cover_letter", "resume_pdf", "cover_letter_pdf")
        new_status = "resume_in_progress"
    elif stage == "cover":
        targets = ("cover_letter", "cover_letter_pdf")
        new_status = "resume_approved"
    else:
        return

    placeholders = ", ".join("?" for _ in targets)
    conn.execute(
        f"DELETE FROM job_materials_artifacts "
        f"WHERE tenant_id = ? AND job_id = ? AND generation = ? "
        f"AND artifact_type IN ({placeholders})",
        (str(tenant_id), str(job_id), generation, *targets),
    )
    if new_status is not None:
        conn.execute(
            """
            UPDATE job_materials
            SET status = ?, updated_at = ?
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            """,
            (new_status, utc_now(), str(tenant_id), str(job_id), generation),
        )


def reset_job_stage(
    conn,
    job_url_or_application_url: str,
    stage: str,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    reset_attempts: bool = False,
) -> str:
    """Resolve a locator once, then reset one tenant-scoped job stage.

    Args:
        conn: SQLite connection.
        job_url_or_application_url: Primary job URL or direct application URL.
        stage: Pipeline stage to reset.
        tenant_id: Tenant that owns the locator and canonical JobId.
        reset_attempts: Whether to reset that stage's attempt counter.

    Returns:
        The canonical job URL.

    Raises:
        ValueError: If the stage is unknown or the job cannot be found.
    """
    if stage not in (*STAGE_ORDER, "apply"):
        raise ValueError(f"unknown stage: {stage}")

    row = conn.execute(
        """
        SELECT job_id, url
        FROM jobs
        WHERE tenant_id = ? AND (url = ? OR application_url = ?)
        """,
        (str(tenant_id), job_url_or_application_url, job_url_or_application_url),
    ).fetchone()
    if row is None:
        raise ValueError(f"no matching job found: {job_url_or_application_url}")

    job_url = row["url"]
    stable_job_id = canonical_job_id(str(row["job_id"]))
    # Round-2 review B3: tailor / cover resets MUST clear the
    # ``job_materials_artifacts`` row(s) for the LATEST generation —
    # otherwise the new ``_LATEST_MATERIALS_JOIN`` queue selectors keep
    # the existing approved tailored_resume / cover_letter visible and
    # re-tailoring is impossible. The legacy ``UPDATE jobs SET *_path =
    # NULL`` statements are dead writes (new code never populated those
    # columns); for un-migrated rows they still NULL the legacy columns
    # so consumers reading the legacy fallback also see the reset.
    updates = {
        "discover": "UPDATE jobs SET discovered_at = discovered_at WHERE tenant_id = ? AND job_id = ?",
        "enrich": (
            "UPDATE jobs SET detail_error = NULL, detail_scraped_at = NULL "
            "WHERE tenant_id = ? AND job_id = ?"
        ),
        "score": (
            "UPDATE jobs SET fit_score = NULL, score_reasoning = NULL, scored_at = NULL "
            "WHERE tenant_id = ? AND job_id = ?"
        ),
        "tailor": (
            "UPDATE jobs SET tailored_resume_path = NULL, tailored_at = NULL"
            + (", tailor_attempts = 0" if reset_attempts else "")
            + " WHERE tenant_id = ? AND job_id = ?"
        ),
        "cover": (
            "UPDATE jobs SET cover_letter_path = NULL, cover_letter_at = NULL"
            + (", cover_attempts = 0" if reset_attempts else "")
            + " WHERE tenant_id = ? AND job_id = ?"
        ),
        "apply": (
            "UPDATE jobs SET apply_status = NULL, apply_error = NULL, agent_id = NULL, apply_task_id = NULL"
            + (", apply_attempts = 0" if reset_attempts else "")
            + " WHERE tenant_id = ? AND job_id = ?"
        ),
    }
    conn.execute(updates[stage], (str(tenant_id), str(stable_job_id)))

    # Materials-side reset (Phase 6, round-2 B3). Idempotent — safe when
    # job_materials hasn't been populated yet.
    if stage in ("tailor", "cover"):
        _reset_materials_artifacts(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
            stage=stage,
        )
    # Enrichment-side reset (Phase 7, round-1 B1). Mirror of the
    # materials reset for the enrichment aggregate. Without this the
    # ``_ENRICHMENT_PENDING`` queue predicate excludes the row and the
    # retry-enrich is a silent no-op.
    if stage == "enrich":
        _reset_enrichment_aggregate(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
        )
    set_stage_state(
        conn,
        stable_job_id,
        stage,
        "pending",
        tenant_id=tenant_id,
        attempt_count=0 if reset_attempts else None,
        validate_transition=False,  # admin override — reset bypasses normal machine
    )
    record_job_event(
        conn,
        stable_job_id,
        stage,
        # H1 (round-1 review): align with the domain catalog
        # (`domain/events/orchestration.py::create_stage_reset`).
        "StageReset",
        tenant_id=tenant_id,
        message=f"Retry reset requested for {stage}",
        payload={"reset_attempts": reset_attempts},
    )
    conn.commit()
    return job_url
