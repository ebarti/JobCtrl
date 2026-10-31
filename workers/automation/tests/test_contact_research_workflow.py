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
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
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
        source = json.loads(messages[1].content)["sources"][0]
        source_text, source_id = source["text"], source["source_id"]
        candidates = []
        for item in self._candidates:
            candidate = {"role": item.get("role", "other"), "confidence": item.get("confidence", 0.5)}
            for field in ("name", "title", "email", "profileUrl"):
                if field in item:
                    start = source_text.index(item[field])
                    candidate[field] = {"source_id": source_id, "start": start, "end": start + len(item[field])}
            candidates.append(candidate)
        return {"source_id": source_id, "candidates": candidates}


class _RecordingLlm(LlmPort):
    def __init__(self) -> None:
        self.calls: list[list[LlmMessage]] = []

    def chat(self, messages, **kwargs) -> str:  # noqa: ANN001, ARG002 - port completeness
        return "{}"

    def chat_json(self, messages: list[LlmMessage], **kwargs) -> dict:  # noqa: ARG002
        self.calls.append(messages)
        return {"source_id": json.loads(messages[1].content)["sources"][0]["source_id"], "candidates": []}


@pytest.fixture(autouse=True)
def _synthetic_activity_dependencies(monkeypatch):
    """Keep activity tests off the user's provider, settings and spend database."""
    from jobctrl.infrastructure import determinations, llm as llm_infra

    monkeypatch.setattr(llm_infra, "LlmAdapter", lambda **_kwargs: _RecordingLlm())

    def dependencies(conn, *, tenant_id, lane, model_spec=None, adapter=None):
        return {
            "llm": adapter or llm_infra.LlmAdapter(default_model=model_spec),
            "repository": determinations.SqliteDeterminationRepository(conn),
            "tenant_id": str(tenant_id), "lane": lane,
            "provider": "synthetic", "model": "synthetic", "preflight": lambda: None,
        }

    monkeypatch.setattr(determinations, "determination_dependencies", dependencies)


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
        service=ContactResearchService(
            policy=policy,
            determination_repository=SqliteDeterminationRepository(research_repo._conn),
            preflight=lambda: None, provider="synthetic", selected_model="synthetic",
        ),
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
        ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text=f"Team: {_SECRET_NAME} {_SECRET_EMAIL}")
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
        ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text=f"Team: {_SECRET_NAME} {_SECRET_EMAIL}")
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
        ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text=f"Team: {_SECRET_NAME} {_SECRET_EMAIL}")
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
                ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, text=f"Team: {_SECRET_NAME} {_SECRET_EMAIL}")
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

    def guard(self, url: str, **_kwargs):  # noqa: ARG002
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

    def guard(self, url: str, **_kwargs):
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

    def read(self, size: int = -1) -> bytes:
        body = self._body if size < 0 else self._body[:size]
        self._body = self._body[len(body):]
        return body


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


class _BoundedResponse:
    def __init__(self, url: str, body: bytes, *, declared: str | None = None, delay: float = 0) -> None:
        from threading import Event

        self.url = url
        self.body = body
        self.status = 200
        self.headers = Message()
        if declared is not None:
            self.headers["Content-Length"] = declared
        self.delay = delay
        self.closed = False
        self.started = Event()
        self.stopped = Event()
        self.read_sizes: list[int] = []
        self.received = 0

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def geturl(self):
        return self.url

    def read1(self, size: int) -> bytes:
        self.read_sizes.append(size)
        self.started.set()
        if self.delay and self.stopped.wait(self.delay):
            return b""
        if self.delay:
            size = min(size, 1)
        chunk, self.body = self.body[:size], self.body[size:]
        self.received += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True
        self.stopped.set()


class _QueueOpener:
    def __init__(self, *responses, delay: float = 0) -> None:
        self.responses = list(responses)
        self.requests: list[str] = []
        self.timeouts: list[float] = []
        self.delay = delay

    def open(self, request, timeout):
        import time

        self.requests.append(request.full_url)
        self.timeouts.append(timeout)
        if self.delay:
            time.sleep(self.delay)
        value = self.responses.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


def _bounded_fetcher(opener, *, timeout=0.3, limit=32, cancel_event=None, session=None):
    from dataclasses import replace
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure.network import (
        PolitenessGateway,
        PolitenessSession,
        PolitenessSourceContext,
        RunBudgetCounter,
    )
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    policy = replace(policy, source_policy=replace(policy.source_policy, min_request_interval_seconds=0))
    if session is None:
        session = PolitenessSession(
            PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=HostRateLimiter()),
            policy=policy.source_policy,
            budget=RunBudgetCounter(8),
            context=PolitenessSourceContext(stage="contact_research"),
        )
    return GatewayContactResearchFetcher(
        policy=policy, session=session, opener=opener, timeout=timeout,
        max_body_bytes=limit, cancel_event=cancel_event,
        target_resolver=lambda *_args: ("93.184.216.34",),
    ), session


def _redirect(url: str, target: str | None):
    import io

    headers = Message()
    if target is not None:
        headers["Location"] = target
    body = io.BytesIO(b"ignored redirect body")
    return urllib.error.HTTPError(url, 302, "Found", headers, body), body


def test_public_fetch_accepts_bounded_body_and_rejects_declared_and_streamed_oversize() -> None:
    valid = _BoundedResponse(_TEAM_URL, b"<p>Team</p>")
    declared = _BoundedResponse(_TEAM_URL, b"ignored", declared="1000")
    chunked = _BoundedResponse(_TEAM_URL, b"x" * 200)
    opener = _QueueOpener(valid, declared, chunked)
    fetcher, _session = _bounded_fetcher(opener, limit=32)

    good = fetcher.fetch(_TEAM_URL)
    too_large_header = fetcher.fetch(_TEAM_URL)
    too_large_stream = fetcher.fetch(_TEAM_URL)

    assert good.outcome == "allowed" and good.text == "Team"
    assert too_large_header.outcome == "response_too_large"
    assert too_large_stream.outcome == "response_too_large"
    assert declared.read_sizes == []
    assert chunked.received == 33 and max(chunked.read_sizes) <= 33
    assert valid.closed and declared.closed and chunked.closed


def test_production_default_rejects_an_oversized_declared_page_before_reading() -> None:
    response = _BoundedResponse(_TEAM_URL, b"not read", declared="2000001")
    fetcher = GatewayContactResearchFetcher(
        policy=ContactResearchSourcePolicy(domain_allowlist=(_HOST,)),
        session=_AllowedSession(), opener=_QueueOpener(response),
        target_resolver=lambda *_args: ("93.184.216.34",),
    )
    assert fetcher.fetch(_TEAM_URL).outcome == "response_too_large"
    assert response.read_sizes == [] and response.closed


def test_progressing_body_hits_whole_acquisition_deadline_and_closes() -> None:
    import time

    response = _BoundedResponse(_TEAM_URL, b"<p>slow page</p>" * 10, delay=0.04)
    fetcher, _session = _bounded_fetcher(_QueueOpener(response), timeout=0.13, limit=200)
    start = time.monotonic()
    result = fetcher.fetch(_TEAM_URL)
    elapsed = time.monotonic() - start
    assert result.outcome == "acquisition_timeout" and not result.text
    assert response.closed and response.received > 0
    assert elapsed < 0.25


def test_redirects_share_deadline_close_previous_response_and_release_host_slot() -> None:
    import time

    target = f"https://{_HOST}/people"
    redirect, redirect_body = _redirect(_TEAM_URL, target)
    page = _BoundedResponse(target, b"<p>Ada</p>", delay=0.04)
    opener = _QueueOpener(redirect, page, delay=0.04)
    fetcher, session = _bounded_fetcher(opener, timeout=0.15, limit=100)
    start = time.monotonic()
    result = fetcher.fetch(_TEAM_URL)
    elapsed = time.monotonic() - start
    assert result.outcome == "acquisition_timeout"
    assert redirect_body.closed and page.closed
    assert opener.requests == [_TEAM_URL, target]
    assert opener.timeouts[1] < opener.timeouts[0]
    assert session.budget.consumed() == 2
    assert elapsed < 0.27


def test_redirect_failures_and_transport_errors_are_not_empty_successes() -> None:
    bad_redirect, body = _redirect(_TEAM_URL, None)
    opener = _QueueOpener(bad_redirect, urllib.error.URLError("synthetic network failure"))
    fetcher, _session = _bounded_fetcher(opener)
    assert fetcher.fetch(_TEAM_URL).outcome == "redirect_failed"
    assert body.closed
    assert fetcher.fetch(_TEAM_URL).outcome == "transport_failed"


def test_http_error_and_redirect_limit_are_distinct_and_close_error_bodies() -> None:
    import io

    http_body = io.BytesIO(b"not found")
    http_error = urllib.error.HTTPError(_TEAM_URL, 404, "missing", Message(), http_body)
    redirect, redirect_body = _redirect(_TEAM_URL, f"https://{_HOST}/people")
    fetcher, _ = _bounded_fetcher(_QueueOpener(http_error, redirect))
    fetcher._max_redirects = 0
    assert fetcher.fetch(_TEAM_URL).outcome == "http_error"
    assert fetcher.fetch(_TEAM_URL).outcome == "redirect_failed"
    assert http_body.closed and redirect_body.closed


def test_same_host_redirect_succeeds_with_real_gateway_and_budget() -> None:
    target = f"https://{_HOST}/people"
    redirect, body = _redirect(_TEAM_URL, target)
    page = _BoundedResponse(target, b"<p>Team</p>")
    fetcher, session = _bounded_fetcher(_QueueOpener(redirect, page), limit=32)
    result = fetcher.fetch(_TEAM_URL)
    assert result.outcome == "allowed" and result.final_url == target and result.text == "Team"
    assert body.closed and page.closed
    assert session.budget.consumed() == 2


def test_active_cancellation_closes_response_and_releases_host_slot() -> None:
    from concurrent.futures import CancelledError, ThreadPoolExecutor
    from threading import Event

    cancelled = Event()
    response = _BoundedResponse(_TEAM_URL, b"a" * 1000, delay=2)
    opener = _QueueOpener(response, _BoundedResponse(_TEAM_URL, b"ok"))
    fetcher, session = _bounded_fetcher(opener, timeout=2, limit=2048, cancel_event=cancelled)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fetcher.fetch, _TEAM_URL)
        assert response.started.wait(1)
        cancelled.set()
        with pytest.raises(CancelledError):
            future.result(timeout=0.5)
    assert response.closed
    # A new fetch can immediately acquire the same actual host slot.
    replacement, _ = _bounded_fetcher(opener, timeout=0.3, session=session)
    assert replacement.fetch(_TEAM_URL).text == "ok"


def test_queued_cancellation_releases_admission_without_an_outbound_request() -> None:
    from concurrent.futures import CancelledError, ThreadPoolExecutor
    from threading import Event
    import time

    cancelled = Event()
    opener = _QueueOpener(_BoundedResponse(_TEAM_URL, b"ok"))
    fetcher, session = _bounded_fetcher(opener, timeout=2, cancel_event=cancelled)
    with session.guard(_TEAM_URL):
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(fetcher.fetch, _TEAM_URL)
            deadline = time.monotonic() + 0.5
            while session.budget.consumed() < 2 and time.monotonic() < deadline:
                time.sleep(0.005)
            assert session.budget.consumed() == 2  # queued behind the held host slot
            cancelled.set()
            with pytest.raises(CancelledError):
                future.result(timeout=0.5)
        assert opener.requests == []
    replacement, _ = _bounded_fetcher(opener, timeout=0.3, session=session)
    assert replacement.fetch(_TEAM_URL).text == "ok"


def test_waiting_for_host_admission_counts_against_deadline() -> None:
    import time
    from concurrent.futures import ThreadPoolExecutor

    opener = _QueueOpener(_BoundedResponse(_TEAM_URL, b"ok"))
    fetcher, session = _bounded_fetcher(opener, timeout=0.1)
    with session.guard(_TEAM_URL):
        start = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(fetcher.fetch, _TEAM_URL).result(timeout=0.5)
        assert result.outcome == "acquisition_timeout"
        assert time.monotonic() - start < 0.3
        assert opener.requests == []


def test_retry_keeps_existing_proposal_and_failed_new_task_records_actionable_outcome(tmp_path: Path) -> None:
    _conn, research_repo, _ = _setup(tmp_path)
    sources = (ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),)
    original = _run_use_case(
        research_repo, fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person synthetic")),
        llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=sources,
    )
    response = _BoundedResponse(_TEAM_URL, b"x" * 100)
    failing, _session = _bounded_fetcher(_QueueOpener(response), limit=10)
    retry = _run_use_case(research_repo, fetcher=failing, llm=_FakeLlm([]), sources=sources)
    assert retry == original == research_repo.load(LOCAL_TENANT, "task-1")
    assert not response.started.is_set()

    failed = _run_use_case(
        research_repo, fetcher=failing, llm=_FakeLlm([]), sources=sources, task_id="task-2",
    )
    assert failed.source_attempts[0].outcome == "response_too_large"
    assert "too large" in failed.source_attempts[0].detail
    assert research_repo.load(LOCAL_TENANT, "task-1") == original
    assert response.closed


def test_slow_http_headers_are_interrupted_at_deadline_with_no_network(monkeypatch) -> None:
    """Exercise real HTTP parsing and the production socket shutdown boundary."""
    import http.client
    import socket
    import threading
    import time
    from jobctrl.infrastructure.contact import research_fetcher as module

    client, server = socket.socketpair()
    sent = threading.Event()

    def send_slow_headers() -> None:
        try:
            server.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")
            sent.set()
            for _ in range(40):
                time.sleep(0.03)
                server.sendall(b"x")
        except OSError:
            pass
        finally:
            server.close()

    class SocketOpener:
        def __init__(self, factory):
            self.factory = factory

        def open(self, request, timeout):
            sock = self.factory(socket.AF_INET, socket.SOCK_STREAM, 0)
            sock.settimeout(timeout)
            response = http.client.HTTPResponse(sock)
            try:
                response.begin()
            except BaseException:
                response.close()
                raise
            response.geturl = lambda: request.full_url
            return response

    monkeypatch.setattr(module.socket, "socket", lambda *_args: client)
    monkeypatch.setattr(
        module, "build_public_http_opener",
        lambda **kwargs: SocketOpener(kwargs["socket_factory"]),
    )
    sender = threading.Thread(target=send_slow_headers, daemon=True)
    sender.start()
    fetcher, _session = _bounded_fetcher(None, timeout=0.14, limit=32)
    start = time.monotonic()
    result = fetcher.fetch(_TEAM_URL)
    elapsed = time.monotonic() - start
    sender.join(0.5)
    assert sent.is_set()
    assert result.outcome == "acquisition_timeout"
    assert elapsed < 0.3
    assert not sender.is_alive(), "the actual socket was not interrupted"


def test_slow_chunked_http_body_is_interrupted_at_deadline_with_no_network(monkeypatch) -> None:
    import http.client
    import socket
    import threading
    import time
    from jobctrl.infrastructure.contact import research_fetcher as module

    client, server = socket.socketpair()
    closed = threading.Event()

    def send_slow_chunks() -> None:
        try:
            server.sendall(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            for _ in range(40):
                server.sendall(b"1\r\nx\r\n")
                time.sleep(0.03)
        except OSError:
            closed.set()
        finally:
            server.close()

    class SocketOpener:
        def __init__(self, factory):
            self.factory = factory

        def open(self, request, timeout):
            sock = self.factory(socket.AF_INET, socket.SOCK_STREAM, 0)
            sock.settimeout(timeout)
            response = http.client.HTTPResponse(sock)
            response.begin()
            response.geturl = lambda: request.full_url
            return response

    monkeypatch.setattr(module.socket, "socket", lambda *_args: client)
    monkeypatch.setattr(module, "build_public_http_opener", lambda **kwargs: SocketOpener(kwargs["socket_factory"]))
    sender = threading.Thread(target=send_slow_chunks, daemon=True)
    sender.start()
    fetcher, _session = _bounded_fetcher(None, timeout=0.14, limit=100)
    start = time.monotonic()
    result = fetcher.fetch(_TEAM_URL)
    elapsed = time.monotonic() - start
    sender.join(0.5)
    assert result.outcome == "acquisition_timeout" and not result.text
    assert elapsed < 0.3 and closed.is_set() and not sender.is_alive()


@pytest.mark.parametrize("failing_lookup", [1, 2])
@pytest.mark.parametrize("failure", ["timeout", "timedout_errno", "dns_error"])
def test_dns_timeouts_remain_distinct_from_other_dns_failures(
    monkeypatch, failing_lookup: int, failure: str,
) -> None:
    import errno
    import socket
    from jobctrl.infrastructure.contact import research_fetcher as module
    from jobctrl.infrastructure.network.public_http import resolve_public_addrinfos

    calls = 0

    def resolver(*_args):
        nonlocal calls
        calls += 1
        if calls == failing_lookup:
            if failure == "timeout":
                raise TimeoutError("synthetic DNS timeout")
            if failure == "timedout_errno":
                raise OSError(errno.ETIMEDOUT, "synthetic DNS timeout")
            raise socket.gaierror(socket.EAI_AGAIN, "synthetic DNS failure")
        return ("93.184.216.34",)

    class RevalidatingOpener:
        def __init__(self, resolver):
            self.resolver = resolver

        def open(self, _request, timeout):  # noqa: ARG002
            resolve_public_addrinfos(_HOST, 443, resolver=self.resolver)
            raise AssertionError("a failed DNS lookup must not reach a socket")

    fetcher, _ = _bounded_fetcher(None)
    fetcher._resolver = module._resolver_from_target_resolver(resolver)
    monkeypatch.setattr(
        module, "build_public_http_opener", lambda **kwargs: RevalidatingOpener(kwargs["resolver"]),
    )
    result = fetcher.fetch(_TEAM_URL)
    assert calls == failing_lookup
    assert result.outcome == ("transport_failed" if failure == "dns_error" else "acquisition_timeout")
    assert not result.text


def test_stalled_dns_is_bounded_and_cannot_open_after_timeout(monkeypatch) -> None:
    import time
    from threading import BoundedSemaphore, Event
    from jobctrl.infrastructure.contact import research_fetcher as module

    started, release, exited = Event(), Event(), Event()
    calls: list[bool] = []
    opener = _QueueOpener(_BoundedResponse(_TEAM_URL, b"unexpected"))

    def resolver(*_args):
        calls.append(True)
        started.set()
        try:
            release.wait(1)
            return ("93.184.216.34",)
        finally:
            exited.set()

    fetcher, _ = _bounded_fetcher(opener, timeout=0.1)
    only_slot = BoundedSemaphore(1)
    monkeypatch.setattr(module, "_ACQUISITION_SLOTS", only_slot)
    fetcher._resolver = module._resolver_from_target_resolver(resolver)
    start = time.monotonic()
    try:
        result = fetcher.fetch(_TEAM_URL)
        assert result.outcome == "acquisition_timeout"
        assert started.is_set() and time.monotonic() - start < 0.23
        assert opener.requests == []
        # An uninterruptible resolver continues to occupy its bounded slot.
        assert fetcher.fetch(_TEAM_URL).outcome == "acquisition_timeout"
        assert len(calls) == 1 and opener.requests == []
    finally:
        release.set()
    assert exited.wait(0.3)
    assert only_slot.acquire(timeout=0.3)
    only_slot.release()
    assert opener.requests == []


def test_actual_activity_records_fetch_failure_without_llm_or_replacing_previous_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.contact import activities
    from jobctrl.contact.activities import ResearchSourceInput, RunContactResearchActivityInput
    from jobctrl import database
    from jobctrl.infrastructure import contact as contact_infra
    from jobctrl.infrastructure import llm as llm_infra
    from jobctrl.infrastructure import events as events_infra

    conn, research_repo, _ = _setup(tmp_path)
    sources = (ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),)
    previous = _run_use_case(
        research_repo, fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person synthetic")),
        llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=sources,
    )
    response = _BoundedResponse(_TEAM_URL, b"x" * 100)
    fetcher, _ = _bounded_fetcher(_QueueOpener(response), limit=10)
    llm = _RecordingLlm()
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(contact_infra, "GatewayContactResearchFetcher", lambda **_kwargs: fetcher)
    monkeypatch.setattr(llm_infra, "LlmAdapter", lambda **_kwargs: llm)
    monkeypatch.setattr(events_infra, "get_default_publisher", lambda: InProcessEventBus())
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)

    payload = RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="task-2", employer="Acme", job_id=_JOB_ID,
        sources=(ResearchSourceInput(category="public_web_page", url=_TEAM_URL),),
    )
    output = activities._run_contact_research(payload)
    saved = research_repo.load(LOCAL_TENANT, "task-2")
    assert output.status == "needs_review" and output.candidate_count == 0
    assert saved is not None and saved.source_attempts[0].outcome == "response_too_large"
    assert saved.source_attempts[0].detail and llm.calls == []
    assert research_repo.load(LOCAL_TENANT, "task-1") == previous
    assert response.closed


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("small", "no_candidates"),
        ("oversize", "response_too_large"),
        ("timeout", "acquisition_timeout"),
        ("redirect", "redirect_failed"),
        ("transport", "transport_failed"),
        ("http", "http_error"),
    ],
)
def test_actual_activity_uses_production_fetch_limits_and_persists_distinct_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str, expected: str,
) -> None:
    """Exercise the real activity/fetcher wiring with synthetic transport only."""
    import io

    from jobctrl import config, database
    from jobctrl.contact import activities
    from jobctrl.contact.activities import ResearchSourceInput, RunContactResearchActivityInput
    from jobctrl.infrastructure import events as events_infra
    from jobctrl.infrastructure import llm as llm_infra
    from jobctrl.infrastructure.contact import research_fetcher as fetch_module

    conn, research_repo, _ = _setup(tmp_path)
    previous = _run_use_case(
        research_repo,
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person synthetic")),
        llm=_FakeLlm([{"name": "Synthetic Person"}]),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    url = f"https://{case}.synthetic.example/team"
    body = None
    if case == "small":
        response = _BoundedResponse(url, b"<p>Synthetic team</p>")
    elif case == "oversize":
        response = _BoundedResponse(url, b"not read", declared="2000001")
    elif case == "timeout":
        response = TimeoutError("synthetic timeout")
    elif case == "redirect":
        response, body = _redirect(url, None)
    elif case == "transport":
        response = urllib.error.URLError("synthetic transport failure")
    else:
        body = io.BytesIO(b"synthetic HTTP error")
        response = urllib.error.HTTPError(url, 404, "missing", Message(), body)
    opener = _QueueOpener(response)
    llm = _RecordingLlm()
    limits = []
    fetch = GatewayContactResearchFetcher.fetch

    def record_limits(self, source_url):
        limits.append((self._max_body_bytes, self._timeout))
        return fetch(self, source_url)

    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(config, "load_saved_search_settings", lambda: {})
    monkeypatch.setattr(llm_infra, "LlmAdapter", lambda **_kwargs: llm)
    monkeypatch.setattr(llm_infra, "get_llm_adapter", lambda: llm)
    monkeypatch.setattr(events_infra, "get_default_publisher", lambda: InProcessEventBus())
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)
    monkeypatch.setattr(fetch_module, "_resolve_target_addresses", lambda *_args: ("93.184.216.34",))
    monkeypatch.setattr(fetch_module, "build_public_http_opener", lambda **_kwargs: opener)
    monkeypatch.setattr(GatewayContactResearchFetcher, "fetch", record_limits)

    payload = RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="task-2", employer="Acme", job_id=_JOB_ID,
        sources=(ResearchSourceInput(category="public_web_page", url=url),),
    )
    output = activities._run_contact_research(payload)
    saved = research_repo.load(LOCAL_TENANT, "task-2")
    assert output.status == "needs_review" and output.candidate_count == 0
    assert limits == [(2_000_000, 20.0)]
    assert opener.requests == [url]
    assert saved is not None and saved.source_attempts[0].outcome == expected
    assert len(llm.calls) == (1 if case == "small" else 0)
    if case != "small":
        assert saved.source_attempts[0].detail
    if case in {"small", "oversize"}:
        assert response.closed
    if case == "oversize":
        assert response.read_sizes == []
    if body is not None:
        assert body.closed

    # Retrying an already accepted task must neither fetch nor replace its review.
    accepted_payload = RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="task-1", employer="Acme", job_id=_JOB_ID,
        sources=(ResearchSourceInput(category="public_web_page", url=_TEAM_URL),),
    )
    accepted_output = activities._run_contact_research(accepted_payload)
    assert accepted_output.candidate_count == 1
    assert research_repo.load(LOCAL_TENANT, "task-1") == previous
    assert limits == [(2_000_000, 20.0)] and opener.requests == [url]
    conn.close()


@pytest.mark.asyncio
async def test_activity_cancellation_propagates_to_active_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    from jobctrl.contact import activities
    from jobctrl.contact.activities import RunContactResearchActivityInput
    from jobctrl.infrastructure.temporal import runtime_guard

    response = _BoundedResponse(_TEAM_URL, b"a" * 100, delay=2)
    opener = _QueueOpener(response)
    monkeypatch.setattr(runtime_guard, "assert_activity_runtime", lambda **_kwargs: None)
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)

    def run(_payload, *, cancel_event):
        fetcher, _session = _bounded_fetcher(opener, timeout=2, limit=200, cancel_event=cancel_event)
        return fetcher.fetch(_TEAM_URL)

    monkeypatch.setattr(activities, "_run_contact_research", run)
    task = asyncio.create_task(activities.run_contact_research_activity(
        RunContactResearchActivityInput(tenant_id=str(LOCAL_TENANT), task_id="synthetic"),
    ))
    assert await asyncio.to_thread(response.started.wait, 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=0.75)
    assert response.closed


def test_cancellation_during_page_parsing_prevents_model_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from concurrent.futures import CancelledError
    from threading import Event

    from jobctrl import config, database
    from jobctrl.contact import activities
    from jobctrl.contact.activities import ResearchSourceInput, RunContactResearchActivityInput
    from jobctrl.infrastructure import contact as contact_infra
    from jobctrl.infrastructure import events as events_infra
    from jobctrl.infrastructure import llm as llm_infra
    from jobctrl.infrastructure.contact import research_fetcher as fetch_module

    conn, repository, _ = _setup(tmp_path)
    previous = _run_use_case(
        repository,
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Second Synthetic Person synthetic")),
        llm=_FakeLlm([{"name": "Synthetic Person"}]),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    cancelled = Event()
    response = _BoundedResponse(_TEAM_URL, b"<p>synthetic team</p>")
    fetcher, _ = _bounded_fetcher(_QueueOpener(response), cancel_event=cancelled)
    llm = _RecordingLlm()

    def cancel_during_parse(_body):
        cancelled.set()
        return "synthetic team"

    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(config, "load_saved_search_settings", lambda: {})
    monkeypatch.setattr(contact_infra, "GatewayContactResearchFetcher", lambda **_kwargs: fetcher)
    monkeypatch.setattr(llm_infra, "LlmAdapter", lambda **_kwargs: llm)
    monkeypatch.setattr(events_infra, "get_default_publisher", lambda: InProcessEventBus())
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)
    monkeypatch.setattr(fetch_module, "_visible_text", cancel_during_parse)

    payload = RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="task-2", employer="Acme", job_id=_JOB_ID,
        sources=(ResearchSourceInput(category="public_web_page", url=_TEAM_URL),),
    )
    with pytest.raises(CancelledError):
        activities._run_contact_research(payload, cancel_event=cancelled)
    assert llm.calls == [] and response.closed
    assert repository.load(LOCAL_TENANT, "task-1") == previous
    saved = repository.load(LOCAL_TENANT, "task-2")
    assert saved is not None and saved.candidates == ()
    conn.close()


def test_cancellation_waiting_for_result_writer_prevents_publication(tmp_path: Path) -> None:
    from concurrent.futures import CancelledError, ThreadPoolExecutor
    from threading import Event

    conn, repository, _ = _setup(tmp_path)
    previous = _run_use_case(
        repository,
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Second Synthetic Person synthetic")),
        llm=_FakeLlm([{"name": "Synthetic Person"}]),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    db_path = tmp_path / "jobctrl.db"
    model_started, release_model, final_ready, allow_final, result_begin, cancelled = (Event() for _ in range(6))
    llm = _FakeLlm([{"name": "Second Synthetic Person"}])

    class BlockingLlm(_FakeLlm):
        def chat_json(self, messages, **kwargs):
            model_started.set()
            assert release_model.wait(3)
            return llm.chat_json(messages, **kwargs)

    def check_cancelled():
        if cancelled.is_set():
            raise CancelledError()

    def run():
        own = sqlite3.connect(db_path, timeout=3)
        own.row_factory = sqlite3.Row
        begins = 0

        def trace(statement):
            nonlocal begins
            if statement.strip().upper() == "BEGIN IMMEDIATE":
                begins += 1
                if begins == 2:
                    result_begin.set()

        own.set_trace_callback(trace)
        try:
            class ObservedRepository(SqliteContactResearchTaskRepository):
                def __init__(self):
                    super().__init__(own, publisher=InProcessEventBus())
                    self.saves = 0

                def save_attempt_if_unproposed(self, *args, **kwargs):
                    self.saves += 1
                    if self.saves == 2:
                        final_ready.set()
                        assert allow_final.wait(3)
                    return super().save_attempt_if_unproposed(*args, **kwargs)

            use_case = RunContactResearchUseCase(
                repository=ObservedRepository(),
                service=ContactResearchService(
                    policy=ContactResearchSourcePolicy(domain_allowlist=(_HOST,)),
                    determination_repository=SqliteDeterminationRepository(own), preflight=lambda: None,
                    provider="synthetic", selected_model="synthetic",
                ),
                fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Second Synthetic Person synthetic")),
                llm=BlockingLlm([]), new_id=lambda: "task-2-candidate", check_cancelled=check_cancelled,
            )
            return use_case.execute(
                LOCAL_TENANT, task_id="task-2", link=ContactLink(employer="Acme", job_id=_JOB_ID),
                sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
            )
        finally:
            own.close()

    writer = sqlite3.connect(db_path, timeout=3)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run)
            assert model_started.wait(2)
            release_model.set()
            assert final_ready.wait(2)
            writer.execute("BEGIN IMMEDIATE")
            allow_final.set()
            assert result_begin.wait(2)
            cancelled.set()
            writer.commit()
            with pytest.raises(CancelledError):
                future.result(timeout=2)
        assert llm.calls == 1
        saved = repository.load(LOCAL_TENANT, "task-2")
        assert saved is not None and saved.candidates == ()
        assert repository.load(LOCAL_TENANT, "task-1") == previous
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactCandidateProposed'"
        ).fetchone()[0] == 1
    finally:
        release_model.set()
        allow_final.set()
        writer.rollback()
        writer.close()
        conn.close()


def test_cancellation_waiting_for_initial_writer_prevents_research(tmp_path: Path) -> None:
    from concurrent.futures import CancelledError, ThreadPoolExecutor
    from threading import Event

    conn, repository, _ = _setup(tmp_path)
    previous = _run_use_case(
        repository,
        fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Second Synthetic Person synthetic")),
        llm=_FakeLlm([{"name": "Synthetic Person"}]),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    db_path = tmp_path / "jobctrl.db"
    cancelled, initial_begin = Event(), Event()
    fetcher = _FakeFetcher(ResearchPageFetch(outcome="allowed", text="Second Synthetic Person synthetic"))
    llm = _FakeLlm([{"name": "Second Synthetic Person"}])

    def check_cancelled():
        if cancelled.is_set():
            raise CancelledError()

    def run():
        own = sqlite3.connect(db_path, timeout=3)
        own.row_factory = sqlite3.Row
        own.set_trace_callback(
            lambda statement: initial_begin.set() if statement.strip().upper() == "BEGIN IMMEDIATE" else None
        )
        try:
            use_case = RunContactResearchUseCase(
                repository=SqliteContactResearchTaskRepository(own, publisher=InProcessEventBus()),
                service=ContactResearchService(
                    policy=ContactResearchSourcePolicy(domain_allowlist=(_HOST,)),
                    determination_repository=SqliteDeterminationRepository(own), preflight=lambda: None,
                    provider="synthetic", selected_model="synthetic",
                ),
                fetcher=fetcher, llm=llm, new_id=lambda: "task-2-candidate", check_cancelled=check_cancelled,
            )
            return use_case.execute(
                LOCAL_TENANT, task_id="task-2", link=ContactLink(employer="Acme", job_id=_JOB_ID),
                sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
            )
        finally:
            own.close()

    writer = sqlite3.connect(db_path, timeout=3)
    try:
        writer.execute("BEGIN IMMEDIATE")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run)
            assert initial_begin.wait(2)
            cancelled.set()
            writer.commit()
            with pytest.raises(CancelledError):
                future.result(timeout=2)
        assert fetcher.calls == [] and llm.calls == 0
        assert repository.load(LOCAL_TENANT, "task-2") is None
        assert repository.load(LOCAL_TENANT, "task-1") == previous
    finally:
        writer.rollback()
        writer.close()
        conn.close()


@pytest.mark.parametrize("slow", [False, True])
def test_tls_socket_wrapping_preserves_valid_reads_and_deadlines(
    tmp_path: Path, monkeypatch, slow: bool,
) -> None:
    """The cancellation handle survives the HTTPS wrapper detaching its raw socket."""
    import datetime
    import http.client
    import socket
    import ssl
    import threading
    import time
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    from jobctrl.infrastructure.contact import research_fetcher as module

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic.example")])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1)).sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "test-cert.pem", tmp_path / "test-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    ))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    client_context.check_hostname = False
    client_context.verify_mode = ssl.CERT_NONE
    client, server = socket.socketpair()
    stopped = threading.Event()

    def send_slow_headers() -> None:
        try:
            with server_context.wrap_socket(server, server_side=True) as peer:
                if not slow:
                    peer.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n<p>Team</p>")
                    return
                peer.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")
                for _ in range(40):
                    time.sleep(0.03)
                    peer.sendall(b"x")
        except OSError:
            stopped.set()

    class SocketOpener:
        def __init__(self, factory):
            self.factory = factory

        def open(self, request, timeout):
            sock = self.factory(socket.AF_INET, socket.SOCK_STREAM, 0)
            sock.settimeout(timeout)
            wrapped = client_context.wrap_socket(sock, server_hostname="synthetic.example")
            response = http.client.HTTPResponse(wrapped)
            try:
                response.begin()
            except BaseException:
                response.close()
                wrapped.close()
                raise
            response.geturl = lambda: request.full_url
            return response

    monkeypatch.setattr(module.socket, "socket", lambda *_args: client)
    monkeypatch.setattr(module, "build_public_http_opener", lambda **kwargs: SocketOpener(kwargs["socket_factory"]))
    sender = threading.Thread(target=send_slow_headers, daemon=True)
    sender.start()
    fetcher, _ = _bounded_fetcher(None, timeout=0.18)
    started_at = time.monotonic()
    result = fetcher.fetch(_TEAM_URL)
    sender.join(0.5)
    if slow:
        assert result.outcome == "acquisition_timeout"
        assert time.monotonic() - started_at < 0.45
        assert stopped.is_set()
    else:
        assert result.outcome == "allowed" and result.text == "Team"
    assert not sender.is_alive()


def test_overlapping_failed_attempt_does_not_replace_newly_published_proposal(tmp_path: Path) -> None:
    conn, research_repo, _ = _setup(tmp_path)
    peer = sqlite3.connect(tmp_path / "jobctrl.db")
    peer.row_factory = sqlite3.Row
    peer_repo = SqliteContactResearchTaskRepository(peer, publisher=InProcessEventBus())
    sources = (ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),)
    accepted = []

    class InterleavedFailure:
        def fetch(self, _url):
            accepted.append(_run_use_case(
                peer_repo, fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="Synthetic Person synthetic")),
                llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=sources,
            ))
            return ResearchPageFetch(outcome="transport_failed")

    try:
        result = _run_use_case(
            research_repo, fetcher=InterleavedFailure(), llm=_FakeLlm([]), sources=sources,
        )
        assert accepted[0].candidates
        assert result.candidates == accepted[0].candidates and result.status == accepted[0].status
        assert [attempt.outcome for attempt in result.source_attempts] == ["allowed", "transport_failed"]
        assert research_repo.load(LOCAL_TENANT, "task-1") == result
    finally:
        peer.close()
        conn.close()


@pytest.mark.parametrize("first", ["success", "failure"])
def test_concurrent_research_attempts_keep_success_regardless_of_completion_order(
    tmp_path: Path, first: str,
) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    conn, repository, contact_repository = _setup(tmp_path)
    db_path = tmp_path / "jobctrl.db"
    sources = (ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),)
    started = {name: Event() for name in ("success", "failure")}
    release = {name: Event() for name in ("success", "failure")}

    class BlockingFetcher:
        def __init__(self, kind: str) -> None:
            self.kind = kind

        def fetch(self, _url):
            started[self.kind].set()
            assert release[self.kind].wait(3)
            if self.kind == "success":
                return ResearchPageFetch(outcome="allowed", text="Synthetic Person synthetic page")
            return ResearchPageFetch(outcome="transport_failed")

    def run(kind: str):
        own = sqlite3.connect(db_path, timeout=2)
        own.row_factory = sqlite3.Row
        peer = SqliteContactResearchTaskRepository(own, publisher=InProcessEventBus())
        try:
            return _run_use_case(
                peer, fetcher=BlockingFetcher(kind),
                llm=_FakeLlm([{"name": "Synthetic Person"}]), sources=sources,
            )
        finally:
            own.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {kind: pool.submit(run, kind) for kind in ("success", "failure")}
            assert started["success"].wait(2) and started["failure"].wait(2)
            # Both reached the fetch while the other waited: no SQLite write
            # lock spans an untrusted network or model operation.
            second = "failure" if first == "success" else "success"
            release[first].set()
            first_result = futures[first].result(timeout=2)
            if first == "success":
                confirmation = ConfirmContactCandidateUseCase(
                    research_repository=repository, contact_repository=contact_repository,
                ).execute(
                    LOCAL_TENANT, task_id="task-1", candidate_id=first_result.candidates[0].candidate_id,
                )
                assert confirmation.task.status is ResearchTaskStatus.COMPLETED
            release[second].set()
            second_result = futures[second].result(timeout=2)
        final = repository.load(LOCAL_TENANT, "task-1")
        assert final is not None and len(final.candidates) == 1
        expected_outcomes = (
            ["allowed", "transport_failed"] if first == "success" else ["transport_failed", "allowed"]
        )
        assert [attempt.outcome for attempt in final.source_attempts] == expected_outcomes
        winner = first_result if first == "success" else second_result
        assert winner.candidates[0].candidate_id == final.candidates[0].candidate_id
        if first == "success":
            assert final.status is ResearchTaskStatus.COMPLETED
            assert final.candidates[0].status is CandidateStatus.CONFIRMED
            assert len(contact_repository.list_for_tenant(LOCAL_TENANT)) == 1
            assert conn.execute(
                "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactResearchSourceAttemptFailed'"
            ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type = 'ContactCandidateProposed'"
        ).fetchone()[0] == 1
    finally:
        for event in release.values():
            event.set()
        conn.close()


def test_successful_empty_result_is_not_replaced_by_a_duplicate_attempt(tmp_path: Path) -> None:
    conn, repository, _ = _setup(tmp_path)
    sources = (ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),)
    first = _run_use_case(
        repository, fetcher=_FakeFetcher(ResearchPageFetch(outcome="allowed", text="a real page")),
        llm=_FakeLlm([]), sources=sources,
    )
    replacement = _FakeFetcher(ResearchPageFetch(outcome="transport_failed"))
    second = _run_use_case(repository, fetcher=replacement, llm=_FakeLlm([]), sources=sources)
    assert first.source_attempts[0].outcome == "no_candidates"
    assert second == first == repository.load(LOCAL_TENANT, "task-1")
    assert replacement.calls == []
    conn.close()


def test_blocked_gateway_metric_and_attempt_save_share_existing_transaction(tmp_path: Path) -> None:
    from dataclasses import replace
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure.network import (
        PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter,
    )
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    conn, repository, _ = _setup(tmp_path)
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    policy = replace(policy, source_policy=replace(policy.source_policy, min_request_interval_seconds=0))
    budget = RunBudgetCounter(1)
    assert budget.try_consume()
    session = PolitenessSession(
        PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=HostRateLimiter()),
        policy=policy.source_policy, budget=budget,
        context=PolitenessSourceContext(stage="contact_research"), recorder_conn=conn,
    )
    fetcher, _ = _bounded_fetcher(_UnexpectedOpener(), session=session)
    task = _run_use_case(
        repository, fetcher=fetcher, llm=_FakeLlm([]),
        sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
    )
    assert task.source_attempts[0].outcome == "budget_exhausted"
    assert repository.load(LOCAL_TENANT, "task-1") == task
    assert not conn.in_transaction
    assert conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0] == 1
    conn.close()


def test_rate_limit_metric_does_not_hold_write_lock_over_next_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import io
    from jobctrl import database
    from jobctrl.contact import activities
    from jobctrl.contact.activities import ResearchSourceInput, RunContactResearchActivityInput
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure import contact as contact_infra, events as events_infra, llm as llm_infra
    from jobctrl.infrastructure import network
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    conn, repository, _ = _setup(tmp_path)
    other_host = "second.example"
    other_url = f"https://{other_host}/team"
    db_path = tmp_path / "jobctrl.db"
    peer_errors: list[str] = []

    class Opener:
        def open(self, request, timeout):
            if request.full_url == _TEAM_URL:
                raise urllib.error.HTTPError(_TEAM_URL, 429, "slow down", Message(), io.BytesIO())
            peer = sqlite3.connect(db_path, timeout=0.1)
            try:
                peer.execute("UPDATE jobs SET title = title WHERE tenant_id = ?", (str(LOCAL_TENANT),))
                peer.commit()
            except sqlite3.OperationalError as exc:
                peer_errors.append(str(exc))
            finally:
                peer.close()
            return _BoundedResponse(other_url, b"<p>Team</p>")

    def write_from_peer() -> None:
        peer = sqlite3.connect(db_path, timeout=0.1)
        try:
            peer.execute("UPDATE jobs SET title = title WHERE tenant_id = ?", (str(LOCAL_TENANT),))
            peer.commit()
        except sqlite3.OperationalError as exc:
            peer_errors.append(str(exc))
        finally:
            peer.close()

    class Model(_FakeLlm):
        def chat_json(self, messages, **kwargs):
            write_from_peer()  # The rate-limit metric must not lock model work either.
            return super().chat_json(messages, **kwargs)

    opener = Opener()
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr(contact_infra, "GatewayContactResearchFetcher", lambda **kwargs: GatewayContactResearchFetcher(
        **kwargs, opener=opener, target_resolver=lambda *_args: ("93.184.216.34",),
    ))
    gateway = network.PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=HostRateLimiter())
    monkeypatch.setattr(network, "PolitenessGateway", lambda: gateway)
    monkeypatch.setattr(llm_infra, "LlmAdapter", lambda **_kwargs: Model([]))
    monkeypatch.setattr(events_infra, "get_default_publisher", lambda: InProcessEventBus())
    monkeypatch.setattr(activities.activity, "heartbeat", lambda *_args: None)
    payload = RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="task-1", employer="Acme", job_id=_JOB_ID,
        sources=(
            ResearchSourceInput(category="public_web_page", url=_TEAM_URL),
            ResearchSourceInput(category="public_web_page", url=other_url),
        ),
    )
    try:
        activities._run_contact_research(payload)
        task = repository.load(LOCAL_TENANT, "task-1")
        assert task is not None
        assert [attempt.outcome for attempt in task.source_attempts] == ["rate_limited", "no_candidates"]
        assert peer_errors == []
        assert conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0] == 1
        assert not conn.in_transaction
    finally:
        conn.close()


def test_contact_activity_does_not_commit_an_existing_caller_transaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import database
    from jobctrl.contact import activities
    from jobctrl.contact.activities import RunContactResearchActivityInput

    conn, _repository, _ = _setup(tmp_path)
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    conn.execute("UPDATE jobs SET title = 'uncommitted synthetic change' WHERE tenant_id = ?", (str(LOCAL_TENANT),))
    payload = RunContactResearchActivityInput(
        tenant_id=str(LOCAL_TENANT), task_id="task-1", employer="Acme", job_id=_JOB_ID,
    )
    try:
        with pytest.raises(RuntimeError, match="activity-owned clean connection"):
            activities._run_contact_research(payload)
        assert conn.in_transaction
        peer = sqlite3.connect(tmp_path / "jobctrl.db")
        try:
            assert peer.execute("SELECT title FROM jobs WHERE tenant_id = ?", (str(LOCAL_TENANT),)).fetchone()[0] == "Test job"
        finally:
            peer.close()
        assert conn.execute("SELECT COUNT(*) FROM contact_research_tasks").fetchone()[0] == 0
    finally:
        conn.rollback()
        conn.close()


def test_deferred_outcomes_never_commit_an_unrelated_transaction(tmp_path: Path) -> None:
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure.network import (
        PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter,
    )
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    conn, _repository, _ = _setup(tmp_path)
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    budget = RunBudgetCounter(1)
    assert budget.try_consume()
    session = PolitenessSession(
        PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=HostRateLimiter()),
        policy=policy.source_policy, budget=budget,
        context=PolitenessSourceContext(stage="contact_research"), recorder_conn=conn,
        defer_recording=True,
    )
    with session.guard(_TEAM_URL) as decision:
        assert not decision.allowed
    assert not conn.in_transaction
    conn.execute("UPDATE jobs SET title = 'uncommitted synthetic change' WHERE tenant_id = ?", (str(LOCAL_TENANT),))
    with pytest.raises(RuntimeError, match="another transaction"):
        session.flush_deferred()
    assert conn.in_transaction
    conn.rollback()
    session.flush_deferred()
    assert conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0] == 1
    assert conn.execute("SELECT title FROM jobs WHERE tenant_id = ?", (str(LOCAL_TENANT),)).fetchone()[0] == "Test job"
    assert not conn.in_transaction
    conn.close()


@pytest.mark.parametrize("succeed", [False, True])
def test_event_publication_failure_releases_write_lock_before_fetch(
    tmp_path: Path, succeed: bool,
) -> None:
    conn, _repository, _ = _setup(tmp_path)
    peer_errors: list[str] = []

    class FailingPublisher:
        def publish(self, _event):
            raise RuntimeError("synthetic publication failure")

    class ProbeFetcher:
        def fetch(self, _url):
            peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=0.1)
            try:
                peer.execute("UPDATE jobs SET title = title WHERE tenant_id = ?", (str(LOCAL_TENANT),))
                peer.commit()
            except sqlite3.OperationalError as exc:
                peer_errors.append(str(exc))
            finally:
                peer.close()
            return ResearchPageFetch(outcome="allowed", text="Synthetic Person synthetic page") if succeed else ResearchPageFetch(outcome="transport_failed")

    try:
        repository = SqliteContactResearchTaskRepository(conn, publisher=FailingPublisher())
        task = _run_use_case(
            repository, fetcher=ProbeFetcher(), llm=_FakeLlm([{"name": "Synthetic Person"}]),
            sources=(ResearchSourceSpec(category="public_web_page", url=_TEAM_URL),),
        )
        assert task.source_attempts[0].outcome == ("allowed" if succeed else "transport_failed")
        assert bool(task.candidates) is succeed
        assert repository.load(LOCAL_TENANT, "task-1") == task
        assert peer_errors == []
        assert not conn.in_transaction
    finally:
        conn.close()


def test_default_rate_limit_recorder_leaves_commit_to_its_caller(tmp_path: Path) -> None:
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure.network import (
        PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter,
    )
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    conn, _repository, _ = _setup(tmp_path)
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    session = PolitenessSession(
        PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=HostRateLimiter()),
        policy=policy.source_policy, budget=RunBudgetCounter(1),
        context=PolitenessSourceContext(stage="company_briefing"), recorder_conn=conn,
    )
    try:
        session.record_server_rate_limit(_TEAM_URL)
        assert conn.in_transaction
        peer = sqlite3.connect(tmp_path / "jobctrl.db")
        try:
            assert peer.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0] == 0
        finally:
            peer.close()
        conn.rollback()
        assert conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0] == 0
    finally:
        conn.close()


@pytest.mark.parametrize("status", [429, 503])
@pytest.mark.parametrize("briefing", [False, True])
def test_retry_after_is_installed_before_a_queued_same_host_request(
    tmp_path: Path, status: int, briefing: bool,
) -> None:
    """The next host request must not enter between a rate response and its cooldown."""
    import io
    import threading
    from concurrent.futures import CancelledError, ThreadPoolExecutor
    from contextlib import contextmanager
    from dataclasses import replace
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure.materials.company_briefing_fetcher import CompanyBriefingFetcher
    from jobctrl.infrastructure.network import (
        PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter,
    )
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    conn, _repository, _ = _setup(tmp_path)
    metrics_conn = sqlite3.connect(tmp_path / "jobctrl.db", timeout=1, check_same_thread=False)
    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    policy = replace(policy, source_policy=replace(policy.source_policy, min_request_interval_seconds=0))
    first_opened, queued, send_response, note_entered, finish_note, second_opened = (
        threading.Event() for _ in range(6)
    )
    second_cancel = threading.Event()

    class TrackingLimiter(HostRateLimiter):
        def __init__(self) -> None:
            super().__init__()
            self.calls = 0
            self.calls_lock = threading.Lock()

        @contextmanager
        def slot(self, host, **kwargs):
            with self.calls_lock:
                self.calls += 1
                if self.calls == 2:
                    queued.set()
            with super().slot(host, **kwargs):
                yield

    class GateSession(PolitenessSession):
        def note_retry_after(self, url, seconds):
            note_entered.set()
            assert finish_note.wait(2)
            return super().note_retry_after(url, seconds)

    class First:
        def __init__(self) -> None:
            self.body = io.BytesIO(b"ignored")

        def open(self, request, timeout):
            first_opened.set()
            assert send_response.wait(2)
            headers = Message()
            headers["Retry-After"] = "60"
            raise urllib.error.HTTPError(request.full_url, status, "rate limited", headers, self.body)

    class Second:
        def open(self, request, timeout):
            second_opened.set()
            return _BoundedResponse(request.full_url, b"<p>Team</p>")

    limiter = TrackingLimiter()
    gateway = PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=limiter)
    first_session = GateSession(
        gateway, policy=policy.source_policy, budget=RunBudgetCounter(4),
        context=PolitenessSourceContext(stage="contact_research"), recorder_conn=metrics_conn,
        defer_recording=not briefing,
    )
    second_session = PolitenessSession(
        gateway, policy=policy.source_policy, budget=RunBudgetCounter(4),
        context=PolitenessSourceContext(stage="contact_research"),
    )
    first_opener = First()

    def fetcher(opener, session, cancel_event=None):
        kwargs = dict(
            policy=policy, session=session, opener=opener, cancel_event=cancel_event,
            target_resolver=lambda *_args: ("93.184.216.34",),
        )
        if briefing:
            return CompanyBriefingFetcher(urls=[_TEAM_URL], **kwargs)
        return GatewayContactResearchFetcher(**kwargs)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(fetcher(first_opener, first_session).fetch, _TEAM_URL)
            assert first_opened.wait(1)
            second = pool.submit(fetcher(Second(), second_session, second_cancel).fetch, _TEAM_URL)
            assert queued.wait(1)
            send_response.set()
            assert note_entered.wait(1)
            slipped_before_note = second_opened.wait(0.15)
            # Metric recording happens after the host slot is released, so
            # neither recorder holds a write lock while installing cooldown.
            peer = sqlite3.connect(tmp_path / "jobctrl.db", timeout=0.2)
            try:
                peer.execute("UPDATE jobs SET title = title WHERE tenant_id = ?", (str(LOCAL_TENANT),))
                peer.commit()
            finally:
                peer.close()
            finish_note.set()
            assert first.result(timeout=1).outcome == "rate_limited"
            slipped_during_cooldown = second_opened.wait(0.15)
            second_cancel.set()
            try:
                second_result = second.result(timeout=1)
            except CancelledError:
                second_result = "cancelled"
            assert not slipped_before_note
            assert not slipped_during_cooldown
            assert second_result == "cancelled"
        assert first_opener.body.closed
        if briefing:
            # Company briefings own this immediate metric transaction and
            # commit it after fetch returns, as in the production caller.
            assert metrics_conn.in_transaction
            metrics_conn.commit()
        else:
            assert not metrics_conn.in_transaction
            first_session.flush_deferred()
        assert conn.execute("SELECT COUNT(*) FROM operational_attempt_metrics").fetchone()[0] == 1
    finally:
        send_response.set()
        finish_note.set()
        second_cancel.set()
        metrics_conn.close()
        conn.close()


@pytest.mark.parametrize("briefing", [False, True])
def test_retry_after_allows_same_host_request_when_cooldown_expires(briefing: bool) -> None:
    """A rate-limit pause is temporary and does not suppress a later valid page."""
    import io
    from dataclasses import replace
    from jobctrl.domain.ports.politeness import default_honest_user_agent
    from jobctrl.infrastructure.materials.company_briefing_fetcher import CompanyBriefingFetcher
    from jobctrl.infrastructure.network import (
        PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter,
    )
    from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter

    clock = {"now": 100.0}
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock["now"] += seconds

    policy = ContactResearchSourcePolicy(domain_allowlist=(_HOST,))
    policy = replace(policy, source_policy=replace(policy.source_policy, min_request_interval_seconds=0))
    limiter = HostRateLimiter(clock=lambda: clock["now"], sleep=sleep)
    gateway = PolitenessGateway(user_agent=default_honest_user_agent(), rate_limiter=limiter)
    session = PolitenessSession(
        gateway, policy=policy.source_policy, budget=RunBudgetCounter(4),
        context=PolitenessSourceContext(stage="contact_research"),
    )
    headers = Message()
    headers["Retry-After"] = "2"
    error_body = io.BytesIO(b"ignored")
    error = urllib.error.HTTPError(_TEAM_URL, 429, "rate limited", headers, error_body)
    page = _BoundedResponse(_TEAM_URL, b"<p>Team</p>")
    opener = _QueueOpener(error, page)
    kwargs = dict(policy=policy, session=session, opener=opener, target_resolver=lambda *_args: ("93.184.216.34",))
    fetcher = CompanyBriefingFetcher(urls=[_TEAM_URL], **kwargs) if briefing else GatewayContactResearchFetcher(**kwargs)

    assert fetcher.fetch(_TEAM_URL).outcome == "rate_limited"
    result = fetcher.fetch(_TEAM_URL)
    assert result.outcome == "allowed" and result.text == "Team"
    assert sleeps == [2.0] and clock["now"] == 102.0
    assert error_body.closed and page.closed and len(opener.requests) == 2
