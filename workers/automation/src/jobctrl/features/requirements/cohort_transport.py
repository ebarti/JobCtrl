"""Lossless source/segment dictionaries and explicit retained-definition references."""

from collections import Counter
from copy import deepcopy
import json

from .domain import RequirementError, canonical_json, fingerprint


COHORT_PROMPT_VERSION = "requirements-capability-demand-partition-v7-cohort"
REFRESH_CATALOG_PROMPT_VERSION = "requirements-capability-demand-partition-v8-sources"
SOURCE_DICTIONARY_INSTRUCTIONS = """SOURCE TRANSPORT: Read every supplied source document. Within its JSON, an object containing
only "$text" selects the exact full original string from context.cohort_texts. In citation_segments
a string handle selects the exact original path or range descriptor from context.cohort_segment_paths.
Interpret every reference in place. The recorded source IDs, citation segments, evidence roles and
posting identities are unchanged. Never cite a dictionary entry or transfer evidence between sources.
"""
REFRESH_CATALOG_INSTRUCTIONS = "\n" + SOURCE_DICTIONARY_INSTRUCTIONS + """For reuse_requirement_id, select an assigned retained member's exact non-null requirement_id only
when its accepted category, name and definition apply verbatim. Otherwise set reuse_requirement_id
to null. Incoming member IDs participate in assignments and cannot identify a retained capability.
"""
# v7's complete instructions and request fingerprints are already in durable use.
COHORT_INSTRUCTIONS = "\nCOHORT " + SOURCE_DICTIONARY_INSTRUCTIONS + """In a used capability_groups slot, kind "reuse" explicitly selects the complete category, name and
definition of its retained reuse_requirement_id. Supply the reason and all required citations.
In a used demand_groups slot, kind "reuse" explicitly selects the exact accepted definition identified
by reuse_demand_fingerprint. Supply all original demand citations. These choices have exactly the
same requirements as copying the selected definition verbatim. Choose them when the supplied meanings
are exact; otherwise use the full "group" definition. Decide every assignment and semantic distinction.
"""


def _map_strings(value, transform):
    if isinstance(value, str):
        return transform(value)
    if isinstance(value, list):
        return [_map_strings(item, transform) for item in value]
    if isinstance(value, dict):
        if "$text" in value:
            raise RequirementError("requirements_cohort_source_invalid")
        return {key: _map_strings(item, transform) for key, item in value.items()}
    return value


def _restore_text(value, texts):
    if isinstance(value, dict):
        if "$text" in value:
            if set(value) != {"$text"}:
                raise RequirementError("requirements_cohort_source_invalid")
            return texts[value["$text"]]
        return {key: _restore_text(item, texts) for key, item in value.items()}
    if isinstance(value, list):
        return [_restore_text(item, texts) for item in value]
    return value


def pack_catalog_sources(context, sources):
    # Count only exact, complete string values. Length determines serialization
    # savings and never selects evidence or decides equivalence.
    documents = {key: json.loads(value) for key, value in sources.items()}
    counts = Counter()
    for document in documents.values():
        _map_strings(document, lambda value: counts.update([value]))
    handles = {value: f"t{i}" for i, value in enumerate(
        (value for value, count in counts.items() if count > 1 and len(value.encode()) >= 40), 1)}
    packed = {key: canonical_json(_map_strings(document,
        lambda value: {"$text": handles[value]} if value in handles else value)) for key, document in documents.items()}
    paths, segments = {}, {}
    for source, offered in context["citation_segments"].items():
        segments[source] = {}
        for segment, descriptor in offered.items():
            key = canonical_json(descriptor)
            if key not in paths:
                paths[key] = (f"p{len(paths) + 1}", descriptor)
            segments[source][segment] = paths[key][0]
    wire = {**context, "citation_segments": segments, "cohort_segment_paths": dict(paths.values()),
            "cohort_texts": {handle: value for value, handle in handles.items()},
            "expanded_context_fingerprint": fingerprint(context)}
    expanded_context, expanded_sources = expand_catalog_sources(wire, packed)
    if expanded_context != context or expanded_sources != sources:
        raise RequirementError("requirements_cohort_source_invalid")
    return wire, packed


def expand_catalog_sources(wire, packed):
    context = dict(wire)
    try:
        paths = context.pop("cohort_segment_paths")
        texts = context.pop("cohort_texts")
        expected = context.pop("expanded_context_fingerprint")
        context["citation_segments"] = {source: {segment: paths[handle] for segment, handle in offered.items()}
                                        for source, offered in context["citation_segments"].items()}
        sources = {key: canonical_json(_restore_text(json.loads(value), texts)) for key, value in packed.items()}
        if (fingerprint(context) != expected or fingerprint(context["citation_segments"]) != context["citation_catalog_fingerprint"]
                or {key: fingerprint(value) for key, value in sources.items()} != context["citation_source_fingerprints"]):
            raise RequirementError("requirements_cohort_source_invalid")
        return context, sources
    except (KeyError, TypeError, ValueError):
        raise RequirementError("requirements_cohort_source_invalid") from None


def expand_group_references(selection, context, sources):
    raw = deepcopy(selection)
    retained = {row["requirement_id"]: row["source_id"] for row in context["members"] if row["requirement_id"] is not None}
    demands = {row["demand_fingerprint"]: row["source_id"] for row in context["accepted_demands"]}
    try:
        for group in raw["capability_groups"].values():
            if group is not None and group["kind"] == "reuse":
                source = json.loads(sources[retained[group["reuse_requirement_id"]]])["canonical"]
                group.update(kind="group", **{key: source[key] for key in ("category", "name", "definition")})
        for demand in raw["demand_groups"].values():
            if demand is not None and demand["kind"] == "reuse":
                source = json.loads(sources[demands[demand["reuse_demand_fingerprint"]]])
                demand.update(kind="group", definition=source["definition"])
    except (KeyError, ValueError, TypeError):
        raise RequirementError("requirements_consolidation_reuse_invalid") from None
    return raw
