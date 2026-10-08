"""Execute model-declared query scopes and tiers by code equality."""

from collections.abc import Iterable, Mapping


def query_applies_to_source(query: Mapping[str, object], source: str) -> bool:
    scope = query.get("source_scope")
    return not scope or source in scope


def query_specs_for_source(queries: Iterable[Mapping[str, object]], source: str, *, max_tier: int | None = None):
    result = []
    for item in queries:
        if not isinstance(item, Mapping) or not query_applies_to_source(item, source):
            continue
        if max_tier is not None and int(item.get("tier") or 99) > max_tier:
            continue
        query = str(item.get("query") or "").strip()
        if query:
            result.append({"query": query, "tier": int(item.get("tier") or 99)})
    return result
