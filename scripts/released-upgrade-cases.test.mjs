import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { RELEASED_UPGRADE_CASES, combineReleasedUpgradeReports, releasedUpgradeCase } from "./released-upgrade-cases.mjs";

const target = "0.3.1-0123456789abcdef-darwin-arm64";
const common = ["source-job-preserved", "temporal-workflow-history-preserved", "verified-paired-backup", "explicit-rollback-to-released-payload", "homebrew-frontend-preserves-rollback", "explicit-homebrew-reupdate-after-rollback"];
function reports() {
  return RELEASED_UPGRADE_CASES.map(({ id, version, kind }) => {
    const checks = kind === "ordinary" ? [...common, "historical-updater-successful-promotion"]
      : kind === "readiness" ? [...common, "historical-updater-readiness-failure", "corrected-selector-interrupted-rollback", "new-installer-owns-staged-activation", "corrected-updater-automatic-paired-rollback"]
        : kind === "recovery" ? [...common, "recovered-preexisting-0.3.0-failure-through-new-formula", "corrected-controller-successful-promotion"]
          : ["unused-installation-upgrade", "verified-paired-backup", "explicit-rollback-to-released-payload", "unrelated-file-preserved"];
    return { schemaVersion: 1, status: "passed", candidateBuildId: target, caseId: id, elapsedMs: 1234,
      acquisitionBoundary: "signed-formula-cache-adapter", executables: "actual-released-sources-and-signed-candidate",
      results: [{ sourceVersion: version, sourceBuildId: `${version}-0123456789abcdef-darwin-arm64`, sourceArtifactSha256: "a".repeat(64), sourceSchema: 11, targetBuildId: target, status: "passed", ...(kind === "unused" ? { unusedInstallation: true } : {}), checks }] };
  });
}

test("every ordinary version and separate fault, recovery and unused case has an explicit selector", () => {
  assert.deepEqual(RELEASED_UPGRADE_CASES.map((entry) => entry.id), ["from-0.1.0", "from-0.1.1", "from-0.2.0", "from-0.2.1", "from-0.3.0", "readiness-0.2.1", "recovery-0.2.1", "unused-0.2.1"]);
  assert.equal(releasedUpgradeCase("from-0.2.1").kind, "ordinary");
  assert.equal(releasedUpgradeCase("readiness-0.2.1").kind, "readiness");
  assert.throws(() => releasedUpgradeCase("from-0.2.2"), /unknown/);
});

test("aggregation accepts all eight cases in arbitrary runner completion order", () => {
  const combined = combineReleasedUpgradeReports(reports().reverse(), target);
  assert.equal(combined.status, "passed");
  assert.equal(combined.results.length, 8);
  assert.deepEqual(combined.cases.map((entry) => entry.caseId), RELEASED_UPGRADE_CASES.map((entry) => entry.id));
  assert.ok(combined.cases.every((entry) => entry.elapsedMs === 1234));
});

test("aggregation rejects missing, duplicate and unknown cases", () => {
  assert.throws(() => combineReleasedUpgradeReports(reports().slice(1), target), /every/);
  const duplicate = reports(); duplicate[7] = structuredClone(duplicate[0]);
  assert.throws(() => combineReleasedUpgradeReports(duplicate, target), /duplicate/);
  const unknown = reports(); unknown[0].caseId = "unexpected";
  assert.throws(() => combineReleasedUpgradeReports(unknown, target), /unknown/);
});

for (const [label, corrupt] of [
  ["different report candidate", (r) => { r.candidateBuildId = "different-candidate"; }],
  ["different result candidate", (r) => { r.results[0].targetBuildId = "different-candidate"; }],
  ["different historical version", (r) => { r.results[0].sourceVersion = "0.2.2"; }],
  ["failed execution", (r) => { r.status = "failed"; }],
  ["failed result", (r) => { r.results[0].status = "failed"; }],
  ["non-binary proof", (r) => { r.executables = "fixture"; }],
  ["missing source digest", (r) => { delete r.results[0].sourceArtifactSha256; }],
  ["missing ordinary promotion", (r) => { r.results[0].checks = common; }],
  ["string instead of a check list", (r) => { r.results[0].checks = r.results[0].checks.join(","); }],
  ["missing timing", (r) => { delete r.elapsedMs; }],
]) test(`aggregation refuses ${label}`, () => {
  const input = reports(); corrupt(input[0]);
  assert.throws(() => combineReleasedUpgradeReports(input, target));
});

test("fault recovery and unused-file preservation remain mandatory", () => {
  for (const [id, required] of [["readiness-0.2.1", "corrected-updater-automatic-paired-rollback"], ["recovery-0.2.1", "recovered-preexisting-0.3.0-failure-through-new-formula"], ["unused-0.2.1", "unrelated-file-preserved"]]) {
    const input = reports(); const result = input.find((entry) => entry.caseId === id).results[0];
    result.checks = result.checks.filter((check) => check !== required);
    assert.throws(() => combineReleasedUpgradeReports(input, target), /missing/);
  }
});

test("verification modules load without installing unrelated application dependencies", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jobctrl-proof-no-dependencies-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL(".", import.meta.url), path.join(directory, "scripts"), { recursive: true });
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(directory, "scripts/released-upgrade-smoke.mjs")).href)});`], { cwd: directory, env: { PATH: process.env.PATH } });
});
