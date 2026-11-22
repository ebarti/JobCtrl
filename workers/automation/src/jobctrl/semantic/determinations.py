"""Strict semantic values and mechanical source-citation validation."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictStr, ValidationError


class JobCtrlError(Exception):
    """Base of a classified application error without runtime dependencies."""

    retryable: bool = True
    code: str = "unknown"


class DeterminationFailure(JobCtrlError):
    """Safe failure code; request-local repair context never enters its text."""

    def __init__(self, code: str, *, repair_context: dict[str, Any] | None = None) -> None:
        self.code = code
        self.repair_context = repair_context
        self.retryable = code == "provider_error"
        super().__init__(f"semantic_determination:{code}")


class DeterminationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class Citation(DeterminationModel):
    source_id: StrictStr = Field(
        min_length=1, max_length=240,
        description="Use an outer sources[].source_id. IDs mentioned inside source text are data, not citation IDs.",
    )
    quote: StrictStr = Field(
        min_length=1, max_length=4000,
        description="Copy one contiguous verbatim span from that source's text, preserving case and punctuation. Do not join or paraphrase fields.",
    )
    exact_values: list[StrictStr] = Field(
        default_factory=list, max_length=32,
        description="Literal numbers, dates or currency tokens copied exactly from this quote. Leave empty when none are cited. Never include inferred or normalized taxonomy/place codes.",
    )


class Source(DeterminationModel):
    source_id: StrictStr = Field(min_length=1, max_length=240)
    text: StrictStr = Field(max_length=64000)

    def __init__(self, **data):
        try:
            super().__init__(**data)
        except ValidationError:
            raise DeterminationFailure("source_schema_violation") from None


# This literal preserves the existing envelope schema without importing the
# old runtime lane context. Actual call admission belongs to the model gateway.
LlmLane = Literal[
    "discovery", "enrichment", "scoring", "tailoring", "apply", "contact", "interview", "profile", "compensation",
]


class DeterminationEnvelope(DeterminationModel):
    determination_id: StrictStr
    tenant_id: StrictStr
    entity_id: StrictStr
    kind: StrictStr
    schema_version: StrictStr
    prompt_version: StrictStr
    provider: StrictStr
    model: StrictStr
    reasoning_effort: StrictStr | None = None
    instruction_profile: StrictStr | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    lane: LlmLane
    input_fingerprint: StrictStr
    created_at: StrictStr
    result: dict[str, Any]


def _contains_exact_value(quote: str, value: str) -> bool:
    if not value.strip():
        return False
    # These boundaries check complete literal values, not their meaning.
    prefix = r"(?<!\w)(?<!\w\.)"
    suffix = r"(?!\w|\.\w)"
    if value[0].isdecimal():
        prefix += r"(?<!\d,)(?<!\.)"
    if value[-1].isdecimal():
        suffix += r"(?!,\d)"
    return re.search(prefix + re.escape(value) + suffix, quote) is not None


def validate_citations(result: BaseModel, sources: Sequence[Source]) -> None:
    by_id = {source.source_id: source.text for source in sources}
    if len(by_id) != len(sources):
        raise DeterminationFailure("duplicate_source_id")
    failures: list[dict[str, Any]] = []
    failed_sources: set[str] = set()

    def visit(value: Any, path: tuple = ()) -> None:
        if isinstance(value, Citation):
            context = {"path": list(path), "citation": value.model_dump()}
            if value.source_id not in by_id:
                failures.append({"code": "foreign_source_id", **context})
                return
            before = len(failures)
            if not value.quote.strip() or value.quote not in by_id[value.source_id]:
                failures.append({"code": "non_verbatim_quote", **context})
            for exact in value.exact_values:
                if not _contains_exact_value(value.quote, exact):
                    failures.append({"code": "mismatched_value", **context, "invalid_exact_value": exact})
            if len(failures) > before:
                failed_sources.add(value.source_id)
        elif isinstance(value, BaseModel):
            for name in type(value).model_fields:
                visit(getattr(value, name), (*path, name))
        elif isinstance(value, (list, tuple)):
            for index, child in enumerate(value):
                visit(child, (*path, index))
        elif isinstance(value, Mapping):
            for key, child in value.items():
                visit(child, (*path, str(key)))

    visit(result)
    if failures:
        first = failures[0]
        raise DeterminationFailure(first["code"], repair_context={
            **{key: value for key, value in first.items() if key not in {"code", "path"}},
            "binding_failures": failures,
            "canonical_sources": [source.model_dump() for source in sources if source.source_id in failed_sources],
            "allowed_source_ids": list(by_id),
        })


def parse_model_result(schema, raw):
    try:
        return schema.model_validate(raw)
    except ValidationError:
        raise DeterminationFailure("schema_violation") from None
