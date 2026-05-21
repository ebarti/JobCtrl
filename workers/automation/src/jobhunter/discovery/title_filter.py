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


def title_matches_query(title: str | None, query: str | None) -> bool:
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


def _tokens(value: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").casefold())
