import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { selectLatestReleasedVersion, selectUpgradeMode } from "./released-upgrade-smoke.mjs";

const published = (version, day, extra = {}) => ({ tag_name: `v${version}`, published_at: `2026-10-${day}T10:00:00Z`, draft: false, prerelease: false, ...extra });

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

test("verification modules load without installing application development dependencies", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jobctrl-proof-no-dependencies-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL(".", import.meta.url), path.join(directory, "scripts"), { recursive: true });
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(directory, "scripts/released-upgrade-smoke.mjs")).href)});`], { cwd: directory, env: { PATH: process.env.PATH } });
});
