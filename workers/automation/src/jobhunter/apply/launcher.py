"""Apply orchestration: acquire jobs, spawn Claude Code sessions, track results.

This is the main entry point for the apply pipeline. It pulls jobs from
the database, launches Chrome + Claude Code for each one, parses the
result, and updates the database. Supports parallel workers via --workers.
"""

import atexit
import json
import logging
import os
import platform
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console
from rich.live import Live

from jobhunter import config
from jobhunter.database import get_connection
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.state import ensure_job_stage_rows, record_job_event, set_stage_state
from jobhunter.apply import prompt as prompt_mod
from jobhunter.apply.chrome import (
    launch_chrome, cleanup_worker, kill_all_chrome,
    reset_worker_dir, cleanup_on_exit, _kill_process_tree,
    BASE_CDP_PORT,
)
from jobhunter.apply.dashboard import (
    init_worker, update_state, add_event, get_state,
    render_full, get_totals,
)

logger = logging.getLogger(__name__)

try:
    from jobhunter.apply import telemetry as _telemetry_mod
except Exception:
    _telemetry_mod = None

# Blocked sites loaded from config/sites.yaml
def _load_blocked():
    from jobhunter.config import load_blocked_sites
    return load_blocked_sites()

# How often to poll the DB when the queue is empty (seconds)
POLL_INTERVAL = config.DEFAULTS["poll_interval"]

# Thread-safe shutdown coordination
_stop_event = threading.Event()

# Track active Claude Code processes for skip (Ctrl+C) handling
_claude_procs: dict[int, subprocess.Popen] = {}
_claude_lock = threading.Lock()


def _enqueue_stdout_lines(stream, out: "queue.Queue[str | None]") -> None:
    """Read process stdout in a daemon thread so timeout checks keep running."""
    try:
        for line in stream:
            out.put(line)
    finally:
        out.put(None)

# Register cleanup on exit
atexit.register(cleanup_on_exit)
if platform.system() != "Windows":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


# ---------------------------------------------------------------------------
# MCP config
# ---------------------------------------------------------------------------

def _make_mcp_config(cdp_port: int) -> dict:
    """Build MCP config dict for a specific CDP port."""
    return {
        "mcpServers": {
            "playwright": {
                "command": "npx",
                "args": [
                    "@playwright/mcp@latest",
                    f"--cdp-endpoint=http://localhost:{cdp_port}",
                    f"--viewport-size={config.DEFAULTS['viewport']}",
                ],
            },
            "gmail": {
                "command": "npx",
                "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
            },
        },
    }


def _telemetry_fn(*names: str):
    """Return the first available telemetry function from the module, if any."""
    if _telemetry_mod is None:
        return None
    for name in names:
        fn = getattr(_telemetry_mod, name, None)
        if callable(fn):
            return fn
    return None


def _compact_text(text: str | None, limit: int = 160) -> str:
    """Collapse large text into a short, single-line preview."""
    if not text:
        return ""
    compact = re.sub(r"\s+", " ", text.strip())
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 3)] + "..."


def _job_snapshot(job: dict | None) -> dict:
    """Extract a concise, structured job summary for telemetry payloads."""
    if not job:
        return {}
    return {
        "job_url": job.get("url"),
        "application_url": job.get("application_url"),
        "job_title": job.get("title"),
        "site": job.get("site"),
        "fit_score": job.get("fit_score"),
        "location": job.get("location"),
    }


def _run_snapshot(run_ctx: dict | None = None, **extra) -> dict:
    """Build a structured payload for telemetry calls."""
    payload: dict = {}
    if run_ctx:
        for key in (
            "run_id", "worker_id", "job_url", "application_url", "job_title",
            "site", "fit_score", "location", "model", "dry_run", "target_url",
            "chrome_pid", "claude_pid", "worker_log", "job_log", "mcp_config",
            "headless", "resume_path", "cover_letter_path", "duration_ms",
        ):
            value = run_ctx.get(key)
            if value is not None:
                payload[key] = value
    payload.update(extra)
    return payload


def _telemetry_emit(event_type: str, run_ctx: dict | None = None, **payload) -> None:
    """Best-effort structured telemetry emission."""
    if _telemetry_mod is None:
        return

    data = _run_snapshot(run_ctx, event_type=event_type, **payload)
    fn = _telemetry_fn(
        "record_event", "record_apply_event", "log_event", "log_apply_event",
        "append_event", "append_run_event", "emit_event", "emit_apply_event",
    )
    if fn is None:
        return
    try:
        fn(**data)
    except TypeError:
        try:
            fn(data)
        except Exception:
            logger.debug("Telemetry event failed for %s", event_type, exc_info=True)
    except Exception:
        logger.debug("Telemetry event failed for %s", event_type, exc_info=True)


def _telemetry_start_run(run_ctx: dict | None = None, **payload) -> None:
    """Best-effort run creation/update hook."""
    if _telemetry_mod is None:
        return

    data = _run_snapshot(run_ctx, **payload)
    fn = _telemetry_fn(
        "start_run", "start_apply_run", "record_run_start",
        "record_apply_run_start", "create_run", "create_apply_run",
    )
    if fn is None:
        return
    try:
        fn(**data)
    except TypeError:
        try:
            fn(data)
        except Exception:
            logger.debug("Telemetry start failed", exc_info=True)
    except Exception:
        logger.debug("Telemetry start failed", exc_info=True)


def _telemetry_finish_run(run_ctx: dict | None = None, **payload) -> None:
    """Best-effort run completion hook."""
    if _telemetry_mod is None:
        return

    data = _run_snapshot(run_ctx, **payload)
    fn = _telemetry_fn(
        "finish_run", "finish_apply_run", "record_run_finish",
        "record_apply_run_finish", "end_run", "complete_run",
        "close_run", "close_apply_run",
    )
    if fn is None:
        return
    try:
        fn(**data)
    except TypeError:
        try:
            fn(data)
        except Exception:
            logger.debug("Telemetry finish failed", exc_info=True)
    except Exception:
        logger.debug("Telemetry finish failed", exc_info=True)


# ---------------------------------------------------------------------------
# Database operations
# ---------------------------------------------------------------------------

def acquire_job(target_url: str | None = None, min_score: int = 7,
                worker_id: int = 0, run_ctx: dict | None = None) -> dict | None:
    """Atomically acquire the next job to apply to.

    Args:
        target_url: Apply to a specific URL instead of picking from queue.
        min_score: Minimum fit_score threshold.
        worker_id: Worker claiming this job (for tracking).

    Returns:
        Job dict or None if the queue is empty.
    """
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")

        if target_url:
            like = f"%{target_url.split('?')[0].rstrip('/')}%"
            row = conn.execute("""
                SELECT url, title, site, application_url, tailored_resume_path,
                       fit_score, location, full_description, cover_letter_path,
                       apply_attempts
                FROM jobs
                WHERE (url = ? OR application_url = ? OR application_url LIKE ? OR url LIKE ?)
                  AND tailored_resume_path IS NOT NULL
                  AND (apply_status IS NULL OR apply_status != 'in_progress')
                LIMIT 1
            """, (target_url, target_url, like, like)).fetchone()
        else:
            blocked_sites, blocked_patterns = _load_blocked()
            # Build parameterized filters to avoid SQL injection
            params: list = [min_score]
            site_clause = ""
            if blocked_sites:
                placeholders = ",".join("?" * len(blocked_sites))
                site_clause = f"AND site NOT IN ({placeholders})"
                params.extend(blocked_sites)
            url_clauses = ""
            if blocked_patterns:
                url_clauses = " ".join("AND url NOT LIKE ?" for _ in blocked_patterns)
                params.extend(blocked_patterns)
            row = conn.execute(f"""
                SELECT url, title, site, application_url, tailored_resume_path,
                       fit_score, location, full_description, cover_letter_path,
                       apply_attempts
                FROM jobs
                WHERE tailored_resume_path IS NOT NULL
                  AND application_url IS NOT NULL AND application_url != ''
                  AND (apply_status IS NULL OR apply_status = 'failed')
                  AND (apply_attempts IS NULL OR apply_attempts < ?)
                  AND fit_score >= ?
                  {site_clause}
                  {url_clauses}
                ORDER BY fit_score DESC, url
                LIMIT 1
            """, [config.DEFAULTS["max_apply_attempts"]] + params).fetchone()

        if not row:
            conn.rollback()
            return None

        # Skip manual ATS sites (unsolvable CAPTCHAs)
        from jobhunter.config import is_manual_ats
        apply_url = row["application_url"] or row["url"]
        if is_manual_ats(apply_url):
            conn.execute(
                "UPDATE jobs SET apply_status = 'manual', apply_error = 'manual ATS' WHERE url = ?",
                (row["url"],),
            )
            conn.commit()
            _telemetry_emit(
                "job_skipped",
                run_ctx,
                reason="manual_ats",
                status="manual",
                **_job_snapshot(dict(row)),
            )
            logger.info("Skipping manual ATS: %s", row["url"][:80])
            return None

        now = datetime.now(timezone.utc).isoformat()
        ensure_job_stage_rows(conn, row["url"])
        set_stage_state(
            conn,
            row["url"],
            "apply",
            "running",
            started_at=now,
            attempt_count=int(row["apply_attempts"] or 0),
        )
        record_job_event(conn, row["url"], "apply", "StageStarted", message="Apply agent acquired job")
        conn.execute("""
            UPDATE jobs SET apply_status = 'in_progress',
                           agent_id = ?,
                           apply_task_id = ?,
                           last_attempted_at = ?
            WHERE url = ?
        """, (f"worker-{worker_id}", run_ctx.get("run_id") if run_ctx else None, now, row["url"]))
        conn.commit()

        if run_ctx is not None:
            run_ctx.update(_job_snapshot(dict(row)))
            run_ctx.setdefault("worker_id", worker_id)
            _telemetry_start_run(
                run_ctx,
                status="in_progress",
                acquired_at=now,
            )
            _telemetry_emit(
                "job_acquired",
                run_ctx,
                status="in_progress",
                acquired_at=now,
            )

        job = dict(row)
        if run_ctx is not None:
            job["apply_run_id"] = run_ctx.get("run_id")
        return job
    except Exception:
        conn.rollback()
        raise


def mark_result(url: str, status: str, error: str | None = None,
                permanent: bool = False, duration_ms: int | None = None,
                task_id: str | None = None, run_ctx: dict | None = None) -> None:
    """Update a job's apply status in the database."""
    conn = get_connection()
    now = datetime.now(timezone.utc).isoformat()
    ensure_job_stage_rows(conn, url)
    if status == "applied":
        conn.execute("""
            UPDATE jobs SET apply_status = 'applied', applied_at = ?,
                           apply_error = NULL, agent_id = NULL,
                           apply_duration_ms = ?, apply_task_id = ?
            WHERE url = ?
        """, (now, duration_ms, task_id, url))
        set_stage_state(conn, url, "apply", "succeeded", finished_at=now, duration_ms=duration_ms)
        record_job_event(conn, url, "apply", "StageCompleted", message="Application submitted")
    elif status == "dry_run":
        conn.execute("""
            UPDATE jobs SET apply_status = 'dry_run', apply_error = NULL,
                           agent_id = NULL, last_attempted_at = ?,
                           apply_duration_ms = ?, apply_task_id = ?
            WHERE url = ?
        """, (now, duration_ms, task_id, url))
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
        record_job_event(conn, url, "apply", "DryRunCompleted", message="Dry run completed without submitting")
    else:
        attempts = 99 if permanent else "COALESCE(apply_attempts, 0) + 1"
        conn.execute(f"""
            UPDATE jobs SET apply_status = ?, apply_error = ?,
                           apply_attempts = {attempts}, agent_id = NULL,
                           apply_duration_ms = ?, apply_task_id = ?
            WHERE url = ?
        """, (status, error or "unknown", duration_ms, task_id, url))
        set_stage_state(
            conn,
            url,
            "apply",
            "failed",
            finished_at=now,
            duration_ms=duration_ms,
            error_code=status.upper(),
            error_message=error or "unknown",
            retryable=not permanent,
            next_action=f"jobhunter apply --url {url}" if not permanent else None,
        )
        record_job_event(
            conn,
            url,
            "apply",
            "StageFailed",
            level="error",
            message=error or "unknown",
        )
    conn.commit()
    _telemetry_emit(
        "result_recorded",
        run_ctx,
        status=status,
        permanent=permanent,
        error=error or "unknown",
        duration_ms=duration_ms,
        task_id=task_id,
        applied_at=now if status == "applied" else None,
    )


def release_lock(url: str, run_ctx: dict | None = None) -> None:
    """Release the in_progress lock without changing status."""
    conn = get_connection()
    conn.execute(
        "UPDATE jobs SET apply_status = NULL, agent_id = NULL WHERE url = ? AND apply_status = 'in_progress'",
        (url,),
    )
    set_stage_state(conn, url, "apply", "pending", next_action=f"jobhunter apply --url {url}")
    record_job_event(conn, url, "apply", "LockReleased", message="Apply lock released")
    conn.commit()
    _telemetry_emit("lock_released", run_ctx, job_url=url)


# ---------------------------------------------------------------------------
# Utility modes (--gen, --mark-applied, --mark-failed, --reset-failed)
# ---------------------------------------------------------------------------

def _load_profile_snapshot() -> ProfileSnapshot:
    """Load the active ProfileSnapshot via the local repository.

    Centralised so each apply entry point can swap to a tenant-scoped lookup
    without touching the call sites.
    """
    from jobhunter.infrastructure.profile import get_profile_repository

    return get_profile_repository().load_snapshot(LOCAL_TENANT)


def gen_prompt(target_url: str, min_score: int = 7,
               model: str = "sonnet", worker_id: int = 0,
               snapshot: ProfileSnapshot | None = None) -> Path | None:
    """Generate a prompt file and print the Claude CLI command for manual debugging.

    Returns:
        Path to the generated prompt file, or None if no job found.
    """
    job = acquire_job(target_url=target_url, min_score=min_score, worker_id=worker_id)
    if not job:
        return None

    if snapshot is None:
        snapshot = _load_profile_snapshot()

    # Read resume text
    resume_path = job.get("tailored_resume_path")
    txt_path = Path(resume_path).with_suffix(".txt") if resume_path else None
    resume_text = ""
    if txt_path and txt_path.exists():
        resume_text = txt_path.read_text(encoding="utf-8")

    prompt = prompt_mod.build_prompt(job=job, tailored_resume=resume_text, snapshot=snapshot)

    # Release the lock so the job stays available
    release_lock(job["url"])

    # Write prompt file
    config.ensure_dirs()
    site_slug = (job.get("site") or "unknown")[:20].replace(" ", "_")
    prompt_file = config.LOG_DIR / f"prompt_{site_slug}_{job['title'][:30].replace(' ', '_')}.txt"
    prompt_file.write_text(prompt, encoding="utf-8")

    # Write MCP config for reference
    port = BASE_CDP_PORT + worker_id
    mcp_path = config.APP_DIR / f".mcp-apply-{worker_id}.json"
    mcp_path.write_text(json.dumps(_make_mcp_config(port)), encoding="utf-8")

    return prompt_file


def mark_job(url: str, status: str, reason: str | None = None) -> None:
    """Manually mark a job's apply status in the database.

    Args:
        url: Job URL to mark.
        status: Either 'applied' or 'failed'.
        reason: Failure reason (only for status='failed').
    """
    conn = get_connection()
    now = datetime.now(timezone.utc).isoformat()
    if status == "applied":
        conn.execute("""
            UPDATE jobs SET apply_status = 'applied', applied_at = ?,
                           apply_error = NULL, agent_id = NULL
            WHERE url = ?
        """, (now, url))
    else:
        conn.execute("""
            UPDATE jobs SET apply_status = 'failed', apply_error = ?,
                           apply_attempts = 99, agent_id = NULL
            WHERE url = ?
        """, (reason or "manual", url))
    conn.commit()


def reset_failed() -> int:
    """Reset all failed jobs so they can be retried.

    Returns:
        Number of jobs reset.
    """
    conn = get_connection()
    cursor = conn.execute("""
        UPDATE jobs SET apply_status = NULL, apply_error = NULL,
                       apply_attempts = 0, agent_id = NULL
        WHERE apply_status = 'failed'
          OR (apply_status IS NOT NULL AND apply_status != 'applied'
              AND apply_status != 'in_progress')
    """)
    conn.commit()
    return cursor.rowcount


# ---------------------------------------------------------------------------
# Per-job execution
# ---------------------------------------------------------------------------

def run_job(job: dict, port: int, worker_id: int = 0,
            model: str = "sonnet", dry_run: bool = False,
            run_ctx: dict | None = None,
            snapshot: ProfileSnapshot | None = None) -> tuple[str, int]:
    """Spawn a Claude Code session for one job application.

    Returns:
        Tuple of (status_string, duration_ms). Status is one of:
        'applied', 'expired', 'captcha', 'login_issue',
        'failed:reason', or 'skipped'.
    """
    run_ctx = run_ctx or {}
    run_id = run_ctx.setdefault("run_id", uuid.uuid4().hex)
    run_ctx.setdefault("worker_id", worker_id)
    run_ctx.update(_job_snapshot(job))

    # Read tailored resume text
    resume_path = job.get("tailored_resume_path")
    txt_path = Path(resume_path).with_suffix(".txt") if resume_path else None

    run_ctx.update({
        "model": model,
        "dry_run": dry_run,
        "port": port,
        "resume_path": str(txt_path) if txt_path else None,
        "cover_letter_path": job.get("cover_letter_path"),
    })
    resume_text = ""
    if txt_path and txt_path.exists():
        resume_text = txt_path.read_text(encoding="utf-8")

    if snapshot is None:
        snapshot = _load_profile_snapshot()

    # Build the prompt
    agent_prompt = prompt_mod.build_prompt(
        job=job,
        tailored_resume=resume_text,
        dry_run=dry_run,
        snapshot=snapshot,
    )
    run_ctx["prompt_chars"] = len(agent_prompt)
    run_ctx["prompt_preview"] = _compact_text(agent_prompt, 220)
    _telemetry_emit(
        "prompt_built",
        run_ctx,
        prompt_chars=run_ctx["prompt_chars"],
        prompt_preview=run_ctx["prompt_preview"],
        resume_chars=len(resume_text),
    )

    # Write per-worker MCP config
    mcp_config_path = config.APP_DIR / f".mcp-apply-{worker_id}.json"
    mcp_config_path.write_text(json.dumps(_make_mcp_config(port)), encoding="utf-8")
    run_ctx["mcp_config"] = str(mcp_config_path)

    # Build claude command
    cmd = [
        "claude",
        "--model", model,
        "-p",
        "--mcp-config", str(mcp_config_path),
        "--permission-mode", "bypassPermissions",
        "--no-session-persistence",
        "--disallowedTools", (
            "mcp__gmail__draft_email,mcp__gmail__modify_email,"
            "mcp__gmail__delete_email,mcp__gmail__download_attachment,"
            "mcp__gmail__batch_modify_emails,mcp__gmail__batch_delete_emails,"
            "mcp__gmail__create_label,mcp__gmail__update_label,"
            "mcp__gmail__delete_label,mcp__gmail__get_or_create_label,"
            "mcp__gmail__list_email_labels,mcp__gmail__create_filter,"
            "mcp__gmail__list_filters,mcp__gmail__get_filter,"
            "mcp__gmail__delete_filter"
        ),
        "--output-format", "stream-json",
        "--verbose", "-",
    ]

    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)

    worker_dir = reset_worker_dir(worker_id)
    run_ctx["worker_dir"] = str(worker_dir)

    update_state(worker_id, run_id=run_id, status="applying", job_title=job["title"],
                 company=job.get("site", ""), score=job.get("fit_score", 0),
                 start_time=time.time(), actions=0, last_action="starting")
    add_event(f"[W{worker_id} {run_id[:8]}] Starting: {job['title'][:40]} @ {job.get('site', '')}")
    _telemetry_emit(
        "job_run_started",
        run_ctx,
        message="starting",
        job_title=job.get("title"),
    )

    worker_log = config.LOG_DIR / f"worker-{worker_id}.log"
    run_ctx["worker_log"] = str(worker_log)
    ts_header = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_header = (
        f"\n{'=' * 60}\n"
        f"[{ts_header}] {job['title']} @ {job.get('site', '')}\n"
        f"URL: {job.get('application_url') or job['url']}\n"
        f"Score: {job.get('fit_score', 'N/A')}/10\n"
        f"{'=' * 60}\n"
    )

    start = time.time()
    stats: dict = {}
    proc = None

    try:
        _telemetry_emit(
            "claude_launch_started",
            run_ctx,
            command="claude",
            model=model,
        )
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            cwd=str(worker_dir),
        )
        run_ctx["claude_pid"] = proc.pid
        with _claude_lock:
            _claude_procs[worker_id] = proc
        _telemetry_emit(
            "claude_launch_succeeded",
            run_ctx,
            claude_pid=proc.pid,
            worker_dir=str(worker_dir),
        )

        proc.stdin.write(agent_prompt)
        proc.stdin.close()

        text_parts: list[str] = []
        stdout_queue: queue.Queue[str | None] = queue.Queue()
        stdout_reader = threading.Thread(
            target=_enqueue_stdout_lines,
            args=(proc.stdout, stdout_queue),
            name=f"claude-stdout-{worker_id}",
            daemon=True,
        )
        stdout_reader.start()
        timeout_seconds = int(config.DEFAULTS.get("apply_timeout", 300))
        deadline = time.monotonic() + timeout_seconds
        with open(worker_log, "a", encoding="utf-8") as lf:
            lf.write(log_header)

            while True:
                if proc.poll() is None and time.monotonic() > deadline:
                    raise subprocess.TimeoutExpired(cmd, timeout_seconds)
                try:
                    queued_line = stdout_queue.get(timeout=0.25)
                except queue.Empty:
                    if proc.poll() is not None and not stdout_reader.is_alive():
                        break
                    continue
                if queued_line is None:
                    break

                line = queued_line
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    msg_type = msg.get("type")
                    if msg_type == "assistant":
                        for block in msg.get("message", {}).get("content", []):
                            bt = block.get("type")
                            if bt == "text":
                                text = block.get("text", "") or ""
                                text_parts.append(text)
                                lf.write(text + "\n")
                                _telemetry_emit(
                                    "assistant_text",
                                    run_ctx,
                                    text_preview=_compact_text(text, 180),
                                    text_chars=len(text),
                                )
                            elif bt == "tool_use":
                                name = (
                                    block.get("name", "")
                                    .replace("mcp__playwright__", "")
                                    .replace("mcp__gmail__", "gmail:")
                                )
                                inp = block.get("input", {})
                                if "url" in inp:
                                    desc = f"{name} {inp['url'][:60]}"
                                elif "ref" in inp:
                                    desc = f"{name} {inp.get('element', inp.get('text', ''))}"[:50]
                                elif "fields" in inp:
                                    desc = f"{name} ({len(inp['fields'])} fields)"
                                elif "paths" in inp:
                                    desc = f"{name} upload"
                                else:
                                    desc = name

                                lf.write(f"  >> {desc}\n")
                                ws = get_state(worker_id)
                                cur_actions = ws.actions if ws else 0
                                update_state(worker_id,
                                             actions=cur_actions + 1,
                                             last_action=desc[:35])
                                _telemetry_emit(
                                    "tool_use",
                                    run_ctx,
                                    tool_name=name,
                                    tool_preview=_compact_text(json.dumps(inp, default=str), 220),
                                    action_count=cur_actions + 1,
                                )
                    elif msg_type == "result":
                        stats = {
                            "input_tokens": msg.get("usage", {}).get("input_tokens", 0),
                            "output_tokens": msg.get("usage", {}).get("output_tokens", 0),
                            "cache_read": msg.get("usage", {}).get("cache_read_input_tokens", 0),
                            "cache_create": msg.get("usage", {}).get("cache_creation_input_tokens", 0),
                            "cost_usd": msg.get("total_cost_usd", 0),
                            "turns": msg.get("num_turns", 0),
                        }
                        result_text = msg.get("result", "") or ""
                        text_parts.append(result_text)
                        _telemetry_emit(
                            "claude_result",
                            run_ctx,
                            result_preview=_compact_text(result_text, 220),
                            result_chars=len(result_text),
                            input_tokens=stats["input_tokens"],
                            output_tokens=stats["output_tokens"],
                            cost_usd=stats["cost_usd"],
                            turns=stats["turns"],
                        )
                except json.JSONDecodeError:
                    text_parts.append(line)
                    lf.write(line + "\n")
                    _telemetry_emit(
                        "stream_parse_fallback",
                        run_ctx,
                        line_preview=_compact_text(line, 180),
                    )

        proc.wait(timeout=5)
        returncode = proc.returncode
        proc = None

        if returncode and returncode < 0:
            duration_ms = int((time.time() - start) * 1000)
            run_ctx["duration_ms"] = duration_ms
            _telemetry_emit(
                "process_skipped",
                run_ctx,
                duration_ms=duration_ms,
                returncode=returncode,
            )
            return "skipped", duration_ms

        output = "\n".join(text_parts)
        elapsed = int(time.time() - start)
        duration_ms = int((time.time() - start) * 1000)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        job_log = config.LOG_DIR / f"claude_{ts}_w{worker_id}_{job.get('site', 'unknown')[:20]}_{run_id[:8]}.txt"
        job_log.write_text(output, encoding="utf-8")
        run_ctx["job_log"] = str(job_log)
        run_ctx["duration_ms"] = duration_ms
        run_ctx["output_chars"] = len(output)

        if stats:
            cost = stats.get("cost_usd", 0)
            ws = get_state(worker_id)
            prev_cost = ws.total_cost if ws else 0.0
            update_state(worker_id, total_cost=prev_cost + cost)
            _telemetry_emit(
                "usage_recorded",
                run_ctx,
                input_tokens=stats.get("input_tokens", 0),
                output_tokens=stats.get("output_tokens", 0),
                cache_read_tokens=stats.get("cache_read", 0),
                cache_create_tokens=stats.get("cache_create", 0),
                cost_usd=cost,
                turns=stats.get("turns", 0),
            )

        def _clean_reason(s: str) -> str:
            return re.sub(r'[*`"]+$', '', s).strip()

        for result_status in ["APPLIED", "DRY_RUN", "EXPIRED", "CAPTCHA", "LOGIN_ISSUE"]:
            if f"RESULT:{result_status}" in output:
                add_event(f"[W{worker_id} {run_id[:8]}] {result_status} ({elapsed}s): {job['title'][:30]}")
                final_status = "dry_run" if result_status == "DRY_RUN" or dry_run else result_status.lower()
                update_state(worker_id, status=final_status,
                             last_action=f"{result_status} ({elapsed}s)")
                _telemetry_emit(
                    "final_result_detected",
                    run_ctx,
                    final_status=final_status,
                    result_reason=None,
                    duration_ms=duration_ms,
                )
                return final_status, duration_ms

        if "RESULT:FAILED" in output:
            for out_line in output.split("\n"):
                if "RESULT:FAILED" in out_line:
                    reason = (
                        out_line.split("RESULT:FAILED:")[-1].strip()
                        if ":" in out_line[out_line.index("FAILED") + 6:]
                        else "unknown"
                    )
                    reason = _clean_reason(reason)
                    PROMOTE_TO_STATUS = {"captcha", "expired", "login_issue"}
                    if reason in PROMOTE_TO_STATUS:
                        add_event(f"[W{worker_id} {run_id[:8]}] {reason.upper()} ({elapsed}s): {job['title'][:30]}")
                        update_state(worker_id, status=reason,
                                     last_action=f"{reason.upper()} ({elapsed}s)")
                        _telemetry_emit(
                            "final_result_detected",
                            run_ctx,
                            final_status=reason,
                            result_reason=reason,
                            duration_ms=duration_ms,
                        )
                        return reason, duration_ms
                    add_event(f"[W{worker_id} {run_id[:8]}] FAILED ({elapsed}s): {reason[:30]}")
                    update_state(worker_id, status="failed",
                                 last_action=f"FAILED: {reason[:25]}")
                    _telemetry_emit(
                        "final_result_detected",
                        run_ctx,
                        final_status="failed",
                        result_reason=reason,
                        duration_ms=duration_ms,
                    )
                    return f"failed:{reason}", duration_ms
            return "failed:unknown", duration_ms

        add_event(f"[W{worker_id} {run_id[:8]}] NO RESULT ({elapsed}s)")
        update_state(worker_id, status="failed", last_action=f"no result ({elapsed}s)")
        _telemetry_emit(
            "final_result_missing",
            run_ctx,
            final_status="failed",
            result_reason="no_result_line",
            duration_ms=duration_ms,
        )
        return "failed:no_result_line", duration_ms

    except subprocess.TimeoutExpired:
        duration_ms = int((time.time() - start) * 1000)
        elapsed = int(time.time() - start)
        add_event(f"[W{worker_id} {run_id[:8]}] TIMEOUT ({elapsed}s)")
        update_state(worker_id, status="failed", last_action=f"TIMEOUT ({elapsed}s)")
        _telemetry_emit(
            "timeout",
            run_ctx,
            duration_ms=duration_ms,
        )
        return "failed:timeout", duration_ms
    except Exception as e:
        duration_ms = int((time.time() - start) * 1000)
        add_event(f"[W{worker_id} {run_id[:8]}] ERROR: {str(e)[:40]}")
        update_state(worker_id, status="failed", last_action=f"ERROR: {str(e)[:25]}")
        _telemetry_emit(
            "run_error",
            run_ctx,
            error=str(e),
            duration_ms=duration_ms,
        )
        return f"failed:{str(e)[:100]}", duration_ms
    finally:
        proc_pid = proc.pid if proc is not None else None
        _telemetry_emit(
            "cleanup_started",
            run_ctx,
            claude_pid=proc_pid,
        )
        with _claude_lock:
            _claude_procs.pop(worker_id, None)
        if proc is not None and proc.poll() is None:
            _kill_process_tree(proc.pid)
        _telemetry_emit(
            "cleanup_finished",
            run_ctx,
            claude_pid=proc_pid,
        )


# ---------------------------------------------------------------------------
# Permanent failure classification
# ---------------------------------------------------------------------------

PERMANENT_FAILURES: set[str] = {
    "expired", "captcha", "login_issue",
    "not_eligible_location", "not_eligible_salary",
    "already_applied", "account_required",
    "not_a_job_application", "unsafe_permissions",
    "unsafe_verification", "sso_required",
    "site_blocked", "cloudflare_blocked", "blocked_by_cloudflare",
}

PERMANENT_PREFIXES: tuple[str, ...] = ("site_blocked", "cloudflare", "blocked_by")


def _is_permanent_failure(result: str) -> bool:
    """Determine if a failure should never be retried."""
    reason = result.split(":", 1)[-1] if ":" in result else result
    return (
        result in PERMANENT_FAILURES
        or reason in PERMANENT_FAILURES
        or any(reason.startswith(p) for p in PERMANENT_PREFIXES)
    )


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------

def worker_loop(worker_id: int = 0, limit: int = 1,
                target_url: str | None = None,
                min_score: int = 7, headless: bool = False,
                model: str = "sonnet", dry_run: bool = False,
                snapshot: ProfileSnapshot | None = None) -> tuple[int, int]:
    """Run jobs sequentially until limit is reached or queue is empty.

    Args:
        worker_id: Numeric worker identifier.
        limit: Max jobs to process (0 = continuous).
        target_url: Apply to a specific URL.
        min_score: Minimum fit_score threshold.
        headless: Run Chrome headless.
        model: Claude model name.
        dry_run: Don't click Submit.

    Returns:
        Tuple of (applied_count, failed_count).
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

        update_state(worker_id, status="idle", job_title="", company="",
                     run_id="", last_action="waiting for job", actions=0)

        run_ctx = {
            "run_id": uuid.uuid4().hex,
            "worker_id": worker_id,
            "model": model,
            "dry_run": dry_run,
            "target_url": target_url,
            "min_score": min_score,
            "headless": headless,
        }
        job = acquire_job(target_url=target_url, min_score=min_score,
                          worker_id=worker_id, run_ctx=run_ctx)
        if not job:
            if not continuous:
                add_event(f"[W{worker_id}] Queue empty")
                update_state(worker_id, status="done", last_action="queue empty")
                break
            empty_polls += 1
            update_state(worker_id, status="idle",
                         last_action=f"polling ({empty_polls})")
            if empty_polls == 1:
                add_event(f"[W{worker_id}] Queue empty, polling every {POLL_INTERVAL}s...")
            # Use Event.wait for interruptible sleep
            if _stop_event.wait(timeout=POLL_INTERVAL):
                break  # Stop was requested during wait
            continue

        empty_polls = 0

        chrome_proc = None
        try:
            update_state(worker_id, run_id=run_ctx["run_id"], status="launching")
            add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Launching Chrome...")
            _telemetry_emit(
                "chrome_launch_started",
                run_ctx,
                headless=headless,
                port=port,
            )
            try:
                chrome_proc = launch_chrome(worker_id, port=port, headless=headless)
            except Exception as chrome_error:
                _telemetry_emit(
                    "chrome_launch_failed",
                    run_ctx,
                    error=str(chrome_error),
                    headless=headless,
                    port=port,
                )
                raise
            run_ctx["chrome_pid"] = chrome_proc.pid
            update_state(worker_id, run_id=run_ctx["run_id"], status="applying")
            _telemetry_emit(
                "chrome_launch_succeeded",
                run_ctx,
                chrome_pid=chrome_proc.pid,
                headless=headless,
                port=port,
            )

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
                add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Skipped: {job['title'][:30]}")
                _telemetry_finish_run(
                    run_ctx,
                    final_status="skipped",
                    duration_ms=duration_ms,
                    result_reason="skipped",
                )
                continue
            elif result == "applied":
                mark_result(job["url"], "applied", duration_ms=duration_ms,
                            task_id=run_ctx.get("run_id"), run_ctx=run_ctx)
                applied += 1
                update_state(worker_id, jobs_applied=applied,
                             jobs_done=applied + failed)
                _telemetry_finish_run(
                    run_ctx,
                    final_status="applied",
                    duration_ms=duration_ms,
                    result_reason=None,
                )
            elif result == "dry_run":
                mark_result(job["url"], "dry_run", duration_ms=duration_ms,
                            task_id=run_ctx.get("run_id"), run_ctx=run_ctx)
                update_state(worker_id, jobs_done=applied + failed)
                _telemetry_finish_run(
                    run_ctx,
                    final_status="dry_run",
                    duration_ms=duration_ms,
                    result_reason="dry_run",
                )
            else:
                reason = result.split(":", 1)[-1] if ":" in result else result
                mark_result(job["url"], "failed", reason,
                            permanent=_is_permanent_failure(result),
                            duration_ms=duration_ms,
                            task_id=run_ctx.get("run_id"),
                            run_ctx=run_ctx)
                failed += 1
                update_state(worker_id, jobs_failed=failed,
                             jobs_done=applied + failed)
                _telemetry_finish_run(
                    run_ctx,
                    final_status="failed",
                    duration_ms=duration_ms,
                    result_reason=reason,
                )

        except KeyboardInterrupt:
            release_lock(job["url"], run_ctx=run_ctx)
            _telemetry_emit(
                "run_interrupted",
                run_ctx,
                final_status="skipped",
            )
            add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Job skipped (Ctrl+C)")
            _telemetry_finish_run(
                run_ctx,
                final_status="skipped",
                result_reason="ctrl_c",
            )
            if _stop_event.is_set():
                break
            continue
        except Exception as e:
            logger.exception("Worker %d launcher error", worker_id)
            add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Launcher error: {str(e)[:40]}")
            release_lock(job["url"], run_ctx=run_ctx)
            failed += 1
            update_state(worker_id, jobs_failed=failed)
            _telemetry_emit(
                "launcher_error",
                run_ctx,
                error=str(e),
            )
            _telemetry_finish_run(
                run_ctx,
                final_status="failed",
                result_reason=str(e),
            )
        finally:
            if chrome_proc:
                cleanup_worker(worker_id, chrome_proc)
                _telemetry_emit(
                    "chrome_cleanup_finished",
                    run_ctx,
                    chrome_pid=chrome_proc.pid,
                )

        jobs_done += 1
        if target_url:
            break

    update_state(worker_id, run_id="", status="done", last_action="finished")
    return applied, failed


# ---------------------------------------------------------------------------
# Main entry point (called from cli.py)
# ---------------------------------------------------------------------------

def main(limit: int = 1, target_url: str | None = None,
         min_score: int = 7, headless: bool = False, model: str = "sonnet",
         dry_run: bool = False, continuous: bool = False,
         poll_interval: int = 60, workers: int = 1,
         snapshot: ProfileSnapshot | None = None) -> tuple[int, int]:
    """Launch the apply pipeline.

    Args:
        limit: Max jobs to apply to (0 or with continuous=True means run forever).
        target_url: Apply to a specific URL.
        min_score: Minimum fit_score threshold.
        headless: Run Chrome in headless mode.
        model: Claude model name.
        dry_run: Don't click Submit.
        continuous: Run forever, polling for new jobs.
        poll_interval: Seconds between DB polls when queue is empty.
        workers: Number of parallel workers (default 1).
    """
    global POLL_INTERVAL
    POLL_INTERVAL = poll_interval
    _stop_event.clear()

    config.ensure_dirs()
    console = Console()

    # Load the profile snapshot ONCE at the orchestrator level so every
    # worker sees the same version — avoids races where a wizard save
    # mid-run gives different workers different profiles.
    if snapshot is None:
        try:
            snapshot = _load_profile_snapshot()
        except FileNotFoundError:
            snapshot = None  # fall back to lazy load inside run_job

    if continuous:
        effective_limit = 0
        mode_label = "continuous"
    else:
        effective_limit = limit
        mode_label = f"{limit} jobs"

    total_applied = 0
    total_failed = 0

    # Initialize dashboard for all workers
    for i in range(workers):
        init_worker(i)

    worker_label = f"{workers} worker{'s' if workers > 1 else ''}"
    console.print(f"Launching apply pipeline ({mode_label}, {worker_label}, poll every {POLL_INTERVAL}s)...")
    console.print("[dim]Ctrl+C = skip current job(s) | Ctrl+C x2 = stop[/dim]")

    # Double Ctrl+C handler
    _ctrl_c_count = 0

    def _sigint_handler(sig, frame):
        nonlocal _ctrl_c_count
        _ctrl_c_count += 1
        if _ctrl_c_count == 1:
            console.print("\n[yellow]Skipping current job(s)... (Ctrl+C again to STOP)[/yellow]")
            # Kill all active Claude processes to skip current jobs
            with _claude_lock:
                for wid, cproc in list(_claude_procs.items()):
                    if cproc.poll() is None:
                        _kill_process_tree(cproc.pid)
        else:
            console.print("\n[red bold]STOPPING[/red bold]")
            _stop_event.set()
            with _claude_lock:
                for wid, cproc in list(_claude_procs.items()):
                    if cproc.poll() is None:
                        _kill_process_tree(cproc.pid)
            kill_all_chrome()
            raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _sigint_handler)

    try:
        with Live(render_full(), console=console, refresh_per_second=2) as live:
            # Daemon thread for display refresh only (no business logic)
            _dashboard_running = True

            def _refresh():
                while _dashboard_running:
                    live.update(render_full())
                    time.sleep(0.5)

            refresh_thread = threading.Thread(target=_refresh, daemon=True)
            refresh_thread.start()

            if workers == 1:
                # Single worker — run directly in main thread
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
                # Multi-worker — distribute limit across workers
                if effective_limit:
                    base = effective_limit // workers
                    extra = effective_limit % workers
                    limits = [base + (1 if i < extra else 0)
                              for i in range(workers)]
                else:
                    limits = [0] * workers  # continuous mode

                with ThreadPoolExecutor(max_workers=workers,
                                        thread_name_prefix="apply-worker") as executor:
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
                        except Exception:
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
