from __future__ import annotations

import json

import pytest

from jobhunter.domain.compensation import PublicMarketBaseline, estimate_market_compensation


def _esco(*, score: float = 0.95) -> PublicMarketBaseline:
    return PublicMarketBaseline(
        source_id="esco_occupation_taxonomy",
        occupation_code="2512.1",
        occupation_label="Software developer",
        geography_scope="Europe",
        aggregate_bucket="ESCO software developer",
        minimum_amount=None,
        maximum_amount=None,
        release_year=2024,
        sample_count=None,
        attribution="ESCO public occupation taxonomy",
        occupation_match_score=score,
    )


def _eurostat(
    *,
    minimum: int = 72_000,
    maximum: int = 92_000,
    sample_count: int | None = 900,
    release_year: int = 2024,
    geography_scope: str = "EU",
    occupation_score: float = 0.9,
    seniority_score: float = 0.82,
    component: str = "base_salary",
    period: str = "year",
    aggregate_bucket: str = "Eurostat SES occupation/country aggregate",
    attribution: str = "Eurostat public statistical aggregate",
    snapshot_version: str = "synthetic-public-fixture",
) -> PublicMarketBaseline:
    return PublicMarketBaseline(
        source_id="eurostat_structure_of_earnings",
        occupation_code="2512.1",
        occupation_label="Software developer",
        geography_scope=geography_scope,
        aggregate_bucket=aggregate_bucket,
        minimum_amount=minimum,
        maximum_amount=maximum,
        release_year=release_year,
        snapshot_version=snapshot_version,
        sample_count=sample_count,
        attribution=attribution,
        occupation_match_score=occupation_score,
        seniority_match_score=seniority_score,
        component=component,  # type: ignore[arg-type]
        period=period,  # type: ignore[arg-type]
    )


def _ine(
    *,
    minimum: int = 76_000,
    maximum: int = 96_000,
    sample_count: int | None = 800,
    release_year: int = 2025,
) -> PublicMarketBaseline:
    return PublicMarketBaseline(
        source_id="spain_ine_salary_structure",
        occupation_code="2512.1",
        occupation_label="Software developer",
        geography_scope="Spain",
        aggregate_bucket="INE software occupation Spain aggregate",
        minimum_amount=minimum,
        maximum_amount=maximum,
        release_year=release_year,
        sample_count=sample_count,
        attribution="INE public statistical aggregate",
        occupation_match_score=0.92,
        seniority_match_score=0.84,
    )


def test_estimates_spain_local_range_preferring_ine_baseline() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/platform",
        title="Senior Platform Engineer",
        location="Madrid, Spain",
        component="base_salary",
        baselines=(_esco(), _eurostat(), _ine()),
        posted_annualized_minimum=70_000,
        posted_annualized_maximum=95_000,
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.currency == "EUR"
    assert estimate.minimum_amount == 76_000
    assert estimate.maximum_amount == 96_000
    assert estimate.confidence_band in {"medium", "high"}
    assert estimate.geography_scope == "spain"
    assert estimate.source_count == 1
    assert estimate.sample_count == 800
    assert "spain_local_assumption" in estimate.warnings
    assert "aggregate_baseline" in estimate.warnings
    assert {source.source_id for source in estimate.sources} == {
        "spain_ine_salary_structure",
        "esco_occupation_taxonomy",
    }


def test_eu_wide_estimate_uses_eurostat_aggregate_warning() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/eu",
        title="Software Developer",
        location="Remote Europe",
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.minimum_amount == 72_000
    assert estimate.maximum_amount == 92_000
    assert "remote_europe_assumption" in estimate.warnings
    assert "aggregate_baseline" in estimate.warnings


def test_esco_only_mapping_is_insufficient_because_it_has_no_salary_observation() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/esco",
        title="Software Developer",
        location="Remote Europe",
        baselines=(_esco(),),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None
    assert "missing_salary_observation" in estimate.insufficient_reasons


@pytest.mark.parametrize(
    ("location", "expected_warning"),
    [
        ("Zurich, Switzerland", "non_eu_europe_assumption"),
        ("", "unknown_location_assumption"),
    ],
)
def test_location_assumptions_are_explicit(location: str, expected_warning: str) -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/location",
        title="Software Developer",
        location=location,
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert expected_warning in estimate.warnings
    if location == "":
        assert estimate.estimate_state == "insufficient_evidence"
        assert estimate.minimum_amount is None


def test_known_non_europe_location_is_unsupported() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/us",
        title="Software Developer",
        location="San Francisco, United States",
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "unsupported"
    assert "unsupported_geography" in estimate.unsupported_reasons
    assert estimate.minimum_amount is None


@pytest.mark.parametrize("location", ["Eugene, Oregon", "Eureka, California"])
def test_eu_substrings_do_not_count_as_europe(location: str) -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/substrings",
        title="Software Developer",
        location=location,
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.geography_scope == "unknown"
    assert "unknown_location_assumption" in estimate.warnings
    assert estimate.minimum_amount is None


def test_europe_country_names_do_not_match_us_substrings() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/austria",
        title="Software Developer",
        location="Vienna, Austria",
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.geography_scope == "eu_wide"
    assert "unsupported_geography" not in estimate.unsupported_reasons


@pytest.mark.parametrize("component", ["ote", "equity", "bonus", "commission"])
def test_unsupported_components_never_emit_range(component: str) -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/component",
        title="Software Developer",
        location="Remote Europe",
        component=component,
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "unsupported"
    assert "unsupported_component" in estimate.unsupported_reasons
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None


def test_supported_component_requires_matching_baseline_component_and_period() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/component-mismatch",
        title="Software Developer",
        location="Remote Europe",
        component="gross_monthly_salary",
        baselines=(_esco(), _eurostat()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert "weak_component_match" in estimate.insufficient_reasons
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None


def test_supported_monthly_component_uses_matching_monthly_baseline() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/monthly",
        title="Software Developer",
        location="Remote Europe",
        component="gross_monthly_salary",
        baselines=(
            _esco(),
            _eurostat(minimum=6_000, maximum=8_000, component="gross_monthly_salary", period="month"),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.component == "gross_monthly_salary"
    assert estimate.period == "month"
    assert estimate.minimum_amount == 6_000
    assert estimate.maximum_amount == 8_000


def test_stale_source_snapshot_is_source_unavailable() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/stale",
        title="Software Developer",
        location="Remote Europe",
        baselines=(_esco(), _eurostat(release_year=2019)),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "source_unavailable"
    assert "stale_source_snapshot" in estimate.source_unavailable_reasons
    assert "stale_source_snapshot" in estimate.warnings
    assert estimate.minimum_amount is None


def test_low_sample_count_degrades_to_insufficient_evidence() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/low-sample",
        title="Software Developer",
        location="Remote Europe",
        baselines=(_esco(), _eurostat(sample_count=120)),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert "low_sample_count" in estimate.insufficient_reasons
    assert "low_sample_count" in estimate.warnings
    assert estimate.minimum_amount is None


def test_source_dispersion_degrades_to_insufficient_evidence() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/dispersion",
        title="Software Developer",
        location="Remote Europe",
        baselines=(
            _esco(),
            _eurostat(minimum=70_000, maximum=90_000),
            _ine(minimum=120_000, maximum=150_000),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert "source_dispersion_too_high" in estimate.insufficient_reasons
    assert "broad_aggregate_band" in estimate.warnings
    assert estimate.minimum_amount is None


def test_broad_range_and_posted_conflict_are_warnings_only() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/conflict",
        title="Software Developer",
        location="Remote Europe",
        baselines=(_esco(), _eurostat(minimum=60_000, maximum=95_000)),
        posted_annualized_minimum=150_000,
        posted_annualized_maximum=180_000,
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.minimum_amount == 60_000
    assert "broad_aggregate_band" in estimate.warnings
    assert "source_conflict_with_posted_salary" in estimate.warnings


def test_rejects_unlicensed_and_non_european_source_ids_without_serializing_them() -> None:
    bad_source = PublicMarketBaseline(  # type: ignore[arg-type]
        source_id="glassdoor",
        occupation_code="2512.1",
        occupation_label="Software developer",
        geography_scope="United States",
        aggregate_bucket="US private page",
        minimum_amount=100_000,
        maximum_amount=140_000,
        attribution="/Users/local/rawProviderPayload",
    )
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/bad-source",
        title="Software Developer",
        location="Remote Europe",
        baselines=(_esco(), bad_source),
        estimated_at="2026-06-19T10:00:00Z",
    )

    serialized = json.dumps(estimate, default=lambda value: getattr(value, "__dict__", str(value)))
    assert estimate.estimate_state == "unsupported"
    assert "unsupported_source" in estimate.unsupported_reasons
    assert estimate.sources == ()
    assert "glassdoor" not in serialized.lower()
    assert "levels" not in serialized.lower()
    assert "rawproviderpayload" not in serialized.lower()
    assert "/users/" not in serialized.lower()


def test_allowed_source_free_text_is_sanitized_before_serialization() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/sanitized-source",
        title="Software Developer",
        location="Remote Europe",
        baselines=(
            _esco(),
            _eurostat(
                aggregate_bucket="/Users/local/rawProviderPayload Glassdoor BLS SOC",
                attribution="credential secret token file:///Users/local/private",
                snapshot_version="rawProviderPayload",
            ),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    serialized = json.dumps(estimate, default=lambda value: getattr(value, "__dict__", str(value))).casefold()
    assert estimate.estimate_state == "estimated_range"
    assert {source.source_id for source in estimate.sources} == {
        "eurostat_structure_of_earnings",
        "esco_occupation_taxonomy",
    }
    assert "glassdoor" not in serialized
    assert "levels" not in serialized
    assert "bls" not in serialized
    assert "soc" not in serialized
    assert "rawproviderpayload" not in serialized
    assert "credential" not in serialized
    assert "secret" not in serialized
    assert "/users/" not in serialized


def test_allowed_source_with_non_europe_geography_is_rejected() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/us-baseline",
        title="Software Developer",
        location="Remote Europe",
        baselines=(
            _esco(),
            _eurostat(
                geography_scope="United States",
                aggregate_bucket="BLS SOC software developer",
                attribution="US source payload",
            ),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    serialized = json.dumps(estimate, default=lambda value: getattr(value, "__dict__", str(value))).casefold()
    assert estimate.estimate_state == "unsupported"
    assert "unsupported_source" in estimate.unsupported_reasons
    assert estimate.sources == ()
    assert "united states" not in serialized
    assert "bls" not in serialized
    assert "soc" not in serialized
