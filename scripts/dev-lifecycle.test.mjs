import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = path.join(root, "scripts/dev");

async function createHarness() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "jobctrl-dev-lifecycle-"));
  const binDir = path.join(temporaryRoot, "bin");
  const homeDir = path.join(temporaryRoot, "home");
  const devDir = path.join(temporaryRoot, "dev");
  const fixtureLauncher = path.join(temporaryRoot, "scripts/dev");
  const eventsPath = path.join(temporaryRoot, "events.log");
  const failBuildPath = path.join(temporaryRoot, "fail-build");
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.dirname(fixtureLauncher), { recursive: true });
  await copyFile(launcher, fixtureLauncher);
  await chmod(fixtureLauncher, 0o755);
  await writeFile(eventsPath, "");

  const fakeCorepack = path.join(binDir, "corepack");
  await writeFile(
    fakeCorepack,
    `#!/usr/bin/env bash
set -euo pipefail

[[ "\${1:-}" == "pnpm" ]] && shift
arguments=" $* "

if [[ "$arguments" == " extension:build " ]]; then
  echo "build:$PWD" >> "$JOBCTRL_TEST_EVENTS"
  for file in "$JOBCTRL_DEV_DIR"/pids/*.pid; do
    [[ -f "$file" ]] || continue
    pid=$(cat "$file")
    if kill -0 "$pid" 2>/dev/null; then
      echo "build-alive:\${file##*/}:$pid" >> "$JOBCTRL_TEST_EVENTS"
    fi
  done
  [[ ! -f "$JOBCTRL_TEST_FAIL_BUILD" ]] || exit 23
  echo "build-complete" >> "$JOBCTRL_TEST_EVENTS"
  exit 0
fi

if [[ "$arguments" == *" wrangler d1 migrations apply "* ]]; then
  exit 0
fi

echo "launch:$(basename "$0"):$*" >> "$JOBCTRL_TEST_EVENTS"
if [[ "$arguments" == *" vitepress dev docs "* ]]; then
  echo "Local: http://127.0.0.1:\${JOBCTRL_DOCS_PORT}/"
elif [[ "$arguments" == *" wrangler dev "* ]]; then
  echo "Ready on http://127.0.0.1:\${JOBCTRL_DEMO_API_PORT}/"
elif [[ "$arguments" == *" exec vite "* ]]; then
  if [[ "\${VITE_JOBCTRL_APP_MODE:-}" == "demo" ]]; then
    echo "Local: http://127.0.0.1:\${JOBCTRL_DEMO_WEB_PORT}/"
  else
    echo "Local: http://127.0.0.1:\${JOBCTRL_WEB_PORT}/"
  fi
elif [[ "$arguments" == " --filter @jobctrl/api dev " ]]; then
  echo "API ready"
elif [[ "$arguments" == *" server start-dev "* || "$arguments" == *" run jobctrl worker "* ]]; then
  echo "Ready"
else
  echo "unexpected fixture invocation: $*" >&2
  exit 64
fi

exec sleep 300
`,
  );
  await chmod(fakeCorepack, 0o755);
  for (const name of ["pnpm", "temporal", "uv"]) {
    await copyFile(fakeCorepack, path.join(binDir, name));
  }
  await writeFile(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 1\n");
  await chmod(path.join(binDir, "curl"), 0o755);

  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: homeDir,
    JOBCTRL_USER_ENV_PATH: path.join(temporaryRoot, "missing.env"),
    JOBCTRL_DIR: path.join(temporaryRoot, "app"),
    JOBCTRL_DEV_DIR: devDir,
    JOBCTRL_TEST_EVENTS: eventsPath,
    JOBCTRL_TEST_FAIL_BUILD: failBuildPath,
    JOBCTRL_WEB_PORT: "45173",
    JOBCTRL_DOCS_PORT: "44174",
    JOBCTRL_DEMO_API_PORT: "48787",
    JOBCTRL_DEMO_WEB_PORT: "45174",
    JOBCTRL_BINDING_WAIT_TICKS: "50",
    JOBCTRL_BINDING_WAIT_INTERVAL_SECONDS: "0.01",
    JOBCTRL_STOP_WAIT_TICKS: "20",
    JOBCTRL_KILL_WAIT_TICKS: "20",
    JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.01",
  };

  const runResult = (...args) =>
    spawnSync(fixtureLauncher, args, {
      cwd: homeDir,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

  const run = (...args) => {
    const result = runResult(...args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };

  const runForegroundUntilReady = (...args) =>
    spawnSync(fixtureLauncher, args, {
      cwd: homeDir,
      env,
      encoding: "utf8",
      timeout: 1_500,
      killSignal: "SIGINT",
    });

  return {
    run,
    runResult,
    runForegroundUntilReady,
    temporaryRoot,
    events: () => readFile(eventsPath, "utf8"),
    async waitForLaunches(count) {
      let events;
      for (let attempt = 0; attempt < 200; attempt++) {
        events = await readFile(eventsPath, "utf8");
        if (events.split("\n").filter((event) => event.startsWith("launch:")).length >= count) {
          return events;
        }
        await delay(25);
      }
      assert.fail(`Expected ${count} fixture launches:\n${events}`);
    },
    clearEvents: () => writeFile(eventsPath, ""),
    failBuild: () => writeFile(failBuildPath, "fail"),
    pid: (name) => readFile(path.join(devDir, "pids", `${name}.pid`), "utf8"),
    logPath: (name) => path.join(devDir, "logs", `${name}.log`),
    async cleanup() {
      try {
        run("stop", "temporal", "api", "web", "worker", "docs", "demo-api", "demo-web");
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

for (const mode of ["run", "start", "restart"]) {
  for (const targets of [[], ["api", "web"]]) {
    test(`${mode} ${targets.join(" ") || "default fleet"} builds the extension once before replacing processes`, { timeout: 30_000 }, async () => {
      const harness = await createHarness();
      try {
        harness.run("start", "api", "web");
        await harness.waitForLaunches(2);
        const previousPids = await Promise.all([harness.pid("api"), harness.pid("web")]);
        await harness.clearEvents();

        let output;
        if (mode === "run") {
          const result = harness.runForegroundUntilReady(mode, ...targets);
          assert.equal(result.error?.code, "ETIMEDOUT");
          output = result.stdout;
        } else {
          output = harness.run(mode, ...targets);
        }

        const events = (await harness.waitForLaunches(targets.length || 4)).trim().split("\n");
        assert.deepEqual(events.filter((event) => event.startsWith("build:")), [
          `build:${harness.temporaryRoot}`,
        ]);
        for (const [index, name] of ["api", "web"].entries()) {
          assert.ok(events.includes(`build-alive:${name}.pid:${previousPids[index].trim()}`));
        }
        const completed = events.indexOf("build-complete");
        const launches = events.flatMap((event, index) => event.startsWith("launch:") ? [index] : []);
        assert.ok(completed >= 0);
        assert.ok(launches.length >= (targets.length || 4));
        assert.ok(launches.every((index) => index > completed), events.join("\n"));
        assert.ok(output.includes(`extension: ${harness.temporaryRoot}/dist/extension`));
        assert.match(output, /chrome:\/\/extensions.*Developer mode.*Load unpacked/);
        assert.match(output, /click Reload.*reload open application tabs/);
      } finally {
        await harness.cleanup();
      }
    });
  }

  test(`${mode} preserves existing processes and logs when the extension build fails`, { timeout: 30_000 }, async () => {
    const harness = await createHarness();
    try {
      harness.run("start", "api", "web");
      await harness.waitForLaunches(2);
      const previousPids = await Promise.all([harness.pid("api"), harness.pid("web")]);
      for (const name of ["api", "web"]) {
        await writeFile(harness.logPath(name), `previous ${name} log\n`);
      }
      await harness.clearEvents();
      await harness.failBuild();

      const failed = harness.runResult(mode, "api", "web");
      assert.equal(failed.error, undefined);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /extension build failed; existing processes were left running/);
      assert.doesNotMatch(failed.stdout, /stopped|stopping previous|started \(|running in foreground|Load unpacked/);
      for (const [index, name] of ["api", "web"].entries()) {
        assert.equal(await harness.pid(name), previousPids[index]);
        process.kill(Number(previousPids[index].trim()), 0);
        assert.equal(await readFile(harness.logPath(name), "utf8"), `previous ${name} log\n`);
        await assert.rejects(readFile(`${harness.logPath(name)}.1`), { code: "ENOENT" });
      }
      const events = await harness.events();
      assert.equal(events.split("\n").filter((event) => event.startsWith("build:")).length, 1);
      assert.doesNotMatch(events, /launch:|build-complete/);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${mode} skips the extension for component sets without product web`, { timeout: 30_000 }, async () => {
    const harness = await createHarness();
    try {
      await harness.failBuild();
      const targets = ["temporal", "api", "worker", "docs", "demo-api", "demo-web"];
      if (mode === "run") {
        const result = harness.runForegroundUntilReady(mode, ...targets);
        assert.equal(result.error?.code, "ETIMEDOUT");
        assert.match(result.stdout, /foreground run active/);
      } else {
        assert.match(harness.run(mode, ...targets), /demo-web: started/);
      }
      assert.doesNotMatch(await harness.waitForLaunches(targets.length), /build:/);
    } finally {
      await harness.cleanup();
    }
  });
}

test("status, stop, list, and help do not build the extension", async () => {
  const harness = await createHarness();
  try {
    await harness.failBuild();
    for (const mode of ["status", "stop", "list", "help"]) {
      harness.run(mode);
    }
    assert.equal(await harness.events(), "");
  } finally {
    await harness.cleanup();
  }
});
