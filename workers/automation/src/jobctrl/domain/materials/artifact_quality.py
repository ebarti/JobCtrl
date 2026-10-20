"""A separate model call judges usefulness and quality of final artifact lines."""

from jobctrl.domain.determinations import DeterminationFailure, Source, determine
from jobctrl.domain.ports.artifact_quality import (
    ArtifactQuality, ARTIFACT_QUALITY_SCHEMA_VERSION, ARTIFACT_QUALITY_PROMPT_VERSION,
)
from jobctrl.domain.ports.resume_adversarial import (
    ResumeAdversarialReview, RESUME_ADVERSARIAL_SCHEMA_VERSION, RESUME_ADVERSARIAL_PROMPT_VERSION,
)
from jobctrl.domain.materials.adversarial import ADVERSARIAL_REVIEW_PERSONAS, ADVERSARIAL_REVIEW_PERSONA_RUBRICS


class ModelArtifactQualityJudge:
    def __init__(self, *, llm, repository, tenant_id, provider, model, lane, preflight):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._lane, self._preflight = provider, model, lane, preflight

    @staticmethod
    def _validate_finding(finding, line_ids):
        if finding.line_id not in line_ids or finding.citation.source_id != "line:" + finding.line_id:
            raise DeterminationFailure("finding_line_binding_invalid", repair_context={
                "finding": finding.model_dump(),
                "line_ids": sorted(line_ids),
                "expected_citation_source_id": "line:" + finding.line_id if finding.line_id in line_ids else None,
            })

    def review_adversarial(self, *, entity_id, lines, sources, rubric):
        line_ids = {line.line_id for line in lines}

        def validate(result):
            if {row.persona for row in result.personas} != set(ADVERSARIAL_REVIEW_PERSONAS):
                raise DeterminationFailure("foreign_or_missing_persona")
            for persona in result.personas:
                for finding in persona.findings:
                    self._validate_finding(finding, line_ids)
                if persona.findings and persona.verdict != "fail":
                    raise DeterminationFailure("inconsistent_verdict")
            if result.verdict == "pass" and any(row.verdict != "pass" for row in result.personas):
                raise DeterminationFailure("inconsistent_verdict")

        return determine(
            kind="resume_adversarial",
            schema=ResumeAdversarialReview,
            schema_version=RESUME_ADVERSARIAL_SCHEMA_VERSION,
            prompt_version=RESUME_ADVERSARIAL_PROMPT_VERSION,
            instruction="Review the final resume from all six supplied personas. Each persona decides pass or fail, cites verbatim source spans and gives specific findings bound to the supplied line IDs. Each finding.line_id must be an exact context.line_ids value, and its citation.source_id must be 'line:' plus that line_id, quoting that rendered line. Return an overall pass/fail decision, with a diagnostic score and rationale. Scores do not gate acceptance. Factual support has a separate claim verifier, and general usefulness has a separate quality judge. Do not omit a persona or decide by a word list.",
            sources=[*(Source(source_id="line:" + line.line_id, text=line.text) for line in lines), *sources],
            context={"rubric": rubric, "personas": ADVERSARIAL_REVIEW_PERSONA_RUBRICS, "line_ids": [line.line_id for line in lines]},
            entity_id=entity_id,
            tenant_id=self._tenant_id,
            provider=self._provider,
            model=self._model,
            lane=self._lane,
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
            validate=validate,
        )

    def judge(self, *, artifact_kind, entity_id, lines, sources, rubric):
        line_ids = {line.line_id for line in lines}
        evidence_ids = {ident for line in lines for ident in line.allowed_evidence_ids}

        def validate(result: ArtifactQuality) -> None:
            for finding in result.findings:
                self._validate_finding(finding, line_ids)
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

        return determine(
            kind="artifact_quality",
            schema=ArtifactQuality,
            schema_version=ARTIFACT_QUALITY_SCHEMA_VERSION,
            prompt_version=ARTIFACT_QUALITY_PROMPT_VERSION,
            instruction="Judge the artifact's relevance, clarity, completeness, structure, voice and interview defensibility. Apply the supplied rubric by understanding the text. Return your pass/fail decision and a diagnostic quality score from 0 to 1, specific findings bound to supplied line IDs and verbatim quotations, and actionable repairs. Each finding.line_id must be an exact context.line_ids value, and its citation.source_id must be 'line:' plus that line_id, quoting that rendered line. If a repair requires adding saved candidate evidence, cite that evidence in evidence_corrections; only that list uses candidate evidence IDs, never posting or requirement IDs. Factual support has its own separate claim verifier. Do not use a numeric threshold to make this judgment.",
            sources=[*(Source(source_id="line:" + line.line_id, text=line.text) for line in lines), *sources],
            context={
                "artifact_kind": artifact_kind, "rubric": rubric,
                "line_ids": [line.line_id for line in lines],
                "allowed_evidence_correction_ids": sorted(evidence_ids),
            },
            tenant_id=self._tenant_id,
            entity_id=entity_id,
            provider=self._provider,
            model=self._model,
            lane=self._lane,
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
            validate=validate,
        )
