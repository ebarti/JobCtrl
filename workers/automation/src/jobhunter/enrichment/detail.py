"""Detail page enrichment — Phase 7 / S-27 refactor.

This module is the **adapter shell** that the CLI / pipeline call into.
The actual enrichment logic now lives in the domain layer:

  * extractors → ``jobhunter.domain.enrichment.services``
  * use cases  → ``jobhunter.domain.enrichment.use_cases``
  * fetcher    → ``jobhunter.infrastructure.enrichment.playwright_fetcher``
  * persistence → ``jobhunter.infrastructure.enrichment.sqlite_repository``

Per the no-strangler directive, this module:

  * imports ONLY from ``jobhunter.domain``, ``jobhunter.infrastructure``
    and ``jobhunter.state`` / ``jobhunter.database`` (NO discovery imports);
  * never writes to ``jobs.full_description`` / ``jobs.application_url`` /
    ``jobs.detail_scraped_at`` / ``jobs.detail_error`` — every enrichment
    write goes through ``EnrichmentRepository`` to ``job_enrichments``.

The public surface (``run_enrichment``, ``scrape_detail_page``,
``scrape_site_batch``, ``stream_detail``) is preserved so existing
``pipeline.py`` callers don't change.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright

from jobhunter import database as db_module
from jobhunter.database import ensure_discovery_control_tables, init_db
from jobhunter.domain.enrichment import (
    ActiveState,
    DetailPage,
    EnrichmentError,
    ExtractionTier,
    JobEnrichment,
    PostingSnapshotSet,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobhunter.domain.enrichment.snapshot_services import (
    ActiveStateVerifier,
    judge_snapshot_confidence,
)
from jobhunter.domain.enrichment.services import (
    CssSelectorExtractor,
    ExtractionResult,
    JsonLdExtractor,
    LlmExtractor,
)
from jobhunter.domain.enrichment.value_objects import (
    ApplicationUrl,
    FullDescription,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.errors import ConfigurationError, TransientNetworkError
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.enrichment import SqliteEnrichmentRepository
from jobhunter.infrastructure.enrichment.sqlite_repository import (
    SqlitePostingSnapshotSetRepository,
)
from jobhunter.infrastructure.enrichment.playwright_fetcher import (
    _clean_content_html,
    _collect_json_ld,
    _collect_main_content,
)
from jobhunter.infrastructure.enrichment.linkedin_apply_resolver import (
    LinkedInApplyResolution,
    LinkedInApplyUrlResolver,
    linkedin_apply_resolver_enabled,
)
from jobhunter.infrastructure.network.proxy import ProxyConfig, parse_proxy
from jobhunter.infrastructure.llm import get_llm_adapter
from jobhunter.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
from jobhunter.domain.ports.politeness import (
    PolitenessDecision,
    PolitenessOutcome,
    RobotsVerdict,
)
from jobhunter.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
    get_shared_rate_limiter,
)

log = logging.getLogger(__name__)


class _OwnerAuthenticatedRobots:
    """``RobotsPort`` for the owner's authenticated LinkedIn session (R10 D1/D3).

    A logged-in, user-authorized browser session is not anonymous crawling, so
    ``robots.txt`` is an owner decision here (§Owner decisions D1/D3) and is not
    enforced — enforcing an anonymous robots verdict on the owner's own account
    would break a user-authorized flow. This is **not** a controls bypass: the
    per-host rate limit and the per-run request budget still apply through the
    shared gateway, and this port is used only for the persistent authenticated
    context, never for an anonymous fetch.
    """

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:  # noqa: ARG002
        return RobotsVerdict.ALLOW


def _new_enrichment_budget() -> RunBudgetCounter:
    """A fresh per-run outbound-navigation budget for the enrichment crawl."""
    return RunBudgetCounter(ENRICHMENT_CRAWL_POLICY.max_requests_per_run)


def _enrichment_session(
    gateway: PolitenessGateway,
    budget: RunBudgetCounter,
    conn: sqlite3.Connection | None,
    *,
    site: str | None = None,
) -> PolitenessSession:
    """Bind the shared gateway + run budget to one site's recording context."""
    return PolitenessSession(
        gateway,
        policy=ENRICHMENT_CRAWL_POLICY,
        budget=budget,
        context=PolitenessSourceContext(
            stage="enrich",
            source_id=site,
            adapter="enrichment_browser",
        ),
        recorder_conn=conn,
    )


def _default_enrichment_session(
    conn: sqlite3.Connection | None = None, *, site: str | None = None
) -> PolitenessSession:
    """A self-provisioned enrichment session for standalone/one-off callers."""
    return _enrichment_session(PolitenessGateway(), _new_enrichment_budget(), conn, site=site)

# Sites that block scraping -- skip detail extraction entirely
SKIP_DETAIL_SITES = {"glassdoor", "google", "Workopolis"}

# Module-level proxy config (set from CLI or caller)
_PROXY_CONFIG: ProxyConfig | None = None
_MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS = 3


def set_proxy(proxy_str: str | None) -> None:
    """Set proxy config from an external caller."""
    global _PROXY_CONFIG
    if proxy_str:
        _PROXY_CONFIG = parse_proxy(proxy_str)


def _is_linkedin_job(site: str | None, url: str) -> bool:
    site_text = str(site or "").strip().lower()
    url_text = str(url or "").strip().lower()
    return site_text == "linkedin" or "linkedin.com/jobs/" in url_text


# -- URL resolution ----------------------------------------------------------

def _load_base_urls() -> dict[str, str | None]:
    """Load site base URLs from config/sites.yaml."""
    from jobhunter.config import load_base_urls
    return load_base_urls()


def resolve_url(raw_url: str, site: str) -> str | None:
    """Resolve a stored URL to an absolute URL."""
    if not raw_url:
        return None

    if raw_url.startswith("http://") or raw_url.startswith("https://"):
        return raw_url

    if site == "WelcomeToTheJungle":
        return None

    if site == "Randstad Canada" and "/" not in raw_url:
        return f"https://www.randstad.ca/jobs/search/{raw_url}"

    if site == "4DayWeek" and raw_url in ("/", "/jobs"):
        return None

    base = _load_base_urls().get(site)
    if not base:
        return None

    if ";jsessionid=" in raw_url:
        raw_url = raw_url.split(";jsessionid=")[0]

    return urljoin(base, raw_url)


def resolve_all_urls(conn: sqlite3.Connection) -> dict:
    """Resolve all relative URLs in the database. Returns stats."""
    rows = conn.execute("SELECT url, site FROM jobs").fetchall()
    resolved = 0
    failed = 0
    already_absolute = 0

    for row in rows:
        url, site = row[0], row[1]
        if url.startswith("http://") or url.startswith("https://"):
            already_absolute += 1
            continue

        new_url = resolve_url(url, site)
        if new_url and new_url != url:
            try:
                conn.execute("UPDATE jobs SET url = ? WHERE url = ?", (new_url, url))
                resolved += 1
            except sqlite3.IntegrityError:
                conn.execute("DELETE FROM jobs WHERE url = ?", (url,))
                resolved += 1
        else:
            failed += 1

    # Note: legacy ``jobs.application_url`` is NO LONGER updated here.
    # New enrichment writes target ``job_enrichments.application_url``;
    # the legacy column is read-only fallback for un-backfilled rows.
    conn.commit()
    return {
        "resolved": resolved,
        "failed": failed,
        "already_absolute": already_absolute,
        "app_resolved": 0,
    }


def resolve_wttj_urls(conn: sqlite3.Connection) -> int:
    """Re-fetch WTTJ Algolia API to get proper detail URLs and fix slug-as-title.

    Returns count of URLs updated.
    """
    wttj_jobs = conn.execute(
        "SELECT url, title FROM jobs WHERE site = 'WelcomeToTheJungle'"
    ).fetchall()

    if not wttj_jobs:
        return 0

    listing_url = (
        "https://www.welcometothejungle.com/en/jobs"
        "?query=developer&refinementList%5Bremote%5D%5B%5D=fulltime"
    )

    algolia_data: dict = {}

    def capture_algolia(response):
        if "algolia.net" in response.url and "/queries" in response.url:
            try:
                algolia_data["response"] = json.loads(response.text())
            except Exception:
                pass

    # R10: the Algolia bootstrap is an anonymous crawl of WTTJ — gate it through
    # the politeness gateway. A robots-deny / budget-exhaustion skips the
    # navigation entirely (records the outcome, returns no updates).
    session = _default_enrichment_session(conn, site="WelcomeToTheJungle")
    with session.guard(listing_url) as decision:
        if not decision.allowed:
            log.warning("WTTJ Algolia bootstrap skipped by politeness gate: %s", decision.reason)
            return 0
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            # Present the gateway-resolved honest UA (the same identity robots was
            # evaluated with in the guard above), never an import-time constant.
            page = browser.new_page(user_agent=decision.user_agent)
            page.on("response", capture_algolia)
            page.goto(listing_url, timeout=60000)
            page.wait_for_load_state("networkidle")
            browser.close()

    if not algolia_data.get("response"):
        log.warning("WTTJ: No Algolia response captured")
        return 0

    results = algolia_data["response"].get("results", [])
    slug_map: dict = {}
    for rs in results:
        for hit in rs.get("hits", []):
            slug = hit.get("slug", "")
            org = hit.get("organization", {})
            org_slug = org.get("slug", "") if isinstance(org, dict) else ""
            name = hit.get("name", "")
            if slug and org_slug:
                detail_url = f"https://www.welcometothejungle.com/en/companies/{org_slug}/jobs/{slug}"
                slug_map[slug] = {"url": detail_url, "name": name}

    updated = 0
    for row in wttj_jobs:
        old_url, old_title = row[0], row[1]
        slug = old_url.split("_DFNS_")[0] if "_DFNS_" in old_url else old_url
        match = slug_map.get(slug) or slug_map.get(old_url)
        if match:
            try:
                conn.execute(
                    "UPDATE jobs SET url = ?, title = ? WHERE url = ?",
                    (match["url"], match["name"] or old_title, old_url),
                )
                updated += 1
            except sqlite3.IntegrityError:
                conn.execute("DELETE FROM jobs WHERE url = ?", (old_url,))
                updated += 1
        else:
            for s, data in slug_map.items():
                if s in old_url or old_url in s:
                    try:
                        conn.execute(
                            "UPDATE jobs SET url = ?, title = ? WHERE url = ?",
                            (data["url"], data["name"] or old_title, old_url),
                        )
                        updated += 1
                    except sqlite3.IntegrityError:
                        conn.execute("DELETE FROM jobs WHERE url = ?", (old_url,))
                        updated += 1
                    break

    conn.commit()
    return updated


# ---------------------------------------------------------------------------
# Page → DetailPage conversion (used by the live-browser scrape paths)
# ---------------------------------------------------------------------------


def _page_to_detail_page(page, url: str, status: int | None = None) -> DetailPage:
    """Build a ``DetailPage`` value object from a live Playwright page.

    The fetcher already navigated and waited; this helper just collects
    the fields the extractors need so the cascade can run as pure
    functions over the value object.
    """
    fetched_at = datetime.now(timezone.utc).isoformat()
    final_url = page.url
    page_title = ""
    try:
        page_title = page.title() or ""
    except Exception:
        pass
    json_ld = _collect_json_ld(page)
    html = _collect_main_content(page)
    return DetailPage(
        url=url,
        final_url=final_url,
        page_title=page_title,
        html=html,
        json_ld=tuple(json_ld),
        status=status,
        fetched_at=fetched_at,
    )


# ---------------------------------------------------------------------------
# Cascade orchestration over a Playwright Page (legacy batch entry points)
# ---------------------------------------------------------------------------


_RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}
_PERMANENT_FAILURES = {404, 410, 451}


def scrape_detail_page(page, url: str, *, session: PolitenessSession | None = None) -> dict:
    """Run the three-tier cascade on one Playwright page.

    Public API preserved for callers in ``pipeline.py``; internally
    delegates to the domain-layer extractors. Returns the legacy dict
    shape (``status``, ``tier_used``, ``full_description``,
    ``application_url``, ``error``, ``elapsed``) so existing callers
    don't change.

    R10: every ``page.goto`` runs inside a politeness-gateway verdict. A
    robots-deny or budget-exhaustion yields ``status="blocked"`` (plus the
    ``politeness_outcome``) and performs **zero** navigation — it never navigates
    and relabels. ``session`` is supplied by the batch caller (bound to the run
    budget); a one-off caller lets it self-provision.
    """
    result: dict = {
        "full_description": None,
        "application_url": None,
        "status": "error",
        "tier_used": None,
        "error": None,
        "active_state": None,
        "verification_method": None,
        "http_status": None,
    }
    t0 = time.time()

    if session is None:
        session = _default_enrichment_session()
    with session.guard(url) as decision:
        if not decision.allowed:
            result["status"] = "blocked"
            result["politeness_outcome"] = decision.outcome.value
            result["error"] = decision.reason
            result["elapsed"] = time.time() - t0
            return result
        return _scrape_detail_page_body(page, url, result, t0)


def _scrape_detail_page_body(page, url: str, result: dict, t0: float) -> dict:
    """Navigate + run the three-tier cascade inside the held politeness slot."""
    status_code: int | None = None
    try:
        resp = page.goto(url, timeout=45000)
        if resp is not None:
            status_code = resp.status
            if status_code in _PERMANENT_FAILURES:
                active_state = ActiveState.REMOVED
                result["error"] = f"HTTP {status_code}"
                result["active_state"] = active_state.value
                result["verification_method"] = "http_status"
                result["http_status"] = status_code
                result["elapsed"] = time.time() - t0
                return result
        page.wait_for_load_state("domcontentloaded", timeout=15000)
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
    except Exception as exc:
        err_str = str(exc)
        result["error"] = "timeout" if "timeout" in err_str.lower() else err_str[:200]
        result["elapsed"] = time.time() - t0
        return result

    detail_page = _page_to_detail_page(page, url, status=status_code)
    active_state, verification_method = ActiveStateVerifier().verify(detail_page)
    result["active_state"] = active_state.value
    result["verification_method"] = verification_method
    result["http_status"] = status_code

    cascade = (
        (1, ExtractionTier.JSON_LD, JsonLdExtractor()),
        (2, ExtractionTier.CSS_SELECTORS, CssSelectorExtractor()),
        (3, ExtractionTier.LLM_ASSISTED, _make_llm_extractor()),
    )

    last_apply: ApplicationUrl | None = None
    for tier_num, _tier_enum, extractor in cascade:
        try:
            extracted: ExtractionResult = extractor.extract(detail_page)
        except Exception as exc:
            log.warning("scrape_detail_page: tier %s raised: %s", tier_num, exc)
            continue
        if extracted.application_url is not None:
            last_apply = extracted.application_url
        if extracted.ok and extracted.full_description is not None:
            apply_final = extracted.application_url or last_apply
            result["full_description"] = extracted.full_description.text
            result["application_url"] = apply_final.value if apply_final else None
            result["tier_used"] = tier_num
            if active_state is ActiveState.ACTIVE:
                result["status"] = "ok" if result["application_url"] else "partial"
            else:
                result["status"] = "inactive"
                result["error"] = f"posting {active_state.value}"
            result["elapsed"] = time.time() - t0
            return result

    # All tiers failed — record the partial-apply outcome if Tier 2 found one
    result["application_url"] = last_apply.value if last_apply else None
    result["tier_used"] = 3  # last tier attempted
    if result["application_url"]:
        result["status"] = "partial"
    else:
        result["status"] = "error"
        result["error"] = "no data extracted"
    result["elapsed"] = time.time() - t0
    return result


def _detail_failure_retryable(cascade_result: dict) -> bool:
    """Classify detail extraction failures after page fetch/verification.

    Extraction failures stay retryable: extractor rules, page markup, and
    timing can all change independently of the posting's active state.
    """
    status = cascade_result.get("http_status")
    if isinstance(status, int):
        if status in _RETRYABLE_STATUSES:
            return True
        if 400 <= status < 500:
            return False
    active_state = ActiveState.from_optional(cascade_result.get("active_state"))
    verification_method = str(cascade_result.get("verification_method") or "")
    if (
        active_state is not None
        and active_state is not ActiveState.ACTIVE
        and verification_method
        and verification_method != "unknown"
    ):
        return False
    return True


def _discovery_description_fallback(
    conn: sqlite3.Connection, url: str
) -> tuple[str | None, str | None]:
    """Return discovery-owned content that is usable as enrichment fallback."""
    row = conn.execute(
        """
        SELECT full_description, description, application_url
        FROM jobs
        WHERE url = ?
        """,
        (url,),
    ).fetchone()
    if row is None:
        return None, None

    full_description = (
        row["full_description"] if isinstance(row, sqlite3.Row) else row[0]
    )
    description = row["description"] if isinstance(row, sqlite3.Row) else row[1]
    application_url = (
        row["application_url"] if isinstance(row, sqlite3.Row) else row[2]
    )

    for candidate in (full_description, description):
        text = str(candidate or "").strip()
        if len(text) > 200:
            return text, str(application_url).strip() if application_url else None
    return None, str(application_url).strip() if application_url else None


def _apply_discovery_description_fallback(
    conn: sqlite3.Connection, url: str, cascade_result: dict
) -> dict:
    """Promote discovery content when a live detail scrape finds no description."""
    if str(cascade_result.get("full_description") or "").strip():
        return cascade_result
    if cascade_result.get("status") not in {"error", "partial"}:
        return cascade_result

    description, application_url = _discovery_description_fallback(conn, url)
    if not description:
        return cascade_result

    original_status = cascade_result.get("status")
    original_error = cascade_result.get("error")
    updated = dict(cascade_result)
    updated["status"] = "partial"
    updated["full_description"] = description
    if not updated.get("application_url") and application_url:
        updated["application_url"] = application_url
    updated["fallback_source"] = "discovery"
    updated["detail_status"] = original_status
    updated["detail_error"] = original_error
    return updated


def _apply_authenticated_linkedin_apply_url(
    *,
    site: str | None,
    url: str,
    cascade_result: dict,
    resolver: object | None,
    page: object | None = None,
) -> dict:
    """Resolve a missing LinkedIn apply URL with an authenticated browser.

    This runs only after the normal enrichment cascade has produced usable
    description text. It treats the authenticated click as an application URL
    fallback, not as an application submission path.
    """
    if resolver is None or not _is_linkedin_job(site, url):
        return cascade_result
    if cascade_result.get("application_url"):
        return cascade_result
    if not str(cascade_result.get("full_description") or "").strip():
        return cascade_result
    if cascade_result.get("status") not in {"ok", "partial"}:
        return cascade_result

    try:
        if page is not None and hasattr(resolver, "resolve_loaded_page"):
            # Reuses the enrichment page, whose navigation was already gated by
            # scrape_detail_page — no additional fetch happens here.
            resolution = resolver.resolve_loaded_page(page, url)  # type: ignore[attr-defined]
        elif hasattr(resolver, "resolve"):
            # Fresh navigation in the owner's authenticated persistent Chrome
            # session (retry pre-pass). This is an owner-scoped, user-authorized
            # session (§Owner decisions D1/D3): robots is an owner decision and
            # is not enforced on the owner's own account, and pacing/budget for
            # the authenticated session are deferred to owner config (P5). It is
            # not anonymous crawling and must never be used for one.
            resolution = resolver.resolve(url)  # type: ignore[attr-defined]
        else:
            return cascade_result
    except Exception as exc:  # noqa: BLE001 - resolver is best-effort
        log.warning("LinkedIn apply URL resolver failed for %s: %s", url, exc)
        return {
            **cascade_result,
            "authenticated_apply_url_error": str(exc)[:300],
        }

    application_url: str | None
    method = "authenticated_browser"
    error: str | None = None
    if isinstance(resolution, LinkedInApplyResolution):
        application_url = resolution.application_url
        method = resolution.method
        error = resolution.error
    else:
        application_url = str(resolution).strip() if resolution else None

    if not application_url:
        updated = {
            **cascade_result,
            "authenticated_apply_url_method": method,
        }
        if error:
            updated["authenticated_apply_url_error"] = error
        return updated

    return {
        **cascade_result,
        "status": "ok",
        "application_url": application_url,
        "authenticated_apply_url_method": method,
    }


def _make_llm_extractor() -> LlmExtractor:
    """Build a Tier-3 extractor backed by the canonical LlmAdapter.

    Factored out so tests can swap a stub LlmPort. The adapter is the only
    LlmPort-shaped wrapper around the underlying LLMClient — calling
    LLMClient directly would now violate the port's signature (model kw,
    chat_json, etc.).
    """
    return LlmExtractor(llm=get_llm_adapter())


# ---------------------------------------------------------------------------
# Batch scraping — uses the new EnrichmentRepository for persistence
# ---------------------------------------------------------------------------


def _record_enrich_robots_blocked(
    conn: sqlite3.Connection, url: str, decision: PolitenessDecision
) -> None:
    """Fold a robots-disallowed navigation into the enrichment lifecycle.

    Robots-blocked is a first-class, non-terminal outcome — never a scrape
    failure. The enrich stage moves to ``blocked`` (``Pending -> Blocked`` is the
    valid transition; entering ``running`` first would strand it, so this runs
    before any attempt starts) and the job stays enrichment-pending so a later
    run re-evaluates robots (or the owner imports the posting manually). The
    ``robots_disallowed`` metric is recorded separately by the caller via the
    politeness session, so this never inflates ``attempt_count``.
    """
    from jobhunter.state import (
        ensure_job_stage_rows,
        record_job_event,
        set_stage_state,
        utc_now,
    )

    finished_at = utc_now()
    message = decision.reason or "robots.txt disallows automated fetch of this URL"
    ensure_job_stage_rows(conn, url)
    set_stage_state(
        conn,
        url,
        "enrich",
        "blocked",
        error_code="ENRICH_ROBOTS_DISALLOWED",
        error_message=message[:500],
        retryable=True,
        next_action=f"Import this posting manually — robots.txt disallows automated fetch: {url}",
        finished_at=finished_at,
        metadata={"reason": "robots_disallowed", "politenessOutcome": decision.outcome.value},
        validate_transition=False,
    )
    record_job_event(
        conn,
        url,
        "enrich",
        "StageBlocked",
        level="warning",
        message=message,
        payload={
            "errorCode": "ENRICH_ROBOTS_DISALLOWED",
            "reason": "robots_disallowed",
            "politenessOutcome": decision.outcome.value,
            "retryable": True,
        },
    )
    conn.commit()


def _record_enrich_politeness_deferral(
    conn: sqlite3.Connection,
    repo: SqliteEnrichmentRepository,
    aggregate: JobEnrichment,
    url: str,
    started_at: str,
    cascade_result: dict,
) -> None:
    """Fold a mid-flight budget block (peek allowed, guard denied) as a deferral.

    Only reachable in the rare parallel race where the shared run budget drains
    between the pre-navigation peek and the guard. The politeness *outcome* was
    already recorded by the guard (non-error); here we close the started attempt
    as a retryable failure (``Running -> Failed`` is valid) so the job is retried
    on the next run rather than counted as a scrape failure.
    """
    from jobhunter.state import record_job_event, set_stage_state, utc_now

    finished_at = utc_now()
    message = str(cascade_result.get("error") or "request budget exhausted; will retry")[:500]
    error = EnrichmentError(code="ENRICH_POLITENESS_DEFERRED", message=message, retryable=True)
    failed = aggregate.fail_attempt(error=error, finished_at=finished_at)
    repo.save(failed)
    set_stage_state(
        conn,
        url,
        "enrich",
        "failed",
        attempt_count=failed.attempt_count,
        started_at=started_at,
        finished_at=finished_at,
        error_code=error.code,
        error_message=error.message,
        retryable=True,
        next_action=f"jobhunter retry enrich {url}",
    )
    record_job_event(
        conn,
        url,
        "enrich",
        "StageFailed",
        level="warning",
        message=message,
        payload={
            "errorCode": error.code,
            "retryable": True,
            "politenessOutcome": cascade_result.get("politeness_outcome"),
        },
    )


def _record_enrich_job_failure(conn: sqlite3.Connection, url: str, exc: Exception) -> None:
    """Record a single job's unexpected enrichment failure without aborting the batch.

    ``validate_transition=False`` because the failure-recording path must never
    itself raise on an odd prior state (e.g. a ``succeeded -> failed`` write when
    the row was already marked succeeded earlier in the loop).
    """
    message = f"{type(exc).__name__}: {exc}"[:500]
    try:
        from jobhunter.state import record_job_event, set_stage_state, utc_now

        finished_at = utc_now()
        _record_enrich_aggregate_failure(conn, url, message, finished_at=finished_at)
        set_stage_state(
            conn,
            url,
            "enrich",
            "failed",
            error_code="ENRICH_INTERNAL_ERROR",
            error_message=message,
            retryable=True,
            finished_at=finished_at,
            validate_transition=False,
        )
        record_job_event(
            conn,
            url,
            "enrich",
            "StageFailed",
            level="error",
            message=message,
            payload={
                "errorCode": "ENRICH_INTERNAL_ERROR",
                "errorMessage": message,
                "retryable": True,
            },
        )
        conn.commit()
    except Exception:
        log.exception("Failed to record enrichment job failure for %s", url)


def _record_enrich_aggregate_failure(
    conn: sqlite3.Connection,
    url: str,
    message: str,
    *,
    finished_at: str,
) -> None:
    """Persist the canonical failed JobEnrichment attempt for an isolated crash."""
    repo = SqliteEnrichmentRepository(conn)
    existing = repo.load(LOCAL_TENANT, JobId(url))
    if existing is not None and existing.is_enriched:
        # Do not destroy an accepted enrichment artifact from a later audit-only
        # failure path. The stage event below still preserves the crash.
        return

    error = EnrichmentError(
        code="ENRICH_INTERNAL_ERROR",
        message=message,
        retryable=True,
    )
    aggregate = existing or JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        updated_at=finished_at,
    )
    running = (
        aggregate
        if aggregate.is_running
        else aggregate.start_attempt(
            extraction_tier=ExtractionTier.LLM_ASSISTED,
            started_at=finished_at,
        )
    )
    repo.save(running.fail_attempt(error=error, finished_at=finished_at))


def scrape_site_batch(
    conn: sqlite3.Connection | None,
    site: str,
    jobs: list[tuple],
    max_jobs: int | None = None,
    cancel_event: threading.Event | None = None,
    *,
    gateway: PolitenessGateway | None = None,
    run_budget: RunBudgetCounter | None = None,
) -> dict:
    """Process all jobs for one site using a shared browser context.

    Persistence routes through ``SqliteEnrichmentRepository`` — legacy
    ``jobs.full_description`` / ``jobs.application_url`` /
    ``jobs.detail_scraped_at`` / ``jobs.detail_error`` columns are NOT
    written.

    R10: every navigation is gated by the politeness gateway. ``gateway`` and
    ``run_budget`` are supplied by :func:`_run_detail_scraper` so all site
    batches in one run share a single robots cache + per-run request budget +
    process-wide host limiter; a standalone caller lets them self-provision. The
    fixed per-site ``SITE_DELAYS`` sleep is gone — the host-keyed limiter paces
    each host (per-host min-interval + concurrency across threads).
    """
    stats: dict = {
        "processed": 0,
        "ok": 0,
        "partial": 0,
        "error": 0,
        "blocked": 0,
        "tiers": {1: 0, 2: 0, 3: 0},
    }

    if max_jobs:
        jobs = jobs[:max_jobs]

    if not jobs:
        return stats

    own_conn = conn is None
    if own_conn:
        conn = init_db()
    assert conn is not None

    if run_budget is None:
        run_budget = _new_enrichment_budget()

    repo = SqliteEnrichmentRepository(conn)

    try:
        with sync_playwright() as p:
            browser = None
            resolver: LinkedInApplyUrlResolver | None = None
            if linkedin_apply_resolver_enabled() and _is_linkedin_job(site, jobs[0][0]):
                # Owner-scoped authenticated context: present the real logged-in
                # browser identity (user_agent=None), never the bot UA, matching
                # _default_linkedin_apply_resolver_factory (D1/D3, see module top).
                resolver = LinkedInApplyUrlResolver(
                    proxy=_PROXY_CONFIG,
                    user_agent=None,
                    playwright=p,
                )
                try:
                    resolver.start()
                    page = resolver.new_page()
                    log.info(
                        "LinkedIn authenticated browser enabled for %d enrichment job(s)",
                        len(jobs),
                    )
                except Exception as exc:  # noqa: BLE001 - fallback to static browser
                    log.warning(
                        "LinkedIn authenticated browser unavailable; falling back to unauthenticated enrichment: %s",
                        exc,
                    )
                    resolver.close()
                    resolver = None
                    page = None
            else:
                page = None

            # The authenticated LinkedIn context is the owner's logged-in session,
            # so robots.txt is an owner decision there (D1/D3) — pace + budget it,
            # but do not enforce an anonymous robots verdict on the owner's own
            # account. Every other (anonymous) batch honors robots. This gateway
            # also resolves the honest UA for the anonymous context below, so the
            # identity robots is evaluated with is exactly the identity the fetch
            # presents (never an import-time constant, so an owner UA override
            # reaches the browser).
            if resolver is not None:
                batch_gateway: PolitenessGateway = PolitenessGateway(
                    robots=_OwnerAuthenticatedRobots(),
                    rate_limiter=get_shared_rate_limiter(),
                )
            else:
                batch_gateway = gateway or PolitenessGateway()

            if page is None:
                launch_opts: dict = {"headless": True}
                if _PROXY_CONFIG is not None:
                    launch_opts["proxy"] = _PROXY_CONFIG.playwright
                browser = p.chromium.launch(**launch_opts)
                # Anonymous context presents the gateway's honest UA; the
                # authenticated-LinkedIn page above keeps the owner's real
                # browser identity (user_agent=None) and never enters here.
                context = browser.new_context(user_agent=batch_gateway.user_agent)
                page = context.new_page()

            session = _enrichment_session(batch_gateway, run_budget, conn, site=site)

            for i, (url, title) in enumerate(jobs):
                if cancel_event is not None and cancel_event.is_set():
                    raise TransientNetworkError("enrichment canceled")
                log.info(
                    "[%d/%d] %s",
                    i + 1,
                    len(jobs),
                    title[:50] if title else url[:50],
                )

                from jobhunter.state import (
                    ensure_job_stage_rows,
                    record_job_event,
                    set_stage_state,
                    utc_now,
                )

                # Already-enriched rows need no navigation — reaffirm and skip
                # before the gate so a robots change can't relabel finished work.
                aggregate = repo.load(LOCAL_TENANT, JobId(url))
                if aggregate is not None and aggregate.is_enriched:
                    stats["processed"] += 1
                    stats["ok"] += 1
                    ensure_job_stage_rows(conn, url)
                    set_stage_state(
                        conn,
                        url,
                        "enrich",
                        "succeeded",
                        attempt_count=aggregate.attempt_count,
                        finished_at=utc_now(),
                        validate_transition=False,
                    )
                    conn.commit()
                    continue

                # R10 pre-navigation gate (peek). A block folds into the lifecycle
                # WITHOUT entering 'running' (Running->Blocked is not valid;
                # Pending->Blocked is). scrape_detail_page's guard is the
                # authoritative budget-consume + slot hold.
                gate = session.check(url)
                if not gate.allowed:
                    session.record(gate, url)
                    if gate.outcome is PolitenessOutcome.BUDGET_EXHAUSTED:
                        log.warning(
                            "Enrichment request budget exhausted; deferring %d remaining %s job(s) to a future run",
                            len(jobs) - i,
                            site,
                        )
                        break
                    _record_enrich_robots_blocked(conn, url, gate)
                    stats["blocked"] += 1
                    continue

                try:
                    started_at = utc_now()
                    ensure_job_stage_rows(conn, url)
                    set_stage_state(conn, url, "enrich", "running", started_at=started_at)
                    record_job_event(conn, url, "enrich", "StageStarted", message="Enrichment started")

                    aggregate = aggregate or JobEnrichment.empty(
                        tenant_id=LOCAL_TENANT,
                        job_id=JobId(url),
                        updated_at=started_at,
                    )
                    aggregate = aggregate.start_attempt(
                        extraction_tier=ExtractionTier.JSON_LD,
                        started_at=started_at,
                    )

                    cascade_result = _apply_discovery_description_fallback(
                        conn, url, scrape_detail_page(page, url, session=session)
                    )
                    if cascade_result.get("status") == "blocked":
                        # Rare parallel race: budget drained between peek + guard.
                        _record_enrich_politeness_deferral(
                            conn, repo, aggregate, url, started_at, cascade_result
                        )
                        conn.commit()
                        break
                    cascade_result = _apply_authenticated_linkedin_apply_url(
                        site=site,
                        url=url,
                        cascade_result=cascade_result,
                        resolver=resolver,
                        page=page,
                    )
                    stats["processed"] += 1

                    tier = cascade_result.get("tier_used")
                    status = cascade_result["status"]
                    elapsed = cascade_result.get("elapsed", 0)

                    if tier:
                        stats["tiers"][tier] = stats["tiers"].get(tier, 0) + 1

                    tier_str = f"T{tier}" if tier else "--"
                    desc_len = len(cascade_result.get("full_description") or "")
                    apply_str = "yes" if cascade_result.get("application_url") else "no"
                    err_str = (
                        f" | err={cascade_result.get('error')}"
                        if cascade_result.get("error")
                        else ""
                    )
                    log.info(
                        "  %s | %s | desc=%s chars | apply=%s | %.1fs%s",
                        status,
                        tier_str,
                        f"{desc_len:,}",
                        apply_str,
                        elapsed,
                        err_str,
                    )

                    finished_at = utc_now()
                    if status in ("ok", "partial"):
                        stats[status] += 1
                        fallback_source = cascade_result.get("fallback_source")
                        stage_metadata: dict[str, object] = {}
                        if fallback_source:
                            stage_metadata.update(
                                {
                                    "fallbackSource": fallback_source,
                                    "detailStatus": cascade_result.get("detail_status"),
                                    "detailError": cascade_result.get("detail_error"),
                                }
                            )
                        if cascade_result.get("authenticated_apply_url_method"):
                            stage_metadata["authenticatedApplyUrlMethod"] = (
                                cascade_result.get("authenticated_apply_url_method")
                            )
                        if cascade_result.get("authenticated_apply_url_error"):
                            stage_metadata["authenticatedApplyUrlError"] = (
                                cascade_result.get("authenticated_apply_url_error")
                            )
                        full_desc = FullDescription(
                            text=cascade_result["full_description"] or ""
                        )
                        apply_url = (
                            ApplicationUrl(value=cascade_result["application_url"])
                            if cascade_result.get("application_url")
                            else None
                        )
                        succeeded = aggregate.succeed_attempt(
                            full_description=full_desc,
                            application_url=apply_url,
                            extraction_tier=_tier_from_legacy(tier),
                            finished_at=finished_at,
                        )
                        repo.save(succeeded)
                        _record_posting_snapshot_from_cascade(
                            conn,
                            url=url,
                            source_id=site or "enrichment",
                            title=title or "",
                            cascade_result=cascade_result,
                            captured_at=finished_at,
                        )
                        set_stage_state(
                            conn,
                            url,
                            "enrich",
                            "succeeded",
                            attempt_count=succeeded.attempt_count,
                            started_at=started_at,
                            finished_at=finished_at,
                            metadata=stage_metadata or None,
                        )
                        completed_payload = {
                            "tier": tier,
                            "elapsed": elapsed,
                            "descriptionChars": desc_len,
                            "applicationUrlFound": bool(
                                cascade_result.get("application_url")
                            ),
                        }
                        if cascade_result.get("authenticated_apply_url_method"):
                            completed_payload["authenticatedApplyUrlMethod"] = (
                                cascade_result.get("authenticated_apply_url_method")
                            )
                        if cascade_result.get("authenticated_apply_url_error"):
                            completed_payload["authenticatedApplyUrlError"] = (
                                cascade_result.get("authenticated_apply_url_error")
                            )
                        if fallback_source:
                            completed_payload.update(
                                {
                                    "fallbackSource": fallback_source,
                                    "detailStatus": cascade_result.get("detail_status"),
                                    "detailError": cascade_result.get("detail_error"),
                                }
                            )
                        record_job_event(
                            conn,
                            url,
                            "enrich",
                            "StageCompleted",
                            message=f"Enrichment {status}: {desc_len} description chars",
                            payload=completed_payload,
                        )
                    elif status == "inactive":
                        stats["error"] += 1
                        _record_posting_snapshot_from_cascade(
                            conn,
                            url=url,
                            source_id=site or "enrichment",
                            title=title or "",
                            cascade_result=cascade_result,
                            captured_at=finished_at,
                        )
                        err = EnrichmentError(
                            code="POSTING_INACTIVE",
                            message=str(cascade_result.get("error") or "posting inactive")[:500],
                            retryable=False,
                        )
                        failed = aggregate.fail_attempt(
                            error=err, finished_at=finished_at
                        )
                        repo.save(failed)
                        set_stage_state(
                            conn,
                            url,
                            "enrich",
                            "failed",
                            attempt_count=failed.attempt_count,
                            started_at=started_at,
                            finished_at=finished_at,
                            error_code="POSTING_INACTIVE",
                            error_message=err.message,
                            retryable=False,
                        )
                        record_job_event(
                            conn,
                            url,
                            "enrich",
                            "StageFailed",
                            level="info",
                            message=err.message,
                            payload={
                                "errorCode": "POSTING_INACTIVE",
                                "errorMessage": err.message,
                                "retryable": False,
                                "attemptNumber": failed.attempt_count,
                                "status": status,
                                "tier": tier,
                                "elapsed": elapsed,
                                "durationMs": int(elapsed * 1000) if elapsed else None,
                                "descriptionChars": desc_len,
                                "applicationUrlFound": bool(
                                    cascade_result.get("application_url")
                                ),
                                "activeState": cascade_result.get("active_state"),
                                "active_state": cascade_result.get("active_state"),
                                "verificationMethod": cascade_result.get(
                                    "verification_method"
                                ),
                                "verification_method": cascade_result.get(
                                    "verification_method"
                                ),
                                "httpStatus": cascade_result.get("http_status"),
                                "http_status": cascade_result.get("http_status"),
                            },
                        )
                    else:
                        stats["error"] += 1
                        retryable = _detail_failure_retryable(cascade_result)
                        err = EnrichmentError(
                            code="DETAIL_ERROR",
                            message=str(cascade_result.get("error") or "unknown")[:500],
                            retryable=retryable,
                        )
                        failed = aggregate.fail_attempt(
                            error=err, finished_at=finished_at
                        )
                        repo.save(failed)
                        set_stage_state(
                            conn,
                            url,
                            "enrich",
                            "failed",
                            attempt_count=failed.attempt_count,
                            started_at=started_at,
                            finished_at=finished_at,
                            error_code="DETAIL_ERROR",
                            error_message=err.message,
                            retryable=retryable,
                            next_action=f"jobhunter retry enrich {url}" if retryable else None,
                        )
                        record_job_event(
                            conn,
                            url,
                            "enrich",
                            "StageFailed",
                            level="error",
                            message=err.message,
                            payload={
                                "errorCode": "DETAIL_ERROR",
                                "errorMessage": err.message,
                                "retryable": retryable,
                                "attemptNumber": failed.attempt_count,
                                "status": status,
                                "tier": tier,
                                "elapsed": elapsed,
                                "durationMs": int(elapsed * 1000) if elapsed else None,
                                "descriptionChars": desc_len,
                                "applicationUrlFound": bool(
                                    cascade_result.get("application_url")
                                ),
                                "activeState": cascade_result.get("active_state"),
                                "active_state": cascade_result.get("active_state"),
                                "verificationMethod": cascade_result.get(
                                    "verification_method"
                                ),
                                "verification_method": cascade_result.get(
                                    "verification_method"
                                ),
                                "httpStatus": cascade_result.get("http_status"),
                                "http_status": cascade_result.get("http_status"),
                            },
                        )
                        _record_posting_snapshot_failure_from_cascade(
                            conn,
                            url=url,
                            source_id=site or "enrichment",
                            cascade_result=cascade_result,
                            failed_at=finished_at,
                        )

                    conn.commit()
                except TransientNetworkError:
                    raise
                except Exception as exc:
                    log.exception("Enrichment job failed: %s", url)
                    stats["error"] += 1
                    _record_enrich_job_failure(conn, url, exc)

                # No inter-job sleep: the shared host limiter (inside the gate)
                # now paces each host by min-interval + concurrency across threads.

            if browser is not None:
                browser.close()
            if resolver is not None:
                resolver.close()
    finally:
        if own_conn:
            conn.close()

    return stats


def _tier_from_legacy(tier_num: int | None) -> ExtractionTier:
    """Translate the legacy 1/2/3 tier number into the typed enum."""
    if tier_num == 1:
        return ExtractionTier.JSON_LD
    if tier_num == 2:
        return ExtractionTier.CSS_SELECTORS
    return ExtractionTier.LLM_ASSISTED


def _record_posting_snapshot_from_cascade(
    conn: sqlite3.Connection,
    *,
    url: str,
    source_id: str,
    title: str,
    cascade_result: dict,
    captured_at: str,
) -> None:
    """Persist ``PostingSnapshotSet`` history from the existing enrich path."""
    description = str(cascade_result.get("full_description") or "")
    if not description.strip():
        return
    resolved_source_id = _source_id_for_enriched_job(conn, url, fallback=source_id)
    try:
        repo = SqlitePostingSnapshotSetRepository(conn)
        snapshot_set = repo.load(LOCAL_TENANT, JobId(url)) or PostingSnapshotSet.empty(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            updated_at=captured_at,
        )
        previous_active = snapshot_set.latest_active_state
        active_state = (
            ActiveState.from_optional(cascade_result.get("active_state"))
            or ActiveState.ACTIVE
        )
        verification_method = str(
            cascade_result.get("verification_method") or "enrichment_success"
        )
        tier = _tier_from_legacy(cascade_result.get("tier_used"))
        apply_url = (
            SnapshotApplyUrl(value=str(cascade_result["application_url"]))
            if cascade_result.get("application_url")
            else None
        )
        confidence = judge_snapshot_confidence(
            tier=tier,
            description=FullDescription(text=description),
            apply_url_present=apply_url is not None,
        )
        quarantine_reason = (
            QuarantineReason.NONE
            if confidence is not SnapshotConfidence.LOW and apply_url is not None
            else QuarantineReason.LOW_CONFIDENCE_EXTRACTION
        )
        snapshot_set, snapshot = snapshot_set.record_snapshot(
            source_id=resolved_source_id,
            extraction_tier=tier.value,
            description_hash=SnapshotDescriptionHash.from_text(description),
            apply_url=apply_url,
            active_state=active_state,
            confidence=confidence,
            quarantine_reason=quarantine_reason,
            captured_at=captured_at,
            evidence=(
                f"tier:{tier.value}",
                f"description_length:{len(description)}",
                f"apply_url_present:{str(apply_url is not None).lower()}",
            ),
        )
        repo.save(snapshot_set)

        from jobhunter.state import record_job_event

        record_job_event(
            conn,
            url,
            "enrich",
            "PostingContentSnapshotCaptured",
            message="Posting content snapshot captured.",
            payload={
                "tenantId": str(LOCAL_TENANT),
                "job_id": url,
                "jobId": url,
                "snapshot_version": snapshot.snapshot_version,
                "snapshotVersion": snapshot.snapshot_version,
                "snapshot_ref": f"{url}:{snapshot.snapshot_version}",
                "snapshotRef": f"{url}:{snapshot.snapshot_version}",
                "source_id": resolved_source_id,
                "sourceId": resolved_source_id,
                "extraction_tier": tier.value,
                "extractionTier": tier.value,
                "confidence": confidence.value,
                "quarantine_reason": quarantine_reason.value,
                "quarantineReason": quarantine_reason.value,
                "quarantined": quarantine_reason is not QuarantineReason.NONE,
                "captured_at": captured_at,
                "capturedAt": captured_at,
            },
            occurred_at=captured_at,
        )
        if previous_active is not active_state:
            record_job_event(
                conn,
                url,
                "enrich",
                "JobActiveStateChanged",
                message="Job active state changed.",
                payload={
                    "tenantId": str(LOCAL_TENANT),
                    "job_id": url,
                    "jobId": url,
                    "active_state": active_state.value,
                    "activeState": active_state.value,
                    "previous_state": previous_active.value,
                    "previousState": previous_active.value,
                    "verification_method": verification_method,
                    "verificationMethod": verification_method,
                    "verified_at": captured_at,
                    "verifiedAt": captured_at,
                },
                occurred_at=captured_at,
            )
        if quarantine_reason is not QuarantineReason.NONE:
            ensure_discovery_control_tables(conn)
            conn.execute(
                """
                INSERT INTO discovery_quarantine_entries (
                    tenant_id, job_id, job_key, title, company, source_id,
                    posting_url, reason, confidence, snapshot_version,
                    captured_at, notice_text, status
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
                    url,
                    url,
                    title,
                    resolved_source_id,
                    url,
                    quarantine_reason.value,
                    _snapshot_confidence_value(confidence),
                    snapshot.snapshot_version,
                    captured_at,
                    "Enrichment snapshot needs review before downstream handoff.",
                ),
            )
        conn.commit()
    except Exception:
        log.exception("Failed to persist PostingSnapshotSet for %s", url)


def _record_posting_snapshot_failure_from_cascade(
    conn: sqlite3.Connection,
    *,
    url: str,
    source_id: str,
    cascade_result: dict,
    failed_at: str,
) -> None:
    """Persist verified active-state failures from the existing enrich path."""
    active_state = ActiveState.from_optional(cascade_result.get("active_state"))
    verification_method = str(cascade_result.get("verification_method") or "")
    if active_state is None or verification_method == "unknown":
        return
    resolved_source_id = _source_id_for_enriched_job(conn, url, fallback=source_id)
    try:
        repo = SqlitePostingSnapshotSetRepository(conn)
        snapshot_set = repo.load(LOCAL_TENANT, JobId(url)) or PostingSnapshotSet.empty(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            updated_at=failed_at,
        )
        error_class = str(cascade_result.get("error") or "DETAIL_ERROR")[:120]
        retryable = _detail_failure_retryable(cascade_result)
        snapshot_set, _ = snapshot_set.record_capture_failure(
            source_id=resolved_source_id,
            error_class=error_class,
            message=str(cascade_result.get("error") or "detail extraction failed")[:500],
            retryable=retryable,
            failed_at=failed_at,
        )
        snapshot_set, previous_active = snapshot_set.mark_active_state(
            active_state=active_state,
            verified_at=failed_at,
        )
        repo.save(snapshot_set)

        from jobhunter.state import record_job_event

        record_job_event(
            conn,
            url,
            "enrich",
            "PostingContentSnapshotFailed",
            message="Posting content snapshot failed.",
            payload={
                "tenantId": str(LOCAL_TENANT),
                "job_id": url,
                "jobId": url,
                "source_id": resolved_source_id,
                "sourceId": resolved_source_id,
                "error_class": error_class,
                "errorClass": error_class,
                "retryable": retryable,
                "status": cascade_result.get("status"),
                "tier": cascade_result.get("tier_used"),
                "elapsed": cascade_result.get("elapsed"),
                "durationMs": (
                    int(float(cascade_result.get("elapsed")) * 1000)
                    if cascade_result.get("elapsed")
                    else None
                ),
                "descriptionChars": len(
                    str(cascade_result.get("full_description") or "")
                ),
                "applicationUrlFound": bool(cascade_result.get("application_url")),
                "active_state": active_state.value,
                "activeState": active_state.value,
                "verification_method": verification_method,
                "verificationMethod": verification_method,
                "http_status": cascade_result.get("http_status"),
                "httpStatus": cascade_result.get("http_status"),
                "failed_at": failed_at,
                "failedAt": failed_at,
            },
            occurred_at=failed_at,
        )
        if previous_active is not None:
            record_job_event(
                conn,
                url,
                "enrich",
                "JobActiveStateChanged",
                message="Job active state changed.",
                payload={
                    "tenantId": str(LOCAL_TENANT),
                    "job_id": url,
                    "jobId": url,
                    "active_state": active_state.value,
                    "activeState": active_state.value,
                    "previous_state": previous_active.value,
                    "previousState": previous_active.value,
                    "verification_method": verification_method,
                    "verificationMethod": verification_method,
                    "verified_at": failed_at,
                    "verifiedAt": failed_at,
                },
                occurred_at=failed_at,
            )
    except Exception:
        log.exception("Failed to persist PostingSnapshotSet failure for %s", url)


def _source_id_for_enriched_job(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    fallback: str,
) -> str:
    """Return the discovery source id for an enriched job when available."""
    try:
        row = conn.execute(
            """
            SELECT source_id
            FROM job_source_observations
            WHERE tenant_id = ? AND job_url = ?
            ORDER BY observed_at DESC, source_observation_id DESC
            LIMIT 1
            """,
            (str(LOCAL_TENANT), job_url),
        ).fetchone()
    except sqlite3.OperationalError:
        return fallback
    if row is None:
        return fallback
    source_id = str(row[0] or "").strip()
    return source_id or fallback


def _attempt_count_from_json(attempts_json: str | None) -> int:
    if not attempts_json:
        return 0
    try:
        attempts = json.loads(attempts_json)
    except Exception:
        return 0
    return len(attempts) if isinstance(attempts, list) else 0


def _last_failed_attempt_retryable(attempts_json: str | None) -> bool:
    if not attempts_json:
        return True
    try:
        attempts = json.loads(attempts_json)
    except Exception:
        return True
    if not isinstance(attempts, list):
        return True
    for attempt in reversed(attempts):
        if not isinstance(attempt, dict):
            continue
        if str(attempt.get("status") or "").lower() != "failed":
            continue
        error = attempt.get("error")
        if not isinstance(error, dict):
            return True
        return bool(error.get("retryable", True))
    return True


def _default_linkedin_apply_resolver_factory() -> LinkedInApplyUrlResolver:
    """Build the authenticated resolver used for apply-URL recovery.

    The resolver drives a persistent, user-authenticated Chrome profile — a real
    logged-in browser session, semantically distinct from anonymous crawling.
    Passing ``user_agent=None`` lets that session present its own real browser
    identity rather than the honest JobHunter bot UA (owner decision D1/D3): the
    product does not evade controls, but must not break a user-authorized flow.
    """
    return LinkedInApplyUrlResolver(proxy=_PROXY_CONFIG, user_agent=None)


def _reset_authenticated_linkedin_retry_candidates(
    conn: sqlite3.Connection,
    *,
    job_urls: tuple[str, ...] = (),
    limit: int | None = None,
    resolver_factory: Callable[[], object] | None = None,
) -> int:
    """Retry LinkedIn rows that need authenticated enrichment follow-up.

    The normal enrichment queue excludes failed aggregates and already
    enriched rows. LinkedIn is the exception because a logged-in browser can
    expose data hidden from the first unauthenticated pass, especially the
    external apply target. Two disjoint groups are handled:

      * **Enriched but missing the apply URL** — resolved non-destructively.
        Only ``application_url`` is backfilled; the canonical
        ``full_description`` and the ``enriched`` status are preserved, so a
        failed or empty authenticated resolution can never destroy reviewable
        material. Each authenticated pass records an ``EnrichmentAttempt`` so
        this path shares the same attempt-count bound as the cascade.
      * **Failed / non-enriched** — reset back to ``pending`` so the normal
        cascade re-scrapes them under an authenticated browser. These rows
        hold no enriched description to lose.

    Both paths are bounded by attempt count so repeated enrich runs do not
    loop forever (and never re-drive the authenticated browser against a
    never-resolving posting) when the profile is not logged in or the posting
    has no external apply target. Returns the number of rows reset (re-queued).
    """
    if not linkedin_apply_resolver_enabled():
        return 0

    selected_urls = tuple(dict.fromkeys(url for url in job_urls if url))
    where = [
        "lower(COALESCE(j.site, '')) = 'linkedin'",
        "e.current_status IN ('failed', 'enriched')",
        "(e.current_status = 'failed' OR e.application_url IS NULL OR e.application_url = '')",
    ]
    params: list[object] = []
    if selected_urls:
        placeholders = ", ".join("?" for _ in selected_urls)
        where.append(f"j.url IN ({placeholders})")
        params.extend(selected_urls)

    rows = conn.execute(
        f"""
        SELECT j.url, e.current_status, e.application_url, e.attempts_json
        FROM jobs j
        JOIN job_enrichments e ON e.job_url = j.url
        WHERE {' AND '.join(where)}
        ORDER BY e.updated_at DESC
        """,
        params,
    ).fetchall()

    from jobhunter.state import (
        ensure_job_stage_rows,
        record_job_event,
        set_stage_state,
        utc_now,
    )

    repo = SqliteEnrichmentRepository(conn)
    reset_count = 0
    recovery_count = 0
    backfill_count = 0
    resolver: object | None = None
    try:
        for row in rows:
            try:
                attempts_json = row["attempts_json"] if isinstance(row, sqlite3.Row) else row[3]
                if _attempt_count_from_json(attempts_json) >= _MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS:
                    continue
                current_status = row["current_status"] if isinstance(row, sqlite3.Row) else row[1]
                if str(current_status) == "failed" and not _last_failed_attempt_retryable(attempts_json):
                    continue
                url = str(row["url"] if isinstance(row, sqlite3.Row) else row[0])
                now = utc_now()
                aggregate = repo.load(LOCAL_TENANT, JobId(url))
                if aggregate is None:
                    continue

                if aggregate.is_enriched:
                    if resolver is None and resolver_factory is not None:
                        try:
                            resolver = resolver_factory()
                        except Exception:
                            log.warning(
                                "LinkedIn apply resolver unavailable; skipping apply-URL recovery",
                                exc_info=True,
                            )
                            resolver_factory = None
                    if resolver is None:
                        continue
                    resolved = _apply_authenticated_linkedin_apply_url(
                        site="linkedin",
                        url=url,
                        cascade_result={
                            "status": "ok",
                            "full_description": (
                                aggregate.full_description.text
                                if aggregate.full_description
                                else ""
                            ),
                            "application_url": None,
                        },
                        resolver=resolver,
                        page=None,
                    )
                    apply_url_value = resolved.get("application_url")
                    recovered = (
                        ApplicationUrl(value=str(apply_url_value)) if apply_url_value else None
                    )
                    # Every authenticated pass records an attempt so a
                    # never-resolving row is bounded by attempt count exactly
                    # like the extraction cascade; the description is never
                    # touched.
                    repo.save(
                        aggregate.record_apply_url_recovery(
                            application_url=recovered,
                            extraction_tier=ExtractionTier.CSS_SELECTORS,
                            started_at=now,
                            finished_at=utc_now(),
                        )
                    )
                    record_job_event(
                        conn,
                        url,
                        "enrich",
                        "StageProgress",
                        message=(
                            "LinkedIn authenticated apply URL recovered"
                            if recovered is not None
                            else "LinkedIn authenticated apply URL unresolved"
                        ),
                        payload={
                            "reason": "linkedin_authenticated_apply_url",
                            "applicationUrlFound": recovered is not None,
                            "authenticatedApplyUrlMethod": resolved.get(
                                "authenticated_apply_url_method"
                            ),
                            "authenticatedApplyUrlError": resolved.get(
                                "authenticated_apply_url_error"
                            ),
                            "automated": True,
                        },
                    )
                    recovery_count += 1
                    if recovered is not None:
                        backfill_count += 1
                    if limit and limit > 0 and (reset_count + recovery_count) >= limit:
                        break
                    continue

                repo.save(aggregate.reset(reset_at=now))
                conn.execute(
                    "UPDATE jobs SET detail_error = NULL, detail_scraped_at = NULL WHERE url = ?",
                    (url,),
                )
                ensure_job_stage_rows(conn, url)
                set_stage_state(
                    conn,
                    url,
                    "enrich",
                    "pending",
                    validate_transition=False,
                )
                record_job_event(
                    conn,
                    url,
                    "enrich",
                    "StageReset",
                    message="LinkedIn authenticated enrichment retry queued",
                    payload={
                        "reason": "linkedin_authenticated_apply_url",
                        "previousStatus": str(current_status or ""),
                        "automated": True,
                        "resetAt": now,
                    },
                )
                reset_count += 1
                if limit and limit > 0 and (reset_count + recovery_count) >= limit:
                    break
            except Exception:  # noqa: BLE001 - one bad row must not abort the scan
                log.exception("LinkedIn authenticated retry candidate scan failed for a row")
                continue
    finally:
        close = getattr(resolver, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                log.debug("LinkedIn apply resolver close failed", exc_info=True)

    if reset_count or recovery_count:
        conn.commit()
        if reset_count:
            log.info(
                "LinkedIn authenticated enrichment retry queued for %d job(s)",
                reset_count,
            )
        if backfill_count:
            log.info(
                "LinkedIn authenticated apply URL backfilled for %d job(s)",
                backfill_count,
            )
    return reset_count


def _snapshot_confidence_value(confidence: SnapshotConfidence) -> float:
    if confidence is SnapshotConfidence.HIGH:
        return 0.95
    if confidence is SnapshotConfidence.MEDIUM:
        return 0.7
    return 0.35


def _looks_like_broken_browser_env(message: str | None) -> bool:
    """Heuristic: does a scrape error mean the browser install is broken?

    A missing Playwright browser binary is a deterministic environment fault —
    retrying it just burns time (and authenticated browser passes). Detect the
    Playwright launch signatures so the systemic error is classified
    non-retryable rather than as a transient network blip.
    """
    text = str(message or "").lower()
    return "executable doesn't exist" in text or "playwright install" in text


def _systemic_enrichment_error(site_errors: dict[str, dict[str, str]]) -> Exception:
    """Build the stage-level error when every enrichment site failed.

    Returns a non-retryable ``ConfigurationError`` when every site failed for a
    broken-environment reason (missing browser binary), otherwise a retryable
    ``TransientNetworkError``. The message carries every site's
    ``error_class: error_message`` so the failure is diagnosable instead of
    collapsing to "failed".
    """
    summary = "; ".join(
        f"{site}: {info.get('error_class', 'Error')}: {info.get('error_message', '')}"
        for site, info in site_errors.items()
    )
    message = f"All enrichment sites failed: {summary}"
    broken_env = bool(site_errors) and all(
        _looks_like_broken_browser_env(info.get("error_message"))
        for info in site_errors.values()
    )
    if broken_env:
        return ConfigurationError(message)
    return TransientNetworkError(message)


def _run_detail_scraper(
    conn: sqlite3.Connection,
    sites: list[str] | None = None,
    max_per_site: int | None = None,
    workers: int = 1,
    job_urls: tuple[str, ...] = (),
    cancel_event: threading.Event | None = None,
    reset_linkedin_candidates: bool = True,
) -> dict:
    """Group pending jobs by site and process each batch.

    Sequential by default; ``workers > 1`` runs site batches in
    parallel (one DB connection per thread).

    Pending = jobs whose enrichment row is missing OR ``current_status``
    is ``pending`` (read through the new enrichment LEFT JOIN — see
    ``database.get_jobs_by_stage`` and the same pattern surfaced here).
    """
    skip_filter = " AND ".join(f"jobs.site != '{s}'" for s in SKIP_DETAIL_SITES)
    # Phase 7 (S-26 round-1 review M3): the canonical pending predicate
    # is the aggregate's status alone. The legacy
    # ``detail_scraped_at IS NULL`` gate was redundant AND blocked the
    # post-``reset_job_stage("enrich")`` re-pickup.
    where_parts = [db_module._ENRICHMENT_PENDING, skip_filter]
    params: list[str] = []
    selected_urls = tuple(dict.fromkeys(url for url in job_urls if url))
    if selected_urls:
        placeholders = ", ".join("?" for _ in selected_urls)
        where_parts.append(f"jobs.url IN ({placeholders})")
        params.extend(selected_urls)

    if reset_linkedin_candidates:
        _reset_authenticated_linkedin_retry_candidates(
            conn,
            job_urls=selected_urls,
            limit=max_per_site,
            resolver_factory=_default_linkedin_apply_resolver_factory,
        )

    rows = conn.execute(
        f"SELECT jobs.url, jobs.title, jobs.site FROM jobs {db_module._ENRICHMENT_JOIN} "
        f"WHERE {' AND '.join(where_parts)} "
        "ORDER BY jobs.site",
        params,
    ).fetchall()

    if not rows:
        log.info("No pending jobs to scrape.")
        return {"processed": 0, "ok": 0, "partial": 0, "error": 0, "site_errors": {}}

    site_jobs: dict[str, list[tuple]] = {}
    for row in rows:
        url, title, site = row[0], row[1], row[2]
        if sites and site not in sites:
            continue
        site_jobs.setdefault(site, []).append((url, title))

    log.info("Pending: %d jobs across %d sites (workers=%d)", len(rows), len(site_jobs), workers)
    for site, jobs in site_jobs.items():
        log.info("  %s: %d jobs", site, len(jobs))

    known_order = [
        "RemoteOK",
        "Job Bank Canada",
        "BuiltIn Remote",
        "WelcomeToTheJungle",
        "CareerJet Canada",
        "Hacker News Jobs",
    ]
    order = [s for s in known_order if s in site_jobs]
    order += [s for s in sorted(site_jobs.keys()) if s not in order]

    total_stats: dict = {
        "processed": 0,
        "ok": 0,
        "partial": 0,
        "error": 0,
        "tiers": {1: 0, 2: 0, 3: 0},
    }

    site_errors: dict[str, dict[str, str]] = {}
    any_site_succeeded = False

    def _merge_stats(stats: dict) -> None:
        for k in ("processed", "ok", "partial", "error"):
            total_stats[k] += stats[k]
        for t, count in stats["tiers"].items():
            total_stats["tiers"][t] = total_stats["tiers"].get(t, 0) + count

    def _record_site_error(site: str, exc: Exception) -> None:
        site_errors[site] = {
            "error_class": type(exc).__name__,
            "error_message": str(exc)[:500],
        }
        log.exception("Enrichment site batch failed: %s", site)

    # One gateway + one run budget shared by every site batch in this run: the
    # process-wide host limiter + robots cache are reused, and the per-run
    # navigation budget is a single counter across sequential and parallel modes.
    gateway = PolitenessGateway()
    run_budget = _new_enrichment_budget()

    if workers > 1 and len(order) > 1:
        def _scrape_site(site: str) -> dict:
            if cancel_event is not None and cancel_event.is_set():
                raise TransientNetworkError("enrichment canceled")
            jobs = site_jobs[site]
            log.info("%s -- %d jobs", site, len(jobs))
            if cancel_event is None:
                stats = scrape_site_batch(
                    None, site, jobs, max_jobs=max_per_site,
                    gateway=gateway, run_budget=run_budget,
                )
            else:
                stats = scrape_site_batch(
                    None,
                    site,
                    jobs,
                    max_jobs=max_per_site,
                    cancel_event=cancel_event,
                    gateway=gateway,
                    run_budget=run_budget,
                )
            log.info(
                "%s summary: %d ok, %d partial, %d error | T1=%d T2=%d T3=%d",
                site,
                stats["ok"],
                stats["partial"],
                stats["error"],
                stats["tiers"].get(1, 0),
                stats["tiers"].get(2, 0),
                stats["tiers"].get(3, 0),
            )
            return stats

        with ThreadPoolExecutor(max_workers=min(workers, len(order))) as pool:
            futures = {pool.submit(_scrape_site, site): site for site in order}
            for future in as_completed(futures):
                if cancel_event is not None and cancel_event.is_set():
                    raise TransientNetworkError("enrichment canceled")
                site = futures[future]
                try:
                    stats = future.result()
                except TransientNetworkError:
                    raise
                except Exception as exc:  # noqa: BLE001 - one broken site must not abort the rest
                    _record_site_error(site, exc)
                    continue
                any_site_succeeded = True
                _merge_stats(stats)
    else:
        for site in order:
            if cancel_event is not None and cancel_event.is_set():
                raise TransientNetworkError("enrichment canceled")
            jobs = site_jobs[site]
            log.info("%s -- %d jobs", site, len(jobs))
            try:
                if cancel_event is None:
                    stats = scrape_site_batch(
                        conn, site, jobs, max_jobs=max_per_site,
                        gateway=gateway, run_budget=run_budget,
                    )
                else:
                    stats = scrape_site_batch(
                        conn,
                        site,
                        jobs,
                        max_jobs=max_per_site,
                        cancel_event=cancel_event,
                        gateway=gateway,
                        run_budget=run_budget,
                    )
            except TransientNetworkError:
                raise
            except Exception as exc:  # noqa: BLE001 - one broken site must not abort the rest
                _record_site_error(site, exc)
                continue
            any_site_succeeded = True
            _merge_stats(stats)
            log.info(
                "Site summary: %d ok, %d partial, %d error | T1=%d T2=%d T3=%d",
                stats["ok"],
                stats["partial"],
                stats["error"],
                stats["tiers"].get(1, 0),
                stats["tiers"].get(2, 0),
                stats["tiers"].get(3, 0),
            )

    if site_errors and total_stats["processed"] == 0 and not any_site_succeeded:
        raise _systemic_enrichment_error(site_errors)

    log.info(
        "TOTAL: %d processed | %d ok | %d partial | %d error",
        total_stats["processed"],
        total_stats["ok"],
        total_stats["partial"],
        total_stats["error"],
    )
    log.info(
        "Tier distribution: T1=%d T2=%d T3=%d",
        total_stats["tiers"].get(1, 0),
        total_stats["tiers"].get(2, 0),
        total_stats["tiers"].get(3, 0),
    )

    llm_calls = total_stats["tiers"].get(3, 0)
    total = total_stats["processed"]
    if total > 0:
        savings = ((total - llm_calls) / total) * 100
        log.info("LLM calls: %d/%d (%.0f%% saved)", llm_calls, total, savings)

    total_stats["site_errors"] = site_errors
    return total_stats


# ---------------------------------------------------------------------------
# Streaming scraper (used by the sequential pipeline)
# ---------------------------------------------------------------------------


def stream_detail(
    upstream_done,
    my_done,
    proxy_str: str | None = None,
    poll_interval: float = 5.0,
) -> None:
    """Streaming detail scraper: polls for un-scraped jobs and processes them.

    Args:
        upstream_done: Event set when discover+extract done. None ⇒ run once.
        my_done: Event to set when this stage completes.
        proxy_str: Proxy in host:port:user:pass format.
        poll_interval: Seconds to sleep when no pending jobs found.
    """
    if proxy_str:
        set_proxy(proxy_str)

    conn = init_db()

    url_stats = resolve_all_urls(conn)
    log.info(
        "URL resolution: %d resolved, %d absolute",
        url_stats["resolved"],
        url_stats["already_absolute"],
    )

    total_ok = 0
    total_err = 0
    t0 = time.time()

    try:
        while True:
            skip_filter = " AND ".join(f"jobs.site != '{s}'" for s in SKIP_DETAIL_SITES)
            # Phase 7 (S-26 round-1 review M3 + round-2 L3): the canonical
            # pending predicate is the aggregate's status alone — keep
            # ``stream_detail`` consistent with ``_run_detail_scraper`` and
            # ``_ENRICHMENT_PENDING`` so all three call sites use the
            # same signal.
            rows = conn.execute(
                f"SELECT jobs.url, jobs.title, jobs.site FROM jobs {db_module._ENRICHMENT_JOIN} "
                f"WHERE {db_module._ENRICHMENT_PENDING} "
                f"AND {skip_filter} "
                "ORDER BY jobs.site LIMIT 200"
            ).fetchall()

            if rows:
                site_jobs: dict[str, list[tuple]] = {}
                for row in rows:
                    url, title, site = row[0], row[1], row[2]
                    site_jobs.setdefault(site, []).append((url, title))

                # One shared gateway + per-cycle run budget across this poll's
                # site batches (a poll cycle is the streaming "run").
                gateway = PolitenessGateway()
                run_budget = _new_enrichment_budget()
                for site, jobs in site_jobs.items():
                    log.info("%s: %d jobs", site, len(jobs))
                    try:
                        stats = scrape_site_batch(
                            conn, site, jobs, gateway=gateway, run_budget=run_budget
                        )
                        total_ok += stats["ok"] + stats["partial"]
                        total_err += stats["error"]
                        log.info(
                            "%s: %d ok, %d partial, %d error",
                            site,
                            stats["ok"],
                            stats["partial"],
                            stats["error"],
                        )
                    except Exception as exc:
                        log.error("%s: CRASHED: %s", site, exc)

            upstream_finished = upstream_done is None or upstream_done.is_set()
            if upstream_finished and not rows:
                break
            if not rows:
                time.sleep(poll_interval)
    finally:
        elapsed = time.time() - t0
        if total_ok or total_err:
            log.info("DONE: %d ok, %d errors in %.1fs", total_ok, total_err, elapsed)
        conn.close()
        my_done.set()


# ---------------------------------------------------------------------------
# Public entry point — preserved for pipeline.py
# ---------------------------------------------------------------------------


def run_enrichment(
    limit: int = 100,
    workers: int = 1,
    cancel_event: threading.Event | None = None,
    reset_linkedin_candidates: bool = True,
) -> dict:
    """Main entry point for detail page enrichment.

    Fetches pending jobs from the new ``job_enrichments`` view (rows
    without an enrichment record OR ``current_status = 'pending'``),
    resolves relative URLs, then runs the three-tier extraction
    cascade on each detail page through the new
    ``EnrichmentRepository``.

    Args:
        limit: Maximum number of jobs per site to process.
        workers: Number of parallel threads. Default 1 (sequential).

    Returns:
        Dict with stats: processed, ok, partial, error, tiers.
    """
    conn = init_db()

    url_stats = resolve_all_urls(conn)
    log.info(
        "URL resolution: %d resolved, %d absolute, %d failed",
        url_stats["resolved"],
        url_stats["already_absolute"],
        url_stats["failed"],
    )

    wttj_count = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE site = 'WelcomeToTheJungle'"
    ).fetchone()[0]
    if wttj_count > 0:
        sample = conn.execute(
            "SELECT url FROM jobs WHERE site = 'WelcomeToTheJungle' LIMIT 1"
        ).fetchone()
        if sample and not sample[0].startswith("http"):
            updated = resolve_wttj_urls(conn)
            log.info("WTTJ: %d URLs updated", updated)

    return _run_detail_scraper(
        conn,
        max_per_site=limit,
        workers=workers,
        cancel_event=cancel_event,
        reset_linkedin_candidates=reset_linkedin_candidates,
    )


# Keep helper imports referenced for type-checkers' "unused" warnings —
# they exist on the module so legacy callers can still discover them.
__all__ = [
    "DetailPage",
    "SKIP_DETAIL_SITES",
    "resolve_url",
    "resolve_all_urls",
    "resolve_wttj_urls",
    "scrape_detail_page",
    "scrape_site_batch",
    "set_proxy",
    "stream_detail",
    "run_enrichment",
    "_clean_content_html",  # re-exported for back-compat with any test that patched it
]
