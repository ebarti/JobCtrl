import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const vitestRoot = path.dirname(require.resolve("vitest/package.json"));

it("the real extension E2E caller reports FAIL when required Chromium cannot launch", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-launch-failure-"),
  );
  const config = path.join(temporary, "vitest.config.mjs");
  const setup = path.join(temporary, "launch-failure.mjs");
  const output = path.join(temporary, "result.json");
  const message = "Missing X server: synthetic required launch rejection";
  try {
    fs.writeFileSync(
      setup,
      [
        `import { vi } from ${JSON.stringify(pathToFileURL(path.join(vitestRoot, "dist/index.js")).href)};`,
        `import { chromium } from ${JSON.stringify(pathToFileURL(require.resolve("@playwright/test")).href)};`,
        `vi.spyOn(chromium, "launchPersistentContext").mockRejectedValue(new Error(${JSON.stringify(message)}));`,
      ].join("\n"),
    );
    fs.writeFileSync(
      config,
      `export default ${JSON.stringify({
        root,
        test: {
          environment: "node",
          include: [path.join(root, "src/chromium-extension.e2e.test.ts")],
          setupFiles: [setup],
          testNamePattern: "reports HTTP 404",
        },
      })};`,
    );
    const child = spawnSync(
      process.execPath,
      [
        path.join(vitestRoot, "vitest.mjs"),
        "run",
        "--config",
        config,
        "--reporter=json",
        "--outputFile",
        output,
      ],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(fs.existsSync(output), child.stderr).toBe(true);
    const report = JSON.parse(fs.readFileSync(output, "utf8")) as {
      numFailedTests: number;
      numPassedTests: number;
      testResults: unknown[];
    };
    expect(report.numFailedTests).toBe(1);
    expect(report.numPassedTests).toBe(0);
    expect(JSON.stringify(report.testResults)).toContain(message);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}, 30_000);
