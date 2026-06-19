"""Deterministic parser for employer-posted compensation text."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Literal

PARSER_VERSION = "posted-compensation-v1"
SOURCE_TEXT_LIMIT = 280

ParseState = Literal["missing", "unparseable", "ambiguous", "parsed_range"]
CompensationComponent = Literal["base_salary", "ote", "bonus", "commission", "equity", "unknown"]
CompensationPeriod = Literal["hour", "month", "year", "unknown"]
ConfidenceLevel = Literal["none", "low", "medium", "high"]
WarningCode = Literal[
    "ambiguous_multiple_amounts",
    "bonus_component",
    "broad_range",
    "commission_component",
    "equity_component",
    "hourly_period",
    "missing_currency",
    "missing_period",
    "monthly_period",
    "no_amount_found",
    "one_sided_range",
    "ote_component",
    "source_text_truncated",
]

PARSE_STATES: tuple[ParseState, ...] = ("missing", "unparseable", "ambiguous", "parsed_range")
COMPONENTS: tuple[CompensationComponent, ...] = (
    "base_salary",
    "ote",
    "bonus",
    "commission",
    "equity",
    "unknown",
)
PERIODS: tuple[CompensationPeriod, ...] = ("hour", "month", "year", "unknown")
CONFIDENCE_LEVELS: tuple[ConfidenceLevel, ...] = ("none", "low", "medium", "high")
WARNING_CODES: tuple[WarningCode, ...] = (
    "ambiguous_multiple_amounts",
    "bonus_component",
    "broad_range",
    "commission_component",
    "equity_component",
    "hourly_period",
    "missing_currency",
    "missing_period",
    "monthly_period",
    "no_amount_found",
    "one_sided_range",
    "ote_component",
    "source_text_truncated",
)

_AMOUNT_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?:(?:[€$£]|[A-Z]{3})\s*)?(\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?|\d+(?:[,.]\d+)?)(?:\s*[kK])?(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_CURRENCY_CODES = ("EUR", "USD", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK")
_CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP"}


@dataclass(frozen=True)
class _Amount:
    value: int
    start: int
    end: int
    explicit_k: bool


@dataclass(frozen=True)
class PostedCompensationFact:
    """Persistable posted compensation fact derived from bounded source text."""

    tenant_id: str
    job_url: str
    source_field: str
    source_text: str | None
    legacy_raw_salary: str | None
    parse_state: ParseState
    currency: str | None
    period: CompensationPeriod
    component: CompensationComponent
    minimum_amount: int | None
    maximum_amount: int | None
    annualized_minimum_amount: int | None
    annualized_maximum_amount: int | None
    annualization_assumption: str | None
    confidence: ConfidenceLevel
    warnings: tuple[WarningCode, ...]
    parser_version: str
    source_hash: str
    parsed_at: str


def parse_posted_compensation(
    source_text: str | None,
    *,
    tenant_id: str = "local",
    job_url: str = "",
    source_field: str = "jobs.salary",
    parsed_at: str | None = None,
) -> PostedCompensationFact:
    """Parse a bounded salary/source string into a durable compensation fact."""

    now = parsed_at or datetime.now(timezone.utc).isoformat()
    bounded, truncated = _bounded_source_text(source_text)
    raw_fallback = bounded
    source_hash = _source_hash(bounded)
    warnings: list[WarningCode] = []
    if truncated:
        warnings.append("source_text_truncated")

    if bounded is None:
        return PostedCompensationFact(
            tenant_id=tenant_id,
            job_url=job_url,
            source_field=source_field,
            source_text=None,
            legacy_raw_salary=None,
            parse_state="missing",
            currency=None,
            period="unknown",
            component="unknown",
            minimum_amount=None,
            maximum_amount=None,
            annualized_minimum_amount=None,
            annualized_maximum_amount=None,
            annualization_assumption=None,
            confidence="none",
            warnings=tuple(warnings),
            parser_version=PARSER_VERSION,
            source_hash=source_hash,
            parsed_at=now,
        )

    lower = bounded.casefold()
    component = _detect_component(lower)
    warnings.extend(_component_warnings(lower))
    currency = _detect_currency(bounded)
    if currency is None:
        warnings.append("missing_currency")
    period = _detect_period(lower)
    warnings.extend(_period_warnings(period))

    amounts = _extract_amounts(bounded)
    if not amounts:
        return _non_range_fact(
            tenant_id=tenant_id,
            job_url=job_url,
            source_field=source_field,
            source_text=bounded,
            raw_fallback=raw_fallback,
            parse_state="unparseable",
            confidence="low",
            warnings=_dedupe_warnings([*warnings, "no_amount_found"]),
            parsed_at=now,
            source_hash=source_hash,
        )

    if len(amounts) > 2:
        return _non_range_fact(
            tenant_id=tenant_id,
            job_url=job_url,
            source_field=source_field,
            source_text=bounded,
            raw_fallback=raw_fallback,
            parse_state="ambiguous",
            confidence="low",
            warnings=_dedupe_warnings([*warnings, "ambiguous_multiple_amounts"]),
            parsed_at=now,
            source_hash=source_hash,
        )
    if len(amounts) > 1 and (_has_mixed_compensation_components(lower) or _has_additive_component_phrase(lower)):
        return _non_range_fact(
            tenant_id=tenant_id,
            job_url=job_url,
            source_field=source_field,
            source_text=bounded,
            raw_fallback=raw_fallback,
            parse_state="ambiguous",
            confidence="low",
            warnings=_dedupe_warnings([*warnings, "ambiguous_multiple_amounts"]),
            parsed_at=now,
            source_hash=source_hash,
        )

    minimum, maximum, one_sided = _range_bounds(amounts, lower)
    if one_sided:
        warnings.append("one_sided_range")
    if _is_broad_range(minimum, maximum):
        warnings.append("broad_range")

    annual_min, annual_max, assumption = _annualize(minimum, maximum, period)
    confidence = _confidence(period, currency, warnings)
    return PostedCompensationFact(
        tenant_id=tenant_id,
        job_url=job_url,
        source_field=source_field,
        source_text=bounded,
        legacy_raw_salary=raw_fallback,
        parse_state="parsed_range",
        currency=currency,
        period=period,
        component=component,
        minimum_amount=minimum,
        maximum_amount=maximum,
        annualized_minimum_amount=annual_min,
        annualized_maximum_amount=annual_max,
        annualization_assumption=assumption,
        confidence=confidence,
        warnings=_dedupe_warnings(warnings),
        parser_version=PARSER_VERSION,
        source_hash=source_hash,
        parsed_at=now,
    )


def _non_range_fact(
    *,
    tenant_id: str,
    job_url: str,
    source_field: str,
    source_text: str,
    raw_fallback: str | None,
    parse_state: Literal["unparseable", "ambiguous"],
    confidence: ConfidenceLevel,
    warnings: tuple[WarningCode, ...],
    parsed_at: str,
    source_hash: str,
) -> PostedCompensationFact:
    return PostedCompensationFact(
        tenant_id=tenant_id,
        job_url=job_url,
        source_field=source_field,
        source_text=source_text,
        legacy_raw_salary=raw_fallback,
        parse_state=parse_state,
        currency=None,
        period="unknown",
        component="unknown",
        minimum_amount=None,
        maximum_amount=None,
        annualized_minimum_amount=None,
        annualized_maximum_amount=None,
        annualization_assumption=None,
        confidence=confidence,
        warnings=warnings,
        parser_version=PARSER_VERSION,
        source_hash=source_hash,
        parsed_at=parsed_at,
    )


def _bounded_source_text(value: str | None) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    normalized = re.sub(r"\s+", " ", str(value).strip())
    if not normalized:
        return None, False
    if len(normalized) <= SOURCE_TEXT_LIMIT:
        return normalized, False
    return normalized[:SOURCE_TEXT_LIMIT].rstrip(), True


def _source_hash(value: str | None) -> str:
    payload = f"{PARSER_VERSION}\n{value or ''}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _detect_currency(text: str) -> str | None:
    for symbol, code in _CURRENCY_SYMBOLS.items():
        if symbol in text:
            return code
    upper = text.upper()
    for code in _CURRENCY_CODES:
        if re.search(rf"(?<![A-Z]){code}(?=\s*\d|\b)", upper):
            return code
    return None


def _detect_period(lower: str) -> CompensationPeriod:
    if re.search(r"(/|\b)(hour|hourly|hr|hrs|h)\b", lower):
        return "hour"
    if re.search(r"(/|\b)(month|monthly|mo|mos)\b", lower):
        return "month"
    if re.search(r"(/|\b)(year|yearly|annual|annually|annum|yr|yrs)\b", lower):
        return "year"
    return "unknown"


def _period_warnings(period: CompensationPeriod) -> list[WarningCode]:
    if period == "hour":
        return ["hourly_period"]
    if period == "month":
        return ["monthly_period"]
    if period == "unknown":
        return ["missing_period"]
    return []


def _detect_component(lower: str) -> CompensationComponent:
    if re.search(r"\bbase\b|\bsalary\b|\bpay\b|\bwage\b", lower):
        return "base_salary"
    if re.search(r"\bote\b|on[- ]target earnings", lower):
        return "ote"
    if "commission" in lower:
        return "commission"
    if "bonus" in lower:
        return "bonus"
    if re.search(r"\bequity\b|\brsu\b|\bstock options?\b", lower):
        return "equity"
    return "unknown"


def _component_warnings(lower: str) -> list[WarningCode]:
    warnings: list[WarningCode] = []
    if re.search(r"\bote\b|on[- ]target earnings", lower):
        warnings.append("ote_component")
    if "bonus" in lower:
        warnings.append("bonus_component")
    if "commission" in lower:
        warnings.append("commission_component")
    if re.search(r"\bequity\b|\brsu\b|\bstock options?\b", lower):
        warnings.append("equity_component")
    return warnings


def _has_mixed_compensation_components(lower: str) -> bool:
    component_hits = 0
    for pattern in (
        r"\bbase\b|\bsalary\b|\bwage\b",
        r"\bote\b|on[- ]target earnings",
        r"\bbonus\b",
        r"\bcommission\b",
        r"\bequity\b|\brsu\b|\bstock options?\b",
    ):
        if re.search(pattern, lower):
            component_hits += 1
    return component_hits > 1


def _has_additive_component_phrase(lower: str) -> bool:
    return bool(
        re.search(
            r"(?:\+|\bplus\b|\band\b).{0,24}\b(?:bonus|commission|equity|rsu|ote|on[- ]target earnings)\b",
            lower,
        )
    )


def _extract_amounts(text: str) -> list[_Amount]:
    amounts: list[_Amount] = []
    for match in _AMOUNT_PATTERN.finditer(text):
        if text[match.end() :].lstrip().startswith("%"):
            continue
        token = match.group(0)
        parsed = _parse_amount_token(token)
        if parsed is None:
            continue
        amounts.append(_Amount(value=parsed, start=match.start(), end=match.end(), explicit_k="k" in token.casefold()))
    if len(amounts) >= 2 and any(amount.explicit_k for amount in amounts):
        amounts = [
            _Amount(amount.value * 1000, amount.start, amount.end, amount.explicit_k)
            if not amount.explicit_k and amount.value < 1000
            else amount
            for amount in amounts
        ]
    return amounts


def _parse_amount_token(token: str) -> int | None:
    cleaned = re.sub(r"[€$£A-Za-z\s]", "", token)
    if not cleaned:
        return None
    multiplier = Decimal("1000") if "k" in token.casefold() else Decimal("1")
    cleaned = _normalize_numeric_text(cleaned)
    try:
        amount = Decimal(cleaned) * multiplier
    except InvalidOperation:
        return None
    if amount <= 0:
        return None
    rounded = int(amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return rounded if rounded > 0 else None


def _normalize_numeric_text(value: str) -> str:
    if "," in value and "." in value:
        if value.rfind(",") > value.rfind("."):
            return value.replace(".", "").replace(",", ".")
        return value.replace(",", "")
    if "," in value:
        before, after = value.rsplit(",", 1)
        if len(after) == 3:
            return value.replace(",", "")
        return value.replace(",", ".")
    if "." in value:
        before, after = value.rsplit(".", 1)
        if len(after) == 3 and len(before) <= 3:
            return value.replace(".", "")
    return value


def _range_bounds(amounts: list[_Amount], lower: str) -> tuple[int | None, int | None, bool]:
    if len(amounts) == 1:
        value = amounts[0].value
        if re.search(r"\b(up to|under|below|less than|max(?:imum)?)\b", lower):
            return None, value, True
        if re.search(r"\b(from|starting at|at least|min(?:imum)?)\b", lower) or "+" in lower:
            return value, None, True
        return value, value, False
    first, second = amounts
    low = min(first.value, second.value)
    high = max(first.value, second.value)
    return low, high, False


def _is_broad_range(minimum: int | None, maximum: int | None) -> bool:
    if minimum is None or maximum is None or minimum <= 0 or maximum <= minimum:
        return False
    return (maximum / minimum) >= 1.5 or (maximum - minimum) >= 75_000


def _annualize(
    minimum: int | None,
    maximum: int | None,
    period: CompensationPeriod,
) -> tuple[int | None, int | None, str | None]:
    if period == "year":
        return minimum, maximum, "Source text states annual compensation."
    if period == "month":
        return _multiply(minimum, 12), _multiply(maximum, 12), "Monthly amounts annualized by multiplying by 12."
    if period == "hour":
        return (
            _multiply(minimum, 2080),
            _multiply(maximum, 2080),
            "Hourly amounts annualized by multiplying by 2,080 work hours.",
        )
    return None, None, None


def _multiply(value: int | None, multiplier: int) -> int | None:
    return None if value is None else value * multiplier


def _confidence(
    period: CompensationPeriod,
    currency: str | None,
    warnings: list[WarningCode],
) -> ConfidenceLevel:
    warning_set = set(warnings)
    if period == "unknown" and currency is None:
        return "low"
    if {"hourly_period", "broad_range", "ambiguous_multiple_amounts"} & warning_set:
        return "low"
    if warning_set:
        return "medium"
    return "high"


def _dedupe_warnings(warnings: list[WarningCode]) -> tuple[WarningCode, ...]:
    return tuple(dict.fromkeys(warnings))
