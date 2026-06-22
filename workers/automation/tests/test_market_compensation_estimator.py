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
    location: str = "Remote Europe",
    sample_count: int = 4,
    release_year: int = 2026,
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="levels_fyi",
        company_name=company,
        role_title=role,
        level_label=level,
        company_tier=tier,  # type: ignore[arg-type]
        location=location,
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=sample_count,
        release_year=release_year,
        attribution="Levels.fyi reported compensation data",
        source_url="https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
    )


def _glassdoor(
    *,
    company: str = "Acme AI",
    role: str = "Senior Software Engineer",
    minimum: int = 112_000,
    maximum: int = 136_000,
    level: str = "Senior",
    tier: str = "tier_2_ambitious",
    location: str = "Madrid, Spain",
    sample_count: int = 3,
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="glassdoor",
        company_name=company,
        role_title=role,
        level_label=level,
        company_tier=tier,  # type: ignore[arg-type]
        location=location,
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=sample_count,
        attribution="Glassdoor reported compensation data",
        source_url="https://www.glassdoor.com/Salary/Acme-AI-Senior-Software-Engineer-Salaries.htm",
    )


def _euro_top_tech(
    *,
    company: str = "Euro Top Tech community",
    role: str = "Chief Product Officer",
    minimum: int = 315_000,
    maximum: int = 315_000,
    level: str = "Executive",
    location: str = "Amsterdam, Netherlands",
    sample_count: int = 1,
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="euro_top_tech",
        company_name=company,
        role_title=role,
        level_label=level,
        company_tier="unknown",
        location=location,
        minimum_amount=minimum,
        maximum_amount=maximum,
        sample_count=sample_count,
        attribution="Euro Top Tech public crowdsourced compensation data",
        source_url="https://www.eurotoptech.com/data",
    )


def _posted_salary(
    *,
    company: str = "Novartis",
    role: str = "Director Digital Trust Platforms",
    minimum: int = 84_400,
    maximum: int = 156_800,
    location: str = "Barcelona, Spain",
) -> ReportedCompensationObservation:
    return ReportedCompensationObservation(
        source_id="posted_salary_text",
        company_name=company,
        role_title=role,
        level_label=None,
        company_tier="unknown",
        location=location,
        minimum_amount=minimum,
        maximum_amount=maximum,
        currency="EUR",
        period="year",
        component="base_salary",
        sample_count=1,
        attribution="Employer-posted salary text captured by JobHunter",
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
    assert estimate.confidence_interval_minimum_amount is not None
    assert estimate.confidence_interval_minimum_amount < estimate.minimum_amount
    assert estimate.confidence_interval_maximum_amount is not None
    assert estimate.confidence_interval_maximum_amount > estimate.maximum_amount
    assert estimate.company_name == "Acme AI Ltd."
    assert estimate.normalized_company == "acme ai"
    assert estimate.normalized_role == "platform engineer"
    assert estimate.company_tier == "tier_2_ambitious"
    assert estimate.match_scope == "exact_company_role"
    assert estimate.source_count == 2
    assert estimate.sample_count == 7
    assert {source.source_id for source in estimate.sources} == {"levels_fyi", "glassdoor"}
    assert len(estimate.evidence) == 2
    evidence_ranges = {(row.minimum_amount, row.maximum_amount) for row in estimate.evidence}
    assert evidence_ranges == {(118_000, 142_000), (112_000, 136_000)}
    assert {row.company_name for row in estimate.evidence} == {"Acme AI"}
    assert {row.role_title for row in estimate.evidence} == {"Senior Platform Engineer"}
    assert {row.source_url for row in estimate.evidence} == {
        "https://www.glassdoor.com/Salary/Acme-AI-Senior-Software-Engineer-Salaries.htm",
        "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
    }
    assert all(row.company_score == 1 for row in estimate.evidence)
    assert all(row.role_score >= 0.95 for row in estimate.evidence)
    assert "reported_compensation_sample" in estimate.warnings
    assert "company_role_fallback" not in estimate.warnings


def test_executive_titles_use_executive_baseline_not_staff_plus_fallback() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/cto",
        company="Different Company",
        title="CTO (Chief Technology Officer)",
        location="Spain (Remote)",
        observations=(
            _euro_top_tech(role="Chief Product Officer", minimum=315_000, maximum=315_000),
            _euro_top_tech(company="US based startup", role="COO", minimum=175_000, maximum=175_000, location="Prague, Czechia"),
            _euro_top_tech(role="Staff Software Engineer", level="Staff / Engineering Manager", minimum=147_000, maximum=147_000),
            _euro_top_tech(role="Principal / Director Software Engineer", level="Principal / Director", minimum=350_000, maximum=350_000),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.match_scope == "market_baseline_fallback"
    assert estimate.seniority_label == "executive"
    assert estimate.minimum_amount == 175_000
    assert estimate.maximum_amount == 315_000
    assert estimate.confidence_band == "low"
    assert "company_role_fallback" in estimate.warnings


def test_executive_titles_do_not_use_staff_plus_posted_salary_fallback() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/cto-posted",
        company="Different Company",
        title="Chief Technology Officer (CTO)",
        location="Spain (Remote)",
        observations=(
            _posted_salary(role="Director Digital Trust Platforms", minimum=84_400, maximum=156_800),
            _posted_salary(role="Principal Engineer", minimum=80_000, maximum=100_000),
            _posted_salary(role="Staff Software Engineer", minimum=120_000, maximum=120_000),
        ),
        component="base_salary",
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "insufficient_evidence"
    assert estimate.minimum_amount is None
    assert estimate.maximum_amount is None


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


def test_estimates_trimodal_tier_role_fallback_with_explicit_warning() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/trimodal-tier",
        company="Trimodal Labs",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(
            _levels(
                company="Trimodal Labs",
                role="Senior Product Manager",
                minimum=172_000,
                maximum=196_000,
                tier="tier_3_top_of_market",
                sample_count=4,
            ),
            _glassdoor(
                company="Peer TopCo",
                role="Senior Platform Engineer",
                minimum=168_000,
                maximum=190_000,
                tier="tier_3_top_of_market",
                sample_count=3,
            ),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.match_scope == "tier_role_fallback"
    assert estimate.aggregate_bucket == "trimodal tier role fallback"
    assert "company_role_fallback" in estimate.warnings


def test_infers_trimodal_tier_from_reported_compensation_midpoint() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/inferred-tier",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(
            _levels(role="Senior Platform Engineer", tier="unknown", minimum=128_000, maximum=152_000),
            _glassdoor(role="Senior Platform Engineer", tier="unknown", minimum=122_000, maximum=146_000),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.match_scope == "exact_company_role"
    assert estimate.company_tier != "unknown"
    assert "trimodal_tier_inferred" in estimate.warnings
    assert any(factor.name == "trimodal_tier" for factor in estimate.factors)


def test_weak_market_factors_emit_low_confidence_ranges_with_wider_intervals() -> None:
    low_sample = estimate_market_compensation(
        job_url="https://example.com/jobs/low-sample",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(role="Senior Platform Engineer", sample_count=1),),
        estimated_at="2026-06-19T10:00:00Z",
    )

    weak_level = estimate_market_compensation(
        job_url="https://example.com/jobs/weak-level",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(
            _levels(role="Senior Platform Engineer", level="Junior"),
            _glassdoor(role="Senior Platform Engineer", level="Junior"),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    weak_location = estimate_market_compensation(
        job_url="https://example.com/jobs/weak-location",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(
            _levels(role="Senior Platform Engineer", location="San Francisco, CA"),
            _glassdoor(role="Senior Platform Engineer", location="Austin, TX"),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    source_dispersion = estimate_market_compensation(
        job_url="https://example.com/jobs/source-dispersion",
        company="Acme AI",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(
            _levels(role="Senior Platform Engineer", minimum=82_000, maximum=94_000),
            _glassdoor(role="Senior Platform Engineer", minimum=178_000, maximum=214_000),
        ),
        estimated_at="2026-06-19T10:00:00Z",
    )

    for estimate in (low_sample, weak_level, weak_location, source_dispersion):
        assert estimate.estimate_state == "estimated_range"
        assert estimate.confidence_band == "low"
        assert estimate.minimum_amount is not None
        assert estimate.maximum_amount is not None
        assert estimate.confidence_interval_minimum_amount is not None
        assert estimate.confidence_interval_minimum_amount < estimate.minimum_amount
        assert estimate.confidence_interval_maximum_amount is not None
        assert estimate.confidence_interval_maximum_amount > estimate.maximum_amount

    assert "low_sample_count" in low_sample.warnings
    assert any(factor.name == "sample" for factor in low_sample.factors)

    assert any(factor.name == "level" for factor in weak_level.factors)

    assert "location_mismatch" in weak_location.warnings
    assert any(factor.name == "location" for factor in weak_location.factors)

    assert any(factor.name == "agreement" for factor in source_dispersion.factors)


def test_same_location_role_fallback_estimates_when_company_role_is_missing() -> None:
    estimate = estimate_market_compensation(
        job_url="https://example.com/jobs/missing",
        company="Different Company",
        title="Senior Platform Engineer",
        location="Remote Europe",
        observations=(_levels(company="Acme AI"), _glassdoor(company="OtherCo")),
        estimated_at="2026-06-19T10:00:00Z",
    )

    assert estimate.estimate_state == "estimated_range"
    assert estimate.match_scope == "same_location_role_fallback"
    assert estimate.minimum_amount == 112_000
    assert estimate.maximum_amount == 142_000
    assert estimate.confidence_band == "low"
    assert estimate.confidence_interval_minimum_amount is not None
    assert estimate.confidence_interval_minimum_amount < estimate.minimum_amount
    assert "company_role_fallback" in estimate.warnings


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
