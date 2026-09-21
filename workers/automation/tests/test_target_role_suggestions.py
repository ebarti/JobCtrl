from __future__ import annotations

from types import SimpleNamespace

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
            "target_seniority_floor": "Director; VP",
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
                    "title": "Head of Platform Engineering",
                    "classification": "adjacent",
                    "track": "Management",
                    "seniority": "Director",
                    "evidenceIds": ["experience:role_1", "ev_incidents"],
                    "rationale": "Recent management title and reliability outcome support the adjacent scope.",
                }
            ]
        }
    )

    result = suggest_target_roles(_snapshot(), llm=llm)

    assert result.profile_version == 7
    assert result.strategy == "model"
    assert [item.title for item in result.suggestions] == ["Head of Platform Engineering"]
    assert len(llm.calls) == 1
    _, call = llm.calls[0]
    assert call["max_tokens"] == 900
    payload = llm.calls[0][0][1].content
    assert len(payload) <= 12_500
    for excluded in (
        "private@example.test",
        "private-salary",
        "private-eeo",
        "attestation",
        "Private Company",
        "Private City",
    ):
        assert excluded not in payload


def test_fails_closed_on_unknown_evidence_and_dedupes_saved_roles():
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

    assert result.strategy == "recent_title_fallback"
    assert [item.title for item in result.suggestions] == ["Platform Engineering Manager"]
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


def test_real_rpc_dispatcher_uses_saved_snapshot_and_rejects_stale_version(monkeypatch, tmp_path):
    from jobctrl.infrastructure.llm import llm_client
    from jobctrl.infrastructure.profile import factory
    import jobctrl.llm as spend

    repo = factory.build_profile_repository(
        db_path=tmp_path / "profile.db",
        publisher=InProcessEventBus(),
    )
    saved = repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, _profile_dict()))
    llm = _SyntheticLlm(
        {
            "suggestions": [
                {
                    "title": "Head of Platform Engineering",
                    "classification": "direct",
                    "track": "Management",
                    "seniority": "Director",
                    "evidenceIds": ["ev_incidents"],
                    "rationale": "Canonical achievement evidence supports the title.",
                }
            ]
        }
    )
    monkeypatch.setattr(factory, "get_profile_repository", lambda: repo)
    monkeypatch.setattr(llm_client, "get_llm_adapter", lambda: llm)
    monkeypatch.setattr(spend, "read_spend_budget_status", lambda: SimpleNamespace(exceeded=False))

    server = JsonRpcServer()

    async def canceler(_: str) -> None:
        return None

    register_default_handlers(server, canceler=canceler)
    response = server.dispatch(
        JsonRpcRequest(
            id=1,
            method="profile_target_role_suggestions",
            params={"tenantId": "local", "expectedProfileVersion": saved.version},
        )
    )
    assert response is not None and response.error is None
    assert response.result["profileVersion"] == saved.version
    assert response.result["suggestions"][0]["evidenceIds"] == ["ev_incidents"]
    assert repo.load_snapshot(LOCAL_TENANT).version == saved.version

    stale = server.dispatch(
        JsonRpcRequest(
            id=2,
            method="profile_target_role_suggestions",
            params={"tenantId": "local", "expectedProfileVersion": saved.version + 1},
        )
    )
    assert stale is not None and stale.error is not None
    assert stale.error.code == INVALID_PARAMS
    assert "stale_profile_version" in stale.error.message
    assert len(llm.calls) == 1
