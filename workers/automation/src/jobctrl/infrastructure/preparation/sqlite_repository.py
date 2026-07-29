"""SQLite adapter for durable Preparation work items."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobctrl.database import ensure_preparation_work_item_tables
from jobctrl.domain.discovery.value_objects import PostingUrl
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.preparation import (
    PreparationWorkItem,
    PreparationWorkItemKind,
    PreparationWorkItemState,
    make_preparation_idempotency_key,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_identity_resolver import (
    SqliteJobIdentityResolver,
)


class SqlitePreparationWorkItemRepository:
    """SQLite-backed implementation of ``PreparationWorkItemRepository``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_preparation_work_item_tables(conn)

    def enqueue(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        kind: PreparationWorkItemKind,
        target_version: int,
        source_event_id: str = "",
        available_at: str | None = None,
        now: str | None = None,
    ) -> PreparationWorkItem:
        resolved_job_id = self._resolve_job_id(
            tenant_id=tenant_id,
            job_id=job_id,
        )
        return self._enqueue_resolved(
            tenant_id=tenant_id,
            job_id=resolved_job_id,
            kind=kind,
            target_version=target_version,
            source_event_id=source_event_id,
            available_at=available_at,
            now=now,
        )

    def enqueue_by_posting_url(
        self,
        *,
        tenant_id: TenantId,
        posting_url: PostingUrl,
        kind: PreparationWorkItemKind,
        target_version: int,
        source_event_id: str = "",
        available_at: str | None = None,
        now: str | None = None,
    ) -> PreparationWorkItem:
        """Resolve the bounded legacy URL input before stable persistence."""
        identity = SqliteJobIdentityResolver(self._conn).resolve_by_posting_url(tenant_id, posting_url)
        if identity is None:
            raise KeyError(f"No stable Job identity for preparation work item: {posting_url.value}")
        return self._enqueue_resolved(
            tenant_id=tenant_id,
            job_id=identity.job_id,
            kind=kind,
            target_version=target_version,
            source_event_id=source_event_id,
            available_at=available_at,
            now=now,
        )

    def _enqueue_resolved(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        kind: PreparationWorkItemKind,
        target_version: int,
        source_event_id: str,
        available_at: str | None,
        now: str | None,
    ) -> PreparationWorkItem:
        created_at = now or _utc_now()
        available = available_at or created_at
        normalized_source_event_id = str(source_event_id or "").strip()
        existing = self._get_by_semantic_key(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=kind,
            target_version=target_version,
            source_event_id=normalized_source_event_id,
        )
        if existing is not None:
            return existing
        item = PreparationWorkItem.queued(
            tenant_id=tenant_id,
            job_id=job_id,
            kind=kind,
            target_version=target_version,
            source_event_id=normalized_source_event_id,
            created_at=created_at,
            available_at=available,
            idempotency_key=make_preparation_idempotency_key(
                tenant_id=tenant_id,
                job_id=job_id,
                kind=kind,
                target_version=target_version,
                source_event_id=normalized_source_event_id,
            ),
        )
        self._conn.execute(
            """
            INSERT OR IGNORE INTO preparation_work_items (
                item_id, tenant_id, job_id, kind, target_version, source_event_id,
                state, idempotency_key, attempts, last_error, created_at,
                updated_at, available_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.item_id,
                str(item.tenant_id),
                str(item.job_id),
                item.kind.value,
                item.target_version,
                item.source_event_id,
                item.state.value,
                item.idempotency_key,
                item.attempts,
                item.last_error,
                item.created_at,
                item.updated_at,
                item.available_at,
            ),
        )
        self._conn.commit()
        return self._get_by_idempotency_key(tenant_id, item.idempotency_key)

    def _get_by_semantic_key(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
        kind: PreparationWorkItemKind,
        target_version: int,
        source_event_id: str,
    ) -> PreparationWorkItem | None:
        """Find migrated legacy work without rewriting its historical key."""
        row = self._conn.execute(
            """
            SELECT item_id, tenant_id, job_id, kind, target_version,
                   source_event_id, state, idempotency_key, attempts,
                   last_error, created_at, updated_at, available_at
            FROM preparation_work_items
            WHERE tenant_id = ?
              AND job_id = ?
              AND kind = ?
              AND target_version = ?
              AND source_event_id = ?
            ORDER BY created_at, item_id
            LIMIT 1
            """,
            (
                str(tenant_id),
                str(job_id),
                PreparationWorkItemKind(kind).value,
                int(target_version),
                source_event_id,
            ),
        ).fetchone()
        return _row_to_item(row) if row is not None else None

    def _get_by_idempotency_key(
        self,
        tenant_id: TenantId,
        idempotency_key: str,
    ) -> PreparationWorkItem:
        row = self._conn.execute(
            """
            SELECT item_id, tenant_id, job_id, kind, target_version, source_event_id,
                   state, idempotency_key, attempts, last_error, created_at,
                   updated_at, available_at
            FROM preparation_work_items
            WHERE tenant_id = ? AND idempotency_key = ?
            """,
            (str(tenant_id), idempotency_key),
        ).fetchone()
        if row is None:
            raise LookupError("preparation work item was not persisted")
        return _row_to_item(row)

    def _get_by_item_id(
        self,
        tenant_id: TenantId,
        item_id: str,
    ) -> PreparationWorkItem | None:
        row = self._conn.execute(
            """
            SELECT item_id, tenant_id, job_id, kind, target_version, source_event_id,
                   state, idempotency_key, attempts, last_error, created_at,
                   updated_at, available_at
            FROM preparation_work_items
            WHERE tenant_id = ? AND item_id = ?
            """,
            (str(tenant_id), item_id),
        ).fetchone()
        return _row_to_item(row) if row is not None else None

    def _resolve_job_id(
        self,
        *,
        tenant_id: TenantId,
        job_id: JobId,
    ) -> JobId:
        resolver = SqliteJobIdentityResolver(self._conn)
        raw_reference = str(job_id or "").strip()
        if not raw_reference:
            raise ValueError("job_id must be non-empty")
        try:
            stable_job_id = canonical_job_id(raw_reference)
        except ValueError:
            stable_job_id = None
        identity = resolver.resolve_by_job_id(tenant_id, stable_job_id) if stable_job_id is not None else None
        if identity is None:
            # Compatibility for the historically URL-shaped JobId call site.
            # UUID-shaped URLs use ``enqueue_by_posting_url`` so precedence is
            # explicit rather than data-dependent.
            identity = resolver.resolve_by_posting_url(
                tenant_id,
                PostingUrl(raw_reference),
            )

        if identity is None:
            raise KeyError(f"No stable Job identity for preparation work item: {raw_reference}")
        return identity.job_id


def _row_to_item(row: Any) -> PreparationWorkItem:
    return PreparationWorkItem(
        item_id=str(_row_value(row, "item_id", 0)),
        tenant_id=TenantId(str(_row_value(row, "tenant_id", 1))),
        job_id=JobId(str(_row_value(row, "job_id", 2))),
        kind=PreparationWorkItemKind(str(_row_value(row, "kind", 3))),
        target_version=int(_row_value(row, "target_version", 4)),
        source_event_id=str(_row_value(row, "source_event_id", 5) or ""),
        state=PreparationWorkItemState(str(_row_value(row, "state", 6))),
        idempotency_key=str(_row_value(row, "idempotency_key", 7)),
        attempts=int(_row_value(row, "attempts", 8) or 0),
        last_error=str(_row_value(row, "last_error", 9) or ""),
        created_at=str(_row_value(row, "created_at", 10)),
        updated_at=str(_row_value(row, "updated_at", 11)),
        available_at=str(_row_value(row, "available_at", 12)),
    )


def _row_value(row: Any, name: str, index: int) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[name]
    return row[index]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = ["SqlitePreparationWorkItemRepository"]
