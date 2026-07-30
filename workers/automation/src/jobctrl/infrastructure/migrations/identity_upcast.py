"""Migration-only upcast for root-level v6 event identity payload fields."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    JobIdMap,
)

EVENT_IDENTITY_VERSION = 1

_SINGULAR_FIELDS = {
    "jobUrl": "jobId",
    "jobKey": "jobId",
    "jobId": "jobId",
    "job_url": "job_id",
    "job_key": "job_id",
    "job_id": "job_id",
    "survivingJobUrl": "survivingJobId",
    "survivingJobKey": "survivingJobId",
    "survivingJobId": "survivingJobId",
    "surviving_job_url": "surviving_job_id",
    "surviving_job_key": "surviving_job_id",
    "surviving_job_id": "surviving_job_id",
}
_PLURAL_FIELDS = {
    "jobUrls": "jobIds",
    "jobKeys": "jobIds",
    "jobIds": "jobIds",
    "job_urls": "job_ids",
    "job_keys": "job_ids",
    "job_ids": "job_ids",
    "survivingJobUrls": "survivingJobIds",
    "survivingJobKeys": "survivingJobIds",
    "survivingJobIds": "survivingJobIds",
    "surviving_job_urls": "surviving_job_ids",
    "surviving_job_keys": "surviving_job_ids",
    "surviving_job_ids": "surviving_job_ids",
}
_PRIMARY_FIELDS = frozenset(
    {
        "jobId",
        "job_id",
        "survivingJobId",
        "surviving_job_id",
    }
)


class EventIdentityUpcastError(RuntimeError):
    """Raised when immutable event identity cannot be upcast safely."""


@dataclass(frozen=True)
class UpcastedEventIdentity:
    """Stable identity values for one copied v6 event row."""

    job_id: str | None
    payload_json: str | None
    entity_ref: object


def upcast_v6_event_identity(
    *,
    job_ids: JobIdMap,
    event_type: object,
    event_job_locator: object,
    payload_json: object,
    entity_kind: object,
    entity_ref: object,
) -> UpcastedEventIdentity:
    """Rewrite only root event identity fields using the copied-job authority."""
    column_job_id = _resolve_optional(job_ids, event_job_locator)
    rewritten_payload, payload_primary, payload_references = _upcast_payload(
        job_ids=job_ids,
        event_type=event_type,
        payload_json=payload_json,
    )
    entity_job_id = (
        _resolve_optional(job_ids, entity_ref)
        if entity_kind == "job" and entity_ref is not None
        else None
    )
    primary = {
        value
        for value in (*payload_primary, column_job_id, entity_job_id)
        if value is not None
    }
    if len(primary) > 1:
        raise EventIdentityUpcastError("event_job_identity_conflict")

    if primary:
        job_id = next(iter(primary))
    elif len(payload_references) == 1:
        job_id = next(iter(payload_references))
    else:
        job_id = None

    if entity_kind == "job":
        if job_id is None:
            raise EventIdentityUpcastError("event_job_identity_unresolved")
        rewritten_entity_ref = job_id if entity_ref is not None else None
    else:
        rewritten_entity_ref = entity_ref

    return UpcastedEventIdentity(
        job_id=job_id,
        payload_json=rewritten_payload,
        entity_ref=rewritten_entity_ref,
    )


def _upcast_payload(
    *,
    job_ids: JobIdMap,
    event_type: object,
    payload_json: object,
) -> tuple[str | None, tuple[str, ...], frozenset[str]]:
    if payload_json is None:
        return None, (), frozenset()
    try:
        decoded = json.loads(str(payload_json))
    except (TypeError, ValueError) as error:
        raise EventIdentityUpcastError("event_payload_invalid") from error
    if not isinstance(decoded, dict):
        # Non-object payloads have no root keys and are audit data unchanged.
        return str(payload_json), (), frozenset()

    normalized = _normalize_duplicate_link_payload(event_type, decoded)
    transformed: dict[str, Any] = {}
    primary: set[str] = set()
    references: set[str] = set()
    for key, value in normalized.items():
        output_key = _SINGULAR_FIELDS.get(key)
        if output_key is not None:
            output_value, resolved = _upcast_singular(job_ids, value)
        else:
            output_key = _PLURAL_FIELDS.get(key)
            if output_key is not None:
                output_value, resolved = _upcast_plural(job_ids, value)
            else:
                output_key = key
                output_value = value
                resolved = ()
        if output_key in transformed and transformed[output_key] != output_value:
            raise EventIdentityUpcastError("event_job_identity_conflict")
        transformed[output_key] = output_value
        references.update(resolved)
        if output_key in _PRIMARY_FIELDS:
            primary.update(resolved)

    return (
        json.dumps(transformed, separators=(",", ":"), sort_keys=True),
        tuple(sorted(primary)),
        frozenset(references),
    )


def _normalize_duplicate_link_payload(
    event_type: object,
    payload: dict[str, Any],
) -> dict[str, Any]:
    normalized = dict(payload)
    if event_type != "DuplicateJobLinkRejected":
        return normalized
    _rename_historical_candidate_locator(
        normalized,
        historical_key="candidateJobId",
        locator_key="candidatePostingUrl",
    )
    _rename_historical_candidate_locator(
        normalized,
        historical_key="candidate_job_id",
        locator_key="candidate_posting_url",
    )
    return normalized


def _rename_historical_candidate_locator(
    payload: dict[str, Any],
    *,
    historical_key: str,
    locator_key: str,
) -> None:
    if historical_key not in payload:
        return
    historical_value = payload[historical_key]
    if locator_key in payload and payload[locator_key] != historical_value:
        raise EventIdentityUpcastError("event_job_identity_conflict")
    payload[locator_key] = historical_value
    del payload[historical_key]


def _upcast_singular(
    job_ids: JobIdMap,
    value: object,
) -> tuple[str | None, tuple[str, ...]]:
    if value is None:
        return None, ()
    if not isinstance(value, str):
        raise EventIdentityUpcastError("event_job_identity_invalid")
    resolved = _resolve_required(job_ids, value)
    return resolved, (resolved,)


def _upcast_plural(
    job_ids: JobIdMap,
    value: object,
) -> tuple[list[str | None], tuple[str, ...]]:
    if not isinstance(value, list):
        raise EventIdentityUpcastError("event_job_identity_invalid")
    rewritten: list[str | None] = []
    references: list[str] = []
    for item in value:
        result, resolved = _upcast_singular(job_ids, item)
        rewritten.append(result)
        references.extend(resolved)
    return rewritten, tuple(references)


def _resolve_optional(job_ids: JobIdMap, value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise EventIdentityUpcastError("event_job_identity_invalid")
    return _resolve_required(job_ids, value)


def _resolve_required(job_ids: JobIdMap, locator: str) -> str:
    try:
        resolved = job_ids.resolve(tenant_id="local", locator=locator)
    except CandidateCopyError as error:
        raise EventIdentityUpcastError("event_job_identity_unresolved") from error
    if resolved is None:
        raise EventIdentityUpcastError("event_job_identity_invalid")
    return resolved


__all__ = [
    "EVENT_IDENTITY_VERSION",
    "EventIdentityUpcastError",
    "UpcastedEventIdentity",
    "upcast_v6_event_identity",
]
