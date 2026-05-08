"""Phase 5 / S-18: ScoreJobUseCase + CorrectScoreUseCase wiring.

Each test exercises the use case end-to-end with in-memory fakes for the
``ScoreRepository`` / ``LlmPort`` / ``EventPublisher`` ports so the
behaviour is observable without a real DB or LLM.
"""

from __future__ import annotations

from typing import Any

import pytest

from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.events import Subscription
from jobhunter.domain.ports.llm import LlmMessage
from jobhunter.domain.scoring import (
    FitScore,
    JobScore,
    MatchedKeywords,
    ScoreBreakdown,
)
from jobhunter.domain.scoring.use_cases import (
    CorrectScoreUseCase,
    ScoreJobUseCase,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.profile.factory import build_profile_repository
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _MemoryRepo:
    """In-memory ``ScoreRepository`` keyed by ``(tenant_id, job_id)``.

    Matches the SQLite adapter's version-conflict semantics so the use
    case can be tested for the same monotonic-version invariant.
    """

    def __init__(self) -> None:
        self._scores: dict[tuple[str, str], list[JobScore]] = {}

    def load(self, tenant_id, job_id):
        rows = self._scores.get((str(tenant_id), str(job_id)))
        return rows[-1] if rows else None

    def save(self, score: JobScore) -> None:
        key = (str(score.tenant_id), str(score.job_id))
        existing = self._scores.setdefault(key, [])
        expected = (existing[-1].version + 1) if existing else 1
        if score.version != expected:
            raise ValueError(f"version conflict: got {score.version}, want {expected}")
        existing.append(score)

    def list_pending(self, tenant_id, *, limit: int = 0):  # pragma: no cover
        return []

    def list_by_score_range(self, tenant_id, *, min_score: int, max_score: int = 10):
        out: list[JobScore] = []
        for rows in self._scores.values():
            latest = rows[-1]
            if str(latest.tenant_id) != str(tenant_id):
                continue
            if min_score <= latest.fit_score.value <= max_score:
                out.append(latest)
        return out


class _ScriptedLlm:
    """Deterministic ``LlmPort`` returning canned structured-output payloads."""

    def __init__(self, *responses: dict) -> None:
        self._queue: list[dict] = [dict(r) for r in responses]
        self.calls: list[list[LlmMessage]] = []

    def chat(  # pragma: no cover — structured-output cutover routes through chat_json
        self,
        messages,
        *,
        model=None,
        temperature=None,
        max_tokens=None,
        response_schema=None,
        thinking_budget=None,
    ) -> str:
        raise AssertionError("ScoreJobUseCase should use chat_json after the structured-output cutover")

    def chat_json(
        self,
        messages,
        *,
        response_schema,
        model=None,
        temperature=None,
        max_tokens=None,
        thinking_budget=None,
    ) -> dict:
        self.calls.append(list(messages))
        if not self._queue:
            raise AssertionError("ScriptedLlm exhausted")
        return self._queue.pop(0)

    def ask(self, prompt: str, **kwargs: Any) -> str:  # pragma: no cover
        raise AssertionError("ScoreJobUseCase should not call ask()")


class _ExplodingLlm:
    """``LlmPort`` that always raises — exercises error handling."""

    def chat(  # pragma: no cover
        self,
        messages,
        *,
        model=None,
        temperature=None,
        max_tokens=None,
        response_schema=None,
        thinking_budget=None,
    ) -> str:
        raise RuntimeError("provider down")

    def chat_json(
        self,
        messages,
        *,
        response_schema,
        model=None,
        temperature=None,
        max_tokens=None,
        thinking_budget=None,
    ) -> dict:
        raise RuntimeError("provider down")

    def ask(self, prompt: str, **kwargs: Any) -> str:  # pragma: no cover
        raise RuntimeError("provider down")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def profile_snapshot(tmp_path):
    """Build a fresh ``ProfileSnapshot`` from a tmp profile.json."""
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(
        '{"personal": {"full_name": "Tester"},'
        '"resume": {"executive_profile": {"baseline_text": "Engineer with 5 years experience."},'
        '"experience_entries": [{"id": "r1", "title": "Engineer", "company": "Acme"}],'
        '"education_entries": [], "skill_categories": []}}',
        encoding="utf-8",
    )
    publisher = InProcessEventBus()
    repo = build_profile_repository(profile_path=profile_path, publisher=publisher)
    return repo.load_snapshot(LOCAL_TENANT)


def _job(url: str = "https://example.com/job/1") -> dict[str, Any]:
    return {
        "url": url,
        "title": "Senior Engineer",
        "site": "Acme",
        "location": "Remote",
        "full_description": "We need a Python and FastAPI engineer.",
    }


# ---------------------------------------------------------------------------
# ScoreJobUseCase
# ---------------------------------------------------------------------------


def test_score_job_happy_path_persists_and_publishes(profile_snapshot) -> None:
    repo = _MemoryRepo()
    bus = InProcessEventBus()
    received: list[DomainEvent] = []

    def _capture(event: DomainEvent) -> None:
        received.append(event)

    sub: Subscription = bus.subscribe("JobScored", _capture)
    try:
        llm = _ScriptedLlm(
            {
                "score": 8,
                "technical_fit": 8,
                "experience_fit": 7,
                "role_fit": 8,
                "keywords": ["python", "fastapi"],
                "reasoning": "Strong overlap.",
            }
        )
        use_case = ScoreJobUseCase(repository=repo, llm=llm, publisher=bus)
        outcome = use_case.score(job=_job(), profile_snapshot=profile_snapshot)
    finally:
        sub.unsubscribe()

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.fit_score.value == 8
    assert outcome.score.matched_keywords.values == ("python", "fastapi")

    persisted = repo.load(LOCAL_TENANT, JobId(_job()["url"]))
    assert persisted is not None and persisted.version == 1

    assert len(received) == 1
    assert received[0].event_type == "JobScored"
    assert received[0].payload["fit_score"] == 8


def test_score_job_returns_error_on_unparseable_response(profile_snapshot) -> None:
    repo = _MemoryRepo()
    # Payload missing the required ``score`` field — parser flags ok=False.
    llm = _ScriptedLlm({"keywords": ["a"], "reasoning": "missing score"})
    use_case = ScoreJobUseCase(repository=repo, llm=llm)

    outcome = use_case.score(job=_job(), profile_snapshot=profile_snapshot)
    assert outcome.ok is False
    assert outcome.score is None
    assert "missing" in outcome.error.lower()
    assert repo.load(LOCAL_TENANT, JobId(_job()["url"])) is None


def test_score_job_handles_llm_error_as_parse_failure(profile_snapshot) -> None:
    repo = _MemoryRepo()
    use_case = ScoreJobUseCase(repository=repo, llm=_ExplodingLlm())

    outcome = use_case.score(job=_job(), profile_snapshot=profile_snapshot)
    assert outcome.ok is False
    assert "provider down" in outcome.error
    assert repo.load(LOCAL_TENANT, JobId(_job()["url"])) is None


def test_score_job_bumps_version_on_rescore(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(
        {
            "score": 7,
            "technical_fit": 7,
            "experience_fit": 7,
            "role_fit": 7,
            "keywords": ["python"],
            "reasoning": "first pass.",
        },
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 8,
            "role_fit": 9,
            "keywords": ["python", "fastapi"],
            "reasoning": "rescored.",
        },
    )
    use_case = ScoreJobUseCase(repository=repo, llm=llm)
    use_case.score(job=_job(), profile_snapshot=profile_snapshot)
    second = use_case.score(job=_job(), profile_snapshot=profile_snapshot)

    assert second.ok is True
    assert second.score is not None
    assert second.score.version == 2
    assert second.score.fit_score.value == 9


# ---------------------------------------------------------------------------
# CorrectScoreUseCase
# ---------------------------------------------------------------------------


def test_correct_score_publishes_corrected_event_and_persists() -> None:
    repo = _MemoryRepo()
    bus = InProcessEventBus()
    received: list[DomainEvent] = []
    sub = bus.subscribe("ScoreCorrected", received.append)
    try:
        # Seed the repository with an initial score.
        url = "https://example.com/job/2"
        initial = JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            fit_score=FitScore.create(5),
            breakdown=ScoreBreakdown(reasoning="initial"),
            matched_keywords=MatchedKeywords(),
            scored_at="2024-01-01T00:00:00+00:00",
        )
        repo.save(initial)

        use_case = CorrectScoreUseCase(repository=repo, publisher=bus)
        result = use_case.execute(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            corrected_fit_score=FitScore.create(9),
            rationale="False negative — strong match on review.",
            corrected_at="2024-01-02T00:00:00+00:00",
        )
    finally:
        sub.unsubscribe()

    assert result.version == 2
    assert result.fit_score.value == 9
    assert result.correction is not None

    assert len(received) == 1
    assert received[0].event_type == "ScoreCorrected"
    assert received[0].payload["original_score"] == 5
    assert received[0].payload["corrected_score"] == 9


def test_correct_score_raises_when_no_existing_score() -> None:
    repo = _MemoryRepo()
    use_case = CorrectScoreUseCase(repository=repo)
    with pytest.raises(LookupError):
        use_case.execute(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("never-scored"),
            corrected_fit_score=FitScore.create(5),
            rationale="should fail",
        )
