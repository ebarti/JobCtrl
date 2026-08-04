"""Phase 5 / S-18: ScoreJobUseCase + CorrectScoreUseCase wiring.

Each test exercises the use case end-to-end with in-memory fakes for the
``ScoreRepository`` / ``LlmPort`` / ``EventPublisher`` ports so the
behaviour is observable without a real DB or LLM.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobctrl.domain.ports.events import Subscription
from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.scoring import (
    FitScore,
    JobScore,
    MatchedKeywords,
    RequirementFitReport,
    ScoreBreakdown,
    ScoringPolicy,
    ScoringCriteria,
)
from jobctrl.domain.scoring.services import ConstraintChecker, ScoreParser
from jobctrl.domain.scoring.use_cases import (
    CorrectScoreUseCase,
    ScoreJobUseCase,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.profile.factory import build_profile_repository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus


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


class _MemoryPolicyRepo:
    """In-memory ``ScoringPolicyRepository`` keyed by tenant."""

    def __init__(self) -> None:
        self._policies: dict[str, list[ScoringPolicy]] = {}

    def get_current(self, tenant_id):
        rows = self._policies.get(str(tenant_id))
        if rows:
            return rows[-1]
        policy = ScoringPolicy.default(tenant_id, created_at="2024-01-01T00:00:00+00:00")
        self.save(policy)
        return policy

    def save(self, policy: ScoringPolicy) -> None:
        self._policies.setdefault(str(policy.tenant_id), []).append(policy)

    def save_correction_signal(self, signal):
        current = self.get_current(signal.tenant_id)
        policy = current.with_correction_signal(signal)
        self.save(policy)
        return policy


class _MemoryRequirementFitRepo:
    def __init__(self) -> None:
        self.saved: list[tuple[str, RequirementFitReport]] = []

    def load(self, tenant_id, job_id, *, score_version=None):  # pragma: no cover
        reports = [
            report
            for tenant, report in self.saved
            if tenant == str(tenant_id) and report.job_id == str(job_id)
        ]
        if score_version is not None:
            reports = [report for report in reports if report.score_version == score_version]
        return reports[-1] if reports else None

    def save(self, tenant_id, report: RequirementFitReport) -> None:
        self.saved.append((str(tenant_id), report))


class _ScriptedLlm:
    """Deterministic ``LlmPort`` returning canned structured-output payloads."""

    def __init__(self, *responses: dict) -> None:
        self._queue: list[dict] = [dict(r) for r in responses]
        self.calls: list[list[LlmMessage]] = []
        self.kwargs: list[dict[str, Any]] = []

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
        self.kwargs.append(
            {
                "response_schema": response_schema,
                "model": model,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "thinking_budget": thinking_budget,
            }
        )
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
    """Build a fresh ``ProfileSnapshot`` from an explicitly saved profile."""
    profile = {
        "personal": {"full_name": "Tester"},
        "resume": {
            "executive_profile": {"baseline_text": "Engineer with 5 years experience."},
            "experience_entries": [{"id": "r1", "title": "Engineer", "company": "Acme"}],
            "education_entries": [],
            "skill_categories": [],
        },
    }
    publisher = InProcessEventBus()
    repo = build_profile_repository(db_path=tmp_path / "jobctrl.db", publisher=publisher)
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    return repo.load_snapshot(LOCAL_TENANT)


def _job_id_for(url: str) -> JobId:
    return JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, url)))


def _job(url: str = "https://example.com/job/1") -> dict[str, Any]:
    return {
        "tenant_id": str(LOCAL_TENANT),
        "job_id": str(_job_id_for(url)),
        "url": url,
        "title": "Senior Engineer",
        "site": "Acme",
        "location": "Remote",
        "full_description": "We need a Python and FastAPI engineer.",
    }


def _profile_snapshot_with_evidence(tmp_path):
    profile = {
        "personal": {"full_name": "Tester"},
        "resume": {
            "executive_profile": {"baseline_text": "Engineering leader."},
            "experience_entries": [
                {
                    "id": "acme_platform",
                    "title": "Director of Engineering",
                    "company": "Acme",
                    "bullets": ["Led Python platform reliability for distributed APIs."],
                    "achievement_evidence": [
                        {
                            "id": "ev_python_platform",
                            "source_text": "Led Python platform reliability for distributed APIs.",
                            "tools": ["Python", "FastAPI"],
                            "metrics": [],
                            "seniority_signal": "technical ownership",
                            "tags": ["python", "platform", "reliability"],
                        }
                    ],
                }
            ],
            "education_entries": [],
            "skill_categories": [],
        },
    }
    repo = build_profile_repository(db_path=tmp_path / "profile-evidence.db")
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    return repo.load_snapshot(LOCAL_TENANT)


def _profile_snapshot_with_education(tmp_path):
    profile = {
        "personal": {"full_name": "Tester"},
        "resume": {
            "executive_profile": {"baseline_text": "Security engineering leader."},
            "experience_entries": [
                {
                    "id": "security_leadership",
                    "title": "Security Engineering Lead",
                    "company": "Acme",
                    "bullets": ["Led enterprise security governance programmes."],
                }
            ],
            "education_entries": [
                {
                    "id": "security_degree",
                    "degree": "Bachelor of Science in Information Security",
                    "institution": "State University",
                    "date": "2016",
                }
            ],
            "skill_categories": [],
        },
    }
    repo = build_profile_repository(db_path=tmp_path / "profile-education.db")
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    return repo.load_snapshot(LOCAL_TENANT)


def _employer_analysis(
    job_id: JobId = _job_id_for("https://example.com/job/1"),
    *,
    tenant_id=LOCAL_TENANT,
) -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Platform ownership.",
        inferred_seniority="director",
        ideal_candidate_narrative="A hands-on platform reliability leader.",
        requirements=[
            Requirement(
                id="req-platform",
                text="Lead Python platform reliability across distributed APIs.",
                tier="must_have",
                weight=0.95,
                evidence_span="Python platform reliability",
            )
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Python",
                evidence_span="Python",
                requirement_ref="req-platform",
            )
        ],
    )
    return EmployerAnalysis.build(
        tenant_id=tenant_id,
        job_id=job_id,
        generation=3,
        snapshot_hash=compute_snapshot_hash("Python platform reliability"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _strong_llm_response() -> dict[str, Any]:
    return {
        "score": 9,
        "technical_fit": 9,
        "experience_fit": 9,
        "role_fit": 9,
        "fit_band": "excellent",
        "confidence": "high",
        "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
        "matched_signals": ["Python"],
        "missing_signals": [],
        "transferable_signals": [],
        "keywords": ["python"],
        "reasoning": "The role otherwise looks excellent.",
    }


# ---------------------------------------------------------------------------
# ScoreParser
# ---------------------------------------------------------------------------


def test_score_parser_rejects_missing_keyword_field() -> None:
    result = ScoreParser().parse_json(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 7,
            "role_fit": 8,
            "reasoning": "Strong overlap.",
        }
    )

    assert result.ok is False
    assert "keywords" in result.error


def test_score_parser_rejects_empty_keyword_array() -> None:
    result = ScoreParser().parse_json(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 7,
            "role_fit": 8,
            "keywords": [],
            "reasoning": "Strong overlap.",
        }
    )

    assert result.ok is False
    assert "keywords" in result.error


def test_score_parser_rejects_blank_only_keyword_array() -> None:
    result = ScoreParser().parse_json(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 7,
            "role_fit": 8,
            "keywords": [" ", "\t", "\n"],
            "reasoning": "Strong overlap.",
        }
    )

    assert result.ok is False
    assert "keywords" in result.error


def test_score_parser_supports_fit_assessment_fields() -> None:
    result = ScoreParser().parse_json(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 8,
            "role_fit": 9,
            "fit_band": "excellent",
            "confidence": "high",
            "eligibility": {
                "status": "warning",
                "hard_blockers": [],
                "warnings": ["location needs review"],
            },
            "matched_signals": ["Python leadership", "Platform reliability"],
            "missing_signals": ["public company scale"],
            "transferable_signals": ["incident command"],
            "keywords": ["python", "platform"],
            "reasoning": "Very strong overlap with one review item.",
        }
    )

    assert result.ok is True
    assert result.fit_score is not None and result.fit_score.value == 9
    assert result.breakdown.fit_band == "excellent"
    assert result.breakdown.confidence == "high"
    assert result.breakdown.eligibility.status == "warning"
    assert result.breakdown.eligibility.warnings == ("location needs review",)
    assert result.breakdown.matched_signals == ("Python leadership", "Platform reliability")
    assert result.breakdown.missing_signals == ("public company scale",)
    assert result.breakdown.transferable_signals == ("incident command",)
    assert result.trace.parser_warnings == ()


def test_score_parser_parses_requirement_assessments() -> None:
    result = ScoreParser().parse_json(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 8,
            "role_fit": 7,
            "fit_band": "strong",
            "confidence": "high",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["platform leadership"],
            "missing_signals": ["public company scale"],
            "transferable_signals": ["incident command"],
            "keywords": ["platform", "reliability"],
            "reasoning": "Strong direct fit with one gap.",
            "requirement_assessments": [
                {
                    "requirement_id": "req-1",
                    "requirement_text": "Lead platform reliability across distributed systems.",
                    "tier": "must_have",
                    "weight": 0.9,
                    "job_evidence_span": "Lead platform reliability",
                    "fit": {
                        "kind": "matched",
                        "evidence_ids": ["profile-exp-1"],
                        "strength": "direct",
                    },
                    "target_keywords": ["reliability"],
                },
                {
                    "requirement_id": "req-2",
                    "requirement_text": "Own public company operating cadence.",
                    "tier": "nice_to_have",
                    "weight": 0.4,
                    "job_evidence_span": "public company",
                    "fit": {"kind": "missing", "reason": "No public-company profile evidence."},
                },
            ],
        }
    )

    assert result.ok is True
    assert len(result.requirement_assessments) == 2
    matched, missing = result.requirement_assessments
    assert matched.fit.kind == "matched"
    assert matched.fit.evidence_ids == ("profile-exp-1",)
    assert matched.tailoring.action == "double_down"
    assert matched.tailoring.allowed_evidence_ids == ("profile-exp-1",)
    assert matched.contribution.rationale == "Pending deterministic requirement-fit resolution."
    assert missing.fit.kind == "missing"
    assert missing.tailoring.action == "avoid_claim"
    assert missing.tailoring.prohibited_claims == (
        "Own public company operating cadence.",
    )
    assert result.trace.parser_warnings == ()


def test_score_parser_does_not_accept_matched_requirement_without_evidence() -> None:
    result = ScoreParser().parse_json(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 8,
            "role_fit": 7,
            "fit_band": "strong",
            "confidence": "medium",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["platform leadership"],
            "missing_signals": [],
            "transferable_signals": [],
            "keywords": ["platform"],
            "reasoning": "Strong fit.",
            "requirement_assessments": [
                {
                    "requirement_id": "req-1",
                    "requirement_text": "Lead platform reliability across distributed systems.",
                    "tier": "must_have",
                    "weight": 0.9,
                    "job_evidence_span": "Lead platform reliability",
                    "fit": {"kind": "matched"},
                },
            ],
        }
    )

    assert result.ok is True
    assert result.requirement_assessments[0].fit.kind == "not_assessed"
    assert result.requirement_assessments[0].tailoring.action == "low_priority"
    assert result.trace.parser_warnings == (
        "requirement_fit_matched_without_evidence:req-1",
    )


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

    persisted = repo.load(LOCAL_TENANT, JobId(_job()["job_id"]))
    assert persisted is not None and persisted.version == 1
    assert persisted.job_id != JobId(_job()["url"])
    assert repo.load(LOCAL_TENANT, JobId(_job()["url"])) is None

    assert len(received) == 1
    assert received[0].event_type == "JobScored"
    assert received[0].payload["fit_score"] == 8


def test_score_job_rejects_url_shaped_job_id(profile_snapshot) -> None:
    job = _job()
    job["job_id"] = job["url"]
    llm = _ScriptedLlm(_strong_llm_response())

    with pytest.raises(ValueError, match="canonical UUID"):
        ScoreJobUseCase(
            repository=_MemoryRepo(),
            llm=llm,
        ).score(job=job, profile_snapshot=profile_snapshot)

    assert llm.calls == []


def test_compute_rejects_cross_tenant_job_before_llm(profile_snapshot) -> None:
    llm = _ScriptedLlm(_strong_llm_response())

    with pytest.raises(ValueError, match="tenant_id"):
        ScoreJobUseCase(repository=_MemoryRepo(), llm=llm).compute(
            job=_job(),
            profile_snapshot=profile_snapshot,
            tenant_id=TenantId("another-tenant"),
        )

    assert llm.calls == []


def test_score_job_omits_structured_output_token_cap(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(_strong_llm_response())

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=_job(),
        profile_snapshot=profile_snapshot,
    )

    assert outcome.ok is True
    assert llm.kwargs[0]["max_tokens"] is None
    assert llm.kwargs[0]["temperature"] == 0.0
    assert llm.kwargs[0]["thinking_budget"] == 0


def test_requirement_fit_prompt_includes_education_evidence(tmp_path) -> None:
    score_repo = _MemoryRepo()
    report_repo = _MemoryRequirementFitRepo()
    job = {
        **_job("https://example.com/job/education-fit"),
        "full_description": "Bachelor's degree in Information Security or equivalent experience required.",
    }
    snapshot = _profile_snapshot_with_education(tmp_path)
    canonical = JobAnalysis(
        role_framing="Security leadership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A security leader with relevant education.",
        requirements=[
            Requirement(
                id="req-degree",
                text="Bachelor's degree in Information Security or equivalent experience.",
                tier="must_have",
                weight=0.55,
                evidence_span="Bachelor's degree in Information Security",
            )
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Information Security",
                evidence_span="Information Security",
                requirement_ref="req-degree",
            )
        ],
    )
    analysis = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["job_id"]),
        generation=1,
        snapshot_hash=compute_snapshot_hash(job["full_description"]),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    llm = _ScriptedLlm(
        {
            **_strong_llm_response(),
            "requirement_assessments": [
                {
                    "requirement_id": "req-degree",
                    "requirement_text": "Bachelor's degree in Information Security or equivalent experience.",
                    "tier": "must_have",
                    "weight": 0.55,
                    "job_evidence_span": "Bachelor's degree in Information Security",
                    "fit": {
                        "kind": "matched",
                        "evidence_ids": ["education:security_degree"],
                        "strength": "direct",
                    },
                }
            ],
        }
    )

    outcome = ScoreJobUseCase(
        repository=score_repo,
        llm=llm,
        requirement_fit_repository=report_repo,
    ).score(job=job, profile_snapshot=snapshot, employer_analysis=analysis)

    assert outcome.ok is True
    prompt_payload = llm.calls[0][1].content
    assert '"id": "education:security_degree"' in prompt_payload
    assert "Bachelor of Science in Information Security | State University | 2016" in prompt_payload
    assert outcome.score is not None
    assert (
        "requirement_fit_matched_without_evidence:req-degree"
        not in outcome.score.trace.parser_warnings
    )
    assert report_repo.saved[0][1].assessments[0].fit.kind == "matched"
    assert report_repo.saved[0][1].resolved_fit_score is not None
    assert report_repo.saved[0][1].resolved_fit_score.value == 10


def test_score_job_includes_criteria_in_prompt_and_persists_snapshot(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 8,
            "role_fit": 9,
            "fit_band": "excellent",
            "confidence": "high",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["security leadership"],
            "missing_signals": [],
            "transferable_signals": ["platform reliability"],
            "keywords": ["security", "platform"],
            "reasoning": "Matches the saved leadership criteria.",
        }
    )
    criteria = ScoringCriteria(
        min_fit_score=8,
        criteria_text="Prioritize platform security leadership.",
        target_criteria="Remote infrastructure roles.",
        profile_preferences={
            "target_work_models": "remote",
            "work_authorization": {"require_sponsorship": "no"},
        },
    )

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=_job(),
        profile_snapshot=profile_snapshot,
        criteria=criteria,
    )

    assert outcome.ok is True
    prompt_payload = llm.calls[0][1].content
    assert "Prioritize platform security leadership." in prompt_payload
    assert "Remote infrastructure roles." in prompt_payload
    assert '"target_work_models": "remote"' in prompt_payload
    persisted = repo.load(LOCAL_TENANT, JobId(_job()["job_id"]))
    assert persisted is not None
    assert persisted.criteria.criteria_text == "Prioritize platform security leadership."
    assert persisted.criteria.target_criteria == "Remote infrastructure roles."
    assert persisted.criteria.criteria_version == criteria.criteria_version
    assert persisted.trace.criteria_version == criteria.criteria_version
    assert persisted.breakdown.fit_band == "excellent"


def test_score_job_includes_requirement_fit_inputs_in_prompt(tmp_path) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(_strong_llm_response())
    job = _job("https://example.com/job/requirement-fit-input")
    snapshot = _profile_snapshot_with_evidence(tmp_path)

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=job,
        profile_snapshot=snapshot,
        employer_analysis=_employer_analysis(JobId(job["job_id"])),
    )

    assert outcome.ok is True
    prompt_payload = llm.calls[0][1].content
    assert "REQUIREMENT FIT INPUTS" in prompt_payload
    assert '"employer_analysis_generation": 3' in prompt_payload
    assert '"id": "req-platform"' in prompt_payload
    assert '"tier": "must_have"' in prompt_payload
    assert '"weight": 0.95' in prompt_payload
    assert '"id": "ev_python_platform"' in prompt_payload
    assert "Led Python platform reliability for distributed APIs." in prompt_payload


def test_score_job_ignores_cross_tenant_employer_analysis(tmp_path) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(_strong_llm_response())
    job = _job("https://example.com/job/cross-tenant-analysis")
    analysis = _employer_analysis(
        JobId(job["job_id"]),
        tenant_id=TenantId("another-tenant"),
    )

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=job,
        profile_snapshot=_profile_snapshot_with_evidence(tmp_path),
        employer_analysis=analysis,
    )

    assert outcome.ok is True
    assert "REQUIREMENT FIT INPUTS" not in llm.calls[0][1].content
    assert outcome.score is not None


def test_score_job_persists_resolved_requirement_fit_report(tmp_path) -> None:
    score_repo = _MemoryRepo()
    report_repo = _MemoryRequirementFitRepo()
    job = _job("https://example.com/job/requirement-fit-report")
    snapshot = _profile_snapshot_with_evidence(tmp_path)
    llm = _ScriptedLlm(
        {
            **_strong_llm_response(),
            "requirement_assessments": [
                {
                    "requirement_id": "req-platform",
                    "requirement_text": "Lead Python platform reliability across distributed APIs.",
                    "tier": "must_have",
                    "weight": 0.95,
                    "job_evidence_span": "Python platform reliability",
                    "fit": {
                        "kind": "matched",
                        "evidence_ids": ["ev_python_platform"],
                        "strength": "direct",
                    },
                }
            ],
        }
    )

    outcome = ScoreJobUseCase(
        repository=score_repo,
        llm=llm,
        requirement_fit_repository=report_repo,
    ).score(
        job=job,
        profile_snapshot=snapshot,
        employer_analysis=_employer_analysis(JobId(job["job_id"])),
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.fit_score.value == 10
    assert outcome.score.breakdown.matched_signals == (
        "Lead Python platform reliability across distributed APIs.",
    )
    assert outcome.score.trace.resolution_reason == "requirement_fit_report"
    assert len(report_repo.saved) == 1
    tenant, report = report_repo.saved[0]
    assert tenant == str(LOCAL_TENANT)
    assert report.job_id == job["job_id"]
    assert report.score_version == 1
    assert report.employer_analysis_generation == 3
    assert report.profile_snapshot_version == snapshot.version
    assert report.scoring_policy_version == 1
    assert report.formula_version == "requirement-fit-v1"
    assert report.resolved_fit_score is not None
    assert report.resolved_fit_score.value == 10
    assert report.summary.weighted_fit == 1.0
    assert report.assessments[0].contribution.max_points == 1.1875
    assert report.assessments[0].contribution.awarded_points == 1.1875


def test_score_job_requirement_fit_missing_must_have_drives_low_score(tmp_path) -> None:
    score_repo = _MemoryRepo()
    report_repo = _MemoryRequirementFitRepo()
    job = _job("https://example.com/job/requirement-fit-missing")
    snapshot = _profile_snapshot_with_evidence(tmp_path)
    llm = _ScriptedLlm(
        {
            **_strong_llm_response(),
            "score": 10,
            "technical_fit": 10,
            "experience_fit": 10,
            "role_fit": 10,
            "requirement_assessments": [
                {
                    "requirement_id": "req-platform",
                    "requirement_text": "Lead Python platform reliability across distributed APIs.",
                    "tier": "must_have",
                    "weight": 0.95,
                    "job_evidence_span": "Python platform reliability",
                    "fit": {
                        "kind": "missing",
                        "reason": "No grounded profile evidence.",
                    },
                }
            ],
        }
    )

    outcome = ScoreJobUseCase(
        repository=score_repo,
        llm=llm,
        requirement_fit_repository=report_repo,
    ).score(
        job=job,
        profile_snapshot=snapshot,
        employer_analysis=_employer_analysis(JobId(job["job_id"])),
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.fit_score.value == 1
    assert outcome.score.breakdown.fit_band == "poor"
    assert outcome.score.breakdown.missing_signals == (
        "Lead Python platform reliability across distributed APIs.",
    )
    assert report_repo.saved[0][1].resolved_fit_score is not None
    assert report_repo.saved[0][1].resolved_fit_score.value == 1


def test_score_job_keeps_hard_blockers_separate_from_high_score(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(_strong_llm_response())
    criteria = ScoringCriteria(
        min_fit_score=8,
        target_criteria="Remote only.",
        profile_preferences={
            "target_work_models": "remote",
            "work_authorization": {"require_sponsorship": "yes"},
        },
    )
    job = {
        **_job("https://example.com/job/blocker"),
        "location": "On-site Barcelona",
        "full_description": "Python role. Must already be authorized; no sponsorship. Office-based team.",
    }

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=job,
        profile_snapshot=profile_snapshot,
        criteria=criteria,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.fit_score.value == 9
    assert outcome.score.breakdown.eligibility.status == "blocked"
    assert any(
        "sponsorship" in blocker
        for blocker in outcome.score.breakdown.eligibility.hard_blockers
    )
    # A remote-vs-onsite work-model mismatch is a preference, not a hard
    # eligibility constraint; it must surface as a warning so the job stays
    # in the funnel for the user to judge rather than being silently dropped.
    assert not any(
        "remote" in blocker
        for blocker in outcome.score.breakdown.eligibility.hard_blockers
    )
    assert any(
        "remote" in warning
        for warning in outcome.score.breakdown.eligibility.warnings
    )


def test_score_job_does_not_treat_numeric_prose_as_posted_compensation(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(_strong_llm_response())
    criteria = ScoringCriteria(
        min_fit_score=8,
        profile_preferences={
            "compensation": {
                "salary_range_min": "120,000",
                "salary_expectation": "140,000",
            },
        },
    )
    job = {
        **_job("https://example.com/job/no-posted-pay"),
        "salary": "",
        "full_description": (
            "Lead 30+ engineers across 5 teams in an AI-first delivery model. "
            "Own 202 platform services and mentor 12 staff engineers."
        ),
    }

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=job,
        profile_snapshot=profile_snapshot,
        criteria=criteria,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.breakdown.eligibility.status == "eligible"
    assert "posted compensation appears below profile minimum" not in (
        outcome.score.breakdown.eligibility.hard_blockers
    )


def test_score_job_warns_when_explicit_posted_compensation_is_below_minimum(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(_strong_llm_response())
    criteria = ScoringCriteria(
        min_fit_score=8,
        profile_preferences={
            "compensation": {
                "salary_range_min": "120,000",
                "salary_expectation": "120,000",
            },
        },
    )
    job = {
        **_job("https://example.com/job/posted-pay"),
        "salary": "$80k-$95k",
        "full_description": "Senior engineering role.",
    }

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=job,
        profile_snapshot=profile_snapshot,
        criteria=criteria,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.breakdown.eligibility.status == "warning"
    assert outcome.score.breakdown.eligibility.hard_blockers == ()
    warning = next(
        (
            entry
            for entry in outcome.score.breakdown.eligibility.warnings
            if "posted compensation appears below profile minimum" in entry
        ),
        None,
    )
    assert warning is not None
    # The audit trail must name the source and the parsed figure it judged.
    assert "jobs.salary" in warning
    assert "$95,000" in warning
    assert "$120,000" in warning


@pytest.mark.parametrize(
    "blocker",
    (
        "Compensation range is below the candidate's expectation.",
        "Pay is below the candidate minimum.",
        "Expected earnings are below the target.",
        "The total cash package is under the preferred range.",
        "The salary range falls below the candidate's minimum expectation.",
        "Compensation does not align with the candidate expectations.",
    ),
)
def test_score_job_demotes_model_compensation_blocker_to_warning(
    profile_snapshot,
    blocker: str,
) -> None:
    response = _strong_llm_response()
    response["eligibility"] = {
        "status": "blocked",
        "hard_blockers": [blocker],
        "hard_blocker_categories": ["compensation_preference"],
        "warnings": [],
    }
    outcome = ScoreJobUseCase(repository=_MemoryRepo(), llm=_ScriptedLlm(response)).score(
        job={
            **_job("https://example.com/job/model-salary-blocker"),
            "salary": "",
            "full_description": "Senior engineering role with compensation discussed later.",
        },
        profile_snapshot=profile_snapshot,
        criteria=ScoringCriteria(min_fit_score=8),
    )

    assert outcome.ok is True
    assert outcome.score is not None
    eligibility = outcome.score.breakdown.eligibility
    assert eligibility.status == "warning"
    assert eligibility.hard_blockers == ()
    assert eligibility.warnings == (blocker,)


def test_score_job_preserves_mixed_language_constraint_despite_compensation_category(
    profile_snapshot,
) -> None:
    blocker = "Compensation is below target and the candidate must speak German."
    response = _strong_llm_response()
    response["eligibility"] = {
        "status": "blocked",
        "hard_blockers": [blocker],
        "hard_blocker_categories": ["compensation_preference"],
        "warnings": [],
    }

    outcome = ScoreJobUseCase(repository=_MemoryRepo(), llm=_ScriptedLlm(response)).score(
        job={
            **_job("https://example.com/job/model-language-blocker"),
            "salary": "",
            "full_description": "Senior engineering role with German required.",
        },
        profile_snapshot=profile_snapshot,
        criteria=ScoringCriteria(min_fit_score=8),
    )

    assert outcome.ok is True
    assert outcome.score is not None
    eligibility = outcome.score.breakdown.eligibility
    assert eligibility.status == "blocked"
    assert eligibility.hard_blockers == (blocker,)


def _comp_criteria(desired_min: str) -> ScoringCriteria:
    return ScoringCriteria(
        profile_preferences={"compensation": {"salary_range_min": desired_min}},
    )


def test_constraint_checker_hourly_pay_annualizes_and_does_not_false_block() -> None:
    # Regression: "$50/hourly" is ~$104k/yr, not $50k. The old parser
    # multiplied any amount < 1000 by 1000, fabricating a below-minimum hard
    # blocker that silently dropped a truthful, high-fit job from the funnel.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$50/hourly"},
        criteria=_comp_criteria("80,000"),
    )

    assert assessment.status == "eligible"
    assert assessment.hard_blockers == ()
    assert assessment.warnings == ()


def test_constraint_checker_hourly_below_minimum_is_warning_with_annualization_audit() -> None:
    # An hourly rate is annualized under a fixed-hours assumption, so a
    # below-minimum reading is a warning (never a hard blocker) and the audit
    # trail records the annualized figure, the source, and the assumption.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$50/hr"},
        criteria=_comp_criteria("150,000"),
    )

    assert assessment.status == "warning"
    assert assessment.hard_blockers == ()
    assert len(assessment.warnings) == 1
    warning = assessment.warnings[0]
    assert "posted compensation appears below profile minimum" in warning
    assert "$104,000" in warning
    assert "$150,000" in warning
    assert "jobs.salary" in warning
    assert "2,080" in warning


def test_constraint_checker_confident_annual_below_minimum_is_warning_with_source() -> None:
    # Salary range is a preference, so even a confidently-parsed annual salary
    # stays actionable and records the mismatch as an auditable warning.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$40,000 per year"},
        criteria=_comp_criteria("120,000"),
    )

    assert assessment.status == "warning"
    assert assessment.hard_blockers == ()
    assert len(assessment.warnings) == 1
    warning = assessment.warnings[0]
    assert "posted compensation appears below profile minimum" in warning
    assert "$40,000" in warning
    assert "$120,000" in warning
    assert "jobs.salary" in warning
    assert "period year" in warning


def test_constraint_checker_monthly_pay_below_minimum_is_warning_not_hard_blocker() -> None:
    # Monthly pay is annualized via a fixed x12 assumption, so it is a warning
    # rather than a hard blocker even when the annualized figure is below floor.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$6,000/month"},
        criteria=_comp_criteria("120,000"),
    )

    assert assessment.status == "warning"
    assert assessment.hard_blockers == ()
    assert len(assessment.warnings) == 1
    warning = assessment.warnings[0]
    assert "$72,000" in warning
    assert "period month" in warning


def test_constraint_checker_remote_work_model_mismatch_is_warning_not_hard_blocker() -> None:
    # A remote preference vs an onsite posting is a soft mismatch the user
    # should judge, not a hard eligibility constraint that drops the job.
    assessment = ConstraintChecker().evaluate(
        job={
            "title": "Engineer",
            "location": "On-site Barcelona",
            "full_description": "Office-based team; relocation required.",
        },
        criteria=ScoringCriteria(profile_preferences={"target_work_models": "remote"}),
    )

    assert assessment.status == "warning"
    assert assessment.hard_blockers == ()
    assert any("remote" in warning for warning in assessment.warnings)


def test_constraint_checker_weekly_pay_annualizes_and_does_not_false_block() -> None:
    # Regression: the posted-comp parser classifies only hour/month/year, so a
    # salary-field "$15,000/week" (~$780k/yr) was read as a raw annual $15k and
    # could fabricate a below-minimum hard blocker. Weekly pay must annualize
    # (x52) and never hard-block.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$15,000/week"},
        criteria=_comp_criteria("120,000"),
    )

    assert assessment.status == "eligible"
    assert assessment.hard_blockers == ()
    assert assessment.warnings == ()


def test_constraint_checker_daily_rate_below_minimum_is_warning_not_hard_blocker() -> None:
    # A daily rate annualizes under a fixed working-days assumption, so a
    # below-minimum reading is a warning (never a hard blocker) and the audit
    # trail records the annualized figure and the assumption.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$300/day"},
        criteria=_comp_criteria("120,000"),
    )

    assert assessment.status == "warning"
    assert assessment.hard_blockers == ()
    assert len(assessment.warnings) == 1
    warning = assessment.warnings[0]
    assert "$78,000" in warning
    assert "period day" in warning
    assert "260" in warning


def test_constraint_checker_bare_amount_without_period_is_still_read_as_annual() -> None:
    # A bare salary-field amount with no sub-annual marker keeps the existing
    # parsing behavior: it is read as annual, but remains a preference warning.
    assessment = ConstraintChecker().evaluate(
        job={"title": "Engineer", "salary": "$13,000"},
        criteria=_comp_criteria("120,000"),
    )

    assert assessment.status == "warning"
    assert assessment.hard_blockers == ()
    assert len(assessment.warnings) == 1
    warning = assessment.warnings[0]
    assert "$13,000" in warning
    assert "read as annual" in warning


def test_score_job_resolves_final_score_from_policy_not_llm_overall(profile_snapshot) -> None:
    repo = _MemoryRepo()
    llm = _ScriptedLlm(
        {
            "score": 10,
            "technical_fit": 2,
            "experience_fit": 2,
            "role_fit": 2,
            "fit_band": "excellent",
            "confidence": "high",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["Python"],
            "missing_signals": ["senior ownership", "platform depth"],
            "transferable_signals": [],
            "keywords": ["python"],
            "reasoning": "The overall LLM score is inconsistent with its dimensions.",
        }
    )

    outcome = ScoreJobUseCase(repository=repo, llm=llm).score(
        job=_job("https://example.com/job/low-dimensions"),
        profile_snapshot=profile_snapshot,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.fit_score.value == 2
    assert outcome.score.breakdown.fit_band == "poor"
    assert outcome.score.trace.scoring_policy_id == "local:scoring-policy-v1"
    assert outcome.score.trace.scoring_policy_version == 1
    assert outcome.score.trace.rubric_version == "default-scoring-rubric-v1"
    assert outcome.score.trace.raw_weighted_score == 2.0
    assert outcome.score.trace.resolved_fit_band == "poor"
    assert outcome.score.trace.resolution_reason == "weighted_dimensions+missing_signals_traced"
    assert outcome.score.trace.resolved_dimensions == (
        {"name": "technical_fit", "value": 2, "weight": 0.45, "weighted_value": 0.9},
        {"name": "experience_fit", "value": 2, "weight": 0.3, "weighted_value": 0.6},
        {"name": "role_fit", "value": 2, "weight": 0.25, "weighted_value": 0.5},
    )
    assert outcome.score.trace.fit_band_thresholds == (
        {"band": "excellent", "minimum_score": 9},
        {"band": "strong", "minimum_score": 7},
        {"band": "plausible", "minimum_score": 5},
        {"band": "stretch", "minimum_score": 3},
        {"band": "poor", "minimum_score": 1},
    )
    assert outcome.score.trace.policy_evidence == {
        "confidence": "high",
        "eligibility_status": "eligible",
        "hard_blocker_count": 0,
        "warning_count": 0,
        "matched_signal_count": 1,
        "missing_signal_count": 2,
        "transferable_signal_count": 0,
    }


def test_score_job_returns_error_on_unparseable_response(profile_snapshot) -> None:
    repo = _MemoryRepo()
    # Payload missing the required ``score`` field — parser flags ok=False.
    llm = _ScriptedLlm({"keywords": ["a"], "reasoning": "missing score"})
    use_case = ScoreJobUseCase(repository=repo, llm=llm)

    outcome = use_case.score(job=_job(), profile_snapshot=profile_snapshot)
    assert outcome.ok is False
    assert outcome.score is None
    assert "missing" in outcome.error.lower()
    assert repo.load(LOCAL_TENANT, JobId(_job()["job_id"])) is None


def test_score_job_handles_llm_error_as_parse_failure(profile_snapshot) -> None:
    repo = _MemoryRepo()
    use_case = ScoreJobUseCase(repository=repo, llm=_ExplodingLlm())

    outcome = use_case.score(job=_job(), profile_snapshot=profile_snapshot)
    assert outcome.ok is False
    assert "provider down" in outcome.error
    assert repo.load(LOCAL_TENANT, JobId(_job()["job_id"])) is None


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


def test_correct_score_updates_policy_and_subsequent_score_traces_anchor(
    profile_snapshot,
) -> None:
    repo = _MemoryRepo()
    policy_repo = _MemoryPolicyRepo()
    url = "https://example.com/job/policy-correction"
    llm = _ScriptedLlm(
        {
            "score": 5,
            "technical_fit": 5,
            "experience_fit": 5,
            "role_fit": 5,
            "fit_band": "plausible",
            "confidence": "medium",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["Python"],
            "missing_signals": ["platform leadership"],
            "transferable_signals": [],
            "keywords": ["python"],
            "reasoning": "Initial policy-backed score.",
        },
        {
            "score": 7,
            "technical_fit": 7,
            "experience_fit": 7,
            "role_fit": 7,
            "fit_band": "strong",
            "confidence": "medium",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["Python", "platform"],
            "missing_signals": [],
            "transferable_signals": [],
            "keywords": ["python", "platform"],
            "reasoning": "Subsequent score should cite the learned anchor.",
        },
    )
    scorer = ScoreJobUseCase(repository=repo, llm=llm, policy_repository=policy_repo)

    first = scorer.score(job=_job(url), profile_snapshot=profile_snapshot)
    assert first.score is not None
    assert first.score.trace.scoring_policy_version == 1

    CorrectScoreUseCase(repository=repo, policy_repository=policy_repo).execute(
        tenant_id=LOCAL_TENANT,
        job_id=_job_id_for(url),
        corrected_fit_score=FitScore.create(8),
        rationale="Manual review found stronger platform evidence.",
        corrected_at="2024-01-02T00:00:00+00:00",
    )

    policy = policy_repo.get_current(LOCAL_TENANT)
    assert policy.version == 2
    assert len(policy.anchors) == 1
    assert policy.anchors[0].original_fit_score == FitScore.create(5)
    assert policy.anchors[0].corrected_fit_score == FitScore.create(8)
    assert policy.anchors[0].source_policy_version == 1

    second = scorer.score(
        job=_job("https://example.com/job/after-correction"),
        profile_snapshot=profile_snapshot,
    )

    assert second.score is not None
    assert second.score.trace.scoring_policy_version == 2
    assert second.score.trace.anchor_ids == (policy.anchors[0].anchor_id,)


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
