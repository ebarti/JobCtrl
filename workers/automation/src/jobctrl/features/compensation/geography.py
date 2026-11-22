"""Source-bound geographic compensation bridge over neutral direct benchmarks.

Inputs are observations acquired for the current refresh, never sibling storage.
The host supplies classified, source-bound rows, a dated rate port, and the
fixed official annual price-level loader. A direct target-country observation
always takes precedence. Only an explicitly classified country-level market
observation can anchor a country bridge; a locality is never promoted into a
country benchmark. Missing or failed inputs remain explicit results.

The optional matched-company path accepts only an existing common canonical
company reference and an independently persisted model determination binding
the two exact source rows. Names or token overlap never decide identity.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Iterable, Literal, Mapping
from urllib.parse import urlsplit

from .core.analysis import (
    DirectBenchmark,
    EvidenceError,
    Extrapolation,
    direct_benchmark,
    extrapolate,
    validate_classification,
    validate_source_date,
)
from .core.ports import (
    Citation,
    Classification,
    CompanyPair,
    Determination,
    Observation,
    PriceLevel,
    Rate,
    Rates,
    Source,
)


@dataclass(frozen=True)
class CompanyIdentityDecision:
    source: Source
    determination: Determination
    verdict: Literal["same", "different", "unknown"]
    source_citation: Citation
    target_citation: Citation


@dataclass(frozen=True)
class CompanyMatch:
    source: DirectBenchmark
    target: DirectBenchmark
    decision: CompanyIdentityDecision


@dataclass(frozen=True)
class GeographyResult:
    status: Literal["estimated", "insufficient", "unavailable", "direct"]
    reason: str | None
    source_country: str | None
    target_country: str | None
    anchor: DirectBenchmark | None
    extrapolation: Extrapolation | None
    source_price: PriceLevel | None
    target_price: PriceLevel | None
    company_pairs: tuple[CompanyPair, ...] = ()
    company_matches: tuple[CompanyMatch, ...] = ()
    observed_at: str | None = None
    fresh_until: str | None = None
    warnings: tuple[str, ...] = ()
    input_freshness: dict[str, dict[str, str]] | None = None
    price_freshness: dict[str, dict[str, str]] | None = None


def _freshness_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise EvidenceError("invalid_input_freshness")
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            parsed = date.fromisoformat(value)
            return datetime(parsed.year, parsed.month, parsed.day, tzinfo=timezone.utc)
        parsed_time = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed_time.tzinfo is None or parsed_time.utcoffset() is None:
            raise ValueError
        return parsed_time.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise EvidenceError("invalid_input_freshness") from None


def _selected_freshness(
    references: set[str],
    supplied: Mapping[str, Mapping[str, str]] | None,
    valuation: date,
) -> dict[str, dict[str, str]]:
    """Copy and validate only selected input windows, retaining their precision."""
    result: dict[str, dict[str, str]] = {}
    for reference in sorted(references):
        value = (
            supplied.get(reference)
            if supplied is not None
            else {"observed_at": valuation.isoformat(), "fresh_until": (valuation + timedelta(days=7)).isoformat()}
        )
        if not isinstance(value, Mapping):
            raise EvidenceError("missing_input_freshness")
        observed, expiry = value.get("observed_at"), value.get("fresh_until")
        observed_time, expiry_time = _freshness_time(observed), _freshness_time(expiry)
        if (
            observed_time.date() > valuation
            or expiry_time.date() < valuation
            or expiry_time <= observed_time
            or expiry_time - observed_time > timedelta(days=7)
        ):
            raise EvidenceError("invalid_input_freshness")
        result[reference] = {"observed_at": observed, "fresh_until": expiry}
    return result


def _identity_side(row: Observation) -> str:
    """Canonical evidence supplied to the company-equivalence model."""
    payload = {
        "company": row.company,
        "company_reference": row.company_reference,
        "provider": row.provider,
        "source_reference": row.source.reference,
        "source_text": row.source.text,
        "source_url": row.source.url,
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def company_identity_source(source: Observation, target: Observation) -> Source:
    """Build the exact composite input used for one employer identity decision."""
    source_text, target_text = _identity_side(source), _identity_side(target)
    if len(source_text.encode()) + len(target_text.encode()) > 128 * 1024:
        raise EvidenceError("company_identity_source_too_large")
    text = f"SOURCE {source_text}\nTARGET {target_text}"
    return Source(reference="company-identity:" + hashlib.sha256(text.encode()).hexdigest(), text=text)


def _source_owned_company_id(row: Observation) -> bool:
    """Check a provider-issued ID against its exact content-addressed row."""
    if row.provider != "levels_fyi" or not row.company_reference or not row.source.url:
        return False
    try:
        payload = json.loads(row.source.text)
        parts = urlsplit(row.source.url)
    except (TypeError, ValueError):
        return False
    company_path = re.fullmatch(r"/companies/([a-z0-9-]+)/salaries(?:/.*)?", parts.path)
    return bool(
        isinstance(payload, dict)
        and row.source.reference.rsplit(":", 1)[-1] == hashlib.sha256(row.source.text.encode()).hexdigest()
        and payload.get("company_name", payload.get("company")) == row.company
        and payload.get("company_reference") == row.company_reference
        and payload.get("source_url", payload.get("url")) == row.source.url
        and parts.scheme == "https"
        and parts.netloc == "www.levels.fyi"
        and company_path
        and row.company_reference == f"levels_fyi:company:{company_path.group(1)}"
    )


def validate_company_match(
    match: CompanyMatch, source_country: str, target_country: str, occupation: str, seniority: str, component: str
) -> CompanyPair | None:
    """Revalidate a persisted pair and return its arithmetic input if proven."""
    left, right = match.source, match.target
    source, target = left.observation, right.observation
    # Reconstruct each normalized input; accepting altered amounts or rates
    # would turn the caller's claimed identity into fabricated pay evidence.
    if (
        direct_benchmark(source, rate=left.exchange_rate) != left
        or direct_benchmark(target, rate=right.exchange_rate) != right
    ):
        raise EvidenceError("company_benchmark_binding_invalid")
    if (
        left.exchange_rate is not None
        and right.exchange_rate is not None
        and (
            left.exchange_rate.source != right.exchange_rate.source
            or left.exchange_rate.as_of != right.exchange_rate.as_of
        )
    ):
        raise EvidenceError("company_rate_snapshot_mismatch")
    a, b = source.classification, target.classification
    assert a is not None and b is not None
    compatible = (
        a.market_scope == b.market_scope == "company"
        and getattr(a, "geography_scope", "unknown") == getattr(b, "geography_scope", "unknown") == "country"
        and a.countries == (source_country,)
        and b.countries == (target_country,)
        and a.occupation == b.occupation == occupation
        and a.seniority == b.seniority == seniority
        and source.component == target.component == component
    )
    if not compatible:
        raise EvidenceError("company_benchmark_slice_mismatch")
    decision = match.decision
    expected = company_identity_source(source, target)
    det = decision.determination
    if decision.source != expected or not all(
        (
            det.reference,
            det.provider,
            det.model,
            det.lane,
            det.prompt_version,
            det.input_fingerprint,
            det.decided_at,
            det.rationale,
        )
    ):
        raise EvidenceError("company_identity_provenance_invalid")
    if (
        det.source_reference != expected.reference
        or det.source_hash != hashlib.sha256(expected.text.encode()).hexdigest()
    ):
        raise EvidenceError("company_identity_source_mismatch")
    if decision.verdict not in {"same", "different", "unknown"}:
        raise EvidenceError("company_identity_verdict_invalid")
    if not det.citations or any(
        c.reference != expected.reference or not c.quote or c.quote not in expected.text for c in det.citations
    ):
        raise EvidenceError("company_identity_citation_invalid")
    for citation, side in (
        (decision.source_citation, _identity_side(source)),
        (decision.target_citation, _identity_side(target)),
    ):
        if (
            citation not in det.citations
            or citation.reference != expected.reference
            or not citation.quote
            or citation.quote not in side
        ):
            raise EvidenceError("company_identity_citation_invalid")
    for citation, row in ((decision.source_citation, source), (decision.target_citation, target)):
        source_values = (row.company, row.company_reference, row.source.url)
        if not any(value and value in citation.quote for value in source_values):
            raise EvidenceError("company_identity_citation_invalid")
    if decision.verdict != "same":
        return None
    # Both rows must also join the same previously accepted company identity.
    # This prevents repeated pairwise matches from inflating distinct companies.
    identity = source.company_reference
    if not identity or target.company_reference != identity:
        return None
    if not _source_owned_company_id(source) or not _source_owned_company_id(target):
        raise EvidenceError("company_identity_reference_unbound")
    source_mid = (left.annual_minimum_eur + left.annual_maximum_eur) / 2
    target_mid = (right.annual_minimum_eur + right.annual_maximum_eur) / 2
    quality = math.sqrt(min(source.sample_count, target.sample_count)) * math.sqrt(
        _confidence(source) * _confidence(target)
    )
    return CompanyPair(identity, source_mid, target_mid, max(0.01, quality), source.source, target.source)


def _confidence(row: Observation) -> float:
    base = {"licensed": 0.76, "official": 0.82, "public": 0.64, "manual": 0.56}.get(row.provenance, 0.5)
    return min(0.9, base + min(0.12, max(0, (row.sample_count or 0) - 1) * 0.015))


def _price_pair(
    prices: Iterable[PriceLevel], source_country: str, target_country: str, reference_year: int
) -> tuple[PriceLevel, PriceLevel] | None:
    eligible = [
        p
        for p in prices
        if p.year == reference_year
        and p.category == "actual_individual_consumption"
        and p.base_geography == "EU27_2020"
    ]
    source = [p for p in eligible if p.country == source_country]
    target = [p for p in eligible if p.country == target_country]
    if len(source) != 1 or len(target) != 1:
        return None
    a, b = source[0], target[0]
    if not a.source.reference or a.source.reference != b.source.reference or a.source != b.source:
        return None
    return a, b


async def extrapolate_for_target(
    *,
    target_source: Source,
    target: Classification,
    rows: Iterable[Observation],
    rates: Rates,
    load_price_levels: Callable[[int], tuple[PriceLevel, ...]],
    reference_year: int,
    valuation_date: str,
    matched_company_inputs: Iterable[CompanyMatch] = (),
    input_freshness: Mapping[str, Mapping[str, str]] | None = None,
    price_freshness: Mapping[str, Mapping[str, str]] | None = None,
) -> GeographyResult:
    """Build an audited bridge from current source rows, with no SQL or model fallback.

    ``reference_year`` is the most recent completed official year; a failure
    of that year's annual release retries the preceding year, as before. The
    host supplies only rows acquired for this refresh and owns durable source,
    classification and company-decision receipt validation on readback.
    """
    day = date.fromisoformat(valuation_date)
    if day.isoformat() != valuation_date or isinstance(reference_year, bool) or not isinstance(reference_year, int):
        raise ValueError("invalid valuation date or reference year")
    if reference_year < 2000 or reference_year >= day.year:
        raise ValueError("reference year must be a completed year from 2000")
    validate_classification(target_source, target)
    target_country = target.countries[0] if len(target.countries) == 1 else None
    fresh_until = (day + timedelta(days=7)).isoformat()

    def result(status, reason, *, warnings=()):
        return GeographyResult(
            status,
            reason,
            None,
            target_country,
            None,
            None,
            None,
            None,
            observed_at=valuation_date,
            fresh_until=fresh_until,
            warnings=warnings,
        )

    try:
        validate_source_date(target_source, valuation_date)
    except EvidenceError:
        return result("unavailable", "invalid_source_date")

    if not target_country or getattr(target, "geography_scope", "unknown") != "country":
        return result("insufficient", "unsupported_target_geography")
    if target.occupation == "unknown" or target.seniority == "unknown":
        return result("insufficient", "unknown_role_or_seniority")

    current_rows = tuple(rows)
    eligible: list[Observation] = []
    for row in current_rows:
        try:
            validate_source_date(row.source, valuation_date)
        except EvidenceError:
            return result("unavailable", "invalid_source_date")
        cls = row.classification
        if cls is None:
            continue
        validate_classification(row.source, cls)
        if (
            cls.occupation != target.occupation
            or cls.seniority != target.seniority
            or cls.market_scope != "market"
            or getattr(cls, "geography_scope", "unknown") != "country"
            or len(cls.countries) != 1
            or row.component != "total_compensation"
        ):
            continue
        eligible.append(row)
    if not eligible:
        return result("insufficient", "no_direct_anchor")

    rate_cache: dict[str, Rate | None] = {}
    fx_failed = False
    direct_fx_failed = False
    anchors: list[DirectBenchmark] = []
    direct: list[DirectBenchmark] = []
    for row in eligible:
        is_direct = row.classification.countries == (target_country,)
        try:
            if row.currency != "EUR":
                # Validate every non-FX prerequisite before requesting a rate;
                # a structurally unusable row is not a possible direct fact.
                try:
                    direct_benchmark(row)
                except EvidenceError as error:
                    if str(error) != "exchange_rate_unavailable":
                        continue
            if row.currency != "EUR" and row.currency not in rate_cache:
                rate_cache[row.currency] = await asyncio.to_thread(rates.rate, row.currency, "EUR", valuation_date)
            rate = None if row.currency == "EUR" else rate_cache[row.currency]
            if row.currency != "EUR" and (
                rate is None or date.fromisoformat(rate.as_of) > day or rate.source.as_of != rate.as_of
            ):
                fx_failed = True
                direct_fx_failed |= is_direct
                continue
            fact = direct_benchmark(row, rate=rate)
            (direct if is_direct else anchors).append(fact)
        except EvidenceError as error:
            if str(error) == "exchange_rate_unavailable":
                fx_failed = True
                direct_fx_failed |= is_direct
            continue
        except Exception:  # noqa: BLE001 - do not expose transport/provider messages
            fx_failed = True
            direct_fx_failed |= is_direct
            if row.currency != "EUR":
                rate_cache[row.currency] = None
    # A valid direct fact is stronger than any geographically derived range.
    if direct:
        return result("direct", "direct_evidence_available")
    # A possibly usable direct fact with unknown FX must not be treated as
    # absent and replaced by a cross-country estimate.
    if direct_fx_failed:
        return result("unavailable", "exchange_rate_unavailable")
    if not anchors:
        return result(
            "unavailable" if fx_failed else "insufficient",
            "exchange_rate_unavailable" if fx_failed else "no_direct_anchor",
        )

    snapshots: list[tuple[int, tuple[PriceLevel, ...]]] = []
    failed_years: set[int] = set()
    for year in (reference_year, reference_year - 1):
        if year < 2000:
            continue
        try:
            loaded = tuple(await asyncio.to_thread(load_price_levels, year))
            snapshots.append((year, loaded))
            if all(
                any(
                    _price_pair(prices, anchor.observation.classification.countries[0], target_country, y)
                    for y, prices in snapshots
                )
                for anchor in anchors
            ):
                break
        except Exception:  # noqa: BLE001 - official annual release can lag by one year
            failed_years.add(year)
    if not snapshots:
        return result("unavailable", "eurostat_price_levels_unavailable")

    matches = tuple(matched_company_inputs)
    ranked: list[tuple[tuple, GeographyResult]] = []
    freshness_failure = False
    for anchor in anchors:
        source_country = anchor.observation.classification.countries[0]
        selected = next(
            (
                (year, pair)
                for year, prices in snapshots
                if (pair := _price_pair(prices, source_country, target_country, year)) is not None
            ),
            None,
        )
        if selected is None:
            continue
        selected_year, price_pair = selected
        accepted_pairs: list[CompanyPair] = []
        accepted_matches: list[CompanyMatch] = []
        identities: set[str] = set()
        for match in matches:
            source_cls, target_cls = match.source.observation.classification, match.target.observation.classification
            if (
                source_cls is None
                or target_cls is None
                or source_cls.countries != (source_country,)
                or target_cls.countries != (target_country,)
            ):
                continue
            if match.source.observation not in current_rows or match.target.observation not in current_rows:
                raise EvidenceError("company_benchmark_not_in_refresh")
            if any(
                rate is not None and date.fromisoformat(rate.as_of) > day
                for rate in (match.source.exchange_rate, match.target.exchange_rate)
            ):
                raise EvidenceError("company_rate_after_valuation")
            pair = validate_company_match(
                match, source_country, target_country, target.occupation, target.seniority, "total_compensation"
            )
            if pair is not None and pair.company_reference not in identities:
                identities.add(pair.company_reference)
                accepted_pairs.append(pair)
                accepted_matches.append(match)
        adjusted = extrapolate(anchor.annual_minimum_eur, anchor.annual_maximum_eur, *price_pair, accepted_pairs)
        selected_refs = {anchor.observation.source.reference}
        if anchor.exchange_rate is not None:
            selected_refs.add(anchor.exchange_rate.source.reference)
        for match in accepted_matches:
            selected_refs.update((match.source.observation.source.reference, match.target.observation.source.reference))
            for rate in (match.source.exchange_rate, match.target.exchange_rate):
                if rate is not None:
                    selected_refs.add(rate.source.reference)
        try:
            selected_inputs = _selected_freshness(selected_refs, input_freshness, day)
            selected_prices = _selected_freshness({price_pair[0].source.reference}, price_freshness, day)
        except EvidenceError:
            freshness_failure = True
            continue
        selected_windows = (*selected_inputs.values(), *selected_prices.values())
        earliest_observation = min(selected_windows, key=lambda value: _freshness_time(value["observed_at"]))[
            "observed_at"
        ]
        earliest_expiry = min(selected_windows, key=lambda value: _freshness_time(value["fresh_until"]))["fresh_until"]
        warnings = list(adjusted.warnings)
        if fx_failed:
            warnings.append("exchange_rate_unavailable")
        if reference_year in failed_years:
            warnings.append("latest_price_level_unavailable")
        elif selected_year != reference_year:
            warnings.append("latest_price_level_incomplete")
        if any(year != reference_year for year in failed_years):
            warnings.append("prior_price_level_unavailable")
        entry = GeographyResult(
            "estimated",
            None,
            source_country,
            target_country,
            anchor,
            adjusted,
            price_pair[0],
            price_pair[1],
            tuple(accepted_pairs),
            tuple(accepted_matches),
            earliest_observation,
            earliest_expiry,
            tuple(dict.fromkeys(warnings)),
            selected_inputs,
            selected_prices,
        )
        # Exact taxonomy and country scope were already fenced. Prefer bounded,
        # better supported arithmetic, then stronger and newer source evidence.
        key = (
            adjusted.factor_bound_state == "within_bounds",
            adjusted.confidence_score,
            adjusted.matched_company_count,
            _confidence(anchor.observation),
            anchor.observation.sample_count or 0,
            anchor.observation.source.as_of or "",
            anchor.reference,
        )
        ranked.append((key, entry))
    if not ranked:
        if freshness_failure:
            return result("unavailable", "input_freshness_unavailable")
        if failed_years:
            return result("unavailable", "eurostat_price_levels_unavailable")
        return result("insufficient", "missing_compatible_price_levels")
    return max(ranked, key=lambda pair: pair[0])[1]
