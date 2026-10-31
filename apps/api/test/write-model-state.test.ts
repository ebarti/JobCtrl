import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  queueRetriedJobsForWorkflow,
  resolveJobId,
} from "../src/write-model.js";
import { resetJobStageWithEnrichmentOwner, retryFailedJobsWithEnrichmentOwner } from "../src/enrichment-retry.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { createRetryFixturePythonRuntime } from "./retry-rpc-runtime.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000041";
const JOB_URL = "https://jobs.example.test/platform-engineer";
const fixtures: Array<{ directory: string; db: Database.Database; rpc: SubprocessJsonRpcAdapter }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.rpc.close();
    fixture.db.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("exact-v7 write-model stage state", async () => {
  it("persists exact workflow ownership when an Enrich retry is queued", async () => {
    const fixture = createFixture();
    fixture.db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
       VALUES ('local', ?, ?, 'Platform Engineer', ?)`,
    ).run(JOB_ID, JOB_URL, "2026-07-31T09:00:00.000Z");
    fixture.db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, max_attempts, updated_at, retryable
       ) VALUES ('local', ?, 'enrich', 'pending', 0, 3, ?, 1)`,
    ).run(JOB_ID, "2026-07-31T09:00:00.000Z");

    queueRetriedJobsForWorkflow(
      fixture.db,
      [{ jobUrl: JOB_URL, stage: "enrich" }],
      { workflowId: "workflow-enrich-1", temporalRunId: "run-enrich-1" },
    );

    const row = fixture.db.prepare(
      `SELECT state, metadata_json FROM job_stage_states
       WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).get(JOB_ID) as { state: string; metadata_json: string };
    expect(row.state).toBe("queued");
    expect(JSON.parse(row.metadata_json)).toEqual({
      workflowId: "workflow-enrich-1",
      temporalRunId: "run-enrich-1",
    });
  });

  it("does not invent Enrich execution ownership from a workflow handle", async () => {
    const fixture = createFixture();
    fixture.db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
       VALUES ('local', ?, ?, 'Platform Engineer', ?)`,
    ).run(JOB_ID, JOB_URL, "2026-07-31T09:00:00.000Z");
    fixture.db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, max_attempts, updated_at, retryable
       ) VALUES ('local', ?, 'enrich', 'pending', 0, 3, ?, 1)`,
    ).run(JOB_ID, "2026-07-31T09:00:00.000Z");

    queueRetriedJobsForWorkflow(
      fixture.db,
      [{ jobUrl: JOB_URL, stage: "enrich" }],
      { workflowId: "workflow-enrich-without-execution" },
    );

    const row = fixture.db.prepare(
      `SELECT state, metadata_json FROM job_stage_states
       WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).get(JOB_ID) as { state: string; metadata_json: string | null };
    expect(row).toEqual({ state: "pending", metadata_json: null });
  });

  it("makes an exhausted stage retryable by resetting its attempt budget", async () => {
    const fixture = createFixture();
    fixture.db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
       VALUES ('local', ?, ?, 'Platform Engineer', ?)`,
    ).run(JOB_ID, JOB_URL, "2026-07-31T09:00:00.000Z");
    fixture.db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, max_attempts,
         updated_at, retryable, error_code, error_message
       ) VALUES ('local', ?, 'tailor', 'exhausted', 3, 3, ?, 0,
                 'TAILOR_QUALITY_GATE', 'No acceptable candidate')`,
    ).run(JOB_ID, "2026-07-31T09:00:00.000Z");

    const retried = await retryFailedJobsWithEnrichmentOwner(fixture.db, fixture.rpc, fixture, {
      allMatching: false,
      jobKeys: [JOB_ID],
    });
    const row = fixture.db.prepare(
      `SELECT state, attempt_count, retryable, error_code, error_message
         FROM job_stage_states
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'tailor'`,
    ).get(JOB_ID);
    const event = fixture.db.prepare(
      `SELECT payload_json FROM job_events
        WHERE tenant_id = 'local' AND job_id = ? AND event_type = 'StageReset'`,
    ).get(JOB_ID) as { payload_json: string };

    expect(retried).toMatchObject({
      count: 1,
      targets: [{ jobUrl: JOB_URL, stage: "tailor" }],
    });
    expect(row).toMatchObject({
      state: "pending",
      attempt_count: 0,
      retryable: 1,
      error_code: null,
      error_message: null,
    });
    expect(JSON.parse(event.payload_json)).toMatchObject({ reset_attempts: true });
  });

  it("resets and queues failed stages by tenant and JobId while accepting URL selections", async () => {
    const fixture = createFixture();
    fixture.db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
       VALUES ('local', ?, ?, 'Platform Engineer', ?)`,
    ).run(JOB_ID, JOB_URL, "2026-07-31T09:00:00.000Z");
    fixture.db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, max_attempts,
         updated_at, started_at, finished_at, duration_ms, retryable
       ) VALUES ('local', ?, 'score', 'failed', 2, 3, ?, ?, ?, 500, 1)`,
    ).run(JOB_ID, "2026-07-31T09:01:00.000Z", "2026-07-31T09:00:30.000Z", "2026-07-31T09:01:00.000Z");

    expect(resolveJobId(fixture.db, "local", JOB_URL)).toBe(JOB_ID);
    const retried = await retryFailedJobsWithEnrichmentOwner(fixture.db, fixture.rpc, fixture, { allMatching: false, jobKeys: [JOB_URL] });
    expect(retried).toMatchObject({
      count: 1,
      jobKeys: [JOB_ID],
      targets: [{ jobUrl: JOB_URL, stage: "score" }],
    });
    expect(stageRow(fixture.db)).toMatchObject({
      tenant_id: "local",
      job_id: JOB_ID,
      state: "pending",
      attempt_count: 2,
      started_at: null,
      finished_at: null,
      duration_ms: null,
    });

    queueRetriedJobsForWorkflow(fixture.db, retried.targets, {
      workflowId: "workflow-score-1",
      temporalRunId: "run-score-1",
    });
    expect(stageRow(fixture.db)).toMatchObject({ state: "queued", job_id: JOB_ID });

    const events = fixture.db.prepare(
      `SELECT tenant_id, job_id, identity_version, event_type, payload_json
       FROM job_events
       ORDER BY event_id`,
    ).all() as Array<{
      tenant_id: string;
      job_id: string;
      identity_version: number;
      event_type: string;
      payload_json: string;
    }>;
    expect(events.map((event) => event.event_type)).toEqual(["StageReset", "StageQueued"]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: "local", job_id: JOB_ID, identity_version: 1 }),
    ]));
    expect(JSON.parse(events[1]!.payload_json)).toMatchObject({
      tenantId: "local",
      jobId: JOB_ID,
      workflowId: "workflow-score-1",
      runId: "run-score-1",
    });

    const reset = await resetJobStageWithEnrichmentOwner(fixture.db, fixture.rpc, fixture, JOB_ID, "score", { resetAttempts: true });
    expect(reset).toMatchObject({ jobUrl: JOB_URL, stage: { state: "pending", attemptCount: 0 } });
    expect(stageRow(fixture.db)).toMatchObject({ state: "pending", attempt_count: 0, job_id: JOB_ID });
  });
});

function createFixture(): { directory: string; appDir: string; dbPath: string; db: Database.Database; rpc: SubprocessJsonRpcAdapter } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-write-model-state-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const rpc = new SubprocessJsonRpcAdapter({
    appDir: directory, pythonRuntime: createRetryFixturePythonRuntime(),
  });
  const fixture = { directory, appDir: directory, dbPath, db: new Database(dbPath), rpc };
  fixtures.push(fixture);
  return fixture;
}

function resetJobStage(db: Database.Database, jobId: string, stage: "apply", options: { resetAttempts: boolean }) {
  const fixture = fixtures.find((entry) => entry.db === db);
  if (!fixture) throw new Error("Retry fixture does not own this database");
  return resetJobStageWithEnrichmentOwner(db, fixture.rpc, {
    appDir: fixture.directory, dbPath: path.join(fixture.directory, "jobctrl.db"),
  }, jobId, stage, options);
}

function stageRow(db: Database.Database): Record<string, unknown> {
  return db.prepare(
    `SELECT tenant_id, job_id, state, attempt_count, started_at, finished_at, duration_ms
     FROM job_stage_states
     WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'`,
  ).get(JOB_ID) as Record<string, unknown>;
}

it.each(["pending", "failed", "needs_verification", "running"])("Skip from %s preserves intent, history, budget and safe reset refusal", async (prior) => {
  const { markJobSkipped, markJobApplied } = await import("../src/write-model.js");
  const { applySubmitIntentRunIds, applyIntentManuallyResolved } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply',?,2,3,'2026-10-24',0)").run(JOB_ID, prior);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','ApplySubmitIntended',?,'2026-10-24')").run(JOB_ID, JSON.stringify({ run_id: "original" }));
  markJobSkipped(db, JOB_ID, {});
  const skipped = db.prepare("SELECT * FROM job_stage_states WHERE job_id=?").get(JOB_ID);
  expect(skipped).toMatchObject({ state: prior === "needs_verification" ? prior : "skipped", attempt_count: 2, retryable: 0, error_code: null });
  expect(applySubmitIntentRunIds(db, "local", JOB_ID)).toEqual(["original"]);
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/intent|verification/);
  expect(db.prepare("SELECT * FROM job_stage_states WHERE job_id=?").get(JOB_ID)).toEqual(skipped);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job_events").get()).toEqual({ n: 2 });
  markJobApplied(db, JOB_ID, {});
  expect(db.prepare("SELECT state FROM job_stage_states WHERE job_id=?").get(JOB_ID)).toEqual({ state: "succeeded" });
  expect(applySubmitIntentRunIds(db, "local", JOB_ID)).toEqual(["original"]);
  expect(applyIntentManuallyResolved(db, "local", JOB_ID)).toBe(true);
});

it("safe reset releases only a local stop and retains the budget and previous events", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','failed',2,3,'2026-10-24',1)").run(JOB_ID);
  markJobSkipped(db, JOB_ID, {});
  expect((await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).stage).toMatchObject({ state: "pending", attemptCount: 2 });
  expect(db.prepare("SELECT event_type FROM job_events ORDER BY event_id").all()).toEqual([{ event_type: "StageSkipped" }, { event_type: "StageReset" }]);
  db.prepare("UPDATE job_stage_states SET state='running'").run();
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).rejects.toThrow(/active/);
});

it("safe reset binds the legacy API Skip event to its release frontier", async () => {
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','skipped',2,3,'2026-10-24',0)").run(JOB_ID);
  const skip = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,'apply','StageSkipped','Job marked skipped from the local API.','{}','2026-10-24')").run(JOB_ID);
  await resetJobStage(db, JOB_ID, 'apply', { resetAttempts: false });
  const event = db.prepare("SELECT payload_json FROM job_events WHERE tenant_id='local' AND job_id=? AND event_type='StageReset'").get(JOB_ID) as { payload_json: string };
  expect(JSON.parse(event.payload_json)).toMatchObject({ resetAuthority: 'explicit_safe_apply_reset', manualSkipReleasedThroughEventId: Number(skip.lastInsertRowid) });
});

it("keeps a legacy local Stop after an old owner settles and relabels the stage", async () => {
  const { hasManualApplyStop } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','pending',1,3,'2026-10-24',1)").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,?,'2026-10-24')");
  event.run(JOB_ID, "ApplyRunStarted", "Started.", JSON.stringify({ run_id: "legacy-owner" }));
  const skip = event.run(JOB_ID, "StageSkipped", "Job marked skipped from the local API.", JSON.stringify({ reason: "user reason" }));
  event.run(JOB_ID, "ApplicationFailed", "Previous owner finished.", JSON.stringify({ run_id: "legacy-owner", result: "failed" }));
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(true);
  await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false });
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(false);
  const release = db.prepare("SELECT payload_json FROM job_events WHERE tenant_id='local' AND job_id=? AND event_type='StageReset'").get(JOB_ID) as { payload_json: string };
  expect(JSON.parse(release.payload_json).manualSkipReleasedThroughEventId).toBe(Number(skip.lastInsertRowid));
});

it("does not interpret user reason text or other event types as a legacy Apply Skip", async () => {
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','skipped',2,3,'2026-10-24',0)").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,?,?,?,?,'2026-10-24')");
  const marker = "Job marked skipped from the local API.";
  event.run(JOB_ID, "apply", "StageSkipped", "Other skip.", JSON.stringify({ reason: marker }));
  event.run(JOB_ID, "apply", "StageCompleted", marker, "{}");
  event.run(JOB_ID, "cover", "StageSkipped", marker, "{}");
  await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false });
  const reset = db.prepare("SELECT payload_json FROM job_events WHERE tenant_id='local' AND job_id=? AND event_type='StageReset'").get(JOB_ID) as { payload_json: string };
  expect(JSON.parse(reset.payload_json)).toMatchObject({ resetAuthority: "explicit_safe_apply_reset", manualSkipReleasedThroughEventId: null });
});

it("refuses resetting Skip over an unsettled admitted run even before intent", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','running',1,3,'2026-10-24',1)").run(JOB_ID);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','ApplyRunStarted',?,'2026-10-24')").run(JOB_ID, JSON.stringify({ run_id: "original" }));
  markJobSkipped(db, JOB_ID, {});
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).rejects.toThrow(/prior admitted run/);
  // A foreign run's terminal result cannot release the original owner.
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','ApplicationFailed',?,'2026-10-24')").run(JOB_ID, JSON.stringify({ run_id: "unrelated" }));
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).rejects.toThrow(/prior admitted run/);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','ApplicationFailed',?,'2026-10-24')").run(JOB_ID, JSON.stringify({ run_id: "original" }));
  expect((await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).stage).toMatchObject({ state: "pending", attemptCount: 1 });
});

it("Skip cannot launder Needs verification into a safe reset when the intent receipt is absent", async () => {
  const { markJobSkipped, markJobApplied } = await import("../src/write-model.js");
  const { hasUnresolvedSkippedOutcome } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','needs_verification',1,3,'2026-10-24',0)").run(JOB_ID);
  markJobSkipped(db, JOB_ID, {});
  markJobSkipped(db, JOB_ID, {});
  expect(hasUnresolvedSkippedOutcome(db, "local", JOB_ID)).toBe(true);
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/verification/);
  expect(db.prepare("SELECT state,attempt_count FROM job_stage_states WHERE job_id=?").get(JOB_ID)).toEqual({ state: "needs_verification", attempt_count: 1 });
  markJobApplied(db, JOB_ID, {});
  expect(hasUnresolvedSkippedOutcome(db, "local", JOB_ID)).toBe(false);
});

it.each(["pending", "failed", "canceled"])("reset cannot treat a later %s label as settlement of skipped running work", async (state) => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','running',1,3,'2026-10-24',1)").run(JOB_ID);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','ApplyRunStarted',?,'2026-10-24')")
    .run(JOB_ID, JSON.stringify({ run_id: "original" }));
  markJobSkipped(db, JOB_ID, {});
  db.prepare("UPDATE job_stage_states SET state=? WHERE job_id=? AND stage='apply'").run(state, JOB_ID);
  const before = db.prepare("SELECT * FROM job_stage_states WHERE job_id=?").all(JOB_ID);
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/prior admitted run/);
  expect(db.prepare("SELECT * FROM job_stage_states WHERE job_id=?").all(JOB_ID)).toEqual(before);
});

it("recorded manual Skip remains active after relabel and is released only by safe reset", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { hasManualApplyStop } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  markJobSkipped(db, JOB_ID, {});
  db.prepare("UPDATE job_stage_states SET state='pending' WHERE job_id=? AND stage='apply'").run(JOB_ID);
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(true);
  expect(hasManualApplyStop(db, "other", JOB_ID)).toBe(false);
  await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false });
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(false);
  markJobSkipped(db, JOB_ID, {});
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(true);
});

it("audit consumes only exact recorded outcomes while retaining every intent as a reset blocker", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { applyIntentOutcomeRecorded } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','succeeded',1,3,'2026-10-24',0)").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,'2026-10-24')");
  event.run(JOB_ID, "ApplySubmitIntended", JSON.stringify({ run_id: "original" }));
  event.run(JOB_ID, "ApplicationSubmitted", JSON.stringify({ run_id: "unrelated" }));
  expect(applyIntentOutcomeRecorded(db, "local", JOB_ID)).toBe(false);
  event.run(JOB_ID, "ApplicationSubmitted", JSON.stringify({ run_id: "original" }));
  expect(applyIntentOutcomeRecorded(db, "local", JOB_ID)).toBe(true);
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/intent|verification/);
  markJobSkipped(db, JOB_ID, {});
  expect(applyIntentOutcomeRecorded(db, "local", JOB_ID)).toBe(true);
  event.run(JOB_ID, "ApplySubmitIntended", JSON.stringify({ run_id: "later" }));
  expect(applyIntentOutcomeRecorded(db, "local", JOB_ID)).toBe(false);
});

it.each([
  ["succeeded", null],
  ["needs_verification", "APPLY_NEEDS_VERIFICATION"],
  ["skipped", "MANUAL_ATS"],
  ["skipped", "MIN_SCORE"],
  ["queued", null],
] as const)("repeated Skip preserves protected %s / %s state", async (state, errorCode) => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable,error_code,error_message,metadata_json) VALUES ('local',?,'apply',?,2,3,'2026-10-24',0,?,'protected detail',?)")
    .run(JOB_ID, state, errorCode, JSON.stringify({ source: "synthetic" }));
  const before = db.prepare("SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'").get(JOB_ID);
  markJobSkipped(db, JOB_ID, {});
  markJobSkipped(db, JOB_ID, {});
  expect(db.prepare("SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'").get(JOB_ID)).toEqual(before);
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow();
  expect(db.prepare("SELECT event_type FROM job_events ORDER BY event_id").all()).toEqual([{ event_type: "StageSkipped" }, { event_type: "StageSkipped" }]);
});

it.each([
  ["ApplicationManuallyMarked", {}, "skipped", /applied/i],
  ["StageSkipped", { previousState: "succeeded", manualDisposition: "skip" }, "skipped", /applied/i],
  ["StageSkipped", { previousState: "queued", manualDisposition: "skip" }, "skipped", /queued/i],
  ["StageSkipped", { previousState: "needs_verification", manualDisposition: "skip" }, "skipped", /verification/i],
  ["ApplicationFailed", { result: "needs_verification" }, "skipped", /verification/i],
] as const)("legacy %s history survives repeated Skip and refuses reset", async (eventType, payload, state, message) => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply',?,2,3,'2026-10-24',0)").run(JOB_ID, state);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,'2026-10-24')").run(JOB_ID, eventType, JSON.stringify(payload));
  markJobSkipped(db, JOB_ID, {});
  markJobSkipped(db, JOB_ID, {});
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(message);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='StageReset'").get()).toEqual({ n: 0 });
});

it.each(["manual_ats", "score_threshold"])("legacy %s policy survives repeated manual Skip", async (policy) => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','skipped',2,3,'2026-10-24',0)").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,?,'2026-10-24')");
  event.run(JOB_ID, policy === "manual_ats" ? "ApplyManualSkip" : "StageSkipped", policy === "manual_ats" ? "manual ATS" : "Fit score 3/10 is below the materials threshold 7/10.", JSON.stringify(policy === "manual_ats" ? { result: "manual" } : { reason: "score_below_threshold", fitScore: 3, minScore: 7, upstreamStage: "score", downstreamStage: "apply" }));
  event.run(JOB_ID, "StageSkipped", "Job marked skipped from the local API.", JSON.stringify({ reason: "legacy" }));
  markJobSkipped(db, JOB_ID, {});
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/policy/i);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='StageReset'").get()).toEqual({ n: 0 });
});

it("a genuine score-policy clearance leaves an ordinary later Skip safely resettable", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','pending',2,3,'2026-10-24',1)").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,?,'2026-10-24')");
  event.run(JOB_ID, "StageSkipped", "Fit score 3/10 is below the materials threshold 7/10.", JSON.stringify({ reason: "score_below_threshold", fitScore: 3, minScore: 7, upstreamStage: "score", downstreamStage: "apply" }));
  event.run(JOB_ID, "StageReset", "apply restored after the score threshold allowed materials.", JSON.stringify({ reason: "score_threshold_cleared", upstreamStage: "score", downstreamStage: "apply" }));
  markJobSkipped(db, JOB_ID, {});
  markJobSkipped(db, JOB_ID, {});
  expect((await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).stage).toMatchObject({ state: "pending", attemptCount: 2 });
});

it("does not treat a user-authored score reason as an earlier score-policy Skip", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','skipped',2,3,'2026-10-24',0)").run(JOB_ID);
  db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,'apply','StageSkipped','Job marked skipped from the local API.',?,'2026-10-24')").run(JOB_ID, JSON.stringify({ reason: "score_below_threshold" }));
  markJobSkipped(db, JOB_ID, { reason: "score_below_threshold" });
  expect((await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).stage).toMatchObject({ state: "pending", attemptCount: 2 });
});

it("a score-policy clearance cannot clear a retained manual ATS disposition", async () => {
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','skipped',2,3,'2026-10-24',0)").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,message,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,?,'2026-10-24')");
  event.run(JOB_ID, "ApplyManualSkip", "manual ATS", JSON.stringify({ result: "manual" }));
  event.run(JOB_ID, "StageSkipped", "Skipped locally.", JSON.stringify({ manualDisposition: "skip", previousState: "skipped", previousErrorCode: "MANUAL_ATS", reason: "score_below_threshold" }));
  event.run(JOB_ID, "StageReset", "apply restored after the score threshold allowed materials.", JSON.stringify({ reason: "score_threshold_cleared", upstreamStage: "score", downstreamStage: "apply" }));
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).rejects.toThrow(/policy/i);
});

it.each(["", 42, null])("unidentified intent %s cannot acquire a resolved audit label from a matching malformed outcome", async (runId) => {
  const { applyIntentOutcomeRecorded, applySubmitIntentRunIds } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply','succeeded',1,3,'2026-10-24',0)").run(JOB_ID);
  for (const type of ["ApplySubmitIntended", "ApplicationSubmitted"]) {
    db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,'2026-10-24')")
      .run(JOB_ID, type, JSON.stringify({ run_id: runId }));
  }
  expect(applyIntentOutcomeRecorded(db, "local", JOB_ID)).toBe(false);
  expect(applySubmitIntentRunIds(db, "local", JOB_ID)).toEqual(["unknown"]);
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/intent|verification/);
});

it.each(["pending", "failed", "canceled"])("reset of %s requires the admitted owner's acknowledgement without a Skip", async (state) => {
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable) VALUES ('local',?,'apply',?,1,3,'2026-10-24',1)").run(JOB_ID, state);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply',?,?,'2026-10-24')");
  event.run(JOB_ID, "ApplyClaimAcquired", JSON.stringify({ run_id: "admitted", launcher_id: "launcher" }));
  event.run(JOB_ID, "ApplyRunStarted", JSON.stringify({ run_id: "admitted" }));
  event.run(JOB_ID, "StageCanceled", JSON.stringify({ run_id: "admitted" }));
  const before = db.prepare("SELECT * FROM job_stage_states").all();
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/prior admitted run/);
  expect(db.prepare("SELECT * FROM job_stage_states").all()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) AS n FROM job_events").get()).toEqual({ n: 3 });
  event.run(JOB_ID, "LockReleased", JSON.stringify({ run_id: "other" }));
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/prior admitted run/);
  event.run(JOB_ID, "LockReleased", JSON.stringify({ run_id: "admitted" }));
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/prior admitted run/);
  event.run(JOB_ID, "ApplyClaimSettled", JSON.stringify({ run_id: "admitted", launcher_id: "other" }));
  await expect(resetJobStage(db, JOB_ID, "apply", { resetAttempts: true })).rejects.toThrow(/prior admitted run/);
  event.run(JOB_ID, "ApplyClaimSettled", JSON.stringify({ run_id: "admitted", launcher_id: "launcher" }));
  expect((await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false })).stage.state).toBe("pending");
});

it("automatic and unbound StageReset events cannot release manual Skip", async () => {
  const { markJobSkipped } = await import("../src/write-model.js");
  const { hasManualApplyStop } = await import("../src/apply-controls.js");
  const { db } = createFixture();
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('local',?,?,'Synthetic','2026-10-24')").run(JOB_ID, JOB_URL);
  markJobSkipped(db, JOB_ID, {});
  db.prepare("UPDATE job_stage_states SET state='pending' WHERE job_id=? AND stage='apply'").run(JOB_ID);
  const event = db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','StageReset',?,'2026-10-24')");
  for (const payload of [{ reason: "score_threshold_cleared" }, { reset_attempts: true },
    { resetAuthority: "explicit_safe_apply_reset", manualSkipReleasedThroughEventId: "1" },
    { resetAuthority: "explicit_safe_apply_reset", manualSkipReleasedThroughEventId: 99999 }]) {
    event.run(JOB_ID, JSON.stringify(payload));
    expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(true);
  }
  await resetJobStage(db, JOB_ID, "apply", { resetAttempts: false });
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(false);
  const release = db.prepare("SELECT payload_json FROM job_events ORDER BY event_id DESC LIMIT 1").get() as {payload_json:string};
  markJobSkipped(db, JOB_ID, {});
  event.run(JOB_ID, release.payload_json);
  expect(hasManualApplyStop(db, "local", JOB_ID)).toBe(true);
});
