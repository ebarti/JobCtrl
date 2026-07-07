import { DOMAIN_EVENT_TYPES, LOCAL_TENANT, type DomainEventType } from "@jobctrl/domain-types";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { eventByType } from "../../test/fixtures/events.js";
import { dispatch, handlers, invalidationRouter } from "./invalidation-router.js";

const ALLOW_EMPTY_HANDLERS: ReadonlySet<DomainEventType> = new Set();

describe("event-handler parity (the most important test in the app)", () => {
  it("DOMAIN_EVENT_TYPES is the source of truth (frontend mirrors it 1:1)", () => {
    expect(DOMAIN_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const eventType of DOMAIN_EVENT_TYPES) {
      expect(eventByType[eventType]).toBeDefined();
    }
  });

  for (const eventType of DOMAIN_EVENT_TYPES) {
    it(`registers a working handler for ${eventType}`, () => {
      const handler = handlers[eventType];
      expect(handler, `expected handlers["${eventType}"] to exist`).toBeDefined();
      const event = eventByType[eventType];
      const queryClient = new QueryClient();
      expect(() => invalidationRouter.handle(event, queryClient)).not.toThrow();
    });

    it(`returns at least one InvalidationItem for ${eventType}`, () => {
      if (ALLOW_EMPTY_HANDLERS.has(eventType)) {
        return;
      }
      const event = eventByType[eventType];
      const items = dispatch(event);
      expect(
        items.length,
        `${eventType} handler returned [] — looks like a stub. Add to ALLOW_EMPTY_HANDLERS only with a documented reason linking back to §8.4.`,
      ).toBeGreaterThan(0);
    });
  }

  it("LOCAL_TENANT is wired correctly", () => {
    expect(LOCAL_TENANT).toBe("local");
  });
});
