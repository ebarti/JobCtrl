"""Recheck a recorded public-fetch failure without relaxing request safety."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import re
import sqlite3
from typing import Any
from urllib.parse import urlsplit

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind
from jobctrl.infrastructure.network.url_safety import PublicUrlDecision, validate_public_http_url
from jobctrl.state import record_job_event, set_stage_state

_MAX_CHECKS = 5
_CHECK_BATCH_SIZE = 5
_CHECK_TIMEOUT_SECONDS = 10
_LEGACY_TRANSIENT_FAILURES = {
    "<urlopen error [Errno 60] Operation timed out>": PublicFetchFailureKind.TIMEOUT,
    "<urlopen error [Errno 110] Connection timed out>": PublicFetchFailureKind.TIMEOUT,
    "<urlopen error [Errno 54] Connection reset by peer>": PublicFetchFailureKind.CONNECTION,
    "<urlopen error [Errno 104] Connection reset by peer>": PublicFetchFailureKind.CONNECTION,
}
_STOP_EVENTS = ("StageCanceled", "StageReset", "StageQueued", "StageStarted", "StageCompleted", "StageExhausted", "StageBlocked")
DestinationChecker = Callable[[tuple[str, str]], Awaitable[tuple[PublicUrlDecision, PublicUrlDecision]]]


@dataclass(frozen=True)
class _FailureCandidate:
    row: dict[str, Any]
    event_id: int
    failure: dict[str, Any]
    metadata: dict[str, Any]
    recovery: dict[str, Any]
    observed_at: datetime


def _object(value: str | None) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _instant(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)


def _legacy_kind(message: str) -> PublicFetchFailureKind | None:
    match = re.fullmatch(r"URL host resolves to a non-public address: ([0-9a-fA-F:.]+)", message)
    if match:
        try:
            if not ipaddress.ip_address(match[1]).is_global:
                return PublicFetchFailureKind.DNS_NON_PUBLIC
        except ValueError:
            pass
    return _LEGACY_TRANSIENT_FAILURES.get(message)


def _candidate(conn: sqlite3.Connection, job_id: str) -> _FailureCandidate | None:
    row = conn.execute(
        """
        SELECT s.*, j.url AS posting_url, e.attempts_json, e.updated_at AS enrichment_updated_at
        FROM job_stage_states s JOIN jobs j USING (tenant_id, job_id)
        JOIN job_enrichments e USING (tenant_id, job_id)
        LEFT JOIN posting_snapshot_sets p USING (tenant_id, job_id)
        WHERE s.tenant_id = ? AND s.job_id = ? AND s.stage = 'enrich'
          AND s.state = 'failed' AND s.retryable = 0 AND s.error_code = 'DETAIL_UNSAFE_URL'
          AND e.current_status = 'failed' AND COALESCE(e.full_description, '') = ''
          AND s.attempt_count > 0 AND s.attempt_count < MIN(5, s.max_attempts)
          AND COALESCE(p.latest_active_state, '') NOT IN ('closed', 'expired', 'removed', 'location_incompatible')
          AND NOT EXISTS (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id = s.tenant_id AND d.job_id = s.job_id
            AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at)))
        """,
        (str(LOCAL_TENANT), job_id),
    ).fetchone()
    if row is None:
        return None
    raw = dict(row)
    try:
        attempts = json.loads(row["attempts_json"])
    except (TypeError, ValueError):
        return None
    if not isinstance(attempts, list) or len(attempts) != row["attempt_count"]:
        return None
    last = attempts[-1]
    if not isinstance(last, dict) or last.get("status") != "failed" or last.get("attempt_number") != row["attempt_count"]:
        return None
    error = last.get("error")
    if (
        not isinstance(error, dict) or error.get("code") != row["error_code"]
        or error.get("message") != row["error_message"] or error.get("retryable") is not False
    ):
        return None
    event = conn.execute(
        "SELECT event_id, occurred_at, payload_json FROM job_events "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich' AND event_type = 'StageFailed' "
        "ORDER BY event_id DESC LIMIT 1",
        (str(LOCAL_TENANT), job_id),
    ).fetchone()
    if event is None:
        return None
    payload = _object(event["payload_json"])
    if (
        payload.get("errorCode") != row["error_code"]
        or payload.get("errorMessage") != row["error_message"]
        or payload.get("attemptNumber") != row["attempt_count"]
        or payload.get("securityOutcome") != "unsafe_url"
        or payload.get("retryable") is not False
    ):
        return None
    placeholders = ",".join("?" for _ in _STOP_EVENTS)
    if conn.execute(
        f"SELECT 1 FROM job_events WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich' "
        f"AND event_id > ? AND event_type IN ({placeholders}) LIMIT 1",
        (str(LOCAL_TENANT), job_id, event["event_id"], *_STOP_EVENTS),
    ).fetchone():
        return None
    observed_at = _instant(event["occurred_at"])
    if observed_at is None:
        return None
    metadata = _object(row["metadata_json"])
    recorded = payload.get("fetchFailure")
    if isinstance(recorded, dict):
        if recorded.get("kind") != PublicFetchFailureKind.DNS_NON_PUBLIC.value:
            return None
        kind = PublicFetchFailureKind.DNS_NON_PUBLIC
        current = metadata.get("fetchFailure")
        if not isinstance(current, dict) or any(current.get(key) != recorded.get(key) for key in ("kind", "requestUrl", "observedAt")):
            return None
        request_url = recorded.get("requestUrl")
        if request_url != payload.get("blockedUrl") or _instant(recorded.get("observedAt")) is None:
            return None
    else:
        kind = _legacy_kind(str(row["error_message"] or ""))
        request_url = payload.get("blockedUrl")
    if kind is None or not isinstance(request_url, str) or not request_url:
        return None
    # Validate URL syntax and legacy numeric IP forms without sending DNS here.
    # A DNS condition can only be rechecked for a hostname, never a private literal.
    syntax = validate_public_http_url(request_url, resolver=lambda *_args, **_kwargs: [])
    if not syntax.allowed and syntax.failure_kind is not PublicFetchFailureKind.DNS_FAILURE:
        return None
    if kind is PublicFetchFailureKind.DNS_NON_PUBLIC and syntax.failure_kind is not PublicFetchFailureKind.DNS_FAILURE:
        return None
    failure = {
        "kind": kind.value,
        "requestUrl": request_url,
        "requestHost": urlsplit(request_url).hostname or "",
        "observedAt": observed_at.isoformat(),
    }
    if isinstance(recorded, dict):
        failure["observedAt"] = recorded["observedAt"]
    recovery = metadata.get("fetchRecovery") or {}
    if not isinstance(recovery, dict):
        return None
    if recovery and recovery.get("failureEventId") != event["event_id"]:
        return None
    count = recovery.get("checkCount", 0)
    if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count >= _MAX_CHECKS:
        return None
    if recovery and recovery.get("status") != "waiting":
        return None
    return _FailureCandidate(raw, event["event_id"], failure, metadata, recovery, observed_at)


async def _check_destinations(urls: tuple[str, str]) -> tuple[PublicUrlDecision, PublicUrlDecision]:
    def resolve() -> tuple[PublicUrlDecision, PublicUrlDecision]:
        # No HTTP, browser navigation, credential access, or extractor work.
        return validate_public_http_url(urls[0]), validate_public_http_url(urls[1])

    return await asyncio.to_thread(resolve)


async def reconcile_public_fetch_failures(
    conn: sqlite3.Connection,
    *,
    now: datetime | None = None,
    checker: DestinationChecker | None = None,
) -> int:
    """Release only a positively identified, still-current failure after DNS checks."""
    now = now or datetime.now(timezone.utc)
    if conn.execute(
        "SELECT 1 FROM job_stage_states WHERE tenant_id = ? AND stage IN ('enrich', 'score', 'tailor', 'cover') "
        "AND state IN ('queued', 'running') LIMIT 1", (str(LOCAL_TENANT),),
    ).fetchone():
        return 0
    ids = conn.execute(
        "SELECT job_id FROM job_stage_states WHERE tenant_id = ? AND stage = 'enrich' "
        "AND state = 'failed' AND retryable = 0 AND error_code = 'DETAIL_UNSAFE_URL' ORDER BY updated_at, job_id",
        (str(LOCAL_TENANT),),
    ).fetchall()
    checked = released = 0
    for job in ids:
        candidate = _candidate(conn, job["job_id"])
        if candidate is None:
            continue
        next_check = _instant(candidate.recovery.get("nextCheckAt")) if candidate.recovery else (
            candidate.observed_at + timedelta(seconds=60)
        )
        if next_check is None or now < next_check:
            continue
        if checked >= _CHECK_BATCH_SIZE:
            break
        checked += 1
        try:
            decisions = await asyncio.wait_for(
                (checker or _check_destinations)((candidate.row["posting_url"], candidate.failure["requestUrl"])),
                timeout=_CHECK_TIMEOUT_SECONDS,
            )
        except (TimeoutError, OSError):
            decisions = (
                PublicUrlDecision(False, "DNS recheck did not complete", PublicFetchFailureKind.DNS_FAILURE),
                PublicUrlDecision(False, "DNS recheck did not complete", PublicFetchFailureKind.DNS_FAILURE),
            )
        ready = all(decision.allowed for decision in decisions)
        hard_stop = any(
            not decision.allowed and decision.failure_kind not in {
                PublicFetchFailureKind.DNS_NON_PUBLIC, PublicFetchFailureKind.DNS_FAILURE,
            }
            for decision in decisions
        )
        count = int(candidate.recovery.get("checkCount", 0)) + 1
        status = "retry_ready" if ready else "stopped" if hard_stop else "checks_exhausted" if count >= _MAX_CHECKS else "waiting"
        recovery = {
            "failureEventId": candidate.event_id,
            "status": status,
            "checkCount": count,
            "checkedAt": now.isoformat(),
            "nextCheckAt": (now + timedelta(seconds=min(1800, 60 * 2**count))).isoformat() if status == "waiting" else None,
        }
        if ready:
            cooldown_end = candidate.observed_at + timedelta(seconds=min(1800, 60 * 2**candidate.row["attempt_count"]))
            recovery["retryEligibleAt"] = max(now, cooldown_end).isoformat()
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = _candidate(conn, job["job_id"])
            # Some legacy stage writers do not bump version, so compare the
            # full failure snapshot too, including URL, attempts and metadata.
            if current != candidate:
                conn.rollback()
                continue
            set_stage_state(
                conn, canonical_job_id(job["job_id"]), "enrich", "pending" if ready else "failed",
                attempt_count=candidate.row["attempt_count"], max_attempts=candidate.row["max_attempts"],
                error_code=None if ready else candidate.row["error_code"],
                error_message=None if ready else candidate.row["error_message"], retryable=ready,
                metadata={**candidate.metadata, "fetchFailure": candidate.failure, "fetchRecovery": recovery},
                expected_version=candidate.row["version"], validate_transition=False,
            )
            record_job_event(
                conn, canonical_job_id(job["job_id"]), "enrich", "EnrichmentFetchRechecked",
                occurred_at=now.isoformat(),
                message="The recorded fetch failure was rechecked without fetching a page.",
                payload={
                    "failureEventId": candidate.event_id, "failureKind": candidate.failure["kind"],
                    "requestHost": candidate.failure["requestHost"], "recoveryStatus": status,
                    "checkCount": count, "nextCheckAt": recovery["nextCheckAt"],
                    "postingAllowed": decisions[0].allowed, "requestAllowed": decisions[1].allowed,
                },
            )
            if ready:
                record_job_event(
                    conn, canonical_job_id(job["job_id"]), "enrich", "StageReset", occurred_at=now.isoformat(),
                    message="Both destinations now validate as public; enrichment will retry within its existing attempt limit.",
                    payload={"reason": "public_fetch_condition_resolved", "failureEventId": candidate.event_id,
                             "attemptCount": candidate.row["attempt_count"], "retryEligibleAt": recovery["retryEligibleAt"]},
                )
                released += 1
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return released
