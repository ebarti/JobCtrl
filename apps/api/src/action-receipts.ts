import { createHash } from "node:crypto";
import { z } from "zod";

import { getRow, type SqliteDatabase } from "./db.js";

/** A receipt lives on the single domain event, in the same transaction as its fact. */
export class ActionReceiptConflictError extends Error {
  constructor() {
    super("This request identity cannot be applied. Retry the original request or start a new action.");
  }
}

const ReceiptSchema = z.object({
  version: z.literal(1),
  operation: z.string(),
  target: z.string(),
  payloadHash: z.string(),
  factId: z.string().min(1),
}).strict();
export type ActionReceipt = z.infer<typeof ReceiptSchema>;

export function actionIdentity(
  tenant: string,
  operation: string,
  target: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const binding = { version: 1 as const, operation, target, payloadHash: hash(
    Object.fromEntries(Object.entries(payload).filter(([key, value]) => key !== "requestId" && value !== undefined).sort(([a], [b]) => a.localeCompare(b))),
  ) };
  return {
    key: `local-action:v1:${hash([tenant, operation, target, requestId])}`,
    binding,
  };
}

export function readActionReceipt(
  db: SqliteDatabase,
  tenant: string,
  identity: ReturnType<typeof actionIdentity>,
  eventType: string,
  entityKind: string,
): ActionReceipt | null {
  const row = getRow<{ tenant_id: string; payload_json: string; event_type: string; entity_kind: string; entity_ref: string }>(db,
    `SELECT tenant_id, payload_json, event_type, entity_kind, entity_ref FROM job_events WHERE idempotency_key = ?`,
    [identity.key]);
  if (!row) return null;
  try {
    const receipt = ReceiptSchema.parse(JSON.parse(row.payload_json).receipt);
    if (row.tenant_id !== tenant || row.event_type !== eventType || row.entity_kind !== entityKind || row.entity_ref !== identity.binding.target
      || Object.entries(identity.binding).some(([key, value]) => receipt[key as keyof ActionReceipt] !== value)) {
      throw new ActionReceiptConflictError();
    }
    return receipt;
  } catch {
    throw new ActionReceiptConflictError();
  }
}
