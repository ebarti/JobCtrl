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
from typing import Any
from urllib.parse import urlsplit

from temporalio import activity
from temporalio.exceptions import ApplicationError

from jobhunter.domain.errors import JobHunterError, to_application_error
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


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
    job_url: str | None = None
    sources: tuple[ResearchSourceInput, ...] = ()
    llm_model: str = DEFAULT_PIPELINE_LLM_MODEL_SPEC
    expected_app_dir: str | None = None
    expected_db_path: str | None = None


@dataclass(frozen=True)
class RunContactResearchActivityOutput:
    task_id: str
    status: str
    candidate_count: int = 0
    attempt_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "status": self.status,
            "candidateCount": self.candidate_count,
            "attemptCount": self.attempt_count,
        }


@activity.defn(name="run_contact_research")
async def run_contact_research_activity(
    payload: RunContactResearchActivityInput,
) -> RunContactResearchActivityOutput:
    from jobhunter.infrastructure.temporal.run_in_activity import run_blocking_with_heartbeat
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    try:
        return await run_blocking_with_heartbeat(
            lambda: _run_contact_research(payload),
            starting_message="contact research starting",
            progress_message="contact research still running",
            activity_name="contact:research",
        )
    except ApplicationError:
        raise
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        raise to_application_error(exc) from exc


def _run_contact_research(
    payload: RunContactResearchActivityInput,
) -> RunContactResearchActivityOutput:
    from jobhunter.database import get_connection
    from jobhunter.domain.contact import (
        ContactLink,
        ContactResearchService,
        ContactResearchSourcePolicy,
        ResearchSourceCategory,
        ResearchSourceSpec,
        RunContactResearchUseCase,
    )
    from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
    from jobhunter.infrastructure.contact import (
        GatewayContactResearchFetcher,
        SqliteContactResearchTaskRepository,
    )
    from jobhunter.infrastructure.events import get_default_publisher
    from jobhunter.infrastructure.llm import LlmAdapter, get_llm_adapter
    from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder

    conn = get_connection()
    tenant = TenantId(payload.tenant_id or LOCAL_TENANT)

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
    service = ContactResearchService(policy=policy)
    fetcher = GatewayContactResearchFetcher(policy=policy, recorder_conn=conn)
    llm = LlmAdapter(default_model=payload.llm_model) if payload.llm_model else get_llm_adapter()
    repository = SqliteContactResearchTaskRepository(conn, publisher=get_default_publisher())
    use_case = RunContactResearchUseCase(
        repository=repository,
        service=service,
        fetcher=fetcher,
        llm=llm,
    )

    specs = tuple(
        ResearchSourceSpec(category=source.category, url=source.url, label=source.label)
        for source in payload.sources
    )
    task = use_case.execute(
        tenant,
        task_id=payload.task_id,
        link=ContactLink(employer=payload.employer or None, job_id=payload.job_url or None),
        sources=specs,
        model=payload.llm_model,
    )

    activity.heartbeat({"status": task.status.value})
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=tenant).refresh()
    return RunContactResearchActivityOutput(
        task_id=task.task_id,
        status=task.status.value,
        candidate_count=len(task.candidates),
        attempt_count=len(task.source_attempts),
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
