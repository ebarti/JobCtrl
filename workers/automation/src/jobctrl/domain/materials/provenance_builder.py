"""Bind generation-time anchors to the exact lines the resume renders."""

from jobctrl.domain.materials.claim_grounding import bullet_id_for_claim_location
from jobctrl.domain.materials.provenance import BulletProvenance
from jobctrl.domain.materials.value_objects import TransformType, ControlRule
from jobctrl.domain.materials.resume_document import build_resume_document, contact_items_text


class ProvenanceBindingError(ValueError):
    def __init__(self, kind, bad_ids):
        super().__init__(f"invalid_provenance_{kind}_binding")


def rendered_lines(profile, payload):
    """Project every factual rendered surface from the renderer's canonical document."""
    document = build_resume_document(payload, profile)
    lines = []

    def add(ident, section, source_id, text):
        if text.strip():
            lines.append((ident, section, source_id, text))

    personal = document["personal"]
    add("personal:full_name", "personal", "personal:full_name", personal["full_name"])
    add("personal:address", "personal", "personal:address", personal["address"])
    add("personal:contact", "personal", "personal:contact", contact_items_text(personal["contact_items"]))
    add("executive_profile#0", "executive_profile", "executive_profile", document["summary"])
    for entry in document["experience"]:
        ident = entry["id"]
        for field in ("company", "location", "title", "date_range"):
            add(f"experience:{ident}:{field}", "experience", ident, entry[field])
        add(f"experience:{ident}:summary", "experience", ident, entry["summary"])
        for bullet in entry["bullets"]:
            add(bullet["id"], "experience", ident, bullet["text"])
    for entry in document["education"]:
        ident = entry["id"]
        for field in ("institution", "location", "date"):
            add(f"education:{ident}:{field}", "education", ident, entry[field])
        add(f"education:{ident}:degree", "education", ident, entry["degree"])
        add(f"education:{ident}:details", "education", ident, entry["details"])
    for category in document["skills"]:
        if category["items"]:
            add(
                f"skills:{category['id']}#0",
                "skills",
                category["id"],
                category["label"] + ": " + ", ".join(category["items"]),
            )
    return lines


def build_bullet_provenance(profile, tailored_payload, plan, analysis):
    evidence = set(plan.evidence_by_id)
    requirements = {row.id for row in analysis.canonical.requirements}
    anchors = {}
    for mapping in tailored_payload.get("generated_claim_mappings", []):
        ident = mapping["line_id"]
        if bullet_id_for_claim_location(mapping["location"]) != ident:
            raise ProvenanceBindingError("line", ())
        if set(mapping["evidence_ids"]) - evidence:
            raise ProvenanceBindingError("evidence", ())
        if set(mapping["requirement_ids"]) - requirements:
            raise ProvenanceBindingError("requirement", ())
        anchors.setdefault(ident, []).append(mapping)
    rendered = rendered_lines(profile, tailored_payload)
    if set(anchors) - {row[0] for row in rendered}:
        raise ProvenanceBindingError("line", ())
    rows = []
    for ident, section, source_id, text in rendered:
        mapped = anchors.get(ident, [])
        rows.append(
            BulletProvenance(
                bullet_id=ident,
                section=section,
                source_id=source_id,
                evidence_ids=tuple(dict.fromkeys(item for mapping in mapped for item in mapping["evidence_ids"])),
                requirement_ids=tuple(dict.fromkeys(item for mapping in mapped for item in mapping["requirement_ids"])),
                matched_keywords=(),
                transform_type=TransformType(mapped[0]["transform_type"]) if mapped else TransformType.UNRECORDED,
                control=ControlRule.CLAIM_VERIFICATION,
                rationale="\n".join(mapping["reason"] for mapping in mapped) if mapped else "No recorded source",
                generated_text=text,
            )
        )
    return tuple(rows)
