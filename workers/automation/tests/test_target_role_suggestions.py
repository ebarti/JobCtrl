from __future__ import annotations

from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.profile.target_role_suggestions import suggest_target_roles
from jobctrl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer


def _profile_dict() -> dict:
    return {
        "personal": {"full_name": "Synthetic Candidate", "email": "private@example.test"},
        "work_authorization": {},
        "compensation": {"salary_expectation": "private-salary"},
        "experience": {
            "years_of_experience_total": "8",
            "target_role": "Director of Platform",
            "target_track": "Management; Executive",
            "target_seniority_floor": "Manager; Director; VP",
        },
        "availability": {},
        "eeo_voluntary": {"gender": "private-eeo"},
        "application_attestations": {"additional": {"private": "attestation"}},
        "resume": {
            "executive_profile": {"baseline_text": "Synthetic platform leader."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Platform Engineering Manager",
                    "company": "Private Company",
                    "location": "Private City",
                    "date_range": "2022 -- Present",
                    "summary": "Synthetic summary.",
                    "bullets": ["Reduced incidents 40%.", "Led a team."],
                    "achievement_evidence": [
                        {
                            "id": "ev_incidents",
                            "source_text": "Reduced incidents 40%.",
                            "scope": "Synthetic platform",
                            "action": "Introduced reliability controls",
                            "tools": ["Python"],
                            "metrics": ["40%"],
                            "outcome": "Reduced incidents",
                            "seniority_signal": "Led cross-team adoption",
                            "evidence_strength": "supported",
                            "claim_confidence": 1,
                            "user_confirmed": True,
                            "tags": ["reliability"],
                        }
                    ],
                }
            ],
            "education_entries": [],
            "skill_categories": [
                {"id": "platform", "label": "Platform", "items": ["Python", "Reliability"]}
            ],
            "tailoring_rules": {},
        },
        "resume_constraints": {},
    }


def _snapshot(version: int = 7) -> ProfileSnapshot:
    return ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_dict()),
        version=version,
    )


class _SyntheticLlm:
    def __init__(self, response: dict | Exception) -> None:
        self.response = response
        self.calls: list[tuple[list, dict]] = []

    def chat_json(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response

def test_generates_bounded_suggestions_from_minimized_canonical_evidence():
    llm = _SyntheticLlm(
        {
            "suggestions": [
                {
                    "title": "Platform Reliability Manager",
                    "classification": "adjacent",
                    "track": "Management",
                    "seniority": "Manager",
                    "evidenceIds": ["experience:role_1", "ev_incidents"],
                    "rationale": "Recent management title and reliability outcome support the adjacent scope.",
                }
            ]
        }
    )

    result = suggest_target_roles(_snapshot(), llm=llm)

    assert result.profile_version == 7
    assert result.strategy == "model"
    assert [item.title for item in result.suggestions] == ["Platform Reliability Manager"]
    assert len(llm.calls) == 1
    _, call = llm.calls[0]
    assert call["max_tokens"] == 900
    payload = llm.calls[0][0][1].content
    assert len(payload) <= 12_500
    assert "profile:7:skill:platform:1" in payload
    for excluded in (
        "private@example.test",
        "private-salary",
        "private-eeo",
        "attestation",
        "Private Company",
        "Private City",
    ):
        assert excluded not in payload


def test_fails_closed_on_unknown_evidence():
    llm = _SyntheticLlm(
        {
            "suggestions": [
                {
                    "title": "Invented Executive",
                    "classification": "direct",
                    "track": "Executive",
                    "seniority": "VP",
                    "evidenceIds": ["fabricated"],
                    "rationale": "Unsupported.",
                }
            ]
        }
    )

    result = suggest_target_roles(_snapshot(), llm=llm)

    assert result.strategy == "deterministic"
    assert [item.title for item in result.suggestions] == [
        "Platform Engineering Manager", "Platform Reliability Manager",
    ]
    assert result.warnings == ("model_unavailable_or_invalid",)


def test_fails_complete_model_result_closed_on_unsupported_role_semantics():
    for suggestion in (
        {
            "title": "Chief Financial Officer",
            "classification": "adjacent",
            "track": "Management",
            "seniority": "Director",
            "evidenceIds": ["experience:role_1", "ev_incidents"],
            "rationale": "Fabricated cross-domain role.",
        },
        {
            "title": "Staff Platform Engineer",
            "classification": "adjacent",
            "track": "Management",
            "seniority": "Manager",
            "evidenceIds": ["experience:role_1", "ev_incidents"],
            "rationale": "The title conflicts with the declared track.",
        },
        {
            "title": "Platform Director",
            "classification": "adjacent",
            "track": "Management",
            "seniority": "Director",
            "evidenceIds": ["experience:role_1", "ev_incidents"],
            "rationale": "The title conflicts with the declared seniority.",
        },
        {
            "title": "Quantum Platform Manager",
            "classification": "adjacent",
            "track": "Management",
            "seniority": "Manager",
            "evidenceIds": ["experience:role_1", "ev_incidents"],
            "rationale": "Quantum is not supported by either cited source.",
        },
        {
            "title": "Staff Platform Manager",
            "classification": "adjacent",
            "track": "Management",
            "seniority": "Manager",
            "evidenceIds": ["experience:role_1", "ev_incidents"],
            "rationale": "Conflicting individual contributor level.",
        },
    ):
        result = suggest_target_roles(
            _snapshot(),
            llm=_SyntheticLlm({"suggestions": [suggestion]}),
        )

        assert result.strategy == "deterministic"
        assert [item.title for item in result.suggestions] == [
            "Platform Engineering Manager", "Platform Reliability Manager",
        ]
        assert result.warnings == ("model_unavailable_or_invalid",)


def test_returns_zero_when_authoritative_track_or_seniority_is_missing():
    raw = _profile_dict()
    raw["experience"]["target_track"] = ""
    llm = _SyntheticLlm({"suggestions": []})
    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, raw), version=2)

    result = suggest_target_roles(snapshot, llm=llm)

    assert result.strategy == "none"
    assert result.suggestions == ()
    assert result.warnings == ("authoritative_track_or_seniority_missing",)
    assert llm.calls == []


def test_provider_failure_uses_only_the_exact_recent_title_fallback():
    result = suggest_target_roles(_snapshot(), llm=_SyntheticLlm(OSError("provider unavailable")))

    assert result.strategy == "deterministic"
    assert [item.title for item in result.suggestions] == [
        "Platform Engineering Manager", "Platform Reliability Manager",
    ]
    assert result.warnings == ("model_unavailable_or_invalid",)


def test_unbounded_production_path_is_deterministic_without_provider_call():
    result = suggest_target_roles(
        _snapshot(),
        llm=None,
        allow_model=False,
        fallback_warning="provider_token_or_cost_bound_unsupported",
    )

    assert result.strategy == "deterministic"
    assert [item.title for item in result.suggestions] == [
        "Platform Engineering Manager", "Platform Reliability Manager",
    ]
    assert result.suggestions[0].classification == "direct"
    assert result.suggestions[0].evidence_ids == ("experience:role_1",)
    assert result.warnings == ("provider_token_or_cost_bound_unsupported",)
    assert result.preference_suggestions[0].location == "Private City"
    assert result.preference_suggestions[0].work_model == ""


def test_historical_preference_proposals_keep_rows_and_exact_work_model_markers():
    raw = _profile_dict()
    raw["resume"]["experience_entries"] = [
        {"id": "a", "title": "Platform Engineering Manager", "location": "Madrid, Spain | Hybrid"},
        {"id": "b", "title": "Platform Engineering Manager", "location": "Remote"},
        {"id": "c", "title": "Platform Engineering Manager", "location": "London | On-site"},
        {"id": "d", "title": "Platform Engineering Manager", "location": "Berlin | Remote/Hybrid"},
        {"id": "e", "title": "Platform Engineering Manager", "location": "Not willing to relocate"},
        {"id": "f", "title": "Platform Engineering Manager", "location": "Madrid, Spain | Hybrid"},
    ]
    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, raw), version=9)
    result = suggest_target_roles(snapshot, llm=None, allow_model=False)
    assert [(item.location, item.work_model, item.evidence_ids) for item in result.preference_suggestions] == [
        ("Madrid, Spain", "Hybrid", ("experience:a",)),
        ("", "Remote", ("experience:b",)),
        ("London", "On-site", ("experience:c",)),
    ]
    assert result.as_dict()["preferenceSuggestions"][1] == {
        "location": "", "workModel": "Remote", "evidenceIds": ["experience:b"],
    }


def test_deterministic_cap_existing_role_case_and_sparse_evidence():
    raw = _profile_dict()
    raw["experience"]["target_role"] = "platform engineering manager"
    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, raw), version=10)
    result = suggest_target_roles(snapshot, llm=None, allow_model=False, maximum_suggestions=1)
    assert [item.title for item in result.suggestions] == ["Platform Reliability Manager"]

    raw["resume"]["experience_entries"][0]["achievement_evidence"] = []
    sparse = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, raw), version=11)
    assert suggest_target_roles(sparse, llm=None, allow_model=False).suggestions == ()


def test_real_rpc_dispatcher_uses_saved_snapshot_and_rejects_stale_version(monkeypatch, tmp_path):
    import jobctrl.config as config
    import jobctrl.database as database
    from jobctrl.infrastructure.profile import factory

    db_path = tmp_path / "profile.db"
    repo = factory.build_profile_repository(
        db_path=db_path,
        publisher=InProcessEventBus(),
    )
    saved = repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _profile_dict()))
    monkeypatch.setattr(factory, "get_profile_repository", lambda: repo)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)

    server = JsonRpcServer()

    async def canceler(_: str) -> None:
        return None

    register_default_handlers(server, canceler=canceler)
    response = server.dispatch(
        JsonRpcRequest(
            id=1,
            method="profile_target_role_suggestions",
            params={
                "tenantId": "local",
                "expectedAppDir": str(tmp_path),
                "expectedDbPath": str(db_path),
                "expectedProfileVersion": saved.version,
            },
        )
    )
    assert response is not None and response.error is None
    assert response.result["profileVersion"] == saved.version
    assert [item["title"] for item in response.result["suggestions"]] == [
        "Platform Engineering Manager", "Platform Reliability Manager",
    ]
    assert response.result["strategy"] == "deterministic"
    assert response.result["warnings"] == ["provider_token_or_cost_bound_unsupported"]
    assert repo.load_snapshot(LOCAL_TENANT).version == saved.version

    stale = server.dispatch(
        JsonRpcRequest(
            id=2,
            method="profile_target_role_suggestions",
            params={
                "tenantId": "local",
                "expectedAppDir": str(tmp_path),
                "expectedDbPath": str(db_path),
                "expectedProfileVersion": saved.version + 1,
            },
        )
    )
    assert stale is not None and stale.error is not None
    assert stale.error.code == INVALID_PARAMS
    assert "stale_profile_version" in stale.error.message
