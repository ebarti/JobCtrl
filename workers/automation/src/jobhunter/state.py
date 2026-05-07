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

from jobhunter import config
from jobhunter.domain.events.base import create_domain_event
from jobhunter.domain.pipeline.state_machine import is_valid_transition
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.domain.pipeline_types import deserialize_stage_state_kind

log = logging.getLogger(__name__)

STAGE_ORDER: tuple[str, ...] = ("discover", "enrich", "score", "tailor", "cover", "pdf", "apply")
STATE_VALUES: tuple[str, ...] = (
    "pending",
    "queued",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "skipped",
    "exhausted",
    "stale",
    "canceled",
)

MAX_ATTEMPTS: dict[str, int | None] = {
    "discover": None,
    "enrich": 5,
    "score": 3,
    "tailor": config.DEFAULTS["max_tailor_attempts"],
    "cover": 5,
    "pdf": 3,
    "apply": config.DEFAULTS["max_apply_attempts"],
}


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


# ---------------------------------------------------------------------------
# Transition validation
# ---------------------------------------------------------------------------


def _validate_stage_transition(conn, job_url: str, stage: str, target_state: str) -> None:
    """Check the §8.5 state machine allows the transition.

    Reads the current state from DB. If no row exists yet (INSERT path),
    the transition is always allowed. If a row exists and the state is
    already the target, the call is idempotent — also allowed.
    """
    row = conn.execute(
        "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = ?",
        (job_url, stage),
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
# Public state API — signatures preserved for backward compatibility
# ---------------------------------------------------------------------------


def ensure_job_stage_rows(conn, job_url: str, *, discovered_at: str | None = None) -> None:
    """Ensure a row exists for every stage for one job."""
    now = utc_now()
    for stage in STAGE_ORDER:
        state = "succeeded" if stage == "discover" else "pending"
        attempt_count = 1 if stage == "discover" and discovered_at else 0
        started_at = discovered_at if stage == "discover" else None
        finished_at = discovered_at if stage == "discover" else None
        conn.execute(
            """
            INSERT OR IGNORE INTO job_stage_states (
                job_url, stage, state, attempt_count, max_attempts, started_at, updated_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (job_url, stage, state, attempt_count, MAX_ATTEMPTS.get(stage), started_at, now, finished_at),
        )


def set_stage_state(
    conn,
    job_url: str,
    stage: str,
    state: str,
    *,
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
) -> None:
    """Upsert one job/stage state row.

    When *validate_transition* is True (the default), the function reads the
    current state from the DB and checks that the requested transition is valid
    per the §8.5 state machine table.  If the transition is invalid, a
    ``ValueError`` is raised.  Pass ``validate_transition=False`` to bypass
    (e.g. during initial row creation or legacy migration).
    """
    if stage not in STAGE_ORDER:
        raise ValueError(f"unknown stage: {stage}")
    if state not in STATE_VALUES:
        raise ValueError(f"unknown state: {state}")

    if validate_transition:
        _validate_stage_transition(conn, job_url, stage, state)

    now = utc_now()
    max_attempts = MAX_ATTEMPTS.get(stage) if max_attempts is None else max_attempts
    retry_value = None if retryable is None else int(retryable)
    duration = duration_ms if duration_ms is not None else _duration_ms(started_at, finished_at)

    conn.execute(
        """
        INSERT INTO job_stage_states (
            job_url, stage, state, attempt_count, max_attempts, started_at, updated_at,
            finished_at, duration_ms, error_code, error_message, retryable,
            blocked_by_json, next_action, metadata_json
        ) VALUES (?, ?, ?, COALESCE(?, 0), ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?, ?)
        ON CONFLICT(job_url, stage) DO UPDATE SET
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
            metadata_json = excluded.metadata_json
        """,
        (
            job_url,
            stage,
            state,
            attempt_count,
            max_attempts,
            started_at,
            now,
            finished_at,
            duration,
            error_code,
            error_message,
            retry_value,
            _json_dumps(blocked_by),
            next_action,
            _json_dumps(metadata),
        ),
    )


def record_job_event(
    conn,
    job_url: str | None,
    stage: str | None,
    event_type: str,
    *,
    level: str = "info",
    message: str | None = None,
    payload: dict[str, Any] | None = None,
    occurred_at: str | None = None,
    publisher: EventPublisher | None = None,
) -> None:
    """Append a durable per-job event and publish through the in-process bus.

    Every event fans out through the process-wide ``InProcessEventBus``
    so wildcard subscribers (notably ``ProjectionBuilder._on_event``)
    refresh the read-model after each write.  Callers may inject a
    custom ``publisher`` for tests; the production default is the
    process-wide singleton from
    :func:`jobhunter.infrastructure.events.get_default_publisher`.

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

    Note on payload composition: caller-supplied ``payload`` keys override
    the envelope keys (``job_url``, ``stage``, ``level``, ``message``).  This
    is intentional but worth knowing — don't shadow envelope keys
    accidentally (round-1 review L3).
    """
    ts = occurred_at or utc_now()
    conn.execute(
        """
        INSERT INTO job_events (
            job_url, stage, event_type, level, message, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (job_url, stage, event_type, level, message, ts, _json_dumps(payload)),
    )
    if publisher is None:
        # Default to the process-wide ``InProcessEventBus`` so the
        # projection builder's wildcard subscriber refreshes after every
        # write.  Imported lazily so ``state`` stays importable from
        # bootstrap code that runs before the events package is wired.
        from jobhunter.infrastructure.events import get_default_publisher

        publisher = get_default_publisher()
    event = create_domain_event(
        event_type=event_type,
        tenant_id=LOCAL_TENANT,
        payload={
            "job_url": job_url,
            "stage": stage,
            "level": level,
            "message": message or "",
            **(payload or {}),
        },
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


def _reset_enrichment_aggregate(conn, job_url: str) -> None:
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
    from jobhunter.domain.identifiers import JobId
    from jobhunter.domain.tenant import LOCAL_TENANT
    from jobhunter.infrastructure.enrichment import SqliteEnrichmentRepository

    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, JobId(job_url))
    if aggregate is None:
        # Nothing to reset — the next pipeline run will create the row
        # in the empty state when start_attempt fires.
        return
    if aggregate.is_pending and aggregate.full_description is None:
        return
    repo.save(aggregate.reset(reset_at=utc_now()))


def _reset_materials_artifacts(conn, job_url: str, stage: str) -> None:
    """Clear the latest generation's affected artifact rows after a stage reset.

    Round-2 review B3. Maps stage → artifact_type subset:

      * ``tailor`` resets EVERYTHING in the latest generation (resume,
        cover, both PDFs) and resets the parent row's status back to
        ``resume_in_progress`` — re-tailoring will start a fresh attempt
        within the same generation; downstream artifacts are stale and
        must be regenerated. (Use the ``MaterialsSetFactory.next_generation``
        primitive when explicit re-tailoring with audit-trail is wanted —
        ``reset_job_stage`` is the in-place reset path.)
      * ``cover`` resets the cover-letter text + cover-letter PDF only;
        tailored resume + resume PDF stay intact.
      * ``pdf`` resets only the two PDFs; text artifacts stay.

    Status is rolled back to the appropriate lifecycle state so the
    aggregate's invariants stay consistent.
    """
    latest_row = conn.execute(
        "SELECT generation FROM job_materials WHERE job_url = ? "
        "ORDER BY generation DESC LIMIT 1",
        (job_url,),
    ).fetchone()
    if latest_row is None:
        return

    generation = int(latest_row[0])
    if stage == "tailor":
        targets = ("tailored_resume", "cover_letter", "resume_pdf", "cover_letter_pdf")
        new_status = "resume_in_progress"
    elif stage == "cover":
        targets = ("cover_letter", "cover_letter_pdf")
        new_status = "resume_approved"
    else:  # stage == "pdf"
        targets = ("resume_pdf", "cover_letter_pdf")
        new_status = None  # status doesn't change — PDFs were never gating

    placeholders = ", ".join("?" for _ in targets)
    conn.execute(
        f"DELETE FROM job_materials_artifacts "
        f"WHERE job_url = ? AND generation = ? AND artifact_type IN ({placeholders})",
        (job_url, generation, *targets),
    )
    if new_status is not None:
        conn.execute(
            "UPDATE job_materials SET status = ?, updated_at = ? "
            "WHERE job_url = ? AND generation = ?",
            (new_status, utc_now(), job_url, generation),
        )


def reset_job_stage(conn, job_url_or_application_url: str, stage: str, *, reset_attempts: bool = False) -> str:
    """Reset one job/stage to pending and clear legacy fields that block retry.

    Args:
        conn: SQLite connection.
        job_url_or_application_url: Primary job URL or direct application URL.
        stage: Pipeline stage to reset.
        reset_attempts: Whether to reset that stage's attempt counter.

    Returns:
        The canonical job URL.

    Raises:
        ValueError: If the stage is unknown or the job cannot be found.
    """
    if stage not in (*STAGE_ORDER, "apply"):
        raise ValueError(f"unknown stage: {stage}")

    row = conn.execute(
        "SELECT url FROM jobs WHERE url = ? OR application_url = ?",
        (job_url_or_application_url, job_url_or_application_url),
    ).fetchone()
    if row is None:
        raise ValueError(f"no matching job found: {job_url_or_application_url}")

    job_url = row["url"]
    # Round-2 review B3: tailor / cover / pdf resets MUST clear the
    # ``job_materials_artifacts`` row(s) for the LATEST generation —
    # otherwise the new ``_LATEST_MATERIALS_JOIN`` queue selectors keep
    # the existing approved tailored_resume / cover_letter visible and
    # re-tailoring is impossible. The legacy ``UPDATE jobs SET *_path =
    # NULL`` statements are dead writes (new code never populated those
    # columns); for un-migrated rows they still NULL the legacy columns
    # so consumers reading the legacy fallback also see the reset.
    updates = {
        "discover": "UPDATE jobs SET discovered_at = discovered_at WHERE url = ?",
        "enrich": "UPDATE jobs SET detail_error = NULL, detail_scraped_at = NULL WHERE url = ?",
        "score": "UPDATE jobs SET fit_score = NULL, score_reasoning = NULL, scored_at = NULL WHERE url = ?",
        "tailor": (
            "UPDATE jobs SET tailored_resume_path = NULL, tailored_at = NULL"
            + (", tailor_attempts = 0" if reset_attempts else "")
            + " WHERE url = ?"
        ),
        "cover": (
            "UPDATE jobs SET cover_letter_path = NULL, cover_letter_at = NULL"
            + (", cover_attempts = 0" if reset_attempts else "")
            + " WHERE url = ?"
        ),
        "pdf": "UPDATE jobs SET cover_letter_at = cover_letter_at WHERE url = ?",
        "apply": (
            "UPDATE jobs SET apply_status = NULL, apply_error = NULL, agent_id = NULL, apply_task_id = NULL"
            + (", apply_attempts = 0" if reset_attempts else "")
            + " WHERE url = ?"
        ),
    }
    conn.execute(updates[stage], (job_url,))

    # Materials-side reset (Phase 6, round-2 B3). Idempotent — safe when
    # job_materials hasn't been populated yet.
    if stage in ("tailor", "cover", "pdf"):
        _reset_materials_artifacts(conn, job_url, stage)
    # Enrichment-side reset (Phase 7, round-1 B1). Mirror of the
    # materials reset for the enrichment aggregate. Without this the
    # ``_ENRICHMENT_PENDING`` queue predicate excludes the row and the
    # retry-enrich is a silent no-op.
    if stage == "enrich":
        _reset_enrichment_aggregate(conn, job_url)
    set_stage_state(
        conn, job_url, stage, "pending",
        attempt_count=0 if reset_attempts else None,
        validate_transition=False,  # admin override — reset bypasses normal machine
    )
    record_job_event(
        conn,
        job_url,
        stage,
        # H1 (round-1 review): align with the domain catalog
        # (`domain/events/orchestration.py::create_stage_reset`).
        "StageReset",
        message=f"Retry reset requested for {stage}",
        payload={"reset_attempts": reset_attempts},
    )
    conn.commit()
    return job_url
