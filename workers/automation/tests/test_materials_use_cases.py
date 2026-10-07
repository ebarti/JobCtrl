"""Actual resume paths driven by explicit synthetic model decisions.

No sentence classifications or response replay queues. The fake implements each
requested schema and each test chooses the model's verdict, independently of text.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.analysis import AnalysisAgreement, EmployerAnalysis, JobAnalysis, compute_snapshot_hash
from jobctrl.domain.materials.services import ContentValidator, ResumeAssembler
from jobctrl.domain.materials.use_cases import TailorResumeUseCase, TailoringLlmPolicy
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.enrichment.interpretation import PersistedJobInterpreter
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.value_objects import ArtifactType, RenderFormat
from tests.test_artifact_determinations import JOB, JOB_ID, PROFILE, Model, connection, ports


def _assert_openai_strict_schema(schema: dict[str, Any], path: str = "$") -> None:
    unsupported = {"minLength", "maxLength"}
    assert unsupported.isdisjoint(schema), f"{path} uses unsupported string constraints"

    if "anyOf" in schema:
        for index, child in enumerate(schema["anyOf"]):
            _assert_openai_strict_schema(child, f"{path}.anyOf[{index}]")
        return

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        for child_type in schema_type:
            if child_type != "null":
                child = dict(schema)
                child["type"] = child_type
                _assert_openai_strict_schema(child, path)
        return

    if schema_type == "object":
        properties = schema.get("properties", {})
        assert schema.get("additionalProperties") is False, f"{path} must set additionalProperties to false"
        assert set(schema.get("required", [])) == set(properties), f"{path} must require every property"
        for name, child in properties.items():
            _assert_openai_strict_schema(child, f"{path}.{name}")
    elif schema_type == "array":
        _assert_openai_strict_schema(schema["items"], f"{path}[]")


def source_profile():
    profile = copy.deepcopy(PROFILE)
    profile["resume"]["executive_profile"] = {"baseline_text": "Canonical summary"}
    profile["resume"]["skill_categories"] = [{"id": "skills", "label": "Skills", "items": ["Canonical tool"]}]
    profile["resume"]["tailoring_rules"] = {
        "required_experience_entry_ids": ["entry"],
        "required_skill_category_ids": ["skills"],
        "max_experience_bullets": 4,
    }
    return profile


def draft_payload(text="Synthetic draft"):
    rows = [
        ("executive_profile", "executive_profile#0", "Canonical summary", "executive_profile:baseline"),
        ("experience.entry.bullets[0]", "experience:entry#0", text, "fact"),
        ("skills.skills", "skills:skills#0", "Canonical tool", "skills:skills"),
    ]
    return {
        "executive_profile": "Canonical summary",
        "executive_profile_sentences": ["Canonical summary"],
        "experience_updates": [{"id": "entry", "title": "Authored title", "bullets": [text]}],
        "skill_category_updates": [{"id": "skills", "items": ["Canonical tool"]}],
        "generated_claim_mappings": [
            {
                "claim_id": f"claim:{i}",
                "line_id": ident,
                "location": location,
                "text": text,
                "reason": "Explicit generator reason",
                "transform_type": "rephrase",
                "claim_label": "positioning",
                "coverage_edge_ids": [],
                "requirement_ids": [],
                "evidence_ids": [evidence],
                "non_requirement_reason": "positioning",
                "review_required": False,
            }
            for i, (location, ident, text, evidence) in enumerate(rows)
        ],
    }


class ResumeModel(Model):
    def __init__(
        self,
        *,
        verdict="pass",
        quality="pass",
        score=0.8,
        text="Synthetic draft",
        fault_at=None,
        fault=None,
        mutate=None,
        repair=False,
    ):
        super().__init__(verdict=verdict, quality=quality, draft_text=text)
        self.score, self.fault_at, self.failure, self.mutate, self.repair = score, fault_at, fault, mutate, repair
        self.generations = 0

    def chat_json(self, messages, *, response_schema, **kwargs):
        title = response_schema["title"]
        if title == self.fault_at:
            self.calls.append((title, "tailoring", messages))
            raise self.failure
        if title == "GeneratedResumeDraft":
            self.calls.append((title, "tailoring", messages))
            self.generations += 1
            payload = draft_payload(self.draft_text + (f" revision {self.generations}" if self.repair else ""))
            if self.mutate:
                self.mutate(payload)
            return payload
        if title == "JobInterpretation":
            self.calls.append((title, "enrichment", messages))
            data = json.loads(messages[1].content)
            posting = next(row for row in data["sources"] if row["source_id"] == "posting")

            def field(value):
                return {
                    "value": value,
                    "citations": [{"source_id": "posting", "quote": posting["text"], "exact_values": []}],
                    "rationale": "Explicit model classification",
                }

            return {
                "track": field("ic"),
                "seniority": field("senior"),
                "occupation_family": field("software_engineering"),
                "work_model": field("unknown"),
                "places": [],
                "constraints": [],
                "compensation": [],
                "requirements": [],
            }
        if self.repair and title == "ClaimVerification":
            self.verdict = "fail" if self.generations == 1 else "pass"
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if title == "ArtifactQuality":
            result["score"] = self.score
        return result


def resume_case(conn, model, *, preflight=lambda: None, retries=0, renderer=None, repository=None):
    verifier, quality = ports(conn, model, preflight)
    unit = SqliteUnitOfWork(conn)
    repository = repository or SqliteMaterialsRepository(conn, unit_of_work=unit)
    deps = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="synthetic",
        lane="enrichment",
        preflight=preflight,
    )
    return TailorResumeUseCase(
        repository=repository,
        llm=model,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        claim_verifier=verifier,
        quality_judge=quality,
        job_interpreter=PersistedJobInterpreter(conn, dependencies=deps),
        preflight=preflight,
        max_retries=retries,
        pdf_renderer=renderer,
        unit_of_work=unit,
        llm_policy=TailoringLlmPolicy(candidate_models=("codex:synthetic",), judge_model="codex:synthetic"),
    )


def request(tmp_path, *, retailor=False, profile=None):
    analysis = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(JOB["full_description"]),
        canonical=JobAnalysis(
            role_framing="Model framing",
            inferred_seniority="senior",
            ideal_candidate_narrative="Model narrative",
            requirements=[],
            keywords=[],
        ),
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    return dict(
        job=JOB,
        job_id=JOB_ID,
        profile_snapshot=ProfileSnapshot(LOCAL_TENANT, "default", 1, profile or source_profile()),
        tailored_dir=tmp_path,
        employer_analysis=analysis,
        retailor=retailor,
    )


@pytest.mark.parametrize("verdict,expected", [("pass", "approved"), ("fail", "failed_validation")])
def test_model_support_verdict_controls_actual_resume_path(tmp_path, verdict, expected):
    conn, model = connection(), ResumeModel(verdict=verdict)
    outcome = resume_case(conn, model).execute(**request(tmp_path))
    assert outcome.status == expected
    ids = [row[0] for row in conn.execute("SELECT kind FROM semantic_determinations")]
    assert "claim_verification" in ids
    assert ("artifact_quality" in ids) == (verdict == "pass")
    if verdict == "pass":
        assert conn.execute("SELECT COUNT(*) FROM artifact_line_anchors").fetchone()[0] == 6
        assert Path(outcome.materials.tailored_resume.path).read_text() == ResumeAssembler().assemble_resume_text(
            outcome.final_payload, request(tmp_path)["profile_snapshot"]
        )


@pytest.mark.parametrize("quality,score,approved", [("pass", 0.01, True), ("fail", 0.99, False)])
def test_independent_quality_verdict_controls_approval_without_score_threshold(tmp_path, quality, score, approved):
    conn = connection()
    outcome = resume_case(conn, ResumeModel(quality=quality, score=score)).execute(**request(tmp_path))
    assert outcome.materials.is_resume_approved is approved
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations WHERE kind='artifact_quality'").fetchone()[0] == 1


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_high_fit_resume_keeps_all_six_personas_and_their_model_verdict(tmp_path, verdict):
    conn, model = connection(), ResumeModel(score=0.01)
    model.adversarial = verdict
    kwargs = request(tmp_path)
    kwargs["job"] = {**kwargs["job"], "fit_score": 9}
    outcome = resume_case(conn, model).execute(**kwargs)
    assert outcome.materials.is_resume_approved is (verdict == "pass")
    envelope = conn.execute(
        "SELECT determination_id,envelope_json FROM semantic_determinations WHERE kind='resume_adversarial'"
    ).fetchone()
    result = json.loads(envelope["envelope_json"])["result"]
    assert len(result["personas"]) == 6
    assert result["verdict"] == verdict
    assert result["score"] == 0.1
    if verdict == "pass":
        metadata = conn.execute(
            "SELECT metadata_json FROM job_materials_artifacts WHERE artifact_type='tailored_resume'"
        ).fetchone()[0]
        metadata = json.loads(metadata)
        assert metadata["adversarial_review"]["passed"] is True
        assert len(metadata["adversarial_review"]["personas"]) == 6
        assert metadata["resume_adversarial_id"] == envelope["determination_id"]
        assert (
            conn.execute(
                "SELECT determination_id FROM semantic_entity_bindings WHERE entity_kind='artifact' AND determination_kind='resume_adversarial' LIMIT 1"
            ).fetchone()[0]
            == envelope["determination_id"]
        )


@pytest.mark.parametrize("mode", ["lenient", "normal", "strict"])
def test_every_mode_runs_both_model_checks(tmp_path, mode):
    conn, model = connection(), ResumeModel()
    resume_case(conn, model).execute(**request(tmp_path), validation_mode=mode)
    assert {title for title, _, _ in model.calls} >= {"ClaimVerification", "ArtifactQuality"}


def test_repaired_claim_uses_cited_model_reason_and_new_generation_text(tmp_path):
    conn, model = connection(), ResumeModel(repair=True)
    outcome = resume_case(conn, model, retries=1).execute(**request(tmp_path))
    assert outcome.materials.is_resume_approved
    assert model.generations == 2
    generation_prompt = next(
        messages for title, _, messages in reversed(model.calls) if title == "GeneratedResumeDraft"
    )
    assert "Model rejects support" in " ".join(row.content for row in generation_prompt)
    assert "revision 2" in Path(outcome.materials.tailored_resume.path).read_text()


@pytest.mark.parametrize("stage", ["GeneratedResumeDraft", "ClaimVerification", "ArtifactQuality", "ResumeAdversarialReview"])
def test_provider_failure_preserves_last_accepted_resume(tmp_path, stage):
    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    before = Path(accepted.materials.tailored_resume.path).read_bytes()
    model = ResumeModel(text="Changed synthetic draft", fault_at=stage, fault=RuntimeError("PRIVATE PAYLOAD"))
    kwargs = request(tmp_path, retailor=True)
    if stage == "ResumeAdversarialReview":
        kwargs["job"] = {**kwargs["job"], "fit_score": 9}
    with pytest.raises(DeterminationFailure, match="provider_error") as error:
        resume_case(conn, model).execute(**kwargs)
    assert "PRIVATE" not in str(error.value)
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.materials.tailored_resume.artifact_id
    assert Path(current.tailored_resume.path).read_bytes() == before


def test_budget_denial_precedes_paid_generation_and_preserves_acceptance(tmp_path):
    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    model = ResumeModel(text="Changed synthetic draft")

    def denied():
        raise RuntimeError("private spend metadata")

    with pytest.raises(DeterminationFailure, match="budget_denied"):
        resume_case(conn, model, preflight=denied).execute(**request(tmp_path, retailor=True))
    assert model.calls == []
    assert (
        SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID).tailored_resume.artifact_id
        == accepted.materials.tailored_resume.artifact_id
    )


def test_structural_schema_failure_does_not_repair_with_lexical_fallback(tmp_path):
    conn = connection()
    model = ResumeModel(mutate=lambda payload: payload.update(extra="private output"))
    with pytest.raises(DeterminationFailure, match="schema_violation"):
        resume_case(conn, model, retries=2).execute(**request(tmp_path))
    assert model.generations == 1
    assert conn.execute("SELECT COUNT(*) FROM artifact_line_anchors").fetchone()[0] == 0


def test_foreign_generation_evidence_cannot_be_promoted(tmp_path):
    conn = connection()
    model = ResumeModel(mutate=lambda payload: payload["generated_claim_mappings"][1].update(evidence_ids=["foreign"]))
    outcome = resume_case(conn, model).execute(**request(tmp_path))
    assert not outcome.materials.is_resume_approved
    assert "ClaimVerification" not in [title for title, _, _ in model.calls]


def test_failed_refresh_keeps_current_generation_and_its_anchors(tmp_path):
    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    failed = resume_case(conn, ResumeModel(verdict="fail", text="Changed synthetic draft")).execute(
        **request(tmp_path, retailor=True)
    )
    assert failed.status == "failed_validation"
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.materials.tailored_resume.artifact_id
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM artifact_line_anchors WHERE artifact_id=?", (current.tailored_resume.artifact_id,)
        ).fetchone()[0]
        == 6
    )


class Renderer:
    def __init__(self, fail=False):
        self.fail = fail

    def render_resume_to_pdf(self, **kwargs):
        if self.fail:
            raise RuntimeError("Synthetic renderer failure")
        output = Path(kwargs["output_path"])
        output.write_bytes(b"owned synthetic PDF")
        return Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=str(output),
            render_format=RenderFormat.HTML_PDF,
            created_at=kwargs["created_at"],
        )


def test_pdf_failure_rolls_back_new_generation_and_preserves_accepted_pdf(tmp_path):
    conn = connection()
    accepted = resume_case(conn, ResumeModel(), renderer=Renderer()).execute(**request(tmp_path))
    failed = resume_case(conn, ResumeModel(text="Changed synthetic draft"), renderer=Renderer(fail=True)).execute(
        **request(tmp_path, retailor=True)
    )
    assert not failed.materials.is_resume_approved or failed.error is not None
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.materials.tailored_resume.artifact_id
    assert current.resume_pdf.artifact_id == accepted.materials.resume_pdf.artifact_id


def test_identical_canonical_inputs_reuse_persisted_interpretation_and_verifications(tmp_path):
    conn, model = connection(), ResumeModel()
    resume_case(conn, model).execute(**request(tmp_path))
    calls = len(model.calls)
    resume_case(conn, model).execute(**request(tmp_path, retailor=True))
    assert len(model.calls) == calls + 1  # only the requested new generation call
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 3


def test_tailoring_policy_has_no_numeric_judge_threshold():
    policy = TailoringLlmPolicy(candidate_models=("codex:synthetic",), judge_model="codex:quality")
    assert policy.effective_judge_model == "codex:quality"
