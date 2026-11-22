"""Mandatory, complete capability reconciliation at the Requirements boundary."""

from __future__ import annotations

from copy import deepcopy
import json
import uuid

from jobctrl.app.errors import ConflictError

from .domain import CONTRACT_VERSION, MEANING_KEYS, ModelCallBudget, RequirementError, canonical_json, fingerprint, meaning_data, now
from .normalization_domain import (
    BACKGROUND_COHORT_PROMPT, BACKGROUND_INSTRUCTION, BACKGROUND_MANUAL_PROMPT, BACKGROUND_TRANSPORTS,
    CITED_OCCURRENCE_PARTITION_INSTRUCTION, DEMAND_CHOICE_INSTRUCTION, NORMALIZATION_CITATION_PROMPT_VERSION, NORMALIZATION_INSTRUCTION, NORMALIZATION_PARTITION_V4_PROMPT_VERSION, NORMALIZATION_PARTITION_V5_PROMPT_VERSION, NORMALIZATION_PROMPT_VERSION, NORMALIZATION_VERSION,
    CatalogNormalization, CatalogNormalizationSelection, bind_normalization_selection, bind_normalization_slots,
    demand_fingerprint, validate_normalization,
)
from .normalization_citations import citation_binding_report, citation_binding_summary, citation_segment_catalog, citation_source_context
from .normalization_demand_choices import CITED_OCCURRENCE_PROMPT, DEMAND_CHOICE_PROMPT, add_demand_choice_context
from .normalization_partitions import (cited_occurrence_partition_schema, demand_choice_partition_schema, cohort_partition_schema, refresh_partition_schema, table_partition_schema, partition_binding_summary, partition_group_handles,
                                       partition_selection_schema, partition_selection_schema_v5)
from .normalization_partitions_v4 import partition_selection_schema as partition_selection_schema_v4
from .cohort_transport import (
    COHORT_INSTRUCTIONS, COHORT_PROMPT_VERSION, REFRESH_CATALOG_INSTRUCTIONS, REFRESH_CATALOG_PROMPT_VERSION,
    expand_catalog_sources, pack_catalog_sources,
)
from .catalog_transport import TABLE_CATALOG_INSTRUCTIONS, TABLE_CATALOG_PROMPT_VERSION, expand_catalog_tables, pack_catalog_tables


PARTITION_SCHEMAS = {NORMALIZATION_PROMPT_VERSION: partition_selection_schema,
                     REFRESH_CATALOG_PROMPT_VERSION: refresh_partition_schema,
                     TABLE_CATALOG_PROMPT_VERSION: table_partition_schema,
                     NORMALIZATION_PARTITION_V5_PROMPT_VERSION: partition_selection_schema_v5,
                     NORMALIZATION_PARTITION_V4_PROMPT_VERSION: partition_selection_schema_v4,
                     COHORT_PROMPT_VERSION: cohort_partition_schema}
PARTITION_SCHEMAS.update({prompt: PARTITION_SCHEMAS[wire] for prompt, wire in BACKGROUND_TRANSPORTS.items()})
PARTITION_SCHEMAS.update({DEMAND_CHOICE_PROMPT: demand_choice_partition_schema, CITED_OCCURRENCE_PROMPT: cited_occurrence_partition_schema})


def _catalog_sources(prepared):
    sources = {row["source_id"]: row["text"] for row in prepared["sources"]}
    if len(sources) != len(prepared["sources"]):
        raise RequirementError("catalog_snapshot_invalid")
    version = prepared["prompt_version"]
    transport = BACKGROUND_TRANSPORTS.get(version, version)
    if transport in (COHORT_PROMPT_VERSION, REFRESH_CATALOG_PROMPT_VERSION, TABLE_CATALOG_PROMPT_VERSION):
        if prepared["context"].get("normalization_prompt_version") != prepared["prompt_version"]:
            raise RequirementError("requirements_citation_wire_changed")
        if transport == TABLE_CATALOG_PROMPT_VERSION:
            return expand_catalog_tables(prepared["context"], sources)
        return expand_catalog_sources(prepared["context"], sources)
    return prepared["context"], sources


def _tokens(postings):
    return [{key: row.get(key) for key in ("job_id", "revision", "source_hash", "deleted")}
            for _, row in sorted(postings.items())]


def _compact_citation_sources(context, sources):
    """Short operation-local references; semantic identities and text stay exact."""
    handles = {source_id: f"s{index:03d}" for index, source_id in enumerate(sources, 1)}
    occurrence_sources = {row["source_id"] for row in context["occurrences"]}
    compacted = {}
    for source_id, text in sources.items():
        if source_id in occurrence_sources:
            # Only this outer field refers to the source being supplied here.
            # Nested provider/posting source identities are historical facts.
            value = json.loads(text)
            value["source_id"] = handles[source_id]
            text = canonical_json(value)
        compacted[handles[source_id]] = text
    context["catalog_inventory_source_id"] = handles[context["catalog_inventory_source_id"]]
    for collection, field in (("members", "source_id"), ("occurrences", "source_id"),
                              ("incoming", "model_source_id"), ("accepted_demands", "source_id"),
                              ("posting_sources", "source_id")):
        for row in context[collection]:
            row[field] = handles[row[field]]
    return context, compacted


class CatalogNormalizationService:
    @staticmethod
    def _proposed_occurrence(extracted, posting, receipt, source_binding, operation_id, *, member_id=None):
        member_id = member_id or "incoming:" + extracted.local_id
        occurrence_id = str(uuid.uuid5(uuid.NAMESPACE_URL, canonical_json([operation_id, posting["job_id"], member_id])))
        return {"occurrence_id": occurrence_id, "requirement_id": member_id, "requirement_revision": 1,
            "revision": 1, "job_id": posting["job_id"], "posting_revision": posting["revision"],
            "contract_version": CONTRACT_VERSION, **extracted.model_dump(exclude={"spans"}),
            "canonical": meaning_data(extracted), "source_id": posting["source_id"],
            "model_source_id": source_binding["source_id"], "source_revision": posting["source_revision"],
            "source_hash": posting["source_hash"], "spans": [span.model_dump() for span in extracted.spans],
            "extraction_determination_id": receipt["receipt_id"], "equivalence_determination_ids": [],
            "provenance": {"extraction": receipt, "resolution": [], "matching_local_id": extracted.local_id,
                           "original": extracted.model_dump(exclude={"spans"})},
            "_normalization_member_id": member_id}

    def _incoming_members(self, occurrences, *, cohort=False):
        # A correction's v6 matching ID is the selected occurrence ID.
        return [{"member_id": row["_normalization_member_id"], "job_id": row["job_id"],
                 "extraction_determination_id": row["extraction_determination_id"],
                 "correction_determination_id": row.get("correction_determination_id"),
                 "previous_occurrence_id": row.get("previous_occurrence_id"),
                 "occurrence_id": row["occurrence_id"], "original": {key: row[key] for key in (
                     "category", "name", "definition", "basis", "rationale", "source_note", "evidence_refs", "spans")}
                     | {"local_id": row["local_id"] if cohort else row["_normalization_member_id"].removeprefix("incoming:")}}
                for row in occurrences if "_normalization_member_id" in row]

    async def _normalize_extraction(self, extraction, *, posting, expected_revision, extraction_receipt,
                                    source_binding, operation_id, action_fingerprint, cancelled, budget=None, heartbeat=None,
                                    prompt_version):
        with self.store.read_session() as connection:
            captured = self.store.normalization_capture(connection)
            previous = self.store.current_snapshot(posting["job_id"], connection)
        if (previous["revision"] if previous else 0) != expected_revision:
            raise ConflictError("The accepted requirement snapshot changed.")
        if not extraction.requirements:
            return self.store.publish_empty_snapshot(posting=posting, expected_revision=expected_revision,
                fields=self._extraction_fields(extraction, posting, extraction_receipt, source_binding),
                extraction_receipt=extraction_receipt, attempt_id=operation_id, cancelled=cancelled,
                posting_guard=self.jobs.assert_posting_current)
        rows = [self._proposed_occurrence(row, posting, extraction_receipt, source_binding, operation_id)
                for row in extraction.requirements]
        proposal = {"contract_version": CONTRACT_VERSION, **self._extraction_fields(extraction, posting, extraction_receipt, source_binding),
            "job_id": posting["job_id"], "posting_revision": posting["revision"], "posting_hash": posting["source_hash"],
            "source_id": posting["source_id"], "source_revision": posting["source_revision"], "requirements": rows,
            "extraction_determination_id": extraction_receipt["receipt_id"], "_attempt_id": operation_id}
        return await self._normalize_catalog(captured=captured, proposals={posting["job_id"]: proposal}, incoming=self._incoming_members(rows),
            operation_id=operation_id, action_fingerprint=action_fingerprint, cancelled=cancelled, heartbeat=heartbeat, budget=budget,
            prompt_version=prompt_version)

    def _normalization_postings(self, job_ids, connection=None):
        postings = {}
        identifiers = sorted(set(job_ids))
        for offset in range(0, len(identifiers), 1000):
            postings.update(self.jobs.get_job_snapshots(identifiers[offset:offset + 1000], connection=connection, include_deleted=True))
        if set(postings) != set(identifiers):
            raise ConflictError("A retained job source required for consolidation is unavailable.")
        return postings

    def normalization_status(self, connection=None):
        if connection is None:
            with self.store.read_session() as connection:
                return self.normalization_status(connection)
        epoch, _ = self.store.catalog_snapshot(connection)
        certificate = self.store.normalization_certificate(connection)
        return {"normalization_version": NORMALIZATION_VERSION, "catalog_revision": epoch,
                "ready": bool(certificate and certificate["catalog_revision"] == epoch
                              and certificate["normalization_version"] == NORMALIZATION_VERSION),
                "reconciliation_id": certificate["reconciliation_id"] if certificate else None,
                "certificate_catalog_revision": certificate["catalog_revision"] if certificate else None}

    async def consolidate_catalog(self, *, expected_catalog_revision, operation_id=None, cancelled=lambda: False, heartbeat=None,
                                  catalog_prompt_version=None):
        if type(expected_catalog_revision) is not int or expected_catalog_revision < 0:
            raise RequirementError("invalid_revision")
        self._validate_operation_id(operation_id)
        operation_id = operation_id or str(uuid.uuid4())
        if catalog_prompt_version is None:
            catalog_prompt_version = self.store.admit_consolidation_prompt(
                operation_id, BACKGROUND_MANUAL_PROMPT, NORMALIZATION_PROMPT_VERSION)
        action = fingerprint({"action": "consolidate", "normalization_version": NORMALIZATION_VERSION,
                              "normalization_prompt_version": catalog_prompt_version,
                              "expected_catalog_revision": expected_catalog_revision})
        replay = self.store.normalization_action(operation_id, action)
        if replay is not None:
            return {**replay, "reused_action": True}
        with self.store.read_session() as connection:
            captured = self.store.normalization_capture(connection)
        if captured["catalog_revision"] != expected_catalog_revision:
            raise RequirementError("stale_catalog_revision")
        return await self._normalize_catalog(captured=captured, proposals={}, incoming=[], operation_id=operation_id,
            action_fingerprint=action, cancelled=cancelled, heartbeat=heartbeat, prompt_version=catalog_prompt_version)

    @staticmethod
    def _normalization_input(captured, proposals, incoming, postings, guidance):
        roots = {row["requirement_id"]: row for row in captured["roots"]}
        alias_map = {row["requirement_id"]: row["root_requirement_id"] for row in captured["aliases"]}

        def root_of(ident):
            seen = set()
            while ident in alias_map:
                if ident in seen:
                    raise RequirementError("requirements_alias_cycle")
                seen.add(ident)
                ident = alias_map[ident]
            return ident

        sources = {}
        members = []
        accepted_occurrence_counts = {ident: 0 for ident in roots}
        for snapshot in captured["snapshots"]:
            for occurrence in snapshot["requirements"]:
                root_id = root_of(occurrence["requirement_id"])
                if root_id in accepted_occurrence_counts:
                    accepted_occurrence_counts[root_id] += 1

        def meaning_source(row):
            provenance = row["provenance"]
            if not isinstance(provenance.get("original"), dict) or not isinstance(provenance.get("spans"), list):
                raise RequirementError("catalog_snapshot_invalid")
            return {key: row[key] for key in ("requirement_id", "revision", *MEANING_KEYS)} | {
                "original": provenance["original"], "spans": provenance["spans"], "posting": provenance.get("posting")}

        for ident, row in sorted(roots.items()):
            source_id = f"requirement:{ident}:{row['revision']}"
            family = [meaning_source(item) for item in captured["members"]
                      if item["requirement_id"] != ident and root_of(item["requirement_id"]) == ident]
            sources[source_id] = canonical_json({"canonical": meaning_source(row),
                "retained_members": family})
            members.append({"member_id": ident, "source_id": source_id, "requirement_id": ident,
                            "revision": row["revision"]})
        incoming_context = []
        for row in incoming:
            source_id = row["member_id"]
            sources[source_id] = canonical_json(row["original"])
            members.append({"member_id": row["member_id"], "source_id": source_id,
                            "requirement_id": None, "revision": None})
            incoming_context.append({"local_id": row["original"]["local_id"], "job_id": row["job_id"], "occurrence_id": row["occurrence_id"],
                                     "member_id": row["member_id"], "model_source_id": source_id,
                                     **{key: row.get(key) for key in ("extraction_determination_id", "correction_determination_id", "previous_occurrence_id")}})
        effective = {row["job_id"]: deepcopy(row) for row in captured["snapshots"]}
        effective.update(deepcopy(proposals))
        occurrences = []
        accepted = {}
        accepted_heads = {row["job_id"]: row["revision"] for row in captured.get("accepted_heads", captured["snapshots"])}
        for job_id, snapshot in sorted(effective.items()):
            for row in snapshot["requirements"]:
                member_id = row.get("_normalization_member_id") or root_of(row["requirement_id"])
                if member_id not in {member["member_id"] for member in members}:
                    raise RequirementError("catalog_snapshot_invalid")
                source_id = "occurrence:" + row["occurrence_id"]
                prior_demand = row.get("normalized_demand")
                prior_demand = ({key: prior_demand[key] for key in ("normalization_version", "demand_fingerprint")}
                                if prior_demand else None)
                occurrence = {"job_id": job_id, "occurrence_id": row["occurrence_id"], "member_id": member_id,
                    "posting_revision": row["posting_revision"], "posting_hash": row["source_hash"],
                    "requirement_id": row["requirement_id"], "requirement_revision": row["requirement_revision"],
                    "source_kind": "proposed" if "_normalization_member_id" in row else "accepted_snapshot",
                    "snapshot_revision": None if "_normalization_member_id" in row else accepted_heads.get(job_id),
                    "base_snapshot_revision": accepted_heads.get(job_id, 0),
                    "source_id": source_id, "original": {key: row[key] for key in (
                        "category", "name", "definition", "basis", "rationale", "source_note", "spans")},
                    "canonical": row.get("canonical"), "normalized_demand": prior_demand}
                sources[source_id] = canonical_json({**occurrence, "source_identity": {key: row.get(key) for key in (
                    "source_id", "source_revision", "source_hash", "evidence_refs", "extraction_determination_id")}})
                occurrences.append({key: occurrence[key] for key in (
                    "job_id", "occurrence_id", "member_id", "source_id", "posting_revision", "posting_hash",
                    "requirement_id", "requirement_revision", "source_kind", "snapshot_revision", "base_snapshot_revision")}
                    | {"correction_determination_id": row.get("correction_determination_id"),
                       "previous_occurrence_id": row.get("previous_occurrence_id"),
                       "resolution_determination_ids": list(row.get("equivalence_determination_ids", []))})
                demand = row.get("normalized_demand")
                if demand and demand.get("normalization_version") == NORMALIZATION_VERSION:
                    key = demand["demand_fingerprint"]
                    demand_source_id = "demand:" + key
                    demand_text = canonical_json({"normalization_version": NORMALIZATION_VERSION,
                        "definition": demand["definition"], "demand_fingerprint": key})
                    if demand_source_id in sources and sources[demand_source_id] != demand_text:
                        raise RequirementError("requirements_demand_signature_invalid")
                    sources[demand_source_id] = demand_text
                    previous = accepted.setdefault(key, {"source_id": demand_source_id, "demand_fingerprint": key,
                        "normalization_version": NORMALIZATION_VERSION, "group_member_ids": []})
                    if member_id not in previous["group_member_ids"]:
                        previous["group_member_ids"].append(member_id)
        for job_id, posting in sorted(postings.items()):
            sources[f"posting:{job_id}:{posting['revision']}:{posting['source_hash']}"] = canonical_json({
                key: posting.get(key) for key in ("job_id", "revision", "source_id", "source_revision", "source_hash", "title", "company")
            } | {"text": posting.get("text") or posting.get("description") or ""})
        inventory = {"normalization_version": NORMALIZATION_VERSION, "catalog_revision": captured["catalog_revision"],
                     "member_heads": captured["member_heads"], "member_ids": [row["member_id"] for row in members],
                     "snapshot_heads": [{"job_id": row["job_id"], "revision": row["revision"]} for row in captured["snapshots"]],
                     "posting_tokens": _tokens(postings)}
        inventory_id = "catalog-inventory:" + fingerprint(inventory)
        sources[inventory_id] = canonical_json(inventory)
        context = {"contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION,
                   "catalog_revision": captured["catalog_revision"], "catalog_inventory_source_id": inventory_id,
                   "members": members, "occurrences": occurrences, "incoming": incoming_context,
                   "accepted_occurrence_counts": accepted_occurrence_counts,
                   "source_snapshot_heads": deepcopy(captured.get("accepted_heads", [
                       {"job_id": row["job_id"], "revision": row["revision"], "posting_revision": row["posting_revision"],
                        "posting_hash": row["posting_hash"]} for row in captured["snapshots"]])),
                   "candidates": [{"requirement_id": row["requirement_id"], "revision": row["revision"]} for row in roots.values()],
                   "accepted_demands": list(accepted.values()), "guidance": guidance}
        context["posting_sources"] = [{"job_id": job_id, "revision": posting["revision"], "source_hash": posting["source_hash"],
            "source_id": f"posting:{job_id}:{posting['revision']}:{posting['source_hash']}"} for job_id, posting in sorted(postings.items())]
        context, sources = _compact_citation_sources(context, sources)
        return context, sources, effective

    @classmethod
    def prepare_catalog_consolidation(cls, *, captured, postings, operation_id, proposals=None, incoming=None, guidance=None,
                                      cohort=False, prompt_version=None):
        """Pure public owner payload builder for source-only semantic validation.

        Callers supply detached complete source DTOs. This performs no reads,
        schema initialization, model admission or writes to any workspace.
        """
        context, sources, _ = cls._normalization_input(captured, proposals or {}, incoming or [], postings, guidance)
        context["operation_id"] = operation_id
        if prompt_version is None:
            prompt_version = BACKGROUND_COHORT_PROMPT if cohort else BACKGROUND_MANUAL_PROMPT
        # Earlier cohort builders used the v6 base to request their v7 cohort.
        version = COHORT_PROMPT_VERSION if cohort and prompt_version == NORMALIZATION_PROMPT_VERSION else prompt_version
        transport = BACKGROUND_TRANSPORTS.get(version, version)
        allowed_transports = (COHORT_PROMPT_VERSION,) if cohort else (
            NORMALIZATION_PROMPT_VERSION, REFRESH_CATALOG_PROMPT_VERSION, TABLE_CATALOG_PROMPT_VERSION)
        if transport not in allowed_transports:
            raise RequirementError("requirements_citation_wire_changed")
        if version in (DEMAND_CHOICE_PROMPT, CITED_OCCURRENCE_PROMPT):
            add_demand_choice_context(context, sources, NORMALIZATION_VERSION)
        context["normalization_prompt_version"] = version
        context["partition_group_handles"] = partition_group_handles(context)
        context["citation_segments"] = citation_segment_catalog(sources,
            inventory_source_id=context["catalog_inventory_source_id"], catalog_revision=context["catalog_revision"])
        context["citation_catalog_fingerprint"] = fingerprint(context["citation_segments"])
        context["citation_source_fingerprints"] = {ident: fingerprint(text) for ident, text in sources.items()}
        context["citation_source_context_fingerprint"] = fingerprint(citation_source_context(context, sources))
        schema = PARTITION_SCHEMAS[version](context).model_json_schema()
        instructions = {DEMAND_CHOICE_PROMPT: DEMAND_CHOICE_INSTRUCTION,
                        CITED_OCCURRENCE_PROMPT: CITED_OCCURRENCE_PARTITION_INSTRUCTION}.get(version, NORMALIZATION_INSTRUCTION)
        if version in BACKGROUND_TRANSPORTS:
            instructions += BACKGROUND_INSTRUCTION
        if transport == TABLE_CATALOG_PROMPT_VERSION:
            context, sources = pack_catalog_tables(context, sources)
            instructions += TABLE_CATALOG_INSTRUCTIONS
        elif transport in (COHORT_PROMPT_VERSION, REFRESH_CATALOG_PROMPT_VERSION):
            context, sources = pack_catalog_sources(context, sources)
            instructions += COHORT_INSTRUCTIONS if cohort else REFRESH_CATALOG_INSTRUCTIONS
        return {"operation": "requirements.match_catalog", "prompt_version": version,
                "instructions": instructions, "response_schema": schema,
                "context": context, "sources": [{"source_id": ident, "text": text} for ident, text in sources.items()]}

    @staticmethod
    def validate_catalog_consolidation(value, prepared):
        if prepared["prompt_version"] in PARTITION_SCHEMAS:
            return CatalogNormalizationService.bind_catalog_consolidation(value, prepared)["selection"]
        if prepared["prompt_version"] == NORMALIZATION_CITATION_PROMPT_VERSION:
            result = CatalogNormalizationSelection.model_validate(value)
            bind_normalization_selection(result, context=prepared["context"],
                sources={row["source_id"]: row["text"] for row in prepared["sources"]})
            return result.model_dump()
        # Historical quote-wire authority is checked only against its exact
        # declared old input. It never falls back from a failed current result.
        if prepared["prompt_version"] != NORMALIZATION_VERSION:
            raise RequirementError("requirements_citation_wire_changed")
        result = CatalogNormalization.model_validate(value)
        validate_normalization(result, context=prepared["context"],
                               sources={row["source_id"]: row["text"] for row in prepared["sources"]})
        return result.model_dump()

    @staticmethod
    def bind_catalog_consolidation(value, prepared):
        if prepared["prompt_version"] not in PARTITION_SCHEMAS:
            raise RequirementError("requirements_citation_wire_changed")
        context, sources = _catalog_sources(prepared)
        selection = PARTITION_SCHEMAS[prepared["prompt_version"]](context).model_validate(value)
        derived, intermediate, partition_binding, citation_binding = bind_normalization_slots(
            selection, context=context, sources=sources, prompt_version=prepared["prompt_version"])
        return {"selection": selection.model_dump(), "intermediate_selection": intermediate.model_dump(),
                "derived_decision": derived.model_dump(), "partition_binding": partition_binding,
                "citation_binding": citation_binding}

    async def _normalize_catalog(self, *, captured, proposals, incoming, operation_id, action_fingerprint,
                                 cancelled, heartbeat=None, budget=None, guidance=None, revision_action=None,
                                 required_bindings=None, source_posting=None, cohort_state=None, cohort_guard=None,
                                 prompt_version=NORMALIZATION_PROMPT_VERSION):
        self._check_cancel(cancelled)
        with self.store.read_session() as connection:
            self.store.assert_normalization_capture(captured, connection)
            for proposal in proposals.values():
                self.jobs.assert_posting_current(proposal["job_id"], proposal["posting_revision"], proposal["posting_hash"], connection=connection)
            if source_posting is not None:
                self.jobs.assert_posting_current(source_posting["job_id"], source_posting["revision"], source_posting["source_hash"], connection=connection)
            postings = self._normalization_postings([row["job_id"] for row in captured["snapshots"]] + list(proposals)
                + ([source_posting["job_id"]] if source_posting is not None else []), connection)
            original_jobs = {row["provenance"].get("posting", {}).get("job_id") for row in captured["members"]}
            optional_jobs = sorted(original_jobs - set(postings) - {None})
            for offset in range(0, len(optional_jobs), 1000):
                postings.update(self.jobs.get_job_snapshots(optional_jobs[offset:offset + 1000], connection=connection, include_deleted=True))
        prepared = self.prepare_catalog_consolidation(captured=captured, proposals=proposals, incoming=incoming,
            postings=postings, guidance=guidance, operation_id=operation_id, cohort=cohort_state is not None, prompt_version=prompt_version)
        context, sources = _catalog_sources(prepared)
        version = prepared["prompt_version"]
        effective = {row["job_id"]: deepcopy(row) for row in captured["snapshots"]}
        effective.update(deepcopy(proposals))

        def guard(connection):
            self._check_cancel(cancelled)
            self.store.assert_normalization_capture(captured, connection)
            if cohort_guard is not None:
                cohort_guard(connection)
            current = self._normalization_postings(postings, connection)
            if _tokens(current) != _tokens(postings):
                raise ConflictError("A job posting changed during complete catalog consolidation.")
            for proposal in proposals.values():
                self.jobs.assert_posting_current(proposal["job_id"], proposal["posting_revision"], proposal["posting_hash"], connection=connection)
            if source_posting is not None:
                self.jobs.assert_posting_current(source_posting["job_id"], source_posting["revision"], source_posting["source_hash"], connection=connection)

        if heartbeat:
            heartbeat({"phase": "requirements_consolidation", "catalog_revision": captured["catalog_revision"],
                       "member_count": len(context["members"]), "occurrence_count": len(context["occurrences"])})
        request_pin = {}
        def reserve(value, connection):
            if cohort_state is not None:
                return self.store.reserve_cohort_call(operation_id, value, request_pin, guard, normalization=True, connection=connection)
            return self.store.reserve_normalization_call(operation_id, value, guard, connection=connection)
        selection, receipt = await self.model.determine(
            kind="requirements.match_catalog", schema=PARTITION_SCHEMAS[version](context), prompt_version=version,
            instruction=prepared["instructions"], sources=prepared["sources"], context=prepared["context"], entity_id=None,
            validate=lambda value: bind_normalization_slots(value, context=context, sources=sources, prompt_version=version),
            budget=ModelCallBudget(action_fingerprint, 1, reserve=reserve, check_reservation=lambda value:
                self.store.assert_normalization_call_available(operation_id, value)), catalog_guard=guard,
            retained_request=cohort_state.get("model_request") if cohort_state is not None else None,
            pin_request=request_pin.update if cohort_state is not None else None,
        )
        self._check_cancel(cancelled)
        decision, intermediate, partition_binding, citation_binding = bind_normalization_slots(selection, context=context, sources=sources,
                                                                                             prompt_version=version)
        binding_summary = citation_binding_summary(citation_binding)
        partition_summary = partition_binding_summary(partition_binding)
        if receipt["accepted_result_fingerprint"] != partition_binding["raw_selection_fingerprint"]:
            raise RequirementError("model_cache_binding_invalid")
        mappings, roots, new_meanings = self._normalization_roots(captured, context, decision, receipt, operation_id, effective,
                                                               binding_summary, partition_summary)
        if any(mappings[member] != mappings[target] for member, target in (required_bindings or {}).items()):
            raise RequirementError("binding_not_equivalent")
        replacements = self._normalization_replacements(captured, effective, proposals, mappings, roots, decision, receipt,
                                                       operation_id, binding_summary, partition_summary)
        report = {"captured_catalog_revision": captured["catalog_revision"],
                  "input_member_count": len(context["members"]), "root_count": len(roots),
                  "mapping": mappings, "citation_binding": citation_binding_report(citation_binding),
                  "partition_binding": partition_binding,
                  "corrections": [row.model_dump() for row in decision.corrections],
                  "roots": [{"requirement_id": row["requirement_id"], "revision": row["revision"],
                      "category": row["category"], "name": row["name"], "definition": row["definition"]} for row in roots.values()]}
        old_aliases = {row["requirement_id"]: row["root_requirement_id"] for row in captured["aliases"]}
        aliases = {}
        for row in captured["members"]:
            ident = row["requirement_id"]
            previous_root = ident
            while previous_root in old_aliases:
                previous_root = old_aliases[previous_root]
            aliases[ident] = mappings[previous_root]
        mappings.update(aliases)
        if revision_action is not None:
            revised_root = mappings[revision_action["requirement_id"]]
            revision_action = {**revision_action, "requirement_id": revised_root, "revision": roots[revised_root]["revision"]}
        return self.store.publish_normalization(captured=captured, meanings=new_meanings, aliases=aliases,
            replacements=replacements, operation_id=operation_id, input_fingerprint=action_fingerprint,
            decision=decision.model_dump(), selection=selection.model_dump(), intermediate_selection=intermediate.model_dump(),
            partition_binding=partition_binding, citation_binding=citation_binding,
            receipt=receipt, authority_receipt=self.model.receipt(receipt["receipt_id"]),
            report=report, guard=guard, cancelled=cancelled,
            revision_action=revision_action)

    @staticmethod
    def _normalization_roots(captured, context, decision, receipt, operation_id, effective, citation_binding, partition_binding):
        existing = {row["requirement_id"]: row for row in captured["roots"]}
        mappings, roots, new_meanings = {}, {}, []
        for group in decision.capabilities:
            corrections = [row.model_dump() for row in decision.corrections if row.retained_group_id == group.group_id]
            prior = sorted(set(group.member_ids).intersection(existing))
            root_id = prior[0] if prior else CONTRACT_VERSION + ":" + str(uuid.uuid5(uuid.NAMESPACE_URL,
                "jobctrl:capability:" + fingerprint({"normalization_version": NORMALIZATION_VERSION,
                    "catalog_revision": captured["catalog_revision"], "members": sorted(group.member_ids), "operation_id": operation_id})))
            previous = existing.get(root_id)
            fields = {"contract_version": CONTRACT_VERSION, **{key: getattr(group, key) for key in ("category", "name", "definition")}}
            unchanged = previous is not None and not corrections and all(previous[key] == fields[key] for key in MEANING_KEYS)
            if unchanged:
                meaning = previous
            else:
                original_row = next((row for snapshot in effective.values() for row in snapshot["requirements"]
                    if row.get("_normalization_member_id") in group.member_ids), None)
                original = ({key: original_row[key] for key in (
                    "local_id", "category", "name", "definition", "basis", "rationale", "source_note", "evidence_refs")}
                    if original_row else fields)
                provenance = deepcopy(previous["provenance"]) if previous else {
                    **(deepcopy(original_row["provenance"]) if original_row else {}), "original": original,
                    "spans": original_row["spans"] if original_row else [],
                    "posting": {"job_id": original_row["job_id"], "revision": original_row["posting_revision"],
                        **{key: original_row[key] for key in ("source_id", "source_revision", "source_hash")}}
                        if original_row else {}, "extraction": original_row["provenance"]["extraction"] if original_row else {},
                    "resolution": [receipt]}
                provenance["normalization"] = {"normalization_version": NORMALIZATION_VERSION,
                    "citation_binding": citation_binding, "partition_binding": partition_binding,
                    "reconciliation_id": operation_id, "receipt": receipt, "member_ids": group.member_ids,
                    "reason": group.reason, "citations": [row.model_dump() for row in group.citations], "corrections": corrections}
                if previous is None and original_row and provenance.get("semantic_stage") == "occurrence_correction":
                    provenance["correction"] = original_row["provenance"]["correction"]["receipt"]
                meaning = {"requirement_id": root_id, "revision": previous["revision"] + 1 if previous else 1,
                           **fields, "created_at": now(), "provenance": provenance}
                new_meanings.append(meaning)
            roots[root_id] = meaning
            mappings.update({ident: root_id for ident in group.member_ids})
        return mappings, roots, new_meanings

    @staticmethod
    def _normalization_replacements(captured, effective, proposals, mappings, roots, decision, receipt, operation_id,
                                    citation_binding, partition_binding):
        groups = {group.group_id: mappings[group.member_ids[0]] for group in decision.capabilities}
        demands = {}
        for demand in decision.demands:
            root_id = groups[demand.group_id]
            signature = demand_fingerprint(roots[root_id]["category"], demand.definition)
            for binding in demand.bindings:
                normalized = {"normalization_version": NORMALIZATION_VERSION, "definition": demand.definition,
                    "demand_fingerprint": signature, "provenance": {"normalization_version": NORMALIZATION_VERSION,
                        "citation_binding": citation_binding, "partition_binding": partition_binding,
                        "reconciliation_id": operation_id, "receipt": receipt, "input_fingerprint": receipt["input_fingerprint"],
                        "citations": [row.model_dump() for row in demand.citations], "occurrence_ids": binding.occurrence_ids}}
                for occurrence_id in binding.occurrence_ids:
                    demands[occurrence_id] = (root_id, normalized)
        previous_heads = {row["job_id"]: row["revision"] for row in captured.get("accepted_heads", captured["snapshots"])}
        accepted_occurrences = {row["job_id"]: {item["occurrence_id"] for item in row["requirements"]} for row in captured["snapshots"]}
        replacements = []
        for job_id, snapshot in sorted(effective.items()):
            rows = []
            changed = job_id in proposals or snapshot.get("normalization_version") != NORMALIZATION_VERSION
            for occurrence in snapshot["requirements"]:
                root_id, normalized = demands[occurrence["occurrence_id"]]
                meaning = roots[root_id]
                old_demand = occurrence.get("normalized_demand")
                same = (occurrence.get("requirement_id") == root_id
                        and occurrence.get("requirement_revision") == meaning["revision"]
                        and old_demand is not None
                        and all(old_demand.get(key) == normalized[key] for key in ("normalization_version", "definition", "demand_fingerprint")))
                changed = changed or not same
                row = {key: value for key, value in occurrence.items() if not key.startswith("_")}
                row.update(requirement_id=root_id, requirement_revision=meaning["revision"], revision=meaning["revision"],
                    canonical={key: meaning[key] for key in MEANING_KEYS},
                    normalized_demand=old_demand if same else normalized)
                if not same:
                    inventory = {"normalization_version": NORMALIZATION_VERSION, "catalog_revision": captured["catalog_revision"],
                        "candidate_count": len(captured["roots"]), "candidate_set_fingerprint": fingerprint(captured["member_heads"])}
                    row["equivalence_determination_ids"] = [receipt["receipt_id"]]
                    row["provenance"] = {**row["provenance"], "resolution": [receipt], "catalog_matching": inventory,
                        "normalization": normalized["provenance"]}
                rows.append(row)
            if not changed:
                continue
            for row in rows:
                old_id = row["occurrence_id"]
                row["occurrence_id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, canonical_json([operation_id, job_id, old_id])))
                if old_id in accepted_occurrences.get(job_id, set()):
                    row["previous_occurrence_id"] = old_id
                elif row.get("previous_occurrence_id") not in accepted_occurrences.get(job_id, set()):
                    row.pop("previous_occurrence_id", None)
            replacement = {**snapshot, "requirements": rows, "revision": previous_heads.get(job_id, 0) + 1,
                "normalization_version": NORMALIZATION_VERSION, "normalization_provenance": {"receipt": receipt,
                    "reconciliation_id": operation_id, "citation_binding": citation_binding,
                    "partition_binding": partition_binding}, "created_at": now(),
                "_attempt_id": snapshot.get("_attempt_id", "normalization:" + operation_id + ":" + job_id)}
            replacements.append(replacement)
        return replacements

    def demand_catalog_snapshot(self, connection=None, *, active_only=False):
        if connection is None:
            with self.store.read_session() as connection:
                return self.demand_catalog_snapshot(connection, active_only=active_only)
        captured = self.store.normalization_capture(connection)
        postings = self._normalization_postings([row["job_id"] for row in captured["snapshots"]], connection)
        roots = {row["requirement_id"]: row for row in captured["roots"]}
        demands, missing = {}, []
        for snapshot in captured["snapshots"]:
            job_id = snapshot["job_id"]
            if active_only and postings[job_id].get("deleted"):
                continue
            if snapshot.get("normalization_version") != NORMALIZATION_VERSION:
                missing.append(job_id)
                continue
            for row in snapshot["requirements"]:
                normalized = row.get("normalized_demand")
                if not normalized or normalized.get("normalization_version") != NORMALIZATION_VERSION:
                    missing.append(job_id)
                    continue
                ident = row["requirement_id"]
                if ident not in roots or row["requirement_revision"] != roots[ident]["revision"]:
                    missing.append(job_id)
                    continue
                key = (ident, row["requirement_revision"], normalized["demand_fingerprint"])
                item = demands.setdefault(key, {"contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION,
                    "requirement_id": ident, "requirement_revision": row["requirement_revision"],
                    "category": roots[ident]["category"], "name": roots[ident]["name"],
                    "capability_definition": roots[ident]["definition"], "definition": normalized["definition"],
                    "demand_fingerprint": normalized["demand_fingerprint"], "demand_provenance": normalized["provenance"], "job_ids": []})
                if job_id not in item["job_ids"]:
                    item["job_ids"].append(job_id)
        result = {"contract_version": CONTRACT_VERSION, "normalization_version": NORMALIZATION_VERSION,
            "catalog_revision": captured["catalog_revision"], "active_only": active_only,
            "requirements": [{key: row[key] for key in ("requirement_id", "revision", *MEANING_KEYS)} for row in roots.values()],
            "demands": [demands[key] for key in sorted(demands)], "consolidation_required_job_ids": sorted(set(missing)),
            "snapshot_heads": [{"job_id": row["job_id"], "revision": row["revision"]} for row in captured["snapshots"]],
            "posting_tokens": _tokens(postings)}
        return {**result, "fingerprint": fingerprint(result)}

    def assert_current_demand_catalog(self, snapshot, connection=None):
        current = self.demand_catalog_snapshot(connection, active_only=snapshot.get("active_only", False))
        if canonical_json(current) != canonical_json(snapshot):
            raise ConflictError("The normalized requirement demand catalog changed.")
