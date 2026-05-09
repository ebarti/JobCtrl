"""JobHunter CLI — the main entry point."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

import httpx
import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from jobhunter import __version__
from jobhunter.pipeline import STAGE_ORDER, run_pipeline, run_single_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)

app = typer.Typer(
    name="jobhunter",
    help="AI-powered end-to-end job application pipeline.",
    no_args_is_help=True,
)
console = Console()
log = logging.getLogger(__name__)

# Valid pipeline stages (in execution order)
VALID_STAGES = STAGE_ORDER


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_projection_subscription = None


def _bootstrap() -> None:
    """Common setup: load env, create dirs, init DB, refresh projections.

    Phase 9 (S-32): the ``ProjectionBuilder`` runs an initial backfill on
    every CLI invocation so the read-model projections reflect the
    current canonical state before any stage logic runs.  This is
    cheap (incremental from the watermark) and ensures the dashboards
    don't go blank after a fresh DB or a schema migration.

    The same builder also subscribes (idempotently) to the process-wide
    ``InProcessEventBus`` so events emitted later in the worker run
    drive live projection refreshes.
    """
    global _projection_subscription
    from jobhunter.config import load_env, ensure_dirs
    from jobhunter.database import get_connection, init_db
    from jobhunter.infrastructure.projections.projection_builder import (
        ProjectionBuilder,
    )

    load_env()
    ensure_dirs()
    init_db()
    # Bootstrap OTel as early as possible so every span emitted by the
    # rest of this CLI invocation flows to the configured Langfuse instance.
    # init_otel() is idempotent and degrades gracefully when env vars are
    # absent, so it's safe to call from every command.
    from jobhunter.infrastructure.observability import init_otel

    init_otel()
    try:
        # Pass a thread-local connection factory so the wildcard
        # subscriber (which fires on whichever thread published the
        # event — including ``ThreadPoolExecutor`` worker threads in
        # ``apply --workers > 1``) opens a connection on its own
        # thread instead of reusing the bootstrap-thread handle.
        builder = ProjectionBuilder(conn_factory=get_connection)
        builder.refresh()
        if _projection_subscription is None:
            from jobhunter.infrastructure.events import get_default_publisher

            _projection_subscription = builder.subscribe_to(get_default_publisher())
    except Exception:  # noqa: BLE001 — projection refresh failure must not break boot
        log.exception("ProjectionBuilder backfill on bootstrap failed")


def _version_callback(value: bool) -> None:
    if value:
        console.print(f"[bold]jobhunter[/bold] {__version__}")
        raise typer.Exit()


def _validate_validation_mode(validation: str) -> str:
    """Validate the tailor/cover validation mode option."""
    valid_modes = ("strict", "normal", "lenient")
    if validation not in valid_modes:
        console.print(
            f"[red]Invalid --validation value:[/red] '{validation}'. "
            f"Choose from: {', '.join(valid_modes)}"
        )
        raise typer.Exit(code=1)
    return validation


def _load_telemetry_module():
    """Load the apply telemetry module if it exists."""
    try:
        from jobhunter.apply import telemetry as telemetry_mod
    except Exception:
        return None
    return telemetry_mod


def _resolve_telemetry_fn(module, *names: str):
    """Return the first callable telemetry helper matching one of the names."""
    if module is None:
        return None
    for name in names:
        fn = getattr(module, name, None)
        if callable(fn):
            return fn
    return None


def _row_to_dict(value) -> dict:
    """Normalize sqlite rows, dicts, and simple objects into a dictionary."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if hasattr(value, "keys"):
        try:
            return {key: value[key] for key in value.keys()}
        except Exception:
            pass
    if hasattr(value, "_asdict"):
        try:
            return dict(value._asdict())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return {key: val for key, val in vars(value).items() if not key.startswith("_")}
    return {"value": value}


def _pick(data: dict, *keys: str, default=""):
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return default


def _coerce_rows(result) -> list:
    """Turn telemetry helper results into a flat list of rows."""
    if result is None:
        return []
    if isinstance(result, dict):
        for key in ("runs", "events", "rows", "items", "data", "result"):
            value = result.get(key)
            if isinstance(value, list):
                return value
        return [result]
    if isinstance(result, (str, bytes)):
        return []
    try:
        return list(result)
    except TypeError:
        return [result]


def _fmt_duration_ms(value) -> str:
    """Format a duration in milliseconds into a compact human-readable string."""
    if value in (None, ""):
        return ""
    try:
        ms = int(float(value))
    except (TypeError, ValueError):
        return str(value)
    if ms < 1000:
        return f"{ms}ms"
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    remaining = int(seconds % 60)
    return f"{minutes}m {remaining:02d}s"


def _normalize_run(record) -> dict:
    """Normalize a telemetry run row for display."""
    data = _row_to_dict(record)
    run_id = str(_pick(data, "run_id", "id", "uuid", "task_id", default=""))
    status = str(_pick(data, "status", "apply_status", "result_status", "final_status", default="unknown"))
    title = str(_pick(data, "job_title", "title", "job", default=""))
    company = str(_pick(data, "company", "site", "employer", default=""))
    job_url = str(_pick(data, "job_url", "url", "application_url", default=""))
    worker_id = _pick(data, "worker_id", "worker", "agent_id", default="")
    started_at = str(_pick(data, "started_at", "created_at", "run_started_at", "attempted_at", default=""))
    ended_at = str(_pick(data, "ended_at", "finished_at", "completed_at", "run_finished_at", default=""))
    duration_ms = _pick(data, "duration_ms", "apply_duration_ms", "elapsed_ms", "runtime_ms", default="")
    error = str(_pick(data, "error", "apply_error", "failure_reason", "result_error", default=""))
    last_event = str(_pick(data, "last_event", "event", "last_message", "final_message", default=""))
    log_path = str(_pick(data, "log_path", "worker_log_path", "output_path", "artifact_path", default=""))
    model = str(_pick(data, "model", "provider_model", default=""))
    cost_usd = _pick(data, "cost_usd", "total_cost_usd", "cost", default="")
    input_tokens = _pick(data, "input_tokens", "prompt_tokens", default="")
    output_tokens = _pick(data, "output_tokens", "completion_tokens", default="")
    return {
        "run_id": run_id,
        "status": status,
        "job_title": title,
        "company": company,
        "job_url": job_url,
        "worker_id": str(worker_id),
        "started_at": started_at,
        "ended_at": ended_at,
        "duration": _fmt_duration_ms(duration_ms),
        "error": error,
        "last_event": last_event,
        "log_path": log_path,
        "model": model,
        "cost_usd": cost_usd,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }


def _normalize_event(record) -> dict:
    """Normalize a telemetry event row for display."""
    data = _row_to_dict(record)
    payload = _pick(data, "payload", "data", "details", default="")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            pass
    return {
        "ts": str(_pick(data, "ts", "timestamp", "created_at", "occurred_at", default="")),
        "kind": str(_pick(data, "event_type", "type", "name", "action", default="event")),
        "message": str(_pick(data, "message", "summary", "text", "detail", default="")),
        "payload": payload,
    }


def _fetch_recent_runs(limit: int = 8, failed_only: bool = False) -> list[dict]:
    """Fetch recent telemetry-backed apply runs if telemetry is available."""
    telemetry = _load_telemetry_module()
    fn = _resolve_telemetry_fn(
        telemetry,
        "fetch_recent_runs",
        "get_recent_runs",
        "list_recent_runs",
    )
    if fn is None:
        return []

    kwargs = {"limit": limit}
    for key in ("failed_only", "errors_only", "only_failed"):
        if failed_only:
            kwargs[key] = True
            break
    try:
        rows = _coerce_rows(fn(**kwargs))
    except TypeError:
        try:
            rows = _coerce_rows(fn(limit))
        except Exception:
            return []
    except Exception:
        return []
    return [_normalize_run(row) for row in rows]


def _fetch_run_events(run_id: str, limit: int = 8) -> list[dict]:
    """Fetch a timeline of events for a specific run."""
    telemetry = _load_telemetry_module()
    fn = _resolve_telemetry_fn(
        telemetry,
        "fetch_run_events",
        "get_run_events",
        "list_run_events",
        "fetch_recent_events",
        "get_recent_events",
    )
    if fn is None:
        return []

    kwargs = {"run_id": run_id, "limit": limit}
    try:
        rows = _coerce_rows(fn(**kwargs))
    except TypeError:
        try:
            rows = _coerce_rows(fn(run_id, limit))
        except TypeError:
            try:
                rows = _coerce_rows(fn(run_id))
            except Exception:
                return []
    except Exception:
        return []
    return [_normalize_event(row) for row in rows]


def _format_run_label(run: dict) -> str:
    """Build a compact human-readable label for a telemetry run."""
    title = run.get("job_title") or "Untitled"
    company = run.get("company") or "?"
    if company and company != "?":
        return f"{title} @ {company}"
    return title


def _render_live_workers_table() -> Table | None:
    """Render the current in-memory worker state if any workers are active."""
    try:
        from jobhunter.apply.dashboard import get_worker_states
    except Exception:
        return None

    states = get_worker_states()
    if not states:
        return None

    table = Table(title="Live Apply Workers", show_lines=False)
    table.add_column("W", style="bold", width=3, justify="center")
    table.add_column("Run", width=10, justify="center")
    table.add_column("Job", min_width=30, max_width=46, no_wrap=True)
    table.add_column("Status", width=12, justify="center")
    table.add_column("Time", width=6, justify="right")
    table.add_column("Acts", width=5, justify="right")
    table.add_column("Last Action", min_width=20, max_width=35, no_wrap=True)

    for state in states:
        elapsed = ""
        if getattr(state, "start_time", 0.0) and getattr(state, "status", "") == "applying":
            elapsed = f"{int(time.time() - state.start_time)}s"
        status = str(getattr(state, "status", "starting")).upper()
        style = {
            "STARTING": "dim",
            "IDLE": "dim",
            "LAUNCHING": "cyan",
            "APPLYING": "yellow",
            "APPLIED": "green",
            "FINISHED": "green",
            "FAILED": "red",
            "EXPIRED": "red",
            "CAPTCHA": "magenta",
            "LOGIN_ISSUE": "red",
            "DONE": "bold",
        }.get(status, "")
        job_text = f"{state.job_title[:28]} @ {state.company[:16]}" if state.job_title else ""
        run_text = getattr(state, "run_id", "")[:8]
        table.add_row(
            str(state.worker_id),
            run_text,
            job_text,
            Text(status, style=style),
            elapsed,
            str(getattr(state, "actions", 0) or ""),
            getattr(state, "last_action", "")[:35],
        )

    return table


def _render_recent_runs_table(limit: int = 8, failed_only: bool = False) -> Table | None:
    """Render a telemetry-backed recent runs table."""
    runs = _fetch_recent_runs(limit=limit, failed_only=failed_only)
    if not runs:
        return None

    table = Table(title="Recent Apply Runs", show_lines=False)
    table.add_column("Run", width=10, justify="center")
    table.add_column("Status", width=11, justify="center")
    table.add_column("Worker", width=7, justify="center")
    table.add_column("Job", min_width=24, max_width=42, no_wrap=True)
    table.add_column("When", min_width=16)
    table.add_column("Duration", width=9, justify="right")
    table.add_column("What happened", min_width=26, max_width=42, no_wrap=True)

    for run in runs:
        status = (run.get("status") or "unknown").upper()
        status_style = {
            "IN_PROGRESS": "yellow",
            "RUNNING": "yellow",
            "APPLIED": "green",
            "SUCCESS": "green",
            "FAILED": "red",
            "ERROR": "red",
            "SKIPPED": "dim",
            "CANCELLED": "magenta",
        }.get(status, "")
        table.add_row(
            run.get("run_id", "")[:8],
            Text(status, style=status_style),
            str(run.get("worker_id", "")),
            _format_run_label(run),
            run.get("started_at", ""),
            run.get("duration", ""),
            (run.get("error") or run.get("last_event") or "")[:42],
        )

    return table


def _render_run_timeline(run: dict, limit: int = 8) -> Panel | None:
    """Render the event timeline for a single run."""
    run_id = run.get("run_id", "")
    if not run_id:
        return None

    events = _fetch_run_events(run_id, limit=limit)
    if not events:
        return None

    body = Text()
    for event in events:
        ts = event.get("ts", "")
        kind = event.get("kind", "event")
        message = event.get("message") or ""
        payload = event.get("payload")
        if not message and isinstance(payload, dict):
            message = ", ".join(f"{k}={v}" for k, v in list(payload.items())[:3])
        elif not message and payload not in (None, ""):
            message = str(payload)
        if len(message) > 240:
            message = f"{message[:237]}..."
        if body.plain:
            body.append("\n")
        body.append(ts, style="dim")
        body.append(" ")
        body.append(kind, style="cyan")
        body.append(" ")
        body.append(message)

    return Panel(
        body,
        title=f"Run {run_id[:8]} Timeline",
        border_style="dim",
    )


def _run_stage_command(
    stage: str,
    *,
    min_score: int = 7,
    workers: int = 1,
    dry_run: bool = False,
    validation: str = "normal",
    limit: int = 0,
    rescore: bool = False,
    retailor: bool = False,
) -> None:
    """Run a single pipeline stage through the shared orchestrator."""
    _bootstrap()

    if stage in {"score", "tailor", "cover"}:
        from jobhunter.config import check_tier

        feature_names = {
            "score": "AI scoring",
            "tailor": "resume tailoring",
            "cover": "cover letter generation",
        }
        check_tier(2, feature_names[stage])

    validation = _validate_validation_mode(validation)

    result = run_pipeline(
        stages=[stage],
        min_score=min_score,
        dry_run=dry_run,
        workers=workers,
        validation_mode=validation,
        limit=limit,
        rescore=rescore,
        retailor=retailor,
    )

    if result.get("errors"):
        raise typer.Exit(code=1)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

@app.callback()
def main(
    version: bool = typer.Option(
        False, "--version", "-V",
        help="Show version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """JobHunter — AI-powered end-to-end job application pipeline."""


@app.command()
def action(
    stage: str = typer.Argument(..., help=f"Action stage. Valid: {', '.join((*VALID_STAGES, 'apply', 'profile_import'))}."),
    url: Optional[str] = typer.Option(None, "--url", help="Target job URL for targeted actions."),
    limit: int = typer.Option(0, "--limit", help="Maximum records to process. 0 means stage default."),
    workers: int = typer.Option(1, "--workers", "-w", help="Worker count for supported actions."),
    min_score: int = typer.Option(7, "--min-score", help="Minimum fit score for material/apply actions."),
    validation: str = typer.Option("normal", "--validation", help="Validation mode for material generation."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Return the planned action without executing."),
    pdf_path: Optional[str] = typer.Option(None, "--pdf", help="Resume PDF path for profile_import."),
    model: str = typer.Option("haiku", "--model", "-m", help="Apply action model."),
    headless: bool = typer.Option(False, "--headless", help="Run apply browser action headless."),
) -> None:
    """Run a structured local action and print its JSON result."""
    from jobhunter.actions import LocalActionRequest, run_local_action

    validation = _validate_validation_mode(validation)
    try:
        result = run_local_action(
            LocalActionRequest(
                stage=stage,
                job_url=url,
                limit=limit,
                workers=workers,
                min_score=min_score,
                validation_mode=validation,
                dry_run=dry_run,
                pdf_path=pdf_path,
                model=model,
                headless=headless,
            )
        )
    except (OSError, ValueError) as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    console.print_json(data=result.to_dict())
    if not result.ok:
        raise typer.Exit(code=1)


@app.command()
def init() -> None:
    """Run the first-time setup wizard (profile, resume, search config)."""
    from jobhunter.wizard.init import run_wizard

    run_wizard()


@app.command()
def run(
    stages: Optional[list[str]] = typer.Argument(
        None,
        help=(
            "Pipeline stages to run. "
            f"Valid: {', '.join(VALID_STAGES)}, all. "
            "Defaults to 'all' if omitted."
        ),
    ),
    min_score: int = typer.Option(7, "--min-score", help="Minimum fit score for tailor/cover stages."),
    workers: int = typer.Option(
        1,
        "--workers",
        "-w",
        help="Parallel threads for discovery, enrichment, scoring, and tailoring stages.",
    ),
    stream: bool = typer.Option(False, "--stream", help="Run stages concurrently (streaming mode)."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview stages without executing."),
    validation: str = typer.Option(
        "normal",
        "--validation",
        help=(
            "Validation strictness for tailor/cover stages. "
            "strict: banned words = errors, judge must pass. "
            "normal: banned words = warnings only (default, recommended for Gemini free tier). "
            "lenient: banned words ignored, LLM judge skipped (fastest, fewest API calls)."
        ),
    ),
    retailor: bool = typer.Option(
        False,
        "--retailor",
        help="When running tailor, include jobs that already have a tailored resume.",
    ),
) -> None:
    """Run one or more pipeline stages in order."""
    _bootstrap()

    stage_list = stages if stages else ["all"]

    # Validate stage names
    for s in stage_list:
        if s != "all" and s not in VALID_STAGES:
            console.print(
                f"[red]Unknown stage:[/red] '{s}'. "
                f"Valid stages: {', '.join(VALID_STAGES)}, all"
            )
            raise typer.Exit(code=1)

    # Gate AI stages behind Tier 2
    llm_stages = {"score", "tailor", "cover"}
    if any(s in stage_list for s in llm_stages) or "all" in stage_list:
        from jobhunter.config import check_tier
        check_tier(2, "AI scoring/tailoring")

    # Validate the --validation flag value
    validation = _validate_validation_mode(validation)

    if stream and retailor and ("all" in stage_list or "tailor" in stage_list):
        console.print(
            "[red]--retailor cannot be combined with --stream.[/red]\n"
            "Use a normal sequential run so the tailor stage can finish cleanly."
        )
        raise typer.Exit(code=1)

    result = run_pipeline(
        stages=stage_list,
        min_score=min_score,
        dry_run=dry_run,
        stream=stream,
        workers=workers,
        validation_mode=validation,
        retailor=retailor,
    )

    if result.get("errors"):
        raise typer.Exit(code=1)


@app.command()
def discover(
    workers: int = typer.Option(1, "--workers", "-w", help="Parallel threads for discovery backends."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the discovery stage."""
    _run_stage_command("discover", workers=workers, dry_run=dry_run)


@app.command()
def enrich(
    workers: int = typer.Option(1, "--workers", "-w", help="Parallel threads for detail enrichment."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the enrichment stage."""
    _run_stage_command("enrich", workers=workers, dry_run=dry_run)


@app.command()
def score(
    workers: int = typer.Option(1, "--workers", "-w", help="Parallel LLM workers for scoring."),
    limit: int = typer.Option(0, "--limit", help="Maximum jobs to score. 0 means all eligible jobs."),
    rescore: bool = typer.Option(False, "--rescore", help="Re-score jobs that already have a score."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the scoring stage."""
    _run_stage_command("score", workers=workers, dry_run=dry_run, limit=limit, rescore=rescore)


@app.command()
def tailor(
    workers: int = typer.Option(1, "--workers", "-w", help="Parallel LLM workers for tailoring."),
    min_score: int = typer.Option(7, "--min-score", help="Minimum fit score required for tailoring."),
    limit: int = typer.Option(0, "--limit", help="Maximum jobs to tailor. 0 means all eligible jobs."),
    retailor: bool = typer.Option(False, "--retailor", help="Re-tailor jobs that already have a tailored resume."),
    validation: str = typer.Option(
        "normal",
        "--validation",
        help=(
            "Validation strictness. strict: banned words = errors, judge must pass. "
            "normal: banned words = warnings only. "
            "lenient: banned words ignored, LLM judge skipped."
        ),
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the resume tailoring stage."""
    _run_stage_command(
        "tailor",
        workers=workers,
        min_score=min_score,
        dry_run=dry_run,
        validation=validation,
        limit=limit,
        retailor=retailor,
    )


@app.command()
def cover(
    min_score: int = typer.Option(7, "--min-score", help="Minimum fit score required for cover letter generation."),
    limit: int = typer.Option(0, "--limit", help="Maximum jobs to process. 0 means all eligible jobs."),
    validation: str = typer.Option(
        "normal",
        "--validation",
        help=(
            "Validation strictness. strict: banned words = errors. "
            "normal: banned words = warnings only. "
            "lenient: banned words ignored."
        ),
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the cover letter stage."""
    _run_stage_command(
        "cover",
        min_score=min_score,
        dry_run=dry_run,
        validation=validation,
        limit=limit,
    )


@app.command()
def pdf(
    limit: int = typer.Option(0, "--limit", help="Maximum text artifacts to convert. 0 means all pending files."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the PDF conversion stage."""
    _run_stage_command("pdf", dry_run=dry_run, limit=limit)


@app.command()
def apply(
    limit: Optional[int] = typer.Option(None, "--limit", "-l", help="Max applications to submit (default: all ready jobs)."),
    workers: int = typer.Option(1, "--workers", "-w", help="Number of parallel browser workers."),
    min_score: int = typer.Option(7, "--min-score", help="Minimum fit score for job selection."),
    model: str = typer.Option("haiku", "--model", "-m", help="Claude model name."),
    continuous: bool = typer.Option(False, "--continuous", "-c", help="Run forever, polling for new jobs."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview actions without submitting."),
    headless: bool = typer.Option(False, "--headless", help="Run browsers in headless mode."),
    url: Optional[str] = typer.Option(None, "--url", help="Apply to a specific job URL."),
    gen: bool = typer.Option(False, "--gen", help="Generate prompt file for manual debugging instead of running."),
    mark_applied: Optional[str] = typer.Option(None, "--mark-applied", help="Manually mark a job URL as applied."),
    mark_failed: Optional[str] = typer.Option(None, "--mark-failed", help="Manually mark a job URL as failed (provide URL)."),
    fail_reason: Optional[str] = typer.Option(None, "--fail-reason", help="Reason for --mark-failed."),
    reset_failed: bool = typer.Option(False, "--reset-failed", help="Reset all failed jobs for retry."),
) -> None:
    """Launch auto-apply to submit job applications."""
    _bootstrap()

    from jobhunter.config import APP_DIR as _app_dir, check_tier
    from jobhunter.database import get_connection
    from jobhunter.domain.tenant import LOCAL_TENANT
    from jobhunter.infrastructure.profile import get_profile_repository

    # --- Utility modes (no Chrome/Claude needed) ---

    if mark_applied:
        from jobhunter.apply.launcher import mark_job
        mark_job(mark_applied, "applied")
        console.print(f"[green]Marked as applied:[/green] {mark_applied}")
        return

    if mark_failed:
        from jobhunter.apply.launcher import mark_job
        mark_job(mark_failed, "failed", reason=fail_reason)
        console.print(f"[yellow]Marked as failed:[/yellow] {mark_failed} ({fail_reason or 'manual'})")
        return

    if reset_failed:
        from jobhunter.apply.launcher import reset_failed as do_reset
        count = do_reset()
        console.print(f"[green]Reset {count} failed job(s) for retry.[/green]")
        return

    # --- Full apply mode ---

    # Check 1: Tier 3 required (Claude Code CLI + Chrome)
    check_tier(3, "auto-apply")

    # Check 2: Profile exists
    try:
        profile = get_profile_repository().load(LOCAL_TENANT)
    except FileNotFoundError:
        profile = None
    if profile is None:
        console.print(
            "[red]Profile not found.[/red]\n"
            "Run [bold]jobhunter init[/bold] to create your profile first."
        )
        raise typer.Exit(code=1)

    # Check 3: Tailored resumes exist (skip for --gen with --url)
    # ``ready`` is the count of jobs eligible for apply; default to 0 so the
    # downstream ``effective_limit = ready`` reference is unambiguous to
    # static analysers when the gen+url shortcut early-returns.
    ready: int = 0
    if not (gen and url):
        conn = get_connection()
        ready = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE tailored_resume_path IS NOT NULL"
            " AND application_url IS NOT NULL AND application_url != ''"
            " AND (apply_status IS NULL OR apply_status = 'failed')"
        ).fetchone()[0]
        if ready == 0:
            console.print(
                "[red]No jobs ready to apply.[/red]\n"
                "Jobs need a tailored resume and a direct application URL.\n"
                "Run [bold]jobhunter run enrich score tailor[/bold] to prepare applications."
            )
            raise typer.Exit(code=1)

    if gen:
        from jobhunter.apply.launcher import gen_prompt
        target = url or ""
        if not target:
            console.print("[red]--gen requires --url to specify which job.[/red]")
            raise typer.Exit(code=1)
        prompt_file = gen_prompt(target, min_score=min_score, model=model)
        if not prompt_file:
            console.print("[red]No matching job found for that URL.[/red]")
            raise typer.Exit(code=1)
        mcp_path = _app_dir / ".mcp-apply-0.json"
        console.print(f"[green]Wrote prompt to:[/green] {prompt_file}")
        console.print("\n[bold]Run manually:[/bold]")
        console.print(
            f"  claude --model {model} -p "
            f"--mcp-config {mcp_path} "
            f"--permission-mode bypassPermissions < {prompt_file}"
        )
        return

    from jobhunter.apply.launcher import main as apply_main

    if limit is not None:
        effective_limit = limit
    elif continuous:
        effective_limit = 0
    else:
        # Default: apply to all currently ready jobs
        effective_limit = ready

    console.print("\n[bold blue]Launching Auto-Apply[/bold blue]")
    console.print(f"  Limit:    {'unlimited' if continuous else f'{effective_limit} (all ready)'  if limit is None else effective_limit}")
    console.print(f"  Workers:  {workers}")
    console.print(f"  Model:    {model}")
    console.print(f"  Headless: {headless}")
    console.print(f"  Dry run:  {dry_run}")
    if url:
        console.print(f"  Target:   {url}")
    console.print()

    apply_main(
        limit=effective_limit,
        target_url=url,
        min_score=min_score,
        headless=headless,
        model=model,
        dry_run=dry_run,
        continuous=continuous,
        workers=workers,
    )


@app.command()
def job(
    url: str = typer.Argument(..., help="URL of the job to process. Automatically enriched if not already in the database."),
    tailor_flag: bool = typer.Option(False, "--tailor", "-t", help="Only tailor resume + cover letter (skip apply)."),
    apply_flag: bool = typer.Option(False, "--apply", "-a", help="Only apply (skip tailoring). Job must already be tailored."),
    validation: str = typer.Option(
        "normal",
        "--validation",
        help="Validation strictness for tailor/cover. strict | normal | lenient.",
    ),
    model: str = typer.Option("haiku", "--model", "-m", help="Claude model name for auto-apply."),
    headless: bool = typer.Option(False, "--headless", help="Run browser in headless mode."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview without executing."),
) -> None:
    """Run tailoring and/or application for a specific job URL.

    By default, runs both tailoring and apply. Use --tailor or --apply to
    run only one step. Both flags can be combined explicitly.

    Examples:
        jobhunter job https://example.com/job/123              # tailor + apply
        jobhunter job https://example.com/job/123 --tailor     # tailor only
        jobhunter job https://example.com/job/123 --apply      # apply only
    """
    _bootstrap()

    validation = _validate_validation_mode(validation)

    # Determine actions: neither flag → both; otherwise respect flags
    if not tailor_flag and not apply_flag:
        do_tailor = True
        do_apply = True
    else:
        do_tailor = tailor_flag
        do_apply = apply_flag

    # Gate on required tiers
    if do_tailor:
        from jobhunter.config import check_tier
        check_tier(2, "resume tailoring")
    if do_apply:
        from jobhunter.config import check_tier
        check_tier(3, "auto-apply")

    actions = []
    if do_tailor:
        actions.append("tailor")
    if do_apply:
        actions.append("apply")

    console.print()
    console.print(Panel.fit(
        f"[bold]Single Job[/bold] — {' + '.join(actions)}",
        border_style="blue",
    ))
    console.print(f"  URL:        {url}")
    console.print(f"  Validation: {validation}")
    if do_apply:
        console.print(f"  Model:      {model}")
        console.print(f"  Headless:   {headless}")
    if dry_run:
        console.print("  [yellow]DRY RUN[/yellow]")
    console.print()

    result = run_single_job(
        url,
        do_tailor=do_tailor,
        do_apply=do_apply,
        validation_mode=validation,
        model=model,
        headless=headless,
        dry_run=dry_run,
    )

    if result.get("error"):
        console.print(f"\n[red]Error:[/red] {result['error']}")
        raise typer.Exit(code=1)

    if result.get("errors"):
        console.print(f"\n[yellow]Completed with {len(result['errors'])} issue(s):[/yellow]")
        for err in result["errors"]:
            console.print(f"  - {err}")
    else:
        console.print("\n[green]Done.[/green]")


@app.command()
def status() -> None:
    """Show pipeline statistics from the database."""
    _bootstrap()

    from jobhunter.database import get_stats

    stats = get_stats()

    console.print("\n[bold]JobHunter Pipeline Status[/bold]\n")

    # Summary table
    summary = Table(title="Pipeline Overview", show_header=True, header_style="bold cyan")
    summary.add_column("Metric", style="bold")
    summary.add_column("Count", justify="right")

    summary.add_row("Total jobs discovered", str(stats["total"]))
    summary.add_row("With full description", str(stats["with_description"]))
    summary.add_row("Pending enrichment", str(stats["pending_detail"]))
    summary.add_row("Enrichment errors", str(stats["detail_errors"]))
    summary.add_row("Scored by LLM", str(stats["scored"]))
    summary.add_row("Pending scoring", str(stats["unscored"]))
    summary.add_row("Tailored resumes", str(stats["tailored"]))
    summary.add_row("Pending tailoring (7+)", str(stats["untailored_eligible"]))
    summary.add_row("Cover letters", str(stats["with_cover_letter"]))
    summary.add_row("Ready to apply", str(stats["ready_to_apply"]))
    summary.add_row("Applied", str(stats["applied"]))
    summary.add_row("Apply errors", str(stats["apply_errors"]))

    console.print(summary)

    # Score distribution
    if stats["score_distribution"]:
        dist_table = Table(title="\nScore Distribution", show_header=True, header_style="bold yellow")
        dist_table.add_column("Score", justify="center")
        dist_table.add_column("Count", justify="right")
        dist_table.add_column("Bar")

        max_count = max(count for _, count in stats["score_distribution"]) or 1
        for score, count in stats["score_distribution"]:
            bar_len = int(count / max_count * 30)
            if score >= 7:
                color = "green"
            elif score >= 5:
                color = "yellow"
            else:
                color = "red"
            bar = f"[{color}]{'=' * bar_len}[/{color}]"
            dist_table.add_row(str(score), str(count), bar)

        console.print(dist_table)

    # By site
    if stats["by_site"]:
        site_table = Table(title="\nJobs by Source", show_header=True, header_style="bold magenta")
        site_table.add_column("Site")
        site_table.add_column("Count", justify="right")

        for site, count in stats["by_site"]:
            site_table.add_row(site or "Unknown", str(count))

        console.print(site_table)

    live_workers = _render_live_workers_table()
    recent_runs = _render_recent_runs_table(limit=6)

    if live_workers or recent_runs:
        console.print("\n[bold]Apply Agent Visibility[/bold]")
        if live_workers:
            console.print(live_workers)
        if recent_runs:
            console.print()
            console.print(recent_runs)
    else:
        console.print("\n[dim]Apply telemetry is not available yet. Run `jobhunter apply` to populate it.[/dim]")

    console.print()


@app.command()
def retry(
    stage: str = typer.Argument(..., help="Stage to reset for retry."),
    url: str = typer.Argument(..., help="Job URL to reset."),
    reset_attempts: bool = typer.Option(
        False,
        "--reset-attempts",
        help="Reset the stage attempt counter as well as status/error fields.",
    ),
    run_after: bool = typer.Option(
        False,
        "--run",
        help="Run the stage after resetting. For some stages this may process other pending jobs too.",
    ),
) -> None:
    """Reset one job/stage so it can be retried."""
    _bootstrap()

    if stage not in (*VALID_STAGES, "apply"):
        console.print(
            f"[red]Unknown stage:[/red] '{stage}'. "
            f"Valid stages: {', '.join((*VALID_STAGES, 'apply'))}"
        )
        raise typer.Exit(code=1)

    from jobhunter.database import get_connection
    from jobhunter.state import reset_job_stage

    try:
        job_url = reset_job_stage(get_connection(), url, stage, reset_attempts=reset_attempts)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(code=1)

    console.print(f"[green]Reset {stage} for retry:[/green] {job_url}")
    if run_after:
        if stage == "apply":
            from jobhunter.apply.launcher import main as apply_main

            apply_main(limit=1, target_url=job_url)
        elif stage in VALID_STAGES:
            _run_stage_command(stage, limit=1)


@app.command()
def runs(
    limit: int = typer.Option(8, "--limit", "-l", help="Number of recent runs to show."),
    events: int = typer.Option(8, "--events", "-e", help="Number of events to show for one selected run."),
    failed_only: bool = typer.Option(False, "--failed-only", help="Only show failed runs."),
    run_id: Optional[str] = typer.Option(
        None,
        "--run-id",
        help="Show the timeline for a specific run id or prefix.",
    ),
) -> None:
    """Inspect recent apply runs and the event timeline for one run."""
    _bootstrap()

    console.print("\n[bold]Apply Agent Runs[/bold]\n")

    live_workers = _render_live_workers_table()
    if live_workers:
        console.print(live_workers)
        console.print()

    runs = _fetch_recent_runs(limit=max(limit, events, 20), failed_only=failed_only)
    if not runs:
        console.print("[dim]No telemetry-backed apply runs found yet.[/dim]")
        return

    recent = runs[:limit]
    table = Table(title="Recent Apply Runs", show_lines=False)
    table.add_column("Run", width=10, justify="center")
    table.add_column("Status", width=11, justify="center")
    table.add_column("Worker", width=7, justify="center")
    table.add_column("Job", min_width=24, max_width=42, no_wrap=True)
    table.add_column("When", min_width=16)
    table.add_column("Duration", width=9, justify="right")
    table.add_column("What happened", min_width=26, max_width=42, no_wrap=True)

    for run in recent:
        status = (run.get("status") or "unknown").upper()
        status_style = {
            "IN_PROGRESS": "yellow",
            "RUNNING": "yellow",
            "APPLIED": "green",
            "SUCCESS": "green",
            "FAILED": "red",
            "ERROR": "red",
            "SKIPPED": "dim",
            "CANCELLED": "magenta",
        }.get(status, "")
        table.add_row(
            run.get("run_id", "")[:8],
            Text(status, style=status_style),
            str(run.get("worker_id", "")),
            _format_run_label(run),
            run.get("started_at", ""),
            run.get("duration", ""),
            (run.get("error") or run.get("last_event") or "")[:42],
        )

    console.print(table)

    selected = None
    if run_id:
        selected = next((run for run in runs if run.get("run_id", "").startswith(run_id)), None)
    else:
        selected = next(
            (
                run
                for run in runs
                if (run.get("status") or "").upper() in {"FAILED", "ERROR", "IN_PROGRESS", "RUNNING"}
            ),
            recent[0],
        )

    if selected:
        timeline = _render_run_timeline(selected, limit=events)
        if timeline:
            console.print()
            console.print(timeline)


@app.command()
def rpc() -> None:
    """Run the JSON-RPC 2.0 server on stdin/stdout (target §6.5).

    Each line on stdin must be a single JSON-RPC request envelope; each
    response is written as a single line on stdout.  Used by the TS API to
    drive complex commands (Phase 9 onward) — Phase 3 ships a small handler
    set: ``reset_stage``, ``mark_applied``, ``mark_skipped``, ``cancel_stage``,
    ``run_stage``, ``apply``, ``profile_import``.
    """
    _bootstrap()
    from jobhunter.infrastructure.observability import shutdown_otel
    from jobhunter.infrastructure.rpc.handlers import register_default_handlers
    from jobhunter.infrastructure.rpc.server import JsonRpcServer
    from jobhunter.infrastructure.rpc.workflow_starter import (
        default_workflow_canceler,
        default_workflow_starter,
    )

    server = JsonRpcServer(workflow_starter=default_workflow_starter)
    register_default_handlers(server, canceler=default_workflow_canceler)
    try:
        server.serve()
    finally:
        # Flush queued OTel spans before stdin EOF kills the process —
        # without this the BatchSpanProcessor drops in-flight rpc.<method>
        # spans and Langfuse loses the JSON-RPC trace tail.
        shutdown_otel()


@app.command()
def worker(
    task_queue: Optional[str] = typer.Option(
        None,
        "--task-queue",
        help="Override the Temporal task queue (defaults to JOBHUNTER_TASK_QUEUE).",
    ),
) -> None:
    """Run the long-lived JobHunter Temporal worker."""
    _bootstrap()

    from jobhunter.infrastructure.temporal import (
        JOBHUNTER_TASK_QUEUE,
        build_worker,
        get_temporal_client,
    )
    from jobhunter.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS

    queue = task_queue or JOBHUNTER_TASK_QUEUE

    async def _run() -> None:
        client = await get_temporal_client()
        worker = build_worker(
            client,
            workflows=WORKFLOWS,
            activities=ACTIVITIES,
            task_queue=queue,
        )
        console.print(
            f"[bold blue]JobHunter worker[/bold blue] running on task queue "
            f"[bold]{queue}[/bold] with {len(WORKFLOWS)} workflow(s) and "
            f"{len(ACTIVITIES)} activity(ies) — Ctrl-C to stop."
        )
        await worker.run()

    from jobhunter.infrastructure.observability import shutdown_otel

    try:
        asyncio.run(_run())
    finally:
        # Flush any in-flight spans so the BatchSpanProcessor doesn't drop
        # them on Ctrl-C.
        shutdown_otel()


@app.command()
def doctor() -> None:
    """Check your setup and diagnose missing requirements."""
    import shutil
    from jobhunter.config import (
        load_env, DB_PATH, RESUME_PATH, RESUME_PDF_PATH,
        RESUME_TEMPLATE_PATH, SEARCH_CONFIG_PATH, get_chrome_path,
    )
    from jobhunter.domain.tenant import LOCAL_TENANT
    from jobhunter.infrastructure.profile import get_profile_repository

    load_env()

    ok_mark = "[green]OK[/green]"
    fail_mark = "[red]MISSING[/red]"
    warn_mark = "[yellow]WARN[/yellow]"

    results: list[tuple[str, str, str]] = []  # (check, status, note)

    # --- Tier 1 checks ---
    # Profile
    try:
        profile = get_profile_repository().load(LOCAL_TENANT)
        if profile is None:
            results.append(("candidate profile", fail_mark, "Run 'jobhunter init' to create"))
        else:
            results.append(("candidate profile", ok_mark, f"SQLite source of truth at {DB_PATH}"))
    except FileNotFoundError:
        results.append(("candidate profile", fail_mark, "Run 'jobhunter init' to create"))
    except Exception:  # noqa: BLE001 - doctor should report validation problems instead of crashing
        results.append(("candidate profile", fail_mark, "Profile exists but failed validation"))

    # Resume
    if RESUME_PATH.exists():
        results.append(("resume.txt", ok_mark, str(RESUME_PATH)))
    elif RESUME_PDF_PATH.exists():
        results.append(("resume.txt", warn_mark, "Only PDF found — plain-text needed for AI stages"))
    else:
        results.append(("resume.txt", fail_mark, "Run 'jobhunter init' to add your resume"))

    # LaTeX is mandatory for tailored resume PDFs.
    try:
        from jobhunter.infrastructure.materials.latex_pdf import _find_pdflatex

        results.append(("pdflatex", ok_mark, _find_pdflatex()))
    except FileNotFoundError:
        results.append(("pdflatex", fail_mark, "Install TeX Live/MacTeX or set PDFLATEX_PATH"))

    if RESUME_TEMPLATE_PATH.exists():
        results.append(("resume_template.tex", ok_mark, str(RESUME_TEMPLATE_PATH)))
    else:
        results.append(("resume_template.tex", warn_mark, "Use the local UI profile view to create/edit"))

    # Search config
    if SEARCH_CONFIG_PATH.exists():
        results.append(("searches.yaml", ok_mark, str(SEARCH_CONFIG_PATH)))
    else:
        results.append(("searches.yaml", warn_mark, "Will use example config — run 'jobhunter init'"))

    # jobspy (discovery dep installed separately)
    # The package is intentionally NOT in pyproject.toml so the worker venv
    # stays slim — it ships only when the user opts into LinkedIn / Indeed
    # discovery. ``importlib.import_module`` here keeps pyright from
    # flagging the conditional import as missing on machines that haven't
    # installed it yet.
    try:
        import importlib

        importlib.import_module("jobspy")
        results.append(("python-jobspy", ok_mark, "Job board scraping available"))
    except ImportError:
        results.append(("python-jobspy", warn_mark,
                        "pip install --no-deps python-jobspy && pip install pydantic tls-client requests markdownify regex"))

    # --- Tier 2 checks ---
    import os
    has_gemini = bool(os.environ.get("GEMINI_API_KEY"))
    has_openai = bool(os.environ.get("OPENAI_API_KEY"))
    has_local = bool(os.environ.get("LLM_URL"))
    if has_gemini:
        model = os.environ.get("LLM_MODEL", "gemini-2.0-flash")
        results.append(("LLM API key", ok_mark, f"Gemini ({model})"))
    elif has_openai:
        model = os.environ.get("LLM_MODEL", "gpt-4o-mini")
        results.append(("LLM API key", ok_mark, f"OpenAI ({model})"))
    elif has_local:
        results.append(("LLM API key", ok_mark, f"Local: {os.environ.get('LLM_URL')}"))
    else:
        results.append(("LLM API key", fail_mark,
                        "Set GEMINI_API_KEY in ~/.jobhunter/.env (run 'jobhunter init')"))

    # --- Tier 3 checks ---
    # Claude Code CLI
    claude_bin = shutil.which("claude")
    if claude_bin:
        results.append(("Claude Code CLI", ok_mark, claude_bin))
    else:
        results.append(("Claude Code CLI", fail_mark,
                        "Install from https://claude.ai/code (needed for auto-apply)"))

    # Chrome
    try:
        chrome_path = get_chrome_path()
        results.append(("Chrome/Chromium", ok_mark, chrome_path))
    except FileNotFoundError:
        results.append(("Chrome/Chromium", fail_mark,
                        "Install Chrome or set CHROME_PATH env var (needed for auto-apply)"))

    # Node.js / npx (for Playwright MCP)
    npx_bin = shutil.which("npx")
    if npx_bin:
        results.append(("Node.js (npx)", ok_mark, npx_bin))
    else:
        results.append(("Node.js (npx)", fail_mark,
                        "Install Node.js 18+ from nodejs.org (needed for auto-apply)"))

    # CapSolver (optional)
    capsolver = os.environ.get("CAPSOLVER_API_KEY")
    if capsolver:
        results.append(("CapSolver API key", ok_mark, "CAPTCHA solving enabled"))
    else:
        results.append(("CapSolver API key", "[dim]optional[/dim]",
                        "Set CAPSOLVER_API_KEY in .env for CAPTCHA solving"))

    # Temporal dev server (workflow engine)
    from jobhunter.infrastructure.temporal import get_temporal_client

    async def _probe_temporal() -> None:
        await asyncio.wait_for(get_temporal_client(), timeout=3.0)

    try:
        asyncio.run(_probe_temporal())
        results.append(("Temporal", ok_mark, "reachable"))
    except (Exception, asyncio.TimeoutError):  # noqa: BLE001 — any failure ⇒ unreachable
        results.append(("Temporal", fail_mark,
                        "unreachable (start with: temporal server start-dev)"))

    # Langfuse OTLP ingest (observability target)
    # Skip the network probe entirely if LANGFUSE_DISABLE is set — it's the
    # opt-out switch users flip when they don't want export running and they
    # shouldn't see a misleading "MISSING" or "unreachable" row.
    from jobhunter.infrastructure.observability import langfuse_disabled

    if langfuse_disabled():
        results.append(("Langfuse", "[dim]disabled[/dim]", "LANGFUSE_DISABLE=1"))
    else:
        lf_pub = os.environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
        lf_sec = os.environ.get("LANGFUSE_SECRET_KEY", "").strip()
        lf_url = os.environ.get("LANGFUSE_BASE_URL", "").strip().rstrip("/")
        if not (lf_pub and lf_sec and lf_url):
            results.append((
                "Langfuse",
                fail_mark,
                "MISSING (set LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL)",
            ))
        else:
            try:
                resp = httpx.head(f"{lf_url}/api/public/otel/v1/traces", timeout=2.0)
                # Any non-server-error response means the endpoint is alive.
                # 405 (Method Not Allowed on HEAD) and 401 (auth required) both
                # confirm the route exists.
                if resp.status_code < 500:
                    results.append(("Langfuse", ok_mark, "reachable"))
                else:
                    results.append((
                        "Langfuse",
                        fail_mark,
                        f"unreachable (status={resp.status_code})",
                    ))
            except Exception:  # noqa: BLE001 — any failure ⇒ unreachable
                results.append(("Langfuse", fail_mark, "unreachable"))

    # --- Render results ---
    console.print()
    console.print("[bold]JobHunter Doctor[/bold]\n")

    col_w = max(len(r[0]) for r in results) + 2
    for check, status, note in results:
        pad = " " * (col_w - len(check))
        console.print(f"  {check}{pad}{status}  [dim]{note}[/dim]")

    console.print()

    # Tier summary
    from jobhunter.config import get_tier, TIER_LABELS
    tier = get_tier()
    console.print(f"[bold]Current tier: Tier {tier} — {TIER_LABELS[tier]}[/bold]")

    if tier == 1:
        console.print("[dim]  → Tier 2 unlocks: scoring, tailoring, cover letters (needs LLM API key)[/dim]")
        console.print("[dim]  → Tier 3 unlocks: auto-apply (needs Claude Code CLI + Chrome + Node.js)[/dim]")
    elif tier == 2:
        console.print("[dim]  → Tier 3 unlocks: auto-apply (needs Claude Code CLI + Chrome + Node.js)[/dim]")

    console.print()


if __name__ == "__main__":
    app()
