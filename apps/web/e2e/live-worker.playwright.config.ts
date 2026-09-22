import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// @ts-expect-error Node-only harness support is covered by runtime-support.test.mjs.
import { CREDENTIAL_ENV_KEYS, sanitizedRuntimeEnvironment } from "./live-worker/runtime-support.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { configureE2eWorkspace, requireLiveWorkerExitCleanup } = createRequire(import.meta.url)(
  "./fixtures/owned-workspace.cjs",
) as {
  configureE2eWorkspace(): { appDir: string; token: string };
  requireLiveWorkerExitCleanup(workspace: {
    appDir: string;
    token: string;
  }): void;
};

if (
  process.env["JOBCTRL_E2E_STUB_DISPATCH"] ||
  process.env["JOBCTRL_E2E_ISOLATED"]
) {
  throw new Error(
    "The live-worker smoke refuses stub or isolated E2E dispatch",
  );
}

const workspace = configureE2eWorkspace();
requireLiveWorkerExitCleanup(workspace);
const runKey = createHash("sha256")
  .update(`${workspace.appDir}\0${workspace.token}`)
  .digest("hex")
  .slice(0, 12);
const portBase = 24_000 + (Number.parseInt(runKey.slice(0, 8), 16) % 7_000);
const ports = {
  api: String(portBase),
  web: String(portBase + 1),
  temporal: String(portBase + 2),
  temporalUi: String(portBase + 3),
  control: String(portBase + 4),
};
const serviceHome = process.env["JOBCTRL_E2E_SERVICE_HOME"]!;
const contributorHome = os.homedir();
const browserPath =
  process.env["PLAYWRIGHT_BROWSERS_PATH"] ??
  path.join(contributorHome, "Library", "Caches", "ms-playwright");
const corepackHome =
  process.env["COREPACK_HOME"] ??
  path.join(contributorHome, ".cache", "node", "corepack");
const evidenceDir = path.join(repoRoot, "dist", "live-worker-smoke", runKey);
const temporalDb = path.join(workspace.appDir, "temporal", "temporal.db");
const runtimeEnvironment = {
  ...sanitizedRuntimeEnvironment(process.env),
  HOME: serviceHome,
  USERPROFILE: serviceHome,
  XDG_CONFIG_HOME: path.join(serviceHome, ".config"),
  XDG_CACHE_HOME: path.join(serviceHome, ".cache"),
  PLAYWRIGHT_BROWSERS_PATH: browserPath,
  COREPACK_HOME: corepackHome,
  TZ: "UTC",
  UV_LOCKED: "1",
  LANGFUSE_DISABLE: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
  JOBCTRL_LIVE_WORKER_SMOKE: "1",
  JOBCTRL_LIVE_WORKER_SMOKE_APP_DIR: workspace.appDir,
  JOBCTRL_LIVE_WORKER_SMOKE_TOKEN: workspace.token,
  JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL: `http://127.0.0.1:${ports.control}/provider/chat`,
  JOBCTRL_LIVE_WORKER_EVIDENCE_DIR: evidenceDir,
  JOBCTRL_LIVE_WORKER_TEMPORAL_PORT: ports.temporal,
  JOBCTRL_LIVE_WORKER_TEMPORAL_UI_PORT: ports.temporalUi,
  JOBCTRL_LIVE_WORKER_CONTROL_PORT: ports.control,
  JOBCTRL_TEMPORAL_DB: temporalDb,
  TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
  TEMPORAL_NAMESPACE: "default",
  JOBCTRL_API_HOST: "127.0.0.1",
  JOBCTRL_API_PORT: ports.api,
  JOBCTRL_E2E_API_PORT: ports.api,
  JOBCTRL_E2E_WEB_PORT: ports.web,
};
for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
delete process.env["JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP_VALIDATED"];
Object.assign(process.env, runtimeEnvironment);

export const liveWorkerConfig = Object.freeze({
  evidenceDir,
  ports,
  runKey,
  temporalDb,
  workspace,
});

export default defineConfig({
  testDir: "./live-worker-tests",
  outputDir: path.join(evidenceDir, "playwright"),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  globalTimeout: 240_000,
  globalSetup: "./live-worker/global-setup.ts",
  globalTeardown: "./live-worker/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${ports.web}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "live-worker-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node apps/web/e2e/live-worker/start-runtime.mjs",
      port: Number(ports.api),
      cwd: repoRoot,
      env: runtimeEnvironment,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `corepack pnpm --filter @jobctrl/web exec vite --host 127.0.0.1 --port ${ports.web} --strictPort`,
      port: Number(ports.web),
      cwd: repoRoot,
      env: {
        ...runtimeEnvironment,
        VITE_JOBCTRL_API_BASE_URL: "",
        VITE_DEV_API_PROXY_TARGET: `http://127.0.0.1:${ports.api}`,
        VITE_JOBCTRL_HIDE_DEVTOOLS: "1",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
