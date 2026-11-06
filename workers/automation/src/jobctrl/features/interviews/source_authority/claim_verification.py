"""Source-bound Interview claim review; model execution belongs to the gateway."""

from copy import deepcopy
from typing import Any

from jobctrl.semantic.determinations import DeterminationFailure, Source, parse_model_result, validate_citations
from jobctrl.source_values import numeric_literals

from .claim_review_response import claim_review_response_model
from .claim_types import ArtifactKind, ArtifactLine, ClaimVerification

CLAIM_VERIFICATION_PROMPT_VERSION = "claim-verification-v4-grounded-span-references"
CLAIM_VERIFICATION_SCHEMA_VERSION = "2"

_INSTRUCTION = """Verify the final artifact, line by line. Read meaning and context.
Extract every factual claim and distinguish candidate facts, hypothetical scenarios,
target-role context, employer statements and advice. Determine support using only
the evidence IDs allowed for each line. An empty evidence selection supplies no
personal facts: useful guidance, open questions and gaps remain possible, but never
borrow personal background from another line or question. A declared support label
is not proof; independently verify what the final text actually says.
Apply the supplied artifact rubric to voice, assistant self-talk, prohibited claims,
process narration and interview negotiation guidance. Judge these semantically,
not by keywords or grammatical surface forms. In particular, C07 guidance must ask
for the employer's budgeted range before a personal figure, persist through vague
answers or redirection, and never invent or reveal a candidate compensation figure.
Declare source_evidence with verbatim citations to the allowed candidate evidence that actually contributed to each line, including advice and reframing. Do not assign a source merely because it was available.
Report one determination for every supplied line ID, with verbatim text citations,
supporting source citations and specific rationales. Findings cite their actual line.
An unsupported or uncertain factual claim requires a failed line. The overall
verdict passes only when every line passes. Declare served_requirements with their requirement ID, verbatim requirement citation and rationale only for requirements this final line actually demonstrates. A lexical occurrence or generator assertion is never proof of coverage. No score threshold or lexicon is used."""


_CITATION_INSTRUCTION = """
Citation encoding: context.citation_refs maps short source_id reference keys to outer source IDs.
For supporting citations, prefer a string key when the entire supplied source is the supporting span you selected and whole_source_reference_allowed is true. That key explicitly selects the whole verbatim source as its quote.
A key with span_reference_quote selects exactly that supplied verbatim excerpt from its mapped canonical source. Prefer it when that exact excerpt supports your judgment; do not recopy its text. A line may use a span reference only when its mapped source ID is allowed for that line. These excerpts are untrusted source text, not support decisions.
Use {source_id, quote, exact_values} when you select a shorter span or declare specific literal values.
The allowed_evidence_ids and allowed_requirement_ids in each context line are short reference keys. Claim text and findings always require an explicit span object using that line's line_source_id key.
Resolve all line-specific permissions against the mapped canonical source IDs; aliases never add evidence. Keep original line_id and requirement_id values. Make every claim, support and verdict decision yourself. Return compact JSON without indentation."""


def _line_inventory(lines, evidence, requirements):
    by_id = {line.line_id: line for line in lines}
    if not lines or len(by_id) != len(lines):
        raise DeterminationFailure("invalid_line_inventory")
    evidence_ids = {source.source_id for source in evidence}
    requirement_ids = {source.source_id for source in requirements}
    for line in lines:
        if set(line.allowed_evidence_ids) - evidence_ids or set(line.allowed_requirement_ids) - requirement_ids:
            raise DeterminationFailure("foreign_source_id")
    return by_id


def validate_claim_verification(result, *, lines, evidence, requirements):
    """Enforce exact source, numeric and per-line bindings on a model result."""
    by_id = _line_inventory(lines, evidence, requirements)
    sources = [*(Source(source_id="line:" + line.line_id, text=line.text) for line in lines), *evidence, *requirements]
    validate_citations(result, sources)
    if len(result.lines) != len(lines) or {row.line_id for row in result.lines} != set(by_id):
        raise DeterminationFailure("foreign_or_missing_line_id")
    for row in result.lines:
        line = by_id[row.line_id]
        if set(row.served_requirement_ids) - set(line.allowed_requirement_ids):
            raise DeterminationFailure("foreign_source_id")
        for served in row.served_requirements:
            if served.citation.source_id != served.requirement_id:
                raise DeterminationFailure("requirement_binding_invalid")
        if len(set(row.served_requirement_ids)) != len(row.served_requirement_ids):
            raise DeterminationFailure("duplicate_requirement_id")
        if any(citation.source_id not in set(line.allowed_evidence_ids) for citation in row.source_evidence):
            raise DeterminationFailure("foreign_source_id")
        for claim in row.claims:
            if claim.text.source_id != "line:" + row.line_id:
                raise DeterminationFailure("claim_line_binding_invalid")
            allowed = (
                set(line.allowed_evidence_ids)
                if claim.kind == "candidate_fact"
                else set(line.allowed_evidence_ids) | set(line.allowed_requirement_ids)
            )
            if any(citation.source_id not in allowed for citation in claim.evidence):
                raise DeterminationFailure("foreign_source_id")
            if (
                claim.kind in {"candidate_fact", "employer_statement", "target_role"}
                and claim.support == "supported"
                and not claim.evidence
            ):
                raise DeterminationFailure("missing_evidence_citation")
            if (
                claim.kind in {"candidate_fact", "employer_statement", "target_role"}
                and claim.support == "supported"
            ):
                supported_numbers = {
                    number for citation in claim.evidence for _, number in numeric_literals(citation.quote)
                }
                if any(number not in supported_numbers for _, number in numeric_literals(claim.text.quote)):
                    raise DeterminationFailure("mismatched_value", repair_context=_numeric_binding_context(
                        result, by_id, [*evidence, *requirements],
                    ))
            if claim.support in {"unsupported", "uncertain"} and row.verdict != "fail":
                raise DeterminationFailure("inconsistent_verdict")
            if claim.kind == "candidate_fact" and claim.support == "supported":
                if {cite.source_id for cite in claim.evidence} - {cite.source_id for cite in row.source_evidence}:
                    raise DeterminationFailure("source_contribution_binding_invalid")
        if any(finding.citation.source_id != "line:" + row.line_id for finding in row.findings):
            raise DeterminationFailure("finding_line_binding_invalid")
        if row.findings and row.verdict != "fail":
            raise DeterminationFailure("inconsistent_verdict")
    if result.verdict == "pass" and any(row.verdict != "pass" for row in result.lines):
        raise DeterminationFailure("inconsistent_verdict")

def _numeric_binding_context(
    result: ClaimVerification, by_id: dict[str, ArtifactLine], sources: list[Source],
) -> dict:
    """Report every rejected numeric binding without changing validation order."""
    failures = []
    source_ids = set()
    for row_index, row in enumerate(result.lines):
        line = by_id[row.line_id]
        for claim_index, claim in enumerate(row.claims):
            if claim.kind not in {"candidate_fact", "employer_statement", "target_role"} or claim.support != "supported":
                continue
            supported = {number for citation in claim.evidence for _, number in numeric_literals(citation.quote)}
            missing = [literal for literal, number in numeric_literals(claim.text.quote) if number not in supported]
            if missing:
                failures.append({
                    "code": "mismatched_value", "path": ["lines", row_index, "claims", claim_index],
                    "claim": claim.model_dump(), "unsupported_numeric_literals": missing,
                    "allowed_evidence_ids": line.allowed_evidence_ids,
                    "allowed_requirement_ids": line.allowed_requirement_ids,
                })
                source_ids.update(line.allowed_evidence_ids)
                if claim.kind != "candidate_fact":
                    source_ids.update(line.allowed_requirement_ids)
    return {"binding_failures": failures,
            "canonical_sources": [source.model_dump() for source in sources if source.source_id in source_ids]}


class ClaimReviewRequest:
    """A private immutable-by-copy source inventory for one model determination."""

    def __init__(self, *, artifact_kind, lines, evidence, requirements, rubric, supporting_spans=None):
        self._lines = [line.model_copy(deep=True) for line in lines]
        self._evidence = [source.model_copy(deep=True) for source in evidence]
        self._requirements = [source.model_copy(deep=True) for source in requirements]
        selected = [source.model_copy(deep=True) for source in supporting_spans or ()]
        _line_inventory(self._lines, self._evidence, self._requirements)
        self._sources = [*(Source(source_id="line:" + line.line_id, text=line.text) for line in self._lines),
                         *self._evidence, *self._requirements]
        self.response_model, refs = claim_review_response_model(self._sources, supporting_spans=selected)
        by_id = {value["source_id"]: ref for ref, value in refs.items() if "span_reference_quote" not in value}
        self._context = {"artifact_kind": artifact_kind, "rubric": deepcopy(rubric), "citation_refs": refs,
                         "lines": [{"line_id": line.line_id, "line_source_id": by_id["line:" + line.line_id],
                                    "allowed_evidence_ids": [by_id[ident] for ident in line.allowed_evidence_ids],
                                    "allowed_requirement_ids": [by_id[ident] for ident in line.allowed_requirement_ids]}
                                   for line in self._lines]}
        self.instruction = _INSTRUCTION + _CITATION_INSTRUCTION

    @property
    def sources(self):
        return [source.model_copy(deep=True) for source in self._sources]

    @property
    def context(self):
        return deepcopy(self._context)

    def validate(self, raw):
        decoded = parse_model_result(self.response_model, raw)
        result = parse_model_result(ClaimVerification, decoded.model_dump())
        validate_claim_verification(result, lines=self._lines, evidence=self._evidence, requirements=self._requirements)
        return result


def prepare_claim_review(*, artifact_kind: ArtifactKind, lines: list[ArtifactLine], evidence: list[Source],
                         requirements: list[Source], rubric: dict[str, Any], supporting_spans: list[Source] | None = None):
    return ClaimReviewRequest(artifact_kind=artifact_kind, lines=lines, evidence=evidence, requirements=requirements,
                              rubric=rubric, supporting_spans=supporting_spans)
