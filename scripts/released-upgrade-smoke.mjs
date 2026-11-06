#!/usr/bin/env node

// Run the latest stable release executable and the signed candidate. Only the
// Homebrew download adapter is replaced: its cache is an exact signed release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDescriptorSignature } from "./distribution-homebrew.render.bundle.mjs";

export function selectLatestReleasedVersion(releases, candidateVersion) {
  const stable = releases
    .filter((release) => release.draft === false && release.prerelease === false)
    .map((release) => {
      const publishedAt = Date.parse(release.published_at);
      assert.ok(Number.isFinite(publishedAt), "stable release publication date is invalid");
      return { release, publishedAt };
    });
  const candidates = stable.filter(({ release }) => release.tag_name === `v${candidateVersion}`);
  assert.ok(candidates.length <= 1, "duplicate published candidate release");
  const candidateTime = candidates[0]?.publishedAt;
  if (candidateTime !== undefined) {
    assert.ok(!stable.some(({ release, publishedAt }) => release.tag_name !== `v${candidateVersion}` && publishedAt === candidateTime), "stable release publication order is ambiguous");
  }
  const previous = stable
    .filter(({ release, publishedAt }) => release.tag_name !== `v${candidateVersion}` && (candidateTime === undefined || publishedAt < candidateTime))
    .sort((left, right) => right.publishedAt - left.publishedAt)[0]?.release;
  assert.ok(previous, "no previous published stable release is available for upgrade verification");
  const tag = previous.tag_name;
  if (typeof tag !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) || tag.trim() !== tag) {
    throw new Error("stable release tag must be v<major>.<minor>.<patch>");
  }
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

export const PYTHON_APPLICATION = Object.freeze({ schemaVersion: 1, application: "jobctrl-python", applicationId: 1245926228, userVersion: 1 });
const APPLICATION_SCHEMA_BYTES = `${JSON.stringify(PYTHON_APPLICATION)}\n`;

// Protocol compatibility only describes the controller. Database identity is a
// separate, exact admission requirement, including for protocol-2 predecessors.
export function selectUpgradeMode(oldManifest, targetManifest, identity) {
  const source = oldManifest.launcherCompatibility;
  const target = targetManifest.launcherCompatibility;
  for (const range of [source, target]) {
    assert.ok(range && Number.isSafeInteger(range.minimum) && Number.isSafeInteger(range.maximum)
      && range.minimum > 0 && range.maximum >= range.minimum, "invalid launcher compatibility range");
  }
  assert.equal(target.minimum, 2, "candidate must implement the target launcher protocol");
  assert.equal(target.maximum, 2, "candidate must implement the target launcher protocol");
  if (identity?.applicationId === 0 && [14, 15].includes(identity.userVersion)) return "profile-only-fresh-state";
  if (identity?.applicationId === PYTHON_APPLICATION.applicationId && identity.userVersion === 1
      && source.minimum <= 2 && source.maximum >= 2) return "python-target-update";
  throw new Error(`unsupported released application identity: ${JSON.stringify(identity)}`);
}

export async function assertPythonApplicationDeclaration(manifest, payload) {
  const entries = manifest.files.filter((file) => file.path === "launcher/application-schema.json");
  assert.equal(entries.length, 1, "signed inventory must bind exactly one application identity declaration");
  assert.equal(entries[0].type, "file");
  assert.equal(entries[0].mode, "0644");
  assert.equal(entries[0].sizeBytes, Buffer.byteLength(APPLICATION_SCHEMA_BYTES));
  const declaration = path.join(payload, "launcher", "application-schema.json");
  const info = await lstat(declaration);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o644);
  assert.equal(await hash(declaration), entries[0].sha256, "application declaration differs from signed inventory");
  assert.equal(await readFile(declaration, "utf8"), APPLICATION_SCHEMA_BYTES);
  const runtime = await json(path.join(payload, "launcher", "runtime-manifest.json"));
  assert.equal(runtime.launcherProtocol, 2);
  for (const [name, module] of [["api", "jobctrl.app.server"], ["worker", "jobctrl.app.worker"]]) {
    const component = runtime.components.find((item) => item.name === name);
    assert.equal(component?.executable, "python/bin/python3");
    assert.ok(component.arguments.some((argument, index) => argument === "-m" && component.arguments[index + 1] === module));
  }
}

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = async (file) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};

// Capture the stopped synthetic workspace and its authenticated selection.
// The proof intentionally includes the legacy registry: it must not be
// rewritten to fabricate ownership when the in-place cutover is refused.
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
  const inventory = {};
  const walk = async (directory, prefix) => {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), info = await lstat(file), key = `${prefix}/${name}`;
      assert.ok(!info.isSymbolicLink(), "source proof must not traverse a linked fixture");
      if (info.isDirectory()) { inventory[key] = { type: "directory", ino: info.ino }; await walk(file, key); }
      else { assert.ok(info.isFile()); inventory[key] = { sha256: await hash(file), ino: info.ino, mode: info.mode & 0o777 }; }
    }
  };
  await walk(stateReal, "state");
  await walk(path.join(runtimeReal, "instances"), "instances");
  return { files, inventory };
}

export async function verifyLegacyRefusal({ root, runtime, state, history, external = [], invoke }) {
  const before = await legacyRefusalSnapshot({ root, runtime, state, history, external });
  const result = await invoke();
  assert.ok(Number.isInteger(result.code) && result.code !== 0, "legacy upgrade must explicitly refuse admission");
  assert.match(result.output, /Profile.only transfer|profile.transfer|legacy application|legacy JobCtrl database/i, "refusal must explain the explicit Profile-only cutover");
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
  assert.equal(manifest.buildId, descriptor.buildId);
  assert.equal(manifest.appVersion, descriptor.appVersion);
  assert.equal(manifest.releaseChannel, "stable");
  assert.equal(manifest.signing.codeSigning, "developer-id");
  assert.equal(manifest.signing.notarized, true);
  const archive = path.join(directory, `jobctrl-${descriptor.appVersion}-darwin-arm64.zip`);
  assert.equal(await hash(archive), descriptor.artifact.sha256);
  const installer = path.join(directory, "jobctrl-installer");
  const installers = manifest.files.filter((file) => file.path === "launcher/jobctrl-installer");
  assert.equal(installers.length, 1);
  assert.equal(installers[0].type, "file");
  assert.equal(await hash(installer), installers[0].sha256);
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
  assert.ok(source === "curl" || source === "homebrew", "unsupported acquisition source");
  const base = `https://releases.jobctrl.dev/v1/artifacts/${release.descriptor.buildId}`;
  const common = ["--source", source, ...(stage ? ["--stage-only"] : []), "--home", runtime];
  if (source === "curl") return [...common, "--release-url", `${base}/channel-pointer.json`];
  return [...common, "--descriptor-url", `${base}/release-descriptor.json`,
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

// These scenario helpers are exported for owned operational probes. They do not
// produce release qualification; only the signed/latest-published driver below
// can emit that report, and neither release CLI accepts a local-trust switch.
export async function readApplicationIdentity(database) {
  const info = await lstat(database);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "application database must be an unlinked regular file");
  const file = await open(database, "r");
  try {
    const header = Buffer.alloc(100);
    assert.equal((await file.read(header, 0, 100, 0)).bytesRead, 100);
    assert.equal(header.subarray(0, 16).toString("binary"), "SQLite format 3\0");
    return { applicationId: header.readUInt32BE(68), userVersion: header.readUInt32BE(60) };
  } finally { await file.close(); }
}

export async function publicRequest(route, method = "GET", value) {
  const response = await fetch(`http://127.0.0.1:8766${route}`, {
    method, headers: { Origin: "http://127.0.0.1:8766", "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(body)}`);
  return body;
}

export async function applicationRequest(payload, state, env, method, route, value) {
  const args = ["-I", "-B", "-m", "jobctrl", "--workspace", state, "request", method, route];
  if (value !== undefined) args.push("--data", JSON.stringify(value));
  return JSON.parse((await command(path.join(payload, "python/bin/python3"), args, {
    ...env, JOBCTRL_RUNTIME_MODE: "bundled", JOBCTRL_PAYLOAD_DIR: payload, JOBCTRL_WEB_DIR: path.join(payload, "web"),
  })).output);
}

export function authoredProfileFixture(label = "Released binary QA") {
  return {
    personal: { full_name: `Owned Synthetic ${label}`, email: "synthetic@example.invalid" },
    application_attestations: { age_18_plus: true, background_check_consent: null, felony_conviction: null, previously_worked_at_employer: null, additional: { synthetic: "reviewed" } },
    application_preferences: { how_heard: "Owned release fixture" },
    resume_constraints: { real_metrics: ["12 synthetic records"] },
    resume: {
      executive_profile: { baseline_text: "Full authored synthetic baseline; no generated claims." },
      experience_entries: [
        { id: "release-role-a", date_range: "2020–2026", title: "Engineer", company: "Synthetic A", location: "Synthetic", summary: "Retained source position", bullets: ["Preserved 12 synthetic records.", "Maintained an authored governance mechanism."], achievement_evidence: [] },
        { id: "release-role-b", date_range: "2018–2020", title: "Developer", company: "Synthetic B", location: "Synthetic", summary: "Retained earlier position", bullets: ["Retained foundational tooling."], achievement_evidence: [] },
      ],
      education_entries: [{ id: "release-school", date: "2018", degree: "Synthetic Degree", institution: "Synthetic College", location: "Synthetic" }],
      skill_categories: [{ id: "release-skills", label: "Tools", items: ["Python", "SQLite"] }],
      tailoring_rules: { required_experience_entry_ids: ["release-role-a", "release-role-b"], required_education_entry_ids: ["release-school"], required_skill_category_ids: ["release-skills"], required_bullets_by_experience_id: { "release-role-a": ["Preserved 12 synthetic records."] }, required_skills_by_category_id: { "release-skills": ["Python"] }, max_experience_bullets: 4, custom_tailoring_prompt: "Preserve all authored synthetic history." },
    },
  };
}

async function seedPublicProfile() {
  const current = await publicRequest("/v1/profile");
  assert.equal(current.profileVersion, null, "predecessor fixture must start without a Profile");
  const saved = await publicRequest("/v1/profile", "PATCH", { expectedProfileVersion: current.profileVersion,
    profile: authoredProfileFixture(), ...(current.style ? { style: current.style } : {}),
    templateText: "{{ personal_data }}\n\n{{ resume_body }}\n% owned-release-template\n" });
  assert.ok(Number.isSafeInteger(saved.profileVersion) && saved.profileVersion > 0);
  assert.equal(saved.profile.personal.full_name, authoredProfileFixture().personal.full_name);
  assert.equal(saved.profile.resume.experience_entries.length, 2);
  return saved;
}

function authoredProfile(config) {
  const value = structuredClone({ profile: config.profile, style: config.style, templateText: config.templateText });
  // The target gives authored bullets stable opaque identities. Those new IDs
  // do not alter any source-authored field; all other fields compare exactly.
  for (const role of value.profile.resume.experience_entries) delete role.achievement_ids;
  return value;
}

async function temporalCommand(payload, env, address, args) {
  return command(path.join(payload, "temporal/temporal"), [...args, "--address", address,
    "--disable-config-file", "--disable-config-env"], env);
}

async function createHistory(payload, env, address, workflowId) {
  await temporalCommand(payload, env, address, ["workflow", "start", "--workflow-id", workflowId,
    "--type", "JobCtrlReleaseQualification", "--task-queue", "jobctrl-release-qa-unused", "--input", "{}"]);
  await temporalCommand(payload, env, address, ["workflow", "terminate", "--workflow-id", workflowId, "--reason", "Owned synthetic release fixture"]);
  return describeHistory(payload, env, address, workflowId);
}

async function describeHistory(payload, env, address, workflowId) {
  const info = JSON.parse((await temporalCommand(payload, env, address,
    ["workflow", "describe", "--workflow-id", workflowId, "--output", "json"])).output).workflowExecutionInfo;
  return { runId: info.execution.runId, status: info.status, historyLength: info.historyLength };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

// A real, separately bound Temporal process reads/writes only the stopped owned
// history. Its actual child handle is retained until exit; no PID rediscovery.
async function usingStoppedHistory(payload, history, env, callback) {
  const address = `127.0.0.1:${await availablePort()}`;
  const result = await command(path.join(payload, "temporal/temporal"), ["server", "start-dev", "--headless",
    "--ip", "127.0.0.1", "--port", address.split(":")[1], "--db-filename", history, "--log-level", "error",
    "--disable-config-file", "--disable-config-env"], env, {
    allowFailure: true,
    onStarted: async (child) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const ready = await command(path.join(payload, "temporal/temporal"), ["operator", "cluster", "health", "--address", address,
          "--command-timeout", "1s", "--disable-config-file", "--disable-config-env"], env, { allowFailure: true });
        if (ready.code === 0) break;
        assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < deadline, "owned Temporal did not become healthy");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      try { await callback(address); } finally { child.kill("SIGINT"); }
    },
  });
  assert.ok(result.code === 0 || result.signal === "SIGINT", `owned Temporal failed to stop: ${result.output}`);
}

async function assertPair(state, id) {
  assert.ok(id, "transition must record a paired backup");
  const directory = path.join(state, "backups", id), pair = await json(path.join(directory, "pair.json"));
  assert.equal(pair.id, id);
  assert.deepEqual(pair.files.map((file) => file.name).sort(), ["jobctrl.db", "temporal.db"]);
  for (const file of pair.files) assert.equal(await hash(path.join(directory, file.name)), file.sha256);
  const app = pair.files.find((file) => file.name === "jobctrl.db");
  assert.equal(app.sqliteApplicationId, PYTHON_APPLICATION.applicationId);
  assert.equal(app.sqliteUserVersion, 1);
  return { directory, pair };
}

async function readBusinessState(payload, state, env) {
  const request = (method, route, value) => applicationRequest(payload, state, env, method, route, value);
  return { profile: await request("GET", "/v1/profile"), jobs: await request("GET", "/v1/jobs"),
    discovery: await request("GET", "/v1/discovery/settings"), settings: await request("GET", "/v1/settings") };
}

async function writeBusinessState(payload, state, env, marker) {
  const request = (method, route, value) => applicationRequest(payload, state, env, method, route, value);
  const profile = await request("GET", "/v1/profile");
  profile.profile.personal.preferred_name = `Later ${marker}`;
  profile.profile.resume.executive_profile.baseline_text = `Later authored baseline ${marker}`;
  await request("PATCH", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: profile.profile,
    templateText: `{{ personal_data }}\n\n{{ resume_body }}\n% later-template-${marker}\n` });
  const settings = await request("GET", "/v1/settings");
  await request("PATCH", "/v1/settings", { expectedRevision: settings.revision, targetCriteria: `Later ${marker}` });
  const discovery = await request("GET", "/v1/discovery/settings");
  await request("PATCH", "/v1/discovery/settings", { expectedRevision: discovery.revision, queries: [`Later query ${marker}`], locations: ["Synthetic"] });
  const jobs = await request("GET", "/v1/jobs");
  if (jobs.jobs.length === 0) await request("POST", "/v1/jobs/capture", { url: "https://jobs.example/upgrade-qa", title: `Later job ${marker}`, company: "Synthetic", description: "Literal authored synthetic posting.", location: "Synthetic" });
  else {
    assert.equal(jobs.jobs.length, 1);
    const job = jobs.jobs[0];
    await request("PATCH", `/v1/jobs/${job.job_id}`, { expectedRevision: job.revision, title: `Later job ${marker}` });
  }
  return readBusinessState(payload, state, env);
}

async function assertOwnedScenario({ root, runtime, state, env, payload, selector, candidate }) {
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const fixture = await realpath(root), temporary = await realpath(os.tmpdir());
  assert.ok(inside(temporary, fixture), "release QA root must belong to the system temporary directory");
  const runtimeReal = await realpath(runtime), stateReal = await realpath(state), payloadReal = await realpath(payload);
  assert.ok(inside(fixture, runtimeReal) && inside(fixture, stateReal) && inside(fixture, payloadReal),
    "release QA runtime, workspace and payload must belong to the owned fixture");
  assert.equal(typeof env.JOBCTRL_RUNTIME_HOME, "string");
  assert.equal(typeof env.JOBCTRL_DIR, "string");
  assert.equal(await realpath(env.JOBCTRL_RUNTIME_HOME), runtimeReal, "release command runtime must match the owned fixture");
  assert.equal(await realpath(env.JOBCTRL_DIR), stateReal, "release command workspace must match the owned fixture");
  if (selector !== undefined) {
    assert.equal(path.resolve(selector), path.join(runtimeReal, "bin", "jobctrl"));
    assert.equal(payloadReal, path.join(runtimeReal, "releases", candidate.descriptor.buildId, "payload"));
    assert.ok(inside(stateReal, await realpath(path.join(state, "temporal.db"))), "history must belong to the owned workspace");
  }
}

// Legacy sources are never promoted in place. The candidate first proves its
// refusal, then the explicit public transfer command creates a fresh workspace.
export async function verifyProfileOnlyCutover({ root, runtime, state, history, payload, env,
  invokeInstaller, invokeFrontend, expectedProfile, checked = [] }) {
  await assertOwnedScenario({ root, runtime, state, payload, env });
  for (const invoke of [invokeInstaller, invokeFrontend]) {
    await verifyLegacyRefusal({ root, runtime, state, history, invoke });
  }
  checked.push("candidate-installer-and-frontend-refuse-legacy-before-any-mutation");
  return transferProfileToFreshWorkspace({ root, runtime, state, history, payload, env, expectedProfile, checked });
}

// The transfer operation is separately reusable in an unsigned operational
// probe. It cannot qualify the signed formula/predecessor refusal boundary.
export async function transferProfileToFreshWorkspace({ root, runtime, state, history, payload, env,
  expectedProfile, checked = [] }) {
  await assertOwnedScenario({ root, runtime, state, payload, env });
  const snapshot = await legacyRefusalSnapshot({ root, runtime, state, history });
  const manifest = path.join(root, "browser-profile-sources.json");
  // This source was authored only through HTTP; no browser persistence exists.
  await writeFile(manifest, JSON.stringify({ format: "jobctrl.profile-browser-sources.v1", complete: true,
    sources: [], known_attachment_ids: [], unavailable_refs: [] }), { mode: 0o600 });
  const freshState = path.join(root, "fresh-python-state");
  const transfer = await command(path.join(payload, "python/bin/python3"), ["-I", "-B", "-m", "jobctrl", "profile-transfer",
    "--source", state, "--target", freshState, "--browser-sources", manifest, "--confirm-profile-only-reset"], {
    ...env, JOBCTRL_RUNTIME_MODE: "bundled", JOBCTRL_PAYLOAD_DIR: payload,
  });
  const receipt = JSON.parse(transfer.output);
  assert.equal(receipt.schema, "jobctrl.profile-cutover.v1");
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.sourcePreserved, true);
  assert.equal(receipt.selected, false);
  assert.equal(receipt.reset, "all-non-profile-application-data");
  assert.deepEqual(await legacyRefusalSnapshot({ root, runtime, state, history }), snapshot,
    "explicit Profile transfer must leave the exact prior data and runtime selection unchanged");
  assert.deepEqual(await readApplicationIdentity(path.join(freshState, "jobctrl.db")),
    { applicationId: PYTHON_APPLICATION.applicationId, userVersion: 1 });
  const imported = await applicationRequest(payload, freshState, env, "GET", "/v1/profile");
  assert.deepEqual(authoredProfile(imported), authoredProfile(expectedProfile), "all authored Profile fields, baseline, style and template must transfer");
  assert.equal((await applicationRequest(payload, freshState, env, "GET", "/v1/jobs")).total, 0);
  await assert.rejects(access(path.join(freshState, "temporal.db")), { code: "ENOENT" });
  checked.push("full-authored-profile-style-template-transferred-explicitly", "source-data-history-selector-registry-and-backups-unchanged", "new-application-identity-with-empty-non-profile-state");
  return { freshState, receipt };
}

// Exercise the actual target controller at every current durable boundary.
// Later writes use canonical public actions and real Temporal workflow history.
export async function runForwardInterruptionMatrix({ old, candidate, root, runtime, state, env, selector, payload,
  initial, checked = [], readinessFailure = true }) {
  // Validate all authority before marker creation, process launch or stop.
  await assertOwnedScenario({ root, runtime, state, env, selector, payload, candidate });
  const checkpoints = ["metadata_verified", "pair_backed_up", "selector_handoff_pending", "selector_replaced", "candidate_starting", "candidate_healthy", "policy_finalized"];
  await writeFile(path.join(root, ".jobctrl-release-qa"), "jobctrl-release-qa-v1\n", { mode: 0o600 });
  const app = path.join(state, "jobctrl.db"), history = path.join(state, "temporal.db");
  const inodes = [(await stat(app)).ino, (await stat(history)).ino];
  let previous;
  const historyRecords = [];
  const verifyRevokedCandidate = async ({ promoted = false } = {}) => {
    const policyPath = path.join(runtime, `channel-${candidate.descriptor.channel}.json`);
    const original = await readFile(policyPath), policy = JSON.parse(original);
    const journalBefore = await readFile(path.join(runtime, "transition.json"));
    const activeBefore = await readFile(path.join(runtime, "active.json"));
    assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
    policy.revokedBuildIds[candidate.descriptor.buildId] = true;
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
    try {
      const start = await command(selector, ["start", "--no-open"], env, { allowFailure: true });
      const update = await command(selector, ["update"], env, { allowFailure: true });
      assert.notEqual(start.code, 0, "revoked candidate must not start");
      assert.notEqual(update.code, 0, "revoked candidate must not update");
      assert.match(update.output, /revok/i);
      // An unfinished handoff independently blocks public start. The promoted
      // case below proves revocation itself blocks start after that fence ends.
      if (promoted) assert.match(start.output, /revok/i);
      assert.deepEqual(await readFile(path.join(runtime, "transition.json")), journalBefore);
      assert.deepEqual(await readFile(path.join(runtime, "active.json")), activeBefore);
      await command(selector, ["stop"], env);
      assert.deepEqual(await readFile(path.join(runtime, "transition.json")), journalBefore);
      assert.deepEqual(await readFile(path.join(runtime, "active.json")), activeBefore);
      const instance = createHash("sha256").update(await realpath(state)).digest("hex");
      const directory = path.join(runtime, "instances", instance), registry = await json(path.join(directory, "state.json"));
      assert.ok(registry.stoppedAt && Object.values(registry.components).every((component) => component.exitedAt),
        "revoked cleanup must stop every owned component");
      assert.equal((await readdir(path.join(directory, "executions"))).filter((name) => name.endsWith(".json")).length, 0,
        "revoked cleanup must retire the owned execution receipts");
    } finally {
      // Restore only this disposable modeled policy so the independent crash
      // matrix can continue. A real published revocation is never reversed.
      await writeFile(policyPath, original, { mode: 0o600 });
    }
    checked.push(promoted ? "revoked-promoted-candidate-refuses-start-and-update" : "revoked-in-flight-candidate-refuses-update-and-public-start",
      "revoked-candidate-owned-stop-preserves-journal-and-selection");
  };
  for (const [index, boundary] of checkpoints.entries()) {
    const entry = index === 0 ? initial : { executable: selector, args: ["update"] };
    assert.ok(entry, "first interruption requires the actual acquisition/controller entrypoint");
    console.log(`${old.descriptor.appVersion}: interrupting target update at ${boundary}`);
    await interruptReleaseAtCheckpoint(entry.executable, entry.args, { ...env, TMPDIR: os.tmpdir(),
      JOBCTRL_RELEASE_QA_ROOT: root, JOBCTRL_RELEASE_QA_PAUSE: boundary }, boundary);
    const journal = await json(path.join(runtime, "transition.json"));
    assert.equal(journal.state, boundary);
    assert.equal(journal.forwardOnlyUpgrade, true);
    assert.equal(journal.preserveLiveOnFailure, true);
    assert.equal(journal.sourceSchemaVersion, 1);
    if (boundary === "candidate_healthy") await verifyRevokedCandidate();
    else await command(selector, ["stop"], env);
    if (boundary === "selector_replaced") {
      const policyPath = path.join(runtime, `channel-${candidate.descriptor.channel}.json`), policy = await json(policyPath);
      policy.revokedBuildIds[old.descriptor.buildId] = true;
      await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
      checked.push("revoked-predecessor-remains-historical-evidence-for-forward-handoff");
    }
    if (previous) {
      assert.deepEqual(await readBusinessState(payload, state, env), previous, "interrupted recovery must preserve every later public application write");
      const { directory, pair } = await assertPair(state, journal.recoveryBackupId || journal.backupId);
      assert.equal(pair.releaseReceipt.buildId, journal.recoveryBackupId ? candidate.descriptor.buildId : old.descriptor.buildId,
        "original and recovery snapshots must retain their actual release authority");
      // Inspect copies only: the authenticated paired backup bytes are immutable.
      const inspection = await mkdtemp(path.join(root, "pair-inspection-"));
      try {
        for (const file of pair.files) await copyFile(path.join(directory, file.name), path.join(inspection, file.name));
        assert.deepEqual(await readBusinessState(payload, inspection, env), previous);
        await usingStoppedHistory(payload, path.join(inspection, "temporal.db"), env, async (address) => {
          for (const record of historyRecords) assert.deepEqual(await describeHistory(payload, env, address, record.id), record.value);
        });
      } finally { await rm(inspection, { recursive: true }); }
      await assertPair(state, pair.id);
    }
    if (index > 0) {
      const before = await legacyRefusalSnapshot({ root, runtime, state, history });
      const refused = await command(selector, ["rollback", "--to", old.descriptor.buildId], env, { allowFailure: true });
      assert.notEqual(refused.code, 0, "unfinished forward recovery must refuse rollback");
      assert.deepEqual(await legacyRefusalSnapshot({ root, runtime, state, history }), before);
    }
    previous = await writeBusinessState(payload, state, env, String(index));
    await usingStoppedHistory(payload, history, env, async (address) => {
      for (const record of historyRecords) assert.deepEqual(await describeHistory(payload, env, address, record.id), record.value);
      const id = `jobctrl-later-history-${index}`;
      historyRecords.push({ id, value: await createHistory(payload, env, address, id) });
    });
    if (boundary === "candidate_starting" && readinessFailure) {
      const blocker = net.createServer((socket) => socket.destroy());
      await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(8766, "127.0.0.1", resolve); });
      try { assert.notEqual((await command(selector, ["update"], env, { allowFailure: true })).code, 0); }
      finally { await new Promise((resolve) => blocker.close(resolve)); }
      await command(selector, ["stop"], env);
      assert.deepEqual(await readBusinessState(payload, state, env), previous, "failed readiness cannot restore an older database");
      assert.equal((await json(path.join(runtime, "transition.json"))).preserveLiveOnFailure, true);
      checked.push("actual-readiness-failure-preserves-later-writes-and-forward-recovery");
    }
  }
  await interruptReleaseAtCheckpoint(selector, ["update"], { ...env, TMPDIR: os.tmpdir(),
    JOBCTRL_RELEASE_QA_ROOT: root, JOBCTRL_RELEASE_QA_PAUSE: "selection_committed" }, "selection_committed");
  assert.equal((await json(path.join(runtime, "transition.json"))).state, "policy_finalized");
  const health = await publicRequest("/v1/health");
  assert.equal(health.worker.status, "healthy");
  assert.ok(Number.isSafeInteger(health.worker.pid) && health.worker.pid > 0);
  await command(selector, ["update"], env);
  assert.equal((await publicRequest("/v1/health")).worker.pid, health.worker.pid, "selection finalization must keep the healthy candidate worker");
  const journal = await json(path.join(runtime, "transition.json"));
  assert.equal(journal.state, "promoted");
  assert.equal((await json(path.join(runtime, "active.json"))).receipt.buildId, candidate.descriptor.buildId);
  await assertPair(state, journal.backupId);
  const finalPair = await assertPair(state, journal.recoveryBackupId);
  const inspection = await mkdtemp(path.join(root, "final-pair-inspection-"));
  try {
    for (const file of finalPair.pair.files) await copyFile(path.join(finalPair.directory, file.name), path.join(inspection, file.name));
    assert.deepEqual(await readBusinessState(payload, inspection, env), previous);
    await usingStoppedHistory(payload, path.join(inspection, "temporal.db"), env, async (address) => {
      for (const record of historyRecords) assert.deepEqual(await describeHistory(payload, env, address, record.id), record.value);
    });
  } finally { await rm(inspection, { recursive: true }); }
  await assertPair(state, journal.recoveryBackupId);
  assert.deepEqual(await readBusinessState(payload, state, env), previous);
  for (const record of historyRecords) assert.deepEqual(await describeHistory(payload, env, "127.0.0.1:7233", record.id), record.value);
  assert.deepEqual([(await stat(app)).ino, (await stat(history)).ino], inodes, "forward recovery must preserve the live database pair in place");
  await verifyRevokedCandidate({ promoted: true });
  await command(selector, ["start", "--no-open"], env);
  assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
  checked.push("actual-controller-interrupted-at-all-eight-target-durable-boundaries", "every-later-profile-template-job-search-and-settings-write-preserved", "real-later-temporal-workflow-history-preserved-in-live-and-paired-backups", "unfinished-rollback-refused-without-mutation", "database-pair-inodes-preserved", "selection-finalized-without-restarting-healthy-worker");
  return { state: previous, checks: checked };
}

export async function scenario(old, candidate, root) {
  const runtime = path.join(root, "runtime"), state = path.join(root, "state"), home = path.join(root, "home"), prefix = path.join(root, "formula"), bin = path.join(root, "bin");
  for (const directory of [root, home, state, bin]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { HOME: home, TMPDIR: os.tmpdir(), JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, JOBCTRL_UPGRADE_QA_PREFIX: prefix };
  await writeFile(path.join(bin, "brew"), '#!/bin/sh\ncase "$1" in\nupgrade) [ "$2" = ebarti/tap/jobctrl ] ;;\n--prefix) printf "%s\\n" "$JOBCTRL_UPGRADE_QA_PREFIX" ;;\n*) exit 64 ;;\nesac\n', { mode: 0o700 });
  const selector = path.join(runtime, "bin/jobctrl"), checked = [], cleanups = [{ selector, env }];
  let failure;
  try {
    await command(old.installer, installArgs(old, runtime), env);
    await command(selector, ["start", "--no-open"], env);
    assert.equal(JSON.parse((await command(selector, ["status", "--json"], env)).output).status, "running");
    const oldPayload = path.join(runtime, "releases", old.descriptor.buildId, "payload");
    const identity = await readApplicationIdentity(path.join(state, "jobctrl.db"));
    const mode = selectUpgradeMode(old.manifest, candidate.manifest, identity);
    const savedProfile = await seedPublicProfile();
    const workflowId = `jobctrl-released-history-${old.descriptor.sequence}`;
    const sourceHistory = await createHistory(oldPayload, env, "127.0.0.1:7233", workflowId);
    await command(selector, ["stop"], env);
    assert.deepEqual(await readApplicationIdentity(path.join(state, "jobctrl.db")), identity);
    const stagingRuntime = mode === "profile-only-fresh-state" ? path.join(root, "candidate-acquisition") : runtime;
    const stagingState = mode === "profile-only-fresh-state" ? path.join(root, "candidate-acquisition-state") : state;
    await mkdir(stagingState, { recursive: true, mode: 0o700 });
    await command(candidate.installer, installArgs(candidate, stagingRuntime, true), { ...env, JOBCTRL_RUNTIME_HOME: stagingRuntime, JOBCTRL_DIR: stagingState });
    const payload = path.join(stagingRuntime, "releases", candidate.descriptor.buildId, "payload");
    await assertPythonApplicationDeclaration(candidate.manifest, payload);
    const frontend = await formulaCache(candidate, prefix, payload);
    const result = { sourceVersion: old.descriptor.appVersion, sourceBuildId: old.descriptor.buildId,
      sourceArtifactSha256: old.descriptor.artifact.sha256, sourceApplication: identity,
      targetBuildId: candidate.descriptor.buildId, targetApplication: PYTHON_APPLICATION, mode, status: "passed", checks: checked };
    if (mode === "profile-only-fresh-state") {
      const before = await legacyRefusalSnapshot({ root, runtime, state, history: path.join(state, "temporal.db") });
      const { freshState, receipt } = await verifyProfileOnlyCutover({ root, runtime, state, history: path.join(state, "temporal.db"), payload, env, expectedProfile: savedProfile, checked,
        // Installing a different build into an active home only stages it.
        // Prove first-selection refusal in the separate staged candidate home.
        invokeInstaller: () => command(candidate.installer, installArgs(candidate, stagingRuntime),
          { ...env, JOBCTRL_RUNTIME_HOME: stagingRuntime }, { allowFailure: true }),
        invokeFrontend: () => command(frontend, ["start", "--no-open"], env, { allowFailure: true }) });
      for (const name of ["active.json", "bin/jobctrl"]) {
        await assert.rejects(access(path.join(stagingRuntime, name)), { code: "ENOENT" });
      }
      const freshEnv = { ...env, JOBCTRL_DIR: freshState, JOBCTRL_RUNTIME_HOME: stagingRuntime };
      const freshSelector = path.join(stagingRuntime, "bin/jobctrl");
      await command(candidate.installer, installArgs(candidate, stagingRuntime), freshEnv);
      cleanups.push({ selector: freshSelector, env: freshEnv });
      await command(freshSelector, ["start", "--no-open"], freshEnv);
      assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
      assert.deepEqual(authoredProfile(await publicRequest("/v1/profile")), authoredProfile(savedProfile));
      assert.equal((await publicRequest("/v1/jobs")).total, 0);
      const absent = await command(path.join(payload, "temporal/temporal"), ["workflow", "describe", "--workflow-id", workflowId, "--address", "127.0.0.1:7233", "--disable-config-file", "--disable-config-env"], freshEnv, { allowFailure: true });
      assert.notEqual(absent.code, 0, "fresh target must not inherit legacy Temporal workflows");
      await command(freshSelector, ["stop"], freshEnv);
      await command(freshSelector, ["start", "--no-open"], freshEnv);
      assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
      assert.deepEqual(authoredProfile(await publicRequest("/v1/profile")), authoredProfile(savedProfile));
      assert.equal((await publicRequest("/v1/jobs")).total, 0);
      await command(freshSelector, ["stop"], freshEnv);
      assert.deepEqual(await legacyRefusalSnapshot({ root, runtime, state, history: path.join(state, "temporal.db") }), before);
      // Re-read a copy: validating retained history must not open the source.
      const inspection = path.join(root, "legacy-history-inspection.db");
      await copyFile(path.join(state, "temporal.db"), inspection);
      await usingStoppedHistory(payload, inspection, env, async (address) => {
        assert.deepEqual(await describeHistory(payload, env, address, workflowId), sourceHistory);
      });
      result.transfer = { schema: receipt.schema, status: receipt.status, selected: receipt.selected, reset: receipt.reset, profileBundleSha256: receipt.profileBundleSha256 };
      checked.push("fresh-candidate-real-server-worker-and-temporal-start-stop-restart", "old-temporal-history-retained-only-in-source", "source-byte-and-selection-preservation-after-target-restart");
    } else {
      await assertPythonApplicationDeclaration(old.manifest, oldPayload);
      const baseline = await writeBusinessState(payload, state, env, "before-update");
      await command(selector, ["update"], env);
      assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
      assert.deepEqual(await readBusinessState(payload, state, env), baseline);
      assert.deepEqual(await describeHistory(payload, env, "127.0.0.1:7233", workflowId), sourceHistory);
      const journal = await json(path.join(runtime, "transition.json"));
      assert.equal((await assertPair(state, journal.backupId)).pair.releaseReceipt.buildId, old.descriptor.buildId);
      await publicRequest("/v1/settings", "PATCH", { expectedRevision: baseline.settings.revision, targetCriteria: "Candidate later write before explicit rollback" });
      await command(selector, ["rollback", "--to", old.descriptor.buildId], env);
      assert.deepEqual(await readBusinessState(payload, state, env), baseline, "explicit paired rollback restores the prior accepted business state");
      assert.deepEqual(await describeHistory(payload, env, "127.0.0.1:7233", workflowId), sourceHistory);
      assert.equal((await json(path.join(runtime, "active.json"))).selectorBuildId, candidate.descriptor.buildId);
      assert.equal(JSON.parse((await command(frontend, ["version", "--json"], env)).output).buildId, old.descriptor.buildId);
      checked.push("actual-target-update-with-public-state-and-history-preserved", "predecessor-bound-paired-backup", "explicit-paired-rollback-restores-accepted-state", "newer-authenticated-homebrew-selector-preserves-rollback");
      // The second update exercises the same real Homebrew frontend and all
      // durable handoffs, including failed readiness after later writes.
      const recovered = await runForwardInterruptionMatrix({ old, candidate, root, runtime, state, env, selector, payload, checked,
        initial: { executable: frontend, args: ["update"] } });
      assert.deepEqual(await describeHistory(payload, env, "127.0.0.1:7233", workflowId), sourceHistory);
      await command(selector, ["stop"], env);
      await command(selector, ["start", "--no-open"], env);
      assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
      assert.deepEqual(await readBusinessState(payload, state, env), recovered.state);
      assert.deepEqual(await describeHistory(payload, env, "127.0.0.1:7233", workflowId), sourceHistory);
      checked.push("actual-candidate-stop-and-restart");
    }
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    for (const cleanup of cleanups.reverse()) {
      try { await command(cleanup.selector, ["stop"], cleanup.env); }
      catch (error) { if (failure) failure.message += `\nCleanup failed: ${error.message}`; else throw error; }
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
  assert.equal(result.status, "passed");
  console.log(`Released JobCtrl ${version} qualification: passed (${result.mode})`);
  const report = { schemaVersion: 2, status: "passed", qualification: "signed-latest-stable-and-candidate",
    candidateBuildId: candidate.descriptor.buildId, candidateArtifactSha256: candidate.descriptor.artifact.sha256,
    predecessorVersion: version, predecessorBuildId: old.descriptor.buildId,
    acquisitionBoundary: "signed-formula-cache-adapter", executables: "actual-latest-stable-and-signed-candidate",
    elapsedMs: Math.max(1, Math.round(performance.now() - started)), results: [result] };
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
