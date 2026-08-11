"""Adapters for public ECB exchange rates and Eurostat price-level data.

The adapters deliberately accept fetch callables.  Fetching policy, retrying,
and scheduling live above this module; here we only turn an already-received
official payload into content-addressed compensation inputs.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable, Mapping
from datetime import date
from typing import Any
from xml.etree import ElementTree

from jobctrl.domain.compensation import PriceLevelFact, build_price_level_fact
from jobctrl.infrastructure.compensation.benchmark_ingestion import FxRateToEur


ECB_DAILY_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
ECB_DAILY_XML_ATTRIBUTION = "European Central Bank euro foreign exchange reference rates"
ECB_DAILY_XML_SOURCE_ID = "ecb_daily_xml"

EUROSTAT_PRICE_LEVEL_DATASET = "prc_ppp_ind_1"
EUROSTAT_PRICE_LEVEL_INDICATOR = "PLI_EU27_2020"
EUROSTAT_PRICE_LEVEL_CATEGORY = "A01"
EUROSTAT_PRICE_LEVEL_ATTRIBUTION = "Eurostat, purchasing power parities and price level indices (prc_ppp_ind_1)"
EUROSTAT_API_BASE_URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data"

TextFetcher = Callable[[str], str | bytes | None]
JsonFetcher = Callable[[str], str | bytes | Mapping[str, Any] | None]

_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_EUROSTAT_COUNTRY_ALIASES = {"EL": "GR", "UK": "GB"}
_EUROSTAT_AGGREGATE_GEOS = {
    "EA",
    "EA12",
    "EA19",
    "EA20",
    "EU",
    "EU15",
    "EU25",
    "EU27",
    "EU27_2007",
    "EU27_2020",
    "EU28",
    "EEA",
}


def eurostat_price_level_url(reference_year: int) -> str:
    """Return the fixed official query for annual AIC price levels."""

    year = _require_reference_year(reference_year)
    return (
        f"{EUROSTAT_API_BASE_URL}/{EUROSTAT_PRICE_LEVEL_DATASET}"
        "?lang=en"
        f"&indic_ppp={EUROSTAT_PRICE_LEVEL_INDICATOR}"
        f"&ppp_cat18={EUROSTAT_PRICE_LEVEL_CATEGORY}"
        f"&time={year}"
    )


def load_ecb_daily_exchange_rates(
    *,
    fetch_text: TextFetcher,
) -> tuple[FxRateToEur, ...]:
    """Load ECB daily rates through an injected public-text fetcher."""

    return parse_ecb_daily_exchange_rates(fetch_text(ECB_DAILY_XML_URL))


def parse_ecb_daily_exchange_rates(
    payload: str | bytes | None,
) -> tuple[FxRateToEur, ...]:
    """Convert ECB's quoted currency-per-EUR rates to EUR-per-currency rates."""

    raw = _payload_bytes(payload, "ECB daily XML")
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("ECB daily XML must not contain declarations")
    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError as exc:
        raise ValueError("ECB daily XML is malformed") from exc

    dated_cubes = [
        element for element in root.iter() if _xml_local_name(element.tag) == "Cube" and "time" in element.attrib
    ]
    if len(dated_cubes) != 1:
        raise ValueError("ECB daily XML must contain exactly one dated rate cube")
    as_of_date = _canonical_date(dated_cubes[0].attrib["time"], "ECB rate date")
    snapshot_id = _snapshot_id("ecb-eurofxref-daily", as_of_date, raw)

    rates: dict[str, FxRateToEur] = {}
    for element in dated_cubes[0]:
        if _xml_local_name(element.tag) != "Cube":
            continue
        currency = str(element.attrib.get("currency", "")).strip().upper()
        if not _CURRENCY_RE.fullmatch(currency) or currency == "EUR":
            raise ValueError("ECB daily XML contains an invalid quoted currency")
        if currency in rates:
            raise ValueError("ECB daily XML contains duplicate quoted currencies")
        quote = _finite_positive_float(element.attrib.get("rate"), "ECB quoted rate")
        rates[currency] = FxRateToEur(
            currency=currency,
            rate=1 / quote,
            source_id=ECB_DAILY_XML_SOURCE_ID,
            reference_id=snapshot_id,
            as_of_date=as_of_date,
        )
    if not rates:
        raise ValueError("ECB daily XML contains no quoted rates")
    return tuple(rates[currency] for currency in sorted(rates))


def load_eurostat_actual_individual_consumption_price_levels(
    *,
    tenant_id: str,
    reference_year: int,
    fetched_at: str,
    fresh_until: str,
    fetch_json: JsonFetcher,
) -> tuple[PriceLevelFact, ...]:
    """Load annual country price levels from the fixed official Eurostat query."""

    year = _require_reference_year(reference_year)
    source_url = eurostat_price_level_url(year)
    return parse_eurostat_actual_individual_consumption_price_levels(
        fetch_json(source_url),
        tenant_id=tenant_id,
        reference_year=year,
        fetched_at=fetched_at,
        fresh_until=fresh_until,
        source_url=source_url,
    )


def parse_eurostat_actual_individual_consumption_price_levels(
    payload: str | bytes | Mapping[str, Any] | None,
    *,
    tenant_id: str,
    reference_year: int,
    fetched_at: str,
    fresh_until: str,
    source_url: str | None = None,
) -> tuple[PriceLevelFact, ...]:
    """Parse a JSON-stat 2.0 response into country-level Eurostat facts."""

    year = _require_reference_year(reference_year)
    dataset, snapshot_bytes = _json_object_payload(payload, "Eurostat JSON-stat payload")
    if dataset.get("version") != "2.0" or dataset.get("class") != "dataset":
        raise ValueError("Eurostat payload must be a JSON-stat 2.0 dataset")
    dimensions, sizes = _json_stat_dimensions(dataset)
    required_dimension_codes = {
        "indic_ppp": EUROSTAT_PRICE_LEVEL_INDICATOR,
        "ppp_cat18": EUROSTAT_PRICE_LEVEL_CATEGORY,
        "time": str(year),
    }
    positions: dict[str, int] = {}
    for dimension, codes in dimensions.items():
        if dimension == "geo":
            continue
        required_code = required_dimension_codes.get(dimension)
        if required_code is not None:
            if required_code not in codes:
                raise ValueError(f"Eurostat JSON-stat payload does not contain {dimension}={required_code}")
            positions[dimension] = codes[required_code]
            continue
        if dimension == "freq" and "A" in codes:
            positions[dimension] = codes["A"]
            continue
        if sizes[dimension] != 1:
            raise ValueError(f"Eurostat JSON-stat payload must be filtered to one {dimension}")
        positions[dimension] = 0
    for dimension in required_dimension_codes:
        if dimension not in dimensions:
            raise ValueError(f"Eurostat JSON-stat payload is missing {dimension}")
    if "geo" not in dimensions:
        raise ValueError("Eurostat JSON-stat payload is missing geo")

    values = dataset.get("value")
    if not isinstance(values, (list, Mapping)):
        raise ValueError("Eurostat JSON-stat payload value must be an array or object")
    snapshot_id = _snapshot_id(
        f"eurostat-{EUROSTAT_PRICE_LEVEL_DATASET.lower()}-{year}",
        str(year),
        snapshot_bytes,
    )
    facts: list[PriceLevelFact] = []
    seen_countries: set[str] = set()
    resolved_source_url = source_url or eurostat_price_level_url(year)
    for raw_geo, geo_position in sorted(dimensions["geo"].items()):
        country_code = _eurostat_country_code(raw_geo)
        if country_code is None:
            continue
        if country_code in seen_countries:
            raise ValueError("Eurostat JSON-stat payload maps multiple geos to one country")
        index_positions = dict(positions)
        index_positions["geo"] = geo_position
        flat_index = _json_stat_flat_index(index_positions, dataset["id"], sizes)
        value = _json_stat_value(values, flat_index)
        if value is None:
            continue
        index_value = _finite_positive_float(value, f"Eurostat price level for {raw_geo}")
        facts.append(
            build_price_level_fact(
                tenant_id=tenant_id,
                country_code=country_code,
                category="actual_individual_consumption",
                reference_year=year,
                base_geography_code="EU27_2020",
                index_value=index_value,
                source_id="eurostat",
                source_snapshot_id=snapshot_id,
                source_url=resolved_source_url,
                attribution=EUROSTAT_PRICE_LEVEL_ATTRIBUTION,
                as_of_date=f"{year}-12-31",
                fetched_at=fetched_at,
                fresh_until=fresh_until,
            )
        )
        seen_countries.add(country_code)
    if not facts:
        raise ValueError("Eurostat JSON-stat payload contains no country price levels")
    return tuple(sorted(facts, key=lambda fact: fact.country_code))


def _json_stat_dimensions(dataset: Mapping[str, Any]) -> tuple[dict[str, dict[str, int]], dict[str, int]]:
    dimension_ids = dataset.get("id")
    raw_sizes = dataset.get("size")
    raw_dimensions = dataset.get("dimension")
    if not isinstance(dimension_ids, list) or not all(isinstance(item, str) for item in dimension_ids):
        raise ValueError("Eurostat JSON-stat payload id must be an array of dimension names")
    if len(set(dimension_ids)) != len(dimension_ids) or not dimension_ids:
        raise ValueError("Eurostat JSON-stat payload dimensions must be unique and non-empty")
    if not isinstance(raw_sizes, list) or len(raw_sizes) != len(dimension_ids):
        raise ValueError("Eurostat JSON-stat payload size must match dimensions")
    if not isinstance(raw_dimensions, Mapping):
        raise ValueError("Eurostat JSON-stat payload dimension must be an object")

    dimensions: dict[str, dict[str, int]] = {}
    sizes: dict[str, int] = {}
    for dimension_id, raw_size in zip(dimension_ids, raw_sizes, strict=True):
        if not isinstance(raw_size, int) or isinstance(raw_size, bool) or raw_size <= 0:
            raise ValueError("Eurostat JSON-stat dimension sizes must be positive integers")
        raw_dimension = raw_dimensions.get(dimension_id)
        if not isinstance(raw_dimension, Mapping):
            raise ValueError(f"Eurostat JSON-stat payload is missing dimension {dimension_id}")
        raw_category = raw_dimension.get("category")
        if not isinstance(raw_category, Mapping) or not isinstance(raw_category.get("index"), Mapping):
            raise ValueError(f"Eurostat JSON-stat dimension {dimension_id} has no category index")
        category_index = raw_category["index"]
        codes: dict[str, int] = {}
        for code, position in category_index.items():
            if not isinstance(code, str) or not isinstance(position, int) or isinstance(position, bool):
                raise ValueError("Eurostat JSON-stat category indexes must map strings to integers")
            if position < 0 or position >= raw_size or code in codes:
                raise ValueError("Eurostat JSON-stat category index is invalid")
            codes[code] = position
        if set(codes.values()) != set(range(raw_size)):
            raise ValueError("Eurostat JSON-stat category index must cover each dimension position")
        dimensions[dimension_id] = codes
        sizes[dimension_id] = raw_size
    return dimensions, sizes


def _json_stat_flat_index(
    positions: Mapping[str, int],
    dimension_ids: Any,
    sizes: Mapping[str, int],
) -> int:
    if not isinstance(dimension_ids, list):  # pragma: no cover - validated above
        raise ValueError("Eurostat JSON-stat payload id must be an array")
    index = 0
    for dimension_id in dimension_ids:
        position = positions.get(dimension_id)
        if position is None or position < 0 or position >= sizes[dimension_id]:
            raise ValueError("Eurostat JSON-stat coordinate is invalid")
        index = index * sizes[dimension_id] + position
    return index


def _json_stat_value(values: list[Any] | Mapping[str, Any], flat_index: int) -> Any:
    if isinstance(values, list):
        if flat_index >= len(values):
            return None
        return values[flat_index]
    return values.get(str(flat_index))


def _eurostat_country_code(raw_geo: str) -> str | None:
    geo = raw_geo.strip().upper()
    if geo in _EUROSTAT_AGGREGATE_GEOS or not _COUNTRY_RE.fullmatch(geo):
        return None
    return _EUROSTAT_COUNTRY_ALIASES.get(geo, geo)


def _json_object_payload(
    payload: str | bytes | Mapping[str, Any] | None,
    label: str,
) -> tuple[Mapping[str, Any], bytes]:
    if isinstance(payload, Mapping):
        encoded = _canonical_json_bytes(payload, label)
        return payload, encoded
    raw = _payload_bytes(payload, label)
    try:
        decoded = json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is malformed") from exc
    if not isinstance(decoded, Mapping):
        raise ValueError(f"{label} must be a JSON object")
    return decoded, _canonical_json_bytes(decoded, label)


def _canonical_json_bytes(payload: Mapping[str, Any], label: str) -> bytes:
    try:
        return json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must contain JSON-safe values") from exc


def _payload_bytes(payload: str | bytes | None, label: str) -> bytes:
    if isinstance(payload, str):
        raw = payload.encode("utf-8")
    elif isinstance(payload, bytes):
        raw = payload
    else:
        raise ValueError(f"{label} is missing")
    if not raw.strip():
        raise ValueError(f"{label} is empty")
    return raw


def _finite_positive_float(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a finite positive number")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a finite positive number") from exc
    if not math.isfinite(numeric) or numeric <= 0:
        raise ValueError(f"{field} must be a finite positive number")
    return numeric


def _canonical_date(value: str, field: str) -> str:
    raw = str(value or "").strip()
    try:
        parsed = date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO 8601 date") from exc
    if parsed.isoformat() != raw:
        raise ValueError(f"{field} must use canonical YYYY-MM-DD form")
    return raw


def _require_reference_year(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 2000:
        raise ValueError("reference_year must be an integer no earlier than 2000")
    return value


def _snapshot_id(prefix: str, as_of: str, raw: bytes) -> str:
    digest = hashlib.sha256(raw).hexdigest()[:16]
    return f"{prefix}-{as_of}-{digest}"


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"JSON constant {value} is not allowed")


__all__ = [
    "ECB_DAILY_XML_ATTRIBUTION",
    "ECB_DAILY_XML_SOURCE_ID",
    "ECB_DAILY_XML_URL",
    "EUROSTAT_API_BASE_URL",
    "EUROSTAT_PRICE_LEVEL_ATTRIBUTION",
    "EUROSTAT_PRICE_LEVEL_CATEGORY",
    "EUROSTAT_PRICE_LEVEL_DATASET",
    "EUROSTAT_PRICE_LEVEL_INDICATOR",
    "eurostat_price_level_url",
    "load_ecb_daily_exchange_rates",
    "load_eurostat_actual_individual_consumption_price_levels",
    "parse_ecb_daily_exchange_rates",
    "parse_eurostat_actual_individual_consumption_price_levels",
]
