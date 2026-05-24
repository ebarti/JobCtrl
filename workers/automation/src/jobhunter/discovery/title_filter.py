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

_MANAGEMENT_TOKENS = {"manager", "management", "director", "head"}
_EXECUTIVE_TOKENS = {"chief", "cio", "ciso", "cto", "evp", "svp", "vp", "vice", "president"}
_IC_TOKENS = {
    "architect",
    "engineer",
    "engineering",
    "expert",
    "fellow",
    "ic",
    "individual",
    "lead",
    "principal",
    "staff",
}
_TRACKS = {"ic", "management", "executive"}

_SENIORITY_RANKS = {
    "intern": 0,
    "junior": 1,
    "entry": 1,
    "associate": 1,
    "mid": 2,
    "engineer": 2,
    "analyst": 2,
    "senior": 3,
    "sr": 3,
    "lead": 4,
    "manager": 4,
    "staff": 5,
    "principal": 6,
    "architect": 6,
    "director": 6,
    "head": 6,
    "vp": 7,
    "svp": 7,
    "evp": 7,
    "vice": 7,
    "president": 7,
    "chief": 8,
    "cio": 8,
    "ciso": 8,
    "cto": 8,
}

_SENIORITY_ALIASES = {
    "c level": "chief",
    "c suite": "chief",
    "chief level": "chief",
    "csuite": "chief",
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


def title_matches_query(
    title: str | None,
    query: str | None,
    *,
    match_mode: str = "strict",
    target_track: str | None = None,
    seniority_floor: str | None = None,
) -> bool:
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
        return _recall_title_matches_query(
            title_tokens,
            query_tokens,
            target_track=target_track,
            seniority_floor=seniority_floor,
        )
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


def _recall_title_matches_query(
    title_tokens: set[str],
    query_tokens: Sequence[str],
    *,
    target_track: str | None = None,
    seniority_floor: str | None = None,
) -> bool:
    expanded_title = _expanded_tokens(title_tokens)
    expanded_query = _expanded_tokens(query_tokens)
    query_track = _normalize_track(target_track) or _classify_track(expanded_query)
    query_rank = _seniority_rank(seniority_floor) if seniority_floor else _rank_from_tokens(expanded_query)
    title_track = _classify_track(expanded_title)
    title_rank = _rank_from_tokens(expanded_title)
    if query_track and title_track != query_track:
        return False
    if title_rank < query_rank:
        return False
    domain_tokens = _recall_domain_tokens(expanded_query)
    if not domain_tokens:
        domain_tokens = {
            token
            for token in expanded_query
            if token not in _MANAGEMENT_TOKENS
            and token not in _EXECUTIVE_TOKENS
            and token not in _IC_TOKENS
            and token not in _STOPWORDS
        }
    return bool(_classify_track(expanded_title)) and bool(expanded_title.intersection(domain_tokens))


def _classify_track(tokens: set[str]) -> str | None:
    if tokens.intersection(_EXECUTIVE_TOKENS):
        return "executive"
    if tokens.intersection(_MANAGEMENT_TOKENS):
        return "management"
    if tokens.intersection(_IC_TOKENS):
        return "ic"
    return None


def _normalize_track(value: str | None) -> str | None:
    normalized = str(value or "").strip().casefold().replace("-", "_")
    if normalized in {"individual_contributor", "individual contributor", "staff_plus", "staff plus"}:
        return "ic"
    if normalized in {"manager", "management", "people_manager", "people manager"}:
        return "management"
    if normalized in {"exec", "executive", "leadership"}:
        return "executive"
    return normalized if normalized in _TRACKS else None


def _rank_from_tokens(tokens: set[str]) -> int:
    if not tokens:
        return 0
    if "vice" in tokens and "president" in tokens:
        return _SENIORITY_RANKS["vp"]
    return max((_SENIORITY_RANKS.get(token, 0) for token in tokens), default=0)


def _seniority_rank(value: str | None) -> int:
    seniority_alias = _seniority_alias(value)
    if seniority_alias:
        return _SENIORITY_RANKS[seniority_alias]
    tokens = _expanded_tokens(_tokens(value))
    return _rank_from_tokens(tokens)


def _seniority_alias(value: str | None) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()
    if not normalized:
        return None
    return _SENIORITY_ALIASES.get(normalized) or _SENIORITY_ALIASES.get(normalized.replace(" ", ""))


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
