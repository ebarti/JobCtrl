"""Persist every intake row before spending, then join admission by listing ID."""

import hashlib
import json
from dataclasses import asdict
from datetime import datetime, timezone

from jobctrl.domain.determinations import DeterminationFailure, Source, validate_citations, parse_model_result
from jobctrl.domain.discovery.triage import (
    DEFAULT_TRIAGE_BATCH_SIZE,
    MAX_TRIAGE_BATCH_SIZE,
    TRIAGE_PROMPT_VERSION,
    TRIAGE_SCHEMA_VERSION,
    IntakeSnapshot,
    Listing,
    ModelPostingTriage,
    PostingTriage,
)
from jobctrl.infrastructure.determinations import determination_dependencies


def fingerprint(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def listing_id(source_id: str, url: str, **snapshot) -> str:
    return fingerprint({"source_id": source_id, "url": url, **snapshot})


def saved_targets(search_cfg: dict) -> tuple[list[Source], dict]:
    # Config exposes literal saved profile fields. No title expansion, geography
    # aliasing or source selection is performed while loading those fields.
    target = dict(search_cfg.get("confirmed_targets") or {})
    from jobctrl.domain.profile.search_targets import search_target_sources

    sources = search_target_sources(search_cfg)
    return sources, {
        "profile_version": target.get("profile_version"),
        "exact_title_exclusions": list(search_cfg.get("exact_title_exclusions") or []),
    }


def triage_listings(
    conn, listings: list[Listing], *, search_cfg: dict, tenant_id="local", dependencies=None, postings=None
):
    batch_size = search_cfg.get("triage_batch_size", DEFAULT_TRIAGE_BATCH_SIZE)
    if type(batch_size) is not int or not 1 <= batch_size <= MAX_TRIAGE_BATCH_SIZE:
        raise ValueError("triage_batch_size must be an integer between 1 and 100")
    dependencies = dependencies or determination_dependencies(
        conn, tenant_id=tenant_id, lane="discovery", model_spec=search_cfg.get("triage_model")
    )
    targets, preferences = saved_targets(search_cfg)
    target_key = fingerprint(
        {
            "targets": [source.model_dump() for source in targets],
            "preferences": preferences,
            "schema": TRIAGE_SCHEMA_VERSION,
            "prompt": TRIAGE_PROMPT_VERSION,
            "provider": dependencies["provider"],
            "model": dependencies["model"],
        }
    )
    now = datetime.now(timezone.utc).isoformat()
    decisions, pending = {}, []
    unique = {}
    for listing in listings:
        if listing.listing_id in unique and unique[listing.listing_id] != listing:
            raise DeterminationFailure("conflicting_listing_snapshot")
        unique[listing.listing_id] = listing
    for listing in unique.values():
        snapshot_payload = IntakeSnapshot(
            listing=listing, target_sources=targets, profile_version=preferences["profile_version"]
        )
        captured_json = snapshot_payload.model_dump_json()
        snapshot = fingerprint(listing.model_dump())
        posting_json = json.dumps(asdict(postings[listing.listing_id]), ensure_ascii=False) if postings else None
        row = conn.execute(
            "SELECT status,determination_id,listing_json FROM posting_triage WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=?",
            (tenant_id, listing.listing_id, snapshot, target_key),
        ).fetchone()
        if row and posting_json is not None:
            conn.execute(
                "UPDATE posting_triage SET posting_json=? WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=?",
                (posting_json, tenant_id, listing.listing_id, snapshot, target_key),
            )
        if listing.title.strip().casefold() in {
            str(value).strip().casefold() for value in preferences["exact_title_exclusions"]
        }:
            conn.execute(
                "INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,status,reason_code,created_at) VALUES (?,?,?,?,?,?,'literal_excluded','literal_exact_title_exclusion',?) ON CONFLICT DO NOTHING",
                (
                    tenant_id,
                    listing.listing_id,
                    snapshot,
                    target_key,
                    listing.source_id,
                    captured_json,
                    now,
                ),
            )
            decisions[listing.listing_id] = "literal_excluded"
            continue
        if row and row[0] != "pending_triage":
            try:
                captured = IntakeSnapshot.model_validate_json(row[2])
            except ValueError:
                raise DeterminationFailure("cache_binding_invalid") from None
            if captured != snapshot_payload:
                raise DeterminationFailure("cache_binding_invalid")
            envelope = dependencies["repository"].find(tenant_id, row[1])
            if (
                envelope is None
                or envelope.kind != "posting_triage"
                or any(
                    (
                        envelope.tenant_id != str(tenant_id),
                        envelope.entity_id != "discovery:intake",
                        envelope.schema_version != TRIAGE_SCHEMA_VERSION,
                        envelope.prompt_version != TRIAGE_PROMPT_VERSION,
                        envelope.provider != dependencies["provider"],
                        envelope.model != dependencies["model"],
                        envelope.lane != "discovery",
                        envelope.determination_id != envelope.input_fingerprint,
                    )
                )
            ):
                raise DeterminationFailure("cache_binding_invalid")
            result = parse_model_result(PostingTriage, envelope.result)
            decision = next((item for item in result.listings if item.listing_id == listing.listing_id), None)
            if decision is None or decision.verdict != row[0]:
                raise DeterminationFailure("cache_binding_invalid")
            allowed = [
                *(
                    Source(source_id=f"listing:{listing.listing_id}:{field}", text=str(getattr(listing, field)))
                    for field in ("url", "title", "company", "location", "remote")
                ),
                *targets,
            ]
            validate_citations(decision, allowed)
            decisions[listing.listing_id] = decision.verdict
            continue
        conn.execute(
            "INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,posting_json,status,created_at) VALUES (?,?,?,?,?,?,?,'pending_triage',?) ON CONFLICT DO NOTHING",
            (
                tenant_id,
                listing.listing_id,
                snapshot,
                target_key,
                listing.source_id,
                captured_json,
                posting_json,
                now,
            ),
        )
        pending.append(listing)
        decisions[listing.listing_id] = "pending_triage"
    conn.commit()
    service = ModelPostingTriage(**{key: value for key, value in dependencies.items() if key != "lane"})
    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        try:
            result, envelope = service.triage(listings=batch, targets=targets, preferences=preferences)
        except DeterminationFailure as exc:
            for listing in batch:
                conn.execute(
                    "UPDATE posting_triage SET failure_code=?,last_attempt_at=? WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=? AND status='pending_triage'",
                    (
                        exc.code,
                        datetime.now(timezone.utc).isoformat(),
                        tenant_id,
                        listing.listing_id,
                        fingerprint(listing.model_dump()),
                        target_key,
                    ),
                )
            conn.commit()
            raise
        snapshots = {listing.listing_id: fingerprint(listing.model_dump()) for listing in batch}
        conn.execute("SAVEPOINT triage_bind")
        try:
            for decision in result.listings:
                conn.execute(
                    "UPDATE posting_triage SET status=?,reason_code=?,determination_id=?,failure_code=NULL,last_attempt_at=NULL WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=?",
                    (
                        decision.verdict,
                        decision.reason_code,
                        envelope.determination_id,
                        tenant_id,
                        decision.listing_id,
                        snapshots[decision.listing_id],
                        target_key,
                    ),
                )
                decisions[decision.listing_id] = decision.verdict
            conn.execute("RELEASE triage_bind")
        except BaseException:
            conn.execute("ROLLBACK TO triage_bind")
            conn.execute("RELEASE triage_bind")
            raise
    return decisions


def posting_listing(posting):
    fields = dict(
        title=posting.metadata.title,
        company=posting.employer.name,
        location=posting.metadata.location or "",
        remote=posting.structured_remote,
    )
    return Listing(
        listing_id=listing_id(posting.source_id, posting.posting_url.value, **fields),
        source_id=posting.source_id,
        url=posting.posting_url.value,
        **fields,
    )


def triage_postings(conn, postings, *, search_cfg, tenant_id="local", dependencies=None):
    postings = list(postings)
    listings = [posting_listing(posting) for posting in postings]
    decisions = triage_listings(
        conn,
        listings,
        search_cfg=search_cfg,
        tenant_id=tenant_id,
        dependencies=dependencies,
        postings={listing.listing_id: posting for listing, posting in zip(listings, postings, strict=True)},
    )
    return [
        posting for posting, listing in zip(postings, listings, strict=True) if decisions[listing.listing_id] == "admit"
    ]


class PersistedPostingTriage:
    """The intake port used by every discovery write entry point."""

    def __init__(self, connection, *, search_cfg=None, dependencies=None):
        self._connection = connection
        self._search_cfg = search_cfg
        self._dependencies = dependencies

    def admit(self, *, tenant_id, postings):
        from jobctrl import config

        return triage_postings(
            self._connection,
            postings,
            search_cfg=self._search_cfg if self._search_cfg is not None else config.load_search_config(),
            tenant_id=str(tenant_id),
            dependencies=self._dependencies,
        )

    def complete(self, *, tenant_id, postings):
        """Acknowledge intake only after every admitted posting was ingested."""
        now = datetime.now(timezone.utc).isoformat()
        for posting in postings:
            listing = posting_listing(posting)
            self._connection.execute(
                "UPDATE posting_triage SET consumed_at=? WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND consumed_at IS NULL",
                (now, str(tenant_id), listing.listing_id, fingerprint(listing.model_dump())),
            )
        self._connection.commit()


def retry_pending_postings(
    conn,
    *,
    search_cfg,
    tenant_id="local",
    discovery_execution=None,
    source_ids=(),
    dependencies=None,
    source_family=None,
    limit=0,
    max_batches=1,
    cancel_event=None,
):
    """Recover a bounded batch inside the heartbeating source-family activity."""
    from pydantic import TypeAdapter
    from jobctrl.domain.ports.discovery import ScrapedJobPosting
    from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase
    from jobctrl.domain.discovery.value_objects import SearchStrategy
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher

    batch_size = search_cfg.get("triage_batch_size", DEFAULT_TRIAGE_BATCH_SIZE)
    if type(batch_size) is not int or not 1 <= batch_size <= MAX_TRIAGE_BATCH_SIZE:
        raise ValueError("triage_batch_size must be an integer between 1 and 100")
    if type(max_batches) is not int or max_batches < 1:
        raise ValueError("max_batches must be a positive integer")
    source_clause = " AND source_id IN (" + ",".join("?" for _ in source_ids) + ")" if source_ids else ""
    source_families = {
        SearchStrategy.JOBSPY: "jobspy",
        SearchStrategy.SMART_EXTRACT: "smartextract",
        SearchStrategy.MANUAL: "ats_api",
    }
    resumed = 0
    for _ in range(max_batches):
        if cancel_event is not None and cancel_event.is_set():
            return resumed
        row_limit = min(batch_size, limit - resumed) if limit > 0 else batch_size
        if row_limit <= 0:
            return resumed
        rows = conn.execute(
            "SELECT posting_json FROM posting_triage WHERE tenant_id=? AND consumed_at IS NULL AND posting_json IS NOT NULL AND status IN ('pending_triage','admit','superseded')"
            + source_clause
            + " ORDER BY created_at,listing_id LIMIT ?",
            (str(tenant_id), *source_ids, row_limit),
        ).fetchall()
        if not rows:
            return resumed
        postings = list(dict.fromkeys(row[0] for row in rows))
        postings = [TypeAdapter(ScrapedJobPosting).validate_json(value) for value in postings]

        def family_for(posting):
            if posting.strategy == SearchStrategy.WORKDAY_API:
                return "workday" if posting.source_id.startswith("workday:") else "ats_api"
            return source_families[posting.strategy]

        if source_family is not None:
            postings = [posting for posting in postings if family_for(posting) == source_family]
        if not postings:
            return resumed
        triage = PersistedPostingTriage(conn, search_cfg=search_cfg, dependencies=dependencies)
        # Spend on a single batch before dispatching each admitted row through
        # its original source family and the current execution's write fences.
        triage.admit(tenant_id=TenantId(str(tenant_id)), postings=postings)
        for posting in postings:
            if cancel_event is not None and cancel_event.is_set():
                return resumed
            if limit > 0 and resumed >= limit:
                return resumed
            repository = SqliteJobRepository(
                conn,
                discovery_execution=discovery_execution,
                source_family=family_for(posting) if discovery_execution else None,
            )
            summary = DiscoverJobsUseCase(
                repository=repository,
                publisher=DurableJobEventPublisher(conn, stage="discover"),
                triage=triage,
            ).execute(tenant_id=TenantId(str(tenant_id)), postings=[posting])
            resumed += summary.new_jobs
    return resumed
