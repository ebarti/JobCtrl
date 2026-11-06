"""Verify saved official-data facts against their exact acquired payloads."""

from dataclasses import asdict

from .core.analysis import EvidenceError
from .core.ports import Rate, Source
from .providers.official_data import (
    EcbRates,
    eurostat_price_level_url,
    parse_eurostat_actual_individual_consumption_price_levels,
    parse_ecb_daily_exchange_rates,
)


def _equal(left, right):
    import json
    return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(right, sort_keys=True, ensure_ascii=False)


class OfficialDataVerifier:
    def verify_rate(self, value: dict) -> Rate:
        source = Source(**value["source"])
        rate = Rate(source, value["from_currency"], value["to_currency"], value["rate"], value["as_of"])
        rebuilt = EcbRates(lambda _url: source.text).rate(rate.from_currency, rate.to_currency, rate.as_of)
        if rebuilt is None or not _equal(asdict(rebuilt), value):
            raise EvidenceError("exchange_rate_binding_invalid")
        return rate

    def rate_snapshot(self, value: dict):
        source = Source(**value)
        rates = parse_ecb_daily_exchange_rates(source.text)
        if not rates or not _equal(asdict(rates[0].source), value):
            raise EvidenceError("exchange_rate_binding_invalid")
        return rates

    def price_snapshot(self, value: dict, year: int):
        source = Source(**value)
        if source.url != eurostat_price_level_url(year):
            raise EvidenceError("price_level_source_invalid")
        facts = parse_eurostat_actual_individual_consumption_price_levels(source.text, reference_year=year, source_url=source.url)
        if not facts or not _equal(asdict(facts[0].source), value):
            raise EvidenceError("price_level_binding_invalid")
        return facts

    def verify_prices(self, source_data: dict, target_data: dict, source_country: str, target_country: str):
        if source_data["source"] != target_data["source"] or source_data["year"] != target_data["year"]:
            raise EvidenceError("price_level_binding_invalid")
        source = Source(**source_data["source"])
        if source.url != eurostat_price_level_url(source_data["year"]):
            raise EvidenceError("price_level_source_invalid")
        facts = parse_eurostat_actual_individual_consumption_price_levels(
            source.text, reference_year=source_data["year"], source_url=source.url)
        by_country = {fact.country: fact for fact in facts}
        left, right = by_country.get(source_country), by_country.get(target_country)
        if left is None or right is None or not _equal(asdict(left), source_data) or not _equal(asdict(right), target_data):
            raise EvidenceError("price_level_binding_invalid")
        return left, right
