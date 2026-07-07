import fs from "node:fs";
import path from "node:path";

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
  const stateFile = path.join(repoRoot, ".jobctl-e2e-state.json");
  try {
    const raw = fs.readFileSync(stateFile, "utf-8");
    const state = JSON.parse(raw) as State;
    const dir = state.workspace?.appDir;
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
    fs.rmSync(stateFile, { force: true });
  } catch {
    // No state file or already cleaned up.
  }
}
