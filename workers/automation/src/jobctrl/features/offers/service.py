"""Offer ledger application service with transactional revision fences."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from jobctrl.app.errors import ConflictError

from .domain import RecordDecision, SaveTerms
from .ports import OfferRepository


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class OffersService:
    def __init__(self, repository: OfferRepository):
        self.repository = repository

    def read_offer(self, job_id: str, connection=None) -> dict:
        return self.repository.read_offer(job_id, connection=connection)

    def save_terms(self, job_id: str, payload: dict) -> dict:
        input_ = SaveTerms.model_validate(payload)
        with self.repository.transaction() as offer:
            current = offer.read_offer(job_id)
            previous = current["currentTerms"]
            if (previous["revisionId"] if previous else None) != input_.expectedRevisionId:
                raise ConflictError("Offer terms changed. Reload before saving.")
            if previous and not input_.correctionReason:
                raise ConflictError("A terms revision requires a correction reason.")
            revision = input_.model_dump(exclude_none=True)
            # The contract requires explicit nulls for unconfirmed terms and the initial fence.
            revision["expectedRevisionId"] = input_.expectedRevisionId
            revision["terms"] = input_.terms.model_dump()
            revision.update(revisionId=str(uuid4()), recordedAt=_now())
            offer.append_terms(job_id, revision)
            if previous is None:
                offer.ensure_offer_milestone(job_id)
            offer.publish_change(job_id, revision["revisionId"], None)
            return offer.read_offer(job_id)

    def record_decision(self, job_id: str, payload: dict) -> dict:
        input_ = RecordDecision.model_validate(payload)
        with self.repository.transaction() as offer:
            current = offer.read_offer(job_id)
            terms = current["currentTerms"]
            previous = current["currentDecision"]
            if terms is None or terms["revisionId"] != input_.termsRevisionId:
                raise ConflictError("Review the current offer terms before recording a decision.")
            if (previous["decisionId"] if previous else None) != input_.expectedDecisionId:
                raise ConflictError("Offer decision changed. Reload before recording a correction.")
            if previous and not input_.correctionReason:
                raise ConflictError("A decision correction requires a reason; the previous decision remains in history.")
            decision = input_.model_dump(exclude_none=True)
            decision["expectedDecisionId"] = input_.expectedDecisionId
            decision.update(decisionId=str(uuid4()), recordedAt=_now())
            offer.append_decision(job_id, decision)
            offer.publish_change(job_id, decision["termsRevisionId"], decision["decisionId"])
            return offer.read_offer(job_id)

    def current_terms(self, job_id: str, revision_id: str | None = None, connection=None) -> dict:
        current = self.read_offer(job_id, connection=connection)
        terms, decision = current["currentTerms"], current["currentDecision"]
        if terms is None or (revision_id is not None and terms["revisionId"] != revision_id):
            raise ConflictError("Offer terms changed or are unavailable.")
        compact = deepcopy(terms)
        source_id = "offer:" + terms["revisionId"]
        provenance = []

        def bind_source(value, suffix):
            source = value["source"]
            if source.get("userConfirmed") is not True:
                raise ConflictError("Offer source is not confirmed.")
            identity = source_id + ":" + suffix
            provenance.append({"source_id": identity, "text": _json(source)})
            value["source"] = {"sourceId": identity}

        bind_source(compact["terms"], "source")
        for index, cash in enumerate(compact["terms"]["cash"]):
            bind_source(cash, "cash:" + str(index))
        for key in ("equity", "benefits", "decisionDeadline"):
            if compact["terms"][key] is not None:
                bind_source(compact["terms"][key], key)
        sources = [{"source_id": source_id, "text": _json(compact)}, *provenance]
        if decision is not None:
            sources.append({"source_id": "offer-decision:" + decision["decisionId"], "text": _json(decision)})
        context = {"binding": {"jobId": job_id, "termsRevisionId": terms["revisionId"],
                               "decisionId": decision["decisionId"] if decision else None}, "sources": sources}
        context["fingerprint"] = hashlib.sha256(_json(context).encode()).hexdigest()
        context.update(termsRevisionId=terms["revisionId"], decisionId=decision["decisionId"] if decision else None)
        return context

    def assert_terms_current(self, context: dict, connection=None) -> dict:
        binding = context.get("binding", {})
        current = self.current_terms(binding.get("jobId"), binding.get("termsRevisionId"), connection)
        if current["fingerprint"] != context.get("fingerprint"):
            raise ConflictError("Offer terms or decision changed. Review the current record.")
        return current

    def delete_job_data(self, job_id: str, connection=None) -> None:
        """Remove this owner's private ledger only inside Jobs' permanent-delete transaction."""
        self.repository.delete_job_data(job_id, connection=connection)
