"""Migration-only root-event JobId upcast for the v6-to-v7 cutover.

Historical event payloads are audit data.  Only root-level identity fields are
rewritten; values nested under unrelated payload keys remain opaque and are
preserved exactly when the event row is reconstructed.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping

EVENT_IDENTITY_UPCAST_VERSION = 1

_SINGLE_FIELDS = {
    "jobId": "jobId",
    "jobUrl": "jobId",
    "jobKey": "jobId",
    "job_id": "job_id",
    "job_url": "job_id",
    "job_key": "job_id",
    "candidateJobId": "candidateJobId",
    "candidate_job_id": "candidate_job_id",
    "survivingJobId": "survivingJobId",
    "surviving_job_id": "surviving_job_id",
}
_PLURAL_FIELDS = {
    "jobIds": "jobIds",
    "jobUrls": "jobIds",
    "jobKeys": "jobIds",
    "job_ids": "job_ids",
    "job_urls": "job_ids",
    "job_keys": "job_ids",
}
_ROOT_PRIMARY_FIELDS = (
    "jobId",
    "job_id",
    "survivingJobId",
    "surviving_job_id",
)
_NON_JOB_SCOPE_REFERENCES = frozenset({"pipeline"})


class EventIdentityUpcastError(RuntimeError):
    """Bounded failure that never includes a raw job locator."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class UpcastedEventIdentity:
    version: int
    job_id: str | None
    referenced_job_ids: tuple[str, ...]
    payload: dict[str, Any]


def upcast_v6_event_identity(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    event_type: str | None = None,
    event_job_reference: str | None,
    payload: Mapping[str, Any],
) -> UpcastedEventIdentity:
    """Return the v7 identity view of one immutable v6 event row."""
    normalized_tenant = str(tenant_id or "").strip()
    if not normalized_tenant or not isinstance(payload, Mapping):
        raise EventIdentityUpcastError("event_job_identity_invalid")

    referenced: set[str] = set()
    column_job_id = (
        _resolve_reference(
            conn,
            tenant_id=normalized_tenant,
            reference=event_job_reference,
        )
        if event_job_reference is not None
        else None
    )
    if column_job_id is not None:
        referenced.add(column_job_id)

    transformed = _upcast_root_payload(
        conn,
        tenant_id=normalized_tenant,
        payload=_normalize_root_payload(event_type, payload),
        referenced=referenced,
    )
    root_job_ids = {
        value
        for key in _ROOT_PRIMARY_FIELDS
        if isinstance((value := transformed.get(key)), str)
        and value not in _NON_JOB_SCOPE_REFERENCES
    }
    primary_job_ids = set(root_job_ids)
    if column_job_id is not None:
        primary_job_ids.add(column_job_id)
    if len(primary_job_ids) > 1:
        raise EventIdentityUpcastError("event_job_identity_conflict")

    if column_job_id is not None:
        inferred_job_id = column_job_id
    elif len(root_job_ids) == 1:
        inferred_job_id = next(iter(root_job_ids))
    elif len(inferable_job_ids := _root_payload_job_ids(transformed)) == 1:
        inferred_job_id = next(iter(inferable_job_ids))
    else:
        inferred_job_id = None
    return UpcastedEventIdentity(
        version=EVENT_IDENTITY_UPCAST_VERSION,
        job_id=inferred_job_id,
        referenced_job_ids=tuple(sorted(referenced)),
        payload=transformed,
    )


def _normalize_root_payload(
    event_type: str | None,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    normalized = dict(payload)
    if event_type != "DuplicateJobLinkRejected":
        return normalized
    _rename_root_posting_locator(
        normalized,
        historical_key="candidateJobId",
        current_key="candidatePostingUrl",
    )
    _rename_root_posting_locator(
        normalized,
        historical_key="candidate_job_id",
        current_key="candidate_posting_url",
    )
    return normalized


def _rename_root_posting_locator(
    payload: dict[str, Any],
    *,
    historical_key: str,
    current_key: str,
) -> None:
    if historical_key not in payload:
        return
    historical_value = payload[historical_key]
    if current_key in payload and payload[current_key] != historical_value:
        raise EventIdentityUpcastError("event_job_identity_conflict")
    payload[current_key] = historical_value
    del payload[historical_key]


def _upcast_root_payload(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    payload: Mapping[str, Any],
    referenced: set[str],
) -> dict[str, Any]:
    transformed: dict[str, Any] = {}
    for raw_key, raw_value in payload.items():
        key = str(raw_key)
        if key in _SINGLE_FIELDS:
            output_key = _SINGLE_FIELDS[key]
            output_value = _upcast_single_reference(
                conn,
                tenant_id=tenant_id,
                value=raw_value,
                referenced=referenced,
            )
        elif key in _PLURAL_FIELDS:
            output_key = _PLURAL_FIELDS[key]
            output_value = _upcast_reference_collection(
                conn,
                tenant_id=tenant_id,
                value=raw_value,
                referenced=referenced,
            )
        else:
            output_key = key
            output_value = raw_value
        if output_key in transformed and transformed[output_key] != output_value:
            raise EventIdentityUpcastError("event_job_identity_conflict")
        transformed[output_key] = output_value
    return transformed


def _upcast_single_reference(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    value: Any,
    referenced: set[str],
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise EventIdentityUpcastError("event_job_identity_invalid")
    if value.strip() in _NON_JOB_SCOPE_REFERENCES:
        return value.strip()
    job_id = _resolve_reference(conn, tenant_id=tenant_id, reference=value)
    referenced.add(job_id)
    return job_id


def _upcast_reference_collection(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    value: Any,
    referenced: set[str],
) -> list[str | None]:
    if not isinstance(value, list):
        raise EventIdentityUpcastError("event_job_identity_invalid")
    return [
        _upcast_single_reference(
            conn,
            tenant_id=tenant_id,
            value=item,
            referenced=referenced,
        )
        for item in value
    ]


def _resolve_reference(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    reference: str | None,
) -> str:
    normalized = str(reference or "").strip()
    if not normalized:
        raise EventIdentityUpcastError("event_job_identity_invalid")

    direct_url = _job_id_from_query(
        conn,
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ?",
        (tenant_id, normalized),
    )
    alias_url = _job_id_from_query(
        conn,
        """
        SELECT jobs.job_id
        FROM job_identity_aliases AS aliases
        JOIN jobs
          ON jobs.tenant_id = aliases.tenant_id
         AND jobs.job_id = aliases.job_id
        WHERE aliases.tenant_id = ?
          AND aliases.alias_kind = 'posting_url'
          AND aliases.alias_value = ?
        """,
        (tenant_id, normalized),
    )
    if direct_url is not None and alias_url is not None and direct_url != alias_url:
        raise EventIdentityUpcastError("event_job_identity_conflict")
    if direct_url is not None or alias_url is not None:
        return direct_url or alias_url  # type: ignore[return-value]

    stable_job_id = _job_id_from_query(
        conn,
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND job_id = ?",
        (tenant_id, normalized),
    )
    if stable_job_id is None:
        raise EventIdentityUpcastError("event_job_identity_unresolved")
    return stable_job_id


def _job_id_from_query(
    conn: sqlite3.Connection,
    sql: str,
    params: tuple[str, str],
) -> str | None:
    row = conn.execute(sql, params).fetchone()
    if row is None:
        return None
    value = row["job_id"] if isinstance(row, sqlite3.Row) else row[0]
    normalized = str(value or "").strip()
    if not normalized:
        raise EventIdentityUpcastError("event_job_identity_invalid")
    return normalized


def _root_payload_job_ids(payload: Mapping[str, Any]) -> set[str]:
    inferred: set[str] = set()
    for key, value in payload.items():
        if key in {"jobId", "job_id"} and isinstance(value, str):
            if value not in _NON_JOB_SCOPE_REFERENCES:
                inferred.add(value)
        elif key in {"jobIds", "job_ids"} and isinstance(value, list):
            inferred.update(
                item
                for item in value
                if isinstance(item, str) and item not in _NON_JOB_SCOPE_REFERENCES
            )
    return inferred


__all__ = [
    "EVENT_IDENTITY_UPCAST_VERSION",
    "EventIdentityUpcastError",
    "UpcastedEventIdentity",
    "upcast_v6_event_identity",
]
