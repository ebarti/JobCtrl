import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { permanentlyDeleteJob } from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";

function createSchema(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  db.pragma("user_version = 16");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      application_url TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE job_employer_analysis (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      snapshot_hash TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      sdk_set_version TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      role_framing TEXT NOT NULL DEFAULT '',
      inferred_seniority TEXT NOT NULL DEFAULT '',
      ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
      requirements_json TEXT NOT NULL DEFAULT '[]',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      agreement_json TEXT NOT NULL DEFAULT '{}',
      eeo_screen_json TEXT NOT NULL DEFAULT '[]',
      legs_attempted INTEGER NOT NULL,
      legs_succeeded INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_id, generation),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE TABLE job_employer_analysis_sub_analyses (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_id, generation, model_id),
      FOREIGN KEY (tenant_id, job_id, generation)
        REFERENCES job_employer_analysis(tenant_id, job_id, generation)
        ON DELETE CASCADE
    );
    CREATE TABLE job_employer_analysis_failures (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      error TEXT NOT NULL,
      raw_output TEXT,
      PRIMARY KEY (tenant_id, job_id, generation, model_id),
      FOREIGN KEY (tenant_id, job_id, generation)
        REFERENCES job_employer_analysis(tenant_id, job_id, generation)
        ON DELETE CASCADE
    );
  `);
}

function seedAnalysis(
  db: Database.Database,
  input: { url: string; jobId: string; marker: string },
): void {
  db.prepare(
    `INSERT INTO jobs (url, tenant_id, job_id, title)
     VALUES (?, 'local', ?, 'Platform Engineer')`,
  ).run(input.url, input.jobId);
  db.prepare(
    `INSERT INTO job_employer_analysis (
       tenant_id, job_id, generation, snapshot_hash, prompt_version,
       sdk_set_version, cache_key, role_framing, inferred_seniority,
       ideal_candidate_narrative, requirements_json, keywords_json,
       agreement_json, eeo_screen_json, legs_attempted, legs_succeeded,
       created_at
     ) VALUES (
       'local', ?, 1, ?, 'prompt-v1', 'sdk-v1', ?, '', '', '',
       '[]', '[]', '{}', '[]', 2, 1, '2026-07-29T10:00:00.000Z'
     )`,
  ).run(input.jobId, input.marker, `cache:${input.marker}`);
  db.prepare(
    `INSERT INTO job_employer_analysis_sub_analyses (
       tenant_id, job_id, generation, model_id, analysis_json
     ) VALUES ('local', ?, 1, ?, '{}')`,
  ).run(input.jobId, `draft:${input.marker}`);
  db.prepare(
    `INSERT INTO job_employer_analysis_failures (
       tenant_id, job_id, generation, model_id, error, raw_output
     ) VALUES ('local', ?, 1, ?, 'timeout', NULL)`,
  ).run(input.jobId, `failure:${input.marker}`);
}

describe("schema-v16 employer-analysis writes", () => {
  it("permanently deletes only the UUID-shaped URL owner's analysis graph", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedAnalysis(db, {
      url: UUID_SHAPED_URL,
      jobId: URL_OWNER_JOB_ID,
      marker: "url-owner",
    });
    seedAnalysis(db, {
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
      "job_employer_analysis",
      "job_employer_analysis_sub_analyses",
      "job_employer_analysis_failures",
    ]) {
      expect(
        db.prepare(
          `SELECT DISTINCT job_id FROM ${tableName}`,
        ).all(),
      ).toEqual([{ job_id: UUID_SHAPED_URL }]);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
