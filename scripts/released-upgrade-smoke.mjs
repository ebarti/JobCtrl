#!/usr/bin/env node

// Run the latest stable release executable and the signed candidate. Only the
// Homebrew download adapter is replaced: its cache is an exact signed release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDescriptorSignature } from "./distribution-homebrew.render.bundle.mjs";

export function selectLatestReleasedVersion(releases, candidateVersion) {
  const previous = releases
    .filter((release) => release.draft === false && release.prerelease === false && release.tag_name !== `v${candidateVersion}`)
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at))[0];
  assert.ok(previous, "no previous published stable release is available for upgrade verification");
  assert.match(previous.tag_name, /^v\d+\.\d+\.\d+$/);
  assert.ok(Number.isFinite(Date.parse(previous.published_at)), "stable release publication date is invalid");
  return previous.tag_name.slice(1);
}
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};

async function command(executable, args, env, { allowFailure = false, onStarted = null } = {}) {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const [result] = await Promise.all([finished, onStarted?.(child, finished)]);
    if (!allowFailure) assert.equal(result.code, 0, `${path.basename(executable)} ${args.join(" ")}: ${output}`);
    return { ...result, output };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await finished.catch(() => {});
    error.message += `\n${output}`;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function releaseFiles(directory, trust) {
  const descriptorRaw = await readFile(path.join(directory, "release-descriptor.json"), "utf8");
  const signatureRaw = await readFile(path.join(directory, "release-descriptor.json.sig"), "utf8");
  const descriptor = verifyReleaseDescriptorSignature({ descriptorRaw, signatureRaw, trust });
  const manifest = await json(path.join(directory, "manifest.json"));
  assert.equal(await hash(path.join(directory, "manifest.json")), descriptor.artifact.manifestSha256);
  const archive = path.join(directory, `jobctrl-${descriptor.appVersion}-darwin-arm64.zip`);
  assert.equal(await hash(archive), descriptor.artifact.sha256);
  const installer = path.join(directory, "jobctrl-installer");
  assert.equal(await hash(installer), manifest.files.find((file) => file.path === "launcher/jobctrl-installer").sha256);
  await chmod(installer, 0o700);
  return { directory, descriptor, manifest, archive, installer };
}

async function releasedVersion(version, cache, trust, env) {
  const directory = path.join(cache, `v${version}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["release-descriptor.json", "release-descriptor.json.sig", "manifest.json", "jobctrl-installer", `jobctrl-${version}-darwin-arm64.zip`]) {
    const file = path.join(directory, name);
    try { await access(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await command("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--retry", "2", "--max-time", "240", `https://github.com/ebarti/JobCtrl/releases/download/v${version}/${name}`, "-o", file], env);
    }
  }
  const release = await releaseFiles(directory, trust);
  assert.equal(release.descriptor.appVersion, version);
  return release;
}

function installArgs(release, runtime, stage = false) {
  return ["--source", "homebrew", ...(stage ? ["--stage-only"] : []), "--home", runtime,
    "--descriptor-url", `https://releases.jobctrl.dev/v1/artifacts/${release.descriptor.buildId}/release-descriptor.json`,
    "--descriptor-file", path.join(release.directory, "release-descriptor.json"),
    "--signature-file", path.join(release.directory, "release-descriptor.json.sig"), "--archive-file", release.archive];
}

async function formulaCache(release, prefix, payload) {
  const root = path.join(prefix, "libexec", "bootstrap");
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [source, destination] of [
    [path.join(release.directory, "release-descriptor.json"), "homebrew-release.json"],
    [path.join(release.directory, "release-descriptor.json.sig"), "homebrew-release.json.sig"],
    [release.archive, "jobctrl-release.zip"],
    [path.join(payload, "launcher", "jobctrl"), "jobctrl"],
    [release.installer, "jobctrl-installer"],
  ]) await copyFile(source, path.join(root, destination));
  await chmod(path.join(root, "jobctrl"), 0o700);
  await chmod(path.join(root, "jobctrl-installer"), 0o700);
  await writeFile(path.join(root, "homebrew-bootstrap.json"), JSON.stringify({ schemaVersion: 1,
    descriptorUrl: `https://releases.jobctrl.dev/v1/artifacts/${release.descriptor.buildId}/release-descriptor.json`,
    descriptor: "homebrew-release.json", signature: "homebrew-release.json.sig", archive: "jobctrl-release.zip",
    buildId: release.descriptor.buildId, descriptorSha256: await hash(path.join(release.directory, "release-descriptor.json")),
  }), { mode: 0o600 });
  return path.join(root, "jobctrl");
}

async function scenario(old, candidate, root) {
  const runtime = path.join(root, "runtime"), state = path.join(root, "state"), home = path.join(root, "home"), prefix = path.join(root, "formula");
  const bin = path.join(root, "bin");
  for (const directory of [root, home, state, bin]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { HOME: home, JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, JOBCTRL_UPGRADE_QA_PREFIX: prefix };
  // The real updater executes a regular non-writable brew adapter. It supplies
  // only the already downloaded signed formula resources, without touching the
  // machine's global Homebrew installation or mutable stable channel.
  await writeFile(path.join(bin, "brew"), '#!/bin/sh\ncase "$1" in\nupgrade) [ "$2" = ebarti/tap/jobctrl ] ;;\n--prefix) printf "%s\\n" "$JOBCTRL_UPGRADE_QA_PREFIX" ;;\n*) exit 64 ;;\nesac\n', { mode: 0o700 });
  const selector = path.join(runtime, "bin", "jobctrl");
  const checked = [];
  try {
    console.log(`${old.descriptor.appVersion}: installing and starting released runtime`);
    await command(old.installer, installArgs(old, runtime), env);
    await command(selector, ["start", "--no-open"], env);
    assert.equal(JSON.parse((await command(selector, ["status", "--json"], env)).output).status, "running");
    const oldPayload = path.join(runtime, "releases", old.descriptor.buildId, "payload");
    const python = path.join(oldPayload, "python", "bin", "python3");
    const temporal = path.join(oldPayload, "temporal", "temporal");
    const workflowId = `jobctrl-upgrade-smoke-${old.descriptor.appVersion}`;
    const temporalCommand = (args) => command(temporal, [...args, "--address", "127.0.0.1:7233", "--disable-config-file", "--disable-config-env"], env);
    await temporalCommand(["workflow", "start", "--workflow-id", workflowId, "--type", "JobCtrlUpgradeSmoke", "--task-queue", "jobctrl-upgrade-unused", "--input", "{}"]);
    await temporalCommand(["workflow", "terminate", "--workflow-id", workflowId, "--reason", "Owned upgrade QA fixture"]);
    const originalHistory = JSON.parse((await temporalCommand(["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
    await command(selector, ["stop"], env);
    const seed = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/upgrade-qa','Preserved released-binary QA job')\"); c.commit(); print(c.execute('PRAGMA user_version').fetchone()[0]); c.close()";
    const oldSchema = Number((await command(python, ["-I", "-B", "-c", seed, path.join(state, "jobctrl.db")], env)).output.trim());
    await command(old.installer, installArgs(candidate, runtime, true), env);
    const payload = path.join(runtime, "releases", candidate.descriptor.buildId, "payload");
    const frontend = await formulaCache(candidate, prefix, payload);
    const assertData = async (expectedSchema) => {
      const query = "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('PRAGMA user_version').fetchone()[0],c.execute(\"SELECT title FROM jobs WHERE url='https://jobs.example/upgrade-qa'\").fetchone()[0]])); c.close()";
      const result = await command(python, ["-I", "-B", "-c", query, path.join(state, "jobctrl.db")], env);
      assert.deepEqual(JSON.parse(result.output), [expectedSchema, "Preserved released-binary QA job"]);
      const history = JSON.parse((await temporalCommand(["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
      assert.equal(history.execution.runId, originalHistory.execution.runId);
      assert.equal(history.status, "WORKFLOW_EXECUTION_STATUS_TERMINATED");
      assert.equal(history.historyLength, originalHistory.historyLength);
      const journal = await json(path.join(runtime, "transition.json"));
      const pair = await json(path.join(state, "backups", journal.backupId, "pair.json"));
      assert.deepEqual(pair.files.map((file) => file.name).sort(), ["jobctrl.db", "temporal.db"]);
      for (const file of pair.files) assert.equal(await hash(path.join(state, "backups", pair.id, file.name)), file.sha256);
    };
    console.log(`${old.descriptor.appVersion}: upgrading the real services`);
    await command(selector, ["update"], env);
    checked.push("latest-stable-updater-successful-promotion");
    assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
    await assertData(14);
    checked.push("update-from-latest-stable-payload", "real-services-ready", "source-job-preserved", "temporal-workflow-history-preserved", "verified-paired-backup");
    const result = { sourceVersion: old.descriptor.appVersion, sourceBuildId: old.descriptor.buildId, sourceArtifactSha256: old.descriptor.artifact.sha256, sourceSchema: oldSchema, targetBuildId: candidate.descriptor.buildId, status: "passed", checks: checked };
    await command(selector, ["rollback", "--to", old.descriptor.buildId], env);
    await assertData(oldSchema);
    assert.equal((await json(path.join(runtime, "active.json"))).selectorBuildId, candidate.descriptor.buildId);
    assert.equal(JSON.parse((await command(frontend, ["version", "--json"], env)).output).buildId, old.descriptor.buildId);
    checked.push("explicit-rollback-to-released-payload", "homebrew-frontend-preserves-rollback");
    await command(frontend, ["update"], env);
    await assertData(14);
    assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
    checked.push("explicit-homebrew-reupdate-after-rollback");
    return result;
  } finally {
    const journal = await json(path.join(runtime, "transition.json")).catch(() => null);
    if (journal && !["promoted", "rolled_back", "failed", "idle"].includes(journal.state)) {
      await command(selector, ["rollback"], env, { allowFailure: true });
    }
    await command(selector, ["stop"], env, { allowFailure: true });
  }
}

export async function runReleasedUpgradeSmoke({ releaseDirectory, cacheDirectory, output, publicKeyBase64, keyId }) {
  const started = performance.now();
  assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
  const raw = Buffer.from(publicKeyBase64 ?? "", "base64"); assert.equal(raw.length, 32);
  assert.match(keyId ?? "", /^[A-Za-z0-9._-]+$/);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const trust = new Map([[keyId, publicKey]]);
  const candidate = await releaseFiles(releaseDirectory, trust);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobctrl-released-upgrades-")));
  const cache = cacheDirectory ?? path.join(root, "cache");
  const response = await fetch("https://api.github.com/repos/ebarti/JobCtrl/releases?per_page=100", { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `cannot resolve the latest stable release: HTTP ${response.status}`);
  const version = selectLatestReleasedVersion(await response.json(), candidate.descriptor.appVersion);
  const old = await releasedVersion(version, cache, trust, { PATH: "/usr/bin:/bin" });
  assert.ok(old.descriptor.sequence < candidate.descriptor.sequence, "upgrade source must precede the signed candidate");
  const result = await scenario(old, candidate, path.join(root, "latest-stable"));
  console.log(`Released JobCtrl ${version} upgrade, rollback and re-upgrade passed`);
  const report = { schemaVersion: 1, status: "passed", candidateBuildId: candidate.descriptor.buildId, acquisitionBoundary: "signed-formula-cache-adapter", executables: "actual-latest-stable-and-signed-candidate", elapsedMs: Math.max(1, Math.round(performance.now() - started)), results: [result] };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = new Map();
  const allowed = new Set(["--release-dir", "--cache", "--output"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    assert.ok(allowed.has(process.argv[index]) && !options.has(process.argv[index]) && process.argv[index + 1], "invalid or duplicate released-upgrade argument");
    options.set(process.argv[index], process.argv[index + 1]);
  }
  await runReleasedUpgradeSmoke({ releaseDirectory: options.get("--release-dir"), cacheDirectory: options.get("--cache"), output: options.get("--output"), publicKeyBase64: process.env.JOBCTRL_RELEASE_PUBLIC_KEY, keyId: process.env.JOBCTRL_RELEASE_KEY_ID });
}
