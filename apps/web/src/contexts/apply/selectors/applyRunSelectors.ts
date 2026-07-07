import type { ApplyRunEventRecorded } from "@jobctl/domain-types";

export interface ApplyRunEventEntry {
  readonly at: string | null;
  readonly type: string;
  readonly level: string;
  readonly message: string | null;
  readonly data: Record<string, unknown>;
}

export interface ApplyRunWithEvents {
  readonly events: readonly ApplyRunEventEntry[];
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  const out = text(value);
  return out ? out : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeApplyRunEventEntry(event: unknown): ApplyRunEventEntry {
  const source = isRecord(event) ? event : {};
  const data = isRecord(source["data"]) ? source["data"] : source;
  const at = nullableText(source["at"] ?? source["occurred_at"] ?? source["occurredAt"])
    ?? new Date().toISOString();
  const type = text(source["type"] ?? source["event_type"] ?? source["eventType"]) || "event";
  const level = text(source["level"]) || "info";
  const message = nullableText(source["message"]);
  return { at, type, level, message, data };
}

// Used by the §7.4 / §7.5 invalidation router's setQueryData path. Phase 5
// wires this into the invalidation router so apply-run timeline updates
// surgically patch the cached projection instead of re-fetching the whole
// detail on every per-second event.
export function appendApplyRunEvent<T extends ApplyRunWithEvents>(
  current: T | undefined,
  event: ApplyRunEventRecorded,
): T | undefined {
  if (!current) {
    return undefined;
  }
  const entry = normalizeApplyRunEventEntry(event.payload.event);
  return { ...current, events: [...current.events, entry] };
}
