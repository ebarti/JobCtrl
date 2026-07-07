import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { MarketCompensationEstimateResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";

function withTempApp(options: { estimateTable?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-market-compensation-"));
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
    "€100,000-€130,000/year",
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
      component TEXT NOT NULL DEFAULT 'total_compensation',
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
    companyName: string | null;
    normalizedCompany: string | null;
    roleTitle: string | null;
    normalizedRole: string | null;
    companyTier: string;
    matchScope: string;
    sources: unknown[];
    factors: unknown[];
    evidence: unknown[];
    insufficientReasons: string[];
    unsupportedReasons: string[];
    sourceUnavailableReasons: string[];
    warnings: string[];
    estimatorVersion: string;
  }> = {},
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
      tenant_id, job_url, estimate_state, currency, period, component, minimum_amount, maximum_amount,
      confidence_band, confidence_score, source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json, factor_reasons_json,
      selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json, source_unavailable_reasons_json, warnings_json,
      estimator_version, estimated_at, company_name, normalized_company, role_title, normalized_role,
      company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    values.state ?? "estimated_range",
    values.currency === undefined ? "EUR" : values.currency,
    "year",
    "total_compensation",
    values.minimumAmount === undefined ? 112_000 : values.minimumAmount,
    values.maximumAmount === undefined ? 142_000 : values.maximumAmount,
    values.confidenceBand ?? "medium",
    values.confidenceScore ?? 0.82,
    values.sourceCount ?? 2,
    values.sampleCount ?? 7,
    values.aggregateBucket ?? "reported company-role compensation",
    values.geographyScope ?? "Europe",
    values.occupationCode ?? "acme ai",
    values.occupationLabel ?? "platform engineer",
    values.seniorityLabel ?? "senior",
    JSON.stringify(
      values.sources ?? [
        {
          source_id: "levels_fyi",
          display_name: "Levels.fyi",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "reported-compensation-import-v1",
          geography_scope: "Europe",
          aggregate_bucket: "reported company-role compensation",
          attribution: "Levels.fyi reported compensation data",
          sample_count: 4,
        },
        {
          source_id: "glassdoor",
          display_name: "Glassdoor",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "reported-compensation-import-v1",
          geography_scope: "Europe",
          aggregate_bucket: "reported company-role compensation",
          attribution: "Glassdoor reported compensation data",
          sample_count: 3,
        },
      ],
    ),
    JSON.stringify(
      values.factors ?? [
        { name: "company", score: 1, band: "high", reason: "Company matched Acme AI." },
        { name: "role", score: 1, band: "high", reason: "Role matched Senior Platform Engineer." },
      ],
    ),
    JSON.stringify(
      values.evidence ?? [
        {
          source_id: "levels_fyi",
          source_url: "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
          company_name: values.companyName ?? "Acme AI",
          role_title: values.roleTitle ?? "Senior Platform Engineer",
          location: "Europe",
          level_label: "senior",
          company_tier: values.companyTier ?? "tier_2_ambitious",
          component: "total_compensation",
          currency: "EUR",
          period: "year",
          minimum_amount: values.minimumAmount === undefined ? 112_000 : values.minimumAmount,
          maximum_amount: values.maximumAmount === undefined ? 142_000 : values.maximumAmount,
          sample_count: values.sampleCount ?? 4,
          release_year: 2026,
          company_score: 1,
          role_score: 0.96,
          level_score: 0.95,
          location_score: 0.78,
          freshness_score: 0.95,
        },
      ],
    ),
    JSON.stringify(values.insufficientReasons ?? []),
    JSON.stringify(values.unsupportedReasons ?? []),
    JSON.stringify(values.sourceUnavailableReasons ?? []),
    JSON.stringify(values.warnings ?? ["reported_compensation_sample"]),
    values.estimatorVersion ?? "company-role-reported-compensation-v1",
    "2026-06-19T10:00:00Z",
    values.companyName ?? "Acme AI",
    values.normalizedCompany ?? "acme ai",
    values.roleTitle ?? "Senior Platform Engineer",
    values.normalizedRole ?? "platform engineer",
    values.companyTier ?? "tier_2_ambitious",
    values.matchScope ?? "exact_company_role",
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
  it("serves a recorded company-role reported compensation range", async () => {
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
          component: "total_compensation",
          minimumAmount: 112_000,
          maximumAmount: 142_000,
          confidenceBand: "medium",
          confidenceScore: 0.82,
          sourceCount: 2,
          sampleCount: 7,
          companyName: "Acme AI",
          normalizedCompany: "acme ai",
          roleTitle: "Senior Platform Engineer",
          normalizedRole: "platform engineer",
          companyTier: "tier_2_ambitious",
          matchScope: "exact_company_role",
          warnings: [
            {
              code: "reported_compensation_sample",
              message: "The estimate uses reported compensation rows for the job company and role.",
            },
          ],
        },
      });
      expect(body.recordStatus === "recorded" && body.estimate.sources.map((source) => source.sourceId)).toEqual([
        "levels_fyi",
        "glassdoor",
      ]);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("serves trimodal fallback and source-conflict evidence from canonical market rows", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    const db = new Database(dbPath);
    db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
      "https://example.com/jobs/trimodal",
      "Trimodal Fallback",
      "€70,000-€82,000/year",
      "Synthetic trimodal fallback description",
      "Synthetic full description that must never appear",
    );
    db.close();
    insertEstimate(dbPath, "https://example.com/jobs/trimodal", {
      minimumAmount: 168_000,
      maximumAmount: 190_000,
      confidenceBand: "medium",
      confidenceScore: 0.62,
      sourceCount: 2,
      sampleCount: 7,
      aggregateBucket: "trimodal tier role fallback",
      geographyScope: "Europe",
      companyName: "Trimodal Labs",
      normalizedCompany: "trimodal labs",
      roleTitle: "Senior Platform Engineer",
      normalizedRole: "platform engineer",
      companyTier: "tier_3_top_of_market",
      matchScope: "tier_role_fallback",
      factors: [
        { name: "company", score: 0.62, band: "medium", reason: "Synthetic tier fallback company support." },
        { name: "role", score: 1, band: "high", reason: "Synthetic role support." },
        { name: "trimodal_tier", score: 0.62, band: "medium", reason: "Synthetic trimodal tier support." },
      ],
      warnings: [
        "reported_compensation_sample",
        "company_role_fallback",
        "trimodal_tier_inferred",
        "source_conflict_with_posted_salary",
      ],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/trimodal")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as Extract<MarketCompensationEstimateResponse, { recordStatus: "recorded" }>;
      expect(body.estimate).toMatchObject({
        estimateState: "estimated_range",
        minimumAmount: 168_000,
        maximumAmount: 190_000,
        confidenceBand: "medium",
        aggregateBucket: "trimodal tier role fallback",
        companyTier: "tier_3_top_of_market",
        matchScope: "tier_role_fallback",
      });
      expect(body.estimate.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining([
          "reported_compensation_sample",
          "company_role_fallback",
          "trimodal_tier_inferred",
          "source_conflict_with_posted_salary",
        ]),
      );
      expect(body.estimate.factors.map((factor) => factor.name)).toEqual(
        expect.arrayContaining(["company", "role", "trimodal_tier"]),
      );
      expect(body.estimate.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: "levels_fyi",
            sourceUrl: "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
            companyName: "Trimodal Labs",
            roleTitle: "Senior Platform Engineer",
            minimumAmount: 168_000,
            maximumAmount: 190_000,
            companyScore: 1,
            roleScore: 0.96,
          }),
        ]),
      );
      expect(body.estimate.sources.map((source) => source.sourceId)).toEqual(["levels_fyi", "glassdoor"]);
      const serialized = JSON.stringify(body).toLowerCase();
      for (const unsafe of [
        "/users/",
        "file://",
        "rawproviderpayload",
        "credential",
        "secret",
        "api_key",
        "token",
        "password",
        "synthetic full description",
      ]) {
        expect(serialized).not.toContain(unsafe);
      }
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
      unsupportedReasons: ["unsupported_component"],
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
      insufficientReasons: ["missing_reported_observation"],
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

  it("defensively treats unknown states and stale public-estimator rows as not requested", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, "https://example.com/jobs/estimated", {
      state: "corrupt_state",
      minimumAmount: 112_000,
      maximumAmount: 142_000,
    });
    const db = new Database(dbPath);
    db.prepare("INSERT INTO jobs (url, title, salary, description, full_description) VALUES (?, ?, ?, ?, ?)").run(
      "https://example.com/jobs/public-stale",
      "Public stale",
      "",
      "Short",
      "Private",
    );
    db.close();
    insertEstimate(dbPath, "https://example.com/jobs/public-stale", {
      estimatorVersion: "market-compensation-v1",
    });
    try {
      for (const jobKey of ["https://example.com/jobs/estimated", "https://example.com/jobs/public-stale"]) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(jobKey)}/compensation/market`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
          ok: true,
          recordStatus: "not_requested",
          jobKey,
        });
      }
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

  it("drops unsafe source JSON but allows reported provider identities", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, "https://example.com/jobs/estimated", {
      sources: [
        {
          source_id: "levels_fyi",
          display_name: "Levels.fyi private payload",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "rawProviderPayload",
          geography_scope: "/Users/private",
          aggregate_bucket: "private page",
          attribution: "credential secret",
          sample_count: 7,
        },
        {
          source_id: "eurostat_structure_of_earnings",
          display_name: "Eurostat stale public row",
          source_type: "public_wage_baseline",
          release_year: 2024,
          snapshot_version: "synthetic-public-fixture",
          geography_scope: "EU",
          aggregate_bucket: "Eurostat aggregate",
          attribution: "Eurostat",
          sample_count: 900,
        },
      ],
      warnings: ["reported_compensation_sample", "unknown_warning"],
      unsupportedReasons: ["unsupported_source", "unknown_reason"],
      aggregateBucket: "private page",
      geographyScope: "/Users/private",
      factors: [
        { name: "company", score: 1, band: "high", reason: "private /Users/local credential" },
        { name: "sample", score: 0.5, band: "low", reason: "Reported compensation sample count: 1." },
      ],
      evidence: [
        {
          source_id: "levels_fyi",
          source_url: "https://levels.example/private?token=secret",
          company_name: "private /Users/local credential",
          role_title: "Senior Platform Engineer",
          location: "file:///Users/local/private",
          level_label: "senior",
          company_tier: "tier_2_ambitious",
          component: "total_compensation",
          currency: "EUR",
          period: "year",
          minimum_amount: 112_000,
          maximum_amount: 142_000,
          sample_count: 4,
          release_year: 2026,
          company_score: 1,
          role_score: 0.96,
          level_score: 0.95,
          location_score: 0.78,
          freshness_score: 0.95,
        },
      ],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/estimated")}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const serialized = JSON.stringify(response.json()).toLowerCase();
      const body = response.json() as Extract<MarketCompensationEstimateResponse, { recordStatus: "recorded" }>;
      expect(body.estimate.sources.map((source) => source.sourceId)).toEqual(["levels_fyi"]);
      expect(body.estimate.sources[0]).toMatchObject({
        displayName: "Levels.fyi",
        sourceType: "reported_compensation",
      });
      expect(serialized).toContain("levels.fyi");
      expect(serialized).not.toContain("full private description");
      expect(serialized).not.toContain("eurostat");
      expect(serialized).not.toContain("private page");
      expect(serialized).not.toContain("rawproviderpayload");
      expect(serialized).not.toContain("/users/");
      expect(serialized).not.toContain("/users/local");
      expect(serialized).not.toContain("credential");
      expect(serialized).not.toContain("credential secret");
      expect(body.estimate.geographyScope).toBeNull();
      expect(body.estimate.factors[0]?.reason).toBe(
        "Reported compensation estimate factor recorded by the deterministic company-role estimator.",
      );
      expect(body.estimate.factors[1]?.reason).toBe("Reported compensation sample count: 1.");
      expect(body.estimate.evidence[0]).toMatchObject({
        sourceUrl: null,
        companyName: "unknown company",
        roleTitle: "Senior Platform Engineer",
        location: null,
      });
    } finally {
      await app.close();
      cleanup();
    }
  });
});
