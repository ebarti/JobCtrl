"""JobSpy-based job discovery: searches Indeed, LinkedIn, Glassdoor, ZipRecruiter.

Uses python-jobspy to scrape multiple job boards, deduplicates results,
parses salary ranges, and stores accepted postings in the JobHunter database.

Search queries, locations, and filtering rules are loaded from database-backed
discovery settings plus the profile target-search fields.
"""

import logging
import re
import sqlite3
import time
import hashlib
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from jobhunter import config
from jobhunter.database import ensure_source_observation_tables, get_connection, init_db, resurface_deleted_job
from jobhunter.domain.discovery import JobMetadata, PostingUrl, SearchStrategy, Source
from jobhunter.domain.discovery.identity import normalize_observed_url
from jobhunter.domain.discovery.source_registry import BROAD_BOARD_LEAD_POLICY
from jobhunter.domain.ports.discovery import ScrapedJobPosting
from jobhunter.domain.ports.politeness import PolitenessDecision, PolitenessOutcome
from jobhunter.domain.job_content_identity import (
    content_match_basis,
    is_genuine_employer_identity,
    job_content_fingerprint,
    normalize_identity_text,
)

# Phase 7 (S-27 round-1 review M1): ``parse_proxy`` lives under
# ``jobhunter.infrastructure.network`` so the Enrichment context's
# Playwright fetcher can import it without depending on this Discovery
# module. Imported here for the local call sites in ``_run_one_search``
# / ``_full_crawl``.
from jobhunter.infrastructure.discovery.location_filter import (
    configured_location_filters,
    configured_local_location_accepts,
    location_matches_target,
    normalize_location_display,
)
from jobhunter.infrastructure.discovery.production_wiring import (
    DurableJobEventPublisher,
    _posting_acceptance_policy,
)
from jobhunter.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobhunter.discovery.title_filter import title_matches_query
from jobhunter.domain.discovery.use_cases import DiscoverJobsUseCase
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.network import (
    HostRateLimiter,
    PolitenessGateway,
    PolitenessSourceContext,
    RunBudgetCounter,
    get_shared_rate_limiter,
    record_politeness_outcome,
)
from jobhunter.infrastructure.network.proxy import parse_proxy

log = logging.getLogger(__name__)
_SOURCE_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Broad boards (indeed/linkedin/zip/glassdoor) are fetched by the python-jobspy
# library, which owns its own tls-client/requests transport. Per owner decision
# D3 we therefore CANNOT robots-gate or honest-UA-stamp jobspy's internal
# per-board requests. Instead we enforce politeness at OUR invocation boundary:
# a per-run request budget + inter-search pacing via the shared host limiter,
# recording a budget-exhausted outcome when the budget stops a crawl. The
# residual (jobspy's internal requests are unpoliced) is a documented risk.
_JOBSPY_HOST_KEY = "jobspy"


class DiscoveryCancelled(RuntimeError):
    """Raised when a cooperative discovery cancel request stops JobSpy."""


# -- Retry wrapper -----------------------------------------------------------


def _scrape_with_retry(kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
    """Call scrape_jobs with retry on transient failures."""
    try:
        from jobspy import scrape_jobs
    except ImportError as exc:
        raise ImportError(
            "python-jobspy is not installed. Run: "
            "pip install --no-deps python-jobspy && "
            "pip install pydantic tls-client requests markdownify regex"
        ) from exc

    _patch_jobspy_linkedin_location_parser()

    for attempt in range(max_retries + 1):
        try:
            return scrape_jobs(**kwargs)
        except Exception as e:
            err = str(e).lower()
            transient = any(k in err for k in ("timeout", "429", "proxy", "connection", "reset", "refused"))
            if transient and attempt < max_retries:
                wait = backoff * (attempt + 1)
                log.warning("Retry %d/%d in %.0fs: %s", attempt + 1, max_retries, wait, e)
                time.sleep(wait)
            else:
                raise


def _patch_jobspy_linkedin_location_parser() -> None:
    """Keep unsupported LinkedIn country names from aborting the whole scrape."""
    try:
        from jobspy.linkedin import LinkedIn
        from jobspy.model import Country, Location
    except ImportError:
        return

    if getattr(LinkedIn, "_jobhunter_tolerates_unknown_countries", False):
        return

    def _country_or_text(country: str):
        try:
            return Country.from_string(country)
        except ValueError:
            return country

    def _get_location(self, metadata_card):
        location = Location(country=_country_or_text(getattr(self, "country", "worldwide")))
        if metadata_card is None:
            return location

        location_tag = metadata_card.find("span", class_="job-search-card__location")
        location_string = location_tag.text.strip() if location_tag else "N/A"
        parts = location_string.split(", ")
        if len(parts) == 2:
            city, state = parts
            return Location(
                city=city,
                state=state,
                country=_country_or_text(getattr(self, "country", "worldwide")),
            )
        if len(parts) == 3:
            city, state, country = parts
            return Location(city=city, state=state, country=_country_or_text(country))
        return location

    LinkedIn._get_location = _get_location
    LinkedIn._jobhunter_tolerates_unknown_countries = True


# -- Location filtering ------------------------------------------------------


def _load_location_config(search_cfg: dict) -> tuple[list[str], list[str], list[str]]:
    """Extract accept/reject location lists from search config.

    Falls back to sensible defaults if not defined in the YAML.
    """
    accept, reject = configured_location_filters(search_cfg)
    return accept, reject, configured_local_location_accepts(search_cfg)


def _location_ok(
    location: str | None,
    accept: list[str],
    reject: list[str],
    *,
    search_location: str | None = None,
    remote_required: bool = False,
    is_remote: bool | None = None,
    local_accept: list[str] | None = None,
) -> bool:
    """Check if a job location passes the user's location filter.

    Remote jobs are accepted only after explicit reject geography is checked.
    Non-remote jobs must match an accept pattern and not match a reject pattern.
    """
    return location_matches_target(
        location,
        accept=accept,
        reject=reject,
        search_location=search_location,
        remote_required=remote_required,
        is_remote=is_remote,
        local_accept=local_accept or (),
    )


# -- DB storage (JobSpy DataFrame -> SQLite) ---------------------------------


def store_jobspy_results(
    conn: sqlite3.Connection,
    df,
    source_label: str,
    limit: int = 0,
    run_id: str = "jobspy",
    search_cfg: dict | None = None,
) -> tuple[int, int]:
    """Store JobSpy DataFrame results into the DB. Returns (new, existing)."""
    now = datetime.now(timezone.utc).isoformat()
    new = 0
    existing = 0
    active_search_cfg = search_cfg if search_cfg is not None else _fallback_store_search_cfg(df, source_label)
    acceptance_policy = _posting_acceptance_policy(active_search_cfg)
    repository = SqliteJobRepository(conn)
    use_case = DiscoverJobsUseCase(
        repository=repository,
        publisher=DurableJobEventPublisher(conn, stage="discover"),
        acceptance_policy=acceptance_policy,
    )

    for _, row in df.iterrows():
        if limit > 0 and new >= limit:
            break
        url = str(row.get("job_url", ""))
        if not url or url == "nan":
            continue

        title = str(row.get("title", "")) if str(row.get("title", "")) != "nan" else None
        company = _nullable_str(row.get("company"))
        location_str = str(row.get("location", "")) if str(row.get("location", "")) != "nan" else None

        # Build salary string from min/max
        salary = None
        min_amt = row.get("min_amount")
        max_amt = row.get("max_amount")
        interval = str(row.get("interval", "")) if str(row.get("interval", "")) != "nan" else ""
        currency = str(row.get("currency", "")) if str(row.get("currency", "")) != "nan" else ""
        if min_amt and str(min_amt) != "nan":
            if max_amt and str(max_amt) != "nan":
                salary = f"{currency}{int(float(min_amt)):,}-{currency}{int(float(max_amt)):,}"
            else:
                salary = f"{currency}{int(float(min_amt)):,}"
            if interval:
                salary += f"/{interval}"

        description = _nullable_str(row.get("description"))
        if not (description or "").strip():
            continue
        site_name = str(row.get("site", source_label))
        is_remote = _truthy_remote(row.get("is_remote", False))
        location_str = normalize_location_display(location_str, is_remote=is_remote)

        site_label = f"{site_name}"

        strategy = "jobspy"

        # If JobSpy gave us a full description, promote it directly
        full_description = None
        detail_scraped_at = None
        if description and len(description) > 200:
            full_description = description
            detail_scraped_at = now

        # Extract apply URL if JobSpy provided it. JobSpy's board URL remains
        # the discovery observation; this direct URL can identify who owns the
        # posting for future direct discovery.
        apply_url = _nullable_str(row.get("job_url_direct"))
        source_id = _jobspy_source_id(site_label)
        posting = _jobspy_posting_from_row(
            url=url,
            source_id=source_id,
            source_native_id=_jobspy_source_native_id(row, url),
            site_label=site_label,
            title=title,
            salary=salary,
            description=description,
            location=location_str,
        )
        acceptance = acceptance_policy(posting)
        if not acceptance.accepted:
            continue

        duplicate_url = _find_existing_content_duplicate(
            conn,
            url=url,
            title=title,
            company=company,
            description=full_description or description,
        )
        if duplicate_url:
            _record_content_duplicate_link(
                conn,
                surviving_url=duplicate_url,
                duplicate_url=url,
                source=source_id,
                observed_at=now,
            )
            _record_jobspy_source_observation(
                conn,
                job_url=duplicate_url,
                observed_url=url,
                source_id=source_id,
                run_id=run_id,
                observed_at=now,
            )
            _learn_posting_source(
                conn,
                job_url=duplicate_url,
                posting_url=apply_url,
                discovered_via_source_id=source_id,
                observed_at=now,
            )
            _refresh_existing_jobspy_job(
                conn,
                job_url=duplicate_url,
                title=title,
                company=company,
                salary=salary,
                description=description,
                location=location_str,
                site=site_label,
                strategy=strategy,
                full_description=full_description,
                application_url=apply_url,
                detail_scraped_at=detail_scraped_at,
                updated_at=now,
            )
            _upsert_posted_compensation_fact(conn, job_url=duplicate_url, parsed_at=now)
            resurface_deleted_job(conn, duplicate_url, resurfaced_at=now)
            existing += 1
            continue

        stored_duplicate_url = _find_stored_content_duplicate_survivor(conn, url=url)
        if stored_duplicate_url and stored_duplicate_url != url:
            _record_content_duplicate_link(
                conn,
                surviving_url=stored_duplicate_url,
                duplicate_url=url,
                source=source_id,
                observed_at=now,
            )
            _record_jobspy_source_observation(
                conn,
                job_url=stored_duplicate_url,
                observed_url=url,
                source_id=source_id,
                run_id=run_id,
                observed_at=now,
            )
            _learn_posting_source(
                conn,
                job_url=stored_duplicate_url,
                posting_url=apply_url,
                discovered_via_source_id=source_id,
                observed_at=now,
            )
            _refresh_existing_jobspy_job(
                conn,
                job_url=stored_duplicate_url,
                title=title,
                company=company,
                salary=salary,
                description=description,
                location=location_str,
                site=site_label,
                strategy=strategy,
                full_description=full_description,
                application_url=apply_url,
                detail_scraped_at=detail_scraped_at,
                updated_at=now,
            )
            _upsert_posted_compensation_fact(conn, job_url=stored_duplicate_url, parsed_at=now)
            resurface_deleted_job(conn, stored_duplicate_url, resurfaced_at=now)
            existing += 1
            continue

        summary = use_case.execute(
            tenant_id=LOCAL_TENANT,
            postings=(posting,),
            run_id=run_id,
        )
        if summary.new_jobs > 0 or summary.observed > 0 or summary.duplicates_linked > 0:
            _refresh_existing_jobspy_job(
                conn,
                job_url=url,
                title=title,
                company=company,
                salary=salary,
                description=description,
                location=location_str,
                site=site_label,
                strategy=strategy,
                full_description=full_description,
                application_url=apply_url,
                detail_scraped_at=detail_scraped_at,
                updated_at=now,
            )
            _upsert_posted_compensation_fact(conn, job_url=url, parsed_at=now)
            _learn_posting_source(
                conn,
                job_url=url,
                posting_url=apply_url,
                discovered_via_source_id=source_id,
                observed_at=now,
            )
        if summary.new_jobs > 0:
            new += 1
        elif summary.observed > 0 or summary.duplicates_linked > 0:
            resurface_deleted_job(conn, url, resurfaced_at=now)
            existing += 1

    conn.commit()
    return new, existing


def _jobspy_posting_from_row(
    *,
    url: str,
    source_id: str,
    source_native_id: str,
    site_label: str,
    title: str | None,
    salary: str | None,
    description: str | None,
    location: str | None,
) -> ScrapedJobPosting:
    return ScrapedJobPosting(
        posting_url=PostingUrl(value=url),
        source=Source(board=site_label),
        metadata=JobMetadata(
            title=title or "",
            salary=salary or "",
            description=description or "",
            location=location or "",
        ),
        strategy=SearchStrategy.JOBSPY,
        source_id=source_id,
        source_native_id=source_native_id,
        canonical_url=url,
        )


def _upsert_posted_compensation_fact(conn: sqlite3.Connection, *, job_url: str, parsed_at: str) -> None:
    from jobhunter.infrastructure.compensation import SqlitePostedCompensationRepository

    row = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()
    if row is None:
        return
    salary = row["salary"] if isinstance(row, sqlite3.Row) else row[0]
    SqlitePostedCompensationRepository(conn).parse_and_save_job_salary(job_url, salary, parsed_at=parsed_at)


def _jobspy_source_native_id(row, url: str) -> str:
    for key in ("id", "job_id", "job_url"):
        value = _nullable_str(row.get(key))
        if value:
            return value
    return normalize_observed_url(url) or url


def _fallback_store_search_cfg(df, source_label: str) -> dict:
    """Build a scoped policy for legacy direct storage callers."""
    locations: list[str] = []
    accepts: list[str] = []
    try:
        iterable = df.iterrows()
    except AttributeError:
        iterable = ()
    for _, row in iterable:
        location = normalize_location_display(
            _nullable_str(row.get("location")),
            is_remote=_truthy_remote(row.get("is_remote", False)),
        )
        if location:
            locations.append(location)
            accepts.append(location)
    if not locations:
        locations = ["Remote"]
        accepts = ["Remote"]
    return {
        "queries": [],
        "locations": [{"location": location} for location in dict.fromkeys(locations)],
        "location_accept": list(dict.fromkeys(accepts)),
        "location": {"accept_patterns": list(dict.fromkeys(accepts)), "reject_patterns": []},
    }


def _refresh_existing_jobspy_job(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    title: str | None,
    company: str | None,
    salary: str | None,
    description: str | None,
    location: str | None,
    site: str,
    strategy: str,
    full_description: str | None,
    application_url: str | None,
    detail_scraped_at: str | None,
    updated_at: str,
) -> None:
    cursor = conn.execute(
        """
        UPDATE jobs SET
            title = COALESCE(NULLIF(?, ''), title),
            company = CASE
                WHEN COALESCE(company, '') = '' THEN COALESCE(NULLIF(?, ''), company)
                ELSE company
            END,
            salary = COALESCE(NULLIF(?, ''), salary),
            description = COALESCE(NULLIF(?, ''), description),
            location = COALESCE(NULLIF(?, ''), location),
            site = COALESCE(NULLIF(?, ''), site),
            strategy = COALESCE(NULLIF(?, ''), strategy),
            full_description = COALESCE(NULLIF(?, ''), full_description),
            application_url = COALESCE(NULLIF(?, ''), application_url),
            detail_scraped_at = COALESCE(?, detail_scraped_at)
        WHERE url = ?
        """,
        (
            title,
            company,
            salary,
            description,
            location,
            site,
            strategy,
            full_description,
            application_url,
            detail_scraped_at,
            job_url,
        ),
    )
    if cursor.rowcount:
        from jobhunter.state import record_job_event

        record_job_event(
            conn,
            job_url,
            "discover",
            "JobMetadataUpdated",
            message="Job metadata refreshed from JobSpy",
            payload={
                "company": company,
                "description": bool((description or "").strip()),
                "location": location,
                "source": site,
            },
            occurred_at=updated_at,
        )


def _nullable_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.casefold() in {"nan", "none", "nat", "<na>"}:
        return None
    return text


def _jobspy_source_id(source_label: str) -> str:
    slug = _SOURCE_SLUG_RE.sub("-", source_label.strip().lower()).strip("-")
    return f"jobspy:{slug or 'source'}"


def _record_jobspy_source_observation(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    observed_url: str,
    source_id: str,
    run_id: str,
    observed_at: str,
) -> None:
    ensure_source_observation_tables(conn)
    normalized = normalize_observed_url(observed_url)
    source_native_id = normalized or observed_url
    observation_id = "jobspy:" + hashlib.sha256(
        f"{source_id}:{source_native_id}".encode("utf-8")
    ).hexdigest()[:24]
    updated = conn.execute(
        """
        UPDATE job_source_observations SET
            source_observation_id = ?,
            job_url = ?,
            observed_url = ?,
            normalized_observed_url = ?,
            run_id = ?,
            observed_at = ?
        WHERE tenant_id = 'local' AND source_id = ? AND source_native_id = ?
        """,
        (observation_id, job_url, observed_url, normalized, run_id, observed_at, source_id, source_native_id),
    )
    if updated.rowcount == 0:
        updated = conn.execute(
            """
            UPDATE job_source_observations SET
                source_observation_id = ?,
                job_url = ?,
                source_id = ?,
                source_native_id = ?,
                observed_url = ?,
                run_id = ?,
                observed_at = ?
            WHERE tenant_id = 'local' AND normalized_observed_url = ?
            """,
            (observation_id, job_url, source_id, source_native_id, observed_url, run_id, observed_at, normalized),
        )
    if updated.rowcount == 0:
        conn.execute(
            """
            INSERT INTO job_source_observations (
                tenant_id, source_observation_id, job_url, source_id,
                source_native_id, observed_url, normalized_observed_url,
                run_id, observed_at
            ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (observation_id, job_url, source_id, source_native_id, observed_url, normalized, run_id, observed_at),
        )
    from jobhunter.state import record_job_event

    record_job_event(
        conn,
        job_url,
        "discover",
        "JobSourceObserved",
        message="Job source observed.",
        payload={
            "tenantId": "local",
            "job_id": job_url,
            "jobId": job_url,
            "source_observation_id": observation_id,
            "sourceObservationId": observation_id,
            "source_id": source_id,
            "sourceId": source_id,
            "source_native_id": source_native_id,
            "sourceNativeId": source_native_id,
            "observed_url": observed_url,
            "observedUrl": observed_url,
            "run_id": run_id,
            "runId": run_id,
            "observed_at": observed_at,
            "observedAt": observed_at,
        },
        occurred_at=observed_at,
    )


def _learn_posting_source(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    posting_url: str | None,
    discovered_via_source_id: str,
    observed_at: str,
) -> None:
    if not posting_url:
        return
    from jobhunter.infrastructure.discovery.production_wiring import (
        learn_posting_source_from_url,
    )

    learn_posting_source_from_url(
        conn,
        job_url=job_url,
        posting_url=posting_url,
        discovered_via_source_id=discovered_via_source_id,
        observed_at=observed_at,
    )


def _find_existing_content_duplicate(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str | None,
    company: str | None,
    description: str | None,
) -> str | None:
    return _find_content_duplicate_survivor(
        conn,
        url=url,
        title=title,
        company=company,
        description=description,
        include_self=False,
    )


def _find_stored_content_duplicate_survivor(conn: sqlite3.Connection, *, url: str) -> str | None:
    row = conn.execute(
        """
        SELECT j.title, j.company, j.site,
               COALESCE(je.full_description, j.full_description, j.description) AS description
        FROM jobs j
        LEFT JOIN job_enrichments je ON je.job_url = j.url
        WHERE j.url = ?
        """,
        (url,),
    ).fetchone()
    if row is None:
        return None
    stored_company = row["company"]
    return _find_content_duplicate_survivor(
        conn,
        url=url,
        title=row["title"],
        company=stored_company if stored_company else row["site"],
        description=row["description"],
        include_self=True,
    )


def _find_content_duplicate_survivor(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str | None,
    company: str | None,
    description: str | None,
    include_self: bool,
) -> str | None:
    if not is_genuine_employer_identity(company):
        return None
    incoming_key = job_content_fingerprint(
        title=title,
        company=company,
        description=description,
    )
    if incoming_key is None:
        return None
    _ensure_deleted_jobs_table(conn)
    conn.create_function("jh_normalize_identity", 1, normalize_identity_text, deterministic=True)
    self_filter = "" if include_self else "AND j.url != ?"
    params: tuple[object, ...] = (
        normalize_identity_text(title),
        normalize_identity_text(company),
    )
    if not include_self:
        params = (url, *params)
    rows = conn.execute(
        f"""
        SELECT j.url, j.title, j.company, j.site,
               j.description AS listing_description,
               COALESCE(je.full_description, j.full_description) AS enriched_description,
               CASE WHEN d.job_url IS NULL THEN 0 ELSE 1 END AS is_deleted
        FROM jobs j
        LEFT JOIN job_enrichments je ON je.job_url = j.url
        LEFT JOIN jobhunter_deleted_jobs d
          ON d.job_url = j.url
         AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
        WHERE 1 = 1
          {self_filter}
          AND jh_normalize_identity(COALESCE(j.title, '')) = ?
          AND jh_normalize_identity(COALESCE(NULLIF(j.company, ''), j.site, '')) = ?
        ORDER BY is_deleted ASC, j.discovered_at ASC NULLS LAST, j.url ASC
        """,
        params,
    ).fetchall()
    for existing in rows:
        stored_company = existing["company"]
        stored_employer = stored_company if stored_company else existing["site"]
        if not is_genuine_employer_identity(stored_employer):
            continue
        if content_match_basis(
            incoming_key=incoming_key,
            incoming_description=description,
            candidate_title=existing["title"],
            candidate_employer=stored_employer,
            candidate_descriptions=(
                existing["listing_description"],
                existing["enriched_description"],
            ),
        ) is not None:
            return str(existing["url"])
    return None


def _ensure_deleted_jobs_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
            job_url TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL,
            reason TEXT,
            restored_at TEXT,
            FOREIGN KEY(job_url) REFERENCES jobs(url)
        )
        """
    )


def _record_content_duplicate_link(
    conn: sqlite3.Connection,
    *,
    surviving_url: str,
    duplicate_url: str,
    source: str,
    observed_at: str,
) -> None:
    link_key = job_content_fingerprint(
        title=surviving_url,
        company=source,
        description=duplicate_url,
    )
    if link_key is None:
        return
    duplicate_link_id = "content:" + link_key[:32]
    normalized_url = normalize_observed_url(duplicate_url)
    conn.execute(
        """
        INSERT OR IGNORE INTO job_duplicate_links (
            tenant_id, duplicate_link_id, surviving_job_id,
            superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES ('local', ?, ?, ?, 'content_fingerprint_match', 0.95, ?)
        """,
        (duplicate_link_id, surviving_url, duplicate_url, observed_at),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO job_source_observations (
            tenant_id, source_observation_id, job_url, source_id,
            source_native_id, observed_url, normalized_observed_url,
            run_id, observed_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, 'jobspy', ?)
        """,
        (
            f"content-duplicate:{duplicate_link_id}",
            surviving_url,
            source,
            duplicate_url,
            duplicate_url,
            normalized_url,
            observed_at,
        ),
    )


def _truthy_remote(value: object) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().casefold()
    return text in {"1", "true", "yes", "remote"}


def _title_ok(
    title: str | None,
    query: str | None,
    *,
    match_mode: str = "strict",
    target_track: str | None = None,
    seniority_floor: str | None = None,
) -> bool:
    return title_matches_query(
        title,
        query,
        match_mode=match_mode,
        target_track=target_track,
        seniority_floor=seniority_floor,
    )


# -- Single search execution -------------------------------------------------


def _run_one_search(
    search: dict,
    sites: list[str],
    results_per_site: int,
    hours_old: int,
    proxy_config: dict | None,
    defaults: dict,
    max_retries: int,
    accept_locs: list[str],
    reject_locs: list[str],
    local_accept_locs: list[str],
    glassdoor_map: dict,
    limit: int = 0,
    run_id: str = "jobspy",
    search_cfg: dict | None = None,
) -> dict:
    """Run a single search query and store results in DB."""
    s = search
    label = f'"{s["query"]}" in {s["location"]} {"(remote)" if s.get("remote") else ""}'
    if "tier" in s:
        label += f" [tier {s['tier']}]"

    # Split sites: Glassdoor needs simplified location, others use original
    gd_location = glassdoor_map.get(s["location"], s["location"].split(",")[0])
    has_glassdoor = "glassdoor" in sites
    other_sites = [si for si in sites if si != "glassdoor"]

    all_dfs = []

    # Run non-Glassdoor sites with original location
    if other_sites:
        kwargs = {
            "site_name": other_sites,
            "search_term": s["query"],
            "location": s["location"],
            "results_wanted": results_per_site,
            "hours_old": hours_old,
            "description_format": "markdown",
            "country_indeed": defaults.get("country_indeed", "usa"),
            "verbose": 0,
        }
        if s.get("remote"):
            kwargs["is_remote"] = True
        if proxy_config:
            kwargs["proxies"] = [proxy_config.jobspy]
        if "linkedin" in other_sites:
            kwargs["linkedin_fetch_description"] = True
        try:
            df = _scrape_with_retry(kwargs, max_retries=max_retries)
            all_dfs.append(df)
        except ImportError:
            raise
        except Exception as e:
            log.error("[%s] (non-gd): %s", label, e)

    # Run Glassdoor separately with simplified location
    if has_glassdoor:
        gd_kwargs = {
            "site_name": ["glassdoor"],
            "search_term": s["query"],
            "location": gd_location,
            "results_wanted": results_per_site,
            "hours_old": hours_old,
            "description_format": "markdown",
            "verbose": 0,
        }
        if s.get("remote"):
            gd_kwargs["is_remote"] = True
        if proxy_config:
            gd_kwargs["proxies"] = [proxy_config.jobspy]
        try:
            gd_df = _scrape_with_retry(gd_kwargs, max_retries=max_retries)
            all_dfs.append(gd_df)
        except ImportError:
            raise
        except Exception as e:
            log.error("[%s] (glassdoor): %s", label, e)

    if not all_dfs:
        log.error("[%s]: all sites failed", label)
        return {"new": 0, "existing": 0, "errors": 1, "filtered": 0, "total": 0, "label": label}

    import pandas as pd
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        df = pd.concat(all_dfs, ignore_index=True) if len(all_dfs) > 1 else all_dfs[0]

    if len(df) == 0:
        log.info("[%s] 0 results", label)
        return {"new": 0, "existing": 0, "errors": 0, "filtered": 0, "total": 0, "label": label}

    # Filter by role title and location before storing.
    before = len(df)
    df = df[
        df.apply(
            lambda row: _location_ok(
                str(row.get("location", "")) if str(row.get("location", "")) != "nan" else None,
                accept_locs,
                reject_locs,
                search_location=s.get("location"),
                remote_required=bool(s.get("remote")),
                is_remote=_truthy_remote(row.get("is_remote", False)),
                local_accept=local_accept_locs,
            ),
            axis=1,
        )
    ]
    location_filtered = before - len(df)
    after_location = len(df)
    df = df[
        df.apply(
            lambda row: _title_ok(
                str(row.get("title", "")) if str(row.get("title", "")) != "nan" else None,
                s["query"],
                match_mode=str(s.get("match_mode") or "strict"),
                target_track=str(s.get("target_track") or "") or None,
                seniority_floor=str(s.get("seniority_floor") or "") or None,
            ),
            axis=1,
        )
    ]
    title_filtered = after_location - len(df)
    filtered = location_filtered + title_filtered

    conn = get_connection()
    store_kwargs: dict[str, object] = {"limit": limit, "run_id": run_id}
    if search_cfg is not None:
        store_kwargs["search_cfg"] = search_cfg
    new, existing = store_jobspy_results(conn, df, s["query"], **store_kwargs)

    msg = f"[{label}] {before} results -> {new} new, {existing} dupes"
    if location_filtered:
        msg += f", {location_filtered} filtered (location)"
    if title_filtered:
        msg += f", {title_filtered} filtered (title)"
    log.info(msg)

    return {"new": new, "existing": existing, "errors": 0, "filtered": filtered, "total": before, "label": label}


# -- Single query search -----------------------------------------------------


def search_jobs(
    query: str,
    location: str,
    sites: list[str] | None = None,
    remote_only: bool = False,
    results_per_site: int = 50,
    hours_old: int = 72,
    proxy: str | None = None,
    country_indeed: str = "usa",
) -> dict:
    """Run a single job search via JobSpy and store results in DB."""
    if sites is None:
        sites = ["indeed", "linkedin", "zip_recruiter"]

    proxy_config = parse_proxy(proxy) if proxy else None

    log.info('Search: "%s" in %s | sites=%s | remote=%s', query, location, sites, remote_only)

    kwargs = {
        "site_name": sites,
        "search_term": query,
        "location": location,
        "results_wanted": results_per_site,
        "hours_old": hours_old,
        "description_format": "markdown",
        "country_indeed": country_indeed,
        "verbose": 2,
    }

    if remote_only:
        kwargs["is_remote"] = True

    if proxy_config:
        kwargs["proxies"] = [proxy_config.jobspy]

    if "linkedin" in sites:
        kwargs["linkedin_fetch_description"] = True

    # Pace this single manual search via the shared limiter (R10, D3). jobspy's
    # internal per-board transport remains unpoliced (documented residual).
    try:
        with get_shared_rate_limiter().slot(
            _JOBSPY_HOST_KEY,
            min_interval_seconds=BROAD_BOARD_LEAD_POLICY.min_request_interval_seconds,
            max_concurrency=BROAD_BOARD_LEAD_POLICY.max_concurrent_requests_per_host,
        ):
            df = _scrape_with_retry(kwargs)
    except Exception as e:
        log.error("JobSpy search failed: %s", e)
        return {"error": str(e), "total": 0, "new": 0, "existing": 0}

    total = len(df)
    log.info("JobSpy returned %d results", total)

    if total == 0:
        return {"total": 0, "new": 0, "existing": 0}

    if "site" in df.columns:
        site_counts = df["site"].value_counts()
        for site, count in site_counts.items():
            log.info("  %s: %d", site, count)

    conn = init_db()
    new, existing = store_jobspy_results(conn, df, query)
    log.info("Stored: %d new, %d already in DB", new, existing)

    db_total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    pending = conn.execute("SELECT COUNT(*) FROM jobs WHERE detail_scraped_at IS NULL").fetchone()[0]
    log.info("DB total: %d jobs, %d pending detail scrape", db_total, pending)

    return {"total": total, "new": new, "existing": existing}


# -- Full crawl (all queries x all locations) --------------------------------


def _full_crawl(
    search_cfg: dict,
    tiers: list[int] | None = None,
    locations: list[str] | None = None,
    sites: list[str] | None = None,
    results_per_site: int = 100,
    hours_old: int = 72,
    proxy: str | None = None,
    max_retries: int = 2,
    limit: int = 0,
    run_id: str = "jobspy",
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict:
    """Run all search queries from search config across all locations."""
    if sites is None:
        sites = ["indeed", "linkedin", "zip_recruiter"]

    # Build search combinations from config
    queries = search_cfg.get("queries", [])
    locs = search_cfg.get("locations", [])
    defaults = dict(search_cfg.get("defaults", {}))
    defaults.setdefault("country_indeed", search_cfg.get("country", "usa"))
    glassdoor_map = search_cfg.get("glassdoor_location_map", {})
    accept_locs, reject_locs, local_accept_locs = _load_location_config(search_cfg)

    if tiers:
        queries = [q for q in queries if q.get("tier") in tiers]
    if locations:
        locs = [loc for loc in locs if loc.get("label") in locations]

    searches = []
    for q in queries:
        for loc in locs:
            searches.append(
                {
                    "query": q["query"],
                    "location": loc["location"],
                    "remote": loc.get("remote", False),
                    "tier": q.get("tier", 0),
                    "match_mode": q.get("match_mode", "strict"),
                    "target_track": q.get("target_track", ""),
                    "seniority_floor": q.get("seniority_floor", ""),
                }
            )

    proxy_config = parse_proxy(proxy) if proxy else None

    log.info("Full crawl: %d search combinations", len(searches))
    log.info("Sites: %s | Results/site: %d | Hours old: %d", ", ".join(sites), results_per_site, hours_old)

    # Ensure DB schema is ready
    init_db()

    # Politeness invocation boundary (R10, D3): pace searches + bound the run's
    # outbound request budget. jobspy's internal per-board transport is unpoliced.
    # A per-crawl limiter is correct here (the crawl loop is sequential); the
    # process-shared limiter guards the parallel ThreadPoolExecutor fan-out paths.
    politeness_ua = PolitenessGateway().user_agent
    limiter = HostRateLimiter()
    request_budget = RunBudgetCounter(BROAD_BOARD_LEAD_POLICY.max_requests_per_run)
    politeness_context = PolitenessSourceContext(
        stage="discover",
        source_id=_JOBSPY_HOST_KEY,
        source_role="broad_board",
        adapter="jobspy",
        run_id=run_id,
    )
    politeness_conn = get_connection()

    total_new = 0
    total_existing = 0
    total_errors = 0
    total_found = 0
    total_filtered = 0
    completed = 0

    def emit_progress(search: dict | None, message: str) -> None:
        if progress_callback is None:
            return
        snapshot: dict[str, Any] = {
            "completed": completed,
            "total": len(searches),
            "unit": "searches",
            "new_jobs": total_new,
            "existing_jobs": total_existing,
            "filtered_jobs": total_filtered,
            "errors": total_errors,
            "raw_total": total_found,
            "message": message,
        }
        if search is not None:
            snapshot["current_query"] = str(search.get("query") or "")
            snapshot["current_location"] = str(search.get("location") or "")
        progress_callback(snapshot)

    for s in searches:
        if cancel_event is not None and cancel_event.is_set():
            raise DiscoveryCancelled("JobSpy discovery canceled")
        remaining = max(limit - total_new, 0) if limit > 0 else 0
        if limit > 0 and remaining <= 0:
            break
        if not request_budget.try_consume(1):
            record_politeness_outcome(
                politeness_conn,
                decision=PolitenessDecision(
                    allowed=False,
                    outcome=PolitenessOutcome.BUDGET_EXHAUSTED,
                    user_agent=politeness_ua,
                    reason="jobspy per-run request budget exhausted",
                ),
                context=politeness_context,
            )
            log.warning("JobSpy per-run request budget exhausted after %d searches", completed)
            break
        emit_progress(s, "JobSpy search started")
        with limiter.slot(
            _JOBSPY_HOST_KEY,
            min_interval_seconds=BROAD_BOARD_LEAD_POLICY.min_request_interval_seconds,
            max_concurrency=BROAD_BOARD_LEAD_POLICY.max_concurrent_requests_per_host,
        ):
            result = _run_one_search(
                s,
                sites,
                results_per_site,
                hours_old,
                proxy_config,
                defaults,
                max_retries,
                accept_locs,
                reject_locs,
                local_accept_locs,
                glassdoor_map,
                limit=remaining if limit > 0 else 0,
                run_id=run_id,
                search_cfg=search_cfg,
            )
        completed += 1
        total_new += result["new"]
        total_existing += result["existing"]
        total_errors += result["errors"]
        total_found += result.get("total", 0)
        total_filtered += result.get("filtered", 0)
        emit_progress(s, "JobSpy search completed")

        if completed % 5 == 0 or completed == len(searches):
            log.info(
                "Progress: %d/%d queries done (%d new, %d dupes, %d errors)",
                completed,
                len(searches),
                total_new,
                total_existing,
                total_errors,
            )
        if cancel_event is not None and cancel_event.is_set():
            raise DiscoveryCancelled("JobSpy discovery canceled")

    # Final stats
    conn = get_connection()
    db_total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]

    log.info(
        "Full crawl complete: %d new | %d dupes | %d errors | %d total in DB",
        total_new,
        total_existing,
        total_errors,
        db_total,
    )
    if completed > 0 and total_errors == completed and total_new + total_existing == 0:
        raise RuntimeError(f"JobSpy failed for all {completed} search combination(s)")

    return {
        "total": total_new + total_existing,
        "raw_total": total_found,
        "new": total_new,
        "existing": total_existing,
        "errors": total_errors,
        "filtered": total_filtered,
        "db_total": db_total,
        "queries": completed,
    }


# -- Public entry point ------------------------------------------------------


def run_discovery(
    cfg: dict | None = None,
    limit: int = 0,
    run_id: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict:
    """Main entry point for JobSpy-based job discovery.

    Loads search queries and locations from database-backed discovery settings
    plus profile target-search fields, then runs a full crawl across all
    configured job boards.

    Args:
        cfg: Override the search configuration dict. If None, loads from
             the database-backed discovery settings.

    Returns:
        Dict with stats: new, existing, errors, db_total, queries.
    """
    if cfg is None:
        cfg = config.load_search_config()

    if not cfg:
        log.warning("No search configuration found. Run `jobhunter init` to create one.")
        return {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}

    proxy = cfg.get("proxy")
    sites = config.resolve_jobspy_boards(cfg)
    results_per_site = cfg.get("defaults", {}).get("results_per_site", 100)
    hours_old = cfg.get("defaults", {}).get("hours_old", 72)
    tiers = cfg.get("tiers")
    locations = cfg.get("location_labels")

    return _full_crawl(
        search_cfg=cfg,
        tiers=tiers,
        locations=locations,
        sites=sites,
        results_per_site=results_per_site,
        hours_old=hours_old,
        proxy=proxy,
        limit=limit,
        run_id=run_id or "jobspy",
        progress_callback=progress_callback,
        cancel_event=cancel_event,
    )
