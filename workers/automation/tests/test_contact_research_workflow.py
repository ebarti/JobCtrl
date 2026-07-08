"""Supervised contact research — use cases, service, gateway routing (R6 Phase 2).

Exercises what ``ContactResearchWorkflow`` orchestrates (the workflow is a thin
Temporal shell over these): candidates require explicit confirmation (INV-4),
every candidate + attribute carries provenance (INV-2), fetches route through the
politeness gateway and record robots/rate-limit as first-class outcomes (§5.3),
and the LLM spend preflight is the existing shared one (§5.4 — no second system).
"""

from __future__ import annotations

import sqlite3
import urllib.error
from email.message import Message
from pathlib import Path

import pytest

from jobhunter.contact import workflow as contact_workflow
from jobhunter.domain.contact import (
    CandidateStatus,
    ContactLink,
    ContactResearchService,
    ContactResearchSourcePolicy,
    ConfirmContactCandidateUseCase,
    ContactResearchInputError,
    ResearchSourceOutcome,
    ResearchSourceSpec,
    ResearchTaskStatus,
    RunContactResearchUseCase,
)
from jobhunter.domain.ports.contact import ResearchPageFetch
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.contact import (
    GatewayContactResearchFetcher,
    SqliteContactRepository,
    SqliteContactResearchTaskRepository,
)
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder

_HOST = "acme.example"
_TEAM_URL = f"https://{_HOST}/team"
_SECRET_NAME = "Dana Hiring-Manager"
_SECRET_EMAIL = "dana@acme.example"


class _FakeFetcher:
    def __init__(self, result: ResearchPageFetch) -> None:
        self._result = result
        self.calls: list[str] = []

    def fetch(self, url: str) -> ResearchPageFetch:
        self.calls.append(url)
        return self._result


class _FakeLlm(LlmPort):
    def __init__(self, candidates: list[dict]) -> None:
        self._candidates = candidates
        self.calls = 0

    def chat(self, messages, **kwargs) -> str:  # noqa: ANN001, ARG002 - port completeness
        return "{}"

    def chat_json(self, messages: list[LlmMessage], **kwargs) -> dict:  # noqa: ARG002
        self.calls += 1
        return {"candidates": self._candidates}


def _counter():
    state = {"n": 0}

    def _next() -> str:
        state["n"] += 1
        return f"id-{state['n']:04d}"

    return _next


def _setup(tmp_path: Path):
    from jobhunter.database import init_db

    conn = init_db(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    bus = InProcessEventBus()
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).subscribe_to(bus)
    research_repo = SqliteContactResearchTaskRepository(conn, publisher=bus)
    contact_repo = SqliteContactRepository(conn, publisher=bus)
    return conn, research_repo, contact_repo


def _run_use_case(research_repo, *, fetcher, llm, sources, allowlist=(_HOST,)):
    policy = ContactResearchSourcePolicy(domain_allowlist=allowlist)
    use_case = RunContactResearchUseCase(
        repository=research_repo,
        service=ContactResearchService(policy=policy),
        fetcher=fetcher,
        llm=llm,
        new_id=_counter(),
    )
    return use_case.execute(
        LOCAL_TENANT,
        task_id="task-1",
        link=ContactLink(employer="Acme", job_id="https://job/1"),
        sources=sources,
    )


def test_run_proposes_candidates_needing_review_with_provenance(tmp_path: Path) -> None:
    _conn, research_repo, _contact_repo = _setup(tmp_path)
    fetcher = _FakeFetcher(
        ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text="team page body")
    )
    llm = _FakeLlm(
        [{"name": _SECRET_NAME, "email": _SECRET_EMAIL, "role": "hiring_manager", "confidence": 0.8}]
    )
    task = _run_use_case(
        research_repo,
        fetcher=fetcher,
        llm=llm,
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )

    assert task.status is ResearchTaskStatus.NEEDS_REVIEW
    assert len(task.candidates) == 1
    candidate = task.candidates[0]
    # INV-4: proposed candidate awaits review, not confirmed.
    assert candidate.status is CandidateStatus.NEEDS_REVIEW
    assert candidate.confirmed_contact_id is None
    # INV-2: candidate + every attribute carries provenance; nothing user-confirmed yet.
    assert candidate.provenance.source_kind == "public_web_page"
    assert candidate.provenance.user_confirmed is False
    assert candidate.attributes and all(
        attr.provenance.source_kind == "public_web_page"
        and attr.provenance.capture_method == "llm_assisted"
        and attr.provenance.user_confirmed is False
        for attr in candidate.attributes
    )
    assert fetcher.calls == [_TEAM_URL]


def test_robots_and_rate_limit_are_recorded_as_outcomes_not_errors(tmp_path: Path) -> None:
    _conn, research_repo, _contact_repo = _setup(tmp_path)
    fetcher = _FakeFetcher(
        ResearchPageFetch(outcome=ResearchSourceOutcome.ROBOTS_DISALLOWED.value)
    )
    task = _run_use_case(
        research_repo,
        fetcher=fetcher,
        llm=_FakeLlm([]),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    assert task.candidates == ()
    assert task.status is ResearchTaskStatus.NEEDS_REVIEW
    assert [attempt.outcome for attempt in task.source_attempts] == [
        ResearchSourceOutcome.ROBOTS_DISALLOWED.value
    ]


def test_disallowed_source_is_rejected_without_fetching(tmp_path: Path) -> None:
    _conn, research_repo, _contact_repo = _setup(tmp_path)
    fetcher = _FakeFetcher(ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text="x"))
    # Host is not on the opt-in allowlist -> rejected before any fetch.
    task = _run_use_case(
        research_repo,
        fetcher=fetcher,
        llm=_FakeLlm([{"name": "X"}]),
        sources=(ResearchSourceSpec(category="public_web_page", url="https://evil.example/x"),),
        allowlist=(_HOST,),
    )
    assert fetcher.calls == []
    assert task.candidates == ()
    assert [attempt.outcome for attempt in task.source_attempts] == [
        ResearchSourceOutcome.REJECTED.value
    ]


def test_confirm_candidate_requires_command_and_promotes_to_contact(tmp_path: Path) -> None:
    conn, research_repo, contact_repo = _setup(tmp_path)
    fetcher = _FakeFetcher(
        ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text="team page body")
    )
    llm = _FakeLlm([{"name": _SECRET_NAME, "email": _SECRET_EMAIL, "role": "hiring_manager"}])
    task = _run_use_case(
        research_repo,
        fetcher=fetcher,
        llm=llm,
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    candidate_id = task.candidates[0].candidate_id

    # INV-4: no Contact exists until the explicit confirm command runs.
    assert contact_repo.list_for_tenant(LOCAL_TENANT) == []

    confirm = ConfirmContactCandidateUseCase(
        research_repository=research_repo,
        contact_repository=contact_repo,
    )
    result = confirm.execute(LOCAL_TENANT, task_id="task-1", candidate_id=candidate_id)

    # The candidate became a stored Contact, provenance preserved + user-confirmed.
    stored = contact_repo.list_for_tenant(LOCAL_TENANT)
    assert len(stored) == 1
    name_attr = stored[0].attribute("name")
    assert name_attr is not None
    assert name_attr.value == _SECRET_NAME
    assert name_attr.provenance.source_kind == "public_web_page"
    assert name_attr.provenance.user_confirmed is True

    # The task auto-completes once nothing awaits review; completion event emitted.
    assert result.task.status is ResearchTaskStatus.COMPLETED
    completed = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactResearchTaskCompleted'"
    ).fetchone()[0]
    assert completed == 1

    # Re-confirming the now-confirmed candidate is rejected.
    with pytest.raises(ContactResearchInputError):
        confirm.execute(LOCAL_TENANT, task_id="task-1", candidate_id=candidate_id)


def test_candidate_values_never_leak_into_events(tmp_path: Path) -> None:
    conn, research_repo, _contact_repo = _setup(tmp_path)
    fetcher = _FakeFetcher(
        ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text="team page body")
    )
    llm = _FakeLlm([{"name": _SECRET_NAME, "email": _SECRET_EMAIL, "role": "recruiter"}])
    _run_use_case(
        research_repo,
        fetcher=fetcher,
        llm=llm,
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    events_blob = " ".join(
        str(row[0]) for row in conn.execute("SELECT payload_json FROM job_events").fetchall()
    )
    assert _SECRET_NAME not in events_blob
    assert _SECRET_EMAIL not in events_blob
    # A ContactCandidateProposed event was recorded (safe metadata only).
    proposed = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactCandidateProposed'"
    ).fetchone()[0]
    assert proposed == 1


def test_workflow_reuses_the_shared_spend_preflight() -> None:
    from jobhunter.llm import check_spend_budget

    # The workflow imports the existing preflight activity — no second spend system.
    assert contact_workflow.check_spend_budget is check_spend_budget


class _BlockedSession:
    """Fake PolitenessSession yielding a blocked decision (gateway routing test)."""

    def __init__(self, outcome: str) -> None:
        from jobhunter.domain.ports.politeness import PolitenessDecision, PolitenessOutcome

        self._decision = PolitenessDecision(
            allowed=False, outcome=PolitenessOutcome(outcome), user_agent="JobHunter/test"
        )

    @property
    def user_agent(self) -> str:
        return "JobHunter/test"

    def guard(self, url: str):  # noqa: ARG002
        from contextlib import contextmanager

        decision = self._decision

        @contextmanager
        def _cm():
            yield decision

        return _cm()

    def note_retry_after(self, url: str, seconds: float) -> None:  # noqa: ARG002
        return None

    def record_server_rate_limit(self, url: str, seconds=None) -> None:  # noqa: ARG002
        return None


class _AllowedSession:
    @property
    def user_agent(self) -> str:
        return "JobHunter/test"

    def guard(self, url: str):  # noqa: ARG002
        from contextlib import contextmanager

        from jobhunter.domain.ports.politeness import PolitenessDecision, PolitenessOutcome

        @contextmanager
        def _cm():
            yield PolitenessDecision(
                allowed=True,
                outcome=PolitenessOutcome.ALLOWED,
                user_agent="JobHunter/test",
            )

        return _cm()

    def note_retry_after(self, url: str, seconds: float) -> None:  # noqa: ARG002
        return None

    def record_server_rate_limit(self, url: str, seconds=None) -> None:  # noqa: ARG002
        return None


class _RedirectOpener:
    def open(self, request, timeout):  # noqa: ANN001, ARG002
        headers = Message()
        headers["Location"] = "http://127.0.0.1:8766/v1/profile"
        raise urllib.error.HTTPError(
            request.full_url,
            302,
            "Found",
            headers,
            fp=None,
        )


def test_gateway_fetcher_returns_block_outcome_without_fetching() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    fetcher = GatewayContactResearchFetcher(
        policy=policy, session=_BlockedSession("robots_disallowed")
    )
    result = fetcher.fetch(_TEAM_URL)
    assert result.outcome == ResearchSourceOutcome.ROBOTS_DISALLOWED.value
    assert result.text == ""


def test_gateway_fetcher_rejects_private_redirect_target() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    fetcher = GatewayContactResearchFetcher(
        policy=policy, session=_AllowedSession(), opener=_RedirectOpener()
    )

    result = fetcher.fetch(_TEAM_URL)

    assert result.outcome == ResearchSourceOutcome.REJECTED.value
    assert result.final_url == "http://127.0.0.1:8766/v1/profile"
    assert result.text == ""
