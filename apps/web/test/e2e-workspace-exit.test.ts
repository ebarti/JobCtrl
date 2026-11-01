// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const helper = require.resolve("../e2e/fixtures/owned-workspace.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const { createOwnedE2eWorkspace, workspaceEnvironment } = require(helper) as {
  createOwnedE2eWorkspace(parent: string): { appDir: string };
  workspaceEnvironment(workspace: unknown): Record<string, string>;
};
const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0))
    fs.rmSync(parent, { recursive: true, force: true });
});

function fixture() {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-exit-")),
  );
  parents.push(parent);
  fs.writeFileSync(path.join(parent, "sentinel"), "parent preserved");
  fs.mkdirSync(path.join(parent, "sibling"));
  fs.writeFileSync(
    path.join(parent, "sibling", "sentinel"),
    "sibling preserved",
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("JOBCTRL_E2E_") || key === "JOBCTRL_DOCS_SCREENSHOTS")
      delete env[key];
  env.JOBCTRL_E2E_APP_DIR = parent;
  return { parent, env };
}

function expectSentinels(parent: string) {
  expect(fs.readFileSync(path.join(parent, "sentinel"), "utf8")).toBe(
    "parent preserved",
  );
  expect(
    fs.readFileSync(path.join(parent, "sibling", "sentinel"), "utf8"),
  ).toBe("sibling preserved");
}

it("an early creator exit removes its allocation and preserves parent and sibling", () => {
  const { parent, env } = fixture();
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const h = require(${JSON.stringify(helper)});
    const w = h.configureE2eWorkspace();
    console.log(w.appDir);
    process.exitCode = 7;
  `,
    ],
    { env, encoding: "utf8" },
  );
  expect(child.status).toBe(7);
  expect(child.stderr).toBe("");
  expect(fs.existsSync(child.stdout.trim())).toBe(false);
  expect(fs.readdirSync(parent).sort()).toEqual(["sentinel", "sibling"]);
  expectSentinels(parent);
});

it("an inheriting process leaves its wrapper-owned allocation intact", () => {
  const { parent, env } = fixture();
  const workspace = createOwnedE2eWorkspace(parent);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    require(${JSON.stringify(helper)}).configureE2eWorkspace();
  `,
    ],
    { env: { ...env, ...workspaceEnvironment(workspace) }, encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  expect(fs.existsSync(workspace.appDir)).toBe(true);
  expectSentinels(parent);
});

it("creator cleanup refuses a replaced directory and retains a diagnostic", () => {
  const { parent, env } = fixture();
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    const path = require("node:path");
    const h = require(${JSON.stringify(helper)});
    const w = h.configureE2eWorkspace();
    fs.renameSync(w.appDir, w.appDir + "-retained");
    fs.symlinkSync(${JSON.stringify(path.join(parent, "sibling"))}, w.appDir, "dir");
    console.log(w.appDir);
  `,
    ],
    { env, encoding: "utf8" },
  );
  expect(child.status).toBe(1);
  expect(child.stderr).toContain("E2E creator cleanup refused");
  expect(fs.lstatSync(child.stdout.trim()).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(child.stdout.trim() + "-retained")).toBe(true);
  expectSentinels(parent);
});

it("the real Playwright occupied-port exit cleans its allocation without using the foreign server", async () => {
  const { parent, env } = fixture();
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.end("foreign listener");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener port");
    const cli = path.join(
      path.dirname(require.resolve("@playwright/test/package.json")),
      "cli.js",
    );
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            cli,
            "test",
            "--config=e2e/playwright.config.ts",
            "tests/dashboard.spec.ts",
            "--project=chromium",
            "--workers=1",
            "--retries=0",
          ],
          {
            cwd: root,
            env: { ...env, JOBCTRL_E2E_API_PORT: String(address.port) },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += String(data);
        });
        child.stderr.on("data", (data) => {
          output += String(data);
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Playwright admission timed out"));
        }, 15_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, output });
        });
      },
    );
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("is already used");
    expect(requests).toBe(0);
    expect(server.listening).toBe(true);
    expect(fs.readdirSync(parent).sort()).toEqual(["sentinel", "sibling"]);
    expectSentinels(parent);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 20_000);
