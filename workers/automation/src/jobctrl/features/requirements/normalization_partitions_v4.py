"""Exact v4 graph wire, retained solely for explicitly versioned historical reads."""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, StrictInt, StrictStr, create_model

from .domain import QualifiedMeaning, RequirementError, Value, _nonblank, fingerprint
from .normalization_citations import CitationSelection


PARTITION_BINDER_VERSION = "requirements-partition-binding-v1"
NORMALIZATION_BINDING_VERSION = "requirements-normalization-binding-v2"


class SlotValue(Value):
    # Enums constrain supplied IDs without changing their raw string values.
    model_config = ConfigDict(use_enum_values=True)


class MemberRoot(QualifiedMeaning):
    kind: Literal["root"]
    reason: StrictStr = Field(min_length=1, max_length=6000)
    citations: list[CitationSelection] = Field(min_length=1)


class OccurrenceRoot(Value):
    kind: Literal["root"]
    definition: StrictStr = Field(min_length=1, max_length=6000)
    reuse_demand_fingerprint: StrictStr | None
    citations: list[CitationSelection] = Field(min_length=1)


class UnresolvedSlot(Value):
    kind: Literal["unresolved"]
    reason: StrictStr = Field(min_length=1, max_length=6000)
    citations: list[CitationSelection] = Field(min_length=1)


def _id_type(name, identifiers):
    if not identifiers:
        # An empty inventory has no reference-bearing slots. Any correction
        # still fails the owner membership guard rather than inventing an ID.
        return StrictStr
    enum = Enum(name, {f"id{index}": ident for index, ident in enumerate(identifiers)}, type=str)
    return Annotated[enum, Field(strict=False)]


def partition_selection_schema(context):
    """Required properties cover all inputs; ID enums occur once in $defs."""
    member_ids = tuple(row["member_id"] for row in context["members"])
    occurrence_ids = tuple(row["occurrence_id"] for row in context["occurrences"])
    if len(set(member_ids)) != len(member_ids) or len(set(occurrence_ids)) != len(occurrence_ids):
        raise RequirementError("catalog_snapshot_invalid")
    member_id = _id_type("MemberId", member_ids)
    occurrence_id = _id_type("OccurrenceId", occurrence_ids)
    member_root = create_model("MemberRoot", __base__=(MemberRoot, SlotValue),
                               reuse_requirement_id=(member_id | None, ...))
    member_alias = create_model("MemberSameAs", __base__=SlotValue,
                                kind=(Literal["same_as"], ...), member_id=(member_id, ...))
    occurrence_alias = create_model("OccurrenceSameAs", __base__=SlotValue,
                                    kind=(Literal["same_as"], ...), occurrence_id=(occurrence_id, ...))
    members = create_model("MemberSlots", __base__=SlotValue,
        **{ident: (member_root | member_alias | UnresolvedSlot, ...) for ident in member_ids})
    occurrences = create_model("OccurrenceSlots", __base__=SlotValue,
        **{ident: (OccurrenceRoot | occurrence_alias | UnresolvedSlot, ...) for ident in occurrence_ids})
    correction = create_model("PartitionCorrection", __base__=SlotValue,
        member_id=(member_id, ...), represented_by_member_id=(member_id, ...),
        unsupported_claim=(StrictStr, Field(min_length=1, max_length=2500)),
        reason=(StrictStr, Field(min_length=1, max_length=6000)),
        citations=(list[CitationSelection], Field(min_length=2)))
    return create_model("CatalogNormalizationSlots", __base__=SlotValue,
        status=(Literal["complete", "needs_review"], ...), catalog_revision=(StrictInt, Field(ge=0)),
        member_slots=(members, ...), occurrence_slots=(occurrences, ...), corrections=(list[correction], ...))


def _resolve_slots(slots, target_field):
    roots = {}
    for ident in slots:
        path, seen = [], set()
        current = ident
        while current not in roots:
            if current not in slots:
                raise RequirementError("requirements_partition_reference_invalid")
            if current in seen:
                raise RequirementError("requirements_partition_cycle")
            seen.add(current)
            path.append(current)
            slot = slots[current]
            if slot["kind"] == "root":
                roots[current] = current
                break
            if slot["kind"] == "unresolved":
                roots[current] = None
                break
            current = slot[target_field]
        root = roots[current]
        if root is None and any(slots[item]["kind"] == "same_as" for item in path):
            raise RequirementError("requirements_partition_reference_invalid")
        for item in path:
            roots[item] = root
    return roots


def bind_partition_selection(selection, *, context):
    """Resolve declared edges only; never infer an equivalence or missing row."""
    raw = selection.model_dump()
    _nonblank(raw)
    members = {row["member_id"]: row for row in context["members"]}
    occurrences = {row["occurrence_id"]: row for row in context["occurrences"]}
    if (set(raw["member_slots"]) != set(members) or set(raw["occurrence_slots"]) != set(occurrences)):
        raise RequirementError("requirements_consolidation_partition_invalid")
    if raw["catalog_revision"] != context["catalog_revision"]:
        raise RequirementError("stale_catalog_revision")
    member_roots = _resolve_slots(raw["member_slots"], "member_id")
    occurrence_roots = _resolve_slots(raw["occurrence_slots"], "occurrence_id")
    # Projection handles fit the historical group-id format even when an
    # incoming member's valid source-local ID is longer. Recorded joins retain
    # the exact supplied root; this hash never decides group membership.
    groups = {ident: "capability:" + fingerprint({"root_member_id": ident})
              for ident, slot in raw["member_slots"].items() if slot["kind"] == "root"}
    capabilities, demands, unresolved = [], [], []
    for ident, slot in raw["member_slots"].items():
        if slot["kind"] == "root":
            capabilities.append({"group_id": groups[ident],
                "member_ids": [member for member in members if member_roots[member] == ident],
                **{key: slot[key] for key in ("category", "name", "definition", "reuse_requirement_id", "reason", "citations")}})
        elif slot["kind"] == "unresolved":
            unresolved.append({"member_ids": [ident], "reason": slot["reason"], "citations": slot["citations"]})
    job_roots = {}
    for ident, root in occurrence_roots.items():
        occurrence = occurrences[ident]
        capability = member_roots[occurrence["member_id"]]
        if root is None:
            slot = raw["occurrence_slots"][ident]
            unresolved.append({"member_ids": [occurrence["member_id"]],
                               "reason": slot["reason"], "citations": slot["citations"]})
            continue
        if capability is None or member_roots[occurrences[root]["member_id"]] != capability:
            raise RequirementError("requirements_demand_partition_invalid")
        key = (occurrence["job_id"], capability)
        if key in job_roots and job_roots[key] != root:
            raise RequirementError("requirements_demand_partition_invalid")
        job_roots[key] = root
    for ident, slot in raw["occurrence_slots"].items():
        if slot["kind"] != "root":
            continue
        bindings = {}
        for occurrence_id, occurrence in occurrences.items():
            if occurrence_roots[occurrence_id] == ident:
                bindings.setdefault(occurrence["job_id"], []).append(occurrence_id)
        demands.append({"group_id": groups[member_roots[occurrences[ident]["member_id"]]],
                        **{key: slot[key] for key in ("definition", "reuse_demand_fingerprint", "citations")},
                        "bindings": [{"job_id": job, "occurrence_ids": ids} for job, ids in bindings.items()]})
    corrections = []
    for correction in raw["corrections"]:
        member, target = correction["member_id"], correction["represented_by_member_id"]
        if member not in members or target not in members or member_roots[member] is None or member_roots[target] is None:
            raise RequirementError("requirements_correction_witness_invalid")
        corrections.append({"member_id": member, "retained_group_id": groups[member_roots[member]],
            "represented_by_group_id": groups[member_roots[target]],
            **{key: correction[key] for key in ("unsupported_claim", "reason", "citations")}})
    intermediate = {"status": raw["status"], "catalog_revision": raw["catalog_revision"],
                    "capabilities": capabilities, "demands": demands, "corrections": corrections, "unresolved": unresolved}
    binding = {"binder_version": PARTITION_BINDER_VERSION, "raw_selection_fingerprint": fingerprint(raw),
               "intermediate_fingerprint": fingerprint(intermediate), "member_roots": member_roots,
               "occurrence_roots": occurrence_roots, "group_roots": {handle: ident for ident, handle in groups.items()}}
    return intermediate, binding


def partition_binding_summary(binding):
    return {key: binding[key] for key in ("binder_version", "raw_selection_fingerprint", "intermediate_fingerprint")}
