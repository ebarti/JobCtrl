import { afterAll, afterEach, beforeAll } from "vitest";

import { resetTestHandlers, server } from "./msw/server.js";

// Pure tests opt into Node explicitly; they do not need browser fixtures.
const domHarness = typeof window !== "undefined"
  ? await import("./setup-dom.js")
  : undefined;

// Every environment stays hermetic, including tests without default API mocks.
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  // Preserve teardown order: unmount before restoring handlers and fixture state.
  domHarness?.cleanup();
  resetTestHandlers();
});

afterAll(() => {
  server.close();
});
