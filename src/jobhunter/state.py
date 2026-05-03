"""Per-job pipeline state helpers.

This module gives JobHunter an explicit state model without breaking the
legacy ``jobs`` table. Stage runners can write durable state/events here, and
readers can still synthesize useful state from older databases where the new
tables are empty.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobhunter import config
from jobhunter.database import get_connection

STAGE_ORDER: tuple[str, ...] = ("discover", "enrich", "score", "tailor", "cover", "pdf", "apply")
STATE_VALUES: tuple[str, ...] = (
    "pending",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "skipped",
    "exhausted",
    "stale",
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


def _path_exists(value: str | None) -> bool:
    return bool(value and Path(value).expanduser().exists())


def _path_size(value: str | None) -> int | None:
    if not value:
        return None
    try:
        path = Path(value).expanduser()
        return path.stat().st_size if path.exists() else None
    except OSError:
        return None


def _pdf_sibling(value: str | None) -> str | None:
    if not value:
        return None
    return str(Path(value).with_suffix(".pdf"))


def _duration_ms(started_at: str | None, finished_at: str | None) -> int | None:
    if not started_at or not finished_at:
        return None
    try:
        start = datetime.fromisoformat(started_at)
        finish = datetime.fromisoformat(finished_at)
    except ValueError:
        return None
    return max(0, int((finish - start).total_seconds() * 1000))


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


def initialize_missing_state_rows(conn=None, limit: int = 0, *, min_score: int = 7) -> int:
    """Backfill missing stage rows for existing jobs.

    Existing non-placeholder explicit rows are not overwritten. Missing rows and
    old auto-created placeholder rows are materialized from the legacy ``jobs``
    columns once, after which readers can treat ``job_stage_states`` as the
    canonical source of pipeline truth.
    """
    if conn is None:
        conn = get_connection()
    query = """
        SELECT jobs.*
        FROM jobs
        LEFT JOIN job_stage_states states ON states.job_url = jobs.url
        GROUP BY jobs.url
        HAVING
            COUNT(states.stage) < ?
            OR SUM(
                CASE
                    WHEN states.stage IS NULL THEN 1
                    WHEN states.state = 'pending'
                        AND COALESCE(states.attempt_count, 0) = 0
                        AND states.error_code IS NULL
                        AND states.error_message IS NULL
                        AND states.next_action IS NULL
                        AND states.started_at IS NULL
                        AND states.finished_at IS NULL
                        AND states.duration_ms IS NULL
                        AND states.blocked_by_json IS NULL
                    THEN 1
                    WHEN states.stage = 'discover'
                        AND states.state = 'succeeded'
                        AND COALESCE(states.attempt_count, 0) = 0
                    THEN 1
                    ELSE 0
                END
            ) > 0
        ORDER BY jobs.discovered_at DESC
    """
    params: list[Any] = [len(STAGE_ORDER)]
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)
    rows = conn.execute(query, params).fetchall()
    if not rows:
        return 0
    jobs = [_row_to_dict(row) for row in rows]
    explicit_by_job = _load_explicit_states_for_jobs(conn, [job["url"] for job in jobs])
    for job in jobs:
        _materialize_legacy_stage_rows(conn, job, min_score=min_score, explicit=explicit_by_job.get(job["url"], {}))
    conn.commit()
    return len(rows)


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
) -> None:
    """Upsert one job/stage state row."""
    if stage not in STAGE_ORDER:
        raise ValueError(f"unknown stage: {stage}")
    if state not in STATE_VALUES:
        raise ValueError(f"unknown state: {state}")

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
) -> None:
    """Append a durable per-job event."""
    conn.execute(
        """
        INSERT INTO job_events (
            job_url, stage, event_type, level, message, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (job_url, stage, event_type, level, message, occurred_at or utc_now(), _json_dumps(payload)),
    )


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


def _state(
    stage: str,
    state: str,
    *,
    attempt_count: int = 0,
    max_attempts: int | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    duration_ms: int | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
    retryable: bool = True,
    blocked_by: list[str] | None = None,
    next_action: str | None = None,
) -> dict[str, Any]:
    return {
        "stage": stage,
        "state": state,
        "attempt_count": attempt_count,
        "max_attempts": MAX_ATTEMPTS.get(stage) if max_attempts is None else max_attempts,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "error_code": error_code,
        "error_message": error_message,
        "retryable": retryable,
        "blocked_by": blocked_by or [],
        "next_action": next_action,
    }


def derive_legacy_stage_states(job: dict[str, Any], *, min_score: int = 7) -> list[dict[str, Any]]:
    """Build stage states from the legacy jobs-table columns."""
    url = job.get("url") or ""
    states: list[dict[str, Any]] = []

    states.append(
        _state(
            "discover",
            "succeeded",
            attempt_count=1 if job.get("discovered_at") else 0,
            started_at=job.get("discovered_at"),
            finished_at=job.get("discovered_at"),
        )
    )

    if job.get("full_description"):
        states.append(
            _state(
                "enrich",
                "succeeded",
                attempt_count=1,
                finished_at=job.get("detail_scraped_at"),
            )
        )
    elif job.get("detail_error"):
        states.append(
            _state(
                "enrich",
                "failed",
                attempt_count=1,
                finished_at=job.get("detail_scraped_at"),
                error_code="DETAIL_ERROR",
                error_message=str(job.get("detail_error") or "Detail enrichment failed"),
                retryable=True,
                next_action=f"jobhunter retry enrich {url}",
            )
        )
    else:
        states.append(_state("enrich", "pending", next_action="jobhunter enrich"))

    if not job.get("full_description"):
        states.append(
            _state(
                "score",
                "blocked",
                retryable=False,
                blocked_by=["enrich"],
                error_code="BLOCKED_UPSTREAM",
                error_message="Cannot score until enrichment has a full description.",
                next_action=f"jobhunter retry enrich {url}",
            )
        )
    elif job.get("fit_score") is None:
        states.append(_state("score", "pending", next_action="jobhunter score --limit 1"))
    elif int(job.get("fit_score") or 0) <= 0:
        states.append(
            _state(
                "score",
                "failed",
                attempt_count=1,
                finished_at=job.get("scored_at"),
                error_code="SCORE_FAILED",
                error_message=str(job.get("score_reasoning") or "Scoring failed"),
                retryable=True,
                next_action=f"jobhunter retry score {url}",
            )
        )
    else:
        states.append(
            _state(
                "score",
                "succeeded",
                attempt_count=1,
                finished_at=job.get("scored_at"),
            )
        )

    score = job.get("fit_score")
    tailor_attempts = int(job.get("tailor_attempts") or 0)
    max_tailor = config.DEFAULTS["max_tailor_attempts"]
    if score is None:
        states.append(
            _state(
                "tailor",
                "blocked",
                retryable=False,
                blocked_by=["score"],
                error_code="BLOCKED_UPSTREAM",
                error_message="Cannot tailor until scoring succeeds.",
                next_action=f"jobhunter retry score {url}",
            )
        )
    elif int(score) < min_score:
        states.append(
            _state(
                "tailor",
                "skipped",
                retryable=False,
                error_code="BELOW_MIN_SCORE",
                error_message=f"Score {score} is below the minimum score {min_score}.",
            )
        )
    elif job.get("tailored_resume_path"):
        states.append(
            _state(
                "tailor",
                "succeeded",
                attempt_count=max(1, tailor_attempts),
                finished_at=job.get("tailored_at"),
            )
        )
    elif tailor_attempts >= max_tailor:
        states.append(
            _state(
                "tailor",
                "exhausted",
                attempt_count=tailor_attempts,
                max_attempts=max_tailor,
                finished_at=job.get("tailored_at"),
                error_code="TAILOR_ATTEMPTS_EXHAUSTED",
                error_message=f"Tailoring used {tailor_attempts}/{max_tailor} attempts without an approved resume.",
                retryable=True,
                next_action=f"jobhunter retry tailor {url} --reset-attempts",
            )
        )
    else:
        states.append(
            _state(
                "tailor",
                "pending",
                attempt_count=tailor_attempts,
                max_attempts=max_tailor,
                next_action="jobhunter tailor --limit 1",
            )
        )

    cover_attempts = int(job.get("cover_attempts") or 0)
    max_cover = MAX_ATTEMPTS["cover"] or 5
    if score is not None and int(score) < min_score:
        states.append(_state("cover", "skipped", retryable=False, blocked_by=["score"]))
    elif not job.get("tailored_resume_path"):
        states.append(
            _state(
                "cover",
                "blocked",
                retryable=False,
                blocked_by=["tailor"],
                error_code="BLOCKED_UPSTREAM",
                error_message="Cannot generate a cover letter until a tailored resume is approved.",
                next_action=f"jobhunter retry tailor {url}",
            )
        )
    elif job.get("cover_letter_path"):
        states.append(
            _state(
                "cover",
                "succeeded",
                attempt_count=max(1, cover_attempts),
                finished_at=job.get("cover_letter_at"),
            )
        )
    elif cover_attempts >= max_cover:
        states.append(
            _state(
                "cover",
                "exhausted",
                attempt_count=cover_attempts,
                max_attempts=max_cover,
                error_code="COVER_ATTEMPTS_EXHAUSTED",
                error_message=f"Cover letter generation used {cover_attempts}/{max_cover} attempts.",
                retryable=True,
                next_action=f"jobhunter retry cover {url} --reset-attempts",
            )
        )
    else:
        states.append(
            _state(
                "cover",
                "pending",
                attempt_count=cover_attempts,
                max_attempts=max_cover,
                next_action="jobhunter cover --limit 1",
            )
        )

    tailored_pdf = _pdf_sibling(job.get("tailored_resume_path"))
    cover_pdf = _pdf_sibling(job.get("cover_letter_path"))
    if score is not None and int(score) < min_score:
        states.append(_state("pdf", "skipped", retryable=False, blocked_by=["score"]))
    elif not job.get("tailored_resume_path"):
        states.append(_state("pdf", "blocked", retryable=False, blocked_by=["tailor"]))
    elif not job.get("cover_letter_path"):
        states.append(_state("pdf", "blocked", retryable=False, blocked_by=["cover"]))
    elif _path_exists(tailored_pdf) and _path_exists(cover_pdf):
        states.append(_state("pdf", "succeeded", attempt_count=1))
    else:
        missing = []
        if not _path_exists(tailored_pdf):
            missing.append("tailored_resume_pdf")
        if not _path_exists(cover_pdf):
            missing.append("cover_letter_pdf")
        states.append(
            _state(
                "pdf",
                "pending",
                error_code="PDF_MISSING",
                error_message=f"Missing {', '.join(missing)}.",
                next_action="jobhunter pdf --limit 1",
            )
        )

    apply_status = (job.get("apply_status") or "").lower()
    apply_attempts = int(job.get("apply_attempts") or 0)
    if apply_status == "applied" or job.get("applied_at"):
        states.append(
            _state(
                "apply",
                "succeeded",
                attempt_count=max(1, apply_attempts),
                finished_at=job.get("applied_at"),
            )
        )
    elif apply_status in {"in_progress", "running"}:
        states.append(
            _state(
                "apply",
                "running",
                attempt_count=apply_attempts,
                started_at=job.get("last_attempted_at"),
            )
        )
    elif apply_status in {"failed", "captcha", "login_issue", "expired"}:
        permanent = apply_status in {"captcha", "login_issue", "expired"}
        states.append(
            _state(
                "apply",
                "failed",
                attempt_count=apply_attempts,
                max_attempts=config.DEFAULTS["max_apply_attempts"],
                finished_at=job.get("last_attempted_at"),
                error_code=apply_status.upper(),
                error_message=str(job.get("apply_error") or apply_status),
                retryable=not permanent,
                next_action=f"jobhunter apply --url {url}",
            )
        )
    elif apply_status == "dry_run":
        states.append(
            _state(
                "apply",
                "skipped",
                attempt_count=apply_attempts,
                finished_at=job.get("last_attempted_at"),
                error_code="DRY_RUN",
                error_message="Dry run completed without submitting.",
                retryable=True,
                next_action=f"jobhunter apply --url {url}",
            )
        )
    elif apply_status == "manual":
        states.append(
            _state(
                "apply",
                "skipped",
                retryable=False,
                error_code="MANUAL_ATS",
                error_message=str(job.get("apply_error") or "Manual application required."),
            )
        )
    elif not job.get("application_url"):
        states.append(
            _state(
                "apply",
                "blocked",
                retryable=False,
                blocked_by=["enrich"],
                error_code="MISSING_APPLICATION_URL",
                error_message="Cannot apply without a direct application URL.",
                next_action=f"jobhunter retry enrich {url}",
            )
        )
    elif not job.get("tailored_resume_path"):
        states.append(_state("apply", "blocked", retryable=False, blocked_by=["tailor"]))
    elif not job.get("cover_letter_path"):
        states.append(_state("apply", "blocked", retryable=False, blocked_by=["cover"]))
    else:
        states.append(
            _state(
                "apply",
                "pending",
                attempt_count=apply_attempts,
                max_attempts=config.DEFAULTS["max_apply_attempts"],
                next_action=f"jobhunter apply --url {url}",
            )
        )

    return states


def _load_explicit_states(conn, job_url: str) -> dict[str, dict[str, Any]]:
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


def _load_all_explicit_states(conn) -> dict[str, dict[str, dict[str, Any]]]:
    rows = conn.execute("SELECT * FROM job_stage_states").fetchall()
    return _group_explicit_states(rows)


def _load_explicit_states_for_jobs(conn, job_urls: list[str]) -> dict[str, dict[str, dict[str, Any]]]:
    if not job_urls:
        return {}
    placeholders = ",".join("?" for _ in job_urls)
    rows = conn.execute(f"SELECT * FROM job_stage_states WHERE job_url IN ({placeholders})", job_urls).fetchall()
    return _group_explicit_states(rows)


def _group_explicit_states(rows) -> dict[str, dict[str, dict[str, Any]]]:
    by_job: dict[str, dict[str, dict[str, Any]]] = {}
    for row in rows:
        data = _row_to_dict(row)
        data["blocked_by"] = _json_loads(data.pop("blocked_by_json", None), [])
        data["metadata"] = _json_loads(data.pop("metadata_json", None), {})
        data["retryable"] = bool(data.get("retryable", 1))
        by_job.setdefault(data["job_url"], {})[data["stage"]] = data
    return by_job


def _materialize_legacy_stage_rows(
    conn,
    job: dict[str, Any],
    *,
    min_score: int = 7,
    explicit: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Create canonical rows from legacy job columns without clobbering real state."""
    explicit = _load_explicit_states(conn, job["url"]) if explicit is None else explicit
    for legacy_state in derive_legacy_stage_states(job, min_score=min_score):
        existing = explicit.get(legacy_state["stage"])
        if existing and not _is_placeholder_state(existing, legacy_state):
            continue
        set_stage_state(
            conn,
            job["url"],
            legacy_state["stage"],
            legacy_state["state"],
            attempt_count=legacy_state.get("attempt_count"),
            max_attempts=legacy_state.get("max_attempts"),
            started_at=legacy_state.get("started_at"),
            finished_at=legacy_state.get("finished_at"),
            duration_ms=legacy_state.get("duration_ms"),
            error_code=legacy_state.get("error_code"),
            error_message=legacy_state.get("error_message"),
            retryable=bool(legacy_state.get("retryable", True)),
            blocked_by=legacy_state.get("blocked_by") or [],
            next_action=legacy_state.get("next_action"),
            metadata=legacy_state.get("metadata") or {},
        )


def _is_placeholder_state(existing: dict[str, Any], legacy_state: dict[str, Any]) -> bool:
    """Return true for rows created by the old default-row backfill."""
    if (
        existing.get("stage") == "discover"
        and existing.get("state") == "succeeded"
        and legacy_state.get("state") == "succeeded"
        and int(existing.get("attempt_count") or 0) == 0
    ):
        return True
    if _has_real_state_fields(existing):
        return False
    if existing.get("state") == "pending":
        return True
    return (
        existing.get("stage") == "discover"
        and existing.get("state") == "succeeded"
        and legacy_state.get("state") == "succeeded"
    )


def _has_real_state_fields(existing: dict[str, Any]) -> bool:
    return (
        int(existing.get("attempt_count") or 0) != 0
        or bool(existing.get("error_code"))
        or bool(existing.get("error_message"))
        or bool(existing.get("next_action"))
        or bool(existing.get("blocked_by"))
        or bool(existing.get("started_at"))
        or bool(existing.get("finished_at"))
        or bool(existing.get("duration_ms"))
        or bool(existing.get("metadata"))
    )


def get_job_stage_states(conn, job: dict[str, Any], *, min_score: int = 7) -> list[dict[str, Any]]:
    """Return canonical stage states for one job."""
    legacy = {item["stage"]: item for item in derive_legacy_stage_states(job, min_score=min_score)}
    explicit = _load_explicit_states(conn, job["url"])

    if not explicit:
        return [legacy[stage] for stage in STAGE_ORDER]

    states: list[dict[str, Any]] = []
    for stage in STAGE_ORDER:
        existing = explicit.get(stage)
        if existing and not _is_placeholder_state(existing, legacy[stage]):
            states.append(existing)
        else:
            states.append(legacy[stage])
    return states


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
    set_stage_state(conn, job_url, stage, "pending", attempt_count=0 if reset_attempts else None)
    record_job_event(
        conn,
        job_url,
        stage,
        "retry_requested",
        message=f"Retry reset requested for {stage}",
        payload={"reset_attempts": reset_attempts},
    )
    conn.commit()
    return job_url
