import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Stage } from "../src/contracts.js";
import { cancelJobAction, markJobApplied, markJobSkipped, resetJobStage } from "../src/write-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_URL = "https://example.com/jobs/ready";
const JOB_ID = "10000000-0000-4000-8000-000000000001";
const TENANT_ID = "local";
const RETIRED_AT = "2025-01-01T00:00:00Z";

describe("cancelJobAction", () => {
  let directory: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-cancel-action-"));
    const dbPath = path.join(directory, "jobctrl.db");
    initializeExactV7Database(dbPath);
    db = new Database(dbPath);
    db.prepare(
      `INSERT INTO jobs (
         tenant_id, job_id, url, application_url,
         detail_scraped_at, detail_error,
         fit_score, score_reasoning, scored_at,
         tailored_resume_path, tailored_at, tailor_attempts,
         cover_letter_path, cover_letter_at, cover_attempts,
         applied_at, apply_status, apply_error, apply_attempts,
         agent_id, apply_task_id
       ) VALUES (?, ?, ?, ?, ?, 'retired-detail-error', 10, 'retired-score', ?,
                 '/tmp/retired-resume.txt', ?, 4,
                 '/tmp/retired-cover.txt', ?, 3,
                 ?, 'retired-status', 'retired-apply-error', 2,
                 'retired-agent', 'retired-task')`,
    ).run(
      TENANT_ID,
      JOB_ID,
      JOB_URL,
      `${JOB_URL}/apply`,
      RETIRED_AT,
      RETIRED_AT,
      RETIRED_AT,
      RETIRED_AT,
      RETIRED_AT,
    );
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
    const retiredBefore = retiredJobState();
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
    expect(retiredJobState()).toEqual(retiredBefore);
  });

  it.each(["score", "tailor", "cover", "apply"] as const)(
    "resets %s through canonical stage state without writing retired jobs columns",
    (stage) => {
      insertStage(stage, "failed", 3);
      const retiredBefore = retiredJobState();

      const result = resetJobStage(db, JOB_URL, stage, { resetAttempts: true });

      expect(result.stage).toMatchObject({ state: "pending", attemptCount: 0 });
      expect(retiredJobState()).toEqual(retiredBefore);
      expect(eventCount("StageReset")).toBe(1);
    },
  );

  it("resets enrichment only through the canonical aggregate", () => {
    insertStage("enrich", "failed", 2);
    db.prepare(
      `INSERT INTO job_enrichments (
         tenant_id, job_id, current_status, full_description,
         application_url, enriched_at, extraction_tier, updated_at
       ) VALUES (?, ?, 'enriched', 'canonical description', ?, ?, 'json_ld', ?)`,
    ).run(TENANT_ID, JOB_ID, `${JOB_URL}/canonical-apply`, RETIRED_AT, RETIRED_AT);
    const retiredBefore = retiredJobState();

    const result = resetJobStage(db, JOB_URL, "enrich", { resetAttempts: true });
    const enrichment = db.prepare(
      `SELECT current_status, full_description, application_url,
              enriched_at, extraction_tier
         FROM job_enrichments
        WHERE tenant_id = ? AND job_id = ?`,
    ).get(TENANT_ID, JOB_ID);

    expect(result.stage).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(enrichment).toEqual({
      current_status: "pending",
      full_description: null,
      application_url: null,
      enriched_at: null,
      extraction_tier: null,
    });
    expect(retiredJobState()).toEqual(retiredBefore);
    expect(eventCount("StageReset")).toBe(1);
  });

  function insertStage(stage: Stage, state: string, attemptCount: number): void {
    db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, updated_at, retryable
       ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(TENANT_ID, JOB_ID, stage, state, attemptCount, RETIRED_AT);
  }

  function eventCount(eventType: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM job_events
       WHERE tenant_id = ? AND job_id = ? AND event_type = ?`,
    ).get(TENANT_ID, JOB_ID, eventType) as { count: number };
    return row.count;
  }

  function retiredJobState(): Record<string, unknown> {
    return db.prepare(
      `SELECT detail_scraped_at, detail_error,
              fit_score, score_reasoning, scored_at,
              tailored_resume_path, tailored_at, tailor_attempts,
              cover_letter_path, cover_letter_at, cover_attempts,
              applied_at, apply_status, apply_error, apply_attempts,
              agent_id, apply_task_id
         FROM jobs
        WHERE tenant_id = ? AND job_id = ?`,
    ).get(TENANT_ID, JOB_ID) as Record<string, unknown>;
  }
});
