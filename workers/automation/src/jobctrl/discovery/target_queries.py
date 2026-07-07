"""Profile target-role query planning for discovery."""

from __future__ import annotations

import re
from dataclasses import dataclass
from collections.abc import Iterable, Mapping, Sequence

from jobctrl.discovery.title_filter import RoleTitleMatchAdjudicator, normalize_query
from jobctrl.discovery.title_filter import title_matches_query


RECALL_MATCH_MODE = "recall"

_RECALL_QUERY_LIMIT = 14
_AUTO_ROLE_MATCHER = object()

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

_TRACKS = {"ic", "management", "executive"}
_TRACK_ALIASES = {
    "individual contributor": "ic",
    "individual_contributor": "ic",
    "staff plus": "ic",
    "staff_plus": "ic",
    "manager": "management",
    "people manager": "management",
    "people_manager": "management",
    "exec": "executive",
    "leadership": "executive",
}

_MANAGEMENT_TOKENS = {"manager", "management", "director", "head"}
_EXECUTIVE_TOKENS = {"chief", "cio", "ciso", "cto", "evp", "svp", "vp", "vice", "president"}
_IC_TOKENS = {"architect", "engineer", "engineering", "expert", "fellow", "ic", "lead", "principal", "staff"}

_SENIORITY_RANKS = {
    "intern": 0,
    "junior": 1,
    "entry": 1,
    "associate": 1,
    "mid": 2,
    "engineer": 2,
    "senior": 3,
    "sr": 3,
    "lead": 4,
    "manager": 4,
    "senior_manager": 5,
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
    "senior manager": "senior_manager",
    "senior engineering manager": "senior_manager",
    "head of engineering": "senior_manager",
}

_SENIORITY_LABELS = {
    3: "Senior",
    4: "Lead",
    5: "Staff",
    6: "Principal",
    7: "VP",
    8: "Chief",
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

_DATA_TOKENS = {
    "analytics",
    "data",
    "ml",
    "machine",
    "learning",
}

_AI_TOKENS = {
    "ai",
    "artificial",
    "intelligence",
    "ml",
    "machine",
    "learning",
}

_BACKEND_TOKENS = {
    "api",
    "backend",
    "distributed",
    "server",
}

_DOMAIN_KEYWORDS = {
    "engineering": _ENGINEERING_TOKENS,
    "platform": _PLATFORM_TOKENS,
    "security": _SECURITY_TOKENS,
    "technology": _TECHNOLOGY_TOKENS,
    "data": _DATA_TOKENS,
    "ai": _AI_TOKENS,
    "backend": _BACKEND_TOKENS,
}

_ABBREVIATION_EXPANSIONS = {
    "cio": ("chief", "information", "officer", "technology"),
    "ciso": ("chief", "information", "security", "officer"),
    "cto": ("chief", "technology", "officer"),
    "sre": ("site", "reliability", "engineering"),
    "vp": ("vice", "president"),
}


@dataclass(frozen=True)
class _RoleIntent:
    role: str
    track: str | None
    seniority_floor: str | None
    domains: tuple[str, ...]


def build_target_role_queries(
    roles: Iterable[str],
    *,
    tracks: Iterable[str] = (),
    seniority: Iterable[str] = (),
    functions: Iterable[str] = (),
    specializations: Iterable[str] = (),
) -> list[dict[str, object]]:
    """Build exact and recall-oriented discovery queries from target roles."""

    exact_queries = _dedupe_exact_queries(normalize_query(role) for role in roles)
    exact_queries = _dedupe_exact_queries(
        [*exact_queries, *_structured_exact_queries(tracks=tracks, seniority=seniority, functions=functions)]
    )
    queries: list[dict[str, object]] = [{"query": query, "tier": 1} for query in exact_queries]
    exact_keys = {_query_key(query) for query in exact_queries}

    recall_count = 0
    for recall in _recall_queries_for_roles(
        exact_queries,
        tracks=tracks,
        seniority=seniority,
        functions=functions,
        specializations=specializations,
    ):
        query = recall["query"]
        key = _query_key(query)
        if key in exact_keys:
            continue
        queries.append(recall)
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
    source_aliases = _source_aliases(source)
    if isinstance(scope, str):
        return bool(_source_aliases(scope).intersection(source_aliases))
    if isinstance(scope, Sequence):
        scoped_aliases: set[str] = set()
        for item in scope:
            scoped_aliases.update(_source_aliases(str(item)))
        return bool(scoped_aliases.intersection(source_aliases))
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
                "target_track": str(item.get("target_track") or ""),
                "seniority_floor": str(item.get("seniority_floor") or ""),
            }
        )
    return result


def title_matches_any_query(
    title: str | None,
    queries: Iterable[Mapping[str, object]],
    *,
    role_matcher: RoleTitleMatchAdjudicator | None | object = _AUTO_ROLE_MATCHER,
) -> bool:
    """Return whether a title matches at least one exact or recall query spec."""

    materialized = list(queries)
    if not materialized:
        return True
    for item in materialized:
        kwargs = {
            "match_mode": str(item.get("match_mode") or "strict"),
            "target_track": str(item.get("target_track") or "") or None,
            "seniority_floor": str(item.get("seniority_floor") or "") or None,
        }
        if role_matcher is not _AUTO_ROLE_MATCHER:
            kwargs["role_matcher"] = role_matcher
        if title_matches_query(title, str(item.get("query") or ""), **kwargs):
            return True
    return False


def _recall_queries_for_roles(
    exact_queries: list[str],
    *,
    tracks: Iterable[str] = (),
    seniority: Iterable[str] = (),
    functions: Iterable[str] = (),
    specializations: Iterable[str] = (),
) -> list[dict[str, object]]:
    intents = _role_intents(exact_queries, tracks=tracks, seniority=seniority, functions=functions, specializations=specializations)
    candidates: list[dict[str, object]] = []
    for intent in intents:
        if not intent.track or not intent.domains:
            continue
        for query in _queries_for_intent(intent):
            candidates.append(
                {
                    "query": query,
                    "tier": 1,
                    "match_mode": RECALL_MATCH_MODE,
                    "generated_from": "target_roles",
                    "target_track": intent.track,
                    "seniority_floor": intent.seniority_floor or "",
                }
            )
    return _dedupe_recall_specs(candidates)


def _queries_for_intent(intent: _RoleIntent) -> list[str]:
    floor_rank = _seniority_rank(intent.seniority_floor)
    candidates: list[str] = []
    for domain in intent.domains:
        label = _domain_label(domain)
        if intent.track == "ic":
            ic_label = "Software" if domain == "engineering" else label
            for rank, seniority_label in ((3, "Senior"), (4, "Lead"), (5, "Staff"), (6, "Principal")):
                if rank >= floor_rank:
                    candidates.append(f"{seniority_label} {ic_label} Engineer")
            if floor_rank <= 6 and domain in {"platform", "technology"}:
                candidates.append(f"Principal {ic_label} Architect")
        elif intent.track == "management":
            management_label = "Engineering" if domain == "engineering" else f"{label} Engineering"
            if floor_rank <= 4:
                candidates.append(f"{management_label} Manager")
            if floor_rank <= 5:
                candidates.append(f"Senior {management_label} Manager")
            if floor_rank <= 6:
                candidates.extend([f"{label} Director", f"Head of {label}"])
        elif intent.track == "executive":
            if floor_rank <= 6:
                candidates.extend([f"{label} Director", f"Head of {label}"])
            if floor_rank <= 7:
                candidates.append(f"VP {label}")
            if floor_rank <= 8:
                candidates.extend(_chief_queries_for_domain(domain))
    return _dedupe_recall_queries(candidates)


def _structured_exact_queries(
    *,
    tracks: Iterable[str],
    seniority: Iterable[str],
    functions: Iterable[str],
) -> list[str]:
    track_values = [_normalize_track(item) for item in tracks]
    track_values = [item for item in track_values if item]
    seniority_values = [item for item in (_normalize_seniority(item) for item in seniority) if item]
    domains = _domains_from_values(functions)
    if not track_values or not domains:
        return []
    if not seniority_values:
        seniority_values = ["manager" if "management" in track_values else "senior"]

    queries: list[str] = []
    for track in track_values:
        for floor in seniority_values:
            intent = _RoleIntent(role="", track=track, seniority_floor=floor, domains=domains)
            queries.extend(_queries_for_intent(intent)[:2])
    return _dedupe_recall_queries(queries)


def _role_intents(
    exact_queries: list[str],
    *,
    tracks: Iterable[str],
    seniority: Iterable[str],
    functions: Iterable[str],
    specializations: Iterable[str],
) -> list[_RoleIntent]:
    track_values = [_normalize_track(item) for item in tracks]
    seniority_values = [_normalize_seniority(item) for item in seniority]
    shared_domains = _domains_from_values([*functions, *specializations])
    intents: list[_RoleIntent] = []
    for index, query in enumerate(exact_queries):
        tokens = _expanded_tokens([query])
        track = _value_at(track_values, index) or _classify_track(tokens)
        floor = _value_at(seniority_values, index) or _seniority_from_tokens(tokens)
        inferred_domains = _domains_from_tokens(tokens)
        if shared_domains:
            inferred_domains = [domain for domain in inferred_domains if domain in shared_domains] or list(shared_domains)
        domains = tuple(inferred_domains or shared_domains)
        intents.append(_RoleIntent(role=query, track=track, seniority_floor=floor, domains=domains))
    return intents


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


def _dedupe_recall_specs(values: Iterable[Mapping[str, object]]) -> list[dict[str, object]]:
    seen: set[tuple[str, str, str]] = set()
    result: list[dict[str, object]] = []
    for value in values:
        query = str(value.get("query") or "").strip()
        if not query:
            continue
        key = (
            _query_key(query),
            str(value.get("target_track") or ""),
            str(value.get("seniority_floor") or ""),
        )
        if key in seen:
            continue
        result.append(dict(value))
        seen.add(key)
    return result


def _source_aliases(source: str) -> set[str]:
    normalized = str(source or "").strip()
    aliases = {normalized}
    collapsed = normalized.replace("_", "")
    aliases.add(collapsed)
    if collapsed == "smartextract":
        aliases.update({"smart_extract", "smartextract"})
    return {alias for alias in aliases if alias}


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


def _value_at(values: Sequence[str | None], index: int) -> str | None:
    if index < len(values):
        return values[index]
    if len(values) == 1:
        return values[0]
    return None


def _normalize_track(value: object) -> str | None:
    normalized = str(value or "").strip().casefold().replace("-", "_")
    normalized = _TRACK_ALIASES.get(normalized, normalized)
    return normalized if normalized in _TRACKS else None


def _normalize_seniority(value: object) -> str | None:
    seniority_alias = _seniority_alias(value)
    if seniority_alias:
        return seniority_alias
    tokens = _expanded_tokens([str(value or "")])
    seniority = _seniority_from_tokens(tokens)
    if seniority:
        return seniority
    text = str(value or "").strip().casefold()
    return text or None


def _classify_track(tokens: set[str]) -> str | None:
    if tokens.intersection(_EXECUTIVE_TOKENS):
        return "executive"
    if tokens.intersection(_MANAGEMENT_TOKENS):
        return "management"
    if tokens.intersection(_IC_TOKENS):
        return "ic"
    return None


def _seniority_from_tokens(tokens: set[str]) -> str | None:
    if "senior" in tokens and "manager" in tokens:
        return "senior_manager"
    if "vice" in tokens and "president" in tokens:
        return "vp"
    ranked = sorted(
        ((rank, token) for token, rank in _SENIORITY_RANKS.items() if token in tokens),
        reverse=True,
    )
    if not ranked:
        return None
    rank, token = ranked[0]
    if rank <= 2 and tokens.intersection(_IC_TOKENS):
        return "engineer"
    return token


def _seniority_rank(value: str | None) -> int:
    if not value:
        return 0
    seniority_alias = _seniority_alias(value)
    if seniority_alias:
        return _SENIORITY_RANKS[seniority_alias]
    tokens = _expanded_tokens([value])
    if "vice" in tokens and "president" in tokens:
        return _SENIORITY_RANKS["vp"]
    if "senior" in tokens and "manager" in tokens:
        return _SENIORITY_RANKS["senior_manager"]
    return max((_SENIORITY_RANKS.get(token, 0) for token in tokens), default=0)


def _seniority_alias(value: object) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()
    if not normalized:
        return None
    return _SENIORITY_ALIASES.get(normalized) or _SENIORITY_ALIASES.get(normalized.replace(" ", ""))


def _domains_from_values(values: Iterable[object]) -> tuple[str, ...]:
    tokens = _expanded_tokens(str(value or "") for value in values)
    return tuple(_domains_from_tokens(tokens))


def _domains_from_tokens(tokens: set[str]) -> list[str]:
    domains: list[str] = []
    for domain, domain_tokens in _DOMAIN_KEYWORDS.items():
        if tokens.intersection(domain_tokens) and domain not in domains:
            domains.append(domain)
    if "engineering" in domains and set(domains).intersection({"ai", "backend", "data", "platform", "security"}):
        explicit_engineering = tokens.intersection({"engineer", "engineering", "software", "technical"})
        if not explicit_engineering:
            domains.remove("engineering")
    if "security" in domains and "technology" in domains:
        explicit_technology = tokens.intersection({"cio", "cto", "digital", "it", "systems", "technical", "technology"})
        if not explicit_technology:
            domains.remove("technology")
    if not domains and tokens.intersection(_ENGINEERING_TOKENS | _TECHNOLOGY_TOKENS):
        domains.append("engineering")
    return domains


def _domain_label(domain: str) -> str:
    labels = {
        "ai": "AI",
        "backend": "Backend",
        "data": "Data",
        "engineering": "Engineering",
        "platform": "Platform",
        "security": "Security",
        "technology": "Technology",
    }
    return labels.get(domain, domain.strip().title())


def _chief_queries_for_domain(domain: str) -> list[str]:
    if domain == "security":
        return ["CISO", "Chief Information Security Officer"]
    if domain in {"technology", "platform", "engineering", "backend", "ai", "data"}:
        return ["CTO", "Chief Technology Officer"]
    return [f"Chief {_domain_label(domain)} Officer"]
