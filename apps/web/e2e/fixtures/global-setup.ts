import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { e2eStateFilePath } from "./e2e-state.js";

interface DocsScreenshotWorkspaceGuard {
  prepareOwnedDocsScreenshotDirectory(appDir: string): Promise<string>;
}

const { prepareOwnedDocsScreenshotDirectory } = createRequire(import.meta.url)(
  "./docs-screenshot-workspace.cjs",
) as DocsScreenshotWorkspaceGuard;

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
  if (process.env["JOBCTRL_E2E_ISOLATED"] === "1") {
    const { assertIsolatedE2eWorkspace } = createRequire(import.meta.url)("./isolated-workspace.cjs") as { assertIsolatedE2eWorkspace(): Promise<string> };
    await assertIsolatedE2eWorkspace();
  }
  const repoRoot = findRepoRoot(process.cwd());
  const stateFile = e2eStateFilePath();
  const targetDir = process.env["JOBCTRL_E2E_APP_DIR"];
  if (!targetDir) {
    throw new Error(
      "JOBCTRL_E2E_APP_DIR is not set; playwright.config.ts should populate it before globalSetup runs.",
    );
  }
  const docsScreenshots = process.env["JOBCTRL_DOCS_SCREENSHOTS"] === "1";
  const preparedTargetDir = docsScreenshots
    ? await prepareOwnedDocsScreenshotDirectory(targetDir)
    : targetDir;
  if (!docsScreenshots) {
    fs.rmSync(targetDir, { force: true, recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (process.env["JOBCTRL_E2E_ISOLATED"] === "1") {
    fs.mkdirSync(process.env["TMPDIR"]!, { recursive: true });
    fs.mkdirSync(process.env["JOBCTRL_E2E_SERVICE_HOME"]!, { recursive: true });
  }

  const stdout = execFileSync(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@jobctrl/api",
      "exec",
      "tsx",
      "test/qa-seed.ts",
      preparedTargetDir,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8" },
  );
  const report = JSON.parse(stdout.trim()) as SeedReport;
  if (process.env["JOBCTRL_E2E_ISOLATED"] === "1") {
    const { assertExpectedWorkspace } = createRequire(import.meta.url)("./isolated-workspace.cjs") as { assertExpectedWorkspace(workspace: SeedReport): void };
    assertExpectedWorkspace(report);
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ workspace: report, stateFile }, null, 2));
}
