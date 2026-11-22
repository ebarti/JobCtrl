"""Explicit source selections for the demand slots of new table comparisons."""

from collections import defaultdict
from copy import deepcopy
import json

from .domain import RequirementError


DEMAND_CHOICE_PROMPT = "requirements-capability-demand-partition-v10-demand-choices"
CITED_OCCURRENCE_PROMPT = "requirements-capability-demand-partition-v11-cited-occurrences"
CITED_OCCURRENCE_INSTRUCTION = (
    "Assign each member to one offered capability_group_id or mark it unresolved. In each occurrence slot choose cited or unresolved. "
    "Assign a cited occurrence by selecting its own source_id and an offered segment in exactly one demand group's citations. "
    "These explicit source selections are your occurrence-to-demand assignments. Multiple segments of one occurrence may support "
    "the same demand. Inventory and posting citations supply additional evidence and cannot assign an occurrence. "
    "Within each job, cite every occurrence of the same capability in the same demand group. Across jobs, cite occurrences "
    "together only when the full demand is shared. Each demand must have at least one original occurrence."
)
DEMAND_SLOT_INSTRUCTION = "Every used demand group chooses keep, select or author and cites the inventory and EVERY assigned occurrence."
DEMAND_REUSE_INSTRUCTION = """Choose the complete demand from the actual evidence and keep every material constraint. Use kind keep when the assigned occurrences have one distinct non-null prior_demand_source_id and that exact demand applies to ALL of them, including newly assigned occurrences. Keep selects that frozen definition directly. If there are no prior sources or several distinct ones, keep is unavailable. Use kind select with exactly one offered context.accepted_demands.source_id when its exact definition applies to all assigned occurrences and its group_member_ids include a member assigned to this capability. This also supports a source-established demand shared across jobs. Both choices require the original demand's category. Read the offered definition, members and original occurrence evidence before choosing. If the demand is new, changed or newly combined, use kind author and give its complete definition. Return needs_review for uncertainty. Never choose a prior reference merely for a similar topic. The owner preserves the exact definition and fingerprint selected by keep or select."""
DEMAND_REFERENCE_INSTRUCTION = "The accepted_demands references identify the exact frozen definitions available for keep and select; original demand evidence is still required for all choices."


def _occurrence_reference(occurrence, sources, references, normalization_version):
    previous = json.loads(sources[occurrence["source_id"]])["normalized_demand"]
    if not previous or previous["normalization_version"] != normalization_version:
        return None
    reference = references.get(previous["demand_fingerprint"])
    if reference is None:
        raise RequirementError("catalog_snapshot_invalid")
    return reference


def add_demand_choice_context(context, sources, normalization_version):
    """Expose each accepted definition, and its relationship to a recorded occurrence, in place."""
    references = {}
    for record in context["accepted_demands"]:
        previous = json.loads(sources[record["source_id"]])
        signature = record["demand_fingerprint"]
        if previous["demand_fingerprint"] != signature or signature in references:
            raise RequirementError("catalog_snapshot_invalid")
        record["definition"] = previous["definition"]
        references[signature] = record["source_id"]
    for occurrence in context["occurrences"]:
        occurrence["prior_demand_source_id"] = _occurrence_reference(occurrence, sources, references, normalization_version)


def _bind_cited_occurrences(raw, context):
    occurrences = {row["source_id"]: row["occurrence_id"] for row in context["occurrences"]}
    if len(occurrences) != len(context["occurrences"]):
        raise RequirementError("catalog_snapshot_invalid")
    owners = {}
    for handle, demand in raw["demand_groups"].items():
        if demand is None:
            continue
        for citation in demand["citations"]:
            occurrence = occurrences.get(citation["source_id"])
            if occurrence is None:
                continue
            if owners.setdefault(occurrence, handle) != handle:
                raise RequirementError("requirements_demand_source_invalid")
    if set(owners) != set(raw["occurrence_slots"]):
        raise RequirementError("missing_source_citation")
    for occurrence, handle in owners.items():
        raw["occurrence_slots"][occurrence] = {"kind": "assigned", "demand_group_id": handle}


def expand_demand_choices(selection, context, sources, *, cited_occurrences=False):
    """Bind only the selected records. Authored definitions never acquire a reuse claim."""
    raw = deepcopy(selection)
    if raw["status"] != "complete" or any(slot["kind"] == "unresolved"
            for slots in (raw["member_slots"], raw["occurrence_slots"]) for slot in slots.values()):
        raise RequirementError("requirements_consolidation_uncertain")
    if cited_occurrences:
        _bind_cited_occurrences(raw, context)
    accepted = {row["source_id"]: row for row in context["accepted_demands"]}
    references = {row["demand_fingerprint"]: row["source_id"] for row in accepted.values()}
    prior_sources = defaultdict(set)
    for occurrence in context["occurrences"]:
        reference = _occurrence_reference(occurrence, sources, references, context["normalization_version"])
        if reference != occurrence["prior_demand_source_id"]:
            raise RequirementError("catalog_snapshot_invalid")
        if reference is not None:
            assigned = raw["occurrence_slots"][occurrence["occurrence_id"]]["demand_group_id"]
            prior_sources[assigned].add(reference)
    for handle, choice in raw["demand_groups"].items():
        if choice is None:
            continue
        if choice["kind"] == "author":
            choice.update(kind="group", reuse_demand_fingerprint=None)
            continue
        if choice["kind"] == "keep":
            candidates = prior_sources[handle]
            if len(candidates) != 1:
                raise RequirementError("requirements_demand_reuse_invalid")
            reference, = candidates
        else:
            reference = choice.pop("prior_demand_source_id")
        record = accepted.get(reference)
        if record is None:
            raise RequirementError("requirements_demand_reuse_invalid")
        source = json.loads(sources[reference])
        if source["demand_fingerprint"] != record["demand_fingerprint"] or source["definition"] != record["definition"]:
            raise RequirementError("requirements_demand_reuse_invalid")
        choice.update(kind="group", definition=source["definition"], reuse_demand_fingerprint=record["demand_fingerprint"])
    return raw
