"""JobHunter Pipeline Orchestrator.

Runs pipeline stages in sequence or concurrently (streaming mode).

Usage (via CLI):
    jobhunter run                        # all stages, sequential
    jobhunter run --stream               # all stages, concurrent
    jobhunter run discover enrich        # specific stages
    jobhunter run score tailor cover     # LLM-only stages
    jobhunter run --dry-run              # preview without executing
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from jobhunter import config
from jobhunter.config import load_env, ensure_dirs
from jobhunter.database import init_db, get_connection, get_stats

log = logging.getLogger(__name__)
console = Console()


# ---------------------------------------------------------------------------
# Stage definitions
# ---------------------------------------------------------------------------

STAGE_ORDER = ("discover", "enrich", "score", "tailor", "cover", "pdf")

STAGE_META: dict[str, dict] = {
    "discover": {"desc": "Job discovery (JobSpy + Workday + smart extract)"},
    "enrich":   {"desc": "Detail enrichment (full descriptions + apply URLs)"},
    "score":    {"desc": "LLM scoring (fit 1-10)"},
    "tailor":   {"desc": "Resume tailoring (LLM + validation)"},
    "cover":    {"desc": "Cover letter generation"},
    "pdf":      {"desc": "PDF conversion (tailored resumes + cover letters)"},
}

# Upstream dependencies: a stage only finishes when all of its producers are
# done and it has no remaining pending work.
_UPSTREAMS: dict[str, tuple[str, ...]] = {
    "discover": (),
    "enrich":   ("discover",),
    "score":    ("enrich",),
    "tailor":   ("score",),
    "cover":    ("tailor",),
    "pdf":      ("tailor", "cover"),
}


# ---------------------------------------------------------------------------
# Individual stage runners
# ---------------------------------------------------------------------------

def _run_discover(workers: int = 1) -> dict:
    """Stage: Job discovery — JobSpy, Workday, and smart-extract scrapers."""
    stats: dict = {"jobspy": None, "workday": None, "smartextract": None}

    # JobSpy — skip if disabled in config or module not installed
    search_cfg = config.load_search_config() or {}
    if search_cfg.get("disable_jobspy", False):
        console.print("  [dim]JobSpy disabled in searches.yaml[/dim]")
        stats["jobspy"] = "disabled"
    else:
        console.print("  [cyan]JobSpy full crawl...[/cyan]")
        try:
            from jobhunter.discovery.jobspy import run_discovery
            run_discovery()
            stats["jobspy"] = "ok"
        except ImportError:
            console.print("  [dim]JobSpy not installed — skipping[/dim]")
            stats["jobspy"] = "not_installed"
        except Exception as e:
            log.error("JobSpy crawl failed: %s", e)
            console.print(f"  [red]JobSpy error:[/red] {e}")
            stats["jobspy"] = f"error: {e}"

    # Workday corporate scraper
    console.print("  [cyan]Workday corporate scraper...[/cyan]")
    try:
        from jobhunter.discovery.workday import run_workday_discovery
        run_workday_discovery(workers=workers)
        stats["workday"] = "ok"
    except Exception as e:
        log.error("Workday scraper failed: %s", e)
        console.print(f"  [red]Workday error:[/red] {e}")
        stats["workday"] = f"error: {e}"

    # Smart extract
    console.print("  [cyan]Smart extract (AI-powered scraping)...[/cyan]")
    try:
        from jobhunter.discovery.smartextract import run_smart_extract
        run_smart_extract(workers=workers)
        stats["smartextract"] = "ok"
    except Exception as e:
        log.error("Smart extract failed: %s", e)
        console.print(f"  [red]Smart extract error:[/red] {e}")
        stats["smartextract"] = f"error: {e}"

    return stats


def _run_enrich(workers: int = 1) -> dict:
    """Stage: Detail enrichment — scrape full descriptions and apply URLs."""
    try:
        from jobhunter.enrichment.detail import run_enrichment
        run_enrichment(workers=workers)
        return {"status": "ok"}
    except Exception as e:
        log.error("Enrichment failed: %s", e)
        return {"status": f"error: {e}"}


def _run_score(limit: int = 0, rescore: bool = False, workers: int = 1) -> dict:
    """Stage: LLM scoring — assign fit scores 1-10."""
    try:
        from jobhunter.scoring.scorer import run_scoring
        run_scoring(limit=limit, rescore=rescore, workers=workers)
        return {"status": "ok"}
    except Exception as e:
        log.error("Scoring failed: %s", e)
        return {"status": f"error: {e}"}


def _run_tailor(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
    workers: int = 1,
    retailor: bool = False,
) -> dict:
    """Stage: Resume tailoring — generate tailored resumes for high-fit jobs."""
    try:
        from jobhunter.scoring.tailor import run_tailoring
        run_tailoring(
            min_score=min_score,
            limit=limit,
            validation_mode=validation_mode,
            workers=workers,
            retailor=retailor,
        )
        return {"status": "ok"}
    except Exception as e:
        log.error("Tailoring failed: %s", e)
        return {"status": f"error: {e}"}


def _run_cover(
    min_score: int = 7,
    limit: int = 0,
    validation_mode: str = "normal",
) -> dict:
    """Stage: Cover letter generation."""
    try:
        from jobhunter.scoring.cover_letter import run_cover_letters
        run_cover_letters(
            min_score=min_score,
            limit=limit,
            validation_mode=validation_mode,
        )
        return {"status": "ok"}
    except Exception as e:
        log.error("Cover letter generation failed: %s", e)
        return {"status": f"error: {e}"}


def _run_pdf(limit: int = 0) -> dict:
    """Stage: PDF conversion — convert tailored resumes and cover letters to PDF."""
    try:
        from jobhunter.scoring.pdf import batch_convert
        batch_convert(limit=limit)
        return {"status": "ok"}
    except Exception as e:
        log.error("PDF conversion failed: %s", e)
        return {"status": f"error: {e}"}


# Map stage names to their runner functions
_STAGE_RUNNERS: dict[str, callable] = {
    "discover": _run_discover,
    "enrich":   _run_enrich,
    "score":    _run_score,
    "tailor":   _run_tailor,
    "cover":    _run_cover,
    "pdf":      _run_pdf,
}


def _build_stage_kwargs(
    stage: str,
    *,
    min_score: int = 7,
    workers: int = 1,
    validation_mode: str = "normal",
    limit: int = 0,
    rescore: bool = False,
    retailor: bool = False,
) -> dict:
    """Build the keyword arguments for a stage runner."""
    kwargs: dict = {}

    if stage in ("discover", "enrich", "score"):
        kwargs["workers"] = workers
    if stage == "score":
        kwargs["limit"] = limit
        kwargs["rescore"] = rescore
    elif stage in ("tailor", "cover"):
        kwargs["min_score"] = min_score
        kwargs["limit"] = limit
        kwargs["validation_mode"] = validation_mode
        if stage == "tailor":
            kwargs["workers"] = workers
            kwargs["retailor"] = retailor
    elif stage == "pdf":
        kwargs["limit"] = limit

    return kwargs


# ---------------------------------------------------------------------------
# Stage resolution
# ---------------------------------------------------------------------------

def _resolve_stages(stage_names: list[str]) -> list[str]:
    """Resolve 'all' and validate/order stage names."""
    if "all" in stage_names:
        return list(STAGE_ORDER)

    resolved = []
    for name in stage_names:
        if name not in STAGE_META:
            console.print(
                f"[red]Unknown stage:[/red] '{name}'. "
                f"Available: {', '.join(STAGE_ORDER)}, all"
            )
            raise SystemExit(1)
        if name not in resolved:
            resolved.append(name)

    # Maintain canonical order
    return [s for s in STAGE_ORDER if s in resolved]


# ---------------------------------------------------------------------------
# Streaming pipeline helpers
# ---------------------------------------------------------------------------

class _StageTracker:
    """Thread-safe tracker for which stages have finished producing work."""

    def __init__(self):
        self._events: dict[str, threading.Event] = {
            stage: threading.Event() for stage in STAGE_ORDER
        }
        self._results: dict[str, dict] = {}
        self._lock = threading.Lock()

    def mark_done(self, stage: str, result: dict | None = None) -> None:
        with self._lock:
            self._results[stage] = result or {"status": "ok"}
        self._events[stage].set()

    def is_done(self, stage: str) -> bool:
        return self._events[stage].is_set()

    def wait(self, stage: str, timeout: float | None = None) -> bool:
        return self._events[stage].wait(timeout=timeout)

    def get_results(self) -> dict[str, dict]:
        with self._lock:
            return dict(self._results)


# SQL to count pending work for each stage
_PENDING_SQL: dict[str, str] = {
    "enrich": "SELECT COUNT(*) FROM jobs WHERE detail_scraped_at IS NULL",
    "score":  "SELECT COUNT(*) FROM jobs WHERE full_description IS NOT NULL AND fit_score IS NULL",
    "tailor": (
        "SELECT COUNT(*) FROM jobs WHERE fit_score >= ? "
        "AND full_description IS NOT NULL "
        "AND tailored_resume_path IS NULL "
        "AND COALESCE(tailor_attempts, 0) < 5"
    ),
    "cover": (
        "SELECT COUNT(*) FROM jobs WHERE fit_score >= ? "
        "AND full_description IS NOT NULL "
        "AND tailored_resume_path IS NOT NULL AND tailored_resume_path != '' "
        "AND (cover_letter_path IS NULL OR cover_letter_path = '') "
        "AND COALESCE(cover_attempts, 0) < 5"
    ),
}

# How long to sleep between polling loops in streaming mode (seconds)
_STREAM_POLL_INTERVAL = 10


def _count_pending(stage: str, min_score: int = 7, retailor: bool = False) -> int:
    """Count pending work items for a stage."""
    if stage == "pdf":
        from jobhunter.scoring.pdf import count_pending_conversions
        return count_pending_conversions()

    if stage == "tailor":
        conn = get_connection()
        where = (
            "fit_score >= ? AND full_description IS NOT NULL "
            "AND (tailored_resume_path IS NOT NULL OR COALESCE(tailor_attempts, 0) < 5)"
            if retailor else
            "fit_score >= ? AND full_description IS NOT NULL "
            "AND tailored_resume_path IS NULL AND COALESCE(tailor_attempts, 0) < 5"
        )
        return conn.execute(f"SELECT COUNT(*) FROM jobs WHERE {where}", (min_score,)).fetchone()[0]

    sql = _PENDING_SQL.get(stage)
    if sql is None:
        return 0
    conn = get_connection()
    if "?" in sql:
        return conn.execute(sql, (min_score,)).fetchone()[0]
    return conn.execute(sql).fetchone()[0]


def _run_stage_streaming(
    stage: str,
    tracker: _StageTracker,
    stop_event: threading.Event,
    min_score: int = 7,
    workers: int = 1,
    validation_mode: str = "normal",
    limit: int = 0,
    rescore: bool = False,
    retailor: bool = False,
) -> None:
    """Run a single stage in streaming mode: loop until upstream done + no work.

    For discover: runs once, then marks done.
    For all others: polls DB for pending work, runs the batch processor,
    and repeats until upstream is done and no pending work remains.
    """
    runner = _STAGE_RUNNERS[stage]
    kwargs = _build_stage_kwargs(
        stage,
        min_score=min_score,
        workers=workers,
        validation_mode=validation_mode,
        limit=limit,
        rescore=rescore,
        retailor=retailor,
    )
    upstreams = _UPSTREAMS[stage]

    if stage == "discover":
        # Discover runs once (its sub-scrapers already do their full crawl)
        try:
            result = runner(**kwargs)
            tracker.mark_done(stage, result)
        except Exception as e:
            log.exception("Stage '%s' crashed", stage)
            tracker.mark_done(stage, {"status": f"error: {e}"})
        return

    # For downstream stages: loop until upstream done + no pending work
    passes = 0
    no_progress_passes = 0
    while not stop_event.is_set():
        pending = _count_pending(stage, min_score, retailor=retailor)
        upstream_done = all(tracker.is_done(s) for s in upstreams)

        if pending > 0:
            try:
                runner(**kwargs)
                passes += 1
                after = _count_pending(stage, min_score, retailor=retailor)
                if upstream_done and after >= pending:
                    no_progress_passes += 1
                    if no_progress_passes >= 3:
                        tracker.mark_done(
                            stage,
                            {"status": f"stuck: {after} pending after {passes} passes", "passes": passes},
                        )
                        return
                else:
                    no_progress_passes = 0
            except Exception as e:
                log.error("Stage '%s' error (pass %d): %s", stage, passes, e)
                passes += 1
                if upstream_done:
                    no_progress_passes += 1
                    if no_progress_passes >= 3:
                        tracker.mark_done(
                            stage,
                            {"status": f"error: no progress after {passes} passes: {e}", "passes": passes},
                        )
                        return
        else:
            # No work right now
            if upstream_done:
                # No work and upstream is done — this stage is finished
                break
            # Upstream still running, wait and retry
            if stop_event.wait(timeout=_STREAM_POLL_INTERVAL):
                break  # Stop requested

    tracker.mark_done(stage, {"status": "ok", "passes": passes})


# ---------------------------------------------------------------------------
# Pipeline orchestrators
# ---------------------------------------------------------------------------

def _run_sequential(ordered: list[str], min_score: int, workers: int = 1,
                    validation_mode: str = "normal", limit: int = 0,
                    rescore: bool = False, retailor: bool = False) -> dict:
    """Execute stages one at a time (original behavior)."""
    results: list[dict] = []
    errors: dict[str, str] = {}
    pipeline_start = time.time()

    for name in ordered:
        meta = STAGE_META[name]
        console.print(f"\n{'=' * 70}")
        console.print(f"  [bold]STAGE: {name}[/bold] — {meta['desc']}")
        console.print(f"  Started: {datetime.now().strftime('%H:%M:%S')}")
        console.print(f"{'=' * 70}")

        t0 = time.time()
        runner = _STAGE_RUNNERS[name]

        try:
            kwargs = _build_stage_kwargs(
                name,
                min_score=min_score,
                workers=workers,
                validation_mode=validation_mode,
                limit=limit,
                rescore=rescore,
                retailor=retailor,
            )
            result = runner(**kwargs)
            elapsed = time.time() - t0

            status = "ok"
            if isinstance(result, dict):
                status = result.get("status", "ok")
                if name == "discover":
                    sub_errors = [
                        f"{k}: {v}" for k, v in result.items()
                        if isinstance(v, str) and v.startswith("error")
                    ]
                    if sub_errors:
                        status = "partial"

        except Exception as e:
            elapsed = time.time() - t0
            status = f"error: {e}"
            log.exception("Stage '%s' crashed", name)
            console.print(f"\n  [red]STAGE FAILED:[/red] {e}")

        results.append({"stage": name, "status": status, "elapsed": elapsed})
        if status not in ("ok", "partial"):
            errors[name] = status

        console.print(f"\n  Stage '{name}' completed in {elapsed:.1f}s — {status}")

    total_elapsed = time.time() - pipeline_start
    return {"stages": results, "errors": errors, "elapsed": total_elapsed}


def _run_streaming(ordered: list[str], min_score: int, workers: int = 1,
                   validation_mode: str = "normal", limit: int = 0,
                   rescore: bool = False, retailor: bool = False) -> dict:
    """Execute stages concurrently with DB as conveyor belt."""
    tracker = _StageTracker()
    stop_event = threading.Event()
    pipeline_start = time.time()

    console.print("\n  [bold cyan]STREAMING MODE[/bold cyan] — stages run concurrently")
    console.print(f"  Poll interval: {_STREAM_POLL_INTERVAL}s\n")

    # Mark stages NOT in `ordered` as done so downstream doesn't wait for them
    for stage in STAGE_ORDER:
        if stage not in ordered:
            tracker.mark_done(stage, {"status": "skipped"})

    # Launch each stage in its own thread
    threads: dict[str, threading.Thread] = {}
    start_times: dict[str, float] = {}

    for name in ordered:
        start_times[name] = time.time()
        t = threading.Thread(
            target=_run_stage_streaming,
            args=(name, tracker, stop_event, min_score, workers,
                  validation_mode, limit, rescore, retailor),
            name=f"stage-{name}",
            daemon=True,
        )
        threads[name] = t
        t.start()
        console.print(f"  [dim]Started thread:[/dim] {name}")

    # Wait for all threads to finish
    try:
        for name in ordered:
            threads[name].join()
            elapsed = time.time() - start_times[name]
            console.print(
                f"  [green]Completed:[/green] {name} ({elapsed:.1f}s)"
            )
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted — stopping stages...[/yellow]")
        stop_event.set()
        for t in threads.values():
            t.join(timeout=10)

    total_elapsed = time.time() - pipeline_start

    # Build results from tracker
    all_results = tracker.get_results()
    results: list[dict] = []
    errors: dict[str, str] = {}

    for name in ordered:
        r = all_results.get(name, {"status": "unknown"})
        elapsed = time.time() - start_times.get(name, pipeline_start)
        status = r.get("status", "ok")

        results.append({"stage": name, "status": status, "elapsed": elapsed})
        if status not in ("ok", "partial", "skipped"):
            errors[name] = status

    return {"stages": results, "errors": errors, "elapsed": total_elapsed}


def run_pipeline(
    stages: list[str] | None = None,
    min_score: int = 7,
    dry_run: bool = False,
    stream: bool = False,
    workers: int = 1,
    validation_mode: str = "normal",
    limit: int = 0,
    rescore: bool = False,
    retailor: bool = False,
) -> dict:
    """Run pipeline stages.

    Args:
        stages: List of stage names, or None / ["all"] for full pipeline.
        min_score: Minimum fit score for tailor/cover stages.
        dry_run: If True, preview stages without executing.
        stream: If True, run stages concurrently (streaming mode).
        workers: Number of parallel threads for discovery, enrichment,
            scoring, and tailoring stages.
        validation_mode: Validation strictness for tailor/cover stages.
        limit: Optional per-stage batch limit. 0 means no limit.
        rescore: Re-score already scored jobs when running the score stage.
        retailor: Re-tailor already tailored jobs when running the tailor stage.

    Returns:
        Dict with keys: stages (list of result dicts), errors (dict), elapsed (float).
    """
    # Bootstrap
    load_env()
    ensure_dirs()
    init_db()

    # Resolve stages
    if stages is None:
        stages = ["all"]
    ordered = _resolve_stages(stages)

    if stream and retailor and "tailor" in ordered:
        raise ValueError("--retailor is not supported with --stream because already-tailored jobs never drain.")

    # Banner
    mode = "streaming" if stream else "sequential"
    console.print()
    console.print(Panel.fit(
        f"[bold]JobHunter Pipeline[/bold] ({mode})",
        border_style="blue",
    ))
    console.print(f"  Min score:  {min_score}")
    console.print(f"  Workers:    {workers}")
    console.print(f"  Validation: {validation_mode}")
    if limit > 0:
        console.print(f"  Limit:      {limit}")
    if rescore:
        console.print("  Rescore:    enabled")
    if retailor:
        console.print("  Retailor:   enabled")
    console.print(f"  Stages:     {' -> '.join(ordered)}")

    # Pre-run stats
    pre_stats = get_stats()
    console.print(f"  DB:        {pre_stats['total']} jobs, {pre_stats['pending_detail']} pending enrichment")

    if dry_run:
        console.print(f"\n  [yellow]DRY RUN[/yellow] — would execute ({mode}):")
        for name in ordered:
            meta = STAGE_META[name]
            console.print(f"    {name:<12s}  {meta['desc']}")
        console.print("\n  No changes made.")
        return {"stages": [], "errors": {}, "elapsed": 0.0}

    # Execute
    if stream:
        result = _run_streaming(
            ordered,
            min_score,
            workers=workers,
            validation_mode=validation_mode,
            limit=limit,
            rescore=rescore,
            retailor=retailor,
        )
    else:
        result = _run_sequential(
            ordered,
            min_score,
            workers=workers,
            validation_mode=validation_mode,
            limit=limit,
            rescore=rescore,
            retailor=retailor,
        )

    # Summary table
    console.print(f"\n{'=' * 70}")
    summary = Table(title="Pipeline Summary", show_header=True, header_style="bold")
    summary.add_column("Stage", style="bold")
    summary.add_column("Status")
    summary.add_column("Time", justify="right")

    for r in result["stages"]:
        elapsed_str = f"{r['elapsed']:.1f}s"
        status_display = r["status"][:30]
        if r["status"] == "ok":
            style = "green"
        elif r["status"] in ("partial", "skipped"):
            style = "yellow"
        else:
            style = "red"
        summary.add_row(r["stage"], f"[{style}]{status_display}[/{style}]", elapsed_str)

    summary.add_row("", "", "")
    summary.add_row("[bold]Total[/bold]", "", f"[bold]{result['elapsed']:.1f}s[/bold]")
    console.print(summary)

    # Final DB stats
    final = get_stats()
    console.print("\n  [bold]DB Final State:[/bold]")
    console.print(f"    Total jobs:     {final['total']}")
    console.print(f"    With desc:      {final['with_description']}")
    console.print(f"    Scored:         {final['scored']}")
    console.print(f"    Tailored:       {final['tailored']}")
    console.print(f"    Cover letters:  {final['with_cover_letter']}")
    console.print(f"    Ready to apply: {final['ready_to_apply']}")
    console.print(f"    Applied:        {final['applied']}")
    console.print(f"{'=' * 70}\n")

    return result


# ---------------------------------------------------------------------------
# Single-job processing
# ---------------------------------------------------------------------------

def run_single_job(
    url: str,
    *,
    do_tailor: bool = True,
    do_apply: bool = True,
    validation_mode: str = "normal",
    model: str = "haiku",
    headless: bool = False,
    dry_run: bool = False,
) -> dict:
    """Process a single job by URL: optionally tailor + cover letter, then apply.

    If the job is not yet in the database it will be inserted and enriched
    (full description + application URL scraped) automatically.

    Args:
        url: Job URL.
        do_tailor: Score (if needed), tailor resume, generate cover letter, convert to PDF.
        do_apply: Launch auto-apply for this job.
        validation_mode: Validation strictness for tailor/cover.
        model: Claude model for auto-apply.
        headless: Run Chrome in headless mode for apply.
        dry_run: Preview without executing.

    Returns:
        Dict with keys: url, tailor_status, cover_status, apply_status, errors.
    """
    from datetime import datetime, timezone
    from urllib.parse import urlparse
    import re

    from jobhunter.config import (
        RESUME_PATH, TAILORED_DIR, COVER_LETTER_DIR, load_profile,
    )

    load_env()
    ensure_dirs()
    init_db()

    conn = get_connection()
    row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()

    if row is None:
        # ---- Auto-insert + enrich unknown job URL ----
        console.print("  [cyan]Job not in database — inserting and enriching...[/cyan]")

        # Derive a site label from the hostname
        hostname = urlparse(url).hostname or ""
        _ATS_DOMAINS = {
            "greenhouse.io": "Greenhouse",
            "lever.co": "Lever",
            "ashbyhq.com": "Ashby",
            "myworkdayjobs.com": "Workday",
            "icims.com": "iCIMS",
            "smartrecruiters.com": "SmartRecruiters",
            "jobvite.com": "Jobvite",
            "recruitee.com": "Recruitee",
            "bamboohr.com": "BambooHR",
            "jazz.co": "JazzHR",
        }
        site = "Unknown"
        for domain, label in _ATS_DOMAINS.items():
            if hostname.endswith(domain):
                site = label
                break
        else:
            # Use the first subdomain segment as fallback
            site = hostname.split(".")[0].capitalize() if hostname else "Unknown"

        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO jobs (url, title, site, strategy, discovered_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (url, None, site, "manual", now),
        )
        conn.commit()

        if not dry_run:
            from jobhunter.enrichment.detail import scrape_site_batch

            enrich_stats = scrape_site_batch(
                conn=conn,
                site=site,
                jobs=[(url, "(manual)")],
                delay=0,
            )
            if enrich_stats["ok"] == 0 and enrich_stats["partial"] == 0:
                return {
                    "url": url,
                    "error": "Enrichment failed — could not scrape job description",
                }
        else:
            console.print("  [dim]DRY RUN — would enrich job[/dim]")

        # Re-read after enrichment
        row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()
        if row is None:
            return {"url": url, "error": "Job disappeared after insert"}

        # Infer title from description if still missing
        job_check = dict(row)
        if not job_check.get("title") and job_check.get("full_description"):
            # Use first non-empty line as a rough title
            for line in job_check["full_description"].splitlines():
                line = line.strip()
                if 10 < len(line) < 120:
                    conn.execute("UPDATE jobs SET title = ? WHERE url = ?", (line, url))
                    conn.commit()
                    break
            # Re-read with updated title
            row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()

    job = dict(row)
    result: dict = {"url": url, "title": job.get("title") or "", "errors": []}

    # ------------------------------------------------------------------
    # Tailor flow: enrich (if needed) → score → tailor → cover letter → PDF
    # ------------------------------------------------------------------
    if do_tailor:
        # Enrich if missing full description (job was in DB but never enriched)
        if not job.get("full_description"):
            console.print("  [cyan]Job has no description — enriching...[/cyan]")
            if not dry_run:
                from jobhunter.enrichment.detail import scrape_site_batch

                enrich_stats = scrape_site_batch(
                    conn=conn,
                    site=job.get("site", "Unknown"),
                    jobs=[(url, job.get("title") or "(manual)")],
                    delay=0,
                )
                if enrich_stats["ok"] == 0 and enrich_stats["partial"] == 0:
                    result["error"] = "Enrichment failed — could not scrape job description"
                    return result
                # Re-read
                row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()
                job = dict(row)
            else:
                console.print("  [dim]DRY RUN — would enrich job[/dim]")

        if not dry_run and not job.get("full_description"):
            result["error"] = "Job still has no full description after enrichment"
            return result

        profile = load_profile()
        resume_text = RESUME_PATH.read_text(encoding="utf-8")

        # Score if not yet scored
        if job.get("fit_score") is None:
            console.print("  [cyan]Scoring job...[/cyan]")
            if not dry_run:
                from jobhunter.scoring.scorer import score_job
                score_result = score_job(resume_text, job)
                now = datetime.now(timezone.utc).isoformat()
                reasoning = (
                    f'{score_result.get("keywords", "")}\n'
                    f'{score_result.get("reasoning", "")}'
                )
                conn.execute(
                    "UPDATE jobs SET fit_score=?, score_reasoning=?, scored_at=? WHERE url=?",
                    (score_result["score"], reasoning, now, url),
                )
                conn.commit()
                job["fit_score"] = score_result["score"]
                console.print(f"  Score: [bold]{score_result['score']}[/bold]/10")
            else:
                console.print("  [dim]DRY RUN — would score job[/dim]")

        # Tailor resume
        console.print("  [cyan]Tailoring resume...[/cyan]")
        if not dry_run:
            from jobhunter.scoring.tailor import _tailor_one_job

            TAILORED_DIR.mkdir(parents=True, exist_ok=True)
            tailor_result = _tailor_one_job(job, resume_text, profile, validation_mode)

            now = datetime.now(timezone.utc).isoformat()
            _success = {"approved", "approved_with_judge_warning"}
            if tailor_result["status"] in _success:
                conn.execute(
                    "UPDATE jobs SET tailored_resume_path=?, tailored_at=?, "
                    "tailor_attempts=COALESCE(tailor_attempts,0)+1 WHERE url=?",
                    (tailor_result["path"], now, url),
                )
                job["tailored_resume_path"] = tailor_result["path"]
            else:
                conn.execute(
                    "UPDATE jobs SET tailor_attempts=COALESCE(tailor_attempts,0)+1 WHERE url=?",
                    (url,),
                )
            conn.commit()

            result["tailor_status"] = tailor_result["status"]
            result["tailored_path"] = tailor_result.get("path")
            console.print(f"  Tailor: [bold]{tailor_result['status']}[/bold]")

            if tailor_result["status"] not in _success:
                result["errors"].append(f"Tailor failed: {tailor_result['status']}")
                result["cover_status"] = "blocked_tailor_failed"
                result["apply_status"] = "skipped"
                return result
        else:
            console.print("  [dim]DRY RUN — would tailor resume[/dim]")
            result["tailor_status"] = "dry_run"

        # Cover letter
        console.print("  [cyan]Generating cover letter...[/cyan]")
        if not dry_run:
            from jobhunter.scoring.cover_letter import generate_cover_letter
            from pathlib import Path

            COVER_LETTER_DIR.mkdir(parents=True, exist_ok=True)

            tailored_path = job.get("tailored_resume_path")
            if not tailored_path or not Path(tailored_path).exists():
                result["errors"].append("Cover skipped: tailored resume is missing")
                result["cover_status"] = "blocked_missing_tailored_resume"
                result["apply_status"] = "skipped"
                return result
            cl_resume = Path(tailored_path).read_text(encoding="utf-8")

            try:
                letter = generate_cover_letter(
                    cl_resume, job, profile,
                    validation_mode=validation_mode,
                )
                safe_title = re.sub(r"[^\w\s-]", "", job["title"])[:50].strip().replace(" ", "_")
                safe_site = re.sub(r"[^\w\s-]", "", job.get("site", ""))[:20].strip().replace(" ", "_")
                prefix = f"{safe_site}_{safe_title}"

                cl_path = COVER_LETTER_DIR / f"{prefix}_CL.txt"
                cl_path.write_text(letter, encoding="utf-8")

                # PDF (best-effort)
                try:
                    from jobhunter.scoring.pdf import convert_cover_letter_to_pdf
                    convert_cover_letter_to_pdf(cl_path)
                except Exception:
                    log.debug("Cover letter PDF failed for %s", cl_path, exc_info=True)

                now = datetime.now(timezone.utc).isoformat()
                conn.execute(
                    "UPDATE jobs SET cover_letter_path=?, cover_letter_at=?, "
                    "cover_attempts=COALESCE(cover_attempts,0)+1 WHERE url=?",
                    (str(cl_path), now, url),
                )
                conn.commit()

                result["cover_status"] = "ok"
                result["cover_letter_path"] = str(cl_path)
                console.print("  Cover letter: [bold green]ok[/bold green]")
            except Exception as e:
                conn.execute(
                    "UPDATE jobs SET cover_attempts=COALESCE(cover_attempts,0)+1 WHERE url=?",
                    (url,),
                )
                conn.commit()
                result["cover_status"] = f"error: {e}"
                result["errors"].append(f"Cover letter failed: {e}")
                console.print(f"  Cover letter: [red]error[/red] — {e}")
        else:
            console.print("  [dim]DRY RUN — would generate cover letter[/dim]")
            result["cover_status"] = "dry_run"

    # ------------------------------------------------------------------
    # Apply flow
    # ------------------------------------------------------------------
    if do_apply:
        # Re-read job to pick up any changes from tailoring above
        row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()
        job = dict(row) if row else job

        if not job.get("tailored_resume_path"):
            msg = "Job has no tailored resume — run with --tailor first"
            result["apply_status"] = "skipped"
            result["errors"].append(msg)
            console.print(f"  [red]{msg}[/red]")
        elif not job.get("application_url"):
            msg = "Job has no application URL — run enrichment first"
            result["apply_status"] = "skipped"
            result["errors"].append(msg)
            console.print(f"  [red]{msg}[/red]")
        else:
            console.print("  [cyan]Launching auto-apply...[/cyan]")
            if not dry_run:
                from jobhunter.apply.launcher import main as apply_main
                apply_main(
                    limit=1,
                    target_url=url,
                    min_score=0,  # bypass score filter for targeted apply
                    headless=headless,
                    model=model,
                    dry_run=False,
                    workers=1,
                )
                result["apply_status"] = "launched"
            else:
                console.print("  [dim]DRY RUN — would launch auto-apply[/dim]")
                result["apply_status"] = "dry_run"

    return result
