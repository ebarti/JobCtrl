from __future__ import annotations

import sqlite3

from jobhunter import config


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

    assert merged["queries"] == [
        {"query": "Engineering Manager", "tier": 1},
        {"query": "Head of Engineering", "tier": 1},
    ]
    assert merged["locations"] == [
        {"label": "barcelona-spain", "location": "Barcelona, Spain", "remote": True}
    ]
    assert merged["defaults"]["country_indeed"] == "spain"
    assert "Barcelona, Spain" in merged["location_accept"]
    assert "Canada" in merged["location_reject_non_remote"]


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

    assert [item["query"] for item in loaded["queries"]] == [
        "Director of Engineering",
        "VP Engineering",
    ]
    assert loaded["locations"] == [
        {"label": "barcelona-spain", "location": "Barcelona, Spain", "remote": False}
    ]
    assert loaded["target_region"] == "europe"


def test_source_registry_filters_america_only_sources_for_europe_target() -> None:
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
    assert "smart_extract:welcometothejungle" in by_id
