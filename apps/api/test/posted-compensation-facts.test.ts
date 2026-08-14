import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { PostedCompensationFactResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const PARSED_JOB_ID = "11111111-1111-4111-8111-111111111111";
const PARSED_JOB_URL = "https://example.com/jobs/parsed";
const NOT_RECORDED_JOB_ID = "11111111-1111-4111-8111-111111111112";
const MISSING_JOB_ID = "11111111-1111-4111-8111-111111111113";
const UNPARSEABLE_JOB_ID = "11111111-1111-4111-8111-111111111114";
const AMBIGUOUS_JOB_ID = "11111111-1111-4111-8111-111111111115";
const UNKNOWN_JOB_ID = "11111111-1111-4111-8111-111111111199";

function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-posted-compensation-"));
  const dbPath = path.join(dir, "jobs.db");
  seedDatabase(dbPath);
  const app = buildApp({
    dbPath,
    configPath: path.join(dir, "config.json"),
  });
  return {
    app,
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function seedDatabase(dbPath: string): void {
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  insertJob(
    db,
    PARSED_JOB_ID,
    PARSED_JOB_URL,
    "Parsed Salary",
    "€80,000-€95,000/year",
    "Short description",
    "Full private description that must never appear",
  );
  insertJob(
    db,
    NOT_RECORDED_JOB_ID,
    "https://example.com/jobs/not-recorded",
    "Not Recorded",
    "€77,000/year",
    "Short description",
    "Private description",
  );
  db.close();
}

function insertJob(
  db: Database.Database,
  jobId: string,
  url: string,
  title: string,
  salary: string | null,
  description: string,
  fullDescription: string,
): void {
  db.prepare(
    `INSERT INTO jobs (
      tenant_id, job_id, url, title, salary, description, full_description
    ) VALUES ('local', ?, ?, ?, ?, ?, ?)`,
  ).run(jobId, url, title, salary, description, fullDescription);
}

function insertFact(
  dbPath: string,
  jobId: string,
  values: Partial<{
    sourceText: string | null;
    legacyRawSalary: string | null;
    parseState: string;
    currency: string | null;
    period: string;
    component: string;
    minimumAmount: number | null;
    maximumAmount: number | null;
    annualizedMinimumAmount: number | null;
    annualizedMaximumAmount: number | null;
    annualizationAssumption: string | null;
    confidence: string;
    warnings: string[];
  }> = {},
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_id, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobId,
    "jobs.salary",
    values.sourceText ?? "€80,000-€95,000/year",
    values.legacyRawSalary ?? "€80,000-€95,000/year",
    values.parseState ?? "parsed_range",
    values.currency ?? "EUR",
    values.period ?? "year",
    values.component ?? "base_salary",
    values.minimumAmount ?? 80_000,
    values.maximumAmount ?? 95_000,
    values.annualizedMinimumAmount ?? 80_000,
    values.annualizedMaximumAmount ?? 95_000,
    values.annualizationAssumption ?? "Source text states annual compensation.",
    values.confidence ?? "high",
    JSON.stringify(values.warnings ?? []),
    "posted-compensation-v1",
    "a".repeat(64),
    "2026-06-19T10:00:00Z",
  );
  db.close();
}

function factCount(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM job_posted_compensation_facts")
    .get() as { count: number };
  db.close();
  return Number(row.count);
}

describe("posted compensation facts API", () => {
  it("serves a recorded parsed posted compensation fact", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertFact(dbPath, PARSED_JOB_ID, { warnings: ["broad_range"] });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent(PARSED_JOB_URL)}/compensation/posted`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as PostedCompensationFactResponse;
      expect(body).toMatchObject({
        ok: true,
        recordStatus: "recorded",
        fact: {
          tenantId: "local",
          jobKey: PARSED_JOB_ID,
          sourceField: "jobs.salary",
          sourceText: "€80,000-€95,000/year",
          legacyRawSalary: "€80,000-€95,000/year",
          parseState: "parsed_range",
          currency: "EUR",
          period: "year",
          component: "base_salary",
          minimumAmount: 80_000,
          maximumAmount: 95_000,
          annualizedMinimumAmount: 80_000,
          annualizedMaximumAmount: 95_000,
          annualizationAssumption: "Source text states annual compensation.",
          confidence: "high",
          warnings: [
            {
              code: "broad_range",
              message: "The posted range is broad enough to reduce precision.",
            },
          ],
        },
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("serves the audited warning for a high-value salary inferred as annual", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertFact(dbPath, PARSED_JOB_ID, {
      sourceText: "Salary up to $356,500 USD",
      legacyRawSalary: "Salary up to $356,500 USD",
      currency: "USD",
      period: "year",
      component: "base_salary",
      maximumAmount: 356_500,
      annualizedMaximumAmount: 356_500,
      annualizationAssumption:
        "High-value employer-stated salary is treated as annual because no shorter pay period was stated.",
      confidence: "medium",
      warnings: ["annual_period_inferred", "one_sided_range"],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${PARSED_JOB_ID}/compensation/posted`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as PostedCompensationFactResponse;
      expect(body).toMatchObject({
        ok: true,
        recordStatus: "recorded",
        fact: {
          parseState: "parsed_range",
          period: "year",
          annualizedMaximumAmount: 356_500,
          annualizationAssumption:
            "High-value employer-stated salary is treated as annual because no shorter pay period was stated.",
          confidence: "medium",
          warnings: [
            {
              code: "annual_period_inferred",
              message:
                "The posting states a high-value salary without a shorter pay period, so JobCtrl treats it as annual.",
            },
            {
              code: "one_sided_range",
              message: "The posted range is one-sided.",
            },
          ],
        },
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("serves missing, unparseable, and ambiguous canonical facts without normalized range fields", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    const db = new Database(dbPath);
    for (const [jobId, jobUrl, salary] of [
      [MISSING_JOB_ID, "https://example.com/jobs/missing", null],
      [UNPARSEABLE_JOB_ID, "https://example.com/jobs/unparseable", "Competitive package"],
      [AMBIGUOUS_JOB_ID, "https://example.com/jobs/ambiguous", "€70k base plus €30k bonus plus €100k OTE"],
    ] as const) {
      insertJob(
        db,
        jobId,
        jobUrl,
        jobUrl.split("/").at(-1) ?? jobId,
        salary,
        "Short",
        "Private",
      );
    }
    db.close();
    insertFact(dbPath, MISSING_JOB_ID, {
      sourceText: null,
      legacyRawSalary: null,
      parseState: "missing",
      currency: null,
      period: "unknown",
      component: "unknown",
      minimumAmount: null,
      maximumAmount: null,
      annualizedMinimumAmount: null,
      annualizedMaximumAmount: null,
      annualizationAssumption: null,
      confidence: "none",
      warnings: [],
    });
    insertFact(dbPath, UNPARSEABLE_JOB_ID, {
      sourceText: "Competitive package",
      legacyRawSalary: "Competitive package",
      parseState: "unparseable",
      confidence: "low",
      warnings: ["no_amount_found"],
    });
    insertFact(dbPath, AMBIGUOUS_JOB_ID, {
      sourceText: "€70k base plus €30k bonus plus €100k OTE",
      legacyRawSalary: "€70k base plus €30k bonus plus €100k OTE",
      parseState: "ambiguous",
      confidence: "low",
      warnings: ["ambiguous_multiple_amounts", "bonus_component", "ote_component"],
    });
    try {
      for (const [jobId, parseState] of [
        [MISSING_JOB_ID, "missing"],
        [UNPARSEABLE_JOB_ID, "unparseable"],
        [AMBIGUOUS_JOB_ID, "ambiguous"],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/jobs/${jobId}/compensation/posted`,
        });
        const body = response.json() as PostedCompensationFactResponse;
        expect(response.statusCode, response.body).toBe(200);
        expect(body.recordStatus).toBe("recorded");
        if (body.recordStatus === "recorded") {
          expect(body.fact.parseState).toBe(parseState);
          expect(body.fact).not.toHaveProperty("minimumAmount");
          expect(body.fact).not.toHaveProperty("annualizedMinimumAmount");
        }
      }
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns an explicit not-recorded response without writing on read", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    try {
      expect(factCount(dbPath)).toBe(0);
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${NOT_RECORDED_JOB_ID}/compensation/posted`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_recorded",
        jobKey: NOT_RECORDED_JOB_ID,
        legacyRawSalary: "€77,000/year",
      });
      expect(factCount(dbPath)).toBe(0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns 404 for unknown jobs and does not leak private source data", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertFact(dbPath, PARSED_JOB_ID);
    try {
      const missing = await app.inject({
        method: "GET",
        url: `/v1/jobs/${UNKNOWN_JOB_ID}/compensation/posted`,
      });
      expect(missing.statusCode, missing.body).toBe(404);

      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${PARSED_JOB_ID}/compensation/posted`,
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain("Full private description");
      expect(serialized).not.toContain("rawProviderPayload");
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("glassdoor");
      expect(serialized).not.toContain("levels");
    } finally {
      await app.close();
      cleanup();
    }
  });
});
