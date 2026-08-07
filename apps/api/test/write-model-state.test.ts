import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  queueRetriedJobsForWorkflow,
  resetJobStage,
  resolveJobId,
  retryFailedJobs,
} from "../src/write-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000041";
const JOB_URL = "https://jobs.example.test/platform-engineer";
const fixtures: Array<{ directory: string; db: Database.Database }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("exact-v7 write-model stage state", () => {
  it("persists exact workflow ownership when an Enrich retry is queued", () => {
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

  it("does not invent Enrich execution ownership from a workflow handle", () => {
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

  it("clears canceled Enrich execution ownership on an admin reset", () => {
    const fixture = createFixture();
    fixture.db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
       VALUES ('local', ?, ?, 'Platform Engineer', ?)`,
    ).run(JOB_ID, JOB_URL, "2026-07-31T09:00:00.000Z");
    fixture.db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, max_attempts,
         updated_at, retryable, metadata_json
       ) VALUES ('local', ?, 'enrich', 'canceled', 1, 3, ?, 1, ?)`,
    ).run(
      JOB_ID,
      "2026-07-31T09:00:00.000Z",
      JSON.stringify({
        workflowId: "workflow-canceled",
        temporalRunId: "run-canceled",
      }),
    );

    const reset = resetJobStage(fixture.db, JOB_ID, "enrich", {
      resetAttempts: false,
    });
    const row = fixture.db.prepare(
      `SELECT state, metadata_json FROM job_stage_states
       WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).get(JOB_ID) as { state: string; metadata_json: string | null };

    expect(reset).toMatchObject({
      jobUrl: JOB_URL,
      stage: { state: "pending", attemptCount: 1 },
    });
    expect(row).toEqual({ state: "pending", metadata_json: null });
  });

  it("resets and queues failed stages by tenant and JobId while retaining URL responses", () => {
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
    const retried = retryFailedJobs(fixture.db, { allMatching: false, jobKeys: [JOB_URL] });
    expect(retried).toMatchObject({
      count: 1,
      jobKeys: [JOB_URL],
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

    const reset = resetJobStage(fixture.db, JOB_ID, "score", { resetAttempts: true });
    expect(reset).toMatchObject({ jobUrl: JOB_URL, stage: { state: "pending", attemptCount: 0 } });
    expect(stageRow(fixture.db)).toMatchObject({ state: "pending", attempt_count: 0, job_id: JOB_ID });
  });
});

function createFixture(): { directory: string; db: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-write-model-state-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactV7Database(dbPath);
  const fixture = { directory, db: new Database(dbPath) };
  fixtures.push(fixture);
  return fixture;
}

function stageRow(db: Database.Database): Record<string, unknown> {
  return db.prepare(
    `SELECT tenant_id, job_id, state, attempt_count, started_at, finished_at, duration_ms
     FROM job_stage_states
     WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'`,
  ).get(JOB_ID) as Record<string, unknown>;
}
