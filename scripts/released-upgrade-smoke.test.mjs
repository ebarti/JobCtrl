import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fetchPublishedReleases, interruptReleaseAtCheckpoint, isKnownLegacyRefusal, runForwardInterruptionMatrix, scenario, selectLatestReleasedVersion, selectUpgradeMode, verifyLegacyRefusal } from "./released-upgrade-smoke.mjs";

import { acquisitionChildEnvironment, prepareScopedWorkspace, runPublishedAcquisitionUpgrades } from "./released-acquisition-upgrade.mjs";

const published = (version, day, extra = {}) => ({ tag_name: `v${version}`, published_at: `2026-10-${day}T10:00:00Z`, draft: false, prerelease: false, ...extra });

test("upgrade setup reports the installer failure even when no selector was created", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-upgrade-error-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const installer = path.join(root, "failing-installer");
  await writeFile(installer, "#!/bin/sh\necho 'synthetic installer failure' >&2\nexit 23\n", { mode: 0o700 });
  const old = { installer, directory: root, archive: path.join(root, "unused.zip"), descriptor: { appVersion: "0.3.1", buildId: "synthetic" } };
  await assert.rejects(scenario(old, {}, path.join(root, "fixture")), (error) => {
    assert.match(error.message, /synthetic installer failure/);
    assert.match(error.message, /cleanup failed:.*ENOENT/s);
    return true;
  });
});

test("the upgrade source advances to the latest published stable release", () => {
  const releases = [published("0.3.0", "18"), published("0.3.1", "19"), published("0.4.0", "20", { draft: true }), published("0.4.0-rc.1", "20", { prerelease: true })];
  assert.equal(selectLatestReleasedVersion(releases, "0.3.2"), "0.3.1");
  releases.push(published("0.3.2", "20"));
  assert.equal(selectLatestReleasedVersion(releases, "0.3.3"), "0.3.2");
  assert.equal(selectLatestReleasedVersion(releases, "0.3.2"), "0.3.1", "a published-candidate rerun must still exercise its predecessor");
});

test("missing or malformed stable release metadata fails instead of using a historical fallback", () => {
  assert.throws(() => selectLatestReleasedVersion([published("0.3.1", "19")], "0.3.1"), /no previous/);
  for (const tag of ["invalid", "0.3.1/../../bin/tool", "0.3.1;tool", "0.3.1\n"]) {
    assert.throws(() => selectLatestReleasedVersion([published(tag, "19")], "0.3.2"), /stable release tag/);
  }
  assert.throws(() => selectLatestReleasedVersion([published("0.3.1", "invalid")], "0.3.2"), /publication date/);
});

test("released upgrade qualification distinguishes the forward schema transition from compatible rollback", () => {
  const protocol = (minimum, maximum) => ({ launcherCompatibility: { minimum, maximum } });
  assert.equal(selectUpgradeMode(protocol(1, 1), protocol(2, 2), 14), "forward-schema-15");
  assert.equal(selectUpgradeMode(protocol(2, 2), protocol(2, 2), 15), "compatible");
  assert.equal(selectUpgradeMode(protocol(1, 1), protocol(1, 2), 14), "compatible");
  assert.throws(() => selectUpgradeMode(protocol(1, 2), protocol(1, 2), 14), /unsupported released upgrade/);
  assert.throws(() => selectUpgradeMode(protocol(1, 1), protocol(2, 2), 13), /unsupported released upgrade/);
  assert.throws(() => selectUpgradeMode(protocol(1, 1), protocol(3, 3), 14), /unsupported released upgrade/);
  assert.throws(() => selectUpgradeMode(protocol(1, 1), protocol(2, 1), 14), /invalid launcher compatibility/);
  assert.throws(() => selectUpgradeMode(protocol(1, 1), protocol(1, 1), 0), /invalid source schema/);
});

test("legacy refusal is limited to the documented release pair", () => {
  const release = (appVersion) => ({ descriptor: { appVersion } });
  assert.equal(isKnownLegacyRefusal(release("0.3.1"), release("0.4.0"), "forward-schema-15"), true);
  assert.equal(isKnownLegacyRefusal(release("0.3.1"), release("0.4.1"), "forward-schema-15"), true);
  assert.equal(isKnownLegacyRefusal(release("0.3.1"), release("0.4.2"), "forward-schema-15"), false);
  assert.equal(isKnownLegacyRefusal(release("0.3.0"), release("0.4.0"), "forward-schema-15"), false);
  assert.equal(isKnownLegacyRefusal(release("0.3.1"), release("0.4.0"), "compatible"), false);
});

test("legacy refusal proof requires the real error and preserves both data and runtime evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-legacy-refusal-proof-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime"), state = path.join(root, "state");
  await mkdir(path.join(runtime, "bin"), { recursive: true });
  await mkdir(state, { recursive: true });
  const canonical = await realpath(state);
  const id = createHash("sha256").update(canonical).digest("hex");
  const registry = path.join(runtime, "instances", id, "state.json");
  await mkdir(path.dirname(registry), { recursive: true });
  const app = path.join(state, "jobctrl.db"), history = path.join(state, "temporal.db");
  for (const file of [app, history, registry, path.join(runtime, "active.json"), path.join(runtime, "bin", "jobctrl")]) await writeFile(file, "synthetic evidence");
  const refusal = { code: 1, output: "this legacy runtime has no durable child-ownership record" };
  const proof = { root, runtime, state, history };
  await verifyLegacyRefusal({ ...proof, invoke: async () => refusal });
  await assert.rejects(verifyLegacyRefusal({ ...proof, invoke: async () => ({ code: 0, output: refusal.output }) }), /explicitly refuse/);
  await assert.rejects(verifyLegacyRefusal({ ...proof, invoke: async () => ({ code: 1, output: "different failure" }) }), /actual ownership problem/);
  await assert.rejects(verifyLegacyRefusal({ ...proof, invoke: async () => { await writeFile(app, "changed"); return refusal; } }), /must preserve/);
  await assert.rejects(verifyLegacyRefusal({ ...proof, invoke: async () => { await writeFile(registry, "changed"); return refusal; } }), /must preserve/);
  let invoked = false;
  await assert.rejects(verifyLegacyRefusal({ ...proof, root: "/", invoke: async () => { invoked = true; return refusal; } }), /isolated temporary workspace/);
  assert.equal(invoked, false);
});

test("verification modules load without installing application development dependencies", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jobctrl-proof-no-dependencies-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL(".", import.meta.url), path.join(directory, "scripts"), { recursive: true });
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(directory, "scripts/released-upgrade-smoke.mjs")).href)});`], { cwd: directory, env: { PATH: process.env.PATH } });
});

test("release checkpoint interrupts its owned process group and rejects an absent marker", { skip: process.platform === "win32" }, async () => {
  const script = `process.stderr.write("jobctrl-release-qa-checkpoint:pair_"); setTimeout(() => { process.stderr.write("backed_up\\n"); setInterval(() => {}, 1000); }, 10)`;
  const result = await interruptReleaseAtCheckpoint(process.execPath, ["-e", script], process.env, "pair_backed_up");
  assert.equal(result.signal, "SIGKILL");
  await assert.rejects(interruptReleaseAtCheckpoint(process.execPath, ["-e", "process.exit(0)"], process.env, "metadata_verified"), /exited before metadata_verified/);
});

test("forward release matrix refuses a workspace outside its fixture before writing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-matrix-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture"), runtime = path.join(fixture, "runtime"), state = path.join(fixture, "state"), other = path.join(root, "other");
  await Promise.all([mkdir(runtime, { recursive: true }), mkdir(state, { recursive: true }), mkdir(other)]);
  const candidate = { descriptor: { buildId: "synthetic" } };
  await assert.rejects(runForwardInterruptionMatrix({ candidate, root: fixture, runtime, state, env: { JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: other }, selector: path.join(runtime, "bin/jobctrl"), payload: path.join(runtime, "releases/synthetic/payload") }), /fixture workspace/);
  await assert.rejects(stat(path.join(fixture, ".jobctrl-release-qa")), { code: "ENOENT" });
});

test("release metadata uses a fixed GitHub API and withholds credentials from child processes", async () => {
  let request;
  const releases = await fetchPublishedReleases("synthetic-token", async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => [published("0.3.1", "19")] };
  });
  assert.equal(releases[0].tag_name, "v0.3.1");
  assert.equal(request.url, "https://api.github.com/repos/ebarti/JobCtrl/releases?per_page=100");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer synthetic-token");
  const child = acquisitionChildEnvironment({ HOME: "/synthetic", JOBCTRL_RELEASE_METADATA_TOKEN: "synthetic-token", GH_TOKEN: "synthetic-token", GITHUB_TOKEN: "synthetic-token", ACTIONS_RUNTIME_TOKEN: "synthetic-token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-token" });
  assert.equal(child.HOME, "/synthetic");
  assert.equal(Object.values(child).includes("synthetic-token"), false);
  await assert.rejects(fetchPublishedReleases(undefined, async () => ({ ok: false, status: 403 })), /HTTP 403/);
});

test("release acquisition rejects unknown predecessor installation modes", async () => {
  await assert.rejects(runPublishedAcquisitionUpgrades({ homebrewSource: "unsupported" }), /invalid Homebrew source acquisition/);
});

test("scoped acquisition qualification refuses a non-fixture workspace before starting processes", async () => {
  await assert.rejects(prepareScopedWorkspace({ descriptor: { buildId: "synthetic" } }, "/", "/", "/", {}), /isolated temporary workspace/);
});
