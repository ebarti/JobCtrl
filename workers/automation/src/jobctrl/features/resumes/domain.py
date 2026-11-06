"""Exact arithmetic over recorded IDs. No prose matching or qualification judgment."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any


class ResumeError(ValueError):
    def __init__(self, code: str, message: str | None = None, *, details: dict | None = None):
        self.code = code
        self.details = details
        super().__init__(message or code)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return sha256(canonical(value).encode()).hexdigest()


def dto(value: Any) -> dict:
    if hasattr(value, "to_dict"):
        return deepcopy(value.to_dict())
    if hasattr(value, "as_dict"):
        return deepcopy(value.as_dict())
    if isinstance(value, dict):
        return deepcopy(value)
    raise ResumeError("invalid_public_snapshot")


def variants_for(snapshot: dict) -> tuple[list[dict], dict[str, list[dict]]]:
    """Validate the complete authored inventory and exact approved alternatives."""
    achievements = []
    roles = snapshot.get("roles", [])
    role_ids = [row["role_id"] for row in roles]
    if len(role_ids) != len(set(role_ids)):
        raise ResumeError("duplicate_role_id")
    for role in roles:
        for achievement in role.get("achievements", []):
            achievements.append({**achievement, "role_id": role["role_id"]})
    ids = [row["achievement_id"] for row in achievements]
    if len(ids) != len(set(ids)):
        raise ResumeError("duplicate_achievement_id")
    options = {key: [] for key in ids}
    identities = set()
    for variant in snapshot.get("approved_variants", []):
        identity = (variant["variant_id"], variant["revision"])
        if identity in identities:
            raise ResumeError("duplicate_approved_variant")
        identities.add(identity)
        if (variant.get("achievement_id") not in options or not variant.get("approval_id")
                or not variant.get("source_refs") or not isinstance(variant.get("text"), str)
                or not variant["text"].strip()):
            raise ResumeError("invalid_approved_variant")
        options[variant["achievement_id"]].append(deepcopy(variant))
    for achievement in achievements:
        key = achievement["achievement_id"]
        if not options[key]:
            raise ResumeError("achievement_has_no_approved_variant")
        options[key].sort(key=lambda row: (row["variant_id"], str(row["revision"])))
    return achievements, options


def _requirements(coverage: dict) -> list[dict]:
    by_id = {}
    for requirement in coverage.get("requirements", []):
        identity = (requirement["requirement_id"], requirement.get("revision", requirement.get("requirement_revision")))
        if identity[1] is None:
            raise ResumeError("invalid_requirement_inventory")
        try:
            weight = Decimal(str(requirement["weight"]))
        except (KeyError, InvalidOperation, ValueError):
            raise ResumeError("invalid_requirement_weight") from None
        if not weight.is_finite() or weight <= 0:
            raise ResumeError("invalid_requirement_weight")
        previous = by_id.get(identity[0])
        if previous is not None and previous["revision"] != identity[1]:
            raise ResumeError("invalid_requirement_inventory")
        if previous is None or weight > Decimal(previous["weight"]):
            by_id[identity[0]] = {"requirement_id": identity[0], "revision": identity[1], "weight": str(weight)}
    return sorted(by_id.values(), key=lambda row: (row["requirement_id"], str(row["revision"])))


def _relations(coverage: dict, requirements: list[dict], options: dict[str, list[dict]]) -> dict[tuple, list[dict]]:
    requirement_ids = {(row["requirement_id"], row["revision"]) for row in requirements}
    variant_ids = {(row["achievement_id"], row["variant_id"], row["revision"])
                   for variants in options.values() for row in variants}
    result: dict[tuple, list[dict]] = {}
    seen = set()
    for row in coverage.get("relations", []):
        if row.get("covered") is not True:
            continue
        requirement = (row["requirement_id"], row.get("requirement_revision", row.get("revision")))
        variant = (row["achievement_id"], row["variant_id"], row.get("variant_revision", row.get("revision")))
        if (requirement not in requirement_ids or variant not in variant_ids
                or not row.get("determination_id") or not row.get("source_refs")):
            raise ResumeError("stale_or_unbound_coverage_relation")
        identity = (*requirement, *variant)
        if identity in seen:
            if not any(existing == row for existing in result.get(variant, [])):
                raise ResumeError("duplicate_coverage_relation")
            continue
        seen.add(identity)
        result.setdefault(variant, []).append({**deepcopy(row), "requirement_revision": requirement[1],
                                               "variant_revision": variant[2]})
    return result


@dataclass(frozen=True)
class CompositionLimits:
    max_states: int = 50_000
    max_paths: int = 200_000
    max_transitions: int = 1_000_000


@dataclass(slots=True)
class _Path:
    supports: Decimal
    previous: _Path | None
    variant: dict | None
    order: tuple[int, int]
    rank: int = 0


def choose_variants(snapshot: dict, coverage: dict, *, baseline: bool = False,
                    cancelled=lambda: False, limits: CompositionLimits | None = None) -> tuple[list[dict], dict]:
    """Exact multiple-choice maximum coverage, then complementary achievement depth.

    Independent achievement/requirement components have additive objectives.
    Requirements unconditionally covered by some achievement do not couple
    choices; their additional achievement supports still contribute to depth.
    Each component uses exact union-state DP with ranked backpointers. Finite
    structural work admission refuses irreducible cases rather than returning
    an approximation. No beam, semantic heuristic, brevity or omission exists.
    """
    achievements, options = variants_for(snapshot)
    if baseline:
        chosen = []
        for item in achievements:
            variant = next((row for row in options[item["achievement_id"]]
                            if row["variant_id"] == item["baseline_variant_id"]), None)
            if variant is None:
                raise ResumeError("baseline_wording_not_approved")
            chosen.append(variant)
        return deepcopy(chosen), {"status": "not_assessed", "reason": "resume_tailoring_disabled",
                                  "requirements": [], "selected_relations": [], "objective": None}
    if coverage.get("profile_revision") != snapshot["profile_revision"]:
        raise ResumeError("coverage_profile_revision_changed")
    if coverage.get("status") in {"stale", "invalid", "failed"}:
        raise ResumeError("coverage_snapshot_not_current")
    requirements = _requirements(coverage)
    relations = _relations(coverage, requirements, options)
    indexes = {(row["requirement_id"], row["revision"]): index for index, row in enumerate(requirements)}
    weights = [Decimal(row["weight"]) for row in requirements]
    masks = {}
    for key, rows in relations.items():
        masks[key] = sum(1 << indexes[(row["requirement_id"], row["requirement_revision"])] for row in rows)

    weight_cache = {0: Decimal(0)}

    def value(mask: int) -> Decimal:
        cached = weight_cache.get(mask)
        if cached is not None:
            return cached
        total = Decimal(0)
        remaining = mask
        while remaining:
            bit = remaining & -remaining
            total += weights[bit.bit_length() - 1]
            remaining ^= bit
        weight_cache[mask] = total
        return total

    limits = limits or CompositionLimits()
    work = {"transitions": 0, "paths": 0, "peak_states": 0, "components": 0,
            "largest_component_achievements": 0, "largest_component_requirements": 0}

    def admit(kind, observed, maximum):
        if kind == "transitions" and cancelled():
            raise ResumeError("resume_action_cancelled")
        if observed > maximum:
            raise ResumeError("composition_resource_limit",
                              "Exact composition exceeded its finite work budget; the accepted resume is preserved.",
                              details={"resource": kind, "observed": observed, "limit": maximum,
                                       "work": dict(work), "approximate_result_returned": False})

    # Exact identical coverage alternatives have identical objectives. Keep the
    # stable-ID winner before building the choice graph; no prose is compared.
    choices = []
    guaranteed = 0
    for achievement in achievements:
        by_mask = {}
        for variant in options[achievement["achievement_id"]]:
            identity = (variant["achievement_id"], variant["variant_id"], variant["revision"])
            mask = masks.get(identity, 0)
            by_mask.setdefault(mask, variant)
        rows = [(mask, row, value(mask)) for mask, row in by_mask.items()]
        intersection = rows[0][0]
        for mask, _, _ in rows[1:]:
            intersection &= mask
        guaranteed |= intersection
        choices.append(rows)

    parent = list(range(len(achievements) + len(requirements)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(left, right):
        left, right = root(left), root(right)
        if left != right:
            parent[max(left, right)] = min(left, right)

    for index, rows in enumerate(choices):
        variable = 0
        for mask, _, _ in rows:
            variable |= mask & ~guaranteed
        while variable:
            bit = variable & -variable
            join(index, len(achievements) + bit.bit_length() - 1)
            variable ^= bit
    components = {}
    for index in range(len(achievements)):
        components.setdefault(root(index), []).append(index)
    selected_by_achievement = {}
    for indexes_in_component in sorted(components.values(), key=lambda indexes: indexes[0]):
        work["components"] += 1
        work["largest_component_achievements"] = max(work["largest_component_achievements"], len(indexes_in_component))
        component_mask = 0
        for index in indexes_in_component:
            for mask, _, _ in choices[index]:
                component_mask |= mask & ~guaranteed
        work["largest_component_requirements"] = max(work["largest_component_requirements"], component_mask.bit_count())
        states = {0: _Path(Decimal(0), None, None, (0, 0))}
        for index in indexes_in_component:
            admit("transitions", work["transitions"], limits.max_transitions)
            # Once guaranteed coverage is factored out, equal variable masks may
            # have different depth. Keep maximum full support, then stable ID.
            local_choices = {}
            for order, (mask, variant, supports) in enumerate(choices[index]):
                local_mask = mask & ~guaranteed
                previous = local_choices.get(local_mask)
                if previous is None or supports > previous[2]:
                    local_choices[local_mask] = (order, variant, supports)
            next_states = {}
            for union, previous_path in states.items():
                for mask, (order, variant, supports) in local_choices.items():
                    work["transitions"] += 1
                    if work["transitions"] > limits.max_transitions or work["transitions"] % 1024 == 0:
                        admit("transitions", work["transitions"], limits.max_transitions)
                    new_union = union | mask
                    total = previous_path.supports + supports
                    stable = (previous_path.rank, order)
                    previous = next_states.get(new_union)
                    if previous is not None and (previous.supports > total or
                                                 (previous.supports == total and previous.order <= stable)):
                        continue
                    if previous is None:
                        admit("states", len(next_states) + 1, limits.max_states)
                    work["paths"] += 1
                    admit("paths", work["paths"], limits.max_paths)
                    next_states[new_union] = _Path(total, previous_path, variant, stable)
                    work["peak_states"] = max(work["peak_states"], len(next_states))
            work["peak_states"] = max(work["peak_states"], len(next_states))
            for rank, path in enumerate(sorted(next_states.values(), key=lambda path: path.order)):
                path.rank = rank
            states = next_states
        _, path = min(states.items(), key=lambda item: (-value(item[0]), -item[1].supports, item[1].rank))
        for index in reversed(indexes_in_component):
            selected_by_achievement[index] = path.variant
            path = path.previous
    selected = deepcopy([selected_by_achievement[index] for index in range(len(achievements))])
    union = 0
    supports = Decimal(0)
    for variant in selected:
        mask = masks.get((variant["achievement_id"], variant["variant_id"], variant["revision"]), 0)
        union |= mask
        supports += value(mask)
    manifest = coverage_manifest(snapshot, coverage, selected, requirements=requirements, relations=relations)
    manifest["objective"] = {"weighted_distinct_coverage": str(value(union)),
                             "weighted_complementary_depth": str(supports - value(union)),
                             "tie_break": "ordered_variant_id_and_revision",
                             "algorithm": "exact_independent_components_union_dynamic_program_v2",
                             "work": work, "limits": {"states": limits.max_states, "paths": limits.max_paths,
                                                       "transitions": limits.max_transitions}}
    return selected, manifest


def coverage_manifest(snapshot: dict, coverage: dict, selected: list[dict], *, requirements=None, relations=None) -> dict:
    if requirements is None:
        requirements = _requirements(coverage)
    if relations is None:
        _, options = variants_for(snapshot)
        relations = _relations(coverage, requirements, options)
    selected_relations = [row for variant in selected for row in relations.get(
        (variant["achievement_id"], variant["variant_id"], variant["revision"]), [])]
    rows = []
    for requirement in requirements:
        supporting = [row for row in selected_relations if row["requirement_id"] == requirement["requirement_id"]]
        rows.append({**requirement, "covered": bool(supporting),
                     "achievement_ids": sorted({row["achievement_id"] for row in supporting}),
                     "variant_ids": sorted({row["variant_id"] for row in supporting}),
                     "determination_ids": sorted({row["determination_id"] for row in supporting})})
    return {"status": "recorded", "coverage_snapshot_id": coverage.get("snapshot_id"),
            "profile_revision": snapshot["profile_revision"], "requirements": rows,
            "selected_relations": deepcopy(selected_relations), "objective": None,
            "qualification": "Person fit is owned by Fit and is unchanged by document coverage."}


def _document_roles(document: dict) -> list[dict]:
    return document.get("experience", document.get("roles", []))


def baseline_document(snapshot: dict) -> dict:
    """Project all authored resume fields, never profile tailoring selections/caps."""
    raw = snapshot["document"]
    if "resume" not in raw and "resume_master" not in raw and isinstance(raw.get("experience"), list):
        return deepcopy(raw)
    resume = raw.get("resume", raw.get("resume_master", {}))
    personal = raw.get("personal", {})
    address = ", ".join(str(personal[key]) for key in ("address", "city") if personal.get(key))
    region = " ".join(str(personal[key]) for key in ("postal_code", "country") if personal.get(key))
    contacts = []
    for field, kind, prefix in (("phone", "phone", "tel:"), ("email", "email", "mailto:"),
                                 ("website_url", "website", ""), ("portfolio_url", "website", ""),
                                 ("linkedin_url", "linkedin", ""), ("github_url", "github", "")):
        value = personal.get(field)
        if isinstance(value, str) and value:
            if field == "portfolio_url" and personal.get("website_url"):
                continue
            href = prefix + value
            if not prefix and not value.startswith(("https://", "http://")):
                href = "https://" + value
            contacts.append({"kind": kind, "label": value, "href": href})
    source_entries = {row["id"]: row for row in resume.get("experience_entries", [])}
    experience = []
    for role in snapshot.get("roles", []):
        entry = source_entries.get(role["role_id"])
        if entry is None:
            raise ResumeError("baseline_role_identity_mismatch")
        experience.append({"id": role["role_id"],
                           **{field: str(entry.get(field, "")) for field in
                              ("title", "company", "location", "date_range", "summary")},
                           "bullets": [{"id": row["achievement_id"], "text": str(text)}
                                       for row, text in zip(role["achievements"], entry.get("bullets", []))]})
        if len(entry.get("bullets", [])) != len(role["achievements"]):
            raise ResumeError("baseline_achievement_inventory_mismatch")
    education = [{"id": row.get("id", f"education:{index}"),
                  **{field: str(row.get(field, "")) for field in ("degree", "institution", "location", "date", "details")}}
                 for index, row in enumerate(resume.get("education_entries", []))]
    skills = [{"id": row.get("id", f"skills:{index}"), "label": str(row.get("label", "Skills")),
               "items": deepcopy(row.get("items", []))}
              for index, row in enumerate(resume.get("skill_categories", []))]
    summary = resume.get("executive_profile", {})
    return {"personal": {"full_name": str(personal.get("full_name", personal.get("name", ""))),
                         "address": " - ".join(value for value in (address, region) if value),
                         "contact_items": contacts},
            "summary": str(summary.get("baseline_text", "")) if isinstance(summary, dict) else str(summary),
            "experience": experience, "education": education, "skills": skills,
            "section_labels": {"summary": "Executive Profile", "experience": "Experience",
                               "education": "Education", "skills": "Skills"}}


def assemble(snapshot: dict, selected: list[dict]) -> dict:
    """Copy every authored field and replace only achievement wording by ID."""
    document = baseline_document(snapshot)
    choices = {row["achievement_id"]: row for row in selected}
    source_roles = snapshot.get("roles", [])
    roles = _document_roles(document)
    if len(roles) != len(source_roles):
        raise ResumeError("baseline_role_inventory_mismatch")
    for role, source in zip(roles, source_roles):
        if role.get("id", role.get("role_id")) != source["role_id"]:
            raise ResumeError("baseline_role_identity_mismatch")
        bullets = role.get("bullets", role.get("achievements", []))
        if len(bullets) != len(source.get("achievements", [])):
            raise ResumeError("baseline_achievement_inventory_mismatch")
        replacement = []
        for bullet, achievement in zip(bullets, source.get("achievements", [])):
            choice = choices[achievement["achievement_id"]]
            original = deepcopy(bullet) if isinstance(bullet, dict) else {}
            original.update(id=achievement["achievement_id"], achievement_id=achievement["achievement_id"],
                            text=choice["text"], variant_id=choice["variant_id"],
                            variant_revision=choice["revision"], approval_id=choice["approval_id"],
                            source_refs=deepcopy(choice["source_refs"]))
            replacement.append(original)
        role["bullets" if "bullets" in role or "achievements" not in role else "achievements"] = replacement
    return document


def mechanical_check(snapshot: dict, document: dict, selected: list[dict]) -> dict:
    """Exact authority checks, including all non-wording baseline fields."""
    failures = []
    achievements, options = variants_for(snapshot)
    expected_ids = [row["achievement_id"] for row in achievements]
    selected_ids = [row.get("achievement_id") for row in selected]
    if selected_ids != expected_ids:
        failures.append("every_baseline_achievement_exactly_once_in_authored_order")
    for row in selected:
        approved = [item for item in options.get(row.get("achievement_id"), [])
                    if item["variant_id"] == row.get("variant_id") and item["revision"] == row.get("revision")]
        if len(approved) != 1 or any(row.get(field) != approved[0].get(field)
                                     for field in ("text", "approval_id", "source_refs")):
            failures.append("wording_requires_exact_current_profile_approval")
    if not failures:
        expected = assemble(snapshot, selected)
        if document != expected:
            failures.append("document_requires_exact_source_bound_approved_content")
    return {"status": "valid" if not failures else "invalid", "failures": sorted(set(failures)),
            "profile_revision": snapshot["profile_revision"], "document_sha256": digest(document),
            "role_ids": [row["role_id"] for row in snapshot.get("roles", [])],
            "achievement_ids": expected_ids,
            "selected_variant_ids": [row.get("variant_id") for row in selected]}


def compose(snapshot: dict, coverage: dict, *, mode: str = "tailored", cancelled=lambda: False,
            limits: CompositionLimits | None = None) -> dict:
    if mode not in {"tailored", "baseline_copy"}:
        raise ResumeError("unsupported_composition_mode")
    selected, manifest = choose_variants(snapshot, coverage, baseline=mode == "baseline_copy",
                                       cancelled=cancelled, limits=limits)
    document = assemble(snapshot, selected)
    if not document.get("personal", {}).get("full_name") or not document.get("experience"):
        raise ResumeError("baseline_resume_incomplete")
    return {"mode": mode, "document": document, "selected_variants": selected,
            "coverage_manifest": manifest, "mechanical": mechanical_check(snapshot, document, selected)}


def document_lines(document: dict) -> list[dict]:
    """Literal renderer projection; these IDs are also translation/review sources."""
    result = []

    def add(identity, value):
        if isinstance(value, str) and value.strip():
            result.append({"source_id": identity, "text": value})

    personal = document.get("personal", {})
    for field in ("full_name", "address"):
        add(f"personal:{field}", personal.get(field, ""))
    contact = personal.get("contact_items", [])
    for index, row in enumerate(contact):
        add(f"personal:contact:{index}", row.get("label", ""))
    if not contact:
        for index, text in enumerate(personal.get("contact", [])):
            add(f"personal:contact:{index}", text)
    labels = document.get("section_labels", {})
    add("heading:summary", labels.get("summary", "Executive Profile"))
    add("summary", document.get("summary", ""))
    add("heading:experience", labels.get("experience", "Experience"))
    for role in _document_roles(document):
        identity = role.get("id", role.get("role_id"))
        for field in ("title", "company", "location", "date_range", "summary"):
            add(f"role:{identity}:{field}", role.get(field, ""))
        for bullet in role.get("bullets", role.get("achievements", [])):
            add(f"achievement:{bullet.get('achievement_id', bullet.get('id'))}", bullet.get("text", ""))
    add("heading:education", labels.get("education", "Education"))
    for index, row in enumerate(document.get("education", [])):
        identity = row.get("id", str(index))
        for field in ("degree", "institution", "location", "date", "details"):
            add(f"education:{identity}:{field}", row.get(field, ""))
    add("heading:skills", labels.get("skills", "Skills"))
    for index, row in enumerate(document.get("skills", [])):
        identity = row.get("id", str(index))
        add(f"skills:{identity}:label", row.get("label", ""))
        for item, text in enumerate(row.get("items", [])):
            add(f"skills:{identity}:{item}", text)
    return result
