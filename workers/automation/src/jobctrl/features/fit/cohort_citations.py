"""Explicit references to complete factual sources or exact lines in a cohort batch."""

from pydantic import Field, StrictInt, StrictStr, ValidationError

from jobctrl.app.errors import AppError

from .models import Citation, Decision, QualificationBatchDecision, QualificationDecision
from .sources import fingerprint

RESPONSE_VERSION = "fit-qualification-citation-refs-v1"
RESPONSE_INSTRUCTIONS = """
Cohort citation transport: use context.cohort_citation_sources to select an exact supplied source.
In evidence or requirement_citations, {"source_ref":"sN","line":null} explicitly selects the complete
unmodified text of that source; {"source_ref":"sN","line":1} selects its first complete line (numbered
from one, excluding line terminators). Use an exact reference when that text establishes the claim.
For any other verbatim substring, use the original {"source_id","quote"} citation. Each resolved quote
must be nonblank and at most 6000 characters. An employer source is never candidate evidence.
Apply every original source-role, permitted-evidence, assessment and citation rule unchanged.
"""


class SourceSelection(Decision):
    source_ref: StrictStr = Field(min_length=1)
    line: StrictInt | None = Field(ge=1)


class CohortQualification(QualificationDecision):
    evidence: list[Citation | SourceSelection] = Field(max_length=80)
    requirement_citations: list[Citation | SourceSelection] = Field(min_length=1, max_length=8)


class CohortQualificationBatch(Decision):
    requirements: list[CohortQualification] = Field(min_length=1)


def citation_inventory(sources):
    return {f"s{index}": row["source_id"] for index, row in enumerate(sources, 1)}


def bind_cohort_citations(result, sources, inventory):
    if inventory != citation_inventory(sources):
        raise AppError("fit_cohort_citation_invalid", "The cohort citation inventory changed.", 422)
    texts = {row["source_id"]: row["text"] for row in sources}
    raw = result.model_dump()
    rows, bindings = [], []
    for raw_row in raw["requirements"]:
        row = dict(raw_row)
        selections = []
        for field in ("evidence", "requirement_citations"):
            row[field] = []
            for citation in raw_row[field]:
                if "source_id" in citation:
                    row[field].append(citation)
                    continue
                source_id = inventory.get(citation["source_ref"])
                if source_id is None:
                    raise AppError("fit_foreign_source_id", "The cohort response selected an unavailable source.", 422)
                text = texts[source_id]
                if citation["line"] is not None:
                    lines = text.splitlines()
                    if not 1 <= citation["line"] <= len(lines):
                        raise AppError("fit_cohort_citation_invalid", "The selected source line does not exist.", 422)
                    text = lines[citation["line"] - 1]
                row[field].append({"source_id": source_id, "quote": text})
                selections.append({**citation, "field": field, "source_id": source_id,
                                   "quote_fingerprint": fingerprint(text)})
        rows.append(row)
        bindings.append({"raw_row_fingerprint": fingerprint(raw_row), "selections": selections})
    try:
        expanded = QualificationBatchDecision.model_validate({"requirements": rows})
    except ValidationError:
        raise AppError("fit_cohort_citation_invalid", "A selected quotation exceeds its source contract.", 422) from None
    common = {"version": RESPONSE_VERSION, "source_inventory_fingerprint": fingerprint(inventory),
              "raw_batch_fingerprint": fingerprint(raw), "expanded_batch_fingerprint": fingerprint(expanded.model_dump())}
    return expanded, [{**common, **binding} for binding in bindings]
