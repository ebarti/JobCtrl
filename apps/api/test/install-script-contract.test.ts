import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const source = readFileSync(installScript, "utf8");
    expect(help).toContain("Interactive first-time installer");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--skip-system");
    expect(source).not.toContain("pdftoppm");
    expect(source).not.toContain("Poppler");
  });

  it("dry-runs the locked repository dependency steps", () => {
    const output = execFileSync(
      installScript,
      ["--", "--dry-run", "--yes", "--skip-system", "--skip-doctor"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toContain("corepack pnpm install --frozen-lockfile");
    expect(output).toContain("uv --project workers/automation sync --extra dev");
    expect(output).toContain("corepack pnpm --filter @jobctrl/web exec playwright install chromium");
    expect(output).toContain("uv --project workers/automation run playwright install chromium");
  });

  it("offers the standalone Homebrew Corepack package when Node has no Corepack", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "jobctrl-install-"));
    const node = join(fakeBin, "node");
    const brew = join(fakeBin, "brew");
    writeFileSync(node, "#!/bin/sh\nprintf '22.0.0\\n'\n", "utf8");
    writeFileSync(brew, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(node, 0o755);
    chmodSync(brew, 0o755);

    try {
      const result = spawnSync(
        installScript,
        ["--dry-run", "--yes", "--skip-browsers", "--skip-doctor"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            CHROME_PATH: "/bin/true",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("Install Corepack with Homebrew now? yes");
      expect(output).toContain("+ brew install corepack");
      expect(output).toContain(
        "Corepack - install Corepack directly or with Homebrew (brew install corepack)",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
