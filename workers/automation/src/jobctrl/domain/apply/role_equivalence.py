"""One persisted model judgment owns semantic repeat-application equivalence."""

from typing import Literal
from pydantic import Field
from jobctrl.domain.determinations import Citation, DeterminationModel, Source, determine, DeterminationFailure
import json


class RoleEquivalence(DeterminationModel):
    verdict: Literal["equivalent", "different", "uncertain"]
    citations: list[Citation] = Field(min_length=1, max_length=12)
    rationale: str = Field(min_length=1, max_length=1000)


class ModelRoleEquivalence:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def determine(self, *, target, prior, pair_version):
        def validate(result):
            if {citation.source_id for citation in result.citations} != {"target", "prior"}:
                raise DeterminationFailure("pair_binding_invalid")

        return determine(
            kind="repeat_equivalence",
            schema=RoleEquivalence,
            schema_version="2",
            prompt_version="repeat-equivalence-v2",
            validate=validate,
            entity_id=target["job_id"] + ":" + prior["job_id"],
            sources=[
                Source(source_id="target", text=json.dumps(target, sort_keys=True)),
                Source(source_id="prior", text=json.dumps(prior, sort_keys=True)),
            ],
            context={"pair_version": pair_version},
            instruction="Determine whether these are materially equivalent roles at the same employer. Exact canonical-opening identity is checked separately. Understand titles, actual employer identity and the supplied job interpretations; a shared occupation family or overlapping title words alone is not equivalence. Use different when employer or role differs, uncertain when the evidence cannot determine equivalence. Cite verbatim spans from both records and explain the judgment. Never compare token overlap or legal-suffix lists.",
            **self._dependencies,
        )
