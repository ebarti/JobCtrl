"""Literal public DTO adaptation, identity hashing and exact citation guards."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any

from jobctrl.app.errors import AppError

from .serialization import encoded


def fingerprint(value: Any) -> str:
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def dto(value: Any) -> dict:
    if isinstance(value, dict):
        return json.loads(encoded(value))
    return value.to_dict()


def fact_sources(profile: dict) -> list[dict]:
    result = []
    for source in profile["evidence_sources"]:
        if (not isinstance(source, dict) or not isinstance(source.get("source_id"), str)
                or not source["source_id"] or not isinstance(source.get("text"), str)
                or source.get("revision") in (None, "")):
            raise AppError("fit_profile_source_invalid", "The Profile factual sources cannot be bound.", 409)
        # Authority is a recorded approval state, never an inference about the
        # prose. Pending/rejected evidence stays inspectable in Profile but
        # cannot become candidate truth merely because a model cites it.
        if source.get("confirmation") not in {"authored", "confirmed"}:
            continue
        result.append({key: source[key] for key in (
            "source_id", "revision", "text", "confirmation", "kind", "origin", "provenance", "path",
            "role_id", "achievement_id", "evidence_id",
        ) if key in source})
    if len({source["source_id"] for source in result}) != len(result):
        raise AppError("fit_profile_source_invalid", "The Profile factual source IDs must be unique.", 409)
    return sorted(result, key=lambda row: row["source_id"])


class FitProfileSnapshot:
    """Profile's immutable public snapshot plus versioned user scoring guidance."""

    def __init__(self, profile_snapshot, guidance: str):
        self.profile_snapshot = profile_snapshot
        self.scoring_guidance = guidance

    def __getattr__(self, name):
        return getattr(self.profile_snapshot, name)

    def to_dict(self):
        profile = deepcopy(dto(self.profile_snapshot))
        profile["evidence_sources"].append({"source_id": "fit:score-criteria", "revision": fingerprint(self.scoring_guidance),
                                            "text": self.scoring_guidance, "kind": "user_scoring_guidance",
                                            "origin": "settings", "confirmation": "authored"})
        return profile


def achievements(profile: dict) -> dict[str, dict]:
    result = {}
    for role in profile["roles"]:
        for achievement in role["achievements"]:
            ident = achievement["achievement_id"]
            if ident in result:
                raise AppError("fit_profile_achievement_invalid", "Profile achievement IDs must be unique.", 409)
            result[ident] = {**achievement, "role_id": role["role_id"]}
    return result


def achievement_inventory(profile: dict) -> dict:
    return {ident: {"role_id": row["role_id"], "source_refs": row.get("source_refs", [])}
            for ident, row in sorted(achievements(profile).items())}


def fact_fingerprint(profile: dict, facts: list[dict] | None = None) -> str:
    return fingerprint({"sources": fact_sources(profile) if facts is None else facts,
                        "achievements": achievement_inventory(profile)})


def source_id(ref: str | dict) -> str:
    return ref if isinstance(ref, str) else ref["source_id"]


def requirement_source(requirement: dict) -> dict:
    # JSON is a literal complete definition/qualifier source, never lexical input
    # to a hand-written meaning classifier.
    text = encoded({
        "definition": requirement["definition"], "qualifiers": requirement.get("qualifiers", {}),
        "scope": requirement["scope"],
    })
    return {"source_id": "requirement", "revision": str(requirement["requirement_revision"]), "text": text}


def semantic_sources(requirement: dict, facts: list[dict]) -> list[dict]:
    return [requirement_source(requirement), *[
        {**source, "source_id": "evidence:" + source["source_id"]} for source in facts
    ]]


def validate_citations(citations, sources: list[dict], *, required_ids=()) -> None:
    index = {source["source_id"]: source["text"] for source in sources}
    if len(index) != len(sources):
        raise AppError("fit_source_binding_invalid", "The Fit source inventory is ambiguous.", 409)
    found = set()
    for citation in citations:
        value = citation.model_dump() if hasattr(citation, "model_dump") else citation
        ident, quote = value["source_id"], value["quote"]
        if ident not in index:
            raise AppError("fit_foreign_source_id", "The model referenced an unavailable source.", 422)
        if not quote.strip() or quote not in index[ident]:
            raise AppError("fit_non_verbatim_quote", "The model evidence does not match its exact source.", 422)
        found.add(ident)
    if not set(required_ids).issubset(found):
        raise AppError("fit_missing_source_citation", "The model did not cite the required canonical sources.", 422)


def evidence_refs(citations, facts: list[dict]) -> list[dict]:
    index = {"evidence:" + source["source_id"]: source for source in facts}
    return [{"source_id": index[cite.source_id]["source_id"], "revision": index[cite.source_id]["revision"],
             "quote": cite.quote} for cite in citations if cite.source_id in index]


def citations_still_bound(refs: list[dict], facts: list[dict]) -> bool:
    index = {source["source_id"]: source for source in facts}
    return all(ref["source_id"] in index and ref["quote"].strip()
               and ref["quote"] in index[ref["source_id"]]["text"] for ref in refs)


def approved_fingerprint(profile: dict) -> str:
    """Exact accepted expression inventory, excluding proposal bookkeeping."""
    return fingerprint(sorted(profile["approved_variants"], key=lambda row: row["variant_id"]))


class FrozenFitProfileSnapshot:
    """Durable Fit-owned copy of a public Profile snapshot and its guidance."""

    def __init__(self, value: dict, guidance: str, operation_id=None):
        self.refresh_operation_id = operation_id
        self._value = deepcopy(value)
        self.scoring_guidance = guidance
        self.manual_refresh = True
        for name in ("profile_id", "profile_revision", "fact_semantics_version", "fingerprint"):
            setattr(self, name, value[name])

    def to_dict(self):
        return deepcopy(self._value)
