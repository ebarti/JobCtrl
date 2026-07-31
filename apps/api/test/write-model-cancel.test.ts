import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cancelJobAction, markJobApplied, markJobSkipped } from "../src/write-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_URL = "https://example.com/jobs/ready";
const JOB_ID = "10000000-0000-4000-8000-000000000001";
const TENANT_ID = "local";

describe("cancelJobAction", () => {
  let directory: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-cancel-action-"));
    const dbPath = path.join(directory, "jobctrl.db");
    initializeExactV7Database(dbPath);
    db = new Database(dbPath);
    db.prepare(
      "INSERT INTO jobs (tenant_id, job_id, url, application_url) VALUES (?, ?, ?, ?)",
    ).run(TENANT_ID, JOB_ID, JOB_URL, `${JOB_URL}/apply`);
    db.prepare(
      `INSERT INTO job_locators (
         tenant_id, job_id, locator_kind, locator_value, is_current,
         first_seen_at, last_seen_at
       ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)`,
    ).run(
      TENANT_ID,
      JOB_ID,
      JOB_URL,
      "2026-07-31T12:00:00+00:00",
      "2026-07-31T12:00:00+00:00",
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("records a running-stage cancellation only once", () => {
    db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, updated_at
       ) VALUES (?, ?, 'apply', 'running', 1, ?)`,
    ).run(TENANT_ID, JOB_ID, "2026-07-31T12:00:00+00:00");

    const first = cancelJobAction(db, JOB_URL, "apply-run-1");
    const second = cancelJobAction(db, JOB_URL, "apply-run-1");

    expect(first.cancelRequested).toBe(true);
    expect(first.stage.state).toBe("canceled");
    expect(second.cancelRequested).toBe(false);
    expect(second.stage.state).toBe("canceled");
    const events = db
      .prepare(
        `SELECT COUNT(*) AS count FROM job_events
         WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageCanceled'`,
      )
      .get(TENANT_ID, JOB_ID) as { count: number };
    expect(events.count).toBe(1);
  });

  it("preserves an already-terminal Apply result", () => {
    db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, updated_at
       ) VALUES (?, ?, 'apply', 'succeeded', 1, ?)`,
    ).run(TENANT_ID, JOB_ID, "2026-07-31T12:00:00+00:00");

    const result = cancelJobAction(db, JOB_URL, "apply-run-terminal");

    expect(result.cancelRequested).toBe(false);
    expect(result.stage.state).toBe("succeeded");
    const events = db
      .prepare(
        `SELECT COUNT(*) AS count FROM job_events
         WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageCanceled'`,
      )
      .get(TENANT_ID, JOB_ID) as { count: number };
    expect(events.count).toBe(0);
  });

  it.each([
    ["applied", markJobApplied, "succeeded", "ApplicationManuallyMarked"],
    ["skipped", markJobSkipped, "skipped", "StageSkipped"],
  ] as const)("persists a manually %s result only in the canonical aggregate", (_label, action, state, eventType) => {
    const result = action(db, JOB_URL, { reason: "confirmed by user" });

    expect(result.jobUrl).toBe(JOB_URL);
    expect(result.stage.state).toBe(state);
    const stageRow = db
      .prepare(
        `SELECT state FROM job_stage_states
         WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'`,
      )
      .get(TENANT_ID, JOB_ID) as { state: string };
    expect(stageRow.state).toBe(state);
    const event = db
      .prepare(
        `SELECT event_type, payload_json FROM job_events
         WHERE tenant_id = ? AND job_id = ? ORDER BY event_id DESC LIMIT 1`,
      )
      .get(TENANT_ID, JOB_ID) as { event_type: string; payload_json: string };
    expect(event.event_type).toBe(eventType);
    expect(JSON.parse(event.payload_json)).toMatchObject({
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      reason: "confirmed by user",
    });
  });
});
