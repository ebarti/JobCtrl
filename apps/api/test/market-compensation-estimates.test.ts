import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { MarketCompensationEstimateResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";

function withTempApp(options: { estimateTable?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-market-compensation-"));
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

function seedDatabase(dbPath: string, options: { estimateTable?: boolean }): void {
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
    "https://example.com/jobs/estimated",
    "Estimated Salary",
    "€80,000-€95,000/year",
    "Short description",
    "Full private description that must never appear",
  );
  db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
    "https://example.com/jobs/not-requested",
    "Not Requested",
    "€77,000/year",
    "Short description",
    "Private description",
  );
  if (options.estimateTable ?? true) {
    createEstimateTable(db);
  }
  db.close();
}

function createEstimateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE job_market_compensation_estimates (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      estimate_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'year',
      component TEXT NOT NULL DEFAULT 'base_salary',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
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
      insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
      unsupported_reasons_json TEXT NOT NULL DEFAULT '[]',
      source_unavailable_reasons_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      estimator_version TEXT NOT NULL,
      estimated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
  `);
}

function insertEstimate(
  dbPath: string,
  jobUrl: string,
  values: Partial<{
    state: string;
    currency: string | null;
    minimumAmount: number | null;
    maximumAmount: number | null;
    confidenceBand: string;
    confidenceScore: number;
    sourceCount: number;
    sampleCount: number | null;
    aggregateBucket: string | null;
    geographyScope: string | null;
    occupationCode: string | null;
    occupationLabel: string | null;
    seniorityLabel: string | null;
    sources: unknown[];
    factors: unknown[];
    insufficientReasons: string[];
    unsupportedReasons: string[];
    sourceUnavailableReasons: string[];
    warnings: string[];
  }> = {},
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
      tenant_id, job_url, estimate_state, currency, period, component, minimum_amount, maximum_amount,
      confidence_band, confidence_score, source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json, factor_reasons_json,
      insufficient_reasons_json, unsupported_reasons_json, source_unavailable_reasons_json, warnings_json,
      estimator_version, estimated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    values.state ?? "estimated_range",
    values.currency === undefined ? "EUR" : values.currency,
    "year",
    "base_salary",
    values.minimumAmount === undefined ? 72_000 : values.minimumAmount,
    values.maximumAmount === undefined ? 92_000 : values.maximumAmount,
    values.confidenceBand ?? "medium",
    values.confidenceScore ?? 0.82,
    values.sourceCount ?? 2,
    values.sampleCount ?? 900,
    values.aggregateBucket ?? "Eurostat SES occupation/country aggregate",
    values.geographyScope ?? "remote_europe",
    values.occupationCode ?? "2512.1",
    values.occupationLabel ?? "Software developer",
    values.seniorityLabel ?? "aggregate",
    JSON.stringify(
      values.sources ?? [
        {
          source_id: "eurostat_structure_of_earnings",
          display_name: "Eurostat Structure of Earnings Survey",
          source_type: "public_wage_baseline",
          release_year: 2024,
          snapshot_version: "synthetic-public-fixture",
          geography_scope: "EU",
          aggregate_bucket: "Eurostat SES occupation/country aggregate",
          attribution: "Eurostat public statistical aggregate",
          sample_count: 900,
        },
        {
          source_id: "esco_occupation_taxonomy",
          display_name: "ESCO occupation taxonomy",
          source_type: "occupation_taxonomy",
          release_year: 2024,
          snapshot_version: "synthetic-public-fixture",
          geography_scope: "Europe",
          aggregate_bucket: "ESCO software developer",
          attribution: "ESCO public occupation taxonomy",
          sample_count: null,
        },
      ],
    ),
    JSON.stringify(
      values.factors ?? [
        { name: "occupation", score: 0.9, band: "high", reason: "Occupation mapped to Software developer." },
      ],
    ),
    JSON.stringify(values.insufficientReasons ?? []),
    JSON.stringify(values.unsupportedReasons ?? []),
    JSON.stringify(values.sourceUnavailableReasons ?? []),
    JSON.stringify(values.warnings ?? ["aggregate_baseline", "remote_europe_assumption"]),
    "market-compensation-v1",
    "2026-06-19T10:00:00Z",
  );
  db.close();
}

function estimateCount(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM job_market_compensation_estimates")
    .get() as { count: number };
  db.close();
  return Number(row.count);
}

describe("market compensation estimates API", () => {
  it("serves a recorded estimated range with Europe public aggregate evidence", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, "https://example.com/jobs/estimated");
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/estimated")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as MarketCompensationEstimateResponse;
      expect(body).toMatchObject({
        ok: true,
        recordStatus: "recorded",
        estimate: {
          tenantId: "local",
          jobKey: "https://example.com/jobs/estimated",
          estimateState: "estimated_range",
          currency: "EUR",
          period: "year",
          component: "base_salary",
          minimumAmount: 72_000,
          maximumAmount: 92_000,
          confidenceBand: "medium",
          confidenceScore: 0.82,
          sourceCount: 2,
          sampleCount: 900,
          warnings: [
            {
              code: "aggregate_baseline",
              message: "The market estimate is based on public occupation/location aggregate data.",
            },
            {
              code: "remote_europe_assumption",
              message: "The estimate maps a remote-Europe role to a Europe aggregate baseline.",
            },
          ],
        },
      });
      expect(body.recordStatus === "recorded" && body.estimate.sources.map((source) => source.sourceId)).toEqual([
        "eurostat_structure_of_earnings",
        "esco_occupation_taxonomy",
      ]);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("serves unsupported, source-unavailable, and insufficient-evidence rows without range fields", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    const db = new Database(dbPath);
    for (const [jobUrl, title] of [
      ["https://example.com/jobs/unsupported", "Unsupported"],
      ["https://example.com/jobs/unavailable", "Unavailable"],
      ["https://example.com/jobs/insufficient", "Insufficient"],
    ] as const) {
      db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
        jobUrl,
        title,
        null,
        "Short",
        "Private",
      );
    }
    db.close();
    insertEstimate(dbPath, "https://example.com/jobs/unsupported", {
      state: "unsupported",
      minimumAmount: null,
      maximumAmount: null,
      confidenceBand: "none",
      confidenceScore: 0,
      sourceCount: 0,
      sampleCount: null,
      unsupportedReasons: ["unsupported_geography"],
      warnings: [],
    });
    insertEstimate(dbPath, "https://example.com/jobs/unavailable", {
      state: "source_unavailable",
      minimumAmount: null,
      maximumAmount: null,
      confidenceBand: "none",
      confidenceScore: 0,
      sourceUnavailableReasons: ["stale_source_snapshot"],
      warnings: ["stale_source_snapshot"],
    });
    insertEstimate(dbPath, "https://example.com/jobs/insufficient", {
      state: "insufficient_evidence",
      minimumAmount: null,
      maximumAmount: null,
      confidenceBand: "low",
      confidenceScore: 0.55,
      insufficientReasons: ["low_sample_count"],
      warnings: ["low_sample_count"],
    });
    try {
      for (const [jobUrl, state, reasonKey] of [
        ["https://example.com/jobs/unsupported", "unsupported", "unsupportedReasons"],
        ["https://example.com/jobs/unavailable", "source_unavailable", "sourceUnavailableReasons"],
        ["https://example.com/jobs/insufficient", "insufficient_evidence", "insufficientReasons"],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(jobUrl)}/compensation/market`,
        });
        expect(response.statusCode, response.body).toBe(200);
        const estimate = (
          (response.json() as Extract<MarketCompensationEstimateResponse, { recordStatus: "recorded" }>)
            .estimate as unknown
        ) as Record<string, unknown>;
        expect(estimate.estimateState).toBe(state);
        expect(estimate).not.toHaveProperty("minimumAmount");
        expect(estimate).not.toHaveProperty("maximumAmount");
        expect(estimate[reasonKey]).toEqual(expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]));
      }
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns not-requested without writing on read", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    try {
      expect(estimateCount(dbPath)).toBe(0);
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/not-requested")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_requested",
        jobKey: "https://example.com/jobs/not-requested",
      });
      expect(estimateCount(dbPath)).toBe(0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns not-requested when the market estimate table does not exist", async () => {
    const { app, cleanup } = withTempApp({ estimateTable: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/not-requested")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        recordStatus: "not_requested",
        jobKey: "https://example.com/jobs/not-requested",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("defensively treats persisted not-requested rows as not requested", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, "https://example.com/jobs/estimated", {
      state: "not_requested",
      minimumAmount: null,
      maximumAmount: null,
      confidenceBand: "none",
      confidenceScore: 0,
      sourceCount: 0,
      sampleCount: null,
      sources: [],
      factors: [],
      warnings: [],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/estimated")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_requested",
        jobKey: "https://example.com/jobs/estimated",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns 404 for unknown jobs", async () => {
    const { app, cleanup } = withTempApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/missing")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ ok: false, error: "job_not_found" });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("drops unsafe source JSON and does not leak private data", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, "https://example.com/jobs/estimated", {
      sources: [
        {
          source_id: "eurostat_structure_of_earnings",
          display_name: "Glassdoor private payload",
          source_type: "public_wage_baseline",
          release_year: 2024,
          snapshot_version: "rawProviderPayload",
          geography_scope: "United States /Users/private",
          aggregate_bucket: "BLS SOC private benchmark",
          attribution: "credential secret",
          sample_count: 900,
        },
        {
          source_id: "glassdoor",
          display_name: "Glassdoor",
          source_type: "licensed_market_benchmark",
          release_year: 2026,
          snapshot_version: "rawProviderPayload",
          geography_scope: "/Users/private",
          aggregate_bucket: "US private page",
          attribution: "credential secret",
          sample_count: 1,
        },
      ],
      warnings: ["aggregate_baseline", "unknown_warning"],
      unsupportedReasons: ["unsupported_source", "unknown_reason"],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/estimated")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const serialized = JSON.stringify(response.json()).toLowerCase();
      const body = response.json() as Extract<MarketCompensationEstimateResponse, { recordStatus: "recorded" }>;
      expect(body.estimate.sources.map((source) => source.sourceId)).toEqual(["eurostat_structure_of_earnings"]);
      expect(body.estimate.sources[0]).toMatchObject({
        displayName: "Eurostat Structure of Earnings Survey",
      });
      expect(serialized).not.toContain("full private description");
      expect(serialized).not.toContain("glassdoor");
      expect(serialized).not.toContain("levels");
      expect(serialized).not.toContain("united states");
      expect(serialized).not.toContain("bls");
      expect(serialized).not.toContain("soc");
      expect(serialized).not.toContain("rawproviderpayload");
      expect(serialized).not.toContain("/users/");
      expect(serialized).not.toContain("credential secret");
    } finally {
      await app.close();
      cleanup();
    }
  });
});
