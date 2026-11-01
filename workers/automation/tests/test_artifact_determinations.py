"""Model authority and actual artifact writes with owned synthetic sources."""

from __future__ import annotations

import json
import sqlite3

import pytest

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.aggregate import MaterialsSetFactory
from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.services import ContentValidator
from jobctrl.domain.materials.use_cases import GenerateCoverLetterUseCase
from jobctrl.domain.materials.value_objects import ArtifactType, RenderFormat
from jobctrl.domain.ports.artifact_review import ValidationResult, JudgeVerdict
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema
from jobctrl.llm_lanes import current_llm_lane
from tests.determination_fakes import claim_verification_input, claim_verification_response

JOB_ID = canonical_job_id("90000000-0000-4000-8000-000000000055")
JOB = {
    "job_id": JOB_ID,
    "title": "Synthetic title",
    "company": "Synthetic employer",
    "full_description": "Canonical posting",
}
PROFILE = {
    "personal": {"full_name": "Synthetic Person"},
    "resume": {
        "experience_entries": [
            {
                "id": "entry",
                "title": "Authored title",
                "company": "Authored employer",
                "bullets": ["Canonical source"],
                "achievement_evidence": [
                    {
                        "id": "fact",
                        "source_text": "Canonical source",
                        "user_confirmed": True,
                        "evidence_strength": "supported",
                    }
                ],
            }
        ]
    },
}


class Model:
    provider_id, model = "fake", "synthetic"

    def __init__(self, verdict="pass", quality="pass", fault=None, draft_text="Synthetic draft", adversarial="pass"):
        self.verdict, self.quality, self.fault, self.calls = verdict, quality, fault, []
        self.draft_text = draft_text
        self.adversarial = adversarial

    def chat_json(self, messages, *, response_schema, **kwargs):
        self.calls.append((response_schema["title"], current_llm_lane(), messages))
        if self.fault:
            raise self.fault
        title = response_schema["title"]
        if title == "GeneratedProseDraft":
            return {
                "lines": [
                    {
                        "line_id": "body:1",
                        "text": self.draft_text,
                        "evidence_ids": ["fact"],
                        "requirement_ids": [],
                        "transform_type": "rephrase",
                        "reason": "Generator anchor reason",
                    }
                ]
            }
        data = claim_verification_input(json.loads(messages[1].content))
        sources = {row["source_id"]: row["text"] for row in data["sources"]}
        if title == "ResumeAdversarialReview":
            from tests.determination_fakes import persona_decision

            return persona_decision(data, self.adversarial)
        if title == "ClaimVerification":
            result = {
                "verdict": self.verdict,
                "rationale": "Model support decision",
                "lines": [
                    {
                        "line_id": row["line_id"],
                        "verdict": self.verdict,
                        "source_evidence": [
                            {"source_id": sid, "quote": sources[sid], "exact_values": []}
                            for sid in row["allowed_evidence_ids"]
                        ],
                        "served_requirements": [],
                        "claims": [],
                        "findings": []
                        if self.verdict == "pass"
                        else [
                            {
                                "kind": "unsupported_claim",
                                "rationale": "Model rejects support",
                                "citation": {
                                    "source_id": "line:" + row["line_id"],
                                    "quote": sources["line:" + row["line_id"]],
                                    "exact_values": [],
                                },
                            }
                        ],
                    }
                    for row in data["context"]["lines"]
                ],
            }
            return claim_verification_response(data, result)
        if title == "ArtifactQuality":
            return {
                "verdict": self.quality,
                "score": 0.8,
                "findings": [],
                "evidence_corrections": [],
                "rationale": "Independent model quality decision",
            }
        raise AssertionError(title)


def connection():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v15_schema(conn)
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at) VALUES ('local',?,'https://example.test/owned','Synthetic title','Synthetic employer','2026-10-06')",
        (str(JOB_ID),),
    )
    conn.commit()
    return conn


def ports(conn, model, preflight=lambda: None, lane="tailoring"):
    deps = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="synthetic",
        lane=lane,
        preflight=preflight,
    )
    return ModelClaimVerifier(**deps), ModelArtifactQualityJudge(**deps)


@pytest.mark.parametrize("admitted", [False, True])
def test_quality_correction_requires_revision_authority_even_when_source_exists(admitted):
    class CorrectionModel(Model):
        def chat_json(self, messages, *, response_schema, **kwargs):
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            result.update(
                verdict="fail",
                evidence_corrections=[{"source_id": "addition", "quote": "Saved additional fact", "exact_values": []}],
            )
            return result

    conn, model = connection(), CorrectionModel()
    _, judge = ports(conn, model)
    allowed = ["current", "addition"] if admitted else ["current"]
    kwargs = dict(
        artifact_kind="resume", entity_id="owned",
        lines=[ArtifactLine(line_id="owned", text="Owned current line", allowed_evidence_ids=allowed, allowed_requirement_ids=[])],
        sources=[Source(source_id="current", text="Current fact"), Source(source_id="addition", text="Saved additional fact")],
        rubric={},
    )
    if admitted:
        result, _ = judge.judge(**kwargs)
        assert result.verdict == "fail"
        assert len(model.calls) == 1
    else:
        with pytest.raises(DeterminationFailure, match="foreign_source_id") as error:
            judge.judge(**kwargs)
        assert error.value.repair_context["allowed_evidence_correction_ids"] == ["current"]
        assert len(model.calls) == 3
        assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0
    supplied = json.loads(model.calls[0][2][1].content)
    assert supplied["context"]["allowed_evidence_correction_ids"] == sorted(allowed)


@pytest.mark.parametrize("artifact_kind", ["resume", "cover_letter", "outreach", "employer_analysis"])
def test_same_text_opposite_verdicts_control_each_artifact_kind(artifact_kind):
    outcomes = []
    for verdict in ("pass", "fail"):
        conn, model = connection(), Model(verdict=verdict)
        verifier, _ = ports(conn, model)
        result, envelope = verifier.verify(
            artifact_kind=artifact_kind,
            entity_id="owned",
            lines=[
                ArtifactLine(
                    line_id="owned:line",
                    text="Synthetic text",
                    allowed_evidence_ids=["source:1"],
                    allowed_requirement_ids=[],
                )
            ],
            evidence=[Source(source_id="source:1", text="Canonical source")],
            requirements=[],
            rubric={},
        )
        outcomes.append(result.verdict)
        assert (
            SqliteDeterminationRepository(conn).find("local", envelope.determination_id).result == result.model_dump()
        )
    assert outcomes == ["pass", "fail"]


def cover_case(conn, model, preflight=lambda: None, *, retries=0):
    verifier, quality = ports(conn, model, preflight)
    return GenerateCoverLetterUseCase(
        repository=SqliteMaterialsRepository(conn),
        llm=model,
        claim_verifier=verifier,
        quality_judge=quality,
        preflight=preflight,
        validator=ContentValidator(),
        max_retries=retries,
    )


def seed_resume(conn, tmp_path):
    path = tmp_path / "owned-resume.txt"
    path.write_text("Owned synthetic accepted artifact")
    artifact = Artifact.create(
        type=ArtifactType.TAILORED_RESUME, path=str(path), created_at="2026-10-06", render_format=RenderFormat.TEXT
    )
    materials = MaterialsSetFactory.initial(tenant_id=LOCAL_TENANT, job_id=JOB_ID, created_at="2026-10-06")
    materials = materials.with_resume_attempt(
        artifact, validation=ValidationResult.success(), verdict=JudgeVerdict.passed(), updated_at="2026-10-06"
    )
    pdf = Artifact.create(
        type=ArtifactType.RESUME_PDF, path=str(path), created_at="2026-10-06", render_format=RenderFormat.HTML_PDF
    )
    materials = materials.with_resume_pdf(pdf, updated_at="2026-10-06")
    SqliteMaterialsRepository(conn).save(materials)
    conn.commit()


def cover_request(tmp_path):
    return dict(
        job=JOB,
        profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 1, PROFILE),
        job_id=JOB_ID,
        cover_letter_dir=tmp_path,
    )


def test_cover_product_path_persists_anchors_and_failed_refresh_preserves_acceptance(tmp_path):
    conn = connection()
    seed_resume(conn, tmp_path)
    accepted = cover_case(conn, Model()).execute(**cover_request(tmp_path))
    assert accepted.status == "ok"
    artifact_id = accepted.materials.cover_letter.artifact_id
    anchor = conn.execute(
        "SELECT line_id, determination_id FROM artifact_line_anchors WHERE artifact_id=?", (artifact_id,)
    ).fetchone()
    assert anchor["line_id"] == "body:1"
    assert SqliteDeterminationRepository(conn).find("local", anchor["determination_id"]).kind == "claim_verification"
    rejected = cover_case(conn, Model(verdict="fail", draft_text="Refreshed synthetic draft")).execute(
        **cover_request(tmp_path)
    )
    assert rejected.status == "failed_validation"
    assert rejected.materials.cover_letter.artifact_id == artifact_id
    assert len(rejected.materials.metadata["cover_letter_attempts"]) == 1
    current = SqliteMaterialsRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert current.cover_letter.artifact_id == artifact_id


@pytest.mark.parametrize(
    "fault,expected",
    [
        (json.JSONDecodeError("private", "private", 0), "malformed_json"),
        (RuntimeError("PRIVATE OUTPUT"), "provider_error"),
    ],
)
def test_cover_provider_failure_is_safe_and_preserves_artifact(tmp_path, fault, expected):
    conn = connection()
    seed_resume(conn, tmp_path)
    accepted = cover_case(conn, Model()).execute(**cover_request(tmp_path))
    with pytest.raises(DeterminationFailure) as error:
        cover_case(conn, Model(fault=fault)).execute(**cover_request(tmp_path))
    assert error.value.code == expected
    assert "PRIVATE" not in str(error.value)
    assert (
        SqliteMaterialsRepository(conn).load(LOCAL_TENANT, JOB_ID).cover_letter.artifact_id
        == accepted.materials.cover_letter.artifact_id
    )


def test_cover_budget_preflight_precedes_generation_and_uses_lane(tmp_path):
    conn, model = connection(), Model()
    seed_resume(conn, tmp_path)

    def denied():
        assert current_llm_lane() == "tailoring"
        raise RuntimeError("private budget data")

    with pytest.raises(DeterminationFailure, match="budget_denied"):
        cover_case(conn, model, denied).execute(**cover_request(tmp_path))
    assert model.calls == []



@pytest.mark.parametrize("verdict", ["pass", "fail"])
@pytest.mark.parametrize("source_value,claim_value", [("12345", "12345"), ("1,234.50", "1234.5")])
def test_sentence_final_numeric_evidence_does_not_override_a_valid_model_verdict(verdict, source_value, claim_value):
    conn = connection()
    model = _SentenceNumberModel(verdict, f"Recorded {source_value}.", f"Recorded {claim_value}; verified.")
    verifier, _ = ports(conn, model)
    result, envelope = verifier.verify(
        artifact_kind="resume", entity_id="owned-sentence-number",
        lines=[ArtifactLine(line_id="line", text=model.claim, allowed_evidence_ids=["fact"], allowed_requirement_ids=[])],
        evidence=[Source(source_id="fact", text=model.source)], requirements=[], rubric={},
    )
    assert result.verdict == envelope.result["verdict"] == verdict
    assert len(model.calls) == 1
    assert SqliteDeterminationRepository(conn).find("local", envelope.determination_id).result == result.model_dump()


def test_sentence_final_numeric_claim_cannot_hide_a_different_value_and_preserves_accepted_review():
    conn = connection()
    model = _SentenceNumberModel("pass", "Recorded 12345.", "Recorded 12345.")
    verifier, _ = ports(conn, model)
    arguments = dict(
        artifact_kind="resume", entity_id="owned-sentence-number",
        lines=[ArtifactLine(line_id="line", text=model.claim, allowed_evidence_ids=["fact"], allowed_requirement_ids=[])],
        evidence=[Source(source_id="fact", text=model.source)], requirements=[], rubric={},
    )
    _, accepted = verifier.verify(**arguments)
    model.claim = "Recorded 12346."
    arguments["lines"] = [
        ArtifactLine(line_id="line", text=model.claim, allowed_evidence_ids=["fact"], allowed_requirement_ids=[]),
    ]
    with pytest.raises(DeterminationFailure, match="mismatched_value"):
        verifier.verify(**arguments)
    assert len(model.calls) == 4  # Accepted call, then the existing three-call correction budget.
    repository = SqliteDeterminationRepository(conn)
    assert repository.find("local", accepted.determination_id) == accepted
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 1


class _SentenceNumberModel:
    def __init__(self, verdict, source, claim):
        self.verdict, self.source, self.claim, self.calls = verdict, source, claim, []

    def chat_json(self, messages, **kwargs):
        self.calls.append(messages)
        evidence = {"source_id": "fact", "quote": self.source, "exact_values": []}
        result = {
            "verdict": self.verdict, "rationale": "Synthetic model decision", "lines": [{
                "line_id": "line", "verdict": self.verdict, "source_evidence": [evidence],
                "served_requirements": [], "findings": [], "claims": [{
                    "kind": "candidate_fact", "support": "supported",
                    "text": {"source_id": "line:line", "quote": self.claim, "exact_values": []},
                    "evidence": [evidence], "rationale": "Synthetic model support decision",
                }],
            }],
        }
        return claim_verification_response(json.loads(messages[1].content), result)


def test_supported_numeric_claim_cannot_borrow_values_from_another_source():
    conn = connection()

    class NumericModel:
        def chat_json(self, messages, **kwargs):
            result = {
                "verdict": "pass",
                "rationale": "Model judgment",
                "lines": [
                    {
                        "line_id": "line",
                        "verdict": "pass",
                        "source_evidence": [],
                        "served_requirements": [],
                        "findings": [],
                        "claims": [
                            {
                                "kind": "candidate_fact",
                                "support": "supported",
                                "text": {"source_id": "line:line", "quote": "5 units", "exact_values": []},
                                "evidence": [{"source_id": "fact", "quote": "3 units", "exact_values": []}],
                                "rationale": "Model support claim",
                            }
                        ],
                    }
                ],
            }
            return claim_verification_response(json.loads(messages[1].content), result)

    verifier, _ = ports(conn, NumericModel())
    with pytest.raises(DeterminationFailure, match="mismatched_value"):
        verifier.verify(
            artifact_kind="resume",
            entity_id="owned",
            lines=[
                ArtifactLine(line_id="line", text="5 units", allowed_evidence_ids=["fact"], allowed_requirement_ids=[])
            ],
            evidence=[Source(source_id="fact", text="3 units"), Source(source_id="other", text="5 units")],
            requirements=[],
            rubric={},
        )


@pytest.mark.parametrize("kind,expected_calls", [("candidate_fact", 2), ("advice", 1)])
def test_supported_candidate_citation_must_be_in_its_declared_contributions(kind, expected_calls):
    class ContributionModel:
        calls = 0

        def chat_json(self, messages, **kwargs):
            self.calls += 1
            fact = {"source_id": "fact", "quote": "3 units", "exact_values": []}
            result = {"verdict": "pass", "rationale": "Synthetic model decision", "lines": [{
                "line_id": "line", "verdict": "pass", "served_requirements": [], "findings": [],
                "source_evidence": [fact] if self.calls > 1 else [],
                "claims": [{"kind": kind, "support": "supported", "rationale": "Synthetic reason",
                            "text": {"source_id": "line:line", "quote": "3 units", "exact_values": []},
                            "evidence": [fact]}],
            }]}
            return claim_verification_response(json.loads(messages[1].content), result)

    conn, model = connection(), ContributionModel()
    verifier, _ = ports(conn, model)
    result, _ = verifier.verify(
        artifact_kind="resume", entity_id="owned",
        lines=[ArtifactLine(line_id="line", text="3 units", allowed_evidence_ids=["fact"], allowed_requirement_ids=[])],
        evidence=[Source(source_id="fact", text="3 units")], requirements=[], rubric={},
    )
    assert result.verdict == "pass"
    assert model.calls == expected_calls


@pytest.mark.parametrize("persona", [False, True])
def test_quality_and_persona_finding_slots_repair_without_overriding_a_failed_verdict(persona):
    class FindingModel(Model):
        def chat_json(self, messages, *, response_schema, **kwargs):
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            data = claim_verification_input(json.loads(messages[1].content))
            assert data["context"]["line_ids"] == ["owned:line"]
            result["verdict"] = "fail"
            target = result["personas"][0] if persona else result
            target["verdict"] = "fail"
            target["findings"] = [{
                "line_id": "owned:line", "category": "clarity",
                "citation": {"source_id": "source:1" if len(self.calls) == 1 else "line:owned:line",
                             "quote": "Synthetic text", "exact_values": []},
                "rationale": "Synthetic model rejection", "repair_instruction": "Synthetic repair",
            }]
            return result

    conn, model = connection(), FindingModel()
    _, judge = ports(conn, model)
    kwargs = dict(entity_id="owned", lines=[ArtifactLine(
        line_id="owned:line", text="Synthetic text", allowed_evidence_ids=["source:1"], allowed_requirement_ids=[],
    )], sources=[Source(source_id="source:1", text="Synthetic text")], rubric={})
    result, _ = judge.review_adversarial(**kwargs) if persona else judge.judge(artifact_kind="resume", **kwargs)
    assert result.verdict == "fail"
    assert len(model.calls) == 2
    feedback = json.loads(model.calls[1][2][-1].content.split("\n", 1)[1])["binding_failure"]
    assert feedback["finding"]["citation"]["source_id"] == "source:1"
    assert feedback["expected_citation_source_id"] == "line:owned:line"
