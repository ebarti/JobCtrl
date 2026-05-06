import { DOMAIN_EVENT_TYPES, LOCAL_TENANT, type TenantId } from "@jobhunter/domain-types";

import type { DomainEventEnvelope } from "../EventStreamPort.js";

const KNOWN_EVENT_TYPES = new Set<string>(DOMAIN_EVENT_TYPES);

export interface ParsedFrame {
  readonly eventType: string;
  readonly data: string | null;
}

export type ParseDomainEventResult =
  | { readonly ok: true; readonly envelope: DomainEventEnvelope }
  | { readonly ok: false; readonly reason: ParseFailureReason; readonly eventType: string };

export type ParseFailureReason =
  | "unknown-event-type"
  | "missing-data"
  | "invalid-json"
  | "non-object-payload";

export function parseDomainEvent(frame: ParsedFrame): ParseDomainEventResult {
  if (!KNOWN_EVENT_TYPES.has(frame.eventType)) {
    return { ok: false, reason: "unknown-event-type", eventType: frame.eventType };
  }
  if (typeof frame.data !== "string" || frame.data.length === 0) {
    return { ok: false, reason: "missing-data", eventType: frame.eventType };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return { ok: false, reason: "invalid-json", eventType: frame.eventType };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "non-object-payload", eventType: frame.eventType };
  }
  return {
    ok: true,
    envelope: {
      eventType: frame.eventType,
      tenantId: readTenantId(parsed),
      payload: parsed,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTenantId(payload: Record<string, unknown>): TenantId {
  const candidate = payload["tenantId"];
  return typeof candidate === "string" && candidate.length > 0
    ? (candidate as TenantId)
    : LOCAL_TENANT;
}
