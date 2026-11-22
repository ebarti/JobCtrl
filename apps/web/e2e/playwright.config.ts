import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// `run-e2e.mjs` allocates this directory. Listing tests starts no application
// and requires no writable application state.
const evidence =
  process.env["JOBCTRL_E2E_RUN_DIR"] ??
  path.join(os.tmpdir(), "jobctrl-e2e-list");
const consoleReporters = (process.env["JOBCTRL_E2E_CONSOLE_REPORTER"] ?? (process.env["CI"] ? "github" : "list"))
  .split(",").filter((name) => name !== "json" && name !== "junit");
const installed = process.env["JOBCTRL_E2E_INSTALLED"] === "1";

export default defineConfig({
  testDir: "./journeys",
  outputDir: path.join(evidence, "playwright"),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: installed ? Math.min(4, Math.max(1, os.availableParallelism() - 1)) : 1,
  timeout: 90_000,
  // Hosted qualification partitions the installed suite across Mac runners.
  // Every case keeps the same deadline in an individual or sharded run.
  globalTimeout: installed ? 3_600_000 : 720_000,
  expect: { timeout: 10_000 },
  reporter: [
    ...consoleReporters.map((name): [string, Record<string, unknown>] => [name, name === "html" ? { outputFolder: path.join(evidence, "html"), open: "never" } : {}]),
    ["junit", { outputFile: path.join(evidence, "junit.xml") }],
    ["json", { outputFile: path.join(evidence, "results.json") }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(installed ? [] : [{ name: "demo-chromium", testDir: ".", testMatch: "demo-runtime.spec.ts", use: { ...devices["Desktop Chrome"] } }]),
  ],
});
