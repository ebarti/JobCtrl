// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";

const {
  createOwnedE2eWorkspace,
  workspaceEnvironment,
  canonicalTemporaryRoot,
} = createRequire(import.meta.url)("../e2e/fixtures/owned-workspace.cjs") as {
  createOwnedE2eWorkspace(): { appDir: string };
  workspaceEnvironment(workspace: unknown): Record<string, string>;
  canonicalTemporaryRoot(): string;
};
const managedEnvironmentKeys = [
  "CI",
  "JOBCTRL_DOCS_SCREENSHOTS",
  "JOBCTRL_E2E_ISOLATED",
  "JOBCTRL_E2E_WORKSPACE",
  "JOBCTRL_E2E_APP_DIR",
  "JOBCTRL_E2E_DB_PATH",
  "JOBCTRL_E2E_CONFIG_PATH",
  "JOBCTRL_E2E_SERVICE_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "JOBCTRL_E2E_API_PORT",
  "JOBCTRL_E2E_STATE_FILE",
  "JOBCTRL_E2E_WEB_PORT",
  "JOBCTRL_DIR",
  "JOBCTRL_DB_PATH",
  "JOBCTRL_CONFIG_PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;
const originalEnvironment = Object.fromEntries(
  managedEnvironmentKeys.map((key) => [key, process.env[key]]),
);
const roots = new Set<string>();

async function loadPlaywrightConfig(environment: Record<string, string> = {}) {
  for (const key of managedEnvironmentKeys) delete process.env[key];
  if (originalEnvironment.TMPDIR)
    process.env["TMPDIR"] = originalEnvironment.TMPDIR;
  Object.assign(process.env, environment);
  vi.resetModules();
  const config = (await import("../e2e/playwright.config.js")).default;
  roots.add(process.env["JOBCTRL_E2E_APP_DIR"]!);
  return config;
}

afterEach(() => {
  for (const key of managedEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
  vi.resetModules();
});

describe("Playwright run ownership", () => {
  test("documentation screenshots own both servers and the allocated workspace", async () => {
    const workspace = createOwnedE2eWorkspace();
    roots.add(workspace.appDir);
    const { appDir } = workspace;
    const serviceHome = path.join(appDir, "service-home");
    const config = await loadPlaywrightConfig({
      ...workspaceEnvironment(workspace),
      JOBCTRL_DOCS_SCREENSHOTS: "1",
      PLAYWRIGHT_BROWSERS_PATH: "/tmp/jobctrl-playwright-browsers",
      JOBCTRL_E2E_API_PORT: "18767",
      JOBCTRL_E2E_WEB_PORT: "15174",
    });
    if (!Array.isArray(config.webServer))
      throw new Error("Missing E2E servers");
    expect(
      config.webServer.map((server) => server.reuseExistingServer),
    ).toEqual([false, false]);
    expect(config.webServer[0]?.command).toContain("fixtures/start-api.cjs");
    expect(config.webServer[0]?.env).toMatchObject({
      JOBCTRL_DIR: appDir,
      JOBCTRL_DB_PATH: path.join(appDir, "jobctrl.db"),
      JOBCTRL_CONFIG_PATH: path.join(appDir, "config.json"),
      JOBCTRL_E2E_WEB_PORT: "15174",
      HOME: serviceHome,
      USERPROFILE: serviceHome,
      UV_LOCKED: "1",
    });
    expect(config.webServer[1]?.env).toMatchObject({
      VITE_DEV_API_PROXY_TARGET: "http://127.0.0.1:18767",
      HOME: serviceHome,
      TZ: "UTC",
    });
    expect(config.use?.baseURL).toBe("http://127.0.0.1:15174");
    expect(process.env["JOBCTRL_E2E_STATE_FILE"]).toBe(
      path.join(appDir, ".jobctrl-e2e-state.json"),
    );
  });

  test("repeated ordinary runs under the same parent preserve its data and get distinct paths", async () => {
    const parent = fs.mkdtempSync(
      path.join(canonicalTemporaryRoot(), "jobctrl-config-parent-"),
    );
    roots.add(parent);
    fs.writeFileSync(path.join(parent, "sentinel"), "preserved");
    const first = await loadPlaywrightConfig({ JOBCTRL_E2E_APP_DIR: parent });
    const firstState = process.env["JOBCTRL_E2E_STATE_FILE"];
    const second = await loadPlaywrightConfig({ JOBCTRL_E2E_APP_DIR: parent });
    expect(firstState).not.toBe(process.env["JOBCTRL_E2E_STATE_FILE"]);
    expect(first.outputDir).not.toBe(second.outputDir);
    expect(path.dirname(process.env["JOBCTRL_E2E_APP_DIR"]!)).toBe(parent);
    expect(fs.readFileSync(path.join(parent, "sentinel"), "utf8")).toBe(
      "preserved",
    );
  });

  test.each([
    {},
    { JOBCTRL_E2E_ISOLATED: "1" },
    { JOBCTRL_DOCS_SCREENSHOTS: "1" },
  ])("no E2E mode can reuse an unrelated listener: %j", async (mode) => {
    const config = await loadPlaywrightConfig(mode);
    if (!Array.isArray(config.webServer))
      throw new Error("Missing E2E servers");
    expect(
      config.webServer.map((server) => server.reuseExistingServer),
    ).toEqual([false, false]);
    expect(config.webServer[0]?.command).toContain("fixtures/start-api.cjs");
  });
});
