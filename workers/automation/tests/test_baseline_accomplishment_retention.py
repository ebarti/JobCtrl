"""Baseline retention is separate from user pins and generated requirement coverage."""
from copy import deepcopy
import json
from pathlib import Path

import pytest

from jobctrl.domain.materials.quality import build_tailoring_plan, require_artifact_budget_feasible
from jobctrl.domain.materials.resume_document import build_resume_document
from jobctrl.domain.materials.services import ContentValidator, ResumeAssembler
from jobctrl.domain.materials.use_cases import (
    _claim_mapping_validation_errors, build_master_tailor_prompt,
)
from tests.determination_fakes import job_interpretation
from tests.test_materials_use_cases import (
    connection, draft_payload, request, resume_case, ResumeModel, source_profile,
)


def fixture():
    profile = source_profile()
    role = profile["resume"]["experience_entries"][0]
    role["bullets"] = ["Canonical source", "Introduced an incident rotation across three teams."]
    profile["resume"]["tailoring_rules"]["max_experience_bullets"] = 2
    kwargs = request(Path("/unused"), profile=profile)
    plan = build_tailoring_plan(profile, kwargs["job"], employer_analysis=kwargs["employer_analysis"],
                               job_interpretation=job_interpretation())
    return profile, kwargs["profile_snapshot"], plan


def retained_payload():
    payload = draft_payload("Canonical source")
    payload["experience_omissions"] = []
    first = payload["generated_claim_mappings"][1]
    first.update(evidence_ids=["fact", "experience:entry:source:0"],
                 non_requirement_reason="baseline_retained", claim_label="verified")
    payload["experience_updates"][0]["bullets"].append("Introduced an incident rotation across three teams.")
    second = deepcopy(first)
    second.update(claim_id="claim:retained-1", line_id="experience:entry#1",
                  location="experience.entry.bullets[1]", evidence_ids=["experience:entry:source:1"],
                  text=payload["experience_updates"][0]["bullets"][1])
    payload["generated_claim_mappings"].append(second)
    return payload


def errors(payload, plan):
    return _claim_mapping_validation_errors(payload=payload, tailoring_plan=plan)


def test_first_prompt_retains_baseline_without_turning_it_into_explicit_pins():
    _, snapshot, plan = fixture()
    prompt = build_master_tailor_prompt(snapshot, tailoring_plan=plan)
    value = plan.to_prompt_dict()
    assert value["baseline_evidence_ids_by_role"] == {
        "entry": ["experience:entry:source:0", "experience:entry:source:1"]}
    assert not plan.required_evidence_ids
    assert "smallest sufficient set" not in prompt
    assert "Keep as many applicable baseline accomplishments as possible" in prompt
    assert plan.to_metadata()["baseline_evidence_ids_by_role"] == value["baseline_evidence_ids_by_role"]


def test_missing_baseline_binding_is_rejected_before_paid_review():
    _, _, plan = fixture()
    payload = draft_payload("Canonical source")
    payload["generated_claim_mappings"][1]["evidence_ids"] = ["experience:entry:source:0"]
    found = errors(payload, plan)
    assert any("Missing baseline selection decision" in error and "source:1" in error for error in found)


def test_retained_baseline_within_cap_reaches_fields_text_pdf_and_preflight():
    profile, snapshot, plan = fixture()
    payload = retained_payload()
    assert ContentValidator().validate_json_fields(payload, profile).passed
    require_artifact_budget_feasible(profile, plan)
    assert not errors(payload, plan)
    assert "Introduced an incident rotation" in ResumeAssembler().assemble_resume_text(payload, snapshot)
    document = build_resume_document(payload, profile)
    assert [row["text"] for row in document["experience"][0]["bullets"]] == payload["experience_updates"][0]["bullets"]


@pytest.mark.parametrize("failed_review", [None, "factual", "quality"])
def test_real_materials_path_keeps_retained_baseline_and_independent_gates(tmp_path, failed_review):
    profile, _, _ = fixture()

    def mutate(payload):
        payload.clear()
        payload.update(retained_payload())

    conn = connection()
    model = ResumeModel(mutate=mutate, verdict="fail" if failed_review == "factual" else "pass",
                        quality="fail" if failed_review == "quality" else "pass")
    outcome = resume_case(conn, model).execute(**request(tmp_path, profile=profile))
    assert outcome.status == {None: "approved", "factual": "failed_validation", "quality": "failed_judge"}[failed_review]
    assert model.generations == 1
    factual = next(messages for title, _, messages in model.calls if title == "ClaimVerification")
    rubric = json.loads(factual[1].content)["context"]["rubric"]
    assert "baseline_retention" in rubric
    if failed_review is None:
        assert "Introduced an incident rotation" in Path(outcome.materials.tailored_resume.path).read_text()
    conn.close()


@pytest.mark.parametrize("fault", ["duplicate", "foreign_role", "false_retention", "false_pin", "over_limit"])
def test_retention_does_not_grant_foreign_sources_pins_duplicates_or_extra_budget(fault):
    profile, _, plan = fixture()
    payload = retained_payload()
    first = payload["generated_claim_mappings"][1]
    if fault == "duplicate":
        payload["generated_claim_mappings"][-1]["evidence_ids"].append("experience:entry:source:0")
    elif fault == "foreign_role":
        from dataclasses import replace
        other = replace(plan.evidence_items[0], evidence_id="foreign-role-evidence", experience_entry_id="other")
        plan = replace(plan, evidence_items=(*plan.evidence_items, other))
        first["evidence_ids"] = ["foreign-role-evidence", "experience:entry:source:0"]
    elif fault == "false_retention":
        first["evidence_ids"] = ["fact"]
    elif fault == "false_pin":
        first["non_requirement_reason"] = "pinned"
    else:
        payload["experience_updates"][0]["bullets"].append("An unbudgeted extra accomplishment.")
        assert not ContentValidator().validate_json_fields(payload, profile).passed
        return
    assert errors(payload, plan)


def test_a_summary_binding_does_not_substitute_for_the_missing_experience_accomplishment():
    _, _, plan = fixture()
    payload = retained_payload()
    payload["generated_claim_mappings"].pop()
    payload["experience_updates"][0]["bullets"].pop()
    payload["generated_claim_mappings"][0]["evidence_ids"].append("experience:entry:source:1")
    assert any("Missing baseline selection decision" in error for error in errors(payload, plan))


def test_an_omitted_optional_role_does_not_force_its_baseline_into_another_role():
    profile, _, _ = fixture()
    profile["resume"]["experience_entries"].append({"id": "optional", "title": "Other role",
        "company": "Other employer", "bullets": ["A different authored accomplishment."]})
    args = request(Path("/unused"), profile=profile)
    plan = build_tailoring_plan(profile, args["job"], employer_analysis=args["employer_analysis"],
                               job_interpretation=job_interpretation())
    assert plan.baseline_evidence_ids_by_role["optional"]
    assert not errors(retained_payload(), plan)


def test_disabling_rewriting_preserves_authored_text_within_the_saved_limit():
    profile, snapshot, _ = fixture()
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {"allow_achievement_rewriting": False}
    from jobctrl.domain.profile.snapshot import ProfileSnapshot
    snapshot = ProfileSnapshot(snapshot.tenant_id, snapshot.profile_id, snapshot.version, profile)
    payload = retained_payload()
    payload["experience_updates"][0]["bullets"] = ["Unaccepted rewrite"]
    document = build_resume_document(payload, profile)
    assert [row["text"] for row in document["experience"][0]["bullets"]] == profile["resume"]["experience_entries"][0]["bullets"]
    assert "Unaccepted rewrite" not in ResumeAssembler().assemble_resume_text(payload, snapshot)


@pytest.mark.parametrize("failed_review", ["factual", "quality"])
def test_failed_retention_refresh_preserves_accepted_artifact_and_bytes(tmp_path, failed_review):
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from jobctrl.domain.tenant import LOCAL_TENANT
    from tests.test_materials_use_cases import JOB_ID
    profile, _, _ = fixture()
    def mutate(payload):
        payload.clear()
        payload.update(retained_payload())
    conn = connection()
    accepted = resume_case(conn, ResumeModel(mutate=mutate)).execute(**request(tmp_path, profile=profile))
    before = Path(accepted.materials.tailored_resume.path).read_bytes()
    def changed_candidate(payload):
        mutate(payload)
        changed = "Canonical source presented with updated emphasis."
        payload["experience_updates"][0]["bullets"][0] = changed
        payload["generated_claim_mappings"][1]["text"] = changed
    rejected = resume_case(conn, ResumeModel(mutate=changed_candidate,
        verdict="fail" if failed_review == "factual" else "pass",
        quality="fail" if failed_review == "quality" else "pass"),
    ).execute(**request(tmp_path, profile=profile, retailor=True))
    assert rejected.status == ("failed_validation" if failed_review == "factual" else "failed_judge")
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.materials.tailored_resume.artifact_id
    assert Path(current.tailored_resume.path).read_bytes() == before
    conn.close()


def omit_second(payload, reason="role_bullet_limit"):
    payload["experience_updates"][0]["bullets"].pop()
    payload["generated_claim_mappings"].pop()
    payload["experience_omissions"] = [{"experience_entry_id": "entry", "evidence_id": "experience:entry:source:1",
        "reason": reason, "rationale": "Explicit synthetic selection proposal for independent review."}]


def test_configured_cap_stays_hard_even_when_more_baseline_bullets_exist():
    profile, _, _ = fixture()
    profile["resume"]["tailoring_rules"]["max_experience_bullets"] = 1
    args = request(Path("/unused"), profile=profile)
    plan = build_tailoring_plan(profile, args["job"], employer_analysis=args["employer_analysis"],
                               job_interpretation=job_interpretation())
    payload = retained_payload()
    assert not ContentValidator().validate_json_fields(payload, profile).passed
    omit_second(payload)
    assert ContentValidator().validate_json_fields(payload, profile).passed
    assert not errors(payload, plan)
    from jobctrl.resume_profile import mark_current_artifact_budget
    payload = mark_current_artifact_budget(payload)
    document = build_resume_document(payload, profile)
    assert [row["text"] for row in document["experience"][0]["bullets"]] == ["Canonical source"]
    assert "Introduced an incident rotation" not in ResumeAssembler().assemble_resume_text(payload, profile)


def test_a_role_below_the_limit_cannot_claim_that_the_limit_forced_omission():
    _, _, plan = fixture()
    payload = retained_payload()
    omit_second(payload)
    assert any("requires a full role" in error for error in errors(payload, plan))


@pytest.mark.parametrize("fault", ["foreign", "wrong_role", "duplicate", "retained", "pin"])
def test_omission_proposals_cannot_bypass_source_identity_or_explicit_pins(fault):
    profile, _, plan = fixture()
    payload = retained_payload()
    omit_second(payload, "clearly_inapplicable")
    proposal = payload["experience_omissions"][0]
    if fault == "foreign":
        proposal["evidence_id"] = "foreign"
    elif fault == "wrong_role":
        proposal["experience_entry_id"] = "another-role"
    elif fault == "duplicate":
        payload["experience_omissions"].append(deepcopy(proposal))
    elif fault == "retained":
        proposal["evidence_id"] = "experience:entry:source:0"
    else:
        from dataclasses import replace
        plan = replace(plan, required_evidence_ids=("experience:entry:source:1",))
    assert errors(payload, plan)


@pytest.mark.parametrize("quality", ["pass", "fail"])
def test_model_quality_owns_whether_a_source_bound_inapplicability_proposal_is_justified(tmp_path, quality):
    profile, _, _ = fixture()
    def mutate(payload):
        payload.clear()
        payload.update(retained_payload())
        omit_second(payload, "clearly_inapplicable")
    model, conn = ResumeModel(mutate=mutate, quality=quality), connection()
    result = resume_case(conn, model).execute(**request(tmp_path, profile=profile))
    assert result.status == ("approved" if quality == "pass" else "failed_judge")
    messages = next(messages for title, _, messages in model.calls if title == "ArtifactQuality")
    rubric = json.loads(messages[1].content)["context"]["rubric"]
    assert json.loads(rubric["experience_omissions"])[0]["evidence_id"] == "experience:entry:source:1"
    assert "Reject an underfilled role" in rubric["baseline_retention"]
    assert model.generations == 1
    conn.close()


def test_reviewed_complete_inapplicability_can_keep_role_metadata_without_inventing_bullets(tmp_path):
    profile, _, _ = fixture()
    def mutate(payload):
        payload.clear()
        payload.update(retained_payload())
        payload["experience_updates"][0]["bullets"] = []
        payload["generated_claim_mappings"] = [row for row in payload["generated_claim_mappings"]
                                                if not row["location"].startswith("experience.")]
        payload["experience_omissions"] = [{"experience_entry_id": "entry", "evidence_id": f"experience:entry:source:{index}",
            "reason": "clearly_inapplicable", "rationale": "Explicit synthetic proposal for model review."}
            for index in range(2)]
    conn = connection()
    result = resume_case(conn, ResumeModel(mutate=mutate)).execute(**request(tmp_path, profile=profile))
    assert result.status == "approved"
    text = Path(result.materials.tailored_resume.path).read_text()
    assert "Authored employer" in text
    assert "Introduced an incident rotation" not in text
    conn.close()


@pytest.mark.parametrize("recorded_selection", [False, True])
def test_disabled_rewriting_keeps_legacy_export_behavior_and_new_literal_selection(recorded_selection):
    profile, _, _ = fixture()
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {"allow_achievement_rewriting": False}
    payload = retained_payload()
    omit_second(payload, "clearly_inapplicable")
    if not recorded_selection:
        payload.pop("experience_omissions")
    document = build_resume_document(payload, profile)
    expected = profile["resume"]["experience_entries"][0]["bullets"][:1 if recorded_selection else 2]
    assert [row["text"] for row in document["experience"][0]["bullets"]] == expected
