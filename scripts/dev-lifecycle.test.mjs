import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = path.join(root, "scripts/dev");

async function createHarness() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "jobctrl-dev-lifecycle-"));
  const binDir = path.join(temporaryRoot, "bin");
  const homeDir = path.join(temporaryRoot, "home");
  const devDir = path.join(temporaryRoot, "dev");
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const fakeCorepack = path.join(binDir, "corepack");
  await writeFile(
    fakeCorepack,
    `#!/usr/bin/env bash
set -euo pipefail

[[ "\${1:-}" == "pnpm" ]] && shift
arguments=" $* "

if [[ "$arguments" == *" wrangler d1 migrations apply "* ]]; then
  exit 0
fi

if [[ "$arguments" == *" vitepress dev docs "* ]]; then
  echo "Local: http://127.0.0.1:\${JOBCTRL_DOCS_PORT}/"
elif [[ "$arguments" == *" wrangler dev "* ]]; then
  echo "Ready on http://127.0.0.1:\${JOBCTRL_DEMO_API_PORT}/"
elif [[ "$arguments" == *" exec vite "* ]]; then
  echo "Local: http://127.0.0.1:\${JOBCTRL_DEMO_WEB_PORT}/"
else
  echo "unexpected corepack invocation: $*" >&2
  exit 64
fi

exec sleep 300
`,
  );
  await chmod(fakeCorepack, 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: homeDir,
    JOBCTRL_USER_ENV_PATH: path.join(temporaryRoot, "missing.env"),
    JOBCTRL_DEV_DIR: devDir,
    JOBCTRL_DOCS_PORT: "44174",
    JOBCTRL_DEMO_API_PORT: "48787",
    JOBCTRL_DEMO_WEB_PORT: "45174",
    JOBCTRL_BINDING_WAIT_TICKS: "50",
    JOBCTRL_BINDING_WAIT_INTERVAL_SECONDS: "0.01",
    JOBCTRL_STOP_WAIT_TICKS: "20",
    JOBCTRL_KILL_WAIT_TICKS: "20",
    JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.01",
  };

  const run = (...args) =>
    execFileSync(launcher, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

  const runForegroundUntilReady = (...args) =>
    spawnSync(launcher, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 1_500,
      killSignal: "SIGINT",
    });

  return {
    run,
    runForegroundUntilReady,
    async cleanup() {
      try {
        run("stop", "docs", "demo-api", "demo-web");
      } catch {
        // The assertion failure is more useful than cleanup output.
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test("package scripts expose foreground and detached docs/demo lifecycle commands", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(
    Object.fromEntries(
      [
        "docs:dev",
        "docs:start",
        "docs:status",
        "docs:stop",
        "demo:dev",
        "demo:start",
        "demo:status",
        "demo:stop",
      ].map((name) => [name, packageJson.scripts[name]]),
    ),
    {
      "docs:dev": "scripts/dev run docs",
      "docs:start": "scripts/dev start docs",
      "docs:status": "scripts/dev status docs",
      "docs:stop": "scripts/dev stop docs",
      "demo:dev": "scripts/dev run demo-api demo-web",
      "demo:start": "scripts/dev start demo-api demo-web",
      "demo:status": "scripts/dev status demo-api demo-web",
      "demo:stop": "scripts/dev stop demo-api demo-web",
    },
  );
});

test("detached docs lifecycle starts, reports, and stops the tracked server", async () => {
  const harness = await createHarness();
  try {
    const started = harness.run("start", "docs");
    assert.match(started, /docs: started \(pid \d+, logs /);
    assert.match(started, /docs: http:\/\/127\.0\.0\.1:44174\//);

    const status = harness.run("status", "docs");
    assert.match(status, /^docs\s+up\s+\d+/m);

    const stopped = harness.run("stop", "docs");
    assert.match(stopped, /docs: stopped/);
    assert.match(harness.run("status", "docs"), /^docs\s+down\s+-/m);
  } finally {
    await harness.cleanup();
  }
});

test("demo detached lifecycle owns both API and web processes", { timeout: 30_000 }, async () => {
  const harness = await createHarness();
  try {
    const started = harness.run("start", "demo-api", "demo-web");
    assert.match(started, /demo-api: started \(pid \d+, logs /);
    assert.match(started, /demo-web: started \(pid \d+, logs /);
    assert.match(started, /demo-api: http:\/\/127\.0\.0\.1:48787\//);
    assert.match(started, /demo-web: http:\/\/127\.0\.0\.1:45174\//);

    const status = harness.run("status", "demo-api", "demo-web");
    assert.match(status, /^demo-api\s+up\s+\d+/m);
    assert.match(status, /^demo-web\s+up\s+\d+/m);

    const defaultStatus = harness.run("status");
    assert.doesNotMatch(defaultStatus, /demo-api|demo-web|docs/);
    const registry = harness.run("list");
    assert.match(registry, /^docs\s+/m);
    assert.match(registry, /^demo-api\s+/m);
    assert.match(registry, /^demo-web\s+/m);

    const stopped = harness.run("stop", "demo-api", "demo-web");
    assert.match(stopped, /demo-api: stopped/);
    assert.match(stopped, /demo-web: stopped/);
    const finalStatus = harness.run("status", "demo-api", "demo-web");
    assert.match(finalStatus, /^demo-api\s+down\s+-/m);
    assert.match(finalStatus, /^demo-web\s+down\s+-/m);
  } finally {
    await harness.cleanup();
  }
});

test("foreground demo API advances from migrations to the long-lived server", async () => {
  const harness = await createHarness();
  try {
    const result = harness.runForegroundUntilReady("run", "demo-api");
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.match(result.stdout, /\[demo-api\] Ready on http:\/\/127\.0\.0\.1:48787\//);
    assert.match(harness.run("status", "demo-api"), /^demo-api\s+down\s+-/m);
  } finally {
    await harness.cleanup();
  }
});
