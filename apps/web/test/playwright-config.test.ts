// @vitest-environment node

import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const managedEnvironmentKeys = [
  "CI",
  "JOBCTRL_DOCS_SCREENSHOTS",
  "JOBCTRL_E2E_APP_DIR",
  "JOBCTRL_E2E_DB_PATH",
  "JOBCTRL_E2E_CONFIG_PATH",
  "JOBCTRL_E2E_API_PORT",
  "JOBCTRL_E2E_STATE_FILE",
  "JOBCTRL_E2E_WEB_PORT",
] as const;

const originalEnvironment = Object.fromEntries(
  managedEnvironmentKeys.map((key) => [key, process.env[key]]),
);

async function loadPlaywrightConfig(
  environment: Partial<Record<(typeof managedEnvironmentKeys)[number], string>>,
) {
  for (const key of managedEnvironmentKeys) {
    delete process.env[key];
  }
  Object.assign(process.env, environment);
  vi.resetModules();
  return (await import("../e2e/playwright.config.js")).default;
}

afterEach(() => {
  for (const key of managedEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
});

describe("Playwright server isolation", () => {
  test("documentation screenshots own both servers and their supplied workspace", async () => {
    const appDir = path.join("/tmp", "jobctrl-docs-screenshot-config-test");
    const config = await loadPlaywrightConfig({
      JOBCTRL_DOCS_SCREENSHOTS: "1",
      JOBCTRL_E2E_APP_DIR: appDir,
      JOBCTRL_E2E_API_PORT: "18767",
      JOBCTRL_E2E_WEB_PORT: "15174",
    });

    expect(Array.isArray(config.webServer)).toBe(true);
    if (!Array.isArray(config.webServer)) return;

    expect(config.webServer).toHaveLength(2);
    expect(
      config.webServer.map((server) => server.reuseExistingServer),
    ).toEqual([false, false]);
    expect(config.webServer[0]?.env).toMatchObject({
      JOBCTRL_DIR: appDir,
      JOBCTRL_DB_PATH: path.join(appDir, "jobctrl.db"),
      JOBCTRL_CONFIG_PATH: path.join(appDir, "config.json"),
      JOBCTRL_E2E_WEB_PORT: "15174",
    });
    expect(config.webServer[1]?.env).toMatchObject({
      VITE_DEV_API_PROXY_TARGET: "http://127.0.0.1:18767",
    });
    expect(config.use?.baseURL).toBe("http://127.0.0.1:15174");
    expect(process.env["JOBCTRL_E2E_STATE_FILE"]).toBe(
      path.join(appDir, ".jobctrl-e2e-state.json"),
    );
    expect(config.outputDir).toBeDefined();
    const outputDir = config.outputDir ?? "";
    expect(path.basename(path.dirname(outputDir))).toBe("playwright-report");
    expect(path.basename(outputDir)).toMatch(/^[a-f0-9]{12}$/);
  });

  test("separate workspaces receive separate state and artifact paths", async () => {
    const first = await loadPlaywrightConfig({
      JOBCTRL_E2E_APP_DIR: path.join("/tmp", "jobctrl-e2e-first"),
    });
    const firstState = process.env["JOBCTRL_E2E_STATE_FILE"];

    const second = await loadPlaywrightConfig({
      JOBCTRL_E2E_APP_DIR: path.join("/tmp", "jobctrl-e2e-second"),
    });
    const secondState = process.env["JOBCTRL_E2E_STATE_FILE"];

    expect(firstState).not.toBe(secondState);
    expect(first.outputDir).not.toBe(second.outputDir);
  });

  test("ordinary local E2E may still reuse explicitly selected ports", async () => {
    const config = await loadPlaywrightConfig({});

    expect(Array.isArray(config.webServer)).toBe(true);
    if (!Array.isArray(config.webServer)) return;

    expect(
      config.webServer.map((server) => server.reuseExistingServer),
    ).toEqual([true, true]);
  });
});
