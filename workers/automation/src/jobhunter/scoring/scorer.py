"""Job fit scoring runner — wires the Scoring use case into the worker.

See ddd-target.md §3.4 / §4.4 / §5.4. After Phase 5 the scorer is a thin
adapter around ``ScoreJobUseCase`` (`domain/scoring/use_cases.py`):

  * Domain logic (parsing, aggregate construction, version bumping) lives
    in the use case + ``ScoreParser`` / ``JobScore``.
  * Persistence goes through ``ScoreRepository`` — the legacy
    ``UPDATE jobs SET fit_score = …`` writes are GONE per the
    no-strangler directive. Readers fall back to ``jobs.fit_score`` only
    for historical rows that were never re-scored after the backfill.
  * The LLM call is mediated by ``LlmPort`` so the cloud LLM gateway
    swap-out (Phase 9) is a constructor-only change.

The module preserves the public surface ``run_scoring`` and ``score_job``
so existing callers (``pipeline.py``) continue to work; their internals
now run on top of the new use case.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from jobhunter.config import RESUME_PATH
from jobhunter.database import get_connection, get_jobs_by_stage
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.scoring import LlmPort, ScoreRepository
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.scoring.use_cases import (
    ScoreJobOutcome,
    ScoreJobUseCase,
)
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.llm import get_llm_adapter
from jobhunter.infrastructure.profile.factory import get_profile_repository
from jobhunter.infrastructure.scoring import SqliteScoreRepository
from jobhunter.state import (
    ensure_job_stage_rows,
    record_job_event,
    set_stage_state,
    utc_now,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Use-case construction (DI seam)
# ---------------------------------------------------------------------------


def _build_use_case(
    *,
    repository: ScoreRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
) -> ScoreJobUseCase:
    """Construct a ``ScoreJobUseCase`` using local-mode defaults.

    The defaults are deliberately lazy — tests pass explicit fakes for
    every argument, so production code avoids any module-level singletons
    until first use.
    """
    if repository is None:
        repository = SqliteScoreRepository(get_connection())
    if llm_port is None:
        llm_port = get_llm_adapter()
    return ScoreJobUseCase(repository=repository, llm=llm_port, publisher=publisher)


# ---------------------------------------------------------------------------
# Public scoring helpers
# ---------------------------------------------------------------------------


def score_job(
    profile_snapshot: ProfileSnapshot,
    job: dict,
    *,
    use_case: ScoreJobUseCase | None = None,
    repository: ScoreRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    resume_text: str | None = None,
) -> ScoreJobOutcome:
    """Score a single job and persist the result.

    The signature changed in Phase 5: the first positional argument is now
    a ``ProfileSnapshot`` (was ``resume_text: str``). Callers that still
    have the raw resume text on hand can pass it via ``resume_text=…`` —
    the use case will use it instead of the snapshot's baseline.
    """
    if use_case is None:
        use_case = _build_use_case(
            repository=repository,
            llm_port=llm_port,
            publisher=publisher,
        )
    return use_case.score(
        job=job,
        profile_snapshot=profile_snapshot,
        tenant_id=tenant_id,
        resume_text=resume_text,
    )


def run_scoring(
    limit: int = 0,
    rescore: bool = False,
    workers: int = 1,
    *,
    repository: ScoreRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    profile_snapshot: ProfileSnapshot | None = None,
    resume_text: str | None = None,
) -> dict:
    """Score unscored jobs that have full descriptions.

    Each job is processed inside a ``ThreadPoolExecutor`` task; the LLM
    call happens in the worker thread, then results are written back to
    the repository on the main thread (sqlite connections are not
    thread-safe across statements). Stage state and events still flow
    through ``state.py`` so the dashboard observability remains intact.
    """
    if profile_snapshot is None:
        profile_snapshot = get_profile_repository().load_snapshot(tenant_id)
    if resume_text is None:
        try:
            resume_text = RESUME_PATH.read_text(encoding="utf-8")
        except FileNotFoundError:
            resume_text = ""

    conn = get_connection()
    if repository is None:
        repository = SqliteScoreRepository(conn)

    use_case = _build_use_case(
        repository=repository,
        llm_port=llm_port,
        publisher=publisher,
    )

    if rescore:
        query = "SELECT * FROM jobs WHERE full_description IS NOT NULL"
        if limit > 0:
            query += f" LIMIT {limit}"
        rows = conn.execute(query).fetchall()
        jobs = [dict(zip(row.keys(), row)) for row in rows]
    else:
        jobs = get_jobs_by_stage(conn=conn, stage="pending_score", limit=limit)

    if not jobs:
        log.info("No unscored jobs with descriptions found.")
        return {"scored": 0, "errors": 0, "elapsed": 0.0, "distribution": []}

    worker_count = max(1, workers)
    log.info("Scoring %d jobs with %d worker(s)...", len(jobs), worker_count)

    started_ats: dict[str, str] = {}
    for job in jobs:
        ensure_job_stage_rows(conn, job["url"], discovered_at=job.get("discovered_at"))
        started_at = utc_now()
        started_ats[job["url"]] = started_at
        set_stage_state(conn, job["url"], "score", "running", started_at=started_at)
        record_job_event(conn, job["url"], "score", "StageStarted", message="Scoring started")

    t0 = time.time()
    results: list[tuple[dict[str, Any], ScoreJobOutcome]] = []
    errors = 0

    # Worker threads run the LLM step only — the SQLite connection is not
    # safe to share across threads. Persistence happens below on the main
    # thread once each parse comes back.
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_job = {
            executor.submit(
                use_case.compute,
                job=job,
                profile_snapshot=profile_snapshot,
                resume_text=resume_text,
            ): job
            for job in jobs
        }
        for completed, future in enumerate(as_completed(future_to_job), start=1):
            job = future_to_job[future]
            try:
                parse = future.result()
            except Exception as exc:  # noqa: BLE001 — recorded as a stage failure below
                log.error("Unhandled scoring error for %r: %s", job.get("title", "?"), exc)
                outcome = ScoreJobOutcome(ok=False, score=None, error=f"Unhandled error: {exc}")
            else:
                try:
                    outcome = use_case.persist_outcome(
                        job=job, parse=parse, tenant_id=tenant_id,
                    )
                except Exception as exc:  # noqa: BLE001 — surface as a stage failure
                    log.error("Score persistence failed for %r: %s", job.get("title", "?"), exc)
                    outcome = ScoreJobOutcome(
                        ok=False,
                        score=None,
                        error=f"Score persistence failed: {exc}",
                    )

            results.append((job, outcome))
            if not outcome.ok:
                errors += 1
            score_value = outcome.score.fit_score.value if outcome.ok and outcome.score else 0
            log.info(
                "[%d/%d] score=%d  %s",
                completed, len(jobs), score_value, str(job.get("title", "?"))[:60],
            )

    finished_at = utc_now()
    for job, outcome in results:
        url = job["url"]
        if outcome.ok and outcome.score is not None:
            set_stage_state(
                conn,
                url,
                "score",
                "succeeded",
                attempt_count=1,
                started_at=started_ats.get(url),
                finished_at=finished_at,
            )
            record_job_event(
                conn,
                url,
                "score",
                "StageCompleted",
                message=f"Fit score {outcome.score.fit_score.value}/10",
                payload={"keywords": list(outcome.score.matched_keywords)},
            )
        else:
            set_stage_state(
                conn,
                url,
                "score",
                "failed",
                attempt_count=1,
                started_at=started_ats.get(url),
                finished_at=finished_at,
                error_code="SCORE_FAILED",
                error_message=outcome.error or "Scoring failed",
                retryable=True,
                next_action=f"jobhunter retry score {url}",
            )
            record_job_event(
                conn,
                url,
                "score",
                "StageFailed",
                level="error",
                message=outcome.error or "Scoring failed",
            )
    conn.commit()

    elapsed = time.time() - t0
    log.info(
        "Done: %d scored in %.1fs (%.1f jobs/sec)",
        len(results), elapsed, len(results) / elapsed if elapsed > 0 else 0,
    )

    distribution = _score_distribution(repository, tenant_id)
    return {
        "scored": len(results),
        "errors": errors,
        "elapsed": elapsed,
        "distribution": distribution,
    }


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _score_distribution(
    repository: ScoreRepository,
    tenant_id: TenantId,
) -> list[tuple[int, int]]:
    """Return a (fit_score, count) histogram from the repository.

    Reads through the repository's ``list_by_score_range`` so the read
    path stays portable between local and cloud adapters. Bucket-zero is
    intentionally omitted — ``FitScore`` cannot be zero.
    """
    counts: dict[int, int] = {}
    for score in repository.list_by_score_range(tenant_id, min_score=1, max_score=10):
        counts[score.fit_score.value] = counts.get(score.fit_score.value, 0) + 1
    # Match the legacy distribution shape: highest score first.
    return sorted(counts.items(), key=lambda kv: kv[0], reverse=True)


# ---------------------------------------------------------------------------
# Re-exports for backwards-compatible imports
# ---------------------------------------------------------------------------


# Older test fixtures and pipeline modules may still import these symbols
# directly; keep them visible so the refactor doesn't break unrelated
# callers. The canonical home is the use case module.
from jobhunter.domain.scoring.use_cases import SCORE_PROMPT  # noqa: E402,F401
