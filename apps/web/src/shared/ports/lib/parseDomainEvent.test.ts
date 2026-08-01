import { DOMAIN_EVENT_TYPES, LOCAL_TENANT } from "@jobctrl/domain-types";
import { describe, expect, it } from "vitest";

import { eventByType } from "../../../test/fixtures/events.js";
import { parseDomainEvent } from "./parseDomainEvent.js";

describe("parseDomainEvent", () => {
  for (const eventType of DOMAIN_EVENT_TYPES) {
    it(`round-trips JSON → parsed → envelope for ${eventType}`, () => {
      const event = eventByType[eventType];
      const data = encodeEnvelope(event.payload);
      const result = parseDomainEvent({ eventType, data });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.eventType).toBe(eventType);
        expect(result.envelope.payload).toEqual(event.payload);
      }
    });
  }

  it("uses the explicit tenantId from the payload when present", () => {
    const result = parseDomainEvent({
      eventType: "JobScored",
      data: encodeEnvelope(
        { tenantId: "alice", jobId: "job-1" },
        { tenantId: "alice" },
      ),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.tenantId).toBe("alice");
    }
  });

  it("separates the authoritative event timestamp from the domain timestamp", () => {
    const eventOccurredAt = "2026-08-01T15:30:00Z";
    const outcomeOccurredAt = "2026-07-01T09:00:00Z";
    const result = parseDomainEvent({
      eventType: "ApplicationOutcomeRecorded",
      data: encodeEnvelope(
        {
          tenantId: "local",
          jobId: "job-1",
          outcomeId: "outcome-1",
          occurredAt: outcomeOccurredAt,
        },
        { occurredAt: eventOccurredAt },
      ),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.occurredAt).toBe(eventOccurredAt);
      expect(result.envelope.payload).toMatchObject({ occurredAt: outcomeOccurredAt });
    }
  });

  it("falls back to LOCAL_TENANT when the payload omits tenantId", () => {
    const result = parseDomainEvent({
      eventType: "JobScored",
      data: JSON.stringify({ occurredAt: null, payload: { jobId: "job-1" } }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.tenantId).toBe(LOCAL_TENANT);
    }
  });

  it("rejects unknown event types", () => {
    const result = parseDomainEvent({ eventType: "MysteryEvent", data: encodeEnvelope({}) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown-event-type");
    }
  });

  it("rejects missing data", () => {
    const result = parseDomainEvent({ eventType: "JobScored", data: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-data");
    }
  });

  it("rejects invalid JSON", () => {
    const result = parseDomainEvent({ eventType: "JobScored", data: "not-json" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-json");
    }
  });

  it("rejects non-object payloads (e.g. arrays, primitives)", () => {
    const result = parseDomainEvent({ eventType: "JobScored", data: "[1,2,3]" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non-object-payload");
    }
  });

  it("rejects the legacy flat payload shape", () => {
    const result = parseDomainEvent({
      eventType: "JobScored",
      data: JSON.stringify({ tenantId: "local", jobId: "job-1" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non-object-payload");
    }
  });
});

function encodeEnvelope(
  payload: object,
  metadata: { tenantId?: string | undefined; occurredAt?: string | null } = {},
): string {
  const payloadRecord = payload as Record<string, unknown>;
  const tenantId = metadata.tenantId === undefined
    ? (typeof payloadRecord["tenantId"] === "string" ? payloadRecord["tenantId"] : LOCAL_TENANT)
    : metadata.tenantId;
  return JSON.stringify({
    ...(tenantId === undefined ? {} : { tenantId }),
    occurredAt: metadata.occurredAt ?? null,
    payload,
  });
}
