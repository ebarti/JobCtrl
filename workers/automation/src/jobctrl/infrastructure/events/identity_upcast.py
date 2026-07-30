"""Versioned legacy-event JobId upcast shared with the TypeScript runtime.

Historical events are immutable. Before a projection consumes a pre-cutover
event, this adapter resolves job identity fields through the tenant-scoped
posting-URL alias map and returns a canonical in-memory view. Locator fields
such as ``postingUrl`` and ``applicationUrl`` remain untouched.
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


def upcast_event_identity(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    event_job_reference: str | None,
    payload: Mapping[str, Any],
) -> UpcastedEventIdentity:
    """Return the canonical identity view for one immutable legacy event."""

    normalized_tenant = str(tenant_id or "").strip()
    if not normalized_tenant:
        raise EventIdentityUpcastError("event_job_identity_invalid")
    if not isinstance(payload, Mapping):
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

    transformed = _upcast_value(
        conn,
        tenant_id=normalized_tenant,
        value=dict(payload),
        referenced=referenced,
    )
    if not isinstance(transformed, dict):
        raise EventIdentityUpcastError("event_job_identity_invalid")

    root_job_ids = {
        value
        for key in _ROOT_PRIMARY_FIELDS
        if isinstance((value := transformed.get(key)), str)
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
    elif len(inferable_job_ids := _inferable_payload_job_ids(transformed)) == 1:
        inferred_job_id = next(iter(inferable_job_ids))
    else:
        inferred_job_id = None
    return UpcastedEventIdentity(
        version=EVENT_IDENTITY_UPCAST_VERSION,
        job_id=inferred_job_id,
        referenced_job_ids=tuple(sorted(referenced)),
        payload=transformed,
    )


def _upcast_value(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    value: Any,
    referenced: set[str],
) -> Any:
    if isinstance(value, list):
        return [
            _upcast_value(
                conn,
                tenant_id=tenant_id,
                value=item,
                referenced=referenced,
            )
            for item in value
        ]
    if not isinstance(value, dict):
        return value

    transformed: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
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
            output_value = _upcast_value(
                conn,
                tenant_id=tenant_id,
                value=raw_value,
                referenced=referenced,
            )
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
    job_id = _resolve_reference(
        conn,
        tenant_id=tenant_id,
        reference=value,
    )
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
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND url = ?
        """,
        (tenant_id, normalized),
    )
    alias_url = (
        _job_id_from_query(
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
        if _table_exists(conn, "job_identity_aliases")
        else None
    )
    if (
        direct_url is not None
        and alias_url is not None
        and direct_url != alias_url
    ):
        raise EventIdentityUpcastError("event_job_identity_conflict")
    url_job_id = direct_url or alias_url
    if url_job_id is not None:
        return url_job_id

    stable_job_id = _job_id_from_query(
        conn,
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND job_id = ?
        """,
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


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
        """,
        (table_name,),
    ).fetchone()
    return row is not None


def _inferable_payload_job_ids(value: Any) -> set[str]:
    if isinstance(value, list):
        inferred: set[str] = set()
        for item in value:
            inferred.update(_inferable_payload_job_ids(item))
        return inferred
    if not isinstance(value, dict):
        return set()

    inferred = set()
    for key, item in value.items():
        if key in {"jobId", "job_id"} and isinstance(item, str):
            inferred.add(item)
        elif key in {"jobIds", "job_ids"} and isinstance(item, list):
            inferred.update(entry for entry in item if isinstance(entry, str))
        elif key not in {
            "candidateJobId",
            "candidate_job_id",
            "survivingJobId",
            "surviving_job_id",
        }:
            inferred.update(_inferable_payload_job_ids(item))
    return inferred


__all__ = [
    "EVENT_IDENTITY_UPCAST_VERSION",
    "EventIdentityUpcastError",
    "UpcastedEventIdentity",
    "upcast_event_identity",
]
