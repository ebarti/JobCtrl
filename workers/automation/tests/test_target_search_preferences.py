from __future__ import annotations

import sqlite3

from jobhunter import config
from jobhunter.infrastructure.discovery.location_filter import (
    configured_local_location_accepts,
    configured_location_filters,
    location_matches_target,
)
from jobhunter.infrastructure.discovery.production_wiring import _ats_query_specs, _location_values
from jobhunter.discovery.target_queries import build_target_role_queries, query_applies_to_source, title_matches_any_query


def test_profile_target_search_overrides_discovery_queries_and_locations() -> None:
    search_cfg = {
        "queries": [{"query": "software engineer", "tier": 1}],
        "locations": [{"label": "sf", "location": "San Francisco, CA"}],
        "defaults": {"results_per_site": 100},
    }

    merged = config._apply_profile_target_search(
        search_cfg,
        {
            "roles": ["Engineering Manager", "Head of Engineering"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Hybrid, Remote"],
        },
    )

    assert merged["queries"][:2] == [
        {"query": "Engineering Manager", "tier": 1},
        {"query": "Head of Engineering", "tier": 1},
    ]
    assert {
        "query": "Engineering Director",
        "tier": 1,
        "match_mode": "recall",
        "generated_from": "target_roles",
        "target_track": "management",
        "seniority_floor": "manager",
    } in merged["queries"]
    recall_query = next(item for item in merged["queries"] if item.get("query") == "Engineering Director")
    assert query_applies_to_source(recall_query, "jobspy")
    assert query_applies_to_source(recall_query, "workday")
    assert query_applies_to_source(recall_query, "ats_api")
    assert query_applies_to_source({"query": "Engineering", "source_scope": "smart_extract"}, "smartextract")
    assert query_applies_to_source({"query": "Engineering", "source_scope": "smartextract"}, "smart_extract")
    assert merged["workday_max_tier"] == 1
    assert merged["ats_max_tier"] == 1
    assert merged["locations"] == [
        {"label": "barcelona-spain", "location": "Barcelona, Spain", "remote": False},
        {"label": "spain", "location": "Spain", "remote": True},
        {"label": "europe-remote", "location": "European Union", "remote": True},
    ]
    assert merged["defaults"]["hours_old"] == 720
    assert merged["defaults"]["country_indeed"] == "spain"
    assert "Barcelona, Spain" in merged["location_accept"]
    assert "Spain" in merged["location_accept"]
    assert "Europe" in merged["location_accept"]
    assert merged["location_accept_local"] == ["Barcelona, Spain"]
    assert "Canada" in merged["location_reject_non_remote"]


def test_profile_target_search_strips_role_notes_from_queries() -> None:
    merged = config._apply_profile_target_search(
        {"queries": [{"query": "software engineer", "tier": 1}]},
        {
            "roles": [
                "Head of Platform | Preferred work model: Remote | Onsite if required: Barcelona, Spain",
                "CISO",
            ],
            "locations": [],
            "work_models": [],
        },
    )

    assert merged["queries"][:2] == [
        {"query": "Head of Platform", "tier": 1},
        {"query": "CISO", "tier": 1},
    ]
    assert {
        "query": "Platform Director",
        "tier": 1,
        "match_mode": "recall",
        "generated_from": "target_roles",
        "target_track": "management",
        "seniority_floor": "head",
    } in merged["queries"]
    assert {
        "query": "Chief Information Security Officer",
        "tier": 1,
        "match_mode": "recall",
        "generated_from": "target_roles",
        "target_track": "executive",
        "seniority_floor": "ciso",
    } in merged["queries"]
    assert not any(item.get("query") == "CTO" for item in merged["queries"])


def test_recall_queries_expand_ats_internal_title_filters_without_query_pairs() -> None:
    merged = config._apply_profile_target_search(
        {"queries": [{"query": "software engineer", "tier": 1}]},
        {
            "roles": ["Head of Platform"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Hybrid"],
        },
    )

    query_specs = _ats_query_specs(merged)
    assert _location_values(merged) == ("Barcelona, Spain",)
    assert any(item["query"] == "Head of Platform" for item in query_specs)
    assert any(item["query"] == "Platform Director" for item in query_specs)
    assert title_matches_any_query("Platform Director", query_specs)
    assert not title_matches_any_query("Platform Engineering Manager", query_specs)


def test_profile_target_locations_replace_legacy_location_accept_patterns() -> None:
    merged = config._apply_profile_target_search(
        {
            "queries": [{"query": "software engineer", "tier": 1}],
            "locations": [{"label": "zurich", "location": "Zurich"}],
            "location_accept": ["Switzerland", "Zurich"],
            "location": {
                "accept_patterns": ["Remote", "Switzerland", "Zurich", "Europe", "EMEA"],
                "reject_patterns": ["United States"],
            },
        },
        {
            "roles": ["Director of Engineering"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Remote, Hybrid"],
        },
    )

    accept, reject = configured_location_filters(merged)
    local_accept = configured_local_location_accepts(merged)

    assert "Barcelona, Spain" in accept
    assert local_accept == ["Barcelona, Spain"]
    assert "Switzerland" not in accept
    assert "Zurich" not in accept
    assert location_matches_target("Barcelona, Spain (Remote)", accept=accept, reject=reject)
    assert location_matches_target("Remote EMEA", accept=accept, reject=reject)
    assert not location_matches_target("Switzerland - Zurich", accept=accept, reject=reject)


def test_hybrid_target_locations_filter_to_exact_target_location() -> None:
    merged = config._apply_profile_target_search(
        {
            "queries": [{"query": "software engineer", "tier": 1}],
            "locations": [{"label": "remote", "location": "Remote", "remote": True}],
        },
        {
            "roles": ["Director of Engineering"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Hybrid"],
        },
    )

    accept, reject = configured_location_filters(merged)
    local_accept = configured_local_location_accepts(merged)

    assert merged["locations"] == [{"label": "barcelona-spain", "location": "Barcelona, Spain", "remote": False}]
    assert local_accept == ["Barcelona, Spain"]
    assert "Europe" not in accept
    assert "EMEA" not in accept
    assert location_matches_target("Barcelona, CT, ES", accept=accept, reject=reject)
    assert location_matches_target("Barcelona, Spain", accept=accept, reject=reject)
    assert not location_matches_target("Remote EMEA", accept=accept, reject=reject)
    assert not location_matches_target("Remote Spain", accept=accept, reject=reject)
    assert not location_matches_target("Madrid, MD, ES", accept=accept, reject=reject)


def test_remote_european_target_locations_filter_country_and_europe_remote() -> None:
    merged = config._apply_profile_target_search(
        {"queries": [{"query": "software engineer", "tier": 1}]},
        {
            "roles": ["Director of Engineering"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Remote"],
        },
    )

    accept, reject = configured_location_filters(merged)
    local_accept = configured_local_location_accepts(merged)

    assert merged["locations"] == [
        {"label": "spain", "location": "Spain", "remote": True},
        {"label": "europe-remote", "location": "European Union", "remote": True},
    ]
    assert "Barcelona, Spain" not in accept
    assert local_accept == []
    assert "Spain" in accept
    assert "Europe" in accept
    assert location_matches_target("Remote Spain", accept=accept, reject=reject)
    assert location_matches_target("Remote EMEA", accept=accept, reject=reject)
    assert location_matches_target("Barcelona, CT, ES", accept=accept, reject=reject)
    assert not location_matches_target(
        "Barcelona, CT, ES",
        accept=accept,
        reject=reject,
        search_location="Spain",
        remote_required=True,
        is_remote=False,
        local_accept=local_accept,
    )
    assert not location_matches_target("Remote United States", accept=accept, reject=reject)
    assert not location_matches_target("Barcelona, Venezuela", accept=accept, reject=reject)


def test_remote_plus_local_target_rejects_non_remote_country_only_hits() -> None:
    merged = config._apply_profile_target_search(
        {"queries": [{"query": "software engineer", "tier": 1}]},
        {
            "roles": ["Chief Information Officer"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Remote, Hybrid, On-site"],
        },
    )

    accept, reject = configured_location_filters(merged)
    local_accept = configured_local_location_accepts(merged)

    assert "Spain" in accept
    assert "Europe" in accept
    assert local_accept == ["Barcelona, Spain"]
    assert not location_matches_target(
        "La Rinconada, AN, ES",
        accept=accept,
        reject=reject,
        search_location="Spain",
        remote_required=True,
        is_remote=False,
        local_accept=local_accept,
    )
    assert location_matches_target(
        "Barcelona, CT, ES",
        accept=accept,
        reject=reject,
        search_location="Spain",
        remote_required=True,
        is_remote=False,
        local_accept=local_accept,
    )
    assert location_matches_target(
        "La Rinconada, AN, ES",
        accept=accept,
        reject=reject,
        search_location="Spain",
        remote_required=True,
        is_remote=True,
        local_accept=local_accept,
    )


def test_profile_target_search_preserves_larger_configured_lookback() -> None:
    merged = config._apply_profile_target_search(
        {
            "queries": [{"query": "software engineer", "tier": 1}],
            "defaults": {"hours_old": 1440},
        },
        {
            "roles": ["Director of Engineering"],
            "locations": ["Barcelona, Spain"],
            "work_models": ["Remote"],
        },
    )

    assert merged["defaults"]["hours_old"] == 1440


def test_load_search_config_reads_profile_target_search_from_db(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE candidate_profiles (
          tenant_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          experience_target_role TEXT NOT NULL,
          experience_target_locations TEXT NOT NULL,
          experience_target_work_models TEXT NOT NULL,
          personal_city TEXT NOT NULL DEFAULT '',
          personal_country TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profiles (
          tenant_id, profile_id, experience_target_role,
          experience_target_locations, experience_target_work_models,
          personal_city, personal_country
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "default",
            "Target roles: Director of Engineering; VP Engineering",
            "",
            "Hybrid",
            "Barcelona",
            "Spain",
        ),
    )
    conn.commit()
    conn.close()

    search_path = tmp_path / "searches.yaml"
    search_path.write_text(
        """
queries:
  - query: software engineer
    tier: 1
locations:
  - label: remote
    location: Remote
defaults:
  results_per_site: 25
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(config, "SEARCH_CONFIG_PATH", search_path)

    loaded = config.load_search_config()

    assert [item["query"] for item in loaded["queries"][:2]] == [
        "Director of Engineering",
        "VP Engineering",
    ]
    assert any(
        item.get("query") == "Head of Engineering"
        and item.get("tier") == 1
        and item.get("match_mode") == "recall"
        and item.get("target_track") == "management"
        and item.get("seniority_floor") == "director"
        and "source_scope" not in item
        for item in loaded["queries"]
    )
    assert loaded["locations"] == [{"label": "barcelona-spain", "location": "Barcelona, Spain", "remote": False}]
    assert loaded["target_region"] == "europe"


def test_structured_profile_target_search_builds_track_and_seniority_aware_queries() -> None:
    merged = config._apply_profile_target_search(
        {"queries": [{"query": "software engineer", "tier": 1}]},
        {
            "roles": [],
            "tracks": ["IC"],
            "seniority": ["Principal"],
            "functions": ["Platform"],
            "specializations": ["SaaS"],
            "locations": [],
            "work_models": [],
        },
    )

    assert merged["queries"] == [
        {"query": "Principal Platform Engineer", "tier": 1},
        {"query": "Principal Platform Architect", "tier": 1},
    ]


def test_structured_management_senior_manager_floor_excludes_manager_level_queries() -> None:
    queries = build_target_role_queries(
        [],
        tracks=["management"],
        seniority=["senior_manager"],
        functions=["Engineering"],
    )

    query_texts = [item["query"] for item in queries]
    assert "Engineering Manager" not in query_texts
    assert query_texts[:2] == ["Senior Engineering Manager", "Engineering Director"]
    assert title_matches_any_query("Senior Engineering Manager", queries)
    assert title_matches_any_query("Head of Engineering", queries)
    assert not title_matches_any_query("Engineering Manager", queries)


def test_partial_structured_target_search_preserves_configured_queries_when_planner_is_empty() -> None:
    search_cfg = {"queries": [{"query": "software engineer", "tier": 1}]}

    merged = config._apply_profile_target_search(
        search_cfg,
        {
            "roles": [],
            "tracks": [],
            "seniority": ["C-level"],
            "functions": ["Security"],
            "specializations": [],
            "locations": [],
            "work_models": [],
        },
    )

    assert merged == search_cfg


def test_c_suite_structured_target_generates_only_chief_level_queries() -> None:
    for seniority in ("C-level", "C suite"):
        queries = build_target_role_queries(
            [],
            tracks=["Executive"],
            seniority=[seniority],
            functions=["Technology"],
        )

        query_texts = [item["query"] for item in queries]
        assert query_texts == ["CTO", "Chief Technology Officer"]
        assert not any("Director" in query or "Head of" in query or query.startswith("VP ") for query in query_texts)


def test_source_registry_filters_america_only_sources_for_europe_target(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobhunter.db")

    registry = config.load_source_registry(
        search_cfg={"target_region": "europe", "boards": ["linkedin"]},
        sites_cfg={
            "sites": [
                {
                    "name": "Job Bank Canada",
                    "url": "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={query_encoded}",
                    "type": "search",
                },
                {
                    "name": "Wellfound",
                    "url": "https://wellfound.com/location/spain",
                    "type": "static",
                },
                {
                    "name": "Wellfound Canada",
                    "url": "https://wellfound.com/role/l/software-engineer/canada",
                    "type": "static",
                },
                {
                    "name": "WelcomeToTheJungle",
                    "url": "https://www.welcometothejungle.com/en/jobs?query={query_encoded}",
                    "type": "search",
                },
            ]
        },
        employers_cfg={"employers": {}},
    )

    by_id = {entry.source_id for entry in registry}
    assert "smart_extract:job-bank-canada" not in by_id
    assert "smart_extract:wellfound" in by_id
    assert "smart_extract:wellfound-canada" not in by_id
    assert "smart_extract:welcometothejungle" in by_id


def test_local_source_registry_row_preserves_search_site_type(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE source_registry_entries (
          tenant_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          owner TEXT NOT NULL,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          policy_id TEXT NOT NULL,
          seed_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, source_id)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO source_registry_entries (
          tenant_id, source_id, kind, display_name, owner, priority,
          state, policy_id, seed_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            "smart_extract:welcometothejungle",
            "smart_extract",
            "WelcomeToTheJungle",
            "system",
            "fallback",
            "experimental",
            "smart_extract_experimental",
            "https://www.welcometothejungle.com/en/jobs?query={query_encoded}",
            "2026-05-18T00:00:00Z",
            "2026-05-18T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(config, "DB_PATH", db_path)

    registry = config.load_source_registry(
        search_cfg={"target_region": "europe", "boards": ["linkedin"]},
        sites_cfg={
            "sites": [
                {
                    "name": "WelcomeToTheJungle",
                    "url": "https://www.welcometothejungle.com/en/jobs?query={query_encoded}",
                    "type": "search",
                    "query_mode": "source_first",
                }
            ]
        },
        employers_cfg={"employers": {}},
    )

    by_id = {entry.source_id: entry for entry in registry}
    assert by_id["smart_extract:welcometothejungle"].adapter_config["type"] == "search"
    assert by_id["smart_extract:welcometothejungle"].adapter_config["query_mode"] == "source_first"
