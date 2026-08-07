import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    // Seeding hooks do real filesystem and SQLite work, so they must not carry a
    // tighter deadline than the tests they set up. Vitest defaults hookTimeout to
    // 10s, which made `beforeEach` the first thing to fail on a loaded CI runner.
    hookTimeout: 15_000,
  },
});
