"""JobStreaming broad-board discovery for Indeed, LinkedIn, Glassdoor, and ZipRecruiter.

Uses JobStreaming to scrape multiple job boards, deduplicates results,
parses salary ranges, and stores accepted postings in the JobCtrl database.

Search queries, locations, and filtering rules are loaded from database-backed
discovery settings plus the profile target-search fields.
"""

import logging
import re
import sqlite3
import hashlib
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from jobctrl import config
from jobctrl.database import get_connection, init_db
from jobctrl.domain.discovery import JobMetadata, PostingUrl, SearchStrategy, Source
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import (
    DiscoverySearchSpec,
    DiscoverySearchUnit,
    DiscoverySearchUnitLease,
)
from jobctrl.domain.discovery.identity import JobSourceObservation, normalize_observed_url
from jobctrl.domain.discovery.source_registry import BROAD_BOARD_LEAD_POLICY
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.ports.politeness import PolitenessDecision, PolitenessOutcome
from jobctrl.domain.job_content_identity import (
    content_match_basis,
    is_genuine_employer_identity,
    job_content_fingerprint,
    normalize_identity_text,
)
# Phase 7 (S-27 round-1 review M1): ``parse_proxy`` lives under
# ``jobctrl.infrastructure.network`` so the Enrichment context's
# Playwright fetcher can import it without depending on this Discovery
# module. Imported here for the local call sites in ``_run_one_search``
# / ``_full_crawl``.
from jobctrl.infrastructure.discovery.location_filter import (
    configured_location_filters,
    configured_local_location_accepts,
    location_matches_target,
    normalize_location_display,
)
from jobctrl.infrastructure.discovery.production_wiring import (
    DurableJobEventPublisher,
    _posting_acceptance_policy,
)
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.discovery.title_filter import title_matches_query
from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.network import (
    PolitenessGateway,
    PolitenessSourceContext,
    RunBudgetCounter,
    get_shared_rate_limiter,
    record_politeness_outcome,
)
from jobctrl.infrastructure.network.proxy import parse_proxy

log = logging.getLogger(__name__)
_SOURCE_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Broad boards (indeed/linkedin/zip/glassdoor) are fetched by JobStreaming,
# which owns its own tls-client/requests transport. Per owner decision D3 we
# therefore CANNOT robots-gate JobStreaming's internal
# per-board requests. Instead we enforce politeness at OUR invocation boundary:
# a per-run request budget + inter-search pacing via the shared host limiter,
# recording a budget-exhausted outcome when the budget stops a crawl. The
# residual (JobStreaming's internal requests are unpoliced) is documented.
_JOBSPY_HOST_KEY = "jobspy"


class DiscoveryCancelled(RuntimeError):
    """Raised when a cooperative request stops broad-board discovery."""


class DiscoveryResumeRequired(RuntimeError):
    """Raised when an unfinished search unit should be retried by Temporal."""


# -- Retry wrapper -----------------------------------------------------------


def _scrape_with_retry(kwargs: dict, max_retries: int = 2, backoff: float = 5.0):
    """Collect one typed JobStreaming request into the legacy frame shape."""
    try:
        from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
            scrape_legacy_options,
        )
    except ImportError as exc:
        raise ImportError("jobstreaming 0.0.2 is not installed. Run the JobCtrl setup again.") from exc
    return scrape_legacy_options(
        kwargs,
        max_retries=max_retries,
        retry_backoff=backoff,
        user_agent=PolitenessGateway().user_agent,
    )


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


# -- DB storage (legacy broad-board DataFrame -> SQLite) ----------------------


def store_jobspy_results(
    conn: sqlite3.Connection,
    df,
    source_label: str,
    limit: int = 0,
    run_id: str = "jobspy",
    search_cfg: dict | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
    search_unit_lease: DiscoverySearchUnitLease | None = None,
) -> tuple[int, int]:
    """Store broad-board DataFrame results. Returns ``(new, existing)``."""
    now = datetime.now(timezone.utc).isoformat()
    new = 0
    existing = 0
    active_search_cfg = search_cfg if search_cfg is not None else _fallback_store_search_cfg(df, source_label)
    acceptance_policy = _posting_acceptance_policy(active_search_cfg)
    repository = SqliteJobRepository(
        conn,
        discovery_execution=discovery_execution,
        source_family=("jobspy" if discovery_execution is not None or search_unit_lease is not None else None),
        search_unit_lease=search_unit_lease,
    )
    write_fence: Callable[[], None] | None = None
    if search_unit_lease is not None:
        from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
            SqliteDiscoverySearchUnitRepository,
        )

        search_units = SqliteDiscoverySearchUnitRepository(conn)

        def write_fence() -> None:
            search_units.fence_write(search_unit_lease)

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

        # If JobStreaming gave us a full description, promote it directly.
        full_description = None
        detail_scraped_at = None
        if description and len(description) > 200:
            full_description = description
            detail_scraped_at = now

        # Extract the direct URL when supplied. The provider's board URL remains
        # the discovery observation; this direct URL can identify who owns the
        # posting for future direct discovery.
        apply_url = _nullable_str(row.get("job_url_direct"))
        source_id = _jobspy_source_id(site_label)
        provider_event_key = _nullable_str(row.get("jobstreaming_job_key")) or _jobspy_source_native_id(row, url)
        consumption_prefix = _jobstreaming_consumption_prefix(
            search_unit_lease,
            source_id=source_id,
            provider_event_key=provider_event_key,
        )
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
                write_fence=write_fence,
            )
            _record_jobspy_source_observation(
                conn,
                job_url=duplicate_url,
                observed_url=url,
                source_id=source_id,
                run_id=run_id,
                observed_at=now,
                discovery_execution=discovery_execution,
                search_unit_lease=search_unit_lease,
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "JobSourceObserved",
                ),
            )
            _learn_posting_source(
                conn,
                job_url=duplicate_url,
                posting_url=apply_url,
                discovered_via_source_id=source_id,
                observed_at=now,
                write_fence=write_fence,
                event_idempotency_prefix=_consumption_event_key(
                    consumption_prefix,
                    "learned-source",
                ),
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
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "JobMetadataUpdated",
                ),
            )
            _upsert_posted_compensation_fact(
                conn,
                job_url=duplicate_url,
                parsed_at=now,
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "CompensationFactsUpdated",
                ),
            )
            _apply_write_fence(write_fence)
            _restore_job_by_url(conn, duplicate_url, restored_at=now)
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
                write_fence=write_fence,
            )
            _record_jobspy_source_observation(
                conn,
                job_url=stored_duplicate_url,
                observed_url=url,
                source_id=source_id,
                run_id=run_id,
                observed_at=now,
                discovery_execution=discovery_execution,
                search_unit_lease=search_unit_lease,
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "JobSourceObserved",
                ),
            )
            _learn_posting_source(
                conn,
                job_url=stored_duplicate_url,
                posting_url=apply_url,
                discovered_via_source_id=source_id,
                observed_at=now,
                write_fence=write_fence,
                event_idempotency_prefix=_consumption_event_key(
                    consumption_prefix,
                    "learned-source",
                ),
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
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "JobMetadataUpdated",
                ),
            )
            _upsert_posted_compensation_fact(
                conn,
                job_url=stored_duplicate_url,
                parsed_at=now,
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "CompensationFactsUpdated",
                ),
            )
            _apply_write_fence(write_fence)
            _restore_job_by_url(conn, stored_duplicate_url, restored_at=now)
            existing += 1
            continue

        use_case = DiscoverJobsUseCase(
            repository=repository,
            publisher=DurableJobEventPublisher(
                conn,
                stage="discover",
                write_fence=write_fence,
                idempotency_prefix=_consumption_event_key(
                    consumption_prefix,
                    "ingest",
                ),
            ),
            acceptance_policy=acceptance_policy,
            observation_id_factory=((lambda: f"obs:{consumption_prefix}") if consumption_prefix is not None else None),
            republish_canonical_identity=consumption_prefix is not None,
        )
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
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "JobMetadataUpdated",
                ),
            )
            _upsert_posted_compensation_fact(
                conn,
                job_url=url,
                parsed_at=now,
                write_fence=write_fence,
                idempotency_key=_consumption_event_key(
                    consumption_prefix,
                    "CompensationFactsUpdated",
                ),
            )
            _learn_posting_source(
                conn,
                job_url=url,
                posting_url=apply_url,
                discovered_via_source_id=source_id,
                observed_at=now,
                write_fence=write_fence,
                event_idempotency_prefix=_consumption_event_key(
                    consumption_prefix,
                    "learned-source",
                ),
            )
        if summary.new_jobs > 0:
            new += 1
        elif summary.observed > 0 or summary.duplicates_linked > 0:
            _apply_write_fence(write_fence)
            _restore_job_by_url(conn, url, restored_at=now)
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


def _upsert_posted_compensation_fact(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    parsed_at: str,
    write_fence: Callable[[], None] | None = None,
    idempotency_key: str | None = None,
) -> None:
    from jobctrl.infrastructure.compensation import SqlitePostedCompensationRepository

    repository = SqlitePostedCompensationRepository(conn)
    _apply_write_fence(write_fence)
    row = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()
    if row is None:
        return
    salary = row["salary"] if isinstance(row, sqlite3.Row) else row[0]
    repository.parse_and_save_job_salary(
        job_url,
        salary,
        parsed_at=parsed_at,
        event_idempotency_key=idempotency_key,
        event_write_fence=write_fence,
    )


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
    write_fence: Callable[[], None] | None = None,
    idempotency_key: str | None = None,
) -> None:
    _apply_write_fence(write_fence)
    identity = SqliteJobRepository(conn).resolve_by_posting_url(
        LOCAL_TENANT,
        PostingUrl(value=job_url),
    )
    if identity is None:
        raise LookupError(f"JobSpy metadata refresh references an unknown posting URL: {job_url!r}")
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
        WHERE tenant_id = ? AND job_id = ?
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
            str(LOCAL_TENANT),
            str(identity.job_id),
        ),
    )
    if cursor.rowcount:
        from jobctrl.state import record_job_event

        record_job_event(
            conn,
            identity.job_id,
            "discover",
            "JobMetadataUpdated",
            message="Job metadata refreshed from broad-board discovery",
            payload={
                "company": company,
                "description": bool((description or "").strip()),
                "location": location,
                "source": site,
            },
            occurred_at=updated_at,
            idempotency_key=idempotency_key,
        )


def _restore_job_by_url(
    conn: sqlite3.Connection,
    job_url: str,
    *,
    restored_at: str,
) -> None:
    repository = SqliteJobRepository(conn)
    identity = repository.resolve_by_posting_url(LOCAL_TENANT, PostingUrl(value=job_url))
    if identity is None:
        raise LookupError(f"JobSpy restore references an unknown posting URL: {job_url!r}")
    repository.restore(LOCAL_TENANT, identity.job_id, restored_at=restored_at)


def _nullable_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.casefold() in {"nan", "none", "nat", "<na>"}:
        return None
    return text


def _apply_write_fence(write_fence: Callable[[], None] | None) -> None:
    if write_fence is not None:
        write_fence()


def _jobstreaming_consumption_prefix(
    lease: DiscoverySearchUnitLease | None,
    *,
    source_id: str,
    provider_event_key: str,
) -> str | None:
    """Build a replay-stable key without exposing provider or query payloads."""

    if lease is None:
        return None
    material = "\x1f".join(
        (
            lease.execution.tenant_id,
            lease.execution.workflow_id,
            lease.execution.temporal_run_id,
            lease.unit_id,
            source_id,
            provider_event_key,
        )
    )
    return "jobstreaming:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def _consumption_event_key(prefix: str | None, event_type: str) -> str | None:
    return f"{prefix}:{event_type}" if prefix is not None else None


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
    discovery_execution: DiscoveryExecutionRef | None = None,
    search_unit_lease: DiscoverySearchUnitLease | None = None,
    write_fence: Callable[[], None] | None = None,
    idempotency_key: str | None = None,
) -> None:
    normalized = normalize_observed_url(observed_url)
    source_native_id = normalized or observed_url
    observation_id = "jobspy:" + hashlib.sha256(f"{source_id}:{source_native_id}".encode("utf-8")).hexdigest()[:24]
    repository = SqliteJobRepository(
        conn,
        discovery_execution=discovery_execution,
        source_family=("jobspy" if discovery_execution is not None or search_unit_lease is not None else None),
        search_unit_lease=search_unit_lease,
    )
    identity = repository.resolve_by_posting_url(
        LOCAL_TENANT,
        PostingUrl(value=job_url),
    )
    if identity is None:
        raise LookupError(f"JobSpy observation references an unknown posting URL: {job_url!r}")
    repository.attach_source_observation(
        LOCAL_TENANT,
        identity.job_id,
        JobSourceObservation(
            source_observation_id=observation_id,
            source_id=source_id,
            source_native_id=source_native_id,
            observed_url=observed_url,
            run_id=run_id,
            observed_at=observed_at,
        ),
    )
    from jobctrl.state import record_job_event

    _apply_write_fence(write_fence)
    record_job_event(
        conn,
        identity.job_id,
        "discover",
        "JobSourceObserved",
        message="Job source observed.",
        payload={
            "tenantId": "local",
            "job_id": str(identity.job_id),
            "jobId": str(identity.job_id),
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
        idempotency_key=idempotency_key,
    )


def _learn_posting_source(
    conn: sqlite3.Connection,
    *,
    job_url: str,
    posting_url: str | None,
    discovered_via_source_id: str,
    observed_at: str,
    write_fence: Callable[[], None] | None = None,
    event_idempotency_prefix: str | None = None,
) -> None:
    if not posting_url:
        return
    from jobctrl.infrastructure.discovery.production_wiring import (
        learn_posting_source_from_url,
    )

    learn_posting_source_from_url(
        conn,
        job_url=job_url,
        posting_url=posting_url,
        discovered_via_source_id=discovered_via_source_id,
        observed_at=observed_at,
        write_fence=write_fence,
        event_idempotency_prefix=event_idempotency_prefix,
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
        LEFT JOIN job_enrichments je
          ON je.tenant_id = j.tenant_id
         AND je.job_id = j.job_id
        WHERE j.tenant_id = ? AND j.url = ?
        """,
        (str(LOCAL_TENANT), url),
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
               CASE WHEN d.job_id IS NULL THEN 0 ELSE 1 END AS is_deleted
        FROM jobs j
        LEFT JOIN job_enrichments je
          ON je.tenant_id = j.tenant_id
         AND je.job_id = j.job_id
        LEFT JOIN jobctrl_deleted_jobs d
          ON d.tenant_id = j.tenant_id
         AND d.job_id = j.job_id
         AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
        WHERE j.tenant_id = ?
          {self_filter}
          AND jh_normalize_identity(COALESCE(j.title, '')) = ?
          AND jh_normalize_identity(COALESCE(NULLIF(j.company, ''), j.site, '')) = ?
        ORDER BY is_deleted ASC, j.discovered_at ASC NULLS LAST, j.url ASC
        """,
        (str(LOCAL_TENANT), *params),
    ).fetchall()
    for existing in rows:
        stored_company = existing["company"]
        stored_employer = stored_company if stored_company else existing["site"]
        if not is_genuine_employer_identity(stored_employer):
            continue
        if (
            content_match_basis(
                incoming_key=incoming_key,
                incoming_description=description,
                candidate_title=existing["title"],
                candidate_employer=stored_employer,
                candidate_descriptions=(
                    existing["listing_description"],
                    existing["enriched_description"],
                ),
            )
            is not None
        ):
            return str(existing["url"])
    return None


def _record_content_duplicate_link(
    conn: sqlite3.Connection,
    *,
    surviving_url: str,
    duplicate_url: str,
    source: str,
    observed_at: str,
    write_fence: Callable[[], None] | None = None,
) -> None:
    link_key = job_content_fingerprint(
        title=surviving_url,
        company=source,
        description=duplicate_url,
    )
    if link_key is None:
        return
    _apply_write_fence(write_fence)
    duplicate_link_id = "content:" + link_key[:32]
    normalized_url = normalize_observed_url(duplicate_url)
    owner = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ?",
        (str(LOCAL_TENANT), surviving_url),
    ).fetchone()
    if owner is None:
        raise LookupError(f"Content duplicate owner is unknown: {surviving_url!r}")
    owner_job_id = canonical_job_id(str(owner["job_id"] if isinstance(owner, sqlite3.Row) else owner[0]))
    conn.execute(
        """
        INSERT OR IGNORE INTO job_duplicate_links (
            tenant_id, duplicate_link_id, surviving_job_id,
            superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES ('local', ?, ?, ?, 'content_fingerprint_match', 0.95, ?)
        """,
        (duplicate_link_id, str(owner_job_id), duplicate_url, observed_at),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO job_source_observations (
            tenant_id, source_observation_id, job_id, source_id,
            source_native_id, observed_url, normalized_observed_url,
            run_id, observed_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, 'jobspy', ?)
        """,
        (
            f"content-duplicate:{duplicate_link_id}",
            str(owner_job_id),
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
    discovery_execution: DiscoveryExecutionRef | None = None,
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
    provider_errors = 0

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
            df, failures = _jobstreaming_frame_and_failures(_scrape_with_retry(kwargs, max_retries=max_retries))
            provider_errors += failures
            all_dfs.append(df)
        except ImportError:
            raise
        except Exception as e:
            provider_errors += 1
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
            gd_df, failures = _jobstreaming_frame_and_failures(_scrape_with_retry(gd_kwargs, max_retries=max_retries))
            provider_errors += failures
            all_dfs.append(gd_df)
        except ImportError:
            raise
        except Exception as e:
            provider_errors += 1
            log.error("[%s] (glassdoor): %s", label, e)

    if not all_dfs:
        log.error("[%s]: all sites failed", label)
        return {
            "new": 0,
            "existing": 0,
            "errors": max(provider_errors, 1),
            "all_sites_failed": True,
            "filtered": 0,
            "total": 0,
            "label": label,
        }

    import pandas as pd
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        df = pd.concat(all_dfs, ignore_index=True) if len(all_dfs) > 1 else all_dfs[0]

    if len(df) == 0:
        log.info("[%s] 0 results", label)
        return {
            "new": 0,
            "existing": 0,
            "errors": provider_errors,
            "all_sites_failed": False,
            "filtered": 0,
            "total": 0,
            "label": label,
        }

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
    if discovery_execution is not None:
        store_kwargs["discovery_execution"] = discovery_execution
    new, existing = store_jobspy_results(conn, df, s["query"], **store_kwargs)

    msg = f"[{label}] {before} results -> {new} new, {existing} dupes"
    if location_filtered:
        msg += f", {location_filtered} filtered (location)"
    if title_filtered:
        msg += f", {title_filtered} filtered (title)"
    log.info(msg)

    return {
        "new": new,
        "existing": existing,
        "errors": provider_errors,
        "all_sites_failed": False,
        "filtered": filtered,
        "total": before,
        "label": label,
    }


def _jobstreaming_frame_and_failures(result):
    """Unpack the typed provider result while tolerating legacy test frames."""

    from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
        JobStreamingBatch,
    )

    if not isinstance(result, JobStreamingBatch):
        return result, 0
    for failure in result.failures:
        log.error(
            "[%s] provider failure [%s]: %s: %s",
            failure.site,
            failure.code,
            failure.error_type,
            failure.message,
        )
    return result.frame, len(result.failures)


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
    """Run a single broad-board search via JobStreaming and store results."""
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
            df, provider_errors = _jobstreaming_frame_and_failures(_scrape_with_retry(kwargs))
    except Exception as e:
        log.error("JobStreaming search failed: %s", e)
        return {"error": str(e), "total": 0, "new": 0, "existing": 0, "errors": 1}

    total = len(df)
    log.info("JobStreaming returned %d results", total)

    if total == 0:
        return {"total": 0, "new": 0, "existing": 0, "errors": provider_errors}

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

    return {"total": total, "new": new, "existing": existing, "errors": provider_errors}


# -- Full crawl (all queries x all locations) --------------------------------


def _configured_searches(
    search_cfg: dict,
    *,
    tiers: list[int] | None = None,
    locations: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Compile the ordered query/location plan shared by both execution paths."""

    queries = search_cfg.get("queries", [])
    locs = search_cfg.get("locations", [])
    if tiers:
        queries = [query for query in queries if query.get("tier") in tiers]
    if locations:
        locs = [location for location in locs if location.get("label") in locations]

    return [
        {
            "query": query["query"],
            "location": location["location"],
            "remote": location.get("remote", False),
            "tier": query.get("tier", 0),
            "match_mode": query.get("match_mode", "strict"),
            "target_track": query.get("target_track", ""),
            "seniority_floor": query.get("seniority_floor", ""),
        }
        for query in queries
        for location in locs
    ]


def _durable_search_specs(
    search_cfg: dict,
    *,
    tiers: list[int] | None,
    locations: list[str] | None,
    sites: list[str],
    results_per_site: int,
    hours_old: int,
) -> list[DiscoverySearchSpec]:
    """Split the crawl into immutable provider-location-compatible units."""

    searches = _configured_searches(
        search_cfg,
        tiers=tiers,
        locations=locations,
    )
    defaults = dict(search_cfg.get("defaults", {}))
    country_indeed = str(
        defaults.get("country_indeed", search_cfg.get("country", "usa"))
    )
    glassdoor_map = search_cfg.get("glassdoor_location_map", {})
    accept_locs, reject_locs, local_accept_locs = _load_location_config(search_cfg)
    specs: list[DiscoverySearchSpec] = []

    for search in searches:
        common = {
            "query": str(search["query"]),
            "target_location": str(search["location"]),
            "results_per_site": results_per_site,
            "hours_old": hours_old,
            "remote_only": bool(search.get("remote")),
            "country_indeed": country_indeed,
            "match_mode": str(search.get("match_mode") or "strict"),
            "target_track": str(search.get("target_track") or ""),
            "seniority_floor": str(search.get("seniority_floor") or ""),
            "accept_locations": tuple(accept_locs),
            "reject_locations": tuple(reject_locs),
            "local_accept_locations": tuple(local_accept_locs),
        }
        for site in sites:
            target_location = str(search["location"])
            provider_location = target_location
            if site == "glassdoor":
                provider_location = str(
                    glassdoor_map.get(
                        target_location,
                        target_location.split(",")[0],
                    )
                )
            specs.append(
                DiscoverySearchSpec(
                    provider_location=provider_location,
                    sites=(site,),
                    linkedin_fetch_description=site == "linkedin",
                    **common,
                )
            )
    return specs


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
    discovery_execution: DiscoveryExecutionRef | None = None,
) -> dict:
    """Run all search queries from search config across all locations."""
    if sites is None:
        sites = ["indeed", "linkedin", "zip_recruiter"]

    defaults = dict(search_cfg.get("defaults", {}))
    defaults.setdefault("country_indeed", search_cfg.get("country", "usa"))
    glassdoor_map = search_cfg.get("glassdoor_location_map", {})
    accept_locs, reject_locs, local_accept_locs = _load_location_config(search_cfg)
    searches = _configured_searches(
        search_cfg,
        tiers=tiers,
        locations=locations,
    )

    proxy_config = parse_proxy(proxy) if proxy else None

    log.info("Full crawl: %d search combinations", len(searches))
    log.info("Sites: %s | Results/site: %d | Hours old: %d", ", ".join(sites), results_per_site, hours_old)

    # Ensure DB schema is ready
    init_db()

    # Politeness invocation boundary (R10, D3): pace searches + bound the run's
    # search fan-out. JobStreaming owns its internal per-board transport, so
    # we cannot count (or robots-gate) its individual outbound requests. The
    # budget here therefore counts SEARCH INVOCATIONS, not outbound requests: one
    # unit == one ``_run_one_search`` call (each of which fans out to up to two
    # ``scrape_jobs`` calls with internal board x page requests we can't police).
    # We pace on the shared process-wide limiter's "jobspy" bucket so every jobspy
    # invocation path (this crawl + the single manual ``search_jobs``) shares one
    # pacing budget.
    politeness_ua = PolitenessGateway().user_agent
    limiter = get_shared_rate_limiter()
    search_budget = RunBudgetCounter(BROAD_BOARD_LEAD_POLICY.max_requests_per_run)
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
    failed_searches = 0
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
            raise DiscoveryCancelled("JobStreaming discovery canceled")
        remaining = max(limit - total_new, 0) if limit > 0 else 0
        if limit > 0 and remaining <= 0:
            break
        if not search_budget.try_consume(1):
            record_politeness_outcome(
                politeness_conn,
                decision=PolitenessDecision(
                    allowed=False,
                    outcome=PolitenessOutcome.BUDGET_EXHAUSTED,
                    user_agent=politeness_ua,
                    reason="jobspy per-run search-invocation budget exhausted",
                ),
                context=politeness_context,
            )
            # record_politeness_outcome does not commit; commit here so the
            # outcome is durable even though we break out before the crawl's
            # normal end-of-run persistence.
            politeness_conn.commit()
            log.warning("JobStreaming per-run search-invocation budget exhausted after %d searches", completed)
            break
        emit_progress(s, "JobStreaming search started")
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
                discovery_execution=discovery_execution,
            )
        completed += 1
        total_new += result["new"]
        total_existing += result["existing"]
        total_errors += result["errors"]
        total_found += result.get("total", 0)
        total_filtered += result.get("filtered", 0)
        failed_searches += int(bool(result.get("all_sites_failed", False)))
        emit_progress(s, "JobStreaming search completed")

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
            raise DiscoveryCancelled("JobStreaming discovery canceled")

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
    if completed > 0 and failed_searches == completed and total_new + total_existing == 0:
        raise RuntimeError(f"JobStreaming failed for all {completed} search combination(s)")

    return {
        "total": total_new + total_existing,
        "raw_total": total_found,
        "new": total_new,
        "existing": total_existing,
        "errors": total_errors,
        "failed_queries": failed_searches,
        "filtered": total_filtered,
        "db_total": db_total,
        "queries": completed,
    }


def _jobstreaming_spec(spec: DiscoverySearchSpec):
    from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
        JobStreamingSearchSpec,
    )

    return JobStreamingSearchSpec(
        sites=spec.sites,
        query=spec.query,
        location=spec.provider_location,
        results_per_site=spec.results_per_site,
        hours_old=spec.hours_old,
        remote_only=spec.remote_only,
        country_indeed=spec.country_indeed,
        linkedin_fetch_description=spec.linkedin_fetch_description,
    )


def _filter_jobstreaming_event_frame(
    frame,
    spec: DiscoverySearchSpec,
):
    """Apply the caller-owned title and target-location policy to one event."""

    if frame.empty:
        return frame
    row = frame.iloc[0]
    location = (
        str(row.get("location", ""))
        if str(row.get("location", "")) != "nan"
        else None
    )
    title = (
        str(row.get("title", ""))
        if str(row.get("title", "")) != "nan"
        else None
    )
    if not _location_ok(
        location,
        list(spec.accept_locations),
        list(spec.reject_locations),
        search_location=spec.target_location,
        remote_required=spec.remote_only,
        is_remote=_truthy_remote(row.get("is_remote", False)),
        local_accept=list(spec.local_accept_locations),
    ):
        return frame.iloc[0:0]
    if not _title_ok(
        title,
        spec.query,
        match_mode=spec.match_mode,
        target_track=spec.target_track or None,
        seniority_floor=spec.seniority_floor or None,
    ):
        return frame.iloc[0:0]
    return frame


def _failed_jobstreaming_source_ids(
    units: list[DiscoverySearchUnit],
) -> list[str]:
    failed: set[str] = set()
    for unit in units:
        if not unit.last_error_code:
            continue
        board, separator, _code = unit.last_error_code.partition(":")
        boards = (board,) if separator and board in unit.spec.sites else unit.spec.sites
        failed.update(_jobspy_source_id(site) for site in boards)
    return sorted(failed)


def _durable_progress_snapshot(
    units: list[DiscoverySearchUnit],
    counts: dict[str, int],
    *,
    current: DiscoverySearchUnit | None,
    filtered_jobs: int,
    raw_total: int,
    message: str,
) -> dict[str, Any]:
    terminal = {"completed", "skipped", "failed", "canceled"}
    snapshot: dict[str, Any] = {
        "completed": sum(unit.state in terminal for unit in units),
        "total": len(units),
        "unit": "search units",
        "new_jobs": counts["new"],
        "existing_jobs": counts["existing"],
        "filtered_jobs": filtered_jobs,
        "raw_total": raw_total,
        "errors": len(_failed_jobstreaming_source_ids(units)),
        "message": message,
        "recovered_units": sum(unit.recovered for unit in units),
    }
    if current is not None:
        snapshot["current_query"] = current.spec.query
        snapshot["current_location"] = current.spec.target_location
    return snapshot


def _durable_full_crawl(
    search_cfg: dict,
    *,
    tiers: list[int] | None,
    locations: list[str] | None,
    sites: list[str],
    results_per_site: int,
    hours_old: int,
    proxy: str | None,
    max_retries: int,
    limit: int,
    run_id: str,
    progress_callback: Callable[[dict[str, Any]], None] | None,
    cancel_event: threading.Event | None,
    discovery_execution: DiscoveryExecutionRef,
    activity_attempt: int,
    activity_owner_token: str,
    adapter_registry: Any | None,
) -> dict[str, Any]:
    """Consume JobStreaming from caller-owned units with store-before-ack."""

    from jobstreaming import (
        CheckpointCompatibilityError,
        CheckpointMismatchError,
        ErrorEvent,
        JobEvent,
        ProgressEvent,
        SearchCompleteEvent,
        SiteCompleteEvent,
        StreamCancelledError,
        WarningEvent,
    )

    from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
        JobStreamingGateway,
    )
    from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
        SqliteDiscoverySearchUnitRepository,
    )

    specs = _durable_search_specs(
        search_cfg,
        tiers=tiers,
        locations=locations,
        sites=sites,
        results_per_site=results_per_site,
        hours_old=hours_old,
    )
    conn = init_db()
    repository = SqliteDiscoverySearchUnitRepository(conn)
    repository.plan_units(discovery_execution, specs)
    proxy_config = parse_proxy(proxy) if proxy else None
    proxies = [proxy_config.jobspy] if proxy_config else None
    gateway = JobStreamingGateway()
    limiter = get_shared_rate_limiter()
    politeness_ua = PolitenessGateway().user_agent
    politeness_context = PolitenessSourceContext(
        stage="discover",
        source_id=_JOBSPY_HOST_KEY,
        source_role="broad_board",
        adapter="jobstreaming",
        run_id=run_id,
    )
    stopped_for_limit = False

    def emit_progress(current: DiscoverySearchUnit | None, message: str) -> None:
        if progress_callback is None:
            return
        progress_callback(
            _durable_progress_snapshot(
                repository.list_units(discovery_execution),
                repository.execution_counts(discovery_execution),
                current=current,
                filtered_jobs=repository.execution_filtered_count(
                    discovery_execution
                ),
                raw_total=repository.execution_provider_job_count(
                    discovery_execution
                ),
                message=message,
            )
        )

    emit_progress(None, "JobStreaming search plan ready")
    while True:
        lease = repository.claim_next(
            discovery_execution,
            activity_owner_token,
            activity_attempt,
        )
        if lease is None:
            break
        unit = repository.get_unit(discovery_execution, lease.unit_id)
        if unit is None:  # pragma: no cover - protected by the lease foreign key
            raise RuntimeError(f"claimed search unit {lease.unit_id} disappeared")

        if cancel_event is not None and cancel_event.is_set():
            repository.mark_execution_canceled(lease)
            emit_progress(unit, "JobStreaming discovery canceled")
            raise DiscoveryCancelled("JobStreaming discovery canceled")

        invocations = sum(
            (1 + candidate.recovery_count)
            for candidate in repository.list_units(discovery_execution)
            if candidate.lease_attempt > 0
        )
        if invocations > BROAD_BOARD_LEAD_POLICY.max_requests_per_run:
            repository.mark_skipped(lease)
            repository.mark_pending_skipped(discovery_execution)
            record_politeness_outcome(
                conn,
                decision=PolitenessDecision(
                    allowed=False,
                    outcome=PolitenessOutcome.BUDGET_EXHAUSTED,
                    user_agent=politeness_ua,
                    reason="JobStreaming per-run search-unit budget exhausted",
                ),
                context=politeness_context,
            )
            conn.commit()
            emit_progress(unit, "JobStreaming search-unit budget exhausted")
            break

        repository.reset_checkpoint_if_requested(lease)
        unit = repository.get_unit(discovery_execution, lease.unit_id)
        assert unit is not None
        message = (
            "Resuming interrupted JobStreaming search unit"
            if unit.recovered
            else "JobStreaming search unit started"
        )
        emit_progress(unit, message)
        failures: list[ErrorEvent] = []
        completed_sites: set[str] = set()
        saw_search_complete = False
        terminal_checkpoint_failure = False
        provider_spec = _jobstreaming_spec(unit.spec)

        try:
            with limiter.slot(
                _JOBSPY_HOST_KEY,
                min_interval_seconds=BROAD_BOARD_LEAD_POLICY.min_request_interval_seconds,
                max_concurrency=BROAD_BOARD_LEAD_POLICY.max_concurrent_requests_per_host,
            ):
                with gateway.open_stream(
                    provider_spec,
                    proxies=proxies,
                    user_agent=politeness_ua,
                    checkpoint_store=repository.checkpoint_store(lease),
                    resume=True,
                    max_retries=max_retries,
                    retry_backoff=5.0,
                    cancel_event=cancel_event,
                    registry=adapter_registry,
                ) as stream:
                    for event in stream:
                        if isinstance(event, JobEvent):
                            counts = repository.execution_counts(discovery_execution)
                            if limit > 0 and counts["new"] >= limit:
                                # A worker can disappear after acknowledging the
                                # limit-reaching event but before terminalizing
                                # the unit. Never accept one extra posting when
                                # that completed checkpoint resumes at the next
                                # provider result.
                                repository.mark_skipped(lease)
                                repository.mark_pending_skipped(discovery_execution)
                                stream.close()
                                stopped_for_limit = True
                                emit_progress(unit, "Discovery result limit reached")
                                break
                            frame = gateway.frame_for_job_event(
                                event,
                                provider_spec,
                            )
                            accepted_frame = _filter_jobstreaming_event_frame(
                                frame,
                                unit.spec,
                            )
                            if accepted_frame.empty:
                                repository.record_filtered_result(
                                    lease,
                                    event.job_key,
                                )
                            else:
                                store_jobspy_results(
                                    conn,
                                    accepted_frame,
                                    unit.spec.query,
                                    run_id=run_id,
                                    search_cfg=search_cfg,
                                    discovery_execution=discovery_execution,
                                    search_unit_lease=lease,
                                )
                            stream.ack(event)
                            counts = repository.execution_counts(discovery_execution)
                            emit_progress(unit, "JobStreaming posting acknowledged")
                            if limit > 0 and counts["new"] >= limit:
                                repository.mark_skipped(lease)
                                repository.mark_pending_skipped(discovery_execution)
                                stream.close()
                                stopped_for_limit = True
                                emit_progress(unit, "Discovery result limit reached")
                                break
                        elif isinstance(event, ErrorEvent):
                            repository.record_failure(
                                lease,
                                error_code=f"{event.site.value}:{event.code.value}",
                                error_type=event.error_type,
                                retryable=event.retryable,
                                reset_checkpoint=event.reset_checkpoint,
                                terminal=False,
                            )
                            stream.ack(event)
                            failures.append(event)
                            log.warning(
                                "JobStreaming board %s reported %s (%s)",
                                event.site.value,
                                event.code.value,
                                event.error_type,
                            )
                        elif isinstance(event, SiteCompleteEvent):
                            completed_sites.add(event.site.value)
                            stream.ack(event)
                        elif isinstance(event, SearchCompleteEvent):
                            stream.ack(event)
                            saw_search_complete = True
                            recoverable_failure = any(
                                failure.retryable or failure.reset_checkpoint
                                for failure in failures
                            )
                            if event.completed:
                                repository.mark_completed(
                                    lease,
                                    clear_error=True,
                                )
                            elif recoverable_failure:
                                raise DiscoveryResumeRequired(
                                    "JobStreaming search unit requires a retry"
                                )
                            elif failures and completed_sites:
                                # Healthy boards are a valid partial result even
                                # when they found zero postings. Preserve the
                                # typed failure evidence for the failed board.
                                repository.mark_completed(lease)
                            elif failures:
                                failure = failures[-1]
                                repository.record_failure(
                                    lease,
                                    error_code=(
                                        f"{failure.site.value}:{failure.code.value}"
                                    ),
                                    error_type=failure.error_type,
                                    retryable=False,
                                    reset_checkpoint=False,
                                )
                            else:
                                repository.record_failure(
                                    lease,
                                    error_code=f"{unit.spec.sites[0]}:incomplete",
                                    error_type="IncompleteSearchStream",
                                    retryable=True,
                                    reset_checkpoint=False,
                                    terminal=False,
                                )
                                raise DiscoveryResumeRequired(
                                    "JobStreaming ended without a terminal board outcome"
                                )
                        elif isinstance(event, (ProgressEvent, WarningEvent)):
                            stream.ack(event)
                        else:  # pragma: no cover - pinned event union is exhaustive
                            raise TypeError(
                                f"unsupported JobStreaming event: {type(event).__name__}"
                            )
        except StreamCancelledError as exc:
            repository.mark_execution_canceled(lease)
            emit_progress(unit, "JobStreaming discovery canceled")
            raise DiscoveryCancelled("JobStreaming discovery canceled") from exc
        except (CheckpointCompatibilityError, CheckpointMismatchError) as exc:
            repository.record_failure(
                lease,
                error_code=f"{unit.spec.sites[0]}:checkpoint_incompatible",
                error_type=type(exc).__name__,
                retryable=False,
                reset_checkpoint=False,
            )
            log.error(
                "JobStreaming checkpoint is incompatible for search unit %s (%s)",
                unit.unit_id,
                type(exc).__name__,
            )
            terminal_checkpoint_failure = True

        if stopped_for_limit:
            break
        if terminal_checkpoint_failure:
            emit_progress(
                repository.get_unit(discovery_execution, lease.unit_id),
                "JobStreaming checkpoint rejected",
            )
            continue
        if not saw_search_complete:
            raise DiscoveryResumeRequired(
                "JobStreaming search unit ended before SearchComplete"
            )
        emit_progress(
            repository.get_unit(discovery_execution, lease.unit_id),
            "JobStreaming search unit finished",
        )

    units = repository.list_units(discovery_execution)
    counts = repository.execution_counts(discovery_execution)
    failed_units = [unit for unit in units if unit.state == "failed"]
    completed_units = [unit for unit in units if unit.state == "completed"]
    canceled_units = [unit for unit in units if unit.state == "canceled"]
    if canceled_units:
        raise DiscoveryCancelled("JobStreaming discovery canceled")
    if failed_units and not completed_units and counts["accepted"] == 0:
        raise RuntimeError(
            f"JobStreaming failed for all {len(failed_units)} search unit(s)"
        )

    db_total = int(conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])
    result = {
        "total": counts["accepted"],
        "raw_total": repository.execution_provider_job_count(discovery_execution),
        "new": counts["new"],
        "existing": counts["existing"],
        "errors": len(_failed_jobstreaming_source_ids(units)),
        "failed_queries": len(failed_units),
        "failed_source_ids": _failed_jobstreaming_source_ids(units),
        "filtered": repository.execution_filtered_count(discovery_execution),
        "db_total": db_total,
        "queries": sum(
            unit.state in {"completed", "skipped", "failed"} for unit in units
        ),
        "search_units": len(units),
        "recovered_units": sum(unit.recovered for unit in units),
        "skipped_units": sum(unit.state == "skipped" for unit in units),
    }
    emit_progress(None, "JobStreaming discovery complete")
    return result


# -- Public entry point ------------------------------------------------------


def run_discovery(
    cfg: dict | None = None,
    limit: int = 0,
    run_id: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    cancel_event: threading.Event | None = None,
    discovery_execution: DiscoveryExecutionRef | None = None,
    activity_attempt: int | None = None,
    activity_owner_token: str | None = None,
    adapter_registry: Any | None = None,
) -> dict:
    """Main entry point for JobStreaming broad-board discovery.

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
        log.warning("No search configuration found. Run `jobctrl init` to create one.")
        return {"new": 0, "existing": 0, "errors": 0, "db_total": 0, "queries": 0}

    proxy = cfg.get("proxy")
    sites = config.resolve_jobspy_boards(cfg)
    results_per_site = cfg.get("defaults", {}).get("results_per_site", 100)
    hours_old = cfg.get("defaults", {}).get("hours_old", 72)
    tiers = cfg.get("tiers")
    locations = cfg.get("location_labels")

    if discovery_execution is not None:
        if activity_attempt is None or activity_attempt < 1:
            raise ValueError(
                "activity_attempt is required for resumable discovery"
            )
        if not activity_owner_token or not activity_owner_token.strip():
            raise ValueError(
                "activity_owner_token is required for resumable discovery"
            )
        return _durable_full_crawl(
            search_cfg=cfg,
            tiers=tiers,
            locations=locations,
            sites=sites,
            results_per_site=results_per_site,
            hours_old=hours_old,
            proxy=proxy,
            max_retries=2,
            limit=limit,
            run_id=run_id or "jobstreaming",
            progress_callback=progress_callback,
            cancel_event=cancel_event,
            discovery_execution=discovery_execution,
            activity_attempt=activity_attempt,
            activity_owner_token=activity_owner_token,
            adapter_registry=adapter_registry,
        )

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
        discovery_execution=discovery_execution,
    )
