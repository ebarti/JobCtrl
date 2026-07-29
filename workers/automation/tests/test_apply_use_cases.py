"""SubmitApplicationUseCase + SubmitBatchUseCase happy paths, failure
variants, dry-run semantics, and event publishing.

PR 4 of the Temporal stack removed ``SqliteApplyRunRepository``; the
use case now exercises the ``ApplyRun`` aggregate against an in-memory
fake repository (the launcher persists lifecycle state via
``record_job_event`` per ``test_apply_regressions``).
"""

import pytest
from pathlib import Path

from jobctrl.apply import chrome as chrome_mod
from jobctrl.domain.apply import ApplyRun, ApplyRunStatus
from jobctrl.domain.apply.process_manager import ApplySaga
from jobctrl.domain.apply.services import (
    ApplyEligibilityChecker,
    ApplyPromptBuilder,
)
from jobctrl.domain.apply.use_cases import (
    SubmitApplicationUseCase,
    SubmitBatchUseCase,
)
from jobctrl.domain.apply.value_objects import (
    Applied,
    Captcha,
    DryRunComplete,
    EmailOnlyApplication,
    Failed,
    Manual,
    TokenUsage,
)
from jobctrl.domain.ports.apply import (
    AgentResult,
    BrowserSession,
    EmailApplicationSendResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.apply.local_chrome import LocalChromeAdapter


@pytest.fixture(autouse=True)
def permit_browser_for_existing_apply_use_case_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use-case tests exercise domain outcomes after capability enforcement."""

    monkeypatch.setattr(
        "jobctrl.infrastructure.apply.local_chrome.require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


class _InMemoryApplyRunRepository:
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
    def __init__(self):
        self.configs = []

    def launch(self, config):
        self.configs.append(config)
        return BrowserSession(config=config, pid=1, worker_dir="/tmp/w")

    def cleanup(self, session):
        pass


class _ExplodingBrowser:
    def launch(self, _config):
        raise AssertionError("unsafe URL must be blocked before browser launch")

    def cleanup(self, _session):
        raise AssertionError("cleanup should not run when launch is blocked")


class _FakeAgent:
    def __init__(self, *, result):
        self.result = result
        self.calls = 0
        self.last_kwargs = {}

    def submit_application(self, **kwargs):
        self.calls += 1
        self.last_kwargs = dict(kwargs)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _FakeEmailSender:
    def __init__(self):
        self.sent = []

    def send_email_application(self, candidate):
        self.sent.append(candidate)
        return EmailApplicationSendResult(
            provider="gmail",
            message_id="message-1",
            thread_id="thread-1",
        )


class _CapturingPublisher:
    def __init__(self):
        self.events: list = []

    def publish(self, event):
        self.events.append(event)

    def subscribe(self, _event_type, _handler):
        raise NotImplementedError


class _FakeSnapshot:
    def as_dict(self):
        return {
            "personal": {
                "full_name": "Test Applicant",
                "email": "test@example.com",
                "phone": "+1 555 0100",
                "address": "",
                "city": "Barcelona",
                "province_state": "",
                "country": "Spain",
                "postal_code": "",
            },
            "work_authorization": {
                "legally_authorized_to_work": "Yes",
                "require_sponsorship": "No",
            },
            "compensation": {
                "salary_expectation": "100000",
                "salary_currency": "EUR",
            },
            "experience": {
                "years_of_experience_total": "10",
                "target_role": "Engineering leader",
            },
            "availability": {"earliest_start_date": "Immediately"},
            "eeo_voluntary": {},
        }


@pytest.fixture()
def repo():
    return _InMemoryApplyRunRepository()


def _allow_apply_target(_url: str) -> bool:
    return True


def _build_use_case(repo, *, agent_result=None, publisher=None) -> SubmitApplicationUseCase:
    return SubmitApplicationUseCase(
        repository=repo,
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(
            result=agent_result
            or AgentResult(
                submission_result=DryRunComplete(
                    navigated_to="https://example.com/apply"
                ),
                duration_ms=100,
            )
        ),
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=ApplyPromptBuilder(
            mcp_config_factory=lambda port: {"port": port}
        ),
        publisher=publisher,
        url_safety_checker=_allow_apply_target,
    )


def _ready_job():
    return {
        "url": "https://example.com/job",
        "application_url": "https://example.com/apply",
        "tailored_resume_path": "/tmp/resume.txt",
        "title": "Eng",
        "site": "ExampleCo",
        "fit_score": 9,
    }


class _ExplodingPromptBuilder:
    def build(self, **_kwargs):
        raise AssertionError("unsafe URL must be blocked before prompt build")


def test_live_browser_apply_requires_trusted_final_submit_before_prompt_or_browser(repo):
    agent = _FakeAgent(
        result=AgentResult(
            submission_result=Applied(
                applied_at="t9",
                verification_confidence=1.0,
            ),
            duration_ms=100,
        )
    )
    use_case = SubmitApplicationUseCase(
        repository=repo,
        browser_port=_ExplodingBrowser(),
        agent_port=agent,
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=_ExplodingPromptBuilder(),
        url_safety_checker=_allow_apply_target,
    )

    outcome = use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
    )

    assert isinstance(outcome.submission_result, Manual)
    assert outcome.submission_result.reason == "trusted_final_submit_required"
    assert agent.calls == 0
    assert "ApplySubmissionBlocked" in {
        event.event_type for event in outcome.apply_run.events
    }


def test_approved_email_uses_transport_locked_agent_and_owned_sender(
    monkeypatch,
    repo,
):
    _stub_legacy_prompt(monkeypatch)
    browser = _FakeBrowser()
    agent = _FakeAgent(
        result=AgentResult(
            submission_result=EmailOnlyApplication(
                recipient_email="apply@example.com"
            ),
            duration_ms=100,
        )
    )
    sender = _FakeEmailSender()
    saga = ApplySaga(
        browser_port=browser,
        agent_port=agent,
        repository=repo,
        email_sender=sender,
    )
    use_case = SubmitApplicationUseCase(
        repository=repo,
        browser_port=browser,
        agent_port=agent,
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=ApplyPromptBuilder(
            mcp_config_factory=lambda port: {"port": port}
        ),
        saga=saga,
        url_safety_checker=_allow_apply_target,
    )
    job = {
        **_ready_job(),
        "full_description": "Email applications to apply@example.com.",
        "resume_pdf_path": "/tmp/resume.pdf",
        "resume_pdf_artifact_id": "resume-pdf-1",
        "approved_email_recipient": "apply@example.com",
        "approved_email_attachment_artifact_id": "resume-pdf-1",
    }

    outcome = use_case.execute(
        job=job,
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
    )

    assert outcome.apply_run.is_succeeded
    assert browser.configs[0].dry_run is True
    assert agent.last_kwargs["dry_run"] is True
    assert sender.sent[0].recipient_email == "apply@example.com"
    event_types = [event.event_type for event in outcome.apply_run.events]
    assert event_types.index("ApplySubmitIntended") < event_types.index(
        "EmailApplicationSent"
    )


def _stub_legacy_prompt(monkeypatch):
    monkeypatch.setattr(
        "jobctrl.apply.prompt.build_prompt",
        lambda **_kwargs: "rendered prompt",
    )


def test_live_browser_path_stops_at_manual_boundary(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    use_case = _build_use_case(
        repo,
        agent_result=AgentResult(
            submission_result=Applied(applied_at="t9", verification_confidence=1.0),
            token_usage=TokenUsage(input=1, output=2, cost_usd=0.01),
            duration_ms=500,
            events=(
                {"event_type": "Tool", "occurred_at": "t5", "payload": {"k": 1}},
            ),
        ),
    )
    outcome = use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
    )
    assert outcome.ok is True
    assert not outcome.skipped
    assert isinstance(outcome.submission_result, Manual)
    assert outcome.submission_result.reason == "trusted_final_submit_required"
    loaded = repo.load(LOCAL_TENANT, outcome.apply_run.run_id)
    assert loaded is not None
    event_types = [e.event_type for e in loaded.events]
    assert event_types == ["ApplySubmissionBlocked"]


def test_dry_run_accepts_public_ip_application_url_and_reaches_agent(
    monkeypatch,
    repo,
):
    _stub_legacy_prompt(monkeypatch)
    agent = _FakeAgent(
        result=AgentResult(
            submission_result=DryRunComplete(
                navigated_to="https://93.184.216.34/apply",
            ),
            duration_ms=100,
        )
    )
    use_case = SubmitApplicationUseCase(
        repository=repo,
        browser_port=_FakeBrowser(),
        agent_port=agent,
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=ApplyPromptBuilder(
            mcp_config_factory=lambda port: {"port": port}
        ),
    )

    outcome = use_case.execute(
        job={**_ready_job(), "application_url": "https://93.184.216.34/apply"},
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        dry_run=True,
    )

    assert isinstance(outcome.submission_result, DryRunComplete)
    assert agent.calls == 1


def test_dry_run_returns_dry_run_complete_variant(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    use_case = _build_use_case(
        repo,
        agent_result=AgentResult(
            submission_result=DryRunComplete(navigated_to="https://x"),
            duration_ms=100,
        ),
    )
    outcome = use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        dry_run=True,
    )
    assert outcome.apply_run.dry_run is True
    assert outcome.apply_run.status == "dry_run_complete"


def test_execute_passes_worker_dir_to_prompt_builder(monkeypatch, repo):
    seen = {}

    def fake_build(**kwargs):
        seen.update(kwargs)
        return "rendered prompt"

    monkeypatch.setattr("jobctrl.apply.prompt.build_prompt", fake_build)
    use_case = _build_use_case(repo)

    use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        worker_dir="/tmp/apply-worker-1",
        dry_run=True,
    )

    assert seen["upload_dir"] == "/tmp/apply-worker-1"
    assert "tailored_resume" not in seen
    assert "cover_letter" not in seen
    assert "search_config" not in seen


def test_execute_keeps_reviewed_materials_outside_agent_worker(
    monkeypatch, tmp_path, repo
):
    worker_id = 4
    materials_dir = tmp_path / "materials"
    materials_dir.mkdir()
    resume_txt = materials_dir / "resume.txt"
    resume_txt.write_text("Tailored resume", encoding="utf-8")
    resume_pdf = materials_dir / "resume.pdf"
    resume_pdf.write_bytes(b"%PDF-1.4\n")
    apply_workers = tmp_path / "apply-workers"

    monkeypatch.setattr(chrome_mod.config, "APPLY_WORKER_DIR", apply_workers)
    monkeypatch.setattr("jobctrl.apply.prompt.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobctrl.apply.prompt.config.gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client at /tmp/.jobctrl/gmail/oauth-client.json"),
    )

    class FakeChromeProc:
        pid = 4242

        def poll(self):
            return 0

    monkeypatch.setattr(
        chrome_mod,
        "launch_chrome",
        lambda *,
        worker_id,
        port,
        headless,
        dry_run=False,
        approved_application_url="": FakeChromeProc(),
    )

    class PathCheckingAgent:
        def submit_application(self, *, prompt, **_kwargs):
            upload_path = Path(worker_dir) / "Test_Applicant_Resume.pdf"
            assert not upload_path.exists()
            assert str(upload_path) not in prompt.text
            assert "upload_artifact" not in prompt.text
            return AgentResult(
                submission_result=DryRunComplete(
                    navigated_to="https://example.com/apply",
                ),
                duration_ms=100,
            )

    worker_dir = str(chrome_mod.reset_worker_dir(worker_id))
    use_case = SubmitApplicationUseCase(
        repository=repo,
        browser_port=LocalChromeAdapter(),
        agent_port=PathCheckingAgent(),
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=ApplyPromptBuilder(
            mcp_config_factory=lambda port: {"port": port}
        ),
        url_safety_checker=_allow_apply_target,
    )

    outcome = use_case.execute(
        job={
            **_ready_job(),
            "tailored_resume_path": str(resume_txt),
        },
        snapshot=_FakeSnapshot(),
        worker_id=worker_id,
        cdp_port=9222 + worker_id,
        worker_dir=worker_dir,
        search_config={"location": {"accept_patterns": ["Barcelona"]}},
        dry_run=True,
    )

    assert outcome.apply_run.status == "dry_run_complete"


def test_eligibility_accepts_posting_url_without_direct_application_url(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    use_case = _build_use_case(
        repo,
        agent_result=AgentResult(
            submission_result=DryRunComplete(navigated_to="https://example.com/job"),
            duration_ms=100,
        ),
    )
    job = _ready_job()
    job["application_url"] = ""

    outcome = use_case.execute(
        job=job,
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        dry_run=True,
    )

    assert outcome.skipped is False
    assert outcome.apply_run.status == "dry_run_complete"


def test_execute_blocks_private_network_application_url_before_agent(repo):
    agent = _FakeAgent(
        result=AgentResult(
            submission_result=Applied(applied_at="t9", verification_confidence=1.0),
            duration_ms=100,
        )
    )
    use_case = SubmitApplicationUseCase(
        repository=repo,
        browser_port=_ExplodingBrowser(),
        agent_port=agent,
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=_ExplodingPromptBuilder(),
    )
    job = {
        **_ready_job(),
        "application_url": "http://127.0.0.1:8080/internal-ats",
    }

    outcome = use_case.execute(
        job=job,
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        dry_run=True,
    )

    assert outcome.skipped is False
    assert outcome.submission_result is not None
    assert isinstance(outcome.submission_result, Failed)
    assert outcome.submission_result.retryable is False
    assert outcome.submission_result.error.startswith("unsafe_url:")
    assert agent.calls == 0


def test_eligibility_requires_some_apply_target_url():
    checker = ApplyEligibilityChecker(max_attempts=3)
    job = _ready_job()
    job["application_url"] = ""
    job["url"] = ""

    outcome = checker.check(job=job)

    assert outcome.ok is False
    assert outcome.reason == "missing_apply_target_url"


def test_agent_failure_variant_routes_to_failed(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    use_case = _build_use_case(
        repo,
        agent_result=AgentResult(
            submission_result=Captcha(details="hcaptcha unsolved"),
            duration_ms=400,
        ),
    )
    outcome = use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        dry_run=True,
    )
    assert outcome.apply_run.status == "captcha"


def test_agent_timeout_routes_through_saga_compensation(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    use_case = _build_use_case(repo, agent_result=TimeoutError("timed out"))
    outcome = use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        dry_run=True,
    )
    assert outcome.apply_run.is_failed
    submission = outcome.apply_run.submission_result
    assert isinstance(submission, Failed)
    assert "TIMEOUT" in submission.error


def test_publisher_receives_started_then_terminal_events(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    publisher = _CapturingPublisher()
    use_case = _build_use_case(repo, publisher=publisher)
    use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
    )
    types = [e.event_type for e in publisher.events]
    assert "ApplyRunStarted" in types
    assert "ApplicationFailed" in types
    assert "ApplyRunEventRecorded" in types


def test_submit_batch_iterates_acquirer(monkeypatch, repo):
    _stub_legacy_prompt(monkeypatch)
    queue = [
        _ready_job(),
        {**_ready_job(), "url": "https://example.com/job-2"},
    ]

    def acquirer(_worker_id):
        return queue.pop(0) if queue else None

    single = _build_use_case(repo)
    batch = SubmitBatchUseCase(
        single_job_use_case=single,
        acquirer=acquirer,
        snapshot_provider=_FakeSnapshot,
    )
    summary = batch.execute(worker_id=0, cdp_port=9222, limit=0)
    assert summary.processed == 2
    assert summary.applied == 0
    assert summary.failed == 2
