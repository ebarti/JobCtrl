"""Literal source/receipt guards for complete maintained-wording publications."""

from __future__ import annotations

from jobctrl.app.errors import ConflictError

from .coverage import variant_fingerprint
from .sources import fingerprint, qualification_fingerprint, wording_eligible


def validate_selection(assignments, previous, provenance, read, profile):
    if provenance.get("kind") == "model_group":
        _model_selection(assignments, provenance, read, profile)
    elif provenance.get("kind") == "literal_revalidation":
        _literal_revalidation(assignments, previous, provenance, read)
    else:
        raise ConflictError("Grouped wording selection requires its recorded determination or exact revalidation lineage.")


def _model_selection(assignments, provenance, read, profile):
    record = read.wording_group_decision(provenance.get("group_key", ""))
    if (record is None or record["profile_id"] != profile["profile_id"]
            or provenance.get("receipt_id") != record["provenance"]["receipt_id"]
            or provenance.get("decision") != record["decision"]
            or provenance.get("input_fingerprint") != fingerprint(record["requirements"])):
        raise ConflictError("The maintained-wording selection does not match its recorded group determination.")
    owner = record["achievement_id"]
    if any(row["achievement_id"] != owner for row in assignments):
        raise ConflictError("The grouped selection changed its achievement.")
    bindings = {row["requirement_id"]: row for row in record["requirements"]}
    supported = {}
    for meaning in read.catalog_snapshot()["requirements"]:
        assessment = read.latest_assessment(profile["profile_id"], meaning["requirement_id"], meaning["revision"], source_fingerprint=qualification_fingerprint(profile, meaning))
        if assessment is not None and wording_eligible(assessment) and assessment["kind"] in {"matched", "transferable"} and owner in assessment["achievement_ids"]:
            supported[meaning["requirement_id"]] = (meaning, assessment)
    if set(bindings) != set(supported):
        raise ConflictError("The grouped determination must include the complete currently supported requirement set.")
    for ident, binding in bindings.items():
        meaning, assessment = supported[ident]
        if (str(binding["requirement_revision"]) != str(meaning["revision"])
                or binding["qualification_determination_id"] != assessment["determination_id"]
                or any(binding[key] != meaning[key] for key in ("definition", "category", "name"))):
            raise ConflictError("A grouped requirement or its qualification changed.")
    approved = [row for row in profile["approved_variants"] if row["achievement_id"] == owner]
    expected_variants = {(row["variant_id"], str(row["revision"]), variant_fingerprint(row)) for row in approved}
    recorded_variants = {(row["variant_id"], str(row["revision"]), row["fingerprint"]) for row in record["approved_variant_fingerprints"]}
    if expected_variants != recorded_variants:
        raise ConflictError("The complete approved-wording inventory changed after the grouped determination.")
    decision = record["decision"]
    selected = ({ident: decision["reusable_variant_id"] for ident in bindings} if decision["action"] == "reuse_approved"
                else {row["requirement_id"]: row["variant_id"] for row in decision.get("selected_relations", [])})
    if {(row["requirement_id"], row["variant_id"]) for row in assignments} != set(selected.items()):
        raise ConflictError("The maintained wording differs from the exact recorded group selection.")
    if len(set(selected.values())) > 1 and not decision.get("distinct_wording_rationale"):
        raise ConflictError("Distinct maintained wordings require a source-bound consolidation exception.")


def _literal_revalidation(assignments, previous, provenance, read):
    active = {pair: row for pair, row in previous.items() if row["state"] == "active"}
    if {(row["achievement_id"], row["requirement_id"]) for row in assignments} != set(active):
        raise ConflictError("Literal revalidation cannot add or remove maintained requirements.")
    revisions = {(row["assignment_id"], row["revision"]) for row in active.values()}
    recorded_revisions = {(row["assignment_id"], row["revision"]) for row in provenance.get("previous_assignment_revisions", [])}
    authorities = {}
    for row in active.values():
        retained = row["selection_provenance"]
        if retained.get("kind") == "literal_revalidation":
            authorities.update(retained["selection_authorities"])
        else:
            authorities[row["assignment_id"]] = retained
    if revisions != recorded_revisions or authorities != provenance.get("selection_authorities"):
        raise ConflictError("The prior maintained selection authority changed before literal revalidation.")
    stable = ("profile_id", "achievement_id", "requirement_id", "requirement_revision", "variant_id", "variant_revision", "approval_id")
    changed = []
    for row in assignments:
        before = active[(row["achievement_id"], row["requirement_id"])]
        if any(str(row[key]) != str(before[key]) for key in stable):
            raise ConflictError("Literal revalidation cannot select different wording or meaning.")
        if row["relation_id"] == before["relation_id"]:
            continue
        history = {item["relation_id"]: item for item in read.prior_coverage(row["profile_id"], row["requirement_id"],
                    row["requirement_revision"], row["variant_id"], row["variant_revision"])}
        ancestor, cursor = history.get(before["relation_id"]), history.get(row["relation_id"])
        visited = set()
        while cursor is not None and cursor["relation_id"] != before["relation_id"]:
            if (ancestor is None or cursor["relation_id"] in visited or not cursor["covered"]
                    or any(str(cursor[key]) != str(ancestor[key]) for key in (*stable, "variant_fingerprint", "qualification_determination_id"))):
                raise ConflictError("The exact positive coverage revalidation lineage cannot be verified.")
            visited.add(cursor["relation_id"])
            cursor = history.get(cursor.get("revalidated_from"))
        if ancestor is None or cursor is None:
            raise ConflictError("The exact positive coverage ancestor is unavailable.")
        changed.append({"requirement_id": row["requirement_id"], "previous_relation_id": before["relation_id"],
                        "relation_id": row["relation_id"], "qualification_determination_id": ancestor["qualification_determination_id"]})
    def key(item):
        return item["requirement_id"]
    if not changed or sorted(changed, key=key) != sorted(provenance.get("revalidations", []), key=key):
        raise ConflictError("Literal revalidation must retain the exact coverage lineage inventory.")
