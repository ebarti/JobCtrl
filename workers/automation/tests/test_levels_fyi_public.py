from __future__ import annotations

import json

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
        return markdown

    observations = load_levels_fyi_public_observations(
        [LevelsFyiPublicTarget("Senior Software Engineer", "Madrid, Spain")],
        fetch_text=fetch,
    )

    assert calls == ["https://www.levels.fyi/t/software-engineer/locations/madrid-esp.md"]
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
