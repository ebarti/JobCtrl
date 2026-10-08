"""Analysis generation gates depend on model determinations, never prose patterns."""

import json
import sqlite3

import pytest

from jobctrl.domain.materials.analysis import JobAnalysis, JobAnalysisDraft, EnsembleError
from jobctrl.domain.materials.analyze_use_case import AnalyzeJobUseCase
from jobctrl.domain.materials.analysis_agreement import ModelAnalysisAgreementJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.enrichment.interpretation import PersistedJobInterpreter
from jobctrl.infrastructure.materials.employer_analysis_repository import SqliteEmployerAnalysisRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema

JOB_ID = "90000000-0000-4000-8000-000000000066"
JOB = {"job_id": JOB_ID, "title": "Synthetic title", "full_description": "Canonical posting"}


class Model:
    def __init__(self, verdict="pass", agreement=0.9, fault=None, protected=False):
        self.verdict, self.agreement, self.fault, self.protected, self.calls = verdict, agreement, fault, protected, []

    def chat_json(self, messages, *, response_schema, **kwargs):
        data = json.loads(messages[1].content)
        sources = {row["source_id"]: row["text"] for row in data["sources"]}
        title = response_schema["title"]
        self.calls.append(title)
        if self.fault == title:
            raise RuntimeError("PRIVATE PROVIDER DATA")

        def cite(ident):
            return {"source_id": ident, "quote": sources[ident], "exact_values": []}

        if title == "ClaimVerification":
            return {
                "verdict": self.verdict,
                "rationale": "Model review decision",
                "lines": [
                    {
                        "line_id": row["line_id"],
                        "verdict": self.verdict,
                        "source_evidence": [],
                        "served_requirements": [],
                        "claims": [],
                        "findings": []
                        if self.verdict == "pass"
                        else [
                            {
                                "kind": "process_narration",
                                "rationale": "Model rejects narration",
                                "citation": cite("line:" + row["line_id"]),
                            }
                        ],
                    }
                    for row in data["context"]["lines"]
                ],
            }
        if title == "DraftAgreement":
            return {
                "score": self.agreement,
                "findings": [],
                "citations": [cite(next(iter(sources)))],
                "rationale": "Model agreement decision",
            }
        if title == "JobInterpretation":

            def field(value):
                return {"value": value, "citations": [cite("posting")], "rationale": "Model classification"}

            return {
                "track": field("ic"),
                "seniority": field("senior"),
                "occupation_family": field("software_engineering"),
                "work_model": field("unknown"),
                "places": [],
                "constraints": [],
                "compensation": [],
                "requirements": [
                    {
                        "requirement_id": ident,
                        "scope": "resume",
                        "protected_class": self.protected,
                        "citations": [cite(ident)],
                        "rationale": "Model requirement decision",
                    }
                    for ident in data["context"]["requirement_ids"]
                ],
            }
        raise AssertionError(title)


class Draft:
    model_id = "fake:leg"

    def __init__(self):
        self.calls = []

    async def draft(self, prompt, snapshot):
        self.calls.append(prompt)
        return JobAnalysisDraft(
            model_id=self.model_id,
            role_framing="Synthetic framing",
            inferred_seniority="unknown",
            ideal_candidate_narrative="Synthetic candidate needs",
            requirements=[
                {
                    "id": "r1",
                    "text": "Synthetic requirement",
                    "tier": "must_have",
                    "weight": 1.0,
                    "evidence_span": "Canonical posting",
                    "coverage_scope": "resume",
                }
            ],
            keywords=[],
        )


class OtherDraft(Draft):
    model_id = "fake:other-leg"


class Synth:
    async def reconcile(self, prompt, *, drafts, jd_snapshot):
        return JobAnalysis.model_validate(drafts[0].model_dump(exclude={"model_id"}))


def connection():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, company, discovered_at) VALUES ('local',?,'https://example.test/analysis','Synthetic title','Synthetic employer','2026-10-06')",
        (JOB_ID,),
    )
    conn.commit()
    return conn


def use_case(conn, model, draft=None, *, multiple=False):
    deps = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="synthetic",
        lane="enrichment",
        preflight=lambda: None,
    )
    return AnalyzeJobUseCase(
        repository=SqliteEmployerAnalysisRepository(conn),
        adapters=(draft or Draft(), OtherDraft()) if multiple else (draft or Draft(),),
        synthesizer=Synth(),
        claim_verifier=ModelClaimVerifier(**deps),
        agreement_judge=ModelAnalysisAgreementJudge(**deps),
        job_interpreter=PersistedJobInterpreter(conn, dependencies=deps),
        system_prompt="Synthetic instructions",
        synthesizer_system_prompt="Synthetic synthesis",
    )


def test_analysis_acceptance_and_rejection_follow_model_for_identical_prose():
    conn, model = connection(), Model()
    accepted = use_case(conn, model).execute(job=JOB)
    record = accepted.analysis
    assert record.canonical.inferred_seniority == "senior"
    assert record.agreement.score is None
    assert set(record.determination_ids) == {"fake:leg", "canonical", "job_interpretation"}
    loaded = SqliteEmployerAnalysisRepository(conn).load(record.tenant_id, record.job_id)
    assert loaded.determination_ids == record.determination_ids
    assert len(loaded.line_anchors) == 3
    assert (
        conn.execute("SELECT COUNT(*) FROM artifact_line_anchors WHERE artifact_kind='employer_analysis'").fetchone()[0]
        == 3
    )
    calls = len(model.calls)
    assert use_case(conn, model).execute(job=JOB).cached
    assert len(model.calls) == calls
    other = connection()
    with pytest.raises(EnsembleError) as error:
        use_case(other, Model(verdict="fail")).execute(job=JOB)
    assert {row.error for row in error.value.failures} == {"claim_verification_failed"}
    assert other.execute("SELECT COUNT(*) FROM job_employer_analysis").fetchone()[0] == 0


def test_failed_analysis_refresh_preserves_accepted_generation():
    conn = connection()
    accepted = use_case(conn, Model()).execute(job=JOB).analysis
    changed = {**JOB, "full_description": "Canonical posting\nNew snapshot source"}
    with pytest.raises(EnsembleError):
        use_case(conn, Model(verdict="fail")).execute(job=changed, force=True)
    current = SqliteEmployerAnalysisRepository(conn).load(accepted.tenant_id, accepted.job_id)
    assert current.generation == accepted.generation
    assert current.canonical == accepted.canonical


def test_protected_class_flag_comes_from_interpretation_and_keeps_original_evidence():
    outputs = []
    for flag in (False, True):
        conn = connection()
        record = use_case(conn, Model(protected=flag)).execute(job=JOB).analysis
        outputs.append(bool(record.eeo_screen_hits))
        assert [row.id for row in record.canonical.requirements] == ["r1"]
        assert record.canonical.requirements[0].evidence_span == "Canonical posting"
    assert outputs == [False, True]


def test_agreement_score_is_model_authored_for_the_same_drafts():
    scores = [
        use_case(connection(), Model(agreement=score), multiple=True).execute(job=JOB).analysis.agreement.score
        for score in (0.1, 0.9)
    ]
    assert scores == [0.1, 0.9]


def test_agreement_provider_failure_cannot_fall_back_to_text_overlap():
    conn = connection()
    model = Model(fault="DraftAgreement")
    result = use_case(conn, model, multiple=True).execute(job=JOB).analysis
    assert result.agreement.score is None
    assert "analysis_agreement" not in result.determination_ids
    assert any(row.model_id == "analysis_agreement" and row.error == "provider_error" for row in result.failures)
    assert conn.execute("SELECT COUNT(*) FROM job_employer_analysis").fetchone()[0] == 1


def test_single_draft_never_spends_on_an_agreement_diagnostic():
    model = Model(fault="DraftAgreement")
    result = use_case(connection(), model).execute(job=JOB).analysis
    assert result.agreement.score is None
    assert "DraftAgreement" not in model.calls
