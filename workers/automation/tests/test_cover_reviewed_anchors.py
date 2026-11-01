"""Final cover provenance uses the verifier's decision, not draft proposals."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from tests.determination_fakes import claim_verification_response
from tests.test_artifact_determinations import (
    JOB_ID, PROFILE, Model, connection, cover_case, cover_request, seed_resume,
)


class SelectedSourcesModel(Model):
    def __init__(self, *, proposed=("fact", "other"), endorsed=("fact",), **kwargs):
        super().__init__(**kwargs)
        self.proposed, self.endorsed = proposed, endorsed

    def chat_json(self, messages, *, response_schema, **kwargs):
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if response_schema["title"] == "GeneratedProseDraft":
            result["lines"][0]["evidence_ids"] = list(self.proposed)
        elif response_schema["title"] == "ClaimVerification":
            data = json.loads(messages[1].content)
            refs = data["context"]["citation_refs"]
            for row in result["lines"]:
                row["source_evidence"] = [
                    citation for citation in row["source_evidence"] if refs.get(citation["source_id"], {}).get("source_id", citation["source_id"]) in self.endorsed
                ]
                row["served_requirements"] = [{
                    "requirement_id": "posting",
                    "citation": {"source_id": "posting", "quote": "Canonical posting", "exact_values": []},
                    "rationale": "Independent model requirement binding",
                }]
        return claim_verification_response(json.loads(messages[1].content), result) if response_schema["title"] == "ClaimVerification" else result


def request(tmp_path):
    profile = deepcopy(PROFILE)
    profile["resume"]["experience_entries"][0]["achievement_evidence"].append({
        "id": "other", "source_text": "Another canonical source", "user_confirmed": True,
        "evidence_strength": "supported",
    })
    return {**cover_request(tmp_path), "profile_snapshot": ProfileSnapshot(LOCAL_TENANT, "default", 1, profile)}


@pytest.mark.parametrize("proposed,endorsed", [
    (("fact", "other"), ("fact",)),
    (("fact",), ()),
    ((), ("fact",)),
])
def test_cover_publishes_only_reviewed_source_and_requirement_bindings(tmp_path, proposed, endorsed):
    conn, model = connection(), SelectedSourcesModel(proposed=proposed, endorsed=endorsed)
    seed_resume(conn, tmp_path)
    admissions = []
    outcome = cover_case(conn, model, lambda: admissions.append(True), retries=3).execute(**request(tmp_path))
    assert outcome.status == "ok"
    assert len(model.calls) == len(admissions) == 3  # One draft and both independent reviews.
    artifact = outcome.materials.cover_letter
    audit = artifact.metadata["claim_verification"]
    assert audit["proposed_anchors"][0]["evidence_ids"] == list(proposed)
    assert audit["anchors"][0]["evidence_ids"] == list(endorsed)
    assert audit["anchors"][0]["requirement_ids"] == ["posting"]
    row = conn.execute("SELECT * FROM artifact_line_anchors WHERE artifact_id=?", (artifact.artifact_id,)).fetchone()
    assert json.loads(row["evidence_ids_json"]) == list(endorsed)
    assert json.loads(row["requirement_ids_json"]) == ["posting"]
    assert row["determination_id"] == artifact.metadata["claim_verification_id"]
    assert not list(tmp_path.glob("*CL_rejected*"))


@pytest.mark.parametrize("verdict,quality", [("fail", "pass"), ("pass", "fail")])
@pytest.mark.parametrize("accepted_before", [False, True])
def test_rejected_cover_source_subset_is_auditable_and_preserves_accepted_artifact(
    tmp_path, verdict, quality, accepted_before,
):
    conn = connection()
    seed_resume(conn, tmp_path)
    accepted = cover_case(conn, Model()).execute(**cover_request(tmp_path)).materials.cover_letter if accepted_before else None
    before = Path(accepted.path).read_bytes() if accepted else None
    model = SelectedSourcesModel(verdict=verdict, quality=quality, draft_text="Owned rejected revision")
    outcome = cover_case(conn, model).execute(**request(tmp_path))
    assert outcome.status == "failed_validation"
    assert len(model.calls) == 3
    current = SqliteMaterialsRepository(conn).load(LOCAL_TENANT, JOB_ID)
    attempts = current.metadata["cover_letter_attempts"]
    assert len(attempts) == 1
    rejected = attempts[0]["artifact"]
    assert rejected["status"] == "rejected"
    assert Path(rejected["path"]).read_text() == "Owned rejected revision"
    audit = rejected["metadata"]["claim_verification"]
    assert audit["anchors"][0]["evidence_ids"] == ["fact"]
    assert audit["proposed_anchors"][0]["evidence_ids"] == ["fact", "other"]
    if accepted:
        assert current.cover_letter.artifact_id == accepted.artifact_id
        assert Path(current.cover_letter.path).read_bytes() == before
    else:
        assert current.cover_letter.status.value == "rejected"
        row = conn.execute("SELECT evidence_ids_json FROM artifact_line_anchors WHERE artifact_id=?", (rejected["artifact_id"],)).fetchone()
        assert json.loads(row[0]) == ["fact"]


def test_foreign_proposed_source_still_fails_closed_before_review_or_publication(tmp_path):
    conn, model = connection(), SelectedSourcesModel(proposed=("unprovided",))
    seed_resume(conn, tmp_path)
    with pytest.raises(DeterminationFailure, match="foreign_source_id"):
        cover_case(conn, model).execute(**request(tmp_path))
    assert [call[0] for call in model.calls] == ["GeneratedProseDraft"]
    assert conn.execute("SELECT COUNT(*) FROM artifact_line_anchors").fetchone()[0] == 0
    assert not list(tmp_path.glob("*CL*"))
