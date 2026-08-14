from __future__ import annotations

import json
from collections.abc import Mapping

import pytest

from jobctrl.infrastructure.compensation.official_data import (
    ECB_DAILY_XML_URL,
    EUROSTAT_PRICE_LEVEL_ATTRIBUTION,
    EUROSTAT_PRICE_LEVEL_CATEGORY,
    EUROSTAT_PRICE_LEVEL_DATASET,
    EUROSTAT_PRICE_LEVEL_INDICATOR,
    eurostat_price_level_url,
    load_ecb_daily_exchange_rates,
    load_eurostat_actual_individual_consumption_price_levels,
    parse_ecb_daily_exchange_rates,
    parse_eurostat_actual_individual_consumption_price_levels,
)


def _ecb_payload(rates: Mapping[str, str]) -> str:
    cubes = "".join(f'<Cube currency="{currency}" rate="{rate}" />' for currency, rate in rates.items())
    return (
        '<Envelope xmlns="http://www.gesmes.org/xml/2002-08-01" '
        'xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" '
        'xmlns:eurofxref="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">'
        '<Cube><Cube time="2026-08-11">'
        f"{cubes}"
        "</Cube></Cube></Envelope>"
    )


def _eurostat_payload(
    *,
    geos: tuple[str, ...],
    values: tuple[float, ...],
) -> dict[str, object]:
    return {
        "version": "2.0",
        "class": "dataset",
        "id": ["freq", "indic_ppp", "ppp_cat18", "geo", "time"],
        "size": [1, 1, 1, len(geos), 1],
        "dimension": {
            "freq": {"category": {"index": {"A": 0}}},
            "indic_ppp": {"category": {"index": {"PLI_EU27_2020": 0}}},
            "ppp_cat18": {"category": {"index": {"A01": 0}}},
            "geo": {"category": {"index": {geo: index for index, geo in enumerate(geos)}}},
            "time": {"category": {"index": {"2025": 0}}},
        },
        "value": {str(index): value for index, value in enumerate(values)},
    }


def test_ecb_parser_inverts_quoted_currency_per_eur_rates_with_stable_provenance() -> None:
    payload = _ecb_payload({"USD": "1.2500", "GBP": "0.8000"})

    rates = parse_ecb_daily_exchange_rates(payload)

    assert [(rate.currency, rate.rate) for rate in rates] == [("GBP", 1.25), ("USD", 0.8)]
    assert all(rate.source_id == "ecb_daily_xml" for rate in rates)
    assert all(rate.as_of_date == "2026-08-11" for rate in rates)
    assert len({rate.reference_id for rate in rates}) == 1
    assert next(rate for rate in rates if rate.currency == "USD").reference_id.startswith(
        "ecb-eurofxref-daily-2026-08-11-"
    )


def test_ecb_loader_uses_only_the_official_fixed_url() -> None:
    requested: list[str] = []

    def fetch_text(url: str) -> str:
        requested.append(url)
        return _ecb_payload({"USD": "1.25"})

    rates = load_ecb_daily_exchange_rates(fetch_text=fetch_text)

    assert requested == [ECB_DAILY_XML_URL]
    assert rates[0].currency == "USD"


@pytest.mark.parametrize(
    "payload",
    (
        "<not-xml>",
        "<!DOCTYPE foo><foo />",
        _ecb_payload({"USD": "0"}),
        _ecb_payload({"USD": "NaN"}),
        _ecb_payload({"EUR": "1"}),
    ),
)
def test_ecb_parser_rejects_malformed_or_unsafe_values(payload: str) -> None:
    with pytest.raises(ValueError):
        parse_ecb_daily_exchange_rates(payload)


def test_eurostat_loader_parses_json_stat_country_facts_and_aliases() -> None:
    payload = _eurostat_payload(
        geos=("EL", "UK", "ES", "EU27_2020"),
        values=(84.5, 110.25, 91.75, 100.0),
    )
    requested: list[str] = []

    def fetch_json(url: str) -> Mapping[str, object]:
        requested.append(url)
        return payload

    facts = load_eurostat_actual_individual_consumption_price_levels(
        tenant_id="local",
        reference_year=2025,
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
        fetch_json=fetch_json,
    )

    assert requested == [eurostat_price_level_url(2025)]
    assert [(fact.country_code, fact.index_value) for fact in facts] == [
        ("ES", 91.75),
        ("GB", 110.25),
        ("GR", 84.5),
    ]
    assert all(fact.category == "actual_individual_consumption" for fact in facts)
    assert all(fact.reference_year == 2025 for fact in facts)
    assert all(fact.base_geography_code == "EU27_2020" for fact in facts)
    assert all(fact.source_id == "eurostat" for fact in facts)
    assert all(fact.attribution == EUROSTAT_PRICE_LEVEL_ATTRIBUTION for fact in facts)
    assert all(fact.as_of_date == "2025-12-31" for fact in facts)
    assert all(fact.fetched_at == "2026-08-12T08:00:00.000000Z" for fact in facts)
    assert all(fact.fresh_until == "2026-08-19T08:00:00.000000Z" for fact in facts)
    assert all(fact.source_snapshot_id.startswith("eurostat-prc_ppp_ind_1-2025-") for fact in facts)


def test_eurostat_parser_is_content_addressed_and_uses_the_fixed_query_contract() -> None:
    payload = _eurostat_payload(geos=("ES",), values=(91.75,))

    first = parse_eurostat_actual_individual_consumption_price_levels(
        json.dumps(payload),
        tenant_id="local",
        reference_year=2025,
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )
    second = parse_eurostat_actual_individual_consumption_price_levels(
        payload,
        tenant_id="local",
        reference_year=2025,
        fetched_at="2026-08-12T08:00:00Z",
        fresh_until="2026-08-19T08:00:00Z",
    )

    assert first == second
    fact = first[0]
    assert fact.source_url == eurostat_price_level_url(2025)
    assert EUROSTAT_PRICE_LEVEL_DATASET in fact.source_url
    assert f"indic_ppp={EUROSTAT_PRICE_LEVEL_INDICATOR}" in fact.source_url
    assert f"ppp_cat18={EUROSTAT_PRICE_LEVEL_CATEGORY}" in fact.source_url


@pytest.mark.parametrize(
    "payload",
    (
        {"id": [], "size": [], "dimension": {}, "value": {}},
        _eurostat_payload(geos=("ES",), values=(0,)),
        _eurostat_payload(geos=("ES",), values=(float("inf"),)),
        _eurostat_payload(geos=("ES",), values=(float("nan"),)),
    ),
)
def test_eurostat_parser_rejects_malformed_or_non_positive_country_values(
    payload: Mapping[str, object],
) -> None:
    with pytest.raises(ValueError):
        parse_eurostat_actual_individual_consumption_price_levels(
            payload,
            tenant_id="local",
            reference_year=2025,
            fetched_at="2026-08-12T08:00:00Z",
            fresh_until="2026-08-19T08:00:00Z",
        )


def test_eurostat_parser_rejects_unfiltered_indicator_category_or_time() -> None:
    payload = _eurostat_payload(geos=("ES",), values=(91.75,))
    payload["dimension"]["time"]["category"]["index"] = {"2024": 0}  # type: ignore[index]

    with pytest.raises(ValueError, match="time=2025"):
        parse_eurostat_actual_individual_consumption_price_levels(
            payload,
            tenant_id="local",
            reference_year=2025,
            fetched_at="2026-08-12T08:00:00Z",
            fresh_until="2026-08-19T08:00:00Z",
        )
