"""Temporal activity for the scoring stage."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace
import time
from typing import Any

from temporalio import activity

from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class ScoreActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
    rescore: bool = False
    job_urls: tuple[str, ...] = ()
    current_policy_only: bool = False
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    workflow_id: str | None = None


@dataclass(frozen=True)
class ScoreActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@activity.defn(name="score")
async def score_activity(payload: ScoreActivityInput) -> ScoreActivityOutput:
    """Run the scoring stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline import run_pipeline

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    if payload.current_policy_only:
        result = await run_blocking_with_heartbeat(
            lambda: _run_current_policy_scores(payload),
            starting_message="current-policy score starting",
            progress_message="current-policy score still running",
        )
        return ScoreActivityOutput(
            status=str(result["status"]),
            elapsed=float(result["elapsed"]),
            errors=dict(result["errors"]),
            stages=list(result["stages"]),
        )

    if payload.job_urls:
        result = await run_blocking_with_heartbeat(
            lambda: _run_selected_scores(payload),
            starting_message="selected score starting",
            progress_message="selected score still running",
        )
        return ScoreActivityOutput(
            status=str(result["status"]),
            elapsed=float(result["elapsed"]),
            errors=dict(result["errors"]),
            stages=list(result["stages"]),
        )

    def _do() -> dict[str, Any]:
        return run_pipeline(
            stages=["score"],
            workers=payload.workers,
            limit=payload.limit,
            dry_run=payload.dry_run,
            rescore=payload.rescore,
            llm_model=payload.llm_model,
            workflow_id=payload.workflow_id,
        )

    result = await run_blocking_with_heartbeat(
        _do,
        starting_message="score starting",
        progress_message="score still running",
    )
    stages = list(result.get("stages") or [])
    errors = dict(result.get("errors") or {})
    status = stages[0]["status"] if stages else ("failed" if errors else "ok")
    return ScoreActivityOutput(
        status=status,
        elapsed=float(result.get("elapsed") or 0.0),
        errors=errors,
        stages=stages,
    )


def _run_current_policy_scores(payload: ScoreActivityInput) -> dict[str, Any]:
    from jobhunter.database import get_connection
    from jobhunter.pipeline.current_policy_selectors import scoring_current_policy_job_urls

    urls = scoring_current_policy_job_urls(
        get_connection(),
        tenant_id=payload.tenant_id,
        limit=payload.limit,
        job_urls=payload.job_urls,
    )
    return _run_selected_scores(replace(payload, job_urls=urls, limit=0))


def _run_selected_scores(payload: ScoreActivityInput) -> dict[str, Any]:
    from jobhunter.domain.tenant import TenantId
    from jobhunter.scoring.scorer import score_job_by_url

    urls = _limited_job_urls(payload.job_urls, payload.limit)
    if payload.dry_run:
        return {
            "status": "ok",
            "elapsed": 0.0,
            "errors": {},
            "stages": [
                {
                    "stage": "score",
                    "status": "ok",
                    "elapsed": 0.0,
                    "selected": len(urls),
                    "dry_run": True,
                }
            ],
        }

    t0 = time.time()
    errors: dict[str, str] = {}
    scored = 0

    def score_one(url: str):
        return url, score_job_by_url(
            url,
            tenant_id=TenantId(payload.tenant_id),
            rescore=payload.rescore,
            llm_model=payload.llm_model,
        )

    worker_count = max(1, int(payload.workers or 1))
    if worker_count == 1 or len(urls) <= 1:
        results = [score_one(url) for url in urls]
    else:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [executor.submit(score_one, url) for url in urls]
            results = [future.result() for future in as_completed(futures)]

    for url, outcome in results:
        if outcome.ok:
            scored += 1
        else:
            errors[url] = outcome.error or "Scoring failed"

    elapsed = time.time() - t0
    status = "failed" if errors else "ok"
    return {
        "status": status,
        "elapsed": elapsed,
        "errors": errors,
        "stages": [
            {
                "stage": "score",
                "status": status,
                "elapsed": elapsed,
                "selected": len(urls),
                "scored": scored,
            }
        ],
    }


def _limited_job_urls(job_urls: tuple[str, ...], limit: int) -> tuple[str, ...]:
    unique = tuple(dict.fromkeys(url for url in job_urls if url))
    if limit > 0:
        return unique[:limit]
    return unique
