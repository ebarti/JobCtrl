#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASED_UPGRADE_CASES = Object.freeze([
  ...["0.1.0", "0.1.1", "0.2.0", "0.2.1", "0.3.0"].map((version) => ({ id: `from-${version}`, version, kind: "ordinary" })),
  { id: "readiness-0.2.1", version: "0.2.1", kind: "readiness" },
  { id: "recovery-0.2.1", version: "0.2.1", kind: "recovery" },
  { id: "unused-0.2.1", version: "0.2.1", kind: "unused" },
]);

export function releasedUpgradeCase(id) {
  const selected = RELEASED_UPGRADE_CASES.find((entry) => entry.id === id);
  assert.ok(selected, `unknown released-upgrade case: ${id}`);
  return selected;
}

const commonChecks = ["source-job-preserved", "temporal-workflow-history-preserved", "verified-paired-backup", "explicit-rollback-to-released-payload", "homebrew-frontend-preserves-rollback", "explicit-homebrew-reupdate-after-rollback"];
export function requiredUpgradeChecks(kind) {
  if (kind === "unused") return ["unused-installation-upgrade", "verified-paired-backup", "explicit-rollback-to-released-payload", "unrelated-file-preserved"];
  if (kind === "ordinary") return [...commonChecks, "historical-updater-successful-promotion"];
  if (kind === "readiness") return [...commonChecks, "historical-updater-readiness-failure", "corrected-selector-interrupted-rollback", "new-installer-owns-staged-activation", "corrected-updater-automatic-paired-rollback"];
  assert.equal(kind, "recovery");
  return [...commonChecks, "recovered-preexisting-0.3.0-failure-through-new-formula", "corrected-controller-successful-promotion"];
}

export function combineReleasedUpgradeReports(reports, candidateBuildId) {
  assert.match(candidateBuildId, /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/);
  assert.equal(reports.length, RELEASED_UPGRADE_CASES.length, "every released-upgrade case is required");
  const seen = new Set();
  for (const report of reports) {
    const selected = releasedUpgradeCase(report.caseId);
    assert.ok(!seen.has(report.caseId), `duplicate released-upgrade case: ${report.caseId}`);
    seen.add(report.caseId);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, "passed");
    assert.equal(report.candidateBuildId, candidateBuildId);
    assert.equal(report.acquisitionBoundary, "signed-formula-cache-adapter");
    assert.equal(report.executables, "actual-released-sources-and-signed-candidate");
    assert.ok(Number.isSafeInteger(report.elapsedMs) && report.elapsedMs > 0);
    assert.equal(report.results.length, 1);
    const result = report.results[0];
    assert.equal(result.status, "passed");
    assert.equal(result.sourceVersion, selected.version);
    assert.equal(result.targetBuildId, candidateBuildId);
    assert.match(result.sourceBuildId, /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/);
    assert.match(result.sourceArtifactSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(result.sourceSchema) && result.sourceSchema >= 0);
    assert.ok(Array.isArray(result.checks) && result.checks.every((check) => typeof check === "string"));
    assert.equal(result.unusedInstallation === true, selected.kind === "unused");
    for (const check of requiredUpgradeChecks(selected.kind)) assert.ok(result.checks.includes(check), `${report.caseId} is missing ${check}`);
  }
  const ordered = RELEASED_UPGRADE_CASES.map((entry) => reports.find((report) => report.caseId === entry.id));
  return { schemaVersion: 1, status: "passed", candidateBuildId, acquisitionBoundary: "signed-formula-cache-adapter", executables: "actual-released-sources-and-signed-candidate", cases: ordered.map((report) => ({ caseId: report.caseId, elapsedMs: report.elapsedMs })), results: ordered.flatMap((report) => report.results) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, candidateBuildId, output] = process.argv.slice(2);
  assert.ok(directory && candidateBuildId && output, "usage: released-upgrade-cases.mjs REPORT_DIRECTORY BUILD_ID OUTPUT");
  const files = await readdir(directory);
  assert.equal(files.length, RELEASED_UPGRADE_CASES.length, "unexpected or missing case artifacts");
  const reports = await Promise.all(files.map(async (file) => {
    assert.ok(file.endsWith(".json"), "case artifact must be JSON");
    return JSON.parse(await readFile(path.join(directory, file), "utf8"));
  }));
  await writeFile(output, `${JSON.stringify(combineReleasedUpgradeReports(reports, candidateBuildId), null, 2)}\n`, { mode: 0o600 });
}
