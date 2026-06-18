"""Phase 5 / S-18: refactored scoring runner exercises the new path.

After Phase 5 the scoring runner writes ONLY to the ``job_scores`` table
through the ``ScoreRepository`` adapter — never to the legacy
``jobs.fit_score`` columns. These tests pin both behaviours.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from jobhunter.database import init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.scoring import (
    EligibilityAssessment,
    FitScore,
    JobScore,
    MatchedKeywords,
    ScoreBreakdown,
    ScoringCriteria,
    ScoringPolicy,
    WeightedScoreDimension,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.scoring import (
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
    SqliteScoringPolicyRepository,
)
from jobhunter.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobhunter.scoring import scorer as scorer_module
from jobhunter.state import set_stage_state


class _ScriptedLlm:
    """Test double for ``LlmPort`` — returns scripted JSON payloads to
    ``chat_json``. Use ``invalid=...`` to script raw strings the parser
    will reject (e.g. for the failure-state coverage)."""

    _DRAIN: dict = {
        "score": 0,
        "technical_fit": 0,
        "experience_fit": 0,
        "role_fit": 0,
        "keywords": [],
        "reasoning": "drained",
    }

    def __init__(self, *responses: dict | str) -> None:
        self._queue = list(responses)
        self.calls = 0
        self.messages = []

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
        self.calls += 1
        self.messages.append(messages)
        if not self._queue:
            return self._DRAIN
        next_payload = self._queue.pop(0)
        if isinstance(next_payload, str):
            # Scripted-error path: pretend the JSON came back as a non-dict
            # so the parser can flip ok=False without a network round-trip.
            return next_payload  # type: ignore[return-value]
        return dict(next_payload)

    def ask(self, prompt: str, **kwargs: Any) -> str:  # pragma: no cover
        raise AssertionError("ScoreJobUseCase should not call ask()")


class _CriteriaProvider:
    def __init__(self, criteria: ScoringCriteria) -> None:
        self.criteria = criteria
        self.loaded = False

    def load(self, profile_snapshot) -> ScoringCriteria:
        self.loaded = True
        return self.criteria


class _AnalyzeUseCase:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def execute(self, *, job: dict, tenant_id=LOCAL_TENANT, force: bool = False):
        self.calls.append({"job": job, "tenant_id": tenant_id, "force": force})
        return SimpleNamespace(analysis=_employer_analysis(str(job["url"])))


class _FailingAnalyzeUseCase:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0

    def execute(self, *, job: dict, tenant_id=LOCAL_TENANT, force: bool = False):
        self.calls += 1
        raise self.error


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "jobhunter.db"
    return init_db(db_path)


@pytest.fixture(autouse=True)
def _stub_default_analyzer(monkeypatch) -> None:
    monkeypatch.setattr(
        scorer_module,
        "build_analyze_use_case",
        lambda *, conn, publisher=None, event_stage: _AnalyzeUseCase(),
    )


def _seed_pending_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Need Python.", "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _employer_analysis(job_url: str) -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Platform ownership.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A Python platform engineer.",
        requirements=[
            Requirement(
                id="req-python-platform",
                text="Own Python platform reliability.",
                tier="must_have",
                weight=0.9,
                evidence_span="Need Python.",
            )
        ],
        keywords=[
            ReasonedKeyword(
                keyword="Python",
                evidence_span="Need Python.",
                requirement_ref="req-python-platform",
            )
        ],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job_url),
        generation=1,
        snapshot_hash=compute_snapshot_hash("Need Python."),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _seed_pending_job_with_description(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str,
    description: str,
    discovered_at: str,
    company: str = "Acme",
    location: str = "Remote",
) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, company, site, location, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (url, title, company, "linkedin", location, description, discovered_at),
    )
    conn.commit()


@pytest.fixture()
def profile_snapshot(tmp_path):
    from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
    from jobhunter.infrastructure.profile.factory import build_profile_repository

    profile = {
        "personal": {"full_name": "Tester"},
        "resume": {
            "executive_profile": {"baseline_text": "Engineer."},
            "experience_entries": [{"id": "r1", "title": "Engineer", "company": "Acme"}],
            "education_entries": [],
            "skill_categories": [],
        },
    }
    bus = InProcessEventBus()
    repo = build_profile_repository(db_path=tmp_path / "jobhunter.db", publisher=bus)
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    return repo.load_snapshot(LOCAL_TENANT)


# ---------------------------------------------------------------------------
# score_job (single job)
# ---------------------------------------------------------------------------


def test_score_job_writes_only_to_job_scores(
    conn: sqlite3.Connection, profile_snapshot
) -> None:
    url = "https://example.com/job/single"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 7,
            "role_fit": 8,
            "keywords": ["python"],
            "reasoning": "ok",
        }
    )

    job_dict = dict(conn.execute("SELECT * FROM jobs WHERE url=?", (url,)).fetchone())
    outcome = scorer_module.score_job(
        profile_snapshot,
        job_dict,
        repository=repo,
        llm_port=llm,
    )
    assert outcome.ok is True

    # New path persisted into job_scores.
    persisted = repo.load(LOCAL_TENANT, JobId(url))
    assert persisted is not None
    assert persisted.fit_score.value == 8

    # Legacy ``jobs.fit_score`` was NOT written by the new path.
    legacy_row = conn.execute(
        "SELECT fit_score, score_reasoning, scored_at FROM jobs WHERE url=?",
        (url,),
    ).fetchone()
    assert legacy_row["fit_score"] is None
    assert legacy_row["score_reasoning"] is None
    assert legacy_row["scored_at"] is None


def test_score_job_with_explicit_sqlite_repository_uses_persisted_policy(
    conn: sqlite3.Connection,
    profile_snapshot,
) -> None:
    url = "https://example.com/job/policy"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    SqliteScoringPolicyRepository(conn).save(
        ScoringPolicy(
            tenant_id=LOCAL_TENANT,
            version=2,
            rubric_version="technical-only-v2",
            dimensions=(WeightedScoreDimension(name="technical_fit", weight=1.0),),
            created_at="2024-01-01T00:00:00+00:00",
        )
    )
    llm = _ScriptedLlm(
        {
            "score": 10,
            "technical_fit": 1,
            "experience_fit": 10,
            "role_fit": 10,
            "keywords": ["python"],
            "reasoning": "Low technical fit despite high overall score.",
        }
    )

    job_dict = dict(conn.execute("SELECT * FROM jobs WHERE url=?", (url,)).fetchone())
    outcome = scorer_module.score_job(
        profile_snapshot,
        job_dict,
        repository=repo,
        llm_port=llm,
    )

    assert outcome.ok is True
    persisted = repo.load(LOCAL_TENANT, JobId(url))
    assert persisted is not None
    assert persisted.fit_score.value == 1
    assert persisted.trace.scoring_policy_id == "local:scoring-policy-v2"
    assert persisted.trace.scoring_policy_version == 2
    assert persisted.trace.rubric_version == "technical-only-v2"
    assert persisted.trace.resolved_dimensions == (
        {"name": "technical_fit", "value": 1, "weight": 1.0, "weighted_value": 1.0},
    )


def test_score_job_by_url_repairs_existing_score_stage_state(
    conn: sqlite3.Connection,
    profile_snapshot,
    monkeypatch,
) -> None:
    url = "https://example.com/job/existing-score-repair"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    existing = JobScore.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        fit_score=FitScore.create(8),
        breakdown=ScoreBreakdown(reasoning="persisted before stage repair"),
        matched_keywords=MatchedKeywords.from_iterable(["python"]),
        scored_at="2026-05-26T00:00:00+00:00",
    )
    repo.save(existing)
    set_stage_state(
        conn,
        url,
        "score",
        "failed",
        error_code="SCORE_FAILED",
        error_message="crashed after score save",
        validate_transition=False,
    )
    llm = _ScriptedLlm(
        {
            "score": 1,
            "technical_fit": 1,
            "experience_fit": 1,
            "role_fit": 1,
            "keywords": [],
            "reasoning": "should not be called",
        }
    )
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)

    outcome = scorer_module.score_job_by_url(
        url,
        profile_snapshot=profile_snapshot,
        resume_text="Engineer with Python.",
        criteria=ScoringCriteria(),
        repository=repo,
        llm_port=llm,
    )

    assert outcome.ok is True
    assert outcome.score is not None
    assert outcome.score.fit_score.value == 8
    assert llm.calls == 0
    stage_row = conn.execute(
        "SELECT state, error_code, error_message "
        "FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
        (url,),
    ).fetchone()
    assert stage_row["state"] == "succeeded"
    assert stage_row["error_code"] is None
    assert stage_row["error_message"] is None
    events = conn.execute(
        "SELECT event_type FROM job_events WHERE job_url = ? AND stage = 'score'",
        (url,),
    ).fetchall()
    assert [row["event_type"] for row in events] == ["StageCompleted"]


def test_score_job_by_url_syncs_existing_blocked_score_to_downstream_stages(
    conn: sqlite3.Connection,
    profile_snapshot,
    monkeypatch,
) -> None:
    url = "https://example.com/job/existing-score-blocked"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    repo.save(
        JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            fit_score=FitScore.create(9),
            breakdown=ScoreBreakdown(
                reasoning="persisted blocked score",
                eligibility=EligibilityAssessment(
                    status="blocked",
                    hard_blockers=("candidate requires sponsorship",),
                ),
            ),
            matched_keywords=MatchedKeywords.from_iterable(["python"]),
            scored_at="2026-05-26T00:00:00+00:00",
        )
    )
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)

    outcome = scorer_module.score_job_by_url(
        url,
        profile_snapshot=profile_snapshot,
        resume_text="Engineer with Python.",
        criteria=ScoringCriteria(),
        repository=repo,
        llm_port=_ScriptedLlm(),
    )

    assert outcome.ok is True
    rows = conn.execute(
        """
        SELECT stage, state, error_code, error_message
        FROM job_stage_states
        WHERE job_url = ? AND stage IN ('tailor', 'cover', 'apply')
        ORDER BY stage
        """,
        (url,),
    ).fetchall()
    assert {row["stage"]: row["state"] for row in rows} == {
        "apply": "blocked",
        "cover": "blocked",
        "tailor": "blocked",
    }
    assert {row["error_code"] for row in rows} == {"SCORE_ELIGIBILITY_BLOCKED"}
    assert all("candidate requires sponsorship" in row["error_message"] for row in rows)


def test_score_job_prompt_uses_company_not_source(
    conn: sqlite3.Connection,
    profile_snapshot,
) -> None:
    url = "https://example.com/job/company"
    conn.execute(
        "INSERT INTO jobs (url, title, company, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            url,
            "Director, Security Engineering",
            "Auctane",
            "linkedin",
            "Lead security engineering teams.",
            "2024-01-01T00:00:00+00:00",
        ),
    )
    conn.commit()
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 9,
            "role_fit": 9,
            "keywords": ["security"],
            "reasoning": "ok",
        }
    )

    job_dict = dict(conn.execute("SELECT * FROM jobs WHERE url=?", (url,)).fetchone())
    outcome = scorer_module.score_job(
        profile_snapshot,
        job_dict,
        repository=repo,
        llm_port=llm,
    )

    assert outcome.ok is True
    prompt = llm.messages[0][1].content
    assert "COMPANY: Auctane" in prompt
    assert "COMPANY: linkedin" not in prompt


# ---------------------------------------------------------------------------
# run_scoring (batch)
# ---------------------------------------------------------------------------


def test_run_scoring_persists_via_repository_only(
    conn: sqlite3.Connection, profile_snapshot, monkeypatch
) -> None:
    url = "https://example.com/job/batch"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 7,
            "technical_fit": 7,
            "experience_fit": 7,
            "role_fit": 7,
            "keywords": ["python"],
            "reasoning": "ok",
        }
    )

    # The default ``run_scoring`` path constructs an SqliteScoreRepository
    # against ``get_connection()``; for tests we inject our tmp connection
    # via the ``repository`` argument and skip get_connection entirely.
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)

    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Engineer with Python.",
    )
    assert summary["scored"] == 1
    assert summary["errors"] == 0
    assert summary["distribution"] == [(7, 1)]

    # New aggregate persisted.
    loaded = repo.load(LOCAL_TENANT, JobId(url))
    assert loaded is not None and loaded.fit_score.value == 7

    # Legacy ``jobs`` columns untouched.
    legacy = conn.execute(
        "SELECT fit_score, scored_at FROM jobs WHERE url=?", (url,)
    ).fetchone()
    assert legacy["fit_score"] is None
    assert legacy["scored_at"] is None

    # Stage state row reflects success.
    stage_row = conn.execute(
        "SELECT state FROM job_stage_states WHERE job_url=? AND stage='score'",
        (url,),
    ).fetchone()
    assert stage_row["state"] == "succeeded"


def test_run_scoring_loads_and_persists_local_scoring_criteria(
    conn: sqlite3.Connection, profile_snapshot, monkeypatch
) -> None:
    url = "https://example.com/job/criteria"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 7,
            "role_fit": 8,
            "fit_band": "strong",
            "confidence": "medium",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["Python"],
            "missing_signals": [],
            "transferable_signals": [],
            "keywords": ["python"],
            "reasoning": "ok",
        }
    )
    criteria = ScoringCriteria(
        min_fit_score=8,
        criteria_text="Favor platform reliability leadership.",
        target_criteria="Remote infrastructure roles.",
        profile_preferences={"target_work_models": "remote"},
    )
    provider = _CriteriaProvider(criteria)
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)
    monkeypatch.setattr(scorer_module, "LocalScoringCriteriaProvider", lambda: provider)

    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Engineer with Python.",
    )

    assert summary["scored"] == 1
    assert provider.loaded is True
    loaded = repo.load(LOCAL_TENANT, JobId(url))
    assert loaded is not None
    assert loaded.criteria.criteria_text == "Favor platform reliability leadership."
    assert loaded.criteria.target_criteria == "Remote infrastructure roles."
    assert loaded.trace.criteria_version == criteria.criteria_version


def test_run_scoring_loads_persisted_employer_analysis_into_prompt(
    conn: sqlite3.Connection,
    profile_snapshot,
    monkeypatch,
) -> None:
    url = "https://example.com/job/analysis-loaded"
    _seed_pending_job(conn, url)
    SqliteEmployerAnalysisRepository(conn).save(_employer_analysis(url))
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 7,
            "role_fit": 8,
            "fit_band": "strong",
            "confidence": "high",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["Python"],
            "missing_signals": [],
            "transferable_signals": [],
            "keywords": ["python"],
            "reasoning": "ok",
            "requirement_assessments": [
                {
                    "requirement_id": "req-python-platform",
                    "requirement_text": "Own Python platform reliability.",
                    "tier": "must_have",
                    "weight": 0.9,
                    "job_evidence_span": "Need Python.",
                    "fit": {"kind": "missing", "reason": "No profile evidence."},
                }
            ],
        }
    )
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)

    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Engineer with Python.",
    )

    assert summary["errors"] == 0
    prompt_payload = llm.messages[0][1].content
    assert "REQUIREMENT FIT INPUTS" in prompt_payload
    assert '"id": "req-python-platform"' in prompt_payload
    assert '"employer_analysis_generation": 1' in prompt_payload
    report = SqliteRequirementFitReportRepository(conn).load(LOCAL_TENANT, JobId(url))
    assert report is not None
    assert report.score_version == 1
    assert report.employer_analysis_generation == 1
    assert report.assessments[0].fit.kind == "missing"


def test_run_scoring_generates_employer_analysis_before_prompt(
    conn: sqlite3.Connection,
    profile_snapshot,
    monkeypatch,
) -> None:
    url = "https://example.com/job/analysis-generated"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    analyze = _AnalyzeUseCase()
    llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 8,
            "role_fit": 9,
            "fit_band": "excellent",
            "confidence": "high",
            "eligibility": {"status": "eligible", "hard_blockers": [], "warnings": []},
            "matched_signals": ["Python"],
            "missing_signals": [],
            "transferable_signals": [],
            "keywords": ["python"],
            "reasoning": "ok",
            "requirement_assessments": [
                {
                    "requirement_id": "req-python-platform",
                    "requirement_text": "Own Python platform reliability.",
                    "tier": "must_have",
                    "weight": 0.9,
                    "job_evidence_span": "Need Python.",
                    "fit": {"kind": "missing", "reason": "No profile evidence."},
                }
            ],
        }
    )
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)

    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Engineer with Python.",
        analyze_use_case=analyze,
    )

    assert summary["errors"] == 0
    assert len(analyze.calls) == 1
    prompt_payload = llm.messages[0][1].content
    assert "REQUIREMENT FIT INPUTS" in prompt_payload
    assert '"id": "req-python-platform"' in prompt_payload
    report = SqliteRequirementFitReportRepository(conn).load(LOCAL_TENANT, JobId(url))
    assert report is not None
    assert report.employer_analysis_generation == 1


def test_run_scoring_fails_before_llm_when_employer_analysis_fails(
    conn: sqlite3.Connection,
    profile_snapshot,
    monkeypatch,
) -> None:
    url = "https://example.com/job/analysis-fails"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    analyze = _FailingAnalyzeUseCase(RuntimeError("analysis unavailable"))
    llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 8,
            "role_fit": 9,
            "keywords": ["python"],
            "reasoning": "should not be called",
        }
    )
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)

    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Engineer with Python.",
        analyze_use_case=analyze,
    )

    assert summary["scored"] == 0
    assert summary["errors"] == 1
    assert analyze.calls == 1
    assert llm.calls == 0
    stage_row = conn.execute(
        "SELECT state, error_code, error_message "
        "FROM job_stage_states WHERE job_url = ? AND stage = 'score'",
        (url,),
    ).fetchone()
    assert stage_row["state"] == "failed"
    assert stage_row["error_code"] == "SCORE_FAILED"
    assert "analysis unavailable" in stage_row["error_message"]


def test_run_scoring_reuses_same_content_score_for_duplicate_jobs(
    conn: sqlite3.Connection, profile_snapshot, monkeypatch
) -> None:
    description = "Lead security engineering, compliance, identity, and platform risk. " * 8
    first_url = "https://www.linkedin.com/jobs/view/1"
    duplicate_url = "https://www.linkedin.com/jobs/view/2"
    _seed_pending_job_with_description(
        conn,
        url=first_url,
        title="Director, Security Engineering - Remote in Spain",
        company="Auctane",
        location="Madrid, Community of Madrid, Spain (Remote)",
        description=description,
        discovered_at="2026-01-02T00:00:00+00:00",
    )
    _seed_pending_job_with_description(
        conn,
        url=duplicate_url,
        title="Director, Security Engineering - Remote in Spain",
        company="Auctane",
        location="Seville, Andalusia, Spain (Remote)",
        description=description,
        discovered_at="2026-01-01T00:00:00+00:00",
    )
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 9,
            "role_fit": 9,
            "keywords": ["security"],
            "reasoning": "ok",
        },
        {
            "score": 3,
            "technical_fit": 3,
            "experience_fit": 3,
            "role_fit": 3,
            "keywords": ["security"],
            "reasoning": "would diverge if called",
        },
    )

    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)
    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Security engineering leadership.",
    )

    assert summary["scored"] == 2
    assert summary["errors"] == 0
    assert llm.calls == 1
    first_score = repo.load(LOCAL_TENANT, JobId(first_url))
    duplicate_score = repo.load(LOCAL_TENANT, JobId(duplicate_url))
    assert first_score is not None and first_score.fit_score.value == 9
    assert duplicate_score is not None and duplicate_score.fit_score.value == 9


def test_run_scoring_reuses_existing_same_content_score_without_llm(
    conn: sqlite3.Connection, profile_snapshot, monkeypatch
) -> None:
    description = "Lead security engineering, compliance, identity, and platform risk. " * 8
    scored_url = "https://www.linkedin.com/jobs/view/scored"
    pending_url = "https://www.linkedin.com/jobs/view/pending-duplicate"
    _seed_pending_job_with_description(
        conn,
        url=scored_url,
        title="Director, Security Engineering - Remote in Spain",
        company="Auctane",
        description=description,
        discovered_at="2026-01-01T00:00:00+00:00",
    )
    repo = SqliteScoreRepository(conn)
    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)
    first_llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 9,
            "role_fit": 9,
            "keywords": ["security"],
            "reasoning": "ok",
        }
    )
    scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=first_llm,
        resume_text="Security engineering leadership.",
    )
    _seed_pending_job_with_description(
        conn,
        url=pending_url,
        title="Director, Security Engineering - Remote in Spain",
        company="Auctane",
        location="Seville, Andalusia, Spain (Remote)",
        description=description,
        discovered_at="2026-01-02T00:00:00+00:00",
    )
    second_llm = _ScriptedLlm(
        {
            "score": 3,
            "technical_fit": 3,
            "experience_fit": 3,
            "role_fit": 3,
            "keywords": ["security"],
            "reasoning": "should not be called",
        }
    )

    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=second_llm,
        resume_text="Security engineering leadership.",
    )

    assert summary["scored"] == 1
    assert summary["errors"] == 0
    assert second_llm.calls == 0
    pending_score = repo.load(LOCAL_TENANT, JobId(pending_url))
    assert pending_score is not None and pending_score.fit_score.value == 9


def test_run_scoring_records_failure_state_when_llm_returns_garbage(
    conn: sqlite3.Connection, profile_snapshot, monkeypatch
) -> None:
    url = "https://example.com/job/bad"
    _seed_pending_job(conn, url)
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 99,  # out of [1, 10] → parser flags ok=False
            "technical_fit": 0,
            "experience_fit": 0,
            "role_fit": 0,
            "keywords": [],
            "reasoning": "invalid",
        }
    )

    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)
    summary = scorer_module.run_scoring(
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="anything",
    )
    assert summary["scored"] == 0
    assert summary["errors"] == 1
    assert repo.load(LOCAL_TENANT, JobId(url)) is None

    stage_row = conn.execute(
        "SELECT state, error_message FROM job_stage_states WHERE job_url=? AND stage='score'",
        (url,),
    ).fetchone()
    assert stage_row["state"] == "failed"
    assert "outside" in (stage_row["error_message"] or "").lower()


def test_run_scoring_preselects_retrieval_top_k_before_llm(
    conn: sqlite3.Connection, profile_snapshot, monkeypatch
) -> None:
    relevant_url = "https://example.com/job/platform"
    stale_irrelevant_url = "https://example.com/job/retail"
    _seed_pending_job_with_description(
        conn,
        url=stale_irrelevant_url,
        title="Retail Operations Manager",
        description="Store staffing, inventory, and sales operations.",
        discovered_at="2026-01-02T00:00:00+00:00",
    )
    _seed_pending_job_with_description(
        conn,
        url=relevant_url,
        title="Platform Engineering Manager",
        description="Lead Kubernetes, SRE, infrastructure, and developer platform teams.",
        discovered_at="2026-01-01T00:00:00+00:00",
    )
    repo = SqliteScoreRepository(conn)
    llm = _ScriptedLlm(
        {
            "score": 9,
            "technical_fit": 9,
            "experience_fit": 9,
            "role_fit": 9,
            "keywords": ["kubernetes", "platform"],
            "reasoning": "ok",
        }
    )

    monkeypatch.setattr(scorer_module, "get_connection", lambda: conn)
    summary = scorer_module.run_scoring(
        limit=1,
        profile_snapshot=profile_snapshot,
        repository=repo,
        llm_port=llm,
        resume_text="Kubernetes platform engineering leadership.",
    )

    assert summary["scored"] == 1
    assert summary["errors"] == 0
    assert repo.load(LOCAL_TENANT, JobId(relevant_url)) is not None
    assert repo.load(LOCAL_TENANT, JobId(stale_irrelevant_url)) is None
