// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import globalSetup from "../e2e/fixtures/global-setup.js";
import globalTeardown from "../e2e/fixtures/global-teardown.js";
import { loadE2eDbPath } from "../e2e/fixtures/e2e-state.js";

const require = createRequire(import.meta.url);
const { createOwnedE2eWorkspace, workspaceEnvironment } =
  require("../e2e/fixtures/owned-workspace.cjs") as {
    createOwnedE2eWorkspace(): { appDir: string };
    workspaceEnvironment(workspace: unknown): Record<string, string>;
  };
const { seedOwnedE2eWorkspace } =
  require("../e2e/fixtures/seed-workspace.cjs") as {
    seedOwnedE2eWorkspace(
      repoRoot: string,
      env: Record<string, string>,
      runSeed: (...args: unknown[]) => string,
    ): unknown;
  };
const originalEnvironment = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workspace = createOwnedE2eWorkspace();
  roots.push(workspace.appDir);
  const env = workspaceEnvironment(workspace);
  const report = {
    appDir: workspace.appDir,
    dbPath: env.JOBCTRL_E2E_DB_PATH,
    configPath: env.JOBCTRL_E2E_CONFIG_PATH,
  };
  return { workspace, env, report };
}

function publishReceipt(env: Record<string, string>, report: unknown) {
  fs.writeFileSync(
    env.JOBCTRL_E2E_STATE_FILE!,
    JSON.stringify({ workspace: report }),
  );
}

describe("E2E lifecycle ownership", () => {
  it("seeds once before startup and setup cannot replace that database", async () => {
    const { env, report } = fixture();
    const seed = vi.fn(() => {
      fs.writeFileSync(env.JOBCTRL_E2E_DB_PATH!, "seeded database sentinel");
      return JSON.stringify(report);
    });
    seedOwnedE2eWorkspace("synthetic-unused-repository", env, seed);
    expect(seed).toHaveBeenCalledOnce();
    process.env = { ...originalEnvironment, ...env };
    await globalSetup();
    expect(loadE2eDbPath()).toBe(report.dbPath);
    expect(fs.readFileSync(env.JOBCTRL_E2E_DB_PATH!, "utf8")).toBe(
      "seeded database sentinel",
    );
    expect(() =>
      seedOwnedE2eWorkspace("synthetic-unused-repository", env, seed),
    ).toThrow();
    expect(seed).toHaveBeenCalledOnce();
    await globalTeardown();
    expect(fs.existsSync(report.appDir)).toBe(false);
  });

  it.each(["ordinary", "isolated", "screenshots"])(
    "forged %s state cannot read/delete another owned run",
    async (mode) => {
      const current = fixture();
      const sibling = fixture();
      fs.writeFileSync(
        path.join(sibling.report.appDir, "sentinel"),
        "preserved",
      );
      publishReceipt(current.env, sibling.report);
      process.env = { ...originalEnvironment, ...current.env };
      if (mode === "isolated") process.env["JOBCTRL_E2E_ISOLATED"] = "1";
      if (mode === "screenshots") process.env["JOBCTRL_DOCS_SCREENSHOTS"] = "1";
      await expect(globalSetup()).rejects.toThrow("different run");
      expect(() => loadE2eDbPath()).toThrow("different run");
      await expect(globalTeardown()).rejects.toThrow("different run");
      expect(fs.existsSync(current.report.appDir)).toBe(true);
      expect(
        fs.readFileSync(path.join(sibling.report.appDir, "sentinel"), "utf8"),
      ).toBe("preserved");
    },
  );

  it("caller paths without an allocation cannot authorize setup or teardown", async () => {
    const external = fixture();
    fs.writeFileSync(
      path.join(external.report.appDir, "sentinel"),
      "preserved",
    );
    process.env = {
      ...originalEnvironment,
      JOBCTRL_E2E_APP_DIR: external.report.appDir,
      JOBCTRL_E2E_STATE_FILE: external.env.JOBCTRL_E2E_STATE_FILE,
    };
    delete process.env["JOBCTRL_E2E_WORKSPACE"];
    await expect(globalSetup()).rejects.toThrow("ownership capability");
    await expect(globalTeardown()).rejects.toThrow("ownership capability");
    expect(
      fs.readFileSync(path.join(external.report.appDir, "sentinel"), "utf8"),
    ).toBe("preserved");
  });

  it.each(["appDir", "state", "database", "marker"])(
    "%s symlinks cannot authorize setup, reads or teardown",
    async (surface) => {
      const current = fixture();
      const sibling = fixture();
      fs.writeFileSync(
        path.join(sibling.report.appDir, "sentinel"),
        "preserved",
      );
      publishReceipt(current.env, current.report);
      if (surface === "appDir") {
        const retained = current.report.appDir + "-retained";
        fs.renameSync(current.report.appDir, retained);
        roots.push(retained);
        fs.symlinkSync(sibling.report.appDir, current.report.appDir, "dir");
      } else {
        const target =
          surface === "state"
            ? current.env.JOBCTRL_E2E_STATE_FILE!
            : surface === "database"
              ? current.env.JOBCTRL_E2E_DB_PATH!
              : path.join(current.report.appDir, ".jobctrl-e2e-owned.json");
        fs.rmSync(target, { force: true });
        fs.symlinkSync(path.join(sibling.report.appDir, "sentinel"), target);
      }
      process.env = { ...originalEnvironment, ...current.env };
      await expect(globalSetup()).rejects.toThrow();
      expect(() => loadE2eDbPath()).toThrow();
      await expect(globalTeardown()).rejects.toThrow();
      expect(
        fs.readFileSync(path.join(sibling.report.appDir, "sentinel"), "utf8"),
      ).toBe("preserved");
    },
  );

  it("a forged seed report never becomes an accepted startup receipt", () => {
    const current = fixture();
    const sibling = fixture();
    const seed = vi.fn(() => JSON.stringify(sibling.report));
    expect(() =>
      seedOwnedE2eWorkspace("synthetic-unused-repository", current.env, seed),
    ).toThrow("different run");
    expect(fs.existsSync(current.env.JOBCTRL_E2E_STATE_FILE!)).toBe(false);
  });
});
