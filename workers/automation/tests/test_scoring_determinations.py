"""Scoring and downstream gating follow typed, cited model verdicts."""

import sqlite3
from jobctrl.domain.determinations import Source
from jobctrl.domain.scoring.use_cases import ScoreJobUseCase
from jobctrl.domain.scoring.retrieval import preselect_jobs_for_scoring
from jobctrl.domain.scoring.eligibility import eligibility_blocks_downstream
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.scoring.sqlite_repository import SqliteScoreRepository
from jobctrl.domain.enrichment.interpretation import JobInterpretation
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.domain.identifiers import canonical_job_id

JOB_ID = canonical_job_id("90000000-0000-4000-8000-000000000088")
PROFILE = {
    "resume": {
        "experience_entries": [
            {"id": "entry", "title": "Authored role", "company": "Owned employer", "bullets": ["Owned source"]}
        ]
    }
}


def connection():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at) VALUES ('local',?,'https://example.test/owned','Owned role','Owned employer','2026-10-06')",
        (str(JOB_ID),),
    )
    conn.commit()
    return conn


JOB = {
    "job_id": str(JOB_ID),
    "tenant_id": "local",
    "url": "https://example.test/owned",
    "title": "Owned role",
    "company": "Owned employer",
    "description": "Posting source",
}


class Model:
    def __init__(self, blocked=False, fault=None):
        self.blocked, self.fault, self.calls = blocked, fault, []

    def chat_json(self, messages, **kwargs):
        self.calls.append(messages)
        if self.fault:
            raise self.fault
        cite = {"source_id": "posting", "quote": "Posting source"}
        return {
            "score": 8,
            "technical_fit": 8,
            "experience_fit": 8,
            "role_fit": 8,
            "fit_band": "strong",
            "confidence": "high",
            "eligibility": {
                "status": "blocked" if self.blocked else "eligible",
                "blockers": [{"category": "work_authorization", "reason": "Model blocker reason", "citations": [cite]}]
                if self.blocked
                else [],
                "warnings": [],
            },
            "matched_signals": [],
            "missing_signals": [],
            "transferable_signals": [],
            "requirement_assessments": [],
            "keywords": ["Model keyword"],
            "discovery_feedback": {"verdict": "none", "reason": "Model rationale", "citations": [cite]},
            "reasoning": "Model rationale",
            "citations": [cite],
        }


def interpretation():
    def field(value):
        return {
            "value": value,
            "citations": [{"source_id": "posting", "quote": "Posting source"}],
            "rationale": "Model field",
        }

    return JobInterpretation.model_validate(
        {
            "track": field("ic"),
            "seniority": field("senior"),
            "occupation_family": field("software_engineering"),
            "work_model": field("unknown"),
            "places": [],
            "constraints": [],
            "compensation": [],
            "requirements": [],
        }
    )


def case(conn, model):
    deps = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="fake",
        lane="scoring",
        preflight=lambda: None,
    )
    return ScoreJobUseCase(
        repository=SqliteScoreRepository(conn),
        llm=model,
        determination_dependencies=deps,
        job_interpretation_reader=lambda job: interpretation(),
        confirmed_preferences_reader=lambda snapshot, criteria: [
            Source(source_id="target:roles:0", text="Synthetic saved target")
        ],
    )


def test_same_sources_opposite_model_blockers_change_downstream_outcome():
    for blocked in (False, True):
        conn, model = connection(), Model(blocked)
        outcome = case(conn, model).score(
            job=JOB, profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 1, PROFILE)
        )
        assert outcome.ok
        assert eligibility_blocks_downstream(outcome.score.breakdown.eligibility) == blocked
        assert outcome.score.trace.determination_id
        persisted = conn.execute(
            'SELECT determination_id FROM semantic_entity_bindings WHERE entity_kind="score"'
        ).fetchone()[0]
        assert persisted == outcome.score.trace.determination_id
        if blocked:
            assert outcome.score.breakdown.eligibility.hard_blocker_citations[0][0]["quote"] == "Posting source"
        assert len(model.calls) == 1


def test_scoring_provider_failure_preserves_last_score_and_has_no_fallback():
    conn = connection()
    good = case(conn, Model()).score(job=JOB, profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 1, PROFILE))
    # A new profile version creates a different determination input.
    bad = case(conn, Model(fault=RuntimeError("private error"))).score(
        job=JOB, profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 2, PROFILE)
    )
    assert not bad.ok and bad.error == "semantic_determination:provider_error"
    assert SqliteScoreRepository(conn).load(LOCAL_TENANT, JOB_ID).version == good.score.version
    assert (
        conn.execute('SELECT failure_code FROM semantic_stage_states WHERE state="blocked"').fetchone()[0]
        == "provider_error"
    )


def test_scoring_limit_uses_recency_independently_of_text():
    rows = [
        {"job_id": "old", "discovered_at": "2024-01-01", "title": "Matched matched matched"},
        {"job_id": "new", "discovered_at": "2026-01-01", "title": "Other"},
    ]
    assert [row["job_id"] for row in preselect_jobs_for_scoring(rows, top_k=1)] == ["new"]
