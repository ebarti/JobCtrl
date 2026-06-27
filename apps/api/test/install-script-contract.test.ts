import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const installScript = join(repoRoot, "scripts/install");

describe("interactive install script contract", () => {
  it("is exposed through the root package scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["install:interactive"]).toBe("scripts/install");
    expect(statSync(installScript).mode & 0o111).not.toBe(0);
  });

  it("documents its interactive and verification modes", () => {
    execFileSync("bash", ["-n", installScript], { cwd: repoRoot });

    const help = execFileSync(installScript, ["--help"], { cwd: repoRoot, encoding: "utf8" });
    expect(help).toContain("Interactive first-time installer");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--skip-system");
  });

  it("dry-runs the locked repository dependency steps", () => {
    const output = execFileSync(
      installScript,
      ["--", "--dry-run", "--yes", "--skip-system", "--skip-doctor"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toContain("corepack pnpm install --frozen-lockfile");
    expect(output).toContain("uv --project workers/automation sync --extra dev");
    expect(output).toContain("corepack pnpm --filter @jobhunter/web exec playwright install chromium");
    expect(output).toContain("uv --project workers/automation run playwright install chromium");
  });
});
