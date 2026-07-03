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
    Failed,
    new_apply_run_id,
)
from jobhunter.domain.apply.process_manager import ApplySaga
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.apply import AgentResult, BrowserSession
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
    def __init__(self, *, raise_on_launch: bool = False):
        self.launches = 0
        self.cleanups = 0
        self.raise_on_launch = raise_on_launch

    def launch(self, config):
        self.launches += 1
        if self.raise_on_launch:
            raise RuntimeError("chrome failed to start")
        return BrowserSession(config=config, pid=42, worker_dir="/tmp/w")

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
