#!/usr/bin/env node

// Exercise the published acquisition commands on a disposable macOS runner.
// Unlike the pre-publication signed-cache smoke, Homebrew itself is unmodified.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDescriptorSignature } from "./distribution-homebrew.render.bundle.mjs";
import { selectLatestReleasedVersion, selectUpgradeMode } from "./released-upgrade-smoke.mjs";

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
  const temporal = path.join(oldPayload, "temporal", "temporal");
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
  return { selector, python, temporalCommand, workflowId, history, schema };
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
      // A real occupied API port makes readiness fail after activation. No
      // application or installer behavior is replaced or bypassed.
      const blocker = net.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(8766, "127.0.0.1", resolve); });
      let failed;
      try { failed = await run("/bin/bash", upgrade, env, { allowFailure: true }); }
      finally { await new Promise((resolve) => blocker.close(resolve)); }
      assert.ok(Number.isInteger(failed.code) && failed.code !== 0, "the occupied API port must fail signed-candidate readiness");
      const before = await readJson(path.join(runtime, "transition.json"));
      assert.equal(before.state, "candidate_starting", "the real installer must have reached the readiness boundary");
      assert.equal(before.candidate.buildId, candidate.descriptor.buildId);
      await run(selector, ["stop"], env);
      const seed = `import os,sqlite3,sys
app=sqlite3.connect(sys.argv[1]); app.execute("PRAGMA journal_mode=WAL"); app.execute("PRAGMA wal_autocheckpoint=0")
assert app.execute("PRAGMA user_version").fetchone()[0] == 15
app.execute("UPDATE jobs SET title='Acknowledged after failed readiness' WHERE url='https://jobs.example/acquisition-qa'")
app.execute("INSERT INTO candidate_profiles(tenant_id,profile_id,personal_full_name,updated_at) VALUES('local','acquisition-qa','Later synthetic profile','2026-01-01')")
app.execute("INSERT INTO resume_templates(tenant_id,template_id,display_name,created_at,updated_at) VALUES('local','acquisition-qa','Later synthetic resume','2026-01-01','2026-01-01')")
app.commit()
history=sqlite3.connect(sys.argv[2]); history.execute("PRAGMA journal_mode=WAL"); history.execute("PRAGMA wal_autocheckpoint=0")
history.execute("CREATE TABLE jobctrl_acquisition_qa (value TEXT NOT NULL)"); history.execute("INSERT INTO jobctrl_acquisition_qa VALUES ('Later synthetic history')"); history.commit()
os._exit(0)`;
      await run(context.python, ["-I", "-B", "-c", seed, path.join(state, "jobctrl.db"), path.join(state, "temporal.db")], env);
      assert.ok((await stat(path.join(state, "jobctrl.db-wal"))).size > 0);
      assert.ok((await stat(path.join(state, "temporal.db-wal"))).size > 0);
      await run(selector, ["update"], env);
      const after = await readJson(path.join(runtime, "transition.json"));
      assert.equal(after.state, "promoted");
      assert.ok(after.recoveryBackupId && after.recoveryBackupId !== before.backupId);
      const verify = `import json,sqlite3,sys
app=sqlite3.connect(sys.argv[1]); history=sqlite3.connect(sys.argv[2])
print(json.dumps([app.execute("SELECT personal_full_name FROM candidate_profiles WHERE profile_id='acquisition-qa'").fetchone()[0],app.execute("SELECT display_name FROM resume_templates WHERE template_id='acquisition-qa'").fetchone()[0],history.execute("SELECT value FROM jobctrl_acquisition_qa").fetchone()[0]]))`;
      const values = ["Later synthetic profile", "Later synthetic resume", "Later synthetic history"];
      const checkPair = async (app, history) => assert.deepEqual(JSON.parse((await run(context.python, ["-I", "-B", "-c", verify, app, history], env)).output), values);
      await checkPair(path.join(state, "jobctrl.db"), path.join(state, "temporal.db"));
      await checkPair(path.join(state, "backups", after.recoveryBackupId, "jobctrl.db"), path.join(state, "backups", after.recoveryBackupId, "temporal.db"));
      title = "Acknowledged after failed readiness";
      checks.push("real-readiness-failure", "public-forward-recovery", "later-application-and-temporal-wal-preserved");
    } else {
      await run("/bin/bash", upgrade, env);
    }
    const expectedSchema = forward ? 15 : context.schema;
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, title);
    await run(selector, ["stop"], env);
    await run(selector, ["start", "--no-open"], env);
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema, title);
    return { acquisition: "curl", sourceSchema: context.schema, targetSchema: expectedSchema, checks };
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

async function brewScenario(old, candidate, root, baseEnv) {
  const runtime = path.join(root, "runtime"), state = path.join(root, "state"), cache = path.join(root, "brew-cache");
  for (const directory of [state, cache]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...baseEnv, JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_CACHE: cache };
  const brew = "/opt/homebrew/bin/brew";
  const tap = `jobctrl/upgrade-qa-${process.env.GITHUB_RUN_ID ?? process.pid}`;
  const formula = `${tap}/jobctrl`;
  const frontend = "/opt/homebrew/bin/jobctrl";
  let tapCreated = false, installed = false;
  try {
    const source = await oldFormula(brew, old, env);
    await run(brew, ["tap-new", "--no-git", tap], env); tapCreated = true;
    const repository = (await run(brew, ["--repository", tap], env)).output.trim();
    const formulaPath = path.join(repository, "Formula", "jobctrl.rb");
    await writeFile(formulaPath, source, { mode: 0o644 });
    await run(brew, ["install", "--formula", formula], env); installed = true;
    const context = await prepareWorkspace(old, runtime, state, env, frontend);
    console.log(`${old.descriptor.appVersion}: upgrading through unmodified Homebrew`);
    await copyFile(path.join(candidate.directory, "jobctrl.rb"), formulaPath);
    await run(brew, ["upgrade", "--formula", formula], env);
    await run(frontend, ["start", "--no-open"], env);
    const expectedSchema = selectUpgradeMode(old.manifest, candidate.manifest, context.schema) === "forward-schema-15" ? 15 : context.schema;
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema);
    await run(context.selector, ["stop"], env);
    await run(frontend, ["start", "--no-open"], env);
    await verifyWorkspace(context, candidate, runtime, state, env, expectedSchema);
    return { acquisition: "unmodified-homebrew", sourceSchema: context.schema, targetSchema: expectedSchema, checks: ["real-formula-upgrade", "real-services", "paired-backup", "job-and-resume-preserved", "temporal-history-preserved", "stop-and-restart"] };
  } finally {
    await run(path.join(runtime, "bin", "jobctrl"), ["stop"], env, { allowFailure: true }).catch(() => {});
    if (installed) await run(brew, ["uninstall", "--formula", formula], env, { allowFailure: true });
    if (tapCreated) await run(brew, ["untap", tap], env, { allowFailure: true });
  }
}

export async function runPublishedAcquisitionUpgrades({ releaseDirectory, output, publicKeyBase64, keyId }) {
  assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
  const raw = Buffer.from(publicKeyBase64 ?? "", "base64"); assert.equal(raw.length, 32);
  assert.match(keyId ?? "", /^[A-Za-z0-9._-]+$/);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const trust = new Map([[keyId, publicKey]]);
  const candidate = await releaseIdentity(releaseDirectory, trust);
  const response = await fetch("https://api.github.com/repos/ebarti/JobCtrl/releases?per_page=100", { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `cannot resolve the latest stable release: HTTP ${response.status}`);
  const version = selectLatestReleasedVersion(await response.json(), candidate.descriptor.appVersion);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobctrl-acquisition-upgrades-")));
  const env = { ...process.env, PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOMEBREW_NO_AUTO_UPDATE: "1" };
  const old = await publishedSource(version, root, trust, env);
  assert.ok(old.descriptor.sequence < candidate.descriptor.sequence);
  const started = performance.now();
  const results = [await curlScenario(old, candidate, path.join(root, "curl"), env), await brewScenario(old, candidate, path.join(root, "homebrew"), env)];
  const report = { schemaVersion: 1, status: "passed", sourceBuildId: old.descriptor.buildId, candidateBuildId: candidate.descriptor.buildId, elapsedMs: Math.round(performance.now() - started), results };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    assert.ok(["--release-dir", "--output"].includes(process.argv[index]) && !options.has(process.argv[index]) && process.argv[index + 1], "invalid or duplicate acquisition-upgrade argument");
    options.set(process.argv[index], process.argv[index + 1]);
  }
  await runPublishedAcquisitionUpgrades({ releaseDirectory: options.get("--release-dir"), output: options.get("--output"), publicKeyBase64: process.env.JOBCTRL_RELEASE_PUBLIC_KEY, keyId: process.env.JOBCTRL_RELEASE_KEY_ID });
}
