import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { PostedCompensationFactResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";

function withTempApp(options: { factTable?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-posted-compensation-"));
  const dbPath = path.join(dir, "jobs.db");
  seedDatabase(dbPath, options);
  const app = buildApp({
    dbPath,
    settingsPath: path.join(dir, "dashboard.json"),
  });
  return {
    app,
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function seedDatabase(dbPath: string, options: { factTable?: boolean }): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      salary TEXT,
      description TEXT,
      full_description TEXT
    );
  `);
  db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
    "https://example.com/jobs/parsed",
    "Parsed Salary",
    "€80,000-€95,000/year",
    "Short description",
    "Full private description that must never appear",
  );
  db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
    "https://example.com/jobs/not-recorded",
    "Not Recorded",
    "€77,000/year",
    "Short description",
    "Private description",
  );
  if (options.factTable ?? true) {
    createFactTable(db);
  }
  db.close();
}

function createFactTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE job_posted_compensation_facts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
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
      PRIMARY KEY (tenant_id, job_url)
    );
  `);
}

function insertFact(
  dbPath: string,
  jobUrl: string,
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
      tenant_id, job_url, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
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
    insertFact(dbPath, "https://example.com/jobs/parsed", { warnings: ["broad_range"] });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/parsed")}/compensation/posted`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as PostedCompensationFactResponse;
      expect(body).toMatchObject({
        ok: true,
        recordStatus: "recorded",
        fact: {
          tenantId: "local",
          jobKey: "https://example.com/jobs/parsed",
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

  it("serves missing, unparseable, and ambiguous canonical facts without normalized range fields", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    const db = new Database(dbPath);
    for (const [jobUrl, salary] of [
      ["https://example.com/jobs/missing", null],
      ["https://example.com/jobs/unparseable", "Competitive package"],
      ["https://example.com/jobs/ambiguous", "€70k base plus €30k bonus plus €100k OTE"],
    ] as const) {
      db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
        jobUrl,
        jobUrl.split("/").at(-1),
        salary,
        "Short",
        "Private",
      );
    }
    db.close();
    insertFact(dbPath, "https://example.com/jobs/missing", {
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
    insertFact(dbPath, "https://example.com/jobs/unparseable", {
      sourceText: "Competitive package",
      legacyRawSalary: "Competitive package",
      parseState: "unparseable",
      confidence: "low",
      warnings: ["no_amount_found"],
    });
    insertFact(dbPath, "https://example.com/jobs/ambiguous", {
      sourceText: "€70k base plus €30k bonus plus €100k OTE",
      legacyRawSalary: "€70k base plus €30k bonus plus €100k OTE",
      parseState: "ambiguous",
      confidence: "low",
      warnings: ["ambiguous_multiple_amounts", "bonus_component", "ote_component"],
    });
    try {
      for (const [jobUrl, parseState] of [
        ["https://example.com/jobs/missing", "missing"],
        ["https://example.com/jobs/unparseable", "unparseable"],
        ["https://example.com/jobs/ambiguous", "ambiguous"],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(jobUrl)}/compensation/posted`,
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
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/not-recorded")}/compensation/posted`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_recorded",
        jobKey: "https://example.com/jobs/not-recorded",
        legacyRawSalary: "€77,000/year",
      });
      expect(factCount(dbPath)).toBe(0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns not-recorded for older databases without a fact table", async () => {
    const { app, cleanup } = withTempApp({ factTable: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/not-recorded")}/compensation/posted`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        recordStatus: "not_recorded",
        legacyRawSalary: "€77,000/year",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns 404 for unknown jobs and does not leak private source data", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertFact(dbPath, "https://example.com/jobs/parsed");
    try {
      const missing = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/missing-job")}/compensation/posted`,
      });
      expect(missing.statusCode, missing.body).toBe(404);

      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/parsed")}/compensation/posted`,
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
