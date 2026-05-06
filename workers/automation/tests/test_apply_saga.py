"""Phase 8 (S-31): ApplySaga happy-path + compensation branches."""

from pathlib import Path
from typing import Any

import pytest

from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.domain.apply import (
    Applied,
    ApplyPrompt,
    ApplyRun,
    ApplyRunStatus,
    BrowserWorkerConfig,
    Failed,
    new_apply_run_id,
)
from jobhunter.domain.apply.process_manager import ApplySaga
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.apply import AgentResult, BrowserSession
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.apply import SqliteApplyRunRepository


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
        return AgentResult(
            submission_result=Applied(applied_at="t9", verification_confidence=0.9),
            duration_ms=1000,
            events=({"event_type": "AgentDone", "occurred_at": "t8"},),
        )


@pytest.fixture()
def repo(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    init_db(db_path)
    conn = get_connection(db_path)
    yield SqliteApplyRunRepository(conn)
    close_connection(db_path)


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


def test_mark_orphans_as_failed_rescues_starting_runs(repo):
    # Persist an orphaned in-progress aggregate.
    orphan = _starting().transition_to_in_progress()
    repo.save(orphan)
    saga = ApplySaga(
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(),
        repository=repo,
    )
    rescued = saga.mark_orphans_as_failed(tenant_id=LOCAL_TENANT)
    assert len(rescued) == 1
    loaded = repo.load(LOCAL_TENANT, orphan.run_id)
    assert loaded is not None
    assert loaded.status == ApplyRunStatus.FAILED
    assert isinstance(loaded.submission_result, Failed)
    assert "ORPHANED" in loaded.submission_result.error


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
