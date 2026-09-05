import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const E2E_DIR =
  process.env["JOBCTRL_E2E_APP_DIR"] ??
  path.join(os.tmpdir(), "jobctrl-e2e-current");
const E2E_DB =
  process.env["JOBCTRL_E2E_DB_PATH"] ?? path.join(E2E_DIR, "jobctrl.db");
const E2E_CONFIG =
  process.env["JOBCTRL_E2E_CONFIG_PATH"] ?? path.join(E2E_DIR, "config.json");
const E2E_SERVICE_HOME =
  process.env["JOBCTRL_E2E_SERVICE_HOME"] ?? path.join(E2E_DIR, "service-home");
const E2E_PLAYWRIGHT_BROWSERS_PATH = process.env["PLAYWRIGHT_BROWSERS_PATH"];

process.env["JOBCTRL_E2E_APP_DIR"] = E2E_DIR;
process.env["JOBCTRL_E2E_DB_PATH"] = E2E_DB;
process.env["JOBCTRL_E2E_CONFIG_PATH"] = E2E_CONFIG;

// Ports default to 8767/5174 (unchanged) but are overridable so parallel
// worktrees / local stacks can run E2E without colliding on a busy port.
const API_PORT = process.env["JOBCTRL_E2E_API_PORT"] ?? "8767";
const WEB_PORT = process.env["JOBCTRL_E2E_WEB_PORT"] ?? "5174";
const RUN_KEY = createHash("sha256")
  .update(path.resolve(E2E_DIR))
  .digest("hex")
  .slice(0, 12);
const E2E_STATE_FILE = path.join(E2E_DIR, ".jobctrl-e2e-state.json");
process.env["JOBCTRL_E2E_STATE_FILE"] = E2E_STATE_FILE;
// Documentation screenshots are committed artifacts, so their run must own
// both servers and the disposable workspace wired into them. A listening port
// is not sufficient evidence that an existing process uses E2E_DIR.
const ISOLATED_E2E = process.env["JOBCTRL_E2E_ISOLATED"] === "1";
const REUSE_EXISTING_SERVERS =
  !ISOLATED_E2E && !process.env["CI"] && process.env["JOBCTRL_DOCS_SCREENSHOTS"] !== "1";
const DOCS_SERVICE_ENVIRONMENT =
  process.env["JOBCTRL_DOCS_SCREENSHOTS"] === "1"
    ? {
        HOME: E2E_SERVICE_HOME,
        USERPROFILE: E2E_SERVICE_HOME,
        XDG_CONFIG_HOME: path.join(E2E_SERVICE_HOME, ".config"),
        XDG_CACHE_HOME: path.join(E2E_SERVICE_HOME, ".cache"),
        ...(E2E_PLAYWRIGHT_BROWSERS_PATH
          ? { PLAYWRIGHT_BROWSERS_PATH: E2E_PLAYWRIGHT_BROWSERS_PATH }
          : {}),
        TZ: "UTC",
        // Profile screenshot capture uses the real profile-preview renderer.
        // Its source runtime must not rewrite the committed Python lockfile.
        UV_LOCKED: "1",
      }
    : {};

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(repoRoot, "dist", "playwright-report", RUN_KEY),
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
      grepInvert: /@mobile/,
    },
    {
      name: "mobile-chromium",
      grep: /@mobile/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      command: ISOLATED_E2E
        ? "corepack pnpm --filter @jobctrl/api exec tsx test/e2e-server.ts"
        : "corepack pnpm --filter @jobctrl/api dev",
      port: Number(API_PORT),
      cwd: repoRoot,
      env: {
        ...DOCS_SERVICE_ENVIRONMENT,
        JOBCTRL_API_PORT: API_PORT,
        JOBCTRL_DIR: E2E_DIR,
        JOBCTRL_DB_PATH: E2E_DB,
        JOBCTRL_CONFIG_PATH: E2E_CONFIG,
        JOBCTRL_E2E_WEB_PORT: WEB_PORT,
        // INSPECT-01: route material-generation dispatch to the deterministic
        // E2E stub (no worker subprocess, no LLM) while keeping the
        // worker-readiness gate live against the seeded heartbeat.
        JOBCTRL_E2E_STUB_DISPATCH: "1",
      },
      reuseExistingServer: REUSE_EXISTING_SERVERS,
      timeout: 120_000,
    },
    {
      command: `corepack pnpm --filter @jobctrl/web exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      port: Number(WEB_PORT),
      cwd: repoRoot,
      env: {
        ...DOCS_SERVICE_ENVIRONMENT,
        VITE_JOBCTRL_API_BASE_URL: "",
        VITE_DEV_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
        VITE_JOBCTRL_HIDE_DEVTOOLS: "1",
      },
      reuseExistingServer: REUSE_EXISTING_SERVERS,
      timeout: 120_000,
    },
  ],
});
