"""Temporal activity for the discovery stage.

Wraps the existing ``run_pipeline(stages=["discover"])`` orchestrator so the
Temporal workflow consults the same stage runner the CLI uses.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity

from jobhunter.domain.errors import JobHunterError, SourceUnavailableError, to_application_error
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class DiscoverActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    limit: int = 0
    workers: int = 1
    dry_run: bool = False
    min_score: int = 7
    validation_mode: str = "normal"
    tailor_models: tuple[str, ...] = ()
    tailor_judge_model: str | None = None
    tailor_judge_min_score: float | None = None
    source_ids: tuple[str, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    workflow_id: str | None = None


@dataclass(frozen=True)
class DiscoverActivityOutput:
    status: str
    elapsed: float
    errors: dict[str, str] = field(default_factory=dict)
    stages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class PlanDiscoverySourcesInput:
    tenant_id: str
    limit: int = 0
    source_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlanDiscoverySourcesOutput:
    families: list[str]
    progress_total: int
    start_count: int


@dataclass(frozen=True)
class DiscoverySourceActivityInput:
    tenant_id: str
    family: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    workers: int = 1
    limit: int = 0
    source_ids: tuple[str, ...] = ()
    start_count: int = 0
    progress_completed: int = 0
    progress_total: int = 0


@dataclass(frozen=True)
class DiscoverySourceActivityOutput:
    family: str
    status: str
    result: dict[str, Any] = field(default_factory=dict)
    source_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DiscoveryEnrichmentActivityInput:
    tenant_id: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    workers: int = 1
    limit: int = 0


@dataclass(frozen=True)
class DiscoveryEnrichmentActivityOutput:
    status: str
    passes: int = 0
    pending: int = 0
    error_class: str | None = None
    error_message: str | None = None


@activity.defn(name="plan_discovery_sources")
def plan_discovery_sources(payload: PlanDiscoverySourcesInput) -> PlanDiscoverySourcesOutput:
    """Plan the source-family activities for ``DiscoverWorkflow``."""
    from jobhunter.pipeline.runner import plan_discovery_source_families

    plan = plan_discovery_source_families(
        limit=payload.limit,
        source_ids=payload.source_ids,
    )
    return PlanDiscoverySourcesOutput(
        families=list(plan.get("families") or []),
        progress_total=int(plan.get("progress_total") or 0),
        start_count=int(plan.get("start_count") or 0),
    )


@activity.defn(name="discovery_source_family")
async def discovery_source_family_activity(
    payload: DiscoverySourceActivityInput,
) -> DiscoverySourceActivityOutput:
    """Run one discovery source family with real cancellation and heartbeats."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline.runner import run_discovery_source_family

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()

    try:
        result = await run_blocking_with_heartbeat(
            lambda: run_discovery_source_family(
                payload.family,
                workers=payload.workers,
                limit=payload.limit,
                source_ids=payload.source_ids,
                start_count=payload.start_count,
                progress_completed=payload.progress_completed,
                progress_total=payload.progress_total,
                cancel_event=cancel_event,
            ),
            starting_message=f"discover {payload.family} starting",
            progress_message=f"discover {payload.family} still running",
            on_cancel=cancel_event.set,
            activity_name=f"discover:{payload.family}",
        )
        status = str(result.get("status") or "ok")
        activity_result = {"status": status, "errors": {}}
        _raise_on_failure(f"discover:{payload.family}", activity_result, SourceUnavailableError)
        return DiscoverySourceActivityOutput(
            family=str(result.get("family") or payload.family),
            status=status,
            result=dict(result.get("result") or {}),
            source_ids=[str(item) for item in (result.get("source_ids") or [])],
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


@activity.defn(name="discovery_enrichment")
async def discovery_enrichment_activity(
    payload: DiscoveryEnrichmentActivityInput,
) -> DiscoveryEnrichmentActivityOutput:
    """Drain detail enrichment after source-family discovery completes."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline.runner import run_discovery_enrichment_stage, run_discovery_hygiene

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()

    try:
        result = await run_blocking_with_heartbeat(
            lambda: run_discovery_enrichment_stage(
                workers=payload.workers,
                limit=payload.limit,
                cancel_event=cancel_event,
            ),
            starting_message="discovery enrichment starting",
            progress_message="discovery enrichment still running",
            on_cancel=cancel_event.set,
            activity_name="discover:enrichment",
        )
        activity.heartbeat({"status": result.get("status", "ok")})
        run_discovery_hygiene("after")
        status = str(result.get("status") or "ok")
        activity_result = {"status": status, "errors": {}}
        _raise_on_failure("discover:enrichment", activity_result, SourceUnavailableError)
        return DiscoveryEnrichmentActivityOutput(
            status=status,
            passes=int(result.get("passes") or 0),
            pending=int(result.get("pending") or 0),
            error_class=result.get("error_class"),
            error_message=result.get("error_message"),
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


@activity.defn(name="discover")
async def discover_activity(payload: DiscoverActivityInput) -> DiscoverActivityOutput:
    """Run the discovery stage via ``run_pipeline``."""
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.pipeline import run_pipeline

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()

    try:
        def _do() -> dict[str, Any]:
            return run_pipeline(
                stages=["discover"],
                workers=payload.workers,
                limit=payload.limit,
                dry_run=payload.dry_run,
                min_score=payload.min_score,
                validation_mode=payload.validation_mode,
                tailor_models=payload.tailor_models,
                tailor_judge_model=payload.tailor_judge_model,
                tailor_judge_min_score=payload.tailor_judge_min_score,
                source_ids=payload.source_ids,
                llm_model=payload.llm_model,
                workflow_id=payload.workflow_id,
                cancel_event=cancel_event,
            )

        result = await run_blocking_with_heartbeat(
            _do,
            starting_message="discover starting",
            progress_message="discover still running",
            on_cancel=cancel_event.set,
            activity_name="discover",
        )
        stages = list(result.get("stages") or [])
        errors = dict(result.get("errors") or {})
        status = stages[0]["status"] if stages else ("failed" if errors else "ok")
        activity_result = {
            "status": status,
            "elapsed": float(result.get("elapsed") or 0.0),
            "errors": errors,
            "stages": stages,
        }
        _raise_on_failure("discover", activity_result, SourceUnavailableError)
        return DiscoverActivityOutput(
            status=status,
            elapsed=float(result.get("elapsed") or 0.0),
            errors=errors,
            stages=stages,
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc


_SUCCESS_STATUSES = {"ok", "partial", "skipped", "already_done"}


def _raise_on_failure(stage: str, result: dict[str, Any], error_type: type[JobHunterError]) -> None:
    errors = result.get("errors") or {}
    status = str(result.get("status") or "ok").lower()
    if errors or status not in _SUCCESS_STATUSES:
        detail = errors or result.get("error") or result.get("status") or "stage failed"
        raise error_type(f"{stage} failed: {detail}")
