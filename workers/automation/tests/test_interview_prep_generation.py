"""Interview prep generation stays grounded in existing materials gates."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jobhunter.database import close_connection, get_connection, init_db
from jobhunter.domain.events import (
    InterviewPrepGeneratedPayload,
    create_interview_prep_generated,
)
from jobhunter.domain.interview import GenerateInterviewPrepUseCase
from jobhunter.domain.interview.use_cases import INTERVIEW_PREP_RESPONSE_SCHEMA
from jobhunter.domain.materials.adversarial import ADVERSARIAL_REVIEW_RESPONSE_SCHEMA
from jobhunter.domain.ports.llm import LlmMessage
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.interview import SqliteInterviewPrepRepository
from jobhunter.interview.activities import InterviewPrepEventRecorder


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


def _init_conn(tmp_path: Path):
    db_path = tmp_path / "jobs.db"
    init_db(db_path)
    return get_connection(db_path)


def _job() -> dict[str, Any]:
    return {
        "url": "https://example.test/job/1",
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
