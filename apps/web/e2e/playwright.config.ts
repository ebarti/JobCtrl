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

export default defineConfig({
  testDir: "./journeys",
  outputDir: path.join(evidence, "playwright"),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  globalTimeout: 480_000,
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
    ...(process.env["JOBCTRL_E2E_INSTALLED"] === "1" ? [] : [{ name: "demo-chromium", testDir: ".", testMatch: "demo-runtime.spec.ts", use: { ...devices["Desktop Chrome"] } }]),
  ],
});
