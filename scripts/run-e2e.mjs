import { spawn, execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const { sourceInventory, sourceResource } = await import("./e2e-candidate.mjs");

const root = fileURLToPath(new URL("../", import.meta.url));
const started = performance.now();
const arguments_ = process.argv.slice(2).filter((arg) => arg !== "--");
const installed = arguments_.includes("--installed");
const testArguments = [];
let consoleReporter;
for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === "--installed") continue;
  if (argument.startsWith("--reporter=")) {
    consoleReporter = argument.slice("--reporter=".length);
    continue;
  }
  if (argument === "--reporter") {
    consoleReporter = arguments_[++index];
    continue;
  }
  testArguments.push(argument);
}
if (
  installed &&
  (!path.isAbsolute(process.env.JOBCTRL_E2E_PYTHON ?? "") ||
    !path.isAbsolute(process.env.JOBCTRL_E2E_STATIC_DIR ?? "") ||
    !path.isAbsolute(process.env.JOBCTRL_E2E_PAYLOAD_DIR ?? ""))
) {
  throw new Error(
    "Installed journeys require absolute JOBCTRL_E2E_PAYLOAD_DIR, JOBCTRL_E2E_PYTHON and JOBCTRL_E2E_STATIC_DIR from the same extracted candidate",
  );
}
const lockPath = path.join(root, "workers/automation/uv.lock");
const lockDigest = createHash("sha256")
  .update(await readFile(lockPath))
  .digest("hex");
const parent =
  process.platform === "darwin"
    ? "/private/tmp/jobctrl-transform-1428"
    : path.join(os.tmpdir(), "jobctrl-transform-1428");
await mkdir(parent, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(path.join(parent, "e2e-"));
const token = randomBytes(32).toString("hex");
const identity = await lstat(evidence, { bigint: true });
await writeFile(
  path.join(evidence, ".e2e-owned.json"),
  JSON.stringify({
    directory: evidence,
    token,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  }),
  { flag: "wx", mode: 0o600 },
);
const environment = {
  ...process.env,
  JOBCTRL_E2E_RUN_DIR: evidence,
  JOBCTRL_E2E_RUN_TOKEN: token,
  JOBCTRL_E2E_INSTALLED: installed ? "1" : "0",
  ...(consoleReporter ? { JOBCTRL_E2E_CONSOLE_REPORTER: consoleReporter } : {}),
  UV_LOCKED: "1",
  VITE_JOBCTRL_API_BASE_URL: "",
  VITE_JOBCTRL_HIDE_DEVTOOLS: "1",
};
// Keep the project's locked cutoffs; do not inherit a caller's global cutoff.
// Older pinned uv versions do not accept a "false" disabling sentinel.
delete environment.UV_EXCLUDE_NEWER;
delete environment.UV_EXCLUDE_NEWER_PACKAGE;
if (installed) {
  environment.JOBCTRL_E2E_PAYLOAD_DIR = await realpath(
    environment.JOBCTRL_E2E_PAYLOAD_DIR,
  );
  for (const key of ["JOBCTRL_E2E_PYTHON", "JOBCTRL_E2E_STATIC_DIR"]) {
    const actual = await realpath(environment[key]);
    if (
      !actual.startsWith(`${environment.JOBCTRL_E2E_PAYLOAD_DIR}${path.sep}`)
    ) {
      throw new Error(`${key} escapes the extracted candidate payload`);
    }
    environment[key] = actual;
  }
} else {
  delete environment.JOBCTRL_E2E_PYTHON;
  delete environment.JOBCTRL_E2E_STATIC_DIR;
  delete environment.JOBCTRL_E2E_PAYLOAD_DIR;
}
let active;
let interrupted;
let preflightStarted;
let verifyOwnedRun;
let removeAllocated;
let snapshotIdentity;
let webIdentity;

async function greenBrowserReport() {
  // Listing, custom reporters/configs, zero tests, retries, skips and incomplete
  // teardown must retain their generated artifacts even if Playwright exits 0.
  if (arguments_.some((arg) => arg === "--list" || arg === "-l")) return false;
  const reportPath = path.join(evidence, "results.json");
  let report;
  try {
    const info = await lstat(reportPath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) return false;
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    return false;
  }
  if (!report || typeof report !== "object" ||
      report.config?.configFile !== path.join(root, "apps/web/e2e/playwright.config.ts") ||
      !Array.isArray(report.errors) || report.errors.length !== 0 ||
      !Number.isInteger(report.stats?.expected) || report.stats.expected < 1 ||
      report.stats.skipped !== 0 || report.stats.unexpected !== 0 || report.stats.flaky !== 0 ||
      !Array.isArray(report.suites)) return false;
  let count = 0;
  function greenSuite(suite) {
    if (!suite || typeof suite !== "object" || !Array.isArray(suite.specs) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))) return false;
    for (const spec of suite.specs) {
      if (!spec || typeof spec !== "object" || !Array.isArray(spec.tests) || spec.tests.length === 0) return false;
      for (const test of spec.tests) {
        count++;
        if (!test || typeof test !== "object" || test.status !== "expected" || test.expectedStatus !== "passed" ||
            !Array.isArray(test.results) || test.results.length !== 1 ||
            !test.results[0] || test.results[0].status !== "passed" || test.results[0].retry !== 0) return false;
      }
    }
    return (suite.suites ?? []).every(greenSuite);
  }
  return report.suites.every(greenSuite) && count === report.stats.expected;
}

async function removeGreenGeneratedArtifacts() {
  if (!verifyOwnedRun || await verifyOwnedRun() !== evidence || !snapshotIdentity || !webIdentity)
    throw new Error("E2E run or generated directory ownership could not be verified");
  const directories = [
    [path.join(evidence, "source-checkout"), snapshotIdentity],
    [path.join(evidence, "web-build"), webIdentity],
  ];
  for (const [directory, identity] of directories) await removeAllocated(directory, identity);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    active?.kill(signal);
  });
}

function run(args) {
  return new Promise((resolve, reject) => {
    active = spawn("corepack", ["pnpm", ...args], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    active.once("error", reject);
    active.once("exit", (code, signal) => {
      active = undefined;
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

const summary = {
  mode: installed ? "installed" : "source",
  runner: {
    platform: process.platform,
    arch: process.arch,
    cpus: os.availableParallelism(),
    node: process.version,
  },
  evidence,
  ...(installed ? { payloadRoot: environment.JOBCTRL_E2E_PAYLOAD_DIR } : {}),
};
try {
  const freezeStarted = performance.now();
  if (!installed) {
    const source = path.join(root, "workers/automation/src/jobctrl");
    // Keep actual checkout topology for source-only resources whose owning
    // code deliberately resolves from workers/automation/src to repo root.
    const snapshotRoot = path.join(evidence, "source-checkout");
    const snapshot = path.join(snapshotRoot, "workers/automation/src/jobctrl");
    const policyRelative = "packaging/distribution/capability-policy.json";
    const policy = path.join(root, policyRelative);
    const policySnapshot = path.join(snapshotRoot, policyRelative);
    const [before, policyBefore] = await Promise.all([
      sourceInventory(source),
      sourceResource(policy),
    ]);
    const [copied, policyCopied] = await Promise.all([
      sourceInventory(source, snapshot),
      sourceResource(policy, policySnapshot),
    ]);
    const [after, policyAfter] = await Promise.all([
      sourceInventory(source),
      sourceResource(policy),
    ]);
    if (
      before.sha256 !== copied.sha256 ||
      copied.sha256 !== after.sha256 ||
      policyBefore.sha256 !== policyCopied.sha256 ||
      policyCopied.sha256 !== policyAfter.sha256
    ) {
      throw new Error(
        "Python source changed while its snapshot was copied; no application stack was started",
      );
    }
    snapshotIdentity = await lstat(snapshotRoot, { bigint: true });
    environment.JOBCTRL_E2E_SOURCE_PATH = path.dirname(snapshot);
    summary.pythonSource = { ...copied, path: snapshot };
    summary.runtimePolicy = { ...policyCopied, path: policySnapshot };
    summary.sourceCandidateSha256 = createHash("sha256")
      .update(
        `${policyRelative}\0${policyCopied.sha256}\0workers/automation/src/jobctrl\0${copied.sha256}\0`,
      )
      .digest("hex");
  } else {
    delete environment.JOBCTRL_E2E_SOURCE_PATH;
  }
  const interpreter = installed
    ? environment.JOBCTRL_E2E_PYTHON
    : path.join(root, "workers/automation/.venv/bin/python");
  const probe = await execFile(
    interpreter,
    [
      "-c",
      "import pathlib,jobctrl\nprint(pathlib.Path(jobctrl.__file__).resolve())",
    ],
    {
      cwd: evidence,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: evidence,
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        ...(installed
          ? {}
          : { PYTHONPATH: environment.JOBCTRL_E2E_SOURCE_PATH }),
      },
    },
  );
  const origin = probe.stdout.trim();
  if (
    installed
      ? origin.startsWith(`${root}${path.sep}`) ||
        !origin.startsWith(`${environment.JOBCTRL_E2E_PAYLOAD_DIR}${path.sep}`)
      : origin !== path.join(summary.pythonSource.path, "__init__.py")
  ) {
    throw new Error(
      "Python imported JobCtrl from a different candidate origin",
    );
  }
  summary.pythonOrigin = origin;
  summary.snapshotMs = Math.round(performance.now() - freezeStarted);

  // Run the same public server entry point once before paying for a web build
  // or starting per-journey fleets. Frozen bytes can still capture an incomplete
  // multi-file edit; an import-only probe does not prove route composition.
  for (const key of [
    "JOBCTRL_E2E_RUN_DIR",
    "JOBCTRL_E2E_RUN_TOKEN",
    "JOBCTRL_E2E_INSTALLED",
    "JOBCTRL_E2E_SOURCE_PATH",
    "JOBCTRL_E2E_PYTHON",
    "JOBCTRL_E2E_STATIC_DIR",
    "JOBCTRL_E2E_PAYLOAD_DIR",
  ]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  if (interrupted) throw new Error(`E2E run interrupted by ${interrupted}`);
  preflightStarted = performance.now();
  summary.preflight = { status: "starting" };
  const { applicationStack, postgresStack, ownedRun, removeAllocated: removeOwnedDirectory } =
    await import("../apps/web/e2e/harness/runtime.mjs");
  verifyOwnedRun = ownedRun;
  removeAllocated = removeOwnedDirectory;
  const preflightDatabase = await postgresStack();
  let preflight;
  try {
    preflight = await applicationStack(await preflightDatabase.createDatabase(), {
      preflight: true,
      pythonExecutable: interpreter,
    });
    await preflight.close();
  } finally { await preflightDatabase.close(); }
  summary.preflight = {
    status: "passed",
    elapsedMs: Math.round(performance.now() - preflightStarted),
    directory: preflight.directory,
  };
  console.log(
    `E2E composition preflight: ${JSON.stringify(summary.preflight)}`,
  );

  if (interrupted) throw new Error(`E2E run interrupted by ${interrupted}`);
  const buildStarted = performance.now();
  const staticDir = installed ? environment.JOBCTRL_E2E_STATIC_DIR : path.join(evidence, "web-build");
  let code = installed ? 0 : await run(["--filter", "@jobctrl/web", "exec", "vite", "build", "--outDir", staticDir]);
  environment.JOBCTRL_E2E_STATIC_DIR = staticDir;
  summary.buildMs = Math.round(performance.now() - buildStarted);
  if (code === 0 && !interrupted) {
    if (!installed) webIdentity = await lstat(staticDir, { bigint: true });
    summary.webBuild = await sourceInventory(staticDir);
    const testStarted = performance.now();
    code = await run([
      "--filter",
      "@jobctrl/web",
      "exec",
      "playwright",
      "test",
      "--config=e2e/playwright.config.ts",
      ...testArguments,
    ]);
    summary.journeysMs = Math.round(performance.now() - testStarted);
    summary.webBuildUnchanged =
      (await sourceInventory(staticDir)).sha256 === summary.webBuild.sha256;
    if (!summary.webBuildUnchanged) code = 1;
  }
  summary.exitCode = code;
  process.exitCode = code;
} catch (error) {
  if (summary.preflight?.status === "starting") {
    summary.preflight.status = "failed";
    summary.preflight.elapsedMs = Math.round(
      performance.now() - preflightStarted,
    );
  }
  summary.error = error.message;
  summary.exitCode = 1;
  process.exitCode = 1;
} finally {
  summary.totalMs = Math.round(performance.now() - started);
  summary.signal = interrupted ?? null;
  // Lockfile mutation is a failed run, even if the browser assertions passed.
  summary.lockfileUnchanged =
    createHash("sha256")
      .update(await readFile(lockPath))
      .digest("hex") === lockDigest;
  if (!summary.lockfileUnchanged) {
    summary.exitCode = 1;
    process.exitCode = 1;
  }
  const timingsPath = path.join(evidence, "timings.json");
  // Persist the candidate hashes and run outcome before releasing any bytes.
  await writeFile(timingsPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (!installed && summary.exitCode === 0 && !interrupted && summary.webBuildUnchanged === true &&
      summary.lockfileUnchanged === true && await greenBrowserReport()) {
    try {
      if (!verifyOwnedRun || await verifyOwnedRun() !== evidence || !snapshotIdentity || !webIdentity)
        throw new Error("E2E run or generated directory ownership could not be verified");
      const snapshotRoot = path.join(evidence, "source-checkout");
      const current = await lstat(snapshotRoot, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== snapshotIdentity.dev ||
          current.ino !== snapshotIdentity.ino || await realpath(snapshotRoot) !== snapshotRoot)
        throw new Error("Generated E2E source identity changed; cleanup refused");
      const [sourceAfter, policyAfter] = await Promise.all([
        sourceInventory(summary.pythonSource.path), sourceResource(summary.runtimePolicy.path),
      ]);
      summary.pythonSourceUnchanged = sourceAfter.sha256 === summary.pythonSource.sha256;
      summary.runtimePolicyUnchanged = policyAfter.sha256 === summary.runtimePolicy.sha256;
      if (!summary.pythonSourceUnchanged || !summary.runtimePolicyUnchanged)
        throw new Error("Frozen E2E source changed during the run; cleanup refused");
      if (interrupted) throw new Error("E2E run interrupted before cleanup; generated artifacts retained");
      await removeGreenGeneratedArtifacts();
      summary.generatedArtifacts = { status: "removed", bytes: summary.pythonSource.bytes + summary.runtimePolicy.bytes + summary.webBuild.bytes };
    } catch (error) {
      summary.generatedArtifacts = { status: "cleanup_failed", error: error.message };
      summary.exitCode = 1;
      process.exitCode = 1;
    }
  } else {
    summary.generatedArtifacts = { status: "retained" };
  }
  summary.totalMs = Math.round(performance.now() - started);
  await writeFile(timingsPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`E2E timing: ${JSON.stringify(summary)}`);
}
