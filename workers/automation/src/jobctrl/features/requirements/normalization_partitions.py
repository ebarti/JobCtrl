"""Exhaustive assignments to independent terminal groups; no recursive aliases."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, StrictInt, StrictStr, create_model
from typing_extensions import TypeAliasType

from .domain import QualifiedMeaning, RequirementError, Value, _nonblank, fingerprint
from .normalization_citations import CitationSelection
from .normalization_partitions_v4 import SlotValue, UnresolvedSlot, _id_type


PARTITION_BINDER_VERSION = "requirements-partition-binding-v2"
NORMALIZATION_BINDING_VERSION = "requirements-normalization-binding-v3"


class CapabilityGroup(QualifiedMeaning):
    kind: Literal["group"]
    reason: StrictStr = Field(min_length=1, max_length=6000)
    citations: list[CitationSelection] = Field(min_length=1)


class DemandGroup(Value):
    kind: Literal["group"]
    definition: StrictStr = Field(min_length=1, max_length=6000)
    reuse_demand_fingerprint: StrictStr | None
    citations: list[CitationSelection] = Field(min_length=1)


def partition_group_handles(context):
    # Capacity permits every input to be separate. The model alone chooses how
    # many groups to use; these labels carry no meaning or durable identity.
    return {"capabilities": [f"capability:{index + 1}" for index in range(len(context["members"]))],
            "demands": [f"demand:{index + 1}" for index in range(len(context["occurrences"]))]}


def _citation_type(name, source_ids, context):
    catalog = context["citation_segments"]
    if not source_ids or not set(source_ids).issubset(catalog):
        raise RequirementError("citation_segment_catalog_invalid")
    return create_model(name + "Citation", __base__=(CitationSelection, SlotValue),
        source_id=(_id_type(name + "SourceId", source_ids), ...))


def _demand_evidence_sources(context):
    # Source roles come only from recorded joins. A supplied prior definition
    # is copy/reuse context, never original demand evidence.
    allowed = {context["catalog_inventory_source_id"]}
    allowed.update(row["source_id"] for row in context["occurrences"])
    for posting in context["posting_sources"]:
        if any((row["job_id"], row["posting_revision"], row["posting_hash"])
                == (posting["job_id"], posting["revision"], posting["source_hash"])
                for row in context["occurrences"]):
            allowed.add(posting["source_id"])
    return tuple(ident for ident in context["citation_segments"] if ident in allowed)


def partition_selection_schema(context):
    return _partition_selection_schema(context, offered_citations=True)


def refresh_partition_schema(context):
    return _partition_selection_schema(context, offered_citations=True, retained_reuse_only=True)


def table_partition_schema(context):
    return _partition_selection_schema(context, offered_citations=True, retained_reuse_only=True, shared_slot_schema=True)


def demand_choice_partition_schema(context, *, cited_occurrences=False):
    return _partition_selection_schema(context, offered_citations=True, retained_reuse_only=True, shared_slot_schema=True,
                                       demand_choices=True, cited_occurrences=cited_occurrences)


def cited_occurrence_partition_schema(context):
    return demand_choice_partition_schema(context, cited_occurrences=True)


def _demand_choice_schema(context, citation):
    citations = (list[citation], Field(min_length=1))
    authored = create_model("AuthoredDemand", __base__=SlotValue, kind=(Literal["author"], ...),
        definition=(StrictStr, Field(min_length=1, max_length=6000)), citations=citations)
    references = tuple(row["source_id"] for row in context["accepted_demands"])
    if not references:
        return authored
    if len(references) != len(set(references)):
        raise RequirementError("catalog_snapshot_invalid")
    keep = create_model("OccurrenceDemand", __base__=SlotValue, kind=(Literal["keep"], ...), citations=citations)
    select = create_model("SelectedDemand", __base__=SlotValue, kind=(Literal["select"], ...),
        prior_demand_source_id=(_id_type("PriorDemandSource", references), ...), citations=citations)
    return authored | keep | select


def cohort_partition_schema(context):
    return _partition_selection_schema(context, offered_citations=True, cohort=True)


def partition_selection_schema_v5(context):
    """Exact historical v5 schema; never a fallback for a current response."""
    return _partition_selection_schema(context, offered_citations=False)


def _partition_selection_schema(context, *, offered_citations, cohort=False, retained_reuse_only=False, shared_slot_schema=False, demand_choices=False, cited_occurrences=False):
    member_ids = tuple(row["member_id"] for row in context["members"])
    occurrence_ids = tuple(row["occurrence_id"] for row in context["occurrences"])
    if len(set(member_ids)) != len(member_ids) or len(set(occurrence_ids)) != len(occurrence_ids):
        raise RequirementError("catalog_snapshot_invalid")
    handles = partition_group_handles(context)
    member_id = _id_type("MemberId", member_ids)
    capability_id = _id_type("CapabilityGroupId", handles["capabilities"])
    demand_id = _id_type("DemandGroupId", handles["demands"])
    citation, demand, unresolved = CitationSelection, DemandGroup, UnresolvedSlot
    if cohort or retained_reuse_only:
        retained = tuple(row["requirement_id"] for row in context["members"] if row["requirement_id"] is not None)
    reuse_id = member_id | None
    if retained_reuse_only:
        # Incoming IDs can be assigned, but do not identify an accepted meaning.
        reuse_id = _id_type("RetainedCapabilityId", retained) | None if retained else type(None)
    capability_fields = {"reuse_requirement_id": (reuse_id, ...)}
    if offered_citations:
        citation = _citation_type("Offered", tuple(context["citation_segments"]), context)
        demand_citation = _citation_type("DemandEvidence", _demand_evidence_sources(context), context)
        capability_fields["citations"] = (list[citation], Field(min_length=1))
        demand = (_demand_choice_schema(context, demand_citation) if demand_choices else
                  create_model("DemandGroup", __base__=(DemandGroup, SlotValue), citations=(list[demand_citation], Field(min_length=1))))
        unresolved = create_model("UnresolvedSlot", __base__=(UnresolvedSlot, SlotValue),
                                  citations=(list[citation], Field(min_length=1)))
    capability = create_model("CapabilityGroup", __base__=(CapabilityGroup, SlotValue), **capability_fields)
    if cohort:
        if retained:
            capability = capability | create_model("RetainedCapability", __base__=SlotValue,
                kind=(Literal["reuse"], ...), reuse_requirement_id=(_id_type("RetainedCapabilityId", retained), ...),
                reason=(StrictStr, Field(min_length=1, max_length=6000)), citations=(list[citation], Field(min_length=1)))
        signatures = tuple(row["demand_fingerprint"] for row in context["accepted_demands"])
        if signatures:
            demand = demand | create_model("RetainedDemand", __base__=SlotValue,
                kind=(Literal["reuse"], ...), reuse_demand_fingerprint=(_id_type("RetainedDemandId", signatures), ...),
                citations=(list[demand_citation], Field(min_length=1)))
    member_assignment = create_model("MemberAssignment", __base__=SlotValue,
        kind=(Literal["assigned"], ...), capability_group_id=(capability_id, ...))
    occurrence_assignment = (create_model("CitedOccurrence", __base__=SlotValue, kind=(Literal["cited"], ...))
        if cited_occurrences else create_model("OccurrenceAssignment", __base__=SlotValue,
            kind=(Literal["assigned"], ...), demand_group_id=(demand_id, ...)))
    def slots(name, entries, definition):
        if shared_slot_schema:
            definition = TypeAliasType(name + "Value", definition)
        return create_model(name, __base__=SlotValue, **{ident: (definition, ...) for ident in entries})

    members = slots("MemberSlots", member_ids, member_assignment | unresolved)
    occurrences = slots("OccurrenceSlots", occurrence_ids, occurrence_assignment | unresolved)
    capabilities = slots("CapabilityGroups", handles["capabilities"], capability | None)
    demands = slots("DemandGroups", handles["demands"], demand | None)
    correction = create_model("PartitionCorrection", __base__=SlotValue,
        member_id=(member_id, ...), represented_by_member_id=(member_id, ...),
        unsupported_claim=(StrictStr, Field(min_length=1, max_length=2500)),
        reason=(StrictStr, Field(min_length=1, max_length=6000)),
        citations=(list[citation], Field(min_length=2)))
    return create_model("CatalogNormalizationSlots", __base__=SlotValue,
        status=(Literal["complete", "needs_review"], ...), catalog_revision=(StrictInt, Field(ge=0)),
        member_slots=(members, ...), occurrence_slots=(occurrences, ...),
        capability_groups=(capabilities, ...), demand_groups=(demands, ...), corrections=(list[correction], ...))


def bind_partition_selection(selection, *, context, expanded=None):
    """Join only declared assignments; never choose a representative or meaning."""
    raw = selection.model_dump() if expanded is None else expanded
    _nonblank(raw)
    members = {row["member_id"]: row for row in context["members"]}
    occurrences = {row["occurrence_id"]: row for row in context["occurrences"]}
    handles = partition_group_handles(context)
    if (set(raw["member_slots"]) != set(members) or set(raw["occurrence_slots"]) != set(occurrences)
            or set(raw["capability_groups"]) != set(handles["capabilities"])
            or set(raw["demand_groups"]) != set(handles["demands"])):
        raise RequirementError("requirements_consolidation_partition_invalid")
    if raw["catalog_revision"] != context["catalog_revision"]:
        raise RequirementError("stale_catalog_revision")
    if raw["status"] != "complete" or any(slot["kind"] == "unresolved"
            for slots in (raw["member_slots"], raw["occurrence_slots"]) for slot in slots.values()):
        raise RequirementError("requirements_consolidation_uncertain")
    member_groups = {ident: slot["capability_group_id"] for ident, slot in raw["member_slots"].items()}
    occurrence_groups = {ident: slot["demand_group_id"] for ident, slot in raw["occurrence_slots"].items()}
    for assignments, definitions in ((member_groups, raw["capability_groups"]), (occurrence_groups, raw["demand_groups"])):
        if set(assignments.values()) != {ident for ident, definition in definitions.items() if definition is not None}:
            raise RequirementError("requirements_partition_reference_invalid")
    capabilities = [{"group_id": ident, "member_ids": [member for member in members if member_groups[member] == ident],
        **{key: slot[key] for key in ("category", "name", "definition", "reuse_requirement_id", "reason", "citations")}}
        for ident, slot in raw["capability_groups"].items() if slot is not None]
    demand_capabilities, job_demands, bindings = {}, {}, {}
    for ident, demand in occurrence_groups.items():
        occurrence = occurrences[ident]
        capability = member_groups[occurrence["member_id"]]
        if demand in demand_capabilities and demand_capabilities[demand] != capability:
            raise RequirementError("requirements_demand_partition_invalid")
        demand_capabilities[demand] = capability
        key = (occurrence["job_id"], capability)
        if key in job_demands and job_demands[key] != demand:
            raise RequirementError("requirements_demand_partition_invalid")
        job_demands[key] = demand
        bindings.setdefault(demand, {}).setdefault(occurrence["job_id"], []).append(ident)
    demands = [{"group_id": demand_capabilities[ident],
        **{key: slot[key] for key in ("definition", "reuse_demand_fingerprint", "citations")},
        "bindings": [{"job_id": job, "occurrence_ids": ids} for job, ids in bindings[ident].items()]}
        for ident, slot in raw["demand_groups"].items() if slot is not None]
    corrections = []
    for correction in raw["corrections"]:
        member, target = correction["member_id"], correction["represented_by_member_id"]
        if member not in members or target not in members:
            raise RequirementError("requirements_correction_witness_invalid")
        corrections.append({"member_id": member, "retained_group_id": member_groups[member],
            "represented_by_group_id": member_groups[target],
            **{key: correction[key] for key in ("unsupported_claim", "reason", "citations")}})
    intermediate = {"status": raw["status"], "catalog_revision": raw["catalog_revision"],
                    "capabilities": capabilities, "demands": demands, "corrections": corrections, "unresolved": []}
    binding = {"binder_version": PARTITION_BINDER_VERSION, "raw_selection_fingerprint": fingerprint(selection.model_dump()),
               "intermediate_fingerprint": fingerprint(intermediate), "member_groups": member_groups,
               "occurrence_groups": occurrence_groups, "demand_capabilities": demand_capabilities}
    if expanded is not None:
        binding["expanded_group_selection_fingerprint"] = fingerprint(expanded)
    return intermediate, binding


def partition_binding_summary(binding):
    return {key: binding[key] for key in ("binder_version", "raw_selection_fingerprint", "intermediate_fingerprint",
                                          "expanded_group_selection_fingerprint") if key in binding}
