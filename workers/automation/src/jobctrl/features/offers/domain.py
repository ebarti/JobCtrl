"""Validate explicitly attested terms without deriving or filling unknown facts."""

from __future__ import annotations

import math
import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator
from typing import Literal


class OfferInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def _timestamp(value: str) -> str:
    value = value.strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", value):
        raise ValueError("expected UTC timestamp")
    datetime.fromisoformat(value[:-1] + "+00:00")
    return value


def _uuid(value: str) -> str:
    # Match the public UUID string contract and retain its original spelling.
    if str(UUID(value)) != value.lower():
        raise ValueError("expected UUID")
    return value


class Source(OfferInput):
    reference: StrictStr = Field(min_length=1, max_length=1000)
    quote: StrictStr = Field(min_length=1, max_length=8000)
    capturedAt: StrictStr
    userConfirmed: Literal[True]

    @field_validator("userConfirmed", mode="before")
    @classmethod
    def confirmed_is_true(cls, value):
        if value is not True:
            raise ValueError("explicit user confirmation is required")
        return value

    @field_validator("reference")
    @classmethod
    def trim_reference(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("source reference is required")
        return value

    @field_validator("quote")
    @classmethod
    def quote_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("source quote is required")
        return value

    _captured = field_validator("capturedAt")(_timestamp)


class Cash(OfferInput):
    component: Literal["base_salary", "bonus", "signing_bonus", "commission", "other"]
    amount: float = Field(ge=0, le=1e12, allow_inf_nan=False)
    currency: StrictStr | None
    period: Literal["year", "month", "week", "hour", "one_off", "unknown"]
    source: Source

    @field_validator("amount", mode="before")
    @classmethod
    def number_only(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("amount must be finite")
        return value

    @field_validator("currency")
    @classmethod
    def currency_code(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"[A-Z]{3}", value):
            raise ValueError("expected currency code")
        return value


class SourcedText(OfferInput):
    value: StrictStr = Field(min_length=1, max_length=4000)
    source: Source

    @field_validator("value")
    @classmethod
    def trim_value(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value is required")
        return value


class SourcedDeadline(OfferInput):
    value: StrictStr
    source: Source
    _value_timestamp = field_validator("value")(_timestamp)


class Terms(OfferInput):
    source: Source
    cash: list[Cash] = Field(max_length=20)
    equity: SourcedText | None
    benefits: SourcedText | None
    decisionDeadline: SourcedDeadline | None


class SaveTerms(OfferInput):
    expectedRevisionId: StrictStr | None
    terms: Terms
    correctionReason: StrictStr | None = None

    @field_validator("expectedRevisionId")
    @classmethod
    def revision_id(cls, value: str | None) -> str | None:
        return _uuid(value) if value is not None else None

    @field_validator("correctionReason")
    @classmethod
    def reason(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value or len(value) > 1000:
            raise ValueError("correction reason is required")
        return value


class RecordDecision(OfferInput):
    expectedDecisionId: StrictStr | None
    termsRevisionId: StrictStr
    decision: Literal["accepted", "declined"]
    occurredAt: StrictStr
    source: Source
    correctionReason: StrictStr | None = None

    @field_validator("expectedDecisionId", "termsRevisionId")
    @classmethod
    def decision_id(cls, value: str | None) -> str | None:
        return _uuid(value) if value is not None else None

    _occurred = field_validator("occurredAt")(_timestamp)
    _reason = field_validator("correctionReason")(SaveTerms.reason.__func__)
