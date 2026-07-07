import { DOMAIN_EVENT_TYPES, LOCAL_TENANT } from "@jobctrl/domain-types";
import { describe, expect, it } from "vitest";

import { eventByType } from "../../../test/fixtures/events.js";
import { parseDomainEvent } from "./parseDomainEvent.js";

describe("parseDomainEvent", () => {
  for (const eventType of DOMAIN_EVENT_TYPES) {
    it(`round-trips JSON → parsed → envelope for ${eventType}`, () => {
      const event = eventByType[eventType];
      const data = JSON.stringify(event.payload);
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
      data: JSON.stringify({ tenantId: "alice", jobId: "job-1" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.tenantId).toBe("alice");
    }
  });

  it("falls back to LOCAL_TENANT when the payload omits tenantId", () => {
    const result = parseDomainEvent({
      eventType: "JobScored",
      data: JSON.stringify({ jobId: "job-1" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.tenantId).toBe(LOCAL_TENANT);
    }
  });

  it("rejects unknown event types", () => {
    const result = parseDomainEvent({ eventType: "MysteryEvent", data: "{}" });
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
});
