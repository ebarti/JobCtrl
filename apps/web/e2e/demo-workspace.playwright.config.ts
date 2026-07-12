import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const port = Number(process.env["JOBCTRL_DEMO_E2E_WEB_PORT"] ?? "5198");

export default defineConfig({
  testDir: "./demo-workspace-tests",
  outputDir: path.join(os.tmpdir(), "jobctrl-demo-workspace-playwright"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
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
  webServer: {
    command: `corepack pnpm --filter @jobctrl/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    port,
    cwd: repoRoot,
    env: {
      VITE_JOBCTRL_APP_MODE: "demo",
      VITE_JOBCTRL_HIDE_DEVTOOLS: "1",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
