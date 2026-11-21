"""Exact source-format citation choices, separate from immutable model output."""

from __future__ import annotations

from copy import deepcopy
import json

from pydantic import Field, StrictStr

from .domain import RequirementError, Value, canonical_json, fingerprint


CITATION_BINDER_VERSION = "requirements-citation-binding-v1"
MAX_CITATION_CHARACTERS = 4000


class CitationSelection(Value):
    source_id: StrictStr = Field(min_length=1, max_length=1000)
    segment_id: StrictStr = Field(min_length=1, max_length=120)


def citation_source_context(context, sources):
    """Record source-handle identity joins; no prose or inferred current heads."""
    members = []
    for member in context["members"]:
        document = json.loads(sources[member["source_id"]])
        record = deepcopy(member)
        if member["requirement_id"] is not None:
            record["retained_members"] = [{"requirement_id": item["requirement_id"], "revision": item["revision"]}
                                           for item in document["retained_members"]]
            record["posting"] = deepcopy(document["canonical"].get("posting"))
        members.append(record)
    occurrences = []
    demand_occurrences = {}
    for occurrence in context["occurrences"]:
        document = json.loads(sources[occurrence["source_id"]])
        record = {**deepcopy(occurrence), "source_identity": deepcopy(document["source_identity"])}
        occurrences.append(record)
        demand = document.get("normalized_demand")
        if demand is not None:
            demand_occurrences.setdefault(demand["demand_fingerprint"], []).append(occurrence["occurrence_id"])
    postings = []
    for posting in context["posting_sources"]:
        document = json.loads(sources[posting["source_id"]])
        postings.append({**deepcopy(posting), "posting_source_id": document.get("source_id"),
                         "source_revision": document.get("source_revision")})
    return {"normalization_version": context["normalization_version"], "catalog_revision": context["catalog_revision"],
            "inventory_source_id": context["catalog_inventory_source_id"],
            "snapshot_heads": deepcopy(context["source_snapshot_heads"]), "members": members,
            "occurrences": occurrences, "posting_sources": postings, "incoming": deepcopy(context["incoming"]),
            "accepted_demands": [{**{key: deepcopy(value) for key, value in item.items() if key != "definition"},
                                  "occurrence_ids": demand_occurrences.get(item["demand_fingerprint"], [])}
                                 for item in context["accepted_demands"]]}


def _string_locations(value, path=()):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _string_locations(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _string_locations(item, (*path, index))


def _ranges(text):
    """Lossless format subdivision only where the existing quote bound needs it."""
    start = 0
    while start < len(text):
        end = min(start + MAX_CITATION_CHARACTERS, len(text))
        if end < len(text):
            newline = text.rfind("\n", start, end)
            if newline >= start:
                end = newline + 1
        yield start, end
        start = end


def citation_segment_catalog(sources, *, inventory_source_id, catalog_revision):
    segments = {}
    ordinal = 0

    def append(source_id, source_format, path, start, end, text, *, preview=False):
        nonlocal ordinal
        if not text[start:end].strip():
            return
        ordinal += 1
        entry = {"value_path": list(path)}
        if source_format != "json_string":
            entry["source_format"] = source_format
        if source_format == "serialized" or start != 0 or end != len(text):
            entry.update(start=start, end=end)
        if preview:
            entry["preview"] = text[start:min(end, start + 64)]
        descriptor = entry["value_path"] if set(entry) == {"value_path"} else entry
        segments.setdefault(source_id, {})[f"c{ordinal:04d}"] = descriptor

    for source_id, raw in sources.items():
        if source_id == inventory_source_id:
            # The inventory's exact serialized epoch is structural authority,
            # not a prose field requiring a model-authored quotation.
            fragment = canonical_json({"catalog_revision": catalog_revision})[1:-1]
            start = raw.find(fragment)
            if start < 0:
                raise RequirementError("citation_segment_catalog_invalid")
            append(source_id, "serialized", ("catalog_revision",), start, start + len(fragment), raw)
            continue
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            raise RequirementError("citation_segment_catalog_invalid") from None
        if not isinstance(value, (dict, list)):
            raise RequirementError("citation_segment_catalog_invalid")
        for path, text in _string_locations(value):
            for start, end in _ranges(text):
                append(source_id, "json_string", path, start, end, text,
                       preview=len(text) > MAX_CITATION_CHARACTERS)
    return segments


def _selected_text(segment, sources, context):
    source_id = segment.get("source_id")
    if source_id not in sources:
        raise RequirementError("foreign_source_id")
    path = segment.get("value_path")
    if not isinstance(path, list):
        raise RequirementError("citation_segment_catalog_invalid")
    source_format = segment.get("source_format", "json_string")
    if source_format == "serialized":
        if source_id != context["catalog_inventory_source_id"] or path != ["catalog_revision"]:
            raise RequirementError("citation_segment_catalog_invalid")
        text = sources[source_id]
    elif source_format == "json_string":
        try:
            text = json.loads(sources[source_id])
            for part in path:
                if isinstance(text, dict) and isinstance(part, str):
                    text = text[part]
                elif isinstance(text, list) and type(part) is int and 0 <= part < len(text):
                    text = text[part]
                else:
                    raise RequirementError("citation_segment_catalog_invalid")
        except (KeyError, TypeError, ValueError):
            raise RequirementError("citation_segment_catalog_invalid") from None
        if not isinstance(text, str):
            raise RequirementError("citation_segment_catalog_invalid")
    else:
        raise RequirementError("citation_segment_catalog_invalid")
    start, end = segment.get("start", 0), segment.get("end", len(text))
    if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text)
            or end - start > MAX_CITATION_CHARACTERS):
        raise RequirementError("citation_segment_catalog_invalid")
    quote = text[start:end]
    if not quote.strip():
        raise RequirementError("blank_requirement_field")
    if source_format == "serialized" and quote != canonical_json({"catalog_revision": context["catalog_revision"]})[1:-1]:
        raise RequirementError("citation_segment_catalog_invalid")
    return quote


def bind_citation_selections(selection, *, context, sources):
    """Derive exact quote fields without modifying the raw model selection."""
    catalog = context.get("citation_segments")
    if not isinstance(catalog, dict) or fingerprint(catalog) != context.get("citation_catalog_fingerprint"):
        raise RequirementError("citation_segment_catalog_invalid")
    source_context = citation_source_context(context, sources)
    source_fingerprints = {ident: fingerprint(text) for ident, text in sources.items()}
    if (fingerprint(source_context) != context.get("citation_source_context_fingerprint")
            or source_fingerprints != context.get("citation_source_fingerprints")):
        raise RequirementError("citation_source_context_invalid")
    index = {}
    for source_id, segments in catalog.items():
        if source_id not in sources or not isinstance(segments, dict):
            raise RequirementError("citation_segment_catalog_invalid")
        for ident, descriptor in segments.items():
            if not isinstance(ident, str) or ident in index:
                raise RequirementError("citation_segment_catalog_invalid")
            if isinstance(descriptor, list):
                descriptor = {"value_path": descriptor}
            if not isinstance(descriptor, dict):
                raise RequirementError("citation_segment_catalog_invalid")
            index[ident] = {**descriptor, "source_id": source_id}
    derived = deepcopy(selection)
    used = []
    for collection in ("capabilities", "demands", "corrections", "unresolved"):
        for item_index, item in enumerate(derived[collection]):
            citations = []
            seen = set()
            for citation_index, ref in enumerate(item["citations"]):
                segment_id = ref["segment_id"]
                segment = index.get(segment_id)
                if segment is None:
                    raise RequirementError("foreign_citation_segment_id")
                if ref["source_id"] not in sources or segment["source_id"] != ref["source_id"]:
                    raise RequirementError("foreign_source_id")
                if segment_id in seen:
                    raise RequirementError("duplicate_citation_segment_id")
                seen.add(segment_id)
                quote = _selected_text(segment, sources, context)
                citations.append({"source_id": ref["source_id"], "quote": quote})
                used.append({"collection": collection, "item_index": item_index, "citation_index": citation_index,
                             "segment_id": segment_id, "source_id": ref["source_id"], "quote_fingerprint": fingerprint(quote)})
            item["citations"] = citations
    binding = {"binder_version": CITATION_BINDER_VERSION, "selection_fingerprint": fingerprint(selection),
               "derived_fingerprint": fingerprint(derived), "segment_catalog_fingerprint": fingerprint(catalog),
               "source_fingerprint": fingerprint(sources), "source_fingerprints": source_fingerprints,
               "source_context_fingerprint": fingerprint(source_context), "source_context": source_context,
               "segment_catalog": deepcopy(catalog), "selections": used}
    return derived, binding


def citation_binding_summary(binding):
    return {key: binding[key] for key in ("binder_version", "selection_fingerprint", "derived_fingerprint",
                                        "segment_catalog_fingerprint", "source_fingerprint", "source_context_fingerprint")}


def citation_binding_report(binding):
    return {**citation_binding_summary(binding), "source_fingerprints": binding["source_fingerprints"],
            "source_context": binding["source_context"], "segment_catalog": binding["segment_catalog"]}
