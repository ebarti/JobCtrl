"""Title/query matching helpers for discovery adapters."""

from __future__ import annotations

import re
import sqlite3
import time
from collections.abc import Sequence
from itertools import product
from typing import Protocol, cast


class RoleTitleMatchAdjudicator(Protocol):
    def matches(
        self,
        *,
        title: str,
        query: str,
        match_mode: str,
        target_track: str | None = None,
        seniority_floor: str | None = None,
    ) -> bool:
        ...


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
    (
        frozenset(("director", "platform", "engineering")),
        (("platform", "director"), ("director", "platform")),
    ),
)

_RECALL_MATCH_MODE = "recall"
_MAX_MATCH_EXTRA_TOKENS = 1
_EXCLUDED_ENGINEERING_SPECIALTIES = {
    "aerospace",
    "automotive",
    "biomedical",
    "chemical",
    "civil",
    "electrical",
    "industrial",
    "manufacturing",
    "mechanical",
    "process",
    "structural",
}
_EXCLUDED_BUSINESS_FALSE_POSITIVE_TOKENS = {
    "account",
    "accounts",
    "commercial",
    "pmo",
    "pricing",
    "sales",
}
_EXCLUDED_BUSINESS_FALSE_POSITIVE_PHRASES = (
    frozenset(("business", "transformation")),
    frozenset(("customer", "success")),
    frozenset(("product", "management")),
)

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

_AUTO_ROLE_MATCHER = object()
_ROLE_FEEDBACK_CACHE_TTL_SECONDS = 30.0
_ROLE_FEEDBACK_CACHE: tuple[float, tuple[str, ...]] = (0.0, ())


def title_matches_query(
    title: str | None,
    query: str | None,
    *,
    match_mode: str = "strict",
    target_track: str | None = None,
    seniority_floor: str | None = None,
    role_matcher: RoleTitleMatchAdjudicator | None | object = _AUTO_ROLE_MATCHER,
) -> bool:
    """Return whether a posting title satisfies a target search query."""
    if _title_excluded_by_role_feedback(title):
        return False
    normalized_query = normalize_query(query)
    if not normalized_query:
        return True
    title_sequence = _significant_tokens(title)
    title_tokens = set(title_sequence)
    if not title_tokens:
        return False
    query_tokens = [token for token in _tokens(normalized_query) if token not in _STOPWORDS]
    if not query_tokens:
        return False
    if _has_business_function_false_positive(title_sequence, query_tokens):
        return False
    if _has_excluded_engineering_specialty(title_sequence, query_tokens):
        return False
    if match_mode == _RECALL_MATCH_MODE:
        matched = _recall_title_matches_query(
            title_sequence,
            query_tokens,
            target_track=target_track,
            seniority_floor=seniority_floor,
        )
        if not matched:
            return False
        return _adjudicate_loose_match(
            title=title,
            query=normalized_query,
            match_mode=match_mode,
            target_track=target_track,
            seniority_floor=seniority_floor,
            role_matcher=role_matcher,
            verbatim=_query_tokens_match_verbatim(query_tokens, title_sequence)
            or _query_alias_matches(query_tokens, title_sequence),
        )
    verbatim_match = _query_tokens_match_verbatim(query_tokens, title_sequence)
    alias_match = _query_alias_matches(query_tokens, title_sequence)
    if not (
        verbatim_match
        or alias_match
        or _query_tokens_match_compactly(query_tokens, title_sequence)
    ):
        return False
    return _adjudicate_loose_match(
        title=title,
        query=normalized_query,
        match_mode=match_mode,
        target_track=target_track,
        seniority_floor=seniority_floor,
        role_matcher=role_matcher,
        verbatim=verbatim_match or alias_match,
    )


def normalize_query(query: str | None) -> str:
    """Strip profile notes from a role query while preserving the role itself."""
    raw = str(query or "").strip()
    if not raw:
        return ""
    return raw.split("|", 1)[0].strip()


def reset_role_match_feedback_cache() -> None:
    """Clear the approved title-exclusion cache for tests and long-lived workers."""

    global _ROLE_FEEDBACK_CACHE
    _ROLE_FEEDBACK_CACHE = (0.0, ())


def _title_excluded_by_role_feedback(title: str | None) -> bool:
    pattern = _normalize_title_pattern(title)
    if not pattern:
        return False
    return pattern in _approved_role_feedback_title_patterns()


def _normalize_title_pattern(title: str | None) -> str:
    return " ".join(_tokens(title))


def _approved_role_feedback_title_patterns() -> tuple[str, ...]:
    global _ROLE_FEEDBACK_CACHE
    now = time.monotonic()
    cached_at, cached_patterns = _ROLE_FEEDBACK_CACHE
    if now - cached_at < _ROLE_FEEDBACK_CACHE_TTL_SECONDS:
        return cached_patterns
    try:
        from jobhunter import config

        db_path = config.DB_PATH
        if not db_path.exists():
            patterns: tuple[str, ...] = ()
        else:
            with sqlite3.connect(db_path) as conn:
                table = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_match_feedback_suggestions'"
                ).fetchone()
                if table is None:
                    patterns = ()
                else:
                    patterns = tuple(
                        str(row[0] or "").strip()
                        for row in conn.execute(
                            """
                            SELECT title_pattern
                            FROM role_match_feedback_suggestions
                            WHERE tenant_id = 'local'
                              AND status = 'approved'
                              AND rule_kind = 'exact_title_exclusion'
                            """
                        ).fetchall()
                        if str(row[0] or "").strip()
                    )
    except Exception:
        patterns = ()
    _ROLE_FEEDBACK_CACHE = (now, patterns)
    return patterns


def _token_matches_title(token: str, title_tokens: set[str]) -> bool:
    alternatives: Sequence[tuple[str, ...]] = _TOKEN_ALIASES.get(token, ((token,),))
    return any(all(part in title_tokens for part in alternative) for alternative in alternatives)


def _query_alias_matches(query_tokens: Sequence[str], title_sequence: Sequence[str]) -> bool:
    query_token_set = frozenset(query_tokens)
    for required_query_tokens, title_aliases in _QUERY_ALIASES:
        if required_query_tokens.issubset(query_token_set) and any(
            _query_tokens_match_compactly(title_alias, title_sequence)
            for title_alias in title_aliases
        ):
            return True
    return False


def _has_excluded_engineering_specialty(
    title_sequence: Sequence[str],
    query_tokens: Sequence[str],
) -> bool:
    query_token_set = set(query_tokens)
    for index, token in enumerate(title_sequence):
        if token not in {"engineer", "engineering"} or index == 0:
            continue
        modifier = title_sequence[index - 1]
        if modifier in _EXCLUDED_ENGINEERING_SPECIALTIES and modifier not in query_token_set:
            return True
    return False


def _has_business_function_false_positive(
    title_sequence: Sequence[str],
    query_tokens: Sequence[str],
) -> bool:
    title_tokens = set(title_sequence)
    query_token_set = set(query_tokens)
    excluded_tokens = _EXCLUDED_BUSINESS_FALSE_POSITIVE_TOKENS.difference(query_token_set)
    if title_tokens.intersection(excluded_tokens):
        return True
    return any(
        phrase.issubset(title_tokens) and not phrase.intersection(query_token_set)
        for phrase in _EXCLUDED_BUSINESS_FALSE_POSITIVE_PHRASES
    )


def _query_tokens_match_compactly(query_tokens: Sequence[str], title_sequence: Sequence[str]) -> bool:
    return _query_tokens_match_with_extra(
        query_tokens,
        title_sequence,
        max_extra_tokens=_MAX_MATCH_EXTRA_TOKENS,
    )


def _query_tokens_match_verbatim(query_tokens: Sequence[str], title_sequence: Sequence[str]) -> bool:
    return _query_tokens_match_with_extra(query_tokens, title_sequence, max_extra_tokens=0)


def _query_tokens_match_with_extra(
    query_tokens: Sequence[str],
    title_sequence: Sequence[str],
    *,
    max_extra_tokens: int,
) -> bool:
    token_spans = [_token_spans(token, title_sequence) for token in query_tokens]
    if any(not spans for spans in token_spans):
        return False

    for candidate in product(*token_spans):
        total_span_tokens = sum(end - start for start, end in candidate)
        window_start = min(start for start, _ in candidate)
        window_end = max(end for _, end in candidate)
        if window_end - window_start <= total_span_tokens + max_extra_tokens:
            return True
    return False


def _adjudicate_loose_match(
    *,
    title: str | None,
    query: str,
    match_mode: str,
    target_track: str | None,
    seniority_floor: str | None,
    role_matcher: RoleTitleMatchAdjudicator | None | object,
    verbatim: bool,
) -> bool:
    if verbatim:
        return True
    matcher = _resolve_role_matcher(role_matcher)
    if matcher is None:
        return True
    return matcher.matches(
        title=str(title or ""),
        query=query,
        match_mode=match_mode,
        target_track=target_track,
        seniority_floor=seniority_floor,
    )


def _resolve_role_matcher(
    role_matcher: RoleTitleMatchAdjudicator | None | object,
) -> RoleTitleMatchAdjudicator | None:
    if role_matcher is None:
        return None
    if role_matcher is not _AUTO_ROLE_MATCHER:
        return cast(RoleTitleMatchAdjudicator, role_matcher)
    from jobhunter.discovery.role_title_matcher import default_role_title_matcher

    return default_role_title_matcher()


def _token_spans(token: str, title_sequence: Sequence[str]) -> tuple[tuple[int, int], ...]:
    alternatives: Sequence[tuple[str, ...]] = _TOKEN_ALIASES.get(token, ((token,),))
    spans: list[tuple[int, int]] = []
    for alternative in alternatives:
        spans.extend(_matching_alternative_spans(alternative, title_sequence))
    return tuple(spans)


def _recall_title_matches_query(
    title_sequence: Sequence[str],
    query_tokens: Sequence[str],
    *,
    target_track: str | None = None,
    seniority_floor: str | None = None,
) -> bool:
    title_tokens = set(title_sequence)
    expanded_title = _expanded_title_tokens(title_tokens)
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
    title_leadership_tokens = expanded_title.intersection(_RECALL_LEADERSHIP_TOKENS)
    title_domain_tokens = expanded_title.intersection(domain_tokens)
    return bool(title_leadership_tokens) and bool(title_domain_tokens) and _has_compact_recall_signal(
        title_sequence,
        title_leadership_tokens,
        title_domain_tokens,
    )


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


def _has_compact_recall_signal(
    title_sequence: Sequence[str],
    leadership_tokens: set[str],
    domain_tokens: set[str],
) -> bool:
    leadership_spans = _title_spans_for_tokens(leadership_tokens, title_sequence)
    domain_spans = _title_spans_for_tokens(domain_tokens, title_sequence)
    for leadership_span in leadership_spans:
        for domain_span in domain_spans:
            window_start = min(leadership_span[0], domain_span[0])
            window_end = max(leadership_span[1], domain_span[1])
            if window_end - window_start <= 2 + _MAX_MATCH_EXTRA_TOKENS:
                return True
    return False


def _title_spans_for_tokens(tokens: set[str], title_sequence: Sequence[str]) -> tuple[tuple[int, int], ...]:
    spans: list[tuple[int, int]] = []
    title_tokens = set(title_sequence)
    for token in tokens:
        if token in title_tokens:
            spans.extend(_token_spans(token, title_sequence))
        for alias_token, alternatives in _TOKEN_ALIASES.items():
            if token != alias_token:
                continue
            for alternative in alternatives:
                spans.extend(_matching_alternative_spans(alternative, title_sequence))
    return tuple(spans)


def _matching_alternative_spans(
    alternative: Sequence[str],
    title_sequence: Sequence[str],
) -> tuple[tuple[int, int], ...]:
    width = len(alternative)
    if not width or width > len(title_sequence):
        return ()
    return tuple(
        (start, start + width)
        for start in range(0, len(title_sequence) - width + 1)
        if tuple(title_sequence[start : start + width]) == tuple(alternative)
    )


def _expanded_tokens(tokens: Sequence[str] | set[str]) -> set[str]:
    expanded = set(tokens)
    for token in tuple(tokens):
        expanded.update(_RECALL_TOKEN_EXPANSIONS.get(token, ()))
    return expanded


def _expanded_title_tokens(tokens: set[str]) -> set[str]:
    expanded = _expanded_tokens(tokens)
    for alias_token, alternatives in _TOKEN_ALIASES.items():
        if any(set(alternative).issubset(tokens) for alternative in alternatives):
            expanded.add(alias_token)
    return expanded


def _significant_tokens(value: str | None) -> list[str]:
    return [token for token in _tokens(value) if token not in _STOPWORDS]


def _tokens(value: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").casefold())
