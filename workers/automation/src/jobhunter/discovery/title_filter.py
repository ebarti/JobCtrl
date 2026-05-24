"""Title/query matching helpers for discovery adapters."""

from __future__ import annotations

import re
from collections.abc import Sequence


_STOPWORDS = {
    "a",
    "an",
    "and",
    "for",
    "if",
    "in",
    "model",
    "of",
    "on",
    "onsite",
    "preferred",
    "remote",
    "required",
    "role",
    "roles",
    "site",
    "the",
    "to",
    "work",
}

_TOKEN_ALIASES: dict[str, tuple[tuple[str, ...], ...]] = {
    "vp": (("vp",), ("vice", "president")),
    "svp": (("svp",), ("senior", "vice", "president")),
    "evp": (("evp",), ("executive", "vice", "president")),
    "ciso": (("ciso",), ("chief", "information", "security", "officer")),
    "cio": (("cio",), ("chief", "information", "officer")),
    "cto": (("cto",), ("chief", "technology", "officer")),
    "it": (("it",), ("information",), ("technology",)),
}

_QUERY_ALIASES: tuple[tuple[frozenset[str], tuple[tuple[str, ...], ...]], ...] = (
    (frozenset(("director", "platform", "engineering")), (("platform", "director"),)),
)

_RECALL_MATCH_MODE = "recall"

_RECALL_LEADERSHIP_TOKENS = {
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

_RECALL_DOMAIN_TOKENS = {
    "engineering": {
        "cloud",
        "devops",
        "engineering",
        "engineer",
        "infrastructure",
        "platform",
        "reliability",
        "software",
        "sre",
        "technical",
        "technology",
    },
    "platform": {
        "cloud",
        "devops",
        "infrastructure",
        "platform",
        "reliability",
        "sre",
    },
    "security": {
        "cybersecurity",
        "devsecops",
        "information",
        "infosec",
        "security",
    },
    "technology": {
        "digital",
        "information",
        "it",
        "systems",
        "technical",
        "technology",
    },
}

_RECALL_TOKEN_EXPANSIONS = {
    "cio": ("chief", "information", "officer", "technology"),
    "ciso": ("chief", "information", "security", "officer"),
    "cto": ("chief", "technology", "officer"),
    "infosec": ("information", "security"),
    "it": ("information", "technology"),
    "sre": ("site", "reliability", "engineering"),
    "vp": ("vice", "president"),
}


def title_matches_query(title: str | None, query: str | None, *, match_mode: str = "strict") -> bool:
    """Return whether a posting title satisfies a target search query."""
    normalized_query = normalize_query(query)
    if not normalized_query:
        return True
    title_tokens = set(_tokens(title))
    if not title_tokens:
        return False
    query_tokens = [token for token in _tokens(normalized_query) if token not in _STOPWORDS]
    if not query_tokens:
        return False
    if match_mode == _RECALL_MATCH_MODE:
        return _recall_title_matches_query(title_tokens, query_tokens)
    return all(_token_matches_title(token, title_tokens) for token in query_tokens) or _query_alias_matches(
        query_tokens,
        title_tokens,
    )


def normalize_query(query: str | None) -> str:
    """Strip profile notes from a role query while preserving the role itself."""
    raw = str(query or "").strip()
    if not raw:
        return ""
    return raw.split("|", 1)[0].strip()


def _token_matches_title(token: str, title_tokens: set[str]) -> bool:
    alternatives: Sequence[tuple[str, ...]] = _TOKEN_ALIASES.get(token, ((token,),))
    return any(all(part in title_tokens for part in alternative) for alternative in alternatives)


def _query_alias_matches(query_tokens: Sequence[str], title_tokens: set[str]) -> bool:
    query_token_set = frozenset(query_tokens)
    for required_query_tokens, title_aliases in _QUERY_ALIASES:
        if required_query_tokens.issubset(query_token_set) and any(
            all(part in title_tokens for part in title_alias)
            for title_alias in title_aliases
        ):
            return True
    return False


def _recall_title_matches_query(title_tokens: set[str], query_tokens: Sequence[str]) -> bool:
    expanded_title = _expanded_tokens(title_tokens)
    expanded_query = _expanded_tokens(query_tokens)
    domain_tokens = _recall_domain_tokens(expanded_query)
    if not domain_tokens:
        domain_tokens = {
            token
            for token in expanded_query
            if token not in _RECALL_LEADERSHIP_TOKENS and token not in _STOPWORDS
        }
    return bool(expanded_title.intersection(_RECALL_LEADERSHIP_TOKENS)) and bool(
        expanded_title.intersection(domain_tokens)
    )


def _recall_domain_tokens(query_tokens: set[str]) -> set[str]:
    domains: set[str] = set()
    for tokens in _RECALL_DOMAIN_TOKENS.values():
        if query_tokens.intersection(tokens):
            domains.update(tokens)
    return domains


def _expanded_tokens(tokens: Sequence[str] | set[str]) -> set[str]:
    expanded = set(tokens)
    for token in tuple(tokens):
        expanded.update(_RECALL_TOKEN_EXPANSIONS.get(token, ()))
    return expanded


def _tokens(value: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").casefold())
