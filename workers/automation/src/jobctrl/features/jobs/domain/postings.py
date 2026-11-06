"""Literal identity and source bookkeeping; semantic decisions arrive as receipts."""

from __future__ import annotations

import hashlib
import ipaddress
import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def posting_url(value: str) -> str:
    """Validate URL syntax without fetching or deciding posting meaning."""
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 33 for c in value) or "\\" in value:
        raise ValueError("A valid public HTTP(S) posting URL is required.")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
    if parsed.scheme not in {"http", "https"} or not host or parsed.username is not None or parsed.password is not None:
        raise ValueError("A valid public HTTP(S) posting URL is required.")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan")):
        raise ValueError("A public posting destination is required.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("A public posting destination is required.")
    port = parsed.port
    if ":" in host:
        host = f"[{host}]"
    authority = host if port is None or port == (443 if parsed.scheme == "https" else 80) else f"{host}:{port}"
    return urlunsplit((parsed.scheme.lower(), authority, parsed.path or "/", parsed.query, ""))


def normalize_url(value: str) -> str:
    parsed = urlsplit(posting_url(value))
    tracking = {"gh_src", "gh_jrid", "gh_id", "ashby_jid", "lever-source", "lever_source", "src", "ref"}
    query = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not k.casefold().startswith("utm_") and k.casefold() not in tracking
    ]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") or "/", urlencode(query), ""))


def identity_keys(posting: dict) -> tuple[str, ...]:
    keys = ["url:" + normalize_url(posting["url"])]
    if posting.get("canonical_url"):
        keys.append("url:" + normalize_url(posting["canonical_url"]))
    if posting.get("source_native_id") and posting.get("source_id"):
        keys.append("native:" + digest([posting["source_id"], posting["source_native_id"]]))
    # Exact full content and supplied employer/title are identity evidence.
    # A listing-only title/employer pair never merges two jobs.
    if all(posting.get(k, "").strip() for k in ("title", "company", "description")):
        keys.append("content:" + digest([posting[k].strip() for k in ("title", "company", "description")]))
    return tuple(dict.fromkeys(keys))


def canonical_posting(data: dict) -> dict:
    def text(*names, default="", limit=64000):
        value = next((data[name] for name in names if data.get(name) is not None), default)
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f"{names[0]} must be text of at most {limit} characters.")
        return value.strip()

    description = text("description", "fullDescription", "full_description", "text")
    full_description = text("full_description", "fullDescription")
    enriched_description = text("enriched_description", "enrichedDescription")
    authority = (data.get("provenance") or {}).get("authority") if isinstance(data.get("provenance"), dict) else None
    if authority in {"user_authored", "source_bound_model"} and description:
        full_description = full_description or description
        enriched_description = enriched_description or full_description
    result = {
        "url": posting_url(text("url", "postingUrl", "posting_url", limit=8192)),
        "canonical_url": text("canonical_url", "canonicalUrl", limit=8192),
        "source_id": text("source_id", "sourceId", default="manual", limit=500),
        "source_native_id": text("source_native_id", "sourceNativeId", limit=8192),
        "title": text("title", limit=2000),
        "company": text("company", "employer", limit=2000),
        "description": description,
        "full_description": full_description,
        "enriched_description": enriched_description,
        "text": description,
        "location": text("location", limit=4000),
        "salary": text("salary", limit=4000),
        "application_url": text("application_url", "applicationUrl", limit=8192),
        "observed_at": text("observed_at", "observedAt", default=utc_now(), limit=100),
        "active_state": text("active_state", "activeState", default="unknown", limit=50),
        "provenance": data.get("provenance") or {},
        "content_state": "accepted_detail"
        if authority in {"user_authored", "source_bound_model"} and full_description
        else "provider_detail"
        if full_description
        else "listing_only",
    }
    if result["canonical_url"]:
        result["canonical_url"] = posting_url(result["canonical_url"])
    if result["application_url"]:
        result["application_url"] = posting_url(result["application_url"])
    if result["active_state"] not in {"unknown", "active", "closed", "expired", "removed", "location_incompatible"}:
        raise ValueError("Invalid posting availability state.")
    if not isinstance(result["provenance"], dict):
        raise ValueError("Posting provenance must be an object.")
    observed = datetime.fromisoformat(result["observed_at"])
    if observed.tzinfo is None:
        raise ValueError("Posting observation timestamps must include their timezone.")
    result["observed_at"] = observed.astimezone(timezone.utc).isoformat()
    result["source_hash"] = digest(
        {
            k: result[k]
            for k in (
                "url",
                "canonical_url",
                "title",
                "company",
                "description",
                "full_description",
                "enriched_description",
                "location",
                "salary",
                "application_url",
                "active_state",
            )
        }
    )
    result["needs_enrichment"] = result["content_state"] != "accepted_detail"
    return result
