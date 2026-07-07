import assert from "node:assert/strict";
import test from "node:test";

import { discoveryProvenance, gateableRecordRejectionReasons, summarizeMeasurementRecords } from "./ttfv-real.mjs";

const WORK_COMMAND = "uv --project workers/automation run jobctl run discover score tailor --limit 1 --workers 1";
const JOB_HASH = "jobhash00000001";

function validRecord(overrides = {}) {
  const jobHash = overrides.jobHash ?? JOB_HASH;
  return {
    schemaVersion: 1,
    kind: "jobctl.realPathTtfvMeasurement",
    mode: "run",
    status: "passed",
    gateable: true,
    gateableReason: null,
    expected: null,
    baseline: {
      capturedAt: "2026-07-06T00:00:30.000Z",
      visibilityFilter: "all",
      jobCount: 0,
      jobHashes: [],
      ...(overrides.baseline ?? {}),
    },
    policy: {
      realPathOnly: true,
      syntheticDataAllowed: false,
      ciAllowed: false,
    },
    urls: {
      apiBaseUrl: overrides.apiBaseUrl ?? "http://127.0.0.1:8766",
      webBaseUrl: overrides.webBaseUrl ?? "http://127.0.0.1:5173",
    },
    thresholds: {
      ttfv1Ms: overrides.thresholdTtfv1Ms ?? 600_000,
      ttfv2Ms: overrides.thresholdTtfv2Ms ?? 1_800_000,
      worstRunCeilingMultiplier: overrides.worstMultiplier ?? 1.5,
      requiredRuns: overrides.requiredRuns ?? 3,
    },
    t0: {
      command: "corepack pnpm install:interactive",
      startedAt: "2026-07-06T00:00:00.000Z",
    },
    phases: [
      { name: "install", command: "corepack pnpm install:interactive", exitCode: 0 },
      { name: "workspace_init", command: "uv --project workers/automation run jobctl init", exitCode: 0 },
      { name: "stack_start", command: "corepack pnpm dev", status: "healthy" },
      {
        name: "real_job_pipeline",
        command: overrides.workCommand ?? WORK_COMMAND,
        exitCode: 0,
      },
    ],
    probes: {
      ttfv1: {
        status: "passed",
        durationMs: overrides.ttfv1DurationMs ?? 60_000,
        api: {
          selectedJobHash: jobHash,
          selectedFitScore: 8,
          selectedDiscoveredAt: "2026-07-06T00:05:00.000Z",
          selectedDiscoverySourceHash: "sourcehash00001",
          selectedSourceHash: "sourcehash00002",
          realDiscoverySource: true,
          discoveredAfterT0: true,
          ...(overrides.ttfv1Api ?? {}),
        },
        ui: {
          selectedJobRendered: true,
          badgeMatched: true,
          ...(overrides.ttfv1Ui ?? {}),
        },
      },
      ttfv2: {
        status: "passed",
        durationMs: overrides.ttfv2DurationMs ?? 120_000,
        api: {
          selectedJobHash: overrides.ttfv2JobHash ?? jobHash,
          selectedArtifactHash: "artifacthash0001",
        },
        ui: {
          linkMatchedSelectedArtifact: true,
        },
        artifact: {
          status: 200,
          byteLength: 1234,
          magicBytes: "25504446",
        },
      },
    },
    errors: [],
  };
}

function reasons(record) {
  return gateableRecordRejectionReasons(record);
}

test("accepts a complete discovery-inclusive real-path record", () => {
  assert.deepEqual(reasons(validRecord()), []);
});

test("rejects records measured against non-default probe URLs", () => {
  assert.match(
    reasons(validRecord({ apiBaseUrl: "http://127.0.0.1:9876" })).join("\n"),
    /non-default API probe URL/,
  );
  assert.match(
    reasons(validRecord({ webBaseUrl: "http://127.0.0.1:9999" })).join("\n"),
    /non-default web probe URL/,
  );
});

test("rejects records whose owner thresholds were overridden", () => {
  assert.match(
    reasons(validRecord({ thresholdTtfv1Ms: 999_999_999 })).join("\n"),
    /owner TTFV thresholds missing or overridden/,
  );
});

test("summaries ignore and fail unsupported threshold overrides", () => {
  const records = ["one", "two", "three"].map((file) => ({
    file,
    record: validRecord({
      ttfv1DurationMs: 700_000,
      ttfv2DurationMs: 1_900_000,
    }),
  }));

  const summary = summarizeMeasurementRecords(records, {
    thresholdTtfv1Ms: 999_999_999,
    thresholdTtfv2Ms: 999_999_999,
    worstMultiplier: 99,
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.thresholds.ttfv1Ms, 600_000);
  assert.equal(summary.thresholds.ttfv2Ms, 1_800_000);
  assert.equal(summary.thresholds.worstRunCeilingMultiplier, 1.5);
  assert.match(summary.configurationErrors.join("\n"), /owner thresholds are fixed/);
  assert.equal(summary.ttfv1.passed, false);
  assert.equal(summary.ttfv2.passed, false);
});

test("rejects records whose measured job is already in the all-state baseline", () => {
  assert.match(
    reasons(validRecord({ baseline: { jobHashes: [JOB_HASH] } })).join("\n"),
    /measurement job was already present in the pre-work baseline/,
  );
});

test("rejects baselines that do not cover all job visibility states", () => {
  assert.match(
    reasons(validRecord({ baseline: { visibilityFilter: "active" } })).join("\n"),
    /baseline did not include all job visibility states/,
  );
});

test("rejects records without baseline job hashes", () => {
  const record = validRecord();
  delete record.baseline.jobHashes;
  assert.match(reasons(record).join("\n"), /baseline hashes missing/);
});

test("rejects records without post-T0 discoveredAt proof", () => {
  assert.match(
    reasons(
      validRecord({
        ttfv1Api: {
          selectedDiscoveredAt: "2026-07-05T23:59:59.000Z",
          discoveredAfterT0: true,
        },
      }),
    ).join("\n"),
    /discoveredAt is missing or before T0/,
  );
});

test("rejects records without real discovery-source provenance", () => {
  assert.match(
    reasons(
      validRecord({
        ttfv1Api: {
          selectedDiscoverySourceHash: null,
          selectedSourceHash: null,
          selectedPostingSourceHash: null,
          realDiscoverySource: false,
        },
      }),
    ).join("\n"),
    /real discovery source proof missing/,
  );
});

test("rejects records whose discovery-source proof is only an unknown fallback", () => {
  assert.match(
    reasons(
      validRecord({
        ttfv1Api: {
          realDiscoverySource: false,
          selectedDiscoverySourceHash: "unknownhash0001",
          selectedSourceHash: "unknownhash0002",
        },
      }),
    ).join("\n"),
    /real discovery source proof missing/,
  );
});

test("classifies unknown source labels as non-real discovery provenance", () => {
  assert.equal(
    discoveryProvenance({
      discoverySource: "unknown",
      source: "unknown",
      postingSource: "",
    }).realDiscoverySource,
    false,
  );
});

test("rejects old tailor-only work-command records", () => {
  assert.match(
    reasons(
      validRecord({
        workCommand: "uv --project workers/automation run jobctl job <redacted-real-job-url> --tailor",
      }),
    ).join("\n"),
    /discovery-inclusive real job command did not succeed/,
  );
});

test("rejects TTFV-2 records bound to a different job", () => {
  assert.match(
    reasons(validRecord({ ttfv2JobHash: "differentjobhash" })).join("\n"),
    /TTFV-2 probe is not bound to the measurement job/,
  );
});
