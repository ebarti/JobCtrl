import { createRequire } from "node:module";

const { assertIsolatedLinuxManualCapture } = createRequire(import.meta.url)(
  "./fixtures/manual-capture-recovery-guard.cjs",
) as { assertIsolatedLinuxManualCapture(): void };

// Check before importing the shared configuration, which allocates a workspace
// and defines web servers. A skipped test would still start those servers.
assertIsolatedLinuxManualCapture();

const { default: sharedConfig } = await import("./playwright.config.js");
export default {
  ...sharedConfig,
  testDir: "./isolated-tests",
  testMatch: "manual-capture-recovery.spec.ts",
};
