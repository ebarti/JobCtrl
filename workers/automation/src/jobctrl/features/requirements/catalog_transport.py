"""Lossless, model-readable tables for one complete single-job catalog comparison."""

from collections import Counter
import json

from .domain import RequirementError, canonical_json, fingerprint


TABLE_CATALOG_PROMPT_VERSION = "requirements-capability-demand-partition-v9-tables"
TABLE_CATALOG_INSTRUCTIONS = """
CATALOG TABLE FORMAT. Every original posting, capability, occurrence and accepted demand is supplied.
In context collections and source JSON, a row beginning "~rN" contains the values for the named
fields in context.catalog_tables.row_fields[N], in that exact order. A string "~N" selects the
entire original string in catalog_tables.strings[N]. A literal beginning "~~" drops just its first
tilde. Read references in place. Read every source in its original role, without transferring
evidence between sources.
In context.citation_segments each source offers [layout number, space-separated segment IDs].
Pair the offered IDs, in order, with the entries of catalog_tables.segment_layouts[layout number].
Each entry selects its exact JSON path/range in catalog_tables.segment_paths. Cite only the
explicitly offered source and segment IDs; table positions and dictionary strings are not citations.
For reuse_requirement_id choose an assigned retained member's non-null requirement_id only when
its accepted category, name and definition apply verbatim. Otherwise choose null.
"""


def pack_catalog_tables(context, sources):
    documents = {key: json.loads(text) for key, text in sources.items()}
    payload = dict(context)
    segments = payload.pop("citation_segments")
    # These exact hashes are derivable from the original canonical source documents.
    # The expanded context fingerprint below commits to the entire original map.
    payload.pop("citation_source_fingerprints")
    strings, shapes = Counter(), Counter()

    def count(value):
        if isinstance(value, dict):
            shapes[tuple(sorted(value))] += 1
            for child in value.values():
                count(child)
        elif isinstance(value, list):
            for child in value:
                count(child)
        elif isinstance(value, str):
            strings[value] += 1

    for value in (*payload.values(), *documents.values()):
        count(value)
    # References save bytes only for repeated complete values and field lists.
    # Identity, source inclusion and meaning never depend on length or repetition.
    texts = [word for word, count in strings.items() if count > 1 and (len(word.encode()) - 6) * (count - 1) > 12]
    text_refs = {word: f"~{index}" for index, word in enumerate(texts)}
    fields = [names for names, count in shapes.items() if len(names) > 1 and count > 1]
    row_refs = {names: f"~r{index}" for index, names in enumerate(fields)}

    def encode(value):
        if isinstance(value, dict):
            names = tuple(sorted(value))
            if names in row_refs:
                return [row_refs[names], *(encode(value[key]) for key in names)]
            return {key: encode(child) for key, child in value.items()}
        if isinstance(value, list):
            return [encode(child) for child in value]
        if isinstance(value, str):
            return text_refs.get(value, "~" + value if value.startswith("~") else value)
        return value

    paths, layouts, offers = {}, {}, {}
    for source, offered in segments.items():
        path_ids = []
        for descriptor in offered.values():
            key = canonical_json(descriptor)
            if key not in paths:
                paths[key] = (len(paths), descriptor)
            path_ids.append(paths[key][0])
        layout = tuple(path_ids)
        offers[source] = [layouts.setdefault(layout, len(layouts)), " ".join(offered)]
    wire = {key: encode(value) if isinstance(value, (list, dict)) else value for key, value in payload.items()}
    wire["citation_segments"] = offers
    wire["catalog_tables"] = {"row_fields": fields, "strings": texts, "segment_layouts": list(layouts),
                              "segment_paths": [row[1] for row in paths.values()], "expanded_context_fingerprint": fingerprint(context)}
    packed = {source: canonical_json(encode(document)) for source, document in documents.items()}
    if expand_catalog_tables(wire, packed) != (context, sources):
        raise RequirementError("requirements_catalog_transport_invalid")
    return wire, packed


def expand_catalog_tables(wire, packed):
    try:
        context = dict(wire)
        tables = context.pop("catalog_tables")
        offers = context.pop("citation_segments")

        def decode(value):
            if isinstance(value, dict):
                return {key: decode(child) for key, child in value.items()}
            if isinstance(value, list):
                if value and isinstance(value[0], str) and value[0].startswith("~r"):
                    number = value[0][2:]
                    if not number.isascii() or not number.isdecimal():
                        raise ValueError
                    names = tables["row_fields"][int(number)]
                    return dict(zip(names, (decode(child) for child in value[1:]), strict=True))
                return [decode(child) for child in value]
            if isinstance(value, str) and value.startswith("~"):
                if value.startswith("~~"):
                    return value[1:]
                number = value[1:]
                if not number.isascii() or not number.isdecimal():
                    raise ValueError
                return tables["strings"][int(number)]
            return value

        context = {key: decode(value) if isinstance(value, (list, dict)) else value for key, value in context.items()}
        sources = {key: canonical_json(decode(json.loads(text))) for key, text in packed.items()}
        segments = {}
        for source, (layout, identifiers) in offers.items():
            if type(layout) is not int or layout < 0:
                raise ValueError
            ids = tables["segment_layouts"][layout]
            if any(type(index) is not int or index < 0 for index in ids):
                raise ValueError
            segments[source] = dict(zip(identifiers.split(), (tables["segment_paths"][index] for index in ids), strict=True))
        context["citation_segments"] = segments
        context["citation_source_fingerprints"] = {key: fingerprint(text) for key, text in sources.items()}
        if fingerprint(context) != tables["expanded_context_fingerprint"] or fingerprint(segments) != context["citation_catalog_fingerprint"]:
            raise ValueError
        return context, sources
    except (IndexError, KeyError, TypeError, ValueError):
        raise RequirementError("requirements_catalog_transport_invalid") from None
