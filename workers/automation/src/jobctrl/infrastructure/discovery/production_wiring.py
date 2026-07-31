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
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlparse

from jobctrl.database import (
    ensure_discovery_control_tables,
    ensure_posting_snapshot_tables,
    ensure_source_observation_tables,
)
from jobctrl.domain.discovery.identity import AtsKind, CanonicalJobIdentity
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.source_registry import (
    ATS_API_POLICY,
    LocatorPolicy,
    ManualActionReason,
    ManualActionRequired,
    SourceDiscoveryEvidence,
    SourceKind,
    SourceLocationCandidate,
    SourcePolicy,
    SourceRegistryEntry,
    validate_locator_candidate,
)
from jobctrl.domain.discovery.use_cases import (
    DiscoverJobsUseCase,
    PostingAcceptance,
    default_canonical_identity,
)
from jobctrl.domain.discovery.value_objects import (
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.errors import TransientNetworkError
from jobctrl.domain.enrichment import DetailPage, ExtractionTier, FullDescription, JobEnrichment
from jobctrl.domain.enrichment.services import CssSelectorExtractor, JsonLdExtractor
from jobctrl.domain.enrichment.snapshot_services import (
    ContentAcquisitionService,
    TierExtractor,
)
from jobctrl.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
from jobctrl.domain.enrichment.snapshot_value_objects import QuarantineReason
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.discovery.target_queries import query_specs_for_source, title_matches_any_query
from jobctrl.infrastructure.discovery.ats_adapters import (
    AshbyBoardAdapter,
    GreenhouseBoardAdapter,
    HttpFetcher,
    LeverBoardAdapter,
)
from jobctrl.infrastructure.discovery.location_filter import (
    configured_location_filters,
    location_matches_target,
)
from jobctrl.infrastructure.network import (
    GatewayHttpClient,
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
)
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.infrastructure.enrichment import (
    SqliteEnrichmentRepository,
    SqlitePostingSnapshotSetRepository,
)
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class SourceControlSeedSummary:
    registry_rows: int = 0
    locator_candidates: int = 0
    manual_action_count: int = 0


@dataclass(frozen=True)
class LearnedPostingSource:
    """Outcome of learning a durable posting source from a discovered job."""

    source_id: str | None
    canonical_url: str | None
    candidate_id: str | None
    action: str


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


_WORKDAY_HOST_ALIAS_SOURCE_RE = re.compile(r"^workday:(?P<employer>.+)-wd\d+-myworkdayjobs-com$")


class DurableJobEventPublisher:
    """Persist domain events to ``job_events`` while still fanning out locally."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        stage: str,
        write_fence: Callable[[], None] | None = None,
        idempotency_prefix: str | None = None,
    ) -> None:
        self._conn = conn
        self._stage = stage
        self._write_fence = write_fence
        self._idempotency_prefix = idempotency_prefix

    def publish(self, event: DomainEvent) -> None:
        if self._write_fence is not None:
            self._write_fence()
        payload = {"tenantId": str(event.tenant_id), **event.payload}
        job_id = _event_job_id(event)
        record_job_event(
            self._conn,
            job_id,
            self._stage,
            event.event_type,
            message=event.event_type,
            payload=payload,
            occurred_at=event.occurred_at,
            idempotency_key=(
                f"{self._idempotency_prefix}:{event.event_type}" if self._idempotency_prefix is not None else None
            ),
        )
        self._conn.commit()


def ensure_worker_discovery_tables(conn: sqlite3.Connection) -> None:
    ensure_source_observation_tables(conn)
    ensure_discovery_control_tables(conn)
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
        persisted += 1
        if decision == "promote":
            if _promote_locator_candidate(conn, candidate) and is_new:
                _record_locator_event(conn, candidate)
            continue
        if decision == "manual_action_required":
            if is_new:
                _record_locator_event(conn, candidate)
            _enqueue_manual_action_from_candidate(conn, candidate)
            _upsert_locator_candidate(conn, candidate)
            manual_actions += 1
        else:
            _delete_locator_candidate(conn, candidate.candidate_id)
    conn.commit()
    return persisted, manual_actions


def learn_posting_source_from_url(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    posting_url: str | None,
    discovered_via_source_id: str,
    observed_at: str,
    write_fence: Callable[[], None] | None = None,
    event_idempotency_prefix: str | None = None,
) -> LearnedPostingSource:
    """Learn a durable owner source from a broad-board posting URL.

    JobSpy often discovers a posting on a broad board while also exposing a
    direct apply/detail URL. When that direct URL is a known ATS, promote the
    owning ATS source into the registry and attach canonical identity to the
    broad-board job. Unknown direct URLs are kept in local review queues.
    """

    candidate_url = str(posting_url or "").strip()
    if not candidate_url:
        return LearnedPostingSource(
            source_id=None,
            canonical_url=None,
            candidate_id=None,
            action="skipped",
        )

    ensure_worker_discovery_tables(conn)
    _apply_optional_write_fence(write_fence)
    detected = _detect_ats_kind(candidate_url)
    if detected is None:
        candidate = _source_location_candidate(
            candidate_url=candidate_url,
            source_kind=SourceKind.EMPLOYER_CAREERS_PAGE,
            confidence=0.55,
            detected_ats_kind=None,
            employer_domain_matched=False,
            source_id=None,
            manual_reason=ManualActionReason.AMBIGUOUS_CAREER_SYSTEM,
            retry_context={
                "source": "broad_board_posting_url",
                "discovered_via_source_id": discovered_via_source_id,
                "job_url": job_url,
            },
        )
        if _locator_candidate_is_new(conn, candidate):
            _record_locator_event(
                conn,
                candidate,
                idempotency_key=_event_idempotency_key(
                    event_idempotency_prefix,
                    "SourceLocationCandidateDiscovered",
                ),
            )
        _upsert_locator_candidate(conn, candidate)
        _enqueue_manual_action_from_candidate(conn, candidate)
        conn.commit()
        return LearnedPostingSource(
            source_id=None,
            canonical_url=candidate_url,
            candidate_id=candidate.candidate_id,
            action="manual_review",
        )

    identity = CanonicalJobIdentity(
        canonical_url=candidate_url,
        ats_kind=detected,
        source_native_id=_source_native_id_from_url(candidate_url),
        confidence=0.82,
    )
    identity_repository = SqliteJobRepository(conn)
    resolved_job = identity_repository.resolve_by_posting_url(
        LOCAL_TENANT,
        PostingUrl(value=job_url),
    )
    if resolved_job is None:
        raise LookupError(f"Source learning references an unknown posting URL: {job_url!r}")
    _apply_optional_write_fence(write_fence)
    identity_repository.set_canonical_identity(
        LOCAL_TENANT,
        resolved_job.job_id,
        identity,
    )
    _apply_optional_write_fence(write_fence)
    _record_canonical_identity_resolved_event(
        conn,
        job_id=resolved_job.job_id,
        identity=identity,
        occurred_at=observed_at,
        idempotency_key=_event_idempotency_key(
            event_idempotency_prefix,
            "CanonicalJobIdentityResolved",
        ),
    )

    if detected is AtsKind.WORKDAY:
        candidate = _source_location_candidate(
            candidate_url=candidate_url,
            source_kind=SourceKind.ATS_API,
            confidence=0.82,
            detected_ats_kind=detected.value,
            employer_domain_matched=False,
            source_id=None,
            manual_reason=ManualActionReason.AMBIGUOUS_CAREER_SYSTEM,
            retry_context={
                "source": "broad_board_posting_url",
                "discovered_via_source_id": discovered_via_source_id,
                "job_url": job_url,
                "ats_kind": detected.value,
                "reason": "workday_adapter_config_required",
            },
        )
        if _locator_candidate_is_new(conn, candidate):
            _record_locator_event(
                conn,
                candidate,
                idempotency_key=_event_idempotency_key(
                    event_idempotency_prefix,
                    "SourceLocationCandidateDiscovered",
                ),
            )
        _upsert_locator_candidate(conn, candidate)
        _enqueue_manual_action_from_candidate(conn, candidate)
        conn.commit()
        return LearnedPostingSource(
            source_id=None,
            canonical_url=candidate_url,
            candidate_id=candidate.candidate_id,
            action="manual_review",
        )

    candidate = _source_location_candidate(
        candidate_url=candidate_url,
        source_kind=SourceKind.ATS_API,
        confidence=0.82,
        detected_ats_kind=detected.value,
        employer_domain_matched=False,
        source_id=discovered_via_source_id,
        manual_reason=None,
        retry_context={
            "source": "broad_board_posting_url",
            "discovered_via_source_id": discovered_via_source_id,
            "job_url": job_url,
        },
    )
    source_id = _source_id_from_locator_candidate(conn, candidate)
    _apply_optional_write_fence(write_fence)
    _promote_locator_candidate(
        conn,
        candidate,
        event_idempotency_prefix=event_idempotency_prefix,
    )
    conn.commit()
    return LearnedPostingSource(
        source_id=source_id,
        canonical_url=candidate_url,
        candidate_id=candidate.candidate_id,
        action="promoted",
    )


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
            adapter_config.get("url") or adapter_config.get("seed_url") or adapter_config.get("base_url") or ""
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
    gateway: PolitenessGateway | None = None,
    limit: int = 0,
    cancel_event: threading.Event | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
) -> dict[str, Any]:
    """Run Greenhouse, Lever, and Ashby through the Discovery use case.

    Each adapter fetches through the R10 politeness gateway: when no explicit
    ``http`` fetcher is injected (production), a per-source
    :class:`GatewayHttpClient` is built from the source policy so robots
    (exempt for documented APIs, D2), per-host rate/concurrency, the per-run
    request budget, and the honest UA all apply. Tests may inject ``http`` to
    bypass the network.
    """
    ensure_worker_discovery_tables(conn)
    resolved_gateway = gateway if gateway is not None else (PolitenessGateway() if http is None else None)
    runnable = tuple(source for source in sources if getattr(source, "should_run", True))
    adapters = tuple(
        _adapter_for_source(
            source,
            http=http,
            gateway=resolved_gateway,
            conn=conn,
            run_id=run_id,
            search_cfg=search_cfg,
        )
        for source in runnable
    )
    adapters = tuple(adapter for adapter in adapters if adapter is not None)
    if not adapters:
        return ScheduledAtsSummary().to_result_dict()

    job_repository = SqliteJobRepository(
        conn,
        discovery_execution=discovery_execution,
        source_family="ats_api" if discovery_execution is not None else None,
    )
    enrichment_repository = SqliteEnrichmentRepository(conn)
    use_case = DiscoverJobsUseCase(
        repository=job_repository,
        publisher=DurableJobEventPublisher(conn, stage="discover"),
        acceptance_policy=_posting_acceptance_policy(search_cfg),
    )
    total = 0
    new_jobs = 0
    observed_jobs = 0
    duplicate_jobs = 0
    rejected_duplicates = 0
    sources_run: list[str] = []
    failed_sources: list[str] = []
    remaining_new = limit if limit > 0 else None
    query_specs = tuple(_ats_query_specs(search_cfg))
    locations = tuple(_location_values(search_cfg))
    for adapter in adapters:
        if cancel_event is not None and cancel_event.is_set():
            raise TransientNetworkError("ATS discovery canceled")
        if remaining_new is not None and remaining_new <= 0:
            break
        source_processed = False
        seen_postings: set[tuple[str, str, str]] = set()
        try:
            for location in locations:
                if cancel_event is not None and cancel_event.is_set():
                    raise TransientNetworkError("ATS discovery canceled")
                if remaining_new is not None and remaining_new <= 0:
                    break
                for posting in adapter.scrape(
                    tenant_id=LOCAL_TENANT,
                    query="",
                    location=location,
                ):
                    if cancel_event is not None and cancel_event.is_set():
                        raise TransientNetworkError("ATS discovery canceled")
                    if remaining_new is not None and remaining_new <= 0:
                        break
                    if not title_matches_any_query(posting.metadata.title, query_specs):
                        continue
                    if not str(posting.metadata.description or "").strip():
                        continue
                    posting_key = _scraped_posting_key(posting)
                    if posting_key in seen_postings:
                        continue
                    seen_postings.add(posting_key)
                    summary = use_case.execute(
                        tenant_id=LOCAL_TENANT,
                        postings=[posting],
                        run_id=run_id,
                    )
                    if summary.new_jobs > 0 or summary.observed > 0:
                        _promote_ats_source_description_to_enrichment(
                            conn,
                            job_repository=job_repository,
                            enrichment_repository=enrichment_repository,
                            posting=posting,
                            observed_at=utc_now(),
                        )
                    total += summary.total
                    new_jobs += summary.new_jobs
                    observed_jobs += summary.observed
                    duplicate_jobs += summary.duplicates_linked
                    rejected_duplicates += summary.duplicates_rejected
                    source_processed = True
                    if remaining_new is not None and summary.new_jobs > 0:
                        remaining_new -= summary.new_jobs
        except Exception as exc:
            failed_sources.append(adapter.source_id)
            _record_ats_source_failure(conn, adapter.source_id, run_id, exc)
        if source_processed:
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


def _promote_ats_source_description_to_enrichment(
    conn: sqlite3.Connection,
    *,
    job_repository: SqliteJobRepository,
    enrichment_repository: SqliteEnrichmentRepository,
    posting: ScrapedJobPosting,
    observed_at: str,
) -> bool:
    description = str(posting.metadata.description or "").strip()
    if not description:
        return False

    identity = default_canonical_identity(posting)
    owner_match = job_repository.find_canonical_owner(
        LOCAL_TENANT,
        source_id=posting.source_id,
        source_native_id=identity.source_native_id,
        canonical_url=identity.canonical_url,
    )
    if owner_match is None:
        return False
    job_id = owner_match.job_id
    if job_repository.load(LOCAL_TENANT, job_id) is None:
        return False

    existing = enrichment_repository.load(LOCAL_TENANT, job_id)
    if existing is not None and (existing.is_enriched or existing.is_running):
        return False

    base = existing or JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        updated_at=observed_at,
    )
    succeeded = base.start_attempt(
        extraction_tier=ExtractionTier.CSS_SELECTORS,
        started_at=observed_at,
    ).succeed_attempt(
        full_description=FullDescription(text=description),
        application_url=None,
        extraction_tier=ExtractionTier.CSS_SELECTORS,
        finished_at=observed_at,
    )
    enrichment_repository.save(succeeded)

    ensure_job_stage_rows(conn, job_id, discovered_at=observed_at)
    stage_row = conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    stage_state = str(stage_row["state"] or "") if stage_row is not None else ""
    if stage_state != "succeeded":
        if stage_state != "running":
            try:
                set_stage_state(
                    conn,
                    job_id,
                    "enrich",
                    "running",
                    attempt_count=succeeded.attempt_count,
                    started_at=observed_at,
                )
            except ValueError:
                set_stage_state(
                    conn,
                    job_id,
                    "enrich",
                    "running",
                    attempt_count=succeeded.attempt_count,
                    started_at=observed_at,
                    validate_transition=False,
                )
        set_stage_state(
            conn,
            job_id,
            "enrich",
            "succeeded",
            attempt_count=succeeded.attempt_count,
            started_at=observed_at,
            finished_at=observed_at,
        )
        record_job_event(
            conn,
            job_id,
            "enrich",
            "StageCompleted",
            message=(f"ATS source description promoted to enrichment: {len(description)} description chars"),
            payload={
                "source_id": posting.source_id,
                "source_native_id": identity.source_native_id,
                "extraction_tier": ExtractionTier.CSS_SELECTORS.value,
                "description_length": len(description),
            },
            occurred_at=observed_at,
        )
    conn.commit()
    return True


def retire_invalid_source_jobs(
    conn: sqlite3.Connection,
    *,
    search_cfg: Mapping[str, Any],
    run_id: str = "discovery:hygiene",
) -> dict[str, Any]:
    """Soft-delete active discovered jobs that fail today's discovery contract."""

    ensure_source_observation_tables(conn)
    query_specs_by_family = _query_specs_by_family(search_cfg)
    accept_locs, reject_locs = configured_location_filters(search_cfg)
    locations = tuple(_location_values(search_cfg))
    now = utc_now()
    retired: list[dict[str, str]] = []

    rows = conn.execute(
        """
        SELECT
            j.job_id,
            j.url,
            COALESCE(j.title, '') AS title,
            COALESCE(j.location, '') AS location,
            COALESCE(e.full_description, '') AS enrichment_description,
            COALESCE(j.full_description, '') AS job_full_description,
            COALESCE(j.description, '') AS job_description,
            COALESCE(j.strategy, '') AS strategy,
            COALESCE(c.ats_kind, '') AS ats_kind,
            COALESCE(MIN(o.source_id), '') AS source_id
        FROM jobs j
        LEFT JOIN job_enrichments e
          ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id
        LEFT JOIN job_canonical_identities c
          ON c.tenant_id = j.tenant_id AND c.job_id = j.job_id
        LEFT JOIN job_source_observations o
          ON o.tenant_id = j.tenant_id AND o.job_id = j.job_id
        LEFT JOIN jobctrl_deleted_jobs d
          ON d.tenant_id = j.tenant_id AND d.job_id = j.job_id
         AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
        WHERE j.tenant_id = ? AND d.job_id IS NULL
        GROUP BY j.tenant_id, j.job_id
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()

    for row in rows:
        family = _source_family(
            source_id=str(row["source_id"] or ""),
            strategy=str(row["strategy"] or ""),
            ats_kind=str(row["ats_kind"] or ""),
        )
        if family is None:
            continue
        reasons = _source_rejection_reasons(
            title=str(row["title"] or ""),
            location=str(row["location"] or ""),
            description=_first_usable_description(
                row["enrichment_description"],
                row["job_full_description"],
                row["job_description"],
            ),
            query_specs=query_specs_by_family.get(family, ()),
            accept_locs=accept_locs,
            reject_locs=reject_locs,
            locations=locations,
        )
        if not reasons:
            continue
        source_id = str(row["source_id"] or row["ats_kind"] or family)
        reason = f"discovery hygiene rejected {source_id}: {', '.join(reasons)}"
        job_id = canonical_job_id(str(row["job_id"]))
        job_url = str(row["url"])
        conn.execute(
            """
            INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at)
            VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                deleted_at = excluded.deleted_at,
                reason = excluded.reason,
                restored_at = NULL
            """,
            (str(LOCAL_TENANT), str(job_id), now, reason),
        )
        record_job_event(
            conn,
            job_id,
            "discover",
            "JobDeleted",
            message=reason,
            payload={
                "reason": reason,
                "deleted_at": now,
                "run_id": run_id,
                "source_id": source_id,
                "rejection_reasons": reasons,
            },
            occurred_at=now,
        )
        retired.append({"job_url": job_url, "reason": reason})

    if retired:
        conn.commit()
    return {"retired_jobs": len(retired), "jobs": retired}


def _query_specs_by_family(search_cfg: Mapping[str, Any]) -> dict[str, tuple[dict[str, object], ...]]:
    query_specs_by_family = {
        "ats_api": tuple(_ats_query_specs(search_cfg)),
        "jobspy": tuple(query_specs_for_source(search_cfg.get("queries", []), "jobspy")),
        "smartextract": tuple(query_specs_for_source(search_cfg.get("queries", []), "smartextract")),
        "workday": tuple(
            query_specs_for_source(
                search_cfg.get("queries", []),
                "workday",
                max_tier=int(search_cfg.get("workday_max_tier") or 2),
            )
        ),
    }
    if not query_specs_by_family["workday"]:
        query_specs_by_family["workday"] = tuple(query_specs_for_source(search_cfg.get("queries", []), "workday"))
    return query_specs_by_family


def _posting_acceptance_policy(search_cfg: Mapping[str, Any]):
    query_specs_by_family = _query_specs_by_family(search_cfg)
    accept_locs, reject_locs = configured_location_filters(search_cfg)
    locations = tuple(_location_values(search_cfg))

    def policy(posting: ScrapedJobPosting) -> PostingAcceptance:
        strategy = str(getattr(posting.strategy, "value", posting.strategy) or "")
        ats_kind = str(getattr(posting.ats_kind, "value", posting.ats_kind) or "")
        family = _source_family(
            source_id=str(posting.source_id or ""),
            strategy=strategy,
            ats_kind=ats_kind,
        )
        if family is None:
            return PostingAcceptance.accept()
        reasons = _source_rejection_reasons(
            title=str(posting.metadata.title or ""),
            location=str(posting.metadata.location or ""),
            description=str(posting.metadata.description or ""),
            query_specs=query_specs_by_family.get(family, ()),
            accept_locs=accept_locs,
            reject_locs=reject_locs,
            locations=locations,
        )
        if not reasons:
            return PostingAcceptance.accept()
        source_id = str(posting.source_id or ats_kind or family)
        return PostingAcceptance.reject(
            reason=f"discovery policy rejected {source_id}",
            rejection_reasons=reasons,
        )

    return policy


def retire_invalid_canonical_ats_jobs(
    conn: sqlite3.Connection,
    *,
    search_cfg: Mapping[str, Any],
    run_id: str = "discovery:hygiene",
) -> dict[str, Any]:
    """Backward-compatible wrapper for the broader source hygiene pass."""

    return retire_invalid_source_jobs(conn, search_cfg=search_cfg, run_id=run_id)


def _source_family(*, source_id: str, strategy: str, ats_kind: str) -> str | None:
    if ats_kind in {"greenhouse", "lever", "ashby"} or source_id.startswith(("greenhouse:", "lever:", "ashby:")):
        return "ats_api"
    if ats_kind == "workday" or source_id.startswith("workday:") or strategy == "workday_api":
        return "workday"
    if source_id.startswith("jobspy:") or strategy == "jobspy":
        return "jobspy"
    if source_id.startswith("smart_extract:") or strategy in {
        "api_response",
        "css_selectors",
        "json_ld",
        "smart_extract",
        "static",
    }:
        return "smartextract"
    return None


_NULL_DESCRIPTION_SENTINELS = {"<na>", "nan", "nat", "none", "null"}


def _first_usable_description(*values: object) -> str:
    for value in values:
        text = _usable_description_text(value)
        if text:
            return text
    return ""


def _usable_description_text(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.casefold() in _NULL_DESCRIPTION_SENTINELS:
        return ""
    return text


def _source_rejection_reasons(
    *,
    title: str,
    location: str,
    description: str,
    query_specs: tuple[dict[str, object], ...],
    accept_locs: list[str],
    reject_locs: list[str],
    locations: tuple[str, ...],
) -> list[str]:
    reasons: list[str] = []
    effective_accept_locs = accept_locs or [location for location in locations if location]
    location_evidence = " ".join(str(part).strip() for part in (location, title) if str(part or "").strip())
    if not _usable_description_text(description):
        reasons.append("missing_description")
    if query_specs and not title_matches_any_query(title, query_specs):
        reasons.append("title_mismatch")
    if not any(
        location_matches_target(
            location_evidence,
            accept=effective_accept_locs,
            reject=reject_locs,
            search_location=target_location,
        )
        for target_location in locations
    ):
        reasons.append("location_mismatch")
    return reasons


def _scraped_posting_key(posting: ScrapedJobPosting) -> tuple[str, str, str]:
    return (
        str(posting.source_id or ""),
        str(posting.source_native_id or ""),
        str(posting.canonical_url or posting.posting_url.value),
    )


def import_manual_capture_item(
    conn: sqlite3.Connection,
    capture: ManualCaptureImport,
    *,
    tenant_id: TenantId = LOCAL_TENANT,
) -> ManualCaptureImportOutcome:
    """Import one queued manual capture through Discovery + Enrichment."""
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
    content = manual_capture_content(capture)
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
    capture_client = retry_context.get("capture_client")
    if isinstance(capture_client, str) and capture_client.strip():
        retry_context["manual_capture_provenance"]["capture_client"] = capture_client.strip()
    extension_version = retry_context.get("extension_version")
    if isinstance(extension_version, str) and extension_version.strip():
        retry_context["manual_capture_provenance"]["extension_version"] = extension_version.strip()

    repository = SqliteJobRepository(conn)
    use_case = DiscoverJobsUseCase(
        repository=repository,
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
    identity = repository.resolve_by_posting_url(tenant_id, posting.posting_url)
    if identity is None:
        raise RuntimeError("Manual capture import did not persist a canonical JobId")
    job_id = identity.job_id

    snapshot_use_case = _manual_capture_snapshot_use_case(
        conn,
        captured_url=captured_url,
        content=content,
    )
    outcome = snapshot_use_case.execute(
        tenant_id=tenant_id,
        job_id=job_id,
        url=captured_url,
        source_id=str(source_id),
        policy_id="user_mediated_capture",
        promote_to_job_enrichment=True,
    )
    quarantine_reason = (
        outcome.snapshot_set.latest_snapshot.quarantine_reason.value if outcome.snapshot_set.latest_snapshot else ""
    )
    if outcome.ok and quarantine_reason and quarantine_reason != QuarantineReason.NONE.value:
        _upsert_quarantine_entry(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
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
             job_id = ?
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
            str(job_id),
            str(tenant_id),
            capture.item_id,
        ),
    )
    conn.commit()
    return ManualCaptureImportOutcome(
        item_id=capture.item_id,
        job_id=str(job_id),
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
        SELECT COUNT(DISTINCT job_id)
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
        "SELECT COUNT(DISTINCT job_id) FROM job_canonical_identities WHERE tenant_id = ?",
        (tenant,),
    )
    canonical_verification_rate = round(canonical_jobs / lead_yield, 4) if lead_yield else 0.0
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
        JOIN job_enrichments e ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id
        LEFT JOIN discovery_quarantine_entries q
          ON q.tenant_id = j.tenant_id AND q.job_id = j.job_id AND q.status = 'pending'
        WHERE j.tenant_id = ?
          AND e.current_status = 'enriched'
          AND j.fit_score IS NULL
          AND q.job_id IS NULL
        """,
        (tenant,),
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
        reason = ManualActionReason.PROTECTED_INTERNAL_SITE if protected else None
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
            confidence=0.82,
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
            (candidate.manual_action_required.reason.value if candidate.manual_action_required else None),
            candidate.discovered_at,
        ),
    )


def _promote_locator_candidate(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
    *,
    event_idempotency_prefix: str | None = None,
) -> bool:
    source_id = _source_id_from_locator_candidate(conn, candidate)
    now = utc_now()
    existing = conn.execute(
        """
        SELECT source_id, state, policy_id, seed_url, created_at
        FROM source_registry_entries
        WHERE tenant_id = ? AND source_id = ?
        """,
        (str(candidate.tenant_id), source_id),
    ).fetchone()
    if existing is None:
        kind = SourceKind.ATS_API.value if candidate.evidence.detected_ats_kind else candidate.source_kind.value
        policy_id = _policy_id_for_promoted_source(source_id, candidate)
        conn.execute(
            """
            INSERT INTO source_registry_entries (
                tenant_id, source_id, kind, display_name, owner, priority,
                state, policy_id, seed_url, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'system', ?, 'active', ?, ?, ?, ?)
            """,
            (
                str(candidate.tenant_id),
                source_id,
                kind,
                _source_display_name_from_url(candidate.candidate_url),
                _default_priority_value(kind),
                policy_id,
                candidate.candidate_url,
                now,
                now,
            ),
        )
        _record_source_registry_created_event(
            conn,
            source_id=source_id,
            kind=kind,
            policy_id=policy_id,
            state="active",
            occurred_at=now,
            idempotency_key=_event_idempotency_key(
                event_idempotency_prefix,
                "SourceRegistryEntryCreated",
            ),
        )
        changed = True
    else:
        changed_fields: list[str] = []
        if str(existing["state"]) != "active":
            changed_fields.append("state")
        if existing["seed_url"] is None:
            changed_fields.append("seedUrl")
        conn.execute(
            """
            UPDATE source_registry_entries
            SET state = 'active',
                seed_url = COALESCE(seed_url, ?),
                updated_at = ?
            WHERE tenant_id = ? AND source_id = ?
            """,
            (candidate.candidate_url, now, str(candidate.tenant_id), source_id),
        )
        if changed_fields:
            _record_source_registry_updated_event(
                conn,
                source_id=source_id,
                changed_fields=tuple(changed_fields),
                occurred_at=now,
                idempotency_key=_event_idempotency_key(
                    event_idempotency_prefix,
                    "SourceRegistryEntryUpdated",
                ),
            )
        changed = bool(changed_fields)
    had_pending_candidate = not _locator_candidate_is_new(conn, candidate)
    _delete_locator_candidate(conn, candidate.candidate_id)
    if changed or had_pending_candidate:
        _record_locator_promoted_event(
            conn,
            candidate_id=candidate.candidate_id,
            source_id=source_id,
            occurred_at=now,
            idempotency_key=_event_idempotency_key(
                event_idempotency_prefix,
                "SourceLocationCandidatePromoted",
            ),
        )
    return changed or had_pending_candidate


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


def _delete_locator_candidate(conn: sqlite3.Connection, candidate_id: str) -> None:
    conn.execute(
        """
        DELETE FROM source_locator_candidates
        WHERE tenant_id = ? AND candidate_id = ?
        """,
        (str(LOCAL_TENANT), candidate_id),
    )


def _record_locator_event(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
    *,
    idempotency_key: str | None = None,
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
        idempotency_key=idempotency_key,
    )


def _record_locator_promoted_event(
    conn: sqlite3.Connection,
    *,
    candidate_id: str,
    source_id: str,
    occurred_at: str,
    idempotency_key: str | None = None,
) -> None:
    record_job_event(
        conn,
        None,
        "discover",
        "SourceLocationCandidatePromoted",
        message="Source location candidate promoted.",
        payload={
            "tenantId": str(LOCAL_TENANT),
            "candidate_id": candidate_id,
            "candidateId": candidate_id,
            "source_id": source_id,
            "sourceId": source_id,
            "promoted_at": occurred_at,
            "promotedAt": occurred_at,
        },
        occurred_at=occurred_at,
        idempotency_key=idempotency_key,
    )


def _record_source_registry_created_event(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    kind: str,
    policy_id: str,
    state: str,
    occurred_at: str,
    idempotency_key: str | None = None,
) -> None:
    record_job_event(
        conn,
        None,
        "discover",
        "SourceRegistryEntryCreated",
        message="Source registry entry created.",
        payload={
            "tenantId": str(LOCAL_TENANT),
            "source_id": source_id,
            "sourceId": source_id,
            "kind": kind,
            "policy_id": policy_id,
            "policyId": policy_id,
            "state": state,
            "created_at": occurred_at,
            "createdAt": occurred_at,
        },
        occurred_at=occurred_at,
        idempotency_key=idempotency_key,
    )


def _record_source_registry_updated_event(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    changed_fields: tuple[str, ...],
    occurred_at: str,
    idempotency_key: str | None = None,
) -> None:
    record_job_event(
        conn,
        None,
        "discover",
        "SourceRegistryEntryUpdated",
        message="Source registry entry updated.",
        payload={
            "tenantId": str(LOCAL_TENANT),
            "source_id": source_id,
            "sourceId": source_id,
            "changed_fields": list(changed_fields),
            "changedFields": list(changed_fields),
            "updated_at": occurred_at,
            "updatedAt": occurred_at,
        },
        occurred_at=occurred_at,
        idempotency_key=idempotency_key,
    )


def _record_canonical_identity_resolved_event(
    conn: sqlite3.Connection,
    *,
    job_id: JobId,
    identity: CanonicalJobIdentity,
    occurred_at: str,
    idempotency_key: str | None = None,
) -> None:
    record_job_event(
        conn,
        job_id,
        "discover",
        "CanonicalJobIdentityResolved",
        message="Canonical job identity resolved.",
        payload={
            "tenantId": str(LOCAL_TENANT),
            "job_id": str(job_id),
            "jobId": str(job_id),
            "canonical_url": identity.canonical_url,
            "canonicalUrl": identity.canonical_url,
            "ats_kind": identity.ats_kind.value,
            "atsKind": identity.ats_kind.value,
            "source_native_id": identity.source_native_id,
            "sourceNativeId": identity.source_native_id,
            "confidence": identity.confidence,
        },
        occurred_at=occurred_at,
        idempotency_key=idempotency_key,
    )


def _apply_optional_write_fence(write_fence: Callable[[], None] | None) -> None:
    if write_fence is not None:
        write_fence()


def _event_idempotency_key(prefix: str | None, event_type: str) -> str | None:
    return f"{prefix}:{event_type}" if prefix is not None else None


def _enqueue_manual_action_from_candidate(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
) -> None:
    manual = candidate.manual_action_required
    reason = manual.reason.value if manual else ManualActionReason.AMBIGUOUS_CAREER_SYSTEM.value
    retry_context = (
        manual.retry_context
        if manual
        else {
            "source": "locator_candidate",
            "candidate_id": candidate.candidate_id,
        }
    )
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


def _source_id_from_locator_candidate(
    conn: sqlite3.Connection,
    candidate: SourceLocationCandidate,
) -> str:
    slug = _source_slug_from_locator_url(
        candidate.candidate_url,
        candidate.evidence.detected_ats_kind,
    )
    if candidate.evidence.detected_ats_kind == AtsKind.WORKDAY.value:
        canonical_workday_id = _canonical_workday_source_id_for_alias(f"{AtsKind.WORKDAY.value}:{slug}")
        if canonical_workday_id:
            existing_canonical = conn.execute(
                """
                SELECT source_id
                FROM source_registry_entries
                WHERE tenant_id = ? AND source_id = ?
                LIMIT 1
                """,
                (str(candidate.tenant_id), canonical_workday_id),
            ).fetchone()
            if existing_canonical is not None:
                return str(existing_canonical["source_id"])
    existing = conn.execute(
        """
        SELECT source_id
        FROM source_registry_entries
        WHERE tenant_id = ? AND seed_url = ?
        ORDER BY CASE WHEN owner = 'system' THEN 0 ELSE 1 END,
                 LENGTH(source_id) ASC,
                 source_id ASC
        LIMIT 1
        """,
        (str(candidate.tenant_id), candidate.candidate_url),
    ).fetchone()
    if existing is not None:
        return str(existing["source_id"])
    if candidate.evidence.detected_ats_kind:
        return f"{candidate.evidence.detected_ats_kind}:{slug}"
    return f"{candidate.source_kind.value}:{slug}"


def _canonical_workday_source_id_for_alias(source_id: str) -> str | None:
    match = _WORKDAY_HOST_ALIAS_SOURCE_RE.match(source_id)
    if not match:
        return None
    return f"workday:{match.group('employer')}"


def _source_slug_from_locator_url(url: str, ats_kind: str | None) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    segments = [segment for segment in parsed.path.split("/") if segment]
    if ats_kind == AtsKind.GREENHOUSE.value:
        if "boards" in segments:
            index = segments.index("boards")
            if len(segments) > index + 1:
                return _slug_text(segments[index + 1])
        if "greenhouse.io" in host and segments:
            return _slug_text(segments[0])
    if ats_kind == AtsKind.LEVER.value:
        if "postings" in segments:
            index = segments.index("postings")
            if len(segments) > index + 1:
                return _slug_text(segments[index + 1])
        if segments:
            return _slug_text(segments[0])
    if ats_kind == AtsKind.ASHBY.value:
        if "job-board" in segments:
            index = segments.index("job-board")
            if len(segments) > index + 1:
                return _slug_text(segments[index + 1])
        if segments:
            return _slug_text(segments[0])
    return _slug_text(host or url)


def _source_display_name_from_url(url: str) -> str:
    host = (urlparse(url).hostname or "").removeprefix("www.")
    return host or url


def _default_priority_value(kind: str) -> str:
    if kind == SourceKind.ATS_API.value:
        return "canonical"
    if kind == SourceKind.BROAD_BOARD.value:
        return "lead_generator"
    if kind == SourceKind.SMART_EXTRACT.value:
        return "fallback"
    return "standard"


def _policy_id_for_promoted_source(
    source_id: str,
    candidate: SourceLocationCandidate,
) -> str:
    if candidate.evidence.detected_ats_kind == AtsKind.WORKDAY.value:
        return "workday_api_canonical"
    if candidate.evidence.detected_ats_kind is not None:
        return "ats_api_canonical"
    return f"local:{source_id}"


def _slug_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-") or "source"


def _source_native_id_from_url(url: str) -> str:
    parsed = urlparse(url)
    segments = [segment for segment in parsed.path.split("/") if segment]
    if "jobs" in segments:
        index = segments.index("jobs")
        if len(segments) > index + 1:
            return segments[index + 1]
    if "postings" in segments:
        index = segments.index("postings")
        if len(segments) > index + 2:
            return segments[index + 2]
    if segments:
        return segments[-1]
    return url


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


def _adapter_for_source(
    source: Any,
    *,
    http: HttpFetcher | None,
    gateway: PolitenessGateway | None,
    conn: sqlite3.Connection | None,
    run_id: str | None,
    search_cfg: Mapping[str, Any],
) -> Any | None:
    source_id = str(getattr(source, "source_id", "")).strip()
    if source_id.startswith("workday:"):
        return None
    adapter_config = dict(getattr(source, "adapter_config", {}) or {})
    ats_kind = _source_ats_kind(source_id, adapter_config)
    location_accept, location_reject = configured_location_filters(search_cfg)
    if ats_kind not in (AtsKind.GREENHOUSE, AtsKind.LEVER, AtsKind.ASHBY):
        return None
    fetcher = (
        http
        if http is not None
        else _gateway_ats_fetcher(
            source,
            source_id=source_id,
            ats_kind=ats_kind,
            gateway=gateway,
            conn=conn,
            run_id=run_id,
        )
    )
    common = dict(
        source_id=source_id,
        company=_company_name(source, adapter_config),
        http=fetcher,
        location_accept=location_accept,
        location_reject=location_reject,
    )
    if ats_kind is AtsKind.GREENHOUSE:
        return GreenhouseBoardAdapter(board_token=_board_token(source_id, adapter_config), **common)
    if ats_kind is AtsKind.LEVER:
        return LeverBoardAdapter(site=_site_token(source_id, adapter_config), **common)
    return AshbyBoardAdapter(board_name=_board_name(source_id, adapter_config), **common)


def _gateway_ats_fetcher(
    source: Any,
    *,
    source_id: str,
    ats_kind: AtsKind,
    gateway: PolitenessGateway | None,
    conn: sqlite3.Connection | None,
    run_id: str | None,
) -> HttpFetcher:
    """Build a per-source gateway-routed JSON fetcher for an ATS adapter."""
    active_gateway = gateway if gateway is not None else PolitenessGateway()
    policy: SourcePolicy = getattr(source, "policy", None) or ATS_API_POLICY
    context = PolitenessSourceContext(
        stage="discover",
        source_id=source_id,
        source_kind=_enum_value(getattr(source, "source_kind", None)),
        source_priority=_enum_value(getattr(source, "priority", None)),
        source_role="ats_api",
        adapter=f"{ats_kind.value}_api",
        run_id=run_id,
    )
    session = PolitenessSession(
        active_gateway,
        policy=policy,
        budget=active_gateway.new_run_budget(policy.max_requests_per_run),
        context=context,
        recorder_conn=conn,
    )
    return GatewayHttpClient(session).fetch_json


def _enum_value(value: Any) -> str | None:
    if value is None:
        return None
    return getattr(value, "value", str(value))


def _ats_query_specs(search_cfg: Mapping[str, Any]) -> tuple[dict[str, object], ...]:
    queries_cfg = search_cfg.get("queries", [])
    queries = query_specs_for_source(
        (item for item in queries_cfg if isinstance(item, Mapping)),
        "ats_api",
        max_tier=int(search_cfg.get("ats_max_tier") or 2),
    )
    if not queries:
        queries = query_specs_for_source(
            (item for item in queries_cfg if isinstance(item, Mapping)),
            "ats_api",
        )
    return tuple(queries)


def _location_values(search_cfg: Mapping[str, Any]) -> tuple[str, ...]:
    locations_cfg = search_cfg.get("locations", [])
    locations = [
        str(item.get("location") or item.get("label") or "").strip()
        for item in locations_cfg
        if isinstance(item, Mapping)
    ]
    locations = [location for location in locations if location] or [""]
    return tuple(locations)


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


def manual_capture_content(capture: ManualCaptureImport) -> str:
    """Return the canonical content used to identify a manual capture import.

    Temporal retry recovery hashes this exact value before reusing an already
    imported queue row. Keeping the transform beside the importer prevents the
    activity and the canonical Discovery path from drifting apart.
    """
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
    tenant_id: TenantId,
    job_id: JobId,
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
            tenant_id, job_id, title, company, source_id, posting_url,
            reason, confidence, snapshot_version, captured_at, notice_text,
            status
        ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
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
            str(tenant_id),
            str(job_id),
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
        adapter_config.get("board_token") or _token_from_seed_url(adapter_config) or source_id.split(":", 1)[-1]
    ).strip()


def _site_token(source_id: str, adapter_config: Mapping[str, Any]) -> str:
    return str(
        adapter_config.get("site") or _token_from_seed_url(adapter_config) or source_id.split(":", 1)[-1]
    ).strip()


def _board_name(source_id: str, adapter_config: Mapping[str, Any]) -> str:
    return str(
        adapter_config.get("board_name") or _token_from_seed_url(adapter_config) or source_id.split(":", 1)[-1]
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
    return (
        str(
            adapter_config.get("company") or adapter_config.get("name") or getattr(source, "display_name", "") or ""
        ).strip()
        or None
    )


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


def _event_job_id(event: DomainEvent) -> JobId | None:
    for key in ("job_id", "jobId", "surviving_job_id"):
        value = event.payload.get(key)
        if value:
            return canonical_job_id(str(value))
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
