"""SubmitApplicationUseCase + SubmitBatchUseCase happy paths, failure
variants, dry-run semantics, and event publishing.

PR 4 of the Temporal stack removed ``SqliteApplyRunRepository``; the
use case now exercises the ``ApplyRun`` aggregate against an in-memory
fake repository (the launcher persists lifecycle state via
``record_job_event`` per ``test_apply_regressions``).
"""

import pytest
from pathlib import Path

from jobhunter.apply import chrome as chrome_mod
from jobhunter.domain.apply import ApplyRun, ApplyRunStatus
from jobhunter.domain.apply.services import (
    ApplyEligibilityChecker,
    ApplyPromptBuilder,
)
from jobhunter.domain.apply.use_cases import (
    SubmitApplicationUseCase,
    SubmitBatchUseCase,
)
from jobhunter.domain.apply.value_objects import (
    Applied,
    Captcha,
    DryRunComplete,
    Failed,
    TokenUsage,
)
from jobhunter.domain.ports.apply import (
    AgentResult,
    BrowserSession,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.apply.local_chrome import LocalChromeAdapter


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
    def launch(self, config):
        return BrowserSession(config=config, pid=1, worker_dir="/tmp/w")

    def cleanup(self, session):
        pass


class _FakeAgent:
    def __init__(self, *, result):
        self.result = result
        self.calls = 0

    def submit_application(self, **_kwargs):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


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


def _build_use_case(repo, *, agent_result=None, publisher=None) -> SubmitApplicationUseCase:
    return SubmitApplicationUseCase(
        repository=repo,
        browser_port=_FakeBrowser(),
        agent_port=_FakeAgent(
            result=agent_result
            or AgentResult(
                submission_result=Applied(applied_at="t9", verification_confidence=1.0),
                duration_ms=100,
            )
        ),
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        prompt_builder=ApplyPromptBuilder(
            mcp_config_factory=lambda port: {"port": port}
        ),
        publisher=publisher,
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


def _stub_legacy_prompt(monkeypatch):
    monkeypatch.setattr(
        "jobhunter.apply.prompt.build_prompt",
        lambda **_kwargs: "rendered prompt",
    )


def test_happy_path_marks_run_succeeded(monkeypatch, repo):
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
    assert outcome.apply_run.is_succeeded
    # The aggregate is persisted with the agent's events folded in.
    loaded = repo.load(LOCAL_TENANT, outcome.apply_run.run_id)
    assert loaded is not None
    event_types = [e.event_type for e in loaded.events]
    assert "Tool" in event_types
    assert "AgentResult" in event_types


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

    monkeypatch.setattr("jobhunter.apply.prompt.build_prompt", fake_build)
    use_case = _build_use_case(repo)

    use_case.execute(
        job=_ready_job(),
        snapshot=_FakeSnapshot(),
        worker_id=1,
        cdp_port=9222,
        worker_dir="/tmp/apply-worker-1",
    )

    assert seen["upload_dir"] == "/tmp/apply-worker-1"


def test_execute_keeps_upload_files_after_local_chrome_launch(
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
    monkeypatch.setattr("jobhunter.apply.prompt.config.load_env", lambda: None)
    monkeypatch.setattr(
        "jobhunter.apply.prompt.config.gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client at /tmp/.jobhunter/gmail/oauth-client.json"),
    )

    class FakeChromeProc:
        pid = 4242

        def poll(self):
            return 0

    monkeypatch.setattr(
        chrome_mod,
        "launch_chrome",
        lambda *, worker_id, port, headless, dry_run=False: FakeChromeProc(),
    )

    class PathCheckingAgent:
        def submit_application(self, *, prompt, **_kwargs):
            upload_path = Path(worker_dir) / "Test_Applicant_Resume.pdf"
            assert upload_path.exists()
            assert str(upload_path) not in prompt.text
            assert 'upload_artifact(kind="resume")' in prompt.text
            return AgentResult(
                submission_result=Applied(
                    applied_at="t9",
                    verification_confidence=1.0,
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
    )

    assert outcome.apply_run.is_succeeded


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
    assert "ApplicationSubmitted" in types
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
    assert summary.applied == 2
