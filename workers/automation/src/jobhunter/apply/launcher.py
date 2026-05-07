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

from jobhunter import config
from jobhunter.apply import prompt as prompt_mod  # noqa: F401  -- kept for back-compat imports
from jobhunter.apply.chrome import (
    BASE_CDP_PORT,
    _kill_process_tree,
    cleanup_on_exit,
    cleanup_worker,
    kill_all_chrome,
    launch_chrome,
    reset_worker_dir,
)
from jobhunter.apply.dashboard import (
    add_event,
    get_totals,
    init_worker,
    render_full,
    update_state,
)
from jobhunter.database import (
    _EFFECTIVE_APPLICATION_URL,
    _EFFECTIVE_APPLIED_AT,
    _EFFECTIVE_APPLY_STATUS,
    _EFFECTIVE_COVER_PATH,
    _EFFECTIVE_FIT_SCORE,
    _EFFECTIVE_FULL_DESCRIPTION,
    _EFFECTIVE_TAILOR_PATH,
    _ENRICHMENT_JOIN,
    _LATEST_APPLY_RUN_JOIN,
    _LATEST_MATERIALS_JOIN,
    _LATEST_SCORE_JOIN,
    get_connection,
)
from jobhunter.domain.apply.services import ApplyPromptBuilder
from jobhunter.domain.apply.value_objects import ApplyPrompt, ApplyRunId, new_apply_run_id
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.state import ensure_job_stage_rows, record_job_event, set_stage_state

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
if platform.system() != "Windows":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


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


def _attempt_count_for(conn, url: str) -> int:
    """Return the canonical attempt count from ``job_stage_states.apply``."""
    row = conn.execute(
        "SELECT attempt_count FROM job_stage_states "
        "WHERE job_url = ? AND stage = 'apply' LIMIT 1",
        (url,),
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _load_blocked():
    from jobhunter.config import load_blocked_sites

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
            f"{_EFFECTIVE_FIT_SCORE} AS fit_score, "
            f"jobs.location AS location, "
            f"{_EFFECTIVE_FULL_DESCRIPTION} AS full_description, "
            f"{_EFFECTIVE_COVER_PATH} AS cover_letter_path, "
            f"{_EFFECTIVE_APPLIED_AT} AS applied_at, "
            f"{_EFFECTIVE_APPLY_STATUS} AS apply_status, "
            f"{attempts_subquery}"
        )
        common_joins = (
            f"{_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
            f"{_ENRICHMENT_JOIN} {_LATEST_APPLY_RUN_JOIN}"
        )

        if target_url:
            like = f"%{target_url.split('?')[0].rstrip('/')}%"
            row = conn.execute(
                f"""
                SELECT {common_columns}
                FROM jobs {common_joins}
                WHERE (jobs.url = ? OR {_EFFECTIVE_APPLICATION_URL} = ?
                       OR {_EFFECTIVE_APPLICATION_URL} LIKE ? OR jobs.url LIKE ?)
                  AND {_EFFECTIVE_TAILOR_PATH} IS NOT NULL
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
            row = conn.execute(
                f"""
                SELECT {common_columns}
                FROM jobs {common_joins}
                WHERE {_EFFECTIVE_TAILOR_PATH} IS NOT NULL
                  AND {_EFFECTIVE_APPLICATION_URL} IS NOT NULL
                  AND {_EFFECTIVE_APPLICATION_URL} != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM job_stage_states jss_active
                      WHERE jss_active.job_url = jobs.url
                        AND jss_active.stage = 'apply'
                        AND jss_active.state IN ('running', 'succeeded')
                  )
                  AND COALESCE(
                      (SELECT jss_a.attempt_count FROM job_stage_states jss_a
                       WHERE jss_a.job_url = jobs.url AND jss_a.stage = 'apply'
                       LIMIT 1), 0
                  ) < ?
                  AND {_EFFECTIVE_FIT_SCORE} >= ?
                  {site_clause}
                  {url_clauses}
                ORDER BY {_EFFECTIVE_FIT_SCORE} DESC, jobs.url
                LIMIT 1
                """,
                params,
            ).fetchone()

        if not row:
            conn.rollback()
            return None

        # Skip manual ATS sites (the agent cannot solve them).
        from jobhunter.config import is_manual_ats

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
        attempts = _attempt_count_for(conn, url)
        if attempts >= int(config.DEFAULTS["max_apply_attempts"]):
            conn.rollback()
            return None

        now = _utc_now()
        run_id = ApplyRunId(
            (run_ctx.get("run_id") if run_ctx else None) or new_apply_run_id()
        )
        ensure_job_stage_rows(conn, url)
        # Reset prior terminal state (failed / exhausted / canceled /
        # skipped) back to pending so the §8.5 state machine accepts
        # the pending → running transition.
        prior_row = conn.execute(
            "SELECT state FROM job_stage_states "
            "WHERE job_url = ? AND stage = 'apply' LIMIT 1",
            (url,),
        ).fetchone()
        if prior_row is not None and prior_row[0] not in {"pending", "running"}:
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
            },
        )
        conn.commit()

        if run_ctx is not None:
            run_ctx["run_id"] = str(run_id)
            run_ctx.setdefault("worker_id", worker_id)

        return _row_to_job_dict(row, run_id=run_id)
    except Exception:
        conn.rollback()
        raise


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

    Writes go to ``job_stage_states.apply`` (canonical lifecycle row)
    and a terminal ``ApplicationSubmitted`` / ``ApplicationFailed`` /
    ``DryRunCompleted`` event whose payload feeds
    ``apply_run_projections``. The legacy ``jobs.apply_*`` columns are
    NOT touched.
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
        set_stage_state(
            conn, url, "apply", "succeeded", finished_at=now, duration_ms=duration_ms
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
            next_action=f"jobhunter apply --url {url}",
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
            },
        )
    else:
        reason = (error or "unknown").strip()
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
            next_action=f"jobhunter apply --url {url}" if not permanent else None,
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
    """Release any active apply stage row for ``url`` without recording a result.

    Records an ``ApplicationFailed`` event with an ORPHANED reason so
    the projection treats the run as failed (retryable). Resets the
    ``job_stage_states`` row to pending.

    When the caller doesn't pass a ``run_ctx`` (orphan-rescue path), we
    look up the prior ``ApplyRunStarted`` event for the URL and reuse
    its ``run_id`` so the terminal event closes the SAME row in
    ``apply_run_projections`` instead of minting a phantom new run.
    """
    conn = get_connection()
    now = _utc_now()
    ctx_run_id = run_ctx.get("run_id") if run_ctx else None
    run_id = (
        ctx_run_id
        or _latest_apply_run_started_run_id(conn, url)
        or new_apply_run_id()
    )
    if _has_active_apply(conn, url):
        record_job_event(
            conn,
            url,
            "apply",
            "ApplicationFailed",
            level="warning",
            message="Apply lock released",
            payload={
                "run_id": str(run_id),
                "result": "ORPHANED: lock released by launcher",
                "finished_at": now,
                "duration_ms": 0,
            },
        )
    # Launcher owns lock-release policy: Running -> Pending is a launcher
    # convention, not in the canonical §8.5 state-machine table.
    set_stage_state(
        conn,
        url,
        "apply",
        "pending",
        next_action=f"jobhunter apply --url {url}",
        validate_transition=False,
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
        set_stage_state(
            conn,
            url,
            "apply",
            "pending",
            attempt_count=0,
            error_code=None,
            error_message=None,
            next_action=f"jobhunter apply --url {url}",
        )
        count += 1
    conn.commit()
    return count


# ---------------------------------------------------------------------------
# Profile snapshot loader (kept for back-compat with callers that
# import it).
# ---------------------------------------------------------------------------


def _load_profile_snapshot() -> ProfileSnapshot:
    from jobhunter.infrastructure.profile import get_profile_repository

    return get_profile_repository().load_snapshot(LOCAL_TENANT)


# ---------------------------------------------------------------------------
# gen_prompt (debug helper) — no DB writes
# ---------------------------------------------------------------------------


def gen_prompt(
    target_url: str,
    min_score: int = 7,
    model: str = "sonnet",
    worker_id: int = 0,
    snapshot: ProfileSnapshot | None = None,
) -> Path | None:
    """Render the prompt + MCP config for one job for manual debugging."""
    job = acquire_job(target_url=target_url, min_score=min_score, worker_id=worker_id)
    if not job:
        return None

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
    mcp_path.write_text(json.dumps(apply_prompt.mcp_config), encoding="utf-8")

    return prompt_file


# ---------------------------------------------------------------------------
# run_job — kept on the public surface for the regression tests +
# pipeline.apply_jobs single-job flow. Delegates to the apply use case.
# ---------------------------------------------------------------------------


def _build_use_case():
    """Construct the canonical local-mode use case wiring.

    Imported lazily — the use case pulls the `Applied`/`Failed` value
    objects, which only the run-job path needs.
    """
    from jobhunter.domain.apply.process_manager import ApplySaga
    from jobhunter.domain.apply.services import ApplyEligibilityChecker
    from jobhunter.domain.apply.use_cases import SubmitApplicationUseCase
    from jobhunter.infrastructure.apply import (
        ClaudeCodeCliAdapter,
        LocalChromeAdapter,
    )

    browser_port = LocalChromeAdapter()
    agent_port = ClaudeCodeCliAdapter()
    saga = ApplySaga(
        browser_port=browser_port,
        agent_port=agent_port,
        repository=_NoopApplyRunRepository(),
        timeout_seconds=int(config.DEFAULTS.get("apply_timeout", 300)),
    )
    return SubmitApplicationUseCase(
        repository=_NoopApplyRunRepository(),
        browser_port=browser_port,
        agent_port=agent_port,
        eligibility_checker=ApplyEligibilityChecker(
            max_attempts=int(config.DEFAULTS["max_apply_attempts"])
        ),
        prompt_builder=ApplyPromptBuilder(),
        saga=saga,
        timeout_seconds=int(config.DEFAULTS.get("apply_timeout", 300)),
    )


class _NoopApplyRunRepository:
    """No-op stand-in for the deleted ``SqliteApplyRunRepository``.

    PR 4 of the Temporal stack removed the bespoke ``apply_runs`` table.
    The ``ApplyRun`` aggregate stays in-memory inside
    ``SubmitApplicationUseCase`` / ``ApplySaga``; persistence happens
    via ``record_job_event`` (the launcher emits ``ApplyRunStarted`` /
    ``ApplicationSubmitted`` / ``ApplicationFailed`` events whose
    payloads feed ``apply_run_projections``). The repository port is
    no longer needed but the saga signature still accepts one — this
    no-op satisfies the protocol without writing anywhere.
    """

    def save(self, run) -> None:  # pragma: no cover — trivial
        return None

    def load(self, tenant_id, run_id):  # pragma: no cover — trivial
        return None

    def list_active(self, tenant_id):  # pragma: no cover — trivial
        return []

    def list_recent(self, tenant_id, *, limit: int = 50):  # pragma: no cover
        return []


def _result_to_status_string(result) -> str:
    """Map a ``SubmissionResult`` variant back to the legacy status string."""
    from jobhunter.domain.apply.value_objects import (
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
    model: str = "sonnet",
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

PERMANENT_PREFIXES: tuple[str, ...] = ("site_blocked", "cloudflare", "blocked_by")


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
    model: str = "sonnet",
    dry_run: bool = False,
    snapshot: ProfileSnapshot | None = None,
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
            "run_id": uuid.uuid4().hex,
            "worker_id": worker_id,
            "model": model,
            "dry_run": dry_run,
            "target_url": target_url,
            "min_score": min_score,
            "headless": headless,
        }
        job = acquire_job(
            target_url=target_url,
            min_score=min_score,
            worker_id=worker_id,
            run_ctx=run_ctx,
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
        chrome_proc = None
        try:
            update_state(worker_id, run_id=run_ctx["run_id"], status="launching")
            add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Launching Chrome...")
            chrome_proc = launch_chrome(worker_id, port=port, headless=headless)
            update_state(worker_id, run_id=run_ctx["run_id"], status="applying")

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
        finally:
            if chrome_proc:
                cleanup_worker(worker_id, chrome_proc)

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
    model: str = "sonnet",
    dry_run: bool = False,
    continuous: bool = False,
    poll_interval: int = 60,
    workers: int = 1,
    snapshot: ProfileSnapshot | None = None,
) -> tuple[int, int]:
    global POLL_INTERVAL
    POLL_INTERVAL = poll_interval
    _stop_event.clear()
    config.ensure_dirs()
    console = Console()

    if snapshot is None:
        try:
            snapshot = _load_profile_snapshot()
        except FileNotFoundError:
            snapshot = None

    # Sweep orphaned in-progress runs from a prior crashed process
    # before starting new workers (per §8.3 compensation). The
    # canonical lock is now ``job_stage_states.apply.state == 'running'``;
    # rescue any rows still showing ``running`` from a previous PID.
    rescued = _rescue_orphaned_running_apply(console)

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
            with _claude_lock:
                for _wid, cproc in list(_claude_procs.items()):
                    if cproc.poll() is None:
                        _kill_process_tree(cproc.pid)
        else:
            console.print("\n[red bold]STOPPING[/red bold]")
            _stop_event.set()
            with _claude_lock:
                for _wid, cproc in list(_claude_procs.items()):
                    if cproc.poll() is None:
                        _kill_process_tree(cproc.pid)
            kill_all_chrome()
            raise KeyboardInterrupt

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
        pass
    finally:
        _stop_event.set()
        kill_all_chrome()
    _ = rescued
    return total_applied, total_failed


def _rescue_orphaned_running_apply(console: Console) -> int:
    """Mark any ``apply.state == 'running'`` row as failed/orphaned.

    Per-row failures are caught + logged so one bad row doesn't poison
    the whole sweep — a single corrupt payload (or a row whose
    ``release_lock`` raises) must not strand every other orphan in
    ``running`` forever.
    """
    try:
        conn = get_connection()
        rows = conn.execute(
            "SELECT job_url FROM job_stage_states "
            "WHERE stage = 'apply' AND state = 'running'"
        ).fetchall()
        if not rows:
            return 0
        rescued = 0
        for row in rows:
            url = row["job_url"]
            try:
                release_lock(url)
                rescued += 1
            except Exception:  # noqa: BLE001 — keep sweeping past per-row failures
                logger.exception(
                    "Orphan rescue: release_lock failed for %s", url
                )
                continue
        if rescued:
            console.print(
                f"[yellow]Rescued {rescued} orphaned apply run(s) from prior crash[/yellow]"
            )
        return rescued
    except Exception:  # noqa: BLE001 — orphan sweep is best-effort
        logger.exception("Orphan sweep failed")
        return 0


# Re-import LOCAL_TENANT lazily to avoid an import cycle (use_cases pulls
# in the launcher transitively through the apply package init).
from jobhunter.domain.tenant import LOCAL_TENANT  # noqa: E402


__all__ = [
    "PERMANENT_FAILURES",
    "PERMANENT_PREFIXES",
    "_is_permanent_failure",
    "acquire_job",
    "gen_prompt",
    "main",
    "mark_job",
    "mark_result",
    "release_lock",
    "reset_failed",
    "run_job",
    "worker_loop",
]
