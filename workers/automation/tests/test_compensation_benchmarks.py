from __future__ import annotations

from dataclasses import replace

import pytest

from jobctrl.domain.compensation import (
    BenchmarkGeography,
    CompanyBenchmarkPair,
    ReportedCompensationObservation,
    build_direct_benchmark_fact,
    build_price_level_fact,
    classify_role,
    extrapolate_benchmark,
    resolve_benchmark_geography,
    resolve_country_code,
)
from jobctrl.infrastructure.compensation import (
    FxRateToEur,
    canonicalize_reported_observations,
)


def test_role_and_country_classification_is_deterministic() -> None:
    security = classify_role("Staff Application Security Engineer")
    assert security.role_family_code == "security_privacy"
    assert security.seniority_label == "staff"

    data = classify_role("Senior Data Engineer")
    assert data.role_family_code == "data_ai"
    assert data.seniority_label == "senior"

    platform = classify_role("Principal Platform Engineer")
    assert platform.role_family_code == "infrastructure_platform"
    assert platform.seniority_label == "principal"

    assert resolve_country_code("Remote — Barcelona, Spain") == "ES"
    assert resolve_country_code("London / UK") == "GB"
    assert resolve_country_code("Remote") is None
    assert resolve_benchmark_geography("Madrid, Spain") == BenchmarkGeography(
        "ES",
        scope="locality",
        locality="Madrid",
    )
    assert resolve_benchmark_geography("Remote - Spain") == BenchmarkGeography("ES")


def test_reported_observations_become_content_addressed_direct_facts() -> None:
    observation = ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="licensed",
        company_name="Acme GmbH",
        role_title="Senior Platform Engineer",
        minimum_amount=8_000,
        maximum_amount=10_000,
        currency="USD",
        period="month",
        component="total_compensation",
        location="Berlin, Germany",
        level_label="Senior",
        release_year=2026,
        snapshot_version="levels-2026-08",
        sample_count=10,
        attribution="Licensed compensation data",
        source_url="https://example.com/levels/acme",
    )
    fx = FxRateToEur(
        currency="USD",
        rate=0.9,
        source_id="ecb",
        reference_id="ecb-2026-08-12",
        as_of_date="2026-08-12",
    )

    first = canonicalize_reported_observations(
        (observation,),
        tenant_id="local",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
        fx_rates_to_eur=(fx,),
    )
    second = canonicalize_reported_observations(
        (observation,),
        tenant_id="local",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
        fx_rates_to_eur=(fx,),
    )

    assert first.rejected == ()
    assert first == second
    fact = first.facts[0]
    assert fact.role_family_code == "infrastructure_platform"
    assert fact.seniority_label == "senior"
    assert fact.geography == BenchmarkGeography("DE", scope="locality", locality="Berlin")
    assert fact.normalized_company == "acme"
    assert fact.eur_annual_minimum_amount == 86_400
    assert fact.eur_annual_maximum_amount == 108_000
    assert fact.fx_reference["reference_id"] == "ecb-2026-08-12"


def test_posted_salary_is_rejected_from_direct_market_authority() -> None:
    posted = ReportedCompensationObservation(
        source_id="posted_salary_text",
        source_provenance="employer_posted",
        company_name="Acme",
        role_title="Senior Software Engineer",
        minimum_amount=80_000,
        maximum_amount=100_000,
        location="Spain",
        component="base_salary",
    )

    result = canonicalize_reported_observations(
        (posted,),
        tenant_id="local",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )

    assert result.facts == ()
    assert result.rejected[0].reason == "employer_posted_is_not_market_evidence"


def test_invalid_observation_does_not_discard_independent_valid_evidence() -> None:
    invalid = ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name="Levels.fyi market aggregate",
        role_title="Senior Software Engineer",
        minimum_amount=80_000,
        maximum_amount=100_000,
        location="Spain",
        level_label="Senior",
        snapshot_version="/tmp/private-feed.json",
        attribution="Data source: Levels.fyi (https://www.levels.fyi)",
        source_url="https://www.levels.fyi/t/software-engineer",
    )
    valid = replace(invalid, snapshot_version="levels-public-2026")

    result = canonicalize_reported_observations(
        (invalid, valid),
        tenant_id="local",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )

    assert len(result.facts) == 1
    assert result.rejected[0].reason == "invalid_observation"


@pytest.mark.parametrize(
    "location",
    (
        r"C:\Users\alice\private-salary.csv, Spain",
        "/tmp/private-salary.csv, Spain",
        "./private-salary.csv, Spain",
        "https://private.example/Spain",
        f"{'A' * 129}, Spain",
    ),
)
def test_local_or_unbounded_geography_is_rejected_from_canonical_facts(
    location: str,
) -> None:
    observation = ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name="Levels.fyi market aggregate",
        role_title="Senior Software Engineer",
        minimum_amount=80_000,
        maximum_amount=100_000,
        location=location,
        level_label="Senior",
        snapshot_version="levels-public-2026",
        attribution="Data source: Levels.fyi (https://www.levels.fyi)",
        source_url="https://www.levels.fyi/t/software-engineer",
    )

    result = canonicalize_reported_observations(
        (observation,),
        tenant_id="local",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )

    assert result.facts == ()
    assert result.rejected[0].reason == "invalid_observation"


def test_direct_fact_builder_enforces_authority_and_public_provenance() -> None:
    with pytest.raises(ValueError, match="posted compensation authority"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            source_provenance="employer_posted",
        )
    with pytest.raises(ValueError, match="posted compensation authority"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            source_id="posted_salary_text",
        )
    for local_url in (
        "http://127.0.0.1/private-snapshot",
        "http://127.1/private-snapshot",
        "http://localhost./private-snapshot",
        "http://foo.local./private-snapshot",
    ):
        with pytest.raises(ValueError, match="public host"):
            _direct_fact(
                country="ES",
                minimum=80_000,
                maximum=100_000,
                source_url=local_url,
            )


@pytest.mark.parametrize(
    "local_path",
    (
        r"C:\work\compensation-feed.json",
        "/tmp/compensation-feed.json",
        "/Volumes/private-disk/compensation-feed.json",
        "./local-feed.json",
        "../local-feed.json",
        "~/local-feed.json",
        r"\\server\share\compensation-feed.json",
    ),
)
def test_direct_fact_rejects_local_path_provenance(local_path: str) -> None:
    with pytest.raises(ValueError, match="local filesystem path"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            source_snapshot_id=local_path,
        )
    with pytest.raises(ValueError, match="local filesystem path"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            source_id=local_path,
        )


def test_direct_fact_metadata_is_deeply_immutable_and_content_addressed() -> None:
    fact = _direct_fact(
        country="ES",
        minimum=80_000,
        maximum=100_000,
        fx_reference={
            "rate_to_eur": 1,
            "provider": {"reference_id": "eur-identity"},
        },
    )

    with pytest.raises(TypeError):
        fact.fx_reference["api_key"] = "must-not-persist"  # type: ignore[index]
    with pytest.raises(TypeError):
        fact.fx_reference["provider"]["api_key"] = "must-not-persist"  # type: ignore[index]
    with pytest.raises(ValueError, match="evidence_hash"):
        replace(fact, fx_reference={"rate_to_eur": 2})


def test_benchmark_temporal_fields_are_canonical_and_ordered() -> None:
    fact = _direct_fact(country="ES", minimum=80_000, maximum=100_000)
    assert fact.fetched_at == "2026-08-12T08:00:00.000000Z"
    assert fact.fresh_until == "2026-08-19T08:00:00.000000Z"

    with pytest.raises(ValueError, match="ISO 8601 timestamp"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            fetched_at="not-a-timestamp",
        )
    with pytest.raises(ValueError, match="must not be before fetched_at"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            fresh_until="2026-08-11T08:00:00Z",
        )
    with pytest.raises(ValueError, match="must not be after fetched_at"):
        _direct_fact(
            country="ES",
            minimum=80_000,
            maximum=100_000,
            as_of_date="2026-08-13",
        )


def test_cost_of_living_only_extrapolation_is_always_low_confidence() -> None:
    anchor = _direct_fact(country="DE", minimum=80_000, maximum=100_000)
    source_price = _price_fact(country="DE", index=100, marker="de")
    target_price = _price_fact(country="ES", index=80, marker="es")

    result = extrapolate_benchmark(
        anchor=anchor,
        target_geography=BenchmarkGeography("ES"),
        source_price_level=source_price,
        target_price_level=target_price,
        derived_at="2026-08-12T09:00:00Z",
    )

    assert result.raw_factor == 0.8
    assert (result.minimum_amount, result.maximum_amount) == (64_000, 80_000)
    assert result.confidence_band == "low"
    assert result.confidence_score == 0.3
    assert result.warnings == ("cost_of_living_only",)
    assert result.is_actionable is True
    assert {item.input_role for item in result.price_inputs} == {
        "source_price_level",
        "target_price_level",
    }


def test_same_company_country_ratios_shrink_toward_cost_of_living() -> None:
    anchor = _direct_fact(country="DE", minimum=80_000, maximum=100_000)
    pairs = (
        CompanyBenchmarkPair(
            source=_direct_fact(
                country="DE",
                minimum=100_000,
                maximum=100_000,
                company="acme",
                marker="acme-de",
            ),
            target=_direct_fact(
                country="ES",
                minimum=80_000,
                maximum=80_000,
                company="acme",
                marker="acme-es",
            ),
        ),
        CompanyBenchmarkPair(
            source=_direct_fact(
                country="DE",
                minimum=100_000,
                maximum=100_000,
                company="globex",
                marker="globex-de",
            ),
            target=_direct_fact(
                country="ES",
                minimum=90_000,
                maximum=90_000,
                company="globex",
                marker="globex-es",
            ),
        ),
    )

    result = extrapolate_benchmark(
        anchor=anchor,
        target_geography=BenchmarkGeography("ES"),
        source_price_level=_price_fact(country="DE", index=100, marker="de"),
        target_price_level=_price_fact(country="ES", index=70, marker="es"),
        company_pairs=pairs,
        derived_at="2026-08-12T09:00:00Z",
    )

    assert 0.7 < result.raw_factor < 0.85
    assert 0 < result.shrinkage_weight < 1
    assert result.matched_company_count == 2
    assert result.confidence_band == "medium"
    assert "limited_matched_company_evidence" in result.warnings
    assert len(result.direct_inputs) == 5


def test_company_ratio_inputs_require_exact_geographies_and_one_tenant() -> None:
    with pytest.raises(ValueError, match="same tenant"):
        CompanyBenchmarkPair(
            source=_direct_fact(
                country="DE",
                minimum=100_000,
                maximum=100_000,
                company="acme",
                marker="acme-de",
            ),
            target=_direct_fact(
                country="ES",
                minimum=80_000,
                maximum=80_000,
                company="acme",
                marker="acme-es",
                tenant_id="other",
            ),
        )

    pair = CompanyBenchmarkPair(
        source=_direct_fact(
            country="DE",
            geography=BenchmarkGeography("DE", scope="locality", locality="Munich"),
            minimum=100_000,
            maximum=100_000,
            company="acme",
            marker="acme-munich",
        ),
        target=_direct_fact(
            country="ES",
            geography=BenchmarkGeography("ES", scope="locality", locality="Barcelona"),
            minimum=80_000,
            maximum=80_000,
            company="acme",
            marker="acme-barcelona",
        ),
    )
    with pytest.raises(ValueError, match="extrapolation slice"):
        extrapolate_benchmark(
            anchor=_direct_fact(
                country="DE",
                geography=BenchmarkGeography("DE", scope="locality", locality="Berlin"),
                minimum=80_000,
                maximum=100_000,
            ),
            target_geography=BenchmarkGeography(
                "ES",
                scope="locality",
                locality="Madrid",
            ),
            source_price_level=_price_fact(country="DE", index=100, marker="de"),
            target_price_level=_price_fact(country="ES", index=80, marker="es"),
            company_pairs=(pair,),
            derived_at="2026-08-12T09:00:00Z",
        )


def test_out_of_bound_raw_range_is_visible_but_not_actionable() -> None:
    anchor = _direct_fact(country="DE", minimum=80_000, maximum=100_000)

    result = extrapolate_benchmark(
        anchor=anchor,
        target_geography=BenchmarkGeography("CH"),
        source_price_level=_price_fact(country="DE", index=1, marker="de"),
        target_price_level=_price_fact(country="CH", index=12, marker="ch"),
        derived_at="2026-08-12T09:00:00Z",
    )

    assert result.raw_factor == 12
    assert result.factor_bound_state == "above_upper_bound"
    assert result.bounded_factor == 10
    assert (result.minimum_amount, result.maximum_amount) == (960_000, 1_200_000)
    assert "factor_above_upper_bound" in result.warnings
    assert result.is_actionable is False
    with pytest.raises(ValueError, match="fact_id"):
        replace(result, minimum_amount=960_001)


def test_price_level_requires_a_finite_positive_index() -> None:
    for invalid in (float("inf"), float("-inf"), float("nan"), 0):
        with pytest.raises(ValueError, match="finite and positive"):
            _price_fact(country="ES", index=invalid, marker="invalid")


def test_fx_rate_requires_a_finite_positive_rate() -> None:
    for invalid in (float("inf"), float("-inf"), float("nan"), 0):
        with pytest.raises(ValueError, match="finite and positive"):
            FxRateToEur(
                currency="USD",
                rate=invalid,
                source_id="ecb",
                reference_id="ecb-2026-08-12",
                as_of_date="2026-08-12",
            )


def _direct_fact(
    *,
    country: str,
    minimum: int,
    maximum: int,
    company: str | None = None,
    marker: str = "anchor",
    geography: BenchmarkGeography | None = None,
    tenant_id: str = "local",
    source_id: str = "test-source",
    source_provenance: str = "manual",
    source_url: str | None = "https://example.com/source",
    source_snapshot_id: str | None = None,
    fx_reference: dict[str, object] | None = None,
    as_of_date: str = "2026-08-01",
    fetched_at: str = "2026-08-12T08:00:00Z",
    fresh_until: str = "2026-08-19T08:00:00Z",
):
    return build_direct_benchmark_fact(
        tenant_id=tenant_id,
        role_family_code="software_engineering",
        seniority_label="senior",
        geography=geography or BenchmarkGeography(country),
        market_scope="company" if company else "market",
        normalized_company=company,
        component="base_salary",
        original_currency="EUR",
        original_period="year",
        original_minimum_amount=minimum,
        original_maximum_amount=maximum,
        eur_annual_minimum_amount=minimum,
        eur_annual_maximum_amount=maximum,
        confidence_interval_minimum_amount=round(minimum * 0.9),
        confidence_interval_maximum_amount=round(maximum * 1.1),
        confidence_score=0.8,
        sample_count=10,
        source_id=source_id,
        source_provenance=source_provenance,  # type: ignore[arg-type]
        source_snapshot_id=source_snapshot_id or f"snapshot-{marker}",
        source_url=source_url,
        attribution="Test compensation evidence",
        fx_reference=fx_reference or {"rate_to_eur": 1, "reference_id": "eur-identity"},
        as_of_date=as_of_date,
        fetched_at=fetched_at,
        fresh_until=fresh_until,
    )


def _price_fact(*, country: str, index: float, marker: str):
    return build_price_level_fact(
        tenant_id="local",
        country_code=country,
        category="actual_individual_consumption",
        reference_year=2025,
        base_geography_code="EU27_2020=100",
        index_value=index,
        source_id="eurostat",
        source_snapshot_id=f"eurostat-{marker}",
        source_url="https://ec.europa.eu/eurostat/",
        attribution="Eurostat purchasing power parities",
        as_of_date="2025-12-31",
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )
