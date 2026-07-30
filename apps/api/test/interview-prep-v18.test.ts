import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  recordManualApplicationOutcome,
} from "../src/application-feedback.js";
import {
  InputError,
  permanentlyDeleteJob,
} from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";

function createSchema(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  db.pragma("user_version = 18");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      application_url TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE job_interview_prep (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      generated_at TEXT NOT NULL,
      gate_status TEXT NOT NULL,
      fabrication_findings_json TEXT NOT NULL DEFAULT '[]',
      grounding_findings_json TEXT NOT NULL DEFAULT '[]',
      judge_verdict TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      failure_reason TEXT NOT NULL DEFAULT '',
      origin_run_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, job_id, generation)
    );
    CREATE TABLE job_interview_prep_items (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      generated_text TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      requirement_ids_json TEXT NOT NULL DEFAULT '[]',
      source_text_json TEXT NOT NULL DEFAULT '[]',
      transform_type TEXT NOT NULL DEFAULT 'grounded_prep',
      control TEXT NOT NULL DEFAULT 'never_fabricate',
      grounding_audit_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, job_id, generation, item_id)
    );
  `);
}

function seedPrep(
  db: Database.Database,
  input: { url: string; jobId: string; marker: string },
): void {
  db.prepare(
    `INSERT INTO jobs (url, tenant_id, job_id, title)
     VALUES (?, 'local', ?, 'Platform Engineer')`,
  ).run(input.url, input.jobId);
  db.prepare(
    `INSERT INTO job_interview_prep (
       tenant_id, job_id, generation, status, generated_at, gate_status,
       origin_run_id
     ) VALUES (
       'local', ?, 2, 'accepted', '2026-07-29T10:00:00.000Z',
       'passed', ?
     )`,
  ).run(input.jobId, `run:${input.marker}`);
  db.prepare(
    `INSERT INTO job_interview_prep_items (
       tenant_id, job_id, generation, item_id, kind, title, generated_text
     ) VALUES (
       'local', ?, 2, ?, 'theme', 'Theme', 'Grounded preparation'
     )`,
  ).run(input.jobId, `item:${input.marker}`);
}

describe("schema-v18 Interview Preparation API compatibility", () => {
  it("links a UUID-shaped posting URL to its URL owner's stable prep", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedPrep(db, {
      url: UUID_SHAPED_URL,
      jobId: URL_OWNER_JOB_ID,
      marker: "url-owner",
    });
    seedPrep(db, {
      url: ID_TEXT_OWNER_URL,
      jobId: UUID_SHAPED_URL,
      marker: "id-owner",
    });

    expect(
      recordManualApplicationOutcome(db, UUID_SHAPED_URL, {
        kind: "interview",
        occurredAt: "2026-07-29T11:00:00.000Z",
        note: "Private reflection",
        interviewPrepGeneration: 2,
      }).outcome,
    ).toMatchObject({
      jobKey: UUID_SHAPED_URL,
      interviewPrepGeneration: 2,
    });
    expect(() =>
      recordManualApplicationOutcome(db, UUID_SHAPED_URL, {
        kind: "interview",
        occurredAt: "2026-07-29T11:01:00.000Z",
        interviewPrepGeneration: 99,
      }),
    ).toThrowError(InputError);
    db.close();
  });

  it("permanently deletes only the URL owner's prep with FK cascades off", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedPrep(db, {
      url: UUID_SHAPED_URL,
      jobId: URL_OWNER_JOB_ID,
      marker: "url-owner",
    });
    seedPrep(db, {
      url: ID_TEXT_OWNER_URL,
      jobId: UUID_SHAPED_URL,
      marker: "id-owner",
    });

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });
    expect(
      db.prepare("SELECT url FROM jobs ORDER BY url").all(),
    ).toEqual([{ url: ID_TEXT_OWNER_URL }]);
    for (const tableName of [
      "job_interview_prep",
      "job_interview_prep_items",
    ]) {
      expect(
        db.prepare(
          `SELECT DISTINCT job_id FROM ${tableName}`,
        ).all(),
      ).toEqual([{ job_id: UUID_SHAPED_URL }]);
    }
    db.close();
  });
});
