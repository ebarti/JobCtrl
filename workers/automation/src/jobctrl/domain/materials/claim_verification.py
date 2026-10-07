"""One model determination verifies final artifact lines against canonical sources."""

from __future__ import annotations

from collections.abc import Callable

from jobctrl.domain.determinations import (
    DeterminationEnvelope,
    DeterminationFailure,
    DeterminationRepository,
    Source,
    determine,
)
from jobctrl.domain.ports.claim_verification import (
    ArtifactKind,
    ArtifactLine,
    ClaimVerification,
)
from jobctrl.domain.ports.llm import LlmPort
from jobctrl.domain.exact_values import numeric_literals
from jobctrl.llm_lanes import LlmLane


CLAIM_VERIFICATION_PROMPT_VERSION = "claim-verification-v2"
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


class ModelClaimVerifier:
    def __init__(
        self,
        *,
        llm: LlmPort | None,
        repository: DeterminationRepository,
        tenant_id: str,
        provider: str,
        model: str,
        lane: LlmLane,
        preflight: Callable[[], object],
    ) -> None:
        self._llm = llm
        self._repository = repository
        self._tenant_id = tenant_id
        self._provider = provider
        self._model = model
        self._lane = lane
        self._preflight = preflight

    def verify(
        self,
        *,
        artifact_kind: ArtifactKind,
        entity_id: str,
        lines: list[ArtifactLine],
        evidence: list[Source],
        requirements: list[Source],
        rubric: dict[str, str],
    ) -> tuple[ClaimVerification, DeterminationEnvelope]:
        by_id = {line.line_id: line for line in lines}
        if not lines or len(by_id) != len(lines):
            raise DeterminationFailure("invalid_line_inventory")
        evidence_ids = {source.source_id for source in evidence}
        requirement_ids = {source.source_id for source in requirements}
        for line in lines:
            if set(line.allowed_evidence_ids) - evidence_ids or set(line.allowed_requirement_ids) - requirement_ids:
                raise DeterminationFailure("foreign_source_id")

        def validate(result: ClaimVerification) -> None:
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
                            raise DeterminationFailure("mismatched_value")
                    if claim.support in {"unsupported", "uncertain"} and row.verdict != "fail":
                        raise DeterminationFailure("inconsistent_verdict")
                if any(finding.citation.source_id != "line:" + row.line_id for finding in row.findings):
                    raise DeterminationFailure("finding_line_binding_invalid")
                if row.findings and row.verdict != "fail":
                    raise DeterminationFailure("inconsistent_verdict")
            if result.verdict == "pass" and any(row.verdict != "pass" for row in result.lines):
                raise DeterminationFailure("inconsistent_verdict")

        return determine(
            kind="claim_verification",
            schema=ClaimVerification,
            schema_version=CLAIM_VERIFICATION_SCHEMA_VERSION,
            prompt_version=CLAIM_VERIFICATION_PROMPT_VERSION,
            instruction=_INSTRUCTION,
            sources=[
                *(Source(source_id="line:" + line.line_id, text=line.text) for line in lines),
                *evidence,
                *requirements,
            ],
            context={
                "artifact_kind": artifact_kind,
                "rubric": rubric,
                "lines": [
                    {
                        "line_id": line.line_id,
                        "allowed_evidence_ids": line.allowed_evidence_ids,
                        "allowed_requirement_ids": line.allowed_requirement_ids,
                    }
                    for line in lines
                ],
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
