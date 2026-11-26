#!/usr/bin/env node

// Run the latest stable release executable and the signed candidate. Only the
// Homebrew download adapter is replaced: its cache is an exact signed release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
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
export const POSTGRES_APPLICATION = Object.freeze({ schemaVersion: 2, application: "jobctrl-python", storage: "postgresql", major: 17, workflow: "dbos" });

function hasPostgres(manifest) {
  return manifest.files.some(({ path, type }) => path === "postgres/bin/postgres" && type === "file");
}

export function selectUpgradeMode(oldManifest, targetManifest, identity) {
  const source = oldManifest.launcherCompatibility;
  const target = targetManifest.launcherCompatibility;
  for (const range of [source, target]) {
    assert.ok(range && Number.isSafeInteger(range.minimum) && Number.isSafeInteger(range.maximum)
      && range.minimum > 0 && range.maximum >= range.minimum, "invalid launcher compatibility range");
  }
  assert.equal(target.minimum, 2, "candidate must implement the target launcher protocol");
  assert.equal(target.maximum, 2, "candidate must implement the target launcher protocol");
  assert.ok(hasPostgres(targetManifest), "candidate must bundle PostgreSQL");
  assert.ok(source.minimum <= 2 && source.maximum >= 2, "predecessor must implement the supported launcher protocol");
  if (hasPostgres(oldManifest)) return "postgres-release-update";
  assert.deepEqual(identity, { applicationId: PYTHON_APPLICATION.applicationId, userVersion: PYTHON_APPLICATION.userVersion },
    "published predecessor must use the supported Python SQLite identity");
  return "sqlite-to-postgres";
}

export async function assertPythonApplicationDeclaration(manifest, payload, expected = POSTGRES_APPLICATION) {
  const schemaBytes = `${JSON.stringify(expected)}\n`;
  const entries = manifest.files.filter((file) => file.path === "launcher/application-schema.json");
  assert.equal(entries.length, 1, "signed inventory must bind exactly one application identity declaration");
  assert.equal(entries[0].type, "file");
  assert.equal(entries[0].mode, "0644");
  assert.equal(entries[0].sizeBytes, Buffer.byteLength(schemaBytes));
  const declaration = path.join(payload, "launcher", "application-schema.json");
  const info = await lstat(declaration);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o644);
  assert.equal(await hash(declaration), entries[0].sha256, "application declaration differs from signed inventory");
  assert.equal(await readFile(declaration, "utf8"), schemaBytes);
  const runtime = await json(path.join(payload, "launcher", "runtime-manifest.json"));
  assert.equal(runtime.launcherProtocol, 2);
  if (expected.storage === "postgresql") {
    const postgres = runtime.components.find((item) => item.name === "postgres");
    assert.equal(postgres?.executable, "postgres/bin/postgres");
    assert.ok(manifest.files.some(({ path, type }) => path === postgres.executable && type === "file"));
  }
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

async function command(executable, args, env, { allowFailure = false } = {}) {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const signal = (name) => {
    try { child.kill(name); }
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
    const result = await finished;
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
    "--descriptor-file", release.descriptorFile ?? path.join(release.directory, "release-descriptor.json"),
    "--signature-file", release.signatureFile ?? path.join(release.directory, "release-descriptor.json.sig"), "--archive-file", release.archive];
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
  return {
    ...release,
    frontend: path.join(root, "jobctrl"),
    installer: path.join(root, "jobctrl-installer"),
    descriptorFile: path.join(root, "homebrew-release.json"),
    signatureFile: path.join(root, "homebrew-release.json.sig"),
    archive: path.join(root, "jobctrl-release.zip"),
  };
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

async function sourceFingerprints(state) {
  const files = [];
  for (const name of ["jobctrl.db", "temporal.db"]) {
    const file = path.join(state, name);
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "predecessor database must be an unlinked regular file");
    files.push({ name, ino: info.ino, sha256: await hash(file) });
    // A stopped predecessor can retain rollback/WAL files. Preserve their
    // exact bytes when present. A transient shared-memory file is not history.
    for (const suffix of ["-wal", "-journal"]) {
      try {
        const sidecar = await lstat(file + suffix);
        assert.ok(sidecar.isFile() && !sidecar.isSymbolicLink() && sidecar.nlink === 1, "SQLite sidecar must be an unlinked regular file");
        files.push({ name: name + suffix, ino: sidecar.ino, sha256: await hash(file + suffix) });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return files;
}

async function businessState() {
  const [profile, jobs, discovery, settings] = await Promise.all([
    publicRequest("/v1/profile"), publicRequest("/v1/jobs"), publicRequest("/v1/discovery/settings"), publicRequest("/v1/settings"),
  ]);
  return { profile, jobs, discovery, settings };
}

async function seedPublicBusinessState() {
  await seedPublicProfile();
  const { settings, discovery } = await businessState();
  await publicRequest("/v1/settings", "PATCH", { expectedRevision: settings.revision, targetCriteria: "Owned release qualification" });
  await publicRequest("/v1/discovery/settings", "PATCH", {
    expectedRevision: discovery.revision, queries: ["Synthetic qualification query"], locations: ["Synthetic"],
  });
  // Capture is local and uses supplied synthetic content.
  await publicRequest("/v1/jobs/capture", "POST", {
    url: "https://jobs.example/upgrade-qa", title: "Owned upgrade QA job", company: "Synthetic",
    description: "Literal authored synthetic posting.", location: "Synthetic",
  });
  const captured = await businessState();
  assert.equal(captured.jobs.jobs.length, 1);
  return captured;
}

function assertRetainedBusinessState(observed, expected) {
  assert.deepEqual(observed.profile, expected.profile, "Profile, accepted template and versions must survive");
  assert.deepEqual(observed.jobs, expected.jobs, "canonical Job IDs, revisions and content must survive");
  assert.deepEqual(observed.discovery, expected.discovery, "saved Discovery settings must survive");
  assert.deepEqual(observed.settings, expected.settings, "accepted settings and revision must survive");
}

export async function scenario(old, candidate, root) {
  const runtime = path.join(root, "runtime");
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const prefix = path.join(root, "formula");
  for (const directory of [root, home, state]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { HOME: home, TMPDIR: os.tmpdir(), JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const selector = path.join(runtime, "bin/jobctrl");
  const oldPayload = path.join(runtime, "releases", old.descriptor.buildId, "payload");
  const payload = path.join(runtime, "releases", candidate.descriptor.buildId, "payload");
  const status = async () => JSON.parse((await command(selector, ["status", "--json"], env)).output);
  const checked = [];
  let failure;
  try {
    await command(old.installer, installArgs(old, runtime), env);
    await command(selector, ["start", "--no-open"], env);
    assert.equal((await status()).status, "running");
    assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
    const isPostgres = hasPostgres(old.manifest);
    const identity = isPostgres ? POSTGRES_APPLICATION : await readApplicationIdentity(path.join(state, "jobctrl.db"));
    const mode = selectUpgradeMode(old.manifest, candidate.manifest, identity);
    await assertPythonApplicationDeclaration(old.manifest, oldPayload, isPostgres ? POSTGRES_APPLICATION : PYTHON_APPLICATION);
    const baseline = await seedPublicBusinessState();
    if (!isPostgres) {
      const sourceHistory = await createHistory(oldPayload, env, "127.0.0.1:7233", `jobctrl-released-history-${old.descriptor.sequence}`);
      assert.match(sourceHistory.status, /terminated/i);
      assert.ok(Number(sourceHistory.historyLength) > 1);
    }
    await command(selector, ["stop"], env);
    assert.equal((await status()).status, "stopped");
    const fingerprints = isPostgres ? null : await sourceFingerprints(state);

    await command(candidate.installer, installArgs(candidate, runtime, true), env);
    await assertPythonApplicationDeclaration(candidate.manifest, payload);
    const homebrew = await formulaCache(candidate, prefix, payload);
    // The staged signed candidate owns activation, including migration from
    // the authenticated predecessor. Its acquisition path is the formula cache.
    await command(homebrew.installer, installArgs(homebrew, runtime), env);
    await command(selector, ["start", "--no-open"], env);
    const activated = await status();
    assert.equal(activated.status, "running");
    for (const name of ["postgres", "worker", "api"]) assert.equal(activated.components[name].state, "running");
    assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
    assert.equal(JSON.parse((await command(homebrew.frontend, ["version", "--json"], env)).output).buildId, candidate.descriptor.buildId);
    assertRetainedBusinessState(await businessState(), baseline);
    checked.push("signed-candidate-activated-through-actual-installer", "actual-postgresql-worker-and-api-ready", "public-business-state-preserved");

    if (isPostgres) {
      await publicRequest("/v1/settings", "PATCH", {
        expectedRevision: baseline.settings.revision, targetCriteria: "Owned rollback probe",
      });
      await command(selector, ["rollback", "--to", old.descriptor.buildId], env);
      await command(selector, ["start", "--no-open"], env);
      assert.equal(JSON.parse((await command(selector, ["version", "--json"], env)).output).buildId, old.descriptor.buildId);
      assertRetainedBusinessState(await businessState(), baseline);
      await command(homebrew.installer, installArgs(homebrew, runtime), env);
      await command(selector, ["start", "--no-open"], env);
      assertRetainedBusinessState(await businessState(), baseline);
      checked.push("explicit-postgresql-rollback-restores-predecessor-state", "candidate-reselected-after-postgresql-rollback");
    }

    const afterActivation = await publicRequest("/v1/settings", "PATCH", {
      expectedRevision: baseline.settings.revision, targetCriteria: "Accepted write after candidate activation",
    });
    const backup = path.join(root, "backup");
    await command(selector, ["backup", "--output", backup], env);
    const backupDirectories = await readdir(backup);
    assert.equal(backupDirectories.length, 1, "native backup must publish one complete snapshot");
    const [backupId] = backupDirectories;
    assert.match(backupId, /^pair-[a-f0-9]+$/);
    const backupPath = path.join(backup, backupId);
    const pair = await json(path.join(backupPath, "pair.json"));
    assert.equal(pair.id, backupId);
    assert.equal(pair.schemaVersion, 2);
    assert.equal(pair.releaseReceipt.buildId, candidate.descriptor.buildId);
    assert.deepEqual(pair.files.map(({ name }) => name).sort(), [".jobctrl-postgres-identity", "postgres.tar"]);
    for (const { name, sha256 } of pair.files) assert.equal(await hash(path.join(backupPath, name)), sha256);
    const postgresVersion = await command("/usr/bin/tar", ["-xOf", path.join(backupPath, "postgres.tar"), "PG_VERSION"], env);
    assert.equal(postgresVersion.output.trim(), String(POSTGRES_APPLICATION.major));
    checked.push("post-activation-public-write", "native-postgresql-backup");

    if (fingerprints) {
      const rollback = await command(selector, ["rollback", "--to", old.descriptor.buildId], env, { allowFailure: true });
      assert.ok(Number.isInteger(rollback.code) && rollback.code !== 0, "SQLite rollback must refuse after PostgreSQL activation");
      assert.deepEqual(await sourceFingerprints(state), fingerprints);
      checked.push("cross-engine-rollback-refused", "stopped-source-sqlite-and-temporal-retained-exactly");
    }

    await command(selector, ["stop"], env);
    assert.equal((await status()).status, "stopped");
    await command(selector, ["start", "--no-open"], env);
    assert.equal((await publicRequest("/v1/health")).worker.status, "healthy");
    assertRetainedBusinessState(await businessState(), { ...baseline, settings: afterActivation });
    if (fingerprints) assert.deepEqual(await sourceFingerprints(state), fingerprints);
    checked.push("actual-candidate-stop-and-restart", "post-activation-write-retained");

    return {
      sourceVersion: old.descriptor.appVersion, sourceBuildId: old.descriptor.buildId,
      sourceArtifactSha256: old.descriptor.artifact.sha256, sourceApplication: identity,
      targetBuildId: candidate.descriptor.buildId, targetApplication: POSTGRES_APPLICATION,
      mode, status: "passed", checks: checked,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await command(selector, ["stop"], env); }
    catch (error) { if (failure) failure.message += `\nCleanup failed: ${error.message}`; else throw error; }
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
