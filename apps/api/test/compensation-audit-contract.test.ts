import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { buildCompensationProjection } from "../src/projections.js";
import { parseCompensationAudit } from "../src/read-model.js";

describe("compensation audit identity contract", () => {
  it("emits the supplied jobId and rejects legacy jobKey audit payloads", () => {
    const db = new Database(":memory:");
    const locator = "https://example.com/jobs/legacy-locator";
    const jobId = "123e4567-e89b-12d3-a456-426614174000";
    db.exec("CREATE TABLE jobs (url TEXT PRIMARY KEY, salary TEXT)");
    db.prepare("INSERT INTO jobs (url, salary) VALUES (?, ?)").run(locator, "EUR 90000/year");

    const absentAudit = JSON.parse(buildCompensationProjection(db, locator, jobId).auditJson);
    expect(absentAudit).toMatchObject({
      posted: {
        ok: true,
        recordStatus: "not_recorded",
        jobId,
        legacyRawSalary: "EUR 90000/year",
      },
      market: { ok: true, recordStatus: "not_requested", jobId },
    });
    expect(JSON.stringify(absentAudit)).not.toContain('"jobKey"');
    expect(parseCompensationAudit(JSON.stringify(absentAudit))).toEqual(absentAudit);

    installCompensationTables(db);
    insertRecordedCompensation(db, locator);
    const recordedAudit = JSON.parse(buildCompensationProjection(db, locator, jobId).auditJson);

    expect(recordedAudit.posted.fact.jobId).toBe(jobId);
    expect(recordedAudit.market.estimate.jobId).toBe(jobId);
    expect(JSON.stringify(recordedAudit)).not.toContain('"jobKey"');

    recordedAudit.posted.fact.jobKey = locator;
    expect(parseCompensationAudit(JSON.stringify(recordedAudit))).toBeNull();
    db.close();
  });
});

function installCompensationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE job_posted_compensation_facts (
      tenant_id TEXT, job_url TEXT, source_field TEXT, source_text TEXT,
      legacy_raw_salary TEXT, parse_state TEXT, currency TEXT, period TEXT,
      component TEXT, minimum_amount INTEGER, maximum_amount INTEGER,
      annualized_minimum_amount INTEGER, annualized_maximum_amount INTEGER,
      annualization_assumption TEXT, confidence TEXT, warnings_json TEXT,
      parser_version TEXT, source_hash TEXT, parsed_at TEXT
    );
    CREATE TABLE job_market_compensation_estimates (
      tenant_id TEXT, job_url TEXT, estimate_state TEXT, currency TEXT,
      period TEXT, component TEXT, minimum_amount INTEGER, maximum_amount INTEGER,
      confidence_interval_minimum_amount INTEGER,
      confidence_interval_maximum_amount INTEGER, confidence_band TEXT,
      confidence_score REAL, source_count INTEGER, sample_count INTEGER,
      aggregate_bucket TEXT, geography_scope TEXT, occupation_code TEXT,
      occupation_label TEXT, seniority_label TEXT, source_snapshot_json TEXT,
      factor_reasons_json TEXT, selected_evidence_json TEXT,
      insufficient_reasons_json TEXT, unsupported_reasons_json TEXT,
      source_unavailable_reasons_json TEXT, warnings_json TEXT,
      estimator_version TEXT, estimated_at TEXT, company_name TEXT,
      normalized_company TEXT, role_title TEXT, normalized_role TEXT,
      company_tier TEXT, match_scope TEXT
    );
  `);
}

function insertRecordedCompensation(db: Database.Database, locator: string): void {
  db.prepare(
    `INSERT INTO job_posted_compensation_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    locator,
    "jobs.salary",
    "EUR 90000/year",
    "EUR 90000/year",
    "parsed_range",
    "EUR",
    "year",
    "base_salary",
    90000,
    120000,
    90000,
    120000,
    null,
    "high",
    "[]",
    "posted-compensation-v1",
    "hash-posted",
    "2026-07-31T00:00:00Z",
  );
  db.prepare(
    `INSERT INTO job_market_compensation_estimates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    locator,
    "estimated_range",
    "EUR",
    "year",
    "total_compensation",
    100000,
    130000,
    90000,
    140000,
    "medium",
    0.75,
    1,
    1,
    "reported company-role compensation",
    "Europe",
    null,
    null,
    null,
    "[]",
    "[]",
    "[]",
    "[]",
    "[]",
    "[]",
    "[]",
    "company-role-reported-compensation-v1",
    "2026-07-31T00:00:00Z",
    null,
    null,
    null,
    null,
    "unknown",
    "none",
  );
}
