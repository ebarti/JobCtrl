import fs from "node:fs";
import { createRequire } from "node:module";
import { e2eStateFilePath } from "./e2e-state.js";

const {
  assertE2eWorkspaceEnvironment,
  assertExpectedWorkspace,
  removeOwnedE2eWorkspace,
} = createRequire(import.meta.url)("./owned-workspace.cjs") as {
  assertE2eWorkspaceEnvironment(): unknown;
  assertExpectedWorkspace(report: unknown): void;
  removeOwnedE2eWorkspace(workspace: unknown): void;
};

export default async function globalTeardown(): Promise<void> {
  const owned = assertE2eWorkspaceEnvironment();
  try {
    const state = JSON.parse(fs.readFileSync(e2eStateFilePath(), "utf8")) as {
      workspace?: unknown;
    };
    assertExpectedWorkspace(state.workspace);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  // State is only a receipt. The independent allocation is deletion authority.
  removeOwnedE2eWorkspace(owned);
}
