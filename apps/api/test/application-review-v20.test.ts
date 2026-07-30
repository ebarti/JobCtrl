import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  ensureApplicationFeedbackTables,
  recordApplyReviewDecision,
} from "../src/application-feedback.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";
const OTHER_TENANT_URL = "https://example.com/jobs/other-tenant-review";

function createSchema(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  db.pragma("user_version = 20");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      application_url TEXT,
      tailored_resume_path TEXT,
      cover_letter_path TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE application_review_decisions (
      tenant_id                    TEXT NOT NULL DEFAULT 'local',
      decision_id                  TEXT NOT NULL,
      job_id                       TEXT NOT NULL,
      decision                     TEXT NOT NULL,
      reason                       TEXT,
      decided_by                   TEXT DEFAULT 'user',
      decided_at                   TEXT NOT NULL,
      materials_generation         INTEGER,
      profile_version              INTEGER,
      application_url              TEXT,
      partial_override_run_id      TEXT,
      email_recipient              TEXT,
      email_attachment_artifact_id TEXT,
      PRIMARY KEY (tenant_id, decision_id),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_application_review_decisions_job
      ON application_review_decisions(
        tenant_id,
        job_id,
        decided_at DESC
      );
  `);
}

function seedCollisionGraph(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, application_url
     ) VALUES (?, ?, ?, 'Platform Engineer', NULL)`,
  );
  insert.run(UUID_SHAPED_URL, "local", URL_OWNER_JOB_ID);
  insert.run(ID_TEXT_OWNER_URL, "local", UUID_SHAPED_URL);
  insert.run(OTHER_TENANT_URL, "tenant-b", URL_OWNER_JOB_ID);
}

function seedDecision(
  db: Database.Database,
  input: {
    tenantId: string;
    decisionId: string;
    jobId: string;
  },
): void {
  db.prepare(
    `INSERT INTO application_review_decisions (
       tenant_id, decision_id, job_id, decision, reason, decided_by,
       decided_at
     ) VALUES (?, ?, ?, 'defer', NULL, 'user', ?)`,
  ).run(
    input.tenantId,
    input.decisionId,
    input.jobId,
    "2026-07-30T10:00:00.000Z",
  );
}

describe("schema-v20 Apply Review API compatibility", () => {
  it("writes a UUID-shaped posting URL under its URL owner's JobId", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);
    db.exec("DROP TABLE application_review_decisions");
    ensureApplicationFeedbackTables(db);

    const result = recordApplyReviewDecision(
      db,
      UUID_SHAPED_URL,
      {
        decision: "defer",
        reason: "Review later.",
        decidedBy: "user",
      },
    );

    expect(result.decision).toMatchObject({
      jobKey: UUID_SHAPED_URL,
      decision: "defer",
    });
    expect(
      db.prepare(
        `SELECT tenant_id, job_id, decision
           FROM application_review_decisions`,
      ).get(),
    ).toEqual({
      tenant_id: "local",
      job_id: URL_OWNER_JOB_ID,
      decision: "defer",
    });
    db.close();
  });

  it("deletes only the URL owner's review history with cascades off", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);
    seedDecision(db, {
      tenantId: "local",
      decisionId: "url-owner",
      jobId: URL_OWNER_JOB_ID,
    });
    seedDecision(db, {
      tenantId: "local",
      decisionId: "id-owner",
      jobId: UUID_SHAPED_URL,
    });
    seedDecision(db, {
      tenantId: "tenant-b",
      decisionId: "other-tenant",
      jobId: URL_OWNER_JOB_ID,
    });

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });
    expect(
      db.prepare(
        `SELECT tenant_id, decision_id, job_id
           FROM application_review_decisions
          ORDER BY tenant_id, decision_id`,
      ).all(),
    ).toEqual([
      {
        tenant_id: "local",
        decision_id: "id-owner",
        job_id: UUID_SHAPED_URL,
      },
      {
        tenant_id: "tenant-b",
        decision_id: "other-tenant",
        job_id: URL_OWNER_JOB_ID,
      },
    ]);
    expect(
      db.prepare("SELECT url FROM jobs ORDER BY url").all(),
    ).toEqual([
      { url: ID_TEXT_OWNER_URL },
      { url: OTHER_TENANT_URL },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
