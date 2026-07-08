"""Apply orchestration — thin shell over the Apply Automation domain.

PR 4 of the Temporal stack collapsed the bespoke ``apply_runs`` table
into the workflow run history. The launcher now drives apply lifecycle
state via:

  * ``job_stage_states.apply`` — the canonical "is this job locked /
    succeeded / failed" row (already maintained by ``state.set_stage_state``).
  * ``record_job_event(stage='apply', payload={"run_id": ...})`` — the
    durable event stream the projection builder consumes to materialise
    ``apply_run_projections``.

The legacy public surface (``main``, ``run_job``, ``worker_loop``,
``acquire_job``, ``mark_result``, ``release_lock``, ``gen_prompt``,
``mark_job``, ``reset_failed``) is preserved so callers (``cli.py``,
``actions.py``, ``pipeline.py``, regression tests) keep working.

The Rich dashboard from ``apply/dashboard.py`` continues to drive the
CLI display. The launcher refreshes it directly from the saga events
so we don't need a brand-new presentation adapter just yet.
"""

from __future__ import annotations

import atexit
import html
import json
import logging
import platform
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.live import Live

from jobctrl import config
from jobctrl.apply import prompt as prompt_mod  # noqa: F401  -- kept for back-compat imports
from jobctrl.apply.chrome import (
    BASE_CDP_PORT,
    _kill_process_tree,
    cleanup_on_exit,
    kill_all_chrome,
    reset_worker_dir,
)
from jobctrl.apply.dashboard import (
    add_event,
    get_totals,
    init_worker,
    render_full,
    update_state,
)
from jobctrl.database import (
    _ACTIVE_STATE_JOIN,
    _EFFECTIVE_APPLICATION_URL,
    _EFFECTIVE_APPLIED_AT,
    _EFFECTIVE_APPLY_TARGET_URL,
    _EFFECTIVE_APPLY_STATUS,
    _EFFECTIVE_COVER_PATH,
    _EFFECTIVE_FIT_SCORE,
    _EFFECTIVE_FULL_DESCRIPTION,
    _EFFECTIVE_TAILOR_PATH,
    _ENRICHMENT_JOIN,
    _ENRICHMENT_NOT_QUARANTINED,
    _LATEST_APPLY_RUN_JOIN,
    _LATEST_MATERIALS_JOIN,
    _LATEST_SCORE_JOIN,
    _NOT_CLOSED_ACTIVE_STATE,
    _READY_TAILORED_RESUME_WITH_PDF,
    _SCORE_DOWNSTREAM_STATE_JOIN,
    _SCORE_CURRENT_FOR_DOWNSTREAM,
    _SCORE_ELIGIBLE_FOR_DOWNSTREAM,
    _order_rows_by_feedback,
    ensure_application_review_decision_columns,
    get_connection,
)
from jobctrl.domain.apply.services import ApplyPromptBuilder
from jobctrl.domain.apply.value_objects import ApplyPrompt, ApplyRunId, new_apply_run_id
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.operational_metrics import record_operational_attempt_metric
from jobctrl.state import (
    ensure_job_stage_rows,
    record_job_artifact,
    record_job_event,
    set_stage_state,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Process-wide bookkeeping (kept for parity with the legacy launcher
# so signal handlers / Ctrl+C can interrupt mid-run).
# ---------------------------------------------------------------------------

POLL_INTERVAL = config.DEFAULTS["poll_interval"]
_stop_event = threading.Event()
_claude_procs: dict[int, subprocess.Popen] = {}
_claude_lock = threading.Lock()

atexit.register(cleanup_on_exit)
if platform.system() != "Windows" and threading.current_thread() is threading.main_thread():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


def _kill_claude_processes_for_interrupt() -> None:
    from jobctrl.infrastructure.apply.claude_code_cli import (
        kill_active_claude_processes,
    )

    kill_active_claude_processes()
    with _claude_lock:
        for _wid, cproc in list(_claude_procs.items()):
            if cproc.poll() is None:
                _kill_process_tree(cproc.pid)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Stage-state-driven acquire / release / mark helpers
# ---------------------------------------------------------------------------


def _has_active_apply(conn, url: str) -> bool:
    """True when ``job_stage_states.apply.state == 'running'`` for ``url``.

    The §4.6 invariant — at most one in-progress apply per JobId —
    is enforced by checking the canonical stage state row.
    """
    row = conn.execute(
        "SELECT 1 FROM job_stage_states "
        "WHERE job_url = ? AND stage = 'apply' AND state = 'running' LIMIT 1",
        (url,),
    ).fetchone()
    return row is not None


def _has_succeeded_apply(conn, url: str) -> bool:
    """True when the canonical apply stage row is succeeded for ``url``."""
    row = conn.execute(
        "SELECT 1 FROM job_stage_states "
        "WHERE job_url = ? AND stage = 'apply' AND state = 'succeeded' LIMIT 1",
        (url,),
    ).fetchone()
    return row is not None


def _has_needs_verification_apply(conn, url: str) -> bool:
    """True when a live apply is parked for manual verification."""
    row = conn.execute(
        "SELECT 1 FROM job_stage_states "
        "WHERE job_url = ? AND stage = 'apply' AND state = 'needs_verification' LIMIT 1",
        (url,),
    ).fetchone()
    return row is not None


def _attempt_count_for(conn, url: str) -> int:
    """Return the canonical attempt count from ``job_stage_states.apply``."""
    row = conn.execute(
        "SELECT attempt_count FROM job_stage_states "
        "WHERE job_url = ? AND stage = 'apply' LIMIT 1",
        (url,),
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _latest_apply_review_decision(conn, *, tenant_id: str, job_key: str) -> dict[str, Any] | None:
    ensure_application_review_decision_columns(conn)
    row = conn.execute(
        """
        SELECT decision, materials_generation, profile_version, application_url,
               partial_override_run_id, email_recipient, email_attachment_artifact_id
        FROM application_review_decisions
        WHERE tenant_id = ? AND job_key = ?
        ORDER BY decided_at DESC, decision_id DESC
        LIMIT 1
        """,
        (tenant_id, job_key),
    ).fetchone()
    if row is None:
        return None
    return dict(row) if hasattr(row, "keys") else {
        "decision": row[0],
        "materials_generation": row[1],
        "profile_version": row[2],
        "application_url": row[3],
        "partial_override_run_id": row[4],
        "email_recipient": row[5],
        "email_attachment_artifact_id": row[6],
    }


def _latest_email_application_candidate(conn, *, job_key: str) -> dict[str, Any] | None:
    try:
        row = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE job_url = ?
              AND stage = 'apply'
              AND event_type = 'EmailApplicationCandidateRecorded'
            ORDER BY occurred_at DESC, event_id DESC
            LIMIT 1
            """,
            (job_key,),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return None
    if row is None:
        return None
    raw = row["payload_json"] if hasattr(row, "keys") else row[0]
    try:
        payload = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _current_profile_version(conn, *, tenant_id: str = "local") -> int | None:
    columns = {
        row[1]
        for row in conn.execute("PRAGMA table_info(candidate_profiles)").fetchall()
    }
    if "version" not in columns:
        return None
    row = conn.execute(
        "SELECT version FROM candidate_profiles WHERE tenant_id = ? AND profile_id = 'default'",
        (tenant_id,),
    ).fetchone()
    if row is None:
        return None
    value = row["version"] if hasattr(row, "keys") else row[0]
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _payload_from_row(row) -> dict[str, Any]:
    payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
    if not payload_json:
        return {}
    try:
        payload = json.loads(payload_json)
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _payload_value(payload: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
    return None


def _payload_int(payload: dict[str, Any], *names: str) -> int | None:
    value = _payload_value(payload, *names)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _dry_run_evidence_exists(
    conn,
    *,
    job_key: str,
    materials_generation: int,
    profile_version: int,
    application_url: str,
    coverage: str,
    run_id: str | None = None,
) -> bool:
    rows = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE job_url = ? AND stage = 'apply' AND event_type = 'DryRunCompleted'
        ORDER BY event_id DESC
        LIMIT 24
        """,
        (job_key,),
    ).fetchall()
    for row in rows:
        payload = _payload_from_row(row)
        payload_run_id = str(_payload_value(payload, "run_id", "runId") or "")
        if not payload_run_id:
            continue
        if run_id and payload_run_id != run_id:
            continue
        if str(_payload_value(payload, "coverage", "dry_run_coverage") or "") != coverage:
            continue
        payload_generation = _payload_int(payload, "materials_generation", "materialsGeneration")
        payload_profile_version = _payload_int(payload, "profile_version", "profileVersion")
        payload_url = str(_payload_value(payload, "application_url", "applicationUrl") or "")
        started_rows = conn.execute(
            """
            SELECT payload_json FROM job_events
            WHERE job_url = ? AND stage = 'apply' AND event_type = 'ApplyRunStarted'
            ORDER BY event_id DESC
            LIMIT 48
            """,
            (job_key,),
        ).fetchall()
        for started_row in started_rows:
            started_payload = _payload_from_row(started_row)
            if str(_payload_value(started_payload, "run_id", "runId") or "") != payload_run_id:
                continue
            if (
                (
                    payload_generation
                    if payload_generation is not None
                    else _payload_int(
                        started_payload,
                        "materials_generation",
                        "materialsGeneration",
                    )
                )
                == materials_generation
                and (
                    payload_profile_version
                    if payload_profile_version is not None
                    else _payload_int(
                        started_payload,
                        "profile_version",
                        "profileVersion",
                    )
                )
                == profile_version
                and (
                    payload_url
                    or str(
                        _payload_value(
                            started_payload,
                            "application_url",
                            "applicationUrl",
                        )
                        or ""
                    )
                )
                == application_url
            ):
                return True
    return False


def _apply_run_started_payload(conn, *, job_key: str, run_id: str) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE job_url = ? AND stage = 'apply' AND event_type = 'ApplyRunStarted'
        ORDER BY event_id DESC
        LIMIT 48
        """,
        (job_key,),
    ).fetchall()
    for row in rows:
        payload = _payload_from_row(row)
        if str(_payload_value(payload, "run_id", "runId") or "") == run_id:
            return payload
    return {}


def _dry_run_completion_binding(
    conn,
    *,
    job_key: str,
    run_id: str,
    run_ctx: dict | None,
) -> dict[str, Any]:
    ctx = run_ctx or {}
    started_payload = _apply_run_started_payload(conn, job_key=job_key, run_id=run_id)
    materials_generation = _payload_int(ctx, "materials_generation", "materialsGeneration")
    if materials_generation is None:
        materials_generation = _payload_int(
            started_payload,
            "materials_generation",
            "materialsGeneration",
        )
    application_url = str(
        _payload_value(ctx, "application_url", "applicationUrl")
        or _payload_value(started_payload, "application_url", "applicationUrl")
        or ""
    )
    profile_version = _payload_int(ctx, "profile_version", "profileVersion")
    if profile_version is None:
        profile_version = _payload_int(started_payload, "profile_version", "profileVersion")
    coverage = str(_payload_value(ctx, "coverage", "dry_run_coverage") or "full")
    if coverage not in {"full", "partial"}:
        coverage = "full"
    blocked_channels = _payload_value(ctx, "blocked_channels", "blockedChannels") or []
    if not isinstance(blocked_channels, list):
        blocked_channels = [str(blocked_channels)]
    return {
        "materials_generation": materials_generation,
        "application_url": application_url or None,
        "profile_version": profile_version,
        "coverage": coverage,
        "blocked_channels": [
            str(channel)
            for channel in blocked_channels
            if channel is not None and str(channel)
        ],
    }


def _approval_refusal_reason(
    conn,
    *,
    tenant_id: str,
    job_key: str,
    materials_generation: Any,
    profile_version: int | None,
    application_url: str,
) -> str | None:
    decision = _latest_apply_review_decision(
        conn,
        tenant_id=tenant_id,
        job_key=job_key,
    )
    if not decision or decision.get("decision") != "approve_submit":
        return "awaiting_approval"
    try:
        current_materials_generation = int(materials_generation)
    except (TypeError, ValueError):
        return "approval_stale_materials"
    try:
        decision_materials_generation = int(decision.get("materials_generation"))
    except (TypeError, ValueError):
        return "approval_stale_materials"
    if decision_materials_generation != current_materials_generation:
        return "approval_stale_materials"
    try:
        decision_profile_version = int(decision.get("profile_version"))
    except (TypeError, ValueError):
        return "approval_stale_profile"
    if profile_version is None or decision_profile_version != profile_version:
        return "approval_stale_profile"
    if str(decision.get("application_url") or "") != application_url:
        return "approval_stale_url"
    email_candidate = _latest_email_application_candidate(conn, job_key=job_key)
    if email_candidate:
        if (
            str(decision.get("email_recipient") or "").lower()
            != str(email_candidate.get("recipient") or "").lower()
            or str(decision.get("email_attachment_artifact_id") or "")
            != str(email_candidate.get("attachment_artifact_id") or "")
        ):
            return "approval_stale_email_candidate"
    if _dry_run_evidence_exists(
        conn,
        job_key=job_key,
        materials_generation=current_materials_generation,
        profile_version=decision_profile_version,
        application_url=application_url,
        coverage="full",
    ):
        return None
    partial_override_run_id = str(decision.get("partial_override_run_id") or "")
    if partial_override_run_id:
        if _dry_run_evidence_exists(
            conn,
            job_key=job_key,
            materials_generation=current_materials_generation,
            profile_version=decision_profile_version,
            application_url=application_url,
            coverage="partial",
            run_id=partial_override_run_id,
        ):
            return None
        return "override_evidence_invalid"
    return "awaiting_dry_run"


def _load_blocked():
    from jobctrl.config import load_blocked_sites

    return load_blocked_sites()


def _row_to_job_dict(row, *, run_id: ApplyRunId | None = None) -> dict[str, Any]:
    job = dict(row)
    if run_id is not None:
        job["apply_run_id"] = str(run_id)
    return job


def acquire_job(
    target_url: str | None = None,
    min_score: int = 7,
    worker_id: int = 0,
    run_ctx: dict | None = None,
    approval_required: bool = True,
) -> dict | None:
    """Atomically acquire the next job to apply to.

    The lock is taken on ``job_stage_states.apply.state == 'running'`` —
    PR 4 of the Temporal stack made the canonical stage row the only
    apply lock; the bespoke ``apply_runs`` table is gone. The
    ``ApplyRunStarted`` event is published on the same transaction so
    the projection builder materialises the corresponding
    ``apply_run_projections`` row on the next refresh.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")

        attempts_subquery = (
            "(SELECT COALESCE(jss_a.attempt_count, 0) "
            "FROM job_stage_states jss_a "
            "WHERE jss_a.job_url = jobs.url AND jss_a.stage = 'apply' LIMIT 1) AS apply_attempts"
        )
        common_columns = (
            f"jobs.url AS url, jobs.title AS title, jobs.site AS site, "
            f"{_EFFECTIVE_APPLICATION_URL} AS application_url, "
            f"{_EFFECTIVE_TAILOR_PATH} AS tailored_resume_path, "
            f"jm.jm_resume_pdf_path AS resume_pdf_path, "
            f"jm.jm_resume_pdf_artifact_id AS resume_pdf_artifact_id, "
            f"jm.jm_generation AS materials_generation, "
            f"{_EFFECTIVE_FIT_SCORE} AS fit_score, "
            f"jobs.location AS location, jobs.description AS description, "
            f"{_EFFECTIVE_FULL_DESCRIPTION} AS full_description, "
            f"{_EFFECTIVE_COVER_PATH} AS cover_letter_path, "
            f"{_EFFECTIVE_APPLIED_AT} AS applied_at, "
            f"{_EFFECTIVE_APPLY_STATUS} AS apply_status, "
            f"{attempts_subquery}"
        )
        common_joins = (
            f"{_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
            f"{_SCORE_DOWNSTREAM_STATE_JOIN} {_ENRICHMENT_JOIN} "
            f"{_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN}"
        )

        if target_url:
            like = f"%{target_url.split('?')[0].rstrip('/')}%"
            row = conn.execute(
                f"""
                SELECT {common_columns}
                FROM jobs {common_joins}
                WHERE (jobs.url = ? OR {_EFFECTIVE_APPLICATION_URL} = ?
                       OR {_EFFECTIVE_APPLICATION_URL} LIKE ? OR jobs.url LIKE ?)
                  AND {_READY_TAILORED_RESUME_WITH_PDF}
                  AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM}
                  AND {_SCORE_CURRENT_FOR_DOWNSTREAM}
                  AND {_NOT_CLOSED_ACTIVE_STATE}
                LIMIT 1
                """,
                (target_url, target_url, like, like),
            ).fetchone()
        else:
            blocked_sites, blocked_patterns = _load_blocked()
            params: list[Any] = [
                config.DEFAULTS["max_apply_attempts"],
                min_score,
            ]
            site_clause = ""
            if blocked_sites:
                placeholders = ",".join("?" * len(blocked_sites))
                site_clause = f"AND jobs.site NOT IN ({placeholders})"
                params.extend(blocked_sites)
            url_clauses = ""
            if blocked_patterns:
                url_clauses = " ".join(
                    "AND jobs.url NOT LIKE ?" for _ in blocked_patterns
                )
                params.extend(blocked_patterns)
            rows = conn.execute(
                f"""
                SELECT {common_columns}
                FROM jobs {common_joins}
                WHERE {_READY_TAILORED_RESUME_WITH_PDF}
                  AND {_EFFECTIVE_APPLY_TARGET_URL} IS NOT NULL
                  AND {_EFFECTIVE_APPLY_TARGET_URL} != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM job_stage_states jss_active
                      WHERE jss_active.job_url = jobs.url
                        AND jss_active.stage = 'apply'
                        AND jss_active.state IN ('running', 'succeeded', 'needs_verification')
                  )
                  AND COALESCE(
                      (SELECT jss_a.attempt_count FROM job_stage_states jss_a
                       WHERE jss_a.job_url = jobs.url AND jss_a.stage = 'apply'
                       LIMIT 1), 0
                  ) < ?
                  AND {_EFFECTIVE_FIT_SCORE} >= ?
                  AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM}
                  AND {_SCORE_CURRENT_FOR_DOWNSTREAM}
                  AND {_NOT_CLOSED_ACTIVE_STATE}
                  AND {_ENRICHMENT_NOT_QUARANTINED}
                  {site_clause}
                  {url_clauses}
                ORDER BY {_EFFECTIVE_FIT_SCORE} DESC, jobs.url
                """,
                params,
            ).fetchall()
            ordered_rows = _order_rows_by_feedback(conn, rows)
            row = ordered_rows[0] if ordered_rows else None

        if not row:
            conn.rollback()
            return None

        # Skip manual ATS sites (the agent cannot solve them).
        from jobctrl.config import is_manual_ats

        url = row["url"]
        apply_url = row["application_url"] or url
        if is_manual_ats(apply_url):
            now = _utc_now()
            ensure_job_stage_rows(conn, url)
            set_stage_state(
                conn,
                url,
                "apply",
                "skipped",
                finished_at=now,
                error_code="MANUAL_ATS",
                error_message="manual ATS",
                retryable=False,
            )
            run_id = new_apply_run_id()
            record_job_event(
                conn,
                url,
                "apply",
                "ApplyManualSkip",
                level="info",
                message="manual ATS",
                payload={
                    "run_id": str(run_id),
                    "result": "manual",
                    "started_at": now,
                    "finished_at": now,
                    "duration_ms": 0,
                    "worker_id": worker_id,
                },
            )
            conn.commit()
            logger.info("Skipping manual ATS: %s", url[:80])
            return None

        # Targeted-mode also enforces the no-active + max-attempts
        # invariants (the SELECT above is permissive on target_url so
        # we can surface "no such job" errors clearly).
        if _has_active_apply(conn, url):
            conn.rollback()
            return None
        if _has_succeeded_apply(conn, url):
            conn.rollback()
            return None
        if _has_needs_verification_apply(conn, url):
            conn.rollback()
            return None
        attempts = _attempt_count_for(conn, url)
        if attempts >= int(config.DEFAULTS["max_apply_attempts"]):
            conn.rollback()
            return None
        dry_run = bool(run_ctx.get("dry_run")) if run_ctx else False
        if approval_required and not dry_run:
            refusal_reason = _approval_refusal_reason(
                conn,
                tenant_id=LOCAL_TENANT,
                job_key=url,
                materials_generation=row["materials_generation"],
                profile_version=_current_profile_version(conn, tenant_id=LOCAL_TENANT),
                application_url=apply_url,
            )
            if refusal_reason:
                conn.rollback()
                add_event(
                    f"[W{worker_id}] Awaiting apply approval "
                    f"({refusal_reason}) for {(row['title'] or url)[:40]}"
                )
                logger.info(
                    "Apply approval required for %s; refusal_reason=%s",
                    url,
                    refusal_reason,
                )
                return None

        now = _utc_now()
        run_id = ApplyRunId(
            (run_ctx.get("run_id") if run_ctx else None) or new_apply_run_id()
        )
        ensure_job_stage_rows(conn, url)
        # Reset prior retryable terminal state (failed / exhausted /
        # canceled / skipped) back to pending so the §8.5 state machine accepts
        # the pending → running transition.
        prior_row = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply' LIMIT 1",
            (url,),
        ).fetchone()
        if prior_row is not None and prior_row[0] not in {
            "pending",
            "running",
            "succeeded",
            "needs_verification",
        }:
            set_stage_state(
                conn,
                url,
                "apply",
                "pending",
                validate_transition=False,
            )
        set_stage_state(
            conn,
            url,
            "apply",
            "running",
            started_at=now,
            attempt_count=attempts + 1,
        )
        record_job_event(
            conn,
            url,
            "apply",
            "ApplyRunStarted",
            message="Apply agent acquired job",
            payload={
                "run_id": str(run_id),
                "model": (run_ctx.get("model") if run_ctx else None),
                "dry_run": bool(run_ctx.get("dry_run")) if run_ctx else False,
                "worker_id": worker_id,
                "started_at": now,
                "headless": bool(run_ctx.get("headless")) if run_ctx else False,
                "attempts": attempts + 1,
                "workflow_id": run_ctx.get("workflow_id") if run_ctx else None,
                "materials_generation": row["materials_generation"],
                "application_url": apply_url,
                "profile_version": _current_profile_version(conn, tenant_id=LOCAL_TENANT),
            },
        )
        conn.commit()

        if run_ctx is not None:
            run_ctx["run_id"] = str(run_id)
            run_ctx.setdefault("worker_id", worker_id)
            run_ctx["materials_generation"] = row["materials_generation"]
            run_ctx["application_url"] = apply_url
            run_ctx["profile_version"] = _current_profile_version(
                conn,
                tenant_id=LOCAL_TENANT,
            )

        job_dict = _row_to_job_dict(row, run_id=run_id)
        decision = _latest_apply_review_decision(
            conn,
            tenant_id=LOCAL_TENANT,
            job_key=url,
        )
        if decision:
            job_dict["approved_email_recipient"] = str(decision.get("email_recipient") or "")
            job_dict["approved_email_attachment_artifact_id"] = str(
                decision.get("email_attachment_artifact_id") or ""
            )
        return job_dict
    except Exception:
        conn.rollback()
        raise


def _register_apply_log_artifact(
    conn,
    url: str,
    *,
    worker_id: int | None,
    run_id: str,
    occurred_at: str,
) -> None:
    """Record the per-worker apply log (``LOG_DIR/worker-{worker_id}.log``,
    written by :class:`ClaudeCodeCliAdapter`) as a ``job_artifacts`` row;
    no-op when ``worker_id`` is ``None`` (manual ``mark_result`` calls)."""
    if worker_id is None:
        return
    log_path = config.LOG_DIR / f"worker-{int(worker_id)}.log"
    record_job_artifact(
        conn,
        url,
        "apply",
        "apply_log",
        log_path,
        status="active",
        created_at=occurred_at,
        metadata={"run_id": str(run_id), "worker_id": int(worker_id)},
    )


def mark_result(
    url: str,
    status: str,
    error: str | None = None,
    permanent: bool = False,
    duration_ms: int | None = None,
    task_id: str | None = None,
    run_ctx: dict | None = None,
) -> None:
    """Update a job's apply outcome.

    Writes go to ``job_stage_states.apply`` (canonical lifecycle row),
    a terminal ``ApplicationSubmitted`` / ``ApplicationFailed`` /
    ``DryRunCompleted`` event whose payload feeds
    ``apply_run_projections``, and — when the run carries a
    ``worker_id`` — a ``job_artifacts`` row pointing at the agent's
    per-worker log file (kind ``apply_log``). The legacy
    ``jobs.apply_*`` columns are NOT touched.
    """
    conn = get_connection()
    now = _utc_now()
    ensure_job_stage_rows(conn, url)

    run_id = (
        task_id
        or (run_ctx.get("run_id") if run_ctx else None)
        or new_apply_run_id()
    )
    worker_id = run_ctx.get("worker_id") if run_ctx else None
    model = run_ctx.get("model") if run_ctx else None
    dry_run = bool(run_ctx.get("dry_run")) if run_ctx else False

    if status == "applied":
        # Launcher owns lock-release policy: if a competing process raced
        # the row out of `running` (orphan rescue, mark-skipped, etc.) we
        # still want to record this completion. Skip canonical validation;
        # the launcher is the writer.
        set_stage_state(
            conn, url, "apply", "succeeded",
            finished_at=now, duration_ms=duration_ms,
            validate_transition=False,
        )
        record_job_event(
            conn,
            url,
            "apply",
            "ApplicationSubmitted",
            message="Application submitted",
            payload={
                "run_id": str(run_id),
                "result": "applied",
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
            },
        )
    elif status == "dry_run":
        binding = _dry_run_completion_binding(
            conn,
            job_key=url,
            run_id=str(run_id),
            run_ctx=run_ctx,
        )
        # Launcher owns lock-release policy: Running -> Skipped is a launcher
        # convention (dry-run completed), not in the canonical §8.5 table.
        set_stage_state(
            conn,
            url,
            "apply",
            "skipped",
            finished_at=now,
            duration_ms=duration_ms,
            error_code="DRY_RUN",
            error_message="Dry run completed without submitting.",
            retryable=True,
            next_action=f"jobctrl apply --url {url}",
            validate_transition=False,
        )
        record_job_event(
            conn,
            url,
            "apply",
            "DryRunCompleted",
            message="Dry run completed without submitting",
            payload={
                "run_id": str(run_id),
                "result": "dry_run_complete",
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
                "dry_run": True,
                "coverage": binding["coverage"],
                "blocked_channels": binding["blocked_channels"],
                "materials_generation": binding["materials_generation"],
                "application_url": binding["application_url"],
                "profile_version": binding["profile_version"],
            },
        )
    else:
        reason = (error or "unknown").strip()
        # Same launcher-policy reasoning as the applied branch above:
        # the writer is the launcher, transitions are runner-owned.
        set_stage_state(
            conn,
            url,
            "apply",
            "failed",
            finished_at=now,
            duration_ms=duration_ms,
            error_code=str(status).upper(),
            error_message=reason,
            retryable=not permanent,
            next_action=f"jobctrl apply --url {url}" if not permanent else None,
            validate_transition=False,
        )
        record_job_event(
            conn,
            url,
            "apply",
            "ApplicationFailed",
            level="error",
            message=reason,
            payload={
                "run_id": str(run_id),
                "result": reason,
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
                "dry_run": dry_run,
            },
        )

    _register_apply_log_artifact(
        conn, url, worker_id=worker_id, run_id=str(run_id), occurred_at=now
    )
    conn.commit()


def _latest_apply_run_started_run_id(conn, url: str) -> str | None:
    """Look up the run_id of the most recent ``ApplyRunStarted`` event for ``url``.

    Used by orphan rescue (and any caller without a ``run_ctx``) to
    close the SAME run row instead of minting a phantom new uuid that
    leaves the original run stuck in ``status='starting'`` forever.
    """
    row = conn.execute(
        "SELECT payload_json FROM job_events "
        "WHERE job_url = ? AND stage = 'apply' AND event_type = 'ApplyRunStarted' "
        "ORDER BY event_id DESC LIMIT 1",
        (url,),
    ).fetchone()
    if row is None:
        return None
    payload_json = row["payload_json"] if not isinstance(row, tuple) else row[0]
    if not payload_json:
        return None
    try:
        payload = json.loads(payload_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    run_id = payload.get("run_id")
    return str(run_id) if run_id else None


def release_lock(url: str, run_ctx: dict | None = None) -> None:
    """Record that launcher cleanup ran without making retry decisions."""
    conn = get_connection()
    ctx_run_id = run_ctx.get("run_id") if run_ctx else None
    run_id = (
        ctx_run_id
        or _latest_apply_run_started_run_id(conn, url)
        or new_apply_run_id()
    )
    record_job_event(
        conn,
        url,
        "apply",
        "LockReleased",
        message="Apply lock released",
        payload={"run_id": str(run_id)},
    )
    conn.commit()


def recover_ambiguous_running_apply(console: Console | None = None) -> int:
    """Recover apply rows inherited from a prior dead workflow/activity."""
    try:
        conn = get_connection()
        rows = conn.execute(
            "SELECT job_url FROM job_stage_states "
            "WHERE stage = 'apply' AND state = 'running'"
        ).fetchall()
        recovered = 0
        for row in rows:
            url = str(row["job_url"] if hasattr(row, "keys") else row[0])
            try:
                run_id, workflow_id = _latest_apply_run_started_identity(conn, url)
                if not _workflow_terminal_or_gone(conn, workflow_id or run_id):
                    continue
                if run_id and _has_apply_submit_intent(conn, url, run_id):
                    if _has_apply_terminal_result(conn, url, run_id):
                        continue
                    set_stage_state(
                        conn,
                        url,
                        "apply",
                        "needs_verification",
                        error_code="APPLY_NEEDS_VERIFICATION",
                        error_message="Live apply reached the submit-intent checkpoint without a terminal result.",
                        retryable=False,
                        next_action="Review the employer site or confirmation email before retrying.",
                        validate_transition=False,
                    )
                else:
                    set_stage_state(
                        conn,
                        url,
                        "apply",
                        "pending",
                        next_action=f"jobctrl apply --url {url}",
                        validate_transition=False,
                    )
                recovered += 1
            except Exception:  # noqa: BLE001
                logger.exception("Apply recovery failed for %s", url)
                continue
        if recovered:
            conn.commit()
            if console is not None:
                console.print(
                    f"[yellow]Recovered {recovered} ambiguous apply run(s) from prior crash[/yellow]"
                )
        return recovered
    except Exception:  # noqa: BLE001
        logger.exception("Apply recovery sweep failed")
        return 0


def _latest_apply_run_started_identity(conn, url: str) -> tuple[str | None, str | None]:
    row = conn.execute(
        "SELECT payload_json FROM job_events "
        "WHERE job_url = ? AND stage = 'apply' AND event_type = 'ApplyRunStarted' "
        "ORDER BY event_id DESC LIMIT 1",
        (url,),
    ).fetchone()
    if row is None:
        return None, None
    payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
    try:
        payload = json.loads(payload_json or "{}")
    except (TypeError, ValueError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    run_id = str(payload.get("run_id") or "") or None
    workflow_id = str(payload.get("workflow_id") or "") or None
    return run_id, workflow_id


def _workflow_terminal_or_gone(conn, workflow_id: str | None) -> bool:
    if not workflow_id:
        return True
    try:
        row = conn.execute(
            "SELECT status FROM workflow_run_projections WHERE workflow_id = ? LIMIT 1",
            (workflow_id,),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return True
    if row is None:
        return True
    status = str(row["status"] if hasattr(row, "keys") else row[0])
    return status in {"succeeded", "failed", "canceled", "timed_out", "terminated"}


def _has_apply_submit_intent(conn, url: str, run_id: str) -> bool:
    return _has_apply_event(conn, url, run_id, {"ApplySubmitIntended"})


def _has_apply_terminal_result(conn, url: str, run_id: str) -> bool:
    return _has_apply_event(
        conn,
        url,
        run_id,
        {"ApplicationSubmitted", "ApplicationFailed", "DryRunCompleted", "ApplyManualSkip"},
    )


def _has_apply_event(conn, url: str, run_id: str, event_types: set[str]) -> bool:
    placeholders = ",".join("?" for _ in event_types)
    rows = conn.execute(
        f"""
        SELECT payload_json FROM job_events
        WHERE job_url = ? AND stage = 'apply' AND event_type IN ({placeholders})
        """,
        (url, *event_types),
    ).fetchall()
    for row in rows:
        payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
        try:
            payload = json.loads(payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict) and str(payload.get("run_id") or "") == run_id:
            return True
    return False


# ---------------------------------------------------------------------------
# Manual mark / reset helpers — operate on the canonical stage row +
# event stream, never on the legacy jobs.apply_* columns.
# ---------------------------------------------------------------------------


def mark_job(url: str, status: str, reason: str | None = None) -> None:
    """Manually mark a job's apply status."""
    if status == "applied":
        mark_result(url, "applied", duration_ms=0)
    else:
        mark_result(
            url,
            "failed",
            error=reason or "manual",
            permanent=True,
            duration_ms=0,
        )


def reset_failed() -> int:
    """Reset failed jobs so they can be retried.

    Re-queues every job whose canonical apply stage state is ``failed``
    by flipping it back to ``pending`` and zeroing the attempt counter.
    The historical event stream is preserved (no audit history is
    purged); only the live state row is rewound. Returns the number of
    jobs reset.
    """
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT job_url FROM job_stage_states
        WHERE stage = 'apply' AND state IN ('failed', 'exhausted')
        """
    ).fetchall()
    count = 0
    for row in rows:
        url = row["job_url"]
        # Skip jobs that already succeeded on a prior run.
        if _has_succeeded_apply(conn, url):
            continue
        ensure_job_stage_rows(conn, url)
        # Per-row try/except so one race-induced failure (e.g., another
        # worker flipped the row to ``running`` between the SELECT and
        # this write) doesn't strand every subsequent row in the batch
        # without a commit. Admin-initiated rewind so the runner owns the
        # transition policy: validate_transition=False bypasses the
        # canonical state-machine table (Failed -> Pending is fine but
        # Running -> Pending is not).
        try:
            set_stage_state(
                conn,
                url,
                "apply",
                "pending",
                attempt_count=0,
                error_code=None,
                error_message=None,
                next_action=f"jobctrl apply --url {url}",
                validate_transition=False,
            )
            count += 1
        except Exception as exc:  # noqa: BLE001 — keep batch reset alive
            logger.warning("reset_failed: skipping %s — %s", url, exc)
    conn.commit()
    return count


# ---------------------------------------------------------------------------
# Profile snapshot loader (kept for back-compat with callers that
# import it).
# ---------------------------------------------------------------------------


def _load_profile_snapshot() -> ProfileSnapshot:
    from jobctrl.infrastructure.profile import get_profile_repository

    return get_profile_repository().load_snapshot(LOCAL_TENANT)


# ---------------------------------------------------------------------------
# gen_prompt (debug helper) — no DB writes
# ---------------------------------------------------------------------------


def gen_prompt(
    target_url: str,
    min_score: int = 7,
    model: str = "default",
    worker_id: int = 0,
    snapshot: ProfileSnapshot | None = None,
) -> Path | None:
    """Render the prompt + MCP config for one job for manual debugging."""
    job = acquire_job(target_url=target_url, min_score=min_score, worker_id=worker_id)
    if not job:
        return None

    apply_url = str(job.get("application_url") or job.get("url") or "").strip()
    from jobctrl.infrastructure.network import validate_public_http_url

    decision = validate_public_http_url(apply_url)
    if not decision.allowed:
        release_lock(job["url"])
        raise ValueError(
            f"unsafe apply target URL: {decision.reason or 'not a public HTTP(S) destination'}"
        )

    snapshot = snapshot or _load_profile_snapshot()
    resume_path = job.get("tailored_resume_path")
    txt_path = Path(resume_path).with_suffix(".txt") if resume_path else None
    resume_text = ""
    if txt_path and txt_path.exists():
        resume_text = txt_path.read_text(encoding="utf-8")

    cdp_port = BASE_CDP_PORT + worker_id
    builder = ApplyPromptBuilder()
    apply_prompt: ApplyPrompt = builder.build(
        job=job,
        tailored_resume=resume_text,
        snapshot=snapshot,
        cdp_port=cdp_port,
        dry_run=False,
    )

    release_lock(job["url"])

    config.ensure_dirs()
    site_slug = (job.get("site") or "unknown")[:20].replace(" ", "_")
    title_slug = job["title"][:30].replace(" ", "_")
    prompt_file = config.LOG_DIR / f"prompt_{site_slug}_{title_slug}.txt"
    prompt_file.write_text(apply_prompt.text, encoding="utf-8")

    mcp_path = config.APP_DIR / f".mcp-apply-{worker_id}.json"
    from jobctrl.infrastructure.apply.claude_code_cli import _write_private_json

    _write_private_json(mcp_path, apply_prompt.mcp_config)

    return prompt_file


# ---------------------------------------------------------------------------
# run_job — kept on the public surface for the regression tests +
# pipeline.apply_jobs single-job flow. Delegates to the apply use case.
# ---------------------------------------------------------------------------


def _build_use_case():
    """Construct the canonical local-mode use case wiring.

    Imported lazily — the use case pulls the `Applied`/`Failed` value
    objects, which only the run-job path needs.

    The process-wide ``InProcessEventBus`` is wired in as the publisher.
    Saga events are persisted directly by ``SqliteApplyRunRepository`` as
    the saga checkpoints progress, so ``run_job`` must not replay the
    aggregate timeline at the end of the run.
    """
    from jobctrl.domain.apply.process_manager import ApplySaga
    from jobctrl.domain.apply.services import ApplyEligibilityChecker
    from jobctrl.domain.apply.use_cases import SubmitApplicationUseCase
    from jobctrl.infrastructure.apply import (
        ClaudeCodeCliAdapter,
        GmailEmailApplicationSender,
        LocalChromeAdapter,
    )
    from jobctrl.infrastructure.events import get_default_publisher

    browser_port = LocalChromeAdapter()
    agent_port = ClaudeCodeCliAdapter()
    saga = ApplySaga(
        browser_port=browser_port,
        agent_port=agent_port,
        repository=SqliteApplyRunRepository(),
        email_sender=GmailEmailApplicationSender(),
        timeout_seconds=config.get_apply_timeout_seconds(),
    )
    return SubmitApplicationUseCase(
        repository=SqliteApplyRunRepository(),
        browser_port=browser_port,
        agent_port=agent_port,
        eligibility_checker=ApplyEligibilityChecker(
            max_attempts=int(config.DEFAULTS["max_apply_attempts"])
        ),
        prompt_builder=ApplyPromptBuilder(),
        publisher=get_default_publisher(),
        saga=saga,
        timeout_seconds=config.get_apply_timeout_seconds(),
    )


class SqliteApplyRunRepository:
    """Persist ``ApplyRun`` aggregate events into the canonical event stream."""

    def save(self, run) -> None:
        job_url = str(getattr(run, "job_id", "") or "")
        run_id = str(getattr(run, "run_id", "") or "")
        if not job_url or not run_id:
            return

        conn = get_connection()
        try:
            seen = _existing_apply_event_ids(conn, job_url, run_id)
            for event in list(getattr(run, "events", ()) or ()):
                event_id = int(getattr(event, "event_id", 0) or 0)
                if event_id and event_id in seen:
                    continue
                event_type = str(getattr(event, "event_type", "") or "")
                if not event_type:
                    continue
                payload = dict(getattr(event, "payload", {}) or {})
                payload.setdefault("run_id", run_id)
                payload["event_id"] = event_id
                payload.setdefault("apply_status", str(getattr(run, "status", "") or ""))
                record_job_event(
                    conn,
                    job_url,
                    "apply",
                    event_type,
                    level=str(getattr(event, "level", "info") or "info"),
                    message=getattr(event, "message", None),
                    payload=payload,
                    occurred_at=str(getattr(event, "occurred_at", "") or "") or None,
                )
                _persist_agent_artifacts(conn, job_url, run_id, event_type, payload)
                if event_id:
                    seen.add(event_id)
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise

    def load(self, tenant_id, run_id):
        return None

    def list_active(self, tenant_id):
        return []

    def list_recent(self, tenant_id, *, limit: int = 50):
        return []


def _existing_apply_event_ids(conn, job_url: str, run_id: str) -> set[int]:
    rows = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE job_url = ? AND stage = 'apply' AND payload_json IS NOT NULL
        """,
        (job_url,),
    ).fetchall()
    seen: set[int] = set()
    for row in rows:
        payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
        try:
            payload = json.loads(payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict) or str(payload.get("run_id") or "") != run_id:
            continue
        try:
            event_id = int(payload.get("event_id") or 0)
        except (TypeError, ValueError):
            continue
        if event_id:
            seen.add(event_id)
    return seen


def _persist_agent_artifacts(
    conn,
    job_url: str,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    safe_run = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in run_id)
    artifact_dir = config.LOG_DIR / "apply-artifacts"
    if event_type == "DryRunBlockedChannels":
        blocked_requests = payload.get("blocked_requests")
        if not isinstance(blocked_requests, list) or not blocked_requests:
            return
        artifact_dir.mkdir(parents=True, exist_ok=True)
        blocked_path = artifact_dir / f"{safe_run}-dry-run-blocked.json"
        blocked_path.write_text(
            json.dumps(
                {
                    "run_id": run_id,
                    "coverage": payload.get("coverage") or "partial",
                    "blocked_channels": payload.get("blocked_channels") or [],
                    "blocked_requests": blocked_requests,
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        record_job_artifact(
            conn,
            job_url,
            "apply",
            "apply_dryrun_blocked",
            blocked_path,
            status="active",
            metadata={
                "run_id": run_id,
                "coverage": payload.get("coverage") or "partial",
                "blocked_count": len(blocked_requests),
            },
        )
        return
    if event_type != "AgentResult":
        return
    raw_output = str(payload.get("raw_output") or "")
    if not raw_output:
        return
    artifact_dir.mkdir(parents=True, exist_ok=True)
    output_path = artifact_dir / f"{safe_run}-agent-output.txt"
    output_path.write_text(raw_output, encoding="utf-8")
    record_job_artifact(
        conn,
        job_url,
        "apply",
        "apply_agent_output",
        output_path,
        status="active",
        metadata={"run_id": run_id},
    )
    if str(payload.get("kind") or "") != "applied":
        return
    confirmation_path = artifact_dir / f"{safe_run}-confirmation.html"
    confirmation_path.write_text(
        "<!doctype html><meta charset=\"utf-8\"><title>Apply confirmation</title>"
        f"<pre>{html.escape(raw_output)}</pre>",
        encoding="utf-8",
    )
    record_job_artifact(
        conn,
        job_url,
        "apply",
        "apply_confirmation",
        confirmation_path,
        status="active",
        metadata={"run_id": run_id, "source": "agent_output"},
    )


def _result_to_status_string(result) -> str:
    """Map a ``SubmissionResult`` variant back to the legacy status string."""
    from jobctrl.domain.apply.value_objects import (
        Applied,
        Captcha,
        DryRunComplete,
        Expired,
        Failed,
        LoginIssue,
        Manual,
    )

    if isinstance(result, Applied):
        return "applied"
    if isinstance(result, DryRunComplete):
        return "dry_run"
    if isinstance(result, Expired):
        return "expired"
    if isinstance(result, Captcha):
        return "captcha"
    if isinstance(result, LoginIssue):
        return "login_issue"
    if isinstance(result, Manual):
        return f"failed:{result.reason or 'manual'}"
    if isinstance(result, Failed):
        reason = result.error
        if reason.startswith("TIMEOUT"):
            return "failed:timeout"
        return f"failed:{reason}"
    return "failed:unknown"


def run_job(
    job: dict,
    port: int,
    worker_id: int = 0,
    model: str = "default",
    dry_run: bool = False,
    run_ctx: dict | None = None,
    snapshot: ProfileSnapshot | None = None,
) -> tuple[str, int]:
    """Spawn a Claude Code session for one job application.

    Returns ``(status_string, duration_ms)`` for back-compat with the
    legacy launcher tests + ``pipeline.apply_jobs`` single-job flow.
    All persistence happens via ``mark_result`` / events; the
    ``status_string`` is derived from the saga's terminal
    ``SubmissionResult``.
    """
    run_ctx = run_ctx or {}
    run_id = run_ctx.setdefault("run_id", uuid.uuid4().hex)
    run_ctx.setdefault("worker_id", worker_id)
    run_ctx.update(
        {
            "model": model,
            "dry_run": dry_run,
            "port": port,
        }
    )
    snapshot = snapshot or _load_profile_snapshot()
    use_case = _build_use_case()
    worker_dir = str(reset_worker_dir(worker_id))
    run_ctx["worker_dir"] = worker_dir

    start = time.time()
    update_state(
        worker_id,
        run_id=run_id,
        status="applying",
        job_title=job.get("title", ""),
        company=job.get("site", ""),
        score=job.get("fit_score", 0),
        start_time=start,
        actions=0,
        last_action="starting",
    )
    add_event(
        f"[W{worker_id} {run_id[:8]}] Starting: "
        f"{(job.get('title') or '')[:40]} @ {job.get('site', '')}"
    )

    outcome = use_case.execute(
        tenant_id=LOCAL_TENANT,
        job=job,
        snapshot=snapshot,
        worker_id=worker_id,
        cdp_port=port,
        model=model,
        dry_run=dry_run,
        headless=bool(run_ctx.get("headless", False)),
        run_id=ApplyRunId(run_id),
        worker_dir=worker_dir,
    )
    duration_ms = int((time.time() - start) * 1000)
    if outcome.skipped:
        return "skipped", duration_ms

    submission = outcome.submission_result
    if submission is None:
        return "failed:no_result", duration_ms

    status = _result_to_status_string(submission)
    update_state(
        worker_id,
        status=status if status in {"applied", "dry_run", "expired", "captcha", "login_issue"} else "failed",
        last_action=status,
    )
    return status, duration_ms


# ---------------------------------------------------------------------------
# Permanent failure classification (kept identical for back-compat)
# ---------------------------------------------------------------------------

PERMANENT_FAILURES: set[str] = {
    "expired",
    "captcha",
    "login_issue",
    "not_eligible_location",
    "not_eligible_salary",
    "already_applied",
    "account_required",
    "not_a_job_application",
    "unsafe_permissions",
    "unsafe_verification",
    "sso_required",
    "site_blocked",
    "cloudflare_blocked",
    "blocked_by_cloudflare",
}

PERMANENT_PREFIXES: tuple[str, ...] = (
    "site_blocked",
    "cloudflare",
    "blocked_by",
    "unsafe_url",
)


def _is_permanent_failure(result: str) -> bool:
    reason = result.split(":", 1)[-1] if ":" in result else result
    return (
        result in PERMANENT_FAILURES
        or reason in PERMANENT_FAILURES
        or any(reason.startswith(p) for p in PERMANENT_PREFIXES)
    )


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------


def worker_loop(
    worker_id: int = 0,
    limit: int = 1,
    target_url: str | None = None,
    min_score: int = 7,
    headless: bool = False,
    model: str = "default",
    dry_run: bool = False,
    snapshot: ProfileSnapshot | None = None,
    approval_required: bool = True,
    workflow_id: str | None = None,
) -> tuple[int, int]:
    """Run jobs sequentially until ``limit`` is reached or the queue is empty."""
    applied = 0
    failed = 0
    continuous = limit == 0
    jobs_done = 0
    empty_polls = 0
    port = BASE_CDP_PORT + worker_id

    while not _stop_event.is_set():
        if not continuous and jobs_done >= limit:
            break

        update_state(
            worker_id,
            status="idle",
            job_title="",
            company="",
            run_id="",
            last_action="waiting for job",
            actions=0,
        )

        run_ctx: dict[str, Any] = {
            "run_id": workflow_id or uuid.uuid4().hex,
            "worker_id": worker_id,
            "model": model,
            "dry_run": dry_run,
            "workflow_id": workflow_id,
            "target_url": target_url,
            "min_score": min_score,
            "headless": headless,
        }
        job = acquire_job(
            target_url=target_url,
            min_score=min_score,
            worker_id=worker_id,
            run_ctx=run_ctx,
            approval_required=approval_required,
        )
        if not job:
            if not continuous:
                add_event(f"[W{worker_id}] Queue empty")
                update_state(worker_id, status="done", last_action="queue empty")
                break
            empty_polls += 1
            update_state(
                worker_id, status="idle", last_action=f"polling ({empty_polls})"
            )
            if empty_polls == 1:
                add_event(
                    f"[W{worker_id}] Queue empty, polling every {POLL_INTERVAL}s..."
                )
            if _stop_event.wait(timeout=POLL_INTERVAL):
                break
            continue

        empty_polls = 0
        try:
            result, duration_ms = run_job(
                job,
                port=port,
                worker_id=worker_id,
                model=model,
                dry_run=dry_run,
                run_ctx=run_ctx,
                snapshot=snapshot,
            )

            if result == "skipped":
                release_lock(job["url"], run_ctx=run_ctx)
                add_event(
                    f"[W{worker_id} {run_ctx['run_id'][:8]}] Skipped: "
                    f"{(job.get('title') or '')[:30]}"
                )
                continue
            if result == "applied":
                mark_result(
                    job["url"],
                    "applied",
                    duration_ms=duration_ms,
                    task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx,
                )
                applied += 1
                update_state(
                    worker_id,
                    jobs_applied=applied,
                    jobs_done=applied + failed,
                )
            elif result == "dry_run":
                mark_result(
                    job["url"],
                    "dry_run",
                    duration_ms=duration_ms,
                    task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx,
                )
                update_state(worker_id, jobs_done=applied + failed)
            else:
                reason = result.split(":", 1)[-1] if ":" in result else result
                mark_result(
                    job["url"],
                    "failed",
                    reason,
                    permanent=_is_permanent_failure(result),
                    duration_ms=duration_ms,
                    task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx,
                )
                failed += 1
                update_state(
                    worker_id, jobs_failed=failed, jobs_done=applied + failed
                )
        except KeyboardInterrupt:
            release_lock(job["url"], run_ctx=run_ctx)
            add_event(
                f"[W{worker_id} {run_ctx['run_id'][:8]}] Job skipped (Ctrl+C)"
            )
            if _stop_event.is_set():
                break
            continue
        except Exception as exc:  # noqa: BLE001
            logger.exception("Worker %d launcher error", worker_id)
            add_event(
                f"[W{worker_id} {run_ctx['run_id'][:8]}] Launcher error: {str(exc)[:40]}"
            )
            release_lock(job["url"], run_ctx=run_ctx)
            failed += 1
            update_state(worker_id, jobs_failed=failed)

        jobs_done += 1
        if target_url:
            break

    update_state(worker_id, run_id="", status="done", last_action="finished")
    return applied, failed


# ---------------------------------------------------------------------------
# Main entry point — kept identical for cli.py / pipeline / actions
# ---------------------------------------------------------------------------


def main(
    limit: int = 1,
    target_url: str | None = None,
    min_score: int = 7,
    headless: bool = False,
    model: str = "default",
    dry_run: bool = False,
    continuous: bool = False,
    poll_interval: int = 60,
    workers: int = 1,
    snapshot: ProfileSnapshot | None = None,
    install_signal_handlers: bool = True,
    approval_required: bool = True,
    workflow_id: str | None = None,
) -> tuple[int, int]:
    global POLL_INTERVAL
    POLL_INTERVAL = poll_interval
    _stop_event.clear()
    config.ensure_dirs()
    console = Console()
    batch_run_id = f"apply:{uuid.uuid4().hex}"
    batch_started = time.time()
    metric_error_class: str | None = None
    metric_error_message: str | None = None

    _record_apply_batch_metric(
        outcome="started",
        run_id=batch_run_id,
        target_url=target_url,
        dry_run=dry_run,
        workers=workers,
        model=model,
    )

    if snapshot is None:
        try:
            snapshot = _load_profile_snapshot()
        except FileNotFoundError:
            snapshot = None

    recovered = recover_ambiguous_running_apply(console)

    if continuous:
        effective_limit = 0
        mode_label = "continuous"
    else:
        effective_limit = limit
        mode_label = f"{limit} jobs"

    total_applied = 0
    total_failed = 0

    for i in range(workers):
        init_worker(i)

    worker_label = f"{workers} worker{'s' if workers > 1 else ''}"
    console.print(
        f"Launching apply pipeline ({mode_label}, {worker_label}, poll every {POLL_INTERVAL}s)..."
    )
    console.print("[dim]Ctrl+C = skip current job(s) | Ctrl+C x2 = stop[/dim]")

    _ctrl_c_count = 0

    def _sigint_handler(_sig, _frame):
        nonlocal _ctrl_c_count
        _ctrl_c_count += 1
        if _ctrl_c_count == 1:
            console.print(
                "\n[yellow]Skipping current job(s)... (Ctrl+C again to STOP)[/yellow]"
            )
            _kill_claude_processes_for_interrupt()
        else:
            console.print("\n[red bold]STOPPING[/red bold]")
            _stop_event.set()
            _kill_claude_processes_for_interrupt()
            kill_all_chrome()
            raise KeyboardInterrupt

    if install_signal_handlers:
        signal.signal(signal.SIGINT, _sigint_handler)

    try:
        with Live(render_full(), console=console, refresh_per_second=2) as live:
            _dashboard_running = True

            def _refresh():
                while _dashboard_running:
                    live.update(render_full())
                    time.sleep(0.5)

            refresh_thread = threading.Thread(target=_refresh, daemon=True)
            refresh_thread.start()

            if workers == 1:
                total_applied, total_failed = worker_loop(
                    worker_id=0,
                    limit=effective_limit,
                    target_url=target_url,
                    min_score=min_score,
                    headless=headless,
                    model=model,
                    dry_run=dry_run,
                    snapshot=snapshot,
                    approval_required=approval_required,
                    workflow_id=workflow_id,
                )
            else:
                if effective_limit:
                    base = effective_limit // workers
                    extra = effective_limit % workers
                    limits = [
                        base + (1 if i < extra else 0) for i in range(workers)
                    ]
                else:
                    limits = [0] * workers

                with ThreadPoolExecutor(
                    max_workers=workers, thread_name_prefix="apply-worker"
                ) as executor:
                    futures = {
                        executor.submit(
                            worker_loop,
                            worker_id=i,
                            limit=limits[i],
                            target_url=target_url,
                            min_score=min_score,
                            headless=headless,
                            model=model,
                            dry_run=dry_run,
                            snapshot=snapshot,
                            approval_required=approval_required,
                            workflow_id=workflow_id,
                        ): i
                        for i in range(workers)
                    }

                    results: list[tuple[int, int]] = []
                    for future in as_completed(futures):
                        wid = futures[future]
                        try:
                            results.append(future.result())
                        except Exception:  # noqa: BLE001
                            logger.exception("Worker %d crashed", wid)
                            results.append((0, 0))

                total_applied = sum(r[0] for r in results)
                total_failed = sum(r[1] for r in results)

            _dashboard_running = False
            refresh_thread.join(timeout=2)
            live.update(render_full())

        totals = get_totals()
        console.print(
            f"\n[bold]Done: {total_applied} applied, {total_failed} failed "
            f"(${totals['cost']:.3f})[/bold]"
        )
        console.print(f"Logs: {config.LOG_DIR}")
    except KeyboardInterrupt:
        metric_error_class = "manual_abort_apply"
        metric_error_message = "manual_abort_apply"
        pass
    except Exception as exc:
        metric_error_class = type(exc).__name__
        metric_error_message = str(exc)
        raise
    finally:
        _stop_event.set()
        kill_all_chrome()
        if metric_error_class:
            metric_outcome = "failed"
        elif dry_run:
            metric_outcome = "dry_run"
        else:
            metric_outcome = "succeeded" if total_failed == 0 else "failed"
        _record_apply_batch_metric(
            outcome=metric_outcome,
            run_id=batch_run_id,
            target_url=target_url,
            dry_run=dry_run,
            workers=workers,
            model=model,
            duration_ms=int((time.time() - batch_started) * 1000),
            total_applied=total_applied,
            total_failed=total_failed,
            error_class=metric_error_class,
            error_message=metric_error_message,
        )
    _ = recovered
    return total_applied, total_failed


def _record_apply_batch_metric(
    *,
    outcome: str,
    run_id: str,
    target_url: str | None,
    dry_run: bool,
    workers: int,
    model: str,
    duration_ms: int | None = None,
    total_applied: int = 0,
    total_failed: int = 0,
    error_class: str | None = None,
    error_message: str | None = None,
) -> None:
    try:
        conn = get_connection()
        record_operational_attempt_metric(
            conn,
            stage="apply",
            attempt_kind="apply_batch",
            outcome=outcome,
            adapter="browser",
            run_id=run_id,
            job_url=target_url,
            duration_ms=duration_ms,
            counts={"total": total_applied + total_failed},
            error_class=error_class,
            error_message=error_message,
            metadata={
                "dryRun": dry_run,
                "workers": workers,
                "model": model,
                "applied": total_applied,
                "failed": total_failed,
            },
        )
        conn.commit()
    except Exception:
        logger.exception("Failed to record apply operational metric")


# Re-import LOCAL_TENANT lazily to avoid an import cycle (use_cases pulls
# in the launcher transitively through the apply package init).
from jobctrl.domain.tenant import LOCAL_TENANT  # noqa: E402


__all__ = [
    "PERMANENT_FAILURES",
    "PERMANENT_PREFIXES",
    "_is_permanent_failure",
    "acquire_job",
    "gen_prompt",
    "main",
    "mark_job",
    "mark_result",
    "recover_ambiguous_running_apply",
    "release_lock",
    "reset_failed",
    "run_job",
    "worker_loop",
]
