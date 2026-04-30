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

SEVERITY_RANK: dict[str, int] = {"high": 0, "medium": 1, "low": 2}


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
        finished_at = discovered_at if stage == "discover" else None
        conn.execute(
            """
            INSERT OR IGNORE INTO job_stage_states (
                job_url, stage, state, attempt_count, max_attempts, updated_at, finished_at
            ) VALUES (?, ?, ?, 0, ?, ?, ?)
            """,
            (job_url, stage, state, MAX_ATTEMPTS.get(stage), now, finished_at),
        )


def initialize_missing_state_rows(conn=None, limit: int = 0) -> int:
    """Backfill missing stage rows for existing jobs.

    Existing explicit rows are not overwritten. This makes migration safe and
    cheap enough to run from dashboard generation or startup paths.
    """
    if conn is None:
        conn = get_connection()
    query = "SELECT url, discovered_at FROM jobs ORDER BY discovered_at DESC"
    params: list[Any] = []
    if limit > 0:
        query += " LIMIT ?"
        params.append(limit)
    rows = conn.execute(query, params).fetchall()
    for row in rows:
        ensure_job_stage_rows(conn, row["url"], discovered_at=row["discovered_at"])
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


def get_job_stage_states(conn, job: dict[str, Any], *, min_score: int = 7) -> list[dict[str, Any]]:
    """Return merged explicit + legacy stage states for one job."""
    legacy = {item["stage"]: item for item in derive_legacy_stage_states(job, min_score=min_score)}
    explicit = _load_explicit_states(conn, job["url"])
    merged: list[dict[str, Any]] = []

    for stage in STAGE_ORDER:
        legacy_state = legacy[stage]
        explicit_state = explicit.get(stage)
        if not explicit_state:
            merged.append(legacy_state)
            continue

        if legacy_state["state"] == "succeeded":
            merged.append({**explicit_state, **legacy_state})
        elif explicit_state.get("state") not in (None, "pending"):
            merged.append({**legacy_state, **explicit_state})
        else:
            merged.append(legacy_state)

    return merged


def _first_actionable_stage(states: list[dict[str, Any]]) -> dict[str, Any] | None:
    for state in states:
        if state["state"] in {"failed", "blocked", "exhausted", "stale"}:
            return state
    for state in states:
        if state["state"] in {"pending", "running"}:
            return state
    return None


def _severity(stage_state: dict[str, Any], job: dict[str, Any]) -> str:
    if stage_state["state"] in {"failed", "exhausted"}:
        return "high" if int(job.get("fit_score") or 0) >= 7 else "medium"
    if stage_state["state"] == "blocked":
        return "high" if stage_state.get("stage") in {"score", "apply"} else "medium"
    return "low"


def _job_label(job: dict[str, Any]) -> str:
    title = job.get("title") or "Untitled"
    company = job.get("site") or "Unknown"
    return f"{company} / {title}"


def _artifact_entries(conn, job: dict[str, Any]) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT artifact_type, status, path, created_at, size_bytes
        FROM job_artifacts
        WHERE job_url = ?
        ORDER BY created_at DESC
        """,
        (job["url"],),
    ).fetchall()
    artifacts = [
        {
            "type": row["artifact_type"],
            "status": row["status"],
            "path": row["path"],
            "at": row["created_at"],
            "size": _format_size(row["size_bytes"]),
        }
        for row in rows
    ]

    legacy_paths = [
        ("tailored_resume_txt", "tailor", job.get("tailored_resume_path"), job.get("tailored_at")),
        ("tailored_resume_pdf", "pdf", _pdf_sibling(job.get("tailored_resume_path")), job.get("tailored_at")),
        ("cover_letter_txt", "cover", job.get("cover_letter_path"), job.get("cover_letter_at")),
        ("cover_letter_pdf", "pdf", _pdf_sibling(job.get("cover_letter_path")), job.get("cover_letter_at")),
    ]
    seen = {(item["type"], item["path"]) for item in artifacts}
    for artifact_type, _stage, path, at in legacy_paths:
        if not path or (artifact_type, path) in seen:
            continue
        artifacts.append(
            {
                "type": artifact_type,
                "status": "active" if _path_exists(path) else "stale",
                "path": path,
                "at": at,
                "size": _format_size(_path_size(path)),
            }
        )
    return artifacts


def _format_size(size: int | None) -> str:
    if not size:
        return "missing"
    if size < 1024:
        return f"{size}b"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f}kb"
    return f"{size / (1024 * 1024):.1f}mb"


def _recent_events(conn, job_url: str | None = None, limit: int = 12) -> list[dict[str, Any]]:
    params: list[Any] = []
    where = ""
    if job_url:
        where = "WHERE job_url = ?"
        params.append(job_url)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT job_url, stage, event_type, level, message, occurred_at, payload_json
        FROM job_events
        {where}
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    return [
        {
            "job_url": row["job_url"],
            "stage": row["stage"] or "system",
            "level": row["level"],
            "message": row["message"] or row["event_type"],
            "at": row["occurred_at"],
            "payload": _json_loads(row["payload_json"], {}),
        }
        for row in rows
    ]


def _recent_apply_runs(conn, job_url: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    params: list[Any] = []
    where = ""
    if job_url:
        where = "WHERE job_url = ?"
        params.append(job_url)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT run_id, job_url, title, site, worker_name, model, status, result, error,
               dry_run, headless, attempts, started_at, duration_ms, input_tokens,
               output_tokens, cache_read_tokens, cache_create_tokens, cost_usd,
               log_path, output_path
        FROM apply_runs
        {where}
        ORDER BY started_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    runs = []
    for row in rows:
        tokens = sum(
            int(row[key] or 0) for key in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_create_tokens")
        )
        runs.append(
            {
                "run_id": row["run_id"],
                "job_url": row["job_url"],
                "title": row["title"] or "Untitled",
                "company": row["site"] or "Unknown",
                "status": _normalize_apply_run_status(row["status"], row["result"], bool(row["dry_run"])),
                "result": row["result"],
                "error": row["error"],
                "worker_name": row["worker_name"] or "",
                "model": row["model"] or "",
                "dry_run": bool(row["dry_run"]),
                "headless": bool(row["headless"]),
                "attempts": row["attempts"] or 0,
                "started_at": row["started_at"],
                "duration_ms": row["duration_ms"],
                "cost_usd": float(row["cost_usd"] or 0),
                "tokens": tokens,
                "log_path": row["log_path"],
                "output_path": row["output_path"],
            }
        )
    return runs


def _normalize_apply_run_status(status: str | None, result: str | None, dry_run: bool) -> str:
    value = (status or result or "unknown").lower()
    if value in {"in_progress", "running", "applying", "starting"}:
        return "running"
    if dry_run and value in {"applied", "succeeded", "success", "finished"}:
        return "succeeded"
    if value in {"applied", "success", "succeeded", "finished"}:
        return "succeeded"
    if value in {"failed", "error", "captcha", "login_issue", "expired"}:
        return "failed"
    return value


def build_dashboard_data(
    conn=None,
    *,
    min_score: int | None = None,
    dashboard_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the JSON contract consumed by the generated operations dashboard."""
    if conn is None:
        conn = get_connection()
    settings = config.normalize_dashboard_settings(dashboard_settings or {})
    if min_score is not None:
        settings = config.normalize_dashboard_settings({"min_fit_score": min_score}, base=settings)
    min_score_value = int(settings["min_fit_score"])
    initialize_missing_state_rows(conn)

    rows = conn.execute("SELECT * FROM jobs ORDER BY discovered_at DESC NULLS LAST, title").fetchall()
    jobs = [_row_to_dict(row) for row in rows]
    stage_by_url = {job["url"]: get_job_stage_states(conn, job, min_score=min_score_value) for job in jobs}

    funnel = []
    for stage in STAGE_ORDER:
        counts = {"stage": stage, "total": 0, "succeeded": 0, "running": 0, "pending": 0, "blocked": 0, "failed": 0}
        for states in stage_by_url.values():
            state = next(item for item in states if item["stage"] == stage)["state"]
            if state == "skipped":
                continue
            counts["total"] += 1
            if state == "exhausted":
                counts["failed"] += 1
            elif state == "stale":
                counts["pending"] += 1
            elif state in counts:
                counts[state] += 1
        funnel.append(counts)

    triage = []
    ready = []
    job_summaries = []
    artifact_summaries = []
    job_detail = {}
    for job in jobs:
        states = stage_by_url[job["url"]]
        action = _first_actionable_stage(states)
        apply_state = next(item for item in states if item["stage"] == "apply")
        artifacts = _artifact_entries(conn, job)
        events = _recent_events(conn, job["url"], limit=12)
        apply_runs_for_job = _recent_apply_runs(conn, job["url"], limit=8)

        job_summaries.append(
            {
                "job_url": job["url"],
                "title": job.get("title") or "Untitled",
                "company": job.get("site") or "Unknown",
                "site": job.get("site") or "Unknown",
                "strategy": job.get("strategy") or "",
                "location": job.get("location") or "",
                "salary": job.get("salary") or "",
                "discovered_at": job.get("discovered_at"),
                "application_url": job.get("application_url"),
                "fit_score": job.get("fit_score"),
                "current_stage": action["stage"] if action else "complete",
                "current_state": action["state"] if action else "succeeded",
                "error_code": action.get("error_code") if action else None,
                "error_message": action.get("error_message") if action else None,
                "next_action": action.get("next_action") if action else None,
                "artifact_count": len(artifacts),
                "apply_status": job.get("apply_status"),
                "applied_at": job.get("applied_at"),
            }
        )

        for artifact in artifacts:
            artifact_summaries.append(
                {
                    "job_url": job["url"],
                    "title": job.get("title") or "Untitled",
                    "company": job.get("site") or "Unknown",
                    "site": job.get("site") or "Unknown",
                    **artifact,
                }
            )

        if action and action["state"] in {"failed", "blocked", "exhausted", "stale"}:
            triage.append(
                {
                    "job_url": job["url"],
                    "title": job.get("title") or "Untitled",
                    "company": job.get("site") or "Unknown",
                    "site": job.get("site") or "Unknown",
                    "stage": action["stage"],
                    "state": action["state"],
                    "retryable": bool(action.get("retryable", True)),
                    "error_code": action.get("error_code") or action["state"].upper(),
                    "error_message": action.get("error_message") or f"{action['stage']} is {action['state']}",
                    "attempt_count": action.get("attempt_count") or 0,
                    "max_attempts": action.get("max_attempts"),
                    "exhausted": action["state"] == "exhausted",
                    "blocked_by": action.get("blocked_by", []),
                    "finished_at": action.get("finished_at") or action.get("updated_at") or job.get("discovered_at"),
                    "fit_score": job.get("fit_score"),
                    "next_action": action.get("next_action") or _default_retry_command(job["url"], action["stage"]),
                    "severity": _severity(action, job),
                }
            )

        if apply_state["state"] == "pending":
            ready.append(
                {
                    "job_url": job["url"],
                    "title": job.get("title") or "Untitled",
                    "company": job.get("site") or "Unknown",
                    "fit_score": job.get("fit_score") or 0,
                    "tailored_at": job.get("tailored_at"),
                    "cover_letter_at": job.get("cover_letter_at"),
                    "pdf_at": job.get("cover_letter_at") or job.get("tailored_at"),
                    "salary": job.get("salary") or "",
                    "location": job.get("location") or "",
                }
            )

        job_detail[job["url"]] = {
            "url": job["url"],
            "title": job.get("title") or "Untitled",
            "company": job.get("site") or "Unknown",
            "site": job.get("site") or "Unknown",
            "strategy": job.get("strategy") or "",
            "location": job.get("location") or "",
            "salary": job.get("salary") or "",
            "discovered_at": job.get("discovered_at"),
            "fit_score": job.get("fit_score"),
            "score_reasoning": job.get("score_reasoning"),
            "application_url": job.get("application_url"),
            "stages": states,
            "events": events,
            "artifacts": artifacts,
            "apply_runs": apply_runs_for_job,
            "next_action": _next_action_payload(action),
            "description_preview": (job.get("full_description") or job.get("description") or "")[:800],
        }

    triage.sort(
        key=lambda item: (
            SEVERITY_RANK.get(item["severity"], 9),
            -(item.get("fit_score") or 0),
            item.get("finished_at") or "",
        )
    )
    ready.sort(key=lambda item: (-(item.get("fit_score") or 0), item.get("company") or ""))
    apply_runs = _recent_apply_runs(conn, limit=12)
    activity = _recent_events(conn, limit=20)
    if not activity:
        activity = _legacy_activity(jobs, stage_by_url)

    today = datetime.now(timezone.utc).date().isoformat()
    applied_today = sum(1 for job in jobs if str(job.get("applied_at") or "").startswith(today))
    dry_runs_today = sum(
        1 for run in apply_runs if run["dry_run"] and str(run.get("started_at") or "").startswith(today)
    )

    return {
        "generated_at": utc_now(),
        "schema_version": 2,
        "config": {
            "db_path": str(config.DB_PATH),
            **settings,
        },
        "totals": {
            "jobs": len(jobs),
            "discovered_today": sum(1 for job in jobs if str(job.get("discovered_at") or "").startswith(today)),
            "failures": len([item for item in triage if item["state"] in {"failed", "exhausted"}]),
            "blocked": len([item for item in triage if item["state"] == "blocked"]),
            "ready_to_apply": len(ready),
            "applied_total": sum(1 for job in jobs if job.get("applied_at")),
            "applied_today": applied_today,
            "dry_runs_today": dry_runs_today,
        },
        "stages": list(STAGE_ORDER),
        "funnel": funnel,
        "jobs": job_summaries,
        "artifacts": artifact_summaries,
        "triage": triage,
        "ready": ready[:40],
        "activity": activity,
        "apply_runs": apply_runs,
        "job_detail": job_detail,
        "legacy": {
            "using_legacy_columns": True,
            "state_rows_initialized": True,
        },
    }


def _default_retry_command(job_url: str, stage: str) -> str:
    if stage == "apply":
        return f"jobhunter apply --url {job_url}"
    if stage in {"enrich", "score", "tailor", "cover", "pdf"}:
        return f"jobhunter retry {stage} {job_url}"
    return "jobhunter status"


def _next_action_payload(stage_state: dict[str, Any] | None) -> dict[str, str] | None:
    if not stage_state or not stage_state.get("next_action"):
        return None
    state = stage_state["state"]
    if state == "blocked":
        why = f"{stage_state['stage']} is waiting on {', '.join(stage_state.get('blocked_by') or ['upstream data'])}."
    elif state == "exhausted":
        why = f"{stage_state['stage']} exhausted its retry budget."
    elif state == "failed":
        why = stage_state.get("error_message") or f"{stage_state['stage']} failed."
    elif state == "pending":
        why = f"{stage_state['stage']} is the next pending stage."
    else:
        why = f"{stage_state['stage']} needs attention."
    return {"cmd": stage_state["next_action"], "why": why}


def _legacy_activity(jobs: list[dict[str, Any]], stage_by_url: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    events = []
    for job in jobs[:20]:
        states = stage_by_url[job["url"]]
        action = _first_actionable_stage(states)
        if not action:
            continue
        level = (
            "error"
            if action["state"] in {"failed", "exhausted"}
            else "warn"
            if action["state"] == "blocked"
            else "info"
        )
        events.append(
            {
                "at": action.get("finished_at") or job.get("discovered_at") or "",
                "level": level,
                "stage": action["stage"],
                "message": action.get("error_message") or f"{action['stage']} is {action['state']}",
                "job": _job_label(job),
            }
        )
    return events


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
