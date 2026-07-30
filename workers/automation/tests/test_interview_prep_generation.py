"""Interview prep generation stays grounded in existing materials gates."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.events import (
    InterviewPrepGeneratedPayload,
    create_interview_prep_generated,
)
from jobctrl.domain.interview import GenerateInterviewPrepUseCase
from jobctrl.domain.interview.use_cases import INTERVIEW_PREP_RESPONSE_SCHEMA
from jobctrl.domain.materials.adversarial import ADVERSARIAL_REVIEW_RESPONSE_SCHEMA
from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.interview import activities as interview_activities
from jobctrl.interview.activities import (
    GenerateInterviewPrepActivityInput,
    GenerateInterviewPrepActivityOutput,
    InterviewPrepEventRecorder,
    generate_interview_prep_activity,
)

TEST_JOB_URL = "https://example.test/job/1"
TEST_JOB_ID = "11111111-1111-4111-8111-111111111111"


class _FakeLlm:
    model = "fake-interview-prep-model"

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def chat_json(
        self,
        messages: list[LlmMessage],
        *,
        response_schema: dict,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        thinking_budget: int | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "messages": messages,
                "response_schema": response_schema,
                "model": model,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "thinking_budget": thinking_budget,
            }
        )
        return self._responses.pop(0)

    def chat(self, *_args: object, **_kwargs: object) -> str:
        raise AssertionError("interview prep use case should call chat_json")

    def ask(self, *_args: object, **_kwargs: object) -> str:
        raise AssertionError("interview prep use case should call chat_json")


class _RecordingPublisher:
    def __init__(self) -> None:
        self.events: list[Any] = []

    def publish(self, event: Any) -> None:
        self.events.append(event)

    def subscribe(self, _event_type: str, _handler: object) -> None:
        raise AssertionError("tests only publish interview prep events")


def test_generates_accepted_prep_through_existing_truthfulness_gates(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        publisher = _RecordingPublisher()
        llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Latency story",
                    "Reduced API latency by 30% using Python.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                ),
                _judge_pass(),
            ]
        )

        outcome = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=llm,
            publisher=publisher,
        ).execute(
            tenant_id=LOCAL_TENANT,
            job=_job(),
            profile_snapshot=_profile_snapshot(),
            evidence_entries=_evidence_entries(),
            evidence_gaps=(),
            requirements=_requirements("req-python", "Python service optimization"),
            model="fake-model",
        )

        assert outcome.status == "accepted"
        accepted = repository.load_latest(TenantId("local"), "https://example.test/job/1")
        assert accepted is not None
        assert accepted.generation == 1
        assert accepted.gate_audit.status == "passed"
        assert accepted.items[0].evidence_ids == ("ev-platform-latency",)
        assert [event.event_type for event in publisher.events] == ["InterviewPrepGenerated"]
        assert [call["response_schema"] for call in llm.calls] == [
            INTERVIEW_PREP_RESPONSE_SCHEMA,
            ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
        ]
    finally:
        close_connection(tmp_path / "jobs.db")


def test_fabricated_metric_fails_without_superseding_last_accepted_prep(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        publisher = _RecordingPublisher()
        first_llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Latency story",
                    "Reduced API latency by 30% using Python.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                ),
                _judge_pass(),
            ]
        )
        use_case = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=first_llm,
            publisher=publisher,
        )
        use_case.execute(
            tenant_id=LOCAL_TENANT,
            job=_job(),
            profile_snapshot=_profile_snapshot(),
            evidence_entries=_evidence_entries(),
            evidence_gaps=(),
            requirements=_requirements("req-python", "Python service optimization"),
        )

        second_llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Inflated latency story",
                    "Reduced API latency by 99% using Python.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                )
            ]
        )
        outcome = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=second_llm,
            publisher=publisher,
        ).execute(
            tenant_id=LOCAL_TENANT,
            job=_job(),
            profile_snapshot=_profile_snapshot(),
            evidence_entries=_evidence_entries(),
            evidence_gaps=(),
            requirements=_requirements("req-python", "Python service optimization"),
        )

        assert outcome.status == "failed"
        assert any("99%" in error for error in outcome.errors)
        latest_accepted = repository.load_latest(TenantId("local"), "https://example.test/job/1")
        latest_any = repository.load_latest(
            TenantId("local"),
            "https://example.test/job/1",
            status=None,
        )
        assert latest_accepted is not None
        assert latest_accepted.generation == 1
        assert latest_accepted.status == "accepted"
        assert latest_any is not None
        assert latest_any.generation == 2
        assert latest_any.status == "failed"
        assert [event.event_type for event in publisher.events] == [
            "InterviewPrepGenerated",
            "InterviewPrepFailed",
        ]
        assert [call["response_schema"] for call in second_llm.calls] == [
            INTERVIEW_PREP_RESPONSE_SCHEMA
        ]
    finally:
        close_connection(tmp_path / "jobs.db")


def test_star_draft_claim_must_ground_in_referenced_evidence_source(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Planning story",
                    "Led cross-team planning for Python service optimization.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                )
            ]
        )

        outcome = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=llm,
            publisher=_RecordingPublisher(),
        ).execute(
            tenant_id=LOCAL_TENANT,
            job=_job(),
            profile_snapshot=_profile_snapshot(),
            evidence_entries=_evidence_entries(),
            evidence_gaps=(),
            requirements=_requirements("req-python", "Python service optimization"),
        )

        assert outcome.status == "failed"
        assert any(
            "claim-prep-1 ungrounded: text_not_in_shipped_resume" in error
            for error in outcome.errors
        )
        assert [call["response_schema"] for call in llm.calls] == [
            INTERVIEW_PREP_RESPONSE_SCHEMA
        ]
    finally:
        close_connection(tmp_path / "jobs.db")


def test_gap_drill_must_name_gap_without_claiming_experience(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        llm = _FakeLlm(
            [
                _candidate(
                    "gap_drill",
                    "Kubernetes gap practice",
                    "I used Kubernetes in production to operate clusters.",
                    evidence_ids=[],
                    requirement_ids=["req-kubernetes"],
                )
            ]
        )

        outcome = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=llm,
            publisher=_RecordingPublisher(),
        ).execute(
            tenant_id=LOCAL_TENANT,
            job=_job(),
            profile_snapshot=_profile_snapshot(),
            evidence_entries=_evidence_entries(),
            evidence_gaps=(
                {
                    "requirementId": "req-kubernetes",
                    "demandedSkill": "Kubernetes",
                    "jobRefs": [{"jobKey": "https://example.test/job/1"}],
                },
            ),
            requirements=_requirements("req-kubernetes", "Kubernetes administration"),
        )

        assert outcome.status == "failed"
        assert any("gap drill asserts experience" in error for error in outcome.errors)
    finally:
        close_connection(tmp_path / "jobs.db")


def test_event_recorder_writes_safe_camel_and_snake_payload_aliases(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        InterviewPrepEventRecorder(conn).publish(
            create_interview_prep_generated(
                LOCAL_TENANT,
                InterviewPrepGeneratedPayload(
                    job_id="https://example.test/job/1",
                    generation=3,
                    item_count=4,
                    generated_at="2026-07-05T12:00:00Z",
                ),
            )
        )

        row = conn.execute(
            """
            SELECT payload_json FROM job_events
            WHERE event_type = 'InterviewPrepGenerated'
            """
        ).fetchone()
        payload = json.loads(row["payload_json"])
        assert payload["job_id"] == "https://example.test/job/1"
        assert payload["jobId"] == "https://example.test/job/1"
        assert payload["item_count"] == 4
        assert payload["itemCount"] == 4
        assert payload["generated_at"] == "2026-07-05T12:00:00Z"
        assert payload["generatedAt"] == "2026-07-05T12:00:00Z"
    finally:
        close_connection(tmp_path / "jobs.db")


def test_retry_with_same_origin_run_reuses_completed_generation(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        publisher = _RecordingPublisher()
        llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Latency story",
                    "Reduced API latency by 30% using Python.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                ),
                _judge_pass(),
            ]
        )
        use_case = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=llm,
            publisher=publisher,
        )
        request = {
            "tenant_id": LOCAL_TENANT,
            "job": _job(),
            "profile_snapshot": _profile_snapshot(),
            "evidence_entries": _evidence_entries(),
            "evidence_gaps": (),
            "requirements": _requirements("req-python", "Python service optimization"),
            "model": "fake-model",
        }

        first = use_case.execute(origin_run_id="wf-run-1", **request)
        assert first.status == "accepted"
        assert first.prep.generation == 1
        assert len(llm.calls) == 2  # one generation call + one judge call

        # A retried activity attempt for the SAME workflow run must reuse the
        # already-generated prep: no second LLM spend, no duplicate row. Only two
        # canned responses exist, so a re-generation would also raise IndexError.
        retry = use_case.execute(origin_run_id="wf-run-1", **request)
        assert retry.status == "accepted"
        assert retry.prep.generation == 1
        assert len(llm.calls) == 2
        row_count = conn.execute(
            "SELECT COUNT(*) FROM job_interview_prep WHERE job_id = ?",
            (TEST_JOB_ID,),
        ).fetchone()[0]
        assert row_count == 1
        assert [event.event_type for event in publisher.events] == ["InterviewPrepGenerated"]
    finally:
        close_connection(tmp_path / "jobs.db")


def test_new_workflow_run_generates_a_fresh_generation(tmp_path: Path) -> None:
    conn = _init_conn(tmp_path)
    try:
        repository = SqliteInterviewPrepRepository(conn)
        request = {
            "tenant_id": LOCAL_TENANT,
            "job": _job(),
            "profile_snapshot": _profile_snapshot(),
            "evidence_entries": _evidence_entries(),
            "evidence_gaps": (),
            "requirements": _requirements("req-python", "Python service optimization"),
            "model": "fake-model",
        }

        first_llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Latency story",
                    "Reduced API latency by 30% using Python.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                ),
                _judge_pass(),
            ]
        )
        first = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=first_llm,
            publisher=_RecordingPublisher(),
        ).execute(origin_run_id="wf-run-1", **request)
        assert first.prep.generation == 1

        # A genuinely new workflow run (new run id) is not a retry: idempotency
        # must not suppress a legitimate re-generation.
        second_llm = _FakeLlm(
            [
                _candidate(
                    "star_draft",
                    "Latency story",
                    "Reduced API latency by 30% using Python.",
                    evidence_ids=["ev-platform-latency"],
                    requirement_ids=["req-python"],
                ),
                _judge_pass(),
            ]
        )
        second = GenerateInterviewPrepUseCase(
            repository=repository,
            llm=second_llm,
            publisher=_RecordingPublisher(),
        ).execute(origin_run_id="wf-run-2", **request)
        assert second.status == "accepted"
        assert second.prep.generation == 2
        assert len(second_llm.calls) == 2
    finally:
        close_connection(tmp_path / "jobs.db")


@pytest.mark.asyncio
async def test_generate_activity_offloads_generation_and_heartbeats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    heartbeats: list[str] = []
    forwarded: dict[str, str] = {}
    started = threading.Event()
    release = threading.Event()

    def _blocking_generate(
        job_url: str,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
        llm_model: str | None = None,
        origin_run_id: str = "",
    ) -> GenerateInterviewPrepActivityOutput:
        forwarded["origin_run_id"] = origin_run_id
        started.set()
        # Stand in for a generation that runs longer than the heartbeat timeout.
        if not release.wait(timeout=5):
            raise AssertionError("release was never set")
        return GenerateInterviewPrepActivityOutput(
            status="accepted",
            job_url=job_url,
            generation=1,
            item_count=1,
        )

    monkeypatch.setattr(interview_activities, "generate_interview_prep_by_url", _blocking_generate)
    monkeypatch.setattr(
        interview_activities.activity,
        "heartbeat",
        lambda *args, **_kwargs: heartbeats.append(args[0] if args else ""),
    )
    monkeypatch.setattr(
        interview_activities.activity,
        "info",
        lambda: SimpleNamespace(
            activity_type="generate_interview_prep",
            workflow_run_id="wf-run-heartbeat",
        ),
    )

    task = asyncio.create_task(
        generate_interview_prep_activity(
            GenerateInterviewPrepActivityInput(job_url="https://example.test/job/1")
        )
    )
    # The blocking generation runs in the worker thread pool, so the event loop
    # stays responsive instead of being starved by an inline blocking call.
    await asyncio.get_running_loop().run_in_executor(None, started.wait, 2)
    await asyncio.sleep(0.05)
    assert not task.done()
    assert "interview-prep starting" in heartbeats

    release.set()
    output = await asyncio.wait_for(task, timeout=5)
    assert output.status == "accepted"
    assert heartbeats[-1] == "done"
    assert forwarded["origin_run_id"] == "wf-run-heartbeat"


def _init_conn(tmp_path: Path):
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'local', ?, 'Backend Engineer', 'ExampleCo', ?)
        """,
        (TEST_JOB_URL, TEST_JOB_ID, "2026-07-29T10:00:00+00:00"),
    )
    conn.commit()
    return conn


def _job() -> dict[str, Any]:
    return {
        "url": TEST_JOB_URL,
        "title": "Backend Engineer",
        "company": "ExampleCo",
    }


def _profile_snapshot() -> ProfileSnapshot:
    profile = {
        "experience": {"total_years": "6"},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer focused on platform reliability."},
            "experience_entries": [
                {
                    "id": "platform",
                    "company": "Acme",
                    "title": "Backend Engineer",
                    "bullets": ["Reduced API latency by 30% using Python."],
                    "achievement_evidence": [
                        {
                            "id": "ev-platform-latency",
                            "source_text": "Reduced API latency by 30% using Python.",
                            "scope": "API latency",
                            "action": "Optimized Python service",
                            "tools": ["Python"],
                            "metrics": ["30%"],
                            "outcome": "Latency reduction",
                            "evidence_strength": "verified",
                            "claim_confidence": 1.0,
                            "user_confirmed": True,
                            "tags": ["latency"],
                        }
                    ],
                }
            ],
            "education_entries": [],
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python"]}],
            "tailoring_rules": {},
        },
        "resume_constraints": {"real_metrics": ["30%"]},
        "skills_boundary": {"languages": ["Python"]},
        "resume_facts": {"preserved_companies": ["Acme"], "real_metrics": ["30%"]},
    }
    return ProfileSnapshot(
        tenant_id=LOCAL_TENANT,
        profile_id="profile",
        version=1,
        _data=profile,
    )


def _evidence_entries() -> tuple[dict[str, Any], ...]:
    return (
        {
            "evidenceId": "ev-platform-latency",
            "title": "API latency reduction",
            "resumeUsages": [{"jobKey": "https://example.test/job/1"}],
        },
    )


def _requirements(requirement_id: str, text: str) -> tuple[dict[str, Any], ...]:
    return (
        {
            "requirementId": requirement_id,
            "requirementText": text,
            "tier": "must_have",
            "weight": 1.0,
        },
    )


def _candidate(
    kind: str,
    title: str,
    generated_text: str,
    *,
    evidence_ids: list[str],
    requirement_ids: list[str],
) -> dict[str, Any]:
    return {
        "items": [
            {
                "kind": kind,
                "title": title,
                "generated_text": generated_text,
                "evidence_ids": evidence_ids,
                "requirement_ids": requirement_ids,
            }
        ]
    }


def _judge_pass() -> dict[str, Any]:
    return {
        "verdict": "PASS",
        "score": 0.95,
        "score_rationale": "Grounded in profile evidence.",
        "personas": [
            {
                "persona": "evidence_auditor",
                "verdict": "PASS",
                "score": 0.95,
                "score_rationale": "The metric and tool are supported.",
                "blockers": [],
                "warnings": [],
                "repair_instructions": [],
            }
        ],
        "blockers": [],
        "warnings": [],
        "repair_instructions": [],
    }
