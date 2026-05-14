"""Production wiring for the Discovery RFC runtime path.

This module is deliberately adapter-level. It lets the existing worker
pipeline feed the Discovery-owned source controls, canonical ATS adapters,
manual-capture queue, and acceptance evidence without moving those concerns
into the TS API or the scoring context.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlparse

from jobhunter.database import (
    ensure_discovery_control_tables,
    ensure_enrichment_tables,
    ensure_posting_snapshot_tables,
    ensure_source_observation_tables,
)
from jobhunter.domain.discovery.identity import AtsKind
from jobhunter.domain.discovery.source_registry import (
    LocatorPolicy,
    ManualActionReason,
    ManualActionRequired,
    SourceDiscoveryEvidence,
    SourceKind,
    SourceLocationCandidate,
    SourceRegistryEntry,
    validate_locator_candidate,
)
from jobhunter.domain.discovery.use_cases import DiscoverJobsUseCase
from jobhunter.domain.discovery.value_objects import (
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.enrichment import DetailPage, ExtractionTier
from jobhunter.domain.enrichment.services import CssSelectorExtractor, JsonLdExtractor
from jobhunter.domain.enrichment.snapshot_services import (
    ContentAcquisitionService,
    TierExtractor,
)
from jobhunter.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
from jobhunter.domain.enrichment.snapshot_value_objects import QuarantineReason
from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.discovery import ScrapedJobPosting
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.discovery.ats_adapters import (
    AshbyBoardAdapter,
    GreenhouseBoardAdapter,
    HttpFetcher,
    LeverBoardAdapter,
)
from jobhunter.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobhunter.infrastructure.enrichment import (
    SqliteEnrichmentRepository,
    SqlitePostingSnapshotSetRepository,
)
from jobhunter.state import record_job_event


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class SourceControlSeedSummary:
    registry_rows: int = 0
    locator_candidates: int = 0
    manual_action_count: int = 0


@dataclass(frozen=True)
class ScheduledAtsSummary:
    total: int = 0
    new_jobs: int = 0
    observed_jobs: int = 0
    duplicate_jobs: int = 0
    rejected_duplicates: int = 0
    sources_run: tuple[str, ...] = ()
    failed_sources: tuple[str, ...] = ()

    def to_result_dict(self) -> dict[str, Any]:
        failed_source_ids = list(self.failed_sources)
        return {
            "total": self.total,
            "new_jobs": self.new_jobs,
            "observed_jobs": self.observed_jobs,
            "duplicate_jobs": self.duplicate_jobs,
            "rejected_duplicates": self.rejected_duplicates,
            "failed_sources": failed_source_ids,
            "failed_source_ids": failed_source_ids,
            "failedSourceIds": failed_source_ids,
        }


@dataclass(frozen=True)
class ManualCaptureImport:
    item_id: str
    capture_mode: str
    content_text: str | None = None
    content_html_base64: str | None = None
    captured_url: str | None = None
    note: str | None = None
    future_manual_action_required: bool = False


@dataclass(frozen=True)
class ManualCaptureImportOutcome:
    item_id: str
    job_id: str
    snapshot_version: int | None
    promoted_to_job_enrichment: bool
    quarantine_reason: str


@dataclass(frozen=True)
class DiscoveryAcceptanceReport:
    scenario: str
    generated_at: str
    lead_yield: int
    candidate_sources: tuple[str, ...]
    manual_action_count: int
    canonical_verification_rate: float
    duplicate_count: int
    quarantine_count: int
    source_quality_updates: int
    scoring_handoff_count: int
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "generated_at": self.generated_at,
            "lead_yield": self.lead_yield,
            "candidate_sources": list(self.candidate_sources),
            "manual_action_count": self.manual_action_count,
            "canonical_verification_rate": self.canonical_verification_rate,
            "duplicate_count": self.duplicate_count,
            "quarantine_count": self.quarantine_count,
            "source_quality_updates": self.source_quality_updates,
            "scoring_handoff_count": self.scoring_handoff_count,
            "details": self.details,
        }


class DurableJobEventPublisher:
    """Persist domain events to ``job_events`` while still fanning out locally."""

    def __init__(self, conn: sqlite3.Connection, *, stage: str) -> None:
        self._conn = conn
        self._stage = stage

    def publish(self, event: DomainEvent) -> None:
        payload = {"tenantId": str(event.tenant_id), **event.payload}
        job_url = _event_job_url(event)
        record_job_event(
            self._conn,
            job_url,
            self._stage,
            event.event_type,
            message=event.event_type,
            payload=payload,
            occurred_at=event.occurred_at,
        )
        self._conn.commit()


def ensure_worker_discovery_tables(conn: sqlite3.Connection) -> None:
    ensure_source_observation_tables(conn)
    ensure_discovery_control_tables(conn)
    ensure_enrichment_tables(conn)
    ensure_posting_snapshot_tables(conn)


def seed_source_registry_controls(
    conn: sqlite3.Connection,
    registry: Iterable[SourceRegistryEntry],
) -> int:
    """Upsert generated worker source registry entries for API/UI visibility."""
    ensure_worker_discovery_tables(conn)
    now = utc_now()
    count = 0
    for entry in registry:
        conn.execute(
            """
            INSERT INTO source_registry_entries (
                tenant_id, source_id, kind, display_name, owner, priority,
                state, policy_id, seed_url, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, source_id) DO UPDATE SET
                kind = excluded.kind,
                display_name = excluded.display_name,
                owner = excluded.owner,
                priority = excluded.priority,
                state = excluded.state,
                policy_id = excluded.policy_id,
                seed_url = excluded.seed_url,
                updated_at = excluded.updated_at
            """,
            (
                str(entry.tenant_id),
                entry.source_id,
                entry.kind.value,
                entry.display_name,
                entry.owner,
                entry.priority.value,
                entry.state.value,
                entry.policy.policy_id,
                _seed_url(entry),
                now,
                now,
            ),
        )
        count += 1
    conn.commit()
    return count


def seed_discovery_control_queues(
    conn: sqlite3.Connection,
    registry: Iterable[SourceRegistryEntry],
    *,
    policy: LocatorPolicy | None = None,
) -> SourceControlSeedSummary:
    """Seed source registry rows, locator candidates, and manual actions."""
    materialized = tuple(registry)
    registry_rows = seed_source_registry_controls(conn, materialized)
    locator_candidates, manual_actions = run_deterministic_source_locator(
        conn,
        materialized,
        policy=policy,
    )
    return SourceControlSeedSummary(
        registry_rows=registry_rows,
        locator_candidates=locator_candidates,
        manual_action_count=manual_actions,
    )


def run_deterministic_source_locator(
    conn: sqlite3.Connection,
    registry: Iterable[SourceRegistryEntry],
    *,
    policy: LocatorPolicy | None = None,
) -> tuple[int, int]:
    """Persist deterministic locator candidates from seeds and observations."""
    ensure_worker_discovery_tables(conn)
    active_policy = policy or LocatorPolicy()
    candidates = list(_candidates_from_registry(registry))
    candidates.extend(_candidates_from_broad_board_observations(conn))

    persisted = 0
    manual_actions = 0
    for candidate in candidates:
        decision = validate_locator_candidate(candidate, active_policy)
        is_new = _locator_candidate_is_new(conn, candidate)
        _upsert_locator_candidate(conn, candidate)
        if is_new:
            _record_locator_event(conn, candidate)
        persisted += 1
        if decision == "manual_action_required":
            _enqueue_manual_action_from_candidate(conn, candidate)
            manual_actions += 1
    conn.commit()
    return persisted, manual_actions


def enqueue_manual_action_for_sources(
    conn: sqlite3.Connection,
    sources: Iterable[Any],
) -> int:
    """Queue manual capture for blocked/protected Smart Extract sources."""
    ensure_worker_discovery_tables(conn)
    count = 0
    for source in sources:
        source_id = str(getattr(source, "source_id", "")).strip()
        adapter_config = dict(getattr(source, "adapter_config", {}) or {})
        url = str(
            adapter_config.get("url")
            or adapter_config.get("seed_url")
            or adapter_config.get("base_url")
            or ""
        ).strip()
        if not url or not _looks_protected(url):
            continue
        _enqueue_manual_capture(
            conn,
            originating_url=url,
            source_id=source_id or None,
            reason=ManualActionReason.PROTECTED_INTERNAL_SITE.value,
            retry_context={
                "source": "smart_extract",
                "source_id": source_id,
                "provenance": "worker_blocked_source",
                "retryable_with_user_capture": True,
            },
            required_at=utc_now(),
        )
        count += 1
    conn.commit()
    return count


def run_scheduled_ats_sources(
    conn: sqlite3.Connection,
    sources: Iterable[Any],
    *,
    search_cfg: Mapping[str, Any],
    run_id: str,
    http: HttpFetcher | None = None,
    limit: int = 0,
) -> dict[str, Any]:
    """Run Greenhouse, Lever, and Ashby through the Discovery use case."""
    ensure_worker_discovery_tables(conn)
    runnable = tuple(source for source in sources if getattr(source, "should_run", True))
    adapters = tuple(_adapter_for_source(source, http=http) for source in runnable)
    adapters = tuple(adapter for adapter in adapters if adapter is not None)
    if not adapters:
        return ScheduledAtsSummary().to_result_dict()

    use_case = DiscoverJobsUseCase(
        repository=SqliteJobRepository(conn),
        publisher=DurableJobEventPublisher(conn, stage="discover"),
    )
    total = 0
    new_jobs = 0
    observed_jobs = 0
    duplicate_jobs = 0
    rejected_duplicates = 0
    sources_run: list[str] = []
    failed_sources: list[str] = []
    remaining = limit if limit > 0 else None
    pairs = tuple(_query_location_pairs(search_cfg))
    for adapter in adapters:
        if remaining is not None and remaining <= 0:
            break
        postings: list[ScrapedJobPosting] = []
        try:
            for query, location in pairs:
                if remaining is not None and remaining <= 0:
                    break
                for posting in adapter.scrape(
                    tenant_id=LOCAL_TENANT,
                    query=query,
                    location=location,
                ):
                    postings.append(posting)
                    if remaining is not None:
                        remaining -= 1
                        if remaining <= 0:
                            break
        except Exception as exc:
            failed_sources.append(adapter.source_id)
            _record_ats_source_failure(conn, adapter.source_id, run_id, exc)
        if not postings:
            continue
        summary = use_case.execute(
            tenant_id=LOCAL_TENANT,
            postings=postings,
            run_id=run_id,
        )
        total += summary.total
        new_jobs += summary.new_jobs
        observed_jobs += summary.observed
        duplicate_jobs += summary.duplicates_linked
        rejected_duplicates += summary.duplicates_rejected
        sources_run.append(adapter.source_id)
    return ScheduledAtsSummary(
        total=total,
        new_jobs=new_jobs,
        observed_jobs=observed_jobs,
        duplicate_jobs=duplicate_jobs,
        rejected_duplicates=rejected_duplicates,
        sources_run=tuple(sources_run),
        failed_sources=tuple(failed_sources),
    ).to_result_dict()


def import_manual_capture_item(
    conn: sqlite3.Connection,
    capture: ManualCaptureImport,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
) -> ManualCaptureImportOutcome:
    """Import one queued manual capture through Discovery + Enrichment."""
    ensure_worker_discovery_tables(conn)
    row = conn.execute(
        """
        SELECT item_id, originating_url, source_id, reason, retry_context_json
        FROM manual_capture_queue
        WHERE tenant_id = ? AND item_id = ? AND status = 'pending'
        LIMIT 1
        """,
        (str(tenant_id), capture.item_id),
    ).fetchone()
    if row is None:
        raise ValueError(f"Manual capture item {capture.item_id!r} was not found")

    originating_url = _row_value(row, "originating_url", 1)
    source_id = _row_value(row, "source_id", 2) or f"manual_capture:{capture.item_id}"
    retry_context = _json_dict(_row_value(row, "retry_context_json", 4))
    captured_url = capture.captured_url or str(originating_url)
    content = _manual_capture_content(capture)
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    now = utc_now()
    retry_context["manual_capture_provenance"] = {
        "source_kind": SourceKind.USER_MEDIATED_CAPTURE.value,
        "originating_url": str(originating_url),
        "source_id": str(source_id),
        "capture_mode": capture.capture_mode,
        "captured_at": now,
        "future_manual_action_required": capture.future_manual_action_required,
    }

    use_case = DiscoverJobsUseCase(
        repository=SqliteJobRepository(conn),
        publisher=DurableJobEventPublisher(conn, stage="discover"),
    )
    posting = _manual_capture_posting(
        source_id=str(source_id),
        item_id=capture.item_id,
        url=captured_url,
        content=content,
        originating_url=str(originating_url),
    )
    use_case.execute(
        tenant_id=tenant_id,
        postings=(posting,),
        run_id=f"manual-capture:{capture.item_id}",
    )

    snapshot_use_case = _manual_capture_snapshot_use_case(
        conn,
        captured_url=captured_url,
        content=content,
    )
    outcome = snapshot_use_case.execute(
        tenant_id=tenant_id,
        job_id=JobId(captured_url),
        url=captured_url,
        source_id=str(source_id),
        policy_id="user_mediated_capture",
        promote_to_job_enrichment=True,
    )
    quarantine_reason = (
        outcome.snapshot_set.latest_snapshot.quarantine_reason.value
        if outcome.snapshot_set.latest_snapshot
        else ""
    )
    if outcome.ok and quarantine_reason and quarantine_reason != QuarantineReason.NONE.value:
        _upsert_quarantine_entry(
            conn,
            job_id=captured_url,
            source_id=str(source_id),
            reason=quarantine_reason,
            confidence=None,
            snapshot_version=outcome.captured_snapshot_version,
            captured_at=now,
            title=posting.metadata.title,
            posting_url=captured_url,
            notice_text="Manual capture imported but held for review.",
        )

    conn.execute(
        """
        UPDATE manual_capture_queue
         SET status = 'imported',
             imported_at = ?,
             capture_mode = ?,
             captured_url = ?,
             content_sha256 = ?,
             content_length = ?,
             note = ?,
             future_manual_action_required = ?,
             retry_context_json = ?,
             job_key = ?
         WHERE tenant_id = ? AND item_id = ?
        """,
        (
            now,
            capture.capture_mode,
            captured_url,
            content_hash,
            len(content),
            capture.note,
            1 if capture.future_manual_action_required else 0,
            json.dumps(retry_context, sort_keys=True),
            captured_url,
            str(tenant_id),
            capture.item_id,
        ),
    )
    conn.commit()
    return ManualCaptureImportOutcome(
        item_id=capture.item_id,
        job_id=captured_url,
        snapshot_version=outcome.captured_snapshot_version,
        promoted_to_job_enrichment=outcome.promoted_to_job_enrichment,
        quarantine_reason=quarantine_reason,
    )


def build_discovery_acceptance_report(
    conn: sqlite3.Connection,
    *,
    scenario: str = "Barcelona/Spain tech leadership",
    tenant_id: TenantId = LOCAL_TENANT,
) -> DiscoveryAcceptanceReport:
    """Build the RFC acceptance evidence report from worker-populated rows."""
    ensure_worker_discovery_tables(conn)
    tenant = str(tenant_id)
    lead_yield = _scalar_int(
        conn,
        """
        SELECT COUNT(DISTINCT job_url)
        FROM job_source_observations
        WHERE tenant_id = ? AND run_id != 'backfill'
        """,
        (tenant,),
    )
    candidate_sources = tuple(
        str(row[0])
        for row in conn.execute(
            """
            SELECT source_id FROM source_registry_entries
            WHERE tenant_id = ?
            UNION
            SELECT source_id FROM job_source_observations
            WHERE tenant_id = ? AND source_id != ''
            ORDER BY source_id ASC
            """,
            (tenant, tenant),
        ).fetchall()
    )
    manual_action_count = _scalar_int(
        conn,
        "SELECT COUNT(*) FROM manual_capture_queue WHERE tenant_id = ?",
        (tenant,),
    )
    canonical_jobs = _scalar_int(
        conn,
        "SELECT COUNT(DISTINCT job_url) FROM job_canonical_identities WHERE tenant_id = ?",
        (tenant,),
    )
    canonical_verification_rate = (
        round(canonical_jobs / lead_yield, 4) if lead_yield else 0.0
    )
    duplicate_count = _scalar_int(
        conn,
        "SELECT COUNT(*) FROM job_duplicate_links WHERE tenant_id = ?",
        (tenant,),
    )
    quarantine_count = _scalar_int(
        conn,
        """
        SELECT COUNT(*) FROM discovery_quarantine_entries
        WHERE tenant_id = ? AND status = 'pending'
        """,
        (tenant,),
    )
    source_quality_updates = _scalar_int(
        conn,
        "SELECT COUNT(*) FROM source_quality_stats WHERE tenant_id = ?",
        (tenant,),
    )
    scoring_handoff_count = _scalar_int(
        conn,
        """
        SELECT COUNT(*)
        FROM jobs j
        JOIN job_enrichments e ON e.job_url = j.url AND e.tenant_id = ?
        LEFT JOIN discovery_quarantine_entries q
          ON q.tenant_id = ? AND q.job_id = j.url AND q.status = 'pending'
        WHERE e.current_status = 'enriched'
          AND j.fit_score IS NULL
          AND q.job_id IS NULL
        """,
        (tenant, tenant),
    )
    return DiscoveryAcceptanceReport(
        scenario=scenario,
        generated_at=utc_now(),
        lead_yield=lead_yield,
        candidate_sources=candidate_sources,
        manual_action_count=manual_action_count,
        canonical_verification_rate=canonical_verification_rate,
        duplicate_count=duplicate_count,
        quarantine_count=quarantine_count,
        source_quality_updates=source_quality_updates,
        scoring_handoff_count=scoring_handoff_count,
        details={
            "canonical_jobs": canonical_jobs,
            "locator_candidates": _scalar_int(
                conn,
                "SELECT COUNT(*) FROM source_locator_candidates WHERE tenant_id = ?",
                (tenant,),
            ),
            "manual_imports": _scalar_int(
                conn,
                """
                SELECT COUNT(*) FROM manual_capture_queue
                WHERE tenant_id = ? AND status = 'imported'
                """,
                (tenant,),
            ),
        },
    )


def _candidates_from_registry(
    registry: Iterable[SourceRegistryEntry],
) -> Iterable[SourceLocationCandidate]:
    for entry in registry:
        seed_url = _seed_url(entry)
        if not seed_url:
            continue
        detected = _detect_ats_kind(seed_url)
        if detected is None and entry.kind not in {
            SourceKind.EMPLOYER_CAREERS_PAGE,
            SourceKind.NICHE_BOARD,
            SourceKind.SMART_EXTRACT,
        }:
            continue
        protected = _looks_protected(seed_url)
        reason = (
            ManualActionReason.PROTECTED_INTERNAL_SITE
            if protected
            else None
        )
        candidate_url = seed_url
        confidence = 0.88 if detected else 0.55
        yield _source_location_candidate(
            candidate_url=candidate_url,
            source_kind=SourceKind.ATS_API if detected else entry.kind,
            confidence=confidence,
            detected_ats_kind=detected.value if detected else None,
            employer_domain_matched=entry.owner == "system" and not protected,
            source_id=entry.source_id,
            manual_reason=reason,
            retry_context={"source": "configured_seed", "source_id": entry.source_id},
        )


def _candidates_from_broad_board_observations(
    conn: sqlite3.Connection,
) -> Iterable[SourceLocationCandidate]:
    rows = conn.execute(
        """
        SELECT source_id, observed_url
        FROM job_source_observations
        WHERE tenant_id = ? AND source_id LIKE 'jobspy:%'
        ORDER BY observed_at DESC
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()
    for row in rows:
        source_id = str(_row_value(row, "source_id", 0) or "")
        observed_url = str(_row_value(row, "observed_url", 1) or "")
        detected = _detect_ats_kind(observed_url)
        if detected is None:
            continue
        yield _source_location_candidate(
            candidate_url=observed_url,
            source_kind=SourceKind.ATS_API,
            confidence=0.72,
            detected_ats_kind=detected.value,
            employer_domain_matched=False,
            source_id=source_id,
            manual_reason=None,
            retry_context={"source": "broad_board_observation", "source_id": source_id},
        )


def _source_location_candidate(
    *,
    candidate_url: str,
    source_kind: SourceKind,
    confidence: float,
    detected_ats_kind: str | None,
    employer_domain_matched: bool,
    source_id: str | None,
    manual_reason: ManualActionReason | None,
    retry_context: dict[str, Any],
) -> SourceLocationCandidate:
    now = utc_now()
    candidate_id = f"locator:{hashlib.sha256(candidate_url.encode('utf-8')).hexdigest()[:16]}"
    manual = (
        ManualActionRequired(
            originating_url=candidate_url,
            source_id=source_id,
            reason=manual_reason,
            retry_context=retry_context,
            required_at=now,
        )
        if manual_reason is not None
        else None
    )
    return SourceLocationCandidate(
        tenant_id=LOCAL_TENANT,
        candidate_id=candidate_id,
        candidate_url=candidate_url,
        source_kind=source_kind,
        confidence=confidence,
        evidence=SourceDiscoveryEvidence(
            matched_url=candidate_url,
            detected_ats_kind=detected_ats_kind,
            employer_domain_matched=employer_domain_matched,
            validation_fetch_status=None,
        ),
        manual_action_required=manual,
        discovered_at=now,
    )


def _upsert_locator_candidate(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
) -> None:
    conn.execute(
        """
        INSERT INTO source_locator_candidates (
            tenant_id, candidate_id, candidate_url, source_kind, confidence,
            detected_ats_kind, employer_domain_matched, manual_action_reason,
            discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, candidate_id) DO UPDATE SET
            candidate_url = excluded.candidate_url,
            source_kind = excluded.source_kind,
            confidence = excluded.confidence,
            detected_ats_kind = excluded.detected_ats_kind,
            employer_domain_matched = excluded.employer_domain_matched,
            manual_action_reason = excluded.manual_action_reason,
            discovered_at = excluded.discovered_at
        """,
        (
            str(candidate.tenant_id),
            candidate.candidate_id,
            candidate.candidate_url,
            candidate.source_kind.value,
            candidate.confidence,
            candidate.evidence.detected_ats_kind,
            1 if candidate.evidence.employer_domain_matched else 0,
            (
                candidate.manual_action_required.reason.value
                if candidate.manual_action_required
                else None
            ),
            candidate.discovered_at,
        ),
    )


def _locator_candidate_is_new(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
) -> bool:
    row = conn.execute(
        """
        SELECT 1 FROM source_locator_candidates
        WHERE tenant_id = ? AND candidate_id = ?
        LIMIT 1
        """,
        (str(candidate.tenant_id), candidate.candidate_id),
    ).fetchone()
    return row is None


def _record_locator_event(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
) -> None:
    record_job_event(
        conn,
        None,
        "discover",
        "SourceLocationCandidateDiscovered",
        message="Source location candidate discovered.",
        payload={
            "tenantId": str(candidate.tenant_id),
            "candidate_id": candidate.candidate_id,
            "candidateId": candidate.candidate_id,
            "candidate_url": candidate.candidate_url,
            "candidateUrl": candidate.candidate_url,
            "source_kind": candidate.source_kind.value,
            "sourceKind": candidate.source_kind.value,
            "confidence": candidate.confidence,
            "evidence_ref": candidate.evidence.matched_url,
            "evidenceRef": candidate.evidence.matched_url,
            "discovered_at": candidate.discovered_at,
            "discoveredAt": candidate.discovered_at,
        },
        occurred_at=candidate.discovered_at,
    )


def _enqueue_manual_action_from_candidate(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
) -> None:
    manual = candidate.manual_action_required
    reason = (
        manual.reason.value
        if manual
        else ManualActionReason.AMBIGUOUS_CAREER_SYSTEM.value
    )
    retry_context = manual.retry_context if manual else {
        "source": "locator_candidate",
        "candidate_id": candidate.candidate_id,
    }
    _enqueue_manual_capture(
        conn,
        originating_url=candidate.candidate_url,
        source_id=manual.source_id if manual else None,
        reason=reason,
        retry_context=retry_context,
        required_at=manual.required_at if manual else candidate.discovered_at,
    )


def _enqueue_manual_capture(
    conn: sqlite3.Connection,
    *,
    originating_url: str,
    source_id: str | None,
    reason: str,
    retry_context: dict[str, Any],
    required_at: str,
) -> str:
    item_id = f"manual:{hashlib.sha256(originating_url.encode('utf-8')).hexdigest()[:16]}"
    conn.execute(
        """
        INSERT INTO manual_capture_queue (
            tenant_id, item_id, originating_url, source_id, reason,
            retry_context_json, required_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(tenant_id, item_id) DO UPDATE SET
            originating_url = excluded.originating_url,
            source_id = excluded.source_id,
            reason = excluded.reason,
            retry_context_json = CASE
                WHEN manual_capture_queue.status IN ('imported', 'dismissed')
                    THEN manual_capture_queue.retry_context_json
                ELSE excluded.retry_context_json
            END,
            required_at = excluded.required_at,
            status = CASE
                WHEN manual_capture_queue.status IN ('imported', 'dismissed')
                    THEN manual_capture_queue.status
                ELSE excluded.status
            END
        """,
        (
            str(LOCAL_TENANT),
            item_id,
            originating_url,
            source_id,
            reason,
            json.dumps(retry_context, sort_keys=True),
            required_at,
        ),
    )
    return item_id


def _record_ats_source_failure(
    conn: sqlite3.Connection,
    source_id: str,
    run_id: str,
    exc: Exception,
) -> None:
    failed_at = utc_now()
    record_job_event(
        conn,
        None,
        "discover",
        "DiscoveryRunFailed",
        level="error",
        message=f"ATS source {source_id} failed: {exc}",
        payload={
            "tenantId": str(LOCAL_TENANT),
            "run_id": run_id,
            "runId": run_id,
            "source_id": source_id,
            "sourceId": source_id,
            "source_ids": [source_id],
            "sourceIds": [source_id],
            "error_class": type(exc).__name__,
            "errorClass": type(exc).__name__,
            "retryable": True,
            "failed_at": failed_at,
            "failedAt": failed_at,
        },
        occurred_at=failed_at,
    )
    conn.commit()


def _adapter_for_source(source: Any, *, http: HttpFetcher | None) -> Any | None:
    source_id = str(getattr(source, "source_id", "")).strip()
    if source_id.startswith("workday:"):
        return None
    adapter_config = dict(getattr(source, "adapter_config", {}) or {})
    ats_kind = _source_ats_kind(source_id, adapter_config)
    if ats_kind is AtsKind.GREENHOUSE:
        board_token = _board_token(source_id, adapter_config)
        return GreenhouseBoardAdapter(
            source_id=source_id,
            board_token=board_token,
            company=_company_name(source, adapter_config),
            http=http,
        )
    if ats_kind is AtsKind.LEVER:
        site = _site_token(source_id, adapter_config)
        return LeverBoardAdapter(
            source_id=source_id,
            site=site,
            company=_company_name(source, adapter_config),
            http=http,
        )
    if ats_kind is AtsKind.ASHBY:
        board_name = _board_name(source_id, adapter_config)
        return AshbyBoardAdapter(
            source_id=source_id,
            board_name=board_name,
            company=_company_name(source, adapter_config),
            http=http,
        )
    return None


def _query_location_pairs(search_cfg: Mapping[str, Any]) -> Iterable[tuple[str, str]]:
    queries_cfg = search_cfg.get("queries", [])
    queries = [
        str(item.get("query") or "").strip()
        for item in queries_cfg
        if isinstance(item, Mapping) and int(item.get("tier") or 99) <= int(search_cfg.get("ats_max_tier") or 2)
    ]
    if not queries:
        queries = [
            str(item.get("query") or "").strip()
            for item in queries_cfg
            if isinstance(item, Mapping)
        ]
    queries = [query for query in queries if query] or [""]
    locations_cfg = search_cfg.get("locations", [])
    locations = [
        str(item.get("location") or item.get("label") or "").strip()
        for item in locations_cfg
        if isinstance(item, Mapping)
    ]
    locations = [location for location in locations if location] or [""]
    for query in queries:
        for location in locations:
            yield query, location


def _manual_capture_snapshot_use_case(
    conn: sqlite3.Connection,
    *,
    captured_url: str,
    content: str,
):
    class _ManualFetcher:
        def fetch(self, url: str) -> DetailPage:  # noqa: ARG002
            return _detail_page_from_manual_content(captured_url, content)

    acquisition = ContentAcquisitionService(
        fetcher=_ManualFetcher(),
        extractors=(
            TierExtractor(tier=ExtractionTier.JSON_LD, extractor=JsonLdExtractor()),
            TierExtractor(tier=ExtractionTier.CSS_SELECTORS, extractor=CssSelectorExtractor()),
        ),
    )
    return CapturePostingSnapshotUseCase(
        snapshot_repository=SqlitePostingSnapshotSetRepository(conn),
        acquisition_service=acquisition,
        publisher=DurableJobEventPublisher(conn, stage="enrich"),
        enrichment_repository=SqliteEnrichmentRepository(conn),
    )


def _manual_capture_posting(
    *,
    source_id: str,
    item_id: str,
    url: str,
    content: str,
    originating_url: str,
) -> ScrapedJobPosting:
    title = _extract_title(content) or "User-mediated captured posting"
    return ScrapedJobPosting(
        posting_url=PostingUrl(value=url),
        source=Source(board="User-mediated capture"),
        metadata=JobMetadata(
            title=title,
            salary="",
            description="Manual capture imported by the user.",
            location=_extract_location(content),
        ),
        strategy=SearchStrategy.MANUAL,
        source_id=source_id,
        source_native_id=item_id,
        canonical_url=url,
        ats_kind=AtsKind.OTHER,
    )


def _detail_page_from_manual_content(url: str, content: str) -> DetailPage:
    json_ld = tuple(_extract_json_ld(content))
    return DetailPage(
        url=url,
        final_url=url,
        page_title=_extract_title(content),
        html=content,
        json_ld=json_ld,
        status=200,
        fetched_at=utc_now(),
    )


def _extract_json_ld(content: str) -> list[dict[str, Any]]:
    matches = re.findall(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        content,
        flags=re.IGNORECASE | re.DOTALL,
    )
    parsed: list[dict[str, Any]] = []
    for raw in matches:
        try:
            data = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            parsed.append(data)
        elif isinstance(data, list):
            parsed.extend(item for item in data if isinstance(item, dict))
    return parsed


def _manual_capture_content(capture: ManualCaptureImport) -> str:
    if capture.content_text:
        return capture.content_text
    if capture.content_html_base64:
        return base64.b64decode(capture.content_html_base64).decode("utf-8")
    if capture.captured_url:
        return f"<main>Captured posting URL: {capture.captured_url}</main>"
    return ""


def _upsert_quarantine_entry(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    source_id: str,
    reason: str,
    confidence: float | None,
    snapshot_version: int | None,
    captured_at: str,
    title: str,
    posting_url: str,
    notice_text: str,
) -> None:
    conn.execute(
        """
        INSERT INTO discovery_quarantine_entries (
            tenant_id, job_id, job_key, title, company, source_id, posting_url,
            reason, confidence, snapshot_version, captured_at, notice_text,
            status
        ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(tenant_id, job_key) DO UPDATE SET
            title = excluded.title,
            source_id = excluded.source_id,
            posting_url = excluded.posting_url,
            reason = excluded.reason,
            confidence = excluded.confidence,
            snapshot_version = excluded.snapshot_version,
            captured_at = excluded.captured_at,
            notice_text = excluded.notice_text,
            status = excluded.status
        """,
        (
            str(LOCAL_TENANT),
            job_id,
            job_id,
            title,
            source_id,
            posting_url,
            reason,
            confidence,
            snapshot_version,
            captured_at,
            notice_text,
        ),
    )


def _seed_url(entry: SourceRegistryEntry) -> str | None:
    for key in ("seed_url", "url", "base_url"):
        value = entry.adapter_config.get(key)
        if value:
            return str(value)
    return None


def _detect_ats_kind(url: str) -> AtsKind | None:
    host = (urlparse(url).hostname or "").lower()
    if "greenhouse.io" in host:
        return AtsKind.GREENHOUSE
    if "lever.co" in host:
        return AtsKind.LEVER
    if "ashbyhq.com" in host:
        return AtsKind.ASHBY
    if "myworkdayjobs.com" in host:
        return AtsKind.WORKDAY
    return None


def _source_ats_kind(source_id: str, adapter_config: Mapping[str, Any]) -> AtsKind | None:
    raw = str(adapter_config.get("ats_kind") or source_id.split(":", 1)[0]).lower()
    for kind in AtsKind:
        if kind.value == raw:
            return kind
    seed = str(adapter_config.get("url") or adapter_config.get("seed_url") or "")
    return _detect_ats_kind(seed)


def _board_token(source_id: str, adapter_config: Mapping[str, Any]) -> str:
    return str(
        adapter_config.get("board_token")
        or _token_from_seed_url(adapter_config)
        or source_id.split(":", 1)[-1]
    ).strip()


def _site_token(source_id: str, adapter_config: Mapping[str, Any]) -> str:
    return str(
        adapter_config.get("site")
        or _token_from_seed_url(adapter_config)
        or source_id.split(":", 1)[-1]
    ).strip()


def _board_name(source_id: str, adapter_config: Mapping[str, Any]) -> str:
    return str(
        adapter_config.get("board_name")
        or _token_from_seed_url(adapter_config)
        or source_id.split(":", 1)[-1]
    ).strip()


def _token_from_seed_url(adapter_config: Mapping[str, Any]) -> str:
    seed = str(adapter_config.get("url") or adapter_config.get("seed_url") or "").strip()
    if not seed:
        return ""
    parsed = urlparse(seed)
    path = parsed.path.strip("/")
    if not path:
        return ""
    parts = [part for part in path.split("/") if part]
    if "postings" in parts:
        idx = parts.index("postings")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    if "boards" in parts:
        idx = parts.index("boards")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    if "job-board" in parts:
        idx = parts.index("job-board")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return parts[0]


def _company_name(source: Any, adapter_config: Mapping[str, Any]) -> str | None:
    return str(
        adapter_config.get("company")
        or adapter_config.get("name")
        or getattr(source, "display_name", "")
        or ""
    ).strip() or None


def _looks_protected(url: str) -> bool:
    text = url.lower()
    return any(
        marker in text
        for marker in (
            "login",
            "sso",
            "captcha",
            "protected",
            "internal",
            "auth",
        )
    )


def _event_job_url(event: DomainEvent) -> str | None:
    for key in ("job_id", "jobId", "job_url", "jobUrl"):
        value = event.payload.get(key)
        if value:
            return str(value)
    return None


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key]
    return row[index]


def _scalar_int(
    conn: sqlite3.Connection,
    sql: str,
    params: tuple[Any, ...],
) -> int:
    row = conn.execute(sql, params).fetchone()
    return int(row[0] or 0) if row else 0


def _json_dict(raw: object) -> dict[str, Any]:
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _extract_title(content: str) -> str:
    json_ld = _extract_json_ld(content)
    for item in json_ld:
        title = item.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
    match = re.search(r"<title>(.*?)</title>", content, flags=re.IGNORECASE | re.DOTALL)
    if match:
        return re.sub(r"\s+", " ", match.group(1)).strip()
    return ""


def _extract_location(content: str) -> str:
    for item in _extract_json_ld(content):
        location = item.get("jobLocation")
        if isinstance(location, dict):
            address = location.get("address")
            if isinstance(address, dict):
                parts = [
                    str(address.get(key) or "").strip()
                    for key in ("addressLocality", "addressRegion", "addressCountry")
                ]
                return ", ".join(part for part in parts if part)
    return ""
