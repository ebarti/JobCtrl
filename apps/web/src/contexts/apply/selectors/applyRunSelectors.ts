import type { ApplyRunEventRecorded } from "@jobhunter/domain-types";

export interface ApplyRunEventEntry {
  readonly at: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface ApplyRunWithEvents {
  readonly events: readonly ApplyRunEventEntry[];
}

function eventEntryFromPayload(event: Record<string, unknown>): ApplyRunEventEntry {
  const at = typeof event["at"] === "string" ? event["at"] : new Date().toISOString();
  const type = typeof event["type"] === "string" ? event["type"] : "event";
  return { at, type, data: event };
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
  const entry = eventEntryFromPayload(event.payload.event);
  return { ...current, events: [...current.events, entry] };
}
