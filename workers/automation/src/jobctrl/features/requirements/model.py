"""The only requirement semantic adapter: configured, admitted model calls."""

from __future__ import annotations

from pydantic import ValidationError

from jobctrl.app.errors import AppError

from .domain import RequirementError, fingerprint


class RequirementModelAdapter:
    def __init__(self, gateway, store, jobs):
        self.gateway = gateway
        self.store = store
        self.jobs = jobs

    async def determine(
        self, *, kind, schema, prompt_version, instruction, sources, context,
        entity_id, validate, budget=None,
    ):
        selection = self.gateway.selection()
        model_spec = f"{selection['provider']}:{selection['model']}"
        arguments = dict(
            operation=kind,
            instructions=instruction,
            sources=sources,
            response_schema=schema.model_json_schema(),
            context={**context, "entity_id": entity_id},
            prompt_version=prompt_version,
            lane="requirements",
            model=model_spec,
        )
        input_fingerprint = self.gateway.fingerprint(**arguments)
        cached = self.store.model_call(input_fingerprint)
        if cached is not None:
            parsed, provenance = self._checked(cached, input_fingerprint, kind, schema, validate)
            if budget is not None:
                budget.reused += 1
            return parsed, provenance
        if budget is not None:
            budget.consume()
        result = await self.gateway.determine(**arguments)
        try:
            parsed = schema.model_validate(result.value)
        except ValidationError:
            raise RequirementError("schema_violation") from None
        validate(parsed)
        provenance = dict(result.provenance)
        # Keep the gateway's full immutable receipt. Its ID is required: a
        # generated local UUID cannot stand in for provider/model authority.
        receipt_id = provenance.get("receipt_id") or provenance.get("determination_id")
        if not isinstance(receipt_id, str) or not receipt_id:
            raise RequirementError("model_provenance_missing")
        provenance["receipt_id"] = receipt_id
        provenance["accepted_result_fingerprint"] = fingerprint(parsed.model_dump())
        if provenance.get("input_fingerprint") != input_fingerprint:
            raise RequirementError("model_cache_binding_invalid")
        posting = context.get("posting")
        if not isinstance(posting, dict):
            raise RequirementError("model_source_context_missing")
        accepted = self.store.save_model_call(
            input_fingerprint=input_fingerprint, operation=kind, posting=posting,
            catalog_revision=context.get("catalog_revision"), result=parsed.model_dump(), provenance=provenance,
            posting_guard=self.jobs.assert_posting_current,
        )
        return self._checked(accepted, input_fingerprint, kind, schema, validate)

    def _checked(self, cached, input_fingerprint, kind, schema, validate):
        if cached.get("input_fingerprint") != input_fingerprint or cached.get("operation") != kind:
            raise RequirementError("model_cache_binding_invalid")
        try:
            parsed = schema.model_validate(cached["result"])
            provenance = dict(cached["provenance"])
        except (KeyError, TypeError, ValueError):
            raise RequirementError("model_cache_binding_invalid") from None
        if (
            provenance.get("input_fingerprint") != input_fingerprint
            or provenance.get("accepted_result_fingerprint") != fingerprint(parsed.model_dump())
            or not isinstance(provenance.get("receipt_id"), str) or not provenance["receipt_id"]
        ):
            raise RequirementError("model_cache_binding_invalid")
        # The feature cache is a bounded progress projection. Its copied hash
        # and metadata do not establish model authority: join the recorded ID
        # through the gateway's public immutable receipt reader every time.
        try:
            receipt = self.gateway.receipt(provenance["receipt_id"])
            canonical = schema.model_validate(receipt["value"])
        except (AppError, KeyError, TypeError, ValueError):
            raise RequirementError("model_cache_receipt_invalid") from None
        if (
            receipt.get("status") != "succeeded" or receipt.get("operation") != kind
            or any(receipt.get(key) != provenance.get(key) for key in (
                "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at",
            ))
            or receipt.get("input_fingerprint") != input_fingerprint
            or canonical.model_dump() != parsed.model_dump()
        ):
            raise RequirementError("model_cache_receipt_invalid")
        validate(parsed)
        return parsed, provenance
