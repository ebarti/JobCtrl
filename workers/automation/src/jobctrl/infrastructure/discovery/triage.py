"""Persist every intake row before spending, then join admission by listing ID."""

import hashlib
import json
from datetime import datetime, timezone

from jobctrl.domain.determinations import DeterminationFailure, Source, validate_citations, parse_model_result
from jobctrl.domain.discovery.triage import (
    DEFAULT_TRIAGE_BATCH_SIZE,
    MAX_TRIAGE_BATCH_SIZE,
    TRIAGE_PROMPT_VERSION,
    TRIAGE_SCHEMA_VERSION,
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


def confirmed_targets(search_cfg: dict) -> tuple[list[Source], dict]:
    # Config exposes literal saved profile fields. No title expansion, geography
    # aliasing or source selection is performed while loading those fields.
    target = dict(search_cfg.get("confirmed_targets") or {})
    sources = []
    for key in (
        "roles",
        "tracks",
        "seniority",
        "functions",
        "specializations",
        "locations",
        "work_models",
        "exclusions",
        "criteria",
    ):
        for index, value in enumerate(target.get(key) or []):
            sources.append(Source(source_id=f"target:{key}:{index}", text=str(value)))
    return sources, {
        "profile_version": target.get("profile_version"),
        "exact_title_exclusions": list(search_cfg.get("exact_title_exclusions") or []),
    }


def triage_listings(conn, listings: list[Listing], *, search_cfg: dict, tenant_id="local", dependencies=None):
    batch_size = search_cfg.get("triage_batch_size", DEFAULT_TRIAGE_BATCH_SIZE)
    if type(batch_size) is not int or not 1 <= batch_size <= MAX_TRIAGE_BATCH_SIZE:
        raise ValueError("triage_batch_size must be an integer between 1 and 100")
    dependencies = dependencies or determination_dependencies(
        conn, tenant_id=tenant_id, lane="discovery", model_spec=search_cfg.get("triage_model")
    )
    targets, preferences = confirmed_targets(search_cfg)
    from jobctrl.infrastructure.profile.search_preferences import read_search_preferences, preferences_version

    confirmed = read_search_preferences(conn, search_cfg, tenant_id=tenant_id, confirmed=True)
    preferences_id = confirmed[1].determination_id if confirmed else None
    target_key = fingerprint(
        {
            "preferences_version": preferences_version(search_cfg),
            "preferences_id": preferences_id,
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
        snapshot = fingerprint(listing.model_dump())
        row = conn.execute(
            "SELECT status,determination_id FROM posting_triage WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=?",
            (tenant_id, listing.listing_id, snapshot, target_key),
        ).fetchone()
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
                    json.dumps(listing.model_dump(), ensure_ascii=False),
                    now,
                ),
            )
            decisions[listing.listing_id] = "literal_excluded"
            continue
        if row and row[0] != "pending_triage":
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
            from jobctrl.infrastructure.profile.search_preferences import require_confirmed_search_preferences

            confirmed_sources, _ = require_confirmed_search_preferences(conn, search_cfg, tenant_id=tenant_id)
            allowed = [
                *(
                    Source(source_id=f"listing:{listing.listing_id}:{field}", text=str(getattr(listing, field)))
                    for field in ("url", "title", "company", "location", "remote")
                ),
                *confirmed_sources,
            ]
            validate_citations(decision, allowed)
            decisions[listing.listing_id] = decision.verdict
            continue
        conn.execute(
            "INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,status,created_at) VALUES (?,?,?,?,?,?,'pending_triage',?) ON CONFLICT DO NOTHING",
            (
                tenant_id,
                listing.listing_id,
                snapshot,
                target_key,
                listing.source_id,
                json.dumps(listing.model_dump(), ensure_ascii=False),
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
            from jobctrl.infrastructure.profile.search_preferences import require_confirmed_search_preferences

            confirmed_sources, confirmed_preferences = require_confirmed_search_preferences(
                conn, search_cfg, tenant_id=tenant_id
            )
            result, envelope = service.triage(
                listings=batch, targets=confirmed_sources, preferences=confirmed_preferences
            )
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
                    "UPDATE posting_triage SET status=?,reason_code=?,determination_id=?,preferences_determination_id=?,failure_code=NULL,last_attempt_at=NULL WHERE tenant_id=? AND listing_id=? AND snapshot_fingerprint=? AND target_fingerprint=?",
                    (
                        decision.verdict,
                        decision.reason_code,
                        envelope.determination_id,
                        confirmed_preferences["determination_id"],
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


def triage_postings(conn, postings, *, search_cfg, tenant_id="local", dependencies=None):
    postings = list(postings)
    listings = [
        Listing(
            listing_id=listing_id(
                posting.source_id,
                posting.posting_url.value,
                title=posting.metadata.title,
                company=posting.employer.name,
                location=posting.metadata.location or "",
                remote=posting.structured_remote,
            ),
            source_id=posting.source_id,
            url=posting.posting_url.value,
            title=posting.metadata.title,
            company=posting.employer.name,
            location=posting.metadata.location or "",
            remote=posting.structured_remote,
        )
        for posting in postings
    ]
    decisions = triage_listings(conn, listings, search_cfg=search_cfg, tenant_id=tenant_id, dependencies=dependencies)
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
