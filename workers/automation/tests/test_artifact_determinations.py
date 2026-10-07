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
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane

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
        data = json.loads(messages[1].content)
        sources = {row["source_id"]: row["text"] for row in data["sources"]}
        if title == "ResumeAdversarialReview":
            from tests.determination_fakes import persona_decision

            return persona_decision(data, self.adversarial)
        if title == "ClaimVerification":
            return {
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
    create_exact_v14_schema(conn)
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


def cover_case(conn, model, preflight=lambda: None):
    verifier, quality = ports(conn, model, preflight)
    return GenerateCoverLetterUseCase(
        repository=SqliteMaterialsRepository(conn),
        llm=model,
        claim_verifier=verifier,
        quality_judge=quality,
        preflight=preflight,
        validator=ContentValidator(),
        max_retries=0,
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


def test_supported_numeric_claim_cannot_borrow_values_from_another_source():
    conn = connection()

    class NumericModel:
        def chat_json(self, messages, **kwargs):
            return {
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
