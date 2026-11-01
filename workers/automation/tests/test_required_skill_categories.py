"""Required categories are inclusion pins; models may select other authored categories."""
from copy import deepcopy
from pathlib import Path
import json

import pytest

from jobctrl.domain.materials.resume_document import build_resume_document
from jobctrl.domain.materials.services import ContentValidator, ResumeAssembler
from jobctrl.domain.materials.use_cases import build_master_tailor_prompt
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.resume_profile import get_required_skill_category_ids
from tests.test_materials_use_cases import connection, draft_payload, request, resume_case, ResumeModel, source_profile


def profile_and_payload():
    profile = source_profile()
    profile["resume"]["skill_categories"].extend([
        {"id": "platform", "label": "Platform", "items": ["Kubernetes", "Docker"]},
        {"id": "languages", "label": "Languages", "items": ["Python"]},
    ])
    payload = draft_payload()
    add_platform(payload)
    return profile, payload


def add_platform(payload):
    payload["skill_category_updates"].append({"id": "platform", "items": ["Kubernetes"]})
    payload["generated_claim_mappings"].append({
        "claim_id": "claim:platform", "line_id": "skills:platform#0", "location": "skills.platform",
        "text": "Kubernetes", "reason": "Explicit model selection from authored category",
        "transform_type": "rephrase", "claim_label": "positioning", "coverage_edge_ids": [],
        "requirement_ids": [], "evidence_ids": ["skills:platform"],
        "non_requirement_reason": "positioning", "review_required": False,
    })


def snapshot(profile):
    return ProfileSnapshot(LOCAL_TENANT, "default", 1, profile)


def test_generator_sees_all_authored_categories_while_pins_remain_the_minimum():
    profile, _ = profile_and_payload()
    prompt = build_master_tailor_prompt(snapshot(profile))
    categories = json.loads(prompt.split("MASTER SKILL CATEGORIES:\n")[1].split("\n\n", 1)[0])
    required = json.loads(prompt.split("REQUIRED SKILL CATEGORY IDS:\n")[1].split("\n\n", 1)[0])
    assert [row["id"] for row in categories] == ["skills", "platform", "languages"]
    assert required == ["skills"]


def test_known_optional_category_survives_field_validation_text_and_pdf_document():
    profile, payload = profile_and_payload()
    assert ContentValidator().validate_json_fields(payload, profile).passed
    text = ResumeAssembler().assemble_resume_text(payload, snapshot(profile))
    document = build_resume_document(payload, profile)
    assert [row["id"] for row in document["skills"]] == ["skills", "platform"]
    assert document["skills"][1]["items"] == ["Kubernetes"]
    assert "Platform: Kubernetes" in text
    assert "Languages:" not in text and "Python" not in text
    assert payload["skill_category_updates"] == [
        {"id": "skills", "items": ["Canonical tool"]}, {"id": "platform", "items": ["Kubernetes"]},
    ]


@pytest.mark.parametrize("fault", ["missing_required", "foreign", "duplicate"])
def test_optional_selection_does_not_relax_required_or_source_identity_checks(fault):
    profile, payload = profile_and_payload()
    if fault == "missing_required":
        payload["skill_category_updates"] = payload["skill_category_updates"][1:]
    elif fault == "foreign":
        payload["skill_category_updates"][1]["id"] = "foreign-category"
    else:
        payload["skill_category_updates"].append(deepcopy(payload["skill_category_updates"][1]))
    result = ContentValidator().validate_json_fields(payload, profile)
    assert not result.passed


def test_individual_skill_pin_requires_its_category_and_remains_in_rendered_items():
    profile, payload = profile_and_payload()
    profile["resume"]["tailoring_rules"]["required_skills_by_category_id"] = {"platform": ["Docker"]}
    assert get_required_skill_category_ids(profile) == ["skills", "platform"]
    document = build_resume_document(payload, profile)
    assert document["skills"][1]["items"] == ["Kubernetes", "Docker"]
    payload["skill_category_updates"] = payload["skill_category_updates"][:1]
    assert not ContentValidator().validate_json_fields(payload, profile).passed


@pytest.mark.parametrize("failed_review", [None, "factual", "quality"])
def test_selected_optional_skill_reaches_actual_materials_gates(tmp_path, failed_review):
    profile, _ = profile_and_payload()
    model = ResumeModel(mutate=add_platform,
                        verdict="fail" if failed_review == "factual" else "pass",
                        quality="fail" if failed_review == "quality" else "pass")
    conn = connection()
    outcome = resume_case(conn, model).execute(**request(tmp_path, profile=profile))
    expected = {None: "approved", "factual": "failed_validation", "quality": "failed_judge"}
    assert outcome.status == expected[failed_review]
    assert model.generations == 1
    titles = {title for title, _, _ in model.calls}
    assert "ClaimVerification" in titles
    if failed_review != "factual":
        assert "ArtifactQuality" in titles
    if failed_review is None:
        text = Path(outcome.materials.tailored_resume.path).read_text()
        assert "Platform: Kubernetes" in text
    conn.close()


def test_disabling_skill_reordering_keeps_authored_items_in_a_selected_optional_category():
    profile, payload = profile_and_payload()
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {"allow_skill_reordering": False}
    payload["skill_category_updates"][1]["items"] = ["Untrusted requested replacement"]
    document = build_resume_document(payload, profile)
    assert [row["id"] for row in document["skills"]] == ["skills", "platform"]
    assert document["skills"][1]["items"] == ["Kubernetes", "Docker"]
    text = ResumeAssembler().assemble_resume_text(payload, snapshot(profile))
    assert "Platform: Kubernetes, Docker" in text
    assert "Untrusted requested replacement" not in text


def test_default_all_categories_and_missing_update_metadata_remain_preserved():
    profile, payload = profile_and_payload()
    profile["resume"]["tailoring_rules"]["required_skill_category_ids"] = []
    assert get_required_skill_category_ids(profile) == ["skills", "platform", "languages"]
    document = build_resume_document(payload, profile)
    assert [row["id"] for row in document["skills"]] == ["skills", "platform", "languages"]
    assert document["skills"][2]["items"] == ["Python"]
    assert not ContentValidator().validate_json_fields(payload, profile).passed
