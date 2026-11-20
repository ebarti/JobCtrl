"""Fixed-cohort extraction receipts followed by one complete reconciliation."""

from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

from jobctrl.app.errors import ConflictError

from .domain import (CONTRACT_VERSION, ModelCallBudget,
                     RequirementError, bind_extraction, canonical_json, fingerprint, validate_extraction_selection)
from .cohort_transport import COHORT_PROMPT_VERSION
from .normalization_domain import BACKGROUND_COHORT_PROMPT
from .extraction_wire import EXTRACTION_VERSION, extraction_wire

COHORT_VERSION = "requirements-initial-cohort-v1"


class RequirementsCohortService:
    def record_cohort_attempts(self, job_operations, state, failure_code, connection):
        """Record a Preparation outcome alongside its checkpoint, under the original attempt IDs."""
        self.store.record_cohort_attempts(job_operations, state, failure_code, connection)

    def _cohort_posting(self, state, connection=None, *, allow_accepted=False):
        request = state["request"]
        posting = self.jobs.assert_posting_current(request["job_id"], request["expected_posting_revision"],
                                                   state["posting"]["source_hash"], connection=connection)
        accepted = self.store.current_snapshot(request["job_id"], connection)
        if (accepted["revision"] if accepted else 0) != request["expected_revision"]:
            own = self.store.accepted_action(request["operation_id"], state["input_fingerprint"], connection) if allow_accepted else None
            if own is None or accepted is None or accepted["revision"] != own["revision"]:
                raise ConflictError("The accepted requirement snapshot changed during cohort preparation.")
        return posting

    async def prepare_cohort_job(self, job_id, *, expected_posting_revision, expected_revision,
                                 operation_id, cancelled=lambda: False, heartbeat=None):
        self._validate_operation_id(operation_id)
        self._validate_versions(expected_posting_revision, expected_revision)
        if not operation_id:
            raise RequirementError("invalid_operation_id")
        state = self.store.cohort_operation(operation_id)
        version = state["request"].get("extraction_version") if state is not None else EXTRACTION_VERSION
        schema, instruction = extraction_wire(version)
        request = {"cohort_version": COHORT_VERSION, "extraction_version": version,
                   "job_id": job_id, "expected_posting_revision": expected_posting_revision,
                   "expected_revision": expected_revision, "operation_id": operation_id}
        input_hash = fingerprint(request)
        if state is None:
            posting = self.jobs.assert_posting_current(job_id, expected_posting_revision)
            state = {"request": request, "input_fingerprint": input_hash, "posting": posting, "status": "staging"}
            state = self.store.start_cohort_operation(operation_id, input_hash, state,
                lambda connection: self._cohort_posting(state, connection))
        if state["request"] != request or state["input_fingerprint"] != input_hash:
            raise RequirementError("requirements_cohort_contract_changed")
        posting = self._cohort_posting(state, allow_accepted=True)
        if state.get("result") is not None:
            return deepcopy(state["result"])
        self._check_cancel(cancelled)
        previous = self.store.current_snapshot(job_id)
        if previous is not None and not self.get_job_requirements(job_id)["stale"]:
            result = {"contract_version": CONTRACT_VERSION, "cohort_version": COHORT_VERSION,
                      "job_id": job_id, "posting_revision": posting["revision"], "posting_hash": posting["source_hash"],
                      "expected_revision": expected_revision, "operation_id": operation_id,
                      "status": "accepted", "accepted_revision": previous["revision"]}
            self.store.update_cohort_operation(operation_id, {"status": "accepted", "result": result},
                lambda connection: self._cohort_posting(state, connection))
            return result
        text = posting.get("text") or posting.get("description") or ""
        if not isinstance(text, str) or not text.strip() or len(text.encode()) > 192000:
            raise RequirementError("posting_source_invalid")
        source = self._content_source(text)
        self.store.start_attempt({"attempt_id": operation_id, "job_id": job_id,
            "posting_revision": posting["revision"], "expected_revision": expected_revision, "input_fingerprint": input_hash})
        def guard(connection):
            return self._cohort_posting(state, connection)
        request_pin = {}
        selection, receipt = await self.model.determine(kind="requirements.extract", schema=schema,
            prompt_version=version, instruction=instruction,
            sources=[{"source_id": source["source_id"], "text": text}],
            context={"contract_version": CONTRACT_VERSION, "posting_content": source, "refresh_binding": None}, entity_id=None,
            validate=lambda value: validate_extraction_selection(value, source_id=source["source_id"], text=text),
            budget=ModelCallBudget(input_hash, 1, reserve=lambda value, connection:
                self.store.reserve_cohort_call(operation_id, value, request_pin, guard, connection=connection)),
            retained_request=state.get("model_request"), pin_request=request_pin.update,
            refused_receipt_id=state.get("refused_extraction_receipt_id"),
            pin_refusal=lambda receipt_id: self.store.update_cohort_operation(
                operation_id, {"refused_extraction_receipt_id": receipt_id}),
            publication_posting=self._publication_identity(posting), source_binding=source)
        extraction = bind_extraction(selection, source_id=source["source_id"], text=text)
        result = {"contract_version": CONTRACT_VERSION, "cohort_version": COHORT_VERSION,
                  "job_id": job_id, "posting_revision": posting["revision"], "posting_hash": posting["source_hash"],
                  "expected_revision": expected_revision, "operation_id": operation_id, "status": "prepared",
                  "extraction_receipt_id": receipt["receipt_id"], "extraction_provenance": receipt, "source_binding": source}
        result["prepared_fingerprint"] = fingerprint({"request": request, "receipt": receipt,
                                                       "extraction": extraction.model_dump(), "source_binding": source})
        self._check_cancel(cancelled)
        self.store.update_cohort_operation(operation_id, {"status": "prepared", "result": result,
            "extraction": extraction.model_dump()}, guard)
        if heartbeat:
            heartbeat({"phase": "requirements_extracted", "jobId": job_id, "status": extraction.status})
        return deepcopy(result)

    def _prepared_cohort_item(self, item):
        state = self.store.cohort_operation(item["operation_id"])
        if (state is None or state.get("result") != item or item.get("cohort_version") != COHORT_VERSION
                or item.get("contract_version") != CONTRACT_VERSION):
            raise RequirementError("requirements_cohort_preparation_invalid")
        posting = self._cohort_posting(state, allow_accepted=True)
        if item["status"] == "accepted":
            return state, posting, None
        version = state["request"].get("extraction_version")
        schema, _ = extraction_wire(version)
        receipt = self.model.receipt(item["extraction_receipt_id"])
        if (receipt.get("status") != "succeeded" or receipt.get("operation") != "requirements.extract"
                or receipt.get("prompt_version") != version
                or any(receipt.get(key) != item["extraction_provenance"].get(key) for key in (
                    "receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at"))):
            raise RequirementError("model_cache_receipt_invalid")
        selection = schema.model_validate(receipt["value"])
        text = posting.get("text") or posting.get("description") or ""
        source = self._content_source(text)
        if source != item["source_binding"]:
            raise RequirementError("requirements_cohort_source_changed")
        validate_extraction_selection(selection, source_id=source["source_id"], text=text)
        extraction = bind_extraction(selection, source_id=source["source_id"], text=text)
        if extraction.model_dump() != state["extraction"] or fingerprint({"request": state["request"],
                "receipt": item["extraction_provenance"], "extraction": extraction.model_dump(),
                "source_binding": source}) != item["prepared_fingerprint"]:
            raise RequirementError("requirements_cohort_preparation_invalid")
        return state, posting, extraction

    def _cohort_result(self, operation_id, prepared, revisions, connection=None):
        if connection is None:
            with self.store.read_session() as connection:
                return self._cohort_result(operation_id, prepared, revisions, connection)
        jobs = []
        for item in prepared:
            current = self.get_job_requirements(item["job_id"], connection)
            if (current["stale"] or current["posting_revision"] != item["posting_revision"]
                    or current["posting_hash"] != item["posting_hash"]
                    or current["revision"] != revisions[item["job_id"]]):
                raise ConflictError("A finalized cohort requirement source changed.")
            jobs.append({key: current[key] for key in ("job_id", "revision", "posting_revision", "posting_hash", "status", "stale")})
        return {"contract_version": CONTRACT_VERSION, "cohort_version": COHORT_VERSION,
                "operation_id": operation_id, "jobs": jobs}

    def _accept_cohort_revisions(self, operation_id, prepared, revisions, cancelled):
        with self.store.database.transaction() as connection:
            result = self._cohort_result(operation_id, prepared, revisions, connection)
            self._check_cancel(cancelled)
            self.store.update_cohort_operation(operation_id, {"status": "accepted", "result": result}, connection=connection)
            return result

    async def finalize_cohort(self, prepared, *, operation_id, cancelled=lambda: False, heartbeat=None,
                              catalog_prompt_version=BACKGROUND_COHORT_PROMPT):
        self._validate_operation_id(operation_id)
        if (not operation_id or not isinstance(prepared, list) or not 1 <= len(prepared) <= 1000
                or len({row["job_id"] for row in prepared}) != len(prepared)):
            raise RequirementError("requirements_cohort_scope_invalid")
        version = COHORT_PROMPT_VERSION if catalog_prompt_version is None else catalog_prompt_version
        if version not in (COHORT_PROMPT_VERSION, BACKGROUND_COHORT_PROMPT):
            raise RequirementError("requirements_citation_wire_changed")
        action = fingerprint({"cohort_version": COHORT_VERSION, "normalization_prompt_version": version,
                              "prepared": prepared})
        state = self.store.cohort_operation(operation_id, action)
        if state is not None and state.get("result") is not None:
            revisions = {row["job_id"]: row["revision"] for row in state["result"]["jobs"]}
            return self._cohort_result(operation_id, prepared, revisions)
        report = self.store.normalization_action(operation_id, action)
        if report is not None:
            revisions = {row["job_id"]: row["revision"] for row in report["affected_jobs"]}
            return self._accept_cohort_revisions(operation_id, prepared,
                {row["job_id"]: revisions.get(row["job_id"], row.get("accepted_revision")) for row in prepared}, cancelled)
        checked = [self._prepared_cohort_item(item) for item in prepared]
        def frozen_jobs(connection):
            for stage, _, _ in checked:
                self._cohort_posting(stage, connection)
        if state is None:
            with self.store.read_session() as connection:
                frozen_jobs(connection)
                captured = self.store.normalization_capture(connection)
            proposals, incoming = {}, []
            for item, (_, posting, extraction) in zip(prepared, checked, strict=True):
                if extraction is None:
                    continue
                receipt, source = item["extraction_provenance"], item["source_binding"]
                rows = [self._proposed_occurrence(row, posting, receipt, source, item["operation_id"],
                    member_id="incoming:" + str(uuid5(NAMESPACE_URL, canonical_json([item["job_id"], row.local_id]))))
                    for row in extraction.requirements]
                proposals[item["job_id"]] = {"contract_version": CONTRACT_VERSION,
                    **self._extraction_fields(extraction, posting, receipt, source),
                    "job_id": posting["job_id"], "posting_revision": posting["revision"], "posting_hash": posting["source_hash"],
                    "source_id": posting["source_id"], "source_revision": posting["source_revision"], "requirements": rows,
                    "extraction_determination_id": receipt["receipt_id"], "_attempt_id": item["operation_id"]}
                incoming.extend(self._incoming_members(rows, cohort=True))
            state = self.store.start_cohort_operation(operation_id, action,
                {"kind": "normalization", "cohort_version": COHORT_VERSION, "prepared": deepcopy(prepared),
                 "captured": captured, "proposals": proposals, "incoming": incoming, "status": "prepared"},
                lambda connection: self.store.assert_normalization_capture(captured, connection))
        self._check_cancel(cancelled)
        revisions = {item["job_id"]: item["accepted_revision"] for item in prepared if item["status"] == "accepted"}
        if state["incoming"]:
            report = await self._normalize_catalog(captured=state["captured"], proposals=state["proposals"], incoming=state["incoming"],
                operation_id=operation_id, action_fingerprint=action, cancelled=cancelled, heartbeat=heartbeat,
                cohort_state=state, cohort_guard=frozen_jobs, prompt_version=version)
            revisions.update({row["job_id"]: row["revision"] for row in report["affected_jobs"]})
        else:
            with self.store.database.transaction() as connection:
                self.store.assert_normalization_capture(state["captured"], connection)
                frozen_jobs(connection)
                for item, (_, posting, extraction) in zip(prepared, checked, strict=True):
                    if extraction is None:
                        continue
                    accepted = self.store.publish_empty_snapshot(posting=posting, expected_revision=item["expected_revision"],
                        fields=self._extraction_fields(extraction, posting, item["extraction_provenance"], item["source_binding"]),
                        extraction_receipt=item["extraction_provenance"], attempt_id=item["operation_id"],
                        cancelled=cancelled, posting_guard=self.jobs.assert_posting_current, connection=connection)
                    revisions[item["job_id"]] = accepted["revision"]
                result = self._cohort_result(operation_id, prepared, revisions, connection)
                self._check_cancel(cancelled)
                self.store.update_cohort_operation(operation_id, {"status": "accepted", "result": result}, connection=connection)
                return result
        return self._accept_cohort_revisions(operation_id, prepared, revisions, cancelled)
