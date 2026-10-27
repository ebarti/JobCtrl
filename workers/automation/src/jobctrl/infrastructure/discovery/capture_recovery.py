"""Ingest unconsumed source payloads retained by the exact-v14 capture store.

The retired model's status, result and preferences are never read. Recovery
uses the current canonical ingestion boundary, just like a fetched posting.
"""

import hashlib
import json
from datetime import datetime, timezone

from pydantic import TypeAdapter, ValidationError

from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.infrastructure.discovery.result_budget import DiscoveryResultLimitReached

_CAPTURE_FAILURE_CODES = ("captured_posting_invalid", "captured_posting_source_mismatch")


def recover_captured_postings(
    conn,
    *,
    tenant_id,
    source_ids,
    source_family,
    search_cfg,
    run_id,
    discovery_execution=None,
    limit=0,
    cancel_event=None,
    result_budget=None,
    activity_attempt=None,
    activity_owner_token=None,
):
    """Consume at most 100 archived captures, counting only new jobs toward limit."""
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher

    result = {"new": 0, "existing": 0, "recovered_captures": 0, "recovered_exclusions": 0,
              "recovered_capture_failures": 0}
    if not source_ids:
        return result
    rows = conn.execute(
        "SELECT listing_id,snapshot_fingerprint,target_fingerprint,source_id,posting_json "
        "FROM posting_triage WHERE tenant_id=? AND consumed_at IS NULL AND posting_json IS NOT NULL "
        "AND (failure_code IS NULL OR failure_code NOT IN (?,?)) "
        "AND source_id IN (" + ",".join("?" for _ in source_ids) + ") "
        "ORDER BY created_at,listing_id,snapshot_fingerprint,target_fingerprint LIMIT 100",
        (str(tenant_id), *_CAPTURE_FAILURE_CODES, *source_ids),
    ).fetchall()
    repository = SqliteJobRepository(
        conn,
        discovery_execution=discovery_execution,
        source_family=source_family if discovery_execution is not None else None,
    )
    smart_clients = {}
    for listing_id, snapshot, target, source_id, payload in rows:
        if cancel_event is not None and cancel_event.is_set():
            break
        if limit > 0 and result["new"] >= limit:
            break
        if result_budget is not None and (
            result_budget.run_exhausted() or result_budget.source_exhausted(source_id)
        ):
            continue
        capture_key = hashlib.sha256(
            json.dumps([str(tenant_id), listing_id, snapshot, target]).encode()
        ).hexdigest()
        failure = None
        try:
            posting = TypeAdapter(ScrapedJobPosting).validate_json(payload)
        except (ValidationError, ValueError):
            failure = "captured_posting_invalid"
        else:
            if posting.source_id != source_id:
                failure = "captured_posting_source_mismatch"
        if failure is not None:
            from jobctrl.state import record_job_event

            try:
                conn.execute(
                    "UPDATE posting_triage SET failure_code=?,last_attempt_at=? WHERE tenant_id=? "
                    "AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=?",
                    (failure, datetime.now(timezone.utc).isoformat(), str(tenant_id), listing_id, snapshot, target),
                )
                record_job_event(
                    conn, None, "discover", "StageProgress", tenant_id=TenantId(str(tenant_id)),
                    level="warning", message="An archived source capture is invalid; fresh searches continue.",
                    payload={"sourceId": source_id, "runId": run_id, "captureId": capture_key,
                             "errorCode": failure, "retryable": False, "reason": "capture_quarantined"},
                    entity_kind="discovery_capture", entity_ref=capture_key,
                    idempotency_key=f"capture-invalid:{capture_key}",
                )
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            result["recovered_capture_failures"] += 1
            continue
        if source_family == "smartextract":
            from jobctrl.discovery.smartextract import _smart_extract_session, _store_jobs
            from jobctrl.infrastructure.discovery.live_browser import (
                LiveChromeDiscoveryClient, PoliteLiveChromeHttpClient, prefer_live_browser,
            )

            if source_id not in smart_clients:
                selected = None
                if discovery_execution is not None:
                    client = LiveChromeDiscoveryClient(
                        discovery_execution, source_family=source_family, source_id=source_id, cancel_event=cancel_event,
                    )
                    if prefer_live_browser(client, cancel_event=cancel_event) is not None:
                        selected = PoliteLiveChromeHttpClient(
                            _smart_extract_session(source_id=source_id, run_id=run_id, browser=client), client,
                        )
                smart_clients[source_id] = selected
            try:
                new, existing = _store_jobs(
                    conn, [{"url": posting.posting_url.value, "title": posting.metadata.title,
                            "company": posting.employer.name, "description": posting.metadata.description,
                            "location": posting.metadata.location}], posting.source.board, posting.strategy.value,
                    search_cfg=search_cfg, limit=max(limit - result["new"], 0) if limit > 0 else 0, run_id=run_id,
                    discovery_execution=discovery_execution, cancel_event=cancel_event, source_id=source_id,
                    source_native_id=posting.source_native_id, tenant_id=TenantId(str(tenant_id)),
                    refresh_existing_job=False, observation_id_factory=lambda key=capture_key: f"capture:{key}",
                    idempotency_prefix=f"capture:{capture_key}", browser_client=smart_clients[source_id],
                    result_budget=result_budget,
                )
            except DiscoveryResultLimitReached:
                continue
            excluded = not (new or existing)
        else:
            if result_budget is not None:
                repository = SqliteJobRepository(
                    conn, discovery_execution=discovery_execution, source_family=source_family,
                    result_budget=result_budget, result_budget_source_id=source_id,
                )
            try:
                summary = DiscoverJobsUseCase(
                    repository=repository,
                    publisher=DurableJobEventPublisher(conn, stage="discover", idempotency_prefix=f"capture:{capture_key}"),
                    exact_title_exclusions=tuple(search_cfg.get("exact_title_exclusions") or ()),
                    observation_id_factory=lambda key=capture_key: f"capture:{key}",
                    refresh_existing_job=False,
                ).execute(tenant_id=TenantId(str(tenant_id)), postings=[posting], run_id=run_id)
            except DiscoveryResultLimitReached:
                # The canonical insert rolled back after a competing writer
                # used the allowance. Leave this archived capture unconsumed.
                continue
            new, existing, excluded = summary.new_jobs, summary.observed, not summary.total
        conn.execute(
            "UPDATE posting_triage SET consumed_at=? WHERE tenant_id=? AND listing_id=? "
            "AND snapshot_fingerprint=? AND target_fingerprint=? AND consumed_at IS NULL",
            (datetime.now(timezone.utc).isoformat(), str(tenant_id), listing_id, snapshot, target),
        )
        conn.commit()
        result["new"] += new
        result["existing"] += existing
        result["recovered_captures"] += 1
        result["recovered_exclusions"] += excluded
    return result
