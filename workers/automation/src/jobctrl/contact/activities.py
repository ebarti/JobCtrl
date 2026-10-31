"""Temporal activity for supervised contact research (one source family).

The only fetching source family is ``public_web_page`` (user-entered and
user-imported-list data carry no network fetch), so a single activity drives the
whole research run: it authorises each opted-in source against the policy
(INV-3), fetches allowed public pages through the merged politeness gateway
(§5.3), extracts candidates with a schema-driven LLM call (§5.2), and records
them in ``needs_review`` (INV-4) with provenance on every attribute (INV-2).
Heartbeats keep a long run alive.
"""

from __future__ import annotations

from dataclasses import dataclass
from concurrent.futures import CancelledError
import threading
from typing import Any
from urllib.parse import urlsplit

from temporalio import activity
from temporalio.exceptions import ApplicationError

from jobctrl.domain.errors import JobCtrlError, to_application_error
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


@dataclass(frozen=True)
class ResearchSourceInput:
    """One opted-in source for a research run (serialisable activity/workflow arg)."""

    category: str
    url: str = ""
    label: str = ""


@dataclass(frozen=True)
class RunContactResearchActivityInput:
    tenant_id: str
    task_id: str
    employer: str | None = None
    job_id: JobId | None = None
    sources: tuple[ResearchSourceInput, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    expected_app_dir: str | None = None
    expected_db_path: str | None = None

    def __post_init__(self) -> None:
        if self.job_id is not None:
            object.__setattr__(self, "job_id", canonical_job_id(str(self.job_id)))


@dataclass(frozen=True)
class RunContactResearchActivityOutput:
    task_id: str
    status: str
    candidate_count: int = 0
    attempt_count: int = 0
    error_code: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "status": self.status,
            "candidateCount": self.candidate_count,
            "attemptCount": self.attempt_count,
            "errorCode": self.error_code,
        }


@activity.defn(name="run_contact_research")
async def run_contact_research_activity(
    payload: RunContactResearchActivityInput,
) -> RunContactResearchActivityOutput:
    from jobctrl.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    cancel_event = threading.Event()
    try:
        output = await run_blocking_with_heartbeat(
            lambda: _run_contact_research(payload, cancel_event=cancel_event),
            starting_message="contact research starting",
            progress_message="contact research still running",
            activity_name="contact:research",
            on_cancel=cancel_event.set,
        )
        if not (activity.in_activity() and activity.info().is_local):
            activity.heartbeat({
                "status": output.status,
                **({"jobId": str(payload.job_id)} if payload.job_id is not None else {}),
            })
        return output
    except ApplicationError:
        raise
    except JobCtrlError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        raise to_application_error(exc) from exc


def _run_contact_research(
    payload: RunContactResearchActivityInput,
    *,
    cancel_event: threading.Event | None = None,
) -> RunContactResearchActivityOutput:
    from jobctrl.database import get_connection
    from jobctrl.domain.contact import (
        ContactLink,
        ContactResearchService,
        ContactResearchSourcePolicy,
        ResearchSourceCategory,
        ResearchSourceSpec,
        RunContactResearchUseCase,
    )
    from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
    from jobctrl.infrastructure.contact import (
        GatewayContactResearchFetcher,
        SqliteContactResearchTaskRepository,
    )
    from jobctrl.infrastructure.events import get_default_publisher
    from jobctrl.infrastructure.determinations import determination_dependencies
    from jobctrl.infrastructure.network import (
        PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter,
    )
    from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

    conn = get_connection()
    if conn.in_transaction:
        raise RuntimeError("Contact research requires an activity-owned clean connection")
    tenant = TenantId(payload.tenant_id or LOCAL_TENANT)
    job_id = canonical_job_id(str(payload.job_id)) if payload.job_id is not None else None

    # Per-source opt-in (resolved decision 3): the allowlist is exactly the hosts
    # the user explicitly provided — nothing is discovered or fetched autonomously.
    public_hosts = tuple(
        {
            _host(source.url)
            for source in payload.sources
            if source.category == ResearchSourceCategory.PUBLIC_WEB_PAGE.value
            and _host(source.url)
        }
    )
    policy = ContactResearchSourcePolicy(domain_allowlist=public_hosts)
    dependencies = determination_dependencies(conn, tenant_id=tenant, lane="contact", model_spec=payload.llm_model)
    service = ContactResearchService(
        policy=policy,
        determination_repository=dependencies["repository"],
        preflight=dependencies["preflight"],
        provider=dependencies["provider"],
        selected_model=dependencies["model"],
    )
    session = PolitenessSession(
        PolitenessGateway(), policy=policy.source_policy,
        budget=RunBudgetCounter(policy.source_policy.max_requests_per_run),
        context=PolitenessSourceContext(stage="contact_research", adapter="contact_research_fetcher"),
        recorder_conn=conn, defer_recording=True,
    )
    fetcher = GatewayContactResearchFetcher(policy=policy, session=session, cancel_event=cancel_event)
    llm = dependencies["llm"]
    repository = SqliteContactResearchTaskRepository(conn, publisher=get_default_publisher())
    def check_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise CancelledError()

    use_case = RunContactResearchUseCase(
        repository=repository,
        service=service,
        fetcher=fetcher,
        llm=llm,
        check_cancelled=check_cancelled,
    )

    specs = tuple(
        ResearchSourceSpec(category=source.category, url=source.url, label=source.label)
        for source in payload.sources
    )
    execution = use_case.execute_with_outcome(
        tenant,
        task_id=payload.task_id,
        link=ContactLink(employer=payload.employer or None, job_id=job_id),
        sources=specs,
        model=payload.llm_model,
    )
    task = execution.task
    session.flush_deferred()

    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant).refresh()
    return RunContactResearchActivityOutput(
        task_id=task.task_id,
        status="failed" if execution.attempt_failure else task.status.value,
        candidate_count=len(task.candidates),
        attempt_count=len(task.source_attempts),
        error_code=execution.attempt_failure or (task.error_class if task.status.value == "failed" else None),
    )


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


__all__ = [
    "ResearchSourceInput",
    "RunContactResearchActivityInput",
    "RunContactResearchActivityOutput",
    "run_contact_research_activity",
]
