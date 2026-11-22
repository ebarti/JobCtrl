import type { TenantId } from "@jobctrl/domain-types";

import type { DomainEventEnvelope } from "../EventStreamPort.js";

export interface ParsedFrame {
  readonly eventType: string;
  readonly data: string | null;
}

export type ParseDomainEventResult =
  | { readonly ok: true; readonly envelope: DomainEventEnvelope }
  | { readonly ok: false; readonly reason: ParseFailureReason; readonly eventType: string };

export type ParseFailureReason =
  | "event-type-mismatch"
  | "missing-data"
  | "invalid-json"
  | "invalid-envelope"
  | "non-object-payload";

export function parseDomainEvent(frame: ParsedFrame): ParseDomainEventResult {
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
  if (parsed.type !== frame.eventType) {
    return { ok: false, reason: "event-type-mismatch", eventType: frame.eventType };
  }
  if (typeof parsed.eventId !== "string" || !parsed.eventId ||
      typeof parsed.feature !== "string" || !parsed.feature ||
      typeof parsed.tenantId !== "string" || !parsed.tenantId ||
      typeof parsed.occurredAt !== "string" || !parsed.occurredAt ||
      !(typeof parsed.aggregateId === "string" || parsed.aggregateId === null)) {
    return { ok: false, reason: "invalid-envelope", eventType: frame.eventType };
  }
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return { ok: false, reason: "non-object-payload", eventType: frame.eventType };
  }
  return {
    ok: true,
    envelope: {
      eventType: frame.eventType,
      tenantId: parsed.tenantId as TenantId,
      occurredAt: parsed.occurredAt,
      eventId: parsed.eventId,
      feature: parsed.feature,
      aggregateId: parsed.aggregateId,
      payload,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
