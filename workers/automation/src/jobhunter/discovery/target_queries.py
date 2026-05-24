"""Profile target-role query planning for discovery."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence

from jobhunter.discovery.title_filter import normalize_query
from jobhunter.discovery.title_filter import title_matches_query


RECALL_MATCH_MODE = "recall"

_RECALL_QUERY_LIMIT = 14

_QUERY_DEDUPE_STOPWORDS = {
    "a",
    "an",
    "and",
    "for",
    "in",
    "of",
    "on",
    "the",
    "to",
}

_LEADERSHIP_TOKENS = {
    "chief",
    "cio",
    "ciso",
    "cto",
    "director",
    "head",
    "lead",
    "leader",
    "leadership",
    "manager",
    "principal",
    "staff",
    "vp",
}

_ENGINEERING_TOKENS = {
    "devops",
    "engineering",
    "engineer",
    "infrastructure",
    "platform",
    "reliability",
    "sre",
}

_PLATFORM_TOKENS = {
    "cloud",
    "devops",
    "infrastructure",
    "platform",
    "reliability",
    "sre",
}

_SECURITY_TOKENS = {
    "ciso",
    "cybersecurity",
    "devsecops",
    "information",
    "security",
}

_TECHNOLOGY_TOKENS = {
    "cio",
    "cto",
    "digital",
    "information",
    "it",
    "technology",
}

_ABBREVIATION_EXPANSIONS = {
    "cio": ("chief", "information", "officer", "technology"),
    "ciso": ("chief", "information", "security", "officer"),
    "cto": ("chief", "technology", "officer"),
    "sre": ("site", "reliability", "engineering"),
    "vp": ("vice", "president"),
}


def build_target_role_queries(roles: Iterable[str]) -> list[dict[str, object]]:
    """Build exact and recall-oriented discovery queries from target roles."""

    exact_queries = _dedupe_exact_queries(normalize_query(role) for role in roles)
    queries: list[dict[str, object]] = [{"query": query, "tier": 1} for query in exact_queries]
    exact_keys = {_query_key(query) for query in exact_queries}

    recall_count = 0
    for query in _recall_queries_for_roles(exact_queries):
        key = _query_key(query)
        if key in exact_keys:
            continue
        queries.append(
            {
                "query": query,
                "tier": 1,
                "match_mode": RECALL_MATCH_MODE,
                "generated_from": "target_roles",
            }
        )
        exact_keys.add(key)
        recall_count += 1
        if recall_count >= _RECALL_QUERY_LIMIT:
            break

    return queries


def query_applies_to_source(query: Mapping[str, object], source: str) -> bool:
    """Return whether a query should run for the given discovery source."""

    scope = query.get("source_scope")
    if not scope:
        return True
    if isinstance(scope, str):
        return scope == source
    if isinstance(scope, Sequence):
        return source in {str(item) for item in scope}
    return True


def query_specs_for_source(
    queries: Iterable[Mapping[str, object]],
    source: str,
    *,
    max_tier: int | None = None,
) -> list[dict[str, object]]:
    """Return target query specs that should run or match for a source."""

    result: list[dict[str, object]] = []
    for item in queries:
        if not isinstance(item, Mapping) or not query_applies_to_source(item, source):
            continue
        if max_tier is not None and int(item.get("tier") or 99) > max_tier:
            continue
        query = str(item.get("query") or "").strip()
        if not query:
            continue
        result.append(
            {
                "query": query,
                "match_mode": str(item.get("match_mode") or "strict"),
                "tier": int(item.get("tier") or 99),
            }
        )
    return result


def title_matches_any_query(title: str | None, queries: Iterable[Mapping[str, object]]) -> bool:
    """Return whether a title matches at least one exact or recall query spec."""

    materialized = list(queries)
    if not materialized:
        return True
    return any(
        title_matches_query(
            title,
            str(item.get("query") or ""),
            match_mode=str(item.get("match_mode") or "strict"),
        )
        for item in materialized
    )


def _recall_queries_for_roles(exact_queries: list[str]) -> list[str]:
    tokens = _expanded_tokens(exact_queries)
    if not tokens.intersection(_LEADERSHIP_TOKENS):
        return []

    candidates: list[str] = []
    if tokens.intersection(_ENGINEERING_TOKENS):
        candidates.extend(
            [
                "engineering manager",
                "engineering director",
                "head of engineering",
                "technical director",
            ]
        )
    if tokens.intersection(_PLATFORM_TOKENS):
        candidates.extend(
            [
                "platform director",
                "platform engineering manager",
                "infrastructure director",
                "infrastructure manager",
                "cloud engineering manager",
            ]
        )
    if tokens.intersection(_SECURITY_TOKENS):
        candidates.extend(
            [
                "security director",
                "cybersecurity director",
                "information security director",
                "security engineering manager",
            ]
        )
    if tokens.intersection(_TECHNOLOGY_TOKENS):
        candidates.extend(
            [
                "technology director",
                "head of technology",
                "IT director",
                "information technology director",
            ]
        )

    if tokens.intersection(_ENGINEERING_TOKENS | _PLATFORM_TOKENS | _SECURITY_TOKENS | _TECHNOLOGY_TOKENS):
        candidates.extend(["technology leadership", "technical leadership"])

    return _dedupe_recall_queries(candidates)


def _dedupe_exact_queries(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if not normalized:
            continue
        key = normalized.casefold()
        if key not in seen:
            result.append(normalized)
            seen.add(key)
    return result


def _dedupe_recall_queries(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if not normalized:
            continue
        key = _query_key(normalized)
        if key not in seen:
            result.append(normalized)
            seen.add(key)
    return result


def _query_key(query: str) -> str:
    tokens = sorted(token for token in _tokens(query) if token not in _QUERY_DEDUPE_STOPWORDS)
    return " ".join(tokens) if tokens else str(query or "").strip().casefold()


def _expanded_tokens(queries: Iterable[str]) -> set[str]:
    tokens: set[str] = set()
    for query in queries:
        for token in _tokens(query):
            tokens.add(token)
            tokens.update(_ABBREVIATION_EXPANSIONS.get(token, ()))
    return tokens


def _tokens(value: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").casefold())
