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

const execFile = promisify(execFileCallback);
export const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const groupScript = fileURLToPath(
  new URL("process-group.mjs", import.meta.url),
);
export const python = path.join(repo, "workers/automation/.venv/bin/python");
const temporal = process.env.JOBCTRL_TEMPORAL_CLI_PATH ?? "temporal";
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

async function removeAllocated(directory, identity) {
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

export async function temporalStack() {
  const root = await ownedRun();
  const directory = await mkdtemp(path.join(root, "temporal-"));
  const identity = await lstat(directory, { bigint: true });
  const home = path.join(directory, "home");
  await mkdir(home, { mode: 0o700 });
  const address = `127.0.0.1:${await port()}`;
  const service = await launch(
    "temporal",
    temporal,
    [
      "server",
      "start-dev",
      "--ip",
      "127.0.0.1",
      "--port",
      address.split(":")[1],
      "--headless",
      "--db-filename",
      path.join(directory, "history.db"),
      "--log-level",
      "error",
    ],
    { directory, env: environment(home) },
  );
  try {
    await waitFor(
      async () => {
        service.assertRunning();
        const { stdout } = await execFile(
          temporal,
          ["operator", "cluster", "health", "--address", address],
          { timeout: 3_000, env: environment(home) },
        );
        return stdout.includes("SERVING");
      },
      "real Temporal health",
      { timeout: 40_000 },
    );
  } catch (error) {
    await service.stop();
    throw error;
  }
  let retainState = false;
  return {
    address,
    retainForDiagnosis() {
      retainState = true;
    },
    async close() {
      await service.stop();
      if (!retainState) await removeAllocated(directory, identity);
    },
  };
}

export async function applicationStack(
  temporalAddress,
  {
    features,
    discoveryTransport = "http",
    nativeAccountingPreflight = false,
    preflight = false,
    pythonExecutable = process.env.JOBCTRL_E2E_PYTHON ?? python,
    staticDir = process.env.JOBCTRL_E2E_STATIC_DIR ??
      path.join(repo, "dist/web"),
  } = {},
) {
  const started = performance.now();
  const root = await ownedRun();
  const directory = await mkdtemp(path.join(root, "application-"));
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
    JOBCTRL_TEMPORAL_ADDRESS: temporalAddress,
    JOBCTRL_TEMPORAL_NAMESPACE: "default",
    JOBCTRL_TEMPORAL_TASK_QUEUE: `e2e-${randomUUID()}`,
    JOBCTRL_SYNTHETIC_BOUNDARIES: "1",
    JOBCTRL_E2E_TOKEN: token,
    JOBCTRL_E2E_PROVIDER_URL: `${external.url}/model`,
    JOBCTRL_GMAIL_API_ROOT: `${external.url}/gmail/v1`,
    JOBCTRL_DISCOVERY_PROVIDER_ENDPOINT: `${external.url}/discovery`,
    JOBCTRL_DISCOVERY_PROVIDER_TOKEN: token,
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
  if (discoveryTransport === "jobstreaming") {
    delete env.JOBCTRL_DISCOVERY_PROVIDER_ENDPOINT;
    env.JOBCTRL_JOBSTREAMING_PROVIDER_ENDPOINT = `${external.url}/jobstreaming`;
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
  let workerGeneration = 0;
  async function startWorker() {
    worker = await launch(
      `worker-${++workerGeneration}`,
      pythonExecutable,
      [
        "-m",
        "jobctrl.app.worker",
        "--workspace",
        workspace,
        "--temporal-address",
        temporalAddress,
      ],
      { directory, env },
    );
    services.push(worker);
    return worker.pid;
  }
  try {
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
    const credentialHelper = path.join(workspace, "credential-helper");
    await writeFile(
      credentialHelper,
      `#!${pythonExecutable}\nimport json, os, pathlib, sys\nroot = pathlib.Path(__file__).parent\noperation, key = sys.argv[1:]\nstore = root / 'synthetic-credential-store.json'\nvalue = json.loads(store.read_text()) if store.exists() else {}\nif (root / 'fail-credential-helper').exists(): sys.exit(70)\nif operation in ('inspect', 'read'):\n if key not in value: sys.exit(44)\n if operation == 'read': sys.stdout.write(value[key])\nelif operation == 'set':\n value[key] = sys.stdin.read()\n temporary = store.with_suffix('.pending')\n fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)\n with os.fdopen(fd, 'w') as stream:\n  json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())\n os.replace(temporary, store)\nelif operation == 'delete':\n value.pop(key, None)\n store.write_text(json.dumps(value)); store.chmod(0o600)\nelse: sys.exit(64)\n`,
      { mode: 0o700, flag: "wx" },
    );
    if (!nativeAccountingPreflight) env.JOBCTRL_E2E_CREDENTIAL_HELPER = credentialHelper;
    const server = await launch(
      "api",
      pythonExecutable,
      [
        "-m",
        "jobctrl.app.server",
        "--host",
        "127.0.0.1",
        "--port",
        env.JOBCTRL_API_PORT,
        "--workspace",
        workspace,
        ...(preflight ? [] : ["--static-dir", staticDir]),
      ],
      { directory, env },
    );
    services.push(server);
    await waitFor(async () => {
      server.assertRunning();
      return (
        await fetch(`${baseURL}/v1/health`, {
          signal: AbortSignal.timeout(2_000),
        })
      ).ok;
    }, "Python HTTP health");
    if (!preflight) {
      await startWorker();
      await waitFor(async () => {
        worker.assertRunning();
        const health = await fetch(`${baseURL}/v1/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        return (await health.json()).worker?.healthy === true;
      }, "live Python worker registration");
      // The ordinary user setting keeps unrelated background compensation work
      // from consuming another journey's explicit external-model request queue.
      // Automation itself has a separate journey which enables the setting.
      const settingsResponse = await fetch(`${baseURL}/v1/settings`);
      const settings = await settingsResponse.json();
      const configured = await fetch(`${baseURL}/v1/settings`, {
        method: "PATCH",
        headers: { Origin: baseURL, "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: settings.revision,
          compensationAutomationEnabled: false,
        }),
      });
      if (!configured.ok)
        throw new Error(
          `Could not isolate compensation automation through Settings (${configured.status})`,
        );
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
      async failRendering() {
        await writeFile(renderFailure, "external browser process failure\n", {
          flag: "wx",
          mode: 0o600,
        });
      },
      async restoreRendering() {
        await rm(renderFailure);
      },
      async cli(args, { input } = {}) {
        try {
          const pending = execFile(
            pythonExecutable,
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
      async inspectPdf(bytes) {
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
        return { ...result, images };
      },
      async discoveryCheckpoint(runId) {
        // Read actual committed SDK checkpoints/receipts; never seed domain
        // state or infer an acknowledgement from the next outbound request.
        const inspected = await execFile(pythonExecutable, ["-c", `
import hashlib, json, os, pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1])
owner = json.loads((root / ".jobctrl-e2e-owned.json").read_text())
assert owner["workspace"] == str(root) and owner["token"] == os.environ["JOBCTRL_E2E_TOKEN"]
run_id = sys.argv[2]
key = hashlib.sha256(json.dumps(run_id, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
directory = root / "discovery-checkpoints" / key
assert not directory.is_symlink() and not directory.parent.is_symlink()
adapters = []
for path in directory.glob("*.sqlite3"):
    assert not path.is_symlink() and path.resolve().is_relative_to(root.resolve())
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1) as conn:
        conn.execute("PRAGMA query_only=ON")
        for site, state, emitted, completed in conn.execute("SELECT site,state_json,emitted_count,completed FROM jobstreaming_adapter_checkpoint"):
            adapters.append({"site": site, "state": json.loads(state), "emittedCount": emitted, "completed": bool(completed)})
path = root / "jobctrl.db"
assert not path.is_symlink()
with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1) as conn:
    conn.execute("PRAGMA query_only=ON")
    receipts = dict(conn.execute("SELECT outcome,COUNT(*) FROM discovery_intake_receipts WHERE run_id=? GROUP BY outcome", (run_id,)))
print(json.dumps({"adapters": adapters, "receipts": receipts}))
`, workspace, runId], { env, timeout: 5000, maxBuffer: 100_000 });
        return JSON.parse(inspected.stdout);
      },
      async restartWorker() {
        const previous = worker;
        previous.crash();
        await previous.stop();
        services.splice(services.indexOf(previous), 1);
        const next = await startWorker();
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

export async function startRuntime({ temporalAddress, ...options }) {
  if (!temporalAddress)
    throw new Error("startRuntime requires its owned Temporal server address");
  return applicationStack(temporalAddress, options);
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
