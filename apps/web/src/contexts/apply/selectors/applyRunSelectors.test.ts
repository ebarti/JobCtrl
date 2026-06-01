import { LOCAL_TENANT, createApplyRunEventRecorded } from "@jobhunter/domain-types";
import { describe, expect, it } from "vitest";

import { appendApplyRunEvent, type ApplyRunWithEvents } from "./applyRunSelectors.js";

describe("appendApplyRunEvent", () => {
  it("returns undefined when no current cache exists", () => {
    const event = createApplyRunEventRecorded(LOCAL_TENANT, {
      runId: "run-1",
      event: { at: "2026-05-06T08:00:00Z", type: "navigation" },
    });
    expect(appendApplyRunEvent(undefined, event)).toBeUndefined();
  });

  it("appends the event to the existing event list", () => {
    const cache: ApplyRunWithEvents & { runId: string } = {
      runId: "run-1",
      events: [
        {
          at: "2026-05-06T07:55:00Z",
          type: "boot",
          level: "info",
          message: null,
          data: {},
        },
      ],
    };
    const event = createApplyRunEventRecorded(LOCAL_TENANT, {
      runId: "run-1",
      event: {
        at: "2026-05-06T08:00:00Z",
        type: "navigation",
        level: "debug",
        message: "Opened page",
        url: "https://x.test",
      },
    });
    const next = appendApplyRunEvent(cache, event);
    expect(next?.events).toHaveLength(2);
    expect(next?.events[1]?.type).toBe("navigation");
    expect(next?.events[1]?.at).toBe("2026-05-06T08:00:00Z");
    expect(next?.events[1]?.level).toBe("debug");
    expect(next?.events[1]?.message).toBe("Opened page");
    expect(next).not.toBe(cache);
  });

  it("falls back to defaults when payload event lacks timestamp", () => {
    const cache: ApplyRunWithEvents = { events: [] };
    const event = createApplyRunEventRecorded(LOCAL_TENANT, {
      runId: "run-1",
      event: {},
    });
    const next = appendApplyRunEvent(cache, event);
    expect(next?.events).toHaveLength(1);
    expect(next?.events[0]?.type).toBe("event");
    expect(next?.events[0]?.level).toBe("info");
    expect(next?.events[0]?.message).toBeNull();
    expect(next?.events[0]?.at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
