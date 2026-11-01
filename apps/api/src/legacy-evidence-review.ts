import type { SqliteDatabase } from "./db.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** Private structural provenance journal. These records are never model determinations. */
export function requiresLegacyEvidenceReview(
  db: SqliteDatabase, tenantId: string, profileId: string, entryId: string, evidenceId: string,
): boolean {
  const row = db.prepare(`SELECT event_id,payload_json FROM job_events
    WHERE tenant_id=? AND event_type='LegacyEvidenceReviewRecorded'
      AND entity_kind='legacy_achievement_evidence' AND entity_ref=?
    ORDER BY event_id DESC LIMIT 1`)
    .get(tenantId, JSON.stringify([profileId, entryId, evidenceId])) as { event_id: number; payload_json: string } | undefined;
  if (!row) return false;
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const result = payload.result as { status?: unknown; original?: unknown; previous_event_id?: unknown; resulting_row_fingerprint?: unknown } | undefined;
  if (payload.schema_version !== 1 || payload.kind !== "legacy_evidence_confirmation_review"
    || payload.tenant_id !== tenantId || payload.profile_id !== profileId
    || payload.entry_id !== entryId || payload.evidence_id !== evidenceId
    || !["migration_inventory", "human_review"].includes(String(payload.author))
    || !["pending_review", "unconfirmed", "confirmed", "rejected"].includes(String(result?.status))
    || !result?.original || typeof result.original !== "object"
    || (payload.author === "migration_inventory" && !["pending_review", "unconfirmed"].includes(String(result.status)))
    || (payload.author === "human_review" && (!["confirmed", "rejected"].includes(String(result.status))
      || typeof result.previous_event_id !== "number" || typeof result.resulting_row_fingerprint !== "string"))) {
    throw new Error("legacy_evidence_review_invalid_history");
  }
  const original = result.original as Record<string, unknown>;
  if (original.tenant_id !== tenantId || original.profile_id !== profileId
    || original.entry_id !== entryId || original.evidence_id !== evidenceId) {
    throw new Error("legacy_evidence_review_invalid_history");
  }
  if (result.status === "unconfirmed" && original.user_confirmed !== 0) {
    throw new Error("legacy_evidence_review_invalid_history");
  }
  if (payload.author === "human_review") {
    const previous = db.prepare(`SELECT payload_json FROM job_events WHERE tenant_id=? AND event_id=? AND event_id<?
      AND event_type='LegacyEvidenceReviewRecorded' AND entity_kind='legacy_achievement_evidence' AND entity_ref=?`)
      .get(tenantId, result.previous_event_id as number, row.event_id, JSON.stringify([profileId, entryId, evidenceId])) as { payload_json: string } | undefined;
    if (!previous || !isDeepStrictEqual((JSON.parse(previous.payload_json) as { result?: { original?: unknown } }).result?.original, original)) {
      throw new Error("legacy_evidence_review_invalid_history");
    }
  }
  if (result.status === "pending_review") return true;
  const rows = db.prepare(`SELECT * FROM candidate_profile_achievement_evidence
    WHERE tenant_id=? AND profile_id=? AND entry_id=? AND evidence_id=?`)
    .all(tenantId, profileId, entryId, evidenceId) as Array<Record<string, unknown>>;
  if (rows.length !== 1) return true;
  const current = rows[0]!;
  if (result.status === "unconfirmed") return typeof current.user_confirmed !== "number" || current.user_confirmed !== 0;
  const confidence = current.claim_confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("legacy_evidence_review_invalid_confidence");
  }
  // Match Python's typed big-endian binary64 field encoding without changing
  // SQLite values or depending on either runtime's JSON exponent formatting.
  const confidenceBytes = Buffer.alloc(8);
  confidenceBytes.writeDoubleBE(confidence);
  const content = Object.fromEntries(Object.keys(current).sort().filter((key) => key !== "evidence_index")
    .map((key) => [key, key === "claim_confidence" ? `binary64:${confidenceBytes.toString("hex")}` : current[key]]));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex") !== result.resulting_row_fingerprint;
}
