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
from typing import Any, Mapping, Protocol
from contextlib import contextmanager

from jobctrl.config import RESUME_PATH
from jobctrl.database import effective_tailoring_min_score, get_connection, get_jobs_by_stage
from jobctrl.domain.determinations import DeterminationFailure, serialized_determination_failure
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    EmployerAnalysis,
    EnsembleError,
    compute_snapshot_hash,
)
from jobctrl.domain.job_snapshot import build_jd_snapshot
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.ports.materials import EmployerAnalysisRepository
from jobctrl.domain.ports.scoring import (
    LlmPort,
    RequirementFitReportRepository,
    ScoreRepository,
    ScoringPolicyRepository,
)
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.scoring.aggregate import JobScore
from jobctrl.domain.scoring.eligibility import eligibility_blocks_downstream
from jobctrl.domain.scoring.retrieval import (
    preselect_jobs_for_scoring,
)
from jobctrl.domain.scoring.use_cases import (
    ScoreJobOutcome,
    ScoreJobUseCase,
)
from jobctrl.domain.scoring.value_objects import ScoringCriteria
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobctrl.infrastructure.discovery import SqliteJobIdentityResolver
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC
from jobctrl.infrastructure.profile.factory import get_profile_repository
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
from jobctrl.infrastructure.preparation_recovery import stage_completed_by_activity_owner
from jobctrl.infrastructure.scoring import (
    LocalScoringCriteriaProvider,
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
    SqliteScoringPolicyRepository,
)
from jobctrl.state import (
    ensure_job_stage_rows,
    reconcile_score_threshold_skips,
    reconcile_score_eligibility_blockers,
    record_job_event,
    set_stage_state,
    utc_now,
)
from jobctrl.scoring.employer_analysis import build_analyze_use_case

log = logging.getLogger(__name__)


def _employer_analysis_failure_message(exc: Exception) -> str:
    """Describe an all-leg failure without persisting raw model output."""

    failure = exc.determination_failure if isinstance(exc, EnsembleError) else exc
    if isinstance(failure, DeterminationFailure):
        return str(failure)
    if not isinstance(exc, EnsembleError):
        return f"Employer analysis failed: {exc}"
    leg_failures = []
    for failure in exc.failures:
        error_kind = failure.error.partition(":")[0].strip() or "Error"
        leg_failures.append(f"{failure.model_id}: {error_kind}")
    detail = "; ".join(leg_failures)
    suffix = f" ({detail})" if detail else ""
    return f"Employer analysis failed: all ensemble legs failed{suffix}"


class AnalyzeJobUseCaseLike(Protocol):
    """Small protocol for the canonical employer-analysis front-half step."""

    def execute(
        self,
        *,
        job: dict,
        tenant_id: TenantId = LOCAL_TENANT,
        force: bool = False,
    ) -> Any: ...


# ---------------------------------------------------------------------------
# Use-case construction (DI seam)
# ---------------------------------------------------------------------------


def _build_use_case(
    *,
    tenant_id: TenantId = LOCAL_TENANT,
    repository: ScoreRepository | None = None,
    policy_repository: ScoringPolicyRepository | None = None,
    requirement_fit_repository: RequirementFitReportRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = None,
    publisher: EventPublisher | None = None,
    determination_dependencies=None,
    job_interpretation_reader=None,
    confirmed_preferences_reader=None,
    exact_title_exclusions: tuple[str, ...] | None = None,
) -> ScoreJobUseCase:
    """Construct a ``ScoreJobUseCase`` using local-mode defaults.

    The defaults are deliberately lazy — tests pass explicit fakes for
    every argument, so production code avoids any module-level singletons
    until first use.
    """
    # Default product wiring uses persisted canonical interpretation; injected
    # reader/dependency ports are explicit seams and need their own validation.
    canonical_source_reader = determination_dependencies is None and job_interpretation_reader is None
    if canonical_source_reader and isinstance(repository, _OwnedScoreRepository):
        repository.require_canonical_inputs = True
    if repository is None:
        conn = get_connection()
        repository = SqliteScoreRepository(conn)
        if policy_repository is None:
            policy_repository = SqliteScoringPolicyRepository(conn)
        if requirement_fit_repository is None:
            requirement_fit_repository = SqliteRequirementFitReportRepository(conn)
    elif isinstance(repository, SqliteScoreRepository):
        if policy_repository is None:
            policy_repository = SqliteScoringPolicyRepository(repository.connection)
        if requirement_fit_repository is None:
            requirement_fit_repository = SqliteRequirementFitReportRepository(repository.connection)
    if determination_dependencies is None:
        from jobctrl.infrastructure.determinations import (
            determination_dependencies as resolve_dependencies,
            ThreadLocalDeterminationRepository,
        )
        from jobctrl.infrastructure.enrichment.interpretation import read_job_interpretation
        from pathlib import Path

        conn = repository.connection if isinstance(repository, SqliteScoreRepository) else get_connection()
        dependencies = resolve_dependencies(
            conn, tenant_id=tenant_id, lane="scoring", model_spec=llm_model, adapter=llm_port
        )
        path = conn.execute("PRAGMA database_list").fetchone()[2]
        durable_repository = ThreadLocalDeterminationRepository(Path(path)) if path else dependencies["repository"]
        dependencies["repository"] = durable_repository
        determination_dependencies = dependencies

        def read_interpretation(job):
            result = read_job_interpretation(
                durable_repository.connection if path else conn, job, tenant_id=str(job["tenant_id"])
            )
            return result[0] if result is not None else None

        if job_interpretation_reader is None:
            job_interpretation_reader = read_interpretation
    if confirmed_preferences_reader is None:
        from jobctrl.domain.profile.search_targets import snapshot_target_sources

        from jobctrl import config

        exact_exclusions = (
            config.load_scoring_exact_title_exclusions()
            if exact_title_exclusions is None else exact_title_exclusions
        )
        def confirmed_preferences_reader(snapshot, criteria):
            return snapshot_target_sources(snapshot, criteria, exact_title_exclusions=exact_exclusions)
    llm_port = determination_dependencies["llm"]
    return ScoreJobUseCase(
        repository=repository,
        llm=llm_port,
        determination_dependencies=determination_dependencies,
        job_interpretation_reader=job_interpretation_reader,
        confirmed_preferences_reader=confirmed_preferences_reader,
        publisher=publisher,
        policy_repository=policy_repository,
        requirement_fit_repository=requirement_fit_repository,
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
    requirement_fit_repository: RequirementFitReportRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = None,
    publisher: EventPublisher | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    resume_text: str | None = None,
    criteria: ScoringCriteria | None = None,
    employer_analysis: EmployerAnalysis | None = None,
    employer_analysis_repository: EmployerAnalysisRepository | None = None,
    analyze_use_case: AnalyzeJobUseCaseLike | None = None,
    require_employer_analysis: bool = False,
    previous_score: JobScore | None = None,
) -> ScoreJobOutcome:
    """Score a single job and persist the result.

    The signature changed in Phase 5: the first positional argument is now
    a ``ProfileSnapshot`` (was ``resume_text: str``). Callers that still
    have the raw resume text on hand can pass it via ``resume_text=…`` —
    the use case will use it instead of the snapshot's baseline.
    """
    if use_case is None:
        use_case = _build_use_case(
            tenant_id=tenant_id,
            repository=repository,
            policy_repository=policy_repository,
            requirement_fit_repository=requirement_fit_repository,
            llm_port=llm_port,
            llm_model=llm_model,
            publisher=publisher,
        )
    if employer_analysis is None and (
        employer_analysis_repository is not None or analyze_use_case is not None or require_employer_analysis
    ):
        conn = _analysis_connection_for_repository(repository)
        if employer_analysis_repository is None:
            employer_analysis_repository = SqliteEmployerAnalysisRepository(conn)
        if analyze_use_case is None and require_employer_analysis:
            analyze_use_case = build_analyze_use_case(
                conn=conn,
                tenant_id=tenant_id,
                publisher=publisher,
                event_stage="score",
                # Score resolves the analysis before EVERY fresh score; cache
                # hits must not append duplicate job_events timeline rows.
                record_cached_hits=False,
            )
        employer_analysis = _ensure_employer_analysis_for_job(
            repository=employer_analysis_repository,
            analyze_use_case=analyze_use_case,
            tenant_id=tenant_id,
            job=job,
            require=require_employer_analysis,
        )
    # Freeze the canonical inputs on the owning connection before provider I/O.
    # The publication fence compares them under the same writer lock used for
    # the replacement score; changes do not retroactively alter the admitted
    # immutable profile snapshot.
    publication_repository = getattr(use_case, "_repository", None)
    capture_inputs = getattr(publication_repository, "capture_scoring_inputs", None)
    if callable(capture_inputs):
        current_policy_repository = policy_repository or getattr(use_case, "_policy_repository", None)
        if current_policy_repository is not None:
            current_policy_repository.get_current(tenant_id)
        job = {**job, "_score_publication_inputs": capture_inputs(job)}
    return use_case.score(
        job=job,
        profile_snapshot=profile_snapshot,
        tenant_id=tenant_id,
        resume_text=resume_text,
        criteria=criteria,
        employer_analysis=employer_analysis,
        **({"previous_score": previous_score} if previous_score is not None else {}),
    )


def run_scoring(
    limit: int = 0,
    rescore: bool = False,
    workers: int = 1,
    *,
    repository: ScoreRepository | None = None,
    policy_repository: ScoringPolicyRepository | None = None,
    requirement_fit_repository: RequirementFitReportRepository | None = None,
    llm_port: LlmPort | None = None,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    publisher: EventPublisher | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    profile_snapshot: ProfileSnapshot | None = None,
    resume_text: str | None = None,
    criteria: ScoringCriteria | None = None,
    employer_analyses_by_job: Mapping[str, EmployerAnalysis] | None = None,
    employer_analysis_repository: EmployerAnalysisRepository | None = None,
    analyze_use_case: AnalyzeJobUseCaseLike | None = None,
    require_employer_analysis: bool = True,
    workflow_id: str | None = None,
    cancel_event: Any | None = None,
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
    if requirement_fit_repository is None and isinstance(repository, SqliteScoreRepository):
        requirement_fit_repository = SqliteRequirementFitReportRepository(repository.connection)
    # Global sweeps must use the same publication fence as selected scoring.
    repository = _OwnedScoreRepository(repository, conn, workflow_id, cancel_event)
    if employer_analysis_repository is None:
        employer_analysis_repository = SqliteEmployerAnalysisRepository(conn)
    if analyze_use_case is None and require_employer_analysis:
        analyze_use_case = build_analyze_use_case(
            conn=conn,
            tenant_id=tenant_id,
            publisher=publisher,
            event_stage="score",
            # Score resolves the analysis before EVERY fresh score; cache
            # hits must not append duplicate job_events timeline rows.
            record_cached_hits=False,
        )

    use_case = _build_use_case(
        tenant_id=tenant_id,
        repository=repository,
        policy_repository=policy_repository,
        requirement_fit_repository=requirement_fit_repository,
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
        return {"scored": 0, "errors": 0, "elapsed": 0.0, "distribution": [], "scoredJobIds": []}

    jobs = [
        dict(job)
        for job in preselect_jobs_for_scoring(
            jobs,
            top_k=limit,
        )
    ]
    if workflow_id:
        jobs = [
            job
            for job in jobs
            if not stage_completed_by_activity_owner(
                conn,
                tenant_id=str(tenant_id),
                job_id=str(canonical_job_id(str(job["job_id"]))),
                stage="score",
                workflow_id=workflow_id,
            )
        ]
    if not jobs:
        return {"scored": 0, "errors": 0, "elapsed": 0.0, "distribution": [], "scoredJobIds": []}

    worker_count = max(1, workers)
    log.info("Scoring %d jobs with %d worker(s)...", len(jobs), worker_count)

    conn.commit()
    from jobctrl.enrichment.availability import require_preparation_available
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

    ownership_skipped: set[str] = set()
    available_jobs = []
    availability_deferred = 0
    for job in jobs:
        try:
            _assert_direct_score_admission(conn, tenant_id, job["job_id"], workflow_id, cancel_event)
        except PreparationReservationLost:
            ownership_skipped.add(str(job["job_id"]))
            continue
        try:
            require_preparation_available(
                str(job["job_id"]),
                tenant_id=str(tenant_id),
                conn=conn,
                expected_posting_url=job["url"],
            )
        except Exception as exc:
            log.info("Scoring deferred for %s: %s", job["job_id"], exc)
            availability_deferred += 1
        else:
            available_jobs.append(job)
    jobs = available_jobs
    started_ats: dict[str, str] = {}
    activity_metadata: dict[str, dict[str, object]] = {}
    from jobctrl.infrastructure.preparation_recovery import claim_preparation_reservation
    from jobctrl.domain.errors import MissingInputError

    claimed_jobs = []
    for job in jobs:
        try:
            with claim_preparation_reservation(
                conn,
                tenant_id=tenant_id,
                job_id=job["job_id"],
                stage="score",
                workflow_id=None,
                cancel_event=cancel_event,
                expected_posting_url=job["url"],
            ):
                job_id = canonical_job_id(str(job["job_id"]))
                _assert_direct_score_admission(conn, tenant_id, job_id, workflow_id, cancel_event)
                ensure_job_stage_rows(
                    conn,
                    job_id,
                    tenant_id=tenant_id,
                    discovered_at=job.get("discovered_at"),
                )
                started_at = utc_now()
                started_ats[job["url"]] = started_at
                # Runner owns the restart policy: a job that previously failed
                # scoring is re-selected here, so allow Failed -> Running even
                # though the canonical state machine table only permits Failed ->
                # Pending (via Reset). Skip validation; the writer is the runner.
                metadata = _score_activity_metadata(
                    conn,
                    tenant_id=tenant_id,
                    job_id=job_id,
                    workflow_id=workflow_id,
                    rescore=rescore,
                )
                activity_metadata[str(job_id)] = metadata or {}
                set_stage_state(
                    conn,
                    job_id,
                    "score",
                    "running",
                    tenant_id=tenant_id,
                    # Preserve the attempt counter across re-selection — see
                    # _score_attempt_count; a bare running write would reset it to 0.
                    attempt_count=_score_attempt_count(
                        conn,
                        tenant_id=tenant_id,
                        job_id=job_id,
                    ),
                    started_at=started_at,
                    metadata=metadata,
                    validate_transition=False,
                )
                record_job_event(
                    conn,
                    job_id,
                    "score",
                    "StageStarted",
                    tenant_id=tenant_id,
                    message="Scoring started",
                )
        except PreparationReservationLost:
            ownership_skipped.add(str(job["job_id"]))
            continue
        except MissingInputError:
            availability_deferred += 1
            continue
        claimed_jobs.append(job)
    jobs = claimed_jobs

    # A score determination and requirement report are bound to one canonical
    # job. Similar posting text does not authorize copying another job's
    # accepted decision or allow its report to be reused. Score each claimed
    # target through its own source-bound determination.
    jobs_to_compute = jobs

    t0 = time.time()
    results: list[tuple[dict[str, Any], ScoreJobOutcome]] = []
    errors = 0
    conn.commit()
    analyses_by_job: dict[str, EmployerAnalysis] = {}
    analysis_ready_jobs: list[dict[str, Any]] = []
    for job in jobs_to_compute:
        if cancel_event is not None and cancel_event.is_set():
            ownership_skipped.add(str(job["job_id"]))
            continue
        job_url = str(job.get("url") or "")
        try:
            analysis = _ensure_employer_analysis_for_job(
                repository=employer_analysis_repository,
                analyze_use_case=analyze_use_case,
                tenant_id=tenant_id,
                job=job,
                existing=(employer_analyses_by_job or {}).get(job_url),
                require=require_employer_analysis,
            )
        except Exception as exc:  # noqa: BLE001 -- surface as a stage failure
            log.error("Employer analysis failed for %r: %s", job.get("title", "?"), exc)
            outcome = ScoreJobOutcome(
                ok=False,
                score=None,
                error=_employer_analysis_failure_message(exc),
            )
            results.append((job, outcome))
            continue
        if analysis is not None:
            analyses_by_job[job_url] = analysis
        analysis_ready_jobs.append(job)
    jobs_to_compute = analysis_ready_jobs

    # Worker threads run the LLM step only — the SQLite connection is not
    # safe to share across threads. Persistence happens below on the main
    # thread once each parse comes back.
    def compute_if_active(**kwargs):
        if cancel_event is not None and cancel_event.is_set():
            raise PreparationReservationLost("Score activity canceled before inference")
        return use_case.compute(**kwargs)

    previous_scores = {
        str(job["job_id"]): repository.load(tenant_id, canonical_job_id(str(job["job_id"])))
        for job in jobs_to_compute
    } if rescore else {}
    current_policy = policy_repository.get_current(tenant_id)
    capture_staleness = getattr(repository, "capture_staleness_for_score", None)
    jobs_to_compute = [
        {**job, "_score_publication_inputs": repository.capture_scoring_inputs(job),
         **({"_score_staleness_snapshot": capture_staleness(
             tenant_id, canonical_job_id(str(job["job_id"])),
         )} if callable(capture_staleness) else {})}
        for job in jobs_to_compute
    ]
    previous_scores = {key: score for key, score in previous_scores.items() if score is not None
        and score.trace.scoring_policy_version == current_policy.version}
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_job = {
            executor.submit(
                compute_if_active,
                job=job,
                profile_snapshot=profile_snapshot,
                tenant_id=tenant_id,
                resume_text=resume_text,
                criteria=criteria,
                employer_analysis=analyses_by_job.get(str(job.get("url") or "")),
                **({"previous_score": previous_scores[str(job["job_id"])]}
                   if str(job["job_id"]) in previous_scores else {}),
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
                        job=job,
                        parse=parse,
                        tenant_id=tenant_id,
                    )
                except PreparationReservationLost:
                    ownership_skipped.add(str(job["job_id"]))
                    outcome = None
                except Exception as exc:  # noqa: BLE001 — surface as a stage failure
                    log.error("Score persistence failed for %r: %s", job.get("title", "?"), exc)
                    outcome = ScoreJobOutcome(
                        ok=False,
                        score=None,
                        error=f"Score persistence failed: {exc}",
                    )

            if outcome is not None:
                results.append((job, outcome))
            score_value = outcome.score.fit_score.value if outcome and outcome.ok and outcome.score else 0
            log.info(
                "[%d/%d] score=%d  %s",
                completed,
                len(jobs_to_compute),
                score_value,
                str(job.get("title", "?"))[:60],
            )

    finished_at = utc_now()
    committed_results: list[tuple[dict[str, Any], ScoreJobOutcome]] = []
    for job, outcome in results:
        metadata = activity_metadata.get(str(job["job_id"]))
        if outcome.ok and outcome.score is not None:
            recorded = _record_score_stage_succeeded(
                conn, job=job, score=outcome.score, tenant_id=tenant_id,
                started_at=started_ats.get(job["url"]), finished_at=finished_at,
                metadata=metadata, require_ownership=True, cancel_event=cancel_event,
                retained=outcome.retained,
            )
        else:
            recorded = _record_score_stage_failed(
                conn, job=job, tenant_id=tenant_id,
                started_at=started_ats.get(job["url"]) or finished_at,
                metadata=metadata, error=outcome.error or "Scoring failed",
                require_ownership=True, cancel_event=cancel_event,
            )
        if recorded:
            committed_results.append((job, outcome))
        else:
            ownership_skipped.add(str(job["job_id"]))
    results = committed_results
    errors = sum(1 for _, outcome in results if not outcome.ok) + availability_deferred
    scored_count = sum(outcome.ok and not outcome.retained for _, outcome in results)
    retained_ids = [str(job["job_id"]) for job, outcome in results if outcome.ok and outcome.retained]

    elapsed = time.time() - t0
    log.info(
        "Done: %d scored, %d failed in %.1fs (%.1f jobs/sec)",
        scored_count,
        errors,
        elapsed,
        scored_count / elapsed if elapsed > 0 else 0,
    )

    distribution = _score_distribution(repository, tenant_id)
    # Canonical IDs this run persisted a target-bound score for. A resolved
    # global material run unions
    # them into its frozen Tailor cohort so newly qualified jobs are tailored
    # in the same command instead of stranding until the next pickup.
    scored_job_ids = list(
        dict.fromkeys(
            str(canonical_job_id(str(job["job_id"])))
            for job, outcome in results
            if outcome.ok and outcome.score is not None and not outcome.retained
        )
    )
    return {
        "scored": scored_count,
        "retained": len(retained_ids),
        "retainedJobIds": retained_ids,
        "errors": errors,
        "elapsed": elapsed,
        "distribution": distribution,
        "scoredJobIds": scored_job_ids,
        "skipped": len(ownership_skipped),
        "skippedJobIds": sorted(ownership_skipped),
        "errorDetails": {
            str(job["job_id"]): outcome.error or "Scoring failed"
            for job, outcome in results if not outcome.ok
        },
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
    requirement_fit_repository: RequirementFitReportRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    employer_analysis: EmployerAnalysis | None = None,
    employer_analysis_repository: EmployerAnalysisRepository | None = None,
    analyze_use_case: AnalyzeJobUseCaseLike | None = None,
    require_employer_analysis: bool = True,
    workflow_id: str | None = None,
) -> ScoreJobOutcome:
    """Resolve one tenant-scoped posting locator, then score its JobId."""
    conn = get_connection()
    identity = SqliteJobIdentityResolver(conn).resolve_current_by_posting_url(
        tenant_id,
        PostingUrl(value=job_url),
    )
    if identity is None:
        return ScoreJobOutcome(ok=False, score=None, error=f"Job not found: {job_url}")
    return score_job_by_id(
        identity.job_id,
        tenant_id=tenant_id,
        rescore=rescore,
        llm_model=llm_model,
        profile_snapshot=profile_snapshot,
        resume_text=resume_text,
        criteria=criteria,
        repository=repository,
        policy_repository=policy_repository,
        requirement_fit_repository=requirement_fit_repository,
        llm_port=llm_port,
        publisher=publisher,
        employer_analysis=employer_analysis,
        employer_analysis_repository=employer_analysis_repository,
        analyze_use_case=analyze_use_case,
        require_employer_analysis=require_employer_analysis,
        workflow_id=workflow_id,
    )


def score_job_by_id(
    job_id: JobId,
    *,
    use_case: ScoreJobUseCase | None = None,
    tenant_id: TenantId = LOCAL_TENANT,
    rescore: bool = False,
    llm_model: str | None = DEFAULT_PIPELINE_LLM_MODEL_SPEC,
    profile_snapshot: ProfileSnapshot | None = None,
    resume_text: str | None = None,
    criteria: ScoringCriteria | None = None,
    repository: ScoreRepository | None = None,
    policy_repository: ScoringPolicyRepository | None = None,
    requirement_fit_repository: RequirementFitReportRepository | None = None,
    llm_port: LlmPort | None = None,
    publisher: EventPublisher | None = None,
    employer_analysis: EmployerAnalysis | None = None,
    employer_analysis_repository: EmployerAnalysisRepository | None = None,
    analyze_use_case: AnalyzeJobUseCaseLike | None = None,
    require_employer_analysis: bool = True,
    workflow_id: str | None = None,
    enforce_workflow_ownership: bool = False,
    cancel_event: Any | None = None,
    recovery_workflow_id: str | None = None,
) -> ScoreJobOutcome:
    """Score exactly one enriched job by tenant-scoped canonical JobId.

    Internal Discovery preparation uses per-job workflows keyed to one job, so
    it cannot safely call the batch selector-based ``run_scoring`` helper. This
    entrypoint preserves the same Scoring use case and stage-state writes while
    targeting one workflow step only. ``rescore=True`` forces a new score
    version even when the job already has a current score.
    """
    stable_job_id = canonical_job_id(str(job_id))
    conn = get_connection()
    job = SqlitePreparationTargetReader(conn).load(tenant_id, stable_job_id)
    if job is None:
        return ScoreJobOutcome(ok=False, score=None, error=f"Job not found: {stable_job_id}")
    if workflow_id and stage_completed_by_activity_owner(
        conn,
        tenant_id=str(tenant_id),
        job_id=str(stable_job_id),
        stage="score",
        workflow_id=workflow_id,
    ):
        committed_score = (repository or SqliteScoreRepository(conn)).load(tenant_id, stable_job_id)
        return ScoreJobOutcome(ok=True, score=committed_score)
    if not job.get("full_description"):
        return ScoreJobOutcome(ok=False, score=None, error=f"Job is not enriched: {stable_job_id}")
    if workflow_id and not enforce_workflow_ownership:
        _assert_direct_score_admission(conn, tenant_id, stable_job_id, workflow_id, cancel_event)
    if enforce_workflow_ownership:
        if not workflow_id or not recovery_workflow_id:
            raise ValueError("Owned scoring requires the reserved workflow and activity owner")
        _assert_reserved_score_admission(conn, tenant_id, stable_job_id, recovery_workflow_id, cancel_event)

    # A cache hit does not build a scoring source. This is an advisory read;
    # availability and ownership are still checked under the writer below.
    cache_hint = (
        not rescore and use_case is None
        and (repository is None or (isinstance(repository, SqliteScoreRepository) and repository.connection is conn))
        and _has_saved_score(conn, tenant_id, stable_job_id)
    )
    # For new work, capture the exact scoring source before availability,
    # stage admission, or employer analysis. Reuse the captured value after
    # provider work instead of rereading a possibly changed settings row.
    exact_title_exclusions = None
    if use_case is None and not cache_hint:
        from jobctrl import config

        exact_title_exclusions = config.load_scoring_exact_title_exclusions()

    from jobctrl.enrichment.availability import require_preparation_available, assert_fresh_candidate
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost, claim_preparation_reservation

    expected_posting_url = job["url"]
    conn.commit()
    require_preparation_available(
        str(stable_job_id),
        tenant_id=str(tenant_id),
        conn=conn,
        expected_posting_url=expected_posting_url,
    )
    # Any refresh released its writer and fenced URL; reload the preparation target.
    with claim_preparation_reservation(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
        stage="score",
        workflow_id=None,
        cancel_event=cancel_event,
        expected_posting_url=expected_posting_url,
    ):
        job = SqlitePreparationTargetReader(conn).load(tenant_id, stable_job_id)
        if cache_hint and not _has_saved_score(conn, tenant_id, stable_job_id):
            return ScoreJobOutcome(ok=False, score=None, error="Saved score changed before reuse. Retry scoring.")
    if job is None:
        return ScoreJobOutcome(ok=False, score=None, error="Availability candidate changed")

    owned_metadata = None
    if enforce_workflow_ownership:
        conn.execute("BEGIN IMMEDIATE")
        try:
            assert_fresh_candidate(
                conn, str(stable_job_id), expected_posting_url, tenant_id=str(tenant_id), allow_unknown=True
            )
            _assert_reserved_score_admission(conn, tenant_id, stable_job_id, recovery_workflow_id, cancel_event)
            if cache_hint and not _has_saved_score(conn, tenant_id, stable_job_id):
                conn.rollback()
                return ScoreJobOutcome(ok=False, score=None, error="Saved score changed before reuse. Retry scoring.")
        except BaseException:
            conn.rollback()
            raise
        owned_metadata = _score_activity_metadata(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
            workflow_id=workflow_id,
            rescore=rescore,
        )
        owned_metadata["automaticRecovery"] = True
        owned_metadata["workflowId"] = recovery_workflow_id
        owned_metadata["temporalRunId"] = workflow_id
        set_stage_state(
            conn,
            stable_job_id,
            "score",
            "running",
            tenant_id=tenant_id,
            attempt_count=_score_attempt_count(conn, tenant_id=tenant_id, job_id=stable_job_id),
            started_at=utc_now(),
            metadata=owned_metadata,
            validate_transition=False,
        )
        record_job_event(conn, stable_job_id, "score", "StageStarted", tenant_id=tenant_id, message="Scoring started")
        conn.commit()

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
    if workflow_id or isinstance(repository, SqliteScoreRepository):
        # Resolve the SQLite companion before the ownership decorator hides
        # its concrete type from the use-case factory's default wiring.
        if requirement_fit_repository is None and isinstance(repository, SqliteScoreRepository):
            requirement_fit_repository = SqliteRequirementFitReportRepository(repository.connection)
        repository = _OwnedScoreRepository(repository, conn, workflow_id, cancel_event)
    if policy_repository is None:
        policy_repository = SqliteScoringPolicyRepository(conn)
    existing = repository.load(tenant_id, stable_job_id)
    if cache_hint and existing is None:
        error = "Saved score changed before reuse. Retry scoring."
        if enforce_workflow_ownership:
            recorded = _record_score_stage_failed(
                conn, job=job, tenant_id=tenant_id, started_at=utc_now(), metadata=owned_metadata,
                error=error, cancel_event=cancel_event, require_ownership=True,
            )
            if not recorded:
                raise PreparationReservationLost("Score activity no longer owns its stage")
        return ScoreJobOutcome(ok=False, score=None, error=error)
    if existing is not None and not rescore:
        if enforce_workflow_ownership:
            recorded = _record_score_stage_succeeded(
                conn,
                job=job,
                score=existing,
                tenant_id=tenant_id,
                metadata=owned_metadata,
                cancel_event=cancel_event,
            )
            if not recorded:
                raise PreparationReservationLost("Score activity no longer owns its stage")
        else:
            with claim_preparation_reservation(
                conn, tenant_id=tenant_id, job_id=stable_job_id, stage="score",
                workflow_id=None, cancel_event=cancel_event, expected_posting_url=expected_posting_url,
            ):
                _assert_direct_score_admission(conn, tenant_id, stable_job_id, workflow_id, cancel_event)
                _ensure_existing_score_stage_succeeded(
                    conn, job=job, score=existing, tenant_id=tenant_id,
                )
        return ScoreJobOutcome(ok=True, score=existing)
    started_at = utc_now()
    metadata = owned_metadata or _score_activity_metadata(
        conn,
        tenant_id=tenant_id,
        job_id=stable_job_id,
        workflow_id=workflow_id,
        rescore=rescore,
    )
    if not enforce_workflow_ownership:
        with claim_preparation_reservation(
            conn,
            tenant_id=tenant_id,
            job_id=stable_job_id,
            stage="score",
            workflow_id=None,
            cancel_event=cancel_event,
            expected_posting_url=expected_posting_url,
        ):
            _assert_direct_score_admission(conn, tenant_id, stable_job_id, workflow_id, cancel_event)
            ensure_job_stage_rows(
                conn,
                stable_job_id,
                tenant_id=tenant_id,
                discovered_at=job.get("discovered_at"),
            )
            set_stage_state(
                conn,
                stable_job_id,
                "score",
                "running",
                tenant_id=tenant_id,
                # Preserve the attempt counter across re-selection — see
                # _score_attempt_count; a bare running write would reset it to 0.
                attempt_count=_score_attempt_count(
                    conn,
                    tenant_id=tenant_id,
                    job_id=stable_job_id,
                ),
                started_at=started_at,
                metadata=metadata,
                validate_transition=False,
            )
            record_job_event(
                conn,
                stable_job_id,
                "score",
                "StageStarted",
                tenant_id=tenant_id,
                message="Scoring started",
            )
            conn.commit()
    if workflow_id and not _score_activity_may_write(conn, tenant_id, stable_job_id, workflow_id, cancel_event):
        raise PreparationReservationLost("Score activity no longer owns its stage")
    if employer_analysis is None:
        try:
            if employer_analysis_repository is None:
                employer_analysis_repository = SqliteEmployerAnalysisRepository(conn)
            if analyze_use_case is None and require_employer_analysis:
                analyze_use_case = build_analyze_use_case(
                    conn=conn,
                    tenant_id=tenant_id,
                    publisher=publisher,
                    event_stage="score",
                    # Score resolves the analysis before EVERY fresh score; cache
                    # hits must not append duplicate job_events timeline rows.
                    record_cached_hits=False,
                )
            employer_analysis = _ensure_employer_analysis_for_job(
                repository=employer_analysis_repository,
                analyze_use_case=analyze_use_case,
                tenant_id=tenant_id,
                job=job,
                require=require_employer_analysis,
            )
        except Exception as exc:  # noqa: BLE001 -- persist one bounded attempt failure
            error = _employer_analysis_failure_message(exc)
            recorded = _record_score_stage_failed(
                conn,
                job=job,
                tenant_id=tenant_id,
                started_at=started_at,
                metadata=metadata,
                error=error,
                cancel_event=cancel_event,
            )
            if workflow_id and not recorded:
                raise PreparationReservationLost("Score activity no longer owns its stage") from exc
            return ScoreJobOutcome(ok=False, score=None, error=error)

    if workflow_id and not _score_activity_may_write(conn, tenant_id, stable_job_id, workflow_id, cancel_event):
        raise PreparationReservationLost("Score activity no longer owns its stage")
    try:
        outcome = score_job(
            profile_snapshot,
            job,
            use_case=use_case
            or _build_use_case(
                tenant_id=tenant_id,
                repository=repository,
                policy_repository=policy_repository,
                requirement_fit_repository=requirement_fit_repository,
                llm_port=llm_port,
                llm_model=llm_model,
                publisher=publisher,
                exact_title_exclusions=exact_title_exclusions,
            ),
            tenant_id=tenant_id,
            resume_text=resume_text,
            criteria=criteria,
            employer_analysis=employer_analysis,
            require_employer_analysis=require_employer_analysis,
            **({"previous_score": existing} if rescore and existing is not None
                and existing.trace.scoring_policy_version == policy_repository.get_current(tenant_id).version else {}),
        )
    except ScoreSourcesChanged as exc:
        error = str(exc)
        recorded = _record_score_stage_failed(
            conn, job=job, tenant_id=tenant_id, started_at=started_at,
            metadata=metadata, error=error, cancel_event=cancel_event,
            require_ownership=True,
        )
        if not recorded:
            raise PreparationReservationLost("Score activity no longer owns its stage") from exc
        return ScoreJobOutcome(ok=False, score=None, error=error)
    if outcome.ok and outcome.score is not None:
        recorded = _record_score_stage_succeeded(
            conn,
            job=job,
            score=outcome.score,
            tenant_id=tenant_id,
            started_at=started_at,
            metadata=metadata,
            cancel_event=cancel_event,
            validate_transition=True,
            retained=outcome.retained,
        )
    else:
        recorded = _record_score_stage_failed(
            conn,
            job=job,
            tenant_id=tenant_id,
            started_at=started_at,
            metadata=metadata,
            error=outcome.error or "Scoring failed",
            cancel_event=cancel_event,
        )
    if workflow_id and not recorded:
        raise PreparationReservationLost("Score activity no longer owns its stage")
    return outcome


class ScoreSourcesChanged(RuntimeError):
    """The still-owned score used canonical sources that are no longer current."""


class _OwnedScoreRepository:
    """Fence the actual score commit after provider I/O, under a write lock."""

    def __init__(self, repository, conn, owner, cancel_event):
        self._repository = repository
        self._conn = conn
        self._owner = owner
        self._cancel_event = cancel_event
        self._publishing = False
        self.require_canonical_inputs = False

    @contextmanager
    def publication(self, tenant_id, job_id):
        """Keep ownership valid until the entire score publication commits."""
        from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

        connection = getattr(self._repository, "connection", self._conn)
        if connection is not self._conn:
            raise RuntimeError("Score publication repositories must share one SQLite connection")
        base_scope = getattr(self._repository, "publication", None)
        if callable(base_scope):
            with base_scope(tenant_id, job_id):
                if not _score_activity_may_write(self._conn, tenant_id, job_id,
                                                self._owner, self._cancel_event):
                    raise PreparationReservationLost("Score activity no longer owns score persistence")
                self._publishing = True
                try:
                    yield
                    if not _score_activity_may_write(self._conn, tenant_id, job_id,
                                                    self._owner, self._cancel_event):
                        raise PreparationReservationLost("Score activity lost its owner before publication")
                finally:
                    self._publishing = False
            return

        # Non-SQLite injected test adapters still receive the ownership fence.
        owns_writer = not self._conn.in_transaction
        if owns_writer:
            self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute("SAVEPOINT owned_score_publication")
        except BaseException:
            if owns_writer:
                self._conn.rollback()
            raise
        released = False
        try:
            if not _score_activity_may_write(self._conn, tenant_id, job_id,
                                            self._owner, self._cancel_event):
                raise PreparationReservationLost("Score activity no longer owns score persistence")
            self._publishing = True
            try:
                yield
                if not _score_activity_may_write(self._conn, tenant_id, job_id,
                                                self._owner, self._cancel_event):
                    raise PreparationReservationLost("Score activity lost its owner before publication")
            finally:
                self._publishing = False
            self._conn.execute("RELEASE SAVEPOINT owned_score_publication")
            released = True
            if owns_writer:
                self._conn.commit()
        except BaseException:
            if owns_writer:
                self._conn.rollback()
            elif not released:
                self._conn.execute("ROLLBACK TO SAVEPOINT owned_score_publication")
                self._conn.execute("RELEASE SAVEPOINT owned_score_publication")
            raise

    def capture_scoring_inputs(self, job):
        """Snapshot current canonical non-profile sources before provider I/O."""
        from jobctrl.domain.materials.analysis import PROMPT_VERSION

        tenant_id = str(job["tenant_id"])
        job_id = str(canonical_job_id(str(job["job_id"])))
        posting_hash = compute_snapshot_hash(build_jd_snapshot(job))
        analysis = self._conn.execute(
            "SELECT generation, snapshot_hash, requirements_json FROM job_employer_analysis "
            "WHERE tenant_id=? AND job_id=? AND prompt_version=? ORDER BY generation DESC LIMIT 1",
            (tenant_id, job_id, PROMPT_VERSION),
        ).fetchone()
        interpretation = self._conn.execute(
            "SELECT binding.determination_id, determination.envelope_json "
            "FROM semantic_entity_bindings binding "
            "LEFT JOIN semantic_determinations determination ON determination.tenant_id=binding.tenant_id "
            "AND determination.determination_id=binding.determination_id "
            "WHERE binding.tenant_id=? AND binding.entity_kind='job' AND binding.entity_id=? "
            "AND binding.entity_version=? AND binding.determination_kind='job_interpretation'",
            (tenant_id, job_id, posting_hash),
        ).fetchone()
        policy = self._conn.execute(
            "SELECT version, rubric_json, anchors_json FROM scoring_policies "
            "WHERE tenant_id=? ORDER BY version DESC LIMIT 1", (tenant_id,),
        ).fetchone()
        return tuple(tuple(row) if row is not None else None for row in (analysis, interpretation, policy))

    def validate_scoring_inputs(self, job, parse):
        """Reject obsolete posting and source inputs under the score writer lock."""
        tenant_id = TenantId(str(job["tenant_id"]))
        job_id = canonical_job_id(str(job["job_id"]))
        current = SqlitePreparationTargetReader(self._conn).load(tenant_id, job_id)
        expected_hash = parse.trace.profile_inputs.get("posting_hash")
        expected_sources = job.get("_score_publication_inputs")
        if (current is None or current.get("url") != job.get("url")
                or (self.require_canonical_inputs and not expected_hash)
                or (expected_hash and compute_snapshot_hash(build_jd_snapshot(current)) != expected_hash)):
            raise ScoreSourcesChanged("Score posting changed before publication")
        if expected_sources is None or self.capture_scoring_inputs(current) != expected_sources:
            raise ScoreSourcesChanged("Score sources changed before publication")
        policy = expected_sources[2]
        if policy is not None and parse.trace.scoring_policy_version != int(policy[0]):
            raise ScoreSourcesChanged("Score policy changed before publication")
        if self.require_canonical_inputs:
            from jobctrl.domain.scoring.use_cases import _scoring_source_fingerprint
            from jobctrl.infrastructure.enrichment.interpretation import read_job_interpretation

            interpretation = read_job_interpretation(self._conn, current, tenant_id=str(tenant_id))
            analysis = _load_employer_analysis_for_job(
                repository=SqliteEmployerAnalysisRepository(self._conn), tenant_id=tenant_id, job=current,
            )
            if (interpretation is None
                    or (parse.employer_analysis_generation > 0 and analysis is None)
                    or not parse.trace.scoring_source_fingerprint
                    or _scoring_source_fingerprint(analysis, interpretation[0])
                    != parse.trace.scoring_source_fingerprint):
                raise ScoreSourcesChanged("Score canonical sources no longer match the decision")

    def __getattr__(self, name):
        return getattr(self._repository, name)

    def record_profile_review(self, score, *, entity_version, determination_id):
        from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

        if self._publishing:
            self._repository.record_profile_review(score, entity_version=entity_version, determination_id=determination_id)
            return
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            if not _score_activity_may_write(self._conn, score.tenant_id, score.job_id,
                                            self._owner, self._cancel_event):
                raise PreparationReservationLost("Score review no longer owns its stage")
            self._repository.record_profile_review(score, entity_version=entity_version, determination_id=determination_id)
            self._conn.commit()
        except BaseException:
            self._conn.rollback()
            raise

    def save(self, score):
        from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

        if self._publishing:
            self._repository.save(score)
            return
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            if not _score_activity_may_write(
                self._conn,
                score.tenant_id,
                score.job_id,
                self._owner,
                self._cancel_event,
            ):
                raise PreparationReservationLost("Score activity no longer owns score persistence")
            self._repository.save(score)
            self._conn.commit()
        except BaseException:
            self._conn.rollback()
            raise


def _has_saved_score(conn, tenant_id, job_id) -> bool:
    """A non-rescore may reuse an existing SQLite score without new inputs."""
    return conn.execute(
        "SELECT 1 FROM job_scores WHERE tenant_id = ? AND job_id = ? LIMIT 1",
        (str(tenant_id), str(job_id)),
    ).fetchone() is not None


def _assert_reserved_score_admission(conn, tenant_id, job_id, reservation_owner, cancel_event):
    """Check the reservation without changing it; the writer repeats this check."""
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

    row = conn.execute(
        "SELECT state, json_extract(metadata_json, '$.automaticPreparation.workflowId') "
        "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if (row is None or row[0] != "queued" or row[1] != reservation_owner
            or (cancel_event is not None and cancel_event.is_set())):
        raise PreparationReservationLost("Score reservation no longer owned")


def _assert_direct_score_admission(conn, tenant_id, job_id, owner, cancel_event):
    """A direct request may not acquire stopped work or another live owner."""
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

    if cancel_event is not None and cancel_event.is_set():
        raise PreparationReservationLost("Score activity canceled before admission")
    row = conn.execute(
        "SELECT state, json_extract(metadata_json, '$.activityOwner'), "
        "json_extract(metadata_json, '$.automaticPreparation.workflowId') FROM job_stage_states "
        "WHERE tenant_id=? AND job_id=? AND stage='score'", (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is not None and (
        row[0] == "canceled"
        or (row[0] in {"pending", "queued", "running"} and row[1] and row[1] != owner)
        or (row[0] == "queued" and row[2] and row[2] != owner)
    ):
        raise PreparationReservationLost("Score activity no longer owns admission")


def _score_activity_may_write(conn, tenant_id, job_id, owner, cancel_event) -> bool:
    if cancel_event is not None and cancel_event.is_set():
        return False
    row = conn.execute(
        "SELECT state, json_extract(metadata_json, '$.activityOwner') FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    return row is not None and row[0] == "running" and row[1] == owner


def _ensure_existing_score_stage_succeeded(
    conn: sqlite3.Connection,
    *,
    job: dict[str, Any],
    score: JobScore,
    tenant_id: TenantId,
) -> None:
    job_id = canonical_job_id(str(score.job_id))
    if _has_unresolved_score_staleness(conn, tenant_id=tenant_id, job_id=job_id):
        return

    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at=job.get("discovered_at"),
    )
    row = conn.execute(
        "SELECT state, started_at, attempt_count "
        "FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    state = _row_value(row, "state", 0)
    if state == "succeeded":
        _sync_score_eligibility_stage_state(
            conn,
            tenant_id=tenant_id,
            job_id=score.job_id,
            score=score,
        )
        conn.commit()
        return

    finished_at = utc_now()
    started_at = _row_value(row, "started_at", 1) or finished_at
    attempt_count = max(int(_row_value(row, "attempt_count", 2) or 0), 1)
    set_stage_state(
        conn,
        job_id,
        "score",
        "succeeded",
        tenant_id=tenant_id,
        attempt_count=attempt_count,
        started_at=str(started_at),
        finished_at=finished_at,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        "score",
        "StageCompleted",
        tenant_id=tenant_id,
        message=f"Fit score {score.fit_score.value}/10",
        payload={"keywords": list(score.matched_keywords)},
    )
    _sync_score_eligibility_stage_state(
        conn,
        tenant_id=tenant_id,
        job_id=score.job_id,
        score=score,
        now=finished_at,
    )
    conn.commit()


def _record_score_stage_succeeded(
    conn: sqlite3.Connection,
    *,
    job: dict[str, Any],
    score: JobScore,
    tenant_id: TenantId,
    started_at: str | None = None,
    finished_at: str | None = None,
    validate_transition: bool = False,
    metadata: dict[str, Any] | None = None,
    cancel_event: Any | None = None,
    require_ownership: bool = False,
    retained: bool = False,
) -> bool:
    job_id = canonical_job_id(str(score.job_id))
    owned = require_ownership or bool(metadata and metadata.get("activityOwner"))
    if owned:
        conn.execute("BEGIN IMMEDIATE")
        if not _score_activity_may_write(conn, tenant_id, job_id, (metadata or {}).get("activityOwner"), cancel_event):
            conn.rollback()
            return False
    finished_at = finished_at or utc_now()
    ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at=job.get("discovered_at"),
    )
    set_stage_state(
        conn,
        job_id,
        "score",
        "succeeded",
        tenant_id=tenant_id,
        attempt_count=_score_attempt_count(conn, tenant_id=tenant_id, job_id=job_id) + (0 if retained else 1) if owned or retained else 1,
        started_at=started_at or finished_at,
        finished_at=finished_at,
        validate_transition=validate_transition,
        metadata=metadata,
    )
    record_job_event(
        conn,
        job_id,
        "score",
        "StageCompleted",
        tenant_id=tenant_id,
        message="Profile changes reviewed; saved score retained." if retained else f"Fit score {score.fit_score.value}/10",
        payload={"keywords": list(score.matched_keywords), "retained": retained},
        occurred_at=finished_at,
    )
    if not retained and not _has_unresolved_score_staleness(conn, tenant_id=tenant_id, job_id=job_id):
        _sync_score_eligibility_stage_state(
            conn, tenant_id=tenant_id, job_id=score.job_id, score=score, now=finished_at,
        )
    conn.commit()
    return True


def _record_score_stage_failed(
    conn: sqlite3.Connection,
    *,
    job: dict[str, Any],
    tenant_id: TenantId,
    started_at: str,
    metadata: dict[str, Any] | None,
    error: str,
    cancel_event: Any | None = None,
    require_ownership: bool = False,
) -> bool:
    """Persist one bounded, retryable scoring attempt failure."""

    job_id = canonical_job_id(str(job["job_id"]))
    if require_ownership or (metadata and metadata.get("activityOwner")):
        conn.execute("BEGIN IMMEDIATE")
        if not _score_activity_may_write(conn, tenant_id, job_id, (metadata or {}).get("activityOwner"), cancel_event):
            conn.rollback()
            return False
    finished_at = utc_now()
    failure = serialized_determination_failure(error)
    set_stage_state(
        conn,
        job_id,
        "score",
        "blocked" if failure and not failure.retryable else "failed",
        tenant_id=tenant_id,
        attempt_count=_score_attempt_count(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
        )
        + 1,
        started_at=started_at,
        finished_at=finished_at,
        error_code=f"SEMANTIC_{failure.code.upper()}" if failure else "SCORE_FAILED",
        error_message=str(failure) if failure else error,
        retryable=failure.retryable if failure else True,
        next_action=f"jobctrl retry score {job.get('url') or job_id}",
        metadata=metadata,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        "score",
        "StageFailed",
        tenant_id=tenant_id,
        level="error",
        message=error,
    )
    conn.commit()
    return True


def _sync_score_eligibility_stage_state(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    score: JobScore,
    now: str | None = None,
) -> None:
    eligibility = score.breakdown.eligibility
    reconcile_score_eligibility_blockers(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        eligibility_status=eligibility.status,
        hard_blockers=list(eligibility.hard_blockers),
        hard_blocker_categories=eligibility.hard_blocker_categories,
        hard_blocker_citations=eligibility.hard_blocker_citations,
        now=now,
    )
    if not eligibility_blocks_downstream(eligibility):
        reconcile_score_threshold_skips(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
            fit_score=score.fit_score.value,
            min_score=effective_tailoring_min_score(score.criteria.min_fit_score),
            now=now,
        )


def _has_unresolved_score_staleness(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM job_score_staleness
        WHERE tenant_id = ?
          AND job_id = ?
          AND resolved = 0
        LIMIT 1
        """,
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    return row is not None


def _row_value(row: Any, key: str, index: int) -> Any:
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return row[key]
    return row[index]


def _score_attempt_count(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> int:
    """Current score-stage attempt count (0 if unrecorded).

    ``set_stage_state`` resets ``attempt_count`` to 0 whenever it is
    omitted, so a bare ``running`` write would wipe the counter between
    batch re-selections. The score stage therefore threads the current
    count through the ``running`` write and increments it on failure, so
    the ``pending_score`` ``< 5`` cap can engage and stop a permanently-
    failing job from re-billing the LLM on every batch.
    """
    row = conn.execute(
        "SELECT attempt_count FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'score'",
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    return int(_row_value(row, "attempt_count", 0) or 0)


def _analysis_connection_for_repository(repository: ScoreRepository | None) -> sqlite3.Connection:
    if isinstance(repository, SqliteScoreRepository):
        return repository.connection
    return get_connection()


def _ensure_employer_analysis_for_job(
    *,
    repository: EmployerAnalysisRepository | None,
    analyze_use_case: AnalyzeJobUseCaseLike | None,
    tenant_id: TenantId,
    job: dict[str, Any],
    existing: EmployerAnalysis | None = None,
    require: bool,
) -> EmployerAnalysis | None:
    """Resolve the canonical requirement source before a fresh score attempt."""

    # ``AnalyzeJobUseCase`` owns the complete cache identity: posting snapshot,
    # prompt version, and enabled SDK/model set.  Always ask it first when it is
    # available.  Loading the latest row directly can return an analysis for an
    # older posting snapshot; scoring against that row creates a requirement-fit
    # report which Tailoring must later discard after it refreshes the analysis.
    refresh_error: Exception | None = None
    if analyze_use_case is not None:
        try:
            outcome = analyze_use_case.execute(job=job, tenant_id=tenant_id)
        except Exception as exc:  # noqa: BLE001 — degrade to a same-snapshot persisted analysis below
            refresh_error = exc
        else:
            analysis = getattr(outcome, "analysis", None)
            if _is_usable_employer_analysis(analysis, job):
                return analysis
            # The use case hashes the same job dict scoring validates against,
            # so on this branch the snapshot always matches — the only reachable
            # failure is an analysis without grounded requirements.
            raise ValueError("Employer analysis did not produce grounded requirements for this job.")
    # Fallback tier: a persisted analysis is acceptable only when it passes the
    # same-snapshot usability check — never score against a different posting
    # snapshot. This keeps scoring available when the ensemble refresh fails
    # (e.g. provider outage) and an analysis for the CURRENT snapshot exists.
    fallback = existing if _is_usable_employer_analysis(existing, job) else None
    if fallback is None and repository is not None:
        fallback = _load_employer_analysis_for_job(
            repository=repository,
            tenant_id=tenant_id,
            job=job,
        )
    if fallback is not None:
        if refresh_error is not None:
            log.warning(
                "Employer analysis refresh failed for tenant=%s job=%s; scoring against persisted "
                "generation %s for the current posting snapshot: %s",
                tenant_id,
                job.get("job_id"),
                fallback.generation,
                refresh_error,
            )
        return fallback
    if refresh_error is not None:
        raise refresh_error
    if require:
        raise ValueError("Scoring requires employer analysis before a fresh score can be computed.")
    return None


def _is_usable_employer_analysis(
    analysis: EmployerAnalysis | None,
    job: dict[str, Any],
) -> bool:
    if analysis is None:
        return False
    job_id = canonical_job_id(str(job["job_id"]))
    tenant_id = TenantId(str(job["tenant_id"]))
    if analysis.job_id != job_id or analysis.tenant_id != tenant_id:
        log.warning(
            "Ignoring employer analysis for tenant=%s job=%s while scoring tenant=%s job=%s",
            analysis.tenant_id,
            analysis.job_id,
            tenant_id,
            job_id,
        )
        return False
    expected_snapshot_hash = compute_snapshot_hash(build_jd_snapshot(job))
    if analysis.snapshot_hash != expected_snapshot_hash:
        log.info(
            "Ignoring employer analysis generation %s for tenant=%s job=%s because its posting snapshot is stale",
            analysis.generation,
            tenant_id,
            job_id,
        )
        return False
    return bool(analysis.canonical.requirements)


def _load_employer_analysis_for_job(
    *,
    repository: EmployerAnalysisRepository,
    tenant_id: TenantId,
    job: dict[str, Any],
) -> EmployerAnalysis | None:
    job_id = canonical_job_id(str(job["job_id"]))
    analysis = repository.load(tenant_id, job_id)
    if not _is_usable_employer_analysis(analysis, job):
        return None
    return analysis


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
    return max(0, limit)


def _score_activity_metadata(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    workflow_id: str | None,
    rescore: bool,
) -> dict[str, object] | None:
    if not workflow_id:
        return None
    row = conn.execute(
        "SELECT COALESCE(MAX(version), 0) AS version FROM job_scores WHERE tenant_id = ? AND job_id = ?",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    return {
        "activityOwner": workflow_id,
        "rescore": rescore,
        "priorScoreVersion": int(row["version"] if row else 0),
    }


# ---------------------------------------------------------------------------
# Re-exports for backwards-compatible imports
# ---------------------------------------------------------------------------


# Older test fixtures and pipeline modules may still import these symbols
# directly; keep them visible so the refactor doesn't break unrelated
# callers. The canonical home is the use case module.
from jobctrl.domain.scoring.use_cases import SCORE_PROMPT  # noqa: E402,F401
