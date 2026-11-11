import { z } from "zod";
import type { StoragePort } from "../../../shared/ports/StoragePort.js";

export interface DraftSlotToken {
  readonly ownerId: string;
  readonly revision: number;
}
export interface OwnedDraft<T> extends DraftSlotToken {
  readonly data: T;
}
const envelope = z
  .object({
    version: z.literal(1),
    ownerId: z.string().min(1),
    revision: z.number().int().positive(),
    data: z.unknown(),
  })
  .strict();

const unreadableValues = new WeakMap<UnreadableDraftError, string>();
/** Opaque unreadable bytes stay inside this boundary, never in an Error or UI. */
export class UnreadableDraftError extends Error {
  constructor(storedValue: string) {
    super(
      "The retained draft could not be read. Retry or explicitly discard this recovery copy.",
    );
    unreadableValues.set(this, storedValue);
  }
}

function parse<T>(
  raw: string | null,
  schema: z.ZodType<T>,
): OwnedDraft<T> | null {
  if (raw === null || raw === "null") return null;
  try {
    const record = envelope.parse(JSON.parse(raw) as unknown);
    return {
      ownerId: record.ownerId,
      revision: record.revision,
      data: schema.parse(record.data),
    };
  } catch {
    throw new UnreadableDraftError(raw);
  }
}

export function readDraftSlot<T>(
  storage: StoragePort,
  key: string,
  schema: z.ZodType<T>,
): Promise<OwnedDraft<T> | null> {
  return storage.transact(key, (raw) => ({ result: parse(raw, schema) }));
}

/** Both comparison and publication occur in the port's cross-tab transaction. */
export function writeDraftSlot<T>(
  storage: StoragePort,
  key: string,
  schema: z.ZodType<T>,
  expected: DraftSlotToken | null,
  ownerId: string,
  data: T | null,
): Promise<
  | { state: "written"; record: OwnedDraft<T> | null }
  | { state: "conflict"; record: OwnedDraft<T> | null }
> {
  const checked = data === null ? null : schema.parse(data);
  return storage.transact<{
    state: "written" | "conflict";
    record: OwnedDraft<T> | null;
  }>(key, (raw) => {
    const current = parse(raw, schema);
    if (
      current?.ownerId !== expected?.ownerId ||
      current?.revision !== expected?.revision
    )
      return { result: { state: "conflict" as const, record: current } };
    const next =
      checked === null
        ? null
        : { ownerId, revision: (current?.revision ?? 0) + 1, data: checked };
    return {
      result: { state: "written" as const, record: next },
      write: JSON.stringify(next ? { version: 1, ...next } : null),
    };
  });
}

export function discardUnreadableDraft(
  storage: StoragePort,
  key: string,
  failure: UnreadableDraftError,
): Promise<boolean> {
  return storage.transact(key, (raw) =>
    unreadableValues.has(failure) && raw === unreadableValues.get(failure)
      ? { result: true, write: "null" }
      : { result: false },
  );
}
