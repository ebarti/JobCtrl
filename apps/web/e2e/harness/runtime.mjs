import { spawn, execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { externalBoundaries } from "./external-boundaries.mjs";
import { upgradeRevisions } from "./upgrade-revisions.mjs";

const execFile = promisify(execFileCallback);
export const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const groupScript = fileURLToPath(
  new URL("process-group.mjs", import.meta.url),
);
export const python = path.join(repo, "workers/automation/.venv/bin/python");
const pgBin = process.env.JOBCTRL_POSTGRES_BIN_DIR ?? "";
const pgCommand = (name) => pgBin ? path.join(pgBin, name) : name;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class ProcessExited extends Error {}

export async function waitFor(
  probe,
  description,
  { timeout = 30_000, interval = 100 } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {
      if (await probe()) return;
    } catch (error) {
      if (error instanceof ProcessExited) throw error;
      last = error;
    }
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for ${description}${last ? `: ${last.message}` : ""}`,
  );
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

/** New runtimes inherit tool locations, never provider keys, user's HOME or
 * ambient JobCtrl configuration. All supported external boundaries are explicit. */
function environment(home) {
  const result = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    UV_LOCKED: "1",
    LANGFUSE_DISABLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
  result.PLAYWRIGHT_BROWSERS_PATH =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(
      os.homedir(),
      process.platform === "darwin"
        ? "Library/Caches/ms-playwright"
        : ".cache/ms-playwright",
    );
  return result;
}

export async function removeAllocated(directory, identity) {
  const current = await lstat(directory, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Owned E2E directory identity changed; cleanup refused");
  await rm(directory, { recursive: true });
}

async function launch(name, executable, args, { directory, env, cwd = repo }) {
  const logPath = path.join(directory, `${name}.log`);
  const log = createWriteStream(logPath, { mode: 0o600 });
  let bytes = 0;
  const leader = spawn(process.execPath, [groupScript, executable, ...args], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // Keep consuming streams after the bound to avoid blocking a real service.
  for (const stream of [leader.stdout, leader.stderr])
    stream.on("data", (data) => {
      if (bytes < 2_000_000) {
        log.write(data.subarray(0, 2_000_000 - bytes));
        bytes += data.length;
      }
    });
  let payloadPid;
  let outcome;
  let failure;
  leader.on("message", (message) => {
    if (message?.type === "spawn") payloadPid = message.pid;
    if (message?.type === "exit") outcome = message;
    if (message?.type === "error")
      failure = new Error(`${name}: ${message.message}`);
  });
  leader.on("error", (error) => {
    failure = error;
  });
  try {
    await waitFor(
      () => {
        if (failure) throw new ProcessExited(failure.message);
        if (leader.exitCode !== null)
          throw new ProcessExited(`${name} group exited during launch`);
        return Boolean(payloadPid);
      },
      `${name} process start`,
      { timeout: 10_000 },
    );
  } catch (error) {
    if (leader.connected) leader.send({ type: "stop" });
    await waitFor(
      () => leader.exitCode !== null || leader.signalCode !== null,
      `${name} failed-launch cleanup`,
      { timeout: 7_000 },
    );
    log.end();
    throw error;
  }
  return {
    name,
    get pid() {
      return payloadPid;
    },
    assertRunning() {
      if (failure) throw new ProcessExited(failure.message);
      if (leader.exitCode !== null || leader.signalCode !== null)
        throw new ProcessExited(
          `${name} lost its process-group leader; inspect ${logPath}`,
        );
      if (outcome)
        throw new ProcessExited(
          `${name} exited (${outcome.code ?? outcome.signal}); inspect ${logPath}`,
        );
    },
    crash() {
      this.assertRunning();
      process.kill(payloadPid, "SIGKILL");
    },
    async stop() {
      if (leader.exitCode !== null || leader.signalCode !== null) {
        log.end();
        throw new Error(`${name} lost its owned group leader before cleanup`);
      }
      leader.send({ type: "stop" });
      try {
        await waitFor(
          async () => {
            const { stdout } = await execFile(
              "ps",
              ["-e", "-o", "pid=,pgid="],
              { timeout: 2_000 },
            );
            return !stdout.split("\n").some((line) => {
              const [pid, pgid] = line.trim().split(/\s+/).map(Number);
              return pgid === leader.pid && pid !== leader.pid;
            });
          },
          `${name} process group exit`,
          { timeout: 4_000 },
        );
        leader.send({ type: "finish" });
      } catch {
        // The live leader still reserves this exact group; kill only that group.
        if (leader.exitCode === null && leader.signalCode === null)
          process.kill(-leader.pid, "SIGKILL");
      }
      await waitFor(
        () => leader.exitCode !== null || leader.signalCode !== null,
        `${name} leader exit`,
        { timeout: 3_000 },
      );
      log.end();
    },
  };
}

export async function ownedRun() {
  const value = process.env.JOBCTRL_E2E_RUN_DIR;
  if (!value)
    throw new Error(
      "Run the suite with corepack pnpm e2e so it owns its evidence directory",
    );
  const target = await realpath(value);
  const metadata = await lstat(value);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    target !== value ||
    !path.basename(target).startsWith("e2e-")
  ) {
    throw new Error(
      "E2E evidence directory must be a newly allocated, canonical run directory",
    );
  }
  const marker = JSON.parse(
    await readFile(path.join(target, ".e2e-owned.json"), "utf8"),
  );
  const identity = await lstat(target, { bigint: true });
  if (
    marker.directory !== target ||
    marker.token !== process.env.JOBCTRL_E2E_RUN_TOKEN ||
    !/^[a-f0-9]{64}$/.test(marker.token ?? "") ||
    marker.device !== identity.dev.toString() ||
    marker.inode !== identity.ino.toString()
  ) {
    throw new Error("E2E evidence ownership has changed");
  }
  return target;
}

export async function postgresStack() {
  const root = await ownedRun();
  const directory = await mkdtemp(path.join(root, "postgres-"));
  const identity = await lstat(directory, { bigint: true });
  const home = path.join(directory, "home");
  const data = path.join(directory, "data");
  await mkdir(home, { mode: 0o700 });
  const env = environment(home);
  // Each private socket directory is unique, so workers can share this port.
  const pgPort = 5432;
  await execFile(pgCommand("initdb"), ["-D", data, "-U", "jobctrl", "-A", "trust", "--no-locale", "--encoding=UTF8"], { env, timeout: 60_000 });
  async function start() {
    const service = await launch("postgres", pgCommand("postgres"), ["-D", data, "-h", "", "-p", String(pgPort), "-k", directory], { directory, env });
    try {
      await waitFor(async () => {
        service.assertRunning();
        await execFile(pgCommand("pg_isready"), ["-h", directory, "-p", String(pgPort), "-U", "jobctrl"], { env, timeout: 2_000 });
        return true;
      }, "owned PostgreSQL readiness", { timeout: 40_000 });
    } catch (error) {
      await service.stop();
      throw error;
    }
    return service;
  }
  let service = await start();
  let retainState = false;
  return {
    async createDatabase() {
      const name = `e2e_${randomUUID().replaceAll("-", "")}`;
      await execFile(pgCommand("createdb"), ["-h", directory, "-p", String(pgPort), "-U", "jobctrl", name], { env, timeout: 10_000 });
      return `postgresql://jobctrl@/${name}?host=${encodeURIComponent(directory)}&port=${pgPort}`;
    },
    async pause() { await service.stop(); service = null; },
    async resume() { service = await start(); },
    retainForDiagnosis() { retainState = true; },
    async close() {
      await service?.stop();
      if (!retainState) await removeAllocated(directory, identity);
    },
  };
}

export async function applicationStack(
  databaseURL,
  {
    features,
    discoveryTransport = "jobstreaming",
    nativeAccountingPreflight = false,
    sourceRevision,
    fitRecoveryDebugger = false,
    cohortBoundaryDebugger = false,
    modelReceiptDebugger = false,
    searchTimerDebugger = false,
    preflight = false,
    sqlitePredecessor = false,
    predecessorPython: explicitPredecessorPython,
    createDatabase,
    pythonExecutable = process.env.JOBCTRL_E2E_PYTHON ?? python,
    staticDir = process.env.JOBCTRL_E2E_STATIC_DIR ??
      path.join(repo, "dist/web"),
  } = {},
) {
  const started = performance.now();
  const root = await ownedRun();
  const directory = await mkdtemp(path.join(root, "application-"));
  let predecessorPython = explicitPredecessorPython;
  const home = path.join(directory, "home");
  const workspace = path.join(directory, "workspace");
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const homeIdentity = await lstat(home, { bigint: true });
  const workspaceIdentity = await lstat(workspace, { bigint: true });
  const token = randomBytes(32).toString("hex");
  await writeFile(
    path.join(workspace, ".jobctrl-e2e-owned.json"),
    JSON.stringify({ version: 1, workspace, token }),
    { flag: "wx", mode: 0o600 },
  );
  const external = await externalBoundaries(token);
  const baseURL = `http://127.0.0.1:${await port()}`;
  const env = {
    ...environment(home),
    JOBCTRL_DIR: workspace,
    JOBCTRL_API_HOST: "127.0.0.1",
    JOBCTRL_API_PORT: baseURL.split(":")[2],
    JOBCTRL_DATABASE_URL: databaseURL,
    ...(pgBin ? { JOBCTRL_POSTGRES_BIN_DIR: pgBin } : {}),
    JOBCTRL_SYNTHETIC_BOUNDARIES: "1",
    JOBCTRL_E2E_TOKEN: token,
    JOBCTRL_E2E_PROVIDER_URL: `${external.url}/model`,
    JOBCTRL_GMAIL_API_ROOT: `${external.url}/gmail/v1`,
    JOBCTRL_E2E_COMPANY_PAGE_URL: `${external.url}/company-page`,
    JOBCTRL_E2E_COMPENSATION_URL: `${external.url}/compensation`,
    JOBCTRL_E2E_DNS_URL: `${external.url}/dns`,
    JOBCTRL_POSTING_PROVIDER_ENDPOINT: `${external.url}/posting-page`,
  };
  if (nativeAccountingPreflight) {
    // Exercise the ordinary native cost gate, never a model execution. The
    // journey uses only settings/profile/Discovery and denies credential and
    // provider routes; HOME is owned and outbound proxy access remains denied.
    for (const key of Object.keys(env)) {
      if (key === "JOBCTRL_SYNTHETIC_BOUNDARIES" || key.startsWith("JOBCTRL_E2E_")
          || key === "JOBCTRL_GMAIL_API_ROOT" || key.startsWith("JOBCTRL_DISCOVERY_PROVIDER_")
          || key === "JOBCTRL_POSTING_PROVIDER_ENDPOINT") delete env[key];
    }
  }
  if (!nativeAccountingPreflight) {
    env.JOBCTRL_JOBSTREAMING_PROVIDER_ENDPOINT = `${external.url}/jobstreaming`;
    if (discoveryTransport !== "jobstreaming") env.JOBCTRL_E2E_BOARD_ACCESS = discoveryTransport;
  }
  if (features !== undefined) env.JOBCTRL_FEATURES = features;
  if (
    process.env.JOBCTRL_E2E_INSTALLED !== "1" &&
    pythonExecutable === python &&
    process.env.JOBCTRL_E2E_SOURCE_PATH
  ) {
    env.PYTHONPATH = process.env.JOBCTRL_E2E_SOURCE_PATH;
  }
  const renderFailure = path.join(directory, "fail-chromium-launch");
  const services = [];
  let worker;
  let server;
  let serverGeneration = 0;
  let replacementWorkspace;
  let upgraded = false;
  let workerGeneration = 0;
  let recoveryDebuggerEnabled = fitRecoveryDebugger;
  const recoveryArm = path.join(directory, "fit-recovery-arm");
  const recoveryPaused = path.join(directory, "fit-recovery-paused.json");
  const cohortArm = path.join(directory, "cohort-boundary-arm");
  const cohortPaused = path.join(directory, "cohort-boundary-paused.json");
  const modelReceiptArm = path.join(directory, "model-receipt-arm");
  const modelReceiptPaused = path.join(directory, "model-receipt-paused.json");
  const searchTimerPaused = path.join(directory, "search-timer-paused.json");
  async function startWorker(workerFeatures, selected = workspace, selectedEnv = env) {
    worker = await launch(
      `worker-${++workerGeneration}`,
      pythonExecutable,
      [
        ...(recoveryDebuggerEnabled ? [path.join(repo, "apps/web/e2e/harness/fit-recovery-debugger.py"), recoveryArm, recoveryPaused]
          : cohortBoundaryDebugger ? [path.join(repo, "apps/web/e2e/harness/cohort-boundary-debugger.py"), cohortArm, cohortPaused]
          : modelReceiptDebugger ? [path.join(repo, "apps/web/e2e/harness/model-receipt-debugger.py"), modelReceiptArm, modelReceiptPaused]
          : searchTimerDebugger && workerGeneration === 1 ? [path.join(repo, "apps/web/e2e/harness/search-timer-debugger.py"), searchTimerPaused]
          : ["-m", "jobctrl.app.worker"]),
        "--workspace",
        selected,
      ],
      { directory, env: workerFeatures === undefined ? selectedEnv : { ...selectedEnv, JOBCTRL_FEATURES: workerFeatures } },
    );
    services.push(worker);
    return worker.pid;
  }
  async function startServer(selected = workspace, selectedEnv = env) {
    server = await launch(
      ++serverGeneration === 1 ? "api" : `api-${serverGeneration}`,
      sqlitePredecessor && !upgraded ? predecessorPython : pythonExecutable,
      ["-m", "jobctrl.app.server", "--host", "127.0.0.1", "--port", env.JOBCTRL_API_PORT,
        "--workspace", selected, ...(preflight ? [] : ["--static-dir", staticDir])],
      { directory, env: selectedEnv },
    );
    services.push(server);
    await waitFor(async () => {
      server.assertRunning();
      return (await fetch(`${baseURL}/v1/health`, { signal: AbortSignal.timeout(2_000) })).ok;
    }, "Python HTTP health");
  }
  async function disableCompensationAutomation() {
    // Isolate unrelated background work through the ordinary Settings boundary.
    const settings = await (await fetch(`${baseURL}/v1/settings`)).json();
    const configured = await fetch(`${baseURL}/v1/settings`, {
      method: "PATCH",
      headers: { Origin: baseURL, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: settings.revision,
        compensationAutomationEnabled: false,
      }),
    });
    if (!configured.ok)
      throw new Error(`Could not isolate compensation automation through Settings (${configured.status})`);
  }
  try {
    if (sqlitePredecessor && sourceRevision)
      throw new Error("SQLite migration cannot combine an older source revision.");
    const predecessorRevision = sqlitePredecessor ? "db8043d5f86389e1427d5335e3da336dc35437f6" : sourceRevision;
    if (predecessorRevision) {
      if (!sqlitePredecessor && !upgradeRevisions.includes(predecessorRevision))
        throw new Error("The source upgrade journey requires its exact fixed predecessor.");
      const resolved = await execFile("git", ["rev-parse", "--verify", `${predecessorRevision}^{commit}`], { cwd: repo, timeout: 5_000 });
      if (resolved.stdout.trim() !== predecessorRevision)
        throw new Error("The predecessor source identity did not resolve exactly.");
      const archive = path.join(directory, "predecessor-source.tar");
      const extracted = path.join(directory, "predecessor-source");
      await mkdir(extracted, { mode: 0o700 });
      await execFile("git", ["archive", "--format=tar", "--output", archive, predecessorRevision, ...(sqlitePredecessor ? ["workers/automation"] : ["workers/automation/src"])], { cwd: repo, timeout: 10_000 });
      await execFile("tar", ["-xf", archive, "-C", extracted], { timeout: 10_000 });
      await rm(archive);
      env.PYTHONPATH = path.join(extracted, "workers/automation/src");
      if (sqlitePredecessor) {
        delete env.JOBCTRL_DATABASE_URL;
        if (!predecessorPython) {
          const project = path.join(extracted, "workers/automation");
          const venv = path.join(directory, "predecessor-venv");
          const setupEnv = { PATH: process.env.PATH, HOME: home, UV_PROJECT_ENVIRONMENT: venv, UV_LOCKED: "1", UV_PYTHON: process.env.UV_PYTHON ?? "3.12" };
          await execFile("uv", ["sync", "--project", project, "--locked", "--all-extras", "--no-install-project"], { env: setupEnv, timeout: 180_000, maxBuffer: 1_000_000 });
          predecessorPython = path.join(venv, "bin/python");
        }
      }
    }
    if (fitRecoveryDebugger && !["df06b08ae201f7a73dc2c359944c06daf517c69e", "b49dc52e3d727356870317069304ac6ceb9f1237"].includes(sourceRevision))
      throw new Error("The durable-gap debugger requires an exact declared Fit predecessor.");
    if ((cohortBoundaryDebugger || modelReceiptDebugger) && (sourceRevision || sqlitePredecessor || fitRecoveryDebugger))
      throw new Error("The selected debugger requires the exact current candidate worker.");
    if (cohortBoundaryDebugger && modelReceiptDebugger)
      throw new Error("Only one candidate debugger can be installed.");
    if (process.env.JOBCTRL_E2E_INSTALLED === "1") {
      const payloadRoot = await realpath(process.env.JOBCTRL_E2E_PAYLOAD_DIR);
      const [executable, assets] = await Promise.all([
        realpath(pythonExecutable),
        realpath(staticDir),
      ]);
      if (
        ![executable, assets].every((value) =>
          value.startsWith(`${payloadRoot}${path.sep}`),
        )
      ) {
        throw new Error(
          "Installed runtime paths must stay inside their extracted payload",
        );
      }
      env.JOBCTRL_RUNTIME_MODE = "bundled";
      env.JOBCTRL_PAYLOAD_DIR = payloadRoot;
      env.JOBCTRL_WEB_DIR = assets;
    }
    // The renderer's EXTERNAL browser process is real Chromium normally. A
    // journey can fail a launch without replacing the JobCtrl renderer.
    if (!preflight) {
      const browser = await execFile(
        pythonExecutable,
        [
          "-c",
          "import json, os, pathlib, playwright\nroot = pathlib.Path(playwright.__file__).parent / 'driver' / 'package'\nregistry = json.loads((root / 'browsers.json').read_text())['browsers']\nrevision = next(row['revision'] for row in registry if row['name'] == 'chromium-headless-shell')\ncache = pathlib.Path(os.environ['PLAYWRIGHT_BROWSERS_PATH']) / ('chromium_headless_shell-' + revision)\ncandidates = [path for path in cache.rglob('*') if path.name in {'chrome-headless-shell', 'headless_shell'} and path.is_file() and os.access(path, os.X_OK)]\nif len(candidates) != 1: raise RuntimeError('The locked managed Chromium headless shell is missing or ambiguous')\nprint(candidates[0])",
        ],
        { env, timeout: 10_000 },
      );
      const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const chromiumWrapper = path.join(directory, "chromium");
      await writeFile(
        chromiumWrapper,
        `#!/bin/sh\nif [ -e ${shellQuote(renderFailure)} ]; then exit 79; fi\nexec ${shellQuote(browser.stdout.trim())} "$@"\n`,
        { mode: 0o700, flag: "wx" },
      );
      env.JOBCTRL_CHROMIUM_EXECUTABLE = chromiumWrapper;
    }
    // The EXTERNAL OS credential command is also a real owned process, with
    // synthetic values held only in this workspace. No native store is read.
    // Credential subprocesses filter Python env vars, so disable bytecode
    // on the helper interpreter itself to keep the installed payload intact.
    const credentialHelper = path.join(workspace, "credential-helper");
    await writeFile(
      credentialHelper,
      `#!${pythonExecutable} -B\nimport json, os, pathlib, sys\nroot = pathlib.Path(__file__).parent\noperation, key = sys.argv[1:]\nstore = root / 'synthetic-credential-store.json'\nvalue = json.loads(store.read_text()) if store.exists() else {}\nif (root / 'fail-credential-helper').exists(): sys.exit(70)\nif operation in ('inspect', 'read'):\n if key not in value: sys.exit(44)\n if operation == 'read': sys.stdout.write(value[key])\nelif operation == 'set':\n value[key] = sys.stdin.read()\n temporary = store.with_suffix('.pending')\n fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)\n with os.fdopen(fd, 'w') as stream:\n  json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())\n os.replace(temporary, store)\nelif operation == 'delete':\n value.pop(key, None)\n store.write_text(json.dumps(value)); store.chmod(0o600)\nelse: sys.exit(64)\n`,
      { mode: 0o700, flag: "wx" },
    );
    if (!nativeAccountingPreflight) env.JOBCTRL_E2E_CREDENTIAL_HELPER = credentialHelper;
    await startServer();
    if (!preflight && !sqlitePredecessor) {
      await startWorker();
      await waitFor(async () => {
        worker.assertRunning();
        const health = await fetch(`${baseURL}/v1/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        return (await health.json()).worker?.healthy === true;
      }, "live Python worker registration");
    }
    if (!preflight) await disableCompensationAutomation();
    async function inspectProviderReceipts(operation) {
      const inspected = await execFile(pythonExecutable, ["-c", `
import json, os, pathlib, sys
import psycopg
root = pathlib.Path(sys.argv[1])
marker = root / ".jobctrl-e2e-owned.json"
assert root.resolve() == root and not marker.is_symlink()
owner = json.loads(marker.read_text())
assert owner["workspace"] == str(root) and owner["token"] == os.environ["JOBCTRL_E2E_TOKEN"]
with psycopg.connect(os.environ["JOBCTRL_DATABASE_URL"], options="-c default_transaction_read_only=on") as conn:
    rows = conn.execute("""SELECT m.receipt_id,c.owner_key,m.status,m.input_fingerprint,m.cost_usd
                           FROM app_model_calls m LEFT JOIN app_model_operation_receipts c
                             ON c.receipt_id=m.receipt_id
                           WHERE m.operation=%s ORDER BY m.receipt_id""", (sys.argv[2],)).fetchall()
print(json.dumps([dict(zip(("receiptId","ownerKey","status","inputFingerprint","costUsd"), row)) for row in rows]))
`, workspace, operation], { env, timeout: 5_000, maxBuffer: 100_000 });
      return JSON.parse(inspected.stdout);
    }
    return {
      baseURL,
      workspace,
      directory,
      external,
      setupMs: Math.round(performance.now() - started),
      get workerPid() {
        return worker?.pid;
      },
      async restartApi({ freshWorkspace = false, afterExit } = {}) {
        if (replacementWorkspace || preflight || sourceRevision)
          throw new Error("Only the original ordinary synthetic workspace can restart its API.");
        let selected = workspace;
        let selectedEnv = env;
        if (freshWorkspace) {
          selected = await mkdtemp(path.join(directory, "workspace-replacement-"));
          replacementWorkspace = { path: selected, identity: await lstat(selected, { bigint: true }) };
          await writeFile(path.join(selected, ".jobctrl-e2e-owned.json"),
            JSON.stringify({ version: 1, workspace: selected, token }), { flag: "wx", mode: 0o600 });
          if (!createDatabase) throw new Error("A fresh workspace requires an owned database allocator");
          selectedEnv = { ...env, JOBCTRL_DIR: selected, JOBCTRL_DATABASE_URL: await createDatabase() };
          if (env.JOBCTRL_E2E_CREDENTIAL_HELPER) {
            const helper = path.join(selected, "credential-helper");
            await writeFile(helper, await readFile(env.JOBCTRL_E2E_CREDENTIAL_HELPER), { flag: "wx", mode: 0o700 });
            selectedEnv.JOBCTRL_E2E_CREDENTIAL_HELPER = helper;
          }
        }
        const previous = server;
        previous.crash();
        await previous.stop();
        services.splice(services.indexOf(previous), 1);
        await afterExit?.();
        await startServer(selected, selectedEnv);
        if (freshWorkspace) {
          await startWorker(undefined, selected, selectedEnv);
          await waitFor(async () => {
            worker.assertRunning();
            const health = await fetch(`${baseURL}/v1/health`, { signal: AbortSignal.timeout(2_000) });
            return (await health.json()).worker?.healthy === true;
          }, "replacement workspace worker registration");
          await disableCompensationAutomation();
        }
      },
      async waitForSearchTimerPause(runId) {
        await waitFor(async () => {
          try {
            const pause = JSON.parse(await readFile(searchTimerPaused, "utf8"));
            return pause.pid === worker.pid && pause.workflowId.endsWith(`-${runId}`);
          } catch (error) { if (error.code === "ENOENT") return false; throw error; }
        }, "owned search workflow paused before timer registration");
      },
      async armCohortBoundaryPause() {
        if (!cohortBoundaryDebugger) throw new Error("The cohort guard debugger is not enabled.");
        await writeFile(cohortArm, "final-currentness-guard", { mode: 0o600, flag: "wx" });
      },
      async waitForCohortBoundaryPause(boundary = "final-currentness-guard") {
        await waitFor(async () => {
          try { const pause = JSON.parse(await readFile(cohortPaused, "utf8")); return pause.pid === worker.pid && pause.boundary === boundary; }
          catch (error) { if (error.code === "ENOENT") return false; throw error; }
        }, `owned cohort ${boundary} pause`);
      },
      async resumeCohortBoundary() {
        if (!cohortBoundaryDebugger || JSON.parse(await readFile(cohortPaused, "utf8")).pid !== worker.pid)
          throw new Error("The paused cohort worker identity did not match.");
        process.kill(worker.pid, "SIGCONT");
        await rm(cohortPaused);
      },
      async armModelReceiptPause() {
        if (!modelReceiptDebugger) throw new Error("The model receipt debugger is not enabled.");
        await writeFile(modelReceiptArm, "", { mode: 0o600, flag: "wx" });
      },
      async waitForModelReceiptPause() {
        let receiptId;
        await waitFor(async () => {
          try {
            const pause = JSON.parse(await readFile(modelReceiptPaused, "utf8"));
            if (pause.pid === worker.pid) receiptId = pause.receiptId;
            return typeof receiptId === "string";
          } catch (error) {
            if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
            throw error;
          }
        }, "owned model receipt pause");
        return receiptId;
      },
      fitProviderReceipts: () => inspectProviderReceipts("fit.qualification-batch"),
      requirementsExtractionReceipts: () => inspectProviderReceipts("requirements.extract"),
      async armFitRecoveryPause(operation) {
        if (!recoveryDebuggerEnabled || !["fit.catalog-impact", "fit.qualification-batch"].includes(operation))
          throw new Error("Only the declared predecessor external-call gap can be armed.");
        await writeFile(recoveryArm, operation, { mode: 0o600, flag: "wx" });
      },
      async waitForFitRecoveryPause() {
        await waitFor(async () => {
          try { return JSON.parse(await readFile(recoveryPaused, "utf8")).pid === worker.pid; }
          catch (error) { if (error.code === "ENOENT") return false; throw error; }
        }, "owned predecessor debugger pause");
      },
      async fitRefreshCheckpoint(operationId) {
        const result = await execFile(pythonExecutable, ["-c", `
import json, os, pathlib, sys
import psycopg
root = pathlib.Path(sys.argv[1])
owned = json.loads((root / '.jobctrl-e2e-owned.json').read_text())
if owned['workspace'] != str(root): raise RuntimeError('Workspace ownership mismatch')
connection = psycopg.connect(os.environ['JOBCTRL_DATABASE_URL'], options='-c default_transaction_read_only=on')
row = connection.execute('SELECT state_json FROM fit_refresh_operations WHERE operation_id=%s', (sys.argv[2],)).fetchone()
if row is None: raise RuntimeError('The admitted refresh has no checkpoint')
state = json.loads(row[0])
print(json.dumps({key: state[key] for key in ('calls', 'checkpoints', 'impact_selection_scope_version', 'qualification_transport_version') if key in state}))
`, workspace, operationId], { env, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
        return JSON.parse(result.stdout);
      },
      async upgradeSqliteToPostgres() {
        if (!sqlitePredecessor || upgraded || preflight)
          throw new Error("Only the exact owned SQLite predecessor can migrate once.");
        await server.stop();
        services.splice(services.indexOf(server), 1);
        const backup = path.join(directory, "pre-upgrade.db");
        await execFile(predecessorPython, ["-m", "jobctrl", "--workspace", workspace, "backup", "--output", backup], { env, cwd: repo, timeout: 15_000 });
        if (process.env.JOBCTRL_E2E_INSTALLED === "1") delete env.PYTHONPATH;
        else env.PYTHONPATH = process.env.JOBCTRL_E2E_SOURCE_PATH ?? path.join(repo, "workers/automation/src");
        env.JOBCTRL_DATABASE_URL = databaseURL;
        const args = ["-m", "jobctrl.app.postgres_upgrade", "--sqlite", backup, "--workspace", workspace];
        const first = JSON.parse((await execFile(pythonExecutable, args, { env, cwd: repo, timeout: 60_000 })).stdout);
        const repeated = JSON.parse((await execFile(pythonExecutable, args, { env, cwd: repo, timeout: 60_000 })).stdout);
        if (first.receipt_sha256 !== repeated.receipt_sha256 || first.rows !== repeated.rows)
          throw new Error("Repeated import changed the source receipt or row count.");
        upgraded = true;
        await startServer();
        await startWorker();
        await waitFor(async () => {
          worker.assertRunning();
          return (await (await fetch(`${baseURL}/v1/health`)).json()).worker?.healthy === true;
        }, "migrated Python worker registration");
        return { first, repeated };
      },
      async upgradeSource() {
        if (!sourceRevision || upgraded || preflight)
          throw new Error("Only the fixed owned predecessor runtime can upgrade once.");
        const previous = worker.pid;
        try {
          if (JSON.parse(await readFile(recoveryPaused, "utf8")).pid === previous) worker.crash();
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        for (const service of [worker, server]) {
          await service.stop();
          services.splice(services.indexOf(service), 1);
        }
        // The real public predecessor CLI takes the consistent backup after its
        // HTTP/worker writers have stopped. No domain tables are seeded.
        const backup = path.join(directory, "pre-upgrade.db");
        await execFile(pythonExecutable, ["-m", "jobctrl", "--workspace", workspace, "backup", "--output", backup], { env, cwd: repo, timeout: 15_000 });
        const installed = process.env.JOBCTRL_E2E_INSTALLED === "1";
        if (installed) delete env.PYTHONPATH;
        else env.PYTHONPATH = process.env.JOBCTRL_E2E_SOURCE_PATH ?? path.join(repo, "workers/automation/src");
        recoveryDebuggerEnabled = false;
        const origin = (await execFile(pythonExecutable, ["-c", "import pathlib,jobctrl\nprint(pathlib.Path(jobctrl.__file__).resolve())"], { env, cwd: directory, timeout: 5_000 })).stdout.trim();
        if (installed ? !origin.startsWith(`${env.JOBCTRL_PAYLOAD_DIR}${path.sep}`)
          : origin !== path.join(env.PYTHONPATH, "jobctrl/__init__.py"))
          throw new Error("The upgraded application did not load its exact candidate source or installed payload.");
        await startServer();
        await startWorker();
        await waitFor(async () => {
          worker.assertRunning();
          return (await (await fetch(`${baseURL}/v1/health`)).json()).worker?.healthy === true;
        }, "upgraded Python worker registration");
        upgraded = true;
        return { previous, current: worker.pid, backup, candidateOrigin: origin, mode: installed ? "installed" : "source" };
      },
      async databaseSchemaFingerprint() {
        const inspected = await execFile(pythonExecutable, ["-c", `
import hashlib, json, os, pathlib, sys
import psycopg
root = pathlib.Path(sys.argv[1])
owner = json.loads((root / ".jobctrl-e2e-owned.json").read_text())
assert owner["workspace"] == str(root) and owner["token"] == os.environ["JOBCTRL_E2E_TOKEN"]
with psycopg.connect(os.environ["JOBCTRL_DATABASE_URL"], options="-c default_transaction_read_only=on") as conn:
    rows = conn.execute("SELECT 'table', tablename, tablename, NULL FROM pg_catalog.pg_tables WHERE schemaname='public' UNION ALL SELECT 'index', indexname, tablename, indexdef FROM pg_catalog.pg_indexes WHERE schemaname='public' ORDER BY 1,2").fetchall()

print(hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
`, workspace], { env, timeout: 5_000, maxBuffer: 10_000 });
        return inspected.stdout.trim();
      },
      async databaseSchemaInventory() {
        const inspected = await execFile(pythonExecutable, ["-c", `
import json, os, pathlib, sys
import psycopg
root = pathlib.Path(sys.argv[1])
owner = json.loads((root / ".jobctrl-e2e-owned.json").read_text())
assert owner["workspace"] == str(root) and owner["token"] == os.environ["JOBCTRL_E2E_TOKEN"]
with psycopg.connect(os.environ["JOBCTRL_DATABASE_URL"], options="-c default_transaction_read_only=on") as conn:
    rows = conn.execute("SELECT 'table', tablename, tablename, NULL FROM pg_catalog.pg_tables WHERE schemaname='public' UNION ALL SELECT 'index', indexname, tablename, indexdef FROM pg_catalog.pg_indexes WHERE schemaname='public' ORDER BY 1,2").fetchall()

print(json.dumps([dict(zip(("type", "name", "table", "sql"), row)) for row in rows], sort_keys=True))
`, workspace], { env, timeout: 5_000, maxBuffer: 200_000 });
        return JSON.parse(inspected.stdout);
      },
      async requirementsReconciliation(operationId) {
        const inspected = await execFile(pythonExecutable, ["-c", `
import json, os, pathlib, sys
import psycopg
from psycopg.rows import dict_row
root = pathlib.Path(sys.argv[1])
assert root.is_dir() and root.resolve() == root
marker = root / ".jobctrl-e2e-owned.json"
assert not marker.is_symlink()
owner = json.loads(marker.read_text())
assert owner["workspace"] == str(root) and owner["token"] == os.environ["JOBCTRL_E2E_TOKEN"]
operation_id = sys.argv[2]
assert 0 < len(operation_id) <= 240
with psycopg.connect(os.environ["JOBCTRL_DATABASE_URL"], options="-c default_transaction_read_only=on", row_factory=dict_row) as conn:
    row = conn.execute("SELECT operation_id,action_fingerprint,input_fingerprint,captured_catalog_revision,published_catalog_revision,decision_json,receipt_json,report_json FROM requirements_reconciliations WHERE operation_id=%s", (operation_id,)).fetchone()
    assert row is not None
    result = {key: row[key] for key in ("operation_id", "action_fingerprint", "input_fingerprint", "captured_catalog_revision", "published_catalog_revision")}
    result.update(selection=json.loads(row["decision_json"]), authority_receipt=json.loads(row["receipt_json"]), stored_report=json.loads(row["report_json"]))
print(json.dumps(result, sort_keys=True))
`, workspace, operationId], { env, timeout: 5_000, maxBuffer: 2_000_000 });
        return JSON.parse(inspected.stdout);
      },
      async failRendering() {
        await writeFile(renderFailure, "external browser process failure\n", {
          flag: "wx",
          mode: 0o600,
        });
      },
      async restoreRendering() {
        await rm(renderFailure);
      },
      async inspectLogicalBackup(archiveName, runId) {
        if (!createDatabase || !/^[a-z0-9-]+\.pgdump$/.test(archiveName))
          throw new Error("Inspect only an archive created by this owned application stack.");
        const archive = path.join(directory, archiveName);
        const archiveInfo = await lstat(archive);
        if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.mode & 0o077)
          throw new Error("The logical archive must be a private regular file from this journey.");
        const scratchUrl = await createDatabase();
        const scratchEnv = { ...env, JOBCTRL_DATABASE_URL: scratchUrl };
        await execFile(pgCommand("pg_restore"), ["--exit-on-error", "--single-transaction", "--no-owner", "--no-acl",
          "--dbname", scratchUrl, archive], { env: scratchEnv, timeout: 45_000 });
        const inspection = `import json, os, sys
import psycopg
with psycopg.connect(os.environ['JOBCTRL_DATABASE_URL']) as connection:
    row = connection.execute('SELECT a.status, w.status FROM app_action_runs a JOIN dbos.workflow_status w ON a.workflow_id=w.workflow_uuid WHERE a.run_id=%s', (sys.argv[1],)).fetchone()
    print(json.dumps(row))`;
        const readArchive = async () => JSON.parse((await execFile(pythonExecutable,
          ["-c", inspection, runId], { env: scratchEnv, timeout: 10_000 })).stdout);
        const archived = await readArchive();
        const clonePort = String(await port());
        async function trial(args) {
          try {
            await execFile(pythonExecutable, args, { env: scratchEnv, cwd: repo, timeout: 25_000 });
            return { exitCode: 0, stderr: "" };
          } catch (error) {
            if (!Number.isInteger(error.code)) throw error;
            return { exitCode: error.code, stderr: error.stderr };
          }
        }
        const cli = await trial(["-m", "jobctrl", "--workspace", workspace, "pipeline-status"]);
        const api = await trial(["-m", "jobctrl.app.server", "--workspace", workspace, "--port", clonePort]);
        const worker = await trial(["-m", "jobctrl.app.worker", "--workspace", workspace]);
        return { archived, afterTrial: await readArchive(), cli, api, worker };
      },
      async cli(args, { input } = {}) {
        try {
          const pending = execFile(
            sqlitePredecessor && !upgraded ? predecessorPython : pythonExecutable,
            ["-m", "jobctrl", "--workspace", workspace, ...args],
            {
              cwd: repo,
              env,
              timeout: 40_000,
              maxBuffer: 2_000_000,
            },
          );
          // This is real stdin to the public CLI subprocess. Never interpolate
          // synthetic secrets into argv, shell commands or captured logs.
          pending.child.stdin.end(input);
          const result = await pending;
          return { ...result, exitCode: 0 };
        } catch (error) {
          if (Number.isInteger(error.code))
            return {
              stdout: error.stdout,
              stderr: error.stderr,
              exitCode: error.code,
            };
          throw error;
        }
      },
      async inspectPdf(bytes, { selectWithPdfKit = false } = {}) {
        const pdf = path.join(directory, `export-${randomUUID()}.pdf`);
        await writeFile(pdf, bytes, { flag: "wx", mode: 0o600 });
        const inspected = await execFile(
          pythonExecutable,
          [
            "-c",
            "import json, sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\nprint(json.dumps({'pages': len(r.pages), 'text': '\\n'.join(p.extract_text() or '' for p in r.pages)}))",
            pdf,
          ],
          { env, timeout: 10_000, maxBuffer: 2_000_000 },
        );
        const prefix = pdf.slice(0, -4);
        await execFile("pdftoppm", ["-png", "-scale-to", "1100", pdf, prefix], {
          timeout: 20_000,
          maxBuffer: 100_000,
        });
        const result = JSON.parse(inspected.stdout);
        const images = [];
        for (let page = 1; page <= result.pages; page += 1)
          images.push(
            await readFile(
              `${prefix}-${String(page).padStart(String(result.pages).length, "0")}.png`,
            ),
          );
        if (selectWithPdfKit && process.platform === "darwin") {
          const script = `import Foundation
import PDFKit
let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!
for index in 0..<document.pageCount {
    let page = document.page(at: index)!
    print(page.selection(for: page.bounds(for: .cropBox))?.string ?? "")
}`;
          const selected = await execFile(
            "/usr/bin/swift",
            ["-module-cache-path", path.join(directory, "swift-cache"), "-e", script, pdf],
            { timeout: 30_000, maxBuffer: 2_000_000 },
          );
          result.pdfKitSelection = selected.stdout;
        }
        return { ...result, images };
      },
      async inspectDocx(bytes) {
        const file = path.join(directory, `export-${randomUUID()}.docx`);
        await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
        const inspected = await execFile(pythonExecutable, ["-c", "import sys, zipfile, xml.etree.ElementTree as ET\nwith zipfile.ZipFile(sys.argv[1]) as archive:\n document = ET.fromstring(archive.read('word/document.xml'))\n print('\\n'.join(node.text or '' for node in document.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')))\n", file], { env, timeout: 10_000, maxBuffer: 2_000_000 });
        return inspected.stdout;
      },
      async discoveryCheckpoint(runId) {
        // Read actual committed SDK checkpoints/receipts; never seed domain
        // state or infer an acknowledgement from the next outbound request.
        const inspected = await execFile(pythonExecutable, ["-c", `
import hashlib, json, os, pathlib, sys
import psycopg
root = pathlib.Path(sys.argv[1])
owner = json.loads((root / ".jobctrl-e2e-owned.json").read_text())
assert owner["workspace"] == str(root) and owner["token"] == os.environ["JOBCTRL_E2E_TOKEN"]
run_id = sys.argv[2]
adapters = []
with psycopg.connect(os.environ["JOBCTRL_DATABASE_URL"], options="-c default_transaction_read_only=on") as conn:
    for unit_id, raw in conn.execute("SELECT unit_id,state_json FROM discovery_provider_checkpoints WHERE run_id=%s ORDER BY unit_id", (run_id,)):
        checkpoint = json.loads(raw)
        for site, adapter in checkpoint["adapters"].items():
            keys = [row[0] for row in conn.execute("SELECT job_key FROM discovery_provider_keys WHERE run_id=%s AND unit_id=%s AND site=%s ORDER BY ordinal", (run_id, unit_id, site))]
            assert len(keys) == adapter["emitted_count"]
            adapters.append({"unitId": unit_id, "site": site, "state": adapter["state"], "emittedCount": adapter["emitted_count"], "completed": adapter["completed"], "requestFingerprint": checkpoint["request_fingerprint"], "acknowledgedKeys": keys})
    received = [{"unitId": unit_id, "site": site, "jobKey": job_key, "status": status} for unit_id, site, job_key, status in conn.execute("SELECT unit_id,site,job_key,status FROM discovery_postings WHERE run_id=%s ORDER BY received_order", (run_id,))]
    receipts = dict(conn.execute("SELECT outcome,COUNT(*) FROM discovery_intake_receipts WHERE run_id=%s GROUP BY outcome", (run_id,)))
    receipt_keys = []
    for unit_id, data in conn.execute("SELECT unit_id,data_json FROM discovery_intake_receipts WHERE run_id=%s ORDER BY created_at,receipt_key", (run_id,)):
        data = json.loads(data)
        receipt_keys.append({"unitId": unit_id, "site": data["sourceId"].removeprefix("jobstreaming:"), "jobKey": data["sourceNativeId"], "isNew": data["isNew"]})
    saved = conn.execute("SELECT request_json FROM discovery_runs WHERE run_id=%s", (run_id,)).fetchone()
    frozen_request = json.loads(saved[0]) if saved else {}
    request = {
        "fingerprint": hashlib.sha256(json.dumps(frozen_request, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
        "settings": {key: frozen_request.get("settings", {}).get(key) for key in ("resultsPerSite", "newJobLimit")},
        **({"sourceFetchPolicy": frozen_request["sourceFetchPolicy"]} if "sourceFetchPolicy" in frozen_request else {}),
    }
    units = []
    from jobstreaming import build_search_request
    for unit_id, status, data, result in conn.execute("SELECT unit_id,status,data_json,result_json FROM discovery_units WHERE run_id=%s ORDER BY unit_id", (run_id,)):
        data = json.loads(data)
        if "sites" not in data:
            continue
        sdk = build_search_request(site_name=data["sites"], search_term=data["query"], location=data["location"] or None,
            results_wanted=data["results_per_site"], hours_old=data["hours_old"], is_remote=data["remote_only"],
            country_indeed=data["country_indeed"], description_format="markdown", linkedin_fetch_description=data["linkedin_fetch_description"])
        units.append({"unitId": unit_id, "status": status, "resultsPerSite": data["results_per_site"], "sdkFingerprint": sdk.fingerprint(),
            "sdkResultsWanted": sdk.results_wanted, "sdkMaxPages": sdk.max_pages, "result": json.loads(result) if result else None})
print(json.dumps({"adapters": adapters, "received": received, "receipts": receipts, "receiptKeys": receipt_keys, "request": request, "units": units}))
`, workspace, runId], { env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
        return JSON.parse(inspected.stdout);
      },
      async restartWorker(workerFeatures, afterExit) {
        const previous = worker;
        previous.crash();
        await previous.stop();
        services.splice(services.indexOf(previous), 1);
        await afterExit?.();
        const next = await startWorker(workerFeatures);
        if (next === previous.pid)
          throw new Error("Worker restart did not change process identity");
        await waitFor(async () => {
          worker.assertRunning();
          const health = await fetch(`${baseURL}/v1/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          return (await health.json()).worker?.healthy === true;
        }, "replacement Python worker registration");
        return { previous: previous.pid, current: next };
      },
      async file(relative) {
        const target = path.resolve(workspace, relative);
        if (!target.startsWith(`${workspace}${path.sep}`))
          throw new Error("Artifact escaped the owned workspace");
        if ((await realpath(target)) !== target)
          throw new Error("Artifact path follows a symlink");
        return readFile(target);
      },
      async close({ retainState = false } = {}) {
        const problems = [];
        for (const service of services.reverse())
          try {
            await service.stop();
          } catch (error) {
            problems.push(error);
          }
        try {
          external.assertDrained();
        } catch (error) {
          problems.push(error);
        }
        await external.close();
        // Failed synthetic state stays local for diagnosis. It is explicitly
        // excluded from artifact upload, including its private native HOME.
        if (!retainState) {
          await removeAllocated(workspace, workspaceIdentity);
          if (replacementWorkspace) await removeAllocated(replacementWorkspace.path, replacementWorkspace.identity);
          await removeAllocated(home, homeIdentity);
        }
        if (problems.length)
          throw new AggregateError(problems, "E2E cleanup failed");
      },
    };
  } catch (error) {
    for (const service of services.reverse())
      await service.stop().catch(() => {});
    await external.close();
    throw error;
  }
}

export async function startRuntime({ databaseURL, ...options }) {
  if (!databaseURL)
    throw new Error("startRuntime requires its owned PostgreSQL database URL");
  return applicationStack(databaseURL, options);
}

export async function demoStack() {
  const started = performance.now();
  const root = await ownedRun();
  const directory = await mkdtemp(path.join(root, "demo-"));
  const home = path.join(directory, "home");
  const staticDir = path.join(directory, "web");
  await mkdir(home, { mode: 0o700 });
  const identity = await lstat(home, { bigint: true });
  const apiPort = await port();
  const env = {
    ...environment(home),
    VITE_JOBCTRL_APP_MODE: "demo",
    VITE_JOBCTRL_API_BASE_URL: "",
    VITE_GOOGLE_MAPS_API_KEY: "",
    VITE_JOBCTRL_HIDE_DEVTOOLS: "1",
    VITE_DEMO_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  };
  const services = [];
  async function stopAll() {
    const failures = [];
    for (const service of [...services].reverse()) {
      try {
        await service.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
  try {
    const wrangler = path.join(
      repo,
      "apps/demo-edge/node_modules/wrangler/bin/wrangler.js",
    );
    const config = path.join(repo, "apps/demo-edge/wrangler.api.jsonc");
    const state = path.join(directory, "edge-state");
    const migration = await execFile(
      process.execPath,
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "DEMO_TELEMETRY_DB",
        "--local",
        "--config",
        config,
        "--persist-to",
        state,
      ],
      {
        cwd: path.join(repo, "apps/demo-edge"),
        env,
        timeout: 45_000,
        maxBuffer: 1_000_000,
      },
    );
    await writeFile(
      path.join(directory, "migrations.log"),
      migration.stdout + migration.stderr,
      { mode: 0o600 },
    );
    const edge = await launch(
      "edge",
      process.execPath,
      [
        wrangler,
        "dev",
        "--config",
        config,
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(apiPort),
        "--inspector-port",
        "0",
        "--persist-to",
        state,
      ],
      { directory, env, cwd: path.join(repo, "apps/demo-edge") },
    );
    services.push(edge);
    await waitFor(async () => {
      edge.assertRunning();
      return (
        await fetch(`http://127.0.0.1:${apiPort}/api/demo-consent`, {
          headers: {
            "Sec-Fetch-Site": "same-origin",
            "CF-Connecting-IP": "127.0.0.1",
          },
          signal: AbortSignal.timeout(2_000),
        })
      ).ok;
    }, "real local consent Worker");
    const vite = path.join(repo, "apps/web/node_modules/vite/bin/vite.js");
    const buildStarted = performance.now();
    const build = await execFile(
      process.execPath,
      [vite, "build", "--outDir", staticDir, "--emptyOutDir"],
      {
        cwd: path.join(repo, "apps/web"),
        env,
        timeout: 90_000,
        maxBuffer: 2_000_000,
      },
    );
    await writeFile(
      path.join(directory, "build.log"),
      build.stdout + build.stderr,
      { mode: 0o600 },
    );
    const buildMs = Math.round(performance.now() - buildStarted);
    const webPort = await port();
    const baseURL = `http://127.0.0.1:${webPort}`;
    const preview = await launch(
      "demo",
      process.execPath,
      [
        vite,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
        "--outDir",
        staticDir,
      ],
      { directory, env, cwd: path.join(repo, "apps/web") },
    );
    services.push(preview);
    await waitFor(async () => {
      preview.assertRunning();
      return (await fetch(baseURL, { signal: AbortSignal.timeout(2_000) })).ok;
    }, "compiled local demo");
    return {
      baseURL,
      directory,
      buildMs,
      setupMs: Math.round(performance.now() - started),
      async close() {
        const failures = await stopAll();
        await removeAllocated(home, identity);
        if (failures.length)
          throw new AggregateError(failures, "Demo process cleanup failed");
      },
    };
  } catch (error) {
    const failures = await stopAll();
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Demo startup and cleanup failed",
      );
    throw error;
  }
}
