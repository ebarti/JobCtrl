#!/usr/bin/env node

// Exercise the published acquisition commands on a disposable macOS runner.
// Unlike the pre-publication signed-cache smoke, Homebrew itself is unmodified.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDescriptorSignature } from "./distribution-homebrew.render.bundle.mjs";
import { fetchPublishedReleases, installArgs, runForwardInterruptionMatrix, selectLatestReleasedVersion, selectUpgradeMode } from "./released-upgrade-smoke.mjs";
import { establishSourceOwnership } from "./released-source-ownership.mjs";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};

async function run(executable, args, env, { allowFailure = false } = {}) {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (!allowFailure) assert.equal(result.code, 0, `${path.basename(executable)} ${args.join(" ")}: ${output}`);
    return { ...result, output };
  } finally { clearTimeout(timer); }
}

async function download(url, file, env) {
  await run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--retry", "2", "--max-time", "240", url, "-o", file], env);
}

async function releaseIdentity(directory, trust) {
  const descriptorRaw = await readFile(path.join(directory, "release-descriptor.json"), "utf8");
  const signatureRaw = await readFile(path.join(directory, "release-descriptor.json.sig"), "utf8");
  const descriptor = verifyReleaseDescriptorSignature({ descriptorRaw, signatureRaw, trust });
  const manifest = await readJson(path.join(directory, "manifest.json"));
  assert.equal(await hash(path.join(directory, "manifest.json")), descriptor.artifact.manifestSha256);
  assert.equal(manifest.buildId, descriptor.buildId);
  assert.equal(manifest.appVersion, descriptor.appVersion);
  return { descriptor, manifest, directory };
}

async function publishedSource(version, root, trust, env) {
  const directory = path.join(root, `v${version}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["release-descriptor.json", "release-descriptor.json.sig", "manifest.json", "install.sh", "SHA256SUMS"]) {
    await download(`https://github.com/ebarti/JobCtrl/releases/download/v${version}/${name}`, path.join(directory, name), env);
  }
  const release = await releaseIdentity(directory, trust);
  assert.equal(release.descriptor.appVersion, version);
  const sums = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  const scriptLine = sums.split(/\r?\n/).filter((line) => /^[a-f0-9]{64}  install\.sh$/.test(line));
  assert.equal(scriptLine.length, 1, "published source must have one install-script checksum");
  assert.equal(await hash(path.join(directory, "install.sh")), scriptLine[0].slice(0, 64));
  return release;
}

const pointer = (release) => `https://releases.jobctrl.dev/v1/artifacts/${release.descriptor.buildId}/channel-pointer.json`;

async function prepareWorkspace(old, runtime, state, env, frontend) {
  const selector = path.join(runtime, "bin", "jobctrl");
  await run(frontend, ["start", "--no-open"], env);
  assert.equal(JSON.parse((await run(selector, ["status", "--json"], env)).output).status, "running");
  const oldPayload = path.join(runtime, "releases", old.descriptor.buildId, "payload");
  const python = path.join(oldPayload, "python", "bin", "python3");
  let temporal = path.join(oldPayload, "temporal", "temporal");
  const workflowId = `jobctrl-acquisition-qa-${path.basename(path.dirname(state))}`;
  const temporalCommand = (args) => run(temporal, [...args, "--address", "127.0.0.1:7233", "--disable-config-file", "--disable-config-env"], env);
  await temporalCommand(["workflow", "start", "--workflow-id", workflowId, "--type", "JobCtrlUpgradeSmoke", "--task-queue", "jobctrl-upgrade-unused", "--input", "{}"]);
  await temporalCommand(["workflow", "terminate", "--workflow-id", workflowId, "--reason", "Owned acquisition QA fixture"]);
  const history = JSON.parse((await temporalCommand(["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
  await run(selector, ["stop"], env);
  const seed = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000892','https://jobs.example/acquisition-qa','Preserved acquisition QA job')"); c.commit(); print(c.execute('PRAGMA user_version').fetchone()[0]); c.close()`;
  const schema = Number((await run(python, ["-I", "-B", "-c", seed, path.join(state, "jobctrl.db")], env)).output.trim());
  await writeFile(path.join(state, "qa-external-resume.txt"), "Synthetic external resume\n", { mode: 0o600 });
  const context = { selector, python, temporalCommand, workflowId, history, schema };
  context.useCandidate = (candidate) => {
    const payload = path.join(runtime, "releases", candidate.descriptor.buildId, "payload");
    context.python = path.join(payload, "python", "bin", "python3");
    temporal = path.join(payload, "temporal", "temporal");
  };
  return context;
}

async function verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, expectedTitle = "Preserved acquisition QA job") {
  const active = await readJson(path.join(runtime, "active.json"));
  assert.equal(active.receipt.buildId, candidate.descriptor.buildId);
  assert.equal(JSON.parse((await run(context.selector, ["status", "--json"], env)).output).status, "running");
  const query = "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('PRAGMA user_version').fetchone()[0],c.execute(\"SELECT title FROM jobs WHERE url='https://jobs.example/acquisition-qa'\").fetchone()[0]])); c.close()";
  assert.deepEqual(JSON.parse((await run(context.python, ["-I", "-B", "-c", query, path.join(state, "jobctrl.db")], env)).output), [expectedSchema, expectedTitle]);
  assert.equal(await readFile(path.join(state, "qa-external-resume.txt"), "utf8"), "Synthetic external resume\n");
  const history = JSON.parse((await context.temporalCommand(["workflow", "describe", "--workflow-id", context.workflowId, "--output", "json"])).output).workflowExecutionInfo;
  assert.equal(history.execution.runId, context.history.execution.runId);
  assert.equal(history.status, "WORKFLOW_EXECUTION_STATUS_TERMINATED");
  assert.equal(history.historyLength, context.history.historyLength);
  const journal = await readJson(path.join(runtime, "transition.json"));
  assert.ok(journal.backupId);
  const pairDir = path.join(state, "backups", journal.backupId);
  const pair = await readJson(path.join(pairDir, "pair.json"));
  assert.equal(pair.id, journal.backupId);
  assert.deepEqual(pair.files.map((file) => file.name).sort(), ["jobctrl.db", "temporal.db"]);
  for (const file of pair.files) assert.equal(await hash(path.join(pairDir, file.name)), file.sha256);
}

async function useLegacyHistory(state) {
  const directory = path.join(state, "temporal");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    try { await rename(path.join(state, `temporal.db${suffix}`), path.join(directory, `temporal.db${suffix}`)); }
    catch (error) { if (!suffix || error.code !== "ENOENT") throw error; }
  }
  return path.join(directory, "temporal.db");
}

async function curlScenario(old, candidate, root, baseEnv) {
  const home = path.join(root, "home"), runtime = path.join(root, "runtime"), state = path.join(root, "state"), bin = path.join(root, "bin");
  for (const directory of [home, state, bin]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...baseEnv, HOME: home, JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state };
  const selector = path.join(runtime, "bin", "jobctrl");
  try {
    await run("/bin/bash", [path.join(old.directory, "install.sh"), "--home", runtime, "--bin-dir", bin, "--no-modify-path", "--release-url", pointer(old)], env);
    const context = await prepareWorkspace(old, runtime, state, env, selector);
    console.log(`${old.descriptor.appVersion}: upgrading through the released curl bootstrap`);
    const upgrade = [path.join(candidate.directory, "install.sh"), "--home", runtime, "--bin-dir", bin, "--no-modify-path", "--release-url", pointer(candidate)];
    const forward = selectUpgradeMode(old.manifest, candidate.manifest, context.schema) === "forward-schema-15";
    const checks = ["released-bootstrap", "real-services", "paired-backup", "job-and-resume-preserved", "temporal-history-preserved", "stop-and-restart"];
    let title = "Preserved acquisition QA job";
    if (forward) {
      // Earlier source checkouts stored the same history one level deeper.
      // Recreate that owned, stopped layout to qualify its real upgrade path.
      const historyPath = await useLegacyHistory(state);
      await establishSourceOwnership({ sourceBinary: process.env.JOBCTRL_RELEASE_QA_SOURCE_BINARY, root, runtime, state, history: historyPath, python: context.python, env });
      checks.push("synthetic-source-owner-established-for-legacy-history");
      const matrix = await runForwardInterruptionMatrix({
        old, candidate, root, runtime, state, env, selector, acquisition: "curl", readinessFailure: true,
        historyPath, jobUrl: "https://jobs.example/acquisition-qa",
        payload: path.join(runtime, "releases", candidate.descriptor.buildId, "payload"),
        initial: { executable: "/bin/bash", args: upgrade },
      });
      title = matrix.title;
      checks.push(...matrix.checks);
    } else {
      await run("/bin/bash", upgrade, env);
    }
    context.useCandidate(candidate);
    const expectedSchema = forward ? 15 : context.schema;
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, title);
    await run(selector, ["stop"], env);
    await run(selector, ["start", "--no-open"], env);
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, title);
    return { acquisition: "curl", sourceSchema: context.schema, targetSchema: expectedSchema, checks };
  } finally { await run(selector, ["stop"], env, { allowFailure: true }).catch(() => {}); }
}

// A checkout may already have migrated the shared workspace before the user
// acquires the new installed release. Qualify that distinct stopped-state path.
async function curlAlreadyMigratedScenario(old, candidate, root, baseEnv) {
  const source = old.manifest.launcherCompatibility, target = candidate.manifest.launcherCompatibility;
  if (source?.minimum !== 1 || source?.maximum !== 1 || target?.minimum !== 2 || target?.maximum !== 2) {
    return { acquisition: "curl-already-migrated", status: "not-applicable" };
  }
  const home = path.join(root, "home"), runtime = path.join(root, "runtime"), state = path.join(root, "state"), bin = path.join(root, "bin");
  for (const directory of [home, state, bin]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...baseEnv, HOME: home, JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state };
  const selector = path.join(runtime, "bin", "jobctrl");
  try {
    await run("/bin/bash", [path.join(old.directory, "install.sh"), "--home", runtime, "--bin-dir", bin, "--no-modify-path", "--release-url", pointer(old)], env);
    const context = await prepareWorkspace(old, runtime, state, env, selector);
    if (selectUpgradeMode(old.manifest, candidate.manifest, context.schema) !== "forward-schema-15") {
      return { acquisition: "curl-already-migrated", status: "not-applicable" };
    }
    const history = await useLegacyHistory(state);
    await run(candidate.installer, installArgs(candidate, runtime, true, "curl"), env);
    const payload = path.join(runtime, "releases", candidate.descriptor.buildId, "payload");
    const python = path.join(payload, "python", "bin", "python3");
    const app = path.join(state, "jobctrl.db");
    const appInode = (await stat(app)).ino, historyInode = (await stat(history)).ino;
    const migrate = "import sqlite3,sys; from jobctrl.infrastructure.migrations.schema_v15 import upgrade_exact_v14_schema_to_v15; c=sqlite3.connect(sys.argv[1]); upgrade_exact_v14_schema_to_v15(c); c.close()";
    await run(python, ["-I", "-B", "-c", migrate, app], env);
    await establishSourceOwnership({ sourceBinary: process.env.JOBCTRL_RELEASE_QA_SOURCE_BINARY, root, runtime, state, history, python: context.python, env });
    await run("/bin/bash", [path.join(candidate.directory, "install.sh"), "--home", runtime, "--bin-dir", bin, "--no-modify-path", "--release-url", pointer(candidate)], env);
    context.useCandidate(candidate);
    await verifyWorkspace(context, candidate, runtime, state, env, 15);
    assert.equal((await stat(app)).ino, appInode);
    assert.equal((await stat(history)).ino, historyInode);
    await run(selector, ["stop"], env);
    await run(selector, ["start", "--no-open"], env);
    await verifyWorkspace(context, candidate, runtime, state, env, 15);
    return { acquisition: "curl-already-migrated", sourceSchema: 15, targetSchema: 15, checks: ["real-installer-accepts-already-migrated-workspace", "synthetic-source-owner-established-for-legacy-history", "legacy-history-path-and-inode-preserved", "job-resume-and-workflow-preserved", "paired-backup", "stop-and-restart"] };
  } finally { await run(selector, ["stop"], env, { allowFailure: true }).catch(() => {}); }
}

async function oldFormula(brew, old, env) {
  await run(brew, ["tap", "ebarti/tap"], env);
  const repository = (await run(brew, ["--repository", "ebarti/tap"], env)).output.trim();
  assert.ok(path.isAbsolute(repository));
  const shallow = (await run("/usr/bin/git", ["-C", repository, "rev-parse", "--is-shallow-repository"], env)).output.trim();
  if (shallow === "true") await run("/usr/bin/git", ["-C", repository, "fetch", "--unshallow"], env);
  const revisions = (await run("/usr/bin/git", ["-C", repository, "log", "--format=%H", "--all", "--", "Formula/jobctrl.rb"], env)).output.trim().split("\n");
  for (const revision of revisions.slice(0, 100)) {
    if (!/^[a-f0-9]{40}$/.test(revision)) continue;
    const candidate = await run("/usr/bin/git", ["-C", repository, "show", `${revision}:Formula/jobctrl.rb`], env, { allowFailure: true });
    if (candidate.code === 0 && candidate.output.includes(`JOBCTRL_BUILD_ID = "${old.descriptor.buildId}"`)) return candidate.output;
  }
  throw new Error("cannot find the exact published source formula in the Homebrew tap history");
}

async function brewScenario(old, candidate, root, baseEnv, sourceAcquisition = "homebrew") {
  const runtime = path.join(root, "runtime"), state = path.join(root, "state"), cache = path.join(root, "brew-cache");
  for (const directory of [state, cache]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...baseEnv, JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_CACHE: cache };
  const brew = "/opt/homebrew/bin/brew";
  const tap = `jobctrl/upgrade-qa-${process.env.GITHUB_RUN_ID ?? process.pid}`;
  const formula = `${tap}/jobctrl`;
  const frontend = "/opt/homebrew/bin/jobctrl";
  let tapCreated = false, installed = false;
  try {
    let context;
    if (sourceAcquisition === "curl") {
      // The historical 0.3.0 formula asks Apple's live notarization service
      // from inside Homebrew's sandbox. Exercise its genuine curl installation
      // and the genuine newer formula instead; the release gate separately
      // tests Homebrew-to-Homebrew using the latest stable formula.
      const bin = path.join(root, "curl-bin");
      await mkdir(bin, { recursive: true, mode: 0o700 });
      await run("/bin/bash", [path.join(old.directory, "install.sh"), "--home", runtime, "--bin-dir", bin, "--no-modify-path", "--release-url", pointer(old)], env);
      context = await prepareWorkspace(old, runtime, state, env, path.join(runtime, "bin", "jobctrl"));
    }
    const source = sourceAcquisition === "homebrew" ? await oldFormula(brew, old, env) : null;
    await run(brew, ["tap-new", "--no-git", tap], env); tapCreated = true;
    const repository = (await run(brew, ["--repository", tap], env)).output.trim();
    const formulaPath = path.join(repository, "Formula", "jobctrl.rb");
    if (sourceAcquisition === "homebrew") {
      await writeFile(formulaPath, source, { mode: 0o644 });
      await run(brew, ["install", "--formula", formula], env); installed = true;
      context = await prepareWorkspace(old, runtime, state, env, frontend);
    }
    console.log(`${old.descriptor.appVersion}: upgrading through unmodified Homebrew`);
    await copyFile(path.join(candidate.directory, "jobctrl.rb"), formulaPath);
    await run(brew, [sourceAcquisition === "homebrew" ? "upgrade" : "install", "--formula", formula], env);
    installed = true;
    const forward = selectUpgradeMode(old.manifest, candidate.manifest, context.schema) === "forward-schema-15";
    const checks = [sourceAcquisition === "homebrew" ? "real-formula-upgrade" : "real-formula-install-over-curl-workspace", "real-services", "paired-backup", "job-and-resume-preserved", "temporal-history-preserved", "stop-and-restart"];
    let title = "Preserved acquisition QA job";
    if (forward) {
      const matrix = await runForwardInterruptionMatrix({
        old, candidate, root, runtime, state, env, selector: context.selector, acquisition: "homebrew", readinessFailure: true,
        jobUrl: "https://jobs.example/acquisition-qa",
        payload: path.join(runtime, "releases", candidate.descriptor.buildId, "payload"),
        initial: { executable: frontend, args: ["start", "--no-open"] },
      });
      title = matrix.title;
      checks.push(...matrix.checks);
    } else {
      await run(frontend, ["start", "--no-open"], env);
    }
    context.useCandidate(candidate);
    const expectedSchema = forward ? 15 : context.schema;
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, title);
    await run(context.selector, ["stop"], env);
    await run(frontend, ["start", "--no-open"], env);
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, title);
    return { acquisition: sourceAcquisition === "homebrew" ? "unmodified-homebrew" : "curl-to-unmodified-homebrew", sourceSchema: context.schema, targetSchema: expectedSchema, checks };
  } finally {
    await run(path.join(runtime, "bin", "jobctrl"), ["stop"], env, { allowFailure: true }).catch(() => {});
    if (installed) await run(brew, ["uninstall", "--formula", formula], env, { allowFailure: true });
    if (tapCreated) await run(brew, ["untap", tap], env, { allowFailure: true });
  }
}

// Real installers and Homebrew do not need the metadata API token or the
// runner's action credentials. Keep them out of every child process.
export function acquisitionChildEnvironment(inherited) {
  const env = { ...inherited, PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOMEBREW_NO_AUTO_UPDATE: "1" };
  for (const name of ["JOBCTRL_RELEASE_METADATA_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) delete env[name];
  return env;
}

export async function runPublishedAcquisitionUpgrades({ releaseDirectory, output, publicKeyBase64, keyId, homebrewSource = "homebrew" }) {
  assert.ok(homebrewSource === "homebrew" || homebrewSource === "curl", "invalid Homebrew source acquisition");
  assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
  const raw = Buffer.from(publicKeyBase64 ?? "", "base64"); assert.equal(raw.length, 32);
  assert.match(keyId ?? "", /^[A-Za-z0-9._-]+$/);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const trust = new Map([[keyId, publicKey]]);
  const candidate = await releaseIdentity(releaseDirectory, trust);
  candidate.installer = path.join(releaseDirectory, "jobctrl-installer");
  candidate.archive = path.join(releaseDirectory, `jobctrl-${candidate.descriptor.appVersion}-darwin-arm64.zip`);
  assert.equal(await hash(candidate.installer), candidate.manifest.files.find((file) => file.path === "launcher/jobctrl-installer").sha256);
  assert.equal(await hash(candidate.archive), candidate.descriptor.artifact.sha256);
  await chmod(candidate.installer, 0o700);
  const releases = await fetchPublishedReleases(process.env.JOBCTRL_RELEASE_METADATA_TOKEN);
  const version = selectLatestReleasedVersion(releases, candidate.descriptor.appVersion);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobctrl-acquisition-upgrades-")));
  const env = acquisitionChildEnvironment(process.env);
  const old = await publishedSource(version, root, trust, env);
  assert.ok(old.descriptor.sequence < candidate.descriptor.sequence);
  const started = performance.now();
  const results = [
    await curlScenario(old, candidate, path.join(root, "curl"), env),
    await brewScenario(old, candidate, path.join(root, "homebrew"), env, homebrewSource),
    await curlAlreadyMigratedScenario(old, candidate, path.join(root, "curl-already-migrated"), env),
  ];
  const report = { schemaVersion: 1, status: "passed", sourceBuildId: old.descriptor.buildId, candidateBuildId: candidate.descriptor.buildId, elapsedMs: Math.round(performance.now() - started), results };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    assert.ok(["--release-dir", "--output", "--homebrew-source"].includes(process.argv[index]) && !options.has(process.argv[index]) && process.argv[index + 1], "invalid or duplicate acquisition-upgrade argument");
    options.set(process.argv[index], process.argv[index + 1]);
  }
  await runPublishedAcquisitionUpgrades({ releaseDirectory: options.get("--release-dir"), output: options.get("--output"), publicKeyBase64: process.env.JOBCTRL_RELEASE_PUBLIC_KEY, keyId: process.env.JOBCTRL_RELEASE_KEY_ID, homebrewSource: options.get("--homebrew-source") });
}
