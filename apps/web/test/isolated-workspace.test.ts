// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createOwnedDocsScreenshotDirectory } =
  require("../e2e/fixtures/docs-screenshot-workspace.cjs") as {
    createOwnedDocsScreenshotDirectory(): Promise<string>;
  };
const { assertIsolatedE2eWorkspace, assertExpectedWorkspace } =
  require("../e2e/fixtures/isolated-workspace.cjs") as {
    assertIsolatedE2eWorkspace(env: Record<string, string>): Promise<string>;
    assertExpectedWorkspace(
      workspace: { appDir: string; dbPath: string },
      env: Record<string, string>,
    ): void;
  };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await createOwnedDocsScreenshotDirectory();
  roots.push(root);
  return {
    root,
    env: {
      JOBCTRL_E2E_ISOLATED: "1",
      JOBCTRL_DOCS_SCREENSHOTS: "1",
      JOBCTRL_DIR: root,
      JOBCTRL_E2E_APP_DIR: root,
      JOBCTRL_DB_PATH: path.join(root, "jobctrl.db"),
      JOBCTRL_E2E_DB_PATH: path.join(root, "jobctrl.db"),
      JOBCTRL_CONFIG_PATH: path.join(root, "config.json"),
      JOBCTRL_E2E_CONFIG_PATH: path.join(root, "config.json"),
      JOBCTRL_E2E_STATE_FILE: path.join(root, "state.json"),
      JOBCTRL_E2E_SERVICE_HOME: path.join(root, "service-home"),
      TMPDIR: path.join(root, "tmp"),
    },
  };
}

describe("isolated browser fixture paths", () => {
  it("admits an explicitly marked workspace before its files exist", async () => {
    const { root, env } = await fixture();
    expect(await assertIsolatedE2eWorkspace(env)).toBe(root);
  });
  it("fails closed on missing marker, escaped DB/config and mismatched environment", async () => {
    const { root, env } = await fixture();
    for (const name of [
      "JOBCTRL_DB_PATH",
      "JOBCTRL_CONFIG_PATH",
      "JOBCTRL_E2E_STATE_FILE",
      "TMPDIR",
    ]) {
      await expect(
        assertIsolatedE2eWorkspace({
          ...env,
          [name]: path.join(os.tmpdir(), "foreign-fixture"),
        }),
      ).rejects.toThrow();
    }
    await expect(
      assertIsolatedE2eWorkspace({
        ...env,
        JOBCTRL_E2E_DB_PATH: path.join(root, "other.db"),
      }),
    ).rejects.toThrow("mismatch");
    fs.rmSync(path.join(root, ".jobctrl-docs-screenshots-owned.json"));
    await expect(assertIsolatedE2eWorkspace(env)).rejects.toThrow();
  });
  it("rejects another marker-owned run in the seed report or teardown state", async () => {
    const current = await fixture();
    const sibling = await fixture();
    const expected = {
      appDir: current.root,
      dbPath: current.env.JOBCTRL_DB_PATH,
    };
    expect(() => assertExpectedWorkspace(expected, current.env)).not.toThrow();
    expect(() =>
      assertExpectedWorkspace(
        { appDir: sibling.root, dbPath: sibling.env.JOBCTRL_DB_PATH },
        current.env,
      ),
    ).toThrow("different run");
    expect(() =>
      assertExpectedWorkspace(
        { ...expected, dbPath: sibling.env.JOBCTRL_DB_PATH },
        current.env,
      ),
    ).toThrow("different run");
  });
  it("rejects dangling symlinks at a destination and an intermediate directory", async () => {
    const { root, env } = await fixture();
    const missingTarget = path.join(root, "not-created");
    fs.symlinkSync(missingTarget, env.JOBCTRL_DB_PATH);
    await expect(assertIsolatedE2eWorkspace(env)).rejects.toThrow("symlink");
    fs.unlinkSync(env.JOBCTRL_DB_PATH);
    fs.symlinkSync(missingTarget, path.join(root, "dangling-directory"));
    await expect(
      assertIsolatedE2eWorkspace({
        ...env,
        TMPDIR: path.join(root, "dangling-directory", "tmp"),
      }),
    ).rejects.toThrow("symlink");
  });
  it("rejects symlinked destinations before any database open", async () => {
    const { root, env } = await fixture();
    fs.symlinkSync(os.tmpdir(), path.join(root, "escape"));
    await expect(
      assertIsolatedE2eWorkspace({
        ...env,
        TMPDIR: path.join(root, "escape", "nested"),
      }),
    ).rejects.toThrow("symlink");
  });
});
