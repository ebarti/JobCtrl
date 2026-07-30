import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  markJobApplied,
  permanentlyDeleteJob,
} from "../src/write-model.js";

describe("schema-v13 stage-state writes", () => {
  it("mutates and deletes the URL owner when its URL equals another JobId", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("user_version = 13");
    db.exec(`
      CREATE TABLE jobs (
        url TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_id TEXT NOT NULL,
        application_url TEXT,
        apply_status TEXT,
        apply_error TEXT,
        applied_at TEXT,
        UNIQUE (tenant_id, job_id)
      );
      CREATE TABLE job_stage_states (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER DEFAULT 1,
        blocked_by_json TEXT,
        next_action TEXT,
        metadata_json TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, job_id, stage),
        FOREIGN KEY (tenant_id, job_id)
          REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
      );
      CREATE TABLE job_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_url TEXT,
        stage TEXT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT
      );
    `);

    const uuidShapedUrl = "11111111-1111-4111-8111-111111111111";
    const urlOwnerJobId = "22222222-2222-4222-8222-222222222222";
    const idTextOwnerUrl = "https://example.com/jobs/id-text-owner";
    db.prepare(
      `INSERT INTO jobs (url, tenant_id, job_id, application_url)
       VALUES (?, 'local', ?, ?), (?, 'local', ?, ?)`,
    ).run(
      uuidShapedUrl,
      urlOwnerJobId,
      `${uuidShapedUrl}/apply`,
      idTextOwnerUrl,
      uuidShapedUrl,
      `${idTextOwnerUrl}/apply`,
    );
    const insertStage = db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, updated_at
       ) VALUES ('local', ?, 'apply', ?, '2026-07-29T10:00:00.000Z')`,
    );
    insertStage.run(urlOwnerJobId, "failed");
    insertStage.run(uuidShapedUrl, "pending");

    expect(
      markJobApplied(db, uuidShapedUrl, { reason: "manual fixture" }),
    ).toMatchObject({
      jobUrl: uuidShapedUrl,
      stage: { state: "succeeded" },
    });
    expect(
      db.prepare(
        `SELECT state
           FROM job_stage_states
          WHERE tenant_id = 'local' AND job_id = ? AND stage = 'apply'`,
      ).get(urlOwnerJobId),
    ).toMatchObject({ state: "succeeded" });
    expect(
      db.prepare(
        `SELECT state
           FROM job_stage_states
          WHERE tenant_id = 'local' AND job_id = ? AND stage = 'apply'`,
      ).get(uuidShapedUrl),
    ).toMatchObject({ state: "pending" });

    expect(permanentlyDeleteJob(db, uuidShapedUrl)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [uuidShapedUrl],
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_id = ?").get(
        urlOwnerJobId,
      ),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT url FROM jobs WHERE job_id = ?").get(uuidShapedUrl),
    ).toEqual({ url: idTextOwnerUrl });
    expect(
      db.prepare(
        "SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ?",
      ).get(uuidShapedUrl),
    ).toEqual({ state: "pending" });

    db.close();
  });
});
