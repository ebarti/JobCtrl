"""Reviewed history proposals in the existing Discovery queue and event ledger.

Coordinates parse URL syntax, never employer identity or posting meaning. The
explicit proposal command validates public destinations but never fetches them.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

from jobctrl.infrastructure.network.url_safety import PublicUrlDecision, validate_public_http_url
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.state import record_job_event, utc_now


@dataclass(frozen=True)
class SourceCoordinate:
    url: str
    source_id: str
    ats_kind: str | None
    board_token: str | None

    @property
    def candidate_id(self) -> str:
        return "locator:" + hashlib.sha256(self.url.encode()).hexdigest()[:16]


def source_coordinate(raw_url: str) -> SourceCoordinate | None:
    """A conservative, local parse; fetching still requires network policy checks."""
    if not isinstance(raw_url, str) or re.search(r"[\s\\\x00-\x1f\x7f]", raw_url):
        return None
    try:
        parsed = urlsplit(raw_url)
        host = (parsed.hostname or "").lower().rstrip(".").encode("idna").decode("ascii")
        port = parsed.port
    except (ValueError, UnicodeError):
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 80, 443}
    ):
        return None
    if (
        ":" in host
        or "." not in host
        or host.endswith((".localhost", ".local", ".internal", ".lan", ".home", ".localdomain"))
    ):
        return None
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global:
            return None
    except ValueError:
        if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in host.split(".")):
            return None
        # Reject alternative numeric IP spellings accepted by browser URL parsers.
        if re.fullmatch(r"[0-9a-fx.]+", host) and any(
            part.startswith("0x") or part.isdigit() for part in host.split(".")
        ):
            return None
    parts = [part for part in parsed.path.split("/") if part]
    kind: str | None = None
    token: str | None = None
    board_host = host
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io", "boards-api.greenhouse.io"}:
        kind = "greenhouse"
        if host == "boards-api.greenhouse.io":
            token = parts[2] if len(parts) >= 3 and parts[:2] == ["v1", "boards"] else None
        else:
            token = parts[0] if parts else None
        board_host = "boards.greenhouse.io"
    elif host in {"jobs.lever.co", "api.lever.co", "jobs.eu.lever.co", "api.eu.lever.co"}:
        kind = "lever"
        token = (
            (parts[2] if len(parts) >= 3 and parts[:2] == ["v0", "postings"] else None)
            if host.startswith("api.")
            else (parts[0] if parts else None)
        )
        board_host = "jobs.eu.lever.co" if ".eu." in host else "jobs.lever.co"
    elif host in {"jobs.ashbyhq.com", "api.ashbyhq.com"}:
        kind = "ashby"
        token = (
            (parts[2] if len(parts) >= 3 and parts[:2] == ["posting-api", "job-board"] else None)
            if host.startswith("api.")
            else (parts[0] if parts else None)
        )
        board_host = "jobs.ashbyhq.com"
    elif host.endswith(".myworkdayjobs.com"):
        kind = "workday"
        if parts and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", parts[0]):
            parts = parts[1:]
        token = (
            parts[3] if len(parts) >= 4 and parts[0] == "wday" and parts[1] == "cxs" else (parts[0] if parts else None)
        )
    if kind:
        if not token or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
            return None
        # Registry identity retains literal board tokens and regional hosts;
        # display slugs must not collapse distinct provider coordinates.
        source_token = f"eu:{token}" if kind == "lever" and board_host == "jobs.eu.lever.co" else token
        if kind == "workday":
            source_token = f"{host}:{token}"
        return SourceCoordinate(f"https://{board_host}/{token}", f"{kind}:{source_token}", kind, token)
    return SourceCoordinate(f"https://{host}/", f"employer_careers_page:{host}", None, None)


def review_state(conn: sqlite3.Connection, coordinate: SourceCoordinate) -> tuple[str | None, int]:
    row = conn.execute(
        """SELECT event_id, event_type, payload_json FROM job_events
           WHERE tenant_id = 'local' AND entity_kind = 'discovery' AND entity_ref = ?
             AND json_valid(payload_json)
             AND (event_type = 'SourceLocationCandidateReviewed'
                  OR (event_type = 'SourceLocationCandidateDiscovered'
                      AND json_extract(payload_json, '$.proposalOnly') = 1))
           ORDER BY event_id DESC LIMIT 1""",
        (coordinate.url,),
    ).fetchone()
    if row is None:
        return None, 0
    payload = json.loads(row["payload_json"])
    decision = payload.get("decision") if row["event_type"] == "SourceLocationCandidateReviewed" else "pending"
    if decision not in {"pending", "promote", "reject", "reset"}:
        decision = "invalid"
    return decision, int(row["event_id"])


def registry_overlaps(
    conn: sqlite3.Connection,
    coordinate: SourceCoordinate,
    *,
    held_only: bool = False,
) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT source_id, state, seed_url FROM source_registry_entries WHERE tenant_id = 'local' "
            "AND (? = 0 OR state IN ('disabled', 'quarantined'))",
            (int(held_only),),
        )
        if row["source_id"] == coordinate.source_id
        or (row["seed_url"] and source_coordinate(row["seed_url"]) == coordinate)
    ]


def automatic_learning_blocked(conn: sqlite3.Connection, url: str) -> bool:
    coordinate = source_coordinate(url)
    if coordinate is None:
        return True
    state, _ = review_state(conn, coordinate)
    return state in {"pending", "reject", "reset", "invalid"} or bool(registry_overlaps(conn, coordinate, held_only=True))


def propose_posting_source(
    conn: sqlite3.Connection,
    url: str,
    evidence: dict[str, Any],
    *,
    validator: Callable[[str], PublicUrlDecision] | None = None,
) -> tuple[str, str | None]:
    coordinate = source_coordinate(url)
    if coordinate is None or not (validator or validate_public_http_url)(url).allowed:
        return "invalid", None
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    decision, _ = review_state(conn, coordinate)
    if decision in {"reject", "invalid"} or registry_overlaps(conn, coordinate, held_only=True):
        return "suppressed", coordinate.candidate_id
    if decision == "promote":
        return "unchanged", coordinate.candidate_id
    # A retry reuses the evidence receipt; reset/promotion starts a new review epoch.
    epoch_row = conn.execute(
        """SELECT COALESCE(MAX(event_id), 0) FROM job_events
           WHERE tenant_id = 'local' AND entity_kind = 'discovery' AND entity_ref = ?
             AND event_type = 'SourceLocationCandidateReviewed' AND json_valid(payload_json)""",
        (coordinate.url,),
    ).fetchone()
    epoch = int(epoch_row[0])
    receipt = json.dumps(evidence, sort_keys=True, ensure_ascii=False)
    fingerprint = hashlib.sha256(receipt.encode()).hexdigest()
    key = f"source-proposal:{coordinate.candidate_id}:{epoch}:{fingerprint}"
    exists = conn.execute(
        "SELECT 1 FROM job_events WHERE tenant_id = 'local' AND idempotency_key = ?", (key,)
    ).fetchone()
    now = utc_now()
    conn.execute(
        """INSERT INTO source_locator_candidates (
             tenant_id, candidate_id, candidate_url, source_kind, confidence,
             detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at
           ) VALUES ('local', ?, ?, ?, 0, ?, 0, 'ambiguous_career_system', ?)
           ON CONFLICT(tenant_id, candidate_id) DO NOTHING""",
        (
            coordinate.candidate_id,
            coordinate.url,
            "ats_api" if coordinate.ats_kind else "employer_careers_page",
            coordinate.ats_kind,
            now,
        ),
    )
    # Replace posting-specific queue aliases with the one board coordinate.
    for row in conn.execute(
        "SELECT candidate_id, candidate_url FROM source_locator_candidates WHERE tenant_id = 'local'"
    ).fetchall():
        if row["candidate_id"] != coordinate.candidate_id and source_coordinate(row["candidate_url"]) == coordinate:
            conn.execute(
                "DELETE FROM source_locator_candidates WHERE tenant_id = 'local' AND candidate_id = ?",
                (row["candidate_id"],),
            )
    if not exists:
        record_job_event(
            conn,
            None,
            "discover",
            "SourceLocationCandidateDiscovered",
            entity_kind="discovery",
            entity_ref=coordinate.url,
            idempotency_key=key,
            message="Saved posting history proposed a source for explicit review.",
            payload={
                "candidateId": coordinate.candidate_id,
                "candidateUrl": coordinate.url,
                "sourceKind": "ats_api" if coordinate.ats_kind else "employer_careers_page",
                "confidence": 0,
                "evidenceRef": key,
                "discoveredAt": now,
                "proposalOnly": True,
                "coordinateKey": coordinate.url,
                "sourceId": coordinate.source_id,
                "boardToken": coordinate.board_token,
                "completeness": "unknown",
                "evidence": evidence,
            },
        )
    return "proposed" if not exists else "unchanged", coordinate.candidate_id


def propose_from_history(conn: sqlite3.Connection, *, job_id: str | None = None) -> dict[str, Any]:
    """Explicit local scan; canonical current URLs only, never historical apply aliases."""
    from jobctrl.infrastructure.discovery.production_wiring import learn_posting_source_from_url

    counts = {"proposed": 0, "unchanged": 0, "suppressed": 0, "invalid": 0}
    if job_id is not None:
        job_id = str(canonical_job_id(job_id))
    rows = conn.execute(
        """SELECT j.job_id, j.url, j.title, j.company, j.description, j.discovered_at,
                  e.application_url, e.full_description, e.extraction_tier, e.enriched_at,
                  s.latest_snapshot_version, s.snapshot_set_json, c.canonical_url,
                  COALESCE(l.locator_value, j.url) AS posting_url
           FROM jobs j
           LEFT JOIN job_enrichments e ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id
           LEFT JOIN posting_snapshot_sets s ON s.tenant_id = j.tenant_id AND s.job_id = j.job_id
           LEFT JOIN job_canonical_identities c ON c.tenant_id = j.tenant_id AND c.job_id = j.job_id
           LEFT JOIN job_locators l ON l.tenant_id = j.tenant_id AND l.job_id = j.job_id AND l.is_current = 1
           WHERE j.tenant_id = 'local' AND (? IS NULL OR j.job_id = ?) ORDER BY j.job_id""",
        (job_id, job_id),
    ).fetchall()
    decisions: dict[str, PublicUrlDecision] = {}
    for row in rows:
        for url in (row["posting_url"], row["canonical_url"], row["application_url"]):
            if url and url not in decisions:
                decisions[url] = validate_public_http_url(url) if source_coordinate(url) else PublicUrlDecision(False)
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    for row in rows:
        observations = [
            dict(item)
            for item in conn.execute(
                """SELECT source_observation_id AS observationId, source_id AS sourceId, run_id AS runId,
                      observed_url AS observedUrl, observed_at AS observedAt
               FROM job_source_observations WHERE tenant_id = 'local' AND job_id = ?
               ORDER BY source_observation_id""",
                (row["job_id"],),
            )
        ]
        description = str(row["full_description"] or row["description"] or "")
        snapshot_evidence: list[str] = []
        if row["snapshot_set_json"]:
            try:
                snapshot_set = json.loads(row["snapshot_set_json"])
                for snapshot in snapshot_set.get("snapshots", []):
                    if snapshot.get("snapshot_version") == row["latest_snapshot_version"]:
                        snapshot_evidence = [item for item in snapshot.get("evidence", []) if isinstance(item, str)]
            except (ValueError, TypeError, AttributeError):
                pass  # No inferred evidence when the saved snapshot is unavailable.
        extraction = {
            "tier": row["extraction_tier"],
            "enrichedAt": row["enriched_at"],
            "snapshotVersion": row["latest_snapshot_version"],
            "snapshotEvidence": snapshot_evidence,
            "descriptionSha256": hashlib.sha256(description.encode()).hexdigest() if description else None,
            "snapshotSha256": hashlib.sha256(row["snapshot_set_json"].encode()).hexdigest()
            if row["snapshot_set_json"]
            else None,
        }
        for kind, url in (
            ("posting_url", row["posting_url"]),
            ("canonical_url", row["canonical_url"]),
            ("application_url", row["application_url"]),
        ):
            if not url:
                continue
            evidence = {
                "originJobId": row["job_id"],
                "originPostingUrl": row["posting_url"],
                "inputUrl": url,
                "urlKind": kind,
                "observations": observations,
                "extraction": extraction,
                "sample": {
                    "title": row["title"] or "",
                    "company": row["company"] or "",
                    "descriptionExcerpt": description[:480],
                },
            }
            outcome = learn_posting_source_from_url(
                conn,
                job_url=row["posting_url"],
                posting_url=url,
                discovered_via_source_id="saved_history",
                observed_at=row["discovered_at"] or "",
                proposal_only=True,
                proposal_evidence=evidence,
                proposal_url_validator=decisions.__getitem__,
            )
            counts[outcome.action] += 1
    return {"ok": True, "counts": counts, "completeness": "unknown"}


def reset_suppression(conn: sqlite3.Connection, candidate_id: str) -> dict[str, Any]:
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        """SELECT payload_json FROM job_events WHERE tenant_id = 'local'
           AND event_type = 'SourceLocationCandidateReviewed' AND json_valid(payload_json)
           AND json_extract(payload_json, '$.candidateId') = ? ORDER BY event_id DESC LIMIT 1""",
        (candidate_id,),
    ).fetchone()
    if row is None or json.loads(row["payload_json"]).get("decision") != "reject":
        raise ValueError("No rejected proposal with this candidate ID. List review history first.")
    payload = json.loads(row["payload_json"])
    record_job_event(
        conn,
        None,
        "discover",
        "SourceLocationCandidateReviewed",
        entity_kind="discovery",
        entity_ref=payload["coordinateKey"],
        message="User explicitly reset source proposal suppression.",
        payload={
            "candidateId": candidate_id,
            "coordinateKey": payload["coordinateKey"],
            "decision": "reset",
            "reason": "Explicit CLI reset",
            "decidedAt": utc_now(),
        },
    )
    return {"ok": True, "candidateId": candidate_id, "decision": "reset"}


def list_proposals(conn: sqlite3.Connection) -> dict[str, Any]:
    """Read saved receipts/decisions, including suppressed history, with no writes."""
    events = conn.execute(
        """SELECT event_id AS eventId, event_type AS eventType, occurred_at AS occurredAt, payload_json
           FROM job_events WHERE tenant_id = 'local'
           AND event_type IN ('SourceLocationCandidateDiscovered', 'SourceLocationCandidateReviewed')
           AND json_valid(payload_json) AND json_extract(payload_json, '$.coordinateKey') IS NOT NULL
           ORDER BY event_id"""
    ).fetchall()
    return {
        "ok": True,
        "history": [
            {
                "eventId": row["eventId"],
                "eventType": row["eventType"],
                "occurredAt": row["occurredAt"],
                "receipt": json.loads(row["payload_json"]),
            }
            for row in events
        ],
        "candidates": [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM source_locator_candidates WHERE tenant_id = 'local' ORDER BY candidate_id"
            )
        ],
    }
