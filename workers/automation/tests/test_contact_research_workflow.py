"""Supervised contact research — use cases, service, gateway routing (R6 Phase 2).

Exercises what ``ContactResearchWorkflow`` orchestrates (the workflow is a thin
Temporal shell over these): candidates require explicit confirmation (INV-4),
every candidate + attribute carries provenance (INV-2), fetches route through the
politeness gateway and record robots/rate-limit as first-class outcomes (§5.3),
and the LLM spend preflight is the existing shared one (§5.4 — no second system).
"""

from __future__ import annotations

import json
import sqlite3
import urllib.error
from email.message import Message
from pathlib import Path

import pytest

from jobctrl.contact import workflow as contact_workflow
from jobctrl.domain.contact import (
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
from jobctrl.domain.ports.contact import ResearchPageFetch
from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.contact import (
    GatewayContactResearchFetcher,
    SqliteContactRepository,
    SqliteContactResearchTaskRepository,
)
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

_HOST = "acme.example"
_TEAM_URL = f"https://{_HOST}/team"
_SECRET_NAME = "Dana Hiring-Manager"
_SECRET_EMAIL = "dana@acme.example"
_JOB_ID = "11111111-1111-4111-8111-111111111111"


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


class _RecordingLlm(LlmPort):
    def __init__(self) -> None:
        self.calls: list[list[LlmMessage]] = []

    def chat(self, messages, **kwargs) -> str:  # noqa: ANN001, ARG002 - port completeness
        return "{}"

    def chat_json(self, messages: list[LlmMessage], **kwargs) -> dict:  # noqa: ARG002
        self.calls.append(messages)
        return {"candidates": []}


def _counter():
    state = {"n": 0}

    def _next() -> str:
        state["n"] += 1
        return f"id-{state['n']:04d}"

    return _next


def _setup(tmp_path: Path):
    from jobctrl.database import init_db

    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    _seed_job(conn, LOCAL_TENANT, _JOB_ID, "https://jobs.example/contact-research")
    bus = InProcessEventBus()
    ProjectionBuilder(conn_factory=lambda: conn, tenant_id=LOCAL_TENANT).subscribe_to(bus)
    research_repo = SqliteContactResearchTaskRepository(conn, publisher=bus)
    contact_repo = SqliteContactRepository(conn, publisher=bus)
    return conn, research_repo, contact_repo


def _seed_job(conn: sqlite3.Connection, tenant_id: TenantId, job_id: str, url: str) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
        VALUES (?, ?, ?, 'Test job', '2026-07-31T12:00:00Z')
        """,
        (str(tenant_id), job_id, url),
    )
    conn.commit()


def _run_use_case(
    research_repo,
    *,
    fetcher,
    llm,
    sources,
    allowlist=(_HOST,),
    tenant_id: TenantId = LOCAL_TENANT,
    task_id: str = "task-1",
):
    policy = ContactResearchSourcePolicy(domain_allowlist=allowlist)
    use_case = RunContactResearchUseCase(
        repository=research_repo,
        service=ContactResearchService(policy=policy),
        fetcher=fetcher,
        llm=llm,
        new_id=_counter(),
    )
    return use_case.execute(
        tenant_id,
        task_id=task_id,
        link=ContactLink(employer="Acme", job_id=_JOB_ID),
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


def test_research_task_events_preserve_tenant_and_canonical_job_id(tmp_path: Path) -> None:
    conn, research_repo, _contact_repo = _setup(tmp_path)
    tenant_a = TenantId("tenant-a")
    tenant_b = TenantId("tenant-b")
    _seed_job(conn, tenant_a, _JOB_ID, "https://jobs.example/tenant-a")
    _seed_job(conn, tenant_b, _JOB_ID, "https://jobs.example/tenant-b")

    for tenant_id in (tenant_a, tenant_b):
        _run_use_case(
            research_repo,
            tenant_id=tenant_id,
            task_id="same-task-id",
            fetcher=_FakeFetcher(
                ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text="team page body")
            ),
            llm=_FakeLlm([]),
            sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
        )

    rows = conn.execute(
        """
        SELECT tenant_id, job_id, payload_json
        FROM job_events
        WHERE event_type = 'ContactResearchTaskStarted'
        ORDER BY tenant_id
        """
    ).fetchall()
    assert [(row["tenant_id"], row["job_id"]) for row in rows] == [
        (str(tenant_a), _JOB_ID),
        (str(tenant_b), _JOB_ID),
    ]
    assert all(json.loads(row["payload_json"])["jobId"] == _JOB_ID for row in rows)
    assert research_repo.load(tenant_a, "same-task-id") is not None
    assert research_repo.load(tenant_b, "same-task-id") is not None


def test_workflow_reuses_the_shared_spend_preflight() -> None:
    from jobctrl.llm import check_spend_budget

    # The workflow imports the existing preflight activity — no second spend system.
    assert contact_workflow.check_spend_budget is check_spend_budget


class _BlockedSession:
    """Fake PolitenessSession yielding a blocked decision (gateway routing test)."""

    def __init__(self, outcome: str) -> None:
        from jobctrl.domain.ports.politeness import PolitenessDecision, PolitenessOutcome

        self._decision = PolitenessDecision(
            allowed=False, outcome=PolitenessOutcome(outcome), user_agent="JobCtrl/test"
        )

    @property
    def user_agent(self) -> str:
        return "JobCtrl/test"

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
    """Fake PolitenessSession yielding allowed decisions while recording targets."""

    def __init__(self) -> None:
        self.guarded: list[str] = []

    @property
    def user_agent(self) -> str:
        return "JobCtrl/test"

    def guard(self, url: str):
        from contextlib import contextmanager

        from jobctrl.domain.ports.politeness import PolitenessDecision, PolitenessOutcome

        self.guarded.append(url)

        @contextmanager
        def _cm():
            yield PolitenessDecision(
                allowed=True,
                outcome=PolitenessOutcome.ALLOWED,
                user_agent="JobCtrl/test",
            )

        return _cm()

    def note_retry_after(self, url: str, seconds: float) -> None:  # noqa: ARG002
        return None

    def record_server_rate_limit(self, url: str, seconds=None) -> None:  # noqa: ARG002
        return None


class _StaticResponse:
    def __init__(self, url: str, body: bytes, status: int = 200) -> None:
        self._url = url
        self._body = body
        self.status = status

    def __enter__(self) -> "_StaticResponse":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def read(self) -> bytes:
        return self._body


class _RedirectThenSecretOpener:
    def __init__(self, redirect_target: str) -> None:
        self.redirect_target = redirect_target
        self.requests: list[str] = []

    def open(self, request, timeout):  # noqa: ANN001, ARG002
        self.requests.append(request.full_url)
        if len(self.requests) == 1:
            headers = Message()
            headers["Location"] = self.redirect_target
            raise urllib.error.HTTPError(request.full_url, 302, "Found", headers, fp=None)
        return _StaticResponse(
            request.full_url,
            b"<html><body>local profile data: SSRF_LOCAL_SECRET</body></html>",
        )


class _RedirectThenPageOpener:
    def __init__(self, redirect_target: str) -> None:
        self.redirect_target = redirect_target
        self.requests: list[str] = []

    def open(self, request, timeout):  # noqa: ANN001, ARG002
        self.requests.append(request.full_url)
        if len(self.requests) == 1:
            headers = Message()
            headers["Location"] = self.redirect_target
            raise urllib.error.HTTPError(request.full_url, 302, "Found", headers, fp=None)
        return _StaticResponse(
            request.full_url,
            b"<html><body><h1>Team</h1><p>Dana Recruiter</p></body></html>",
        )


class _UnexpectedOpener:
    def open(self, request, timeout):  # noqa: ANN001, ARG002
        raise AssertionError(f"unexpected fetch: {request.full_url}")


def test_gateway_fetcher_returns_block_outcome_without_fetching() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    fetcher = GatewayContactResearchFetcher(
        policy=policy, session=_BlockedSession("robots_disallowed")
    )
    result = fetcher.fetch(_TEAM_URL)
    assert result.outcome == ResearchSourceOutcome.ROBOTS_DISALLOWED.value
    assert result.text == ""


def test_gateway_fetcher_rejects_public_host_resolving_to_private_address() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    session = _AllowedSession()
    fetcher = GatewayContactResearchFetcher(
        policy=policy,
        session=session,
        opener=_UnexpectedOpener(),
        target_resolver=lambda host, port: ("10.0.0.5",),  # noqa: ARG005
    )

    result = fetcher.fetch(_TEAM_URL)

    assert result.outcome == ResearchSourceOutcome.REJECTED.value
    assert result.final_url == _TEAM_URL
    assert result.text == ""
    assert session.guarded == [_TEAM_URL]


def test_gateway_fetcher_rejects_dns_rebind_before_urllib_connect() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    session = _AllowedSession()
    resolutions: list[str] = []

    def rebinding_resolver(host: str, port: int | None) -> tuple[str, ...]:  # noqa: ARG001
        resolutions.append(host)
        return ("93.184.216.34",) if len(resolutions) == 1 else ("10.0.0.5",)

    fetcher = GatewayContactResearchFetcher(
        policy=policy,
        session=session,
        target_resolver=rebinding_resolver,
    )

    result = fetcher.fetch(_TEAM_URL)

    assert result.outcome == ResearchSourceOutcome.REJECTED.value
    assert result.final_url == _TEAM_URL
    assert result.text == ""
    assert session.guarded == [_TEAM_URL]
    assert len(resolutions) == 2


def test_gateway_fetcher_rejects_private_redirect_target_without_fetching_it() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    session = _AllowedSession()
    opener = _RedirectThenSecretOpener("http://127.0.0.1:8766/v1/profile")
    fetcher = GatewayContactResearchFetcher(
        policy=policy,
        session=session,
        opener=opener,
        target_resolver=lambda host, port: ("93.184.216.34",),  # noqa: ARG005
    )

    result = fetcher.fetch(_TEAM_URL)

    assert result.outcome == ResearchSourceOutcome.REJECTED.value
    assert result.final_url == "http://127.0.0.1:8766/v1/profile"
    assert result.text == ""
    assert opener.requests == [_TEAM_URL]
    assert session.guarded == [_TEAM_URL]


def test_gateway_fetcher_allows_public_same_host_redirect() -> None:
    redirected_url = f"https://{_HOST}/people"
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    session = _AllowedSession()
    opener = _RedirectThenPageOpener(redirected_url)
    fetcher = GatewayContactResearchFetcher(
        policy=policy,
        session=session,
        opener=opener,
        target_resolver=lambda host, port: ("93.184.216.34",),  # noqa: ARG005
    )

    result = fetcher.fetch(_TEAM_URL)

    assert result.outcome == ResearchSourceOutcome.ALLOWED.value
    assert result.final_url == redirected_url
    assert "Dana Recruiter" in result.text
    assert opener.requests == [_TEAM_URL, redirected_url]
    assert session.guarded == [_TEAM_URL, redirected_url]


def test_private_redirect_body_never_reaches_llm_prompt(tmp_path: Path) -> None:
    _conn, research_repo, _contact_repo = _setup(tmp_path)
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    fetcher = GatewayContactResearchFetcher(
        policy=policy,
        session=_AllowedSession(),
        opener=_RedirectThenSecretOpener("http://127.0.0.1:8766/v1/profile"),
        target_resolver=lambda host, port: ("93.184.216.34",),  # noqa: ARG005
    )
    llm = _RecordingLlm()
    use_case = RunContactResearchUseCase(
        repository=research_repo,
        service=ContactResearchService(policy=policy),
        fetcher=fetcher,
        llm=llm,
        new_id=_counter(),
    )

    task = use_case.execute(
        LOCAL_TENANT,
        task_id="task-1",
        link=ContactLink(employer="Acme", job_id=_JOB_ID),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )

    assert task.candidates == ()
    assert [attempt.outcome for attempt in task.source_attempts] == [
        ResearchSourceOutcome.REJECTED.value
    ]
    assert llm.calls == []
