"""Immutable published Profile language. No persistence or transport imports."""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
from typing import Any, Protocol
from copy import deepcopy


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def profile_identity(kind: str, *identifiers: Any) -> str:
    """Opaque IDs bind an explicit ordered tuple, never delimiter parsing."""
    return f"profile:{kind}:{fingerprint(list(identifiers))}"


def validate_transfer_bundle(bundle: dict) -> dict:
    if (not isinstance(bundle, dict) or bundle.get("format") != "jobctrl.profile-transfer.v1"
            or not isinstance(bundle.get("data"), dict) or bundle.get("sha256") != fingerprint(bundle["data"])):
        raise ValueError("The Profile transfer format or digest is invalid.")
    return deepcopy(bundle["data"])


@dataclass(frozen=True)
class SourceRef:
    source_id: str
    revision: int

    def to_dict(self) -> dict:
        return {"source_id": self.source_id, "revision": self.revision}

    @classmethod
    def from_dict(cls, value: dict) -> SourceRef:
        if (not isinstance(value, dict) or not isinstance(value.get("source_id"), str)
                or not value["source_id"] or type(value.get("revision")) is not int or value["revision"] < 1):
            raise ValueError("Invalid source reference.")
        return cls(value["source_id"], value["revision"])


@dataclass(frozen=True)
class ProfileSnapshot:
    profile_id: str
    profile_revision: int
    fact_semantics_version: int
    wording_revision: int
    fingerprint: str
    _payload_json: str = field(repr=False)

    def to_dict(self) -> dict:
        return json.loads(self._payload_json)

    def as_dict(self) -> dict:
        """Return only authored profile data for fact consumers."""
        return self.document

    @property
    def document(self) -> dict:
        return self.to_dict()["document"]

    @property
    def roles(self) -> tuple[dict, ...]:
        return tuple(self.to_dict()["roles"])

    @property
    def evidence_sources(self) -> tuple[dict, ...]:
        return tuple(self.to_dict()["evidence_sources"])

    @property
    def approved_variants(self) -> tuple[dict, ...]:
        return tuple(self.to_dict()["approved_variants"])

    @property
    def version(self) -> int:
        return self.profile_revision

    @property
    def profile_version(self) -> int:
        return self.profile_revision


@dataclass(frozen=True)
class AuthoringBrief:
    """An immutable request; origin metadata is opaque to Profile.

    The caller owns qualification and gives a persisted support receipt. Profile
    never discovers requirements, computes matches or changes factual fit.
    """

    origin_key: str
    profile_revision: int
    fact_semantics_version: int
    achievement_id: str
    evidence_refs: tuple[SourceRef, ...]
    support_receipt_id: str
    requested_expression: str
    origin_metadata_json: str = "{}"
    profile_id: str = "default"

    def to_dict(self) -> dict:
        return {
            "origin_key": self.origin_key, "profile_revision": self.profile_revision,
            "fact_semantics_version": self.fact_semantics_version, "achievement_id": self.achievement_id,
            "evidence_refs": [item.to_dict() for item in self.evidence_refs],
            "support_receipt_id": self.support_receipt_id, "requested_expression": self.requested_expression,
            "origin_metadata": json.loads(self.origin_metadata_json), "profile_id": self.profile_id,
        }

    @classmethod
    def from_dict(cls, value: dict) -> AuthoringBrief:
        required = ("origin_key", "achievement_id", "support_receipt_id", "requested_expression")
        if any(not isinstance(value.get(key), str) or not value[key].strip() for key in required):
            raise ValueError("An authoring brief requires its origin, achievement, support receipt and expression.")
        if any(type(value.get(key)) is not int or value[key] < 1
               for key in ("profile_revision", "fact_semantics_version")):
            raise ValueError("An authoring brief requires exact Profile revisions.")
        refs = value.get("evidence_refs")
        if not isinstance(refs, list) or not refs:
            raise ValueError("An authoring brief requires source references.")
        metadata = value.get("origin_metadata", {})
        if not isinstance(metadata, dict):
            raise ValueError("Origin metadata must be an object.")
        return cls(*(value[key] for key in ("origin_key", "profile_revision", "fact_semantics_version", "achievement_id")),
                   tuple(SourceRef.from_dict(item) for item in refs), value["support_receipt_id"],
                   value["requested_expression"], canonical(metadata), value.get("profile_id", "default"))


class SemanticPort(Protocol):
    async def determine(self, *, operation: str, instructions: str, sources: list[dict],
                        context: dict, response_schema: dict, prompt_version: str, lane: str) -> Any:
        """Return ModelResult(value, provenance); only this boundary decides meaning."""
        ...
