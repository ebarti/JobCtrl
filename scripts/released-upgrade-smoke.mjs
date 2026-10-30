#!/usr/bin/env node

// Run the latest stable release executable and the signed candidate. Only the
// Homebrew download adapter is replaced: its cache is an exact signed release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDescriptorSignature } from "./distribution-homebrew.render.bundle.mjs";

export function selectLatestReleasedVersion(releases, candidateVersion) {
  const previous = releases
    .filter((release) => release.draft === false && release.prerelease === false && release.tag_name !== `v${candidateVersion}`)
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at))[0];
  assert.ok(previous, "no previous published stable release is available for upgrade verification");
  const tag = previous.tag_name;
  if (typeof tag !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) || tag.trim() !== tag) {
    throw new Error("stable release tag must be v<major>.<minor>.<patch>");
  }
  assert.ok(Number.isFinite(Date.parse(previous.published_at)), "stable release publication date is invalid");
  return tag.slice(1);
}
// A read-only workflow token avoids GitHub's shared-IP rate limit. The
// destination is fixed and redirects are refused so credentials cannot follow
// an unexpected response to another host.
export async function fetchPublishedReleases(token, fetcher = fetch) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher("https://api.github.com/repos/ebarti/JobCtrl/releases?per_page=100", {
    headers, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `cannot resolve the latest stable release: HTTP ${response.status}`);
  return response.json();
}

// Only explicitly supported transitions may change the release test's contract.
// An unknown protocol/schema combination must fail qualification, not silently
// be treated as a same-schema upgrade.
export function selectUpgradeMode(oldManifest, targetManifest, sourceSchema) {
  const source = oldManifest.launcherCompatibility;
  const target = targetManifest.launcherCompatibility;
  for (const range of [source, target]) {
    assert.ok(range && Number.isSafeInteger(range.minimum) && Number.isSafeInteger(range.maximum)
      && range.minimum > 0 && range.maximum >= range.minimum, "invalid launcher compatibility range");
  }
  assert.ok(Number.isSafeInteger(sourceSchema) && sourceSchema > 0, "invalid source schema");
  if (source.minimum === 1 && source.maximum === 1 && target.minimum === 2 && target.maximum === 2 && sourceSchema === 14) {
    return "forward-schema-15";
  }
  if (source.minimum === source.maximum && target.minimum <= source.minimum && source.minimum <= target.maximum) return "compatible";
  throw new Error(`unsupported released upgrade: launcher ${source.minimum}-${source.maximum} to ${target.minimum}-${target.maximum}, schema ${sourceSchema}`);
}

async function assertSchema15Declaration(manifest, payload) {
  const entries = manifest.files.filter((file) => file.path === "launcher/schema-transition.json");
  assert.equal(entries.length, 1, "signed inventory must bind exactly one schema transition declaration");
  assert.equal(entries[0].type, "file");
  const declaration = path.join(payload, "launcher", "schema-transition.json");
  assert.equal(await hash(declaration), entries[0].sha256, "schema transition declaration differs from signed inventory");
  assert.deepEqual(await json(declaration), { schemaVersion: 1, sourceUserVersion: 14, targetUserVersion: 15 });
}

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};

// This is a release-specific limitation, not a new definition of a successful
// upgrade. All other version pairs retain the positive upgrade qualification.
export function isKnownLegacyRefusal(old, candidate, mode) {
  return old.descriptor.appVersion === "0.3.1" && candidate.descriptor.appVersion === "0.4.0" && mode === "forward-schema-15";
}

// Capture the stopped synthetic workspace and its authenticated selection.
// The proof intentionally includes the legacy registry: it must not be
// rewritten to fabricate ownership when the migration is refused.
export async function legacyRefusalSnapshot({ root, runtime, state, history, external = [] }) {
  const temp = await realpath(os.tmpdir());
  const fixture = await realpath(root);
  const runtimeReal = await realpath(runtime);
  const stateReal = await realpath(state);
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.ok(inside(temp, fixture) && inside(fixture, runtimeReal) && inside(fixture, stateReal), "legacy refusal proof requires an isolated temporary workspace");
  assert.ok(inside(stateReal, await realpath(history)), "history must belong to the fixture workspace");
  for (const file of external) assert.ok(inside(stateReal, await realpath(file)), "external fixture must belong to the workspace");
  const instance = createHash("sha256").update(stateReal).digest("hex");
  const app = path.join(stateReal, "jobctrl.db");
  const active = path.join(runtimeReal, "active.json"), selector = path.join(runtimeReal, "bin", "jobctrl");
  const registry = path.join(runtimeReal, "instances", instance, "state.json");
  const paths = [app, history, ...[app, history].flatMap((file) => ["-wal", "-shm", "-journal"].map((suffix) => `${file}${suffix}`)),
    ...external, active, path.join(runtimeReal, "current.json"), path.join(runtimeReal, "transition.json"), selector, registry];
  const files = {};
  for (const file of paths) {
    try {
      const info = await lstat(file);
      assert.ok(info.isFile() && !info.isSymbolicLink(), `fixture path is not a regular file: ${file}`);
      files[file] = { sha256: await hash(file), ino: info.ino };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      files[file] = null;
    }
  }
  assert.ok(files[app] && files[history] && files[active] && files[selector] && files[registry], "legacy refusal fixture must have its database pair, active selection, and registry");
  const backups = await readdir(path.join(stateReal, "backups")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  return { files, backups: backups.sort() };
}

export async function verifyLegacyRefusal({ root, runtime, state, history, external = [], invoke }) {
  const before = await legacyRefusalSnapshot({ root, runtime, state, history, external });
  const result = await invoke();
  assert.ok(Number.isInteger(result.code) && result.code !== 0, "legacy upgrade must explicitly refuse admission");
  assert.match(result.output, /legacy runtime has no durable child-ownership record/i, "refusal must identify the actual ownership problem");
  assert.deepEqual(await legacyRefusalSnapshot({ root, runtime, state, history, external }), before, "refusal must preserve the data pair, registry, selector, journal, and backup inventory");
  return result;
}

async function command(executable, args, env, { allowFailure = false, onStarted = null, processGroup = false } = {}) {
  const child = spawn(executable, args, { env, detached: processGroup, stdio: ["ignore", "pipe", "pipe"] });
  const signal = (name) => {
    try { if (processGroup) process.kill(-child.pid, name); else child.kill(name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const timer = setTimeout(() => signal("SIGKILL"), 300_000);
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const [result] = await Promise.all([finished, onStarted?.(child, finished)]);
    if (!allowFailure) assert.equal(result.code, 0, `${path.basename(executable)} ${args.join(" ")}: ${output}`);
    return { ...result, output };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
    await finished.catch(() => {});
    error.message += `\n${output}`;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Interrupt only the child process group created by command(). The checkpoint
// is emitted after the signed controller synced its journal, and the caller
// separately verifies the retained journal and selection.
export async function interruptReleaseAtCheckpoint(executable, args, env, boundary) {
  let seen = false;
  const result = await command(executable, args, env, {
    allowFailure: true,
    processGroup: true,
    onStarted: async (child, finished) => {
      await new Promise((resolve, reject) => {
        let output = "";
        let settled = false;
        const marker = `jobctrl-release-qa-checkpoint:${boundary}\n`;
        const timer = setTimeout(() => finish(new Error(`did not reach signed checkpoint ${boundary}`)), 180_000);
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stderr.off("data", onData);
          error ? reject(error) : resolve();
        };
        const onData = (chunk) => {
          output += chunk;
          if (!output.includes(marker)) return;
          seen = true;
          try { process.kill(-child.pid, "SIGKILL"); finish(); }
          catch (error) { finish(error); }
        };
        child.stderr.on("data", onData);
        finished.then(() => { if (!seen) finish(new Error(`signed command exited before ${boundary}`)); }, finish);
      });
    },
  });
  assert.ok(seen && result.signal === "SIGKILL", `signed command was not interrupted at ${boundary}`);
  return result;
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

export function installArgs(release, runtime, stage = false, source = "homebrew") {
  return ["--source", source, ...(stage ? ["--stage-only"] : []), "--home", runtime,
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

// Run the same signed-controller interruption matrix after either a real
// acquisition entry or the pre-publication signed-cache adapter.
export async function runForwardInterruptionMatrix({ old, candidate, root, runtime, state, env, selector, payload, initial = null, acquisition = "homebrew", jobUrl = "https://jobs.example/upgrade-qa", historyPath = path.join(state, "temporal.db"), readinessFailure = false, checked = [] }) {
  const temp = await realpath(os.tmpdir());
  const fixture = await realpath(root);
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.ok(within(temp, fixture), "release QA root must be inside the system temporary directory");
  const runtimeReal = await realpath(runtime), stateReal = await realpath(state);
  assert.ok(within(fixture, runtimeReal) && within(fixture, stateReal), "release QA runtime and workspace must belong to the fixture");
  assert.equal(await realpath(env.JOBCTRL_RUNTIME_HOME), runtimeReal, "release command must use the fixture runtime");
  assert.equal(await realpath(env.JOBCTRL_DIR), stateReal, "release command must use the fixture workspace");
  assert.equal(path.resolve(selector), path.join(path.resolve(runtime), "bin", "jobctrl"));
  assert.equal(path.resolve(payload), path.join(path.resolve(runtime), "releases", candidate.descriptor.buildId, "payload"));
  assert.ok(within(stateReal, await realpath(historyPath)), "release QA history must belong to the fixture workspace");
  const assertPair = async (id) => {
    assert.ok(id, "transition must record its paired backup");
    const pair = await json(path.join(state, "backups", id, "pair.json"));
    assert.equal(pair.id, id);
    assert.deepEqual(pair.files.map((file) => file.name).sort(), ["jobctrl.db", "temporal.db"]);
    for (const file of pair.files) assert.equal(await hash(path.join(state, "backups", id, file.name)), file.sha256);
  };
  const inode = (await stat(path.join(state, "jobctrl.db"))).ino;
  const historyInode = (await stat(historyPath)).ino;
  await writeFile(path.join(root, ".jobctrl-release-qa"), "jobctrl-release-qa-v1\n", { mode: 0o600 });
  // The old release is historical evidence once the target is staged. Use
  // the candidate's own bundled runtimes for all subsequent fixture writes.
  const python = path.join(payload, "python", "bin", "python3");
  const checkpoints = ["metadata_verified", "pair_backed_up", "selector_handoff_pending", "selector_replaced", "migration_candidate_ready", "migration_activated", "candidate_starting", "candidate_healthy", "policy_finalized"];
  const interrupt = async (boundary, installer) => {
    const entry = boundary === "metadata_verified" && initial ? initial : {
      executable: installer ? candidate.installer : selector,
      args: installer ? installArgs(candidate, runtime, false, acquisition) : ["update"],
    };
    await interruptReleaseAtCheckpoint(entry.executable, entry.args, {
      ...env, TMPDIR: os.tmpdir(), JOBCTRL_RELEASE_QA_ROOT: root, JOBCTRL_RELEASE_QA_PAUSE: boundary,
    }, boundary);
    return json(path.join(runtime, "transition.json"));
  };
  const writeLater = `import json,os,sqlite3,sys
n=sys.argv[3]
app=sqlite3.connect(sys.argv[1]); app.execute("PRAGMA journal_mode=WAL"); app.execute("PRAGMA wal_autocheckpoint=0")
app.execute("UPDATE jobs SET title=? WHERE url=?",('later-job-'+n,sys.argv[4]))
app.execute("INSERT INTO candidate_profiles(tenant_id,profile_id,personal_full_name,updated_at) VALUES('local','upgrade-qa',?,'2026-01-01') ON CONFLICT(tenant_id,profile_id) DO UPDATE SET personal_full_name=excluded.personal_full_name",('later-profile-'+n,))
app.execute("INSERT INTO resume_templates(tenant_id,template_id,display_name,created_at,updated_at) VALUES('local','upgrade-qa',?,'2026-01-01','2026-01-01') ON CONFLICT(tenant_id,template_id) DO UPDATE SET display_name=excluded.display_name",('later-resume-'+n,))
app.execute("INSERT INTO discovery_settings(tenant_id,search_config_json,created_at,updated_at) VALUES('local',?,'2026-01-01','2026-01-01') ON CONFLICT(tenant_id) DO UPDATE SET search_config_json=excluded.search_config_json",(json.dumps({'search':'later-search-'+n},separators=(',',':')),)); app.commit()
history=sqlite3.connect(sys.argv[2]); history.execute("PRAGMA journal_mode=WAL"); history.execute("PRAGMA wal_autocheckpoint=0")
history.execute("CREATE TABLE IF NOT EXISTS jobctrl_upgrade_qa (value TEXT NOT NULL)"); history.execute("DELETE FROM jobctrl_upgrade_qa"); history.execute("INSERT INTO jobctrl_upgrade_qa VALUES (?)",('later-history-'+n,)); history.commit()
os._exit(0)`;
  const verifyLater = `import json,sqlite3,sys
app=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); history=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
print(json.dumps([app.execute("SELECT title FROM jobs WHERE url=?",(sys.argv[3],)).fetchone()[0],app.execute("SELECT personal_full_name FROM candidate_profiles WHERE profile_id='upgrade-qa'").fetchone()[0],app.execute("SELECT display_name FROM resume_templates WHERE template_id='upgrade-qa'").fetchone()[0],app.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='local'").fetchone()[0],history.execute("SELECT value FROM jobctrl_upgrade_qa").fetchone()[0]]))`;
  const verifyPair = async (app, history, n) => {
    const actual = JSON.parse((await command(python, ["-I", "-B", "-c", verifyLater, app, history, jobUrl], env)).output);
    assert.deepEqual(actual, ["job", "profile", "resume"].map((name) => `later-${name}-${n}`).concat(JSON.stringify({ search: `later-search-${n}` }), `later-history-${n}`));
  };
  const app = path.join(state, "jobctrl.db"), history = historyPath;
  const external = path.join(state, "upgrade-qa-external-resume.txt");
  let previous = null;
  for (let index = 0; index < checkpoints.length; index++) {
    const boundary = checkpoints[index];
    if (boundary === "candidate_healthy" && readinessFailure) {
      const blocker = net.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(8766, "127.0.0.1", resolve); });
      let failed;
      try { failed = await command(selector, ["update"], env, { allowFailure: true }); }
      finally { await new Promise((resolve) => blocker.close(resolve)); }
      assert.ok(Number.isInteger(failed.code) && failed.code !== 0, "occupied API port must fail real candidate readiness");
      const failedJournal = await json(path.join(runtime, "transition.json"));
      assert.equal(failedJournal.state, "candidate_starting");
      assert.equal(failedJournal.candidate.buildId, candidate.descriptor.buildId);
      await command(selector, ["stop"], env);
      await verifyPair(app, history, previous);
      previous = `${previous}-after-failed-readiness`;
      await command(python, ["-I", "-B", "-c", writeLater, app, history, previous, jobUrl], env);
      assert.ok((await stat(`${app}-wal`)).size > 32 && (await stat(`${history}-wal`)).size > 32);
      await writeFile(external, `later-external-resume-${previous}\n`, { mode: 0o600 });
      checked.push("real-readiness-failure-preserves-later-wal-through-forward-recovery");
    }
    console.log(`${old.descriptor.appVersion}: interrupting signed controller at ${boundary}`);
    const journal = await interrupt(boundary, index <= 3);
    assert.equal(journal.state, boundary, "the interrupted journal must remain at the observed durable boundary");
    if (index < 3) {
      const priorJournal = await readFile(path.join(runtime, "transition.json"));
      const priorActive = await readFile(path.join(runtime, "active.json"));
      const rejectedRecovery = await command(selector, ["update"], env, { allowFailure: true });
      assert.ok(Number.isInteger(rejectedRecovery.code) && rejectedRecovery.code !== 0);
      assert.match(rejectedRecovery.output, /transition journal/i);
      assert.deepEqual(await readFile(path.join(runtime, "transition.json")), priorJournal);
      assert.deepEqual(await readFile(path.join(runtime, "active.json")), priorActive);
    } else if (boundary === "candidate_healthy") {
      // Model a newly recorded revocation in this disposable policy store.
      // The candidate is already running; cleanup must not execute it again.
      const policyPath = path.join(runtime, `channel-${candidate.descriptor.channel}.json`);
      const originalPolicy = await readFile(policyPath);
      const policy = JSON.parse(originalPolicy);
      policy.revokedBuildIds[candidate.descriptor.buildId] = true;
      await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
      const priorJournal = await readFile(path.join(runtime, "transition.json"));
      const priorActive = await readFile(path.join(runtime, "active.json"));
      const beforeHolders = await command("/usr/sbin/lsof", ["-nP", "-Fp", history], env, { allowFailure: true });
      assert.match(beforeHolders.output, /^p[0-9]+$/m, "the running candidate must own the synthetic history");
      const rejectedStart = await command(selector, ["start", "--no-open"], env, { allowFailure: true });
      assert.ok(Number.isInteger(rejectedStart.code) && rejectedStart.code !== 0);
      const rejectedUpdate = await command(selector, ["update"], env, { allowFailure: true });
      assert.ok(Number.isInteger(rejectedUpdate.code) && rejectedUpdate.code !== 0);
      assert.match(rejectedUpdate.output, /revok/i);
      await command(selector, ["stop"], env);
      assert.deepEqual(await readFile(path.join(runtime, "transition.json")), priorJournal);
      assert.deepEqual(await readFile(path.join(runtime, "active.json")), priorActive);
      const afterHolders = await command("/usr/sbin/lsof", ["-nP", "-Fp", history], env, { allowFailure: true });
      assert.doesNotMatch(afterHolders.output, /^p[0-9]+$/m, "revoked-candidate cleanup must stop its owned history writer");
      // Restore the exact prior synthetic policy solely to continue the
      // separate interruption matrix; a real revocation is never undone.
      await writeFile(policyPath, originalPolicy, { mode: 0o600 });
      checked.push("modeled-revoked-candidate-refuses-start-and-update", "revoked-candidate-cleanup-stops-owned-history-writer-without-changing-transition");
    } else {
      await command(selector, ["stop"], env);
    }
    if (boundary === "selector_replaced") {
      // The original controller is no longer used. A previously recorded
      // predecessor revocation must not prevent forward recovery.
      const policyPath = path.join(runtime, `channel-${candidate.descriptor.channel}.json`);
      const policy = await json(policyPath);
      policy.revokedBuildIds[old.descriptor.buildId] = true;
      await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
      checked.push("modeled-revoked-predecessor-remains-historical-evidence");
    }
    if (previous !== null) {
      const backupId = journal.recoveryBackupId || journal.backupId;
      await assertPair(backupId);
      const pair = path.join(state, "backups", backupId);
      await verifyPair(app, history, previous);
      await verifyPair(path.join(pair, "jobctrl.db"), path.join(pair, "temporal.db"), previous);
      assert.equal(await readFile(external, "utf8"), `later-external-resume-${previous}\n`);
    }
    await command(python, ["-I", "-B", "-c", writeLater, app, history, String(index), jobUrl], env);
    assert.ok((await stat(`${app}-wal`)).size > 32);
    assert.ok((await stat(`${history}-wal`)).size > 32);
    await writeFile(external, `later-external-resume-${index}\n`, { mode: 0o600 });
    previous = String(index);
  }
  console.log(`${old.descriptor.appVersion}: interrupting after the active selection is committed`);
  const selectionJournal = await interrupt("selection_committed", false);
  assert.equal(selectionJournal.state, "policy_finalized");
  assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
  const health = async () => {
    const response = await fetch("http://127.0.0.1:8766/v1/health", { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const beforeRecovery = await health();
  assert.equal(beforeRecovery.worker.status, "healthy");
  const workerPid = beforeRecovery.worker.heartbeat.pid;
  assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
  console.log(`${old.descriptor.appVersion}: resuming the signed forward upgrade after every durable boundary`);
  await command(selector, ["update"], env);
  const afterRecovery = await health();
  assert.equal(afterRecovery.worker.status, "healthy");
  assert.equal(afterRecovery.worker.heartbeat.pid, workerPid, "selection finalization must not restart a healthy candidate");
  const journal = await json(path.join(runtime, "transition.json"));
  assert.equal(journal.state, "promoted");
  assert.notEqual(journal.recoveryBackupId, journal.backupId);
  await assertPair(journal.recoveryBackupId);
  const last = checkpoints.length - 1;
  const pair = path.join(state, "backups", journal.recoveryBackupId);
  await verifyPair(app, history, last);
  await verifyPair(path.join(pair, "jobctrl.db"), path.join(pair, "temporal.db"), last);
  assert.equal(await readFile(external, "utf8"), `later-external-resume-${last}\n`);
  assert.equal((await stat(app)).ino, inode);
  assert.equal((await stat(history)).ino, historyInode, "the selected Temporal history must remain in place");
  assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
  assert.equal(JSON.parse((await command(selector, ["status", "--json"], env)).output).status, "running");
  const selectedBeforeRollback = await readFile(path.join(runtime, "active.json"));
  const journalBeforeRollback = await readFile(path.join(runtime, "transition.json"));
  const policyPath = path.join(runtime, `channel-${candidate.descriptor.channel}.json`);
  const modeledPolicy = await readFile(policyPath);
  const rollbackPolicy = JSON.parse(modeledPolicy);
  assert.equal(rollbackPolicy.revokedBuildIds[old.descriptor.buildId], true);
  // Test the protocol fence independently of the modeled revocation fence.
  delete rollbackPolicy.revokedBuildIds[old.descriptor.buildId];
  await writeFile(policyPath, `${JSON.stringify(rollbackPolicy)}\n`, { mode: 0o600 });
  try {
    const rollback = await command(selector, ["rollback", "--to", old.descriptor.buildId], env, { allowFailure: true });
    assert.ok(Number.isInteger(rollback.code) && rollback.code !== 0, "cross-protocol rollback must be refused");
    assert.match(rollback.output, historyPath === path.join(state, "temporal.db") ? /protocol/i : /legacy source Temporal history/i);
    assert.deepEqual(await readFile(path.join(runtime, "active.json")), selectedBeforeRollback);
    assert.deepEqual(await readFile(path.join(runtime, "transition.json")), journalBeforeRollback);
    await verifyPair(app, history, last);
  } finally {
    await writeFile(policyPath, modeledPolicy, { mode: 0o600 });
  }
  if (historyPath === path.join(state, "temporal.db")) {
    checked.push("cross-protocol-rollback-refused-without-data-mutation");
  } else {
    checked.push("legacy-history-rollback-refused-without-data-mutation", "legacy-temporal-history-path-and-inode-preserved");
  }
  checked.push("signed-installer-and-public-selector-interrupted-at-all-nine-durable-boundaries", "archived-controller-preserves-every-pre-handoff-journal", "fresh-paired-backup-preserves-every-later-app-and-temporal-wal", "profile-resume-search-and-external-file-preserved", "database-inode-preserved", "source-job-preserved", "real-services-ready", "selection-finalized-without-restarting-healthy-candidate");
  return { last, title: `later-job-${last}`, checks: checked };
}

export async function scenario(old, candidate, root) {
  const runtime = path.join(root, "runtime"), state = path.join(root, "state"), home = path.join(root, "home"), prefix = path.join(root, "formula");
  const bin = path.join(root, "bin");
  for (const directory of [root, home, state, bin]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { HOME: home, TMPDIR: os.tmpdir(), JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, JOBCTRL_UPGRADE_QA_PREFIX: prefix };
  // The real updater executes a regular non-writable brew adapter. It supplies
  // only the already downloaded signed formula resources, without touching the
  // machine's global Homebrew installation or mutable stable channel.
  await writeFile(path.join(bin, "brew"), '#!/bin/sh\ncase "$1" in\nupgrade) [ "$2" = ebarti/tap/jobctrl ] ;;\n--prefix) printf "%s\\n" "$JOBCTRL_UPGRADE_QA_PREFIX" ;;\n*) exit 64 ;;\nesac\n', { mode: 0o700 });
  const selector = path.join(runtime, "bin", "jobctrl");
  const checked = [];
  let scenarioFailed = false;
  let scenarioError;
  try {
    console.log(`${old.descriptor.appVersion}: installing and starting released runtime`);
    await command(old.installer, installArgs(old, runtime), env);
    await command(selector, ["start", "--no-open"], env);
    assert.equal(JSON.parse((await command(selector, ["status", "--json"], env)).output).status, "running");
    const oldPayload = path.join(runtime, "releases", old.descriptor.buildId, "payload");
    let python = path.join(oldPayload, "python", "bin", "python3");
    let temporal = path.join(oldPayload, "temporal", "temporal");
    const workflowId = `jobctrl-upgrade-smoke-${old.descriptor.appVersion}`;
    const temporalCommand = (args) => command(temporal, [...args, "--address", "127.0.0.1:7233", "--disable-config-file", "--disable-config-env"], env);
    await temporalCommand(["workflow", "start", "--workflow-id", workflowId, "--type", "JobCtrlUpgradeSmoke", "--task-queue", "jobctrl-upgrade-unused", "--input", "{}"]);
    await temporalCommand(["workflow", "terminate", "--workflow-id", workflowId, "--reason", "Owned upgrade QA fixture"]);
    const originalHistory = JSON.parse((await temporalCommand(["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
    await command(selector, ["stop"], env);
    const seed = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/upgrade-qa','Preserved released-binary QA job')\"); c.commit(); print(c.execute('PRAGMA user_version').fetchone()[0]); c.close()";
    const oldSchema = Number((await command(python, ["-I", "-B", "-c", seed, path.join(state, "jobctrl.db")], env)).output.trim());
    const mode = selectUpgradeMode(old.manifest, candidate.manifest, oldSchema);
    // For protocol 2, the target installer owns acquisition and activation;
    // the archived protocol-1 installer cannot act as its recovery controller.
    await command(mode === "forward-schema-15" ? candidate.installer : old.installer, installArgs(candidate, runtime, true), env);
    const payload = path.join(runtime, "releases", candidate.descriptor.buildId, "payload");
    const frontend = await formulaCache(candidate, prefix, payload);
    const readBytesOrMissing = async (file) => {
      try { return await readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    };
    const backupNames = async () => {
      try { return (await readdir(path.join(state, "backups"))).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    };
    const assertPair = async (id) => {
      assert.ok(id, "transition must record its paired backup");
      const pair = await json(path.join(state, "backups", id, "pair.json"));
      assert.equal(pair.id, id);
      assert.deepEqual(pair.files.map((file) => file.name).sort(), ["jobctrl.db", "temporal.db"]);
      for (const file of pair.files) assert.equal(await hash(path.join(state, "backups", id, file.name)), file.sha256);
      return pair;
    };
    const assertData = async (expectedSchema, expectedTitle = "Preserved released-binary QA job") => {
      const query = "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('PRAGMA user_version').fetchone()[0],c.execute(\"SELECT title FROM jobs WHERE url='https://jobs.example/upgrade-qa'\").fetchone()[0]])); c.close()";
      const result = await command(python, ["-I", "-B", "-c", query, path.join(state, "jobctrl.db")], env);
      assert.deepEqual(JSON.parse(result.output), [expectedSchema, expectedTitle]);
      const history = JSON.parse((await temporalCommand(["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
      assert.equal(history.execution.runId, originalHistory.execution.runId);
      assert.equal(history.status, "WORKFLOW_EXECUTION_STATUS_TERMINATED");
      assert.equal(history.historyLength, originalHistory.historyLength);
      const journal = await json(path.join(runtime, "transition.json"));
      await assertPair(journal.backupId);
    };
    const result = { sourceVersion: old.descriptor.appVersion, sourceBuildId: old.descriptor.buildId, sourceArtifactSha256: old.descriptor.artifact.sha256, sourceSchema: oldSchema, targetBuildId: candidate.descriptor.buildId, mode, status: "passed", checks: checked };

    if (mode === "forward-schema-15") {
      await assertSchema15Declaration(candidate.manifest, payload);
      const activeBefore = await readFile(path.join(runtime, "active.json"));
      const journalBefore = await readBytesOrMissing(path.join(runtime, "transition.json"));
      const backupsBefore = await backupNames();
      const appHash = await hash(path.join(state, "jobctrl.db"));
      const temporalHash = await hash(path.join(state, "temporal.db"));
      console.log(`${old.descriptor.appVersion}: verifying archived controller refuses protocol-2 promotion`);
      const rejected = await command(selector, ["update"], env, { allowFailure: true });
      assert.ok(Number.isInteger(rejected.code) && rejected.code !== 0, "archived protocol-1 update must exit with a refusal");
      assert.match(rejected.output, /protocol/i, "archived controller must reject the incompatible protocol");
      assert.deepEqual(await readFile(path.join(runtime, "active.json")), activeBefore);
      assert.deepEqual(await readBytesOrMissing(path.join(runtime, "transition.json")), journalBefore);
      assert.deepEqual(await backupNames(), backupsBefore);
      assert.equal(await hash(path.join(state, "jobctrl.db")), appHash);
      assert.equal(await hash(path.join(state, "temporal.db")), temporalHash);
      checked.push("archived-controller-refuses-before-backup-and-journal", "signed-schema-14-to-15-contract");

      if (isKnownLegacyRefusal(old, candidate, mode)) {
        console.log(`${old.descriptor.appVersion}: verifying the documented legacy ownership refusal`);
        await verifyLegacyRefusal({ root, runtime, state, history: path.join(state, "temporal.db"),
          invoke: () => command(candidate.installer, installArgs(candidate, runtime), env, { allowFailure: true }) });
        await verifyLegacyRefusal({ root, runtime, state, history: path.join(state, "temporal.db"),
          invoke: () => command(frontend, ["start", "--no-open"], env, { allowFailure: true }) });
        assert.equal(JSON.parse((await command(selector, ["version", "--json"], env)).output).buildId, old.descriptor.buildId);
        await command(selector, ["start", "--no-open"], env);
        assert.equal(JSON.parse((await command(selector, ["status", "--json"], env)).output).status, "running");
        const query = "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('PRAGMA user_version').fetchone()[0],c.execute(\"SELECT title FROM jobs WHERE url='https://jobs.example/upgrade-qa'\").fetchone()[0]])); c.close()";
        assert.deepEqual(JSON.parse((await command(python, ["-I", "-B", "-c", query, path.join(state, "jobctrl.db")], env)).output), [14, "Preserved released-binary QA job"]);
        const history = JSON.parse((await temporalCommand(["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
        assert.equal(history.execution.runId, originalHistory.execution.runId);
        assert.equal(history.historyLength, originalHistory.historyLength);
        await command(selector, ["stop"], env);
        result.mode = "legacy-ownership-refused";
        result.status = "expected-refusal";
        checked.push("legacy-ownership-refusal", "signed-homebrew-frontend-refuses-legacy-ownership", "data-registry-selector-and-journal-preserved", "released-predecessor-restarts-in-controlled-fixture", "job-and-temporal-history-preserved");
        return result;
      }

      python = path.join(payload, "python", "bin", "python3");
      temporal = path.join(payload, "temporal", "temporal");
      const { last } = await runForwardInterruptionMatrix({ old, candidate, root, runtime, state, env, selector, payload, checked });
      await assertData(15, `later-job-${last}`);
      await command(selector, ["stop"], env);
      await command(selector, ["start", "--no-open"], env);
      await assertData(15, `later-job-${last}`);
      checked.push("real-stop-and-restart");
    } else {
      console.log(`${old.descriptor.appVersion}: upgrading the real services`);
      await command(selector, ["update"], env);
      checked.push("latest-stable-updater-successful-promotion");
      assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
      await assertData(oldSchema);
      checked.push("update-from-latest-stable-payload", "real-services-ready", "source-job-preserved", "temporal-workflow-history-preserved", "verified-paired-backup");
      await command(selector, ["rollback", "--to", old.descriptor.buildId], env);
      await assertData(oldSchema);
      assert.equal((await json(path.join(runtime, "active.json"))).selectorBuildId, candidate.descriptor.buildId);
      assert.equal(JSON.parse((await command(frontend, ["version", "--json"], env)).output).buildId, old.descriptor.buildId);
      checked.push("explicit-rollback-to-released-payload", "homebrew-frontend-preserves-rollback");
      await command(frontend, ["update"], env);
      await assertData(oldSchema);
      assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
      checked.push("explicit-homebrew-reupdate-after-rollback");
    }
    return result;
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
    throw error;
  } finally {
    try {
      await command(selector, ["stop"], env, { allowFailure: true });
    } catch (cleanupError) {
      if (!scenarioFailed) throw cleanupError;
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (scenarioError instanceof Error) {
        scenarioError.message += `\nAdditionally, cleanup failed: ${cleanupMessage}`;
      } else {
        throw new AggregateError([scenarioError, cleanupError], `Upgrade qualification and cleanup failed: ${String(scenarioError)}`);
      }
    }
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
  const releases = await fetchPublishedReleases(process.env.JOBCTRL_RELEASE_METADATA_TOKEN);
  const version = selectLatestReleasedVersion(releases, candidate.descriptor.appVersion);
  const old = await releasedVersion(version, cache, trust, { PATH: "/usr/bin:/bin" });
  assert.ok(old.descriptor.sequence < candidate.descriptor.sequence, "upgrade source must precede the signed candidate");
  const result = await scenario(old, candidate, path.join(root, "latest-stable"));
  const status = result.status === "expected-refusal" ? "qualified-with-legacy-refusal" : "passed";
  console.log(`Released JobCtrl ${version} qualification: ${status} (${result.mode})`);
  const report = { schemaVersion: 1, status, candidateBuildId: candidate.descriptor.buildId, acquisitionBoundary: "signed-formula-cache-adapter", executables: "actual-latest-stable-and-signed-candidate", elapsedMs: Math.max(1, Math.round(performance.now() - started)), results: [result] };
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
