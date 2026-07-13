import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface SeedReport {
  appDir: string;
  dbPath: string;
  configPath: string;
}

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      throw new Error(`Could not find pnpm-workspace.yaml above ${start}`);
    }
    current = next;
  }
  throw new Error(`Could not find pnpm-workspace.yaml within 10 ancestors of ${start}`);
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = findRepoRoot(process.cwd());
  const stateFile = path.join(repoRoot, ".jobctrl-e2e-state.json");
  const targetDir = process.env["JOBCTRL_E2E_APP_DIR"];
  if (!targetDir) {
    throw new Error(
      "JOBCTRL_E2E_APP_DIR is not set; playwright.config.ts should populate it before globalSetup runs.",
    );
  }
  fs.rmSync(targetDir, { force: true, recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const stdout = execFileSync(
    "corepack",
    ["pnpm", "--filter", "@jobctrl/api", "exec", "tsx", "test/qa-seed.ts", targetDir],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8" },
  );
  const report = JSON.parse(stdout.trim()) as SeedReport;

  fs.writeFileSync(stateFile, JSON.stringify({ workspace: report, stateFile }, null, 2));
}
