import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { getMarketCompensationEstimate } from "../src/market-compensation-estimates.js";
import { getPostedCompensationFact } from "../src/posted-compensation-facts.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";
const OTHER_TENANT_URL = "https://example.com/jobs/other-tenant";

function createSchema(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  db.pragma("user_version = 19");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      salary TEXT,
      application_url TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE job_posted_compensation_facts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      source_field TEXT NOT NULL DEFAULT 'jobs.salary',
      source_text TEXT,
      legacy_raw_salary TEXT,
      parse_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'unknown',
      component TEXT NOT NULL DEFAULT 'unknown',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      annualized_minimum_amount INTEGER,
      annualized_maximum_amount INTEGER,
      annualization_assumption TEXT,
      confidence TEXT NOT NULL DEFAULT 'none',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      parser_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      parsed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_id),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE TABLE job_market_compensation_estimates (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      estimate_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'year',
      component TEXT NOT NULL DEFAULT 'total_compensation',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      confidence_interval_minimum_amount INTEGER,
      confidence_interval_maximum_amount INTEGER,
      confidence_band TEXT NOT NULL DEFAULT 'none',
      confidence_score REAL NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER,
      aggregate_bucket TEXT,
      geography_scope TEXT,
      occupation_code TEXT,
      occupation_label TEXT,
      seniority_label TEXT,
      source_snapshot_json TEXT NOT NULL DEFAULT '[]',
      factor_reasons_json TEXT NOT NULL DEFAULT '[]',
      selected_evidence_json TEXT NOT NULL DEFAULT '[]',
      insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
      unsupported_reasons_json TEXT NOT NULL DEFAULT '[]',
      source_unavailable_reasons_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      estimator_version TEXT NOT NULL,
      estimated_at TEXT NOT NULL,
      company_name TEXT,
      normalized_company TEXT,
      role_title TEXT,
      normalized_role TEXT,
      company_tier TEXT NOT NULL DEFAULT 'unknown',
      match_scope TEXT NOT NULL DEFAULT 'none',
      PRIMARY KEY (tenant_id, job_id),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
  `);
}

function seedCompensation(
  db: Database.Database,
  input: {
    tenantId: string;
    url: string;
    jobId: string;
    marker: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, salary, application_url
     ) VALUES (?, ?, ?, 'Platform Engineer', 'EUR 100k', NULL)`,
  ).run(input.url, input.tenantId, input.jobId);
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
       tenant_id, job_id, source_text, legacy_raw_salary, parse_state,
       currency, period, component, minimum_amount, maximum_amount,
       annualized_minimum_amount, annualized_maximum_amount, confidence,
       parser_version, source_hash, parsed_at
     ) VALUES (
       ?, ?, ?, 'EUR 100k', 'parsed_range', 'EUR', 'year', 'base_salary',
       100000, 100000, 100000, 100000, 'high',
       'posted-compensation-v1', ?, '2026-07-29T10:00:00.000Z'
     )`,
  ).run(
    input.tenantId,
    input.jobId,
    `posted:${input.marker}`,
    input.marker.repeat(64).slice(0, 64),
  );
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
       tenant_id, job_id, estimate_state, confidence_band, confidence_score,
       source_count, unsupported_reasons_json, estimator_version,
       estimated_at, company_name
     ) VALUES (
       ?, ?, 'unsupported', 'none', 0, 0, '["unsupported_source"]',
       'company-role-reported-compensation-v1',
       '2026-07-29T10:00:00.000Z', ?
     )`,
  ).run(input.tenantId, input.jobId, `market:${input.marker}`);
}

function seedCollisionGraph(db: Database.Database): void {
  seedCompensation(db, {
    tenantId: "local",
    url: UUID_SHAPED_URL,
    jobId: URL_OWNER_JOB_ID,
    marker: "url-owner",
  });
  seedCompensation(db, {
    tenantId: "local",
    url: ID_TEXT_OWNER_URL,
    jobId: UUID_SHAPED_URL,
    marker: "id-owner",
  });
  seedCompensation(db, {
    tenantId: "tenant-b",
    url: OTHER_TENANT_URL,
    jobId: URL_OWNER_JOB_ID,
    marker: "other-tenant",
  });
}

describe("schema-v19 compensation API compatibility", () => {
  it("links a UUID-shaped posting URL to its URL owner's stable compensation", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);

    expect(getPostedCompensationFact(db, UUID_SHAPED_URL)).toMatchObject({
      recordStatus: "recorded",
      fact: {
        jobKey: UUID_SHAPED_URL,
        sourceText: "posted:url-owner",
      },
    });
    expect(getMarketCompensationEstimate(db, UUID_SHAPED_URL)).toMatchObject({
      recordStatus: "recorded",
      estimate: {
        jobKey: UUID_SHAPED_URL,
        companyName: "market:url-owner",
      },
    });
    db.close();
  });

  it("deletes only the URL owner's stable compensation with cascades off", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });
    expect(
      db.prepare(
        `SELECT tenant_id, job_id
           FROM job_posted_compensation_facts
          ORDER BY tenant_id, job_id`,
      ).all(),
    ).toEqual([
      { tenant_id: "local", job_id: UUID_SHAPED_URL },
      { tenant_id: "tenant-b", job_id: URL_OWNER_JOB_ID },
    ]);
    expect(
      db.prepare(
        `SELECT tenant_id, job_id
           FROM job_market_compensation_estimates
          ORDER BY tenant_id, job_id`,
      ).all(),
    ).toEqual([
      { tenant_id: "local", job_id: UUID_SHAPED_URL },
      { tenant_id: "tenant-b", job_id: URL_OWNER_JOB_ID },
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
