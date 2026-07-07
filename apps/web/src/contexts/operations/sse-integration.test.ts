import { DOMAIN_EVENT_TYPES, LOCAL_TENANT } from "@jobctl/domain-types";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { eventByType } from "../../test/fixtures/events.js";
import { applyRunsKeys } from "./applyRunsKeys.js";
import { invalidationRouter } from "./invalidation-router.js";
import { parseDomainEvent } from "../../shared/ports/lib/parseDomainEvent.js";

interface SerializedFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

interface ParsedFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string | null;
}

function buildFrameText(frames: readonly SerializedFrame[]): string {
  return frames
    .map((frame) => [`id: ${frame.id}`, `event: ${frame.event}`, `data: ${frame.data}`, ""].join("\n"))
    .join("\n");
}

function parseSse(text: string): readonly ParsedFrame[] {
  const blocks = text.split(/\n\n/).filter((block) => block.trim().length > 0);
  return blocks.map((block) => {
    const fields = new Map<string, string>();
    for (const rawLine of block.split("\n")) {
      const idx = rawLine.indexOf(":");
      if (idx <= 0) continue;
      fields.set(rawLine.slice(0, idx).trim(), rawLine.slice(idx + 1).trim());
    }
    return {
      id: fields.get("id") ?? "",
      event: fields.get("event") ?? "",
      data: fields.get("data") ?? null,
    };
  });
}

describe("SSE integration (frames → parser → invalidation router) — full per-variant coverage", () => {
  for (const eventType of DOMAIN_EVENT_TYPES) {
    it(`parses an SSE frame for ${eventType} and routes it through the invalidation router`, () => {
      const event = eventByType[eventType];
      const wire = buildFrameText([
        { id: "42", event: eventType, data: JSON.stringify(event.payload) },
      ]);
      const [frame] = parseSse(wire);
      expect(frame, `expected one parsed frame for ${eventType}`).toBeDefined();

      const result = parseDomainEvent({ eventType: frame!.event, data: frame!.data });
      expect(result.ok, `parseDomainEvent failed for ${eventType}`).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.envelope.eventType).toBe(eventType);

      const queryClient = new QueryClient();
      if (eventType === "ApplyRunEventRecorded") {
        const payload = result.envelope.payload as { runId?: string };
        if (payload.runId) {
          queryClient.setQueryData(applyRunsKeys.detail(LOCAL_TENANT, payload.runId), {
            events: [],
          });
        }
      }
      expect(() =>
        invalidationRouter.handle(
          {
            eventType,
            tenantId: result.envelope.tenantId,
            occurredAt: event.occurredAt,
            payload: result.envelope.payload,
          } as never,
          queryClient,
        ),
      ).not.toThrow();
    });
  }
});
