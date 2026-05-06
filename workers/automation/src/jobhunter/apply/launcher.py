"""Apply orchestration — thin shell over the Apply Automation domain.

Phase 8 (S-30): the launcher is now a thin orchestrator over
``SubmitBatchUseCase`` + ``SubmitApplicationUseCase``. The legacy
public surface (``main``, ``run_job``, ``worker_loop``,
``acquire_job``, ``mark_result``, ``release_lock``, ``gen_prompt``,
``mark_job``, ``reset_failed``) is preserved so callers
(``cli.py``, ``actions.py``, ``pipeline.py``, regression tests) keep
working.

Crucially per the no-strangler memory: **new code does NOT write the
legacy ``jobs.applied_at`` / ``apply_status`` / ``apply_error`` /
``apply_attempts`` / ``agent_id`` / ``last_attempted_at`` /
``apply_duration_ms`` / ``apply_task_id`` / ``verification_confidence``
columns.** All apply state goes to the ``ApplyRun`` aggregate
(``apply_runs`` + ``apply_run_events`` tables) plus the canonical
``job_stage_states`` row. The TS read-model swap to read apply state
from ``apply_runs`` lives in S-30's read-side updates.

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
from jobhunter.domain.apply.aggregate import ApplyRun, ApplyRunStatus
from jobhunter.domain.apply.process_manager import ApplySaga
from jobhunter.domain.apply.services import (
    ApplyEligibilityChecker,
    ApplyPromptBuilder,
)
from jobhunter.domain.apply.use_cases import SubmitApplicationUseCase
from jobhunter.domain.apply.value_objects import (
    Applied,
    ApplyPrompt,
    ApplyRunId,
    Captcha,
    DryRunComplete,
    Expired,
    Failed,
    LoginIssue,
    Manual,
    SubmissionResult,
    new_apply_run_id,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.apply import (
    ClaudeCodeCliAdapter,
    LocalChromeAdapter,
    SqliteApplyRunRepository,
)
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
# Aggregate-driven acquire / release / mark helpers
# ---------------------------------------------------------------------------


def _has_active_apply_run(conn, url: str) -> bool:
    """Return True when an apply_runs row is still open for ``url``.

    The ``ApplyRunRepository.list_active`` helper is the canonical
    answer per §8.1, but this scoped query (job_url + status) lets
    ``acquire_job`` enforce the §4.6 "at most one in_progress per
    JobId" invariant atomically inside the BEGIN IMMEDIATE block.
    """
    row = conn.execute(
        """
        SELECT 1 FROM apply_runs
        WHERE job_url = ? AND status IN (?, ?)
        LIMIT 1
        """,
        (url, ApplyRunStatus.STARTING, ApplyRunStatus.IN_PROGRESS),
    ).fetchone()
    return row is not None


def _has_succeeded_apply_run(conn, url: str) -> bool:
    """Return True when ``url`` already has a succeeded apply_runs row."""
    row = conn.execute(
        "SELECT 1 FROM apply_runs WHERE job_url = ? AND status = ? LIMIT 1",
        (url, ApplyRunStatus.SUCCEEDED),
    ).fetchone()
    return row is not None


def _attempt_count_for(conn, url: str) -> int:
    """Count apply_runs rows for ``url`` (includes terminal failures)."""
    row = conn.execute(
        "SELECT COUNT(*) FROM apply_runs WHERE job_url = ?",
        (url,),
    ).fetchone()
    return int(row[0]) if row else 0


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

    The lock is taken on ``apply_runs`` (a freshly INSERTed row in
    ``starting`` state) — not on ``jobs.apply_status`` like the legacy
    launcher. The aggregate is the source of truth from S-30 onward;
    the legacy column is read for back-compat only.
    """
    conn = get_connection()
    repository = SqliteApplyRunRepository(conn)
    try:
        conn.execute("BEGIN IMMEDIATE")

        # Round-1 review M1: read ``applied_at`` / ``apply_status`` /
        # ``apply_attempts`` through the new apply_runs join so the
        # downstream eligibility checker (and any caller that reads
        # the row dict) sees canonical values rather than the
        # always-NULL legacy columns. ``apply_attempts`` is a
        # correlated count over apply_runs — that's the same number
        # the launcher's _attempt_count_for helper computes.
        attempts_subquery = (
            "(SELECT COUNT(*) FROM apply_runs ar_count "
            "WHERE ar_count.job_url = jobs.url) AS apply_attempts"
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
                ApplyRunStatus.STARTING,
                ApplyRunStatus.IN_PROGRESS,
                ApplyRunStatus.SUCCEEDED,
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
                      SELECT 1 FROM apply_runs ar_active
                      WHERE ar_active.job_url = jobs.url
                        AND ar_active.status IN (?, ?, ?)
                  )
                  AND (
                      SELECT COUNT(*) FROM apply_runs ar_attempts
                      WHERE ar_attempts.job_url = jobs.url
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
            record_job_event(
                conn,
                url,
                "apply",
                "ApplyManualSkip",
                level="info",
                message="manual ATS",
            )
            # Also persist a Manual-result aggregate so the queue
            # selectors stop returning this job.
            run = ApplyRun.start(
                tenant_id=LOCAL_TENANT,
                run_id=new_apply_run_id(),
                job_id=JobId(str(url)),
                started_at=now,
                worker_id=worker_id,
                model=None,
                dry_run=False,
                headless=False,
                attempts=1,
            ).complete(
                result=Manual(reason="manual_ats"),
                finished_at=now,
                duration_ms=0,
            )
            repository.save(run)
            conn.commit()
            logger.info("Skipping manual ATS: %s", url[:80])
            return None

        # Targeted-mode also enforces the no-active-run + max-attempts
        # invariants (the SELECT above is permissive on target_url so
        # we can surface "no such job" errors clearly).
        if _has_active_apply_run(conn, url):
            conn.rollback()
            return None
        if _has_succeeded_apply_run(conn, url):
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
        starting_run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=run_id,
            job_id=JobId(str(url)),
            started_at=now,
            worker_id=worker_id,
            model=(run_ctx.get("model") if run_ctx else None),
            dry_run=bool(run_ctx.get("dry_run")) if run_ctx else False,
            headless=bool(run_ctx.get("headless")) if run_ctx else False,
            attempts=attempts + 1,
        )
        repository.save(starting_run)

        ensure_job_stage_rows(conn, url)
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
            "StageStarted",
            message="Apply agent acquired job",
        )
        conn.commit()

        if run_ctx is not None:
            run_ctx["run_id"] = str(run_id)
            run_ctx.setdefault("worker_id", worker_id)

        return _row_to_job_dict(row, run_id=run_id)
    except Exception:
        conn.rollback()
        raise


def _save_terminal_aggregate(
    *,
    url: str,
    run_id: str | None,
    submission_result: SubmissionResult,
    duration_ms: int | None,
    dry_run: bool = False,
    worker_id: int | None = None,
    model: str | None = None,
) -> ApplyRun:
    """Promote the active apply_runs row to a terminal state.

    If a starting/in-progress aggregate already exists for ``run_id``
    we load it and call ``complete``; otherwise we synthesise a fresh
    aggregate (manual marks via ``mark_job`` follow this path).
    """
    conn = get_connection()
    repository = SqliteApplyRunRepository(conn)
    now = _utc_now()
    run: ApplyRun | None = None
    if run_id:
        run = repository.load(LOCAL_TENANT, ApplyRunId(run_id))
    if run is None:
        # Reuse the most recent active row for this URL if one exists.
        for active in repository.list_active(LOCAL_TENANT):
            if str(active.job_id) == url:
                run = active
                break
    if run is None:
        run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=ApplyRunId(run_id or new_apply_run_id()),
            job_id=JobId(url),
            started_at=now,
            worker_id=worker_id,
            model=model,
            dry_run=dry_run,
            headless=False,
            attempts=1,
        )
    if run.is_terminal:
        return run
    if not run.is_in_progress:
        run = run.transition_to_in_progress(worker_id=worker_id)
    completed = run.complete(
        result=submission_result,
        finished_at=now,
        duration_ms=duration_ms,
    )
    repository.save(completed)
    return completed


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

    NEW: writes go to ``apply_runs`` + ``job_stage_states`` only —
    legacy ``jobs.apply_status`` / ``applied_at`` / ``apply_error`` /
    ``apply_attempts`` / ``apply_duration_ms`` / ``apply_task_id``
    columns are NOT touched.
    """
    conn = get_connection()
    now = _utc_now()
    ensure_job_stage_rows(conn, url)

    if status == "applied":
        result: SubmissionResult = Applied(applied_at=now, verification_confidence=1.0)
        _save_terminal_aggregate(
            url=url,
            run_id=task_id,
            submission_result=result,
            duration_ms=duration_ms,
            dry_run=False,
            worker_id=run_ctx.get("worker_id") if run_ctx else None,
            model=run_ctx.get("model") if run_ctx else None,
        )
        set_stage_state(
            conn, url, "apply", "succeeded", finished_at=now, duration_ms=duration_ms
        )
        record_job_event(
            conn, url, "apply", "StageCompleted", message="Application submitted"
        )
    elif status == "dry_run":
        result = DryRunComplete(navigated_to=url)
        _save_terminal_aggregate(
            url=url,
            run_id=task_id,
            submission_result=result,
            duration_ms=duration_ms,
            dry_run=True,
            worker_id=run_ctx.get("worker_id") if run_ctx else None,
            model=run_ctx.get("model") if run_ctx else None,
        )
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
        )
        record_job_event(
            conn,
            url,
            "apply",
            "DryRunCompleted",
            message="Dry run completed without submitting",
        )
    else:
        reason = (error or "unknown").strip()
        if reason == "captcha":
            term: SubmissionResult = Captcha(details=reason)
        elif reason == "expired":
            term = Expired()
        elif reason == "login_issue":
            term = LoginIssue(details=reason)
        elif reason.startswith("manual"):
            term = Manual(reason=reason)
        else:
            term = Failed(error=reason, retryable=not permanent)
        _save_terminal_aggregate(
            url=url,
            run_id=task_id,
            submission_result=term,
            duration_ms=duration_ms,
            dry_run=run_ctx.get("dry_run", False) if run_ctx else False,
            worker_id=run_ctx.get("worker_id") if run_ctx else None,
            model=run_ctx.get("model") if run_ctx else None,
        )
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
            "StageFailed",
            level="error",
            message=reason,
        )

    conn.commit()


def release_lock(url: str, run_ctx: dict | None = None) -> None:
    """Release any active apply_runs row for ``url`` without recording a result.

    Marks the active aggregate as a Failed (retryable, ORPHANED) row
    so the queue selectors don't keep blocking on it. Resets the
    ``job_stage_states`` row to pending.
    """
    conn = get_connection()
    repository = SqliteApplyRunRepository(conn)
    now = _utc_now()
    for active in repository.list_active(LOCAL_TENANT):
        if str(active.job_id) != url:
            continue
        completed = active.complete(
            result=Failed(error="ORPHANED: lock released by launcher", retryable=True),
            finished_at=now,
            duration_ms=0,
        )
        repository.save(completed)
    set_stage_state(
        conn,
        url,
        "apply",
        "pending",
        next_action=f"jobhunter apply --url {url}",
    )
    record_job_event(
        conn, url, "apply", "LockReleased", message="Apply lock released"
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Manual mark / reset helpers — operate on the aggregate, never on the
# legacy jobs.apply_* columns.
# ---------------------------------------------------------------------------


def mark_job(url: str, status: str, reason: str | None = None) -> None:
    """Manually mark a job's apply status.

    Writes to ``apply_runs`` + ``job_stage_states`` only.
    """
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

    NEW: deletes the failed/manual ``apply_runs`` rows for each affected
    job (so the attempt counter and queue selectors restart cleanly)
    and resets the ``job_stage_states.apply`` row to ``pending``.
    Returns the number of jobs reset.
    """
    conn = get_connection()
    repository = SqliteApplyRunRepository(conn)
    rows = conn.execute(
        """
        SELECT DISTINCT job_url FROM apply_runs
        WHERE status NOT IN (?, ?, ?)
        """,
        (
            ApplyRunStatus.SUCCEEDED,
            ApplyRunStatus.STARTING,
            ApplyRunStatus.IN_PROGRESS,
        ),
    ).fetchall()
    count = 0
    for row in rows:
        url = row["job_url"]
        # Only reset jobs that have NO succeeded run.
        succeeded_row = conn.execute(
            "SELECT 1 FROM apply_runs WHERE job_url = ? AND status = ? LIMIT 1",
            (url, ApplyRunStatus.SUCCEEDED),
        ).fetchone()
        if succeeded_row:
            continue
        conn.execute(
            """
            DELETE FROM apply_run_events
            WHERE run_id IN (
                SELECT run_id FROM apply_runs
                WHERE job_url = ? AND status NOT IN (?, ?, ?)
            )
            """,
            (
                url,
                ApplyRunStatus.SUCCEEDED,
                ApplyRunStatus.STARTING,
                ApplyRunStatus.IN_PROGRESS,
            ),
        )
        conn.execute(
            """
            DELETE FROM apply_runs
            WHERE job_url = ? AND status NOT IN (?, ?, ?)
            """,
            (
                url,
                ApplyRunStatus.SUCCEEDED,
                ApplyRunStatus.STARTING,
                ApplyRunStatus.IN_PROGRESS,
            ),
        )
        ensure_job_stage_rows(conn, url)
        set_stage_state(
            conn,
            url,
            "apply",
            "pending",
            next_action=f"jobhunter apply --url {url}",
        )
        count += 1
    conn.commit()
    # Suppress the "repository unused" lint (kept on the function so
    # tests can swap a fake without monkey-patching internal queries).
    _ = repository
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
    """Render the prompt + MCP config for one job for manual debugging.

    This is the only acquire-then-release helper kept on the legacy
    surface (the wizard still relies on it). It uses the new
    ``ApplyPromptBuilder`` so the rendered text matches what the
    use case would send.
    """
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
# pipeline.apply_jobs single-job flow. Delegates to
# ClaudeCodeCliAdapter.
# ---------------------------------------------------------------------------


def _build_use_case() -> SubmitApplicationUseCase:
    """Construct the canonical local-mode use case wiring."""
    conn = get_connection()
    repository = SqliteApplyRunRepository(conn)
    browser_port = LocalChromeAdapter()
    agent_port = ClaudeCodeCliAdapter()
    saga = ApplySaga(
        browser_port=browser_port,
        agent_port=agent_port,
        repository=repository,
        timeout_seconds=int(config.DEFAULTS.get("apply_timeout", 300)),
    )
    return SubmitApplicationUseCase(
        repository=repository,
        browser_port=browser_port,
        agent_port=agent_port,
        eligibility_checker=ApplyEligibilityChecker(
            max_attempts=int(config.DEFAULTS["max_apply_attempts"])
        ),
        prompt_builder=ApplyPromptBuilder(),
        saga=saga,
        timeout_seconds=int(config.DEFAULTS.get("apply_timeout", 300)),
    )


def _result_to_status_string(result: SubmissionResult) -> str:
    """Map a ``SubmissionResult`` variant back to the legacy status string.

    The CLI / regression tests assert on the string form returned by
    ``run_job`` ("applied" / "dry_run" / "expired" / "captcha" /
    "login_issue" / "failed:reason"). Keep that contract intact.
    """
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
    All persistence happens through the new use case; the
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
    """Run jobs sequentially until ``limit`` is reached or the queue is empty.

    The loop drives ``acquire_job`` → ``run_job`` → ``mark_result`` /
    ``release_lock`` and updates the Rich dashboard. The legacy
    launcher's per-stage telemetry calls are replaced by the saga's
    own event recording (the dashboard reads the same state via the
    ``update_state`` calls in ``run_job``).
    """
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
    # before starting new workers (per §8.3 compensation).
    try:
        repository = SqliteApplyRunRepository(get_connection())
        saga = ApplySaga(
            browser_port=LocalChromeAdapter(),
            agent_port=ClaudeCodeCliAdapter(),
            repository=repository,
        )
        rescued = saga.mark_orphans_as_failed(tenant_id=LOCAL_TENANT)
        if rescued:
            console.print(
                f"[yellow]Rescued {len(rescued)} orphaned apply run(s) from prior crash[/yellow]"
            )
    except Exception:  # noqa: BLE001 — orphan sweep is best-effort
        logger.exception("Orphan sweep failed")

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
    return total_applied, total_failed


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
