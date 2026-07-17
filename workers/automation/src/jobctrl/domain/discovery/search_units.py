"""Caller-owned discovery search units and fencing value objects."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef


DiscoverySearchUnitState = Literal[
    "pending",
    "running",
    "completed",
    "skipped",
    "failed",
    "canceled",
]

DISCOVERY_SEARCH_UNIT_STATES: tuple[DiscoverySearchUnitState, ...] = (
    "pending",
    "running",
    "completed",
    "skipped",
    "failed",
    "canceled",
)

_SAFE_BOARD = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SAFE_UNIT_ID = re.compile(r"^search-[0-9]{4}-[a-f0-9]{16}$")


@dataclass(frozen=True, slots=True)
class DiscoverySearchSpec:
    """Immutable JobCtrl plan for one provider stream.

    ``provider_location`` is what JobStreaming receives. ``target_location``
    remains the user's original search location and owns post-fetch filtering;
    they differ for Glassdoor's simplified location syntax.
    """

    query: str
    provider_location: str
    target_location: str
    sites: tuple[str, ...]
    results_per_site: int
    hours_old: int | None
    remote_only: bool
    country_indeed: str
    linkedin_fetch_description: bool = False
    match_mode: str = "strict"
    target_track: str = ""
    seniority_floor: str = ""
    accept_locations: tuple[str, ...] = ()
    reject_locations: tuple[str, ...] = ()
    local_accept_locations: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name, value in (
            ("query", self.query),
            ("provider_location", self.provider_location),
            ("target_location", self.target_location),
            ("country_indeed", self.country_indeed),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")
        if not self.sites:
            raise ValueError("sites must contain at least one board")
        if len(set(self.sites)) != len(self.sites):
            raise ValueError("sites must be unique")
        invalid_sites = [site for site in self.sites if not _SAFE_BOARD.fullmatch(site)]
        if invalid_sites:
            raise ValueError(f"invalid board name: {invalid_sites[0]}")
        if self.results_per_site < 1:
            raise ValueError("results_per_site must be positive")
        if self.hours_old is not None and self.hours_old < 1:
            raise ValueError("hours_old must be positive when supplied")
        if self.match_mode not in {"strict", "recall"}:
            raise ValueError("match_mode must be strict or recall")

    def to_payload(self) -> dict[str, Any]:
        """Return the canonical JSON-compatible plan payload."""

        return {
            "schema_version": 1,
            "query": self.query,
            "provider_location": self.provider_location,
            "target_location": self.target_location,
            "sites": list(self.sites),
            "results_per_site": self.results_per_site,
            "hours_old": self.hours_old,
            "remote_only": self.remote_only,
            "country_indeed": self.country_indeed,
            "linkedin_fetch_description": self.linkedin_fetch_description,
            "match_mode": self.match_mode,
            "target_track": self.target_track,
            "seniority_floor": self.seniority_floor,
            "accept_locations": list(self.accept_locations),
            "reject_locations": list(self.reject_locations),
            "local_accept_locations": list(self.local_accept_locations),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_payload(), sort_keys=True, separators=(",", ":"))

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json().encode("utf-8")).hexdigest()

    @classmethod
    def from_json(cls, payload: str) -> DiscoverySearchSpec:
        decoded = json.loads(payload)
        if not isinstance(decoded, dict) or decoded.get("schema_version") != 1:
            raise ValueError("unsupported discovery search spec schema")
        return cls(
            query=str(decoded.get("query") or ""),
            provider_location=str(decoded.get("provider_location") or ""),
            target_location=str(decoded.get("target_location") or ""),
            sites=tuple(str(site) for site in decoded.get("sites") or ()),
            results_per_site=int(decoded.get("results_per_site") or 0),
            hours_old=(int(decoded["hours_old"]) if decoded.get("hours_old") is not None else None),
            remote_only=bool(decoded.get("remote_only", False)),
            country_indeed=str(decoded.get("country_indeed") or ""),
            linkedin_fetch_description=bool(decoded.get("linkedin_fetch_description", False)),
            match_mode=str(decoded.get("match_mode") or "strict"),
            target_track=str(decoded.get("target_track") or ""),
            seniority_floor=str(decoded.get("seniority_floor") or ""),
            accept_locations=tuple(str(value) for value in decoded.get("accept_locations") or ()),
            reject_locations=tuple(str(value) for value in decoded.get("reject_locations") or ()),
            local_accept_locations=tuple(str(value) for value in decoded.get("local_accept_locations") or ()),
        )


@dataclass(frozen=True, slots=True)
class DiscoverySearchUnit:
    execution: DiscoveryExecutionRef
    unit_id: str
    ordinal: int
    spec: DiscoverySearchSpec
    request_fingerprint: str
    state: DiscoverySearchUnitState
    lease_owner: str | None
    lease_attempt: int
    lease_epoch: int
    recovery_count: int
    checkpoint_revision: int | None
    accepted_jobs: int
    new_jobs: int
    last_error_code: str | None
    last_error_type: str | None
    last_error_retryable: bool | None
    reset_checkpoint: bool
    reset_checkpoint_after_revision: int | None
    created_at: str
    updated_at: str
    completed_at: str | None

    @property
    def existing_jobs(self) -> int:
        return self.accepted_jobs - self.new_jobs

    @property
    def recovered(self) -> bool:
        return self.recovery_count > 0


@dataclass(frozen=True, slots=True)
class DiscoverySearchUnitLease:
    execution: DiscoveryExecutionRef
    unit_id: str
    owner_token: str
    attempt: int
    epoch: int

    def __post_init__(self) -> None:
        validate_unit_id(self.unit_id)
        if not self.owner_token.strip():
            raise ValueError("owner_token must be non-empty")
        if self.attempt < 1:
            raise ValueError("attempt must be positive")
        if self.epoch < 1:
            raise ValueError("epoch must be positive")


def search_unit_id(ordinal: int, spec: DiscoverySearchSpec) -> str:
    if ordinal < 0 or ordinal > 9999:
        raise ValueError("ordinal must be between 0 and 9999")
    return f"search-{ordinal:04d}-{spec.fingerprint()[:16]}"


def validate_unit_id(value: str) -> str:
    if not _SAFE_UNIT_ID.fullmatch(value):
        raise ValueError("invalid discovery search unit id")
    return value


def validate_search_unit_state(value: str) -> DiscoverySearchUnitState:
    if value not in DISCOVERY_SEARCH_UNIT_STATES:
        raise ValueError(f"unknown discovery search unit state: {value}")
    return value  # type: ignore[return-value]
