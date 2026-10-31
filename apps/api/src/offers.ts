import { z } from "zod";
/** Immutable, private Outcomes ledger. Broad events contain references only. */
import { randomUUID } from "node:crypto";
import {
  OfferTermsRevisionSchema,
  OfferDecisionSchema,
  type OfferReadResponse,
  type SaveOfferTerms,
  type RecordOfferDecision,
} from "@jobctrl/contracts";
import type { SqliteDatabase } from "./db.js";
import { recordManualApplicationOutcome } from "./application-feedback.js";

export class OfferConflictError extends Error {}
export class OfferNotFoundError extends Error {}
const TENANT = "local";

export function readOffer(
  db: SqliteDatabase,
  jobId: string,
): OfferReadResponse {
  if (
    !db
      .prepare("SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?")
      .get(TENANT, jobId)
  ) {
    throw new OfferNotFoundError("Job not found.");
  }
  const rows = db
    .prepare(
      `SELECT payload_json FROM job_events
    WHERE tenant_id=? AND job_id=? AND entity_kind='offer' AND entity_ref=?
    ORDER BY event_id ASC`,
    )
    .all(TENANT, jobId, jobId) as { payload_json: string }[];
  const termsHistory: OfferReadResponse["termsHistory"] = [];
  const decisions: OfferReadResponse["decisions"] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      termsRevision?: unknown;
      decision?: unknown;
    };
    if (payload.termsRevision)
      termsHistory.push(OfferTermsRevisionSchema.parse(payload.termsRevision));
    if (payload.decision)
      decisions.push(OfferDecisionSchema.parse(payload.decision));
  }
  return {
    ok: true,
    jobId,
    termsHistory,
    decisions,
    currentTerms: termsHistory.at(-1) ?? null,
    currentDecision: decisions.at(-1) ?? null,
  };
}

export function saveOfferTerms(
  db: SqliteDatabase,
  jobId: string,
  input: SaveOfferTerms,
): OfferReadResponse {
  return db
    .transaction(() => {
      const current = readOffer(db, jobId);
      if (
        (current.currentTerms?.revisionId ?? null) !== input.expectedRevisionId
      ) {
        throw new OfferConflictError(
          "Offer terms changed. Reload before saving.",
        );
      }
      if (current.currentTerms && !input.correctionReason)
        throw new OfferConflictError(
          "A terms revision requires a correction reason.",
        );
      const recordedAt = new Date().toISOString();
      append(db, jobId, recordedAt, {
        termsRevision: { ...input, revisionId: randomUUID(), recordedAt },
      });
      const milestone = db
        .prepare(
          "SELECT 1 FROM application_outcomes WHERE tenant_id=? AND job_id=? AND kind='offer' LIMIT 1",
        )
        .get(TENANT, jobId);
      if (!current.currentTerms && !milestone)
        recordManualApplicationOutcome(db, jobId, { requestId: randomUUID(), kind: "offer" });
      return readOffer(db, jobId);
    })
    .immediate();
}

export function recordOfferDecision(
  db: SqliteDatabase,
  jobId: string,
  input: RecordOfferDecision,
): OfferReadResponse {
  return db
    .transaction(() => {
      const current = readOffer(db, jobId);
      if (current.currentTerms?.revisionId !== input.termsRevisionId)
        throw new OfferConflictError(
          "Review the current offer terms before recording a decision.",
        );
      if (
        (current.currentDecision?.decisionId ?? null) !==
        input.expectedDecisionId
      )
        throw new OfferConflictError(
          "Offer decision changed. Reload before recording a correction.",
        );
      if (current.currentDecision && !input.correctionReason)
        throw new OfferConflictError(
          "A decision correction requires a reason; the previous decision remains in history.",
        );
      const recordedAt = new Date().toISOString();
      append(db, jobId, recordedAt, {
        decision: { ...input, decisionId: randomUUID(), recordedAt },
      });
      return readOffer(db, jobId);
    })
    .immediate();
}

function append(
  db: SqliteDatabase,
  jobId: string,
  recordedAt: string,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO job_events
    (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json,entity_kind,entity_ref)
    VALUES (?,?,1,NULL,'OfferRecordChanged','info',NULL,?,?,'offer',?)`,
  ).run(TENANT, jobId, recordedAt, JSON.stringify(payload), jobId);
}

export function offerEventReferences(
  payload: unknown,
): Record<string, unknown> {
  const value = payload as {
    termsRevision?: { revisionId?: unknown };
    decision?: { decisionId?: unknown; termsRevisionId?: unknown };
  } | null;
  const revision = z
    .uuid()
    .safeParse(
      value?.termsRevision?.revisionId ?? value?.decision?.termsRevisionId,
    );
  const decision = z
    .uuid()
    .nullable()
    .safeParse(value?.decision?.decisionId ?? null);
  return revision.success && decision.success
    ? { revisionId: revision.data, decisionId: decision.data }
    : {};
}
