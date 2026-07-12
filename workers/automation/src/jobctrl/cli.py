"""JobCtrl CLI — the main entry point."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from jobctrl import __version__
from jobctrl.pipeline import SUPPORTED_STAGE_ORDER, run_single_job
from jobctrl.workflow_specs import (
    build_apply_workflow_spec,
    build_compensation_refresh_workflow_spec,
    build_run_stage_workflow_spec,
    start_workflow_spec_and_wait_sync,
    workflow_result_to_dict,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)

app = typer.Typer(
    name="jobctrl",
    help="AI-powered end-to-end job application pipeline.",
    no_args_is_help=True,
)
capability_app = typer.Typer(help="Inspect and explicitly manage optional browser capabilities.")
app.add_typer(capability_app, name="capability")
console = Console()
log = logging.getLogger(__name__)

# Valid pipeline stages (in execution order)
VALID_STAGES = SUPPORTED_STAGE_ORDER
_TIER2_STAGE_FEATURES = {
    "discover": "AI discovery preparation",
    "score": "AI scoring",
    "tailor": "resume tailoring",
    "cover": "cover letter generation",
}


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
    from jobctrl.config import load_env, ensure_dirs
    from jobctrl.database import get_connection, init_db
    from jobctrl.infrastructure.projections.projection_builder import (
        ProjectionBuilder,
    )

    load_env()
    ensure_dirs()
    init_db()
    # Bootstrap OTel as early as possible so every span emitted by the
    # rest of this CLI invocation flows to the configured Langfuse instance.
    # init_otel() is idempotent and degrades gracefully when env vars are
    # absent, so it's safe to call from every command.
    from jobctrl.infrastructure.observability import init_otel

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
            from jobctrl.infrastructure.events import get_default_publisher

            _projection_subscription = builder.subscribe_to(get_default_publisher())
    except Exception:  # noqa: BLE001 — projection refresh failure must not break boot
        log.exception("ProjectionBuilder backfill on bootstrap failed")


def _check_tier2_stage(stage: str) -> None:
    feature = _TIER2_STAGE_FEATURES.get(stage)
    if feature is None:
        return

    from jobctrl.config import check_tier

    check_tier(2, feature)


def _check_tier2_stage_list(stage_list: list[str]) -> None:
    if "all" in stage_list or "discover" in stage_list:
        _check_tier2_stage("discover")
        return

    if any(s in stage_list for s in ("score", "tailor", "cover")):
        from jobctrl.config import check_tier

        check_tier(2, "AI scoring/tailoring")


def _version_callback(value: bool) -> None:
    if value:
        console.print(f"[bold]jobctrl[/bold] {__version__}")
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


def _parse_tailor_models(value: str) -> tuple[str, ...]:
    """Parse comma-separated LLM model specs for tailoring candidates."""
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _repo_root() -> Path:
    """Find the repository root from the installed source tree."""

    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "package.json").exists() and (parent / "workers" / "automation" / "pyproject.toml").exists():
            return parent
    return current.parents[4]


def _shell_join(cmd: list[str]) -> str:
    import shlex

    return shlex.join(cmd)


def _run_setup_step(cmd: list[str], *, dry_run: bool, cwd: Path | None = None, quiet: bool = False) -> int:
    import subprocess

    if not quiet:
        console.print(f"[dim]+ {_shell_join(cmd)}[/dim]")
    if dry_run:
        return 0
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=False).returncode


def _env_file_updates(path: Path, updates: dict[str, str]) -> str:
    """Return .env contents with ``updates`` replaced/appended, preserving comments."""

    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else ["# JobCtrl configuration"]
    seen: set[str] = set()
    rendered: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            rendered.append(line)
            continue
        key, _sep, _value = line.partition("=")
        key = key.strip()
        if key in updates:
            rendered.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            rendered.append(line)
    for key, value in updates.items():
        if key not in seen:
            rendered.append(f"{key}={value}")
    return "\n".join(rendered).rstrip() + "\n"


def _write_env_updates(path: Path, updates: dict[str, str], *, dry_run: bool, quiet: bool = False) -> None:
    if not updates:
        return
    if dry_run:
        if not quiet:
            console.print(f"[yellow]Would update {path}:[/yellow] {', '.join(sorted(updates))}")
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(_env_file_updates(path, updates), encoding="utf-8")
    path.chmod(0o600)
    for key, value in updates.items():
        import os

        os.environ[key] = value
    if not quiet:
        console.print(f"[green]Updated setup configuration:[/green] {path}")


def _confirm_setup_action(prompt: str, *, yes: bool, non_interactive: bool, default: bool = False) -> bool:
    if yes:
        return True
    if non_interactive:
        return default
    return typer.confirm(prompt, default=default)


def _tool_available(name: str) -> tuple[bool, str]:
    import shutil

    found = shutil.which(name)
    return (True, found) if found else (False, "not found")


def _node_status() -> tuple[bool, str]:
    import shutil
    import subprocess

    if shutil.which("node") is None:
        return False, "not found"
    try:
        version = subprocess.check_output(["node", "-p", "process.versions.node"], text=True, timeout=3).strip()
    except Exception as exc:  # noqa: BLE001 - setup diagnostic
        return False, f"version check failed: {exc}"
    parts = tuple(int(p) for p in version.split(".")[:3])
    return parts >= (20, 19, 0), version


def _setup_toolchain_rows() -> list[tuple[str, bool, str]]:
    from jobctrl.infrastructure.preflight import check_playwright_chromium

    rows: list[tuple[str, bool, str]] = []
    node_ok, node_note = _node_status()
    rows.append(("Node.js 20.19+", node_ok, node_note))
    for command, label in (
        ("corepack", "Corepack"),
        ("uv", "uv"),
        ("temporal", "Temporal CLI"),
    ):
        ok, note = _tool_available(command)
        rows.append((label, ok, note))
    chromium_ok, chromium_note = check_playwright_chromium()
    rows.append(("Managed Playwright Chromium", chromium_ok, chromium_note))
    return rows


def _run_workflow_spec_from_cli(spec, *, label: str) -> dict[str, Any]:
    workflow_name = getattr(spec.workflow, "__name__", str(spec.workflow))
    console.print(f"[cyan]Starting {workflow_name} via Temporal:[/cyan] {label}")
    try:
        started = start_workflow_spec_and_wait_sync(spec)
    except Exception as exc:  # noqa: BLE001 - CLI surfaces runtime reachability plainly
        console.print(
            "[red]Temporal workflow runtime is unavailable.[/red]\n"
            f"{exc}\n"
            "Run [bold]jobctrl doctor[/bold] and start the Temporal server + worker "
            "before retrying."
        )
        raise typer.Exit(code=1) from exc

    result = workflow_result_to_dict(started.result)
    console.print(
        f"[green]Workflow completed:[/green] {started.workflow_id} "
        f"(run {started.first_execution_run_id or started.run_id})"
    )
    if _workflow_result_failed(result):
        error_code = _workflow_error_code(result)
        if error_code:
            console.print(f"[red]Workflow failed:[/red] {error_code}")
        else:
            console.print("[red]Workflow failed.[/red]")
        raise typer.Exit(code=1)
    return result if isinstance(result, dict) else {"result": result}


def _workflow_result_failed(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("ok") is False:
        return True
    status = str(result.get("status") or "").lower()
    if status in {"failed", "failure", "canceled", "cancelled", "timed_out", "terminated"}:
        return True
    return bool(result.get("failure") or result.get("error"))


def _workflow_error_code(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    value = result.get("error_code") or result.get("errorCode")
    return str(value) if value else None


def _load_telemetry_module():
    """Load the apply telemetry module if it exists."""
    try:
        from jobctrl.apply import telemetry as telemetry_mod
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
        from jobctrl.apply.dashboard import get_worker_states
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
    tailor_models: tuple[str, ...] = (),
    tailor_judge_model: str | None = None,
    tailor_judge_min_score: float | None = None,
) -> None:
    """Run a single pipeline stage through the shared orchestrator."""
    _bootstrap()

    _check_tier2_stage(stage)

    validation = _validate_validation_mode(validation)

    _run_workflow_spec_from_cli(
        build_run_stage_workflow_spec(
            {
                "tenantId": "local",
                "stage": stage,
                "minScore": min_score,
                "dryRun": dry_run,
                "workers": workers,
                "validationMode": validation,
                "limit": limit,
                "rescore": rescore,
                "retailor": retailor,
                "tailorModels": tailor_models,
                "tailorJudgeModel": tailor_judge_model,
                "tailorJudgeMinScore": tailor_judge_min_score,
            }
        ),
        label=stage,
    )


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
    """JobCtrl — AI-powered end-to-end job application pipeline."""


@capability_app.command("list")
def capability_list() -> None:
    """Show managed core and optional authenticated-browser readiness."""

    from jobctrl.browser_capabilities import list_browser_capabilities

    table = Table(title="JobCtrl browser capabilities")
    table.add_column("Capability")
    table.add_column("Status")
    table.add_column("Details")
    marks = {
        "ready": "[green]READY[/green]",
        "disabled": "[dim]DISABLED[/dim]",
        "missing": "[yellow]MISSING[/yellow]",
        "failed": "[red]FAILED[/red]",
        "unavailable": "[red]UNAVAILABLE[/red]",
    }
    for capability in list_browser_capabilities():
        detail = capability.detail
        if capability.executable is not None:
            detail = f"{detail} {capability.executable}"
        table.add_row(capability.id, marks[capability.status], detail)
    console.print(table)


@capability_app.command("enable")
def capability_enable(
    name: str = typer.Argument(..., help="Capability to enable."),
    browser_path: Path | None = typer.Option(
        None,
        "--browser-path",
        help="Explicit Chrome or Chromium executable to adopt.",
    ),
    managed_pack: bool = typer.Option(
        False,
        "--managed-pack",
        help="Request a managed browser pack (currently unavailable; nothing is downloaded).",
    ),
    copy_profile_from: Path | None = typer.Option(
        None,
        "--copy-profile-from",
        help="Existing profile to copy into JobCtrl-owned LinkedIn resolver storage.",
    ),
    consent_copy_profile: bool = typer.Option(
        False,
        "--consent-copy-profile",
        help="Affirm separately that JobCtrl may copy the supplied browser profile.",
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Accept safe non-profile prompts."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Do not prompt."),
) -> None:
    """Enable an optional browser only after choosing its executable explicitly."""

    from jobctrl.browser_capabilities import (
        BrowserCapabilityError,
        BrowserCapabilityUnavailableError,
        copy_authenticated_linkedin_profile,
        enable_system_browser_capability,
        managed_optional_browser_pack_unavailable,
    )

    if copy_profile_from is not None and name != "authenticated-linkedin-browser":
        console.print("[red]Profile copying is only available for authenticated-linkedin-browser.[/red]")
        raise typer.Exit(code=2)
    if consent_copy_profile and copy_profile_from is None:
        console.print("[red]--consent-copy-profile requires --copy-profile-from.[/red]")
        raise typer.Exit(code=2)
    if managed_pack and browser_path is not None:
        console.print("[red]Choose either --managed-pack or --browser-path, not both.[/red]")
        raise typer.Exit(code=2)
    if managed_pack:
        try:
            managed_optional_browser_pack_unavailable(name)
        except BrowserCapabilityUnavailableError as exc:
            console.print(f"[yellow]{exc}[/yellow]")
            raise typer.Exit(code=2) from exc

    if browser_path is None:
        if non_interactive or yes:
            console.print(
                "[red]Enabling a browser capability requires --browser-path with an explicit Chrome/Chromium executable.[/red]"
            )
            raise typer.Exit(code=2)
        source = typer.prompt("Browser source (system or managed-pack)", default="system").strip().lower()
        if source == "managed-pack":
            try:
                managed_optional_browser_pack_unavailable(name)
            except BrowserCapabilityUnavailableError as exc:
                console.print(f"[yellow]{exc}[/yellow]")
                raise typer.Exit(code=2) from exc
        if source != "system":
            console.print("[red]Choose system or managed-pack.[/red]")
            raise typer.Exit(code=2)
        browser_path = Path(typer.prompt("Chrome/Chromium executable path")).expanduser()

    if copy_profile_from is not None and not consent_copy_profile:
        # ``--yes`` is deliberately not accepted as profile-copy consent.
        if yes or non_interactive:
            console.print(
                "[red]Copying an existing browser profile requires --consent-copy-profile; --yes cannot grant this consent.[/red]"
            )
            raise typer.Exit(code=2)
        consent_copy_profile = typer.confirm(
            "Copy this existing browser profile into JobCtrl-owned storage?",
            default=False,
        )
        if not consent_copy_profile:
            console.print("[yellow]Browser capability was not enabled because profile-copy consent was not granted.[/yellow]")
            raise typer.Exit(code=2)

    try:
        status = enable_system_browser_capability(name, browser_path)
        if copy_profile_from is not None:
            destination = copy_authenticated_linkedin_profile(
                copy_profile_from,
                consent=consent_copy_profile,
            )
            console.print(f"[green]{name} ready.[/green] Profile copied to JobCtrl-owned storage: {destination}")
        else:
            level = "green" if status.status == "ready" else "yellow"
            console.print(f"[{level}]{name} {status.status}.[/{level}] {status.detail}")
            if name == "authenticated-linkedin-browser":
                console.print(
                    "[yellow]A separate consented profile copy is still required before authenticated LinkedIn resolution can run.[/yellow]"
                )
    except BrowserCapabilityError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=2) from exc


@capability_app.command("disable")
def capability_disable(name: str = typer.Argument(..., help="Optional capability to disable.")) -> None:
    """Disable an optional authenticated-browser capability immediately."""

    from jobctrl.browser_capabilities import BrowserCapabilityError, disable_browser_capability

    try:
        status = disable_browser_capability(name)
    except BrowserCapabilityError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=2) from exc
    console.print(f"[green]{name} {status.status}.[/green] {status.detail}")


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
    model: str = typer.Option("default", "--model", "-m", help="Apply action model. 'default' uses the local Claude Code default."),
    tailor_models: str = typer.Option("", "--tailor-models", help="Comma-separated LLM specs for tailor candidate generation."),
    tailor_judge_model: str = typer.Option("", "--tailor-judge-model", help="Optional LLM spec for the structured tailoring judge."),
    tailor_judge_min_score: float | None = typer.Option(
        None,
        "--tailor-judge-min-score",
        min=0.0,
        max=1.0,
        help="Minimum structured judge score required for tailor approval.",
    ),
    headless: bool = typer.Option(False, "--headless", help="Run apply browser action headless."),
) -> None:
    """Run a structured local action and print its JSON result."""
    from jobctrl.actions import LocalActionRequest, run_local_action

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
                tailor_models=_parse_tailor_models(tailor_models),
                tailor_judge_model=tailor_judge_model.strip() or None,
                tailor_judge_min_score=tailor_judge_min_score,
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
    from jobctrl.wizard.init import run_wizard

    run_wizard()


@app.command()
def setup(
    yes: bool = typer.Option(False, "--yes", "-y", help="Accept safe defaults for prompts."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Do not prompt; use env/config only."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print setup actions without changing files."),
    skip_system: bool = typer.Option(False, "--skip-system", help="Skip local toolchain checks."),
    skip_dependencies: bool = typer.Option(False, "--skip-dependencies", help="Skip pnpm/uv dependency sync."),
    skip_browsers: bool = typer.Option(False, "--skip-browsers", help="Skip Playwright Chromium installs."),
    skip_doctor: bool = typer.Option(False, "--skip-doctor", help="Skip the final doctor run."),
    json_output: bool = typer.Option(False, "--json", help="Print a machine-readable summary."),
    launch_logins: bool = typer.Option(
        False,
        "--launch-logins",
        help="Launch vendor login/enrollment commands when setup can do so safely.",
    ),
) -> None:
    """Install/check local dependencies and configure vendor analysis auth."""

    import os
    import subprocess
    import sys

    from jobctrl.config import ensure_dirs, get_env_path, load_env
    from jobctrl.infrastructure.setup_probes import (
        ANALYSIS_LEGS_ENV,
        CODEX_NEUTRALIZED_AUTH_ENV,
        antigravity_auth_kwargs,
        codex_auth_path,
        enabled_analysis_legs,
        ensure_jobctrl_codex_auth,
        jobctrl_codex_home,
        prepare_jobctrl_codex_home,
        probe_analysis_setup,
        probe_antigravity_auth,
        probe_claude_auth,
        probe_codex_auth,
        resolve_codex_binary,
    )
    from jobctrl.runtime import is_bundled_runtime, payload_dir

    ensure_dirs()
    load_env()
    bundled = is_bundled_runtime()
    root = None if bundled else _repo_root()
    summary: dict[str, Any] = {
        "runtimeMode": "bundled" if bundled else "source",
        "toolchain": [],
        "commands": [],
        "analysis": [],
        "envUpdates": [],
    }

    if not json_output:
        console.print("[bold]JobCtrl Setup[/bold]")

    if not skip_system:
        rows = (
            [("Bundled payload", True, str(payload_dir()))]
            if bundled
            else _setup_toolchain_rows()
        )
        summary["toolchain"] = [
            {"name": name, "ok": ok, "note": note} for name, ok, note in rows
        ]
        if not json_output:
            console.print("\n[bold]Toolchain[/bold]")
            for name, ok, note in rows:
                status = "[green]OK[/green]" if ok else "[yellow]WARN[/yellow]"
                console.print(f"  {name:<22} {status}  [dim]{note}[/dim]")

    commands: list[list[str]] = []
    if not bundled and not skip_dependencies:
        commands.extend([
            ["corepack", "pnpm", "install", "--frozen-lockfile"],
            ["uv", "--project", "workers/automation", "sync", "--extra", "dev"],
        ])
    if not bundled and not skip_browsers:
        commands.extend([
            ["corepack", "pnpm", "--filter", "@jobctrl/web", "exec", "playwright", "install", "chromium"],
            ["uv", "--project", "workers/automation", "run", "playwright", "install", "chromium"],
        ])

    if commands:
        if not json_output:
            console.print("\n[bold]Repository Dependencies[/bold]")
        for command in commands:
            summary["commands"].append(command)
            rc = _run_setup_step(command, dry_run=dry_run, cwd=root, quiet=json_output)
            if rc != 0:
                console.print(f"[red]Setup command failed:[/red] {_shell_join(command)}")
                raise typer.Exit(code=rc)

    env_updates: dict[str, str] = {}
    try:
        configured_legs = list(enabled_analysis_legs())
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=2) from exc
    authenticated_legs: list[str] = []

    if "codex" in configured_legs and not dry_run and not codex_auth_path().exists():
        try:
            ensure_jobctrl_codex_auth()
        except RuntimeError:
            pass

    if not json_output:
        console.print("\n[bold]Analysis Vendor Auth[/bold]")
    for probe in probe_analysis_setup():
        summary["analysis"].append({
            "name": probe.name,
            "ok": probe.ok,
            "note": probe.note,
        })
        if not json_output:
            status = "[green]OK[/green]" if probe.ok else "[yellow]WARN[/yellow]"
            console.print(f"  {probe.name:<28} {status}  [dim]{probe.note}[/dim]")

    if "claude" in configured_legs:
        claude_probe = probe_claude_auth()
        if claude_probe.ok:
            authenticated_legs.append("claude")
        elif _confirm_setup_action(
            "Paste ANTHROPIC_API_KEY for the Claude analysis leg?",
            yes=False,
            non_interactive=non_interactive or yes,
            default=False,
        ):
            key = typer.prompt("ANTHROPIC_API_KEY", hide_input=True)
            if key.strip():
                env_updates["ANTHROPIC_API_KEY"] = key.strip()
                authenticated_legs.append("claude")
        elif _confirm_setup_action("Skip the Claude analysis leg for now?", yes=yes, non_interactive=non_interactive, default=True):
            pass
        else:
            authenticated_legs.append("claude")

    if "codex" in configured_legs:
        codex_probe = probe_codex_auth()
        if codex_probe.ok:
            authenticated_legs.append("codex")
        else:
            key = os.environ.get("OPENAI_API_KEY") or os.environ.get("CODEX_API_KEY")
            command: list[str] | None = None
            stdin: str | None = None
            if key and launch_logins and _confirm_setup_action(
                "Enroll the current OpenAI key into JobCtrl's Codex CLI home now?",
                yes=yes,
                non_interactive=non_interactive,
                default=False,
            ):
                command = [str(resolve_codex_binary()), "login", "--with-api-key"]
                stdin = key + "\n"
            elif launch_logins and _confirm_setup_action(
                "Authenticate JobCtrl's Codex CLI with your ChatGPT subscription now?",
                yes=yes,
                non_interactive=non_interactive,
                default=False,
            ):
                command = [str(resolve_codex_binary()), "login"]
            if command is not None:
                summary["commands"].append(command)
                if not json_output:
                    console.print(f"[dim]+ {_shell_join(command)}[/dim]")
                if dry_run:
                    authenticated_legs.append("codex")
                else:
                    try:
                        prepare_jobctrl_codex_home()
                    except RuntimeError as exc:
                        console.print(f"[red]Unsafe JobCtrl Codex home:[/red] {exc}")
                        raise typer.Exit(code=1) from exc
                    login_env = dict(os.environ)
                    login_env["CODEX_HOME"] = str(jobctrl_codex_home())
                    for auth_key in CODEX_NEUTRALIZED_AUTH_ENV:
                        login_env.pop(auth_key, None)
                    proc = subprocess.run(
                        command,
                        input=stdin,
                        text=True,
                        check=False,
                        cwd=str(root) if root else None,
                        env=login_env,
                    )
                    if proc.returncode == 0 and probe_codex_auth(login_env).ok:
                        authenticated_legs.append("codex")
            elif not json_output:
                console.print(
                    "  [dim]Codex enrollment: run `CODEX_HOME=<JobCtrl Codex home> codex login` "
                    "or pipe OPENAI_API_KEY to `codex login --with-api-key`, then rerun setup.[/dim]"
                )
            if "codex" not in authenticated_legs and _confirm_setup_action(
                "Skip the Codex analysis leg for now?",
                yes=yes,
                non_interactive=non_interactive,
                default=True,
            ):
                pass
            elif "codex" not in authenticated_legs:
                authenticated_legs.append("codex")

    if "antigravity" in configured_legs:
        antigravity_probe = probe_antigravity_auth()
        if antigravity_probe.ok:
            authenticated_legs.append("antigravity")
        elif _confirm_setup_action(
            "Paste GEMINI_API_KEY for the Antigravity analysis leg?",
            yes=False,
            non_interactive=non_interactive or yes,
            default=False,
        ):
            key = typer.prompt("GEMINI_API_KEY", hide_input=True)
            if key.strip():
                env_updates["GEMINI_API_KEY"] = key.strip()
                authenticated_legs.append("antigravity")
        elif _confirm_setup_action("Skip the Antigravity analysis leg for now?", yes=yes, non_interactive=non_interactive, default=True):
            pass
        else:
            authenticated_legs.append("antigravity")

    # Validate an ADC-only Antigravity setup before persisting the leg. API-key
    # paths were already handled by the probe; this catches malformed Vertex env.
    if "antigravity" in authenticated_legs and not (
        os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or env_updates.get("GEMINI_API_KEY")
    ):
        try:
            antigravity_auth_kwargs({**os.environ, **env_updates})
        except RuntimeError:
            authenticated_legs.remove("antigravity")

    if authenticated_legs:
        env_updates[ANALYSIS_LEGS_ENV] = ",".join(authenticated_legs)
    elif configured_legs:
        if not json_output:
            console.print("[yellow]No analysis leg is authenticated; leaving existing leg configuration unchanged.[/yellow]")
    _write_env_updates(get_env_path(), env_updates, dry_run=dry_run, quiet=json_output)
    summary["envUpdates"] = sorted(env_updates)

    post_update_probes = probe_analysis_setup({**os.environ, **env_updates})
    core_probe = next(probe for probe in post_update_probes if probe.name == "core LLM provider")
    summary["analysisReady"] = core_probe.ok
    if not core_probe.ok:
        summary["analysisNotReadyReason"] = core_probe.note
        if not json_output:
            console.print(
                f"[red]Core AI stages are NOT ready:[/red] {core_probe.note}"
            )
    elif not json_output:
        console.print("[green]Core AI provider ready.[/green]")

    if not skip_doctor:
        if not json_output:
            console.print("\n[bold]Doctor[/bold]")
        doctor_command = (
            [sys.executable, "-I", "-B", "-m", "jobctrl", "doctor"]
            if bundled
            else ["uv", "--project", "workers/automation", "run", "jobctrl", "doctor"]
        )
        rc = _run_setup_step(
            doctor_command,
            dry_run=dry_run,
            cwd=root,
            quiet=json_output,
        )
        if rc != 0:
            raise typer.Exit(code=rc)

    if json_output:
        console.print_json(data=summary)


@app.command("provider-pack-install", hidden=True)
def provider_pack_install(
    pack: str = typer.Option(..., "--pack", help="Provider-pack id selected from the signed lock."),
) -> None:
    """Internal launcher hook for installing a hash-pinned provider pack."""

    from jobctrl.config import APP_DIR
    from jobctrl.provider_packs import (
        ProviderPackError,
        install_provider_pack,
        load_provider_pack_spec,
    )
    from jobctrl.runtime import is_bundled_runtime, payload_path

    if not is_bundled_runtime():
        console.print("[red]Provider packs are managed only by the installed JobCtrl launcher.[/red]")
        raise typer.Exit(code=2)
    try:
        # The lock is part of the signed, manifest-covered payload. Never accept
        # a caller-selected lock whose hashes merely authenticate attacker-chosen
        # wheels.
        lock = payload_path("release/provider-packs.lock.json", require_exists=True)
        installed = install_provider_pack(
            load_provider_pack_spec(lock, pack_id=pack),
            app_dir=APP_DIR,
        )
    except ProviderPackError as exc:
        console.print(f"[red]Provider pack installation failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    console.print_json(data={"installed": True, "path": str(installed)})


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
        help="Parallel threads for discovery/detail enrichment, scoring, and tailoring stages.",
    ),
    stream: bool = typer.Option(False, "--stream", help="Run stages concurrently (streaming mode)."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview stages without executing."),
    limit: int = typer.Option(0, "--limit", help="Maximum records to process per stage. 0 means no explicit cap."),
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
    tailor_models: str = typer.Option(
        "",
        "--tailor-models",
        help=(
            "Comma-separated LLM specs for tailor candidate generation "
            "(examples: default, codex:gpt-5.5, claude:claude-opus-4-8, google:gemini-3.5-flash)."
        ),
    ),
    tailor_judge_model: str = typer.Option(
        "",
        "--tailor-judge-model",
        help="Optional LLM spec for the structured tailoring judge.",
    ),
    tailor_judge_min_score: float | None = typer.Option(
        None,
        "--tailor-judge-min-score",
        min=0.0,
        max=1.0,
        help="Minimum structured judge score required to approve a tailored resume.",
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

    # Discovery now drains scoring/tailoring preparation work, so explicit
    # discover uses the same Tier 2 preflight as the maintenance AI stages.
    _check_tier2_stage_list(stage_list)

    # Validate the --validation flag value
    validation = _validate_validation_mode(validation)

    if stream and retailor and ("all" in stage_list or "tailor" in stage_list):
        console.print(
            "[red]--retailor cannot be combined with --stream.[/red]\n"
            "Use a normal sequential run so the tailor stage can finish cleanly."
        )
        raise typer.Exit(code=1)

    if stream:
        console.print("[dim]Temporal owns workflow scheduling; --stream no longer selects an in-process runner.[/dim]")

    _run_workflow_spec_from_cli(
        build_run_stage_workflow_spec(
            {
                "tenantId": "local",
                "stages": stage_list,
                "minScore": min_score,
                "dryRun": dry_run,
                "workers": workers,
                "validationMode": validation,
                "limit": limit,
                "retailor": retailor,
                "tailorModels": _parse_tailor_models(tailor_models),
                "tailorJudgeModel": tailor_judge_model.strip() or None,
                "tailorJudgeMinScore": tailor_judge_min_score,
            }
        ),
        label=" -> ".join(stage_list),
    )


@app.command()
def discover(
    workers: int = typer.Option(1, "--workers", "-w", help="Parallel threads for discovery backends and detail enrichment."),
    limit: int = typer.Option(0, "--limit", help="Maximum jobs to discover. 0 means all eligible jobs."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run only the discovery stage."""
    _run_stage_command("discover", workers=workers, limit=limit, dry_run=dry_run)


@app.command()
def enrich(
    workers: int = typer.Option(1, "--workers", "-w", help="Parallel threads for detail enrichment."),
    limit: int = typer.Option(0, "--limit", help="Maximum jobs to enrich. 0 means all eligible jobs."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview the stage without executing."),
) -> None:
    """Run the detail-enrichment queue directly for diagnostics."""
    _run_stage_command("enrich", workers=workers, limit=limit, dry_run=dry_run)


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
    tailor_models: str = typer.Option(
        "",
        "--tailor-models",
        help="Comma-separated LLM specs for tailor candidate generation.",
    ),
    tailor_judge_model: str = typer.Option(
        "",
        "--tailor-judge-model",
        help="Optional LLM spec for the structured tailoring judge.",
    ),
    tailor_judge_min_score: float | None = typer.Option(
        None,
        "--tailor-judge-min-score",
        min=0.0,
        max=1.0,
        help="Minimum structured judge score required to approve a tailored resume.",
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
        tailor_models=_parse_tailor_models(tailor_models),
        tailor_judge_model=tailor_judge_model.strip() or None,
        tailor_judge_min_score=tailor_judge_min_score,
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


@app.command("compensation-refresh")
def compensation_refresh(
    observations_json: Optional[Path] = typer.Option(
        None,
        "--observations-json",
        help="JSON file of Levels.fyi, Glassdoor, or manual reported compensation observations.",
        exists=True,
        file_okay=True,
        dir_okay=False,
        readable=True,
    ),
    url: Optional[str] = typer.Option(None, "--url", help="Refresh one existing job URL instead of every job."),
    limit: int = typer.Option(0, "--limit", help="Maximum jobs to refresh. 0 means all matching jobs."),
    tenant_id: str = typer.Option("local", "--tenant-id", help="Tenant id for local canonical compensation rows."),
    include_eurotoptech: Optional[bool] = typer.Option(
        None,
        "--include-eurotoptech/--no-eurotoptech",
        help="Include public Euro Top Tech data. Defaults to on when --observations-json is omitted.",
    ),
    eurotoptech_max_pages: int = typer.Option(
        10,
        "--eurotoptech-max-pages",
        min=1,
        help="Maximum Euro Top Tech data-entry pages to load when Euro Top Tech is included.",
    ),
) -> None:
    """Refresh posted salary facts and reported company-role estimates for existing jobs."""

    _bootstrap()

    result = _run_workflow_spec_from_cli(
        build_compensation_refresh_workflow_spec(
            {
                "tenantId": tenant_id,
                "jobUrl": url,
                "allJobs": url is None,
                "limit": limit,
                "observationsJsonPath": str(observations_json) if observations_json else None,
                "includeEuroTopTech": include_eurotoptech if include_eurotoptech is not None else True,
                "euroTopTechMaxPages": eurotoptech_max_pages,
            }
        ),
        label="compensation refresh",
    )
    console.print_json(data=result)


@app.command()
def apply(
    limit: Optional[int] = typer.Option(None, "--limit", "-l", help="Max applications to submit (default: all ready jobs)."),
    workers: int = typer.Option(1, "--workers", "-w", help="Number of parallel browser workers."),
    min_score: int = typer.Option(7, "--min-score", help="Minimum fit score for job selection."),
    model: str = typer.Option("default", "--model", "-m", help="Claude model name. 'default' uses the local Claude Code default."),
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

    from jobctrl.config import APP_DIR as _app_dir, check_tier
    from jobctrl.database import count_ready_to_apply, get_connection
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.profile import get_profile_repository

    # --- Utility modes (no Chrome/Claude needed) ---

    if mark_applied:
        from jobctrl.apply.launcher import mark_job
        mark_job(mark_applied, "applied")
        console.print(f"[green]Marked as applied:[/green] {mark_applied}")
        return

    if mark_failed:
        from jobctrl.apply.launcher import mark_job
        mark_job(mark_failed, "failed", reason=fail_reason)
        console.print(f"[yellow]Marked as failed:[/yellow] {mark_failed} ({fail_reason or 'manual'})")
        return

    if reset_failed:
        from jobctrl.apply.launcher import reset_failed as do_reset
        count = do_reset()
        console.print(f"[green]Reset {count} failed job(s) for retry.[/green]")
        return

    # --- Full apply mode ---

    # Check 1: Tier 3 required (Claude apply runtime + explicitly enabled browser capability)
    check_tier(3, "auto-apply")

    # Check 2: Profile exists
    try:
        profile = get_profile_repository().load(LOCAL_TENANT)
    except FileNotFoundError:
        profile = None
    if profile is None:
        console.print(
            "[red]Profile not found.[/red]\n"
            "Run [bold]jobctrl init[/bold] to create your profile first."
        )
        raise typer.Exit(code=1)

    # Check 3: Tailored resumes exist (skip for --gen with --url)
    # ``ready`` is the count of jobs eligible for apply; default to 0 so the
    # downstream ``effective_limit = ready`` reference is unambiguous to
    # static analysers when the gen+url shortcut early-returns.
    ready: int = 0
    if not (gen and url):
        conn = get_connection()
        ready = count_ready_to_apply(conn, min_score=min_score, target_url=url)
        if ready == 0:
            console.print(
                "[red]No jobs ready to apply.[/red]\n"
                "Jobs need a tailored resume and a posting or direct application URL.\n"
                "Run [bold]jobctrl run enrich score tailor[/bold] to prepare applications."
            )
            raise typer.Exit(code=1)

    if gen:
        from jobctrl.apply.launcher import gen_prompt
        from jobctrl.config import get_apply_max_budget_usd
        from jobctrl.infrastructure.apply.claude_code_cli import (
            _ALLOWED_TOOLS,
            _DISALLOWED_TOOLS,
        )
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
        model_args = "" if model in {"", "default"} else f"--model {model} "
        console.print(
            f"  claude {model_args}-p "
            f"--mcp-config {mcp_path} "
            f"--max-budget-usd {get_apply_max_budget_usd():.2f} "
            f"--allowedTools {_ALLOWED_TOOLS} "
            f"--disallowedTools {_DISALLOWED_TOOLS} < {prompt_file}"
        )
        return

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

    _run_workflow_spec_from_cli(
        build_apply_workflow_spec(
            {
                "tenantId": "local",
                "jobUrl": url,
                "limit": effective_limit,
                "minScore": min_score,
                "headless": headless,
                "model": model,
                "dryRun": dry_run,
                "continuous": continuous,
                "workers": workers,
            }
        ),
        label="apply",
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
    model: str = typer.Option("default", "--model", "-m", help="Claude model name for auto-apply. 'default' uses the local Claude Code default."),
    headless: bool = typer.Option(False, "--headless", help="Run browser in headless mode."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview without executing."),
) -> None:
    """Run tailoring and/or application for a specific job URL.

    By default, runs both tailoring and apply. Use --tailor or --apply to
    run only one step. Both flags can be combined explicitly.

    Examples:
        jobctrl job https://example.com/job/123              # tailor + apply
        jobctrl job https://example.com/job/123 --tailor     # tailor only
        jobctrl job https://example.com/job/123 --apply      # apply only
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
        from jobctrl.config import check_tier
        check_tier(2, "resume tailoring")
    if do_apply:
        from jobctrl.config import check_tier
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
def digest(
    acknowledge: bool = typer.Option(
        False,
        "--acknowledge",
        help="Mark the generated digest as reviewed after printing it.",
    ),
    json_output: bool = typer.Option(False, "--json", help="Print machine-readable JSON."),
    min_fit_score: Optional[int] = typer.Option(
        None,
        "--min-fit-score",
        min=1,
        max=10,
        help="Override the high-fit score threshold for this digest.",
    ),
) -> None:
    """Show the local daily digest."""
    _bootstrap()

    from jobctrl.database import get_connection
    from jobctrl.digest import acknowledge_digest, build_digest
    from jobctrl.infrastructure.scoring.criteria_provider import read_min_fit_score

    threshold = min_fit_score if min_fit_score is not None else read_min_fit_score()
    conn = get_connection()
    digest_payload = build_digest(conn, min_fit_score=threshold)
    acknowledge_payload = None
    if acknowledge:
        acknowledge_payload = acknowledge_digest(
            conn,
            acknowledged_at=str(digest_payload["generatedAt"]),
        )

    if json_output:
        payload = (
            {"digest": digest_payload, "acknowledge": acknowledge_payload}
            if acknowledge_payload
            else digest_payload
        )
        console.print_json(data=payload)
        return

    since = digest_payload.get("since") or "first run"
    console.print("\n[bold]Daily digest[/bold]")
    console.print(
        "[dim]"
        f"Since {since} · generated {digest_payload.get('generatedAt')} · "
        f"high-fit {digest_payload.get('highFitThreshold')}+"
        "[/dim]\n"
    )
    console.print(_render_digest_table(digest_payload))
    links_table = _render_digest_links_table(digest_payload)
    if links_table:
        console.print()
        console.print(links_table)
    if acknowledge_payload:
        state = acknowledge_payload.get("state", {})
        console.print(f"\n[green]Marked reviewed:[/green] {state.get('lastAcknowledgedAt')}")
    else:
        console.print("\n[dim]Run with --acknowledge after reviewing to move the digest watermark.[/dim]")


def _render_digest_table(digest_payload: dict[str, Any]) -> Table:
    new_matches = _dict(digest_payload.get("newMatches"))
    blocked_sources = _dict(digest_payload.get("blockedSources"))
    follow_ups = _dict(digest_payload.get("followUpsDue"))
    budget = _dict(digest_payload.get("budget"))
    table = Table(title="Review Queue", show_lines=False)
    table.add_column("Area", style="bold")
    table.add_column("Count", justify="right")
    table.add_column("Notes")
    table.add_row(
        "New matches",
        str(new_matches.get("count", 0)),
        f"{new_matches.get('highFitCount', 0)} at high-fit threshold",
    )
    table.add_row(
        "Blocked sources",
        str(blocked_sources.get("count", 0)),
        _blocked_source_note(blocked_sources),
    )
    table.add_row(
        "Materials review",
        str(_dict(digest_payload.get("reviewNeededMaterials")).get("count", 0)),
        "Candidates needing resume or cover-letter review",
    )
    table.add_row(
        "Pending approvals",
        str(_dict(digest_payload.get("pendingApprovals")).get("count", 0)),
        "Apply-review decisions waiting on the user",
    )
    table.add_row(
        "Stale scores",
        str(_dict(digest_payload.get("staleScores")).get("count", 0)),
        "Jobs needing current-policy score refresh",
    )
    table.add_row(
        "Follow-ups due",
        str(follow_ups.get("count", 0)),
        f"{follow_ups.get('thresholdDays', 7)} days, {follow_ups.get('dayBoundary', 'UTC')} boundary",
    )
    table.add_row("Budget", _budget_status_label(budget), _budget_note(budget))
    return table


def _render_digest_links_table(digest_payload: dict[str, Any]) -> Table | None:
    links = _dict(digest_payload.get("deepLinks"))
    if not links:
        return None
    table = Table(title="Open In Web App", show_lines=False)
    table.add_column("Area", style="bold")
    table.add_column("Path")
    labels = {
        "newMatches": "New matches",
        "blockedSources": "Blocked sources",
        "reviewNeededMaterials": "Materials review",
        "staleScores": "Stale scores",
        "pendingApprovals": "Pending approvals",
        "followUpsDue": "Follow-ups due",
        "budget": "Budget",
    }
    for key, label in labels.items():
        value = links.get(key)
        if value:
            table.add_row(label, str(value))
    return table


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _blocked_source_note(blocked_sources: dict[str, Any]) -> str:
    sources = blocked_sources.get("sources")
    if not isinstance(sources, list) or not sources:
        return "No blocked or failing sources"
    names = [
        str(_dict(source).get("sourceId") or "")
        for source in sources[:3]
        if str(_dict(source).get("sourceId") or "")
    ]
    extra = len(sources) - len(names)
    if extra > 0:
        names.append(f"+{extra} more")
    return ", ".join(names)


def _budget_status_label(budget: dict[str, Any]) -> str:
    status = str(budget.get("status") or "unknown")
    if status == "over_budget":
        return "[red]over budget[/red]"
    if status == "ok":
        return "[green]ok[/green]"
    return status


def _budget_note(budget: dict[str, Any]) -> str:
    if budget.get("unlimited"):
        return "Unlimited local daily budget"
    estimated = float(budget.get("estimatedUsd") or 0.0)
    daily = float(budget.get("dailyBudgetUsd") or 0.0)
    remaining = budget.get("remainingUsd")
    if remaining is None:
        return f"${estimated:.2f} estimated of ${daily:.2f}"
    return f"${estimated:.2f} estimated, ${float(remaining):.2f} remaining of ${daily:.2f}"


@app.command("pipeline-status")
def pipeline_status() -> None:
    """Show pipeline statistics from the database."""
    _bootstrap()

    from jobctrl.database import get_stats

    stats = get_stats()

    console.print("\n[bold]JobCtrl Pipeline Status[/bold]\n")

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
        console.print("\n[dim]Apply telemetry is not available yet. Run `jobctrl apply` to populate it.[/dim]")

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

    retry_stages = (*VALID_STAGES, "enrich", "apply")
    if stage not in retry_stages:
        console.print(
            f"[red]Unknown stage:[/red] '{stage}'. "
            f"Valid stages: {', '.join(retry_stages)}"
        )
        raise typer.Exit(code=1)

    from jobctrl.database import get_connection
    from jobctrl.state import reset_job_stage

    try:
        job_url = reset_job_stage(get_connection(), url, stage, reset_attempts=reset_attempts)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(code=1)

    console.print(f"[green]Reset {stage} for retry:[/green] {job_url}")
    if run_after:
        if stage == "apply":
            _run_workflow_spec_from_cli(
                build_apply_workflow_spec(
                    {
                        "tenantId": "local",
                        "jobUrl": job_url,
                        "limit": 1,
                    }
                ),
                label="apply retry",
            )
        elif stage in (*VALID_STAGES, "enrich"):
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
    drive workflow-backed commands (``run_stage``, ``apply``, tailor / rescore)
    and local actions (``profile_import``); ``register_default_handlers`` owns
    the authoritative method set.
    """
    _bootstrap()
    from jobctrl.infrastructure.observability import shutdown_otel
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    from jobctrl.infrastructure.rpc.workflow_starter import (
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


async def _reconcile_discovery_schedule(client: Any, task_queue: str) -> None:
    """Create/update or delete the disabled-by-default discovery schedule."""
    from temporalio.client import (
        Schedule,
        ScheduleActionStartWorkflow,
        ScheduleOverlapPolicy,
        SchedulePolicy,
        ScheduleSpec,
        ScheduleUpdate,
    )

    from jobctrl.config import load_discovery_schedule_settings
    from jobctrl.discovery.workflow import (
        DiscoverWorkflow,
        DiscoverWorkflowInput,
        discover_workflow_id,
    )
    from jobctrl.domain.tenant import LOCAL_TENANT

    enabled, cron = load_discovery_schedule_settings()
    schedule_id = f"jobctrl-discovery-{LOCAL_TENANT}"
    handle = client.get_schedule_handle(schedule_id)
    if not enabled:
        try:
            await handle.delete()
        except Exception:
            log.debug("Discovery schedule %s absent or already deleted", schedule_id, exc_info=True)
        return

    schedule = Schedule(
        action=ScheduleActionStartWorkflow(
            DiscoverWorkflow.run,
            DiscoverWorkflowInput(tenant_id=str(LOCAL_TENANT)),
            id=discover_workflow_id(str(LOCAL_TENANT)),
            task_queue=task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )
    try:
        await client.create_schedule(schedule_id, schedule)
    except Exception:
        try:
            await handle.update(lambda _input: ScheduleUpdate(schedule))
        except Exception:
            log.warning("Discovery schedule %s reconcile failed", schedule_id, exc_info=True)


# Truthy spellings accepted by the browser-preflight escape hatch, matching the
# convention used by other JobCtrl env flags (e.g. ``LANGFUSE_DISABLE``).
_SKIP_BROWSER_PREFLIGHT_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _preflight_browsers_or_exit() -> None:
    """Fail fast at worker startup when Playwright Chromium is missing.

    Discovery scraping and HTML/CSS PDF rendering both launch Chromium; without
    it the worker would boot, connect to Temporal, and only fail hours into a
    Discover run the first time an activity opens a browser. Set
    ``JOBCTRL_SKIP_BROWSER_PREFLIGHT=1`` to bypass (e.g. a worker that only
    runs non-browser activities).
    """
    import os

    skip = os.environ.get("JOBCTRL_SKIP_BROWSER_PREFLIGHT", "").strip().lower()
    if skip in _SKIP_BROWSER_PREFLIGHT_TRUTHY:
        return

    from jobctrl.infrastructure.preflight import check_playwright_chromium

    ok, message = check_playwright_chromium()
    if ok:
        return

    console.print(f"[red]Worker preflight failed:[/red] {message}")
    console.print(
        "[dim]Set JOBCTRL_SKIP_BROWSER_PREFLIGHT=1 to start the worker anyway "
        "(browser activities will still fail at runtime).[/dim]"
    )
    raise typer.Exit(code=1)


@app.command()
def worker(
    task_queue: Optional[str] = typer.Option(
        None,
        "--task-queue",
        help="Override the Temporal task queue (defaults to JOBCTRL_TASK_QUEUE).",
    ),
) -> None:
    """Run the long-lived JobCtrl Temporal worker."""
    _bootstrap()

    # Verify the browser this worker needs is installed before we connect to
    # Temporal and start accepting activities — a missing binary must surface
    # here, not two hours into a Discover run.
    _preflight_browsers_or_exit()

    from jobctrl.infrastructure.temporal import (
        JOBCTRL_TASK_QUEUE,
        build_worker,
        get_temporal_client,
    )
    from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS
    from jobctrl.infrastructure.runtime_identity import (
        current_runtime_identity,
        write_worker_heartbeat,
    )
    queue = task_queue or JOBCTRL_TASK_QUEUE

    async def _run() -> None:
        client = await get_temporal_client()
        await _reconcile_discovery_schedule(client, queue)
        from jobctrl.apply.auto_apply import reconcile_auto_apply_loop

        identity = current_runtime_identity()
        startup_auto_apply = await reconcile_auto_apply_loop(
            client,
            task_queue=queue,
            expected_app_dir=str(identity.app_dir),
            expected_db_path=str(identity.db_path),
        )
        worker = build_worker(
            client,
            workflows=WORKFLOWS,
            activities=ACTIVITIES,
            task_queue=queue,
        )
        worker_started_at = datetime.now(timezone.utc)
        heartbeat_worker_id = write_worker_heartbeat(task_queue=queue)
        heartbeat_task = asyncio.create_task(
            _worker_heartbeat_loop(
                queue,
                heartbeat_worker_id,
                worker_started_at=worker_started_at,
                temporal_client=client,
            )
        )
        console.print(
            f"[bold blue]JobCtrl worker[/bold blue] running on task queue "
            f"[bold]{queue}[/bold] with {len(WORKFLOWS)} workflow(s) and "
            f"{len(ACTIVITIES)} activity(ies) against DB "
            f"[bold]{identity.db_path}[/bold] — Ctrl-C to stop."
        )
        if startup_auto_apply.changed:
            console.print(
                f"[yellow]Auto-apply loop {startup_auto_apply.action}: "
                f"{startup_auto_apply.workflow_id}.[/yellow]"
            )
        try:
            await worker.run()
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task

    from jobctrl.infrastructure.observability import shutdown_otel

    try:
        asyncio.run(_run())
    finally:
        # Flush any in-flight spans so the BatchSpanProcessor doesn't drop
        # them on Ctrl-C.
        shutdown_otel()


async def _worker_heartbeat_loop(
    task_queue: str,
    worker_id: str,
    *,
    worker_started_at: datetime | None = None,
    interval_seconds: float = 15.0,
    temporal_client: Any = None,
) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            _worker_heartbeat_iteration(
                task_queue,
                worker_id,
                worker_started_at=worker_started_at,
            )
        except Exception:
            log.warning("Worker heartbeat loop iteration failed; will retry", exc_info=True)
            continue
        # Describe-based reconciler: terminalize workflow-run rows whose
        # Temporal execution has closed (or vanished on a dev-server restart)
        # but never got a finalize outcome — e.g. a killed worker.
        if temporal_client is not None:
            try:
                terminalized = await _reconcile_workflow_runs(temporal_client)
            except Exception:
                log.warning("Workflow-run reconciler iteration failed; will retry", exc_info=True)
            else:
                if terminalized:
                    console.print(
                        f"[yellow]Reconciler terminalized {terminalized} orphaned "
                        "workflow run(s).[/yellow]"
                    )
            try:
                from jobctrl.apply.auto_apply import reconcile_auto_apply_loop
                from jobctrl.infrastructure.runtime_identity import current_runtime_identity

                identity = current_runtime_identity()
                auto_apply = await reconcile_auto_apply_loop(
                    temporal_client,
                    task_queue=task_queue,
                    expected_app_dir=str(identity.app_dir),
                    expected_db_path=str(identity.db_path),
                )
            except Exception:
                log.warning("Auto-apply loop reconciler iteration failed; will retry", exc_info=True)
            else:
                if auto_apply.changed:
                    console.print(
                        f"[yellow]Auto-apply loop {auto_apply.action}: "
                        f"{auto_apply.workflow_id}.[/yellow]"
                    )


def _worker_heartbeat_iteration(
    task_queue: str,
    worker_id: str,
    *,
    worker_started_at: datetime | None = None,
) -> None:
    from jobctrl.infrastructure.runtime_identity import write_worker_heartbeat

    write_worker_heartbeat(task_queue=task_queue, worker_id=worker_id)


# Temporal execution status -> the terminal workflow-run status the reconciler
# records. RUNNING / CONTINUED_AS_NEW are intentionally absent: those rows are
# still live and are left untouched.
def _reconcile_status_map() -> dict:
    from temporalio.client import WorkflowExecutionStatus

    return {
        WorkflowExecutionStatus.COMPLETED: "succeeded",
        WorkflowExecutionStatus.FAILED: "failed",
        WorkflowExecutionStatus.CANCELED: "canceled",
        WorkflowExecutionStatus.TERMINATED: "terminated",
        WorkflowExecutionStatus.TIMED_OUT: "timed_out",
    }


def _reconciled_reason(status: str, describe_status: Any) -> tuple[str | None, str | None]:
    """Reason fields for a row the reconciler terminalizes.

    A backstop-closed run carries no app-level error detail (finalize never ran
    on it), so without this the ``/runs`` UI shows a terminated run with no
    explanation. The reconciler stamps its own provenance instead: an
    ``errorCode`` naming why it closed the row and a human-readable message
    quoting the Temporal execution status. A reconciled success needs no reason
    and keeps both fields null. The NOT_FOUND code (``reconciled_not_found``) is
    set at its call site in ``_reconcile_one_workflow_run``.
    """
    if status == "succeeded":
        return None, None
    name = getattr(describe_status, "name", str(describe_status))
    code = "reconciled_terminated" if status == "terminated" else f"reconciled_closed_{status}"
    return code, f"The reconciler closed this run: the Temporal execution reported {name}."


async def _reconcile_workflow_runs(temporal_client: Any, *, tenant_id: str | None = None) -> int:
    """Terminalize open ``workflow_run_projections`` rows by describing them.

    For each non-terminal row: a CLOSED Temporal execution records the matching
    terminal ``Workflow*`` event; a NOT_FOUND execution (dev-server data loss)
    records ``WorkflowTerminated``; a still-RUNNING execution is left alone.
    """
    from jobctrl.database import get_connection
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.projections.sqlite_projection_store import (
        SqliteProjectionStore,
    )

    tenant = tenant_id or LOCAL_TENANT
    conn = get_connection()
    try:
        open_runs = SqliteProjectionStore(conn).open_workflow_runs(str(tenant))
    except sqlite3.OperationalError:
        return 0

    terminalized = 0
    for run in open_runs:
        if await _reconcile_one_workflow_run(temporal_client, conn, run):
            terminalized += 1
    return terminalized


async def _reconcile_one_workflow_run(temporal_client: Any, conn, run: dict) -> bool:
    from temporalio.service import RPCError, RPCStatusCode

    workflow_id = str(run.get("workflow_id") or "")
    if not workflow_id:
        return False
    try:
        description = await temporal_client.get_workflow_handle(workflow_id).describe()
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND:
            # The dev server lost its history across a restart; treat the run as
            # terminated so it stops showing as forever-running.
            _record_reconciled_outcome(
                conn,
                run,
                status="terminated",
                error_code="reconciled_not_found",
                error_message=(
                    "The reconciler closed this run: its Temporal execution no "
                    "longer exists on the server (dev-server history loss)."
                ),
                temporal_run_id=run.get("temporal_run_id"),
            )
            return True
        log.warning("describe_workflow failed for %s; will retry", workflow_id, exc_info=True)
        return False

    status = _reconcile_status_map().get(description.status)
    if status is None:
        # RUNNING / CONTINUED_AS_NEW — still live, leave it.
        return False
    error_code, error_message = _reconciled_reason(status, description.status)
    _record_reconciled_outcome(
        conn,
        run,
        status=status,
        error_code=error_code,
        error_message=error_message,
        temporal_run_id=description.run_id or run.get("temporal_run_id"),
    )
    return True


def _record_reconciled_outcome(
    conn,
    run: dict,
    *,
    status: str,
    temporal_run_id: str | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    from jobctrl.database import get_connection
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
    from jobctrl.infrastructure.projections.sqlite_projection_store import (
        SqliteProjectionStore,
    )
    from jobctrl.infrastructure.temporal.finalize import (
        WorkflowOutcomeInput,
        build_workflow_outcome_event,
    )
    from jobctrl.state import record_job_event, utc_now

    workflow_id = str(run.get("workflow_id") or "")
    if not workflow_id:
        return

    # The reconciler is a backstop for runs stuck open, never an overwriter of
    # terminal truth. Both workflows encode stage/apply failure in their return
    # value, so a failing run closes COMPLETED on the Temporal side even though
    # finalize already recorded WorkflowFailed. Take the write lock first, then
    # re-read the row: if a finalize landed the real terminal outcome between the
    # open-runs snapshot and now, leave it rather than describe over it (M-1
    # review). Layer 2 (the first-terminal-wins fold) backstops any event that
    # slips past this check.
    own_txn = not conn.in_transaction
    if own_txn:
        conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            "SELECT status FROM workflow_run_projections WHERE workflow_id = ?",
            (workflow_id,),
        ).fetchone()
        if (
            existing is not None
            and str(existing["status"]) in SqliteProjectionStore.WORKFLOW_TERMINAL_STATUSES
        ):
            if own_txn:
                conn.rollback()
            return
        event = build_workflow_outcome_event(
            WorkflowOutcomeInput(
                tenant_id=str(run.get("tenant_id") or LOCAL_TENANT),
                workflow_id=workflow_id,
                workflow_type=str(run.get("workflow_type") or ""),
                status=status,
                error_code=error_code,
                error_message=error_message,
                finished_at=utc_now(),
                temporal_run_id=temporal_run_id,
            )
        )
        record_job_event(conn, None, "workflow", event.event_type, payload=dict(event.payload))
        if own_txn:
            conn.commit()
    except Exception:
        if own_txn:
            conn.rollback()
        raise
    ProjectionBuilder(conn_factory=get_connection).refresh()


@app.command()
def backup(
    output: Optional[Path] = typer.Option(
        None,
        "--output",
        "-o",
        help=(
            "Destination file, or a directory to place a timestamped backup in. "
            "Defaults to ~/.jobctrl/backups/jobctrl-<timestamp>.db."
        ),
    ),
) -> None:
    """Write a consistent snapshot of the local SQLite database.

    Uses SQLite VACUUM INTO, so it is safe to run while the app is running.
    Nothing is ever deleted. To restore, stop the app and copy a backup file
    over ~/.jobctrl/jobctrl.db.
    """
    from jobctrl.database import backup_database

    try:
        destination = backup_database(output)
    except (FileNotFoundError, FileExistsError, OSError, sqlite3.Error) as exc:
        console.print(f"[red]Backup failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc

    size = destination.stat().st_size
    console.print(f"[green]Database backup written:[/green] {destination} ({size:,} bytes)")


# Broad job boards whose internal per-board transport is owned by python-jobspy
# (R10, D3): we cannot robots-gate or count their individual requests, only pace
# and budget at our invocation boundary. ``doctor`` discloses when they are on.
_BROAD_BOARDS = frozenset({"indeed", "linkedin", "glassdoor", "zip_recruiter"})


def _politeness_blocked_source_ids(conn) -> set[str]:
    """Distinct source_ids with a recorded robots/rate-limit block (empty on any error)."""
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT source_id FROM operational_attempt_metrics
            WHERE outcome = 'blocked'
              AND failure_category IN ('robots_disallowed', 'rate_limited')
              AND source_id IS NOT NULL
            """
        ).fetchall()
    except Exception:  # noqa: BLE001 - doctor discloses posture; a missing table is not fatal.
        return set()
    return {str(row[0]) for row in rows if row[0]}


def politeness_doctor_notices(conn, search_cfg: dict) -> list[tuple[str, str, str]]:
    """Crawl-politeness disclosure rows as ``(check, level, note)``.

    ``level`` is ``"ok"`` or ``"warn"``. Pure and side-effect-free (no printing,
    no network) so it is unit-testable with an in-memory connection and a
    search-config dict. ``doctor`` maps the levels to its status marks.
    """
    from jobctrl.config import resolve_jobspy_boards
    from jobctrl.infrastructure.network import resolve_honest_user_agent

    rows: list[tuple[str, str, str]] = []

    user_agent = resolve_honest_user_agent().header_value()
    rows.append((
        "crawl user-agent",
        "ok",
        f"{user_agent} — review before real crawls; override via "
        "JOBCTRL_CRAWL_UA_PRODUCT / JOBCTRL_CRAWL_UA_CONTACT",
    ))

    boards = resolve_jobspy_boards(search_cfg, warn=False)
    active_broad = [board for board in boards if board in _BROAD_BOARDS]
    if active_broad:
        rows.append((
            "broad-board discovery",
            "warn",
            f"active: {', '.join(active_broad)} — python-jobspy owns their transport; "
            "only invocation-boundary budget + pacing apply (D3)",
        ))
    else:
        rows.append(("broad-board discovery", "ok", "no broad boards active"))

    blocked = _politeness_blocked_source_ids(conn)
    if blocked:
        preview = ", ".join(sorted(blocked)[:5])
        extra = "" if len(blocked) <= 5 else f" (+{len(blocked) - 5} more)"
        rows.append((
            "robots/rate-limited sources",
            "warn",
            f"{len(blocked)} source(s) recently blocked: {preview}{extra}",
        ))
    else:
        rows.append(("robots/rate-limited sources", "ok", "none recently blocked"))

    return rows


@app.command()
def doctor() -> None:
    """Check your setup and diagnose missing requirements."""
    import os
    import shutil
    from jobctrl.config import (
        load_env, DB_PATH, RESUME_PATH, RESUME_PDF_PATH,
        load_search_config,
        gmail_mcp_auth_status,
    )
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.profile import get_profile_repository
    from jobctrl.infrastructure.apply.claude_code_cli import _claude_supports_budget_flag
    from jobctrl.infrastructure.scoring.criteria_provider import (
        read_apply_approval_required,
    )
    from jobctrl.infrastructure.setup_probes import (
        probe_analysis_setup,
        resolve_claude_apply_binary,
    )
    from jobctrl.runtime import is_bundled_runtime, payload_path

    keychain_diagnostics = load_env() or ()
    bundled = is_bundled_runtime()

    ok_mark = "[green]OK[/green]"
    fail_mark = "[red]MISSING[/red]"
    warn_mark = "[yellow]WARN[/yellow]"

    results: list[tuple[str, str, str]] = []  # (check, status, note)

    loaded_from_keychain = sum(result.status == "loaded" for result in keychain_diagnostics)
    unavailable_from_keychain = sum(result.status == "unavailable" for result in keychain_diagnostics)
    unsupported_from_keychain = sum(result.status == "unsupported" for result in keychain_diagnostics)
    explicit_provider_settings = sum(result.status == "explicit" for result in keychain_diagnostics)
    if loaded_from_keychain:
        results.append(
            (
                "provider credential source",
                ok_mark,
                f"{loaded_from_keychain} setting(s) loaded from macOS Keychain for this process; restart the worker after Settings changes",
            )
        )
    elif unavailable_from_keychain:
        results.append(
            (
                "provider credential source",
                warn_mark,
                "macOS Keychain fallback unavailable; use ~/.jobctrl/.env or shell environment",
            )
        )
    elif unsupported_from_keychain:
        results.append(
            (
                "provider credential source",
                "[dim]environment only[/dim]",
                "native OS credential-store fallback is not shipped on this platform",
            )
        )
    elif explicit_provider_settings:
        results.append(
            (
                "provider credential source",
                ok_mark,
                "environment configuration takes precedence over macOS Keychain",
            )
        )
    else:
        results.append(
            (
                "provider credential source",
                "[dim]optional[/dim]",
                "no macOS Keychain fallback entries found; environment configuration remains available",
            )
        )

    # --- Tier 1 checks ---
    # Profile
    try:
        profile = get_profile_repository().load(LOCAL_TENANT)
        if profile is None:
            results.append(("candidate profile", fail_mark, "Run 'jobctrl init' to create"))
        else:
            results.append(("candidate profile", ok_mark, f"SQLite source of truth at {DB_PATH}"))
            attestations = profile.to_dict().get("application_attestations") or {}
            required_attestations = (
                "age_18_plus",
                "background_check_consent",
                "felony_conviction",
                "previously_worked_at_employer",
            )
            missing_attestations = [
                key for key in required_attestations if attestations.get(key) is None
            ]
            if missing_attestations:
                results.append((
                    "application attestations",
                    warn_mark,
                    "incomplete; live applies may fail on screening questions",
                ))
            else:
                results.append((
                    "application attestations",
                    ok_mark,
                    "typed screening attestations complete",
                ))
    except FileNotFoundError:
        results.append(("candidate profile", fail_mark, "Run 'jobctrl init' to create"))
    except Exception:  # noqa: BLE001 - doctor should report validation problems instead of crashing
        results.append(("candidate profile", fail_mark, "Profile exists but failed validation"))

    # Resume
    if RESUME_PATH.exists():
        results.append(("resume.txt", ok_mark, str(RESUME_PATH)))
    elif RESUME_PDF_PATH.exists():
        results.append(("resume.txt", warn_mark, "Only PDF found — plain-text needed for AI stages"))
    else:
        results.append(("resume.txt", fail_mark, "Run 'jobctrl init' to add your resume"))

    from jobctrl.browser_capabilities import list_browser_capabilities

    browser_capabilities = {item.id: item for item in list_browser_capabilities()}
    core_browser = browser_capabilities["core-browser"]
    results.append((
        "core browser (scraping + PDF)",
        ok_mark if core_browser.status == "ready" else fail_mark,
        core_browser.detail,
    ))
    auto_apply_browser = browser_capabilities["auto-apply-browser"]
    linkedin_browser = browser_capabilities["authenticated-linkedin-browser"]
    capability_marks = {
        "ready": ok_mark,
        "disabled": "[dim]DISABLED[/dim]",
        "missing": warn_mark,
        "failed": fail_mark,
        "unavailable": fail_mark,
    }
    for capability in (auto_apply_browser, linkedin_browser):
        results.append((
            f"{capability.id} capability",
            capability_marks[capability.status],
            capability.detail,
        ))

    try:
        search_cfg = load_search_config()
        boards = ", ".join(str(board) for board in search_cfg.get("boards", [])) or "default boards"
        results.append(("discovery_settings", ok_mark, f"SQLite-backed search settings ({boards})"))
    except Exception as exc:  # noqa: BLE001 - doctor should report setup issues, not crash.
        results.append(("discovery_settings", warn_mark, f"Unable to load search settings: {exc}"))

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
    for probe in probe_analysis_setup():
        mark = ok_mark if probe.ok else (fail_mark if probe.required else "[dim]optional[/dim]")
        results.append((probe.name, mark, probe.note))

    # --- Tier 3 checks ---
    # Claude apply runtime
    try:
        claude_bin = resolve_claude_apply_binary()
        if shutil.which(claude_bin) or Path(claude_bin).expanduser().exists():
            results.append(("Claude apply runtime", ok_mark, claude_bin))
            if _claude_supports_budget_flag(claude_bin, bare=bundled):
                results.append(("Claude apply budget flag", ok_mark, "--max-budget-usd available"))
            else:
                results.append((
                    "Claude apply budget flag",
                    warn_mark,
                    "installed Claude runtime does not advertise --max-budget-usd",
                ))
        else:
            results.append(("Claude apply runtime", fail_mark, "set JOBCTRL_CLAUDE_BIN or install dependencies"))
    except Exception as exc:  # noqa: BLE001 - doctor is diagnostic
        results.append(("Claude apply runtime", fail_mark, f"unavailable: {exc}"))

    # Playwright MCP uses the payload-owned Node/runtime wrapper in bundled
    # mode; only source checkouts need a machine-level npx executable.
    if bundled:
        try:
            playwright_mcp = payload_path(
                "playwright-mcp/bin/playwright-mcp",
                require_exists=True,
            )
            if not playwright_mcp.is_file() or not os.access(playwright_mcp, os.X_OK):
                raise RuntimeError(f"embedded wrapper is not executable: {playwright_mcp}")
            results.append(("Playwright MCP runtime", ok_mark, str(playwright_mcp)))
        except Exception as exc:  # noqa: BLE001 - doctor is diagnostic
            results.append(("Playwright MCP runtime", fail_mark, f"unavailable: {exc}"))
    else:
        npx_bin = shutil.which("npx")
        if npx_bin:
            results.append(("Node.js (npx)", ok_mark, npx_bin))
        else:
            results.append(("Node.js (npx)", fail_mark,
                            "Install Node.js 18+ from nodejs.org (needed for auto-apply)"))

    # Gmail connector is optional, but apply runs that hit email verification need it
    # to stay browser-independent and finish automatically.
    gmail_ok, gmail_note = gmail_mcp_auth_status()
    if gmail_ok:
        results.append(("Gmail connector auth", ok_mark, gmail_note))
    else:
        results.append((
            "Gmail connector auth",
            warn_mark,
            f"{gmail_note}; email verification will stop as login_issue and email applications cannot send",
        ))

    # CapSolver (optional; the owned solve_captcha tool fails closed when absent)
    capsolver = os.environ.get("CAPSOLVER_API_KEY")
    if capsolver:
        results.append((
            "CapSolver API key",
            "[dim]configured[/dim]",
            "owned solve_captcha tool can handle supported widgets",
        ))
    else:
        results.append(("CapSolver API key", "[dim]optional[/dim]",
                        "not required; unsupported or unconfigured CAPTCHA flows fail closed"))

    # The gate defaults on. If an operator has explicitly disabled it, make the
    # resulting live-submission posture visible in the same preflight that
    # reports the other preserved automation capabilities.
    if read_apply_approval_required(default=True):
        results.append((
            "apply approval gate",
            ok_mark,
            "required before eligible live submissions",
        ))
    else:
        results.append((
            "apply approval gate",
            warn_mark,
            "disabled; eligible live runs may submit without human review",
        ))

    # Temporal dev server (workflow engine)
    from jobctrl.infrastructure.temporal import get_temporal_client

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
    from jobctrl.infrastructure.observability import langfuse_disabled

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

    # --- Crawl politeness disclosure (R10) ---
    try:
        from jobctrl.config import load_search_config as _load_search_config
        from jobctrl.database import get_connection as _get_connection

        try:
            politeness_cfg = _load_search_config()
        except Exception:  # noqa: BLE001 - disclosure must not crash doctor.
            politeness_cfg = {}
        try:
            politeness_conn = _get_connection()
        except Exception:  # noqa: BLE001 - disclosure must not crash doctor.
            politeness_conn = None
        mark_for = {"ok": ok_mark, "warn": warn_mark}
        for check, level, note in politeness_doctor_notices(politeness_conn, politeness_cfg):
            results.append((check, mark_for.get(level, warn_mark), note))
    except Exception:  # noqa: BLE001 - disclosure must not crash doctor.
        pass

    # --- Render results ---
    console.print()
    console.print("[bold]JobCtrl Doctor[/bold]\n")

    col_w = max(len(r[0]) for r in results) + 2
    for check, status, note in results:
        pad = " " * (col_w - len(check))
        console.print(f"  {check}{pad}{status}  [dim]{note}[/dim]")

    console.print()

    # Tier summary
    from jobctrl.config import get_tier, TIER_LABELS
    tier = get_tier()
    console.print(f"[bold]Current tier: Tier {tier} — {TIER_LABELS[tier]}[/bold]")

    if tier == 1:
        console.print("[dim]  → Tier 2 unlocks: scoring, tailoring, cover letters (needs an LLM provider)[/dim]")
        tier3_tools = "Claude apply runtime + an explicitly enabled auto-apply browser capability" + ("" if bundled else " + Node.js")
        console.print(f"[dim]  → Tier 3 unlocks: auto-apply (needs {tier3_tools})[/dim]")
    elif tier == 2:
        tier3_tools = "Claude apply runtime + an explicitly enabled auto-apply browser capability" + ("" if bundled else " + Node.js")
        console.print(f"[dim]  → Tier 3 unlocks: auto-apply (needs {tier3_tools})[/dim]")

    console.print()


@app.command("migrate-resume-html")
def migrate_resume_html(
    dry_run: bool = typer.Option(False, "--dry-run", help="Report matching resume PDFs without writing files or DB rows."),
    force: bool = typer.Option(False, "--force", help="Refresh already-HTML resume PDFs from their sibling text source."),
    job_url: Optional[str] = typer.Option(None, "--job-url", help="Limit migration to one job URL."),
    limit: Optional[int] = typer.Option(None, "--limit", min=1, help="Maximum number of resume PDFs to migrate or refresh."),
) -> None:
    """Migrate or refresh approved resume PDFs as HTML/CSS-rendered artifacts."""
    _bootstrap()

    from jobctrl.database import get_connection
    from jobctrl.infrastructure.materials.resume_html_migration import migrate_legacy_resume_pdfs
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

    conn = get_connection()
    results = migrate_legacy_resume_pdfs(conn, dry_run=dry_run, force=force, job_url=job_url, limit=limit)
    if not dry_run:
        ProjectionBuilder(conn_factory=get_connection).refresh()

    table = Table(title="Resume HTML migration")
    table.add_column("Status")
    table.add_column("Artifact")
    table.add_column("Reason")
    table.add_column("Path")
    for result in results:
        table.add_row(result.status, result.artifact_id[:10], result.reason, result.path)
    console.print(table)
    migrated = sum(1 for result in results if result.status == "migrated")
    refreshed = sum(1 for result in results if result.status == "refreshed")
    ready = sum(1 for result in results if result.status == "would_migrate")
    ready_refresh = sum(1 for result in results if result.status == "would_refresh")
    skipped = sum(1 for result in results if result.status == "skipped")
    if dry_run:
        console.print(
            f"[bold]{ready}[/bold] resume PDF(s) ready to migrate; "
            f"[bold]{ready_refresh}[/bold] ready to refresh; [bold]{skipped}[/bold] skipped."
        )
    else:
        console.print(
            f"[bold]{migrated}[/bold] resume PDF(s) migrated; "
            f"[bold]{refreshed}[/bold] refreshed; [bold]{skipped}[/bold] skipped."
        )


@app.command("gmail-auth")
def gmail_auth(
    no_browser: bool = typer.Option(False, "--no-browser", help="Print the auth URL without opening a browser."),
    timeout_seconds: int = typer.Option(180, "--timeout-seconds", help="Seconds to wait for the local OAuth callback."),
) -> None:
    """Authenticate the first-party Gmail connector."""
    from jobctrl.infrastructure.gmail.auth import GmailAuthError, authenticate

    try:
        token_path = authenticate(open_browser=not no_browser, timeout_seconds=timeout_seconds)
    except GmailAuthError as exc:
        console.print(f"[red]Gmail auth failed:[/red] {exc}")
        raise typer.Exit(code=1) from exc
    console.print(f"[green]Gmail token saved:[/green] {token_path}")


if __name__ == "__main__":
    app()
