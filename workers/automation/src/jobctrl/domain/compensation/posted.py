"""Model extraction of pay meaning with mechanical exact-number checks."""

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import re
from typing import Literal
from pydantic import Field, StrictInt
from jobctrl.domain.determinations import Citation, DeterminationModel, DeterminationFailure, Source, determine
from jobctrl.domain.exact_values import numeric_literals
from jobctrl.domain.identifiers import JobId, canonical_job_id

PARSER_VERSION = "posted-compensation-v5-determination"
SOURCE_TEXT_LIMIT = 280
ParseState = Literal["missing", "unparseable", "ambiguous", "parsed_range"]
CompensationComponent = Literal["base_salary", "ote", "bonus", "commission", "equity", "unknown"]
CompensationPeriod = Literal["hour", "month", "year", "unknown"]
ConfidenceLevel = Literal["none", "low", "medium", "high"]
WarningCode = Literal[
    "annual_period_inferred",
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
PARSE_STATES = ("missing", "unparseable", "ambiguous", "parsed_range")
COMPONENTS = ("base_salary", "ote", "bonus", "commission", "equity", "unknown")
PERIODS = ("hour", "month", "year", "unknown")
CONFIDENCE_LEVELS = ("none", "low", "medium", "high")
WARNING_CODES = (
    "annual_period_inferred",
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
# Format parsing remains available for numeric/source binding.
_AMOUNT_PATTERN = re.compile(r"(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?(?:[kK](?!\w))?(?![\w.])")


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
    job_id: JobId | None
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


class PostedPayExtraction(DeterminationModel):
    parse_state: ParseState
    currency: str | None = Field(pattern=r"^[A-Z]{3}$")
    period: CompensationPeriod
    component: CompensationComponent
    minimum_amount: StrictInt | None = Field(ge=0)
    maximum_amount: StrictInt | None = Field(ge=0)
    confidence: ConfidenceLevel
    warnings: list[WarningCode] = Field(max_length=16)
    citations: list[Citation] = Field(max_length=12)
    rationale: str = Field(min_length=1, max_length=1000)


class ModelPostedPayExtractor:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def extract(self, text, *, entity_id):
        source = Source(source_id="posted_compensation_source", text=text or "")

        def validate(result):
            numbers = {number for cite in result.citations for _, number in numeric_literals(cite.quote)}
            amounts = (result.minimum_amount, result.maximum_amount)
            if any(Decimal(value) not in numbers for value in amounts if value is not None):
                raise DeterminationFailure("mismatched_value")
            if all(value is not None for value in amounts) and amounts[0] > amounts[1]:
                raise DeterminationFailure("invalid_numeric_range")
            if result.parse_state == "parsed_range":
                if not result.citations or not any(value is not None for value in amounts) or result.currency is None:
                    raise DeterminationFailure("missing_compensation_citation")
            elif any(value is not None for value in amounts):
                raise DeterminationFailure("inconsistent_verdict")

        return determine(
            kind="posted_compensation",
            schema=PostedPayExtraction,
            schema_version="1",
            prompt_version="posted-compensation-v1",
            entity_id=entity_id,
            sources=[source],
            context={},
            instruction="Extract the employer's stated compensation. Understand which amounts are pay rather than revenue, funding or benefits, what component and currency they describe, and whether they are a range, a floor or a ceiling. An uncertain or mixed pay statement remains ambiguous; absence remains missing. Cite the precise pay statements with verbatim spans and explain the decision. Preserve every stated amount, expanding only explicit numeric multipliers. Never infer an annual period from magnitude or silently promote bonus/equity/OTE into base salary.",
            validate=validate,
            **self._dependencies,
        )


def posted_fact_from_extraction(result, envelope, *, source_text, tenant_id, job_id, source_field, parsed_at=None):
    lower, upper = result.minimum_amount, result.maximum_amount
    multiplier = (
        12 if result.period == "month" else 2080 if result.period == "hour" else 1 if result.period == "year" else None
    )
    cited = "\n".join(cite.quote for cite in result.citations) or (source_text or "")
    return PostedCompensationFact(
        tenant_id=tenant_id,
        job_id=canonical_job_id(str(job_id)) if job_id is not None else None,
        source_field=source_field,
        source_text=cited[:SOURCE_TEXT_LIMIT] or None,
        legacy_raw_salary=(source_text or "")[:SOURCE_TEXT_LIMIT] or None,
        parse_state=result.parse_state,
        currency=result.currency,
        period=result.period,
        component=result.component,
        minimum_amount=lower,
        maximum_amount=upper,
        annualized_minimum_amount=lower * multiplier if lower is not None and multiplier else None,
        annualized_maximum_amount=upper * multiplier if upper is not None and multiplier else None,
        annualization_assumption="2080 hours/year"
        if result.period == "hour"
        else "12 months/year"
        if result.period == "month"
        else None,
        confidence=result.confidence,
        warnings=tuple(
            dict.fromkeys([*result.warnings, *(["source_text_truncated"] if len(cited) > SOURCE_TEXT_LIMIT else [])])
        ),
        parser_version=PARSER_VERSION,
        source_hash=hashlib.sha256((source_text or "").encode()).hexdigest(),
        parsed_at=parsed_at or datetime.now(timezone.utc).isoformat(),
    )
