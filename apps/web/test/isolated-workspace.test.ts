// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createOwnedE2eWorkspace, workspaceEnvironment, OWNERSHIP_MARKER } =
  require("../e2e/fixtures/owned-workspace.cjs") as {
    createOwnedE2eWorkspace(): { appDir: string };
    workspaceEnvironment(workspace: unknown): Record<string, string>;
    OWNERSHIP_MARKER: string;
  };
const { assertIsolatedE2eWorkspace, assertExpectedWorkspace } =
  require("../e2e/fixtures/isolated-workspace.cjs") as {
    assertIsolatedE2eWorkspace(env: Record<string, string>): string;
    assertExpectedWorkspace(
      workspace: unknown,
      env: Record<string, string>,
    ): void;
  };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workspace = createOwnedE2eWorkspace();
  roots.push(workspace.appDir);
  const env: Record<string, string> = {
    ...workspaceEnvironment(workspace),
    JOBCTRL_E2E_ISOLATED: "1",
  };
  return { root: workspace.appDir, env };
}

describe("isolated browser fixture paths", () => {
  it("admits a run capability without enabling documentation screenshot writes", () => {
    const { root, env } = fixture();
    expect(assertIsolatedE2eWorkspace(env)).toBe(root);
    expect(env.JOBCTRL_DOCS_SCREENSHOTS).toBeUndefined();
  });
  it("rejects missing markers and mismatched run paths", () => {
    const { root, env } = fixture();
    for (const name of [
      "JOBCTRL_DB_PATH",
      "JOBCTRL_CONFIG_PATH",
      "JOBCTRL_E2E_STATE_FILE",
      "TMPDIR",
    ])
      expect(() =>
        assertIsolatedE2eWorkspace({
          ...env,
          [name]: path.join(root, "wrong"),
        }),
      ).toThrow("mismatch");
    fs.rmSync(path.join(root, OWNERSHIP_MARKER));
    expect(() => assertIsolatedE2eWorkspace(env)).toThrow();
  });
  it("rejects another owned run in the seed report or teardown state", () => {
    const current = fixture();
    const sibling = fixture();
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
  it("rejects dangling symlinks at database, state and temporary destinations", () => {
    for (const key of ["JOBCTRL_DB_PATH", "JOBCTRL_E2E_STATE_FILE", "TMPDIR"]) {
      const { root, env } = fixture();
      fs.symlinkSync(path.join(root, "not-created"), env[key]!);
      expect(() => assertIsolatedE2eWorkspace(env)).toThrow("symlink");
    }
  });
});
