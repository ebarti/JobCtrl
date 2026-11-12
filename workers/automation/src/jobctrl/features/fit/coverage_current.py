"""Literal maintained-wording pins and complete achievement-group publication."""

from __future__ import annotations

from jobctrl.app.errors import ConflictError

from .coverage_groups import owned_support
from .sources import fingerprint


def expand_groups(read, profile, groups, inventory, source_hash):
    """Join accepted catalog IDs, including supported bindings outside this job."""
    catalog = read.catalog_snapshot()
    meanings = {row["requirement_id"]: {**row, "requirement_revision": row["revision"]}
                for row in catalog["requirements"]}
    heads = read.current_wordings(profile["profile_id"], achievement_ids=list(groups))
    for head in heads:
        if head["requirement_id"] not in meanings:
            raise ConflictError("A maintained wording's canonical requirement is unavailable.")
    for ident, entries in groups.items():
        indexed = {row["requirement_id"]: (row, assessment) for row, assessment in entries}
        retained = {row["requirement_id"] for row in heads if row["achievement_id"] == ident}
        for requirement_id, requirement in meanings.items():
            if requirement_id in indexed:
                continue
            assessment = read.latest_assessment(profile["profile_id"], requirement_id,
                requirement["requirement_revision"], source_fingerprint=source_hash)
            if assessment is None:
                if requirement_id in retained:
                    raise ConflictError("A maintained wording needs current qualification before grouped refresh.")
                continue
            if (assessment["kind"] in {"matched", "transferable"} and ident in assessment["achievement_ids"]
                    and owned_support(inventory[ident], assessment)):
                indexed[requirement_id] = (requirement, assessment)
        groups[ident] = list(indexed.values())
    return catalog, heads


def replacement_bindings(variant):
    provenance = variant.get("provenance", {})
    replacements = provenance.get("replaces_variant_ids", [])
    if provenance.get("replaces_variant_id"):
        replacements = [*replacements, {"variant_id": provenance["replaces_variant_id"],
                                       "variant_revision": provenance.get("replaces_variant_revision")}]
    return {(row["variant_id"], str(row["variant_revision"])) for row in replacements}


def pending_replacements(variants, heads):
    maintained = {(row["variant_id"], str(row["variant_revision"])) for row in heads}
    requirements = {row["requirement_id"] for row in heads}
    return [row for row in variants if (replacement_bindings(row).intersection(maintained)
            or requirements.intersection(row.get("provenance", {}).get("intended_requirement_ids", [])))
            and (row["variant_id"], str(row["revision"])) not in maintained]


def current_mapping(entries, variants, relations, heads):
    """Exact IDs only. Approval or coverage alone never elects an alternative."""
    by_requirement = {row["requirement_id"]: row for row in heads}
    if len(by_requirement) != len(heads):
        return False
    approved = {row["variant_id"]: row for row in variants}
    for requirement, _ in entries:
        head = by_requirement.get(requirement["requirement_id"])
        variant = approved.get(head["variant_id"]) if head else None
        relation = relations.get((requirement["requirement_id"], head["variant_id"])) if head else None
        if (variant is None or relation is None or not relation["covered"]
                or str(head["requirement_revision"]) != str(requirement["requirement_revision"])
                or str(head["variant_revision"]) != str(variant["revision"])
                or head["approval_id"] != variant["approval_id"] or head["relation_id"] != relation["relation_id"]):
            return False
    if set(by_requirement) != {row["requirement_id"] for row, _ in entries}:
        return False
    if len({row["variant_id"] for row in heads}) > 1:
        # Separate exact user choices cannot authorize unnecessary alternatives.
        # Reuse requires the persisted source-bound consolidation exception.
        for row in heads:
            provenance = row.get("selection_provenance", {})
            if not (
                    provenance.get("distinct_wording_rationale")
                    or provenance.get("decision", {}).get("distinct_wording_rationale")):
                return False
    return not pending_replacements(variants, heads)


def rebind_mapping(coverage, *, profile, entries, variants, relations, heads, profile_snapshot,
                   requirements_snapshot, achievement_id, expected_fingerprint, cancelled, operation):
    """Follow literal revalidation ancestors; this preserves a recorded choice."""
    rebound, changed = [], []
    stable = ("profile_id", "requirement_id", "requirement_revision", "achievement_id", "variant_id",
              "variant_revision", "approval_id", "variant_fingerprint", "qualification_determination_id")
    for head in heads:
        relation = relations.get((head["requirement_id"], head["variant_id"]))
        if relation is None or relation["relation_id"] == head["relation_id"]:
            rebound.append(head)
            continue
        history = {row["relation_id"]: row for row in coverage.store.prior_coverage(
            profile["profile_id"], head["requirement_id"], head["requirement_revision"],
            head["variant_id"], head["variant_revision"])}
        ancestor = history.get(head["relation_id"])
        if ancestor is None:
            return False
        cursor, seen = relation, set()
        while cursor["relation_id"] != head["relation_id"]:
            if (cursor["relation_id"] in seen or not cursor.get("covered")
                    or any(str(cursor[key]) != str(ancestor[key]) for key in stable)):
                return False
            seen.add(cursor["relation_id"])
            cursor = history.get(cursor.get("revalidated_from"))
            if cursor is None:
                return False
        changed.append({"requirement_id": head["requirement_id"], "previous_relation_id": head["relation_id"],
                        "relation_id": relation["relation_id"],
                        "qualification_determination_id": relation["qualification_determination_id"]})
        rebound.append({**head, "relation_id": relation["relation_id"]})
    if not changed or not current_mapping(entries, variants, relations, rebound):
        return False
    authorities = {}
    for row in heads:
        retained = row["selection_provenance"]
        if retained.get("kind") == "literal_revalidation":
            authorities.update(retained["selection_authorities"])
        else:
            authorities[row["assignment_id"]] = retained
    provenance = {"kind": "literal_revalidation", "group_key": "fit-wording-revalidation-" + fingerprint(changed),
        "operation_id": operation.operation_id if operation is not None else None,
        "previous_assignment_revisions": [{"assignment_id": row["assignment_id"], "revision": row["revision"]} for row in heads],
        "selection_authorities": authorities,
        "revalidations": changed,
        "distinct_wording_rationale": next((row["selection_provenance"].get("distinct_wording_rationale")
            or row["selection_provenance"].get("decision", {}).get("distinct_wording_rationale")
            for row in heads if row["selection_provenance"].get("distinct_wording_rationale")
            or row["selection_provenance"].get("decision", {}).get("distinct_wording_rationale")), None)}
    coverage._check_cancelled(cancelled, operation)
    coverage.store.publish_current_wordings([{key: row[key] for key in (
        "profile_id", "achievement_id", "requirement_id", "requirement_revision", "variant_id",
        "variant_revision", "approval_id", "relation_id")} for row in rebound],
        expected_assignments_fingerprint=expected_fingerprint, profile_snapshot=profile_snapshot,
        requirements_snapshot=requirements_snapshot, selection_provenance=provenance,
        achievement_ids=[achievement_id], cancelled=cancelled)
    return True


def publish_selection(coverage, *, result, record, profile, profile_snapshot, requirements_snapshot,
                      achievement_id, entries, variants, heads, expected_fingerprint, cancelled, operation=None):
    if result.action == "propose_consolidation":
        # A proposed merge is not authority to install an unnecessary temporary
        # set of alternatives. Keep the exact prior heads (or baseline fallback).
        return False
    selections = ({row["requirement_id"]: result.reusable_variant_id for row, _ in entries}
                  if result.action == "reuse_approved" else
                  {row.requirement_id: row.variant_id for row in result.selected_relations})
    by_variant = {row["variant_id"]: row for row in variants}
    selected = []
    for requirement, assessment in entries:
        variant_id = selections.get(requirement["requirement_id"])
        if variant_id is None:
            continue
        variant = by_variant[variant_id]
        relation = coverage.store.coverage(profile["profile_id"], requirement["requirement_id"],
            requirement["requirement_revision"], assessment["assessment_id"], variant_id, variant["revision"])
        if relation is None or not relation["covered"]:
            raise ConflictError("The maintained wording selection has no exact positive coverage receipt.")
        selected.append({key: relation[key] for key in ("profile_id", "achievement_id", "requirement_id",
            "requirement_revision", "variant_id", "variant_revision", "approval_id", "relation_id")})

    # An approved revision is a proposal until every prior replacement binding
    # and every intended requirement has positive coverage under that SAME text.
    selected_pairs = {(row["requirement_id"], row["variant_id"]) for row in selected}
    for variant in pending_replacements(variants, heads):
        if not any(row["variant_id"] == variant["variant_id"] for row in selected):
            continue
        replaced = replacement_bindings(variant)
        required = {row["requirement_id"] for row in heads
                    if (row["variant_id"], str(row["variant_revision"])) in replaced}
        required.update(variant.get("provenance", {}).get("intended_requirement_ids", []))
        if not required or any((ident, variant["variant_id"]) not in selected_pairs for ident in required):
            return False
    if not selected and not heads:
        return False
    coverage._check_cancelled(cancelled, operation)
    coverage.store.publish_current_wordings(selected, expected_assignments_fingerprint=expected_fingerprint,
        profile_snapshot=profile_snapshot, requirements_snapshot=requirements_snapshot,
        achievement_ids=[achievement_id], cancelled=cancelled,
        selection_provenance={"kind": "model_group", "group_key": record["group_key"],
            "receipt_id": record["provenance"]["receipt_id"],
            "operation_id": operation.operation_id if operation is not None else None,
            "distinct_wording_rationale": result.distinct_wording_rationale,
            "decision": result.model_dump(), "provenance": record["provenance"],
            "input_fingerprint": fingerprint(record["requirements"])})
    return True
