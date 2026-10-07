"""Config preserves authored fields; model proposals need explicit confirmation."""

from copy import deepcopy
import pytest
from jobctrl import config
from jobctrl.discovery.target_queries import query_applies_to_source
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.profile.search_preferences import (
    prepare_search_preferences,
    confirm_search_preferences,
    read_search_preferences,
    require_confirmed_search_preferences,
    preferences_response,
)
from tests.test_discovery_determinations import setup, CFG, Model, listings
from tests.determination_fakes import PreferenceModel
from jobctrl.infrastructure.discovery.triage import triage_listings


def test_config_preserves_authored_target_text_without_planning_queries():
    raw = {
        "queries": [{"query": "Existing literal query", "tier": 1}],
        "locations": [{"location": "Existing board parameter"}],
    }
    target = {"roles": ["Authored role"], "locations": ["Authored place"], "work_models": ["Authored work model"]}
    original = deepcopy(raw)
    result = config._apply_profile_target_search(raw, target)
    assert result == {**raw, "confirmed_targets": target}
    assert raw == original


@pytest.mark.parametrize("scope", ["jobspy", "ats_api", "workday", "smartextract"])
def test_query_source_scope_is_a_literal_code(scope):
    assert query_applies_to_source({"query": "Literal query", "source_scope": [scope]}, scope)
    assert not query_applies_to_source(
        {"query": "Literal query", "source_scope": ["ats_api" if scope != "ats_api" else "jobspy"]}, scope
    )


@pytest.mark.parametrize("family", ["software_engineering", "sales"])
def test_same_authored_preferences_follow_the_model_then_need_confirmation(family):
    conn, deps = setup(Model())
    cfg = {**CFG, "confirmed_targets": {**CFG["confirmed_targets"], "profile_version": 3}}
    model = PreferenceModel(family)
    result, envelope = prepare_search_preferences(conn, cfg, dependencies={**deps, "llm": model, "lane": "profile"})
    assert result.roles[0].occupation_family == family
    assert preferences_response(conn, cfg)["status"] == "pending_confirmation"
    with pytest.raises(DeterminationFailure, match="preferences_confirmation_required"):
        require_confirmed_search_preferences(conn, cfg)
    confirm_search_preferences(conn, cfg, envelope.determination_id)
    sources, preferences = require_confirmed_search_preferences(conn, cfg)
    assert sources[0].source_id == "confirmed_search_preferences"
    assert preferences["interpretation"]["roles"][0]["occupation_family"] == family
    prepare_search_preferences(conn, cfg, dependencies={**deps, "llm": model, "lane": "profile"})
    assert len(model.calls) == 1


@pytest.mark.parametrize("change", ["profile_version", "locations", "criteria"])
def test_changed_preferences_require_a_new_version_fenced_confirmation(change):
    conn, _ = setup(Model())
    changed = deepcopy(CFG)
    changed["confirmed_targets"][change] = 2 if change == "profile_version" else ["Changed authored text"]
    with pytest.raises(DeterminationFailure, match="stale_preferences_determination"):
        confirm_search_preferences(conn, changed, preferences_response(conn, CFG)["determination"]["determination_id"])
    assert read_search_preferences(conn, changed, confirmed=True) is None
    assert read_search_preferences(conn, CFG, confirmed=True) is not None


def test_missing_confirmation_keeps_intake_visible_and_never_calls_triage_model():
    model = Model()
    conn, deps = setup(model)
    cfg = {**CFG, "confirmed_targets": {**CFG["confirmed_targets"], "profile_version": 2}}
    with pytest.raises(DeterminationFailure, match="preferences_confirmation_required"):
        triage_listings(conn, listings(2), search_cfg=cfg, dependencies=deps)
    assert model.calls == []
    assert [tuple(row) for row in conn.execute("SELECT status,failure_code FROM posting_triage")] == [
        ("pending_triage", "preferences_confirmation_required")
    ] * 2


def test_failed_preference_refresh_preserves_the_confirmed_interpretation():
    conn, deps = setup(Model())
    before = read_search_preferences(conn, CFG, confirmed=True)[1]
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        prepare_search_preferences(
            conn, CFG, dependencies={**deps, "llm": None, "provider": "new-provider", "lane": "profile"}
        )
    assert read_search_preferences(conn, CFG, confirmed=True)[1] == before
