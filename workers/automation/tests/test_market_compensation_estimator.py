"""Compensation consumes model codes and keeps amount arithmetic mechanical."""

from dataclasses import replace
import pytest
from jobctrl.domain.compensation import estimate_market_compensation
from jobctrl.domain.determinations import DeterminationFailure
from tests.compensation_fakes import JOB, NOW, observation, classified_row
from tests.test_remaining_determinations import interpretation


def estimate(rows=(), **kwargs):
    return estimate_market_compensation(
        job_id=JOB,
        title="Synthetic role",
        company="Synthetic employer",
        location="Synthetic place",
        observations=rows,
        interpretation=interpretation(),
        estimated_at=NOW,
        **kwargs,
    )


def test_equal_codes_use_recorded_ranges_and_citations():
    rows = (
        classified_row(observation()),
        classified_row(replace(observation(minimum=70000, maximum=100000), source_id="glassdoor")),
    )
    result = estimate(rows)
    assert result.estimate_state == "estimated_range"
    assert (result.minimum_amount, result.maximum_amount, result.sample_count, result.source_count) == (
        60000,
        100000,
        40,
        2,
    )
    assert result.normalized_role == "software_engineering"
    assert [row.determination_id for row in result.evidence] == [row.determination_id for row in rows]
    assert (result.confidence_interval_minimum_amount, result.confidence_interval_maximum_amount) == (60000, 100000)


@pytest.mark.parametrize(
    "family,seniority,country",
    [
        ("sales", "senior", "ES"),
        ("software_engineering", "principal", "ES"),
        ("software_engineering", "senior", "DE"),
        ("unknown", "unknown", None),
    ],
)
def test_unequal_or_unknown_model_codes_cannot_supply_a_range(family, seniority, country):
    result = estimate((classified_row(observation(), family=family, seniority=seniority, country=country),))
    assert result.estimate_state == "insufficient_evidence"
    assert result.evidence == () and result.minimum_amount is None


def test_missing_classification_blocks_instead_of_interpreting_provider_text():
    with pytest.raises(DeterminationFailure, match="benchmark_classification_unavailable"):
        estimate((observation(),))


def test_unknown_sample_counts_remain_unknown():
    result = estimate((classified_row(replace(observation(), sample_count=None)),))
    assert result.sample_count is None and result.evidence[0].sample_count is None


def test_posted_pay_is_excluded_from_market_authority():
    result = estimate(
        (classified_row(replace(observation(), source_id="posted_salary_text", source_provenance="employer_posted")),)
    )
    assert result.estimate_state == "insufficient_evidence" and result.evidence == ()


@pytest.mark.parametrize("currency,period", [("USD", "year"), ("EUR", "month")])
def test_different_units_are_never_implicitly_converted(currency, period):
    result = estimate(
        (classified_row(observation()), classified_row(replace(observation(), currency=currency, period=period)))
    )
    assert result.estimate_state == "insufficient_evidence" and result.minimum_amount is None


def test_single_currency_and_period_preserve_the_original_amounts():
    result = estimate((classified_row(replace(observation(), currency="USD", period="month")),))
    assert (result.currency, result.period, result.minimum_amount, result.maximum_amount) == (
        "USD",
        "month",
        60000,
        90000,
    )


def test_company_identity_is_exact_canonical_text():
    row = classified_row(replace(observation(), company_name="Another employer"))
    result = estimate((row,))
    assert result.match_scope == "same_location_role_fallback" and result.evidence[0].company_score == 0


@pytest.mark.parametrize("minimum,maximum,conflict", [(60000, 90000, False), (1000, 2000, True)])
def test_posted_range_conflict_uses_amounts_only(minimum, maximum, conflict):
    result = estimate(
        (classified_row(observation()),), posted_annualized_minimum=minimum, posted_annualized_maximum=maximum
    )
    assert ("source_conflict_with_posted_salary" in result.warnings) == conflict
