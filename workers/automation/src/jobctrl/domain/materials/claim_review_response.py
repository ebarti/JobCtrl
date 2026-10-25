"""Compact citation input that retains the canonical claim-verification result.

A reference selects a supplied whole source. A span selects an exact quote.
Neither representation decides support, contribution, coverage or any verdict.
"""

from __future__ import annotations

from collections.abc import Sequence
from copy import deepcopy
from typing import Annotated, Any, cast

from pydantic import BeforeValidator, Field, StrictStr, create_model

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, Source
from jobctrl.domain.ports.claim_verification import (
    ClaimVerification,
    LineVerification,
    ServedRequirement,
    VerificationFinding,
    VerifiedClaim,
)


def _field(owner, name, description=None):
    value = deepcopy(owner.model_fields[name])
    if description is not None:
        value.description = description
    return value


def claim_review_response_model(
    sources: Sequence[Source],
    *,
    supporting_spans: Sequence[Source] = (),
) -> tuple[type[ClaimVerification], dict[str, dict[str, Any]]]:
    """Bind one response model to one request's exact source inventory."""
    identifiers = {source.source_id for source in sources}
    if len(identifiers) != len(sources):
        raise DeterminationFailure("duplicate_source_id")
    if not sources:
        raise DeterminationFailure("source_schema_violation")
    # Snapshot caller-owned values before validating or building any decoder.
    canonical = {source.source_id: source.text for source in sources}
    quote_limit = Citation.model_json_schema()["properties"]["quote"]["maxLength"]
    selected_spans = []
    seen_spans = set()
    for selected in supporting_spans:
        ident, quote = selected.source_id, selected.text
        if ident not in canonical:
            raise DeterminationFailure("foreign_source_id")
        if not quote or quote not in canonical[ident]:
            raise DeterminationFailure("non_verbatim_quote")
        # Large excerpts retain the existing explicit-span path. Duplicates and
        # a whole source already have a compact representation; add no aliases.
        if len(quote) > quote_limit or quote == canonical[ident] or (ident, quote) in seen_spans:
            continue
        selected_spans.append((ident, quote))
        seen_spans.add((ident, quote))
    nonce = 0
    while True:
        references = [f"@{nonce}/{index}" for index in range(len(sources))]
        span_references = [f"@{nonce}/span/{index}" for index in range(len(selected_spans))]
        if identifiers.isdisjoint([*references, *span_references]):
            break
        nonce += 1
    # A span reference selects precisely its supplied quote within the original
    # canonical source. It never creates a new source or expands permissions.
    by_ref = {ref: (ident, text) for ref, (ident, text) in zip(references, canonical.items(), strict=True)}
    by_ref.update(zip(span_references, selected_spans, strict=True))
    explicit_refs = frozenset(references)
    whole_refs = [ref for ref in references if 0 < len(by_ref[ref][1]) <= quote_limit]
    supporting_refs = [*whole_refs, *span_references]
    reference_field = _field(
        Citation, "source_id", "Use a key from context.citation_refs, never an ID found inside source text."
    )
    reference_field.json_schema_extra = {"enum": references}
    span = create_model(
        "ClaimCitationSpan",
        __base__=DeterminationModel,
        source_id=(StrictStr, reference_field),
        quote=(StrictStr, _field(Citation, "quote")),
        exact_values=(list[StrictStr], _field(Citation, "exact_values")),
    )

    def source(ref):
        if ref not in by_ref:
            raise DeterminationFailure("foreign_source_id")
        return by_ref[ref]

    def decode_span(value):
        supplied = span.model_validate(value)
        if supplied.source_id not in explicit_refs:
            raise DeterminationFailure("foreign_source_id")
        ident, _text = source(supplied.source_id)
        return Citation(source_id=ident, quote=supplied.quote, exact_values=supplied.exact_values)

    def decode_reference(value):
        if not isinstance(value, str):
            return decode_span(value)
        ident, text = source(value)
        if value not in supporting_refs:
            raise DeterminationFailure(
                "schema_violation",
                repair_context={
                    "source_id": value,
                    "reason": "whole_source_reference_not_allowed",
                    "max_quote_characters": quote_limit,
                },
            )
        return Citation(source_id=ident, quote=text, exact_values=[])

    span_citation = Annotated[Citation, BeforeValidator(decode_span, json_schema_input_type=span)]
    reference_input = span
    if supporting_refs:
        whole = Annotated[StrictStr, Field(json_schema_extra={"enum": supporting_refs})]
        reference_input = whole | span
    source_citation = Annotated[
        Citation,
        BeforeValidator(decode_reference, json_schema_input_type=reference_input),
    ]
    claim = create_model(
        "ClaimVerificationClaim",
        __base__=VerifiedClaim,
        text=(
            span_citation,
            _field(
                VerifiedClaim,
                "text",
                "Use this context line's line_source_id reference and a verbatim final-line span. Never cite supporting evidence in this slot.",
            ),
        ),
        evidence=(list[source_citation], _field(VerifiedClaim, "evidence")),
    )
    served = create_model(
        "ClaimServedRequirement",
        __base__=ServedRequirement,
        citation=(source_citation, _field(ServedRequirement, "citation")),
    )
    finding = create_model(
        "ClaimVerificationFinding",
        __base__=VerificationFinding,
        citation=(
            span_citation,
            _field(
                VerificationFinding,
                "citation",
                "Use the affected context line's line_source_id reference and a verbatim final-line quote.",
            ),
        ),
    )
    line = create_model(
        "ClaimVerificationLine",
        __base__=LineVerification,
        served_requirements=(list[served], _field(LineVerification, "served_requirements")),
        source_evidence=(list[source_citation], _field(LineVerification, "source_evidence")),
        claims=(list[claim], _field(LineVerification, "claims")),
        findings=(list[finding], _field(LineVerification, "findings")),
    )
    response = create_model(
        "ClaimVerification",
        __base__=ClaimVerification,
        lines=(list[line], _field(ClaimVerification, "lines")),
    )
    context = {
        ref: {"source_id": ident, "whole_source_reference_allowed": ref in whole_refs}
        for ref, (ident, _text) in by_ref.items()
    }
    for ref in span_references:
        context[ref]["span_reference_quote"] = by_ref[ref][1]
    return cast(type[ClaimVerification], response), context
