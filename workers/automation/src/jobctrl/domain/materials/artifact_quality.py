"""A separate model call judges usefulness and quality of final artifact lines."""

from jobctrl.domain.determinations import DeterminationFailure, Source, determine
from jobctrl.domain.ports.artifact_quality import ArtifactQuality
from jobctrl.domain.ports.resume_adversarial import ResumeAdversarialReview
from jobctrl.domain.materials.adversarial import ADVERSARIAL_REVIEW_PERSONAS, ADVERSARIAL_REVIEW_PERSONA_RUBRICS


class ModelArtifactQualityJudge:
    def __init__(self, *, llm, repository, tenant_id, provider, model, lane, preflight):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._lane, self._preflight = provider, model, lane, preflight

    def review_adversarial(self, *, entity_id, lines, sources, rubric):
        line_ids = {line.line_id for line in lines}

        def validate(result):
            if {row.persona for row in result.personas} != set(ADVERSARIAL_REVIEW_PERSONAS):
                raise DeterminationFailure("foreign_or_missing_persona")
            for persona in result.personas:
                for finding in persona.findings:
                    if finding.line_id not in line_ids or finding.citation.source_id != "line:" + finding.line_id:
                        raise DeterminationFailure("finding_line_binding_invalid")
                if persona.findings and persona.verdict != "fail":
                    raise DeterminationFailure("inconsistent_verdict")
            if result.verdict == "pass" and any(row.verdict != "pass" for row in result.personas):
                raise DeterminationFailure("inconsistent_verdict")

        return determine(
            kind="resume_adversarial",
            schema=ResumeAdversarialReview,
            schema_version="1",
            prompt_version="resume-adversarial-v1",
            instruction="Review the final resume from all six supplied personas. Each persona decides pass or fail, cites verbatim source spans and gives specific findings bound to the supplied line IDs. Return an overall pass/fail decision, with a diagnostic score and rationale. Scores do not gate acceptance. Factual support has a separate claim verifier, and general usefulness has a separate quality judge. Do not omit a persona or decide by a word list.",
            sources=[*(Source(source_id="line:" + line.line_id, text=line.text) for line in lines), *sources],
            context={"rubric": rubric, "personas": ADVERSARIAL_REVIEW_PERSONA_RUBRICS},
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
                if finding.line_id not in line_ids or finding.citation.source_id != "line:" + finding.line_id:
                    raise DeterminationFailure("finding_line_binding_invalid")
            if any(citation.source_id not in evidence_ids for citation in result.evidence_corrections):
                raise DeterminationFailure("foreign_source_id")
            if len({cite.source_id for cite in result.evidence_corrections}) != len(result.evidence_corrections):
                raise DeterminationFailure("duplicate_source_id")
            if (result.findings or result.evidence_corrections) and result.verdict != "fail":
                raise DeterminationFailure("inconsistent_verdict")

        return determine(
            kind="artifact_quality",
            schema=ArtifactQuality,
            schema_version="2",
            prompt_version="artifact-quality-v2",
            instruction="Judge the artifact's relevance, clarity, completeness, structure, voice and interview defensibility. Apply the supplied rubric by understanding the text. Return your pass/fail decision and a diagnostic quality score from 0 to 1, specific findings bound to supplied line IDs and verbatim quotations, and actionable repairs. If a repair requires adding saved candidate evidence, cite that evidence in evidence_corrections. Cite only supplied candidate evidence IDs, not requirements or instructions. Factual support has its own separate claim verifier. Do not use a numeric threshold to make this judgment.",
            sources=[*(Source(source_id="line:" + line.line_id, text=line.text) for line in lines), *sources],
            context={"artifact_kind": artifact_kind, "rubric": rubric, "line_ids": [line.line_id for line in lines]},
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
