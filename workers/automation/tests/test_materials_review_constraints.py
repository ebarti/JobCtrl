"""Shared authority reaches each independent Materials actor before drafting."""

import json
from pathlib import Path

import pytest

from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from tests.test_materials_use_cases import (
    JOB_ID,
    ResumeModel,
    canonical_scored_target,
    connection,
    request,
    resume_case,
)


def review_contract(model):
    first = {}
    for title, _, messages in model.calls:
        first.setdefault(title, messages)
    factual = json.loads(first["ClaimVerification"][1].content)["context"]["rubric"]
    quality = json.loads(first["ArtifactQuality"][1].content)["context"]["rubric"]
    constraints = json.loads(factual["generation_constraints"])
    assert constraints == json.loads(quality["generation_permissions"])["shared_constraints"]
    assert set(constraints) == {"summary_quantity_authority", "rendered_experience_context"}
    generator = first["GeneratedResumeDraft"][0].content
    assert all(rule in generator for rule in constraints.values())
    assert "all actionable" in quality["review_scope"]
    assert "generation permissions" in quality["review_scope"]
    return first, quality


@pytest.mark.parametrize("high_fit", [False, True])
def test_first_draft_and_independent_reviews_receive_same_constraints(tmp_path, high_fit):
    conn, model = connection(), ResumeModel()
    kwargs = request(tmp_path)
    if high_fit:
        kwargs["job"] = canonical_scored_target(conn, 8)
    outcome = resume_case(conn, model).execute(**kwargs)
    assert outcome.materials.is_resume_approved
    first, quality = review_contract(model)
    assert model.generations == 1
    if high_fit:
        persona = json.loads(first["ResumeAdversarialReview"][1].content)["context"]["rubric"]
        assert persona == quality
    else:
        assert "ResumeAdversarialReview" not in first


@pytest.mark.parametrize("stage", ["factual", "quality"])
def test_shared_constraints_do_not_override_failed_model_or_replace_acceptance(tmp_path, stage):
    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    accepted_bytes = Path(accepted.materials.tailored_resume.path).read_bytes()
    model = ResumeModel(
        verdict="fail" if stage == "factual" else "pass",
        quality="fail" if stage == "quality" else "pass",
        text="Changed owned synthetic draft",
    )
    result = resume_case(conn, model).execute(**request(tmp_path, retailor=True))
    assert result.status == ("failed_validation" if stage == "factual" else "failed_judge")
    # Sequential custom ports may stop before quality on a factual rejection.
    if stage == "quality":
        review_contract(model)
    else:
        messages = next(messages for title, _, messages in model.calls if title == "ClaimVerification")
        factual = json.loads(messages[1].content)["context"]["rubric"]
        assert json.loads(factual["generation_constraints"])["summary_quantity_authority"]
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.materials.tailored_resume.artifact_id
    assert Path(current.tailored_resume.path).read_bytes() == accepted_bytes


@pytest.mark.parametrize("failed_review", [None, "factual", "quality"])
def test_baseline_only_required_role_reaches_reviews_without_contradictory_permission(tmp_path, failed_review):
    from tests.test_materials_use_cases import source_profile

    profile = source_profile()
    profile["resume"]["experience_entries"][0]["achievement_evidence"] = []
    evidence_id = "experience:entry:source:0"

    def bind_baseline(payload):
        for mapping in payload["generated_claim_mappings"]:
            if "fact" in mapping["evidence_ids"]:
                mapping["evidence_ids"] = [evidence_id]

    conn = connection()
    model = ResumeModel(verdict="fail" if failed_review == "factual" else "pass",
                        quality="fail" if failed_review == "quality" else "pass", mutate=bind_baseline)
    result = resume_case(conn, model).execute(**request(tmp_path, profile=profile))
    assert model.generations == 1
    expected = {None: "approved", "factual": "failed_validation", "quality": "failed_judge"}
    assert result.status == expected[failed_review]
    generator = next(messages[0].content for title, _, messages in model.calls if title == "GeneratedResumeDraft")
    empty_roles = json.loads(generator.split("REQUIRED EXPERIENCE IDS ALLOWING EMPTY BULLETS:\n")[1].split("\n\n", 1)[0])
    evidence_by_role = json.loads(generator.split("EXPERIENCE BULLET EVIDENCE IDS BY ROLE:\n")[1].split("\n\n", 1)[0])
    assert "entry" not in empty_roles
    assert evidence_by_role["entry"] == [evidence_id]
    factual = next(messages for title, _, messages in model.calls if title == "ClaimVerification")
    source_ids = {source["source_id"] for source in json.loads(factual[1].content)["sources"]}
    assert evidence_id in source_ids and "fact" not in source_ids
    if failed_review != "factual":
        review_contract(model)
    conn.close()
