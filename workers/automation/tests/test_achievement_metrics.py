"""Achievement-scoped metric extraction for Candidate Profile evidence."""

from __future__ import annotations

from jobctrl.domain.profile.achievement_metrics import extract_achievement_metrics


def test_extracts_currency_percentage_and_budget_magnitude_from_one_achievement() -> None:
    assert extract_achievement_metrics(
        "Reduced synthetic warehouse energy spend by £240k (12%) against a £2M+ budget."
    ) == ("£240k", "12%", "£2M+")


def test_extracts_basis_points_scale_counts_and_latency_without_absorbing_dates() -> None:
    assert extract_achievement_metrics(
        "From 2018 to 2022, a synthetic fixture improved throughput by 875+ bps "
        "across 9 teams, handled 3.4M records, and cut latency to 85ms."
    ) == ("875+ bps", "9 teams", "3.4M records", "85ms")


def test_extracts_bare_numeric_claim_without_treating_years_as_metrics() -> None:
    assert extract_achievement_metrics(
        "From 2020 to 2024, reduced synthetic incident volume by 7."
    ) == ("7",)
