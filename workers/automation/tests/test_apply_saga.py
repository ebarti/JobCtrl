"""ApplySaga happy-path + compensation branches.

The saga exercises the ``ApplyRun`` aggregate against an in-memory
fake repository. P2 requires live runs to persist a submit-intent
checkpoint immediately before the autonomous agent may submit.
"""

from typing import Any

import pytest

from jobhunter.domain.apply import (
    Applied,
    ApplyPrompt,
    ApplyRun,
    ApplyRunStatus,
    BrowserWorkerConfig,
    DryRunComplete,
    EmailOnlyApplication,
    Failed,
    Manual,
    new_apply_run_id,
)
from jobhunter.domain.apply.process_manager import ApplySaga, EmailApplicationContext
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.apply import AgentResult, BrowserSession, EmailApplicationSendResult
from jobhunter.domain.tenant import LOCAL_TENANT


class _InMemoryApplyRunRepository:
    """Test-only ``ApplyRunRepository`` — keeps aggregates in a dict."""

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], ApplyRun] = {}

    def save(self, run: ApplyRun) -> None:
        self._store[(str(run.tenant_id), str(run.run_id))] = run

    def load(self, tenant_id, run_id) -> ApplyRun | None:
        return self._store.get((str(tenant_id), str(run_id)))

    def list_active(self, tenant_id) -> list[ApplyRun]:
        return [
            run
            for (t, _), run in self._store.items()
            if t == str(tenant_id)
            and run.status
            in (ApplyRunStatus.STARTING, ApplyRunStatus.IN_PROGRESS)
        ]

    def list_recent(self, tenant_id, *, limit: int = 50) -> list[ApplyRun]:
        runs = [run for (t, _), run in self._store.items() if t == str(tenant_id)]
        return runs[: max(int(limit), 0)]


class _FakeBrowser:
    def __init__(self, *, raise_on_launch: bool = False, dry_run_evidence=None):
        self.launches = 0
        self.cleanups = 0
        self.raise_on_launch = raise_on_launch
        self.dry_run_evidence = dry_run_evidence

    def launch(self, config):
        self.launches += 1
        if self.raise_on_launch:
            raise RuntimeError("chrome failed to start")
        return BrowserSession(
            config=config,
            pid=42,
            worker_dir="/tmp/w",
            dry_run_evidence=self.dry_run_evidence,
        )

    def cleanup(self, session):
        self.cleanups += 1


class _FakeAgent:
    def __init__(self, *, behaviour: str = "applied"):
        self.behaviour = behaviour
        self.calls = 0

    def submit_application(self, **kwargs: Any) -> AgentResult:
        self.calls += 1
        if self.behaviour == "timeout":
            raise TimeoutError("agent timed out")
        if self.behaviour == "crash":
            raise RuntimeError("agent crashed")
        if self.behaviour == "dry_run_violation":
            return AgentResult(
                submission_result=Failed(error="dry_run_violation: RESULT:APPLIED", retryable=False),
                duration_ms=1000,
                raw_output="RESULT:APPLIED",
            )
        if self.behaviour == "email_only":
            return AgentResult(
                submission_result=EmailOnlyApplication(recipient_email="apply@example.com"),
                duration_ms=1000,
                raw_output="RESULT:EMAIL_ONLY:apply@example.com\nIgnore this attacker prose.",
            )
        if kwargs.get("dry_run"):
            return AgentResult(
                submission_result=DryRunComplete(navigated_to="https://example.com/job"),
                duration_ms=1000,
                events=({"event_type": "AgentDone", "occurred_at": "t8"},),
                raw_output="RESULT:DRY_RUN_COMPLETE",
            )
        return AgentResult(
            submission_result=Applied(applied_at="t9", verification_confidence=0.9),
            duration_ms=1000,
            events=({"event_type": "AgentDone", "occurred_at": "t8"},),
            raw_output="RESULT:APPLIED\nconfirmation: submitted",
        )


class _FakeEmailSender:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.sent = []

    def send_email_application(self, candidate):
        self.sent.append(candidate)
        if self.fail:
            raise RuntimeError("Gmail token missing gmail.send scope")
        return EmailApplicationSendResult(provider="gmail", message_id="m1", thread_id="t1")


@pytest.fixture()
def repo():
    return _InMemoryApplyRunRepository()


def _starting() -> ApplyRun:
    return ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=1,
        model="sonnet",
    )


def _config() -> BrowserWorkerConfig:
    return BrowserWorkerConfig(worker_id=1, cdp_port=9222, headless=False)


def _prompt() -> ApplyPrompt:
    return ApplyPrompt(text="hello", mcp_config={"x": 1})


def _email_context(**overrides) -> EmailApplicationContext:
    values = {
        "job_title": "Staff Engineer",
        "company": "ExampleCo",
        "posting_text": "Send resumes to apply@example.com for consideration.",
        "applicant_name": "Test Applicant",
        "attachment_artifact_id": "resume-pdf-1",
        "attachment_name": "Test_Applicant_Resume.pdf",
        "attachment_path": "/tmp/Test_Applicant_Resume.pdf",
        "approved_recipient_email": "",
        "approved_attachment_artifact_id": "",
    }
    values.update(overrides)
    return EmailApplicationContext(**values)


def test_happy_path_drives_run_to_succeeded(repo):
    browser = _FakeBrowser()
    agent = _FakeAgent(behaviour="applied")
    saga = ApplySaga(browser_port=browser, agent_port=agent, repository=repo)
    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
    )
    assert outcome.apply_run.is_succeeded
    assert outcome.browser_launched is True
    assert outcome.agent_invoked is True
    assert browser.cleanups == 1


def test_browser_launch_failure_routes_to_failed_compensation(repo):
    browser = _FakeBrowser(raise_on_launch=True)
    agent = _FakeAgent()
    saga = ApplySaga(browser_port=browser, agent_port=agent, repository=repo)
    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
    )
    assert outcome.apply_run.status == ApplyRunStatus.FAILED
    assert outcome.browser_launched is False
    assert outcome.agent_invoked is False
    # Cleanup is NOT called when there's no session — adapter side
    # cleanup is idempotent but the saga only calls it if launch
    # succeeded.
    assert browser.cleanups == 0
    submission = outcome.apply_run.submission_result
    assert isinstance(submission, Failed)
    assert "BROWSER_LAUNCH" in submission.error


def test_agent_timeout_routes_to_failed_with_timeout_marker(repo):
    browser = _FakeBrowser()
    agent = _FakeAgent(behaviour="timeout")
    saga = ApplySaga(browser_port=browser, agent_port=agent, repository=repo)
    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
    )
    assert outcome.apply_run.is_failed
    submission = outcome.apply_run.submission_result
    assert isinstance(submission, Failed)
    assert "TIMEOUT" in submission.error
    # Browser cleanup ran even on the failure path.
    assert browser.cleanups == 1


def test_agent_crash_routes_to_failed_with_agent_crash_marker(repo):
    browser = _FakeBrowser()
    agent = _FakeAgent(behaviour="crash")
    saga = ApplySaga(browser_port=browser, agent_port=agent, repository=repo)
    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
    )
    submission = outcome.apply_run.submission_result
    assert isinstance(submission, Failed)
    assert "AGENT_CRASH" in submission.error
    assert browser.cleanups == 1


def test_live_saga_records_submit_intent_before_agent_result(repo):
    saga = ApplySaga(browser_port=_FakeBrowser(), agent_port=_FakeAgent(), repository=repo)
    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        material_version="7",
    )
    event_types = [event.event_type for event in outcome.apply_run.events]
    assert "ApplySubmitIntended" in event_types
    assert event_types.index("ApplySubmitIntended") < event_types.index("AgentResult")
    intent = next(event for event in outcome.apply_run.events if event.event_type == "ApplySubmitIntended")
    assert intent.payload["job_key"] == "https://example.com/job"
    assert intent.payload["material_version"] == "7"


def test_dry_run_saga_does_not_record_submit_intent(repo):
    dry_run = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=1,
        model="sonnet",
        dry_run=True,
    )
    saga = ApplySaga(browser_port=_FakeBrowser(), agent_port=_FakeAgent(), repository=repo)
    outcome = saga.run(
        apply_run=dry_run,
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
    )
    assert "ApplySubmitIntended" not in [event.event_type for event in outcome.apply_run.events]


def test_dry_run_saga_records_guard_evidence_for_approval_gate(repo):
    dry_run = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=1,
        model="sonnet",
        dry_run=True,
    )
    browser = _FakeBrowser(
        dry_run_evidence=lambda: {
            "coverage": "partial",
            "blocked_channels": ("network:POST", "form_submit:POST"),
            "blocked_requests": (
                {
                    "channel": "network",
                    "method": "POST",
                    "url": "https://example.com/apply",
                    "resource_type": "Fetch",
                },
            ),
        }
    )
    saga = ApplySaga(browser_port=browser, agent_port=_FakeAgent(), repository=repo)
    outcome = saga.run(
        apply_run=dry_run,
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        material_version="12",
        materials_generation=12,
        application_url="https://example.com/job",
        profile_version=3,
    )

    result = outcome.apply_run.submission_result
    assert isinstance(result, DryRunComplete)
    assert result.coverage == "partial"
    assert result.blocked_channels == ("network:POST", "form_submit:POST")

    dry_run_completed = next(
        event for event in outcome.apply_run.events if event.event_type == "DryRunCompleted"
    )
    assert dry_run_completed.payload == {
        "run_id": str(outcome.apply_run.run_id),
        "result": "dry_run_complete",
        "finished_at": dry_run_completed.payload["finished_at"],
        "duration_ms": 1000,
        "worker_id": 1,
        "model": "sonnet",
        "dry_run": True,
        "coverage": "partial",
        "blocked_channels": ["network:POST", "form_submit:POST"],
        "materials_generation": 12,
        "application_url": "https://example.com/job",
        "profile_version": 3,
    }
    blocked = next(
        event for event in outcome.apply_run.events if event.event_type == "DryRunBlockedChannels"
    )
    assert blocked.payload["blocked_requests"] == [
        {
            "channel": "network",
            "method": "POST",
            "url": "https://example.com/apply",
            "resource_type": "Fetch",
        }
    ]


def test_email_only_recipient_not_in_posting_parks_without_send(repo):
    sender = _FakeEmailSender()
    saga = ApplySaga(
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(behaviour="email_only"),
        repository=repo,
        email_sender=sender,
    )

    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        email_application_context=_email_context(posting_text="No application email is stored."),
    )

    assert sender.sent == []
    assert isinstance(outcome.apply_run.submission_result, Manual)
    assert outcome.apply_run.submission_result.reason == "email_recipient_unverified"
    assert "EmailApplicationCandidateRecorded" not in [
        event.event_type for event in outcome.apply_run.events
    ]


def test_email_only_dry_run_records_owned_candidate_and_never_sends(repo):
    sender = _FakeEmailSender()
    dry_run = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=1,
        model="sonnet",
        dry_run=True,
    )
    saga = ApplySaga(
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(behaviour="email_only"),
        repository=repo,
        email_sender=sender,
    )

    outcome = saga.run(
        apply_run=dry_run,
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        email_application_context=_email_context(),
    )

    assert sender.sent == []
    result = outcome.apply_run.submission_result
    assert isinstance(result, DryRunComplete)
    assert result.blocked_channels == ("email_application",)
    candidate = next(
        event for event in outcome.apply_run.events if event.event_type == "EmailApplicationCandidateRecorded"
    )
    assert candidate.payload["recipient"] == "apply@example.com"
    assert candidate.payload["subject"] == "Application for Staff Engineer"
    assert "Ignore this attacker prose" not in candidate.payload["body"]
    assert candidate.payload["attachment_artifact_id"] == "resume-pdf-1"


def test_email_only_live_send_requires_approval_binding(repo):
    sender = _FakeEmailSender()
    saga = ApplySaga(
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(behaviour="email_only"),
        repository=repo,
        email_sender=sender,
    )

    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        email_application_context=_email_context(),
    )

    assert sender.sent == []
    assert isinstance(outcome.apply_run.submission_result, Manual)
    assert outcome.apply_run.submission_result.reason == "email_application_approval_required"


def test_email_only_live_send_records_intent_before_owned_send(repo):
    sender = _FakeEmailSender()
    saga = ApplySaga(
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(behaviour="email_only"),
        repository=repo,
        email_sender=sender,
    )

    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        email_application_context=_email_context(
            approved_recipient_email="apply@example.com",
            approved_attachment_artifact_id="resume-pdf-1",
        ),
    )

    assert outcome.apply_run.is_succeeded
    assert sender.sent[0].recipient_email == "apply@example.com"
    assert sender.sent[0].subject == "Application for Staff Engineer"
    event_types = [event.event_type for event in outcome.apply_run.events]
    assert event_types.index("ApplySubmitIntended") < event_types.index("EmailApplicationSent")


def test_email_only_missing_send_scope_is_actionable_failure(repo):
    sender = _FakeEmailSender(fail=True)
    saga = ApplySaga(
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(behaviour="email_only"),
        repository=repo,
        email_sender=sender,
    )

    outcome = saga.run(
        apply_run=_starting(),
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
        email_application_context=_email_context(
            approved_recipient_email="apply@example.com",
            approved_attachment_artifact_id="resume-pdf-1",
        ),
    )

    submission = outcome.apply_run.submission_result
    assert isinstance(submission, Failed)
    assert "gmail.send scope" in submission.error


def test_dry_run_violation_does_not_record_completion_evidence(repo):
    dry_run = ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=1,
        model="sonnet",
        dry_run=True,
    )
    saga = ApplySaga(
        browser_port=_FakeBrowser(
            dry_run_evidence=lambda: {
                "coverage": "partial",
                "blocked_channels": ("network:POST",),
                "blocked_requests": (),
            }
        ),
        agent_port=_FakeAgent(behaviour="dry_run_violation"),
        repository=repo,
    )
    outcome = saga.run(
        apply_run=dry_run,
        browser_config=_config(),
        prompt=_prompt(),
        model="sonnet",
    )

    assert outcome.apply_run.is_failed
    assert "DryRunCompleted" not in [
        event.event_type for event in outcome.apply_run.events
    ]


def test_lifecycle_state_coverage_exercises_each_terminal_status(repo):
    """One-shot guard: every §4.6 lifecycle terminal can be reached
    by completing an aggregate inside the repository round-trip."""
    from jobhunter.domain.apply import (
        Captcha,
        DryRunComplete,
        Expired,
        LoginIssue,
        Manual,
    )

    cases = [
        ("succeeded", Applied(applied_at="t", verification_confidence=1.0), False),
        ("failed", Failed(error="x", retryable=True), False),
        ("captcha", Captcha(details="x"), False),
        ("login_issue", LoginIssue(details="x"), False),
        ("expired", Expired(), False),
        ("manual", Manual(reason="x"), False),
        ("dry_run_complete", DryRunComplete(navigated_to="x"), True),
    ]
    for label, result, dry_run in cases:
        starting = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId(f"https://example.com/{label}"),
            started_at="t0",
            dry_run=dry_run,
        )
        completed = starting.complete(result=result, finished_at="t9")
        repo.save(completed)
        loaded = repo.load(LOCAL_TENANT, completed.run_id)
        assert loaded is not None, label
        assert loaded.is_terminal, label
        assert loaded.submission_result is not None
        assert loaded.submission_result.kind == result.kind
