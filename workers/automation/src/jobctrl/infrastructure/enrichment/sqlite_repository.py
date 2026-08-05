"""SqliteEnrichmentRepository — local-mode adapter for the Enrichment context.

Persists ``JobEnrichment`` aggregates to the ``job_enrichments`` table
created by the exact-v7 schema. The aggregate identity and table primary
key are both ``(tenant_id, job_id)``. Posting URLs remain locators on the
Job aggregate; they are never used as enrichment identity.

The repository is an upsert on every save — versioning is per-attempt
inside the aggregate's ``attempts_json`` blob, not per-row.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.domain.enrichment.aggregate import (
    EnrichmentLifecycle,
    JobEnrichment,
)
from jobctrl.domain.enrichment.entities import EnrichmentAttempt
from jobctrl.domain.enrichment.snapshot_services import DedupeIndexEntry
from jobctrl.domain.enrichment.snapshot_set import (
    ContentDuplicateCandidate,
    PostingSnapshotSet,
    SnapshotCaptureFailure,
)
from jobctrl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    DuplicateEvidence,
    DuplicateEvidenceKind,
    FilterOverrideAudit,
    PostingContentSnapshot,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.enrichment.value_objects import (
    ApplicationUrl,
    ExtractionTier,
    FullDescription,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId


class SqliteEnrichmentRepository:
    """SQLite-backed implementation of ``EnrichmentRepository``.

    A single ``sqlite3.Connection`` is held for the lifetime of the
    adapter; ``save`` commits eagerly so consumers see the row
    immediately. Tests inject their own connection via the constructor
    for isolation.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId, job_id: JobId) -> JobEnrichment | None:
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT tenant_id, job_id, current_status, full_description,
                   application_url, enriched_at, extraction_tier,
                   attempts_json, updated_at
            FROM job_enrichments
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id)),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_enrichment(row)

    def list_pending(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobId]:
        """Return job_ids whose enrichment is `pending`.

        A job is pending when:

          * the discovery row exists in ``jobs``,
          * AND either there is no ``job_enrichments`` row, or the
            row's ``current_status`` is ``pending``.

        We deliberately exclude rows whose status is ``running`` (in
        flight) or ``failed`` (the orchestrator has the failed list to
        decide whether to retry).
        """
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT j.job_id FROM jobs j "
            "LEFT JOIN job_enrichments e "
            "  ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id "
            "WHERE j.tenant_id = ? "
            "  AND (e.job_id IS NULL OR e.current_status = 'pending') "
            "ORDER BY j.discovered_at DESC NULLS LAST"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [canonical_job_id(str(row[0])) for row in rows if row[0]]

    def list_failed(self, tenant_id: TenantId, *, limit: int = 0) -> list[JobEnrichment]:
        params: list[Any] = [str(tenant_id)]
        sql = (
            "SELECT tenant_id, job_id, current_status, full_description, "
            "application_url, enriched_at, extraction_tier, attempts_json, "
            "updated_at "
            "FROM job_enrichments "
            "WHERE tenant_id = ? AND current_status = 'failed' "
            "ORDER BY updated_at DESC"
        )
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_to_enrichment(row) for row in rows]

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def save(self, enrichment: JobEnrichment, *, commit: bool = True) -> None:
        job_id = canonical_job_id(str(enrichment.job_id))
        attempts_json = json.dumps(
            [a.to_dict() for a in enrichment.attempts],
            sort_keys=True,
        )
        self._conn.execute(
            """
            INSERT INTO job_enrichments (
                tenant_id, job_id, current_status, full_description,
                application_url, enriched_at, extraction_tier,
                attempts_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                current_status = excluded.current_status,
                full_description = excluded.full_description,
                application_url = excluded.application_url,
                enriched_at = excluded.enriched_at,
                extraction_tier = excluded.extraction_tier,
                attempts_json = excluded.attempts_json,
                updated_at = excluded.updated_at
            """,
            (
                str(enrichment.tenant_id),
                str(job_id),
                enrichment.current_status,
                (
                    enrichment.full_description.text
                    if enrichment.full_description
                    else None
                ),
                (
                    enrichment.application_url.value
                    if enrichment.application_url
                    else None
                ),
                enrichment.enriched_at,
                (
                    enrichment.extraction_tier.value
                    if enrichment.extraction_tier
                    else None
                ),
                attempts_json,
                enrichment.updated_at,
            ),
        )
        if commit:
            self._conn.commit()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_enrichment(row: Any) -> JobEnrichment:
        if isinstance(row, sqlite3.Row):
            tenant_id = row["tenant_id"]
            job_id = row["job_id"]
            current_status = row["current_status"]
            full_description = row["full_description"]
            application_url = row["application_url"]
            enriched_at = row["enriched_at"]
            extraction_tier = row["extraction_tier"]
            attempts_json = row["attempts_json"]
            updated_at = row["updated_at"]
        else:
            (
                tenant_id,
                job_id,
                current_status,
                full_description,
                application_url,
                enriched_at,
                extraction_tier,
                attempts_json,
                updated_at,
            ) = row

        attempts_data = json.loads(attempts_json) if attempts_json else []
        attempts = tuple(EnrichmentAttempt.from_dict(d) for d in attempts_data)

        # Defensively coerce the lifecycle string — invalid values would
        # break the aggregate's __post_init__ and we want the load path
        # to surface that as a clear error rather than a silent rewrite.
        return JobEnrichment(
            tenant_id=TenantId(str(tenant_id)),
            job_id=canonical_job_id(str(job_id)),
            current_status=str(current_status or EnrichmentLifecycle.PENDING),
            attempts=attempts,
            full_description=(
                FullDescription(text=str(full_description)) if full_description else None
            ),
            application_url=(
                ApplicationUrl(value=str(application_url)) if application_url else None
            ),
            enriched_at=(str(enriched_at) if enriched_at else None),
            extraction_tier=ExtractionTier.from_optional(extraction_tier),
            updated_at=str(updated_at or ""),
        )


class SqlitePostingSnapshotSetRepository:
    """SQLite-backed ``PostingSnapshotSetRepository`` implementation."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def load(self, tenant_id: TenantId, job_id: JobId) -> PostingSnapshotSet | None:
        stable_job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT snapshot_set_json
            FROM posting_snapshot_sets
            WHERE tenant_id = ? AND job_id = ?
            LIMIT 1
            """,
            (str(tenant_id), str(stable_job_id)),
        ).fetchone()
        if row is None:
            return None
        raw_json = row["snapshot_set_json"] if isinstance(row, sqlite3.Row) else row[0]
        data = json.loads(raw_json) if raw_json else {}
        return _snapshot_set_from_dict(data)

    def save(self, snapshot_set: PostingSnapshotSet, *, commit: bool = True) -> None:
        latest = snapshot_set.latest_snapshot
        self._conn.execute(
            """
            INSERT INTO posting_snapshot_sets (
                tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
                latest_active_state, latest_confidence, latest_quarantine_reason,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                snapshot_set_json = excluded.snapshot_set_json,
                latest_snapshot_version = excluded.latest_snapshot_version,
                latest_active_state = excluded.latest_active_state,
                latest_confidence = excluded.latest_confidence,
                latest_quarantine_reason = excluded.latest_quarantine_reason,
                updated_at = excluded.updated_at
            """,
            (
                str(snapshot_set.tenant_id),
                str(snapshot_set.job_id),
                json.dumps(snapshot_set.to_dict(), sort_keys=True),
                latest.snapshot_version if latest else 0,
                snapshot_set.latest_active_state.value,
                latest.confidence.value if latest else None,
                latest.quarantine_reason.value if latest else None,
                snapshot_set.updated_at,
            ),
        )
        if commit:
            self._conn.commit()

    def index_entries(
        self,
        tenant_id: TenantId,
        *,
        exclude_job_id: JobId | None = None,
    ) -> list[DedupeIndexEntry]:
        rows = self._conn.execute(
            """
            SELECT job_id, snapshot_set_json
            FROM posting_snapshot_sets
            WHERE tenant_id = ?
            ORDER BY updated_at DESC
            """,
            (str(tenant_id),),
        ).fetchall()
        entries: list[DedupeIndexEntry] = []
        for row in rows:
            job_id = row["job_id"] if isinstance(row, sqlite3.Row) else row[0]
            if exclude_job_id is not None and str(job_id) == str(exclude_job_id):
                continue
            raw_json = row["snapshot_set_json"] if isinstance(row, sqlite3.Row) else row[1]
            data = json.loads(raw_json) if raw_json else {}
            snapshot_set = _snapshot_set_from_dict(data)
            latest = snapshot_set.latest_snapshot
            if latest is None:
                continue
            entries.append(
                DedupeIndexEntry(
                    candidate_job_id=str(snapshot_set.job_id),
                    description_hash=latest.description_hash,
                    apply_url=latest.apply_url,
                )
            )
        return entries


def _snapshot_set_from_dict(data: dict[str, Any]) -> PostingSnapshotSet:
    tenant_id = TenantId(str(data.get("tenant_id") or LOCAL_TENANT))
    job_id = canonical_job_id(str(data.get("job_id") or ""))
    snapshots = tuple(
        _snapshot_from_dict(item)
        for item in data.get("snapshots", [])
        if isinstance(item, dict)
    )
    failures = tuple(
        _failure_from_dict(item)
        for item in data.get("failures", [])
        if isinstance(item, dict)
    )
    duplicate_candidates = tuple(
        _duplicate_candidate_from_dict(item)
        for item in data.get("duplicate_candidates", [])
        if isinstance(item, dict)
    )
    latest_state = ActiveState.from_optional(data.get("latest_active_state")) or (
        snapshots[-1].active_state if snapshots else ActiveState.UNKNOWN
    )
    return PostingSnapshotSet(
        tenant_id=tenant_id,
        job_id=job_id,
        snapshots=snapshots,
        failures=failures,
        duplicate_candidates=duplicate_candidates,
        latest_active_state=latest_state,
        updated_at=str(data.get("updated_at") or ""),
    )


def _snapshot_from_dict(data: dict[str, Any]) -> PostingContentSnapshot:
    filter_override_raw = data.get("filter_override")
    filter_override = (
        FilterOverrideAudit(
            source_id=str(filter_override_raw.get("source_id") or ""),
            overridden_filter=str(filter_override_raw.get("overridden_filter") or ""),
            reason=str(filter_override_raw.get("reason") or ""),
            requested_by=str(filter_override_raw.get("requested_by") or ""),
            overridden_at=str(filter_override_raw.get("overridden_at") or ""),
        )
        if isinstance(filter_override_raw, dict)
        else None
    )
    apply_url_raw = data.get("apply_url")
    return PostingContentSnapshot(
        snapshot_version=int(data.get("snapshot_version") or 1),
        source_id=str(data.get("source_id") or "unknown"),
        extraction_tier=str(data.get("extraction_tier") or "unknown"),
        description_hash=SnapshotDescriptionHash(
            value=str(data.get("description_hash") or "")
        ),
        apply_url=SnapshotApplyUrl(value=str(apply_url_raw)) if apply_url_raw else None,
        active_state=ActiveState.from_optional(data.get("active_state"))
        or ActiveState.UNKNOWN,
        confidence=SnapshotConfidence.from_optional(data.get("confidence"))
        or SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.from_optional(data.get("quarantine_reason"))
        or QuarantineReason.NONE,
        captured_at=str(data.get("captured_at") or ""),
        raw_text_hash=str(data.get("raw_text_hash") or ""),
        filter_override=filter_override,
        evidence=tuple(str(item) for item in data.get("evidence", []) if item),
    )


def _failure_from_dict(data: dict[str, Any]) -> SnapshotCaptureFailure:
    return SnapshotCaptureFailure(
        error_class=str(data.get("error_class") or "UNKNOWN"),
        message=str(data.get("message") or ""),
        retryable=bool(data.get("retryable", True)),
        failed_at=str(data.get("failed_at") or ""),
        source_id=str(data.get("source_id") or "unknown"),
    )


def _duplicate_candidate_from_dict(data: dict[str, Any]) -> ContentDuplicateCandidate:
    evidence = tuple(
        _duplicate_evidence_from_dict(item)
        for item in data.get("evidence", [])
        if isinstance(item, dict)
    )
    return ContentDuplicateCandidate(
        candidate_job_id=str(data.get("candidate_job_id") or ""),
        evidence=evidence,
        confidence=float(data.get("confidence") or 0),
        detected_at=str(data.get("detected_at") or ""),
    )


def _duplicate_evidence_from_dict(data: dict[str, Any]) -> DuplicateEvidence:
    return DuplicateEvidence(
        kind=DuplicateEvidenceKind(
            str(data.get("kind") or DuplicateEvidenceKind.DESCRIPTION_HASH_MATCH.value)
        ),
        matched_value=str(data.get("matched_value") or ""),
        confidence=float(data.get("confidence") or 0),
    )
