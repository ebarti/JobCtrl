import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { MarketCompensationEstimateResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const ESTIMATED_JOB_ID = "22222222-2222-4222-8222-222222222211";
const ESTIMATED_APPLICATION_URL = "https://apply.example.com/jobs/estimated";
const NOT_REQUESTED_JOB_ID = "22222222-2222-4222-8222-222222222212";
const TRIMODAL_JOB_ID = "22222222-2222-4222-8222-222222222213";
const UNSUPPORTED_JOB_ID = "22222222-2222-4222-8222-222222222214";
const UNAVAILABLE_JOB_ID = "22222222-2222-4222-8222-222222222215";
const INSUFFICIENT_JOB_ID = "22222222-2222-4222-8222-222222222216";
const STALE_ESTIMATOR_JOB_ID = "22222222-2222-4222-8222-222222222217";
const UNKNOWN_JOB_ID = "22222222-2222-4222-8222-222222222299";
const ANCHOR_DIRECT_FACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_PRICE_FACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_PRICE_FACT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXTRAPOLATED_FACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-market-compensation-"));
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
    ESTIMATED_JOB_ID,
    "https://example.com/jobs/estimated",
    "Estimated Salary",
    "€100,000-€130,000/year",
    "Short description",
    "Full private description that must never appear",
  );
  db.prepare("UPDATE jobs SET application_url = ? WHERE tenant_id = 'local' AND job_id = ?").run(
    ESTIMATED_APPLICATION_URL,
    ESTIMATED_JOB_ID,
  );
  insertJob(
    db,
    NOT_REQUESTED_JOB_ID,
    "https://example.com/jobs/not-requested",
    "Not Requested",
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

function insertEstimate(
  dbPath: string,
  jobId: string,
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
      tenant_id, job_id, estimate_state, currency, period, component, minimum_amount, maximum_amount,
      confidence_band, confidence_score, source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json, factor_reasons_json,
      selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json, source_unavailable_reasons_json, warnings_json,
      estimator_version, estimated_at, company_name, normalized_company, role_title, normalized_role,
      company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobId,
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

function insertCanonicalBenchmarkLineage(dbPath: string): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO compensation_role_families (
      taxonomy_version, role_family_code, display_name, isco_codes_json, created_at
    ) VALUES (
      'jobctrl-role-family-v1', 'software_engineering', 'Software Engineering',
      '["2512","2513","2514","2519"]', '2026-08-12T08:00:00.000000Z'
    )`,
  ).run();
  db.prepare(
    `INSERT INTO compensation_direct_benchmark_facts (
      tenant_id, fact_id, taxonomy_version, role_family_code, seniority_label,
      country_code, subdivision_code, locality, geography_scope, market_scope,
      normalized_company, component, original_currency, original_period,
      original_minimum_amount, original_maximum_amount,
      eur_annual_minimum_amount, eur_annual_maximum_amount,
      confidence_interval_minimum_amount, confidence_interval_maximum_amount,
      confidence_score, sample_count, source_id, source_provenance,
      source_snapshot_id, source_url, attribution, fx_reference_json,
      as_of_date, fetched_at, fresh_until, evidence_hash, created_at
    ) VALUES (
      'local', ?, 'jobctrl-role-family-v1', 'software_engineering', 'senior',
      'DE', '', '', 'country', 'market', NULL, 'total_compensation',
      'EUR', 'year', 60000, 90000, 60000, 90000, 55000, 100000,
      0.76, 20, 'levels_fyi', 'public', 'levels-public-germany',
      'https://www.levels.fyi/t/software-engineer',
      'Data source: Levels.fyi (https://www.levels.fyi)', '{}',
      '2026-01-01', '2026-08-12T08:00:00.000000Z',
      '2026-08-19T08:00:00.000000Z', ?, '2026-08-12T08:00:00.000000Z'
    )`,
  ).run(ANCHOR_DIRECT_FACT_ID, "a".repeat(64));
  const insertPrice = db.prepare(
    `INSERT INTO compensation_price_level_facts (
      tenant_id, fact_id, country_code, category, reference_year,
      base_geography_code, index_value, source_id, source_snapshot_id,
      source_url, attribution, as_of_date, fetched_at, fresh_until,
      evidence_hash, created_at
    ) VALUES (
      'local', ?, ?, 'actual_individual_consumption', 2025,
      'EU27_2020', ?, 'eurostat', 'eurostat-shared-snapshot',
      'https://ec.europa.eu/eurostat/', 'Eurostat purchasing power parities',
      '2025-12-31', '2026-08-12T08:00:00.000000Z',
      '2026-08-19T08:00:00.000000Z', ?, '2026-08-12T08:00:00.000000Z'
    )`,
  );
  insertPrice.run(SOURCE_PRICE_FACT_ID, "DE", 100, "b".repeat(64));
  insertPrice.run(TARGET_PRICE_FACT_ID, "ES", 2000, "c".repeat(64));
  db.prepare(
    `INSERT INTO compensation_extrapolated_benchmark_facts (
      tenant_id, fact_id, anchor_direct_fact_id, taxonomy_version,
      role_family_code, seniority_label, target_country_code,
      target_subdivision_code, target_locality, target_geography_scope,
      component, currency, period, minimum_amount, maximum_amount,
      confidence_interval_minimum_amount, confidence_interval_maximum_amount,
      confidence_band, confidence_score, extrapolation_method, raw_factor,
      shrinkage_weight, lower_factor_bound, upper_factor_bound,
      factor_bound_state, matched_company_count, formula_version, inputs_hash,
      warnings_json, as_of_date, derived_at, fresh_until
    ) VALUES (
      'local', ?, ?, 'jobctrl-role-family-v1', 'software_engineering', 'senior',
      'ES', '', '', 'country', 'total_compensation', 'EUR', 'year',
      1200000, 1800000, 900000, 2100000, 'low', 0.31,
      'evidence_weighted_shrinkage', 20, 0, 0.1, 10,
      'above_upper_bound', 0, 'geo-shrinkage-v1', ?,
      '["cost_of_living_only"]', '2026-01-01',
      '2026-08-12T08:00:00.000000Z', '2026-08-19T08:00:00.000000Z'
    )`,
  ).run(EXTRAPOLATED_FACT_ID, ANCHOR_DIRECT_FACT_ID, "d".repeat(64));
  db.prepare(
    `INSERT INTO compensation_extrapolation_direct_inputs (
      tenant_id, extrapolated_fact_id, direct_fact_id, input_role, weight
    ) VALUES ('local', ?, ?, 'anchor', 1)`,
  ).run(EXTRAPOLATED_FACT_ID, ANCHOR_DIRECT_FACT_ID);
  const insertPriceInput = db.prepare(
    `INSERT INTO compensation_extrapolation_price_inputs (
      tenant_id, extrapolated_fact_id, price_level_fact_id, input_role, weight
    ) VALUES ('local', ?, ?, ?, 1)`,
  );
  insertPriceInput.run(EXTRAPOLATED_FACT_ID, SOURCE_PRICE_FACT_ID, "source_price_level");
  insertPriceInput.run(EXTRAPOLATED_FACT_ID, TARGET_PRICE_FACT_ID, "target_price_level");
  db.close();
}

describe("market compensation estimates API", () => {
  it("serves a recorded company-role reported compensation range", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, ESTIMATED_JOB_ID);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent(ESTIMATED_APPLICATION_URL)}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as MarketCompensationEstimateResponse;
      expect(body).toMatchObject({
        ok: true,
        recordStatus: "recorded",
        estimate: {
          tenantId: "local",
          jobKey: ESTIMATED_JOB_ID,
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

  it("preserves canonical extrapolation warnings and geography lineage", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertCanonicalBenchmarkLineage(dbPath);
    insertEstimate(dbPath, ESTIMATED_JOB_ID, {
      minimumAmount: 1_200_000,
      maximumAmount: 1_800_000,
      confidenceBand: "low",
      confidenceScore: 0.31,
      sourceCount: 1,
      geographyScope: "country",
      sources: [
        {
          source_id: "levels_fyi",
          source_provenance: "public",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "levels-fyi-public-de-2026-08-12",
          geography_scope: "country",
          aggregate_bucket: "reported company-role compensation",
          attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
          sample_count: 4,
        },
      ],
      warnings: [
        "benchmark_extrapolated",
        "cost_of_living_only",
        "factor_out_of_bounds",
      ],
      estimatorVersion: `company-role-reported-compensation-canonical-benchmark-v1:extrapolated:${EXTRAPOLATED_FACT_ID}`,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${ESTIMATED_JOB_ID}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as Extract<
        MarketCompensationEstimateResponse,
        { recordStatus: "recorded" }
      >;
      expect(body.estimate).toMatchObject({
        minimumAmount: 1_200_000,
        maximumAmount: 1_800_000,
        geographyScope: "country",
      });
      expect(body.estimate.sources).toEqual([
        expect.objectContaining({
          sourceId: "levels_fyi",
          provenance: "public",
          geographyScope: "country",
        }),
      ]);
      expect(body.estimate.warnings.map((warning) => warning.code)).toEqual([
        "benchmark_extrapolated",
        "cost_of_living_only",
        "factor_out_of_bounds",
      ]);
      expect(body.estimate.benchmarkLineage).toEqual({
        kind: "extrapolated",
        factId: EXTRAPOLATED_FACT_ID,
        taxonomyVersion: "jobctrl-role-family-v1",
        roleFamilyCode: "software_engineering",
        seniorityLabel: "senior",
        targetGeography: {
          countryCode: "ES",
          subdivisionCode: null,
          locality: null,
          scope: "country",
        },
        component: "total_compensation",
        asOfDate: "2026-01-01",
        observedAt: "2026-08-12T08:00:00.000000Z",
        freshUntil: "2026-08-19T08:00:00.000000Z",
        directInputs: [
          expect.objectContaining({
            factId: ANCHOR_DIRECT_FACT_ID,
            inputRole: "anchor",
            weight: 1,
            geography: expect.objectContaining({ countryCode: "DE" }),
            minimumAmountEur: 60_000,
            maximumAmountEur: 90_000,
            sampleCount: 20,
            sourceId: "levels_fyi",
          }),
        ],
        priceLevelInputs: [
          expect.objectContaining({
            factId: SOURCE_PRICE_FACT_ID,
            inputRole: "source_price_level",
            countryCode: "DE",
            indexValue: 100,
            sourceId: "eurostat",
          }),
          expect.objectContaining({
            factId: TARGET_PRICE_FACT_ID,
            inputRole: "target_price_level",
            countryCode: "ES",
            indexValue: 2000,
            sourceId: "eurostat",
          }),
        ],
        anchorDirectFactId: ANCHOR_DIRECT_FACT_ID,
        anchorGeography: {
          countryCode: "DE",
          subdivisionCode: null,
          locality: null,
          scope: "country",
        },
        extrapolationMethod: "evidence_weighted_shrinkage",
        rawFactor: 20,
        shrinkageWeight: 0,
        lowerFactorBound: 0.1,
        upperFactorBound: 10,
        factorBoundState: "above_upper_bound",
        matchedCompanyCount: 0,
        formulaVersion: "geo-shrinkage-v1",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("exposes direct benchmark authority without geographic derivation inputs", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertCanonicalBenchmarkLineage(dbPath);
    insertEstimate(dbPath, ESTIMATED_JOB_ID, {
      minimumAmount: 60_000,
      maximumAmount: 90_000,
      geographyScope: "country",
      occupationCode: "software_engineering",
      occupationLabel: "Software Engineering",
      sources: [
        {
          source_id: "levels_fyi",
          source_provenance: "public",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "levels-public-germany",
          geography_scope: "country",
          aggregate_bucket: "reported company-role compensation",
          attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
          sample_count: 20,
        },
      ],
      estimatorVersion: `company-role-reported-compensation-canonical-benchmark-v1:direct:${ANCHOR_DIRECT_FACT_ID}`,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${ESTIMATED_JOB_ID}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as Extract<MarketCompensationEstimateResponse, { recordStatus: "recorded" }>;
      expect(body.estimate.benchmarkLineage).toMatchObject({
        kind: "direct",
        factId: ANCHOR_DIRECT_FACT_ID,
        roleFamilyCode: "software_engineering",
        seniorityLabel: "senior",
        targetGeography: { countryCode: "DE", scope: "country" },
        directInputs: [
          {
            factId: ANCHOR_DIRECT_FACT_ID,
            inputRole: "anchor",
            weight: 1,
            geography: {
              countryCode: "DE",
              subdivisionCode: null,
              locality: null,
              scope: "country",
            },
            marketScope: "market",
            normalizedCompany: null,
            minimumAmountEur: 60_000,
            maximumAmountEur: 90_000,
            confidenceScore: 0.76,
            sampleCount: 20,
            sourceId: "levels_fyi",
            sourceProvenance: "public",
            sourceSnapshotId: "levels-public-germany",
            asOfDate: "2026-01-01",
            fetchedAt: "2026-08-12T08:00:00.000000Z",
            freshUntil: "2026-08-19T08:00:00.000000Z",
          },
        ],
        priceLevelInputs: [],
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("does not expose a historical employer-posted row as a market estimate", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, ESTIMATED_JOB_ID, {
      minimumAmount: 100_000,
      maximumAmount: 130_000,
      sources: [
        {
          source_id: "posted_salary_text",
          source_provenance: "employer_posted",
          source_type: "posted_salary",
          release_year: 2026,
          snapshot_version: "jobctrl-posted-compensation-v1",
          geography_scope: "reported",
          aggregate_bucket: "employer-posted company-role compensation",
          attribution: "Employer-posted salary text captured by JobCtrl",
          sample_count: 1,
        },
      ],
      warnings: ["posted_salary_sample"],
      estimatorVersion: "company-role-reported-compensation-v2",
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${ESTIMATED_JOB_ID}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_requested",
        jobKey: ESTIMATED_JOB_ID,
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("preserves public and licensed Levels.fyi snapshot provenance", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    insertEstimate(dbPath, ESTIMATED_JOB_ID, {
      sources: [
        {
          source_id: "levels_fyi",
          source_provenance: "public",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "levels-fyi-public-2026",
          attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
          sample_count: null,
        },
        {
          source_id: "levels_fyi",
          source_provenance: "licensed",
          source_type: "reported_compensation",
          release_year: 2026,
          snapshot_version: "levels-fyi-licensed-2026-q2",
          attribution: "Levels.fyi licensed Q2 export",
          sample_count: 12,
        },
      ],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${ESTIMATED_JOB_ID}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as Extract<MarketCompensationEstimateResponse, { recordStatus: "recorded" }>;
      expect(body.estimate.sources).toEqual([
        expect.objectContaining({
          sourceId: "levels_fyi",
          provenance: "public",
          snapshotVersion: "levels-fyi-public-2026",
          attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
          sampleCount: null,
        }),
        expect.objectContaining({
          sourceId: "levels_fyi",
          provenance: "licensed",
          snapshotVersion: "levels-fyi-licensed-2026-q2",
          attribution: "Levels.fyi licensed Q2 export",
          sampleCount: 12,
        }),
      ]);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("serves trimodal fallback and source-conflict evidence from canonical market rows", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    const db = new Database(dbPath);
    insertJob(
      db,
      TRIMODAL_JOB_ID,
      "https://example.com/jobs/trimodal",
      "Trimodal Fallback",
      "€70,000-€82,000/year",
      "Synthetic trimodal fallback description",
      "Synthetic full description that must never appear",
    );
    db.close();
    insertEstimate(dbPath, TRIMODAL_JOB_ID, {
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
        url: `/v1/jobs/${TRIMODAL_JOB_ID}/compensation/market`,
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
    for (const [jobId, jobUrl, title] of [
      [UNSUPPORTED_JOB_ID, "https://example.com/jobs/unsupported", "Unsupported"],
      [UNAVAILABLE_JOB_ID, "https://example.com/jobs/unavailable", "Unavailable"],
      [INSUFFICIENT_JOB_ID, "https://example.com/jobs/insufficient", "Insufficient"],
    ] as const) {
      insertJob(
        db,
        jobId,
        jobUrl,
        title,
        null,
        "Short",
        "Private",
      );
    }
    db.close();
    insertEstimate(dbPath, UNSUPPORTED_JOB_ID, {
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
    insertEstimate(dbPath, UNAVAILABLE_JOB_ID, {
      state: "source_unavailable",
      minimumAmount: null,
      maximumAmount: null,
      confidenceBand: "none",
      confidenceScore: 0,
      sourceUnavailableReasons: ["stale_source_snapshot"],
      warnings: ["stale_source_snapshot"],
    });
    insertEstimate(dbPath, INSUFFICIENT_JOB_ID, {
      state: "insufficient_evidence",
      minimumAmount: null,
      maximumAmount: null,
      confidenceBand: "low",
      confidenceScore: 0.55,
      insufficientReasons: ["missing_reported_observation"],
      warnings: ["low_sample_count"],
    });
    try {
      for (const [jobId, state, reasonKey] of [
        [UNSUPPORTED_JOB_ID, "unsupported", "unsupportedReasons"],
        [UNAVAILABLE_JOB_ID, "source_unavailable", "sourceUnavailableReasons"],
        [INSUFFICIENT_JOB_ID, "insufficient_evidence", "insufficientReasons"],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/jobs/${jobId}/compensation/market`,
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
        url: `/v1/jobs/${NOT_REQUESTED_JOB_ID}/compensation/market`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_requested",
        jobKey: NOT_REQUESTED_JOB_ID,
      });
      expect(estimateCount(dbPath)).toBe(0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("treats an estimate from the retired public estimator as not requested", async () => {
    const { app, dbPath, cleanup } = withTempApp();
    const db = new Database(dbPath);
    insertJob(
      db,
      STALE_ESTIMATOR_JOB_ID,
      "https://example.com/jobs/public-stale",
      "Public stale",
      "",
      "Short",
      "Private",
    );
    db.close();
    insertEstimate(dbPath, STALE_ESTIMATOR_JOB_ID, {
      estimatorVersion: "market-compensation-v1",
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/jobs/${STALE_ESTIMATOR_JOB_ID}/compensation/market`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        recordStatus: "not_requested",
        jobKey: STALE_ESTIMATOR_JOB_ID,
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
        url: `/v1/jobs/${UNKNOWN_JOB_ID}/compensation/market`,
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
    insertEstimate(dbPath, ESTIMATED_JOB_ID, {
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
        url: `/v1/jobs/${ESTIMATED_JOB_ID}/compensation/market`,
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
