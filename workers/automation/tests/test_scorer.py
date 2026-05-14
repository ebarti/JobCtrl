"""Phase 5 / S-18: refactored scoring runner exercises the new path.

After Phase 5 the scoring runner writes ONLY to the ``job_scores`` table
through the ``ScoreRepository`` adapter — never to the legacy
``jobs.fit_score`` columns. These tests pin both behaviours.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from jobhunter.database import init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.scoring import ScoringCriteria
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.scoring import SqliteScoreRepository
from jobhunter.scoring import scorer as scorer_module


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


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "jobhunter.db"
    return init_db(db_path)


def _seed_pending_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Need Python.", "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _seed_pending_job_with_description(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str,
    description: str,
    discovered_at: str,
) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, title, "Acme", description, discovered_at),
    )
    conn.commit()


@pytest.fixture()
def profile_snapshot(tmp_path):
    from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus
    from jobhunter.infrastructure.profile.factory import build_profile_repository

    profile_path = tmp_path / "profile.json"
    profile_path.write_text(
        '{"personal": {"full_name": "Tester"},'
        '"resume": {"executive_profile": {"baseline_text": "Engineer."},'
        '"experience_entries": [{"id": "r1", "title": "Engineer", "company": "Acme"}],'
        '"education_entries": [], "skill_categories": []}}',
        encoding="utf-8",
    )
    bus = InProcessEventBus()
    repo = build_profile_repository(profile_path=profile_path, publisher=bus)
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
    assert summary["scored"] == 1
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
