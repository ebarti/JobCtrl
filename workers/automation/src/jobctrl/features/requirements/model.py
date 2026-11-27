"""The only requirement semantic adapter: configured, admitted model calls."""

from __future__ import annotations

from pydantic import ValidationError

from jobctrl.app.errors import AppError
from jobctrl.app.model_shared_work import owned_validation_refusal, reject_shared_result

from .domain import CONTRACT_VERSION, RequirementError, fingerprint


class RequirementModelAdapter:
    def __init__(self, gateway, store, jobs):
        self.gateway = gateway
        self.store = store
        self.jobs = jobs

    def receipt(self, receipt_id):
        return self.gateway.receipt(receipt_id)

    @staticmethod
    def refused_extraction_receipt(attempt_id, source_id, code, connection):
        operation = "requirements.extract"
        # Search uses the stage operation ID. A standalone extraction prefixes its own attempt ID.
        refusal = owned_validation_refusal(connection, (attempt_id, f"{operation}:{attempt_id}"), operation, code)
        if refusal and refusal["binding_key"] == f"{operation}:{refusal['prompt_version']}:{source_id}":
            return refusal["receipt_id"]
        return None

    def coordinate_work(self, keys, cancelled):
        return self.gateway.coordinate_work(keys, cancelled)

    def share_receipt(self, keys):
        return self.gateway.share_receipt(keys)

    async def determine(
        self, *, kind, schema, prompt_version, instruction, sources, context,
        entity_id, validate, budget=None, publication_posting=None, source_binding=None, catalog_guard=None,
        retained_request=None, pin_request=None, refused_receipt_id=None, pin_refusal=None,
    ):
        arguments = dict(
            operation=kind,
            instructions=instruction,
            sources=sources,
            response_schema=schema.model_json_schema(),
            context={**context, "contract_version": CONTRACT_VERSION,
                     **({"entity_id": entity_id} if entity_id is not None else {})},
            prompt_version=prompt_version,
            lane="requirements",
        )
        if retained_request is not None:
            # Recovery never selects today's model/effort, nor reserves another
            # call. Reconstruct the exact original gateway payload from its
            # non-secret execution identity and the revalidated frozen sources.
            selection = retained_request["selection"]
            request = {**arguments, **selection, "execution": retained_request["execution"]}
            input_fingerprint = fingerprint(request)
            if (retained_request["arguments_fingerprint"] != fingerprint(arguments)
                    or retained_request["input_fingerprint"] != input_fingerprint):
                raise RequirementError("requirements_cohort_request_invalid")
        else:
            selection = self.gateway.selection()
            execution = self.gateway.freeze_execution(f"{selection['provider']}:{selection['model']}")
            try:
                # The gateway validates the complete payload before lookup or
                # admission. No source text may be truncated to pass its guard.
                input_fingerprint = self.gateway.fingerprint(**arguments, execution=execution)
            except AppError as failure:
                self._raise_catalog_refusal(failure, kind, context)
                raise
            if pin_request is not None:
                pin_request({"selection": selection, "execution": execution.identity(),
                             "arguments_fingerprint": fingerprint(arguments), "input_fingerprint": input_fingerprint})
        cached = (self.store.normalization_model_call(input_fingerprint) if catalog_guard is not None
                  else self.store.model_call(input_fingerprint))
        if cached is not None and refused_receipt_id is None:
            parsed, provenance = self._checked(cached, input_fingerprint, kind, schema, validate)
            if budget is not None:
                budget.reused += 1
            return parsed, self._bind(provenance, publication_posting, source_binding)

        def checked_value(value, receipt):
            try:
                parsed = schema.model_validate(value)
            except ValidationError:
                raise RequirementError("schema_violation") from None
            try:
                validate(parsed)
            except RequirementError as failure:
                receipt_id = receipt.get("receipt_id")
                if (kind == "requirements.extract" and isinstance(receipt_id, str) and receipt_id
                        and receipt.get("input_fingerprint") == input_fingerprint):
                    raise RequirementError(failure.code, details={"receiptId": receipt_id}) from None
                raise
            return parsed

        # A worker may stop after the canonical receipt settles but before the
        # feature projection commits. Recover only an exact, revalidated result.
        recovered = self.gateway.receipt(refused_receipt_id) if refused_receipt_id else self.gateway.find_succeeded(input_fingerprint)
        if recovered is not None:
            if ((refused_receipt_id and recovered.get("receipt_id") != refused_receipt_id)
                    or recovered.get("status") != "succeeded" or recovered.get("input_fingerprint") != input_fingerprint
                    or recovered.get("operation") != kind or recovered.get("prompt_version") != prompt_version
                    or recovered.get("provider") != selection["provider"] or recovered.get("model") != selection["model"]
                    or recovered.get("lane") != "requirements"):
                raise RequirementError("model_cache_receipt_invalid")
            try:
                parsed = checked_value(recovered["value"], recovered)
            except (ValueError, RequirementError):
                if refused_receipt_id:
                    raise  # This operation's own receipt proves the original refusal.
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
                accepted = self._save(input_fingerprint, kind, context, parsed, provenance,
                                      publication_posting, catalog_guard)
                parsed, provenance = self._checked(accepted, input_fingerprint, kind, schema, validate)
                return parsed, self._bind(provenance, publication_posting, source_binding)
        if retained_request is not None:
            raise RequirementError("requirements_cohort_interrupted")
        if budget is not None and budget.check_reservation is not None:
            # An already admitted owner intent keeps its exact refusal, even if
            # that interrupted dispatch also left global accounting unresolved.
            budget.check_reservation(input_fingerprint)

        def admitted(connection, _receipt_id):
            if budget is not None:
                budget.consume(input_fingerprint, connection)

        try:
            result = await self.gateway.determine(**arguments, execution=execution, on_admitted=admitted)
        except AppError as failure:
            self._raise_catalog_refusal(failure, kind, context)
            raise
        try:
            parsed = checked_value(result.value, result.provenance)
        except (ValueError, RequirementError) as failure:
            receipt_id = result.provenance.get("receipt_id")
            if receipt_id:
                reject_shared_result(receipt_id, getattr(failure, "code", "schema_violation"))
            if pin_refusal and receipt_id and result.provenance.get("input_fingerprint") == input_fingerprint:
                pin_refusal(receipt_id)
            raise
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
        accepted = self._save(input_fingerprint, kind, context, parsed, provenance,
                              publication_posting, catalog_guard)
        parsed, provenance = self._checked(accepted, input_fingerprint, kind, schema, validate)
        return parsed, self._bind(provenance, publication_posting, source_binding)

    def _save(self, input_fingerprint, kind, context, parsed, provenance, publication_posting, catalog_guard):
        if catalog_guard is not None:
            return self.store.save_normalization_model_call(
                input_fingerprint=input_fingerprint, operation=kind, catalog_revision=context["catalog_revision"],
                result=parsed.model_dump(), provenance=provenance, guard=catalog_guard)
        posting = publication_posting or context.get("posting")
        if not isinstance(posting, dict):
            raise RequirementError("model_source_context_missing")
        return self.store.save_model_call(
            input_fingerprint=input_fingerprint, operation=kind, posting=posting,
            catalog_revision=context.get("catalog_revision"), result=parsed.model_dump(), provenance=provenance,
            posting_guard=self.jobs.assert_posting_current,
        )

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
            **({"receiptId": failure.details["receiptId"]} if failure.details and failure.details.get("receiptId") else {}),
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
