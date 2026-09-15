from __future__ import annotations

import json
import pytest

from jobctrl.infrastructure.compensation.levels_fyi_public import (
    LEVELS_FYI_ATTRIBUTION,
    LEVELS_FYI_BASE_URL,
    LEVELS_FYI_MARKET_AGGREGATE_COMPANY,
    LevelsFyiPublicTarget,
    levels_fyi_location_slug,
    levels_fyi_public_url,
    levels_fyi_role_slug,
    load_levels_fyi_public_observations,
)


def test_builds_job_family_and_location_routes_from_local_job_fields() -> None:
    assert levels_fyi_role_slug("Senior Platform Engineer") == "software-engineer"
    assert levels_fyi_role_slug("Director of Software Engineering") == "software-engineering-manager"
    assert levels_fyi_role_slug("Lead Technical Program Manager") == "technical-program-manager"
    assert levels_fyi_location_slug("Madrid, Community of Madrid, Spain (Remote)") == "madrid-esp"
    assert levels_fyi_location_slug("London, UK") == "london-gbr"
    assert levels_fyi_location_slug("Remote - Spain") == "spain"
    assert (
        levels_fyi_public_url(LevelsFyiPublicTarget("Senior Platform Engineer", "Madrid, Spain"))
        == f"{LEVELS_FYI_BASE_URL}/t/software-engineer/locations/madrid-esp"
    )
    assert (
        levels_fyi_public_url(LevelsFyiPublicTarget("Senior Platform Engineer", "ES"))
        == f"{LEVELS_FYI_BASE_URL}/t/software-engineer/locations/spain"
    )


def test_loads_tokenless_markdown_with_required_attribution() -> None:
    markdown = """# Levels.fyi – Software Engineer Salary in Madrid, Spain

**URL:** https://www.levels.fyi/t/software-engineer/locations/madrid-esp
**Generated:** 2026-07-12T12:00:00.000Z
**Scope:** Software Engineer roles in Madrid, Spain
**Location:** Madrid, Spain
**Currency:** EUR (€)

---
## Aggregate Highlights
- Median Total Compensation: €54,000
- 25th / 75th Percentile: €39,000 / €77,000

### Top Paying Companies
| Rank | Company | Median Total Compensation |
| --- | --- | --- |
| 1 | Example Cloud | €111,000 |

## Attribution
Use of this data requires attribution to **Levels.fyi**.
"""
    calls: list[str] = []

    def fetch(url: str) -> str | None:
        calls.append(url)
        return markdown if url == "https://www.levels.fyi/t/software-engineer/locations/madrid-esp.md" else None

    observations = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Senior Software Engineer", "Madrid, Spain")],
        fetch_text=fetch,
    )

    assert calls == [
        "https://www.levels.fyi/t/software-engineer/levels/senior/locations/madrid-esp.md",
        "https://www.levels.fyi/t/software-engineer/levels/senior/locations/madrid-esp",
        "https://www.levels.fyi/t/software-engineer/locations/madrid-esp.md",
        "https://www.levels.fyi/t/software-engineer/locations/madrid-esp",
        "https://www.levels.fyi/t/software-engineer/levels/senior/locations/spain.md",
        "https://www.levels.fyi/t/software-engineer/levels/senior/locations/spain",
        "https://www.levels.fyi/t/software-engineer/locations/spain.md",
        "https://www.levels.fyi/t/software-engineer/locations/spain",
    ]
    assert len(observations) == 2
    aggregate, company = observations
    assert aggregate.company_name == LEVELS_FYI_MARKET_AGGREGATE_COMPANY
    assert (aggregate.minimum_amount, aggregate.maximum_amount) == (39_000, 77_000)
    assert aggregate.currency == "EUR"
    assert aggregate.location == "Madrid, Spain"
    assert aggregate.level_label == "all levels"
    assert aggregate.attribution == LEVELS_FYI_ATTRIBUTION
    assert aggregate.source_provenance == "public"
    assert aggregate.snapshot_version == "levels-fyi-public-2026"
    assert aggregate.sample_count is None
    assert company.company_name == "Example Cloud"
    assert company.minimum_amount == 111_000
    assert company.source_provenance == "public"
    assert company.snapshot_version == "levels-fyi-public-2026"
    assert company.sample_count is None


def test_empty_markdown_falls_back_to_public_next_data() -> None:
    occupation = {
        "@type": "Occupation",
        "sampleSize": 42,
        "mainEntityOfPage": {"lastReviewed": "2026-07-12T13:00:00.000Z"},
        "estimatedSalary": [
            {
                "@type": "MonetaryAmountDistribution",
                "name": "total",
                "currency": "GBP",
                "percentile25": 70_000,
                "median": 95_000,
                "percentile75": 130_000,
            }
        ],
    }
    next_data = {
        "props": {
            "pageProps": {
                "jobFamily": "Software Engineer",
                "location": "London, United Kingdom",
                "locationCurrency": "GBP",
                "locationExchangeRate": 0.8,
                "totalJobFamilySubmissionCount": 42,
                "topPayingCompanies": [
                    {
                        "name": "Example Systems",
                        "totalCompensation": 200_000,
                    }
                ],
                "jobFamilyLocationPageOccupationSchema": json.dumps(occupation),
            }
        }
    }
    public_html = f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(next_data)}</script></html>'
    calls: list[str] = []

    def fetch(url: str) -> str | None:
        calls.append(url)
        return "" if url.endswith(".md") else public_html

    observations = load_levels_fyi_public_observations(
        [
            LevelsFyiPublicTarget("Software Engineer", "London, United Kingdom"),
            LevelsFyiPublicTarget("Software Engineer", "London, United Kingdom"),
        ],
        fetch_text=fetch,
    )

    assert calls == [
        "https://www.levels.fyi/t/software-engineer/locations/london-gbr.md",
        "https://www.levels.fyi/t/software-engineer/locations/london-gbr",
    ]
    assert len(observations) == 2
    aggregate, company = observations
    assert aggregate.sample_count == 42
    assert (aggregate.minimum_amount, aggregate.maximum_amount) == (81_900, 152_100)
    assert company.company_name == "Example Systems"
    assert company.minimum_amount == 187_200
    assert company.sample_count is None
    assert all(row.currency == "EUR" for row in observations)

    raw_observations = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Software Engineer", "London, United Kingdom")],
        fetch_text=fetch,
        preserve_source_currency=True,
    )
    raw_aggregate, raw_company = raw_observations
    assert (raw_aggregate.minimum_amount, raw_aggregate.maximum_amount) == (70_000, 130_000)
    assert raw_company.minimum_amount == 160_000
    assert all(row.currency == "GBP" for row in raw_observations)


def test_unavailable_public_pages_are_reported_separately_from_no_evidence() -> None:
    outcomes = []

    observations = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Software Engineer", "Spain")],
        fetch_text=lambda _url: None,
        on_load_outcome=outcomes.append,
    )

    assert observations == ()
    assert len(outcomes) == 1
    assert outcomes[0].requested_pages == 1
    assert outcomes[0].reachable_pages == 0
    assert outcomes[0].parsed_pages == 0
    assert outcomes[0].unavailable is True


def test_nonfinite_company_value_does_not_discard_valid_page_aggregate() -> None:
    occupation = {
        "@type": "Occupation",
        "sampleSize": 42,
        "mainEntityOfPage": {"lastReviewed": "2026-07-12T13:00:00.000Z"},
        "estimatedSalary": [
            {
                "@type": "MonetaryAmountDistribution",
                "name": "total",
                "currency": "EUR",
                "percentile25": 70_000,
                "median": 95_000,
                "percentile75": 130_000,
            }
        ],
    }
    next_data = {
        "props": {
            "pageProps": {
                "jobFamily": "Software Engineer",
                "location": "Spain",
                "locationCurrency": "EUR",
                "locationExchangeRate": 1,
                "totalJobFamilySubmissionCount": 42,
                "topPayingCompanies": [{"name": "Malformed Company", "totalCompensation": float("inf")}],
                "jobFamilyLocationPageOccupationSchema": json.dumps(occupation),
            }
        }
    }
    public_html = f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(next_data)}</script></html>'

    observations = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Software Engineer", "Spain")],
        fetch_text=lambda url: "" if url.endswith(".md") else public_html,
    )

    assert len(observations) == 1
    assert observations[0].company_name == LEVELS_FYI_MARKET_AGGREGATE_COMPANY
    assert (observations[0].minimum_amount, observations[0].maximum_amount) == (
        70_000,
        130_000,
    )


def _html(props: dict, links: tuple[str, ...] = ()) -> str:
    return ('<html>' + ''.join(f'<a href="{link}">salary</a>' for link in links)
            + '<script id="__NEXT_DATA__">' + json.dumps({"props": {"pageProps": props}}) + '</script></html>')


def _company_props() -> dict:
    return {
        "jobFamily": "Software Engineer", "jobFamilySlug": "software-engineer",
        "levels": {"company": "Example Cloud"},
        "locationMeta": {"name": "Spain", "type": "country"},
        "locationCurrency": "EUR", "locationExchangeRate": 0.8,
        # These unrelated global percentiles must never be used for a level row.
        "percentiles": {"locationName": "United States", "percentile25": 1, "percentile75": 2},
        "averages": [
            {"primaryLevelName": "Principal Engineer", "total": 200_000, "count": 4,
             "levelPageUrl": "/companies/example-cloud/salaries/software-engineer/levels/principal/locations/spain"},
            {"primaryLevelName": "Senior Engineer", "total": 120_000, "count": 9,
             "levelPageUrl": "/companies/example-cloud/salaries/software-engineer/levels/senior/locations/spain"},
            {"primaryLevelName": "L8", "total": 900_000, "count": 2,
             "levelPageUrl": "/companies/example-cloud/salaries/software-engineer/levels/l8/locations/spain"},
        ],
    }


def test_discovers_source_owned_company_levels_after_country_fallback() -> None:
    regional = f"{LEVELS_FYI_BASE_URL}/t/software-engineer/locations/spain"
    company = f"{LEVELS_FYI_BASE_URL}/companies/example-cloud/salaries/software-engineer/locations/spain"
    pages = {regional: _html({}, (company, "https://unrelated.invalid/secret", "/companies/unrelated/salaries/sales/locations/spain")),
             company: _html(_company_props())}
    calls = []
    def fetch(url: str) -> str | None:
        calls.append(url)
        return pages.get(url)
    observations = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Principal Software Engineer", "Madrid, Spain")], fetch_text=fetch)
    principal = next(row for row in observations if row.level_label == "Principal Engineer")
    assert principal.company_name == "Example Cloud"
    assert principal.location == "Spain"
    assert principal.currency == "EUR"
    assert principal.minimum_amount == principal.maximum_amount == 160_000
    assert principal.sample_count == 4
    assert principal.source_url == company.replace("/locations/", "/levels/principal/locations/")
    assert all("unrelated" not in call for call in calls)
    assert all(row.level_label != "L8" for row in observations)
    assert len(calls) <= 24


def test_filtered_route_does_not_relabel_an_all_level_payload() -> None:
    regional = f"{LEVELS_FYI_BASE_URL}/t/software-engineer/locations/spain"
    filtered = f"{LEVELS_FYI_BASE_URL}/t/software-engineer/levels/senior/locations/spain"
    schema = {"estimatedSalary": [{"name": "total", "currency": "EUR", "median": 70_000}], "sampleSize": 50}
    props = {"jobFamily": "Software Engineer", "location": "Spain",
             "jobFamilyLocationPageOccupationSchema": json.dumps(schema)}
    pages = {regional: _html(props, (filtered,)), filtered: _html(props)}
    rows = load_levels_fyi_public_observations([LevelsFyiPublicTarget("Senior Software Engineer", "Spain")],
                                             fetch_text=pages.get)
    assert rows and {row.level_label for row in rows} == {"all levels"}
    props["level"] = "Senior"
    pages[filtered] = _html(props)
    rows = load_levels_fyi_public_observations([LevelsFyiPublicTarget("Senior Software Engineer", "Spain")],
                                             fetch_text=pages.get)
    assert next(row for row in rows if row.source_url == filtered).level_label == "Senior"


def test_source_traversal_budget_counts_discovery_pages_and_empty_bodies_as_unavailable() -> None:
    calls = []
    outcomes = []
    def fetch(url: str) -> str:
        calls.append(url)
        return ""
    rows = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Principal Software Engineer", "Madrid, Spain")], fetch_text=fetch,
        max_pages=1, on_load_outcome=outcomes.append)
    assert rows == () and len(calls) == 2
    assert outcomes[0].requested_pages == 1
    assert outcomes[0].unavailable


def test_supported_regional_level_route_is_requested_before_generic_population() -> None:
    level_url = f"{LEVELS_FYI_BASE_URL}/t/software-engineer/levels/senior/locations/spain"
    schema = {"estimatedSalary": [{"name": "total", "currency": "EUR", "median": 80_000}], "sampleSize": 40}
    props = {"jobFamily": "Software Engineer", "level": "Senior", "location": "Spain",
             "jobFamilyLocationPageOccupationSchema": json.dumps(schema)}
    calls = []
    def fetch(url):
        calls.append(url)
        return _html(props) if url == level_url else None
    rows = load_levels_fyi_public_observations([LevelsFyiPublicTarget("Senior Software Engineer", "Spain")], fetch_text=fetch)
    assert calls == [level_url + ".md", level_url]
    assert len(rows) == 1 and rows[0].level_label == "Senior"


def test_generic_available_but_level_discovery_unavailable_is_reported_as_partial_failure() -> None:
    outcomes = []
    # Empty bodies on the requested level discovery path are an acquisition
    # failure, not proof that Principal salary records do not exist.
    load_levels_fyi_public_observations([LevelsFyiPublicTarget("Principal Software Engineer", "Spain")],
        fetch_text=lambda _url: "", on_load_outcome=outcomes.append)
    assert outcomes[0].level_lookup_unavailable


def test_generic_first_cache_is_upgraded_for_principal_discovery_with_shared_budget() -> None:
    regional = f"{LEVELS_FYI_BASE_URL}/t/software-engineer/locations/spain"
    company = f"{LEVELS_FYI_BASE_URL}/companies/example-cloud/salaries/software-engineer/locations/spain"
    markdown = """# Levels.fyi – Software Engineer Salary in Spain
**Location:** Spain
**Currency:** EUR
## Aggregate Highlights
- Median Total Compensation: €60,000
- 25th / 75th Percentile: €40,000 / €80,000
"""
    pages = {regional + ".md": markdown, regional: _html({}, (company,)), company: _html(_company_props())}
    generic = LevelsFyiPublicTarget("Software Engineer", "Spain")
    principal = LevelsFyiPublicTarget("Principal Software Engineer", "Spain")
    for targets in ((generic, principal), (principal, generic)):
        calls, outcomes = [], []
        def fetch(url):
            calls.append(url)
            return pages.get(url)
        rows = load_levels_fyi_public_observations(targets, fetch_text=fetch, max_pages=2, on_load_outcome=outcomes.append)
        assert {row.level_label for row in rows} == {"all levels", "Principal Engineer", "Senior Engineer"}
        assert calls == [regional + ".md", regional, company + ".md", company]
        assert outcomes[0].requested_pages == outcomes[0].reachable_pages == outcomes[0].parsed_pages == 2
        assert not outcomes[0].level_lookup_unavailable
    calls.clear()
    rows = load_levels_fyi_public_observations((generic, principal), fetch_text=fetch, max_pages=1)
    assert calls == [regional + ".md", regional]
    assert {row.level_label for row in rows} == {"all levels"}

    pages[regional] = ""
    outcomes = []
    load_levels_fyi_public_observations((generic, principal), fetch_text=fetch, on_load_outcome=outcomes.append)
    assert outcomes[0].level_lookup_unavailable


@pytest.mark.parametrize("path", ["explicit", "automatic"])
def test_mixed_level_job_refresh_uses_actual_public_loader_and_materializes_principal(tmp_path, monkeypatch, path):
    from jobctrl.database import init_db, close_connection
    from jobctrl.infrastructure.compensation import refresh, sqlite_market_repository as market
    from jobctrl.infrastructure.compensation.automatic_refresh import run_automatic_compensation_refresh
    from jobctrl.infrastructure.compensation.benchmark_materialization import materialize_automatic_compensation_estimates

    conn = init_db(tmp_path / "discovery.db")
    try:
        generic_id, principal_id = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
        for index, (job_id, title) in enumerate(((generic_id, "Software Engineer"), (principal_id, "Principal Software Engineer"))):
            conn.execute("""INSERT INTO jobs (tenant_id, job_id, url, title, site, location, discovered_at)
                VALUES ('local', ?, ?, ?, 'Unrelated Company', 'Spain', '2026-08-12T08:00:00Z')""",
                (job_id, f"https://example.com/{index}", title))
        conn.commit()
        regional = f"{LEVELS_FYI_BASE_URL}/t/software-engineer/locations/spain"
        company = f"{LEVELS_FYI_BASE_URL}/companies/example-cloud/salaries/software-engineer/locations/spain"
        pages = {regional + ".md": """# Levels.fyi – Software Engineer Salary in Spain
**Location:** Spain
**Currency:** EUR
## Aggregate Highlights
- Median Total Compensation: €60,000
- 25th / 75th Percentile: €40,000 / €80,000
""", regional: _html({}, (company,)), company: _html(_company_props())}
        calls, targets_seen = [], []
        settings = tmp_path / "settings.json"
        settings.write_text(json.dumps({"compensation_sources": {
            "levels_fyi": {"enabled": True, "access_mode": "public_markdown"},
        }}))
        def fetch(url):
            calls.append(url)
            return pages.get(url)
        monkeypatch.setattr(market, "_levels_fyi_public_fetcher", lambda *_, **__: fetch)
        def load(targets):
            targets_seen.extend(targets)
            return market.load_default_reported_compensation_observations(levels_fyi_targets=targets,
                include_eurotoptech=False, env={}, settings_path=settings, levels_fyi_public_max_pages=2)
        if path == "explicit":
            monkeypatch.setattr(refresh, "get_connection", lambda: conn)
            monkeypatch.setattr(refresh, "load_default_reported_compensation_observations", lambda **kw: load(kw["levels_fyi_targets"]))
            refresh.refresh_compensation_facts(tenant_id="local", include_euro_top_tech=False)
            assert [target.role_title for target in targets_seen] == ["Software Engineer", "Principal Software Engineer"]
        else:
            now = "2026-08-12T08:00:00Z"
            run_automatic_compensation_refresh(conn, tenant_id="local", owner="source-loader", now=now,
                load_observations=load, load_fx_rates=lambda: (), load_price_levels=lambda: (), completion_clock=lambda: now)
            materialize_automatic_compensation_estimates(conn, tenant_id="local", materialized_at=now)
        estimate = market.SqliteMarketCompensationRepository(conn).get_estimate("local", principal_id)
        assert estimate is not None and estimate.estimate_state == "estimated_range"
        assert estimate.minimum_amount == estimate.maximum_amount == 160_000
        assert estimate.evidence[0].source_url == company.replace("/locations/", "/levels/principal/locations/")
        assert calls == [regional + ".md", regional, company + ".md", company]
        assert conn.execute("SELECT COUNT(*) FROM job_detail_projections WHERE job_id = ?", (principal_id,)).fetchone()[0] == 1
    finally:
        close_connection()
