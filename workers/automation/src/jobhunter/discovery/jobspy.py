"""JobSpy-based job discovery: searches Indeed, LinkedIn, Glassdoor, ZipRecruiter.

Uses python-jobspy to scrape multiple job boards, deduplicates results,
parses salary ranges, and stores everything in the JobHunter database.

Search queries, locations, and filtering rules are loaded from the user's
search configuration YAML (searches.yaml) rather than being hardcoded.
"""

import logging
import sqlite3
import time
from datetime import datetime, timezone

from jobhunter import config
from jobhunter.database import get_connection, init_db, resurface_deleted_job

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
from jobhunter.discovery.title_filter import title_matches_query
from jobhunter.infrastructure.network.proxy import parse_proxy

log = logging.getLogger(__name__)


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


def store_jobspy_results(conn: sqlite3.Connection, df, source_label: str, limit: int = 0) -> tuple[int, int]:
    """Store JobSpy DataFrame results into the DB. Returns (new, existing)."""
    now = datetime.now(timezone.utc).isoformat()
    new = 0
    existing = 0

    for _, row in df.iterrows():
        if limit > 0 and new + existing >= limit:
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

        description = str(row.get("description", "")) if str(row.get("description", "")) != "nan" else None
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

        # Extract apply URL if JobSpy provided it
        apply_url = str(row.get("job_url_direct", "")) if str(row.get("job_url_direct", "")) != "nan" else None

        try:
            conn.execute(
                "INSERT INTO jobs (url, title, company, salary, description, location, site, strategy, discovered_at, "
                "full_description, application_url, detail_scraped_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    url,
                    title,
                    company,
                    salary,
                    description,
                    location_str,
                    site_label,
                    strategy,
                    now,
                    full_description,
                    apply_url,
                    detail_scraped_at,
                ),
            )
            new += 1
        except sqlite3.IntegrityError:
            if company:
                cursor = conn.execute(
                    "UPDATE jobs SET company = ? WHERE url = ? AND (company IS NULL OR company = '')",
                    (company, url),
                )
                if cursor.rowcount:
                    from jobhunter.state import record_job_event

                    record_job_event(
                        conn,
                        url,
                        "discover",
                        "JobMetadataUpdated",
                        message="Job company backfilled from JobSpy",
                        payload={"company": company, "source": site_label},
                        occurred_at=now,
                    )
            resurface_deleted_job(conn, url, resurfaced_at=now)
            existing += 1

    conn.commit()
    return new, existing


def _nullable_str(value: object) -> str | None:
    text = str(value).strip()
    if not text or text == "nan":
        return None
    return text


def _truthy_remote(value: object) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().casefold()
    return text in {"1", "true", "yes", "remote"}


def _title_ok(title: str | None, query: str | None) -> bool:
    return title_matches_query(title, query)


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
            ),
            axis=1,
        )
    ]
    title_filtered = after_location - len(df)
    filtered = location_filtered + title_filtered

    conn = get_connection()
    new, existing = store_jobspy_results(conn, df, s["query"], limit=limit)

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

    try:
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
                }
            )

    proxy_config = parse_proxy(proxy) if proxy else None

    log.info("Full crawl: %d search combinations", len(searches))
    log.info("Sites: %s | Results/site: %d | Hours old: %d", ", ".join(sites), results_per_site, hours_old)

    # Ensure DB schema is ready
    init_db()

    total_new = 0
    total_existing = 0
    total_errors = 0
    total_found = 0
    total_filtered = 0
    completed = 0

    for s in searches:
        remaining = max(limit - (total_new + total_existing), 0) if limit > 0 else 0
        if limit > 0 and remaining <= 0:
            break
        result = _run_one_search(
            s,
            sites,
            min(results_per_site, remaining) if limit > 0 else results_per_site,
            hours_old,
            proxy_config,
            defaults,
            max_retries,
            accept_locs,
            reject_locs,
            local_accept_locs,
            glassdoor_map,
            limit=remaining if limit > 0 else 0,
        )
        completed += 1
        total_new += result["new"]
        total_existing += result["existing"]
        total_errors += result["errors"]
        total_found += result.get("total", 0)
        total_filtered += result.get("filtered", 0)

        if completed % 5 == 0 or completed == len(searches):
            log.info(
                "Progress: %d/%d queries done (%d new, %d dupes, %d errors)",
                completed,
                len(searches),
                total_new,
                total_existing,
                total_errors,
            )

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


def run_discovery(cfg: dict | None = None, limit: int = 0) -> dict:
    """Main entry point for JobSpy-based job discovery.

    Loads search queries and locations from the user's search config YAML,
    then runs a full crawl across all configured job boards.

    Args:
        cfg: Override the search configuration dict. If None, loads from
             the user's searches.yaml file.

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
    )
