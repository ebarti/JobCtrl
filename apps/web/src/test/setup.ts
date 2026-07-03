import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect } from "vitest";

import { toHaveNoViolations as jestAxeToHaveNoViolations } from "jest-axe";

import { server } from "./msw/server.js";

const jestAxeFn = jestAxeToHaveNoViolations.toHaveNoViolations as unknown as (
  this: unknown,
  received: unknown,
) => { pass: boolean; message: () => string };

expect.extend({
  toHaveNoViolations(received: unknown) {
    return jestAxeFn.call(this, received);
  },
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function createMemoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(items.keys())[index] ?? null;
    },
    removeItem(key: string) {
      items.delete(key);
    },
    setItem(key: string, value: string) {
      items.set(key, value);
    },
  };
}

function hasWindowLocalStorage(): boolean {
  try {
    return typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

if (typeof window !== "undefined" && !hasWindowLocalStorage()) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver;
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", { writable: true, value: () => {} });
}
