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
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from jobhunter.config import RESUME_PATH
from jobhunter.database import get_connection, get_jobs_by_stage, load_job_with_enrichment
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.job_content_identity import job_content_fingerprint
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.scoring import LlmPort, ScoreRepository, ScoringPolicyRepository
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.scoring.aggregate import JobScore
from jobhunter.domain.scoring.retrieval import (
    HybridSearchIndex,
    preselect_jobs_for_scoring,
)
from jobhunter.domain.scoring.use_cases import (
    ScoreJobOutcome,
    ScoreJobUseCase,
)
from jobhunter.domain.scoring.value_objects import ScoringCriteria
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.llm import LlmAdapter, get_llm_adapter
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobhunter.infrastructure.profile.factory import get_profile_repository
from jobhunter.infrastructure.scoring import (
    LocalScoringCriteriaProvider,
    SqliteScoreRepository,
    SqliteScoringPolicyRepository,
)
from jobhunter.state import (
    ensure_job_stage_rows,
    reconcile_score_eligibility_blockers,
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
    policy_repository: ScoringPolicyRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = None,
    publisher: EventPublisher | None = None,
) -> ScoreJobUseCase:
    """Construct a ``ScoreJobUseCase`` using local-mode defaults.

    The defaults are deliberately lazy — tests pass explicit fakes for
    every argument, so production code avoids any module-level singletons
    until first use.
    """
    if repository is None:
        conn = get_connection()
        repository = SqliteScoreRepository(conn)
        if policy_repository is None:
            policy_repository = SqliteScoringPolicyRepository(conn)
    elif policy_repository is None and isinstance(repository, SqliteScoreRepository):
        policy_repository = SqliteScoringPolicyRepository(repository.connection)
    if llm_port is None:
        llm_port = (
            LlmAdapter(default_model=llm_model)
            if llm_model
            else get_llm_adapter()
        )
    return ScoreJobUseCase(
        repository=repository,
        llm=llm_port,
        publisher=publisher,
        policy_repository=policy_repository,
    )


# ---------------------------------------------------------------------------
# Public scoring helpers
# ---------------------------------------------------------------------------


def score_job(
    profile_snapshot: ProfileSnapshot,
    job: dict,
    *,
    use_case: ScoreJobUseCase | None = None,
    repository: ScoreRepository | None = None,
    policy_repository: ScoringPolicyRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = None,
    publisher: EventPublisher | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    resume_text: str | None = None,
    criteria: ScoringCriteria | None = None,
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
            policy_repository=policy_repository,
            llm_port=llm_port,
            llm_model=llm_model,
            publisher=publisher,
        )
    return use_case.score(
        job=job,
        profile_snapshot=profile_snapshot,
        tenant_id=tenant_id,
        resume_text=resume_text,
        criteria=criteria,
    )


def run_scoring(
    limit: int = 0,
    rescore: bool = False,
    workers: int = 1,
    *,
    repository: ScoreRepository | None = None,
    policy_repository: ScoringPolicyRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    publisher: EventPublisher | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    profile_snapshot: ProfileSnapshot | None = None,
    resume_text: str | None = None,
    search_index: HybridSearchIndex | None = None,
    criteria: ScoringCriteria | None = None,
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
    if criteria is None:
        criteria = LocalScoringCriteriaProvider().load(profile_snapshot)

    conn = get_connection()
    if repository is None:
        repository = SqliteScoreRepository(conn)
    if policy_repository is None:
        policy_repository = SqliteScoringPolicyRepository(conn)

    use_case = _build_use_case(
        repository=repository,
        policy_repository=policy_repository,
        llm_port=llm_port,
        llm_model=llm_model,
        publisher=publisher,
    )

    source_limit = _retrieval_source_limit(limit)
    if rescore:
        # Phase 7 (S-26 round-1 review H1): bare ``full_description`` is
        # NULL on the new write path; route through ``get_jobs_by_stage``
        # which already COALESCEs over ``job_enrichments``. Use the
        # ``enriched`` selector instead of ``pending_score`` so already-
        # scored rows are included (rescore semantics).
        jobs = get_jobs_by_stage(conn=conn, stage="enriched", limit=source_limit)
    else:
        jobs = get_jobs_by_stage(conn=conn, stage="pending_score", limit=source_limit)

    if not jobs:
        log.info("No unscored jobs with descriptions found.")
        return {"scored": 0, "errors": 0, "elapsed": 0.0, "distribution": []}

    jobs = [
        dict(job)
        for job in preselect_jobs_for_scoring(
            jobs,
            profile_snapshot=profile_snapshot,
            top_k=limit,
            resume_text=resume_text,
            search_index=search_index,
        )
    ]

    worker_count = max(1, workers)
    log.info("Scoring %d jobs with %d worker(s)...", len(jobs), worker_count)

    started_ats: dict[str, str] = {}
    for job in jobs:
        ensure_job_stage_rows(conn, job["url"], discovered_at=job.get("discovered_at"))
        started_at = utc_now()
        started_ats[job["url"]] = started_at
        # Runner owns the restart policy: a job that previously failed
        # scoring is re-selected here, so allow Failed -> Running even
        # though the canonical state machine table only permits Failed ->
        # Pending (via Reset). Skip validation; the writer is the runner.
        set_stage_state(
            conn,
            job["url"],
            "score",
            "running",
            started_at=started_at,
            validate_transition=False,
        )
        record_job_event(conn, job["url"], "score", "StageStarted", message="Scoring started")

    reusable_scores = (
        {}
        if rescore
        else _reusable_scores_by_content_key(
            conn=conn,
            jobs=jobs,
            repository=repository,
            tenant_id=tenant_id,
            criteria=criteria,
            profile_snapshot=profile_snapshot,
        )
    )
    pending_by_key: dict[str, dict[str, Any]] = {}
    duplicate_jobs_by_representative: dict[str, list[dict[str, Any]]] = {}
    jobs_to_compute: list[dict[str, Any]] = []
    reused_results: list[tuple[dict[str, Any], ScoreJobOutcome]] = []
    for job in jobs:
        content_key = _score_content_key(job)
        if content_key is None:
            jobs_to_compute.append(job)
            continue
        reusable_score = reusable_scores.get(content_key)
        if reusable_score is not None:
            try:
                outcome = _persist_reused_score(
                    repository=repository,
                    tenant_id=tenant_id,
                    job=job,
                    source_score=reusable_score,
                )
            except Exception as exc:  # noqa: BLE001 — surface as a stage failure
                log.error("Score reuse failed for %r: %s", job.get("title", "?"), exc)
                outcome = ScoreJobOutcome(
                    ok=False,
                    score=None,
                    error=f"Score reuse failed: {exc}",
                )
            reused_results.append((job, outcome))
            continue
        representative = pending_by_key.get(content_key)
        if representative is None:
            pending_by_key[content_key] = job
            jobs_to_compute.append(job)
            continue
        duplicate_jobs_by_representative.setdefault(representative["url"], []).append(job)

    t0 = time.time()
    results: list[tuple[dict[str, Any], ScoreJobOutcome]] = list(reused_results)
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
                criteria=criteria,
            ): job
            for job in jobs_to_compute
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
            for duplicate_job in duplicate_jobs_by_representative.get(job["url"], ()):
                if outcome.ok and outcome.score is not None:
                    try:
                        duplicate_outcome = _persist_reused_score(
                            repository=repository,
                            tenant_id=tenant_id,
                            job=duplicate_job,
                            source_score=outcome.score,
                        )
                    except Exception as exc:  # noqa: BLE001 — surface as a stage failure
                        log.error(
                            "Score reuse failed for duplicate %r: %s",
                            duplicate_job.get("title", "?"),
                            exc,
                        )
                        duplicate_outcome = ScoreJobOutcome(
                            ok=False,
                            score=None,
                            error=f"Score reuse failed: {exc}",
                        )
                else:
                    duplicate_outcome = ScoreJobOutcome(
                        ok=False,
                        score=None,
                        error=outcome.error or "Scoring failed",
                    )
                results.append((duplicate_job, duplicate_outcome))
            score_value = outcome.score.fit_score.value if outcome.ok and outcome.score else 0
            log.info(
                "[%d/%d] score=%d  %s",
                completed, len(jobs_to_compute), score_value, str(job.get("title", "?"))[:60],
            )

    errors = sum(1 for _, outcome in results if not outcome.ok)

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
            _sync_score_eligibility_stage_state(conn, url, outcome.score, now=finished_at)
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


def score_job_by_url(
    job_url: str,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    rescore: bool = False,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    profile_snapshot: ProfileSnapshot | None = None,
    resume_text: str | None = None,
    criteria: ScoringCriteria | None = None,
    repository: ScoreRepository | None = None,
    policy_repository: ScoringPolicyRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
) -> ScoreJobOutcome:
    """Score exactly one enriched job by URL.

    Internal Discovery preparation uses durable work items keyed to one job,
    so it cannot safely call the batch selector-based ``run_scoring`` helper.
    This entrypoint preserves the same Scoring use case and stage-state writes
    while targeting the claimed work item only. ``rescore=True`` forces a new
    score version even when the job already has a current score.
    """
    conn = get_connection()
    job = load_job_with_enrichment(conn, job_url)
    if job is None:
        return ScoreJobOutcome(ok=False, score=None, error=f"Job not found: {job_url}")
    if not job.get("full_description"):
        return ScoreJobOutcome(ok=False, score=None, error=f"Job is not enriched: {job_url}")

    if profile_snapshot is None:
        profile_snapshot = get_profile_repository().load_snapshot(tenant_id)
    if resume_text is None:
        try:
            resume_text = RESUME_PATH.read_text(encoding="utf-8")
        except FileNotFoundError:
            resume_text = ""
    if criteria is None:
        criteria = LocalScoringCriteriaProvider().load(profile_snapshot)
    if repository is None:
        repository = SqliteScoreRepository(conn)
    if policy_repository is None:
        policy_repository = SqliteScoringPolicyRepository(conn)
    existing = repository.load(tenant_id, JobId(job_url))
    if existing is not None and not rescore:
        _ensure_existing_score_stage_succeeded(
            conn,
            job=job,
            score=existing,
            tenant_id=tenant_id,
        )
        return ScoreJobOutcome(ok=True, score=existing)

    ensure_job_stage_rows(conn, job_url, discovered_at=job.get("discovered_at"))
    started_at = utc_now()
    set_stage_state(
        conn,
        job_url,
        "score",
        "running",
        started_at=started_at,
        validate_transition=False,
    )
    record_job_event(conn, job_url, "score", "StageStarted", message="Scoring started")
    conn.commit()

    outcome = score_job(
        profile_snapshot,
        job,
        use_case=_build_use_case(
            repository=repository,
            policy_repository=policy_repository,
            llm_port=llm_port,
            llm_model=llm_model,
            publisher=publisher,
        ),
        tenant_id=tenant_id,
        resume_text=resume_text,
        criteria=criteria,
    )
    finished_at = utc_now()
    if outcome.ok and outcome.score is not None:
        set_stage_state(
            conn,
            job_url,
            "score",
            "succeeded",
            attempt_count=1,
            started_at=started_at,
            finished_at=finished_at,
        )
        record_job_event(
            conn,
            job_url,
            "score",
            "StageCompleted",
            message=f"Fit score {outcome.score.fit_score.value}/10",
            payload={"keywords": list(outcome.score.matched_keywords)},
        )
        _sync_score_eligibility_stage_state(conn, job_url, outcome.score, now=finished_at)
    else:
        set_stage_state(
            conn,
            job_url,
            "score",
            "failed",
            attempt_count=1,
            started_at=started_at,
            finished_at=finished_at,
            error_code="SCORE_FAILED",
            error_message=outcome.error or "Scoring failed",
            retryable=True,
            next_action=f"jobhunter retry score {job_url}",
            validate_transition=False,
        )
        record_job_event(
            conn,
            job_url,
            "score",
            "StageFailed",
            level="error",
            message=outcome.error or "Scoring failed",
        )
    conn.commit()
    return outcome


def _ensure_existing_score_stage_succeeded(
    conn: sqlite3.Connection,
    *,
    job: dict[str, Any],
    score: JobScore,
    tenant_id: TenantId,
) -> None:
    job_url = str(score.job_id)
    if _has_unresolved_score_staleness(conn, tenant_id=tenant_id, job_url=job_url):
        return

    ensure_job_stage_rows(conn, job_url, discovered_at=job.get("discovered_at"))
    row = conn.execute(
        "SELECT state, started_at, attempt_count "
        "FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
        (job_url,),
    ).fetchone()
    state = _row_value(row, "state", 0)
    if state == "succeeded":
        _sync_score_eligibility_stage_state(conn, job_url, score)
        conn.commit()
        return

    finished_at = utc_now()
    started_at = _row_value(row, "started_at", 1) or finished_at
    attempt_count = max(int(_row_value(row, "attempt_count", 2) or 0), 1)
    set_stage_state(
        conn,
        job_url,
        "score",
        "succeeded",
        attempt_count=attempt_count,
        started_at=str(started_at),
        finished_at=finished_at,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_url,
        "score",
        "StageCompleted",
        message=f"Fit score {score.fit_score.value}/10",
        payload={"keywords": list(score.matched_keywords)},
    )
    _sync_score_eligibility_stage_state(conn, job_url, score, now=finished_at)
    conn.commit()


def _sync_score_eligibility_stage_state(
    conn: sqlite3.Connection,
    job_url: str,
    score: JobScore,
    *,
    now: str | None = None,
) -> None:
    eligibility = score.breakdown.eligibility
    reconcile_score_eligibility_blockers(
        conn,
        job_url=job_url,
        eligibility_status=eligibility.status,
        hard_blockers=list(eligibility.hard_blockers),
        now=now,
    )


def _has_unresolved_score_staleness(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_url: str,
) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM job_score_staleness
        WHERE tenant_id = ?
          AND job_url = ?
          AND resolved = 0
        LIMIT 1
        """,
        (str(tenant_id), job_url),
    ).fetchone()
    return row is not None


def _row_value(row: Any, key: str, index: int) -> Any:
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return row[key]
    return row[index]


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


def _retrieval_source_limit(limit: int) -> int:
    """Fetch a broader pool when scoring is capped, then let retrieval choose."""

    if limit <= 0:
        return 0
    return max(limit * 5, 50)


def _score_content_key(job: dict[str, Any]) -> str | None:
    return job_content_fingerprint(
        title=job.get("title"),
        company=job.get("company"),
        description=job.get("full_description"),
        description_limit=6000,
    )


def _reusable_scores_by_content_key(
    *,
    conn: sqlite3.Connection,
    jobs: list[dict[str, Any]],
    repository: ScoreRepository,
    tenant_id: TenantId,
    criteria: ScoringCriteria,
    profile_snapshot: ProfileSnapshot,
) -> dict[str, JobScore]:
    wanted_keys = {key for job in jobs if (key := _score_content_key(job)) is not None}
    if not wanted_keys:
        return {}
    rows = conn.execute(
        """
        SELECT j.url, j.title, j.company,
               COALESCE(je.full_description, j.full_description) AS full_description
        FROM jobs j
        LEFT JOIN job_enrichments je ON je.job_url = j.url
        INNER JOIN (
            SELECT s.job_url, MAX(s.version) AS max_version
            FROM job_scores s
            WHERE s.tenant_id = ?
            GROUP BY s.job_url
        ) latest ON latest.job_url = j.url
        INNER JOIN job_scores s
            ON s.job_url = latest.job_url
           AND s.version = latest.max_version
           AND s.tenant_id = ?
        ORDER BY s.scored_at DESC
        """,
        (str(tenant_id), str(tenant_id)),
    ).fetchall()

    reusable: dict[str, JobScore] = {}
    for row in rows:
        job = dict(row)
        key = _score_content_key(job)
        if key is None or key not in wanted_keys or key in reusable:
            continue
        score = repository.load(tenant_id, JobId(str(job["url"])))
        if score is None or not _score_matches_context(
            score=score,
            criteria=criteria,
            profile_snapshot=profile_snapshot,
        ):
            continue
        reusable[key] = score
    return reusable


def _score_matches_context(
    *,
    score: JobScore,
    criteria: ScoringCriteria,
    profile_snapshot: ProfileSnapshot,
) -> bool:
    if score.trace.criteria_version != criteria.criteria_version:
        return False
    if score.trace.profile_snapshot_version != profile_snapshot.version:
        return False
    return True


def _persist_reused_score(
    *,
    repository: ScoreRepository,
    tenant_id: TenantId,
    job: dict[str, Any],
    source_score: JobScore,
) -> ScoreJobOutcome:
    job_id = JobId(str(job["url"]))
    previous = repository.load(tenant_id, job_id)
    scored_at = utc_now()
    if previous is None:
        copied = JobScore.initial(
            tenant_id=tenant_id,
            job_id=job_id,
            fit_score=source_score.fit_score,
            breakdown=source_score.breakdown,
            matched_keywords=source_score.matched_keywords,
            scored_at=scored_at,
            criteria=source_score.criteria,
            trace=source_score.trace,
        )
    else:
        copied = previous.next_version(
            fit_score=source_score.fit_score,
            breakdown=source_score.breakdown,
            matched_keywords=source_score.matched_keywords,
            scored_at=scored_at,
            criteria=source_score.criteria,
            trace=source_score.trace,
        )
    repository.save(copied)
    return ScoreJobOutcome(ok=True, score=copied)


# ---------------------------------------------------------------------------
# Re-exports for backwards-compatible imports
# ---------------------------------------------------------------------------


# Older test fixtures and pipeline modules may still import these symbols
# directly; keep them visible so the refactor doesn't break unrelated
# callers. The canonical home is the use case module.
from jobhunter.domain.scoring.use_cases import SCORE_PROMPT  # noqa: E402,F401
