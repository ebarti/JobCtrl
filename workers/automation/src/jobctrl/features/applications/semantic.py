"""Strict source-bound model adapter with private, replayable authority records."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import uuid4

from pydantic import Field, StrictStr

from .domain import ApplicationFailure, Command, copied, digest, timestamp

_BUDGET = ContextVar("applications_model_budget", default=None)


class Citation(Command):
    source_id: StrictStr = Field(min_length=1, max_length=240)
    quote: StrictStr = Field(min_length=1, max_length=4000)


def validate_citations(citations, sources, required=()):
    by_id = {source["source_id"]: source["text"] for source in sources}
    if len(by_id) != len(sources):
        raise ApplicationFailure("application_duplicate_source_id")
    cited = set()
    for citation in citations:
        source_id, quote = citation.source_id, citation.quote
        if source_id not in by_id or not quote.strip() or quote not in by_id[source_id]:
            raise ApplicationFailure("application_invalid_citation")
        cited.add(source_id)
    if not set(required) <= cited:
        raise ApplicationFailure("application_missing_citation")


class ApplicationModel:
    def __init__(self, model, repository):
        self.model, self.repository = model, repository

    @contextmanager
    def budget_scope(self):
        token = _BUDGET.set({"spent": 0.0})
        try:
            yield
        finally:
            _BUDGET.reset(token)

    async def determine(self, *, tenant, entity, operation, schema, sources, binding, instructions,
                        required=(), validate=None, source_fence=None, lane="apply"):
        if source_fence:
            source_fence()
        budget = self.repository.execution_policy()["budgetUsd"]
        budget_state = _BUDGET.get()
        if budget_state is None:
            budget_state = {"spent": 0.0}
        if budget > 0 and budget_state["spent"] >= budget:
            raise ApplicationFailure("application_model_budget_exhausted")
        model = self.model
        if model is None:
            raise ApplicationFailure("application_model_unavailable")
        capability = model.accounting_capability()
        if budget > 0 and not capability["available"]:
            raise ApplicationFailure("application_model_accounting_unavailable")
        # Pin the selection that passed monetary preflight. A disabled scope
        # cap (zero) still uses the shared model lane/token/spend authority.
        selected = capability["provider"] + ":" + capability["model"]
        result = await model.determine(operation=operation, instructions=instructions, sources=sources,
                                       response_schema=schema.model_json_schema(), context={"binding": binding},
                                       prompt_version="applications-v1", lane=lane, model=selected,
                                       require_accounting=budget > 0)
        try:
            parsed = schema.model_validate(result.value)
        except (ValueError, TypeError, AttributeError):
            raise ApplicationFailure("application_model_schema_invalid") from None
        if hasattr(parsed, "citations"):
            validate_citations(parsed.citations, sources, required)
        if validate:
            validate(parsed)
        if source_fence:
            source_fence()
        provenance = result.provenance
        if is_dataclass(provenance):
            provenance = asdict(provenance)
        elif hasattr(provenance, "model_dump"):
            provenance = provenance.model_dump(mode="json")
        if (not isinstance(provenance, dict) or not provenance.get("receipt_id")
                or not provenance.get("provider") or not provenance.get("model")
                or len(provenance.get("input_fingerprint", "")) != 64):
            raise ApplicationFailure("application_model_provenance_missing")
        call = {"operation": operation, "instructions": instructions, "response_schema": schema.model_json_schema(),
                "context": {"binding": binding}, "prompt_version": "applications-v1", "lane": lane}
        fingerprint = self.model.fingerprint(**call, sources=sources,
            selection={"provider": provenance["provider"], "model": provenance["model"]})
        if provenance["input_fingerprint"] != fingerprint:
            raise ApplicationFailure("application_model_binding_invalid")
        receipt = self.model.receipt(provenance["receipt_id"])
        cost = receipt.get("cost_usd")
        if cost is None and budget > 0:
            raise ApplicationFailure("application_model_usage_unresolved")
        if cost is not None:
            budget_state["spent"] += cost
        if budget > 0 and budget_state["spent"] > budget:
            raise ApplicationFailure("application_model_budget_exhausted")
        record = {"determinationId": uuid4().hex, "entityId": entity, "operation": operation,
                  "bindingSha256": digest(binding), "result": parsed.model_dump(mode="json"),
                  "provenance": copied(provenance), "sources": copied(sources), "request": call, "recordedAt": timestamp()}
        with self.repository.atomic() as conn:
            if source_fence:
                source_fence(conn)
            self.repository.determination(conn, tenant, record)
        return parsed, record["determinationId"]
