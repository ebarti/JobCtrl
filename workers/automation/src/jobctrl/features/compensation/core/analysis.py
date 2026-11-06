"""Source-bound posted pay, exact-code market matching and benchmark arithmetic."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
import hashlib
import math
import re
from typing import Iterable

from .ports import Classification, CompanyPair, Determination, Model, Observation, PayJudgment, PriceLevel, Rate, Source


class EvidenceError(ValueError):
    """A source, determination, rate, or arithmetic input cannot support publication."""


_NUMBER = re.compile(r"(?<![\w.,])(?:[A-Z]{3})?(?P<number>\d+(?:,\d{3})*(?:\.\d+)?(?:[kKmM](?!\w))?)(?!\w|\.\w|,\d)")
_WARNINGS = frozenset({"ambiguous_multiple_amounts", "bonus_component", "broad_range", "commission_component", "equity_component", "hourly_period", "missing_currency", "missing_period", "monthly_period", "no_amount_found", "one_sided_range", "ote_component", "source_text_truncated"})


def _numbers(text: str) -> set[Decimal]:
    values: set[Decimal] = set()
    for match in _NUMBER.finditer(text):
        token = match.group("number")
        suffix = token[-1].lower()
        factor = 1000 if suffix == "k" else 1000000 if suffix == "m" else 1
        number = token[:-1] if suffix in {"k", "m"} else token
        values.add(Decimal(number.replace(",", "")) * factor)
    return values


def validate_source_date(source: Source, valuation_date: str) -> None:
    """Reject future or malformed explicit dates without filling unknown precision."""
    try:
        today = date.fromisoformat(valuation_date)
    except (TypeError, ValueError):
        raise EvidenceError("invalid_valuation_date") from None
    value = source.as_of
    if value is None:
        return
    if not isinstance(value, str):
        raise EvidenceError("invalid_source_date")
    try:
        if re.fullmatch(r"\d{4}", value):
            year = int(value)
            if not 1 <= year <= 9999 or year > today.year:
                raise ValueError
        elif re.fullmatch(r"\d{4}-\d{2}", value):
            year, month = map(int, value.split("-"))
            date(year, month, 1)
            if (year, month) > (today.year, today.month):
                raise ValueError
        else:
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                day = date.fromisoformat(value)
            else:
                instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if instant.tzinfo is None or instant.utcoffset() is None:
                    raise ValueError
                day = instant.astimezone(timezone.utc).date()
            if day > today:
                raise ValueError
    except (TypeError, ValueError, OverflowError):
        raise EvidenceError("invalid_source_date") from None


def _validate_determination(source: Source, decision: Determination, *, require_citations: bool) -> None:
    if not source.reference or not isinstance(source.text, str):
        raise EvidenceError("invalid_source")
    if not all((decision.reference, decision.provider, decision.model, decision.lane, decision.prompt_version, decision.input_fingerprint, decision.decided_at, decision.rationale)):
        raise EvidenceError("missing_determination_provenance")
    if decision.source_reference != source.reference or decision.source_hash != hashlib.sha256(source.text.encode()).hexdigest():
        raise EvidenceError("source_binding_mismatch")
    if require_citations and not decision.citations:
        raise EvidenceError("missing_citation")
    if any(c.reference != source.reference or not c.quote or c.quote not in source.text for c in decision.citations):
        raise EvidenceError("invalid_citation")


@dataclass(frozen=True)
class PostedFact:
    source: Source
    judgment: PayJudgment
    annual_minimum: int | None
    annual_maximum: int | None
    annualization_assumption: str | None


async def extract_posted(source: Source, model: Model) -> PostedFact:
    return posted_from_judgment(source, await model.posted_pay(source))


def posted_from_judgment(source: Source, result: PayJudgment) -> PostedFact:
    _validate_determination(source, result.determination, require_citations=result.parse_state == "parsed_range")
    if result.parse_state not in {"missing", "unparseable", "ambiguous", "parsed_range"}:
        raise EvidenceError("invalid_parse_state")
    if result.currency is not None and not re.fullmatch(r"[A-Z]{3}", result.currency):
        raise EvidenceError("invalid_currency")
    if result.period not in {"hour", "month", "year", "unknown"} or result.component not in {"base_salary", "ote", "bonus", "commission", "equity", "unknown"}:
        raise EvidenceError("invalid_pay_type")
    if result.confidence not in {"none", "low", "medium", "high"} or any(item not in _WARNINGS for item in result.warnings):
        raise EvidenceError("invalid_confidence_or_warning")
    values = (result.minimum, result.maximum)
    if any(isinstance(x, bool) or not isinstance(x, int) or x < 0 for x in values if x is not None):
        raise EvidenceError("invalid_amount")
    if result.parse_state == "parsed_range":
        if all(x is None for x in values):
            raise EvidenceError("missing_amount")
        cited_numbers = set().union(*(_numbers(c.quote) for c in result.determination.citations))
        if any(Decimal(x) not in cited_numbers for x in values if x is not None):
            raise EvidenceError("amount_not_in_citation")
    elif any(x is not None for x in values):
        raise EvidenceError("inconsistent_pay_state")
    if all(x is not None for x in values) and values[0] > values[1]:
        raise EvidenceError("invalid_range")
    factor = {"year": 1, "month": 12, "hour": 2080}.get(result.period)
    return PostedFact(source, result,
                      result.minimum * factor if result.minimum is not None and factor else None,
                      result.maximum * factor if result.maximum is not None and factor else None,
                      {"month": "12 months/year", "hour": "2080 hours/year"}.get(result.period))


def validate_classification(source: Source, result: Classification) -> None:
    _validate_determination(source, result.determination, require_citations=True)
    fields = dict(result.field_citations)
    if any(not fields.get(key) for key in ("occupation", "seniority", "market_scope", "company_tier", "geography_scope", "locality")):
        raise EvidenceError("missing_field_citations")
    if result.countries and not fields.get("countries"):
        raise EvidenceError("missing_field_citations")
    if any(c.reference != source.reference or not c.quote or c.quote not in source.text for citations in fields.values() for c in citations):
        raise EvidenceError("invalid_field_citation")
    if not result.occupation or not result.seniority or len(result.countries) > 12:
        raise EvidenceError("invalid_classification")
    if any(not re.fullmatch(r"[A-Z]{2}", country) for country in result.countries):
        raise EvidenceError("invalid_country")
    if result.market_scope not in {"company", "market", "unknown"} or result.company_tier not in {"tier_1_local", "tier_2_ambitious", "tier_3_top_of_market", "unknown"}:
        raise EvidenceError("invalid_classification")
    if result.geography_scope not in {"country", "locality", "multiple", "unknown"}:
        raise EvidenceError("invalid_geography_scope")
    if result.geography_scope in {"country", "locality"} and len(result.countries) != 1:
        raise EvidenceError("invalid_geography_scope")
    if result.geography_scope == "locality":
        if not isinstance(result.locality, str) or not result.locality.strip():
            raise EvidenceError("invalid_locality")
    elif result.locality is not None:
        raise EvidenceError("invalid_locality")


@dataclass(frozen=True)
class MarketEstimate:
    state: str
    currency: str | None
    period: str | None
    component: str
    minimum: int | None
    maximum: int | None
    match_scope: str
    sources: tuple[Observation, ...]
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]


def estimate_market(target_source: Source, target: Classification, observations: Iterable[Observation], *,
                    component: str = "total_compensation", company_reference: str | None = None,
                    posted: PostedFact | None = None) -> MarketEstimate:
    validate_classification(target_source, target)
    if component not in {"base_salary", "total_compensation"}:
        raise EvidenceError("unsupported_component")
    selected = []
    for row in observations:
        if row.classification is None:
            raise EvidenceError("benchmark_classification_unavailable")
        validate_classification(row.source, row.classification)
        if row.provenance not in {"public", "licensed", "manual", "official"} or not row.attribution:
            raise EvidenceError("source_provenance_unavailable")
        if row.period not in {"year", "month", "week", "day", "hour"} or not re.fullmatch(r"[A-Z]{3}", row.currency):
            raise EvidenceError("invalid_observation")
        amounts = (row.minimum, row.maximum)
        if any(isinstance(x, bool) or not isinstance(x, int) or x < 0 for x in amounts if x is not None):
            raise EvidenceError("invalid_amount")
        if all(x is not None for x in amounts) and amounts[0] > amounts[1]:
            raise EvidenceError("invalid_range")
        cls = row.classification
        if (row.component == component and target.occupation != "unknown" and target.seniority != "unknown"
                and cls.occupation == target.occupation and cls.seniority == target.seniority
                and target.geography_scope in {"country", "locality"}
                and cls.geography_scope == target.geography_scope and cls.countries == target.countries
                and (target.geography_scope == "country" or cls.locality == target.locality)
                and any(x is not None for x in amounts)):
            selected.append(row)
    exact = [row for row in selected if company_reference and row.company_reference == company_reference]
    selected = exact or selected
    scope = "exact_company_role" if exact else "same_location_role_fallback" if selected else "none"
    if not selected:
        return MarketEstimate("insufficient_evidence", None, None, component, None, None, scope, (), ("missing_reported_observation",), ())
    if len({(row.currency, row.period) for row in selected}) != 1:
        return MarketEstimate("insufficient_evidence", None, None, component, None, None, scope, tuple(selected), ("source_dispersion_too_high",), ())
    if any(row.minimum is None or row.maximum is None for row in selected):
        return MarketEstimate("insufficient_evidence", None, None, component, None, None, scope,
                              tuple(selected), ("missing_reported_observation",), ())
    minimum = min(row.minimum for row in selected)
    maximum = max(row.maximum for row in selected)
    warnings = []
    if (posted and posted.judgment.component == component and posted.judgment.currency == selected[0].currency and selected[0].period == "year"
            and posted.annual_minimum is not None and posted.annual_maximum is not None):
        low, high = posted.annual_minimum, posted.annual_maximum
        if maximum < low * .7 or minimum > high * 1.3:
            warnings.append("source_conflict_with_posted_salary")
    return MarketEstimate("estimated_range", selected[0].currency, selected[0].period, component, minimum, maximum,
                          scope, tuple(selected), (), tuple(warnings))


def annualize(amount: int, period: str) -> int:
    multipliers = {"year": 1, "month": 12, "week": 52, "day": 260, "hour": 2080}
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0 or period not in multipliers:
        raise EvidenceError("unsupported_amount_or_period")
    return amount * multipliers[period]


def convert_annual(amount: int, period: str, source_currency: str, target_currency: str, rate: Rate | None) -> int:
    amount = annualize(amount, period)
    if source_currency == target_currency:
        return amount
    if rate is None or rate.from_currency != source_currency or rate.to_currency != target_currency or not rate.source.reference or not rate.as_of or not math.isfinite(rate.rate) or rate.rate <= 0:
        raise EvidenceError("exchange_rate_unavailable")
    return max(1, round(amount * rate.rate))


@dataclass(frozen=True)
class Extrapolation:
    minimum: int
    maximum: int
    raw_factor: float
    shrinkage_weight: float
    factor_bound_state: str
    matched_company_count: int
    confidence_score: float
    confidence_band: str
    warnings: tuple[str, ...]
    source_price: PriceLevel
    target_price: PriceLevel
    company_pairs: tuple[CompanyPair, ...]
    formula_version: str = "geo-shrinkage-v1"


def extrapolate(minimum: int, maximum: int, source: PriceLevel, target: PriceLevel,
                pairs: Iterable[CompanyPair] = ()) -> Extrapolation:
    if (isinstance(minimum, bool) or isinstance(maximum, bool) or not isinstance(minimum, int)
            or not isinstance(maximum, int) or minimum <= 0 or maximum < minimum):
        raise EvidenceError("invalid_range")
    if (not source.source.reference or not target.source.reference or source.category != target.category
            or source.year != target.year or source.base_geography != target.base_geography
            or not all(math.isfinite(x) and x > 0 for x in (source.index, target.index))):
        raise EvidenceError("incompatible_price_levels")
    unique: dict[str, CompanyPair] = {}
    for pair in pairs:
        if (not pair.company_reference or not pair.source.reference or not pair.target.reference
                or not all(math.isfinite(x) and x > 0 for x in (pair.source_value, pair.target_value, pair.quality_weight))):
            raise EvidenceError("invalid_company_pair")
        if pair.company_reference in unique and pair != unique[pair.company_reference]:
            raise EvidenceError("duplicate_company_pair")
        unique[pair.company_reference] = pair
    accepted = tuple(unique.values())
    weight = sum(p.quality_weight for p in accepted)
    shrinkage = weight / (weight + 3) if accepted else 0.0
    price_factor = target.index / source.index
    if accepted:
        company_factor = math.exp(sum(p.quality_weight * math.log(p.target_value / p.source_value) for p in accepted) / weight)
        factor = math.exp(shrinkage * math.log(company_factor) + (1 - shrinkage) * math.log(price_factor))
    else:
        factor = price_factor
    factor = round(factor, 8)
    state = "below_lower_bound" if factor < .1 else "above_upper_bound" if factor > 10 else "within_bounds"
    warnings = (["cost_of_living_only"] if not accepted else ["limited_matched_company_evidence"] if len(accepted) < 3 else [])
    if state != "within_bounds":
        warnings.append("factor_below_lower_bound" if state == "below_lower_bound" else "factor_above_upper_bound")
    score = min(.74, .35 + min(.18, len(accepted) * .06) + shrinkage * .24) if accepted else .3
    band = "medium" if len(accepted) >= 2 and score >= .55 else "low"
    if state != "within_bounds":
        score, band = min(score, .2), "low"
    low = max(1, round(minimum * factor))
    return Extrapolation(low, max(low, round(maximum * factor)), factor, round(shrinkage, 8), state,
                         len(accepted), round(score, 6), band, tuple(warnings), source, target, accepted)

@dataclass(frozen=True)
class DirectBenchmark:
    """A normalized source row, retaining its original evidence and rate authority."""
    reference: str
    observation: Observation
    annual_minimum_eur: int
    annual_maximum_eur: int
    exchange_rate: Rate | None


def direct_benchmark(observation: Observation, *, rate: Rate | None = None) -> DirectBenchmark:
    """Materialize one direct EUR/year benchmark without guessing any missing input."""
    if observation.classification is None:
        raise EvidenceError("benchmark_classification_unavailable")
    validate_classification(observation.source, observation.classification)
    if observation.classification.occupation == "unknown" or observation.classification.seniority == "unknown":
        raise EvidenceError("unknown_role_or_seniority")
    if len(observation.classification.countries) != 1 or observation.classification.geography_scope not in {"country", "locality"}:
        raise EvidenceError("missing_or_ambiguous_geography")
    if observation.classification.market_scope not in {"company", "market"}:
        raise EvidenceError("unknown_market_scope")
    if observation.classification.market_scope == "company" and not observation.company:
        raise EvidenceError("missing_company_name")
    if observation.minimum is None or observation.maximum is None:
        raise EvidenceError("one_sided_range")
    if observation.minimum <= 0 or observation.maximum < observation.minimum:
        raise EvidenceError("invalid_range")
    if observation.sample_count is None or observation.sample_count < 1:
        raise EvidenceError("missing_sample_count")
    if observation.provenance not in {"manual", "public", "licensed", "official"} or not observation.attribution:
        raise EvidenceError("source_provenance_unavailable")
    low = convert_annual(observation.minimum, observation.period, observation.currency, "EUR", rate)
    high = convert_annual(observation.maximum, observation.period, observation.currency, "EUR", rate)
    # A deterministic reference names these exact inputs; it does not claim an
    # external provider assigned a benchmark ID.
    material = "\0".join((observation.source.reference, observation.classification.determination.reference,
                          observation.currency, observation.period, str(observation.minimum), str(observation.maximum),
                          rate.source.reference if rate else "EUR:identity", rate.as_of if rate else ""))
    reference = "direct:" + hashlib.sha256(material.encode()).hexdigest()
    return DirectBenchmark(reference, observation, low, high, rate)
