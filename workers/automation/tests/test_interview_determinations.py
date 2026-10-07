"""Model authority, isolated sources and actual persistence; no semantic corpus."""

import json
import sqlite3

import pytest

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.interview.evidence import InterviewEvidenceSnapshot, InterviewEvidenceSource
from jobctrl.domain.interview.preparation import ModelInterviewPlanner
from jobctrl.domain.interview.use_cases import GenerateInterviewPrepUseCase
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane

JOB_ID = "90000000-0000-4000-8000-000000000021"
JOB = {"job_id": JOB_ID, "title": "Synthetic title", "company": "Synthetic employer"}
PROFILE = ProfileSnapshot(LOCAL_TENANT, "default", 1, {})
EVIDENCE = InterviewEvidenceSnapshot(
    LOCAL_TENANT,
    "default",
    1,
    (
        InterviewEvidenceSource("evidence:A", "Canonical source A", ()),
        InterviewEvidenceSource("evidence:B", "Canonical source B", ()),
    ),
)


class Model:
    model = "synthetic"
    provider_id = "fake"

    def __init__(self, *, verdict="pass", quality="pass", fault=None, scope="direct"):
        self.verdict, self.quality, self.fault, self.scope = verdict, quality, fault, scope
        self.calls = []

    def chat_json(self, messages, *, response_schema, **_kwargs):
        assert current_llm_lane() == "interview"
        title = response_schema["title"]
        self.calls.append((title, messages))
        if self.fault == title:
            raise RuntimeError("PRIVATE PROVIDER TEXT")
        if title == "QuestionPrepCandidate":
            context = json.loads(messages[1].content.split("CONTEXT:\n", 1)[1])
            question = context["questions"][0]
            ids = [row["evidenceId"] for row in question["selected_evidence"]]
            return {
                "items": [
                    {
                        "question_id": question["card"]["id"],
                        "rationale": "Model draft reason",
                        "outline": [
                            {
                                "heading": "Synthetic heading",
                                "text": "Synthetic outline",
                                "evidence_ids": ids,
                                "requirement_ids": [],
                                "factual_support": "accepted_profile_fact" if ids else "needs_clarification",
                                "transform_type": "evidence_reframed" if ids else "clarification",
                                "reason": "Model line reason",
                            }
                        ],
                        "gaps": [] if ids else [{"prompt": "Synthetic missing source", "reason": "Model gap reason"}],
                        "probes": [],
                    }
                ]
            }
        data = json.loads(messages[1].content)
        sources = {source["source_id"]: source["text"] for source in data["sources"]}
        if title == "InterviewPlan":
            selection = data["context"]["selection"]
            ids = selection.get("selectedQuestionIds", ["B01"])
            overrides = {row["questionId"]: row["evidenceIds"] for row in selection.get("evidenceSelections", [])}
            return {
                "questions": [
                    {
                        "question_id": question_id,
                        "rationale": "Model selection reason",
                        "citations": [
                            {
                                "source_id": "card:" + question_id,
                                "quote": sources["card:" + question_id],
                                "exact_values": [],
                            }
                        ],
                        "evidence": [
                            {
                                "evidence_id": evidence_id,
                                "scope": self.scope,
                                "rationale": "Model scope reason",
                                "citation": {
                                    "source_id": evidence_id,
                                    "quote": sources[evidence_id],
                                    "exact_values": [],
                                },
                            }
                            for evidence_id in overrides.get(question_id, ["evidence:A"])
                        ],
                        "requirement_ids": [],
                    }
                    for question_id in ids
                ]
            }
        if title == "ClaimVerification":
            rows = []
            for line in data["context"]["lines"]:
                line_id = line["line_id"]
                findings = (
                    []
                    if self.verdict == "pass"
                    else [
                        {
                            "kind": "unsupported_claim",
                            "rationale": "Model rejects support",
                            "citation": {
                                "source_id": "line:" + line_id,
                                "quote": sources["line:" + line_id],
                                "exact_values": [],
                            },
                        }
                    ]
                )
                rows.append(
                    {
                        "line_id": line_id,
                        "verdict": self.verdict,
                        "source_evidence": [],
                        "served_requirements": [],
                        "claims": [],
                        "findings": findings,
                    }
                )
            return {"verdict": self.verdict, "lines": rows, "rationale": "Model verification reason"}
        if title == "ArtifactQuality":
            return {
                "verdict": self.quality,
                "score": 1.0 if self.quality == "pass" else 0.0,
                "findings": [],
                "evidence_corrections": [],
                "rationale": "Model quality reason",
            }
        raise AssertionError(title)


def connection():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at) VALUES ('local',?,'https://example.test/owned','Synthetic title','Synthetic employer','2026-10-06')",
        (JOB_ID,),
    )
    conn.commit()
    return conn


def use_case(conn, model, preflight=lambda: None):
    dependencies = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="synthetic",
        preflight=preflight,
    )
    return GenerateInterviewPrepUseCase(
        repository=SqliteInterviewPrepRepository(conn),
        llm=model,
        planner=ModelInterviewPlanner(**dependencies),
        claim_verifier=ModelClaimVerifier(**dependencies, lane="interview"),
        quality_judge=ModelArtifactQualityJudge(**dependencies, lane="interview"),
        preflight=preflight,
    )


def request(selection=None):
    return dict(
        tenant_id=LOCAL_TENANT,
        job=JOB,
        profile_snapshot=PROFILE,
        canonical_evidence=EVIDENCE,
        requirements=(),
        selection_input=selection
        or {
            "selectedQuestionIds": ["B01"],
            "evidenceProfileVersion": 1,
            "evidenceSelections": [{"questionId": "B01", "evidenceIds": ["evidence:A"]}],
        },
    )


@pytest.mark.parametrize("verdict,expected", [("pass", "accepted"), ("fail", "failed")])
def test_identical_input_obeys_model_claim_verdict(verdict, expected):
    conn = connection()
    model = Model(verdict=verdict)
    outcome = use_case(conn, model).execute(**request())
    assert outcome.status == expected
    stored = conn.execute(
        "SELECT envelope_json FROM semantic_determinations WHERE kind='claim_verification'"
    ).fetchone()
    assert json.loads(stored[0])["result"]["verdict"] == verdict
    if verdict == "fail":
        assert "ArtifactQuality" not in [title for title, _ in model.calls]


@pytest.mark.parametrize("scope", ["direct", "transferable"])
def test_authority_scope_comes_from_model(scope):
    conn = connection()
    result = use_case(conn, Model(scope=scope)).execute(**request())
    assert result.prep.items[0].question_metadata["evidenceLinks"][0]["scope"] == scope


@pytest.mark.parametrize("quality,expected", [("pass", "accepted"), ("fail", "failed")])
def test_quality_is_a_separate_authoritative_call(quality, expected):
    conn = connection()
    model = Model(quality=quality)
    result = use_case(conn, model).execute(**request())
    assert result.status == expected
    assert [title for title, _ in model.calls] == [
        "InterviewPlan",
        "QuestionPrepCandidate",
        "ClaimVerification",
        "ArtifactQuality",
    ]


def test_explicit_empty_evidence_and_per_question_sources_are_fenced():
    conn = connection()
    model = Model()
    selection = {
        "selectedQuestionIds": ["B01", "M02"],
        "evidenceProfileVersion": 1,
        "evidenceSelections": [
            {"questionId": "B01", "evidenceIds": ["evidence:A"]},
            {"questionId": "M02", "evidenceIds": []},
        ],
    }
    result = use_case(conn, model).execute(**request(selection))
    assert result.status == "accepted", result.errors
    calls = [
        (title, messages[1].content)
        for title, messages in model.calls
        if title in {"QuestionPrepCandidate", "ClaimVerification"}
    ]
    assert len(calls) == 4
    assert "Canonical source B" not in "".join(payload for _, payload in calls)
    assert "Canonical source A" not in calls[2][1] + calls[3][1]
    assert "evidence:A" not in calls[2][1] + calls[3][1]
    second = result.prep.items[1]
    assert second.question_metadata["evidenceLinks"] == []
    assert second.question_metadata["gaps"]
    anchors = conn.execute("SELECT line_id,evidence_ids_json,determination_id FROM artifact_line_anchors").fetchall()
    assert len(anchors) == 6
    assert all(row[2] in result.prep.generation_context["determinations"]["claimVerification"] for row in anchors)
    assert all(json.loads(row[1]) == [] for row in anchors if row[0].startswith("M02:"))


@pytest.mark.parametrize("fault", ["InterviewPlan", "QuestionPrepCandidate", "ClaimVerification", "ArtifactQuality"])
def test_failed_refresh_preserves_accepted_and_retry_spends_nothing(fault):
    conn = connection()
    repository = SqliteInterviewPrepRepository(conn)
    original = use_case(conn, Model()).execute(origin_run_id="accepted", **request()).prep
    note = repository.save_note(
        LOCAL_TENANT, JOB_ID, "B01", expected_revision=0, note_text="Owned synthetic note", source_generation=1
    )
    # A changed canonical version forces new determinations without any output replay.
    fresh = request()
    fresh["profile_snapshot"] = ProfileSnapshot(LOCAL_TENANT, "default", 2, {})
    fresh["canonical_evidence"] = InterviewEvidenceSnapshot(
        LOCAL_TENANT,
        "default",
        2,
        (
            InterviewEvidenceSource("evidence:A", "Changed canonical source A", ()),
            EVIDENCE.sources[1],
        ),
    )
    fresh["job"] = {**JOB, "description": "Changed canonical posting"}
    fresh["selection_input"]["evidenceProfileVersion"] = 2
    model = Model(fault=fault)
    failed = use_case(conn, model).execute(origin_run_id="refresh", **fresh)
    assert failed.status == "failed"
    assert "PRIVATE" not in " ".join(failed.errors)
    before = len(model.calls)
    retried = use_case(conn, model).execute(origin_run_id="refresh", **fresh)
    assert retried == failed and len(model.calls) == before
    assert repository.load_latest(LOCAL_TENANT, JOB_ID).to_read_model() == original.to_read_model()
    assert repository.load_note(LOCAL_TENANT, JOB_ID, "B01") == note


@pytest.mark.parametrize("unavailable", ["provider", "budget"])
def test_unavailable_and_budget_denied_never_generate(unavailable):
    conn = connection()
    model = None if unavailable == "provider" else Model()

    def preflight():
        raise RuntimeError("Owned synthetic denial")

    result = use_case(conn, model, preflight if unavailable == "budget" else lambda: None).execute(**request())
    assert result.errors == ("planning:" + ("provider_unavailable" if unavailable == "provider" else "budget_denied"),)
    assert model is None or model.calls == []
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0


def test_verifier_rejects_foreign_evidence_before_persistence():
    conn = connection()
    model = Model()
    verifier = ModelClaimVerifier(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="synthetic",
        lane="interview",
        preflight=lambda: None,
    )
    with pytest.raises(DeterminationFailure, match="foreign_source_id"):
        verifier.verify(
            artifact_kind="interview",
            entity_id=JOB_ID,
            lines=[
                ArtifactLine(
                    line_id="line1",
                    text="Synthetic final line",
                    allowed_evidence_ids=["foreign"],
                    allowed_requirement_ids=[],
                )
            ],
            evidence=[Source(source_id="owned", text="Owned synthetic source")],
            requirements=[],
            rubric={},
        )
    assert model.calls == []
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0
