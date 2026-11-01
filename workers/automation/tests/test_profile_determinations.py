"""Profile authority and draft boundaries through the owned SQLite path."""

import json
import sqlite3
import pytest
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.profile.interpretation import ModelCandidateInterpreter
from jobctrl.domain.profile.resume_extraction import ModelResumeExtractor
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.profile.interpretation import PersistedCandidateInterpreter
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.profile_import import profile_from_extraction
from jobctrl.llm_lanes import current_llm_lane

PROFILE = {
    "resume": {
        "experience_entries": [
            {
                "id": "entry",
                "title": "Role 3",
                "company": "Owned employer",
                "date_range": "2024",
                "location": "Owned place",
                "bullets": ["Authored source 3"],
            }
        ],
        "education_entries": [],
        "skill_categories": [],
    }
}


class Publisher:
    def publish(self, event):
        pass


class Model:
    def __init__(self, level="junior", fault=None):
        self.level, self.fault, self.calls = level, fault, []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "profile"
        self.calls.append(messages)
        if self.fault:
            raise self.fault
        cite = {"source_id": "experience:entry:title", "quote": "Role 3"}

        def field(value):
            return {"value": value, "citations": [cite], "rationale": "Model determination"}

        return {
            "track": field("ic"),
            "seniority": field(self.level),
            "functions": [],
            "target_roles": [
                {
                    "title": "Proposed role",
                    "classification": "adjacent",
                    "track": "ic",
                    "seniority": self.level,
                    "citations": [cite],
                    "rationale": "Model suggestion",
                }
            ],
            "target_preferences": [],
            "experience_places": [],
        }


def setup(model):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    deps = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="fake",
        lane="profile",
        preflight=lambda: None,
    )
    interpreter = PersistedCandidateInterpreter(conn, dependencies=deps)
    return conn, deps, interpreter


def test_same_authored_profile_different_model_levels_control_pending_suggestions():
    for level in ("junior", "principal"):
        conn, deps, interpreter = setup(Model(level))
        repo = SqliteProfileRepository(conn, publisher=Publisher(), candidate_interpreter=interpreter)
        snapshot = repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, PROFILE))
        result = interpreter.suggest(snapshot)
        assert result["suggestions"][0]["seniority"] == level
        assert result["status"] == "pending_confirmation"
        assert (
            conn.execute("SELECT status FROM candidate_interpretation_suggestions").fetchone()[0]
            == "pending_confirmation"
        )
        assert conn.execute("SELECT count(*) FROM candidate_profile_achievement_evidence").fetchone()[0] == 0
        assert snapshot.as_dict()["experience"]["target_seniority_floor"] == ""
        assert len(deps["llm"].calls) == 1
        source_payload = json.loads(deps["llm"].calls[0][1].content)
        assert any(row["source_id"] == "experience:entry:location" for row in source_payload["sources"])


@pytest.mark.parametrize("fault,code", [(RuntimeError("private text"), "provider_error")])
def test_failed_profile_interpretation_saves_authored_facts_with_visible_failure(fault, code):
    conn, deps, interpreter = setup(Model(fault=fault))
    repo = SqliteProfileRepository(conn, publisher=Publisher(), candidate_interpreter=interpreter)
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, PROFILE))
    assert repo.load_snapshot(LOCAL_TENANT).version == 1
    assert conn.execute("SELECT failure_code FROM semantic_stage_states").fetchone()[0] == code
    assert conn.execute("SELECT count(*) FROM candidate_interpretation_suggestions").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM candidate_profile_achievement_evidence").fetchone()[0] == 0


def test_model_unavailable_never_creates_profile_suggestions():
    conn, deps, _ = setup(None)
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        ModelCandidateInterpreter(**deps).interpret(profile=PROFILE, profile_version=1)
    assert conn.execute("SELECT failure_code FROM semantic_stage_states").fetchone()[0] == "provider_unavailable"


def test_resume_extraction_stays_a_draft_and_requires_exact_numbers():
    cite = {"source_id": "resume", "quote": "Role 3 at Owned employer"}

    def extracted(text):
        return {"value": text, "citations": [cite]}

    output = {
        "personal": dict.fromkeys(["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"]),
        "executive_profile": None,
        "experience": [
            {
                "title": extracted("Role 3"),
                "company": extracted("Owned employer"),
                "date_range": None,
                "location": None,
                "summary": None,
                "bullets": [],
            }
        ],
        "education": [],
        "skills": [],
    }

    class ExtractionModel:
        def chat_json(self, messages, **kwargs):
            return output

    conn, deps, _ = setup(ExtractionModel())
    result, envelope = ModelResumeExtractor(**deps).extract("Role 3 at Owned employer")
    draft = profile_from_extraction(result)
    assert draft["resume"]["experience_entries"][0]["achievement_evidence"] == []
    assert draft["experience"] == {}
    assert conn.execute("SELECT count(*) FROM candidate_profiles").fetchone()[0] == 0
    output["experience"][0]["title"]["value"] = "Role 5"
    with pytest.raises(DeterminationFailure, match="mismatched_value"):
        ModelResumeExtractor(**deps).extract("Role 3 at Owned employer more source")
