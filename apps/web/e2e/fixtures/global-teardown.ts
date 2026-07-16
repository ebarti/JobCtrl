import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { e2eStateFilePath } from "./e2e-state.js";

interface DocsScreenshotWorkspaceGuard {
  assertOwnedDocsScreenshotDirectory(appDir: string): Promise<string>;
}

const { assertOwnedDocsScreenshotDirectory } = createRequire(import.meta.url)(
  "./docs-screenshot-workspace.cjs",
) as DocsScreenshotWorkspaceGuard;

function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      return null;
    }
    current = next;
  }
  return null;
}

interface State {
  workspace?: { appDir?: string };
}

export default async function globalTeardown(): Promise<void> {
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    return;
  }
  const stateFile = e2eStateFilePath();
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as State;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  const dir = state.workspace?.appDir;
  if (dir && fs.existsSync(dir)) {
    const deletionTarget =
      process.env["JOBCTRL_DOCS_SCREENSHOTS"] === "1"
        ? await assertOwnedDocsScreenshotDirectory(dir)
        : dir;
    fs.rmSync(deletionTarget, { force: true, recursive: true });
  }
  fs.rmSync(stateFile, { force: true });
}
