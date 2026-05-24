"""Workday ATS direct API scraper: searches employer career portals.

Scrapes Workday-powered career sites (TD, RBC, NVIDIA, Salesforce, etc.)
via the undocumented CXS JSON API. Zero LLM, zero browser -- pure HTTP.

Employer registry is loaded from config/employers.yaml instead of being
hardcoded. Supports sequential search + detail fetching with proxy.
"""

import json
import logging
import re
import sqlite3
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html.parser import HTMLParser

from jobhunter import config
from jobhunter.config import CONFIG_DIR
from jobhunter.database import get_connection, init_db
from jobhunter.domain.discovery.identity import AtsKind
from jobhunter.domain.discovery.use_cases import DiscoverJobsUseCase
from jobhunter.domain.discovery.value_objects import JobMetadata, PostingUrl, SearchStrategy, Source
from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.ports.discovery import ScrapedJobPosting
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.discovery.location_filter import (
    configured_location_filters,
    location_matches_target,
)
from jobhunter.discovery.target_queries import query_applies_to_source
from jobhunter.discovery.title_filter import title_matches_query
from jobhunter.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobhunter.state import record_job_event

log = logging.getLogger(__name__)


# -- Employer registry from YAML --------------------------------------------


def load_employers() -> dict:
    """Load Workday employer registry from config/employers.yaml."""
    data = config.load_employers_config()
    if not data:
        log.warning("employers.yaml not found at %s", CONFIG_DIR / "employers.yaml")
        return {}
    return data.get("employers", {})


# -- Location filtering from search config -----------------------------------


def _load_location_filter(search_cfg: dict | None = None):
    """Load location accept/reject lists from search config."""
    if search_cfg is None:
        search_cfg = config.load_search_config()

    return configured_location_filters(search_cfg)


def _location_ok(location: str | None, accept: list[str], reject: list[str]) -> bool:
    """Check if a job location passes the user's location filter."""
    return location_matches_target(location, accept=accept, reject=reject)


# -- HTML stripper -----------------------------------------------------------


class _HTMLStripper(HTMLParser):
    """Strip HTML tags, keep text content."""

    def __init__(self):
        super().__init__()
        self._parts: list[str] = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip = True
        elif tag in ("br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"):
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = False
        elif tag in ("p", "div", "li", "tr"):
            self._parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self._parts.append(data)

    def get_text(self) -> str:
        text = "".join(self._parts)
        text = re.sub(r"[^\S\n]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def strip_html(html: str) -> str:
    """Convert HTML to plain text."""
    if not html:
        return ""
    stripper = _HTMLStripper()
    stripper.feed(html)
    return stripper.get_text()


# -- Proxy -------------------------------------------------------------------

_opener = None


def setup_proxy(proxy_str: str | None) -> None:
    """Configure a global urllib opener with proxy support."""
    global _opener
    if not proxy_str:
        _opener = urllib.request.build_opener()
        return

    parts = proxy_str.split(":")
    if len(parts) == 4:
        host, port, user, passwd = parts
        proxy_url = f"http://{user}:{passwd}@{host}:{port}"
    elif len(parts) == 2:
        proxy_url = f"http://{parts[0]}:{parts[1]}"
    else:
        log.warning("Proxy format not recognized: %s (expected host:port:user:pass or host:port)", proxy_str)
        _opener = urllib.request.build_opener()
        return

    proxy_handler = urllib.request.ProxyHandler(
        {
            "http": proxy_url,
            "https": proxy_url,
        }
    )
    _opener = urllib.request.build_opener(proxy_handler)
    log.info("Proxy configured: %s:%s", parts[0], parts[1])


def _urlopen(req, timeout=30):
    """Open a URL using the configured opener (with or without proxy)."""
    if _opener:
        return _opener.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


# -- Workday API -------------------------------------------------------------


def workday_search(employer: dict, search_text: str, limit: int = 20, offset: int = 0) -> dict:
    """Search jobs via Workday CXS API. Returns JSON with total + jobPostings."""
    url = f"{employer['base_url']}/wday/cxs/{employer['tenant']}/{employer['site_id']}/jobs"
    payload = json.dumps(
        {
            "appliedFacets": {},
            "limit": limit,
            "offset": offset,
            "searchText": search_text,
        }
    ).encode()

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

    with _urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def workday_detail(employer: dict, external_path: str) -> dict:
    """Fetch full job detail via Workday CXS API."""
    url = f"{employer['base_url']}/wday/cxs/{employer['tenant']}/{employer['site_id']}{external_path}"

    req = urllib.request.Request(url)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

    with _urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


# -- Search + paginate -------------------------------------------------------


def search_employer(
    employer_key: str,
    employer: dict,
    search_text: str,
    location_filter: bool = True,
    max_results: int = 0,
    max_pages: int = 25,
    accept_locs: list[str] | None = None,
    reject_locs: list[str] | None = None,
) -> list[dict]:
    """Search an employer, paginate through all results, optionally filter by location."""
    log.info('%s: searching "%s"...', employer["name"], search_text)

    all_jobs: list[dict] = []
    offset = 0
    page_size = 20
    max_pages = max(1, max_pages)  # Workday pages are 20 postings each.
    total = None

    while True:
        try:
            data = workday_search(employer, search_text, limit=page_size, offset=offset)
        except Exception as e:
            log.error("%s: API error at offset %d: %s", employer["name"], offset, e)
            break

        if total is None:
            total = data.get("total", 0)
            log.info("%s: %d total results", employer["name"], total)

        postings = data.get("jobPostings", [])
        if not postings:
            break

        for j in postings:
            title = j.get("title", "")
            if not title_matches_query(title, search_text):
                continue
            loc = j.get("locationsText", "")
            if location_filter and accept_locs is not None and reject_locs is not None:
                if not _location_ok(loc, accept_locs, reject_locs):
                    continue

            all_jobs.append(
                {
                    "title": title,
                    "location": loc,
                    "posted": j.get("postedOn", ""),
                    "external_path": j.get("externalPath", ""),
                    "employer_key": employer_key,
                    "employer_name": employer["name"],
                }
            )

        offset += page_size
        page_num = offset // page_size
        if offset >= total:
            break
        if page_num >= max_pages:
            log.info("%s: capped at %d pages (%d results scanned)", employer["name"], max_pages, offset)
            break
        if max_results and len(all_jobs) >= max_results:
            all_jobs = all_jobs[:max_results]
            break

    log.info("%s: %d jobs found%s", employer["name"], len(all_jobs), " (filtered)" if location_filter else "")
    return all_jobs


# -- Fetch details -----------------------------------------------------------


def _fetch_one_detail(employer: dict, job: dict) -> dict:
    """Fetch detail for a single job."""
    try:
        detail = workday_detail(employer, job["external_path"])
        info = detail.get("jobPostingInfo", {})

        raw_desc = info.get("jobDescription", "")
        job["full_description"] = strip_html(raw_desc)
        job["apply_url"] = info.get("externalUrl", "")
        job["job_req_id"] = info.get("jobReqId", "")
        job["time_type"] = info.get("timeType", "")
        job["remote_type"] = info.get("remoteType", "")

    except Exception as e:
        job["full_description"] = ""
        job["apply_url"] = ""
        job["detail_error"] = str(e)

    return job


def fetch_details(employer: dict, jobs: list[dict]) -> list[dict]:
    """Fetch full description + apply URL for each job sequentially."""
    log.info("%s: fetching details for %d jobs...", employer["name"], len(jobs))

    completed = 0
    errors = 0
    t0 = time.time()

    for job in jobs:
        _fetch_one_detail(employer, job)
        completed += 1
        if "detail_error" in job:
            errors += 1

        if completed % 20 == 0 or completed == len(jobs):
            elapsed = time.time() - t0
            rate = completed / elapsed if elapsed > 0 else 0
            log.info("%s: %d/%d (%d errors) [%.1f jobs/sec]", employer["name"], completed, len(jobs), errors, rate)

    elapsed = time.time() - t0
    log.info("%s: done in %.1fs (%.1f jobs/sec)", employer["name"], elapsed, len(jobs) / elapsed if elapsed > 0 else 0)
    return jobs


# -- DB storage --------------------------------------------------------------


class _DiscoveryEventPublisher:
    """Persist Workday discovery domain events for API projections."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def publish(self, event: DomainEvent) -> None:
        payload = {"tenantId": str(event.tenant_id), **event.payload}
        job_url = (
            payload.get("job_id")
            or payload.get("jobId")
            or payload.get("posting_url")
            or payload.get("postingUrl")
        )
        record_job_event(
            self._conn,
            str(job_url) if job_url else None,
            "discover",
            event.event_type,
            message=event.event_type,
            payload=payload,
            occurred_at=event.occurred_at,
        )
        self._conn.commit()


def _job_url(job: dict, employers: dict) -> str:
    url = str(job.get("apply_url") or "").strip()
    if url:
        return url
    emp = employers.get(job.get("employer_key", ""), {})
    if emp and job.get("external_path"):
        return f"{emp['base_url']}/{emp['site_id']}{job['external_path']}"
    return ""


def _source_id(job: dict, employers: dict) -> str:
    employer_key = str(job.get("employer_key") or "").strip()
    employer = employers.get(employer_key, {}) if employer_key else {}
    configured = str(employer.get("_source_id") or "").strip() if isinstance(employer, dict) else ""
    if configured:
        return configured
    slug = re.sub(r"[^a-z0-9]+", "-", employer_key.lower()).strip("-")
    return f"workday:{slug or 'unknown'}"


def _posting_from_job(job: dict, employers: dict) -> ScrapedJobPosting | None:
    url = _job_url(job, employers)
    if not url:
        return None
    description = str(job.get("full_description") or "")
    return ScrapedJobPosting(
        posting_url=PostingUrl(value=url),
        source=Source(board=str(job.get("employer_name") or "Workday")),
        metadata=JobMetadata(
            title=str(job.get("title") or ""),
            salary="",
            description=description[:500] if description else "",
            location=str(job.get("location") or ""),
        ),
        strategy=SearchStrategy.WORKDAY_API,
        source_id=_source_id(job, employers),
        source_native_id=str(job.get("job_req_id") or job.get("external_path") or url),
        canonical_url=url,
        ats_kind=AtsKind.WORKDAY,
    )


def _update_detail_columns(conn: sqlite3.Connection, job: dict, url: str, now: str) -> None:
    description = str(job.get("full_description") or "")
    full_description = description if len(description) > 200 else None
    conn.execute(
        """
        UPDATE jobs
        SET full_description = COALESCE(?, full_description),
            application_url = COALESCE(?, application_url),
            detail_scraped_at = COALESCE(?, detail_scraped_at),
            detail_error = COALESCE(?, detail_error)
        WHERE url = ?
        """,
        (
            full_description,
            url,
            now if full_description else None,
            job.get("detail_error"),
            url,
        ),
    )


def store_results(
    conn: sqlite3.Connection,
    jobs: list[dict],
    employers: dict,
    limit: int = 0,
    run_id: str | None = None,
) -> tuple[int, int]:
    """Store corporate jobs through the Discovery write boundary."""
    now = datetime.now(timezone.utc).isoformat()
    postings: list[ScrapedJobPosting] = []
    detail_updates: list[tuple[dict, str]] = []

    for job in jobs:
        if limit > 0 and len(postings) >= limit:
            break
        posting = _posting_from_job(job, employers)
        if posting is None:
            continue
        postings.append(posting)
        detail_updates.append((job, posting.posting_url.value))

    if not postings:
        return 0, 0

    summary = DiscoverJobsUseCase(
        repository=SqliteJobRepository(conn),
        publisher=_DiscoveryEventPublisher(conn),
    ).execute(
        tenant_id=LOCAL_TENANT,
        postings=postings,
        run_id=run_id,
    )

    for job, url in detail_updates:
        _update_detail_columns(conn, job, url, now)

    conn.commit()
    return summary.new_jobs, summary.observed


def _process_one(
    employer_key: str,
    employers: dict,
    search_text: str,
    location_filter: bool,
    accept_locs: list[str],
    reject_locs: list[str],
    limit: int = 0,
    max_pages_per_employer: int = 25,
    run_id: str | None = None,
) -> dict:
    """Search one employer, fetch details, store results."""
    result = _search_and_fetch_one(
        employer_key,
        employers,
        search_text,
        location_filter,
        accept_locs,
        reject_locs,
        limit=limit,
        max_pages_per_employer=max_pages_per_employer,
    )
    jobs = result.pop("jobs", [])
    if not jobs:
        return result

    conn = get_connection()
    new, existing = store_results(conn, jobs, employers, limit=limit, run_id=run_id)
    log.info("%s: %d new, %d already in DB", result["employer"], new, existing)

    return {**result, "new": new, "existing": existing}


def _search_and_fetch_one(
    employer_key: str,
    employers: dict,
    search_text: str,
    location_filter: bool,
    accept_locs: list[str],
    reject_locs: list[str],
    limit: int = 0,
    max_pages_per_employer: int = 25,
) -> dict:
    """Search one employer and fetch details without writing to storage."""
    emp = employers[employer_key]

    try:
        jobs = search_employer(
            employer_key,
            emp,
            search_text,
            location_filter=location_filter,
            max_results=limit,
            max_pages=max_pages_per_employer,
            accept_locs=accept_locs,
            reject_locs=reject_locs,
        )
    except Exception as e:
        log.error("%s: ERROR searching '%s': %s", emp["name"], search_text, e)
        return {"employer": emp["name"], "query": search_text, "found": 0, "new": 0, "existing": 0, "error": str(e)}

    if not jobs:
        return {"employer": emp["name"], "query": search_text, "found": 0, "new": 0, "existing": 0}

    try:
        jobs = fetch_details(emp, jobs)
    except Exception as e:
        log.error("%s: ERROR fetching details for '%s': %s", emp["name"], search_text, e)

    return {"employer": emp["name"], "query": search_text, "found": len(jobs), "new": 0, "existing": 0, "jobs": jobs}


# -- Main orchestrator -------------------------------------------------------


def scrape_employers(
    search_text: str,
    employers: dict,
    employer_keys: list[str] | None = None,
    location_filter: bool = True,
    max_results: int = 0,
    accept_locs: list[str] | None = None,
    reject_locs: list[str] | None = None,
    workers: int = 1,
    limit: int = 0,
    max_pages_per_employer: int = 25,
    run_id: str | None = None,
) -> dict:
    """Run full scrape: search -> filter -> detail -> store.

    Sequential by default. When workers > 1, processes employers in parallel
    using ThreadPoolExecutor.
    """
    if employer_keys is None:
        employer_keys = list(employers.keys())

    if accept_locs is None:
        accept_locs = []
    if reject_locs is None:
        reject_locs = []

    # Ensure DB schema
    init_db()

    total_new = 0
    total_existing = 0
    total_found = 0
    errors = 0
    t0 = time.time()

    valid_keys = [k for k in employer_keys if k in employers]

    if workers > 1 and len(valid_keys) > 1:
        # Parallel mode
        completed = 0
        with ThreadPoolExecutor(max_workers=min(workers, len(valid_keys))) as pool:
            if limit > 0:
                futures = {
                    pool.submit(
                        _search_and_fetch_one,
                        key,
                        employers,
                        search_text,
                        location_filter,
                        accept_locs,
                        reject_locs,
                        limit,
                        max_pages_per_employer,
                    ): key
                    for key in valid_keys
                }
            else:
                futures = {
                    pool.submit(
                        _process_one,
                        key,
                        employers,
                        search_text,
                        location_filter,
                        accept_locs,
                        reject_locs,
                        0,
                        max_pages_per_employer,
                        run_id,
                    ): key
                    for key in valid_keys
                }
            for future in as_completed(futures):
                result = future.result()
                completed += 1
                jobs = result.pop("jobs", [])
                if jobs:
                    remaining = max(limit - total_found, 0) if limit > 0 else 0
                    if limit <= 0 or remaining > 0:
                        jobs_to_store = jobs[:remaining] if limit > 0 else jobs
                        conn = get_connection()
                        new, existing = store_results(
                            conn,
                            jobs_to_store,
                            employers,
                            limit=remaining if limit > 0 else 0,
                            run_id=run_id,
                        )
                        result = {**result, "found": len(jobs_to_store), "new": new, "existing": existing}
                total_new += result["new"]
                total_existing += result["existing"]
                total_found += result["found"]
                if "error" in result:
                    errors += 1

                if completed % 10 == 0 or completed == len(valid_keys):
                    elapsed = time.time() - t0
                    log.info(
                        "[%s] Progress: %d/%d employers (%d new, %d dupes, %d errors) [%.0fs]",
                        search_text,
                        completed,
                        len(valid_keys),
                        total_new,
                        total_existing,
                        errors,
                        elapsed,
                    )
                if limit > 0 and total_found >= limit:
                    for pending in futures:
                        pending.cancel()
                    break
    else:
        # Sequential mode (default)
        completed = 0
        for key in valid_keys:
            remaining = max(limit - total_found, 0) if limit > 0 else 0
            if limit > 0 and remaining <= 0:
                break
            result = _process_one(
                key,
                employers,
                search_text,
                location_filter,
                accept_locs,
                reject_locs,
                remaining if limit > 0 else 0,
                max_pages_per_employer,
                run_id,
            )
            completed += 1
            total_new += result["new"]
            total_existing += result["existing"]
            total_found += result["found"]
            if "error" in result:
                errors += 1

            if completed % 10 == 0 or completed == len(valid_keys):
                elapsed = time.time() - t0
                log.info(
                    "[%s] Progress: %d/%d employers (%d new, %d dupes, %d errors) [%.0fs]",
                    search_text,
                    completed,
                    len(valid_keys),
                    total_new,
                    total_existing,
                    errors,
                    elapsed,
                )

    elapsed = time.time() - t0
    log.info(
        "[%s] Done: %d found, %d new, %d dupes in %.0fs", search_text, total_found, total_new, total_existing, elapsed
    )

    return {"found": total_found, "new": total_new, "existing": total_existing}


# -- Public entry point ------------------------------------------------------


def run_workday_discovery(
    employers: dict | None = None,
    workers: int = 1,
    limit: int = 0,
    run_id: str | None = None,
) -> dict:
    """Main entry point for Workday-based corporate job discovery.

    Loads employer registry from config/employers.yaml (or uses the provided
    dict), then loads search queries from the user's search config to run
    a full crawl across all employers.

    Args:
        employers: Override the employer registry. If None, loads from YAML.
        workers: Number of parallel threads for employer scraping. Default 1 (sequential).

    Returns:
        Dict with stats: found, new, existing, queries.
    """
    if employers is None:
        employers = load_employers()

    if not employers:
        log.warning("No employers configured. Create config/employers.yaml.")
        return {"found": 0, "new": 0, "existing": 0, "queries": 0}

    search_cfg = config.load_search_config()
    queries_cfg = search_cfg.get("queries", [])
    accept_locs, reject_locs = _load_location_filter(search_cfg)

    # Default to tier 1-2 queries for workday scraping
    max_tier = search_cfg.get("workday_max_tier", 2)
    queries = [
        q["query"]
        for q in queries_cfg
        if q.get("tier", 99) <= max_tier and query_applies_to_source(q, "workday")
    ]

    if not queries:
        # Fallback: use all queries
        queries = [q["query"] for q in queries_cfg if query_applies_to_source(q, "workday")]

    if not queries:
        log.warning("No search queries configured in searches.yaml.")
        return {"found": 0, "new": 0, "existing": 0, "queries": 0}

    proxy = search_cfg.get("proxy")
    if proxy:
        setup_proxy(proxy)

    location_filter = search_cfg.get("workday_location_filter", True)
    max_pages_per_employer = _workday_max_pages_per_employer(search_cfg, limit=limit)

    log.info("Workday crawl: %d queries x %d employers (workers=%d)", len(queries), len(employers), workers)

    grand_new = 0
    grand_existing = 0
    grand_found = 0

    for i, query in enumerate(queries, 1):
        remaining = max(limit - grand_found, 0) if limit > 0 else 0
        if limit > 0 and remaining <= 0:
            break
        log.info('Query %d/%d: "%s"', i, len(queries), query)
        result = scrape_employers(
            search_text=query,
            employers=employers,
            location_filter=location_filter,
            accept_locs=accept_locs,
            reject_locs=reject_locs,
            workers=workers,
            limit=remaining if limit > 0 else 0,
            max_pages_per_employer=max_pages_per_employer,
            run_id=run_id,
        )
        grand_new += result["new"]
        grand_existing += result["existing"]
        grand_found += result["found"]

    log.info(
        "Workday crawl done: %d found, %d new, %d existing across %d queries x %d employers",
        grand_found,
        grand_new,
        grand_existing,
        len(queries),
        len(employers),
    )

    return {
        "found": grand_found,
        "new": grand_new,
        "existing": grand_existing,
        "queries": len(queries),
    }


def _workday_max_pages_per_employer(search_cfg: dict, *, limit: int) -> int:
    configured = _positive_int(search_cfg.get("workday_max_pages_per_employer"), 25)
    if limit <= 0:
        return configured
    limited = _positive_int(search_cfg.get("workday_limited_max_pages_per_employer"), 1)
    return min(configured, limited)


def _positive_int(value: object, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default
