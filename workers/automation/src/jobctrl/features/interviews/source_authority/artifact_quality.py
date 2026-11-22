"""Pure Interview quality source binding; model choice stays at the gateway."""

from copy import deepcopy

from jobctrl.semantic.determinations import DeterminationFailure, Source, parse_model_result, validate_citations

from .claim_types import ArtifactLine
from .quality_types import ArtifactQuality

ARTIFACT_QUALITY_SCHEMA_VERSION = "2"
ARTIFACT_QUALITY_PROMPT_VERSION = "artifact-quality-v3"
QUALITY_INSTRUCTION = "Judge the artifact's relevance, clarity, completeness, structure, voice and interview defensibility. Apply the supplied rubric by understanding the text. Return your pass/fail decision and a diagnostic quality score from 0 to 1, specific findings bound to supplied line IDs and verbatim quotations, and actionable repairs. Each finding.line_id must be an exact context.line_ids value, and its citation.source_id must be 'line:' plus that line_id, quoting that rendered line. If a repair requires adding saved candidate evidence, cite that evidence in evidence_corrections; only that list uses candidate evidence IDs, never posting or requirement IDs. Factual support has its own separate claim verifier. Do not use a numeric threshold to make this judgment."


def _inventory(lines, sources):
    combined = [*(Source(source_id="line:" + line.line_id, text=line.text) for line in lines), *sources]
    if len({source.source_id for source in combined}) != len(combined):
        raise DeterminationFailure("duplicate_source_id")
    return combined


def validate_artifact_quality(result, *, lines, sources):
    """Validate model findings against the actual rendered lines and sources."""
    validate_citations(result, _inventory(lines, sources))
    line_ids = {line.line_id for line in lines}
    evidence_ids = {ident for line in lines for ident in line.allowed_evidence_ids}
    for finding in result.findings:
        if finding.line_id not in line_ids or finding.citation.source_id != "line:" + finding.line_id:
            raise DeterminationFailure("finding_line_binding_invalid", repair_context={
                "finding": finding.model_dump(), "line_ids": sorted(line_ids),
                "expected_citation_source_id": "line:" + finding.line_id if finding.line_id in line_ids else None,
            })
    invalid = [citation for citation in result.evidence_corrections if citation.source_id not in evidence_ids]
    if invalid:
        raise DeterminationFailure("foreign_source_id", repair_context={
            "evidence_corrections": [citation.model_dump() for citation in invalid],
            "allowed_evidence_correction_ids": sorted(evidence_ids),
        })
    if len({cite.source_id for cite in result.evidence_corrections}) != len(result.evidence_corrections):
        raise DeterminationFailure("duplicate_source_id")
    if (result.findings or result.evidence_corrections) and result.verdict != "fail":
        raise DeterminationFailure("inconsistent_verdict")


class ArtifactQualityRequest:
    def __init__(self, *, artifact_kind, lines, sources, rubric):
        self._lines = [line.model_copy(deep=True) for line in lines]
        self._sources = [source.model_copy(deep=True) for source in sources]
        self._inventory = _inventory(self._lines, self._sources)
        self._context = {"artifact_kind": artifact_kind, "rubric": deepcopy(rubric),
                         "line_ids": [line.line_id for line in self._lines],
                         "allowed_evidence_correction_ids": sorted({ident for line in self._lines for ident in line.allowed_evidence_ids})}
        self.response_model = ArtifactQuality
        self.instruction = QUALITY_INSTRUCTION

    @property
    def sources(self):
        return [source.model_copy(deep=True) for source in self._inventory]

    @property
    def context(self):
        return deepcopy(self._context)

    def validate(self, raw):
        result = parse_model_result(ArtifactQuality, raw)
        validate_artifact_quality(result, lines=self._lines, sources=self._sources)
        return result


def prepare_artifact_quality(*, artifact_kind: str, lines: list[ArtifactLine], sources: list[Source], rubric: dict):
    return ArtifactQualityRequest(artifact_kind=artifact_kind, lines=lines, sources=sources, rubric=rubric)
