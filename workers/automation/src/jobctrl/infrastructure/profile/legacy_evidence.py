"""Structural legacy-confirmation inventories and explicit human review receipts.

These are provenance records, never model judgments. No prose or value shape
establishes authorship. Original cells remain in immutable private job_events records.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

KIND = "legacy_evidence_confirmation_review"
ENTITY_KIND = "legacy_achievement_evidence"


def _json(value: Any) -> str:
    def normalize(item):
        if isinstance(item, dict):
            return {key: normalize(child) for key, child in item.items()}
        if isinstance(item, (list, tuple)):
            return [normalize(child) for child in item]
        return int(item) if isinstance(item, float) and item.is_integer() else item

    return json.dumps(normalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: Any) -> str:
    return hashlib.sha256(_json(value).encode()).hexdigest()


def row_content(row: dict) -> dict:
    return {key: value for key, value in row.items() if key != "evidence_index"}


def evidence_entity(profile_id: str, entry_id: str, evidence_id: str) -> str:
    return _json([profile_id, entry_id, evidence_id])


def evidence_rows(conn: sqlite3.Connection) -> list[dict]:
    cursor = conn.execute("SELECT * FROM candidate_profile_achievement_evidence ORDER BY tenant_id,profile_id,entry_id,evidence_index")
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row, strict=True)) for row in cursor]


def _record(conn: sqlite3.Connection, row: dict, result: dict, *, author: str) -> int:
    entity = evidence_entity(row["profile_id"], row["entry_id"], row["evidence_id"])
    payload = {"schema_version": 1, "kind": KIND, "tenant_id": row["tenant_id"],
               "profile_id": row["profile_id"], "entry_id": row["entry_id"],
               "evidence_id": row["evidence_id"], "author": author, "result": result}
    identity = "legacy-evidence:" + fingerprint(payload)
    if author == "migration_inventory":
        source_time = conn.execute("SELECT updated_at FROM candidate_profiles WHERE tenant_id=? AND profile_id=?",
                                   (row["tenant_id"], row["profile_id"])).fetchone()
        occurred_at = source_time[0] if source_time else "unknown"
        payload["source_recorded_at"] = source_time[0] if source_time else None
        payload["recorded_at"] = None
    else:
        occurred_at = datetime.now(timezone.utc).isoformat()
        payload["recorded_at"] = occurred_at
    conn.execute(
        "INSERT INTO job_events(tenant_id,identity_version,event_type,occurred_at,payload_json,entity_kind,entity_ref,idempotency_key) VALUES(?,1,'LegacyEvidenceReviewRecorded',?,?,?,?,?) ON CONFLICT DO NOTHING",
        (row["tenant_id"], occurred_at, _json(payload), ENTITY_KIND, entity, identity),
    )
    return int(conn.execute("SELECT event_id FROM job_events WHERE idempotency_key=?", (identity,)).fetchone()[0])


def review_receipt(conn, tenant_id, profile_id, entry_id, evidence_id) -> dict | None:
    row = conn.execute(
        "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND event_type='LegacyEvidenceReviewRecorded' AND entity_kind=? AND entity_ref=? ORDER BY event_id DESC LIMIT 1",
        (tenant_id, ENTITY_KIND, evidence_entity(profile_id, entry_id, evidence_id)),
    ).fetchone()
    if not row:
        return None
    payload = json.loads(row[1])
    if (payload.get("schema_version") != 1 or payload.get("kind") != KIND
            or payload.get("tenant_id") != tenant_id or payload.get("profile_id") != profile_id
            or payload.get("entry_id") != entry_id or payload.get("evidence_id") != evidence_id
            or payload.get("author") not in {"migration_inventory", "human_review"}
            or payload.get("result", {}).get("status") not in {"pending_review", "unconfirmed", "confirmed", "rejected"}
            or not isinstance(payload.get("result", {}).get("original"), dict)
            or (payload.get("author") == "migration_inventory" and payload["result"]["status"] not in {"pending_review", "unconfirmed"})
            or (payload.get("author") == "human_review" and (
                payload["result"]["status"] not in {"confirmed", "rejected"}
                or type(payload["result"].get("previous_event_id")) is not int
                or not isinstance(payload["result"].get("resulting_row_fingerprint"), str)))):
        raise LegacyEvidenceReviewError("legacy_evidence_review_invalid_history")
    original = payload["result"]["original"]
    if any(original.get(key) != value for key, value in (
        ("tenant_id", tenant_id), ("profile_id", profile_id), ("entry_id", entry_id), ("evidence_id", evidence_id)
    )):
        raise LegacyEvidenceReviewError("legacy_evidence_review_invalid_history")
    if payload["author"] == "human_review":
        previous = conn.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id=? AND event_id=? AND event_id<? AND event_type='LegacyEvidenceReviewRecorded' AND entity_kind=? AND entity_ref=?",
            (tenant_id, payload["result"]["previous_event_id"], row[0], ENTITY_KIND, evidence_entity(profile_id, entry_id, evidence_id)),
        ).fetchone()
        if not previous or json.loads(previous[0]).get("result", {}).get("original") != original:
            raise LegacyEvidenceReviewError("legacy_evidence_review_invalid_history")
    return {**payload, "event_id": int(row[0])}


def requires_review(conn, tenant_id, profile_id, entry_id, evidence_id) -> bool:
    receipt = review_receipt(conn, tenant_id, profile_id, entry_id, evidence_id)
    if not receipt:
        return False
    if receipt["result"]["status"] == "unconfirmed":
        return False
    if receipt["result"]["status"] == "pending_review":
        return True
    cursor = conn.execute("SELECT * FROM candidate_profile_achievement_evidence WHERE tenant_id=? AND profile_id=? AND entry_id=? AND evidence_id=?",
                          (tenant_id, profile_id, entry_id, evidence_id))
    columns = [item[0] for item in cursor.description]
    rows = [dict(zip(columns, row, strict=True)) for row in cursor]
    return len(rows) != 1 or fingerprint(row_content(rows[0])) != receipt["result"]["resulting_row_fingerprint"]


def record_legacy_inventory(conn: sqlite3.Connection, originals: list[dict], *, include_unconfirmed: bool = False) -> None:
    for row in originals:
        previous = review_receipt(conn, row["tenant_id"], row["profile_id"], row["entry_id"], row["evidence_id"])
        if previous and (previous["author"] == "human_review" or previous["result"]["original"] == row):
            continue
        status = "pending_review" if row["user_confirmed"] == 1 or include_unconfirmed else "unconfirmed"
        _record(conn, row, {"status": status, "reason": "legacy_confirmation_authority_unknown",
                           "original": row}, author="migration_inventory")


class LegacyEvidenceReviewError(RuntimeError):
    """Safe review refusal; does not disclose private source cells."""


def prepare_review(conn: sqlite3.Connection, *, tenant_id: str, profile_id: str) -> list[dict]:
    """Return exact current cells and a token binding the complete current profile."""
    rows = [row for row in evidence_rows(conn) if row["tenant_id"] == tenant_id and row["profile_id"] == profile_id]
    version = conn.execute("SELECT version FROM candidate_profiles WHERE tenant_id=? AND profile_id=?", (tenant_id, profile_id)).fetchone()
    result = []
    seen = set()
    for row in rows:
        seen.add((row["entry_id"], row["evidence_id"]))
        receipt = review_receipt(conn, tenant_id, profile_id, row["entry_id"], row["evidence_id"])
        if not receipt or not requires_review(conn, tenant_id, profile_id, row["entry_id"], row["evidence_id"]):
            continue
        duplicates = sum(other["entry_id"] == row["entry_id"] and other["evidence_id"] == row["evidence_id"] for other in rows)
        original = receipt["result"]["original"]
        conflicting = any(row.get(key) != value for key, value in original.items()
                          if key not in {"seniority_signal", "evidence_index", "evidence_strength", "claim_confidence", "user_confirmed"}
                          and not key.startswith("_"))
        result.append({"current": row, "original": receipt["result"]["original"],
                       "status": "pending_review", "conflict": duplicates != 1 or conflicting,
                       "token": fingerprint({"rows": rows, "version": list(version) if version else None,
                                             "event_id": receipt["event_id"]})})
    history = conn.execute("SELECT entity_ref,payload_json FROM job_events WHERE tenant_id=? AND event_type='LegacyEvidenceReviewRecorded' AND entity_kind=? ORDER BY event_id DESC", (tenant_id, ENTITY_KIND))
    visited = set()
    for entity, raw in history:
        if entity in visited:
            continue
        visited.add(entity)
        payload = json.loads(raw)
        if payload.get("profile_id") != profile_id or payload.get("result", {}).get("status") != "pending_review":
            continue
        if (payload["entry_id"], payload["evidence_id"]) not in seen:
            result.append({"current": None, "original": payload["result"]["original"],
                           "status": "pending_review", "conflict": True,
                           "reason": "current_evidence_missing", "token": None})
    return result


def decide_review(conn: sqlite3.Connection, *, tenant_id: str, profile_id: str,
                  entry_id: str, evidence_id: str, token: str, decision: str) -> int:
    """Confirm/reject current cells only after explicit review; never restore text."""
    if decision not in {"confirm", "reject"} or conn.in_transaction:
        raise LegacyEvidenceReviewError("legacy_evidence_review_refused")
    conn.execute("BEGIN IMMEDIATE")
    try:
        matches = [item for item in prepare_review(conn, tenant_id=tenant_id, profile_id=profile_id)
                   if item["current"] and item["current"]["entry_id"] == entry_id and item["current"]["evidence_id"] == evidence_id]
        if len(matches) != 1 or matches[0]["conflict"] or matches[0]["token"] != token:
            raise LegacyEvidenceReviewError("legacy_evidence_review_stale_or_conflicting")
        item = matches[0]
        row = item["current"]
        original = item["original"]
        # A recovery can expose original cells but cannot quietly replace edits.
        unchanged = {key: value for key, value in original.items() if key not in {"seniority_signal", "evidence_index"} and not key.startswith("_")}
        if any(row[key] != value for key, value in unchanged.items()
               if key not in {"evidence_strength", "claim_confidence", "user_confirmed"}):
            raise LegacyEvidenceReviewError("legacy_evidence_review_source_conflict")
        conn.execute(
            "UPDATE candidate_profile_achievement_evidence SET user_confirmed=? WHERE tenant_id=? AND profile_id=? AND entry_id=? AND evidence_index=? AND evidence_id=?",
            (1 if decision == "confirm" else 0, tenant_id, profile_id, entry_id, row["evidence_index"], evidence_id),
        )
        # User decision authorizes only confirmation, never inferred strength.
        receipt_id = _record(conn, row, {"status": "confirmed" if decision == "confirm" else "rejected",
                                        "original": original, "reviewed": row, "review_token": token,
                                        "resulting_row_fingerprint": fingerprint(row_content({**row, "user_confirmed": 1 if decision == "confirm" else 0})),
                                        "previous_event_id": review_receipt(conn, tenant_id, profile_id, entry_id, evidence_id)["event_id"]}, author="human_review")
        conn.execute("UPDATE candidate_profiles SET version=version+1 WHERE tenant_id=? AND profile_id=?", (tenant_id, profile_id))
        conn.commit()
        return receipt_id
    except BaseException:
        conn.rollback()
        raise
