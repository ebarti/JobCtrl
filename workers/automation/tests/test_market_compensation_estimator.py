from __future__ import annotations

import pytest

from jobhunter.domain.compensation import ReportedCompensationObservation, estimate_market_compensation


def _levels(
    *,
    company: str = "Acme AI",
    role: str = "Senior Platform Engineer",
    minimum: int = 118_000,
    maximum: int = 142_000,
    level: str = "Senior",
    tier: str = "tier_2_ambitious",
    sample_count: int = 4,
    release_year: int = 2026,
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        company_name=company,
        role_title=role,
        level_label=level,
        company_tier=tier,  # type: ignore[arg-type]
        location="Remote Europe",
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=sample_count,
        release_year=release_year,
        attribution="Levels.fyi reported compensation data",
    )


def _glassdoor(
    *,
    company: str = "Acme AI",
    role: str = "Senior Software Engineer",
    minimum: int = 112_000,
    maximum: int = 136_000,
    sample_count: int = 3,
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="glassdoor",
        company_name=company,
        role_title=role,
        level_label="Senior",
        company_tier="tier_2_ambitious",
        location="Madrid, Spain",
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=sample_count,
        attribution="Glassdoor reported compensation data",
    )


def test_estimates_exact_company_role_from_reported_levels_and_glassdoor_rows() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/platform",
        company="Acme AI Ltd.",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(), _glassdoor(role="Senior Platform Engineer")),
        posted_annualized_minimum=100_000,
        posted_annualized_maximum=135_000,
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.component == "total_compensation"
    assert estimate.currency == "EUR"
    assert estimate.minimum_amount == 112_000
    assert estimate.maximum_amount == 142_000
    assert estimate.company_name == "Acme AI Ltd."
    assert estimate.normalized_company == "acme ai"
    assert estimate.normalized_role == "platform engineer"
    assert estimate.company_tier == "tier_2_ambitious"
    assert estimate.match_scope == "exact_company_role"
    assert estimate.source_count == 2
    assert estimate.sample_count == 7
    assert {source.source_id for source in estimate.sources} == {"levels_fyi", "glassdoor"}
    assert "reported_compensation_sample" in estimate.warnings
    assert "company_role_fallback" not in estimate.warnings


def test_estimates_company_adjacent_role_with_explicit_fallback_warning() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/backend",
        company="Acme AI",
        title="Senior Backend Engineer",
        location="Remote Europe",
        observations=(_levels(role="Senior Platform Engineer"), _glassdoor(role="Senior Software Engineer")),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.match_scope == "company_adjacent_role"
    assert "company_role_fallback" in estimate.warnings


def test_company_role_observations_are_required_before_estimating() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/missing",
        company="Different Company",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(company="Acme AI"), _glassdoor(company="OtherCo")),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None
    assert "missing_reported_observation" in estimate.insufficient_reasons


def test_missing_company_is_insufficient_instead_of_location_title_estimation() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/no-company",
        company="",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(), _glassdoor()),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert "missing_company" in estimate.insufficient_reasons
    assert estimate.minimum_amount is None


def test_stale_reported_sources_are_source_unavailable() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/stale",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(release_year=2020),),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "source_unavailable"
    assert "stale_source_snapshot" in estimate.source_unavailable_reasons
    assert estimate.minimum_amount is None


def test_unsupported_components_never_emit_range() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/component",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        component="equity",
        observations=(_levels(),),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "unsupported"
    assert "unsupported_component" in estimate.unsupported_reasons
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None


@pytest.mark.parametrize(
    ("posted_min", "posted_max", "expected_warning"),
    [
        (70_000, 80_000, "source_conflict_with_posted_salary"),
        (110_000, 140_000, None),
    ],
)
def test_posted_salary_conflict_is_explicit(
    posted_min: int,
    posted_max: int,
    expected_warning: str | None,
) -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/conflict",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(), _glassdoor(role="Senior Platform Engineer")),
        posted_annualized_minimum=posted_min,
        posted_annualized_maximum=posted_max,
        estimated_at="2026-06-19T10:00:00Z",
    )

    if expected_warning is None:
        assert "source_conflict_with_posted_salary" not in estimate.warnings
    else:
        assert expected_warning in estimate.warnings
