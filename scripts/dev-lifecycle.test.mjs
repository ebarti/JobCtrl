import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = path.join(root, "scripts/dev");
const cleanupDiagnosticLimit = 4096;
// A verified stop can spend 20 seconds awaiting its owner. The fixture client
// must allow that bounded cleanup to finish, including serial fleet shutdown.
const fixtureCommandTimeout = 30_000;
const fixtureCaseTimeout = 3 * fixtureCommandTimeout;

function boundedFixtureDiagnostic(value, limit) {
  if (value.length <= limit) return value;
  const marker = " ... [truncated] ... ";
  const leading = Math.floor((limit - marker.length) / 2);
  return value.slice(0, leading) + marker + value.slice(-(limit - marker.length - leading));
}

function fixtureErrorSummary(error) {
  const summary = error instanceof Error
    ? `${error.name}${typeof error.code === "string" ? ` (${error.code})` : ""}: ${error.message}`
    : String(error);
  return boundedFixtureDiagnostic(summary, 1024);
}

async function waitForFixtureFile(file) {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  assert.fail(`Owned fixture marker did not appear: ${file}`);
}

async function extendFixtureOwner(file, extension) {
  const source = await readFile(file, "utf8");
  const entry = '\nif __name__ == "__main__":';
  assert.ok(source.includes(entry), "The copied owner must retain its entry point");
  await writeFile(file, source.replace(entry, `\n${extension}\n${entry}`));
}

function waitForFixtureCleanupFailure(harness, name) {
  const observed = spawnSync("python3", ["-I", "-S", "-B", "-c", `
import importlib.util,json,pathlib,sys,time
script,directory,name = sys.argv[1:]
spec = importlib.util.spec_from_file_location('fixture_failed_owner', script)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
deadline = time.monotonic() + 20
while True:
 try: answer = owner.request(owner.receipt(pathlib.Path(directory), name), 'state')
 except (OSError, ValueError, owner.Unverified): pass
 else:
  if answer == {'state':'cleanup_failed'}:
   print(json.dumps(answer))
   break
 if time.monotonic() >= deadline: raise SystemExit('No authenticated cleanup failure observed')
 time.sleep(0.02)
`, path.join(harness.temporaryRoot, "scripts/dev-process-owner.py"), path.join(harness.devDir, "pids"), name], {
    cwd: harness.temporaryRoot, env: harness.env, encoding: "utf8", timeout: fixtureCommandTimeout,
  });
  assert.equal(observed.error, undefined);
  assert.equal(observed.status, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout), { state: "cleanup_failed" });
}

async function createHarness() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "jobctrl-dev-lifecycle-"));
  const binDir = path.join(temporaryRoot, "bin");
  const homeDir = path.join(temporaryRoot, "home");
  const devDir = path.join(temporaryRoot, "dev");
  const fixtureLauncher = path.join(temporaryRoot, "scripts/dev");
  const eventsPath = path.join(temporaryRoot, "events.log");
  const failBuildPath = path.join(temporaryRoot, "fail-build");
  let primaryFailure;
  const ownedChildren = new Map();
  const trackChild = (child) => {
    const record = { child, closed: false, error: undefined };
    record.close = new Promise((resolve) => {
      child.once("close", () => { record.closed = true; resolve(); });
    });
    child.once("error", (error) => { record.error = error; });
    ownedChildren.set(child, record);
    return child;
  };
  const waitForChildClose = async (child, milliseconds = 5_000) => {
    const record = ownedChildren.get(child);
    assert.ok(record, "Only an original fixture child may be awaited");
    let timer;
    try {
      await Promise.race([
        record.close,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Owned child did not close; retain ${temporaryRoot}`)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(temporaryRoot, "tmp"), { recursive: true });
  await mkdir(path.dirname(fixtureLauncher), { recursive: true });
  await copyFile(launcher, fixtureLauncher);
  await copyFile(path.join(root, "scripts/dev-process-owner.py"), path.join(temporaryRoot, "scripts/dev-process-owner.py"));
  await extendFixtureOwner(path.join(temporaryRoot, "scripts/dev-process-owner.py"), `
from jobctrl.infrastructure import process_ownership as _fixture_process
# Spend this copied shell owner's existing budget on real read-only proof.
# Leaf TERM grace and every original-handle/signal rule stay unchanged.
_fixture_budget = cleanup_budget
@contextmanager
def cleanup_budget(seconds):
 previous = (_fixture_process._SESSION_EXIT_TIMEOUT_SECONDS, _fixture_process._UNSCOPED_CENSUS_RETRY_SECONDS)
 try:
  with _fixture_budget(seconds):
   _fixture_process._SESSION_EXIT_TIMEOUT_SECONDS = seconds
   _fixture_process._UNSCOPED_CENSUS_RETRY_SECONDS = seconds
   yield
 finally:
  (_fixture_process._SESSION_EXIT_TIMEOUT_SECONDS, _fixture_process._UNSCOPED_CENSUS_RETRY_SECONDS) = previous
`);
  await copyFile(path.join(root, "scripts/dev-schema-check.py"), path.join(temporaryRoot, "scripts/dev-schema-check.py"));
  await mkdir(path.join(temporaryRoot, "workers/automation/src"), { recursive: true });
  await symlink(path.join(root, "workers/automation/src/jobctrl"), path.join(temporaryRoot, "workers/automation/src/jobctrl"));
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

if [[ -n "\${JOBCTRL_TEST_SERVICE_LIFETIME_SECONDS:-}" ]]; then
  exec sleep "$JOBCTRL_TEST_SERVICE_LIFETIME_SECONDS"
fi
exec sleep 300
`,
  );
  await chmod(fakeCorepack, 0o755);
  for (const name of ["pnpm", "temporal", "uv"]) {
    await copyFile(fakeCorepack, path.join(binDir, name));
  }
  await writeFile(path.join(temporaryRoot, "scripts/fixture-controller-owner.py"), `import importlib.util,json,os,pathlib,sys
script = sys.argv.pop(1)
spec = importlib.util.spec_from_file_location('fixture_source_owner', script)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
from jobctrl.infrastructure import process_ownership
# This fake controller owns the supervisor session; its leaf services have
# separate sessions. It must not KILL their original launch owners mid-drain.
# Share the existing cleanup deadline as cooperative grace. Deadline expiry
# retains custody before group KILL; the 20-second Stop reply bound is unchanged.
original_cleanup_budget = owner.cleanup_budget
@owner.contextmanager
def controller_cleanup_budget(seconds):
 original_grace = process_ownership._PROCESS_TERMINATION_GRACE_SECONDS
 try:
  with original_cleanup_budget(seconds):
   process_ownership._PROCESS_TERMINATION_GRACE_SECONDS = seconds
   yield
 finally:
  process_ownership._PROCESS_TERMINATION_GRACE_SECONDS = original_grace
owner.cleanup_budget = controller_cleanup_budget
original_terminate = owner.terminate_owned_process
def terminate(child, *, launched_pid):
 marker = os.environ.get('JOBCTRL_TEST_CONTROLLER_STOP_STARTED')
 if marker: pathlib.Path(marker).write_text('started')
 try:
  return original_terminate(child, launched_pid=launched_pid)
 finally:
  report = os.environ.get('JOBCTRL_TEST_SUPERVISOR_CUSTODY_PROOF')
  if report:
   event = owner._waitid_nowait(child.pid) if child.returncode is None else None
   owner.atomic_write(pathlib.Path(report), json.dumps({'originalPid':child.pid, 'returncode':child.returncode, 'eventCode':None if event is None else event.si_code}).encode())
owner.terminate_owned_process = terminate
raise SystemExit(owner.main())
`);
  // Product ownership is exercised by the native source-controller tests;
  // these shell fixtures reuse the launch owner in a separate controller namespace.
  await writeFile(path.join(binDir, "go"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-C" && "$3" == "run" && "$4" == "./cmd/jobctrl-source" ]]
root="$6"
controller_dir="$JOBCTRL_DEV_DIR/source-controller"
mkdir -p "$controller_dir"
if [[ "$5" == "stop" || "$5" == "switch" ]]; then
  exec python3 -B "$root/scripts/dev-process-owner.py" stop "$controller_dir" api
fi
[[ "$5" != "verify" ]] || exit 0
[[ "$5" == "run" ]]
shift 6
export JOBCTRL_DEV_INNER=1
printf -v command 'exec %q run' "$root/scripts/dev"
for component in "$@"; do printf -v command '%s %q' "$command" "$component"; done
launch_id=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
python3 -B "$root/scripts/fixture-controller-owner.py" "$root/scripts/dev-process-owner.py" launch "$controller_dir" api "$launch_id" "$command" &
controller_child=$!
finish() {
  python3 -B "$root/scripts/dev-process-owner.py" stop "$controller_dir" api
  wait "$controller_child"
  exit "$1"
}
trap 'finish 130' INT
trap 'finish 143' TERM
wait "$controller_child"
`);
  await chmod(path.join(binDir, "go"), 0o755);
  await writeFile(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 1\n");
  await chmod(path.join(binDir, "curl"), 0o755);

  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: homeDir,
    TMPDIR: path.join(temporaryRoot, "tmp"),
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
      timeout: fixtureCommandTimeout,
    });

  const run = (...args) => {
    const result = runResult(...args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };

  const runForegroundUntilReady = (...args) =>
    new Promise((resolve, reject) => {
      const child = trackChild(spawn(fixtureLauncher, args, {
        cwd: homeDir,
        env,
        detached: true,
      }));
      const targets = args.length > 1 ? args.slice(1) : ["temporal", "api", "web", "worker"];
      const readiness = {
        temporal: "[temporal] Ready",
        api: "[api] API ready",
        web: "[web] Local:",
        worker: "[worker] Ready",
        docs: "[docs] Local:",
        "demo-api": "[demo-api] Ready on",
        "demo-web": "[demo-web] Local:",
      };
      let stdout = "";
      let stderr = "";
      let stopping = false;
      const signalChild = (signal) => {
        try { child.kill(signal); }
        catch (error) { reject(error); }
      };
      const deadline = setTimeout(() => {
        signalChild("SIGTERM");
        reject(new Error(`Foreground fixture did not start and stop within ${fixtureCommandTimeout / 1000}s:\n${stdout}\n${stderr}`));
      }, fixtureCommandTimeout);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!stopping && stdout.includes("dev: foreground run active;") &&
            targets.every((name) => stdout.includes(readiness[name]))) {
          stopping = true;
          // The original supervisor handles cancellation and drains its owners.
          signalChild("SIGINT");
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("close", (status, signal) => {
        clearTimeout(deadline);
        if (!stopping) {
          reject(new Error(`Foreground fixture exited before readiness:\n${stdout}\n${stderr}`));
          return;
        }
        resolve({ status, signal, stdout, stderr });
      });
    });

  return {
    run,
    runResult,
    runForegroundUntilReady,
    temporaryRoot,
    devDir,
    binDir,
    env,
    trackChild,
    waitForChildClose,
    recordFailure: (error) => { primaryFailure = error; },
    spawnPeer: () => trackChild(spawn("/bin/sleep", ["300"], { cwd: homeDir, env, stdio: "ignore" })),
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
    async cleanup(priorFailure, originalFailure = primaryFailure) {
      const failures = [];
      const diagnostics = [];
      const cleanupPhases = new Set();
      const recordCleanupFailure = (phase, error) => {
        failures.push(error);
        cleanupPhases.add(phase);
        diagnostics.push(`${phase}: ${fixtureErrorSummary(error)}`);
      };
      if (priorFailure) recordCleanupFailure("prior-cleanup", priorFailure);
      try {
        run("stop", "temporal", "api", "web", "worker", "docs", "demo-api", "demo-web");
      } catch (error) {
        recordCleanupFailure("managed-stop", error);
        for (const name of ["source-supervisor", "temporal", "api", "web", "worker", "docs", "demo-api", "demo-web"]) {
          try {
            const file = path.join(devDir, "logs", `${name}.log`);
            const info = await lstat(file);
            if (!info.isFile() || info.nlink !== 1) continue;
            const handle = await open(file, "r");
            try {
              const tail = Buffer.alloc(Math.min(info.size, 2048));
              await handle.read(tail, 0, tail.length, Math.max(0, info.size - tail.length));
              diagnostics.push(`owned ${name} fixture log: ${tail.toString("utf8")}`);
            } finally { await handle.close(); }
          } catch (logError) {
            if (logError.code !== "ENOENT") diagnostics.push(`owned ${name} fixture log: ${logError.name}`);
          }
        }
      }
      for (const record of ownedChildren.values()) {
        const { child } = record;
        try {
          if (!record.closed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          try {
            await waitForChildClose(child);
          } catch (closeError) {
            recordCleanupFailure("child-close", closeError);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await waitForChildClose(child);
          }
          if (record.error) recordCleanupFailure("child-error", record.error);
        } catch (cleanupError) {
          recordCleanupFailure("child-cleanup", cleanupError);
        }
      }
      if (!failures.length) {
        try { await rm(temporaryRoot, { recursive: true, force: true }); }
        catch (error) { recordCleanupFailure("remove-root", error); }
      }
      if (failures.length) {
        const primary = originalFailure === undefined ? "none recorded" : fixtureErrorSummary(originalFailure);
        const message = `Fixture cleanup unverified; retained ${temporaryRoot}\ncleanup phases: ${[...cleanupPhases].join(", ")}\nprimary: ${primary}\n${diagnostics.join("\n")}`;
        throw new AggregateError(
          originalFailure !== undefined ? [originalFailure, ...failures] : failures,
          boundedFixtureDiagnostic(message, cleanupDiagnosticLimit),
          { cause: originalFailure },
        );
      }
    },
  };
}

test("default startup keeps the diagnostic interface when the database needs an upgrade", async () => {
  const harness = await createHarness();
  try {
    const appDir = path.join(harness.temporaryRoot, "app");
    await mkdir(appDir, { recursive: true });
    const seed = spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=14'); c.close()", path.join(appDir, "jobctrl.db")]);
    assert.equal(seed.status, 0);
    assert.match(harness.run("start"), /incompatible workspace database/);
    const events = await harness.waitForLaunches(2);
    assert.match(events, /--filter @jobctrl\/api dev/);
    assert.match(events, /exec vite/);
    assert.doesNotMatch(events, /server start-dev|run jobctrl worker/);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("an explicit worker start refuses an incompatible database", async () => {
  const harness = await createHarness();
  try {
    const appDir = path.join(harness.temporaryRoot, "app");
    await mkdir(appDir, { recursive: true });
    const database = path.join(appDir, "jobctrl.db");
    const seed = spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=14'); c.close()", database]);
    assert.equal(seed.status, 0);
    const before = await readFile(database);
    const result = harness.runResult("run", "worker");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /workspace database needs a compatible upgrade/);
    assert.doesNotMatch(await harness.events(), /launch:/);
    assert.deepEqual(await readFile(database), before);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("a source start does not kill an unverified tracked process", { skip: process.platform !== "darwin" }, async () => {
  const harness = await createHarness();
  const previous = harness.spawnPeer();
  try {
    const pidDir = path.join(harness.temporaryRoot, "dev", "pids");
    await mkdir(pidDir, { recursive: true });
    await writeFile(path.join(pidDir, "api.pid"), String(previous.pid));
    const result = harness.runResult("run", "api");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /process ownership or cleanup could not be verified/);
    process.kill(previous.pid, 0);
    assert.doesNotMatch(await harness.events(), /launch:/);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    let failure;
    try { await rm(path.join(harness.temporaryRoot, "dev", "pids", "api.pid"), { force: true }); }
    catch (error) { failure = error; }
    await harness.cleanup(failure);
  }
});

test("fake source-controller stop ignores legacy PID metadata", async () => {
  const harness = await createHarness();
  const peer = harness.spawnPeer();
  const legacy = path.join(harness.devDir, "pids", "source-controller.pid");
  try {
    await mkdir(path.dirname(legacy), { recursive: true });
    const original = `${peer.pid}\n`;
    await writeFile(legacy, original);
    const result = spawnSync(path.join(harness.binDir, "go"), [
      "-C", path.join(harness.temporaryRoot, "launcher"), "run", "./cmd/jobctrl-source",
      "stop", harness.temporaryRoot,
    ], { cwd: harness.temporaryRoot, env: harness.env, encoding: "utf8", timeout: 5_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(legacy, "utf8"), original);
    assert.equal(peer.exitCode, null);
    assert.equal(peer.signalCode, null);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("fixture cleanup retains unverified state and closes its original peer", async () => {
  const harness = await createHarness();
  const peer = harness.spawnPeer();
  const pidFile = path.join(harness.devDir, "pids", "docs.pid");
  try {
    await mkdir(path.dirname(pidFile), { recursive: true });
    const original = `${peer.pid}\n`;
    await writeFile(pidFile, original);
    const originalFailure = new Error("synthetic test-body failure ".repeat(300));
    await assert.rejects(harness.cleanup(undefined, originalFailure), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], originalFailure);
      assert.equal(error.cause, originalFailure);
      assert.match(error.message, /Fixture cleanup unverified; retained/);
      assert.match(error.message, /primary: Error: synthetic test-body failure/);
      assert.match(error.message, /managed-stop: AssertionError/);
      assert.match(error.message, /\[truncated\]/);
      assert.ok(error.message.length <= cleanupDiagnosticLimit);
      return true;
    });
    assert.equal(await readFile(pidFile, "utf8"), original);
    assert.ok(peer.exitCode !== null || peer.signalCode !== null);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    let failure;
    try {
      if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGTERM");
      await harness.waitForChildClose(peer);
      harness.run("forget", "docs");
    } catch (error) { failure = error; }
    await harness.cleanup(failure);
  }
});

async function verifyFakeControllerBlockedDrain(holdMs, expires) {
  const harness = await createHarness();
  const ready = path.join(harness.temporaryRoot, "receipt-lock-held");
  const release = path.join(harness.temporaryRoot, "release-receipt-lock");
  const stopping = path.join(harness.temporaryRoot, "controller-cleanup-started");
  const custodyProof = path.join(harness.temporaryRoot, "supervisor-custody-proof");
  harness.env.JOBCTRL_TEST_CONTROLLER_STOP_STARTED = stopping;
  harness.env.JOBCTRL_TEST_SUPERVISOR_CUSTODY_PROOF = custodyProof;
  // Bound service lifetime even if a regression destroys a leaf's custodian.
  harness.env.JOBCTRL_TEST_SERVICE_LIFETIME_SECONDS = "40";
  try {
    const targets = ["temporal", "api", "worker", "docs", "demo-api", "demo-web"];
    const foreground = harness.trackChild(spawn(path.join(harness.temporaryRoot, "scripts/dev"), ["run", ...targets], {
      cwd: harness.temporaryRoot, env: harness.env, stdio: ["ignore", "pipe", "pipe"],
    }));
    let foregroundOutput = "";
    foreground.stdout.on("data", (chunk) => { foregroundOutput += chunk; });
    foreground.stderr.on("data", (chunk) => { foregroundOutput += chunk; });
    await harness.waitForLaunches(targets.length);
    for (let attempt = 0; attempt < 250 && !foregroundOutput.includes("dev: foreground run active;"); attempt++) await delay(20);
    assert.ok(foregroundOutput.includes("dev: foreground run active;"), foregroundOutput);
    const receiptPaths = [
      ...targets.map((name) => path.join(harness.devDir, "pids", name)),
      path.join(harness.devDir, "source-controller/api"),
    ].flatMap((base) => [`${base}.pid`, `${base}.identity.json`]);
    const originalReceipts = await Promise.all(receiptPaths.map((file) => readFile(file)));
    const peer = harness.spawnPeer();
    const holder = harness.trackChild(spawn("python3", ["-I", "-S", "-B", "-c", `
import fcntl,os,pathlib,sys,time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW)
try:
 fcntl.flock(fd, fcntl.LOCK_EX)
 pathlib.Path(sys.argv[2]).write_text('held')
 while not pathlib.Path(sys.argv[3]).exists(): time.sleep(0.02)
finally: os.close(fd)
`, path.join(harness.devDir, "pids/temporal.lock"), ready, release], {
      cwd: harness.temporaryRoot, env: harness.env, stdio: "ignore",
    }));
    assert.equal(await waitForFixtureFile(ready), "held");
    const stop = harness.trackChild(spawn(path.join(harness.temporaryRoot, "scripts/dev"), ["stop", ...targets], {
      cwd: harness.temporaryRoot, env: harness.env, stdio: ["ignore", "pipe", "pipe"],
    }));
    let output = "";
    stop.stdout.on("data", (chunk) => { output += chunk; });
    stop.stderr.on("data", (chunk) => { output += chunk; });
    assert.equal(await waitForFixtureFile(stopping), "started");
    // Preserve the old control, exceed its former eight-second controller
    // grace, and separately exceed the existing sixteen-second cleanup budget.
    await delay(holdMs);
    if (expires) {
      await harness.waitForChildClose(stop, 2_000);
      assert.equal(stop.exitCode, 1, output);
      assert.match(output, /process ownership or cleanup could not be verified/);
      const proof = JSON.parse(await waitForFixtureFile(custodyProof));
      assert.ok(Number.isInteger(proof.originalPid) && proof.originalPid > 1);
      assert.equal(proof.returncode, null, JSON.stringify(proof));
      assert.equal(proof.eventCode, null, JSON.stringify(proof));
      // Authenticate the still-live owners without waiting on the held
      // publication lock. These requests never signal discovered PIDs.
      const custody = spawnSync("python3", ["-I", "-S", "-B", "-c", `
import importlib.util,json,pathlib,sys
script,directory = sys.argv[1:]
spec = importlib.util.spec_from_file_location('fixture_custody_probe', script)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
directory = pathlib.Path(directory)
result = {}
for name in ['temporal','api','worker','docs','demo-api','demo-web']:
 record = owner.receipt(directory / 'pids', name)
 result[name] = owner.request(record, 'state')
result['controller'] = owner.request(owner.receipt(directory / 'source-controller', 'api'), 'state')
print(json.dumps(result))
`, path.join(harness.temporaryRoot, "scripts/dev-process-owner.py"), harness.devDir], {
        cwd: harness.temporaryRoot, env: harness.env, encoding: "utf8", timeout: 5_000,
      });
      assert.equal(custody.error, undefined);
      assert.equal(custody.status, 0, custody.stderr);
      const authenticated = JSON.parse(custody.stdout);
      for (const name of targets) assert.deepEqual(authenticated[name], { state: "running" });
      assert.deepEqual(authenticated.controller, { state: "cleanup_failed" });
      assert.deepEqual(await Promise.all(receiptPaths.map((file) => readFile(file))), originalReceipts);
      process.kill(peer.pid, 0);
    }
    await writeFile(release, "release");
    await harness.waitForChildClose(holder);
    assert.equal(holder.exitCode, 0);
    if (expires) {
      const retry = harness.trackChild(spawn(path.join(harness.temporaryRoot, "scripts/dev"), ["stop", ...targets], {
        cwd: harness.temporaryRoot, env: harness.env, stdio: ["ignore", "pipe", "pipe"],
      }));
      let retryOutput = "";
      retry.stdout.on("data", (chunk) => { retryOutput += chunk; });
      retry.stderr.on("data", (chunk) => { retryOutput += chunk; });
      await harness.waitForChildClose(retry, 10_000);
      assert.equal(retry.exitCode, 0, retryOutput);
    } else {
      await harness.waitForChildClose(stop, 10_000);
      assert.equal(stop.exitCode, 0, output);
    }
    await harness.waitForChildClose(foreground, 10_000);
    assert.equal(foreground.exitCode, 0, foregroundOutput);
    assert.equal(peer.exitCode, null);
    assert.equal(peer.signalCode, null);
    process.kill(peer.pid, 0);
    for (const file of receiptPaths) {
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    let releaseFailure;
    try { await writeFile(release, "release"); } catch (error) { releaseFailure = error; }
    await harness.cleanup(releaseFailure);
  }
}

for (const { holdMs, expires } of [
  { holdMs: 3_500, expires: false },
  { holdMs: 9_000, expires: false },
  { holdMs: 17_500, expires: true },
]) {
  test(`a fake source controller ${expires ? "retains custody after" : "finishes"} a ${holdMs / 1000}s blocked drain`, {
    skip: process.platform !== "darwin", timeout: fixtureCaseTimeout,
  }, async () => {
    await verifyFakeControllerBlockedDrain(holdMs, expires);
  });
}

async function verifyFixtureCensusRecovery(naturalExit, expires) {
  const harness = await createHarness();
  const release = path.join(harness.temporaryRoot, "census-release");
  const ready = path.join(harness.temporaryRoot, "census-ready");
  const report = path.join(harness.temporaryRoot, "census-report");
  harness.env.JOBCTRL_TEST_CENSUS_RELEASE = release;
  harness.env.JOBCTRL_TEST_CENSUS_READY = ready;
  harness.env.JOBCTRL_TEST_CENSUS_REPORT = report;
  const peer = harness.spawnPeer();
  try {
    const script = path.join(harness.temporaryRoot, "scripts/dev-process-owner.py");
    await extendFixtureOwner(script, `
if len(sys.argv) > 3 and sys.argv[1] == 'launch' and sys.argv[3] == 'docs':
 _release = Path(os.environ['JOBCTRL_TEST_CENSUS_RELEASE'])
 _ready = Path(os.environ['JOBCTRL_TEST_CENSUS_READY'])
 _report = Path(os.environ['JOBCTRL_TEST_CENSUS_REPORT'])
 _real_inventory = _fixture_process._read_process_inventory
 _real_terminate = terminate_owned_process
 _incomplete_reads = 0
 def inventory(**kwargs):
  global _incomplete_reads
  if _release.exists(): return _real_inventory(**kwargs)
  original_ids = _fixture_process._darwin_process_ids
  child = None
  initial = None
  def ids(library):
   nonlocal child, initial
   observed = original_ids(library)
   if child is None:
    initial = observed
    child = subprocess.Popen(['/bin/sleep', '60'], start_new_session=True)
   elif child.pid in initial or child.pid not in observed:
    raise ProcessOwnershipError('Controlled census birth was not observable')
   return observed
  _fixture_process._darwin_process_ids = ids
  try:
   observed, complete = _real_inventory(**kwargs)
   if complete: raise ProcessOwnershipError('Controlled census was unexpectedly complete')
   _incomplete_reads += 1
   if not _ready.exists(): atomic_write(_ready, b'actual-incomplete-kernel-inventory')
   return observed, complete
  finally:
   _fixture_process._darwin_process_ids = original_ids
   if child is not None:
    child.terminate()
    child.wait(timeout=2)
 def terminate_owned_process(child, *, launched_pid):
  error = None
  try: return _real_terminate(child, launched_pid=launched_pid)
  except ProcessOwnershipError as failure:
   error = str(failure)
   raise
  finally:
   event = _waitid_nowait(child.pid) if child.returncode is None else None
   atomic_write(_report, json.dumps({'error':error, 'incompleteReads':_incomplete_reads, 'pid':child.pid, 'returncode':child.returncode, 'eventPid':None if event is None else event.si_pid}).encode())
 _fixture_process._read_process_inventory = inventory
`);
    const directory = path.join(harness.devDir, "pids");
    await mkdir(directory, { recursive: true });
    const owner = harness.trackChild(spawn("python3", ["-I", "-S", "-B", script, "launch", directory, "docs", "d".repeat(64),
      naturalExit ? "exit 0" : "exec /bin/sleep 40"], {
      cwd: harness.temporaryRoot, env: harness.env, stdio: ["ignore", "pipe", "pipe"],
    }));
    let ownerOutput = "";
    owner.stdout.on("data", (chunk) => { ownerOutput += chunk; });
    owner.stderr.on("data", (chunk) => { ownerOutput += chunk; });
    const files = ["docs.pid", "docs.identity.json"].map((name) => path.join(directory, name));
    await waitForFixtureFile(files[0]);
    const before = await Promise.all(files.map((file) => readFile(file)));
    let stop;
    let stopOutput = "";
    if (!naturalExit) {
      stop = harness.trackChild(spawn("python3", ["-I", "-S", "-B", script, "stop", directory, "docs"], {
        cwd: harness.temporaryRoot, env: harness.env, stdio: ["ignore", "pipe", "pipe"],
      }));
      stop.stdout.on("data", (chunk) => { stopOutput += chunk; });
      stop.stderr.on("data", (chunk) => { stopOutput += chunk; });
    }
    // Each negative read retains an actual new child between the original
    // kernel enumerations. Clearing the fault restores only unchanged reads.
    assert.equal(await waitForFixtureFile(ready), "actual-incomplete-kernel-inventory");
    await delay(expires ? 17_500 : 4_000);
    if (expires) {
      await harness.waitForChildClose(stop, 2_000);
      assert.equal(stop.exitCode, 1, stopOutput);
      const first = JSON.parse(await waitForFixtureFile(report));
      assert.match(first.error, /cleanup deadline expired/);
      assert.ok(first.incompleteReads > 0);
      assert.equal(first.returncode, null);
      assert.equal(first.eventPid, first.pid);
      waitForFixtureCleanupFailure(harness, "docs");
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
      process.kill(peer.pid, 0);
    } else {
      await assert.rejects(readFile(report), { code: "ENOENT" });
    }
    await writeFile(release, "clear");
    if (expires) {
      assert.match(harness.run("stop", "docs"), /docs: stopped/);
    } else if (stop) {
      await harness.waitForChildClose(stop, 10_000);
      assert.equal(stop.exitCode, 0, stopOutput);
    }
    await harness.waitForChildClose(owner, 10_000);
    assert.equal(owner.exitCode, 0, ownerOutput);
    if (naturalExit) assert.match(harness.run("stop", "docs"), /docs: not running/);
    const final = JSON.parse(await readFile(report, "utf8"));
    assert.equal(final.error, null, JSON.stringify(final));
    assert.ok(final.incompleteReads > 0);
    process.kill(peer.pid, 0);
    for (const file of files) await assert.rejects(readFile(file), { code: "ENOENT" });
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await writeFile(release, "clear");
    await harness.cleanup();
  }
}

for (const naturalExit of [false, true]) {
  test(`fixture census waits for real proof after temporary uncertainty with ${naturalExit ? "an exited" : "a live"} original root`, {
    skip: process.platform !== "darwin", timeout: fixtureCaseTimeout,
  }, async () => {
    await verifyFixtureCensusRecovery(naturalExit, false);
  });
}

test("fixture census retains custody at its deadline and retries after uncertainty clears", {
  skip: process.platform !== "darwin", timeout: fixtureCaseTimeout,
}, async () => {
  await verifyFixtureCensusRecovery(false, true);
});

test("concurrent Stop clients serialize receipt retirement and preserve a peer", { timeout: 30_000 }, async () => {
  const harness = await createHarness();
  const release = path.join(harness.temporaryRoot, "release-first-stop");
  try {
    harness.run("start", "docs", "demo-web");
    await harness.waitForLaunches(2);
    const peerPid = await harness.pid("demo-web");
    const client = path.join(harness.temporaryRoot, "gated-stop.py");
    await writeFile(client, `import fcntl,importlib.util,os,pathlib,sys,time
script,directory,name,role,ready,release = sys.argv[1:]
spec = importlib.util.spec_from_file_location('fixture_stop_client', script)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
if role == 'first':
 original_request = owner.request
 def request(value, action):
  if action == 'stop':
   owner.atomic_write(pathlib.Path(ready), b'entered')
   while not pathlib.Path(release).exists(): time.sleep(0.02)
  return original_request(value, action)
 owner.request = request
else:
 fd = os.open(pathlib.Path(directory) / (name + '.stop.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
 try:
  try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
  except BlockingIOError: owner.atomic_write(pathlib.Path(ready), b'blocked')
  else:
   owner.atomic_write(pathlib.Path(ready), b'unlocked')
   fcntl.flock(fd, fcntl.LOCK_UN)
 finally: os.close(fd)
sys.argv = [script, 'stop', directory, name]
raise SystemExit(owner.main())
`);
    const startClient = (role, ready) => {
      const child = harness.trackChild(spawn("python3", ["-I", "-S", "-B", client,
        path.join(harness.temporaryRoot, "scripts/dev-process-owner.py"),
        path.join(harness.devDir, "pids"), "docs", role, ready, release], {
        cwd: harness.temporaryRoot, env: harness.env, stdio: ["ignore", "pipe", "pipe"],
      }));
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      return { child, output: () => output };
    };
    const firstReady = path.join(harness.temporaryRoot, "first-stop-entered");
    const secondReady = path.join(harness.temporaryRoot, "second-stop-probe");
    const first = startClient("first", firstReady);
    assert.equal(await waitForFixtureFile(firstReady), "entered");
    const second = startClient("second", secondReady);
    // This is a kernel lock observation while the first real request is held,
    // rather than an assumption that a scheduled client has had time to run.
    assert.equal(await waitForFixtureFile(secondReady), "blocked");
    await writeFile(release, "release");
    await harness.waitForChildClose(first.child, 10_000);
    await harness.waitForChildClose(second.child, 10_000);
    assert.equal(first.child.exitCode, 0, first.output());
    assert.equal(second.child.exitCode, 0, second.output());
    assert.match(first.output(), /^stopped\s*$/);
    assert.match(second.output(), /^not running\s*$/);
    assert.equal(await harness.pid("demo-web"), peerPid);
    assert.match(harness.run("status", "demo-web"), /demo-web\s+up\b/);
    await assert.rejects(readFile(path.join(harness.devDir, "pids/docs.identity.json")), { code: "ENOENT" });
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    let releaseFailure;
    try { await writeFile(release, "release"); } catch (error) { releaseFailure = error; }
    await harness.cleanup(releaseFailure);
  }
});

test("PID-only records cannot authorize status, stop, or startup replacement", async () => {
  const harness = await createHarness();
  const peer = harness.spawnPeer();
  const pidFile = path.join(harness.devDir, "pids", "docs.pid");
  try {
    await mkdir(path.dirname(pidFile), { recursive: true });
    const original = `${peer.pid}\n`;
    await writeFile(pidFile, original);
    assert.match(harness.run("status", "docs"), /^docs\s+unverified\s+-/m);
    for (const mode of ["stop", "stop", "start", "restart", "run"]) {
      const result = harness.runResult(mode, "docs");
      assert.notEqual(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /records retained/);
      assert.match(result.stderr, /scripts\/dev forget docs/);
      process.kill(peer.pid, 0);
      assert.equal(await readFile(pidFile, "utf8"), original);
      assert.doesNotMatch(await harness.events(), /launch:/);
    }
    assert.match(harness.run("forget", "docs"), /no process was signalled/);
    process.kill(peer.pid, 0);
    assert.match(harness.run("status", "docs"), /^docs\s+down\s+-/m);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    let failure;
    try { await rm(pidFile, { force: true }); }
    catch (error) { failure = error; }
    await harness.cleanup(failure);
  }
});

for (const corruption of ["pid", "identity", "malformed", "missing endpoint"]) {
  test(`a ${corruption} mismatch preserves the unrelated process and original receipt`, async () => {
    const harness = await createHarness();
    const peer = harness.spawnPeer();
    const pidFile = path.join(harness.devDir, "pids", "docs.pid");
    const identityFile = path.join(harness.devDir, "pids", "docs.identity.json");
    let originalPid;
    let originalIdentity;
    try {
      harness.run("start", "docs");
      originalPid = await readFile(pidFile);
      originalIdentity = await readFile(identityFile);
      const identity = JSON.parse(originalIdentity);
      if (corruption === "pid") await writeFile(pidFile, `${peer.pid}\n`);
      else if (corruption === "malformed") await writeFile(identityFile, "{broken receipt\n");
      else {
        if (corruption === "identity") identity.id = "0".repeat(64);
        else identity.socket = path.join(harness.temporaryRoot, "missing-control");
        await writeFile(identityFile, JSON.stringify(identity));
      }
      const retainedPid = await readFile(pidFile);
      const retainedIdentity = await readFile(identityFile);
      assert.match(harness.run("status", "docs"), /^docs\s+unverified\s+-/m);
      for (const mode of ["stop", "start"]) {
        const result = harness.runResult(mode, "docs");
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /records retained/);
        process.kill(peer.pid, 0);
        assert.deepEqual(await readFile(pidFile), retainedPid);
        assert.deepEqual(await readFile(identityFile), retainedIdentity);
      }
    } catch (error) {
      harness.recordFailure(error);
      throw error;
    } finally {
      let failure;
      try {
        if (originalPid) await writeFile(pidFile, originalPid);
        if (originalIdentity) await writeFile(identityFile, originalIdentity);
      } catch (error) { failure = error; }
      await harness.cleanup(failure);
    }
  });
}

test("a verified source launch stops, restarts normally, and preserves an independent peer", async () => {
  const harness = await createHarness();
  const peer = harness.spawnPeer();
  try {
    harness.run("start", "docs");
    const previous = await harness.pid("docs");
    const receipt = JSON.parse(await readFile(path.join(harness.devDir, "pids/docs.identity.json"), "utf8"));
    const check = (pid, id = receipt.id) => spawnSync("python3", [
      "-B", path.join(harness.temporaryRoot, "scripts/dev-process-owner.py"), "check",
      path.join(harness.devDir, "pids"), "docs", id, String(pid),
    ], { env: harness.env, encoding: "utf8" });
    assert.equal(check(receipt.pid).status, 0);
    assert.notEqual(check(peer.pid).status, 0);
    assert.notEqual(check(receipt.pid, "0".repeat(64)).status, 0);
    process.kill(peer.pid, 0);
    const refused = harness.runResult("forget", "docs");
    assert.notEqual(refused.status, 0);
    assert.equal(await harness.pid("docs"), previous);
    assert.match(harness.run("stop", "docs"), /docs: stopped/);
    assert.match(harness.run("stop", "docs"), /docs: not running/);
    harness.run("start", "docs");
    assert.match(harness.run("status", "docs"), /^docs\s+up\s+\d+/m);
    harness.run("restart", "docs");
    assert.match(harness.run("status", "docs"), /^docs\s+up\s+\d+/m);
    process.kill(peer.pid, 0);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("verified cleanup exits after a disconnected stop client", { timeout: 30_000 }, async () => {
  const harness = await createHarness();
  const ownerScript = path.join(harness.temporaryRoot, "scripts/dev-process-owner.py");
  const pidDir = path.join(harness.devDir, "pids");
  await mkdir(pidDir, { recursive: true });
  const owner = harness.trackChild(spawn("python3", [
    "-B", ownerScript, "launch", pidDir, "docs", "1".repeat(64), "exec /bin/sleep 300",
  ], { cwd: harness.temporaryRoot, env: harness.env, stdio: "ignore" }));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (/^docs\s+up\s+\d+/m.test(harness.run("status", "docs"))) { ready = true; break; }
      await delay(20);
    }
    assert.ok(ready, `Owner did not become ready (exit ${owner.exitCode})`);
    const client = spawnSync("python3", ["-B", "-c", `
import hmac, pathlib, runpy, secrets, socket, sys
owner = runpy.run_path(sys.argv[1], run_name="stop_client")
value = owner["receipt"](pathlib.Path(sys.argv[2]), "docs")
with socket.socket(socket.AF_UNIX) as channel:
    channel.settimeout(2)
    endpoint = pathlib.Path(value["socket"])
    with owner["at_directory"](endpoint.parent):
        channel.connect(endpoint.name)
    challenge = secrets.token_hex(32)
    owner["send"](channel, {"jobctrlSourceOwner": challenge})
    answer = owner["receive"](channel)
    assert answer["pid"] == value["pid"]
    assert hmac.compare_digest(answer["proof"], owner["proof"](value["id"], challenge))
    owner["send"](channel, {"action": "stop", "proof": owner["proof"](value["id"], challenge + ":stop")})
    channel.shutdown(socket.SHUT_RDWR)
`, ownerScript, pidDir], {
      cwd: harness.temporaryRoot, env: harness.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(client.error, undefined);
    assert.equal(client.status, 0, client.stderr);
    await harness.waitForChildClose(owner);
    assert.equal(owner.exitCode, 0);
    assert.match(harness.run("status", "docs"), /^docs\s+down\s+-/m);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("owned TERM-ignoring descendants stop while an independent peer survives", { timeout: 30_000 }, async () => {
  const harness = await createHarness();
  const peer = harness.spawnPeer();
  const childFile = path.join(harness.temporaryRoot, "owned-child.pid");
  try {
    const command = path.join(harness.binDir, "corepack");
    const original = await readFile(command, "utf8");
    await writeFile(command, original.replace("exec sleep 300", `trap '' TERM\nsleep 300 &\necho "$!" > "${childFile}"\nwait`));
    harness.run("start", "docs");
    let childPid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { childPid = Number((await readFile(childFile, "utf8")).trim()); break; }
      catch { await delay(20); }
    }
    assert.ok(childPid > 1);
    assert.match(harness.run("stop", "docs"), /docs: stopped/);
    process.kill(peer.pid, 0);
    assert.match(harness.run("status", "docs"), /^docs\s+down\s+-/m);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(childPid, 0); } catch (error) {
        assert.equal(error.code, "ESRCH");
        return;
      }
      await delay(20);
    }
    assert.fail("Owned descendant remained live after verified stop");
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("a departed root with a live child reports cleanup failure and can retry after child exit", { timeout: fixtureCaseTimeout }, async () => {
  const harness = await createHarness();
  const peer = harness.spawnPeer();
  const fifo = path.join(harness.temporaryRoot, "owned-child-control");
  let writer;
  try {
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    writer = await open(fifo, "r+");
    const command = path.join(harness.binDir, "corepack");
    const original = await readFile(command, "utf8");
    await writeFile(command, original.replace("exec sleep 300", `( read -r ignored < "${fifo}" ) &\nexit 0`));
    // The root exits before its child. The owner must not manufacture new
    // group authority after reaping that original root.
    harness.runResult("start", "docs");
    // A busy listener is not proof of failed cleanup. Authenticate the
    // terminal failure after the unchanged owner budget has expired.
    waitForFixtureCleanupFailure(harness, "docs");
    assert.match(harness.run("status", "docs"), /^docs\s+unverified\s+-/m);
    const identity = path.join(harness.devDir, "pids", "docs.identity.json");
    const before = await readFile(identity);
    const failed = harness.runResult("stop", "docs");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /records retained/);
    waitForFixtureCleanupFailure(harness, "docs");
    assert.deepEqual(await readFile(identity), before);
    assert.match(harness.run("status", "docs"), /^docs\s+unverified\s+-/m);
    process.kill(peer.pid, 0);
    await writer.close();
    writer = undefined;
    await delay(100);
    assert.match(harness.run("stop", "docs"), /docs: stopped/);
    assert.match(harness.run("status", "docs"), /^docs\s+down\s+-/m);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    let failure;
    try { if (writer) await writer.close(); }
    catch (error) { failure = error; }
    await harness.cleanup(failure);
  }
});

test("source startup does not connect its web app to another responding API", async () => {
  const harness = await createHarness();
  try {
    const curl = path.join(harness.temporaryRoot, "bin", "curl");
    await writeFile(curl, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(curl, 0o755);
    const result = harness.runResult("start");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another API is responding/);
    assert.doesNotMatch(await harness.events(), /launch:/);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("source startup shares the installed Temporal path, preserves legacy history, and refuses ambiguity", async () => {
  const harness = await createHarness();
  try {
    const appDir = path.join(harness.temporaryRoot, "app");
    const legacy = path.join(appDir, "temporal", "temporal.db");
    const native = path.join(appDir, "temporal.db");
    harness.run("start", "temporal");
    assert.match(await harness.waitForLaunches(1), new RegExp(native.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    harness.run("stop", "temporal");
    await harness.clearEvents();
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "legacy history");
    harness.run("start", "temporal");
    assert.ok((await harness.waitForLaunches(1)).includes(legacy));
    harness.run("stop", "temporal");
    await writeFile(native, "installed history");
    const refused = harness.runResult("start", "temporal");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /conflicting Temporal histories/);
    assert.equal(await readFile(legacy, "utf8"), "legacy history");
    assert.equal(await readFile(native, "utf8"), "installed history");
    await rm(native);
    await writeFile(`${native}-wal`, "orphaned companion");
    const orphaned = harness.runResult("start", "temporal");
    assert.notEqual(orphaned.status, 0);
    assert.match(orphaned.stderr, /orphaned SQLite companions/);
    assert.equal(await readFile(`${native}-wal`, "utf8"), "orphaned companion");
    assert.equal(await readFile(legacy, "utf8"), "legacy history");
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

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
  } catch (error) {
    harness.recordFailure(error);
    throw error;
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
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

test("foreground demo API advances from migrations to the long-lived server", async () => {
  const harness = await createHarness();
  try {
    const result = await harness.runForegroundUntilReady("run", "demo-api");
    assert.equal(result.status, 130, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[demo-api\] Ready on http:\/\/127\.0\.0\.1:48787\//);
    assert.match(harness.run("status", "demo-api"), /^demo-api\s+down\s+-/m);
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});

for (const mode of ["run", "start", "restart"]) {
  for (const targets of [[], ["api", "web"]]) {
    test(`${mode} ${targets.join(" ") || "default fleet"} builds the extension once before replacing processes`, { timeout: fixtureCaseTimeout }, async () => {
      const harness = await createHarness();
      try {
        harness.run("start", "api", "web");
        await harness.waitForLaunches(2);
        const previousPids = await Promise.all([harness.pid("api"), harness.pid("web")]);
        await harness.clearEvents();

        let output;
        if (mode === "run") {
          const result = await harness.runForegroundUntilReady(mode, ...targets);
          assert.equal(result.status, 130, `${result.stdout}\n${result.stderr}`);
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
      } catch (error) {
        harness.recordFailure(error);
        throw error;
      } finally {
        await harness.cleanup();
      }
    });
  }

  test(`${mode} preserves existing processes and logs when the extension build fails`, { timeout: fixtureCaseTimeout }, async () => {
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
    } catch (error) {
      harness.recordFailure(error);
      throw error;
    } finally {
      await harness.cleanup();
    }
  });

  test(`${mode} skips the extension for component sets without product web`, { timeout: fixtureCaseTimeout }, async () => {
    const harness = await createHarness();
    try {
      await harness.failBuild();
      const targets = ["temporal", "api", "worker", "docs", "demo-api", "demo-web"];
      if (mode === "run") {
        const result = await harness.runForegroundUntilReady(mode, ...targets);
        assert.equal(result.status, 130, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /foreground run active/);
      } else {
        assert.match(harness.run(mode, ...targets), /demo-web: (started|http:)/);
      }
      assert.doesNotMatch(await harness.waitForLaunches(targets.length), /build:/);
    } catch (error) {
      harness.recordFailure(error);
      throw error;
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
  } catch (error) {
    harness.recordFailure(error);
    throw error;
  } finally {
    await harness.cleanup();
  }
});
