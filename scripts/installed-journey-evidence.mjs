import { createHash as createCaseHash } from "node:crypto";
import { readFile as readShardFile, readdir as listShardDirectories } from "node:fs/promises";
import { join } from "node:path";

export const INSTALLED_JOURNEY_SHARDS = 4;

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`installed journey qualification: ${message}`);
}

function caseSet(ids) {
  requireEvidence(Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string" && id.length > 0), "missing case IDs");
  const cases = new Set(ids);
  requireEvidence(cases.size === ids.length, "duplicate case IDs");
  return cases;
}

function caseDigest(ids) {
  return createCaseHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex");
}

export function chromiumCaseIds(report, shard = null) {
  const projects = report.config.projects;
  requireEvidence(projects.length === 1 && projects[0].name === "chromium"
    && projects[0].repeatEach === 1 && projects[0].retries === 0, "expected Chromium with one attempt per case");
  requireEvidence(shard === null ? report.config.shard === null
    : report.config.shard?.current === shard && report.config.shard.total === INSTALLED_JOURNEY_SHARDS, "unexpected shard selection");
  requireEvidence(report.errors.length === 0, "browser runner reported errors");
  const ids = [];
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs) {
        const [test] = spec.tests;
        requireEvidence(spec.tests.length === 1 && test.projectName === "chromium"
          && test.expectedStatus === "passed", `case is not required to pass: ${spec.title}`);
        if (shard !== null) {
          requireEvidence(test.status === "expected" && test.results.length === 1
            && test.results[0].status === "passed", `case did not pass: ${spec.title}`);
        }
        ids.push(spec.id);
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites);
  caseSet(ids);
  if (shard !== null) requireEvidence(report.stats.expected === ids.length
    && report.stats.skipped === 0 && report.stats.unexpected === 0 && report.stats.flaky === 0, "case totals do not match the passing results");
  return ids.sort();
}

export function installedJourneyPlan(build) {
  const plan = build.smoke?.applicationJourneys;
  requireEvidence(build.mode === "real" && build.smoke?.status === "pending-installed-journeys"
    && build.smoke.postSmokePayloadTree === "exact-manifest-match" && plan?.status === "pending", "missing deferred qualification plan");
  const { buildId, archiveSha256, manifestSha256 } = build;
  requireEvidence(typeof buildId === "string" && /^[a-f0-9]{64}$/.test(archiveSha256)
    && /^[a-f0-9]{64}$/.test(manifestSha256) && /^[a-f0-9]{40}$/.test(plan.sourceCommit), "invalid candidate identity");
  return { identity: { buildId, archiveSha256, manifestSha256, sourceCommit: plan.sourceCommit }, expected: caseSet(plan.caseIds) };
}

export async function verifyInstalledJourneyClosure(build, directory) {
  const { identity, expected } = installedJourneyPlan(build);
  const selected = new Map();
  for (const entry of await listShardDirectories(directory, { withFileTypes: true })) {
    const match = /^jobctrl-installed-journeys-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(entry.name);
    requireEvidence(entry.isDirectory() && match, `unexpected shard report directory ${entry.name}`);
    const shard = Number(match[1]);
    const attempt = Number(match[2]);
    requireEvidence(shard <= INSTALLED_JOURNEY_SHARDS && Number.isSafeInteger(attempt), `invalid shard or attempt in ${entry.name}`);
    if (!selected.has(shard) || attempt > selected.get(shard).attempt) selected.set(shard, { name: entry.name, attempt });
  }
  requireEvidence(selected.size === INSTALLED_JOURNEY_SHARDS, `expected ${INSTALLED_JOURNEY_SHARDS} passing shards, found ${selected.size}`);
  const results = [];
  for (const [shard, { name }] of [...selected].sort(([left], [right]) => left - right)) {
    const result = JSON.parse(await readShardFile(join(directory, name, "qualification.json"), "utf8"));
    requireEvidence(result.status === "pass" && result.shard === shard
      && Object.entries(identity).every(([key, value]) => result[key] === value), `shard ${shard} does not bind the qualified candidate`);
    requireEvidence(Number.isSafeInteger(result.journeysMs) && result.journeysMs > 0, `shard ${shard} has no measured duration`);
    for (const id of caseSet(result.caseIds)) {
      requireEvidence(expected.delete(id), `shard ${shard} contains an unknown or repeated case ${id}`);
    }
    results.push({ shard, caseCount: result.caseIds.length, caseIdsSha256: caseDigest(result.caseIds), journeysMs: result.journeysMs });
  }
  requireEvidence(expected.size === 0, `missing ${expected.size} planned Chromium cases`);
  const { caseIds } = build.smoke.applicationJourneys;
  return { status: "pass", ...identity, caseCount: caseIds.length, caseIdsSha256: caseDigest(caseIds), shards: results };
}
