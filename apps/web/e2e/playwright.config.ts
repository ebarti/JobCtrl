import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const E2E_DIR =
  process.env["JOBHUNTER_E2E_APP_DIR"] ?? path.join(os.tmpdir(), "jobhunter-e2e-current");
const E2E_DB = process.env["JOBHUNTER_E2E_DB_PATH"] ?? path.join(E2E_DIR, "jobhunter.db");
const E2E_SETTINGS =
  process.env["JOBHUNTER_E2E_SETTINGS_PATH"] ?? path.join(E2E_DIR, "dashboard.json");

process.env["JOBHUNTER_E2E_APP_DIR"] = E2E_DIR;
process.env["JOBHUNTER_E2E_DB_PATH"] = E2E_DB;
process.env["JOBHUNTER_E2E_SETTINGS_PATH"] = E2E_SETTINGS;

// Ports default to 8767/5174 (unchanged) but are overridable so parallel
// worktrees / local stacks can run E2E without colliding on a busy port.
const API_PORT = process.env["JOBHUNTER_E2E_API_PORT"] ?? "8767";
const WEB_PORT = process.env["JOBHUNTER_E2E_WEB_PORT"] ?? "5174";

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(repoRoot, "dist", "playwright-report"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  globalSetup: "./fixtures/global-setup.ts",
  globalTeardown: "./fixtures/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "corepack pnpm --filter @jobhunter/api dev",
      port: Number(API_PORT),
      cwd: repoRoot,
      env: {
        JOBHUNTER_API_PORT: API_PORT,
        JOBHUNTER_DIR: E2E_DIR,
        JOBHUNTER_DB_PATH: E2E_DB,
        JOBHUNTER_DASHBOARD_CONFIG_PATH: E2E_SETTINGS,
        // INSPECT-01: route material-generation dispatch to the deterministic
        // E2E stub (no worker subprocess, no LLM) while keeping the
        // worker-readiness gate live against the seeded heartbeat.
        JOBHUNTER_E2E_STUB_DISPATCH: "1",
      },
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
    {
      command: `corepack pnpm --filter @jobhunter/web exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      port: Number(WEB_PORT),
      cwd: repoRoot,
      env: {
        VITE_JOBHUNTER_API_BASE_URL: "",
        VITE_DEV_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
        VITE_JOBHUNTER_HIDE_DEVTOOLS: "1",
      },
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
  ],
});
