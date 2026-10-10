"""Application message linking and outcomes are cited model determinations."""

import json
from typing import Literal
from pydantic import Field, StrictStr
from jobctrl.domain.determinations import Citation, DeterminationModel, DeterminationFailure, Source, determine


class ApplicationMessageLink(DeterminationModel):
    decision: Literal["linked", "unrelated", "uncertain"]
    application_id: StrictStr | None
    confidence: float = Field(ge=0, le=1)
    citations: list[Citation] = Field(min_length=1, max_length=12)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class MessageOutcome(DeterminationModel):
    kind: Literal[
        "offer", "rejection", "interview", "assessment", "applied_confirmation", "recruiter_reply", "bounced", "unknown"
    ]
    confidence: float = Field(ge=0, le=1)
    citations: list[Citation] = Field(min_length=1, max_length=12)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


class ModelMessageInterpreter:
    def __init__(self, **dependencies):
        self._dependencies = dependencies

    def link(self, *, message_id, headers, applications):
        ids = set(applications)

        def validate(result):
            if result.application_id is not None and result.application_id not in ids:
                raise DeterminationFailure("foreign_source_id")
            if (result.decision == "linked") != (result.application_id is not None):
                raise DeterminationFailure("inconsistent_verdict")
            if result.decision == "linked" and {c.source_id for c in result.citations} != {
                "message_headers",
                "application:" + result.application_id,
            }:
                raise DeterminationFailure("missing_evidence_citation")

        return determine(
            kind="message_link",
            schema=ApplicationMessageLink,
            schema_version="2",
            prompt_version="message-link-v2",
            entity_id=message_id,
            sources=[
                Source(source_id="message_headers", text=json.dumps(headers, sort_keys=True)),
                *(
                    Source(source_id="application:" + ident, text=json.dumps(value, sort_keys=True))
                    for ident, value in applications.items()
                ),
            ],
            context={"application_ids": sorted(ids)},
            instruction="Determine which, if any, bounded application this message concerns, using the message metadata and the exact supplied application records. Receipt and date checks have already passed. A sender domain or similar employer/title wording alone is not proof. Choose unrelated or uncertain if the metadata cannot establish a unique application; never force a link. Cite the message and selected application's verbatim spans. No keyword scoring or confidence cutoff.",
            validate=validate,
            **self._dependencies,
        )

    def outcome(self, *, message_id, text):
        return determine(
            kind="message_outcome",
            schema=MessageOutcome,
            schema_version="1",
            prompt_version="message-outcome-v1",
            entity_id=message_id,
            sources=[Source(source_id="message", text=text)],
            context={},
            instruction="Determine this application's current outcome from the whole message. Distinguish politeness, historical stages, quoted messages and hypothetical statements from the actual current decision. Choose exactly one closed outcome code or unknown, cite the decisive verbatim statement, and explain the judgment. The model owns both kind and confidence; no phrase priorities or fixed confidence values.",
            **self._dependencies,
        )
