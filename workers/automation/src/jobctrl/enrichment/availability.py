"""Saved-posting observations and fenced, bounded acquisition (Enrichment owner).

No schema extension: the existing indexed event ledger holds observations and
leases independently of accepted content, application outcomes and visibility.
All network work happens after the short claim transaction has committed.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import multiprocessing
import os
import signal
import subprocess
import sqlite3
import time
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request
from uuid import uuid4

from bs4 import BeautifulSoup

from jobctrl.domain.enrichment.snapshot_services import ActiveStateVerifier, same_posting_url
from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState
from jobctrl.domain.enrichment.value_objects import DetailPage
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.state import record_job_event

ACTIVE_INTERVAL = timedelta(hours=24)
UNAVAILABLE_INTERVAL = timedelta(days=7)
LEASE_TTL = timedelta(minutes=5)
SWEEP_LIMIT = 25
HOURLY_LIMIT = 100
MAX_BODY_BYTES = 1_000_000
MAX_REQUESTS = 12
REQUEST_TIMEOUT_SECONDS = 20
ACQUISITION_TIMEOUT_SECONDS = 120
BROWSER_CLEANUP_GRACE_SECONDS = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _instant(value: object) -> datetime | None:
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result if result.tzinfo else None
    except ValueError:
        return None


def _latest(conn: sqlite3.Connection, tenant_id: str, kind: str, ref: str) -> dict[str, Any]:
    row = conn.execute("SELECT payload_json FROM job_events WHERE tenant_id = ? "
                       "AND entity_kind = ? AND entity_ref = ? ORDER BY event_id DESC LIMIT 1",
                       (tenant_id, kind, ref)).fetchone()
    return json.loads(row[0]) if row and row[0] else {}


def read_availability(conn: sqlite3.Connection, job_id: str, *, tenant_id: str = str(LOCAL_TENANT),
                      now: datetime | None = None) -> dict[str, Any]:
    """Read persisted evidence only. No transport, dispatch or writer side effect."""
    job_id = str(canonical_job_id(job_id))
    observation = _latest(conn, tenant_id, "posting_availability", job_id)
    now = now or _now()
    due = _instant(observation.get("nextDueAt"))
    lease = _latest(conn, tenant_id, "availability_lease", f"job:{job_id}")
    request = _latest(conn, tenant_id, "posting_availability_request", job_id)
    requested = _instant(request.get("requestedAt"))
    attempted = _instant(observation.get("lastAttemptedAt"))
    return {**observation, "jobId": job_id, "overdue": due is None or due <= now,
            **({"request": {"status": "deferred", "reason": str(request.get("reason") or "check_deferred")[:160],
                             "requestedAt": requested.isoformat(), "retryAt": request.get("retryAt")}}
               if request.get("status") == "deferred" and requested and (not attempted or requested >= attempted) else {}),
            "checkInProgress": bool(lease.get("owner") and (_instant(lease.get("expiresAt")) or now) > now)}


def fresh_active(conn: sqlite3.Connection, job_id: str, *, max_age: timedelta,
                 tenant_id: str = str(LOCAL_TENANT), now: datetime | None = None) -> bool:
    value = read_availability(conn, job_id, tenant_id=tenant_id, now=now)
    verified = _instant(value.get("lastSuccessfullyVerifiedAt"))
    current = conn.execute("SELECT url FROM jobs WHERE tenant_id = ? AND job_id = ?", (tenant_id, job_id)).fetchone()
    if current is None or current[0] != value.get("postingUrl") or _deleted(conn, tenant_id, job_id):
        return False
    policy = conn.execute("SELECT latest_active_state FROM posting_snapshot_sets WHERE tenant_id = ? AND job_id = ?",
                          (tenant_id, job_id)).fetchone()
    if policy and policy[0] != "active":
        return False
    return bool(value.get("verdict") == "active" and value.get("lastSuccessfulState") == "active"
                and verified and timedelta(0) <= (now or _now()) - verified <= max_age
                and not value.get("checkInProgress"))


def _event(conn: sqlite3.Connection, tenant_id: str, kind: str, ref: str, payload: dict[str, Any],
           *, job_id: str | None = None, observed: bool = False, now: datetime | None = None) -> None:
    record_job_event(conn, canonical_job_id(job_id) if job_id else None, "enrich",
                     "JobAvailabilityObserved" if observed else "AvailabilityLeaseChanged",
                     tenant_id=TenantId(tenant_id), entity_kind=kind, entity_ref=ref,
                     occurred_at=(now or _now()).isoformat(), payload=payload)


def _begin(conn: sqlite3.Connection) -> None:
    if conn.in_transaction:
        raise RuntimeError("Availability acquisition requires a released SQLite writer transaction")
    conn.execute("BEGIN IMMEDIATE")


@dataclass(frozen=True)
class Claim:
    tenant_id: str
    job_id: str
    posting_url: str
    source: str
    owner: str
    expires_at: datetime


class DeferredCheck(Exception):
    """A durable or shared acquisition bound refused or canceled work."""

    def __init__(self, reason: str, *, browser_phase: str | None = None) -> None:
        super().__init__(reason)
        self.browser_phase = browser_phase


def claim_job(conn: sqlite3.Connection, job_id: str, *, tenant_id: str = str(LOCAL_TENANT),
              now: datetime | None = None, automatic: bool = False) -> tuple[Claim | None, str]:
    now = now or _now()
    job_id = str(canonical_job_id(job_id))
    _begin(conn)
    try:
        row = conn.execute("SELECT url, site FROM jobs WHERE tenant_id = ? AND job_id = ?",
                           (tenant_id, job_id)).fetchone()
        if row is None or _deleted(conn, tenant_id, job_id) or (automatic and not _eligible(conn, tenant_id, job_id)):
            conn.rollback()
            return None, "job_unavailable"
        latest = _latest(conn, tenant_id, "posting_availability", job_id)
        lease = _latest(conn, tenant_id, "availability_lease", f"job:{job_id}")
        workspace = _latest(conn, tenant_id, "availability_lease", "workspace")
        for current in (lease, workspace):
            if current.get("owner") and (_instant(current.get("expiresAt")) or now) > now:
                conn.rollback()
                return None, "check_in_progress"
        last_start = _instant(lease.get("startedAt"))
        if last_start and now - last_start < timedelta(minutes=1):
            conn.rollback()
            return None, "minimum_interval"
        due = _instant(latest.get("nextDueAt"))
        if due and due > now and (automatic or latest.get("verdict") == "unknown"):
            conn.rollback()
            return None, "retry_backoff"
        claim = Claim(tenant_id, job_id, row[0], row[1] or "unknown", uuid4().hex, now + LEASE_TTL)
        payload = {"owner": claim.owner, "expiresAt": claim.expires_at.isoformat(), "startedAt": now.isoformat()}
        for ref in (f"job:{job_id}", "workspace"):
            _event(conn, tenant_id, "availability_lease", ref, payload, now=now)
        conn.commit()
        return claim, "claimed"
    except BaseException:
        conn.rollback()
        raise


def _deleted(conn: sqlite3.Connection, tenant_id: str, job_id: str) -> bool:
    return conn.execute("SELECT 1 FROM jobctrl_deleted_jobs WHERE tenant_id = ? AND job_id = ? "
                        "AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))",
                        (tenant_id, job_id)).fetchone() is not None


def _eligible(conn: sqlite3.Connection, tenant_id: str, job_id: str) -> bool:
    return not (conn.execute("SELECT 1 FROM jobctrl_hidden_jobs WHERE tenant_id = ? AND job_id = ? "
                             "AND unhidden_at IS NULL", (tenant_id, job_id)).fetchone()
                or conn.execute("SELECT 1 FROM job_stage_states WHERE tenant_id = ? AND job_id = ? "
                                "AND stage = 'apply' AND state IN ('running','succeeded','needs_verification')",
                                (tenant_id, job_id)).fetchone()
                or conn.execute("SELECT 1 FROM application_outcomes WHERE tenant_id = ? AND job_id = ? "
                                "AND kind IN ('applied_confirmation','rejection','withdrawn','offer')",
                                (tenant_id, job_id)).fetchone())


def _fence(conn: sqlite3.Connection, claim: Claim, now: datetime) -> None:
    for ref in (f"job:{claim.job_id}", "workspace"):
        lease = _latest(conn, claim.tenant_id, "availability_lease", ref)
        if lease.get("owner") != claim.owner or (_instant(lease.get("expiresAt")) or now) <= now:
            raise DeferredCheck("stale_lease")
    row = conn.execute("SELECT url FROM jobs WHERE tenant_id = ? AND job_id = ?",
                       (claim.tenant_id, claim.job_id)).fetchone()
    if row is None or row[0] != claim.posting_url or _deleted(conn, claim.tenant_id, claim.job_id):
        raise DeferredCheck("candidate_changed")


def reserve_request(conn: sqlite3.Connection, claim: Claim, url: str, *, now: datetime | None = None) -> str:
    """Reserve the actual host and hourly acquisition before each outbound request."""
    now = now or _now()
    host = (urlsplit(url).hostname or "").lower()
    _begin(conn)
    try:
        _fence(conn, claim, now)
        count = conn.execute("SELECT COUNT(*) FROM job_events WHERE tenant_id = ? "
                             "AND entity_kind = 'availability_request' AND julianday(occurred_at) > julianday(?)",
                             (claim.tenant_id, (now - timedelta(hours=1)).isoformat())).fetchone()[0]
        host_state = _latest(conn, claim.tenant_id, "availability_lease", f"host:{host}")
        if count >= HOURLY_LIMIT:
            raise DeferredCheck("workspace_hourly_quota")
        if (host_state.get("owner") and (_instant(host_state.get("expiresAt")) or now) > now
                or (_instant(host_state.get("nextStartAt")) or now) > now
                or (_instant(host_state.get("cooldownUntil")) or now) > now):
            raise DeferredCheck("host_pacing_or_cooldown")
        _event(conn, claim.tenant_id, "availability_lease", f"host:{host}",
               {"owner": claim.owner, "expiresAt": claim.expires_at.isoformat(),
                "nextStartAt": (now + timedelta(seconds=2)).isoformat(),
                "cooldownUntil": host_state.get("cooldownUntil")}, now=now)
        _event(conn, claim.tenant_id, "availability_request", uuid4().hex,
               {"owner": claim.owner, "host": host, "url": url}, job_id=claim.job_id, now=now)
        conn.commit()
        return host
    except BaseException:
        conn.rollback()
        raise


def release_host(conn: sqlite3.Connection, claim: Claim, host: str, *, retry_after: float = 0,
                 now: datetime | None = None) -> None:
    now = now or _now()
    _begin(conn)
    try:
        value = _latest(conn, claim.tenant_id, "availability_lease", f"host:{host}")
        if value.get("owner") == claim.owner:
            value.update(owner=None, expiresAt=now.isoformat())
            if retry_after > 0:
                value["cooldownUntil"] = (now + timedelta(seconds=min(300, retry_after))).isoformat()
            _event(conn, claim.tenant_id, "availability_lease", f"host:{host}", value, now=now)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


@dataclass(frozen=True)
class Response:
    """Transport-only seam; injected fakes still traverse claims and classifier."""
    url: str
    final_url: str
    status: int
    body: bytes
    retry_after: float = 0
    content_type: str = "text/html"
    redirect_url: str | None = None


def _public_get_in_process(url: str) -> Response:
    from jobctrl.infrastructure.network.public_http import build_public_http_opener
    from jobctrl.infrastructure.network.politeness import resolve_honest_user_agent
    request = Request(url, headers={"User-Agent": resolve_honest_user_agent().header_value(),
                                    "Accept": "application/json,text/html"}, method="GET")
    # Each redirect is acquired separately so its actual host is reserved first.
    try:
        result = build_public_http_opener(follow_redirects=False).open(request, timeout=20)
    except HTTPError as error:
        result = error
    with result:
        deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                raise DeferredCheck("request_deadline")
            chunk = getattr(result, "read1", result.read)(min(65536, MAX_BODY_BYTES + 1 - size))
            if time.monotonic() >= deadline:
                raise DeferredCheck("request_deadline")
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BODY_BYTES:
                raise DeferredCheck("response_body_budget")
        body = b"".join(chunks)
        status = result.code
        final_url = result.geturl()
        retry = _retry_after(result.headers.get("Retry-After"))
        location = result.headers.get("Location") if 300 <= status < 400 else None
        return Response(url, final_url, status, body, retry, result.headers.get("Content-Type", "text/html"),
                        urljoin(url, location) if location else None)



def _transport_process(url: str, sender: Any) -> None:
    try:
        sender.send(("response", _public_get_in_process(url)))
    except Exception as error:
        sender.send(("error", str(error) if isinstance(error, DeferredCheck) else "transport_failure"))
    finally:
        sender.close()


def public_get(url: str, *, timeout: float = REQUEST_TIMEOUT_SECONDS) -> Response:
    """Hard total DNS/header/body deadline; kill and reap the owned transport."""
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_transport_process, args=(url, sender), daemon=True)
    process.start()
    sender.close()
    try:
        if not receiver.poll(max(0, min(REQUEST_TIMEOUT_SECONDS, timeout))):
            raise DeferredCheck("request_deadline")
        kind, value = receiver.recv()
        if kind != "response":
            raise DeferredCheck(value)
        return value
    finally:
        receiver.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=1)
        if process.is_alive():
            process.kill()
            process.join(timeout=1)
        process.close()


_PRODUCTION_PUBLIC_GET = public_get


def _retry_after(value: object) -> float:
    try:
        return min(300, max(0, float(str(value))))
    except ValueError:
        try:
            return min(300, max(0, (parsedate_to_datetime(str(value)) - _now()).total_seconds()))
        except (ValueError, TypeError):
            return 0


def _provider(url: str) -> tuple[str, str, str, str] | None:
    parsed = urlsplit(url)
    parts = [part for part in parsed.path.split("/") if part]
    host = parsed.hostname
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in {None, 443}:
        return None
    if any(not part or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for char in part) for part in parts):
        return None
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"} and len(parts) == 3 and parts[1] == "jobs" and parts[2].isdigit():
        return "greenhouse", parts[0], parts[2], f"https://boards-api.greenhouse.io/v1/boards/{parts[0]}/jobs/{parts[2]}"
    if host in {"jobs.lever.co", "jobs.eu.lever.co"} and (len(parts) == 2 or len(parts) == 3 and parts[2] == "apply"):
        api_host = "api.eu.lever.co" if host == "jobs.eu.lever.co" else "api.lever.co"
        return "lever", parts[0], parts[1], f"https://{api_host}/v0/postings/{parts[0]}/{parts[1]}?mode=json"
    if host == "jobs.ashbyhq.com" and (len(parts) == 2 or len(parts) == 3 and parts[2] == "application"):
        return "ashby", parts[0], parts[1], f"https://api.ashbyhq.com/posting-api/job-board/{parts[0]}"
    return None


def _anonymous_browser_in_process(url: str, *, fetcher: Callable[[str, str], Response], deadline: float, progress: Callable[[str], None] | None = None) -> DetailPage:
    """Existing guarded anonymous browser; never creates an authenticated profile."""
    from playwright.sync_api import sync_playwright
    from jobctrl.enrichment.detail import _page_to_detail_page
    from jobctrl.infrastructure.network import PublicHttpUrlRouteGuard
    from jobctrl.infrastructure.network.url_safety import RouteFulfillment
    deadline = deadline or time.monotonic() + ACQUISITION_TIMEOUT_SECONDS
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, timeout=max(1, min(20, deadline - time.monotonic()) * 1000))
        try:
            context = browser.new_context(service_workers="block")
            unsupported_channels: list[str] = []
            def block_websocket(route: Any) -> None:
                unsupported_channels.append("websocket")
                route.close(code=1008, reason="Availability transport is read-only")
            context.route_web_socket("**/*", block_websocket)
            context.add_init_script("""(() => {
                let attempted = false;
                function blocked() {
                    attempted = true;
                    throw new DOMException('Unsupported availability transport', 'NotSupportedError');
                }
                Object.defineProperty(window, '__jobctrlAvailabilityUnsupported', {
                    get: () => attempted, configurable: false
                });
                for (const name of Object.getOwnPropertyNames(window).filter(name =>
                    /^(?:RTC|webkitRTC)/.test(name) || ['WebSocket', 'WebTransport', 'Worker', 'SharedWorker'].includes(name))) {
                    try { Object.defineProperty(window, name, {value: blocked, configurable: false, writable: false}); }
                    catch (_) { attempted = true; }
                }
                if (navigator.serviceWorker) {
                    try { Object.defineProperty(navigator.serviceWorker, 'register', {
                        value: blocked, configurable: false, writable: false
                    }); } catch (_) { attempted = true; }
                }
            })();""")
            def fetch_route(request_url: str, method: str, headers: Any) -> RouteFulfillment:
                response = fetcher(request_url, "browser_resource")
                if response.status not in range(200, 300):
                    raise DeferredCheck(f"browser_resource_http_{response.status}")
                return RouteFulfillment(response.status, {"content-type": response.content_type}, response.body)
            # Context routing covers the first popup request and every frame.
            # Install all guards before the first page can run employer code.
            guard = PublicHttpUrlRouteGuard(context, fetch_public_requests=True, request_fetcher=fetch_route).install()
            page = context.new_page()
            response = page.goto(url, wait_until="domcontentloaded", timeout=max(1, min(20, deadline - time.monotonic()) * 1000))
            if progress:
                progress("capture")
            rendered = _page_to_detail_page(page, url, response.status if response else None)
            unsupported_frame = any(frame.evaluate("Boolean(window.__jobctrlAvailabilityUnsupported)")
                                    for candidate in context.pages for frame in candidate.frames)
        finally:
            if progress:
                progress("cleanup")
            # Keep HTTP and socket guards installed through browser shutdown.
            # Context disposal removes the routes after every page is closed.
            browser.close()
    if time.monotonic() >= deadline:
        return replace(rendered, status_evidence_complete=False, status_evidence_reason="acquisition_deadline")
    if guard.blocked:
        return replace(rendered, status_evidence_complete=False,
                       status_evidence_reason=f"browser_guard: {guard.blocked_reason}")
    if unsupported_channels or unsupported_frame:
        return replace(rendered, status_evidence_complete=False, status_evidence_reason="unsupported_browser_channel")
    return rendered


def _browser_process(url: str, channel: Any, deadline: float) -> None:
    # Playwright's driver inherits this group; Chromium may create its own.
    # The parent supervises the complete descendant tree, including capture
    # and cleanup RPCs that have no Playwright timeout.
    if os.name != "nt":
        os.setsid()
    def fetch(request_url: str, method: str) -> Response:
        channel.send(("fetch", (request_url, method)))
        kind, value = channel.recv()
        if kind != "response":
            raise DeferredCheck(value)
        return value
    try:
        rendered = _anonymous_browser_in_process(url, fetcher=fetch, deadline=deadline,
                                                progress=lambda phase: channel.send(("phase", phase)))
        # Send only after browser/context/driver cleanup has completed.
        channel.send(("rendered", rendered))
    except Exception as error:
        channel.send(("error", str(error) if isinstance(error, DeferredCheck) else "browser_failure"))
    finally:
        channel.close()



def _owned_browser_groups(process_id: int) -> set[int]:
    inventory = subprocess.run(["ps", "-axo", "pid=,ppid=,pgid="], capture_output=True,
                               text=True, check=True, timeout=1)
    rows = [tuple(map(int, line.split())) for line in inventory.stdout.splitlines() if line.strip()]
    owned = {process_id}
    while True:
        descendants = {pid for pid, parent, _group in rows if parent in owned}
        if descendants <= owned:
            break
        owned.update(descendants)
    return {group for pid, _parent, group in rows if pid in owned and group != os.getpgrp()}

def _stop_browser_process(process: Any, known_groups: set[int] | None = None) -> None:
    """Kill/reap owned browser descendants even if Playwright close hangs."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            # Freeze the driver group before inspecting detached Chromium groups.
            # Never signal the parent's group if startup has not reached setsid.
            if os.getpgid(process.pid) != os.getpgrp():
                os.killpg(os.getpgid(process.pid), signal.SIGSTOP)
            else:
                os.kill(process.pid, signal.SIGSTOP)
        except ProcessLookupError:
            pass
        groups = set(known_groups or ())
        try:
            groups.update(_owned_browser_groups(process.pid))
            for group in groups:
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        except (OSError, subprocess.SubprocessError, ValueError):
            for group in groups:
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            # The original child/driver group still has a bounded fallback.
            try:
                if os.getpgid(process.pid) != os.getpgrp():
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    if process.is_alive():
        process.kill()
    process.join(timeout=1)
    if process.is_alive():
        raise DeferredCheck("browser_cleanup_failed")
    process.close()


def anonymous_browser(url: str, *, fetcher: Callable[[str, str], Response], deadline: float | None = None) -> DetailPage:
    """Supervise every browser RPC/resource/cleanup under the acquisition deadline.

    Outbound resource reads are requested over IPC and performed by the parent's
    real acquisition owner, retaining durable host pacing, quotas and lineage.
    The child owns only an anonymous browser and its guarded rendered capture.
    """
    deadline = deadline or time.monotonic() + ACQUISITION_TIMEOUT_SECONDS
    operation_deadline = deadline - BROWSER_CLEANUP_GRACE_SECONDS
    phase = "launch"
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=True)
    process = context.Process(target=_browser_process, args=(url, child, operation_deadline), daemon=True)
    process.start()
    child.close()
    known_groups: set[int] = set()
    try:
        while True:
            remaining = operation_deadline - time.monotonic()
            if remaining <= 0 or not parent.poll(remaining):
                raise DeferredCheck("acquisition_deadline", browser_phase=phase)
            kind, value = parent.recv()
            if kind == "phase":
                phase = str(value)
                continue
            if kind == "rendered":
                if time.monotonic() >= deadline:
                    raise DeferredCheck("acquisition_deadline")
                return value
            if kind != "fetch":
                raise DeferredCheck(value)
            if os.name != "nt":
                known_groups.update(_owned_browser_groups(process.pid))
            try:
                response = fetcher(*value)
                if time.monotonic() >= deadline:
                    raise DeferredCheck("acquisition_deadline")
                parent.send(("response", response))
            except Exception as error:
                parent.send(("error", str(error) if isinstance(error, DeferredCheck) else "transport_failure"))
    finally:
        parent.close()
        _stop_browser_process(process, known_groups)


class Acquisition:
    """API first, bounded page fallback, preserving every raw response hash."""
    def __init__(self, conn: sqlite3.Connection, claim: Claim, *,
                 transport: Callable[[str], Response] | None = None,
                 browser: Callable[[str], DetailPage] | None = None) -> None:
        self.conn, self.claim, self.transport, self.browser = conn, claim, transport or public_get, browser
        self.lineage: list[dict[str, Any]] = []
        self.deadline = time.monotonic() + ACQUISITION_TIMEOUT_SECONDS

    def _get(self, url: str, method: str, *, deadline: float | None = None) -> Response:
        deadline = min(self.deadline, deadline if deadline is not None else self.deadline)
        original = url
        for _ in range(4):
            response = self._single_get(url, method, deadline=deadline)
            if not response.redirect_url:
                return response
            if not same_posting_url(original, response.redirect_url):
                return replace(response, final_url=response.redirect_url)
            url = response.redirect_url
        raise DeferredCheck("redirect_budget")

    def _pace(self, url: str, *, deadline: float | None = None) -> None:
        host_state = _latest(self.conn, self.claim.tenant_id, "availability_lease", f"host:{urlsplit(url).hostname}")
        next_start = _instant(host_state.get("nextStartAt"))
        if next_start:
            delay = (next_start - _now()).total_seconds()
            if 0 < delay <= 2:
                time.sleep(min(delay, max(0, deadline - time.monotonic())) if deadline is not None else delay)

    def _single_get(self, url: str, method: str, *, deadline: float | None = None) -> Response:
        deadline = min(self.deadline, deadline if deadline is not None else self.deadline)
        if time.monotonic() >= deadline:
            raise DeferredCheck("acquisition_deadline")
        if len(self.lineage) >= MAX_REQUESTS:
            raise DeferredCheck("request_budget")
        # A fallback may reuse a host immediately after its prior request.
        # Wait only for the fixed pacing interval, outside any write transaction.
        self._pace(url, deadline=deadline)
        if time.monotonic() >= deadline:
            raise DeferredCheck("acquisition_deadline")
        host = reserve_request(self.conn, self.claim, url)
        retry = 0.0
        from jobctrl.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
        from jobctrl.infrastructure.network import PolitenessGateway, RunBudgetCounter
        gateway = PolitenessGateway()
        policy = replace(ENRICHMENT_CRAWL_POLICY,
                         min_request_interval_seconds=max(2, ENRICHMENT_CRAWL_POLICY.min_request_interval_seconds),
                         max_concurrent_requests_per_host=1)
        try:
            with gateway.guard(url, policy, RunBudgetCounter(1), timeout_seconds=max(0, deadline - time.monotonic())) as decision:
                if not decision.allowed:
                    raise DeferredCheck("shared_host_cooldown")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DeferredCheck("acquisition_deadline")
                response = (self.transport(url, timeout=remaining) if self.transport is _PRODUCTION_PUBLIC_GET
                            else self.transport(url))
            retry = response.retry_after
            if retry:
                gateway.note_retry_after(url, retry)
            self.lineage.append({"sourceUrl": url, "finalUrl": response.final_url, "status": response.status,
                                 "method": method, "rawHash": hashlib.sha256(response.body).hexdigest(),
                                 **({"redirectUrl": response.redirect_url} if response.redirect_url else {})})
            if time.monotonic() >= deadline:
                raise DeferredCheck("acquisition_deadline")
            return response
        except Exception as error:
            self.lineage.append({"sourceUrl": url, "finalUrl": None, "status": None,
                                 "method": method, "rawHash": None, "error": type(error).__name__})
            if isinstance(error, TimeoutError):
                raise DeferredCheck("acquisition_deadline") from error
            raise
        finally:
            release_host(self.conn, self.claim, host, retry_after=retry)

    def acquire(self) -> tuple[str, str, str]:
        url = self.claim.posting_url
        provider = _provider(url)
        if provider:
            kind, board, native_id, endpoint = provider
            response = self._get(endpoint, f"{kind}_api")
            if not same_posting_url(endpoint, response.final_url):
                return "unknown", "api_identity_lost", f"{kind}_api"
            if response.status in {404, 410} and kind in {"greenhouse", "lever"}:
                return "removed", "exact_provider_http_status", f"{kind}_api"
            if not 200 <= response.status <= 204:
                return "unknown", "http_error", f"{kind}_api"
            try:
                data = json.loads(response.body)
                rows = data.get("jobs", []) if kind == "ashby" and isinstance(data, dict) else [data]
                if not isinstance(data, dict) or not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    return "unknown", "provider_schema_invalid", f"{kind}_api"
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    locator = row.get("absolute_url") if kind == "greenhouse" else row.get("hostedUrl") if kind == "lever" else row.get("jobUrl")
                    if kind == "ashby":
                        # The public board contract has jobUrl, not a separate id.
                        located = _provider(locator) if isinstance(locator, str) else None
                        identity = located[2] if located and located[:2] == (kind, board) else ""
                    else:
                        raw_identity = row.get("id")
                        identity = str(raw_identity) if type(raw_identity) in {str, int} else ""
                    if identity == native_id and isinstance(locator, str) and same_posting_url(url, locator):
                        title = row.get("text") if kind == "lever" else row.get("title")
                        if not isinstance(title, str) or not title.strip():
                            return "unknown", "provider_schema_invalid", f"{kind}_api"
                        # Ashby isListed:false is still direct-link positive; missing rows never prove closure.
                        return "active", "exact_provider_posting", f"{kind}_api"
                    if kind != "ashby" or identity == native_id:
                        return "unknown", "provider_identity_mismatch", f"{kind}_api"
            except (ValueError, TypeError):
                return "unknown", "provider_schema_invalid", f"{kind}_api"
        response = self._get(url, "public_http")
        html = response.body.decode("utf-8", errors="replace")
        soup = BeautifulSoup(html, "html.parser")
        ld: list[Any] = []
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                ld.append(json.loads(script.get_text()))
            except ValueError:
                pass
        page = DetailPage(url=url, final_url=response.final_url, html=html,
                          json_ld=tuple(ld), status=response.status,
                          page_title=soup.title.get_text() if soup.title else "")
        signals: list[dict[str, object]] = []
        verdict, reason = ActiveStateVerifier().verify(page, signals=signals)
        self.lineage[-1]["signals"] = signals
        if verdict is not ActiveState.UNKNOWN or reason in {"http_error", "access_challenge", "identity_lost", "identity_mismatch", "invalid_deadline", "conflicting_signals"}:
            return verdict.value, reason, "public_http"
        try:
            if self.browser is None:
                rendered = anonymous_browser(url, fetcher=lambda request_url, method: self._get(
                    request_url, method, deadline=self.deadline - BROWSER_CLEANUP_GRACE_SECONDS), deadline=self.deadline)
            else:
                # Transport-only fixtures retain the real browser-page reservation.
                self._pace(url)
                host = reserve_request(self.conn, self.claim, url)
                try:
                    rendered = self.browser(url)
                finally:
                    release_host(self.conn, self.claim, host)
        except Exception as error:
            self.lineage.append({"sourceUrl": url, "finalUrl": None, "status": None,
                                 "method": "anonymous_browser", "rawHash": None, "error": str(error)[:160],
                                 **({"signals": [{"kind": "browser_phase", "value": error.browser_phase}]}
                                    if isinstance(error, DeferredCheck) and error.browser_phase else {})})
            raise
        signals = []
        verdict, reason = ActiveStateVerifier().verify(rendered, signals=signals)
        self.lineage.append({"sourceUrl": url, "finalUrl": rendered.final_url, "status": rendered.status,
                             "method": "anonymous_browser", "rawHash": rendered.raw_html_hash or hashlib.sha256(
                                 (rendered.status_html or rendered.html).encode()).hexdigest(), "signals": signals})
        return verdict.value, reason, "anonymous_browser"


def complete_check(conn: sqlite3.Connection, claim: Claim, *, verdict: str, reason: str, method: str,
                   lineage: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    _begin(conn)
    try:
        _fence(conn, claim, now)
        old = _latest(conn, claim.tenant_id, "posting_availability", claim.job_id)
        failures = min(10, int(old.get("consecutiveFailures", 0)) + 1) if verdict == "unknown" else 0
        interval = timedelta(seconds=min(86400, 300 * 2 ** (failures - 1))) if failures else (
            ACTIVE_INTERVAL if verdict == "active" else UNAVAILABLE_INTERVAL)
        value = {"jobId": claim.job_id, "postingUrl": claim.posting_url, "source": claim.source,
                 "providerIdentity": list(_provider(claim.posting_url)[:3]) if _provider(claim.posting_url) else None,
                 "lastAttemptedAt": now.isoformat(), "verdict": verdict, "reason": reason, "method": method,
                 "evidenceRef": f"availability:{claim.owner}", "lineage": lineage,
                 "nextDueAt": (now + interval).isoformat(), "consecutiveFailures": failures,
                 "lastSuccessfullyVerifiedAt": old.get("lastSuccessfullyVerifiedAt"),
                 "lastSuccessfulState": old.get("lastSuccessfulState"), "lastSuccessfulEvidenceRef": old.get("lastSuccessfulEvidenceRef")}
        if verdict != "unknown":
            value.update(lastSuccessfullyVerifiedAt=now.isoformat(), lastSuccessfulState=verdict,
                         lastSuccessfulEvidenceRef=value["evidenceRef"])
            # Only availability changes. Accepted content, materials and outcomes remain intact.
            from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
            repo = SqlitePostingSnapshotSetRepository(conn)
            snapshot = repo.load(TenantId(claim.tenant_id), canonical_job_id(claim.job_id))
            if snapshot and snapshot.latest_active_state is not ActiveState.LOCATION_INCOMPATIBLE:
                updated, previous = snapshot.mark_active_state(active_state=ActiveState(verdict), verified_at=now.isoformat())
                repo.save(updated, commit=False)
                if previous is not None:
                    record_job_event(conn, canonical_job_id(claim.job_id), "enrich", "JobActiveStateChanged",
                                     tenant_id=TenantId(claim.tenant_id), payload={"activeState": verdict,
                                     "previousState": previous.value, "verificationMethod": method, "verifiedAt": now.isoformat()})
        _event(conn, claim.tenant_id, "posting_availability", claim.job_id, value,
               job_id=claim.job_id, observed=True, now=now)
        for ref in (f"job:{claim.job_id}", "workspace"):
            lease = _latest(conn, claim.tenant_id, "availability_lease", ref)
            _event(conn, claim.tenant_id, "availability_lease", ref,
                   {**lease, "owner": None, "expiresAt": now.isoformat()}, now=now)
        conn.commit()
        return read_availability(conn, claim.job_id, tenant_id=claim.tenant_id, now=now)
    except BaseException:
        conn.rollback()
        raise


def check_availability(job_id: str, *, tenant_id: str = str(LOCAL_TENANT), conn: sqlite3.Connection | None = None,
                       automatic: bool = False, transport: Callable[[str], Response] | None = None,
                       browser: Callable[[str], DetailPage] | None = None) -> dict[str, Any]:
    from jobctrl.database import get_connection
    conn = conn if conn is not None else get_connection()
    claim, reason = claim_job(conn, job_id, tenant_id=tenant_id, automatic=automatic)
    if claim is None:
        now = _now()
        latest = _latest(conn, tenant_id, "posting_availability", job_id)
        lease = _latest(conn, tenant_id, "availability_lease", f"job:{job_id}")
        workspace = _latest(conn, tenant_id, "availability_lease", "workspace")
        retry = (_instant(latest.get("nextDueAt")) if reason == "retry_backoff" else
                 (_instant(lease.get("startedAt")) or now) + timedelta(minutes=1) if reason == "minimum_interval" else
                 max(_instant(lease.get("expiresAt")) or now, _instant(workspace.get("expiresAt")) or now) if reason == "check_in_progress" else None)
        request = {"jobId": job_id, "status": "deferred", "reason": reason,
                   "requestedAt": now.isoformat(), "retryAt": retry.isoformat() if retry else None}
        _begin(conn)
        try:
            _event(conn, tenant_id, "posting_availability_request", job_id, request, job_id=job_id, now=now)
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        return {**read_availability(conn, job_id, tenant_id=tenant_id), "requestStatus": "deferred", "requestReason": reason}
    acquisition = Acquisition(conn, claim, transport=transport, browser=browser)
    try:
        verdict, reason, method = acquisition.acquire()
    except Exception as error:
        verdict, reason, method = "unknown", str(error) if isinstance(error, DeferredCheck) else "transport_failure", "acquisition_failed"
    return complete_check(conn, claim, verdict=verdict, reason=reason, method=method, lineage=acquisition.lineage)


def require_fresh_active(job_id: str, *, max_age: timedelta = timedelta(hours=6),
                         tenant_id: str = str(LOCAL_TENANT), conn: sqlite3.Connection | None = None,
                         expected_posting_url: str | None = None) -> None:
    from jobctrl.database import get_connection
    from jobctrl.domain.errors import MissingInputError
    conn = conn if conn is not None else get_connection()
    if not fresh_active(conn, job_id, max_age=max_age, tenant_id=tenant_id):
        check_availability(job_id, tenant_id=tenant_id, conn=conn)
    if not fresh_active(conn, job_id, max_age=max_age, tenant_id=tenant_id) or (
        expected_posting_url is not None and read_availability(conn, job_id, tenant_id=tenant_id).get("postingUrl") != expected_posting_url
    ):
        raise MissingInputError("Posting availability is unverified or unavailable. Check availability or inspect the employer posting before retrying.")


def assert_fresh_candidate(conn: sqlite3.Connection, job_id: str, expected_posting_url: str,
                           *, tenant_id: str = str(LOCAL_TENANT), max_age: timedelta = timedelta(hours=6)) -> None:
    """Recheck URL/evidence under the stage owner's short SQLite writer claim."""
    from jobctrl.domain.errors import MissingInputError
    if not conn.in_transaction:
        raise RuntimeError("Availability candidate fencing requires the stage writer transaction")
    row = conn.execute("SELECT url FROM jobs WHERE tenant_id = ? AND job_id = ?", (str(tenant_id), str(job_id))).fetchone()
    if row is None or row[0] != expected_posting_url or not fresh_active(conn, str(job_id), tenant_id=str(tenant_id), max_age=max_age):
        raise MissingInputError("Posting availability candidate changed. Check availability or inspect the employer posting before retrying.")


def due_jobs(conn: sqlite3.Connection, *, tenant_id: str = str(LOCAL_TENANT),
             now: datetime | None = None) -> list[str]:
    now = now or _now()
    rows = conn.execute("""
        WITH candidates AS (
            SELECT j.job_id, j.discovered_at,
              (SELECT json_extract(e.payload_json, '$.nextDueAt') FROM job_events e
               WHERE e.tenant_id = j.tenant_id AND e.entity_kind = 'posting_availability'
                 AND e.entity_ref = j.job_id ORDER BY e.event_id DESC LIMIT 1) AS due,
              CASE WHEN EXISTS (SELECT 1 FROM job_stage_states s WHERE s.tenant_id = j.tenant_id
                AND s.job_id = j.job_id AND s.stage IN ('score','tailor','cover')
                AND s.state IN ('queued','pending','running'))
                OR EXISTS (SELECT 1 FROM application_review_decisions r
                  WHERE r.tenant_id = j.tenant_id AND r.job_id = j.job_id) THEN 0 ELSE 1 END AS priority
            FROM jobs j
            WHERE j.tenant_id = ?
              AND NOT EXISTS (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id = j.tenant_id
                AND d.job_id = j.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at)))
              AND NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.tenant_id = j.tenant_id
                AND h.job_id = j.job_id AND h.unhidden_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM job_stage_states s WHERE s.tenant_id = j.tenant_id
                AND s.job_id = j.job_id AND s.stage = 'apply' AND s.state IN ('running','succeeded','needs_verification'))
              AND NOT EXISTS (SELECT 1 FROM application_outcomes o WHERE o.tenant_id = j.tenant_id
                AND o.job_id = j.job_id AND o.kind IN ('applied_confirmation','rejection','withdrawn','offer'))
        ) SELECT job_id FROM candidates WHERE due IS NULL OR julianday(due) <= julianday(?)
          ORDER BY priority, COALESCE(julianday(due), 0), discovered_at, job_id LIMIT ?
        """, (tenant_id, now.isoformat(), SWEEP_LIMIT)).fetchall()
    return [row[0] for row in rows]
