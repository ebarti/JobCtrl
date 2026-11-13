"""The only requirement semantic adapter: configured, admitted model calls."""

from __future__ import annotations

from pydantic import ValidationError

from jobctrl.app.errors import AppError

from .domain import CONTRACT_VERSION, RequirementError, fingerprint


class RequirementModelAdapter:
    def __init__(self, gateway, store, jobs):
        self.gateway = gateway
        self.store = store
        self.jobs = jobs

    async def determine(
        self, *, kind, schema, prompt_version, instruction, sources, context,
        entity_id, validate, budget=None, publication_posting=None, source_binding=None,
    ):
        selection = self.gateway.selection()
        model_spec = f"{selection['provider']}:{selection['model']}"
        execution = self.gateway.freeze_execution(model_spec)
        arguments = dict(
            operation=kind,
            instructions=instruction,
            sources=sources,
            response_schema=schema.model_json_schema(),
            context={**context, "contract_version": CONTRACT_VERSION,
                     **({"entity_id": entity_id} if entity_id is not None else {})},
            prompt_version=prompt_version,
            lane="requirements",
            model=model_spec,
            execution=execution,
        )
        try:
            # The gateway validates the complete payload, including schema and
            # context, before cache lookup or external-call admission. No
            # source/catalog text may be truncated to get through this check.
            input_fingerprint = self.gateway.fingerprint(**arguments)
        except AppError as failure:
            self._raise_catalog_refusal(failure, kind, context)
            raise
        cached = self.store.model_call(input_fingerprint)
        if cached is not None:
            parsed, provenance = self._checked(cached, input_fingerprint, kind, schema, validate)
            if budget is not None:
                budget.reused += 1
            return parsed, self._bind(provenance, publication_posting, source_binding)
        # A worker may stop after the canonical receipt settles but before the
        # feature projection commits. Recover only an exact, revalidated result.
        recovered = self.gateway.find_succeeded(input_fingerprint)
        if recovered is not None:
            if (recovered.get("status") != "succeeded" or recovered.get("input_fingerprint") != input_fingerprint
                    or recovered.get("operation") != kind or recovered.get("prompt_version") != prompt_version
                    or recovered.get("provider") != execution.provider or recovered.get("model") != execution.model
                    or recovered.get("lane") != "requirements"):
                raise RequirementError("model_cache_receipt_invalid")
            try:
                parsed = schema.model_validate(recovered["value"])
                validate(parsed)
            except (ValueError, RequirementError):
                # Gateway structural success is not owner acceptance. A new
                # explicitly admitted refresh may make its one planned call;
                # this never retries a newly refused result within an attempt.
                recovered = None
            if recovered is not None:
                provenance = {key: recovered[key] for key in (
                    "receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at",
                )}
                provenance["accepted_result_fingerprint"] = fingerprint(parsed.model_dump())
                provenance["contract_version"] = CONTRACT_VERSION
                if budget is not None:
                    budget.reused += 1
                posting = publication_posting or context.get("posting")
                if not isinstance(posting, dict):
                    raise RequirementError("model_source_context_missing")
                accepted = self.store.save_model_call(
                    input_fingerprint=input_fingerprint, operation=kind, posting=posting,
                    catalog_revision=context.get("catalog_revision"), result=parsed.model_dump(), provenance=provenance,
                    posting_guard=self.jobs.assert_posting_current,
                )
                parsed, provenance = self._checked(accepted, input_fingerprint, kind, schema, validate)
                return parsed, self._bind(provenance, publication_posting, source_binding)
        if budget is not None:
            budget.consume()
        try:
            result = await self.gateway.determine(**arguments)
        except AppError as failure:
            self._raise_catalog_refusal(failure, kind, context)
            raise
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
        provenance["contract_version"] = CONTRACT_VERSION
        if provenance.get("input_fingerprint") != input_fingerprint:
            raise RequirementError("model_cache_binding_invalid")
        posting = publication_posting or context.get("posting")
        if not isinstance(posting, dict):
            raise RequirementError("model_source_context_missing")
        accepted = self.store.save_model_call(
            input_fingerprint=input_fingerprint, operation=kind, posting=posting,
            catalog_revision=context.get("catalog_revision"), result=parsed.model_dump(), provenance=provenance,
            posting_guard=self.jobs.assert_posting_current,
        )
        parsed, provenance = self._checked(accepted, input_fingerprint, kind, schema, validate)
        return parsed, self._bind(provenance, publication_posting, source_binding)

    @staticmethod
    def _bind(provenance, posting, source_binding):
        if source_binding is None:
            return provenance
        if not isinstance(posting, dict):
            raise RequirementError("model_source_context_missing")
        # This owner binding describes reuse; it never rewrites the shared
        # immutable provider response or claims a call was made for this job.
        return {**provenance, "source_binding": {"version": 2, "contract_version": CONTRACT_VERSION, "semantic_source": source_binding,
                                               "destination_posting": posting}}

    @staticmethod
    def _raise_catalog_refusal(failure, kind, context):
        if kind != "requirements.match_catalog":
            return
        reasons = {"model_input_too_large": "structural_payload_too_large",
                   "context_window_exceeded": "context_window_exceeded"}
        if failure.code not in reasons:
            return
        raise RequirementError("requirements_catalog_unavailable", details={
            "reason": reasons[failure.code], "model_failure_code": failure.code,
            "catalog_revision": context["catalog_revision"],
            "candidate_count": len(context["candidates"]), "incoming_count": len(context["incoming"]),
        }) from None

    def _checked(self, cached, input_fingerprint, kind, schema, validate):
        if cached.get("input_fingerprint") != input_fingerprint or cached.get("operation") != kind:
            raise RequirementError("model_cache_binding_invalid")
        try:
            parsed = schema.model_validate(cached["result"])
            provenance = dict(cached["provenance"])
        except (KeyError, TypeError, ValueError):
            raise RequirementError("model_cache_binding_invalid") from None
        if (
            provenance.get("contract_version") != CONTRACT_VERSION
            or provenance.get("input_fingerprint") != input_fingerprint
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
