import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { buildCompensationProjection } from "../src/projections.js";
import { parseCompensationAudit } from "../src/read-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

describe("compensation audit identity contract", () => {
  it("emits the supplied jobId and rejects legacy jobKey audit payloads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-compensation-audit-v7-"));
    const dbPath = path.join(dir, "jobs.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    const locator = "https://example.com/jobs/legacy-locator";
    const jobId = "123e4567-e89b-12d3-a456-426614174000";
    db.prepare(
      "INSERT INTO jobs (tenant_id, job_id, url, salary) VALUES ('local', ?, ?, ?)",
    ).run(jobId, locator, "EUR 90000/year");

    const absentAudit = JSON.parse(buildCompensationProjection(db, "local", jobId).auditJson);
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

    insertRecordedCompensation(db, jobId);
    const recordedAudit = JSON.parse(buildCompensationProjection(db, "local", jobId).auditJson);

    expect(recordedAudit.posted.fact.jobId).toBe(jobId);
    expect(recordedAudit.market.estimate.jobId).toBe(jobId);
    expect(JSON.stringify(recordedAudit)).not.toContain('"jobKey"');

    db.prepare("INSERT INTO jobs (tenant_id, job_id, url, salary) VALUES ('other', ?, ?, ?)").run(
      jobId,
      "https://example.com/jobs/other-tenant",
      "EUR 50000/year",
    );
    insertRecordedCompensation(db, jobId, "other", 50_000, 60_000);
    const otherTenantAudit = JSON.parse(buildCompensationProjection(db, "other", jobId).auditJson);
    expect(otherTenantAudit.posted.fact).toMatchObject({
      tenantId: "other",
      jobId,
      minimumAmount: 50_000,
    });
    expect(otherTenantAudit.market.estimate).toMatchObject({
      tenantId: "other",
      jobId,
      minimumAmount: 60_000,
    });
    expect(recordedAudit.posted.fact.minimumAmount).toBe(90_000);

    recordedAudit.posted.fact.jobKey = locator;
    expect(parseCompensationAudit(JSON.stringify(recordedAudit))).toBeNull();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function insertRecordedCompensation(
  db: Database.Database,
  jobId: string,
  tenantId = "local",
  postedMinimum = 90_000,
  marketMinimum = 100_000,
): void {
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_id, source_field, source_text, legacy_raw_salary, parse_state,
      currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenantId,
    jobId,
    "jobs.salary",
    "EUR 90000/year",
    "EUR 90000/year",
    "parsed_range",
    "EUR",
    "year",
    "base_salary",
    postedMinimum,
    postedMinimum + 30_000,
    postedMinimum,
    postedMinimum + 30_000,
    null,
    "high",
    "[]",
    "posted-compensation-v1",
    "hash-posted",
    "2026-07-31T00:00:00Z",
  );
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
      tenant_id, job_id, estimate_state, currency, period, component,
      minimum_amount, maximum_amount, confidence_interval_minimum_amount,
      confidence_interval_maximum_amount, confidence_band, confidence_score,
      source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json,
      factor_reasons_json, selected_evidence_json, insufficient_reasons_json,
      unsupported_reasons_json, source_unavailable_reasons_json, warnings_json,
      estimator_version, estimated_at, company_name, normalized_company,
      role_title, normalized_role, company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenantId,
    jobId,
    "estimated_range",
    "EUR",
    "year",
    "total_compensation",
    marketMinimum,
    marketMinimum + 30_000,
    marketMinimum - 10_000,
    marketMinimum + 40_000,
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
