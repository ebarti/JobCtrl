"""Versioned provider contracts for source-bound requirements extraction."""

from typing import Annotated, Literal

from pydantic import Field, StrictStr

from .domain import EXTRACTION_INSTRUCTION, ExtractionSelection, RequirementError, SelectedRequirement


LEGACY_EXTRACTION_VERSION = "requirements-v2-extract-v5-content-bound"
V6_EXTRACTION_VERSION = "requirements-v2-extract-v6-inference-rationale"
V7_EXTRACTION_VERSION = "requirements-v2-extract-v7-role-demands"
EXTRACTION_VERSION = "requirements-v2-extract-v8-independent-demands"
Rationale = Annotated[StrictStr, Field(min_length=1, max_length=2000, pattern=r"\S")]


class ExplicitRequirement(SelectedRequirement):
    basis: Literal["explicit"]
    rationale: Rationale | None


class InferredRequirement(SelectedRequirement):
    basis: Literal["inferred", "explicit_and_inferred"]
    rationale: Rationale


class InferenceBoundSelection(ExtractionSelection):
    requirements: list[ExplicitRequirement | InferredRequirement] = Field(max_length=100)


INFERENCE_INSTRUCTION = EXTRACTION_INSTRUCTION + """

For each requirement choose its basis from its cited posting evidence. Use explicit when the posting states the whole demand directly. An explicit demand may have a null rationale or a short explanation of a non-obvious boundary. Use inferred when the cited work establishes a capability indirectly. Use explicit_and_inferred when the statement establishes part of the demand directly and part by inference. For both inferred and explicit_and_inferred, always write a nonblank rationale explaining what the cited work implies and which part of the demand follows from it. Keep this explanation grounded in the cited source, including when the inference is straightforward."""

ROLE_DEMAND_INSTRUCTION = INFERENCE_INSTRUCTION + """

Treat interview agendas, screening exercises and prompts to discuss past work as hiring-process context. A topic mentioned only as something an interviewer will ask about does not establish a separate role demand or an unresolved item. Extract an independently stated responsibility or candidate qualification wherever it appears, and cite that substantive evidence directly."""

INDEPENDENT_DEMAND_INSTRUCTION = ROLE_DEMAND_INSTRUCTION + """

Keep independently demonstrable responsibilities separate, even when the same person or team performs them. For example, when the posting separately asks for directing an organisation and developing other leaders, return separate capabilities with their own definitions and direct evidence. Include ordinary supervision within organisation leadership when the posting does not establish an independent demand for developing leaders. Preserve any separately stated track record as professional experience without combining the corresponding skills."""


def extraction_wire(version):
    if version == EXTRACTION_VERSION:
        return InferenceBoundSelection, INDEPENDENT_DEMAND_INSTRUCTION
    if version == V7_EXTRACTION_VERSION:
        return InferenceBoundSelection, ROLE_DEMAND_INSTRUCTION
    if version == V6_EXTRACTION_VERSION:
        return InferenceBoundSelection, INFERENCE_INSTRUCTION
    if version == LEGACY_EXTRACTION_VERSION:
        return ExtractionSelection, EXTRACTION_INSTRUCTION
    raise RequirementError("requirements_extraction_contract_changed")
