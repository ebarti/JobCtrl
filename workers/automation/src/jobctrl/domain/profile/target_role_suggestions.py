"""Evidence-backed target-role suggestions from a canonical ProfileSnapshot."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.domain.profile.snapshot import ProfileSnapshot


MAX_SUGGESTIONS = 5
MAX_PAYLOAD_CHARS = 12_000
MAX_OUTPUT_TOKENS = 900
_ADJACENT_DOMAINS = frozenset({
    "cloud", "data", "delivery", "engineering", "infrastructure", "operations", "platform",
    "product", "reliability", "security", "software",
})
_EVIDENCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_TITLE_WORD = re.compile(r"[a-z0-9]+")
_TITLE_STOP_WORDS = {
    "a", "an", "and", "chief", "director", "engineer", "engineering", "executive",
    "head", "lead", "leader", "manager", "management", "of", "officer", "principal",
    "senior", "sr", "staff", "the", "to", "vice", "vp",
}
_TRACK_TITLE_MARKERS = {
    "management": {"director", "head", "lead", "leader", "manager", "management", "vp"},
    "executive": {"ceo", "cfo", "chief", "cio", "ciso", "coo", "cto", "evp", "executive", "officer", "president", "svp", "vice", "vp"},
    "ic": {"architect", "developer", "engineer", "principal", "scientist", "specialist", "staff"},
}
_CANONICAL_SENIORITIES = {
    "junior", "mid", "senior", "staff", "principal", "manager",
    "senior_manager", "director", "vp", "svp", "c_level",
}


@dataclass(frozen=True)
class _EvidenceSupport:
    kind: str
    title: str
    tokens: frozenset[str]
    parent_experience_id: str = ""


@dataclass(frozen=True)
class TargetRoleSuggestion:
    title: str
    classification: str
    track: str
    seniority: str
    evidence_ids: tuple[str, ...]
    rationale: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "classification": self.classification,
            "track": self.track,
            "seniority": self.seniority,
            "evidenceIds": list(self.evidence_ids),
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class TargetPreferenceSuggestion:
    location: str
    work_model: str
    evidence_ids: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "location": self.location,
            "workModel": self.work_model,
            "evidenceIds": list(self.evidence_ids),
        }


@dataclass(frozen=True)
class TargetRoleSuggestionResult:
    profile_version: int
    suggestions: tuple[TargetRoleSuggestion, ...]
    strategy: str
    warnings: tuple[str, ...] = ()
    preference_suggestions: tuple[TargetPreferenceSuggestion, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "profileVersion": self.profile_version,
            "suggestions": [suggestion.as_dict() for suggestion in self.suggestions],
            "strategy": self.strategy,
            "warnings": list(self.warnings),
            "preferenceSuggestions": [item.as_dict() for item in self.preference_suggestions],
        }


def suggest_target_roles(
    snapshot: ProfileSnapshot,
    *,
    llm: LlmPort | None,
    maximum_suggestions: int = 3,
    allow_model: bool = True,
    fallback_warning: str = "spend_budget_exhausted",
) -> TargetRoleSuggestionResult:
    """Generate transient suggestions without changing the canonical profile."""

    maximum = max(1, min(MAX_SUGGESTIONS, int(maximum_suggestions)))
    payload, evidence_kinds = _build_minimized_payload(snapshot)
    tracks = tuple(payload["preferences"]["tracks"])
    seniorities = tuple(payload["preferences"]["seniorities"])
    existing_roles = {
        role.casefold() for role in payload["preferences"]["existingTargetRoles"]
    }
    preference_suggestions = _historical_preference_suggestions(snapshot)
    if not tracks or not seniorities:
        return TargetRoleSuggestionResult(
            profile_version=snapshot.version,
            suggestions=(),
            strategy="none",
            warnings=("authoritative_track_or_seniority_missing",),
            preference_suggestions=preference_suggestions,
        )
    if not allow_model or llm is None:
        suggestions = _deterministic_suggestions(
            payload,
            evidence_kinds,
            maximum=maximum,
            tracks=tracks,
            seniorities=seniorities,
            existing_roles=existing_roles,
        )
        return TargetRoleSuggestionResult(
            profile_version=snapshot.version,
            suggestions=suggestions,
            strategy="deterministic" if suggestions else "none",
            warnings=(fallback_warning,) if not allow_model else (),
            preference_suggestions=preference_suggestions,
        )

    try:
        response = llm.chat_json(
            [
                LlmMessage(
                    role="system",
                    content=(
                        "Suggest conservative target job titles from the supplied canonical evidence only. "
                        "Use only the listed evidence IDs, tracks, and seniorities. Do not infer career intent, "
                        "location, relocation, work model, compensation, identity, or unstated qualifications."
                    ),
                ),
                LlmMessage(
                    role="user",
                    content=json.dumps(
                        {"maximumSuggestions": maximum, "canonicalProfileEvidence": payload},
                        separators=(",", ":"),
                        ensure_ascii=True,
                    ),
                ),
            ],
            response_schema=_provider_response_schema(maximum),
            temperature=0.0,
            max_tokens=MAX_OUTPUT_TOKENS,
            thinking_budget=0,
        )
        suggestions = _validate_model_response(
            response,
            maximum=maximum,
            evidence_kinds=evidence_kinds,
            tracks=tracks,
            seniorities=seniorities,
            existing_roles=existing_roles,
        )
        return TargetRoleSuggestionResult(
            profile_version=snapshot.version,
            suggestions=suggestions,
            strategy="model" if suggestions else "none",
            preference_suggestions=preference_suggestions,
        )
    except Exception:  # noqa: BLE001 - provider failures fail closed to a canonical fallback
        suggestions = _deterministic_suggestions(
            payload,
            evidence_kinds,
            maximum=maximum,
            tracks=tracks,
            seniorities=seniorities,
            existing_roles=existing_roles,
        )
        return TargetRoleSuggestionResult(
            profile_version=snapshot.version,
            suggestions=suggestions,
            strategy="deterministic" if suggestions else "none",
            warnings=("model_unavailable_or_invalid",),
            preference_suggestions=preference_suggestions,
        )


def _build_minimized_payload(
    snapshot: ProfileSnapshot,
) -> tuple[dict[str, Any], dict[str, _EvidenceSupport]]:
    data = snapshot.as_dict()
    experience_preferences = _record(data.get("experience"))
    resume = _record(data.get("resume"))
    existing_roles = _split_values(experience_preferences.get("target_role"))
    tracks = _split_values(experience_preferences.get("target_track"))
    seniorities = _split_values(experience_preferences.get("target_seniority_floor"))
    evidence_support: dict[str, _EvidenceSupport] = {}
    experiences: list[dict[str, Any]] = []
    achievements: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []

    for entry in _records(resume.get("experience_entries"))[:8]:
        entry_id = _text(entry.get("id"), 100)
        title = _text(entry.get("title"), 120)
        evidence_id = f"experience:{entry_id}"
        if entry_id and title and _EVIDENCE_ID.fullmatch(evidence_id):
            experiences.append(
                {
                    "evidenceId": evidence_id,
                    "title": title,
                    "dateRange": _text(entry.get("date_range"), 80),
                }
            )
            evidence_support[evidence_id] = _EvidenceSupport(
                kind="experience",
                title=title,
                tokens=frozenset(_title_tokens(title)),
                parent_experience_id=evidence_id,
            )
        for item in _records(entry.get("achievement_evidence")):
            evidence_id = _text(item.get("id"), 160)
            if not _EVIDENCE_ID.fullmatch(evidence_id):
                continue
            achievements.append(
                {
                    "evidenceId": evidence_id,
                    "action": _text(item.get("action") or item.get("source_text"), 160),
                    "outcome": _text(item.get("outcome"), 160),
                    "metrics": [_text(value, 80) for value in _strings(item.get("metrics"))[:4]],
                    "senioritySignal": _text(item.get("seniority_signal"), 100),
                    "skills": [_text(value, 80) for value in _strings(item.get("tools"))[:6]],
                }
            )
            evidence_support[evidence_id] = _EvidenceSupport(
                kind="achievement",
                title="",
                tokens=frozenset(
                    _title_tokens(
                        " ".join(
                            [
                                str(item.get("action") or item.get("source_text") or ""),
                                str(item.get("outcome") or ""),
                                str(item.get("seniority_signal") or ""),
                                *[str(value) for value in _strings(item.get("tools"))[:6]],
                            ]
                        )
                    )
                ),
                parent_experience_id=f"experience:{entry_id}",
            )
            if len(achievements) >= 20:
                break
        if len(achievements) >= 20:
            break

    for category in _records(resume.get("skill_categories"))[:12]:
        category_id = _text(category.get("id"), 80)
        for index, item in enumerate(_strings(category.get("items"))[:12], start=1):
            evidence_id = f"profile:{snapshot.version}:skill:{category_id}:{index}"
            if not category_id or not _EVIDENCE_ID.fullmatch(evidence_id):
                continue
            skills.append(
                {
                    "evidenceId": evidence_id,
                    "category": _text(category.get("label"), 80),
                    "skill": _text(item, 100),
                }
            )
            evidence_support[evidence_id] = _EvidenceSupport(
                kind="skill",
                title="",
                tokens=frozenset(_title_tokens(f"{category.get('label', '')} {item}")),
            )
            if len(skills) >= 32:
                break
        if len(skills) >= 32:
            break

    payload = {
        "profileVersion": snapshot.version,
        "preferences": {
            "existingTargetRoles": existing_roles,
            "tracks": tracks,
            "seniorities": seniorities,
        },
        "experience": experiences,
        "achievements": achievements,
        "skills": skills,
    }
    while len(json.dumps(payload, separators=(",", ":"), ensure_ascii=True)) > MAX_PAYLOAD_CHARS:
        for key in ("skills", "achievements", "experience"):
            values = payload[key]
            if values:
                removed = values.pop()
                evidence_support.pop(removed["evidenceId"], None)
                break
        else:
            break
    return payload, evidence_support


def _validate_model_response(
    response: dict[str, Any],
    *,
    maximum: int,
    evidence_kinds: dict[str, _EvidenceSupport],
    tracks: tuple[str, ...],
    seniorities: tuple[str, ...],
    existing_roles: set[str],
) -> tuple[TargetRoleSuggestion, ...]:
    raw_suggestions = response.get("suggestions")
    if not isinstance(raw_suggestions, list) or len(raw_suggestions) > maximum:
        raise ValueError("invalid suggestion count")
    normalized_tracks = {value.casefold(): value for value in tracks}
    normalized_seniorities = {value.casefold(): value for value in seniorities}
    seen = set(existing_roles)
    suggestions: list[TargetRoleSuggestion] = []
    for raw in raw_suggestions:
        if not isinstance(raw, dict):
            raise ValueError("invalid suggestion")
        title = _required_clean_text(raw.get("title"), 100)
        classification = str(raw.get("classification") or "")
        if classification not in {"direct", "adjacent"}:
            raise ValueError("invalid classification")
        track = normalized_tracks.get(str(raw.get("track") or "").strip().casefold())
        seniority = normalized_seniorities.get(
            str(raw.get("seniority") or "").strip().casefold()
        )
        if not track or not seniority:
            raise ValueError("unsupported track or seniority")
        raw_evidence = raw.get("evidenceIds")
        if not isinstance(raw_evidence, list):
            raise ValueError("invalid evidence list")
        evidence_ids = tuple(dict.fromkeys(str(value).strip() for value in raw_evidence))
        if not 1 <= len(evidence_ids) <= 8 or any(
            evidence_id not in evidence_kinds for evidence_id in evidence_ids
        ):
            raise ValueError("unknown evidence id")
        if classification == "adjacent" and len(evidence_ids) < 2:
            raise ValueError("adjacent suggestion needs multiple evidence references")
        cited_evidence = tuple(evidence_kinds[evidence_id] for evidence_id in evidence_ids)
        if not _role_is_supported(
            title,
            classification=classification,
            track=track,
            seniority=seniority,
            evidence=cited_evidence,
        ):
            raise ValueError("unsupported role title or evidence")
        _required_clean_text(raw.get("rationale"), 240)
        rationale = (
            "Matches the cited canonical experience title."
            if classification == "direct"
            else "The cited experience and independent evidence support the title wording."
        )
        normalized_title = title.casefold()
        if normalized_title in seen:
            continue
        seen.add(normalized_title)
        suggestions.append(
            TargetRoleSuggestion(
                title=title,
                classification=classification,
                track=track,
                seniority=seniority,
                evidence_ids=evidence_ids,
                rationale=rationale,
            )
        )
    return tuple(suggestions)


def _deterministic_suggestions(
    payload: dict[str, Any],
    evidence_kinds: dict[str, _EvidenceSupport],
    *,
    maximum: int,
    tracks: tuple[str, ...],
    seniorities: tuple[str, ...],
    existing_roles: set[str],
) -> tuple[TargetRoleSuggestion, ...]:
    suggestions: list[TargetRoleSuggestion] = []
    seen = set(existing_roles)
    for entry in payload["experience"]:
        title = str(entry["title"])
        evidence_id = str(entry["evidenceId"])
        support = evidence_kinds.get(evidence_id)
        if support is None or support.kind != "experience":
            continue
        matched = next(
            (
                (track, seniority)
                for track in tracks
                for seniority in seniorities
                if _role_is_supported(
                    title,
                    classification="direct",
                    track=track,
                    seniority=seniority,
                    evidence=(support,),
                )
            ),
            None,
        )
        if matched is None:
            continue
        track, seniority = matched
        if title.casefold() not in seen:
            seen.add(title.casefold())
            suggestions.append(TargetRoleSuggestion(
                title=title,
                classification="direct",
                track=track,
                seniority=seniority,
                evidence_ids=(evidence_id,),
                rationale="Matches a saved experience title and the saved target preferences.",
            ))
        if len(suggestions) >= maximum:
            break
        # Only a cited achievement under this exact experience may supply a
        # new domain modifier. A skill alone cannot imply a career direction.
        for achievement in payload["achievements"]:
            achievement_id = str(achievement["evidenceId"])
            achievement_support = evidence_kinds.get(achievement_id)
            if (
                achievement_support is None
                or achievement_support.kind != "achievement"
                or achievement_support.parent_experience_id != evidence_id
            ):
                continue
            novel = sorted((achievement_support.tokens & _ADJACENT_DOMAINS) - support.tokens)
            for modifier in novel:
                replaceable = [
                    token for token in _TITLE_WORD.findall(title.casefold())
                    if token in support.tokens & _ADJACENT_DOMAINS
                ]
                for old in replaceable[-1:]:
                    candidate = re.sub(
                        rf"\b{re.escape(old)}\b", modifier.title(), title,
                        count=1, flags=re.IGNORECASE,
                    )
                    if candidate.casefold() in seen or not _role_is_supported(
                        candidate,
                        classification="adjacent",
                        track=track,
                        seniority=seniority,
                        evidence=(support, achievement_support),
                    ):
                        continue
                    seen.add(candidate.casefold())
                    suggestions.append(TargetRoleSuggestion(
                        title=candidate,
                        classification="adjacent",
                        track=track,
                        seniority=seniority,
                        evidence_ids=(evidence_id, achievement_id),
                        rationale=(
                            "Combines the saved experience title with a domain "
                            "named in its achievement evidence."
                        ),
                    ))
                    if len(suggestions) >= maximum:
                        return tuple(suggestions)
    return tuple(suggestions)


def _historical_preference_suggestions(
    snapshot: ProfileSnapshot,
) -> tuple[TargetPreferenceSuggestion, ...]:
    resume = _record(snapshot.as_dict().get("resume"))
    result: list[TargetPreferenceSuggestion] = []
    seen: set[tuple[str, str]] = set()
    for entry in _records(resume.get("experience_entries"))[:8]:
        entry_id = _text(entry.get("id"), 100)
        evidence_id = f"experience:{entry_id}"
        if not entry_id or not _EVIDENCE_ID.fullmatch(evidence_id):
            continue
        raw = _text(entry.get("location"), 120)
        if not raw or re.search(
            r"\b(?:not|never|various|multiple|anywhere|worldwide|or|and|near|around|"
            r"based|headquarters|hq|office|offices|region|area|relocat\w*|company)\b",
            raw, re.I,
        ):
            continue
        pieces = [part.strip() for part in raw.split("|")]
        if len(pieces) > 2:
            continue
        marker = pieces[-1].casefold()
        work_model = {"remote": "Remote", "hybrid": "Hybrid", "on-site": "On-site"}.get(marker, "")
        location = pieces[0] if len(pieces) == 1 or work_model else ""
        if len(pieces) == 2 and not work_model:
            continue
        if location.casefold() in {"remote", "hybrid", "on-site"}:
            location = ""
        if location and re.search(r"\b(?:remote|hybrid|on-site|onsite)\b", location, re.I):
            continue
        if location and re.search(r"\b(?:in|at|from)\b", location, re.I):
            continue
        # No guesses from prose, mixed model labels, addresses, or employer HQ.
        if location and (len(location) > 100 or not re.fullmatch(r"[^\W\d_][\w ,.'-]*", location, re.UNICODE)):
            continue
        if not location and not work_model:
            continue
        key = (location.casefold(), work_model.casefold())
        if key in seen:
            continue
        seen.add(key)
        result.append(TargetPreferenceSuggestion(location, work_model, (evidence_id,)))
        if len(result) >= MAX_SUGGESTIONS:
            break
    return tuple(result)


def _role_is_supported(
    title: str,
    *,
    classification: str,
    track: str,
    seniority: str,
    evidence: tuple[_EvidenceSupport, ...],
) -> bool:
    title_tokens = _title_tokens(title)
    if not _title_matches_track(title_tokens, track):
        return False
    normalized_seniority = _canonical_seniority(seniority)
    if normalized_seniority is None or _title_seniority(title_tokens) != normalized_seniority:
        return False
    supported_tokens = set().union(*(item.tokens for item in evidence))
    if not _evidence_matches_track(supported_tokens, track):
        return False
    experience = tuple(item for item in evidence if item.kind == "experience")
    if not experience:
        return False
    if not any(
        _title_seniority(item.tokens) == normalized_seniority for item in experience
    ):
        return False
    if any(
        item.kind == "achievement"
        and item.parent_experience_id not in {
            entry.parent_experience_id for entry in experience
        }
        for item in evidence
    ):
        return False
    normalized_title = " ".join(title.casefold().split())
    if classification == "direct":
        return any(" ".join(item.title.casefold().split()) == normalized_title for item in experience)
    if classification != "adjacent" or len(evidence) < 2:
        return False
    if not any(item.kind in {"achievement", "skill"} for item in evidence):
        return False
    domain_tokens = title_tokens - _TITLE_STOP_WORDS
    if not domain_tokens:
        return False
    experience_tokens = set().union(*(item.tokens for item in experience))
    secondary_tokens = set().union(*(
        item.tokens for item in evidence if item.kind in {"achievement", "skill"}
    ))
    return domain_tokens <= supported_tokens and bool((domain_tokens - experience_tokens) & secondary_tokens)


def _title_matches_track(title_tokens: set[str], track: str) -> bool:
    normalized = " ".join(track.casefold().split())
    if normalized in {"individual contributor", "individual-contributor"}:
        normalized = "ic"
    markers = _TRACK_TITLE_MARKERS.get(normalized)
    if markers is None:
        markers = _title_tokens(track)
    return bool(title_tokens & markers)


def _canonical_seniority(value: str) -> str | None:
    normalized = re.sub(r"[\s-]+", "_", value.casefold().strip())
    aliases = {
        "vice_president": "vp", "executive": "c_level", "c_suite": "c_level",
    }
    canonical = aliases.get(normalized, normalized)
    return canonical if canonical in _CANONICAL_SENIORITIES else None


def _title_seniority(tokens: set[str] | frozenset[str]) -> str | None:
    executive = bool(tokens & {"ceo", "cfo", "chief", "cio", "ciso", "coo", "cto"})
    vice = bool(tokens & {"vp", "svp", "evp"}) or {"vice", "president"} <= tokens
    management = bool(tokens & {"manager", "director", "head"})
    ic_level = bool(tokens & {"staff", "principal", "architect"})
    if sum((executive, vice, management, ic_level)) > 1:
        return None
    if executive:
        return "c_level"
    if vice:
        return "svp" if tokens & {"svp", "evp", "senior", "executive"} else "vp"
    if "director" in tokens:
        return "director" if "senior" not in tokens else None
    if "head" in tokens:
        return "senior_manager" if "senior" not in tokens else None
    if "manager" in tokens:
        return "senior_manager" if tokens & {"senior", "sr"} else "manager"
    if ic_level:
        if "principal" in tokens or "architect" in tokens:
            return "principal" if "staff" not in tokens else None
        return "staff"
    if tokens & {"senior", "sr"}:
        return "senior"
    if tokens & {"junior", "entry", "associate"}:
        return "junior"
    if tokens & {"engineer", "developer", "scientist", "specialist", "mid"}:
        return "mid"
    return None


def _evidence_matches_track(evidence_tokens: set[str], track: str) -> bool:
    normalized = " ".join(track.casefold().split())
    if normalized in {"individual contributor", "individual-contributor"}:
        normalized = "ic"
    markers = _TRACK_TITLE_MARKERS.get(normalized, _title_tokens(track))
    return bool(evidence_tokens & markers)


def _title_tokens(value: str) -> set[str]:
    return set(_TITLE_WORD.findall(value.casefold()))


def _provider_response_schema(maximum: int) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["suggestions"],
        "properties": {
            "suggestions": {
                "type": "array",
                "maxItems": maximum,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "title",
                        "classification",
                        "track",
                        "seniority",
                        "evidenceIds",
                        "rationale",
                    ],
                    "properties": {
                        "title": {"type": "string", "maxLength": 100},
                        "classification": {"type": "string", "enum": ["direct", "adjacent"]},
                        "track": {"type": "string", "maxLength": 60},
                        "seniority": {"type": "string", "maxLength": 60},
                        "evidenceIds": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 8,
                            "items": {"type": "string", "maxLength": 160},
                        },
                        "rationale": {"type": "string", "maxLength": 240},
                    },
                },
            }
        },
    }


def _split_values(value: Any) -> list[str]:
    return list(
        dict.fromkeys(
            item.strip()
            for item in re.split(r"[;,\n]", str(value or ""))
            if item.strip()
        )
    )


def _required_clean_text(value: Any, maximum: int) -> str:
    text = str(value or "").strip()
    if not text or len(text) > maximum or any(ord(char) < 32 for char in text):
        raise ValueError("invalid text")
    if "http://" in text.casefold() or "https://" in text.casefold():
        raise ValueError("unexpected URL")
    return text


def _text(value: Any, maximum: int) -> str:
    return " ".join(str(value or "").split())[:maximum]


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _records(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str) and item.strip()] if isinstance(value, list) else []
