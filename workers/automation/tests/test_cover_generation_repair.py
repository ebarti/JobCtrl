"""Cover drafts repair mechanical bindings within the existing call budget."""

import json
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from tests.test_artifact_determinations import JOB_ID, Model, connection, cover_case, cover_request, seed_resume


class DraftModel(Model):
    def __init__(self, *, defect="requirement", bad_calls=1, **kwargs):
        super().__init__(**kwargs)
        self.defect, self.bad_calls, self.drafts = defect, bad_calls, 0

    def chat_json(self, messages, *, response_schema, **kwargs):
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if response_schema["title"] != "GeneratedProseDraft":
            return result
        self.drafts += 1
        if self.bad_calls is not None and self.drafts > self.bad_calls:
            return result
        row = result["lines"][0]
        if self.defect == "requirement":
            row["requirement_ids"] = ["posting:invented"]
        elif self.defect == "evidence":
            row["evidence_ids"] = ["unprovided"]
        elif self.defect == "duplicate":
            result["lines"].append(dict(row))
        elif self.defect == "schema":
            del row["reason"]
        return result


@pytest.mark.parametrize("defect", ["requirement", "evidence", "duplicate", "schema"])
@pytest.mark.parametrize("quality", ["pass", "fail"])
def test_repaired_cover_keeps_model_authority_and_exact_binding_feedback(tmp_path, defect, quality):
    conn, model = connection(), DraftModel(defect=defect, quality=quality)
    seed_resume(conn, tmp_path)
    admissions = []
    case = cover_case(conn, model, lambda: admissions.append(True))
    case._max_retries = 1
    result = case.execute(**cover_request(tmp_path))
    assert result.status == ("ok" if quality == "pass" else "failed_validation")
    assert model.drafts == 2
    assert len(admissions) == len(model.calls) == 4
    requests = [json.loads(call[2][1].content) for call in model.calls if call[0] == "GeneratedProseDraft"]
    assert requests[0]["allowed_requirement_ids"] == ["posting"]
    assert "fact" in requests[0]["allowed_evidence_ids"]
    repair = requests[1]["feedback"][0]
    assert repair["failure_code"] == {
        "requirement": "foreign_source_id", "evidence": "foreign_source_id",
        "duplicate": "duplicate_line_id", "schema": "schema_violation",
    }[defect]
    assert repair["rejected_response"]
    if defect == "requirement":
        assert repair["binding_failure"]["invalid_requirement_ids"] == ["posting:invented"]
    elif defect == "evidence":
        assert repair["binding_failure"]["invalid_evidence_ids"] == ["unprovided"]
    assert "rejected_response" not in json.dumps(result.materials.cover_letter.metadata)


def test_exhausted_cover_binding_repairs_preserve_the_accepted_artifact(tmp_path):
    conn = connection()
    seed_resume(conn, tmp_path)
    accepted = cover_case(conn, Model()).execute(**cover_request(tmp_path)).materials.cover_letter
    before = Path(accepted.path).read_bytes()
    model = DraftModel(bad_calls=None)
    case = cover_case(conn, model)
    case._max_retries = 1
    with pytest.raises(DeterminationFailure, match="foreign_source_id") as raised:
        case.execute(**cover_request(tmp_path))
    assert model.drafts == 2
    assert all(call[0] == "GeneratedProseDraft" for call in model.calls)
    assert "posting:invented" not in str(raised.value)
    current = SqliteMaterialsRepository(conn).load(LOCAL_TENANT, JOB_ID).cover_letter
    assert current.artifact_id == accepted.artifact_id
    assert Path(current.path).read_bytes() == before


def test_cover_repair_rechecks_spend_before_another_generation_call(tmp_path):
    conn, model = connection(), DraftModel()
    seed_resume(conn, tmp_path)
    admissions = []

    def preflight():
        admissions.append(True)
        if len(admissions) == 2:
            raise RuntimeError("private denied budget")

    case = cover_case(conn, model, preflight)
    case._max_retries = 3
    with pytest.raises(DeterminationFailure, match="budget_denied"):
        case.execute(**cover_request(tmp_path))
    assert len(admissions) == 2
    assert len(model.calls) == model.drafts == 1


def test_provider_error_after_a_bad_draft_leaves_the_repair_loop(tmp_path):
    class FailingModel(DraftModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            if self.drafts == 1:
                self.fault = RuntimeError("private provider failure")
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    conn, model = connection(), FailingModel()
    seed_resume(conn, tmp_path)
    case = cover_case(conn, model)
    case._max_retries = 3
    with pytest.raises(DeterminationFailure, match="provider_error"):
        case.execute(**cover_request(tmp_path))
    assert len(model.calls) == 2
