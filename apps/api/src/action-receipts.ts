import { createHash } from "node:crypto";
import { z } from "zod";

import { allRows, type SqliteDatabase } from "./db.js";

/** A receipt lives on the single domain event, in the same transaction as its fact. */
export class ActionReceiptConflictError extends Error {
  constructor() {
    super("This request identity cannot be applied. Retry the original request or start a new action.");
  }
}

const ReceiptSchema = z.object({
  version: z.literal(2),
  operation: z.string(),
  target: z.string(),
  factId: z.string().min(1),
}).strict();
export type ActionReceipt = z.infer<typeof ReceiptSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function actionIdentity(
  tenant: string,
  operation: string,
  target: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  return {
    key: `local-action:v2:${hash([tenant, operation, target, requestId])}`,
    binding: { version: 2 as const, operation, target },
    request: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "requestId")),
  };
}

/** The digest stays in SQLite's internal index column, never the streamed event payload. */
export function actionReceiptKey(
  identity: ReturnType<typeof actionIdentity>,
  fact: object,
  event: object,
): string {
  return `${identity.key}:${hash([identity.request, fact, event])}`;
}

interface StoredActionReceipt {
  factId: string;
  key: string;
  event: Record<string, unknown>;
}

export function readActionReceipt(
  db: SqliteDatabase,
  tenant: string,
  identity: ReturnType<typeof actionIdentity>,
  eventType: string,
  entityKind: string,
): StoredActionReceipt | null {
  // Every caller holds an immediate writer transaction while checking this
  // prefix and inserting. Different payloads cannot race into separate keys.
  // The identity ends in a fixed-length ASCII hex digest. Its last byte's
  // successor bounds every string with this literal prefix, including malformed
  // separators and Unicode suffixes, without scanning unrelated identities.
  const prefixEnd = identity.key.slice(0, -1)
    + String.fromCharCode(identity.key.charCodeAt(identity.key.length - 1) + 1);
  const rows = allRows<{ tenant_id: string; payload_json: string; event_type: string; entity_kind: string; entity_ref: string; idempotency_key: string }>(db,
    `SELECT tenant_id, payload_json, event_type, entity_kind, entity_ref, idempotency_key FROM job_events
     WHERE idempotency_key >= ? AND idempotency_key < ? LIMIT 2`,
    [identity.key, prefixEnd]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new ActionReceiptConflictError();
  const row = rows[0]!;
  try {
    const payload = JSON.parse(row.payload_json);
    const receipt = ReceiptSchema.parse(payload.receipt);
    const eventFactId = eventType === "ApplicationOutcomeRecorded" ? payload.outcomeId
      : eventType === "OutreachSendLogged" ? payload.sendLogId
      : eventType === "OutcomeSuggestionDecided" ? payload.suggestionId : undefined;
    if (row.tenant_id !== tenant || row.event_type !== eventType || row.entity_kind !== entityKind || row.entity_ref !== identity.binding.target
      || eventFactId !== receipt.factId || !new RegExp(`^${identity.key}:[0-9a-f]{64}$`).test(row.idempotency_key)
      || Object.entries(identity.binding).some(([key, value]) => receipt[key as keyof ActionReceipt] !== value)) {
      throw new ActionReceiptConflictError();
    }
    const { receipt: _receipt, ...event } = payload as Record<string, unknown>;
    return { factId: receipt.factId, key: row.idempotency_key, event };
  } catch {
    throw new ActionReceiptConflictError();
  }
}

export function assertActionReceipt(
  identity: ReturnType<typeof actionIdentity>,
  receipt: StoredActionReceipt,
  fact: object,
): void {
  if (receipt.key !== actionReceiptKey(identity, fact, receipt.event)) throw new ActionReceiptConflictError();
}
